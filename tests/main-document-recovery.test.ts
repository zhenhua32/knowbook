import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { DOCUMENT_HISTORY_LIMIT } from '../src/shared/document-recovery'

function withStore(run: (store: KnowbookStore, path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-recovery-')), path = join(root, 'test.db')
  const store = new KnowbookStore(path)
  try { run(store, path) } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
}
function change(store: KnowbookStore, id: string, text: string) {
  const detail = store.getDocumentDetail(id)!
  store.updateDocument(id, { ...detail, blocks: [{ id: detail.blocks[0].id, type: 'paragraph', content: text, checked: false, depth: 0 }] })
}

test('trash survives restart, excludes deleted content from search and restores IDs, metadata and links', () => withStore((store, path) => {
  const parent = store.createDocument(null), id = store.createDocument(parent), child = store.createDocument(id)
  const detail = store.getDocumentDetail(id)!
  store.updateDocument(id, { ...detail, title: 'Recovery target', summary: 'Saved summary', blocks: [
    { id: detail.blocks[0].id, type: 'bulleted-list', content: 'UniqueRecoveryText', checked: false, depth: 0, tags: ['keep'], highlight: 'yellow' },
    { id: detail.blocks[1].id, type: 'bulleted-list', content: 'Nested', checked: false, depth: 1, parentBlockId: detail.blocks[0].id }
  ] })
  const original = store.getDocumentDetail(id)!
  const source = store.createDocument(null)
  change(store, source, `[[Recovery target#${detail.blocks[0].id}]]`)
  store.deleteDocument(id)
  assert.equal(store.getDocumentDetail(id), null)
  assert.equal(store.getDocumentSnapshot(child)?.parentId, parent)
  assert.equal(store.searchDocuments('UniqueRecoveryText').length, 0)
  const reopened = new KnowbookStore(path)
  try {
    assert.equal(reopened.documentRecovery.listTrash()[0].id, id)
    reopened.restoreTrashedDocument(id)
    assert.equal(reopened.getDocumentSnapshot(id)?.parentId, parent)
    assert.deepEqual(reopened.getDocumentDetail(id)!.blocks, original.blocks)
    assert.equal(reopened.getDocumentDetail(id)!.summary, original.summary)
    assert.equal(reopened.getDocumentDetail(id)!.backlinks.some((link) => link.id === source), true)
    assert.equal(reopened.searchDocuments('UniqueRecoveryText')[0]?.documentId, id)
    assert.equal(reopened.documentRecovery.listTrash().length, 0)
  } finally { reopened.destroy() }
}))

test('restore tolerates deleted parents, conflicting titles and changed field options', () => withStore((store) => {
  const parent = store.createDocument(null), id = store.createDocument(parent)
  const database = store.getDatabases()[0]
  const column = store.createDocumentDatabaseColumn({ databaseId: database.id, name: 'State', type: 'multi-select', options: ['Keep', 'Old'] })
  store.updateDocumentDatabaseValue({ documentId: id, columnId: column.id, value: ['Keep', 'Old'] })
  const entity = store.createDatabaseEntity({ databaseId: database.id, documentId: id, title: 'Linked record', fieldValues: { [column.id]: ['Keep', 'Old'] } })
  const deletedTitle = store.getDocumentSnapshot(id)!.title
  store.deleteDocument(id); store.deleteDocument(parent)
  store.updateDocumentDatabaseColumnOptions({ columnId: column.id, options: ['Keep'] })
  const other = store.createDocument(null)
  store.updateDocument(other, { ...store.getDocumentDetail(other)!, title: deletedTitle })
  store.restoreTrashedDocument(id)
  assert.equal(store.getDocumentSnapshot(id)!.parentId, null)
  assert.notEqual(store.getDocumentSnapshot(id)!.title, store.getDocumentSnapshot(other)!.title)
  assert.deepEqual(store.getDocumentCatalog().find((doc) => doc.id === id)?.fieldValues[column.id], ['Keep'])
  const restored = store.getDatabaseEntities(database.id).find((row) => row.id === entity.id)!
  assert.equal(restored.title, 'Linked record')
  assert.deepEqual(restored.fieldValues[column.id], ['Keep'])
}))

test('failed delete and failed restore leave their original recoverable data intact', () => withStore((store) => {
  const parent = store.createDocument(null), id = store.createDocument(parent), child = store.createDocument(id)
  const conflict = store.createDocument(parent)
  store.updateDocument(child, { ...store.getDocumentDetail(child)!, title: 'Child conflict' })
  store.updateDocument(conflict, { ...store.getDocumentDetail(conflict)!, title: store.getDocumentSnapshot(child)!.title })
  assert.throws(() => store.deleteDocument(id), /sibling title/)
  assert.equal(store.documentRecovery.listTrash().length, 0)
  store.moveDocument(conflict, null)
  const blockId = store.getDocumentDetail(id)!.blocks[0].id
  store.deleteDocument(id)
  // A later import may reuse a block ID; never silently overwrite its owner.
  store.updateDocument(conflict, { ...store.getDocumentDetail(conflict)!, blocks: [{ id: blockId, type: 'paragraph', content: 'Owned elsewhere', checked: false, depth: 0 }] })
  assert.throws(() => store.restoreTrashedDocument(id), /UNIQUE/)
  assert.equal(store.getDocumentDetail(id), null)
  assert.equal(store.documentRecovery.listTrash()[0].id, id)
  assert.equal(store.getDocumentDetail(conflict)!.blocks[0].content, 'Owned elsewhere')
}))

test('history coalesces automatic saves, survives reopen, and saves the current version before restoration', () => withStore((store, path) => {
  const id = store.createDocument(null), original = store.getDocumentDetail(id)!
  change(store, id, 'First edit'); change(store, id, 'Second edit')
  assert.equal(store.documentRecovery.listHistory(id).length, 1)
  const version = store.documentRecovery.listHistory(id)[0]
  assert.deepEqual(store.documentRecovery.getHistory(id, version.id).content.blocks.map((b) => b.content), original.blocks.map((b) => b.content))
  const reopened = new KnowbookStore(path)
  try {
    assert.equal(reopened.documentRecovery.listHistory(id)[0].id, version.id)
    assert.throws(() => reopened.restoreDocumentHistory(id, version.id, 'stale'), /changed/)
    reopened.restoreDocumentHistory(id, version.id, reopened.getDocumentDetail(id)!.updatedAt)
    assert.deepEqual(reopened.getDocumentDetail(id)!.blocks, original.blocks)
    const undoVersion = reopened.documentRecovery.listHistory(id)[0]
    assert.equal(undoVersion.reason, 'restore')
    reopened.restoreDocumentHistory(id, undoVersion.id, reopened.getDocumentDetail(id)!.updatedAt)
    assert.equal(reopened.getDocumentDetail(id)!.blocks[0].content, 'Second edit')
  } finally { reopened.destroy() }
}))

test('no-op saves do not create history and invalid updates roll back their checkpoint', () => withStore((store) => {
  const id = store.createDocument(null), other = store.createDocument(null)
  const detail = store.getDocumentDetail(id)!
  store.updateDocument(id, detail)
  assert.equal(store.documentRecovery.listHistory(id).length, 0)
  assert.throws(() => store.updateDocument(id, { ...detail, blocks: store.getDocumentDetail(other)!.blocks }), /UNIQUE/)
  assert.equal(store.documentRecovery.listHistory(id).length, 0)
  assert.deepEqual(store.getDocumentDetail(id)!.blocks, detail.blocks)
}))

test('history is bounded and permanent deletion removes the trash and associated history', () => withStore((store) => {
  const id = store.createDocument(null)
  for (let index = 0; index < DOCUMENT_HISTORY_LIMIT + 5; index++) store.documentRecovery.checkpoint(id, 'restore')
  assert.equal(store.documentRecovery.listHistory(id).length, DOCUMENT_HISTORY_LIMIT)
  store.deleteDocument(id)
  store.documentRecovery.purge(id)
  assert.equal(store.documentRecovery.listTrash().length, 0)
  assert.equal(store.documentRecovery.listHistory(id).length, 0)
  assert.throws(() => store.restoreTrashedDocument(id), /not found/)
}))

test('an intentionally empty workspace stays empty after restart, including after emptying Trash', () => withStore((store, path) => {
  for (const document of store.getDocumentIndex().sort((a, b) => b.path.length - a.path.length)) store.deleteDocument(document.id)
  assert.equal(store.getDocumentCount(), 0)
  const reopened = new KnowbookStore(path)
  try {
    assert.equal(reopened.getDocumentCount(), 0)
    assert.equal(reopened.documentRecovery.listTrash().length, 3)
    for (const entry of reopened.documentRecovery.listTrash()) reopened.documentRecovery.purge(entry.id)
  } finally { reopened.destroy() }
  const empty = new KnowbookStore(path)
  try { assert.equal(empty.getDocumentCount(), 0) } finally { empty.destroy() }
}))
