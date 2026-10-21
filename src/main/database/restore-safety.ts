import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { stopDatabaseRestoreProcesses, type RestoreProcessIdentity } from './restore-process-guard'
import { hasAnySyncedObservationPending } from './synced-remote-observation-pending'
import { assertControlledRestoreReceipt, inspectOrdinaryRestoreDatabase, RestoreUnreadableDatabase, type RestoreDatabaseInspection } from './restore-safety-read'
import { finalizeControlledRestoreStage, migrateControlledRestoreStage } from './restore-safety-stage'
import { RESTORE_FILES, restoreFail, restoreHash, restoreJson, validateRestoreFence, validateRestoreIntent, validateRestoreJournal,
  type RestoreCurrent, type RestoreFence, type RestoreIntent, type RestoreJournal, type RestoreRawFile, type RestoreReceipt } from './restore-safety-model'
import { RESTORE_FENCE, RESTORE_PENDING, RESTORE_SAFE_MODE, assertNoRestorePrivateSyncFiles, assertRestoreInventory, assertRestorePath,
  canonicalRestoreRoot, copyRestoreInventory, readRestoreJson, readRestoreText, restoreDirectory, restoreExists, restoreFileDigest,
  restoreInventory, restorePaths, syncRestoreDirectory, syncRestoreFile, writeRestoreJson } from './restore-safety-files'
import { readRestoreJournalVersion } from './restore-safety-files'
import { prepareDurableSqlCapsuleOriginal } from './restore-knowledge-capsule-files'
import { certifyDurableSqlCapsuleIfSupported, readCertifiedDurableSqlCapsule,
  type CertifiedDurableSqlCapsule } from './restore-knowledge-capsule-read'

export interface ControlledRestoreInput {
  userDataRoot:string; backupPath:string; stopProcesses?:typeof stopDatabaseRestoreProcesses; beforeReplace?:()=>Promise<void>
}
export interface ControlledRestoreResult {
  recoveryDirectory:string; sourceSha256:string; schemaVersion:number; stoppedPids:number[]; operationId:string
  installedSchemaVersion:27; continuity:'ordinary-verified'|'legacy-disaster-unverified';workspaceScope:string;recoveryEpoch:string
}
export interface RestoreLegacyIdentityReader {
  readCurrentIdentities:(root:string,recovery:string)=>Promise<RestoreProcessIdentity[]>
  recoverLegacy:(root:string)=>Promise<boolean>
}
const owners=new Set<string>()
const ownerKey=(root:string):string=>process.platform==='win32'?root.toLowerCase():root
function acquire(root:string):()=>void{const key=ownerKey(root);if(owners.has(key))return restoreFail('该profile已有维护owner。');owners.add(key);return()=>{owners.delete(key)}}
const rawHash=(raw:string):string=>createHash('sha256').update(raw).digest('hex')
const fenceFor=(intent:RestoreIntent,phase:RestoreFence['phase']):RestoreFence=>({kind:'controlled-database-restore-fence',version:1,
  operationId:intent.operationId,intentHash:restoreHash(intent),phase,parentFenceHash:intent.parentFenceHash})
const journalFor=(intent:RestoreIntent,phase:RestoreJournal['phase']):RestoreJournal=>({kind:'controlled-database-restore-journal',version:2,
  operationId:intent.operationId,intentHash:restoreHash(intent),phase})

async function readIntent(root:string,fence:RestoreFence):Promise<RestoreIntent>{
  const p=restorePaths(root,fence.operationId)
  await assertRestorePath(p.recovery,root)
  const intent=validateRestoreIntent(await readRestoreJson(p.intent))
  if(intent.operationId!==fence.operationId||intent.profileRoot!==root||intent.databasePath!==p.database
    ||restoreHash(intent)!==fence.intentHash||intent.parentFenceHash!==fence.parentFenceHash)return restoreFail('fence与原immutable intent/path不符。')
  if(!await restoreExists(p.safety)||(await lstat(p.safety)).isDirectory()===false)return restoreFail('原安全capsule缺失。')
  const expectedNames=new Set<string>(intent.current.inventory.filter(row=>row.present).map(row=>row.name))
  if((await readdir(p.safety)).some(name=>!expectedNames.has(name)))return restoreFail('安全capsule出现清单之外的原件。')
  await assertRestoreInventory(p.safety,intent.current.inventory)
  return intent
}
async function lineage(root:string,first:RestoreFence):Promise<Array<{fence:RestoreFence;intent:RestoreIntent}>>{
  const seen=new Set<string>(),chain:Array<{fence:RestoreFence;intent:RestoreIntent}>=[]
  let fence=first
  for(;;){if(seen.has(fence.operationId))return restoreFail('外fence lineage循环。');seen.add(fence.operationId)
    const intent=await readIntent(root,fence);chain.push({fence,intent})
    const parentPath=restorePaths(root,intent.operationId).parent
    if(intent.parentFenceHash===null){if(await restoreExists(parentPath))return restoreFail('无parent的intent出现额外parent原件。');break}
    const raw=await readRestoreText(parentPath)
    if(rawHash(raw)!==intent.parentFenceHash)return restoreFail('原parent fence bytes/hash缺失或改变。')
    fence=validateRestoreFence(await readRestoreJson(parentPath))
    if(fence.phase==='prepared')return restoreFail('新restore不能继承未完成prepared父fence。')
  }
  return chain
}
async function withCurrentCopy<T>(root:string,ownerId:string,read:(file:string,inventory:RestoreRawFile[])=>T):Promise<T>{
  const p=restorePaths(root,ownerId),temporary=join(p.recovery,'read-'+randomUUID())
  const inventory=await restoreInventory(p.storage)
  let primary:unknown,result:T|undefined,completed=false
  try{
    await copyRestoreInventory(p.storage,temporary,inventory,root)
    result=read(join(temporary,'knowbook.db'),inventory);completed=true
  }catch(error){primary=error}
  try{await assertRestorePath(temporary,root);await rm(temporary,{recursive:true,force:true})}
  catch(cleanup){if(primary!==undefined)throw new AggregateError([primary,cleanup],'当前只读inspection与清理均失败；原库未替换。');throw cleanup}
  if(!completed)throw primary
  return result!
}
function installedInChain(chain:Array<{fence:RestoreFence;intent:RestoreIntent}>):RestoreIntent|null{
  for(const row of chain)if(row.fence.phase==='installed')return row.intent
  return null
}
async function authenticateCurrent(root:string,chain:Array<{fence:RestoreFence;intent:RestoreIntent}>):Promise<void>{
  const newest=chain[0],installed=installedInChain(chain)
  if(installed){await withCurrentCopy(root,newest.intent.operationId,file=>assertControlledRestoreReceipt(file,installed.receipt));return}
  if(newest.fence.phase!=='rolledback')return restoreFail('尚未安装／回退的fence不能认证current。')
  if(newest.intent.current.classification==='legacy-disaster-unverified'){
    // This only recognizes an exact rollback of the already-recorded damaged original.
    // A new restore still refuses unreadable current when any external fence exists.
    await assertRestoreInventory(restorePaths(root,newest.intent.operationId).storage,newest.intent.current.inventory);return
  }
  await withCurrentCopy(root,newest.intent.operationId,(file,inventory)=>{
    if(!inventory[0].present){if(inventory.some(row=>row.present))return restoreFail('rollback current仅剩sidecar。');return}
    const now=inspectOrdinaryRestoreDatabase(file),old=newest.intent.current
    if(old.workspaceScope!==null&&(now.workspaceScope!==old.workspaceScope||now.recoveryEpoch!==old.recoveryEpoch))return restoreFail('回退后scope/epoch被替换。')
  })
}
async function verifyInstalled(root:string,intent:RestoreIntent,raw:boolean):Promise<void>{
  const p=restorePaths(root,intent.operationId)
  await assertRestorePath(p.database,root)
  if(raw&&(await restoreFileDigest(p.database)).sha256!==intent.stagedSha256)return restoreFail('安装bytes不是原final stage。')
  await withCurrentCopy(root,intent.operationId,file=>assertControlledRestoreReceipt(file,intent.receipt))
}
async function finishInstalled(root:string,intent:RestoreIntent,stoppedPids?:number[]):Promise<void>{
  const p=restorePaths(root,intent.operationId)
  await assertRestoreInventory(p.original,intent.current.inventory)
  await verifyInstalled(root,intent,false)
  await writeRestoreJson(p.journal,journalFor(intent,'installed'),root)
  await writeRestoreJson(p.fence,fenceFor(intent,'installed'),root)
  await writeRestoreJson(p.safeMarker,{id:intent.operationId,recoveryDirectory:p.recovery},root)
  await writeRestoreJson(p.result,{status:'restored',recoveryDirectory:p.recovery,sourceSha256:intent.source.sha256,schemaVersion:intent.source.schemaVersion,
    operationId:intent.operationId,installedSchemaVersion:27,continuity:intent.receipt.continuity,workspaceScope:intent.receipt.workspaceScope,
    recoveryEpoch:intent.receipt.recoveryEpoch,...(stoppedPids===undefined?{recovered:true}:{stoppedPids}),completedAt:new Date().toISOString()},root)
  await rm(p.journal);await syncRestoreDirectory(root)
}
async function rollbackControlled(root:string,intent:RestoreIntent,keepSafeMode=false,completeArchive=false):Promise<void>{
  const p=restorePaths(root,intent.operationId)
  // Validate the complete plan before mutating any file. Missing both copies is never an empty DB.
  if((await readdir(p.original)).some(name=>!intent.current.inventory.some(row=>row.present&&row.name===name)))return restoreFail('original目录出现原清单之外的文件。')
  await assertRestoreInventory(p.safety,intent.current.inventory)
  for(const item of intent.current.inventory)if(item.present){
    const archive=join(p.original,item.name),current=join(p.storage,item.name),path=await restoreExists(archive)?archive:current
    if(completeArchive&&!await restoreExists(archive))return restoreFail('已安装candidate物理坏，但原archive不完整；保留journal。')
    const actual=await restoreFileDigest(path)
    if(actual.sha256!==item.sha256||actual.bytes!==item.bytes)return restoreFail('原三文件不完整或原件hash改变；保留journal阻启动。')
  }
  for(const item of intent.current.inventory){const current=join(p.storage,item.name),archive=join(p.original,item.name)
    if(item.present&&!await restoreExists(archive))continue
    if(await restoreExists(current)){await assertRestorePath(current,root);await rename(current,join(p.recovery,'rejected-'+item.name+'-'+randomUUID()))}
    if(item.present)await rename(archive,current)
  }
  await assertRestoreInventory(p.storage,intent.current.inventory)
  await syncRestoreDirectory(p.storage);await syncRestoreDirectory(p.original);await syncRestoreDirectory(p.recovery)
  await writeRestoreJson(p.fence,fenceFor(intent,'rolledback'),root)
  if(await restoreExists(p.safeMarker)){
    let marker:unknown
    try{marker=JSON.parse(await readFile(p.safeMarker,'utf8'))}catch{return restoreFail('安全启动marker损坏，保留journal。')}
    if(marker&&typeof marker==='object'&&'id'in marker&&marker.id===intent.operationId&&!keepSafeMode)await rm(p.safeMarker)
  }
  await writeRestoreJson(p.result,{status:'rolled-back',operationId:intent.operationId,completedAt:new Date().toISOString()},root)
  if(await restoreExists(p.journal))await rm(p.journal)
  await syncRestoreDirectory(root)
}
/** Called by the existing startup entry before Store/worker/plugin initialization. */
async function recoverOwned(root:string):Promise<boolean>{
  const fencePath=join(root,RESTORE_FENCE),journalPath=join(root,RESTORE_PENDING)
  const hasFence=await restoreExists(fencePath),hasJournal=await restoreExists(journalPath)
  if(!hasFence){if(hasJournal)return restoreFail('journal2缺准确库外fence。');return restoreExists(join(root,RESTORE_SAFE_MODE))}
  const fence=validateRestoreFence(await readRestoreJson(fencePath)),chain=await lineage(root,fence),intent=chain[0].intent,p=restorePaths(root,intent.operationId)
  if(!hasJournal){
    if(fence.phase==='prepared'){
      await assertRestoreInventory(p.storage,intent.current.inventory)
      await writeRestoreJson(p.fence,fenceFor(intent,'rolledback'),root)
      await writeRestoreJson(p.result,{status:'aborted-before-move',operationId:intent.operationId,completedAt:new Date().toISOString()},root)
    }else await authenticateCurrent(root,chain)
    return restoreExists(p.safeMarker)
  }
  const journal=validateRestoreJournal(await readRestoreJson(journalPath))
  if(journal.operationId!==intent.operationId||journal.intentHash!==restoreHash(intent))return restoreFail('active pointer不是原fence/intent。')
  if(fence.phase==='rolledback'){
    await assertRestoreInventory(p.storage,intent.current.inventory)
    await writeRestoreJson(p.result,{status:'rolled-back',operationId:intent.operationId,completedAt:new Date().toISOString()},root)
    await rm(p.journal);await syncRestoreDirectory(root);return restoreExists(p.safeMarker)
  }
  if(fence.phase==='installed'||journal.phase==='installed'){
    let physicallyBad=!await restoreExists(p.database)
    if(!physicallyBad){try{await verifyInstalled(root,intent,false)}catch(error){if(!(error instanceof RestoreUnreadableDatabase))throw error;physicallyBad=true}}
    if(physicallyBad){
      // First authenticate every archived original. Do not confuse a finish I/O error with a bad target.
      for(const file of intent.current.inventory)if(file.present){const original=await restoreFileDigest(join(p.original,file.name))
        if(original.sha256!==file.sha256||original.bytes!==file.bytes)return restoreFail('已安装candidate物理坏且原archive不完整。')}
      await writeRestoreJson(p.safeMarker,{id:intent.operationId,recoveryDirectory:p.recovery},root)
      await writeRestoreJson(p.journal,journalFor(intent,'moving'),root)
      await writeRestoreJson(p.fence,fenceFor(intent,'prepared'),root)
      await rollbackControlled(root,intent,true,true);return true
    }
    // An exact valid target only finishes. Result/cleanup errors never enter the physical rollback branch.
    await finishInstalled(root,intent);return true
  }
  if(!await restoreExists(p.stage)&&await restoreExists(p.database)){
    let matches=false
    try{await verifyInstalled(root,intent,true);matches=true}catch{ /* Only an exact original candidate may commit the interrupted rename. */ }
    if(matches){await finishInstalled(root,intent);return true}
  }
  let keepSafeMode=false
  if(await restoreExists(p.safeMarker)){const marker:unknown=JSON.parse(await readRestoreText(p.safeMarker));keepSafeMode=Boolean(marker&&typeof marker==='object'&&'id'in marker&&marker.id===intent.operationId)}
  await rollbackControlled(root,intent,keepSafeMode);return restoreExists(p.safeMarker)
}
async function dispatchOwnedRecovery(root:string,recoverLegacy:(root:string)=>Promise<boolean>):Promise<boolean>{
  const journal=join(root,RESTORE_PENDING),fenced=await restoreExists(join(root,RESTORE_FENCE))
  if(await restoreExists(journal)){
    const version=await readRestoreJournalVersion(journal)
    if(version===1){if(fenced)return restoreFail('已有库外fence，旧v1 journal不可绕过新恢复认证。');return recoverLegacy(root)}
    if(version!==2)return restoreFail('未知恢复journal版本。')
  }
  return recoverOwned(root)
}
export async function recoverControlledDatabaseRestore(userDataRoot:string,recoverLegacy:(root:string)=>Promise<boolean>):Promise<boolean>{
  const requested=resolve(userDataRoot)
  await assertRestorePath(requested)
  if(!await restoreExists(requested))return false
  const root=await canonicalRestoreRoot(requested),release=acquire(root)
  try{return await dispatchOwnedRecovery(root,recoverLegacy)}finally{release()}
}

/** Evidence capture only. Legacy ordinary admission still decides whether the
 * existing restore may proceed; a capsule never authorizes synced installation. */
async function captureRestoreSqlOriginal(p:ReturnType<typeof restorePaths>,sealedDirectory:string,label:'source'|'current'):Promise<CertifiedDurableSqlCapsule|null>{
  const original=await prepareDurableSqlCapsuleOriginal({profileRoot:p.root,recoveryDirectory:p.recovery,sealedDirectory,capsuleId:randomUUID(),label})
  let result:Awaited<ReturnType<typeof certifyDurableSqlCapsuleIfSupported>>
  try{result=await certifyDurableSqlCapsuleIfSupported(original)}catch(error){
    if(error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'
      &&(error.code==='SQLITE_NOTADB'||error.code.startsWith('SQLITE_CORRUPT')))throw new RestoreUnreadableDatabase(error)
    throw error
  }
  if(result.status==='unsupported-schema'){
    await writeRestoreJson(join(p.recovery,label+'-durable-sql.json'),{status:result.status,schemaVersion:result.schemaVersion,
      material:'durable-sql-only',certifiedForInstallation:false},p.root,true)
    return null
  }
  const seal=await readCertifiedDurableSqlCapsule(result.capsule)
  await writeRestoreJson(join(p.recovery,label+'-durable-sql.json'),{status:'certified',manifestPath:seal.manifestPath,
    manifestHash:seal.manifestHash,material:seal.manifest.material,certifiedForInstallation:false},p.root,true)
  return result.capsule
}
async function sourceSqlInventory(source:string):Promise<RestoreRawFile[]>{
  const result:RestoreRawFile[]=[]
  for(const [index,name]of RESTORE_FILES.entries()){
    const path=source+['','-wal','-shm'][index]
    await assertRestorePath(path)
    if(!await restoreExists(path)){result.push({name,present:false,bytes:0,sha256:null});continue}
    const actual=await restoreFileDigest(path)
    result.push({name,present:true,...actual})
  }
  return result
}
async function assertNoActiveRestoreRollbackJournal(database:string):Promise<void>{
  const journal=database+'-journal'
  if(!await restoreExists(journal))return
  await assertRestorePath(journal)
  const info=await lstat(journal)
  if(!info.isFile()||info.size>0)return restoreFail('原数据库含非空或非普通 rollback journal；三文件SQL capsule不能静默遗漏它。')
}
async function sourceStage(source:string,p:ReturnType<typeof restorePaths>):Promise<{sha256:string;schemaVersion:number;authority:{workspaceScope:string|null;recoveryEpoch:string|null};capsule:CertifiedDurableSqlCapsule|null;inventory:RestoreRawFile[]}>{
  await assertRestorePath(source)
  const identity=await lstat(source)
  if(!identity.isFile()||identity.isSymbolicLink())return restoreFail('备份不是独立普通SQLite文件。')
  if(resolve(source).toLowerCase()===resolve(p.database).toLowerCase())return restoreFail('不能恢复当前DB本身。')
  for(const path of [...RESTORE_FILES.map(name=>join(p.storage,name)),p.stage,p.fence,p.journal,p.intent,p.parent]){
    if(!await restoreExists(path))continue
    await assertRestorePath(path,p.root)
    const other=await lstat(path)
    if(identity.ino!==0&&identity.ino===other.ino&&(identity.dev===other.dev||process.platform==='win32'&&(identity.dev===0||other.dev===0)))return restoreFail('备份与profile-owned原件是同一实际file/hardlink。')
  }
  if(await restoreExists(source+'-wal')&&(await lstat(source+'-wal')).size>0)return restoreFail('备份含活动WAL。')
  await assertNoActiveRestoreRollbackJournal(source)
  const sourceInventory=await sourceSqlInventory(source),original=sourceInventory[0]
  if(!original.present||original.sha256===null)return restoreFail('备份原DB缺失。')
  if(sourceInventory[1].bytes>0)return restoreFail('备份含活动WAL。')
  await copyFile(source,p.stage,constants.COPYFILE_EXCL)
  if((await restoreFileDigest(p.stage)).sha256!==original.sha256||(await restoreFileDigest(source)).sha256!==original.sha256)return restoreFail('复制期间备份发生变化。')
  // Preserve the untouched source before SQLite first opens the migration stage.
  const sourceOriginal=join(p.recovery,'source-original')
  await restoreDirectory(sourceOriginal,p.root,true)
  for(const [index,item]of sourceInventory.entries())if(item.present){
    const target=join(sourceOriginal,item.name)
    await copyFile(source+['','-wal','-shm'][index],target,constants.COPYFILE_EXCL);await syncRestoreFile(target)
  }
  await syncRestoreDirectory(sourceOriginal)
  await assertRestoreInventory(sourceOriginal,sourceInventory)
  if(restoreJson(await sourceSqlInventory(source))!==restoreJson(sourceInventory))return restoreFail('源原三文件在封存期间变化。')
  const capsule=await captureRestoreSqlOriginal(p,sourceOriginal,'source')
  const sourceDb=inspectOrdinaryRestoreDatabase(p.stage)
  return {sha256:original.sha256,schemaVersion:sourceDb.schemaVersion,authority:{workspaceScope:sourceDb.workspaceScope,recoveryEpoch:sourceDb.recoveryEpoch},capsule,inventory:sourceInventory}
}
function fixedDocumentBoundary(versions:readonly string[]):string{
  const known=new Set(versions);let next=Date.now(),value=new Date(next).toISOString()
  while(known.has(value)){next++;value=new Date(next).toISOString()}
  return value
}
export async function restoreControlledDatabase(input:ControlledRestoreInput,legacy:RestoreLegacyIdentityReader):Promise<ControlledRestoreResult>{
  if(!isAbsolute(input.backupPath)||input.backupPath.includes('\0'))return restoreFail('备份必须使用原绝对路径。')
  await assertRestorePath(input.userDataRoot);await mkdir(resolve(input.userDataRoot),{recursive:true})
  const root=await canonicalRestoreRoot(input.userDataRoot),release=acquire(root)
  try{
    await dispatchOwnedRecovery(root,legacy.recoverLegacy)
    if(hasAnySyncedObservationPending())return restoreFail('当前进程仍有未持久化的远端曝光拒绝份额。')
    const p=restorePaths(root,randomUUID())
    await restoreDirectory(p.storage,root);await restoreDirectory(dirname(p.recovery),root);await restoreDirectory(p.recovery,root,true)
    await restoreDirectory(p.original,root,true)
    let intent:RestoreIntent|undefined,moving=false,installed=false,stoppedPids:number[]=[]
    try{
      const source=await sourceStage(input.backupPath,p)
      const identities=await legacy.readCurrentIdentities(root,p.recovery)
      stoppedPids=await(input.stopProcesses??stopDatabaseRestoreProcesses)({userDataRoot:root,identities})
      await assertNoRestorePrivateSyncFiles(root)
      await assertNoActiveRestoreRollbackJournal(p.database)
      const inventory=await restoreInventory(p.storage)
      await copyRestoreInventory(p.storage,p.safety,inventory,root)
      let current:RestoreCurrent|undefined,currentVersions:string[]=[],currentInspection:RestoreDatabaseInspection|undefined,currentCapsule:CertifiedDurableSqlCapsule|null=null
      const parentExists=await restoreExists(p.fence)
      let parent:RestoreFence|null=null,parentRaw:string|null=null
      if(parentExists){parentRaw=await readRestoreText(p.fence);parent=validateRestoreFence(await readRestoreJson(p.fence));await lineage(root,parent)}
      if(!inventory[0].present){
        if(inventory.some(row=>row.present))return restoreFail('current缺DB但仍有sidecar；不能认证为空。')
        if(parent)return restoreFail('已有外fence但current数据库缺失。')
        current={classification:'missing',schemaVersion:null,workspaceScope:null,recoveryEpoch:null,inventory}
      }else{
        const inspectDirectory=join(p.recovery,'safety-inspection')
        await copyRestoreInventory(p.safety,inspectDirectory,inventory,root)
        const file=join(inspectDirectory,'knowbook.db')
        try{currentCapsule=await captureRestoreSqlOriginal(p,p.safety,'current');currentInspection=inspectOrdinaryRestoreDatabase(file)}catch(error){
          if(parent||!(error instanceof RestoreUnreadableDatabase))throw error
          current={classification:'legacy-disaster-unverified',schemaVersion:null,workspaceScope:null,recoveryEpoch:null,inventory}
        }
        if(currentInspection){
          if(parent){const previous=installedInChain(await lineage(root,parent));if(previous)assertControlledRestoreReceipt(file,previous.receipt)}
          currentVersions=currentInspection.documentVersions
          current={classification:'ordinary-verified',schemaVersion:currentInspection.schemaVersion,workspaceScope:currentInspection.workspaceScope,
            recoveryEpoch:currentInspection.recoveryEpoch,inventory}
        }
      }
      // Every preceding branch assigns a real classification; no catch converts semantic damage to empty.
      if(!current)return restoreFail('缺准确current分类。')
      const migrated=migrateControlledRestoreStage(p.stage,source.schemaVersion)
      if(migrated.workspaceScope===null||migrated.recoveryEpoch===null)return restoreFail('stage27缺实际scope/epoch。')
      let epoch=randomUUID()
      while(epoch===migrated.recoveryEpoch||epoch===current.recoveryEpoch||epoch===source.authority.recoveryEpoch)epoch=randomUUID()
      const acceptedAt=new Date().toISOString(),receipt:RestoreReceipt={kind:'controlled-database-restore-receipt',version:1,operationId:p.recovery.split(/[\\/]/).at(-1)!,
        profileRoot:root,sourceSha256:source.sha256,sourceSchemaVersion:source.schemaVersion,cloneSha256:source.sha256,currentInventoryHash:restoreHash(inventory),
        workspaceScope:current.workspaceScope??migrated.workspaceScope,recoveryEpoch:epoch,documentBoundary:fixedDocumentBoundary([...currentVersions,...migrated.documentVersions]),
        continuity:current.classification==='legacy-disaster-unverified'?'legacy-disaster-unverified':'ordinary-verified',acceptedAt}
      finalizeControlledRestoreStage(p.stage,receipt)
      for(const suffix of ['-wal','-shm'])if(await restoreExists(p.stage+suffix)&&(await lstat(p.stage+suffix)).size>0)return restoreFail('关闭stage仍含活动sidecar。')
      await syncRestoreFile(p.stage);await syncRestoreDirectory(p.recovery)
      const stagedSha256=(await restoreFileDigest(p.stage)).sha256
      if(parentRaw!==null){const currentRaw=await readRestoreText(p.fence);if(currentRaw!==parentRaw)return restoreFail('维护期间parent fence变化。')
        const fd=await open(p.parent,'wx')
        try{await fd.writeFile(parentRaw);await fd.sync()}finally{await fd.close()}
        await syncRestoreDirectory(p.recovery)}
      intent=validateRestoreIntent({kind:'controlled-database-restore-intent',version:2,operationId:receipt.operationId,profileRoot:root,databasePath:p.database,
        createdAt:acceptedAt,source:{path:resolve(input.backupPath),sha256:source.sha256,schemaVersion:source.schemaVersion},current,candidateAuthority:source.authority,
        parentFenceHash:parentRaw===null?null:rawHash(parentRaw),receipt,receiptHash:restoreHash(receipt),stagedSha256})
      await assertRestoreInventory(p.storage,inventory)
      if(source.capsule)await readCertifiedDurableSqlCapsule(source.capsule)
      if(currentCapsule)await readCertifiedDurableSqlCapsule(currentCapsule)
      if((await restoreFileDigest(input.backupPath)).sha256!==source.sha256)return restoreFail('源备份在维护期间变化。')
      if(restoreJson(await sourceSqlInventory(input.backupPath))!==restoreJson(source.inventory))return restoreFail('源原三文件在维护期间变化。')
      await assertNoActiveRestoreRollbackJournal(input.backupPath)
      await assertNoActiveRestoreRollbackJournal(p.database)
      await writeRestoreJson(p.intent,intent,root,true)
      await writeRestoreJson(p.fence,fenceFor(intent,'prepared'),root)
      await writeRestoreJson(p.journal,journalFor(intent,'moving'),root);moving=true
      for(const file of inventory)if(file.present)await rename(join(p.storage,file.name),join(p.original,file.name))
      await syncRestoreDirectory(p.storage);await syncRestoreDirectory(p.original)
      await input.beforeReplace?.()
      if(source.capsule)await readCertifiedDurableSqlCapsule(source.capsule)
      if(currentCapsule)await readCertifiedDurableSqlCapsule(currentCapsule)
      if(restoreJson(await sourceSqlInventory(input.backupPath))!==restoreJson(source.inventory))return restoreFail('源原三文件在安装前变化。')
      await assertNoActiveRestoreRollbackJournal(input.backupPath)
      await assertNoActiveRestoreRollbackJournal(p.database)
      await assertRestoreInventory(p.original,inventory)
      for(const name of RESTORE_FILES)if(await restoreExists(join(p.storage,name)))return restoreFail('安装前storage出现非原分配数据库文件。')
      await rename(p.stage,p.database);await syncRestoreDirectory(p.storage);await syncRestoreDirectory(p.recovery)
      await verifyInstalled(root,intent,true);installed=true
      await finishInstalled(root,intent,stoppedPids)
      return {recoveryDirectory:p.recovery,sourceSha256:source.sha256,schemaVersion:source.schemaVersion,stoppedPids,
        operationId:intent.operationId,installedSchemaVersion:27,continuity:receipt.continuity,workspaceScope:receipt.workspaceScope,recoveryEpoch:receipt.recoveryEpoch}
    }catch(error){
      if(installed)throw new Error('数据库已按原receipt安装；完成记录尚待重试，不回滚已认证安装。\n'+String(error),{cause:error})
      if(moving&&intent){try{await rollbackControlled(root,intent)}catch(rollbackError){throw new AggregateError([error,rollbackError],'受控恢复失败且回退未完成；原件／capsule／journal保留，禁止启动。')}}
      throw new Error('数据库未替换或已按原三文件回退；恢复证据保留于'+p.recovery+'\n'+String(error),{cause:error})
    }
  }finally{release()}
}
