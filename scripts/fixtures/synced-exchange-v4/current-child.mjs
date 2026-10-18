import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {lstatSync,readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {join,relative,sep} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {causeMessages,copyTreeFresh,hash,inventory,writeFresh} from './evidence.mjs'
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),h=JSON.parse(readFileSync(config.handoffPath,'utf8'))
assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(process.cwd(),config.currentRoot);assert.equal(process.env.TSX_TSCONFIG_PATH,join(config.currentRoot,'tsconfig.test.json'))
const product=path=>import(pathToFileURL(join(config.currentRoot,path)).href)
const require=createRequire(pathToFileURL(join(config.currentRoot,'package.json'))),Database=require('better-sqlite3')
const {exchangeSyncedSnapshot}=await product('src/main/sync/synced-exchange.ts')
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
  assert.deepEqual(setting(h.saved.headRow.key),h.saved.headRow,'The current reader retains the exact old4 operation head')
  for(const row of h.saved.immutableSettings)assert.deepEqual(setting(row.key),row,'Old immutable job/phase/history facts remain original raw rows: '+row.key)
  for(const row of h.saved.operations)assert.deepEqual(db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(row.client_operation_id),row,'Every existing ACK/deletion marker remains exact')
  assert.deepEqual(inventory(h.spoolDirectory),h.spoolFiles,'All original old4 private spool files remain raw-exact')
  for(const row of h.saved.attempts){const actual=db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(row.id);assert.ok(actual)
    if(row.id!==h.saved.head.attemptId||row.state==='confirmed')assert.deepEqual(actual,row,'All historical/denial attempts remain exact')
    else{for(const [key,value]of Object.entries(row))if(!['state','confirmed_at'].includes(key))assert.deepEqual(actual[key],value);assert.equal(actual.state,settled?'confirmed':row.state)}}
  for(const row of h.saved.members)assert.deepEqual(db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=? AND group_id=?').get(row.attempt_id,row.group_id),row)
}
function strictLocal(){return db.transaction(()=>readSyncedExchangeLocal(db,{request:h.saved.job.request,initialTargetFingerprint:initialIncomingTargetFingerprint(h.input.target)}))()}
function proof(){
  const markers=db.prepare("SELECT * FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'").all()
  const row=markers.find(row=>JSON.parse(row.result_json).key===h.key);assert.ok(row)
  const value=JSON.parse(row.result_json),anchor=db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(row.client_operation_id)
  assert.equal(value.kind,'synced-logical-deletion-proof');assert.equal(value.version,1);assert.equal(value.tombstoneHash,h.tombstoneHash);assert.deepEqual(value.deletion,h.tombstone)
  assert.equal(value.persistence.anchorId,row.client_operation_id);assert.equal(row.request_hash,hash(canonicalSyncedPortableJson({domain:'synced.logical-deletion.apply.v1',proof:value})))
  assert.ok(anchor);assert.equal(anchor.channel,'logical-deletion-denial-v1');assert.equal(anchor.publication_hash,h.tombstoneHash);assert.equal(anchor.request_hash,row.request_hash)
  assert.equal(db.prepare('SELECT count(*) AS n FROM synced_group_exposure_members WHERE attempt_id=?').get(anchor.id).n,0)
  if(h.originalProof){assert.deepEqual(row,h.originalProof.row);assert.deepEqual(anchor,h.originalProof.anchor)}
  else{assert.equal(value.application.operationId,h.operationId);assert.equal(value.intentHash,h.saved.job.deletions[0].intentHash)}
  assert.equal(getSyncedGroupSnapshots(db,{groupIds:[h.groupId]}).items[0].status,'missing')
  assert.equal(db.prepare('SELECT count(*) AS n FROM synced_group_blocks WHERE group_id=?').get(h.groupId).n,0)
  const raw=db.prepare('SELECT * FROM synced_groups WHERE id=?').get(h.groupId);assert.ok(raw)
  for(const key of ['id','creation_id','created_at','origin_json'])assert.equal(raw[key],h.beforeGroup[key],'Deletion preserves the actual original immutable group tuple')
  return {row,value,anchor}
}
function actualPortable(){
  const snapshot=db.transaction(()=>readSyncedPersistentPublicationSnapshot(db))()
  const asset=uri=>{const file=fileURLToPath(uri),parts=relative(join(h.profile.root,'storage','assets'),file).split(sep);assert.equal(parts.length,4);assert.equal(parts[0],'attachments');assert.match(parts[2],/^[a-f0-9]{64}$/);assert.equal(parts[1],parts[2].slice(0,2));assert.equal(lstatSync(file).isFile(),true);assert.equal(hash(readFileSync(file)),parts[2]);return buildSyncedPortableAssetUri({hash:parts[2],name:parts[3]})}
  const physical=mapPublicationCatalog(snapshot.records,snapshot.catalogId).map(record=>record.kind==='synced-group'?rewriteSyncedGroupAssets(record,asset):record.kind==='document'?rewriteSyncedPortableHostAssets(record,asset):record)
  const records=[...physical,...(snapshot.deletions??[]).map(row=>row.deletion)]
  const entries=Object.fromEntries(records.map(record=>[record.kind==='databases'?'databases':record.kind==='synced-group'||record.kind==='synced-group-deleted'?'group:'+record.id:'doc:'+record.id,hash(canonicalSyncedPortableJson(record))]).sort(([a],[b])=>a<b?-1:a>b?1:0))
  assert.deepEqual(entries,h.expectedManifest.entries,'Actual SQL physical plus independently authenticated deletion knowledge equals the exact old4 manifest entries')
  const deps=physical.flatMap(record=>record.kind!=='document'?[]:record.content.blocks.flatMap(block=>block.type!=='synced-block'?[]:[{documentId:record.id,instanceId:block.id,groupId:JSON.parse(block.content).groupId,groupHash:entries['group:'+JSON.parse(block.content).groupId]}])).sort((a,b)=>a.documentId<b.documentId?-1:a.documentId>b.documentId?1:a.instanceId<b.instanceId?-1:a.instanceId>b.instanceId?1:0)
  assert.deepEqual(deps,h.expectedManifest.syncedInstances,'Actual complete physical instance dependencies match the original old4 spool')
  assert.equal(db.prepare('SELECT content FROM blocks WHERE document_id=? ORDER BY sort_order LIMIT 1').get(h.incomingDocumentId).content,h.incoming)
  assert.equal(db.prepare('SELECT content FROM blocks WHERE document_id=? ORDER BY sort_order LIMIT 1').get(h.outgoingDocumentId).content,h.outgoing)
  if(h.zero)assert.equal(snapshot.groups.length,0,'The original zero-active writer is recovered with no fake active group')
}
try{
  db=open();originalFacts();const before=strictLocal();assert.ok(before.state)
  if(h.caseName==='committed-replay')assert.deepEqual(before.state.baseline,h.expectedBaseline,'The already settled old4 baseline is its original full planned output')
  let profileBeforeReplay=null,epochMutation=null,replayBefore=null
  if(h.caseName==='committed-replay'){
    const old=db.transaction(()=>readSyncedExchangeReceipt(db,h.saved.job.request))();assert.equal(old.version,4);assert.equal(old.provenance.plannerVersion,'tombstones-v1');proof()
    const state=db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get(),epoch=randomUUID()
    assert.equal(db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(epoch).changes,1)
    epochMutation={previous:state.recovery_epoch,next:epoch,workspaceScope:state.workspace_scope,fixtureOnly:true}
    db.close();db=null;profileBeforeReplay=copyTreeFresh(h.profile.root,join(config.evidence,'profile-before-replay-current'));writeFresh(join(config.evidence,'replay-epoch-fixture.json'),epochMutation)
    db=open();replayBefore=allTables()
  }
  const result=await exchangeSyncedSnapshot(db,h.input,h.runtime)
  assert.equal(result.operationId,h.operationId);assert.equal(result.status,'applied')
  if(h.caseName==='committed-replay'){
    assert.deepEqual(result,{...h.legacyResult,replayed:true});assert.deepEqual(receipt(),h.saved.receipt);assert.deepEqual(allTables(),replayBefore)
  }else{
    assert.equal(result.replayed,false);assert.equal(result.afterManifestHash,h.expectedManifestHash)
    const stored=receipt();assert.ok(stored);const value=JSON.parse(stored.result_json)
    assert.equal(value.version,4,'Actual old4 jobs settle with their original finite format');assert.equal(value.provenance.plannerVersion,'tombstones-v1');assert.equal(value.provenance.attemptId,h.saved.head.attemptId)
    assert.deepEqual(value.request,h.saved.job.request);assert.deepEqual(value.provenance.merges,h.saved.job.merges);assert.deepEqual(value.result,result)
    assert.equal(value.provenance.deletions.length,h.carried?0:1)
    const after=strictLocal();assert.equal(after.state.version,2);assert.equal(after.state.currentOperationId,h.operationId)
    assert.deepEqual(after.state.baseline,h.expectedBaseline,'Current old4 recovery preserves every field of the exact original old planned baseline, including its lawful reacceptance of an existing absence')
    const absent=after.state.baseline.find(row=>row.key===h.key);assert.ok(absent);assert.equal(absent.local.kind,'absent');assert.equal(absent.local.tombstoneHash,h.tombstoneHash)
    const p=proof();assert.equal(absent.local.deletionOperationId,p.value.application.operationId);assert.equal(absent.local.intentHash,p.value.intentHash)
    const prefix='sync.webdav.protocol5.exchange-job-phase.v1.'+h.operationId+'.'+h.saved.head.attemptId+'.'
    const phases=db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length,prefix).sort((a,b)=>JSON.parse(a.value).sequence-JSON.parse(b.value).sequence)
    let previous=null;for(const [sequence,row]of phases.entries()){const fact=JSON.parse(row.value);assert.equal(fact.version,1);assert.equal(fact.sequence,sequence);assert.equal(fact.previousFactHash,previous);assert.equal(fact.jobHash,h.saved.head.jobHash);assert.equal(fact.requestHash,h.saved.job.requestHash);previous=hash(row.value)}
    assert.equal(JSON.parse(phases.at(-1).value).phase,'settled')
    const attempt=db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(h.saved.head.attemptId)
    if(h.zero)assert.equal(attempt,undefined,'A genuine zero-active old4 job never creates an ordinary empty exposure attempt');else assert.equal(attempt.state,'confirmed')
    actualPortable()
  }
  originalFacts(true);const finalReceipt=receipt();db.close();db=null
  let profileAfterReplay=null;if(profileBeforeReplay){profileAfterReplay=copyTreeFresh(h.profile.root,join(config.evidence,'profile-after-replay-current'));assert.deepEqual(profileAfterReplay,profileBeforeReplay)}
  writeFresh(join(config.evidence,'current-result.json'),{status:'passed',pid:process.pid,caseName:h.caseName,operationId:h.operationId,result,finalReceipt,originalV4SpoolPreserved:true,originalPhasePrefixPreserved:true,epochMutation,profileBeforeReplay,profileAfterReplay,completedAt:new Date().toISOString()})
  process.stdout.write(JSON.stringify({status:'passed',caseName:h.caseName,operationId:h.operationId})+'\n')
}catch(error){if(db?.open)db.close();writeFresh(join(config.evidence,'current-failure.json'),{status:'failed',pid:process.pid,caseName:h.caseName,messages:causeMessages(error),stack:error instanceof Error?error.stack:null,at:new Date().toISOString()});process.stderr.write((error instanceof Error?error.stack:String(error))+'\n');process.exitCode=1}
