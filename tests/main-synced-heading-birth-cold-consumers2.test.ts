import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { headingCreateBirthOriginalsFromRaw2 } from '../src/main/database/restore-knowledge-heading-create-birth-original2'
import { graph3Rows, RestoreGraph3Conflict } from '../src/main/database/restore-knowledge-graph3-data'
import { deriveRoot3SettledWorkingEvidence3 } from '../src/main/database/restore-knowledge-assets3-context'
import { deriveRoot5SettledWorkingEvidence5 } from '../src/main/database/restore-knowledge-assets5-working-context'
import { deriveRootRestoreProvenanceSources3 } from '../src/main/database/restore-knowledge-provenance3-model'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityGraphInputs3 } from '../src/main/database/restore-knowledge-identity3-read'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { exchangeJobPrefix, parseExchangeStored, validateExchangeJob } from '../src/main/sync/synced-exchange-model'
import { validateHostCreateOperationAck } from '../src/main/database/synced-host-operation-receipt'
import { createRequest, freshBlock, randomUUID } from './helpers/synced-backup-v3-fixture'
import { withConflicts, completed, ready, component, mergeDecision, editKeepingKeys } from './helpers/synced-exchange-conflict-fixture'
import { withContent3Fixture } from './helpers/content3-fixture'

function createActualHeadingBirth(store: KnowbookStore) {
  const db=store.getUnsafeDatabaseHandle(),hostId=store.createDocument(null),targetId=store.createDocument(null)
  const headingId=randomUUID(),linkId=randomUUID(),suffix=randomUUID(),targetTitle='Cold heading target '+suffix
  store.updateDocument(hostId,{title:'Cold heading host '+suffix,summary:'',blocks:[freshBlock(randomUUID(),'Ordinary host')]})
  store.updateDocument(targetId,{title:targetTitle,summary:'',blocks:[{...freshBlock(headingId,'Cold exact heading'),type:'heading-1'}]})
  const sender=Object.freeze({frame:'actual cold consumer birth producer'}),session=store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:hostId})
  assert.equal(session.status,'ready')
  if(session.status!=='ready')throw Error('Actual fresh host session required')
  const text='[cold exact heading]('+encodeURIComponent(targetTitle)+'.md#cold-exact-heading)'
  const input=createRequest(db,{documentId:hostId,selectedRootIds:[linkId],dirty(working){working.blocks.push(freshBlock(linkId,text))}})
  const ack=validateHostCreateOperationAck(store.invokeSyncedEditingSession(sender,{sessionId:session.session.sessionId,method:'applySyncedHostStructure',input}),input.clientOperationId)
  assert.equal(ack.status,'applied')
  const groupId=ack.createdLifecycle.groupId,group=ack.groups.find(value=>value.groupId===groupId)
  assert.ok(group)
  const target=group.bindings.find(value=>value.blockId===linkId)?.target
  assert.ok(target?.kind==='heading')
  if(target?.kind!=='heading')throw Error('Actual heading target required')
  assert.equal(target.documentId,targetId);assert.equal(target.slug,'cold-exact-heading');assert.equal(target.state,'live')
  const row=db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(ack.operationId) as {result_json:string}
  assert.equal(JSON.parse(row.result_json).kind,'synced-host-create-heading-birth-operation')
  const wire={kind:'synced-group' as const,id:groupId,creationId:group.creationId,createdAt:group.createdAt,
    origin:group.origin,bindings:group.bindings,blocks:group.blocks}
  return{ack,groupId,linkId,text,wire}
}

test('cold settled assets3 and Working5 readers authenticate the new create original beside an actual custom group merge',()=>withConflicts(async f=>{
  const store=KnowbookStore.openCanonicalRuntime(f.B.file)
  const actual=(()=>{try{return createActualHeadingBirth(store)}finally{store.destroy()}})()
  completed(await f.exchange(f.B),'applied');completed(await f.exchange(f.A),'applied')
  editKeepingKeys(f.A,actual.groupId,blocks=>{blocks[0].content='REMOTE overlap '+blocks[0].content})
  completed(await f.exchange(f.A),'applied')
  editKeepingKeys(f.B,actual.groupId,blocks=>{blocks[0].content='LOCAL overlap '+blocks[0].content})
  const preview=ready(await f.preview()),key='group:'+actual.groupId
  const decision=mergeDecision(component(preview,key),part=>{
    assert.equal(part.field,'block-content');assert.equal(part.canEditText,true)
    return{choice:'custom',text:actual.text}
  })
  const operationId=randomUUID();completed(await f.resolve(preview,[decision],operationId),'applied')
  const prefix=exchangeJobPrefix(operationId),jobs=f.B.db.prepare('SELECT key,value FROM app_settings WHERE substr(key,1,?)=?')
    .all(prefix.length,prefix) as Array<{key:string;value:string}>
  assert.equal(jobs.length,1)
  const job=validateExchangeJob(parseExchangeStored(jobs[0].value))
  assert.equal(job.version,2)
  const merge=job.merges?.find(value=>value.key===key);assert.ok(merge)
  assert.equal(merge.resultHash,publicationHash(publicationJson(actual.wire)),
    'The actual Main custom installation must return to the complete immutable create wire, not just a same-ID body')
  const file=join(f.folder,'heading-create-cold-original-'+randomUUID()+'.db')
  await f.B.db.backup(file)
  const cold=new Database(file,{readonly:true,fileMustExist:true})
  try{
    cold.pragma('foreign_keys=ON');cold.pragma('query_only=ON')
    const raw=cold.transaction(()=>readRawCapsule2ContentOwned(cold))()
    const original=headingCreateBirthOriginalsFromRaw2(raw)(actual.ack.operationId)
    assert.equal(original.result.operationId,actual.ack.operationId)
    assert.equal(original.writePermit,false);assert.equal(original.currentHeadingMutationAuthorized,false)
    for(const derive of [deriveRoot3SettledWorkingEvidence3,deriveRoot5SettledWorkingEvidence5]){
      const settled=derive(raw).get(jobs[0].key);assert.ok(settled)
      const selected=settled.merged.find(value=>value.recordKey===key);assert.ok(selected)
      assert.equal(publicationJson(selected.record),publicationJson(actual.wire))
    }
    const missing={...raw,tables:raw.tables.map(table=>table.name==='app_settings'?{...table,
      rows:table.rows.filter(row=>row!==original.companionSource.original)}:table)}
    assert.equal(graph3Rows(missing,'app_settings').some(row=>row.value.key===original.companionRow.key),false)
    for(const derive of [deriveRoot3SettledWorkingEvidence3,deriveRoot5SettledWorkingEvidence5])
      assert.throws(()=>derive(missing),/Heading create birth packet invalid: original support missing\/duplicate: app_settings/,
        'A later valid job and same-result historical holder cannot replace the exact new business companion')
    assert.equal((cold.prepare('SELECT total_changes() AS n').get() as {n:number}).n,0)
    assert.deepEqual(cold.transaction(()=>readRawCapsule2ContentOwned(cold))(),raw)
  }finally{cold.close()}
}))

test('the genuine cold root provenance consumer joins the new business original and rejects an omitted source-point support',async()=>{
  let actual:ReturnType<typeof createActualHeadingBirth>|undefined
  await withContent3Fixture(async f=>{
    assert.ok(actual)
    const identity=await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const data=await readRootRestoreIdentityGraphInputs3(identity.plan)
    const value=deriveRootRestoreProvenanceSources3(data)
    const origin=value.origins.find(row=>row.tuple.groupId===actual!.groupId);assert.ok(origin)
    assert.equal(origin.firstInstance.status,'proved-birth')
    assert.equal(origin.firstInstance.sourceId,actual.ack.createdLifecycle.origin.firstInstanceId)
    assert.equal(origin.document.status,'unresolved')
    assert.equal(value.acceptedCoverage,false);assert.equal(value.effective,false);assert.equal(value.permit,false)
    const material=data.inputs.source.knowledge.historicalMaterial.filter(row=>row.fact.family==='heading-create-birth'
      &&row.fact.locator.key[0]===actual!.ack.operationId)
    assert.equal(material.length,1)
    const pointSupport=material[0].supports.find(row=>row.table==='synced_operations');assert.ok(pointSupport)
    assert.ok(origin.firstInstance.supports.some(row=>publicationJson(row)===publicationJson(pointSupport)))
    const bad=structuredClone(data),badMaterial=bad.inputs.source.knowledge.historicalMaterial.find(row=>row.fact.family==='heading-create-birth'
      &&row.fact.locator.key[0]===actual!.ack.operationId)!
    Reflect.set(badMaterial,'supports',badMaterial.supports.filter(row=>publicationJson(row)!==publicationJson(pointSupport)))
    assert.throws(()=>deriveRootRestoreProvenanceSources3(bad),(error:unknown)=>{
      assert.ok(error instanceof RestoreGraph3Conflict)
      assert.equal(error.code,'contradictory-original-create-pair')
      assert.equal((error.detail as {reason:string}).reason,'invalid-original-heading-birth-material')
      return true
    })
  },undefined,undefined,source=>{actual=createActualHeadingBirth(source.store)})
})
