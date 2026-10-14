import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'

function withStore(run: (store: KnowbookStore, restart: () => KnowbookStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-block-link-paths-'))
  const databasePath = join(root, 'knowbook.db')
  let current = new KnowbookStore(databasePath)
  try {
    run(current, () => { current.destroy(); current = new KnowbookStore(databasePath); return current })
  } finally { current.destroy(); rmSync(root, { recursive: true, force: true }) }
}
function create(store: KnowbookStore, title: string, parentId: string | null = null) {
  const id = store.createDocument(parentId)
  const detail = store.getDocumentDetail(id)!
  store.updateDocument(id, { title, summary: detail.summary, blocks: detail.blocks })
  return id
}
function rename(store: KnowbookStore, id: string, title: string) {
  const detail = store.getDocumentDetail(id)!
  store.updateDocument(id, { title, summary: detail.summary, blocks: detail.blocks })
}

type Scenario = { name: string; change: (store: KnowbookStore, ids: { ancestor: string; parent: string; leaf: string; destination: string }) => void; expectedPath: string }
const scenarios: Scenario[] = [
  { name: 'renaming the document', change: (store, ids) => rename(store, ids.leaf, 'RenamedLeaf'), expectedPath: 'Source/Branch/RenamedLeaf' },
  { name: 'renaming an ancestor', change: (store, ids) => rename(store, ids.ancestor, 'RenamedSource'), expectedPath: 'RenamedSource/Branch/Leaf' },
  { name: 'moving the document', change: (store, ids) => { store.moveDocument(ids.leaf, ids.destination) }, expectedPath: 'Destination/Leaf' },
  { name: 'moving an ancestor', change: (store, ids) => { store.moveDocument(ids.parent, ids.destination) }, expectedPath: 'Destination/Branch/Leaf' }
]
for (const scenario of scenarios) test('copied stable block links remain reachable after ' + scenario.name + ' and reopening the store', () => withStore((store, restart) => {
  const ancestor = create(store, 'Source'), parent = create(store, 'Branch', ancestor), leaf = create(store, 'Leaf', parent)
  const destination = create(store, 'Destination')
  const original = store.getDocumentDetail(leaf)!, stableBlock = original.blocks[0]
  const copiedPath = original.path, copiedFragment = '^' + stableBlock.id
  assert.equal(store.getBlockReference(copiedPath, copiedFragment)?.documentId, leaf)
  scenario.change(store, { ancestor, parent, leaf, destination })
  assert.equal(store.getDocumentDetail(leaf)?.path, scenario.expectedPath)
  assert.equal(store.getDocumentDetail(leaf)?.blocks[0].id, stableBlock.id, 'path changes retain the exact block identity')
  assert.equal(store.getBlockReference(scenario.expectedPath, copiedFragment)?.block.id, stableBlock.id)
  assert.equal(store.getBlockReference('Unrelated/UnknownPath', copiedFragment), null, 'an unrelated path cannot claim the globally stable block')
  const assertCopiedLink = (current: KnowbookStore) => {
    const resolved = current.getBlockReference(copiedPath, copiedFragment)
    assert.ok(resolved, 'a copied document path plus explicit stable block ID needs a historical route after ' + scenario.name)
    assert.equal(resolved.documentId, leaf)
    assert.equal(resolved.documentPath, scenario.expectedPath)
    assert.equal(resolved.block.id, stableBlock.id)
  }
  assertCopiedLink(store)
  assertCopiedLink(restart())
}))

test('deleting a parent promotes living descendants while retaining every old block path after restart', () => withStore((store, restart) => {
  const parent = create(store, 'Source'), child = create(store, 'Branch', parent), grandchild = create(store, 'Leaf', child)
  const originals = [store.getDocumentDetail(child)!, store.getDocumentDetail(grandchild)!]
  const deletedBlock = store.getDocumentDetail(parent)!.blocks[0]
  store.deleteDocument(parent)
  assert.equal(store.getDocumentDetail(parent), null)
  assert.equal(store.getDocumentSnapshot(child)?.parentId, null)
  const verify = (current: KnowbookStore) => {
    for (const original of originals) {
      const currentPath = original.path.slice('Source/'.length)
      assert.equal(current.getDocumentDetail(original.id)?.path, currentPath)
      assert.deepEqual(current.getDocumentDetail(original.id)?.blocks, original.blocks)
      for (const block of original.blocks) {
        const resolved = current.getBlockReference(original.path, '^' + block.id)
        assert.equal(resolved?.documentId, original.id)
        assert.equal(resolved?.documentPath, currentPath)
        assert.equal(resolved?.block.id, block.id)
        assert.equal(current.getBlockReference('Unrelated/UnknownPath', '^' + block.id), null)
      }
    }
    assert.equal(current.getBlockReference('Source', '^' + deletedBlock.id), null, 'deleted parent blocks are not resurrected by descendant aliases')
  }
  verify(store)
  verify(restart())
}))

test('trash restoration with a same-title occupant routes the old block link to its restored owner and rejects foreign IDs', () => withStore((store, restart) => {
  const parent = create(store, 'Parent'), originalId = create(store, 'Leaf', parent)
  const original = store.getDocumentDetail(originalId)!, blockId = original.blocks[0].id
  store.deleteDocument(originalId)
  const occupantId = create(store, 'Leaf', parent), occupant = store.getDocumentDetail(occupantId)!
  const foreignId = create(store, 'Foreign'), foreignBlockId = store.getDocumentDetail(foreignId)!.blocks[0].id
  assert.equal(occupant.path, original.path)
  assert.equal(store.restoreTrashedDocument(originalId), originalId)
  const restored = store.getDocumentDetail(originalId)!
  assert.notEqual(restored.path, original.path, 'the existing title occupant forces a distinct restored path')
  assert.deepEqual(restored.blocks, original.blocks)
  assert.deepEqual(store.getDocumentDetail(occupantId), occupant)
  const verify = (current: KnowbookStore) => {
    const resolved = current.getBlockReference(original.path, '^' + blockId)
    assert.equal(resolved?.documentId, originalId)
    assert.equal(resolved?.documentPath, restored.path)
    assert.equal(resolved?.block.id, blockId)
    assert.equal(current.getBlockReference('Unrelated/UnknownPath', '^' + blockId), null)
    assert.equal(current.getBlockReference(original.path, '^' + foreignBlockId), null, 'a recorded path does not admit other documents\' block IDs')
    assert.equal(current.getBlockReference(restored.path, '^' + occupant.blocks[0].id), null)
    assert.equal(current.getBlockReference(original.path, '^' + occupant.blocks[0].id)?.documentId, occupantId, 'reusing the old document path preserves the new occupant\'s own links')
    assert.deepEqual(current.getDocumentDetail(occupantId), occupant)
    assert.equal(current.documentRecovery.listTrash().some(entry => entry.id === originalId), false)
  }
  verify(store)
  verify(restart())
}))

test('a descendant path update failure rolls back aliases, all document content, timestamps, history and link projections', () => withStore((store, restart) => {
  const ancestor = create(store, 'Source'), parent = create(store, 'Branch', ancestor), leaf = create(store, 'Leaf', parent)
  const original = store.getDocumentDetail(leaf)!, blockId = original.blocks[0].id
  const incomingId = create(store, 'Incoming'), incoming = store.getDocumentDetail(incomingId)!
  store.updateDocument(incomingId, { title: incoming.title, summary: incoming.summary, blocks: [
    { ...incoming.blocks[0], type: 'paragraph', content: '[copied](Source/Branch/Leaf.md#^' + blockId + ')' }
  ] })
  const db = store.getUnsafeDatabaseHandle()
  const snapshot = (current: KnowbookStore) => Object.fromEntries(['documents', 'blocks', 'document_history', 'document_block_routes', 'markdown_link_sources', 'links']
    .map(table => [table, current.getUnsafeDatabaseHandle().prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
  const before = snapshot(store)
  const paths = ['Source', 'Source/Branch', 'Source/Branch/Leaf']
  const countAliases = (current: KnowbookStore) => current.getUnsafeDatabaseHandle()
    .prepare('SELECT COUNT(*) AS count FROM document_block_routes WHERE document_path IN (SELECT value FROM json_each(?))')
    .get(JSON.stringify(paths)) as { count: number }
  assert.equal(countAliases(store).count, 0, 'the current paths have not needed a historical route before this rename')
  db.exec("CREATE TEMP TRIGGER reject_path_rewrite BEFORE UPDATE OF path ON documents WHEN OLD.path = 'Source/Branch/Leaf' BEGIN SELECT RAISE(ABORT, 'injected path failure'); END")
  const ancestorBefore = store.getDocumentDetail(ancestor)!
  assert.throws(() => store.updateDocument(ancestor, { title: 'RenamedSource', summary: 'Should roll back', blocks: [
    { ...ancestorBefore.blocks[0], content: 'Should roll back too' }
  ] }), /injected path failure/)
  assert.deepEqual(snapshot(store), before, 'all data and projections must be identical after the transaction failure')
  assert.equal(countAliases(store).count, 0, 'aliases inserted before the failed path UPDATE must roll back too')
  assert.equal(store.getBlockReference(original.path, '^' + blockId)?.documentId, leaf)
  assert.equal(store.getBlockReference('RenamedSource/Branch/Leaf', '^' + blockId), null)
  const reopened = restart()
  assert.deepEqual(snapshot(reopened), before)
  assert.equal(countAliases(reopened).count, 0)
}))