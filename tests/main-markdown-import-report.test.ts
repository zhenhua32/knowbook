import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { writeMarkdownFile } from '../src/main/backup/markdown-file'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectMarkdownDestinations, parseLocalMarkdownUrl, resolveMarkdownDocumentPath, rewriteMarkdownDestinations } from '../src/shared/markdownLinks'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../src/shared/markdown'
import { extractMarkdownFrontmatter } from '../src/shared/markdownFrontmatter'
import { canonicalMarkdownHtml } from './helpers/markdownSpec'
import type { DocumentDetail } from '../src/shared/contracts'

const fixtureRoot = resolve('tests/fixtures/markdown-real-documents')
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
  cases: Array<{ name: string; sha256NormalizedLf: Record<string, string>; expectedIssues: Record<string, string[]> }>
}
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const literalBlocks = (source: string) => parseMarkdownBlocks(source).filter((block) => ['code', 'frontmatter', 'math'].includes(block.type)).map(({ type, content, language }) => ({ type, content, language }))

function canonicalSource(source: string, documentPath: string, inputRoot: string, assetRoot?: string): string {
  return rewriteMarkdownDestinations(source, ({ url, kind }) => {
    const local = parseLocalMarkdownUrl(url)
    const document = kind === 'image' ? null : resolveMarkdownDocumentPath(documentPath, url)
    if (document) return `https://document.test/${encodeURIComponent(document.path)}#${encodeURIComponent(document.fragment)}`
    let file: string | undefined
    if (url.startsWith('file:') && assetRoot) {
      const path = fileURLToPath(url)
      if (resolve(path).startsWith(resolve(assetRoot) + sep)) file = path
    } else if (local?.path) {
      const path = local.path.startsWith('/') ? resolve(inputRoot, local.path.slice(1)) : resolve(inputRoot, dirname(documentPath), local.path)
      if (path.startsWith(resolve(inputRoot) + sep)) file = path
    }
    if (file && existsSync(file)) return `https://asset.test/${digest(readFileSync(file))}` + (local?.suffix ?? new URL(url).search + new URL(url).hash)
    return null
  })
}

for (const fixture of manifest.cases) test(`real document corpus: ${fixture.name} retains meaning, diagnostics and attachments over three file and backup cycles`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-import-corpus-')), stores: KnowbookStore[] = []
  const originalRoot = join(fixtureRoot, fixture.name, 'input')
  const originals = new Map<string, string>()
  for (const [path, sha] of Object.entries(fixture.sha256NormalizedLf)) {
    const source = readFileSync(join(originalRoot, path), 'utf8').replace(/\r\n?/g, '\n')
    assert.equal(digest(source), sha, `${fixture.name}/${path}: pinned input changed`)
    if (path.endsWith('.md')) originals.set(path, source)
  }
  const previous = new Map<string, string>()
  let input = originalRoot
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const store = new KnowbookStore(join(root, `workspace-${cycle}.sqlite`)); stores.push(store)
      const assets = join(root, `assets-${cycle}`), service = new MarkdownRestoreService(store, assets)
      const before = store.getAllDocumentSnapshots()
      const preview = await service.previewFromDirectory(input)
      assert.equal(preview.restored, originals.size)
      assert.deepEqual(store.getAllDocumentSnapshots(), before)
      assert.equal(existsSync(assets), false)
      const result = await service.restoreFromDirectory(input), report = result.importReport!
      assert.equal(report.files.length, originals.size)
      assert.equal(report.issueCount, Object.values(fixture.expectedIssues).flat().length)
      const output = join(root, `export-${cycle}`)
      const sourceDocuments: DocumentDetail[] = []
      for (const file of report.files) {
        assert.equal(file.status, 'created')
        assert.equal(file.omittedIssueCount, 0)
        assert.deepEqual(file.issues.map((issue) => issue.reason).sort(), [...fixture.expectedIssues[file.sourcePath]].sort())
        const document = store.getDocumentDetail(file.documentId)!, original = originals.get(file.sourcePath)!
        sourceDocuments.push(document)
        for (const issue of file.issues) assert.ok(document.blocks.some((block) => block.id === issue.blockId && issue.offset >= 0 && issue.offset < block.content.length), JSON.stringify(issue))
        const title = basename(file.sourcePath, '.md'), header = extractMarkdownFrontmatter(original)
        const body = header ? original.slice(header.end).trimStart() : original
        const expectedBody = body.startsWith(`# ${title}\n`) ? body.slice(`# ${title}\n`.length) : body
        const actualBody = serializeBlocksToMarkdown(document.blocks)
        assert.equal(canonicalMarkdownHtml(markdownEngine.render(canonicalSource(actualBody, document.path, input, assets))),
          canonicalMarkdownHtml(markdownEngine.render(canonicalSource(expectedBody, document.path, originalRoot))), `${fixture.name}/${file.sourcePath}: imported body semantics`)
        assert.deepEqual(literalBlocks(actualBody), literalBlocks(original), `${file.sourcePath}: literal code/YAML/math`)
        const exported = buildDraftMarkdownExport(document).markdown
        const canonical = canonicalSource(exported, document.path, input, assets)
        if (previous.has(file.sourcePath)) assert.equal(canonical, previous.get(file.sourcePath), `${file.sourcePath}: stable plain export`)
        previous.set(file.sourcePath, canonical)
        writeMarkdownFile(join(output, file.sourcePath), exported, assets)
      }
      const backup = join(root, `backup-${cycle}`)
      await new MarkdownBackupService(store, backup, assets).exportAll()
      const restored = new KnowbookStore(join(root, `restored-${cycle}.sqlite`)); stores.push(restored)
      const restoredAssets = join(root, `restored-assets-${cycle}`)
      await new MarkdownRestoreService(restored, restoredAssets).restoreFromDirectory(backup)
      for (const document of sourceDocuments) {
        const reloaded = restored.getDocumentDetail(restored.getDocumentSnapshotByPath(document.path)!.id)!
        assert.deepEqual(reloaded.blocks.map((block) => block.id), document.blocks.map((block) => block.id))
        assert.equal(canonicalSource(serializeBlocksToMarkdown(reloaded.blocks), reloaded.path, backup, restoredAssets),
          canonicalSource(serializeBlocksToMarkdown(document.blocks), document.path, input, assets))
      }
      input = output
    }
  } finally { stores.forEach((store) => store.destroy()); rmSync(root, { recursive: true, force: true }) }
})

test('backup asset IO excludes code and ordinary YAML while restoring actual links and database fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-import-literals-')), store = new KnowbookStore(join(root, 'source.sqlite'))
  const restored = new KnowbookStore(join(root, 'restored.sqlite'))
  try {
    const assets = join(root, 'assets'), file = join(assets, 'image.svg')
    mkdirSync(assets); copyFileSync(join(fixtureRoot, 'vault/input/附件/截图.svg'), file)
    const url = pathToFileURL(file).href, id = store.createDocument(null)
    const source = `---\nexample: "${url}"\n---\n\n\`${url}\`\n\n\`\`\`text\n![sample](${url})\n\`\`\`\n\n![actual](${url})\n\n${url}`
    store.updateDocument(id, { title: 'Literal', summary: '', blocks: parseMarkdownBlocks(source).map((block) => ({ ...block, language: block.language ?? undefined, checked: false, depth: 0 })) })
    const backup = join(root, 'backup')
    await new MarkdownBackupService(store, backup, assets).exportAll()
    await new MarkdownRestoreService(restored, join(root, 'restored-assets')).restoreFromDirectory(backup)
    const markdown = serializeBlocksToMarkdown(restored.getDocumentDetail(restored.getDocumentSnapshotByPath('Literal')!.id)!.blocks)
    assert.deepEqual(literalBlocks(markdown), literalBlocks(source))
    assert.ok(markdown.includes(`\`${url}\``))
    const links = collectMarkdownDestinations(markdown)
    assert.equal(links.length, 2)
    for (const link of links) {
      assert.notEqual(link.url, url)
      assert.deepEqual(readFileSync(fileURLToPath(link.url)), readFileSync(file))
    }
  } finally { store.destroy(); restored.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('reports distinguish updates and bound large issue lists; rejected imports leave no partial documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-import-report-')), store = new KnowbookStore(join(root, 'workspace.sqlite'))
  try {
    const input = join(root, 'input'); mkdirSync(input)
    const existing = store.createDocument(null)
    store.updateDocument(existing, { title: 'Known|Title', summary: '', blocks: [] })
    writeFileSync(join(input, 'Known.md'), '[[Known|Title]] and \\![[Known|Title]]')
    writeFileSync(join(input, 'Folder.md'), '[folder](./)')
    writeFileSync(join(input, 'Many.md'), Array.from({ length: 130 }, (_, index) => `[missing ${index}](Missing-${index}.md)`).join('\n\n'))
    const service = new MarkdownRestoreService(store, join(root, 'assets'))
    for (const status of ['created', 'updated']) {
      const result = await service.restoreFromDirectory(input), report = result.importReport!
      const many = report.files.find((file) => file.sourcePath === 'Many.md')!
      assert.equal(many.status, status)
      assert.equal(report.issueCount, 131); assert.equal(many.issues.length, 100); assert.equal(many.omittedIssueCount, 30)
      assert.deepEqual(report.files.find((file) => file.sourcePath === 'Known.md')!.issues, [])
      assert.deepEqual(report.files.find((file) => file.sourcePath === 'Folder.md')!.issues.map((issue) => issue.reason), ['missing-attachment'])
    }
    const before = store.getAllDocumentSnapshots()
    writeFileSync(join(input, 'Bad.md'), Buffer.from([0xff, 0xfe]))
    await assert.rejects(service.restoreFromDirectory(input), /not valid UTF-8/)
    assert.deepEqual(store.getAllDocumentSnapshots(), before)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('failure while preparing the report rolls back restored documents and published attachments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-import-atomic-')), store = new KnowbookStore(join(root, 'workspace.sqlite'))
  try {
    const input = join(root, 'input'), assets = join(root, 'assets'); mkdirSync(input)
    writeFileSync(join(input, 'Atomic.md'), '# Atomic\n\n![image](image.svg)')
    copyFileSync(join(fixtureRoot, 'vault/input/附件/截图.svg'), join(input, 'image.svg'))
    const before = store.getAllDocumentSnapshots(), check = store.checkDocumentLinks.bind(store)
    store.checkDocumentLinks = () => { throw new Error('injected report failure') }
    const service = new MarkdownRestoreService(store, assets)
    await assert.rejects(service.restoreFromDirectory(input), /injected report failure/)
    assert.deepEqual(store.getAllDocumentSnapshots(), before)
    const hash = digest(readFileSync(join(input, 'image.svg')))
    assert.equal(existsSync(join(assets, 'markdown', hash.slice(0, 2), `${hash}.svg`)), false)
    store.checkDocumentLinks = check
    assert.equal((await service.restoreFromDirectory(input)).importReport!.issueCount, 0)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
