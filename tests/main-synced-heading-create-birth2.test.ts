import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { withV3Fixture, createRequest, randomUUID, freshBlock, allTables } from './helpers/synced-backup-v3-fixture'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { createRestoreInput } from './helpers/synced-host-command-create-fixture'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readSyncedBaselineMetadataCaptureOwned2 } from '../src/main/database/synced-binding-sources'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { readSyncedHeadingCreateBirthOriginalOwned2, assertSyncedHeadingCreateBirthFamilyOwned2 } from '../src/main/database/synced-heading-create-birth-read2'
import { readSyncedCreatedHeadingPointCurrentOwned2 } from '../src/main/database/synced-heading-create-current2'
import { createHash } from 'node:crypto'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { createRawHash } from '../src/main/database/synced-host-create-plan'
import { validateHostCreateOperationAck } from '../src/main/database/synced-host-operation-receipt'

const EXPECTED_HEADING_BIRTH_KIND='synced-host-create-heading-birth-operation'
type Fixture = Parameters<Parameters<typeof withV3Fixture>[0]>[0]
function freshCreated(f:Fixture) {
  const sender=Object.freeze({frame:'actual fresh heading-Key create'}),linkId=randomUUID()
  const target=f.store.getDocumentDetail(f.targetId)!
  assert.equal(target.blocks.some(block=>block.type==='synced-block'),false)
  assert.equal(target.blocks.find(block=>block.id===f.targetBodyId)?.type,'heading-1')
  const session=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:f.hostId})
  assert.equal(session.status,'ready')
  if(session.status!=='ready')throw Error('Actual host session must open')
  const input=createRequest(f.db,{documentId:f.hostId,selectedRootIds:[linkId],dirty(working){
    working.blocks.push(freshBlock(linkId,'[fresh exact heading](V3%20Target.md#target-heading)'))
  }})
  const rawAck=f.store.invokeSyncedEditingSession(sender,{sessionId:session.session.sessionId,method:'applySyncedHostStructure',input})
  const ack=validateHostCreateOperationAck(rawAck,input.clientOperationId)
  assert.equal(ack.status,'applied')
  assert.equal(ack.createdLifecycle.state,'active')
  const groupId=ack.createdLifecycle.groupId,group=ack.groups.find(value=>value.groupId===groupId)!
  assert.ok(group)
  const binding=group.bindings.find(value=>value.blockId===linkId)
  assert.ok(binding&&binding.target.kind==='heading')
  if(!binding||binding.target.kind!=='heading')throw Error('The true Main source must establish this exact heading Key')
  assert.equal(binding.target.documentId,f.targetId)
  assert.equal(binding.target.slug,'target-heading')
  assert.equal(binding.target.state,'live')
  const row=f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(ack.operationId) as {client_operation_id:string;request_hash:string;result_json:string;created_at:string}
  assert.ok(row)
  const envelope=JSON.parse(row.result_json) as {kind:string;version:number;companionKey?:string;companionHash?:string}
  // On untouched 520512d the actual value is the old bare-create kind. This is
  // the intended red assertion, after real create/eligibility/SQL preconditions.
  assert.equal(envelope.kind,EXPECTED_HEADING_BIRTH_KIND,'A fresh eligible Key needs a business original that reverse-binds its heading birth')
  assert.equal(envelope.version,1)
  assert.equal(envelope.companionKey,'synced.heading.create-birth.v1.'+ack.operationId)
  const companionRow=f.db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(envelope.companionKey) as
    {key:string;value:string;updated_at:string}
  assert.ok(companionRow)
  const companion=JSON.parse(companionRow.value) as {operationId:string;requestHash:string;historyToken:string;groupWireHash:string;resultHash:string;sourcePoint:{key:string;recordHash:string}}
  assert.equal(envelope.companionHash,createHash('sha256').update('knowbook.synced.heading.create-birth.v1\0'+canonicalSyncedPortableJson(companion)).digest('hex'))
  assert.equal(companion.operationId,ack.operationId)
  assert.equal(companion.requestHash,row.request_hash)
  assert.equal(companion.historyToken,ack.historyToken)
  assert.equal(companion.groupWireHash,ack.createdLifecycle.activationHash)
  assert.equal(companion.resultHash,createRawHash(ack))
  const point=f.db.prepare('SELECT request_hash FROM synced_operations WHERE client_operation_id=?').get(companion.sourcePoint.key) as {request_hash:string}
  assert.ok(point)
  assert.equal(companion.sourcePoint.recordHash,point.request_hash)
  return{sender,sessionId:session.session.sessionId,ack,groupId,linkId,input}
}

test('a genuine fresh Main create binds exact heading birth material in its business original',()=>withV3Fixture(async f=>{
  const actual=freshCreated(f)
  const unpublished=()=>assert.equal((f.db.prepare('SELECT exposure_state FROM synced_group_lifecycle WHERE group_id=?')
    .get(actual.groupId) as {exposure_state:string}).exposure_state,'never',
    'The genuine create must remain unpublished throughout its real Undo/Redo; no V3 publication may authorize it')
  unpublished()
  const before=allTables(f.db)
  const original=f.db.transaction(()=>readSyncedHeadingCreateBirthOriginalOwned2(f.db,actual.ack.operationId))()!
  assert.ok(original)
  assert.equal(original.companion.covered.length,1)
  assert.equal(original.companion.covered[0].canonicalKey.blockId,actual.linkId)
  assert.equal(original.companion.covered[0].heading.location.kind,'ordinary')
  if(original.companion.covered[0].heading.location.kind==='ordinary'){
    assert.equal(original.companion.covered[0].heading.location.documentId,f.targetId)
    assert.equal(original.companion.covered[0].heading.location.blockId,f.targetBodyId)
  }
  assert.equal(original.point.capture.originalCaptureBirthProved,false)
  assert.equal(original.point.capture.historicalKeyLineageProved,false)
  const current=f.db.transaction(()=>readSyncedCreatedHeadingPointCurrentOwned2(f.db,actual.groupId))()
  assert.equal(current.status,'same-created-point')
  assert.equal(current.writePermit,false)
  assert.deepEqual(allTables(f.db),before)
  await withCapsule2RawCopy(f,db=>{
    const cold=db.transaction(()=>readSyncedHeadingCreateBirthOriginalOwned2(db,actual.ack.operationId))()!
    assert.deepEqual(cold.envelope,original.envelope)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,0)
  })
  const reopened=f.store.openSyncedEditingSession(actual.sender,{kind:'host',hostDocumentId:f.hostId})
  assert.equal(reopened.status,'ready')
  if(reopened.status!=='ready')throw Error('New ref binding must be freshly opened')
  let restoreSessionId=reopened.session.sessionId
  const inverse=(direction:'undo'|'redo')=>f.store.invokeSyncedEditingSession(actual.sender,{
    sessionId:restoreSessionId,method:'restoreSyncedHostOperation',input:createRestoreInput(f.db,actual.ack,direction).input
  })
  unpublished()
  assert.equal(inverse('undo').status,'applied')
  unpublished()
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM synced_group_pins WHERE group_id=? AND kind='host-history' AND pin_id=?")
    .get(actual.groupId,actual.ack.historyToken) as {n:number}).n,0)
  assert.ok(f.db.transaction(()=>readSyncedHeadingCreateBirthOriginalOwned2(f.db,actual.ack.operationId))(),
    'Own execution pin legitimately disappeared; original birth evidence remains business-bound')
  const redoSession=f.store.openSyncedEditingSession(actual.sender,{kind:'host',hostDocumentId:f.hostId})
  assert.equal(redoSession.status,'ready')
  if(redoSession.status!=='ready')throw Error('Retired create must be reopened before redo')
  restoreSessionId=redoSession.session.sessionId
  assert.equal(inverse('redo').status,'applied')
  unpublished()
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM synced_group_pins WHERE group_id=? AND kind='host-history' AND pin_id=?")
    .get(actual.groupId,actual.ack.historyToken) as {n:number}).n,1)
  const afterRedo=f.db.transaction(()=>readSyncedHeadingCreateBirthOriginalOwned2(f.db,actual.ack.operationId))()!
  assert.deepEqual(afterRedo.envelope,original.envelope)
  assert.deepEqual(afterRedo.companion.creationPins,original.companion.creationPins)
  writeSyncedBackupV3(f.db,{userDataRoot:realpathSync(f.userDataRoot),destination:join(realpathSync(f.root),'fresh-key-original-backup'),snapshotId:randomUUID()})
  await withCapsule2RawCopy(f,db=>db.transaction(()=>{
    const history=readRawCapsule2HistoricalEvidenceOwned(db)
    assert.ok(history.legacyFacts.some(fact=>fact.family==='heading-create-birth'))
    assert.deepEqual(readSyncedHeadingCreateBirthOriginalOwned2(db,actual.ack.operationId)!.envelope,original.envelope)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,0)
  })())
}))

test('an old bare create and a fresh Key whose ordinary heading was deleted and recreated at the same slug never acquire continuous heading permission from a later current point',()=>withV3Fixture(f=>{
  const oldSender=Object.freeze({frame:'old bare create with a real later P point'})
  const oldSession=f.store.openSyncedEditingSession(oldSender,{kind:'host',hostDocumentId:f.hostId})
  assert.equal(oldSession.status,'ready')
  if(oldSession.status!=='ready')throw Error('Actual old source host must open')
  const oldPoint=f.store.invokeSyncedEditingSession(oldSender,{sessionId:oldSession.session.sessionId,method:'captureBaseline',input:{groupId:f.groupId}})
  assert.equal(oldPoint.status,'ready')
  const old=f.db.transaction(()=>readSyncedCreatedHeadingPointCurrentOwned2(f.db,f.groupId))()
  assert.equal(old.status,'requires-heading-lineage')
  if(old.status==='requires-heading-lineage')assert.equal(old.reason,'old-or-imported-Key-has-no-business-bound-birth')
  const actual=freshCreated(f),target=f.store.getDocumentDetail(f.targetId)!,replacementId=randomUUID()
  assert.equal(f.db.transaction(()=>readSyncedCreatedHeadingPointCurrentOwned2(f.db,actual.groupId))().status,'same-created-point')
  f.store.updateDocument(target.id,{expectedUpdatedAt:target.updatedAt,title:target.title,summary:target.summary,
    blocks:[{...freshBlock(replacementId,'Target heading'),type:'heading-1'}]})
  const now=f.store.getDocumentDetail(target.id)!
  assert.equal(now.blocks[0].content,target.blocks[0].content)
  assert.notEqual(now.blocks[0].id,f.targetBodyId)
  const laterPoint=f.store.invokeSyncedEditingSession(actual.sender,{sessionId:actual.sessionId,method:'captureBaseline',input:{groupId:actual.groupId}})
  assert.equal(laterPoint.status,'ready')
  if(laterPoint.status!=='ready')throw Error('The later real current point must expose the ABA endpoint, not authorize it')
  const later=f.db.transaction(()=>readSyncedBaselineMetadataCaptureOwned2(f.db,laterPoint.readOwnerId))()
  assert.equal(later.status,'captured')
  if(later.status==='captured'){
    const heading=later.record.capture.targets.find(item=>item.status==='current-heading')
    assert.ok(heading&&heading.status==='current-heading')
    if(heading&&heading.status==='current-heading'&&heading.heading.location.kind==='ordinary')assert.equal(heading.heading.location.blockId,replacementId)
    assert.equal(later.historicalKeyLineageComplete,false)
  }
  const before=allTables(f.db),changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const refused=f.db.transaction(()=>readSyncedCreatedHeadingPointCurrentOwned2(f.db,actual.groupId))()
  assert.equal(refused.status,'requires-heading-lineage')
  assert.equal(refused.writePermit,false)
  assert.deepEqual(allTables(f.db),before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
  // This is a true Main producer + readonly precondition regression. A complete
  // heading mutation writer and its zero-SQL refusal are still separate work.
}))

test('a failed fresh birth envelope insert rolls back the real create and its point atomically before the same nonce can commit once',()=>withV3Fixture(f=>{
  const sender=Object.freeze({frame:'fresh birth SQL failure and exact nonce retry'}),linkId=randomUUID()
  const session=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:f.hostId})
  assert.equal(session.status,'ready')
  if(session.status!=='ready')throw Error('Actual source session required')
  const input=createRequest(f.db,{documentId:f.hostId,selectedRootIds:[linkId],dirty(working){
    working.blocks.push(freshBlock(linkId,'[atomic heading](V3%20Target.md#target-heading)'))
  }})
  const request={sessionId:session.session.sessionId,method:'applySyncedHostStructure' as const,input}
  const before=allTables(f.db),beforeChanges=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  f.db.exec("CREATE TEMP TRIGGER fail_fresh_heading_business BEFORE INSERT ON main.synced_operations WHEN NEW.client_operation_id='"+input.clientOperationId+"' BEGIN SELECT RAISE(ABORT,'actual fresh heading business insert fault'); END")
  try{
    assert.throws(()=>f.store.invokeSyncedEditingSession(sender,request),/actual fresh heading business insert fault/)
    assert.deepEqual(allTables(f.db),before)
    assert.ok((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n>beforeChanges,
      'Real writes occurred then rolled back; rollback does not reset SQLite total_changes')
  }finally{f.db.exec('DROP TRIGGER temp.fail_fresh_heading_business')}
  const saved=validateHostCreateOperationAck(f.store.invokeSyncedEditingSession(sender,request),input.clientOperationId)
  assert.equal(saved.status,'applied')
  const stable=allTables(f.db),changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const replay=f.store.invokeSyncedEditingSession(sender,request)
  assert.ok(replay.status==='applied'&&replay.replayed)
  assert.deepEqual(allTables(f.db),stable)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as {n:number}).n,1)
}))

test('the new business-linked birth family rejects actual unknown, orphan and retained-pin corruption without repairing any source row',()=>withV3Fixture(f=>{
  const actual=freshCreated(f),db=f.db
  const original=db.transaction(()=>readSyncedHeadingCreateBirthOriginalOwned2(db,actual.ack.operationId))()!
  assert.ok(original&&original.pins.length)
  const checkBad=(pattern:RegExp)=>{
    const before=allTables(db),changes=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
    assert.throws(()=>db.transaction(()=>assertSyncedHeadingCreateBirthFamilyOwned2(db))(),pattern)
    assert.deepEqual(allTables(db),before)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
  }
  db.transaction(()=>assertSyncedHeadingCreateBirthFamilyOwned2(db))()
  const unknown='synced.heading.create-birth.v99.'+randomUUID()
  db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(unknown,original.companionRow.value,original.companionRow.updated_at)
  try{checkBad(/unknown.*family|version|case/)}finally{db.prepare('DELETE FROM app_settings WHERE key=?').run(unknown)}
  const orphan='synced.heading.create-birth.v1.'+randomUUID()
  db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(orphan,original.companionRow.value,original.companionRow.updated_at)
  try{checkBad(/orphan|rebound/)}finally{db.prepare('DELETE FROM app_settings WHERE key=?').run(orphan)}
  const pin=original.pins[0]
  db.prepare('DELETE FROM synced_group_pins WHERE group_id=? AND kind=? AND pin_id=?').run(pin.group_id,pin.kind,pin.pin_id)
  try{checkBad(/retained.*dependencies|missing/)}finally{
    db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(pin.group_id,pin.kind,pin.pin_id,pin.created_at)
  }
  const invalid=JSON.parse(original.companionRow.value) as {sourcePoint:{recordHash:string}}
  invalid.sourcePoint.recordHash='0'.repeat(64)
  db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(JSON.stringify(invalid),original.companionRow.key)
  try{checkBad(/source point|point|companion|commitment/)}finally{
    db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(original.companionRow.value,original.companionRow.key)
  }
  assert.deepEqual(db.transaction(()=>readSyncedHeadingCreateBirthOriginalOwned2(db,actual.ack.operationId))()!.envelope,original.envelope)
}))
