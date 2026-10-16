import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { KnowbookStore } from '../src/main/database/store'
import { type SyncDocument, type SyncRecord } from '../src/main/sync/model'
import { preflightSyncBlockTransfers } from '../src/main/sync/repository'
import { markdownEngine } from '../src/shared/markdownEngine'
import type { DocumentBlockDraft } from '../src/shared/contracts'

const block = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })
function create(store: KnowbookStore, title: string, blocks: DocumentBlockDraft[]) {
  const id = store.createDocument(null); store.updateDocument(id, { title, summary: title + ' summary', blocks }); return id
}
function fixture(run: (a: KnowbookStore, b: KnowbookStore, paths: { a: string; b: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-sync-block-moves-'))
  const paths = { a: join(root, 'a.db'), b: join(root, 'b.db') }
  const a = new KnowbookStore(paths.a), b = new KnowbookStore(paths.b)
  for (const store of [a, b]) for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
  try { run(a, b, paths) } finally {
    a.destroy(); b.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('knowbook-sync-block-moves-'))
    rmSync(root, { recursive: true, force: true })
  }
}
function seed(a: KnowbookStore, b: KnowbookStore) {
  const source = create(a, 'Source', [block('move-id', '[out](Neighbor.md) [[#^keep-id]]'), block('keep-id', 'Keep')])
  const target = create(a, 'Target', [block('target-id', 'Target body')])
  const incoming = create(a, 'Incoming', [block('incoming-id', '[moved](Source.md#^move-id) [[Source#^move-id]] [stay](Source.md#^keep-id)')])
  create(a, 'Neighbor', [block('neighbor-id', 'Neighbor body')])
  b.applySyncRecords([...a.getSyncRecords().values()])
  return { source, target, incoming }
}
function moved(a: KnowbookStore, ids: ReturnType<typeof seed>) {
  return a.moveDocumentBlocks({ fromDocumentId: ids.source, toDocumentId: ids.target, blockIds: ['move-id'],
    expectedFromUpdatedAt: a.getDocumentDetail(ids.source)!.updatedAt, expectedToUpdatedAt: a.getDocumentDetail(ids.target)!.updatedAt })
}
function state(store: KnowbookStore) {
  const db = store.getUnsafeDatabaseHandle()
  return Object.fromEntries(['documents', 'blocks', 'document_history', 'document_trash', 'document_block_routes', 'document_block_moves',
    'markdown_link_sources', 'links', 'app_settings', 'document_search_ids', 'block_search_ids', 'document_search', 'block_search',
    'block_identities', 'synced_workspace_state', 'synced_groups', 'synced_group_blocks', 'synced_instances', 'synced_operations',
    'synced_group_history', 'synced_host_history', 'synced_host_history_documents', 'synced_host_history_state', 'synced_group_pins']
    .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
}
function record(store: KnowbookStore, id: string) { return store.getSyncRecords().get('doc:' + id)! as SyncDocument }
function releaseLocally(store: KnowbookStore, source: string) {
  const db = store.getUnsafeDatabaseHandle()
  const identity = db.prepare<[string], { id: string; last_owner_kind: string; last_owner_id: string; state: string; created_at: string }>(
    'SELECT * FROM block_identities WHERE id = ?').get('move-id')
  assert.ok(identity)
  const routes = [{ document_path: store.getDocumentSnapshot(source)!.path, block_id: 'move-id' }]
  db.prepare('INSERT OR IGNORE INTO document_block_routes(document_path,block_id) VALUES(?,?)').run(routes[0].document_path, 'move-id')
  const content = store.documentRecovery.readContent(source)
  store.updateDocument(source, { ...content, blocks: content.blocks.filter(value => value.id !== 'move-id') })
  assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id = ?').get('move-id'), undefined)
  assert.deepEqual(db.prepare('SELECT * FROM block_identities WHERE id = ?').get('move-id'), { ...identity, state: 'retained' })
  return { identity, routes }
}

test('two real stores receive complete moved IDs in either order without timestamp, old route, or index loss', () => {
  for (const targetFirst of [true, false]) fixture((a, b) => {
    const ids = seed(a, b), createdAt = (b.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get('move-id') as { created_at: string }).created_at
    const late = create(b, 'Late reader', [block('late-id', '[old](Source.md#%5Emove-id) [[Source#^move-id]]')])
    moved(a, ids)
    const owners = targetFirst ? [ids.target, ids.source] : [ids.source, ids.target]
    b.applySyncRecords([...owners, ids.incoming].map(id => record(a, id)))
    assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.target)
    assert.equal(b.getBlockReference('WrongPath', '^move-id'), null)
    assert.deepEqual(b.getDocumentDetail(ids.target)!.blocks.map(value => value.id), a.getDocumentDetail(ids.target)!.blocks.map(value => value.id))
    assert.equal((b.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get('move-id') as { created_at: string }).created_at, createdAt)
    assert.deepEqual(b.checkDocumentLinks(late, () => null).issues, [])
    assert.ok(b.getDocumentDetail(late)!.outgoingLinks.some(value => value.id === ids.target))
    assert.equal((b.getUnsafeDatabaseHandle().prepare('SELECT COUNT(*) AS count FROM markdown_link_sources WHERE source_block_id = ?').get('move-id') as { count: number }).count, 2)
    assert.ok(b.documentRecovery.listHistory(ids.source).some(value => value.reason === 'restore'))
    assert.ok(b.documentRecovery.listHistory(ids.target).some(value => value.reason === 'restore'))
    // Existing routes survive a second transfer and still follow the real owner.
    a.moveDocumentBlocks({ fromDocumentId: ids.target, toDocumentId: ids.source, blockIds: ['move-id'],
      expectedFromUpdatedAt: a.getDocumentDetail(ids.target)!.updatedAt, expectedToUpdatedAt: a.getDocumentDetail(ids.source)!.updatedAt })
    b.applySyncRecords([record(a, ids.source), record(a, ids.target), record(a, ids.incoming)])
    assert.equal(b.getBlockReference('Target', '^move-id')!.documentId, ids.source)
    assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.source)
    assert.deepEqual(b.checkDocumentLinks(late, () => null).issues, [])
  })
})

test('remote source deletion archives its full old content before transferring IDs and preserves observed aliases', () => fixture((a, b) => {
  const ids = seed(a, b), original = b.documentRecovery.readContent(ids.source)
  const createdAt = (b.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get('move-id') as { created_at: string }).created_at
  const late = create(b, 'Late reader', [block('late-id', '[old](Source.md#^move-id) [[Source#^move-id]]')])
  moved(a, ids); a.deleteDocument(ids.source)
  b.applySyncRecords([record(a, ids.target), { kind: 'deleted', id: ids.source }, record(a, ids.incoming)])
  assert.equal(b.getDocumentSnapshot(ids.source), null)
  assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.target)
  assert.deepEqual(b.checkDocumentLinks(late, () => null).issues, [])
  assert.equal((b.getUnsafeDatabaseHandle().prepare('SELECT created_at FROM blocks WHERE id = ?').get('move-id') as { created_at: string }).created_at, createdAt)
  const trash = b.documentRecovery.listTrash().find(value => value.id === ids.source)!
  assert.ok(trash)
  assert.deepEqual(b.documentRecovery.getTrash(ids.source).content, original)
}))

test('partial conflict batches, duplicate global IDs and post-transfer failures roll back data, history, routes and cursor together', () => fixture((a, b) => {
  const ids = seed(a, b); moved(a, ids)
  const target = record(a, ids.target), source = record(a, ids.source)
  const before = state(b)
  const attempts: SyncRecord[][] = [
    [target], // source may have an unresolved conflict; do not partially steal its block.
    [source, { ...target, content: { ...target.content, blocks: [...target.content.blocks, block('keep-id', 'duplicate')] } }],
    [source, source, target],
    [source, { kind: 'deleted', id: source.id }, target]
  ]
  for (const records of attempts) {
    assert.throws(() => b.runInTransaction(() => { b.saveSetting('sync-test-cursor', 'must rollback'); b.applySyncRecords(records) }), /同步批次/)
    assert.deepEqual(state(b), before)
  }
  const db = b.getUnsafeDatabaseHandle()
  db.prepare("CREATE TEMP TRIGGER reject_received_move BEFORE UPDATE OF updated_at ON documents WHEN NEW.id = '" + ids.target
    + "' BEGIN SELECT RAISE(ABORT, 'injected received move failure'); END").run()
  assert.throws(() => b.runInTransaction(() => { b.saveSetting('sync-test-cursor', 'must rollback'); b.applySyncRecords([target, source]) }), /injected received move failure/)
  assert.deepEqual(state(b), before)
  db.exec('DROP TRIGGER reject_received_move')
  b.runInTransaction(() => { b.applySyncRecords([target, source]); b.saveSetting('sync-test-cursor', 'accepted') })
  assert.equal(b.getSettingPublic('sync-test-cursor'), 'accepted')
  assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.target)
}))

test('independent SQLite receiver claims locally released IDs only with a complete selected owner release, preserving birth time and routes', () => {
  for (const targetFirst of [true, false]) fixture((a, b, paths) => {
    const ids = seed(a, b), previous = releaseLocally(b, ids.source)
    moved(a, ids)
    const receiver = new KnowbookStore(paths.b)
    try {
      const owners = targetFirst ? [ids.target, ids.source] : [ids.source, ids.target]
      receiver.applySyncRecords([...owners, ids.incoming].map(id => record(a, id)))
      const db = receiver.getUnsafeDatabaseHandle()
      assert.deepEqual(db.prepare('SELECT last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get('move-id'),
        { last_owner_kind: 'document', last_owner_id: ids.target, state: 'live', created_at: previous.identity.created_at })
      assert.equal((db.prepare('SELECT created_at FROM blocks WHERE id=?').get('move-id') as { created_at: string }).created_at, previous.identity.created_at)
      assert.deepEqual(db.prepare('SELECT * FROM document_block_routes WHERE block_id=? ORDER BY document_path').all('move-id'), previous.routes)
      assert.equal(receiver.getBlockReference('Source', '^move-id')!.documentId, ids.target)
      assert.deepEqual(receiver.getDocumentDetail(ids.target)!.blocks.map(value => value.id), a.getDocumentDetail(ids.target)!.blocks.map(value => value.id))
      assert.ok(receiver.getDocumentDetail(ids.incoming)!.outgoingLinks.some(value => value.id === ids.target))
      assert.deepEqual(db.pragma('foreign_key_check'), [])
    } finally { receiver.destroy() }
  })
})

test('already accepted source releases and tombstones authorize a retained target-only receive without rewriting the source', () => {
  for (const deleted of [false, true]) fixture((a, b) => {
    const ids = seed(a, b), previous = releaseLocally(b, ids.source)
    moved(a, ids)
    if (deleted) { a.deleteDocument(ids.source); b.deleteDocument(ids.source) }
    const proof: SyncRecord = deleted ? { kind: 'deleted', id: ids.source } : record(a, ids.source)
    const db = b.getUnsafeDatabaseHandle()
    const sourceBefore = db.prepare('SELECT * FROM documents WHERE id=?').get(ids.source)
    const historyBefore = db.prepare('SELECT * FROM document_history WHERE document_id=? ORDER BY rowid').all(ids.source)
    b.applySyncRecords([record(a, ids.target)], [proof])
    assert.deepEqual(db.prepare('SELECT * FROM documents WHERE id=?').get(ids.source), sourceBefore)
    assert.deepEqual(db.prepare('SELECT * FROM document_history WHERE document_id=? ORDER BY rowid').all(ids.source), historyBefore)
    assert.equal((db.prepare('SELECT created_at FROM blocks WHERE id=?').get('move-id') as { created_at: string }).created_at, previous.identity.created_at)
    assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.target)
    assert.deepEqual(db.prepare('SELECT * FROM document_block_routes WHERE block_id=? ORDER BY document_path').all('move-id'), previous.routes)
  })
})

test('retained identities reject missing or contradictory release evidence, foreign domains and a deferred receiver without changing any tables', () => fixture((a, b) => {
  const ids = seed(a, b), unreleased = record(a, ids.source)
  releaseLocally(b, ids.source); moved(a, ids)
  const source = record(a, ids.source), target = record(a, ids.target), db = b.getUnsafeDatabaseHandle()
  const before = state(b)
  const reject = (records: SyncRecord[], proofs: SyncRecord[] = []) => {
    assert.throws(() => b.runInTransaction(() => { b.saveSetting('sync-test-cursor', 'rejected'); b.applySyncRecords(records, proofs) }), /同步批次/)
    assert.deepEqual(state(b), before)
  }
  reject([target])
  reject([target], [unreleased])
  reject([source, target], [unreleased])
  reject([target], [source, source])
  assert.throws(() => preflightSyncBlockTransfers(db, [source], [target]), /同步批次缺少目标/)
  assert.deepEqual(state(b), before)
  for (const kind of ['group', 'reserved']) {
    db.prepare('UPDATE block_identities SET last_owner_kind=?,last_owner_id=? WHERE id=?').run(kind, 'foreign-owner', 'move-id')
    const foreign = state(b)
    assert.throws(() => b.applySyncRecords([source, target], [source]), /同步批次不能认领/)
    assert.deepEqual(state(b), foreign)
    db.prepare("UPDATE block_identities SET last_owner_kind='document',last_owner_id=? WHERE id=?").run(ids.source, 'move-id')
  }
  assert.deepEqual(state(b), before)
  b.applySyncRecords([target], [source])
  assert.equal(b.getBlockReference('Source', '^move-id')!.documentId, ids.target)
}))

test('accepted source proof cannot bypass checkpointing a live foreign owner', () => fixture((a, b) => {
  const ids = seed(a, b); moved(a, ids)
  const before = state(b)
  assert.throws(() => b.applySyncRecords([record(a, ids.target)], [record(a, ids.source)]), /同步批次缺少原文档/)
  assert.deepEqual(state(b), before)
}))

test('retained transitions recheck ownership after preflight and roll back later insert failures before a clean retry', () => fixture((a, b, paths) => {
  const ids = seed(a, b), previous = releaseLocally(b, ids.source)
  moved(a, ids)
  const receiver = new KnowbookStore(paths.b)
  try {
    const db = receiver.getUnsafeDatabaseHandle(), batch = [ids.target, ids.source, ids.incoming].map(id => record(a, id))
    const before = state(receiver)
    // This runs after preflight but before the explicit retained claim. It
    // models an intervening owner transition inside the selected transaction.
    db.prepare(`CREATE TEMP TRIGGER change_retained_owner BEFORE DELETE ON markdown_link_sources
      WHEN OLD.source_document_id='${ids.incoming}' BEGIN
        UPDATE block_identities SET last_owner_id='unexpected-owner' WHERE id='move-id'; END`).run()
    assert.throws(() => receiver.runInTransaction(() => { receiver.saveSetting('sync-test-cursor', 'rejected'); receiver.applySyncRecords(batch) }), /同步块归属已变化/)
    assert.deepEqual(state(receiver), before)
    db.exec('DROP TRIGGER change_retained_owner')
    db.exec(`CREATE TEMP TRIGGER reject_retained_insert BEFORE INSERT ON blocks WHEN NEW.id='move-id'
      BEGIN SELECT RAISE(ABORT,'injected retained receive failure'); END`)
    assert.throws(() => receiver.runInTransaction(() => { receiver.saveSetting('sync-test-cursor', 'rejected'); receiver.applySyncRecords(batch) }), /injected retained receive failure/)
    assert.deepEqual(state(receiver), before)
    db.exec('DROP TRIGGER reject_retained_insert')
    receiver.runInTransaction(() => { receiver.applySyncRecords(batch); receiver.saveSetting('sync-test-cursor', 'accepted') })
    assert.equal(receiver.getSettingPublic('sync-test-cursor'), 'accepted')
    assert.equal(receiver.getBlockReference('Source', '^move-id')!.documentId, ids.target)
    assert.equal((db.prepare('SELECT created_at FROM blocks WHERE id=?').get('move-id') as { created_at: string }).created_at, previous.identity.created_at)
    assert.deepEqual(db.prepare('SELECT * FROM document_block_routes WHERE block_id=? ORDER BY document_path').all('move-id'), previous.routes)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally { receiver.destroy() }
}))

test('real store footnote move preserves rendered closures and metadata with paired undo while unsafe source containers reject without writes', () => fixture((a) => {
  const source = create(a, 'Notes', [block('note-use', 'Use[^n]'), block('note-definition', '[^n]: **Original** [link][r], child[^child]\n\n    - list\n\n[^child]: Child\n\n[r]: Neighbor.md')])
  const target = create(a, 'Target notes', [block('existing-note', 'Target[^n]\n\n[^n]: Target definition')])
  const originalSource = a.documentRecovery.readContent(source), originalTarget = a.documentRecovery.readContent(target)
  const move = a.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds: ['note-use'],
    expectedFromUpdatedAt: a.getDocumentDetail(source)!.updatedAt, expectedToUpdatedAt: a.getDocumentDetail(target)!.updatedAt })
  const html = markdownEngine.render(move.target.blocks.map(value => value.content).join('\n\n'))
  assert.ok(html.includes('<strong>Original</strong>'))
  assert.ok(html.includes('Target definition'))
  assert.ok(html.includes('Child'))
  assert.ok(html.includes('<li>list</li>'))
  a.undoDocumentBlockMove({ operationId: move.operationId, expectedUpdatedAtByDocument: move.expectedUpdatedAtByDocument })
  assert.deepEqual(a.documentRecovery.readContent(source), originalSource)
  assert.deepEqual(a.documentRecovery.readContent(target), originalTarget)
  const unsafe = create(a, 'Unsafe note', [{ ...block('unsafe-use', 'Use[^n]'), type: 'todo' }, block('unsafe-definition', '[^n]: Original')])
  const before = state(a)
  assert.throws(() => a.moveDocumentBlocks({ fromDocumentId: unsafe, toDocumentId: target, blockIds: ['unsafe-use'],
    expectedFromUpdatedAt: a.getDocumentDetail(unsafe)!.updatedAt, expectedToUpdatedAt: a.getDocumentDetail(target)!.updatedAt }), /脚注定义.*未移动任何块/)
  assert.deepEqual(state(a), before)
}))
