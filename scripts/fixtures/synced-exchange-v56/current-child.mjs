import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {lstatSync,readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {join,relative,sep} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {causeMessages,copyTreeFresh,hash,inventory,writeFresh} from './evidence.mjs'

const config=JSON.parse(readFileSync(process.argv[2],'utf8')),h=JSON.parse(readFileSync(config.handoffPath,'utf8'))
assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(process.cwd(),config.currentRoot)
assert.equal(process.env.TSX_TSCONFIG_PATH,join(config.currentRoot,'tsconfig.test.json'))
const product=path=>import(pathToFileURL(join(config.currentRoot,path)).href)
const require=createRequire(pathToFileURL(join(config.currentRoot,'package.json'))),Database=require('better-sqlite3')
const methods=await product('src/main/sync/synced-exchange.ts')
const {readSyncedExchangeLocal,readSyncedExchangeReceipt}=await product('src/main/database/synced-exchange-read.ts')
const {initialIncomingTargetFingerprint}=await product('src/main/sync/synced-initial-incoming-model.ts')
const {readSyncedPersistentPublicationSnapshot}=await product('src/main/database/synced-publication.ts')
const {mapPublicationCatalog}=await product('src/main/sync/synced-publication-model.ts')
const {getSyncedGroupSnapshots}=await product('src/main/database/synced-blocks-read.ts')
const {canonicalSyncedPortableJson,rewriteSyncedGroupAssets,rewriteSyncedPortableHostAssets,buildSyncedPortableAssetUri}=await product('src/shared/syncedBlockPortable.ts')
let db=null
function open(){const next=new Database(h.profile.file,{fileMustExist:true});next.pragma('foreign_keys=ON');return next}
const setting=key=>db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(key)
const receipt=()=>db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(h.operationId)
function allTables(){return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>{assert.match(name,/^[a-z_0-9]+$/i);return {name,rows:db.prepare('SELECT * FROM "'+name+'"').all().map(canonicalSyncedPortableJson).sort()}})}
function originalFacts(settled=false){
  assert.deepEqual(setting(h.saved.headRow.key),h.saved.headRow,'The exact original5/6 operation head remains unchanged')
  for(const row of h.saved.immutableSettings)assert.deepEqual(setting(row.key),row,'The original job/phase/preview/history row remains exact: '+row.key)
  for(const row of h.saved.operations)assert.deepEqual(db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(row.client_operation_id),row,'Every original ACK and denial marker remains exact')
  assert.deepEqual(inventory(h.spoolDirectory),h.spoolFiles,'Every original5/6 spool byte remains exact')
  assert.deepEqual(inventory(h.previewDirectory),h.previewFiles,'The actual original private2 preview source remains exact')
  for(const row of h.saved.attempts){const actual=db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(row.id);assert.ok(actual)
    if(row.id!==h.saved.head.attemptId||row.state==='confirmed')assert.deepEqual(actual,row,'Historical and denial anchors remain exact')
    else{for(const [key,value]of Object.entries(row))if(!['state','confirmed_at'].includes(key))assert.deepEqual(actual[key],value);assert.equal(actual.state,settled?'confirmed':row.state)}}
  for(const row of h.saved.members)assert.deepEqual(db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=? AND group_id=?').get(row.attempt_id,row.group_id),row)
}
function strictLocal(){return db.transaction(()=>readSyncedExchangeLocal(db,{request:h.saved.job.request,initialTargetFingerprint:initialIncomingTargetFingerprint(h.input.target)}))()}
function exactDenial(local){
  const d=h.originalDenial
  assert.deepEqual(db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(d.marker.client_operation_id),d.marker)
  assert.deepEqual(db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(d.anchor.id),d.anchor)
  assert.deepEqual(db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(d.receipt.client_operation_id),d.receipt)
  for(const identity of d.identities)assert.deepEqual(db.prepare('SELECT * FROM block_identities WHERE id=?').get(identity.id),identity)
  assert.equal(db.prepare('SELECT count(*) AS n FROM synced_group_exposure_members WHERE attempt_id=?').get(d.anchor.id).n,0)
  if(local){assert.equal(local.state.version,2);assert.deepEqual(local.state.baseline.find(row=>row.key===h.denialKey),d.baseline,'The old5/6 fixed absence baseline is carried exactly, not lawfully re-signed by the new runtime')}
  assert.ok(h.denialKey.startsWith('doc:'),'The oracle uses a true deleted Origin joined to the live component')
  assert.equal(db.prepare('SELECT count(*) AS n FROM documents WHERE id=?').get(h.denialKey.slice(4)).n,0)
}
function exactJobSources(value){
  assert.equal(value.version,h.version);assert.equal(value.provenance.plannerVersion,h.plannerVersion)
  assert.equal(value.provenance.attemptId,h.saved.head.attemptId);assert.equal(value.provenance.knowledgeHash,h.saved.job.knowledgeHash)
  assert.equal(hash(canonicalSyncedPortableJson(h.saved.job.knowledgeSource)),h.saved.job.knowledgeHash)
  assert.deepEqual(value.request,h.saved.job.request);assert.deepEqual(value.provenance.resolution,h.saved.job.resolution)
  assert.deepEqual(value.provenance.merges,h.saved.job.merges)
  assert.equal(Object.hasOwn(value.provenance,'deletions'),false,'Old5/6 receipts remain live-only and cannot become new deletion producers')
  if(h.version===6)assert.deepEqual(value.provenance.forks,h.saved.job.forks,'Original fork maps, effective Origin and exact source projections remain original')
  for(const side of value.provenance.accepted){assert.equal(side.local.kind,'live');assert.notEqual(side.key,h.denialKey)}
}
function actualPortable(){
  const snapshot=db.transaction(()=>readSyncedPersistentPublicationSnapshot(db))()
  const asset=uri=>{const file=fileURLToPath(uri),parts=relative(join(h.profile.root,'storage','assets'),file).split(sep);assert.equal(parts.length,4);assert.equal(parts[0],'attachments');assert.match(parts[2],/^[a-f0-9]{64}$/);assert.equal(parts[1],parts[2].slice(0,2));assert.equal(lstatSync(file).isFile(),true);assert.equal(hash(readFileSync(file)),parts[2]);return buildSyncedPortableAssetUri({hash:parts[2],name:parts[3]})}
  const physical=mapPublicationCatalog(snapshot.records,snapshot.catalogId).map(record=>record.kind==='synced-group'?rewriteSyncedGroupAssets(record,asset):record.kind==='document'?rewriteSyncedPortableHostAssets(record,asset):record)
  const records=[...physical,...(snapshot.deletions??[]).map(row=>row.deletion)]
  const entries=Object.fromEntries(records.map(record=>[record.kind==='databases'?'databases':record.kind==='synced-group'||record.kind==='synced-group-deleted'?'group:'+record.id:'doc:'+record.id,hash(canonicalSyncedPortableJson(record))]).sort(([a],[b])=>a<b?-1:a>b?1:0))
  assert.deepEqual(entries,h.expectedManifest.entries,'Actual SQL physical plus authenticated deleted knowledge matches every original5/6 planned wire hash')
  const deps=physical.flatMap(record=>record.kind!=='document'?[]:record.content.blocks.flatMap(block=>block.type!=='synced-block'?[]:[{documentId:record.id,instanceId:block.id,groupId:JSON.parse(block.content).groupId,groupHash:entries['group:'+JSON.parse(block.content).groupId]}])).sort((a,b)=>a.documentId<b.documentId?-1:a.documentId>b.documentId?1:a.instanceId<b.instanceId?-1:a.instanceId>b.instanceId?1:0)
  assert.deepEqual(deps,h.expectedManifest.syncedInstances,'All actual original5/6 instance dependencies match the original spool')
  assert.equal(db.prepare('SELECT content FROM blocks WHERE document_id=? ORDER BY sort_order LIMIT 1').get(h.incomingDocumentId).content,h.incoming)
  const id=h.fork?.groupId??h.groupId,got=getSyncedGroupSnapshots(db,{groupIds:[id]}).items[0]
  assert.equal(got.status,'ready')
  if(h.fork){assert.equal(got.snapshot.creationId,h.fork.creationId);assert.equal(got.snapshot.createdAt,h.fork.createdAt);assert.equal(got.snapshot.instances.length,0,'The actual old6 allocation is the one intended orphan fork')}
}

try{
  db=open();originalFacts();const before=strictLocal();assert.ok(before.state);exactDenial(before)
  if(h.phaseCase==='committed-replay')assert.deepEqual(before.state.baseline,h.expectedBaseline)
  let profileBeforeReplay=null,epochMutation=null,replayBefore=null
  if(h.phaseCase==='committed-replay'){
    const old=db.transaction(()=>readSyncedExchangeReceipt(db,h.saved.job.request))();assert.ok(old);exactJobSources(old)
    const original=db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get(),epoch=randomUUID()
    assert.equal(db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(epoch).changes,1)
    epochMutation={previous:original.recovery_epoch,next:epoch,workspaceScope:original.workspace_scope,fixtureOnly:true}
    db.close();db=null;profileBeforeReplay=copyTreeFresh(h.profile.root,join(config.evidence,'profile-before-replay-current'))
    writeFresh(join(config.evidence,'replay-epoch-fixture.json'),epochMutation);db=open();replayBefore=allTables()
  }
  const result=await methods[h.mode==='conflicts'?'resolveSyncedExchangeConflicts':'resolveSyncedExchangeBoth'](db,h.input,h.runtime)
  assert.equal(result.operationId,h.operationId);assert.equal(result.status,'applied')
  if(h.phaseCase==='committed-replay'){
    assert.deepEqual(result,{...h.legacyResult,replayed:true});assert.deepEqual(receipt(),h.saved.receipt);assert.deepEqual(allTables(),replayBefore)
  }else{
    assert.equal(result.replayed,false);assert.equal(result.afterManifestHash,h.expectedManifestHash)
    const stored=receipt();assert.ok(stored);const value=JSON.parse(stored.result_json);exactJobSources(value)
    assert.deepEqual(value.result,result)
    const strictReceipt=db.transaction(()=>readSyncedExchangeReceipt(db,h.saved.job.request))();assert.deepEqual(strictReceipt,value)
    const after=strictLocal();assert.equal(after.state.version,2);assert.equal(after.state.currentOperationId,h.operationId)
    assert.deepEqual(after.state.baseline,h.expectedBaseline,'New runtime settles the full exact old5/6 plan.nextBaseline, not a newly computed approximation')
    exactDenial(after)
    const prefix='sync.webdav.protocol5.exchange-job-phase.v1.'+h.operationId+'.'+h.saved.head.attemptId+'.'
    const phases=db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length,prefix).sort((a,b)=>JSON.parse(a.value).sequence-JSON.parse(b.value).sequence)
    let previous=null
    for(const [sequence,row]of phases.entries()){
      const fact=JSON.parse(row.value);assert.equal(fact.version,h.version===5?1:2);assert.equal(fact.sequence,sequence);assert.equal(fact.previousFactHash,previous)
      assert.equal(fact.jobHash,h.saved.head.jobHash);assert.equal(fact.requestHash,h.saved.job.requestHash);if(h.version===6)assert.equal(fact.blocked,null);previous=hash(row.value)
    }
    assert.equal(JSON.parse(phases.at(-1).value).phase,'settled')
    assert.equal(db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(h.saved.head.attemptId).state,'confirmed')
    actualPortable()
  }
  originalFacts(true);exactDenial();const finalReceipt=receipt();db.close();db=null
  let profileAfterReplay=null
  if(profileBeforeReplay){profileAfterReplay=copyTreeFresh(h.profile.root,join(config.evidence,'profile-after-replay-current'));assert.deepEqual(profileAfterReplay,profileBeforeReplay)}
  writeFresh(join(config.evidence,'current-result.json'),{status:'passed',pid:process.pid,caseName:h.caseName,version:h.version,operationId:h.operationId,result,finalReceipt,
    originalSpoolPreserved:true,originalPhasePrefixPreserved:true,originalPreviewPreserved:true,oldKnowledgeAndAllocationPreserved:true,
    epochMutation,profileBeforeReplay,profileAfterReplay,completedAt:new Date().toISOString()})
  process.stdout.write(JSON.stringify({status:'passed',caseName:h.caseName,operationId:h.operationId})+'\n')
}catch(error){if(db?.open)db.close();writeFresh(join(config.evidence,'current-failure.json'),{status:'failed',pid:process.pid,caseName:h.caseName,messages:causeMessages(error),stack:error instanceof Error?error.stack:null,at:new Date().toISOString()});process.stderr.write((error instanceof Error?error.stack:String(error))+'\n');process.exitCode=1}
