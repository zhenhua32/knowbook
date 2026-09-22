import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown.ts'
import { serializeBlocksToMarkdown } from '../src/shared/markdown.ts'
import { extensionMarkdown } from './fixtures/markdown-extensions.ts'

test('real file import, SQLite, document export and reimport preserve all three extensions over three cycles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-extension-files-'))
  const stores: KnowbookStore[] = []
  try {
    let markdown = extensionMarkdown
    let expected = ''
    let last = null as ReturnType<KnowbookStore['getDocumentDetail']>
    for (let cycle = 0; cycle < 3; cycle++) {
      const directory = join(root, `import-${cycle}`)
      mkdirSync(directory)
      writeFileSync(join(directory, 'Extensions.md'), markdown)
      const store = new KnowbookStore(join(root, `store-${cycle}.sqlite`))
      stores.push(store)
      await new MarkdownRestoreService(store).restoreFromDirectory(directory)
      const doc = store.getAllDocumentSnapshots().find((entry) => entry.path === 'Extensions')!
      last = store.getDocumentDetail(doc.id)!
      const firstTask = last.blocks.find((block) => block.type === 'numbered-todo')!
      assert.equal(firstTask.listStart, 3)
      assert.equal(firstTask.checked, true)
      assert.equal(last.blocks.filter((block) => block.type === 'table').length, 2)
      const canonical = serializeBlocksToMarkdown(last.blocks)
      if (cycle === 0) expected = canonical
      else assert.equal(canonical, expected, `cycle ${cycle} changed body`)
      markdown = buildDraftMarkdownExport(last).markdown
      assert.equal((markdown.match(/^# Extensions$/gm) ?? []).length, 1)
    }
    const backup = join(root, 'backup')
    await new MarkdownBackupService(stores.at(-1)!, backup).exportAll()
    const restored = new KnowbookStore(join(root, 'restored.sqlite'))
    stores.push(restored)
    await new MarkdownRestoreService(restored).restoreFromDirectory(backup)
    const doc = restored.getAllDocumentSnapshots().find((entry) => entry.path === 'Extensions')!
    assert.deepEqual(restored.getDocumentDetail(doc.id)!.blocks, last!.blocks, 'backup retains IDs, checks, numbering and hierarchy')
  } finally {
    for (const store of stores) store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

test('ordinary import promotes only a matching title while backups retain a matching body heading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-extension-titles-'))
  const store = new KnowbookStore(join(root, 'store.sqlite'))
  try {
    const dir = join(root, 'input')
    mkdirSync(dir)
    writeFileSync(join(dir, 'Empty.md'), '# Empty\n')
    writeFileSync(join(dir, 'Other.md'), '# Different\n\nBody')
    writeFileSync(join(dir, 'Backup.md'), '---\nkind: document\n---\n<!-- knowbook:backup v1 -->\n\n# Backup\n\nBody')
    await new MarkdownRestoreService(store).restoreFromDirectory(dir)
    const body = (path: string) => store.getDocumentDetail(store.getAllDocumentSnapshots().find((entry) => entry.path === path)!.id)!.blocks
    assert.equal(body('Empty')[0].content, '')
    assert.equal(body('Other')[0].type, 'heading-1')
    assert.equal(body('Backup')[0].content, 'Backup')
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
