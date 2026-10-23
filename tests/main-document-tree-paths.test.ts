import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'

function withStore(run: (store: KnowbookStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-document-tree-paths-'))
  const store = new KnowbookStore(join(root, 'workspace.db'))
  try { run(store) } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
}
function create(store: KnowbookStore, title: string, parent: string | null = null, text = '') {
  const id = store.createDocument(parent), detail = store.getDocumentDetail(id)!
  store.updateDocument(id, { title, summary: '', blocks: [{ ...detail.blocks[0], content: text }] })
  return id
}
function rename(store: KnowbookStore, id: string, title: string) {
  return store.updateDocument(id, { ...store.getDocumentDetail(id)!, title })
}
function state(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  return ['documents', 'blocks', 'block_identities', 'document_block_routes', 'document_history', 'document_trash',
    'links', 'markdown_link_sources', 'document_search', 'block_search'].map(table =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
}
const operations = ['rename', 'move', 'delete'] as const
for (const operation of operations) {
  test(`document ${operation} follows parent IDs without changing a case-distinct sibling tree or its routes`, () => withStore(store => {
    const root = create(store, 'Case'), leaf = create(store, 'Leaf', root), deep = create(store, 'Deep', leaf)
    // Creation/rename avoid case-insensitive siblings, but the actual delete
    // writer accepts promotion of "case" beside "Case". Preserve that domain.
    const wrapper = create(store, 'Wrapper'), other = create(store, 'case', wrapper)
    store.deleteDocument(wrapper)
    assert.equal(store.getDocumentSnapshot(other)?.path, 'case')
    const otherLeaf = create(store, 'Other', other), otherDeep = create(store, 'Deep', otherLeaf)
    const archive = create(store, 'Archive')
    const source = create(store, 'References', null, '[tracked](Case/Leaf/Deep.md) [other](case/Other/Deep.md)')
    const otherBefore = [other, otherLeaf, otherDeep].map(id => store.getDocumentSnapshot(id))
    const deepBefore = store.getDocumentDetail(deep)!.blocks
    const oldPath = store.getDocumentSnapshot(deep)!.path
    const routesBefore = store.getUnsafeDatabaseHandle().prepare(`SELECT * FROM document_block_routes
      WHERE block_id IN (SELECT id FROM blocks WHERE document_id IN (?, ?, ?)) ORDER BY document_path, block_id`).all(other, otherLeaf, otherDeep)
    const changed = operation === 'rename' ? rename(store, root, 'Renamed')
      : operation === 'move' ? store.moveDocument(root, archive) : store.deleteDocument(root)
    const prefix = operation === 'rename' ? 'Renamed/' : operation === 'move' ? 'Archive/Case/' : ''
    assert.deepEqual([other, otherLeaf, otherDeep].map(id => store.getDocumentSnapshot(id)), otherBefore)
    assert.equal(store.getDocumentSnapshot(leaf)?.path, prefix + 'Leaf')
    assert.equal(store.getDocumentSnapshot(deep)?.path, prefix + 'Leaf/Deep')
    assert.equal(store.getDocumentSnapshot(leaf)?.parentId, operation === 'delete' ? null : root)
    assert.equal(store.getDocumentDetail(source)!.blocks[0].content,
      `[tracked](${prefix}Leaf/Deep.md) [other](case/Other/Deep.md)`)
    assert.equal(store.getBlockReference(oldPath, deepBefore[0].id)?.documentPath, prefix + 'Leaf/Deep')
    assert.deepEqual(store.getDocumentDetail(deep)!.blocks, deepBefore)
    assert.deepEqual(store.getUnsafeDatabaseHandle().prepare(`SELECT * FROM document_block_routes
      WHERE block_id IN (SELECT id FROM blocks WHERE document_id IN (?, ?, ?)) ORDER BY document_path, block_id`).all(other, otherLeaf, otherDeep), routesBefore)
    assert.ok(changed.includes(leaf) && changed.includes(deep) && changed.includes(source))
    assert.ok([other, otherLeaf, otherDeep].every(id => !changed.includes(id)))
    assert.deepEqual(store.checkDocumentLinks(source, () => null).issues, [])
  }))

  test(`document ${operation} preserves complete Unicode descendant paths and historical block references`, () => withStore(store => {
    const parent = create(store, '父😀'), root = create(store, '😀组', parent)
    const leaf = create(store, 'A🧑‍💻子', root), deep = create(store, 'B𠮷孙', leaf), archive = create(store, '档📁')
    const before = store.getDocumentSnapshot(deep)!, blockId = store.getDocumentDetail(deep)!.blocks[0].id
    const changed = operation === 'rename' ? rename(store, root, '改🦊名')
      : operation === 'move' ? store.moveDocument(root, archive) : store.deleteDocument(root)
    const prefix = operation === 'rename' ? '父😀/改🦊名/' : operation === 'move' ? '档📁/😀组/' : '父😀/'
    assert.equal(store.getDocumentSnapshot(leaf)?.path, prefix + 'A🧑‍💻子')
    assert.equal(store.getDocumentSnapshot(deep)?.path, prefix + 'A🧑‍💻子/B𠮷孙')
    assert.equal(store.getBlockReference(before.path, blockId)?.documentId, deep)
    assert.equal(store.getBlockReference(before.path, blockId)?.documentPath, prefix + 'A🧑‍💻子/B𠮷孙')
    assert.ok(changed.includes(leaf) && changed.includes(deep))
  }))

  test(`document ${operation} rolls back paths, history, routes, links and search after a late descendant failure`, () => withStore(store => {
    const root = create(store, 'Atomic'), leaf = create(store, 'Child', root), deep = create(store, 'Deep', leaf)
    const archive = create(store, 'Archive')
    create(store, 'References', null, '[child](Atomic/Child/Deep.md)')
    const db = store.getUnsafeDatabaseHandle(), before = state(store)
    db.exec(`CREATE TEMP TRIGGER fail_descendant_path BEFORE UPDATE OF path ON documents
      WHEN old.id = '${deep}' BEGIN SELECT RAISE(ABORT, 'injected descendant path failure'); END`)
    assert.throws(() => operation === 'rename' ? rename(store, root, 'Renamed')
      : operation === 'move' ? store.moveDocument(root, archive) : store.deleteDocument(root), /injected descendant path failure/)
    assert.deepEqual(state(store), before)
  }))
}

test('case-only rename keeps the other root and every actual descendant in the reported change set', () => withStore(store => {
  const other = create(store, 'Cases'), otherLeaf = create(store, 'Other', other)
  const root = create(store, 'case'), leaf = create(store, 'Leaf', root)
  const changed = rename(store, root, 'CASE')
  assert.equal(store.getDocumentSnapshot(leaf)?.path, 'CASE/Leaf')
  assert.equal(store.getDocumentSnapshot(otherLeaf)?.path, 'Cases/Other')
  assert.deepEqual(new Set(changed), new Set([root, leaf]))
}))

test('literal percent and underscore titles do not select a matching-looking sibling tree', () => withStore(store => {
  const root = create(store, 'A%_'), leaf = create(store, 'Child', root)
  const other = create(store, 'AbcX'), otherLeaf = create(store, 'Child', other)
  assert.deepEqual(new Set(rename(store, root, 'Final%_')), new Set([root, leaf]))
  assert.equal(store.getDocumentSnapshot(leaf)?.path, 'Final%_/Child')
  assert.equal(store.getDocumentSnapshot(otherLeaf)?.path, 'AbcX/Child')
}))

test('move rejects a real descendant even when stored paths disagree with parent identity', () => withStore(store => {
  const root = create(store, 'Legacy😀'), leaf = create(store, 'Child', root), deep = create(store, 'Deep', leaf)
  // Explicit pre-existing path corruption, not a claim that the current writer
  // produced it. Parent identity is still authoritative; opening never repairs it.
  store.getUnsafeDatabaseHandle().prepare('UPDATE documents SET path = ? WHERE id = ?').run('Legacy/hild/Deep', deep)
  const before = state(store)
  assert.throws(() => store.moveDocument(root, deep), /own subtree/)
  assert.deepEqual(state(store), before)
}))
