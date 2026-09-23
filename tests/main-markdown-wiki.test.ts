import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { writeMarkdownFile } from '../src/main/backup/markdown-file'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version'

const drafts = (source: string) => parseMarkdownBlocks(source).map((block) => ({ ...block, checked: block.checked ?? false, depth: block.depth ?? 0, language: block.language ?? undefined }))
const create = (store: KnowbookStore, title: string, source = '', parent: string | null = null) => {
  const id = store.createDocument(parent); store.updateDocument(id, { title, summary: '', blocks: drafts(source) }); return id
}
const body = (store: KnowbookStore, id: string) => serializeBlocksToMarkdown(store.getDocumentDetail(id)!.blocks)

test('Wiki aliases and headings follow renames, moves and duplicate section identity while legacy block links stay intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-wiki-maintain-')), store = new KnowbookStore(join(root, 'workspace.sqlite'))
  try {
    const folder = create(store, 'Docs'), archive = create(store, 'Archive')
    const target = create(store, 'Guide', '## Install here\n\nBody\n\n## Repeat\n\n## Repeat', folder)
    const original = store.getDocumentDetail(target)!, blockId = original.blocks[1].id
    const source = create(store, 'Source', `[[Guide.md|Friendly]] [[Docs/Guide#Install here|Start]] [[Docs/Guide#${blockId}|Legacy]] [[Docs/Guide#repeat|First]]\n\n| Link |\n| --- |\n| [[Docs/Guide#repeat-1\\|Second]] |\n\n\`[[Docs/Guide|Code]]\`\n\n## Local\n\n[[#Local|Here]]`)
    assert.deepEqual(store.checkDocumentLinks(source, () => null).issues, [])
    assert.ok(store.getDocumentDetail(target)!.backlinks.some((link) => link.id === source))
    store.updateDocument(target, { ...original, title: 'Renamed', blocks: original.blocks.map((block, index) => index === 0 ? { ...block, content: 'New section' } : block) })
    assert.match(body(store, source), /\[\[Docs\/Renamed#new-section\|Start\]\]/)
    assert.ok(body(store, source).includes(`[[Docs/Renamed#${blockId}|Legacy]]`))
    assert.ok(body(store, source).includes('`[[Docs/Guide|Code]]`'))
    store.moveDocument(target, archive)
    assert.ok(body(store, source).includes('[[Archive/Renamed|Friendly]]'))
    const changed = store.getDocumentDetail(target)!
    store.updateDocument(target, { ...changed, blocks: changed.blocks.filter((_, index) => index !== 2) })
    assert.ok(body(store, source).includes('[[Archive/Renamed#repeat\\|Second]]'))
    assert.match(body(store, source), /#knowbook-missing-heading-[^|]+\|First\]\]/)
    assert.deepEqual(store.checkDocumentLinks(source, () => null).issues.map((issue) => issue.reason), ['missing-heading'])
    store.updateDocument(target, changed)
    assert.deepEqual(store.checkDocumentLinks(source, () => null).issues, [])
    const relativeSource = create(store, 'Relative', '[[../Archive/Renamed.md#New section|Relative]]', folder)
    store.moveDocument(relativeSource, archive)
    assert.ok(body(store, relativeSource).includes('[[Archive/Renamed#New section|Relative]]'))
    assert.deepEqual(store.checkDocumentLinks(relativeSource, () => null).issues, [])
    const hashName = create(store, 'C#', 'Body'), hashBlock = store.getDocumentDetail(hashName)!.blocks[0].id
    const oldSource = create(store, 'Old syntax', `[[C##${hashBlock}]] [[C##${hashBlock}|Named]]`)
    store.updateDocument(hashName, { ...store.getDocumentDetail(hashName)!, title: 'C# guide' })
    assert.ok(body(store, oldSource).includes(`[[C# guide#${hashBlock}|Named]]`))
    assert.deepEqual(store.checkDocumentLinks(oldSource, () => null).issues, [])
    const backup = join(root, 'backup')
    await new MarkdownBackupService(store, backup).exportAll()
    const restored = new KnowbookStore(join(root, 'restored.sqlite'))
    try {
      await new MarkdownRestoreService(restored).restoreFromDirectory(backup)
      assert.deepEqual(restored.checkDocumentLinks(restored.getDocumentSnapshotByPath('Source')!.id, () => null).issues, [])
      assert.ok(body(restored, restored.getDocumentSnapshotByPath('Old syntax')!.id).includes(`#${hashBlock}|Named`))
    } finally { restored.destroy() }
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('newly resolvable aliases and sections reindex, and migration backfills existing Wiki references without editing source', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-wiki-migrate-')), path = join(root, 'workspace.sqlite')
  let store = new KnowbookStore(path)
  try {
    const source = create(store, 'Source', '[[Future.md#Later section|Soon]]')
    const target = create(store, 'Future')
    assert.equal(store.getDocumentDetail(source)!.outgoingLinks[0].id, target)
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, blocks: drafts('## Later section') })
    const detail = store.getDocumentDetail(target)!
    store.updateDocument(target, { ...detail, blocks: detail.blocks.map((block) => ({ ...block, content: 'Changed' })) })
    assert.ok(body(store, source).includes('#changed|Soon'))
    const before = store.getDocumentDetail(source)!.blocks
    store.getUnsafeDatabaseHandle().exec('DELETE FROM markdown_link_sources; DELETE FROM links; PRAGMA user_version = 18;')
    store.destroy(); store = new KnowbookStore(path)
    assert.equal(store.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
    assert.ok(readdirSync(root).some((name) => name.includes(`pre-migration-v18-to-v${CURRENT_DATABASE_SCHEMA_VERSION}`)))
    assert.deepEqual(store.getDocumentDetail(source)!.blocks, before)
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'Final' })
    assert.ok(body(store, source).includes('[[Final#changed|Soon]]'))
    assert.deepEqual(store.checkDocumentLinks(source, () => null).issues, [])
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('Wiki image roots, unique names and aliases survive three file and backup rounds; ambiguous assets stay diagnosed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-wiki-files-')), stores: KnowbookStore[] = []
  const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
  const pixel = readFileSync('tests/fixtures/markdown-real-documents/vault/input/附件/截图.svg')
  let input = join(root, 'input')
  write(join(input, 'Docs/Start.md'), '# Start\n\n[[Guide.md#Install here|Go]]\n\n![[pictures/pixel.svg|Root image]] ![[unique.svg|Unique image]]\n\n`![[missing.png]]`')
  write(join(input, 'Docs/Guide.md'), '# Guide\n\n## Install here\n\n[[#Install here|Same page]]')
  write(join(input, 'pictures/pixel.svg'), pixel.toString()); write(join(input, 'pictures/unique.svg'), pixel.toString())
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const store = new KnowbookStore(join(root, `${cycle}.sqlite`)); stores.push(store)
      const assets = join(root, `assets-${cycle}`), result = await new MarkdownRestoreService(store, assets).restoreFromDirectory(input)
      assert.equal(result.importReport!.issueCount, 0, `cycle ${cycle}: ${JSON.stringify(result.importReport)}`)
      const output = join(root, `output-${cycle}`), backup = join(root, `backup-${cycle}`)
      for (const file of result.importReport!.files) {
        const document = store.getDocumentDetail(file.documentId)!
        for (const link of collectDocumentMarkdownLinks(document.blocks).filter((link) => link.kind === 'image')) assert.deepEqual(readFileSync(fileURLToPath(link.url)), pixel)
        writeMarkdownFile(join(output, `${document.path}.md`), buildDraftMarkdownExport(document).markdown, assets)
      }
      await new MarkdownBackupService(store, backup, assets).exportAll()
      const restored = new KnowbookStore(join(root, `restored-${cycle}.sqlite`)); stores.push(restored)
      assert.equal((await new MarkdownRestoreService(restored, join(root, `restored-assets-${cycle}`)).restoreFromDirectory(backup)).importReport!.issueCount, 0)
      const start = restored.getDocumentSnapshotByPath('Docs/Start')!
      assert.ok(body(restored, start.id).includes('[[Guide.md#Install here|Go]]'))
      assert.ok(body(restored, start.id).includes('`![[missing.png]]`'))
      input = output
    }
    const ambiguous = join(root, 'ambiguous')
    write(join(ambiguous, 'Source.md'), '![[same.svg]] ![[missing.png]] ![[Note]] [[Absent|Alias]]')
    for (const folder of ['A', 'B']) { mkdirSync(join(ambiguous, folder)); copyFileSync(join(root, 'input/pictures/pixel.svg'), join(ambiguous, folder, 'same.svg')) }
    const store = new KnowbookStore(join(root, 'ambiguous.sqlite')); stores.push(store)
    const report = (await new MarkdownRestoreService(store, join(root, 'ambiguous-assets')).restoreFromDirectory(ambiguous)).importReport!
    assert.deepEqual(report.files[0].issues.map((issue) => issue.reason).sort(), ['ambiguous-reference', 'missing-attachment', 'missing-document', 'wiki-syntax'].sort())
    assert.ok(body(store, report.files[0].documentId).includes('![[same.svg]]'))
  } finally { stores.forEach((store) => store.destroy()); rmSync(root, { recursive: true, force: true }) }
})
