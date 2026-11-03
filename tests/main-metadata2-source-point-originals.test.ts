import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { readRawCapsule2AssetReferencesOwned } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { SYNCED_METADATA_BASELINE2_PREFIX, SYNCED_METADATA_CAPTURE2_PIN } from '../src/main/database/synced-metadata-capture-record2'
import { withV3Fixture, addV3Assets, randomUUID, snapshot } from './helpers/synced-backup-v3-fixture'

test('true Source metadata2 baseline is a known original family and its typed full-body assets survive an independent readonly source read', () => withV3Fixture(async f => {
  const assets = await addV3Assets(f), store = KnowbookStore.openCanonicalRuntime(f.file), sender = Object.freeze({frame:'real asset source'})
  let readonly: Database.Database | undefined
  try {
    const instance = assets.ack.createdLifecycle
    const opened = store.openSyncedEditingSession(sender,{kind:'instance',hostDocumentId:f.hostId,instanceId:snapshot(f.db,assets.groupId).instances[0].instanceId,groupId:assets.groupId})
    assert.equal(opened.status,'ready');if(opened.status!=='ready')throw new Error('The real asset-bearing create must open')
    assert.equal(store.invokeSyncedEditingSession(sender,{sessionId:opened.session.sessionId,method:'captureBaseline',input:{groupId:assets.groupId}}).status,'ready')
    assert.equal(instance.groupId,assets.groupId)
    const evidence = f.db.transaction(() => assertRawSyncedHistoricalEvidenceOwned(f.db))()
    const fact = evidence.facts.find(fact=>fact.family==='metadata2-current-capture')
    assert.ok(fact)
    assert.equal(fact.version,2);assert.deepEqual(fact.supports,[],'The read point is not a disguised group pin or a business operation')
    readonly = new Database(f.file,{readonly:true,fileMustExist:true});readonly.pragma('foreign_keys=ON');readonly.pragma('query_only=ON')
    const actual = readonly.transaction(() => readRawCapsule2AssetReferencesOwned(readonly!))()
    const scopes = actual.scopes.filter(scope=>scope.source[0]==='synced_operations'&&scope.source[1]===fact.locator.key[0])
    assert.ok(scopes.some(scope=>scope.source.includes('sources')),'The actual persisted source wire receives its own typed scope')
    const uris = new Set(scopes.flatMap(scope=>scope.destinations.map(item=>item.uri)))
    for(const asset of assets.attachments)assert.equal(uris.has(asset.url),true,'Every true same-hash logical alias in the original full W is retained')
    assert.equal([...uris].some(uri=>uri==='file:///opaque/code'),false,'Opaque code/Origin/Key/heading copies do not invent independent asset grants')
    assert.equal(actual.permit,false)
  } finally { readonly?.close();store.destroy() }
}))

test('reserved metadata2 family rejects a real orphan pin and an unknown operation version instead of treating either as ordinary opaque history', () => withV3Fixture(f => {
  const db = f.db, stamp = new Date().toISOString()
  db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(f.groupId,SYNCED_METADATA_CAPTURE2_PIN,SYNCED_METADATA_BASELINE2_PREFIX+'a'.repeat(64),stamp)
  assert.throws(() => db.transaction(() => assertRawSyncedHistoricalEvidenceOwned(db))(),/orphan|reserved/)
  db.prepare('DELETE FROM synced_group_pins WHERE kind=?').run(SYNCED_METADATA_CAPTURE2_PIN)
  // Keep the negative about the reserved version, rather than a malformed {}.
  // Obtain the complete payload/hash/timestamp from an actual Main read point.
  const store = KnowbookStore.openCanonicalRuntime(f.file), sender = Object.freeze({frame:'original version fixture'})
  try {
    const opened = store.openSyncedEditingSession(sender,{kind:'instance',hostDocumentId:f.hostId,instanceId:f.instanceId,groupId:f.groupId})
    assert.equal(opened.status,'ready');if(opened.status!=='ready')throw new Error('The actual source instance must open')
    assert.equal(store.invokeSyncedEditingSession(sender,{sessionId:opened.session.sessionId,method:'captureBaseline',input:{groupId:f.groupId}}).status,'ready')
  } finally { store.destroy() }
  const original = db.prepare('SELECT request_hash,result_json,created_at FROM synced_operations WHERE substr(client_operation_id,1,?)=? ORDER BY client_operation_id LIMIT 1')
    .get(SYNCED_METADATA_BASELINE2_PREFIX.length,SYNCED_METADATA_BASELINE2_PREFIX) as {request_hash:string;result_json:string;created_at:string} | undefined
  assert.ok(original,'The negative starts from a genuine complete baseline row')
  assert.doesNotThrow(() => db.transaction(() => assertRawSyncedHistoricalEvidenceOwned(db))())
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
    .run('synced.metadata2.read-baseline:v99:'+randomUUID(),original.request_hash,original.result_json,original.created_at)
  assert.throws(() => db.transaction(() => assertRawSyncedHistoricalEvidenceOwned(db))(),/capture|record|事实|原|required/)
}))
