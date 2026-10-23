import assert from 'node:assert/strict'
import test from 'node:test'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2PhysicalGraphOwned } from '../src/main/database/restore-knowledge-capsule2-physical-raw-read'
import { readRawCapsule2HostDocumentOwned, readStrictHostDocument } from '../src/main/database/synced-host-document-read'
import { validateRecord, type SyncDocument } from '../src/main/sync/model'
import { decodedCapsule2Table, withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { snapshot, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('capsule2 physical source preserves signed document order accepted by the actual ordinary sync writer', () => withV3Fixture(async f => {
  const groupBefore = snapshot(f.db, f.groupId)
  const acknowledgement = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  const ids: string[] = []
  for (const sortOrder of [-7, Number.MIN_SAFE_INTEGER]) {
    const id = f.store.createDocument(null), detail = f.store.getDocumentDetail(id)!
    const createdAt = (f.db.prepare('SELECT created_at FROM documents WHERE id=?').get(id) as { created_at: string }).created_at
    const record: SyncDocument = { kind: 'document', id, parentId: null, sortOrder, createdAt,
      content: { title: 'Signed order ' + sortOrder, summary: detail.summary, blocks: detail.blocks } }
    validateRecord(record, 'doc:' + id)
    f.store.applySyncRecords([record])
    assert.deepEqual(f.db.prepare('SELECT sort_order FROM documents WHERE id=?').get(id), { sort_order: sortOrder })
    assert.ok(f.store.getDocumentDetail(id))
    ids.push(id)
  }
  await withCapsule2RawCopy(f, db => {
    const before = db.transaction(() => readRawCapsule2ContentOwned(db))()
    for (const id of ids) assert.throws(() => db.transaction(() => readStrictHostDocument(db, id))(), /宿主原始存储/)
    const observed = db.transaction(() => readRawCapsule2PhysicalGraphOwned(db))()
    assert.deepEqual(ids.map(id => observed.documents.find(row => row.documentId === id)?.sortOrder), [-7, Number.MIN_SAFE_INTEGER])
    const originals = decodedCapsule2Table(before, 'documents')
    assert.deepEqual(ids.map(id => originals.find(row => row.id === id)?.sort_order), [-7n, BigInt(Number.MIN_SAFE_INTEGER)])
    assert.equal(observed.certified, false)
    assert.equal(observed.semanticValidationComplete, false)
    assert.deepEqual(db.transaction(() => readRawCapsule2ContentOwned(db))(), before)
    assert.equal((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count, 0)
    for (const id of ids) assert.throws(() => db.transaction(() => readStrictHostDocument(db, id))(), /宿主原始存储/)
  })
  assert.deepEqual(snapshot(f.db, f.groupId), groupBefore)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId), acknowledgement)
}))

test('capsule2 host leaf requires actual readonly query-only FK-enabled ownership and leaves the original reader result unchanged', () => withV3Fixture(async f => {
  assert.throws(() => f.db.transaction(() => readRawCapsule2HostDocumentOwned(f.db, f.targetId))(), /宿主原始存储/)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => readRawCapsule2HostDocumentOwned(db, f.targetId), /宿主原始存储/)
    const original = db.transaction(() => readStrictHostDocument(db, f.targetId))()
    assert.ok(original)
    assert.deepEqual(db.transaction(() => readRawCapsule2HostDocumentOwned(db, f.targetId))(), original)
    assert.equal(db.transaction(() => readRawCapsule2HostDocumentOwned(db, 'missing-source-document'))(), null)
    db.pragma('query_only=OFF')
    assert.throws(() => db.transaction(() => readRawCapsule2HostDocumentOwned(db, f.targetId))(), /宿主原始存储/)
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=OFF')
    assert.throws(() => db.transaction(() => readRawCapsule2HostDocumentOwned(db, f.targetId))(), /宿主原始存储/)
  })
}))

for (const invalidOrder of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`capsule2 host leaf still rejects non-app document order ${invalidOrder} without rewriting source SQL`, () => withV3Fixture(async f => {
    // Deliberately corrupt fixture: neither value is accepted by validateRecord.
    f.db.prepare('UPDATE documents SET sort_order=? WHERE id=?').run(invalidOrder, f.targetId)
    await withCapsule2RawCopy(f, db => {
      const before = db.transaction(() => readRawCapsule2ContentOwned(db))()
      assert.throws(() => db.transaction(() => readRawCapsule2HostDocumentOwned(db, f.targetId))(), /宿主原始存储/)
      assert.throws(() => db.transaction(() => readRawCapsule2PhysicalGraphOwned(db))(), /宿主原始存储/)
      assert.deepEqual(db.transaction(() => readRawCapsule2ContentOwned(db))(), before)
      assert.equal((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count, 0)
    })
  }))
}
