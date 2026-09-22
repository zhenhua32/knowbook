import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { writeMarkdownFile } from '../src/main/backup/markdown-file'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown'
import { checkMarkdownAttachment } from '../src/main/markdown-attachment-check'
import { KNOWBOOK_BACKUP_MARKER } from '../src/shared/markdownFrontmatter'
import { documentYaml, commonHtml } from './fixtures/markdown-frontmatter-html'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance'

test('schema 18 backfills HTML links before an existing target is renamed and keeps a safety copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-html-migration-')), path = join(root, 'workspace.sqlite')
  let store = new KnowbookStore(path)
  try {
    const target = store.createDocument(null), source = store.createDocument(null)
    store.updateDocument(target, { title: 'Target', summary: '', blocks: [{ type: 'paragraph', content: '<a id="target"></a>', checked: false, depth: 0 }] })
    store.updateDocument(source, { title: 'Source', summary: '', blocks: [{ type: 'paragraph', content: '<a href="Target.md#target">Go</a>', checked: false, depth: 0 }] })
    const before = store.getDocumentDetail(source)!
    store.getUnsafeDatabaseHandle().exec('DELETE FROM markdown_link_sources; DELETE FROM links; PRAGMA user_version = 17;')
    store.destroy(); store = new KnowbookStore(path)
    assert.equal(store.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
    assert.ok(readdirSync(root).some((name) => name.includes(`pre-migration-v17-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`)))
    assert.deepEqual(store.getDocumentDetail(source)!.blocks, before.blocks)
    assert.equal(store.getDocumentDetail(source)!.outgoingLinks.length, 1)
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'Renamed' })
    assert.equal(collectDocumentMarkdownLinks(store.getDocumentDetail(source)!.blocks)[0].url, 'Renamed.md#target')
    assert.deepEqual(store.checkDocumentLinks(source, () => null).issues, [])
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('YAML and HTML survive three portable file cycles, link maintenance and current/legacy backup restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-yaml-html-')), stores: KnowbookStore[] = []
  const write = (path: string, source: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source) }
  const lookup = (store: KnowbookStore, path: string) => {
    const entry = store.getAllDocumentSnapshots().find((document) => document.path === path)
    assert.ok(entry, `missing ${path}`)
    return store.getDocumentDetail(entry.id)!
  }
  try {
    let input = join(root, 'input'), last!: KnowbookStore, assets = '', yaml = documentYaml
    let otherPath = 'Other'
    for (let cycle = 0; cycle < 3; cycle++) {
      const store = new KnowbookStore(join(root, `workspace-${cycle}.sqlite`)); stores.push(store)
      assets = join(root, `assets-${cycle}`)
      if (cycle === 0) {
        const victim = store.createDocument(null)
        store.updateDocument(victim, { title: 'Keep me', summary: 'untouched', blocks: [] })
        yaml = documentYaml.replace('third-party-id', victim)
        write(join(input, 'Note.md'), yaml + '\n\n# Note\n\n' + commonHtml)
        write(join(input, 'Other.md'), '# Other\n\n<a id="target"></a>\n\nTarget')
        write(join(input, 'assets', 'image.png'), 'image fixture')
        await new MarkdownRestoreService(store, assets).restoreFromDirectory(input)
        assert.equal(store.getDocumentDetail(victim)?.summary, 'untouched')
        assert.equal(store.getDocumentDetail(victim)?.title, 'Keep me')
        const other = lookup(store, 'Other')
        otherPath = '另一个 & name'
        store.updateDocument(other.id, { ...other, title: otherPath, blocks: other.blocks.map((block) => ({ ...block, content: block.content.replace('id="target"', 'id="renamed"') })) })
      } else await new MarkdownRestoreService(store, assets).restoreFromDirectory(input)
      const note = lookup(store, 'Note')
      assert.equal(note.blocks[0].type, 'frontmatter')
      assert.equal(note.blocks[0].content, yaml)
      assert.equal(note.blocks.filter((block) => block.type === 'heading-1' && block.content === 'Note').length, 0)
      assert.equal(note.blocks.filter((block) => block.type === 'html').length, 1)
      assert.deepEqual(store.checkDocumentLinks(note.id, (url) => checkMarkdownAttachment(url, assets)).issues, [])
      assert.equal(store.getAllDocumentSnapshots().some((document) => document.path === 'External/Should not move'), false)
      const output = join(root, `export-${cycle}`)
      for (const path of ['Note', otherPath]) writeMarkdownFile(join(output, `${path}.md`), buildDraftMarkdownExport(lookup(store, path)).markdown, assets)
      const exported = readFileSync(join(output, 'Note.md'), 'utf8')
      assert.ok(exported.startsWith(yaml + '\n\n# Note\n\n'))
      assert.ok(exported.includes('width="240" height="120"'))
      assert.ok(exported.includes('missing.png'))
      assert.ok(exported.includes('#renamed'))
      last = store; input = output
    }
    last.createDatabase({ name: 'Legacy DB', description: 'round trip' })
    const backup = join(root, 'backup')
    await new MarkdownBackupService(last, backup, assets).exportAll()
    for (const legacy of [false, true]) {
      if (legacy) for (const entry of readdirSync(backup, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const path = join(entry.parentPath, entry.name)
        writeFileSync(path, readFileSync(path, 'utf8').replace(KNOWBOOK_BACKUP_MARKER + '\n', ''))
      }
      const restored = new KnowbookStore(join(root, `restored-${legacy}.sqlite`)); stores.push(restored)
      const restoredAssets = join(root, `restored-assets-${legacy}`)
      await new MarkdownRestoreService(restored, restoredAssets).restoreFromDirectory(backup)
      const note = lookup(restored, 'Note')
      assert.equal(note.blocks[0].content, yaml)
      assert.deepEqual(note.blocks.map((block) => block.id), lookup(last, 'Note').blocks.map((block) => block.id))
      assert.deepEqual(restored.checkDocumentLinks(note.id, (url) => checkMarkdownAttachment(url, restoredAssets)).issues, [])
      assert.equal(restored.getExportStandaloneDatabases().filter((database) => database.name === 'Legacy DB').length, 1)
      assert.equal(restored.getAllDocumentSnapshots().some((document) => document.path.startsWith('__knowbook')), false)
    }
  } finally { stores.forEach((store) => store.destroy()); rmSync(root, { recursive: true, force: true }) }
})
