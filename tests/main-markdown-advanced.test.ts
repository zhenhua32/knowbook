import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowbookStore } from '../src/main/database/store.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown.ts'
import { serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument.ts'
import { advancedMarkdown } from './fixtures/markdown-advanced.ts'
import { collectMarkdownDestinations, parseLocalMarkdownUrl } from '../src/shared/markdownLinks.ts'
import { writeMarkdownFile } from '../src/main/backup/markdown-file.ts'

test('advanced syntax survives real files, SQLite, three exports and a metadata backup restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-advanced-files-'))
  const stores: KnowbookStore[] = []
  try {
    let source = advancedMarkdown
    let expected = ''
    let last: NonNullable<ReturnType<KnowbookStore['getDocumentDetail']>> | undefined
    for (let cycle = 0; cycle < 3; cycle++) {
      const directory = join(root, `import-${cycle}`)
      mkdirSync(directory)
      writeFileSync(join(directory, 'Advanced.md'), source)
      const store = new KnowbookStore(join(root, `store-${cycle}.sqlite`))
      stores.push(store)
      await new MarkdownRestoreService(store).restoreFromDirectory(directory)
      const document = store.getAllDocumentSnapshots().find((entry) => entry.path === 'Advanced')!
      last = store.getDocumentDetail(document.id)!
      const canonical = serializeBlocksToMarkdown(last.blocks)
      if (cycle === 0) expected = canonical
      else assert.equal(canonical, expected, `cycle ${cycle}`)
      const model = parseMarkdownDocumentBlocks(last.blocks, last.title)
      assert.equal(model.footnotes.length, 1)
      assert.equal(model.footnoteOrigins.size, 6)
      assert.equal(last.blocks.filter((block) => block.type === 'math').length, 2)
      assert.equal(last.blocks.find((block) => block.type === 'code')?.language, 'mermaid')
      source = buildDraftMarkdownExport(last).markdown
      writeFileSync(join(root, `export-${cycle}.md`), source)
      assert.equal(readFileSync(join(root, `export-${cycle}.md`), 'utf8'), source)
    }
    const backup = join(root, 'backup')
    await new MarkdownBackupService(stores.at(-1)!, backup).exportAll()
    const restored = new KnowbookStore(join(root, 'restored.sqlite'))
    stores.push(restored)
    await new MarkdownRestoreService(restored).restoreFromDirectory(backup)
    const document = restored.getAllDocumentSnapshots().find((entry) => entry.path === 'Advanced')!
    assert.deepEqual(restored.getDocumentDetail(document.id)!.blocks, last!.blocks)
  } finally {
    stores.forEach((store) => store.destroy())
    rmSync(root, { recursive: true, force: true })
  }
})

test('images and attachments inside named and inline footnotes are collected, copied and exported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-footnote-assets-'))
  const store = new KnowbookStore(join(root, 'store.sqlite'))
  try {
    const input = join(root, 'input')
    mkdirSync(input)
    writeFileSync(join(input, 'image.png'), 'image bytes')
    writeFileSync(join(input, 'unused.png'), 'unused image bytes')
    writeFileSync(join(input, 'file.pdf'), 'attachment bytes')
    writeFileSync(join(input, 'Notes.md'), 'Named[^n] and inline ^[![inline](image.png)].\n\n[^n]: ![named](image.png) and [attachment](file.pdf).\n\n[^unused]: Not cited ^[![unused](unused.png)].')
    const assets = join(root, 'assets')
    await new MarkdownRestoreService(store, assets).restoreFromDirectory(input)
    const doc = store.getAllDocumentSnapshots().find((entry) => entry.path === 'Notes')!
    const markdown = buildDraftMarkdownExport(store.getDocumentDetail(doc.id)!).markdown
    const urls = collectMarkdownDestinations(markdown)
    assert.equal(urls.filter((entry) => entry.kind === 'image').length, 3)
    assert.equal(urls.filter((entry) => entry.kind === 'link').length, 1)
    for (const { url } of urls) assert.match(readFileSync(fileURLToPath(url), 'utf8'), /bytes/)
    const output = join(root, 'Notes.md')
    writeMarkdownFile(output, markdown, assets)
    for (const { url } of collectMarkdownDestinations(readFileSync(output, 'utf8'))) {
      assert.ok(!url.startsWith('file:'))
      assert.match(readFileSync(join(root, parseLocalMarkdownUrl(url)!.path), 'utf8'), /bytes/)
    }
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
