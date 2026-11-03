import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { readSyncedBaselineMetadataCaptureOwned2, resolveSyncedBindingSource, SYNCED_BINDING_SOURCE_LIMITS } from '../src/main/database/synced-binding-sources'
import { SYNCED_METADATA_BASELINE2_PREFIX } from '../src/main/database/synced-metadata-capture-record2'
import { withV3Fixture, allTables } from './helpers/synced-backup-v3-fixture'

test('metadata2 capacity refusal precedes every SQL write and leaves existing real owners valid until release permits the new actual source point', () => withV3Fixture(f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file), sender = Object.freeze({ frame: 'actual publication capacity' })
  try {
    const db = store.getUnsafeDatabaseHandle()
    const opened = store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw Error('The actual original instance must open')
    const sessionId = opened.session.sessionId
    const capture = () => store.invokeSyncedEditingSession(sender, { sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
    const points = () => db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE substr(client_operation_id,1,?)=? ORDER BY client_operation_id')
      .all(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX)
    const totalChanges = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const owners: Array<Extract<ReturnType<typeof capture>, { status: 'ready' }>> = []
    // Every successful real owner has its own actual alias. Equal immutable
    // binding payloads can share storage, but never another owner's ticket.
    for (let index = 0; index < SYNCED_BINDING_SOURCE_LIMITS.tickets / 2; index++) {
      const result = capture(); assert.equal(result.status, 'ready')
      if (result.status !== 'ready') throw Error('The real owner must fit before reaching the original slot limit')
      owners.push(result)
    }
    assert.equal(owners.length * 2, SYNCED_BINDING_SOURCE_LIMITS.tickets)
    assert.equal(new Set(owners.map(owner => owner.readOwnerId)).size, owners.length)
    assert.equal(new Set(owners.map(owner => owner.bindingSource.ticketId)).size, owners.length)
    assert.equal(points().length, 1, 'Repeated actual equal points do not add persistent captures')
    const original = owners[0], previous = owners.at(-1)!.snapshot
    const instance = previous.instances.find(item => item.instanceId === f.instanceId); assert.ok(instance)
    const edited = store.invokeSyncedEditingSession(sender, { sessionId, method: 'updateSyncedBlockGroup', input: {
      clientOperationId: randomUUID(), expectedRevision: previous.revision, expectedTopologyRevision: previous.topologyRevision,
      expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
      groupId: f.groupId, blocks: previous.blocks.map(({ createdAt: _birth, ...block }, index) => ({ ...block,
        content: index === 0 ? block.content + ' actual capacity revision' : block.content }))
    } })
    assert.equal(edited.status, 'saved'); if (edited.status !== 'saved') throw Error('A genuine canonical edit must create the new source revision')
    assert.notEqual(edited.snapshot.revision, previous.revision)
    const before = allTables(db), started = totalChanges(), beforePoints = points()
    assert.throws(capture, /容量已满/)
    assert.equal(totalChanges(), started, 'INSERT followed by rollback is insufficient: no provisional DML may occur')
    assert.deepEqual(allTables(db), before)
    assert.deepEqual(points(), beforePoints, 'A rejected new actual point is not persisted before refusing its owner')
    assert.deepEqual(store.invokeSyncedEditingSession(sender, { sessionId, method: 'validateOwner', input: { readOwnerId: original.readOwnerId } }),
      { status: 'ready', workspaceScope: original.workspaceScope })
    const entry = original.bindingSource.entries[0]; assert.ok(entry)
    const retained = db.transaction(() => resolveSyncedBindingSource(db, original.bindingSource.ticketId, entry.entryId))()
    assert.deepEqual(retained.key, entry.key, 'Capacity refusal keeps the original real alias valid after content revision changes')
    store.invokeSyncedEditingSession(sender, { sessionId, method: 'releaseOwner', input: { readOwnerId: original.readOwnerId } })
    assert.equal(store.invokeSyncedEditingSession(sender, { sessionId, method: 'validateOwner', input: { readOwnerId: original.readOwnerId } }).status, 'owner-unavailable')

    // A successful capacity plan still cannot publish before actual complete
    // namespace validation: this original SQL TEXT storage class is corrupted.
    const target = db.prepare('SELECT content FROM blocks WHERE id=?').get(f.targetBodyId) as { content: string }
    db.prepare('UPDATE blocks SET content=CAST(content AS BLOB) WHERE id=?').run(f.targetBodyId)
    const invalidBefore = allTables(db), invalidStarted = totalChanges()
    assert.throws(capture, /storage class|原TEXT/)
    assert.equal(totalChanges(), invalidStarted); assert.deepEqual(allTables(db), invalidBefore)
    db.prepare('UPDATE blocks SET content=? WHERE id=?').run(target.content, f.targetBodyId)
    const accepted = capture(); assert.equal(accepted.status, 'ready')
    if (accepted.status !== 'ready') throw Error('Releasing the original owner must allow the genuine new point')
    assert.equal(accepted.snapshot.revision, edited.snapshot.revision)
    assert.equal(points().length, 2, 'Only the successful new actual point is added')
    const point = db.transaction(() => readSyncedBaselineMetadataCaptureOwned2(db, accepted.readOwnerId))()
    assert.equal(point.status, 'captured'); if (point.status !== 'captured') throw Error('The published owner must have its same-transaction original')
    assert.equal(point.record.sources[0].revision, edited.snapshot.revision)
    assert.deepEqual(point.record.sources[0].wire.blocks, accepted.snapshot.blocks)
    assert.equal(point.writePermit, false)
    assert.equal(point.record.businessOperationCommitted, false)
  } finally { store.destroy() }
}))
