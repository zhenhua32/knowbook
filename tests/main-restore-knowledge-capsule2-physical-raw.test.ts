import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { readRawCapsule2PhysicalGraphOwned } from '../src/main/database/restore-knowledge-capsule2-physical-raw-read'
import { readRawInitialIncomingWorkspaceOwned } from '../src/main/database/synced-initial-incoming-raw-read'
import { readRawSyncedPersistentPublicationSnapshotOwned } from '../src/main/database/synced-publication-raw-read'
import { readStrictHostDocument } from '../src/main/database/synced-host-document-read'
import { validateInitialRecord } from '../src/main/sync/synced-publication-model'
import { command, insertAck, applySyncedHostCommand } from './helpers/synced-host-command-insert-fixture'
import { withV3Fixture, makeV3Orphan, snapshot, type V3Fixture } from './helpers/synced-backup-v3-fixture'

// PREPARED ONLY: never imported or executed during this preparation. The existing
// real Main fixture owns its isolated DB and process-free cleanup. No DDL,
// worker/retry/timeout, Electron window or fixture restriction is changed.
async function withRawPhysicalCopy<T>(f: V3Fixture, run: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const file = join(f.root, 'capsule2-physical-only-' + randomUUID() + '.db')
  await f.db.backup(file)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try { db.pragma('foreign_keys=ON'); db.pragma('query_only=ON'); return await run(db) }
  finally { db.close() }
}
function unrelatedOrdinary501(f: V3Fixture) {
  // f.targetId is a real canonical heading-binding target, so renaming targetId
  // would not prove the required unrelated-document case. Create a third root.
  const id = f.store.createDocument(null), title = '独'.repeat(501)
  const detail = f.store.getDocumentDetail(id); assert.ok(detail)
  f.store.updateDocument(id, { title, summary: 'Independent ordinary content', blocks: detail.blocks })
  assert.equal(f.store.getDocumentDetail(id)?.title, title)
  assert.equal(f.db.prepare('SELECT 1 FROM synced_instances WHERE host_document_id=?').get(id), undefined)
  const group = snapshot(f.db, f.groupId)
  assert.notEqual(group.origin.documentId, id)
  assert.ok(group.bindings.every(({ target }) => {
    if (target.kind === 'unresolved-url') return true
    return target.kind === 'document' ? target.id !== id : target.documentId !== id
  }))
  return { id, title }
}

test('physical raw2 keeps a true Main group plus unrelated legal ordinary501 while both legacy raw publication paths still reject wire500', () => withV3Fixture(async f => {
  const independent = unrelatedOrdinary501(f), beforeGroup = snapshot(f.db, f.groupId)
  const beforeAck = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  const template = f.store.saveDocumentTemplate({ name: 'Actual no-ledger template', title: 'Template', summary: '',
    blocks: [{ type: 'paragraph', content: 'Allocated by actual Store template writer', checked: false, depth: 0, parentBlockId: null }] })
  for (const item of template.blocks) { assert.ok(item.id); assert.equal(f.db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(item.id), undefined) }
  await withRawPhysicalCopy(f, db => {
    assert.throws(() => readRawCapsule2PhysicalGraphOwned(db), /owned事务/)
    const before = db.prepare('SELECT total_changes() AS count').get()
    assert.throws(() => db.transaction(() => readRawSyncedPersistentPublicationSnapshotOwned(db))(), /文档标题无效/)
    assert.throws(() => db.transaction(() => readRawInitialIncomingWorkspaceOwned(db))(), /文档标题无效/)
    const raw = db.transaction(() => readRawCapsule2PhysicalGraphOwned(db))()
    assert.equal(raw.documents.find(item => item.documentId === independent.id)?.title, independent.title)
    assert.deepEqual(raw.groups.find(item => item.groupId === f.groupId)?.snapshot, beforeGroup)
    assert.equal(raw.instances.length, 1)
    assert.equal(raw.instances[0].instance_id, f.instanceId)
    assert.equal(raw.identities.find(row => row.id === beforeGroup.blocks[0].id)?.created_at, beforeGroup.blocks[0].createdAt)
    assert.equal(raw.certified, false); assert.equal(raw.semanticValidationComplete, false)
    assert.ok(raw.unresolved.includes('observer2') && raw.unresolved.includes('total-historical2'))
    assert.equal(raw.identities.some(row => template.blocks.some(block => block.id === row.id)), false)
    const host = db.transaction(() => readStrictHostDocument(db, independent.id))(); assert.ok(host)
    assert.throws(() => validateInitialRecord({ kind: 'document', id: independent.id, parentId: host.parentId,
      sortOrder: host.sortOrder, createdAt: host.createdAt, content: host.content }, 'doc:' + independent.id), /文档标题无效/)
    assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), before)
  })
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId), beforeAck)
}))

test('physical raw2 preserves immutable Origin after real Main first-instance removal and actual Store origin-document deletion', () => withV3Fixture(async f => {
  const inserted = command(f.db, { documentId: f.targetId, groupId: f.groupId })
  insertAck(applySyncedHostCommand(f.db, inserted))
  const origin = snapshot(f.db, f.groupId).origin
  makeV3Orphan(f)
  f.store.deleteDocument(f.hostId)
  assert.equal(f.db.prepare('SELECT 1 FROM documents WHERE id=?').get(origin.documentId), undefined)
  assert.equal(f.db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=?').get(origin.firstInstanceId), undefined)
  assert.ok(f.db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=?').get(inserted.action.instanceId))
  await withRawPhysicalCopy(f, db => {
    const raw = db.transaction(() => readRawCapsule2PhysicalGraphOwned(db))()
    const group = raw.groups.find(item => item.groupId === f.groupId)?.snapshot; assert.ok(group)
    assert.deepEqual(group.origin, origin)
    assert.deepEqual(group.instances.map(item => item.instanceId), [inserted.action.instanceId])
    assert.equal(raw.documents.some(item => item.documentId === origin.documentId), false)
    assert.equal(raw.certified, false)
  })
}))

test('physical raw2 rejects a real physical leaf whose registry is subsequently deleted and preserves the damaged SQL', () => withV3Fixture(async f => {
  // Explicitly corrupted fixture only. DELETE has no registry repair/side effect;
  // the real Main group/body/ACK remain, and schema guards stay installed.
  f.db.prepare('DELETE FROM synced_instances WHERE instance_id=?').run(f.instanceId)
  assert.ok(f.db.prepare('SELECT 1 FROM blocks WHERE id=?').get(f.instanceId))
  await withRawPhysicalCopy(f, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2PhysicalGraphOwned(db))(), /实际|实例|引用/)
    assert.equal(db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=?').get(f.instanceId), undefined)
    assert.ok(db.prepare('SELECT 1 FROM blocks WHERE id=?').get(f.instanceId))
  })
}))

test('physical raw2 rejects incomplete stored canonical Key bindings without rebinding by current path', () => withV3Fixture(async f => {
  assert.ok(snapshot(f.db, f.groupId).bindings.length)
  f.db.prepare("UPDATE synced_groups SET bindings_json='[]' WHERE id=?").run(f.groupId)
  await withRawPhysicalCopy(f, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2PhysicalGraphOwned(db))(), /链接绑定/)
    assert.equal((db.prepare('SELECT bindings_json FROM synced_groups WHERE id=?').get(f.groupId) as { bindings_json: string }).bindings_json, '[]')
  })
}))
