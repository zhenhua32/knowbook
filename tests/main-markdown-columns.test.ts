import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { serializeBlocksToMarkdown } from '../src/shared/markdown'
import { buildDraftMarkdownExport } from '../src/renderer/src/utils/documentMarkdown'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const body: DocumentBlockDraft[] = [
  { id: 'layout', type: 'columns', content: '', checked: false, depth: 0, tags: ['layout'], highlight: 'blue' },
  { id: 'left', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'layout', markdownFormat: { columnWeight: 3200 } },
  { id: 'title', type: 'heading-2', content: 'Column heading', checked: false, depth: 2, parentBlockId: 'left' },
  { id: 'toggle', type: 'toggle', content: 'Title [Link][dest]', checked: false, depth: 2, parentBlockId: 'left', markdownFormat: { toggleDefaultOpen: false } },
  { id: 'child', type: 'paragraph', content: 'Inside </section> and </div> [^note]', checked: false, depth: 3, parentBlockId: 'toggle', tags: ['body'], highlight: 'yellow' },
  { id: 'task', type: 'todo', content: 'Checked', checked: true, depth: 2, parentBlockId: 'left', markdownFormat: { listMarker: '+', listLoose: false } },
  { id: 'definitions', type: 'paragraph', content: '[dest]: Guide.md\n\n[^note]: A note', checked: false, depth: 2, parentBlockId: 'left' },
  { id: 'empty', type: 'column', content: '', checked: false, depth: 1, parentBlockId: 'layout', markdownFormat: { columnWeight: 6800 } },
  { id: 'after', type: 'paragraph', content: 'After layout', checked: false, depth: 0 }
]
const find = (store: KnowbookStore) => {
  const entry = store.getAllDocumentSnapshots().find(value => value.path === 'Columns')
  assert.ok(entry)
  return store.getDocumentDetail(entry.id)!
}

test('three real Markdown file cycles retain column order, empty columns, mixed children and exact layout with fresh identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-columns-plain-')), stores: KnowbookStore[] = []
  try {
    const initial = new KnowbookStore(join(root, 'initial.sqlite')); stores.push(initial)
    const id = initial.createDocument(null); initial.updateDocument(id, { title: 'Columns', summary: '', blocks: body })
    let source = buildDraftMarkdownExport(find(initial)).markdown, canonical = '', previousIds = new Set(body.map(value => value.id))
    for (let cycle = 0; cycle < 3; cycle++) {
      const directory = join(root, 'input-' + cycle); mkdirSync(directory)
      writeFileSync(join(directory, 'Columns.md'), source.replace(/\n/g, '\r\n'))
      const restored = new KnowbookStore(join(root, 'restored-' + cycle + '.sqlite')); stores.push(restored)
      await new MarkdownRestoreService(restored).restoreFromDirectory(directory)
      const value = find(restored)
      assert.deepEqual(value.blocks.map(block => [block.type, block.content, block.depth, block.checked, block.markdownFormat]),
        body.map(block => [block.type, block.content, block.depth, block.checked, block.markdownFormat]))
      assert.equal(value.blocks[7].type, 'column'); assert.equal(value.blocks[7].content, '')
      assert.equal(value.blocks[7].parentBlockId, value.blocks[0].id)
      assert.equal(value.blocks[4].parentBlockId, value.blocks[3].id)
      assert.ok(value.blocks.every(block => !previousIds.has(block.id)))
      previousIds = new Set(value.blocks.map(block => block.id))
      const written = serializeBlocksToMarkdown(value.blocks)
      if (!cycle) canonical = written
      else assert.equal(written, canonical)
      assert.doesNotMatch(written, /knowbook:block|parentBlockId|"id"/)
      source = buildDraftMarkdownExport(value).markdown
    }
  } finally { for (const store of stores) store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('three real backup exports and restores preserve all columns identities, ownership, annotations and weights', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-columns-backup-')), stores: KnowbookStore[] = []
  try {
    let store = new KnowbookStore(join(root, 'initial.sqlite')); stores.push(store)
    const id = store.createDocument(null); store.updateDocument(id, { title: 'Columns', summary: 'Summary', blocks: body })
    const expected = find(store)
    for (let cycle = 0; cycle < 3; cycle++) {
      const directory = join(root, 'backup-' + cycle)
      await new MarkdownBackupService(store, directory).exportAll()
      const source = readFileSync(join(directory, 'Columns.md'), 'utf8')
      assert.equal((source.match(/<!-- knowbook:block /g) ?? []).length, body.length)
      const restored = new KnowbookStore(join(root, 'restored-' + cycle + '.sqlite')); stores.push(restored)
      await new MarkdownRestoreService(restored).restoreFromDirectory(directory)
      assert.deepEqual(find(restored).blocks, expected.blocks)
      assert.equal(find(restored).summary, expected.summary)
      store = restored
    }
  } finally { for (const store of stores) store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('damaged plain layouts and contradictory backup weights or ownership leave all existing documents unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-columns-invalid-')), store = new KnowbookStore(join(root, 'workspace.sqlite'))
  try {
    const id = store.createDocument(null); store.updateDocument(id, { title: 'Columns', summary: 'Keep', blocks: body })
    const directory = join(root, 'input'); mkdirSync(directory)
    const original = store.getDocumentDetail(id)!, before = store.getSyncRecords()
    const plain = serializeBlocksToMarkdown(original.blocks), backup = serializeBlocksToMarkdown(original.blocks, { includeBlockMetadata: true })
    for (const source of [plain.replace('data-knowbook-weight="3200"', 'data-knowbook-weight="3201"'),
      plain.slice(0, plain.lastIndexOf('</section>')), backup.replace('"columnWeight":3200', '"columnWeight":3201'),
      backup.replace('"parentBlockId":"layout"', '"parentBlockId":"foreign"')]) {
      writeFileSync(join(directory, 'Columns.md'), source)
      await assert.rejects(new MarkdownRestoreService(store).restoreFromDirectory(directory), /Invalid native Markdown container/)
      assert.deepEqual(store.getDocumentDetail(id), original)
      assert.deepEqual(store.getSyncRecords(), before)
    }
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
