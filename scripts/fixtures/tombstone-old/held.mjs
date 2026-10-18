import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const input=JSON.parse(readFileSync(process.argv[2],'utf8'))
const {oldSource,evidence,file,caseName,groupId,documentId}=input
const load=path=>import(pathToFileURL(join(oldSource,path)).href)
const Database=createRequire(pathToFileURL(join(oldSource,'package.json')))('better-sqlite3')
const {KnowbookStore}=await load('src/main/database/store.ts')
const {restoreKnowbookDatabase}=await load('src/main/database/restore-maintenance.ts')
const {getSyncedGroupSnapshots}=await load('src/main/database/synced-blocks-read.ts')
const {getSyncedGroupSnapshotsWithLinkSources,captureSyncedBaselineOwner,validateSyncedReadOwner}=await load('src/main/database/synced-binding-sources.ts')
const {applySyncedHostCommand,applySyncedHostFinal}=await load('src/main/database/synced-host-final.ts')
const {command}=await load('tests/helpers/synced-host-command-insert-fixture.ts')
const {request,changeBody,allTables}=await load('tests/helpers/synced-host-final-fixture.ts')
const {canonicalSyncedPortableJson:encode}=await load('src/shared/syncedBlockPortable.ts')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const fresh=(name,value)=>writeFileSync(join(evidence,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'})
const fingerprints=path=>['','-wal','-shm','-journal'].map(suffix=>({suffix,exists:existsSync(path+suffix),sha256:existsSync(path+suffix)?sha(readFileSync(path+suffix)):null}))
function attempt(run){try{return {returned:run(),error:null}}catch(error){return {returned:null,error:{name:error?.name??null,message:String(error)}}}}
let held
try{
  held=new KnowbookStore(file)
  const db=held.getUnsafeDatabaseHandle()
  assert.equal(db.prepare('SELECT count(*) AS n FROM synced_groups').get().n,0,'Actual old Store opens the pristine format before any current incoming installation')
  const prepared=new Promise(resolve=>process.once('message',resolve))
  process.send({status:'bootstrap-ready',caseName,oldStoreOpenedBeforeGroups:true})
  assert.equal((await prepared)?.action,'prepare','Current Main initial installation and actual baseline must complete first')
  const original=allTables(db),originalGroup=getSyncedGroupSnapshots(db,{groupIds:[groupId]}).items[0]
  assert.equal(originalGroup.status,'ready');assert.ok(originalGroup.snapshot.blocks.length>0)
  const owner=captureSyncedBaselineOwner(db,{groupId});assert.equal(owner.status,'ready')
  const queued=caseName==='group'?command(db,{documentId,groupId}):request(db,[documentId],after=>changeBody(after[0],'Actual queued old Source body '+randomUUID()))
  // The independent native backup proves the actual original queued Main
  // request succeeds before deletion. It never changes the target database.
  const copy=join(evidence,'old-validity-control.db');await db.backup(copy)
  const control=new Database(copy);control.pragma('foreign_keys=ON')
  let positive
  try{positive=caseName==='group'?applySyncedHostCommand(control,queued):applySyncedHostFinal(control,queued);assert.equal(positive.status,'applied')}finally{control.close()}
  assert.deepEqual(allTables(db),original,'Preparing the old request and its independent control changes no source row')
  fresh('old-before.json',{caseName,originalGroup,owner,queued,positive,originalHash:sha(encode(original))})
  const observed=new Promise(resolve=>process.once('message',resolve))
  process.send({status:'ready',caseName,positiveStatus:positive.status,queuedOperationId:queued.clientOperationId})
  const signal=await observed;assert.equal(signal?.action,'observe','Actual current Main deletion must commit before the old observer continues')
  const before=allTables(db)
  const targetRead=caseName==='group'?attempt(()=>getSyncedGroupSnapshots(db,{groupIds:[groupId]})):attempt(()=>held.getDocumentDetail(documentId))
  const sourceRead=caseName==='group'?attempt(()=>getSyncedGroupSnapshotsWithLinkSources(db,{groupIds:[groupId]})):null
  const ownerObservation=attempt(()=>validateSyncedReadOwner(db,{readOwnerId:owner.readOwnerId}))
  const staleWrite=attempt(()=>caseName==='group'?applySyncedHostCommand(db,queued):applySyncedHostFinal(db,queued))
  assert.ok(staleWrite.error||!['applied','noop'].includes(staleWrite.returned?.status),'Actual old request proven valid before deletion cannot write after deletion')
  if(caseName==='group'){
    assert.ok(targetRead.error,'Old held reader rejects the raw active identity whose canonical forest is absent')
    assert.ok(sourceRead.error,'Old fresh Source read rejects absent canonical data')
  }else assert.equal(targetRead.returned,null,'Old ordinary lookup observes physical document absence')
  assert.deepEqual(allTables(db),before,'Held reads and queued-write observations leave every table unchanged')
  const filesBefore=fingerprints(file)
  const cold=attempt(()=>{const store=new KnowbookStore(file);store.destroy();return 'opened'})
  assert.ok(cold.error?.message.includes('没有准确参与组的发布记录'),'Original schema27 cold guard rejects the immutable zero-member denial anchor')
  assert.deepEqual(allTables(db),before);assert.deepEqual(fingerprints(file),filesBefore,'Cold Store rejects without changing source or SQLite sidecar bytes')
  const profile=join(evidence,'restore-target');mkdirSync(join(profile,'storage'),{recursive:true})
  const target=join(profile,'storage','knowbook.db');writeFileSync(target,'Original independent restore target',{flag:'wx'})
  const targetBefore=fingerprints(target);let stopCalled=false,restoreError=null
  try{await restoreKnowbookDatabase({userDataRoot:profile,backupPath:file,stopProcesses:async()=>{stopCalled=true;return[]}})}catch(error){restoreError={name:error?.name??null,message:String(error)}}
  assert.ok(restoreError,'Actual original restorer rejects the new logical format')
  assert.equal(stopCalled,false,'Old restorer refuses before process stop or target replacement')
  assert.deepEqual(fingerprints(target),targetBefore);assert.deepEqual(allTables(db),before);assert.deepEqual(fingerprints(file),filesBefore)
  fresh('old-result.json',{status:'passed',caseName,positiveStatus:positive.status,queuedOperationId:queued.clientOperationId,targetRead,sourceRead,staleWrite,ownerObservation,cold,restoreError,stopCalled,filesBefore,filesAfter:fingerprints(file),targetBefore,targetAfter:fingerprints(target),allTablesUnchanged:true,limitations:'Old historical read-owner probe is observation, not asserted revoked. No arbitrary already loaded old ordinary Store write denial is claimed under unchanged DDL27.'})
}catch(error){fresh('old-failure.json',{name:error?.name??null,error:String(error),stack:error?.stack??null});process.stderr.write((error?.stack??String(error))+'\n');process.exitCode=1}
finally{held?.destroy();if(process.connected)process.disconnect()}
