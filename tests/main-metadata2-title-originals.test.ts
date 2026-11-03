import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { MarkdownBackupService, writeBackupSnapshot, type BackupV3DatabaseExportJob } from '../src/main/backup/exporter'
import { readRawCapsule2AssetReferencesOwned } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { readTitle2OriginalOperationOwned } from '../src/main/database/synced-host-title2-read'
import { makeTitle2Companion, projectTitle2GroupSide, title2JournalKey, title2GroupHeadKey } from '../src/main/database/synced-host-title2-codec'
import { hostEncode, hostHash } from '../src/main/database/synced-host-journal'
import { allTables, addV3Assets, randomUUID } from './helpers/synced-backup-v3-fixture'
import { withTitle2Fixture } from './helpers/metadata2-title-fixture'

test('real metadata2 title ACK/companion survives every original connection closing and the actual V3 backup service with typed aliases unchanged',()=>withTitle2Fixture(async t=>{
  const {f}=t,assets=await addV3Assets(f)
  writeSyncedBackupV3(f.db,{userDataRoot:realpathSync(f.userDataRoot),destination:join(realpathSync(f.root),'published-with-assets'),snapshotId:randomUUID()})
  // Assets created another genuine instance after the fixture's first open.
  // Recapture the actual host closure through the real Main session API.
  const reopened=t.store.openSyncedEditingSession(t.sender,{kind:'host',hostDocumentId:f.hostId})
  assert.equal(reopened.status,'ready');if(reopened.status!=='ready')throw new Error('The published host must genuinely reopen')
  assert.equal(reopened.session.sessionId,t.sessionId,'The original sender reuses its real session and captures the new instance proof')
  const input=t.titleInput('V3 Host','Archived Host'),saved=t.apply(input)
  assert.equal(saved.status,'applied')
  const committed=allTables(f.db),file=f.file
  const originalSql='SELECT client_operation_id,request_hash,result_json,created_at,CAST(result_json AS BLOB) AS original_bytes FROM synced_operations WHERE client_operation_id=?'
  const originalRow=f.db.prepare(originalSql).get(input.clientOperationId)
  assert.ok(originalRow)
  // Close the live business Store and every original fixture connection before
  // independently reopening. Private connection owners cannot bridge this gap.
  t.store.releaseAllSyncedEditingSessions();t.store.destroy();f.close()
  const cold=KnowbookStore.openCanonicalRuntime(file)
  assert.deepEqual(cold.getUnsafeDatabaseHandle().prepare(originalSql).get(input.clientOperationId),originalRow)
  let readonly:Database.Database|undefined
  try{
    assert.deepEqual(allTables(cold.getUnsafeDatabaseHandle()),committed,'Cold complete admission never repairs or replaces the committed metadata2 action')
    const original=cold.runInTransaction(()=>readTitle2OriginalOperationOwned(cold.getUnsafeDatabaseHandle(),input.clientOperationId))
    assert.ok(original)
    assert.equal(original.companion.businessOperationCommitted,true)
    assert.equal(original.companion.writePermit,false,'An original historical record is not a new write capability')
    assert.deepEqual(original.envelope.result,saved)
    readonly=new Database(file,{readonly:true,fileMustExist:true});readonly.pragma('foreign_keys=ON');readonly.pragma('query_only=ON')
    const facts=readonly.transaction(()=>assertRawSyncedHistoricalEvidenceOwned(readonly!))()
    const fact=facts.facts.find(fact=>fact.family==='metadata2-title-operation'&&fact.locator.key[0]===input.clientOperationId)
    assert.ok(fact)
    assert.ok(fact.supports.some(support=>support.table==='app_settings'))
    assert.ok(fact.supports.some(support=>support.table==='synced_host_history'))
    const references=readonly.transaction(()=>readRawCapsule2AssetReferencesOwned(readonly!))()
    const scopes=references.scopes.filter(scope=>scope.source[0]==='synced_operations'&&scope.source[1]===input.clientOperationId)
    const destinations=new Set(scopes.flatMap(scope=>scope.destinations.map(destination=>destination.uri)))
    for(const asset of assets.attachments)assert.equal(destinations.has(asset.url),true,'The actual v2 receipt holders retain both genuine same-hash aliases')
    assert.equal(destinations.has('file:///opaque/code'),false)
    const destination=join(realpathSync(f.root),'complete-service-after-title'),jobs:BackupV3DatabaseExportJob[]=[]
    const service=new MarkdownBackupService(cold,destination,undefined,async job=>{
      assert.ok('kind'in job&&job.kind==='synced-v3')
      if(!('kind'in job)||job.kind!=='synced-v3')throw new Error('The real canonical raw database producer is required')
      assert.equal(realpathSync(job.databasePath),realpathSync(file))
      jobs.push(structuredClone(job));return writeBackupSnapshot(job)
    })
    const exported=await service.exportAll(),archive=readBackupV3Archive(destination)
    assert.equal(jobs.length,1)
    assert.equal(archive.manifest.snapshotId,jobs[0].snapshotId)
    assert.equal(exported.exported,archive.documents.length)
    assert.equal(archive.documents.find(document=>document.id===f.hostId)!.title,'Archived Host')
    assert.ok(archive.groups.find(group=>group.wire.id===t.groupId)!.wire.blocks[0].content.includes('Archived%20Host.md'))
    assert.equal(archive.assets.length,2)
    assert.deepEqual(archive.assets.map(asset=>asset.name).sort(),assets.attachments.map(asset=>asset.name).sort())
    assert.equal(new Set(archive.assets.map(asset=>asset.relativePath)).size,2)
    for(const asset of archive.assets){
      assert.deepEqual(Buffer.from(asset.bytes),assets.bytes)
      assert.deepEqual(readFileSync(join(destination,...asset.relativePath.split('/'))),assets.bytes)
    }
    const version=service.listVersions()[0]
    assert.equal(version.format,'synced-v3');assert.equal(version.id,archive.manifest.snapshotId)
    assert.equal(readBackupV3Archive(service.resolveVersion(version.id)).manifest.snapshotId,version.id)
    assert.deepEqual(cold.getUnsafeDatabaseHandle().prepare(originalSql).get(input.clientOperationId),originalRow,
      'Real V3 publication and version maintenance keep the original title ACK SQL tuple and bytes unchanged')
  }finally{readonly?.close();cold.destroy()}
}))

test('re-signed actual title2 SQL packets cannot redirect a captured stable document target to a different path while all outer hashes and ACK group bytes agree',()=>withTitle2Fixture(t=>{
  const db=t.store.getUnsafeDatabaseHandle(),input=t.titleInput('V3 Host','Authenticated Host'),saved=t.apply(input)
  const original=db.transaction(()=>readTitle2OriginalOperationOwned(db,input.clientOperationId))()
  assert.ok(original?.journal)
  const packet=structuredClone(original.envelope),body=structuredClone(original.companion),member=body.groups.find(group=>group.groupId===t.groupId)!
  assert.ok(member.afterEdits.length)
  member.afterEdits[0].after='Wrong%20Document.md'
  const material=original.materials.find(item=>item.group.groupId===t.groupId)!,forged=projectTitle2GroupSide(material.before,member.afterEdits)
  member.afterHash=hostHash(forged)
  const {companionHash:_oldHash,...unsigned}=body,signed=makeTitle2Companion(unsigned)
  packet.companionHash=signed.companionHash
  const group=packet.result.groups.find(group=>group.groupId===t.groupId)!
  group.blocks=forged.blocks;group.bindings=forged.bindings
  db.transaction(()=>{
    db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(hostEncode(signed),packet.companionKey)
    db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(hostEncode(packet),input.clientOperationId)
    const pointerKey=title2JournalKey(saved.historyToken!),pointer=JSON.parse((db.prepare('SELECT value FROM app_settings WHERE key=?').get(pointerKey) as {value:string}).value)
    pointer.companionHash=signed.companionHash;db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(hostEncode(pointer),pointerKey)
    const headKey=title2GroupHeadKey(t.groupId),head=JSON.parse((db.prepare('SELECT value FROM app_settings WHERE key=?').get(headKey) as {value:string}).value)
    head.companionHash=signed.companionHash;head.wireHash=member.afterHash;db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(hostEncode(head),headKey)
  })()
  assert.throws(()=>db.transaction(()=>readTitle2OriginalOperationOwned(db,input.clientOperationId))(),/real typed destination projection/,
    'The failure is the inner native target/path join, not an unchanged outer self hash')
}))
