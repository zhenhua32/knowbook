import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { captureSyncedBaselineOwner, readSyncedBaselineMetadataCaptureOwned2 } from '../src/main/database/synced-binding-sources'
import { SYNCED_METADATA_BASELINE2_PREFIX, readSyncedMetadataCaptureRecordOwned2, reopenSyncedMetadataCaptureRecordOwned2 } from '../src/main/database/synced-metadata-capture-record2'
import { withV3Fixture, allTables, createRestoreInput, restoreSyncedHostOperation } from './helpers/synced-backup-v3-fixture'

test('normal genuine session Source baseline captures one real current point, preserves legacy tickets/ACKs and deduplicates repeated opens without business pins', () => withV3Fixture(f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file), sender = Object.freeze({frame:'actual source-point fixture'})
  try {
    const db = store.getUnsafeDatabaseHandle(), before = allTables(db)
    const legacy = captureSyncedBaselineOwner(db,{groupId:f.groupId})
    assert.equal(legacy.status,'ready')
    assert.deepEqual(allTables(db),before,'The old direct source API remains purely readonly')
    const opened = store.openSyncedEditingSession(sender,{kind:'instance',hostDocumentId:f.hostId,instanceId:f.instanceId,groupId:f.groupId})
    assert.equal(opened.status,'ready');if(opened.status!=='ready')throw new Error('The actual original instance must open')
    const first = store.invokeSyncedEditingSession(sender,{sessionId:opened.session.sessionId,method:'captureBaseline',input:{groupId:f.groupId}})
    assert.equal(first.status,'ready');if(first.status!=='ready')throw new Error('The same-snapshot original baseline must exist')
    const point = db.transaction(() => readSyncedBaselineMetadataCaptureOwned2(db,first.readOwnerId))()
    assert.equal(point.status,'captured');if(point.status!=='captured')throw new Error('The genuine private baseline must own its actual record')
    assert.equal(point.record.kind,'synced-metadata2-read-baseline-record')
    assert.deepEqual(point.record.sources[0].wire.blocks,first.snapshot.blocks)
    assert.deepEqual(point.record.sources[0].wire.bindings,first.snapshot.bindings)
    assert.equal(point.record.sources[0].revision,first.snapshot.revision)
    assert.equal(point.record.businessOperationCommitted,false);assert.equal(point.writePermit,false)
    assert.equal(point.record.historicalKeyLineageComplete,false)
    const rows = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE substr(client_operation_id,1,?)=? ORDER BY client_operation_id')
      .all(SYNCED_METADATA_BASELINE2_PREFIX.length,SYNCED_METADATA_BASELINE2_PREFIX) as Array<{client_operation_id:string;request_hash:string;result_json:string;created_at:string}>
    assert.equal(rows.length,1)
    const again = store.invokeSyncedEditingSession(sender,{sessionId:opened.session.sessionId,method:'captureBaseline',input:{groupId:f.groupId}})
    assert.equal(again.status,'ready')
    assert.deepEqual(db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(rows[0].client_operation_id),rows[0])
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM synced_operations WHERE substr(client_operation_id,1,?)=?').get(SYNCED_METADATA_BASELINE2_PREFIX.length,SYNCED_METADATA_BASELINE2_PREFIX) as {n:number}).n,1)
    const after = allTables(db)
    for(const [table,values]of Object.entries(before))if(table!=='synced_operations')assert.deepEqual(after[table],values,table+' must not change merely to capture a read baseline')
    const originalAck = (before.synced_operations as Array<{client_operation_id:string}>).find(row=>row.client_operation_id===f.created.operationId)
    assert.ok(originalAck)
    assert.deepEqual((after.synced_operations as Array<{client_operation_id:string}>).find(row=>row.client_operation_id===f.created.operationId),originalAck)
    store.invokeSyncedEditingSession(sender,{sessionId:opened.session.sessionId,method:'releaseOwner',input:{readOwnerId:first.readOwnerId}})
    assert.equal(db.transaction(() => readSyncedBaselineMetadataCaptureOwned2(db,first.readOwnerId))().status,'owner-unavailable')
    const independent = f.connect()
    const reopened = independent.transaction(() => {
      const owner = reopenSyncedMetadataCaptureRecordOwned2(independent,rows[0].client_operation_id)
      assert.throws(() => readSyncedMetadataCaptureRecordOwned2(independent,{} as typeof owner),/genuine/)
      return readSyncedMetadataCaptureRecordOwned2(independent,owner)
    })()
    assert.deepEqual(reopened,point.record,'A new actual connection reopens data evidence without reviving a private session/ticket')
  } finally { store.destroy() }
}))

test('a read-source metadata2 record does not prevent the actual unpublished create Undo from retiring its original group', () => withV3Fixture(f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file), sender = Object.freeze({frame:'true create inverse'})
  try {
    const opened = store.openSyncedEditingSession(sender,{kind:'instance',hostDocumentId:f.hostId,instanceId:f.instanceId,groupId:f.groupId})
    assert.equal(opened.status,'ready');if(opened.status!=='ready')throw new Error('The actual original instance must open')
    const captured = store.invokeSyncedEditingSession(sender,{sessionId:opened.session.sessionId,method:'captureBaseline',input:{groupId:f.groupId}})
    assert.equal(captured.status,'ready')
    assert.deepEqual(f.db.prepare("SELECT * FROM synced_group_pins WHERE kind='metadata2-current-capture'").all(),[])
    const {input} = createRestoreInput(f.db,f.created,'undo'), result = restoreSyncedHostOperation(f.db,input)
    assert.equal(result.status,'applied')
    assert.ok('createdLifecycle'in result)
    if(!('createdLifecycle'in result))throw new Error('Actual create inverse must return lifecycle outcome')
    assert.equal(result.createdLifecycle.state,'retired-create')
    assert.equal(f.db.prepare('SELECT 1 FROM synced_instances WHERE group_id=?').get(f.groupId),undefined)
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM synced_operations WHERE substr(client_operation_id,1,?)=?').get(SYNCED_METADATA_BASELINE2_PREFIX.length,SYNCED_METADATA_BASELINE2_PREFIX) as {n:number}).n,1,'The original copied read fact remains available without pretending to be live canonical authority')
  } finally { store.destroy() }
}))
