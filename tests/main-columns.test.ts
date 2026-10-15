import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version'
import { assertColumnStructure, validColumnStructure } from '../src/shared/columns'
import { planDocumentBlockTransfer } from '../src/shared/documentBlockTransfer'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { canonicalJson, parseManifest, requiresPageCompositionProtocol, validSyncBlockTree, validateRecord, type SyncDocument } from '../src/main/sync/model'
import { mergeSyncDocument } from '../src/main/sync/merge'
import { columnForest, columnWeights } from './helpers/columns'

function withStore(run: (h: { readonly store: KnowbookStore; root: string; restart(): KnowbookStore }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-columns-store-')), path = join(root, 'test.db')
  let store = new KnowbookStore(path)
  try { run({ get store() { return store }, root, restart() { store.destroy(); store = new KnowbookStore(path); return store } }) }
  finally {
    store.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-columns-store-'))
    rmSync(root, { recursive: true, force: true })
  }
}
function create(store: KnowbookStore, title: string, blocks: DocumentBlockDraft[]) {
  const id = store.createDocument(null)
  store.updateDocument(id, { title, summary: 'Column summary', blocks })
  return id
}
function state(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  return Object.fromEntries(['documents', 'blocks', 'document_history', 'document_block_routes',
    'document_block_moves', 'markdown_link_sources', 'links', 'app_settings'].map(table =>
    [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
}
function document(blocks = columnForest()): SyncDocument {
  return { kind: 'document', id: 'columns', parentId: null, sortOrder: 0, createdAt: '2026-10-15T00:00:00Z',
    content: { title: 'Columns', summary: '', blocks } }
}
const copy = <T>(value: T): T => structuredClone(value)

test('column ownership validates mixed content, empty columns and the depth-six boundary', () => {
  const forest = columnForest()
  assertColumnStructure(forest, { checkParentIds: true })
  const empty = forest.filter(block => ['columns', 'column'].includes(block.type))
  assertColumnStructure(empty, { checkParentIds: true })
  assertColumnStructure([empty[0], { ...empty[1], markdownFormat: { columnWeight: 10000 } }], { checkParentIds: true })
  const nested = [
    ...forest.slice(0, 2),
    ...columnForest('nested-').slice(0, 8).map(block => ({ ...block, depth: block.depth + 2,
      parentBlockId: block.depth ? block.parentBlockId : 'left' })),
    ...forest.slice(5)
  ]
  assertColumnStructure(nested, { checkParentIds: true })
  const last = nested.find(block => block.id === 'nested-child')!
  nested.splice(nested.indexOf(last) + 1, 0, { id: 'boundary', type: 'todo', depth: 6, parentBlockId: last.id,
    content: 'Maximum depth', checked: false })
  assertColumnStructure(nested, { checkParentIds: true })
  nested.push({ id: 'too-deep', type: 'todo', depth: 7, parentBlockId: 'boundary', content: '', checked: false })
  assert.equal(validColumnStructure(nested, { checkParentIds: true }), false)
})

function invalidForests(): DocumentBlockDraft[][] {
  const variants: DocumentBlockDraft[][] = []
  const edit = (mutate: (blocks: DocumentBlockDraft[]) => void) => { const next = columnForest(); mutate(next); variants.push(next) }
  for (const weight of [undefined, 0, -1, 1.5, NaN, Infinity, 10001]) edit(blocks => { blocks[1].markdownFormat = { columnWeight: weight } })
  edit(blocks => { blocks[1].markdownFormat = { columnWeight: 4999 } })
  edit(blocks => { blocks[1].markdownFormat = { columnWeight: 5001 } })
  edit(blocks => { blocks[1].content = 'Structural text' })
  edit(blocks => { blocks[0].checked = true })
  edit(blocks => { blocks[1].language = 'ts' })
  edit(blocks => { blocks[1].listStart = 1 })
  edit(blocks => { blocks[1].markdownFormat = { columnWeight: 5000, listLoose: true } })
  edit(blocks => { blocks[0].markdownFormat = { columnWeight: 10000 } })
  edit(blocks => { blocks[2].type = 'frontmatter' })
  edit(blocks => { blocks[2].parentBlockId = 'right' })
  edit(blocks => { blocks[5].parentBlockId = null })
  edit(blocks => { blocks[8].id = 'group' })
  edit(blocks => { blocks[0].type = ' columns '; blocks[1].type = ' column '; blocks[5].type = ' column ' })
  edit(blocks => { blocks[0].id = undefined; blocks[1].parentBlockId = 'foreign' })
  variants.push([columnForest()[0]])
  variants.push([{ ...columnForest()[1], depth: 0, parentBlockId: null }])
  variants.push([columnForest()[0], { ...columnForest()[2], depth: 1, parentBlockId: 'group' }])
  variants.push([columnForest()[0], ...Array.from({ length: 7 }, (_, index) => ({
    ...columnForest()[1], id: 'column-' + index, markdownFormat: { columnWeight: index ? 1429 : 1426 }
  }))])
  return variants
}

test('invalid column updates leave rows, versions, history, routes and settings unchanged', () => withStore(h => {
  const id = create(h.store, 'Columns', columnForest()), before = state(h.store)
  for (const blocks of invalidForests()) {
    assert.equal(validColumnStructure(blocks), false)
    assert.throws(() => h.store.updateDocument(id, { title: 'Invalid mutation', summary: 'Changed', blocks }))
    assert.deepEqual(state(h.store), before)
  }
}))

test('real storage retains column IDs, annotations, creation times and exact history through restart and trash', () => withStore(h => {
  let store = h.store
  const forest = columnForest(), id = create(store, 'Columns', forest), db = store.getUnsafeDatabaseHandle()
  const rows = db.prepare('SELECT * FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id)
  store.getDocumentDetail(id); store.getSyncRecords(); store.getExportDocuments()
  assert.deepEqual(db.prepare('SELECT * FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id), rows)
  store = h.restart()
  assert.deepEqual(store.documentRecovery.readContent(id).blocks, forest)
  assert.deepEqual(store.getUnsafeDatabaseHandle().prepare('SELECT id,created_at FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id),
    (rows as Array<{ id: string; created_at: string }>).map(({ id, created_at }) => ({ id, created_at })))
  store.documentRecovery.checkpoint(id, 'edit', true)
  const history = store.documentRecovery.listHistory(id)[0], changed = copy(forest)
  changed[1].markdownFormat = { columnWeight: 2300 }; changed[5].markdownFormat = { columnWeight: 7700 }
  changed[2].content = 'Changed heading'
  store.updateDocument(id, { title: 'Columns', summary: 'Changed', blocks: changed })
  store.restoreDocumentHistory(id, history.id, store.getDocumentDetail(id)!.updatedAt)
  assert.deepEqual(store.documentRecovery.readContent(id).blocks, forest)
  store.deleteDocument(id); store = h.restart(); store.restoreTrashedDocument(id)
  assert.deepEqual(store.documentRecovery.readContent(id).blocks, forest)
}))

test('v23 migration creates one complete safety copy before introducing column ownership', () => withStore(h => {
  let store = h.store
  const id = create(store, 'Legacy', [{ id: 'legacy', type: 'paragraph', depth: 0, parentBlockId: null, content: 'Prior content', checked: false }])
  const before = store.documentRecovery.readContent(id)
  store.getUnsafeDatabaseHandle().pragma('user_version = 23'); store = h.restart()
  assert.equal(store.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
  assert.deepEqual(store.documentRecovery.readContent(id), before)
  const copies = readdirSync(h.root).filter(name => name.includes(`pre-migration-v23-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`))
  assert.equal(copies.length, 1)
  const backup = new Database(join(h.root, copies[0]), { readonly: true })
  try {
    assert.equal(backup.pragma('user_version', { simple: true }), 23)
    assert.deepEqual(backup.prepare('SELECT * FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id),
      store.getUnsafeDatabaseHandle().prepare('SELECT * FROM blocks WHERE document_id = ? ORDER BY sort_order').all(id))
  } finally { backup.close() }
  h.restart()
  assert.deepEqual(readdirSync(h.root).filter(name => name.includes('.pre-migration-')), copies)
}))

test('whole column groups transfer with stable IDs, timestamps, old-link routes and paired undo/redo after restart', () => withStore(h => {
  let store = h.store
  const forest = columnForest(), source = create(store, 'ColumnSource', forest)
  const targetForest = [{ id: 'target', type: 'toggle', depth: 0, parentBlockId: null, content: 'Target', checked: false, tags: [],
    markdownFormat: { toggleDefaultOpen: true } }]
  const target = create(store, 'ColumnTarget', targetForest)
  const before = [source, target].map(id => store.documentRecovery.readContent(id))
  const timestamps = store.getUnsafeDatabaseHandle().prepare('SELECT id,created_at FROM blocks ORDER BY id').all()
  const moved = store.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds: ['group'], parentBlockId: 'target',
    expectedFromUpdatedAt: store.getDocumentDetail(source)!.updatedAt, expectedToUpdatedAt: store.getDocumentDetail(target)!.updatedAt })
  assert.deepEqual(moved.movedBlockIds, forest.slice(0, -1).map(block => block.id))
  const expected = [...targetForest, ...forest.slice(0, -1).map(block => ({ ...block, depth: block.depth + 1,
    parentBlockId: block.id === 'group' ? 'target' : block.parentBlockId }))]
  assert.deepEqual(store.documentRecovery.readContent(target).blocks, expected)
  assert.deepEqual(store.getUnsafeDatabaseHandle().prepare('SELECT id,created_at FROM blocks ORDER BY id').all(), timestamps)
  assert.equal(store.getBlockReference('ColumnSource', 'task')!.documentId, target)
  store = h.restart()
  const undo = store.getDocumentBlockMoveHistory(target)!
  store.undoDocumentBlockMove({ operationId: undo.operationId, expectedUpdatedAtByDocument: undo.expectedUpdatedAtByDocument })
  assert.deepEqual([source, target].map(id => store.documentRecovery.readContent(id)), before)
  store = h.restart()
  const redo = store.getDocumentBlockMoveHistory(source)!
  store.redoDocumentBlockMove({ operationId: redo.operationId, expectedUpdatedAtByDocument: redo.expectedUpdatedAtByDocument })
  assert.deepEqual(store.documentRecovery.readContent(target).blocks, expected)
  assert.equal(store.getBlockReference('ColumnSource', 'task')!.documentId, target)
}))

test('ordinary content transfers out of columns while incomplete column-shell transfers are refused', () => {
  const from = columnForest(), to = columnForest('target-'), originals = copy([from, to])
  const moved = planDocumentBlockTransfer({ from, to, selectedIds: ['toggle'], parentBlockId: 'target-right' })!
  assert.ok(moved)
  assert.deepEqual(moved.movedIds, ['toggle', 'code'])
  assertColumnStructure(moved.sourceBlocks, { checkParentIds: true }); assertColumnStructure(moved.targetBlocks, { checkParentIds: true })
  assert.deepEqual(columnWeights(moved.sourceBlocks), [5000, 5000])
  for (const parentBlockId of [null, 'target-group', 'target-left']) {
    assert.equal(planDocumentBlockTransfer({ from, to, selectedIds: ['left'], parentBlockId }), null)
  }
  assert.deepEqual([from, to], originals)
})

test('protocol v3 gates typed and actual source columns but allows literal fenced and unmarked HTML examples', () => {
  const record = document()
  assert.equal(requiresPageCompositionProtocol(record), true)
  assert.equal(validateRecord(record, 'doc:columns', 3), record)
  for (const version of [1, 2] as const) assert.throws(() => validateRecord(record, 'doc:columns', version), /清单版本/)
  const source = '<section data-knowbook-container="columns-v1">\n\n<div data-knowbook-container="column-v1" data-knowbook-weight="10000">\n\nBody\n\n</div>\n\n</section>'
  const hidden = document([{ id: 'source', type: 'paragraph', content: source, checked: false, depth: 0, parentBlockId: null }])
  assert.equal(requiresPageCompositionProtocol(hidden), true)
  assert.equal(validateRecord(hidden, 'doc:columns', 3), hidden)
  for (const version of [1, 2] as const) assert.throws(() => validateRecord(hidden, 'doc:columns', version), /清单版本/)
  for (const content of ['```html\n' + source + '\n```', '<details>\n\n' + source + '\n\n</details>']) {
    const literal = document([{ id: 'literal', type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null }])
    assert.equal(requiresPageCompositionProtocol(literal), false)
    assert.equal(validateRecord(literal, 'doc:columns', 1), literal)
  }
  const code = document([{ id: 'code', type: 'code', content: source, checked: false, depth: 0, parentBlockId: null }])
  assert.equal(requiresPageCompositionProtocol(code), false)
  const damaged = copy(hidden); damaged.content.blocks[0].content = source.replace('10000', '9999')
  assert.throws(() => validateRecord(damaged, 'doc:columns', 3))
  const mixed = document([...columnForest(), ...damaged.content.blocks])
  assert.throws(() => validateRecord(mixed, 'doc:columns', 3), 'typed columns do not bypass validation of another marked source block')
  for (const version of [1, 2, 3]) assert.equal(parseManifest(Buffer.from(canonicalJson({ version, workspaceId: 'workspace', entries: {} }))).version, version)
  assert.throws(() => parseManifest(Buffer.from(canonicalJson({ version: 5, workspaceId: 'workspace', entries: {} }))))
})

test('separate column body edits and one complete resize merge without changing identities or inputs', () => {
  const base = document(), local = copy(base), remote = copy(base), originals = copy([base, local, remote])
  local.content.blocks[2].content = 'Local heading'; remote.content.blocks[6].content = 'Remote task'
  let merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, []); assert.equal(merged.document.content.blocks[2].content, 'Local heading')
  assert.equal(merged.document.content.blocks[6].content, 'Remote task')
  local.content.blocks[1].markdownFormat = { columnWeight: 2700 }; local.content.blocks[5].markdownFormat = { columnWeight: 7300 }
  merged = mergeSyncDocument(base, local, remote)
  assert.deepEqual(merged.unresolved, []); assert.deepEqual(columnWeights(merged.document.content.blocks), [2700, 7300])
  assert.equal(merged.document.content.blocks[6].content, 'Remote task')
  assert.equal(validSyncBlockTree(merged.document.content.blocks), true)
  assert.deepEqual(merged.document.content.blocks.map(({ id, depth, parentBlockId }) => [id, depth, parentBlockId]),
    base.content.blocks.map(({ id, depth, parentBlockId }) => [id, depth, parentBlockId]))
  assert.deepEqual(base, originals[0])
})

test('competing ratios resolve once per group and retain both independent text edits', () => {
  const base = document(), local = copy(base), remote = copy(base)
  local.content.blocks[1].markdownFormat = { columnWeight: 2000 }; local.content.blocks[5].markdownFormat = { columnWeight: 8000 }
  remote.content.blocks[1].markdownFormat = { columnWeight: 6500 }; remote.content.blocks[5].markdownFormat = { columnWeight: 3500 }
  local.content.blocks[2].content = 'Local heading'; remote.content.blocks[6].content = 'Remote task'
  const originals = copy([base, local, remote]), preview = mergeSyncDocument(base, local, remote)
  const id = 'block:group:column-layout'
  assert.deepEqual(preview.unresolved.map(part => part.id), [id])
  assert.equal(preview.unresolved[0].canEditText, false); assert.equal(preview.unresolved[0].property, 'columnWeights')
  for (const choice of ['local', 'remote'] as const) {
    const result = mergeSyncDocument(base, local, remote, { [id]: { choice } })
    assert.deepEqual(result.unresolved, [])
    assert.deepEqual(columnWeights(result.document.content.blocks), choice === 'local' ? [2000, 8000] : [6500, 3500])
    assert.equal(result.document.content.blocks[2].content, 'Local heading'); assert.equal(result.document.content.blocks[6].content, 'Remote task')
    assert.equal(validSyncBlockTree(result.document.content.blocks), true)
  }
  assert.deepEqual(mergeSyncDocument(base, local, remote, { [id]: { choice: 'custom', text: '[5000,5000]' } }).unresolved.map(part => part.id), [id])
  assert.deepEqual([base, local, remote], originals)
})

test('column reorder versus resize stays an explicit structural conflict and invalid choices cannot persist', () => {
  const base = document(), local = copy(base), remote = copy(base)
  local.content.blocks = [local.content.blocks[0], ...local.content.blocks.slice(5, 8), ...local.content.blocks.slice(1, 5), local.content.blocks[8]]
  remote.content.blocks[1].markdownFormat = { columnWeight: 2100 }; remote.content.blocks[5].markdownFormat = { columnWeight: 7900 }
  const result = mergeSyncDocument(base, local, remote)
  assert.deepEqual(result.unresolved.map(part => part.id), ['blocks'])
  for (const choice of ['local', 'remote'] as const) {
    const selected = mergeSyncDocument(base, local, remote, { blocks: { choice } })
    assert.deepEqual(selected.unresolved, []); assert.equal(validSyncBlockTree(selected.document.content.blocks), true)
    assert.deepEqual(selected.document.content.blocks, (choice === 'local' ? local : remote).content.blocks)
  }
  remote.content.blocks[1].markdownFormat = { columnWeight: 2101 }
  assert.deepEqual(mergeSyncDocument(base, local, remote, { blocks: { choice: 'remote' } }).unresolved.map(part => part.id), ['blocks'])
})
