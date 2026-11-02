// Explicit durable all-merge Working5 originals. Source4 formats and their
// custom-only scope remain unchanged; this independent owner grants no install.
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES } from './restore-knowledge-dag-model'
import { readOwnedRawCapsuleOriginal, assertOwnedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { readCapsule2AssetManifest, readCapsule2AssetCopy as readExact, writeCapsule2AssetCopy as writeNew } from './restore-knowledge-capsule2-assets-files'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { readCapsule2BaseProjectionOriginalInput5 as readCapsule2BaseProjection4, assertCapsule2BaseProjectionOriginal4, assertCapsule2BaseProjectionOriginalBytes4,
  describeCapsule2BaseProjectionPointer4, validateCapsule2BaseProjectionPointer4,
  type PreparedCapsule2BaseProjection4, type Capsule2BaseProjectionPointer4 } from './restore-knowledge-capsule2-base-projection4'
import { capsule2MergeContextNativeFilesForMain4 as io, readCapsule2MergeContextBufferForMain3, readCapsule2MergeContextDigestForMain3,
  type Capsule2MergeContextCapture3 } from './restore-knowledge-capsule2-merge-contexts'
import { validateWorkingOriginalsManifest5, parseWorkingOriginals5, describeWorkingOriginals5, workingOriginalsManifestHash5,
  type WorkingOriginalsManifest5, type WorkingOriginalsPointer5, type SettledBinding } from './restore-knowledge-capsule5-working-model'
export {validateWorkingOriginalsManifest5,parseWorkingOriginals5,describeWorkingOriginals5} from './restore-knowledge-capsule5-working-model'
export type {WorkingOriginalsManifest5,WorkingOriginalsPointer5} from './restore-knowledge-capsule5-working-model'
import { deriveCapsule2WorkingPortableEvidence5 } from './restore-knowledge-assets5-working-portable-derive'
import { requiredRoot5WorkingMergeLocators5, createRoot5WorkingMergeReplay5, type Root5WorkingMergeLocator5 } from './restore-knowledge-assets5-working-context'
import { createRoot5WorkingScopeObserver5 } from './restore-knowledge-assets5-working-scopes'
import { root3SupplementOriginalRowHash3, type Root3MergeContextBytes3 } from './restore-knowledge-assets3-context'
import { validateExchangeJob, parseExchangeStored, exchangeJobHash } from '../sync/synced-exchange-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
type Base=Awaited<ReturnType<typeof readCapsule2BaseProjection4>>
type Automatic=ReturnType<typeof automaticEvidence>
interface ContextFile {readonly name:string;readonly sha256:string;readonly bytes:number}
export interface PreparedWorkingOriginals5 {readonly kind:'prepared-merge-working-originals5'}
interface Saved {original:OwnedRawCapsuleOriginal;base:PreparedCapsule2BaseProjection4;root:string;directory:string;manifest:WorkingOriginalsManifest5;bytes:Buffer;manifestHash:string;
  created?:ReadonlyMap<string,{readonly dev:bigint;readonly ino:bigint}>}
const owners=new WeakMap<PreparedWorkingOriginals5,Saved>(),used=new WeakSet<PreparedCapsule2BaseProjection4>()
const fail=(reason:string):never=>{throw new Error('automatic working originals5: '+reason+'；不授accepted或安装权。')}
const same=(a:unknown,b:unknown)=>capsuleJson(a)===capsuleJson(b)
const hash=(domain:string,value:unknown)=>capsuleBytesHash(domain+'\0'+capsuleJson(value))
const digest=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail('hash无效')
const manifestHash=workingOriginalsManifestHash5
const locatorBinding=(locator:Root5WorkingMergeLocator5)=>({jobSettingKey:locator.jobSettingKey,sourceRowId:locator.sourceRowId,originalRowHash:locator.originalRowHash,
  locatorHash:hash('knowbook.capsule5.merge-working-locator.v1',locator)})
const number=(value:unknown):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:fail('有限计数无效')
function automaticEvidence(base:Base){return deriveCapsule2WorkingPortableEvidence5({source:base.source,referenceCapture:{version:2,sourceContentHash:base.commitment.sourceContentHash,
  workspaceHistoryObservationHash:base.commitment.workspaceHistoryObservationHash,assetReferencesObservationHash:base.commitment.assetReferencesObservationHash,
  referenceUris:base.referenceUris,tree:base.tree,referenceProvenance:base.baseProof},binding:{baseProjectionManifestHash:base.commitment.baseManifestHash,baseProjectionMaterialHash:base.commitment.baseMaterialHash}})}
function selected(base:Base,automatic:Automatic){
  const all=requiredRoot5WorkingMergeLocators5(base.sourceContent,{includeSettled:true}),proven=new Map(automatic.jobs.map(value=>[value.jobSettingKey,value]))
  const settledBindings:SettledBinding[]=[],wanted:Root5WorkingMergeLocator5[]=[]
  for(const locator of all){const value=proven.get(locator.jobSettingKey);if(!value){wanted.push(locator);continue}
    if(value.jobHash!==locator.jobHash)return fail('settled whole W不是原job')
    settledBindings.push({...locatorBinding(locator),contextHash:value.contextHash,bindingHash:hash('knowbook.capsule5.merge-settled-binding.v1',value.binding)});proven.delete(locator.jobSettingKey)
  }
  if(proven.size)return fail('settled证据含非原job4 merge')
  return{settledBindings,wanted}
}
function jobFor(base:Base,locator:Root5WorkingMergeLocator5){
  const rows=graph3Rows(base.sourceContent,'app_settings').filter(row=>row.value.key===locator.jobSettingKey)
  if(rows.length!==1||rows[0].original.sourceRowId!==locator.sourceRowId||root3SupplementOriginalRowHash3(base.sourceContent,rows[0])!==locator.originalRowHash||typeof rows[0].value.value!=='string')return fail('原SQL locator不符')
  const job=validateExchangeJob(parseExchangeStored(rows[0].value.value))
  if(job.version===1||exchangeJobHash(job)!==locator.jobHash||job.spoolHash!==locator.spoolHash||publicationHash(publicationJson(job.descriptor))!==locator.descriptorHash)return fail('原job4不符')
  return job
}
async function contextBytes(saved:Pick<Saved,'directory'|'root'>,base:Base,locator:Root5WorkingMergeLocator5,files:readonly ContextFile[]):Promise<Root3MergeContextBytes3>{
  const table=new Map(files.map(file=>[file.name,file])),job=jobFor(base,locator),get=(name:string)=>table.get(name)??fail('缺固定context文件')
  const bytes=async(name:string)=>{const file=get(name);return readCapsule2MergeContextBufferForMain3(join(saved.directory,'files',file.sha256),saved.root,file)}
  const streamed=async(name:string)=>{const file=get(name);return readCapsule2MergeContextDigestForMain3(join(saved.directory,'files',file.sha256),saved.root,file)}
  const objects=[],assets=[]
  for(const item of new Map(job.descriptor.next.objects.map(item=>[item.hash,item])).values())objects.push({hash:item.hash,bytes:await streamed(item.path)})
  for(const item of job.descriptor.next.assets)assets.push({hash:item.hash,names:item.names,bytes:await streamed(item.path)})
  return{operationId:locator.operationId,attemptId:locator.attemptId,inputBytes:await bytes('inputs.json'),jobBytes:await bytes('job.json'),readyBytes:await bytes('ready.json'),manifestBytes:await bytes('manifest.json'),objects,assets}
}
function captures(manifest:WorkingOriginalsManifest5,base:Base,automatic:Automatic){
  const selection=selected(base,automatic),files=new Map(manifest.files.map(file=>[file.sha256,file.bytes]))
  if(!same(manifest.baseProjection,describeCapsule2BaseProjectionPointer4(base.commitment))||manifest.sourceContentHash!==base.commitment.sourceContentHash
    ||manifest.workingEvidenceHash!==automatic.evidenceHash||!same(manifest.settledBindings,selection.settledBindings)||manifest.captures.length!==selection.wanted.length)return fail('实际base/automatic分区不符')
  return selection.wanted.map((locator,index)=>{const capture=manifest.captures[index],binding=locatorBinding(locator)
    for(const key of ['jobSettingKey','sourceRowId','originalRowHash','locatorHash']as const)if(capture[key]!==binding[key])return fail('capture不是原自动job locator')
    if(capture.state==='unavailable'){
      if(capture.missingFiles.some(name=>name!=='spool'&&name!=='assets/'&&name!=='objects/'&&!locator.requiredFiles.includes(name)))return fail('缺失观察不属于固定原文件')
      return{locator,state:'unavailable'as const}
    }
    if(capture.fileHashes.length!==locator.requiredFiles.length)return fail('固定context文件数不同')
    return{locator,state:'captured'as const,files:locator.requiredFiles.map((name,i)=>{const sha256=capture.fileHashes[i],bytes=files.get(sha256);if(bytes===undefined)return fail('缺context闭集文件');return{name,sha256,bytes}})}
  })
}
/** Pure consistency check shared with a genuine qualified-original owner.
 * Data returned here grants no file access or source/observation capability. */
export const bindWorkingOriginalsToBase5 = captures
function assertOriginalBudget(base:Base,files:WorkingOriginalsManifest5['files']){
  const total=files.reduce((n,file)=>n+file.bytes,0)+base.tree.files.reduce((n,file)=>n+file.bytes,0)+base.commitment.baseManifestFile.bytes+base.commitment.sourceInventory.reduce((n,file)=>n+file.bytes,0)
  if(!Number.isSafeInteger(total)||total>DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES)return fail('原SQL/base/context总域超原预算')
}
async function verifyBytes(saved:Saved){
  await assertOwnedRawCapsuleOriginal(saved.original);await assertCapsule2BaseProjectionOriginalBytes4(saved.base)
  const before=await io.assertOriginCatalogDirectory(saved.directory,saved.root),files=join(saved.directory,'files'),fileBefore=await io.assertOriginCatalogDirectory(files,saved.root)
  const closure=async()=>{if(!same((await readdir(saved.directory)).sort(),['files','manifest.json'])||!same((await readdir(files)).sort(),saved.manifest.files.map(file=>file.sha256)))return fail('sealed目录闭集变化')}
  await closure();await readExact(join(saved.directory,'manifest.json'),saved.root,saved.bytes.length,capsuleBytesHash(saved.bytes),CAPSULE2_RAW_MAX_JSON_BYTES)
  await io.assertContextFileInventory({directory:files,root:saved.root,inventory:{files:saved.manifest.files},created:saved.created})
  await closure();const after=await io.assertOriginCatalogDirectory(saved.directory,saved.root),fileAfter=await io.assertOriginCatalogDirectory(files,saved.root)
  for(const[a,b]of[[before,after],[fileBefore,fileAfter]])if(a.dev!==b.dev||a.ino!==b.ino||a.mode!==b.mode||a.nlink!==b.nlink||a.mtimeNs!==b.mtimeNs||a.ctimeNs!==b.ctimeNs)return fail('目录在完整读取后变化')
  await assertCapsule2BaseProjectionOriginalBytes4(saved.base);await assertOwnedRawCapsuleOriginal(saved.original)
}
const summarize=(observation:ReturnType<ReturnType<typeof createRoot5WorkingScopeObserver5>['finish']>)=>({hash:observation.observationHash,scopeCount:observation.scopes.length,
  unsupportedHolders:observation.unsupportedHolders.length,pendingBindings:observation.pendingPortableBindings.length,settledPortableBindings:observation.settledPortableBindings.length})
async function rebuild(saved:Saved){
  assertCapsule2BaseProjectionOriginal4(saved.base,saved.original);await verifyBytes(saved)
  const base=await readCapsule2BaseProjection4(saved.base),automatic=automaticEvidence(base),bound=captures(saved.manifest,base,automatic)
  assertOriginalBudget(base,saved.manifest.files)
  const observer=createRoot5WorkingScopeObserver5(base,automatic),replay=createRoot5WorkingMergeReplay5(base.sourceContent),records=[]
  for(const value of automatic.jobs)for(const item of value.merged)records.push({jobSettingKey:value.jobSettingKey,...item})
  for(const item of bound)if(item.state==='captured'){
    const bytes=await contextBytes(saved,base,item.locator,item.files),value=replay(item.locator,bytes);observer.accept(value)
    for(const record of value.merged)records.push({jobSettingKey:item.locator.jobSettingKey,...record})
  }
  const observation=observer.finish();if(!same(summarize(observation),saved.manifest.observation))return fail('完整自动W/scope不属于持久观察摘要')
  await verifyBytes(saved)
  return freezeCapsuleValue({manifest:saved.manifest,manifestHash:saved.manifestHash,observation,settledEvidence:automatic,records,baseCommitment:base.commitment})
}
function mint(saved:Saved){const owner:PreparedWorkingOriginals5=Object.freeze({kind:'prepared-merge-working-originals5'});owners.set(owner,saved);return owner}
export async function prepareWorkingOriginals5(original:OwnedRawCapsuleOriginal,baseOwner:PreparedCapsule2BaseProjection4){
  assertCapsule2BaseProjectionOriginal4(baseOwner,original);if(used.has(baseOwner))return fail('同一base已开始，不覆盖重试');used.add(baseOwner)
  const base=await readCapsule2BaseProjection4(baseOwner),automatic=automaticEvidence(base),selection=selected(base,automatic),info=readOwnedRawCapsuleOriginal(original)
  const parent=join(info.recoveryDirectory,'knowledge-complete-assets-v2',basename(info.capsuleDirectory)),directory=join(parent,'contexts'),filesDirectory=join(directory,'files')
  await restoreDirectory(parent,info.profileRoot);await restoreDirectory(directory,info.profileRoot,true);await restoreDirectory(filesDirectory,info.profileRoot,true)
  const known={files:new Map<string,number>(),bytes:0},created=new Map<string,{dev:bigint;ino:bigint}>(),captured:Capsule2MergeContextCapture3[]=[]
  const observer=createRoot5WorkingScopeObserver5(base,automatic),replay=createRoot5WorkingMergeReplay5(base.sourceContent)
  for(const locator of selection.wanted){
    const job=jobFor(base,locator),spool=join(info.profileRoot,'storage','synced-exchanges-v1',locator.operationId,locator.attemptId),before=await io.spoolPreflight(spool,info.profileRoot,job,locator)
    if(before.missingFiles.length){captured.push({...locatorBinding(locator),state:'unavailable',reason:'missing-original-context',missingFiles:before.missingFiles,fileHashes:[]});continue}
    const files:ContextFile[]=[]
    for(const name of locator.requiredFiles)files.push({name,...await io.copyByHash(join(spool,...name.split('/')),info.profileRoot,filesDirectory,info.profileRoot,known,created)})
    const bytes=await contextBytes({directory,root:info.profileRoot},base,locator,files),value=replay(locator,bytes);observer.accept(value)
    for(const file of files){const again=await io.hashFile(join(spool,...file.name.split('/')),info.profileRoot);if(again.sha256!==file.sha256||again.bytes!==file.bytes)return fail('source spool bytes在尾变化')}
    await io.assertSpoolTail(spool,info.profileRoot,job,locator,before.directories)
    captured.push({...locatorBinding(locator),state:'captured',fileHashes:files.map(file=>file.sha256)})
  }
  const files=[...known.files].sort(([a],[b])=>a<b?-1:1).map(([sha256,bytes])=>({sha256,bytes})),observation=observer.finish()
  assertOriginalBudget(base,files)
  const manifest=validateWorkingOriginalsManifest5({kind:'capsule5-merge-working-originals',version:1,scope:'all-original-merge-working-records',families:[2,3,4,5,6,7],sourceContentHash:base.commitment.sourceContentHash,
    baseProjection:describeCapsule2BaseProjectionPointer4(base.commitment),workingEvidenceHash:automatic.evidenceHash,settledBindings:selection.settledBindings,captures:captured,files,
    observation:summarize(observation),allAssetScopesCaptured:false,otherHeldPayloadScopesComplete:false,acceptedCoverage:false,effective:false,installPermit:false})
  const bytes=Buffer.from(capsuleJson(manifest)+'\n');if(bytes.length>CAPSULE2_RAW_MAX_JSON_BYTES)return fail('完整manifest超原准备预算，不截断')
  await writeNew(join(directory,'manifest.json'),bytes,info.profileRoot);await syncRestoreDirectory(filesDirectory);await syncRestoreDirectory(directory);await syncRestoreDirectory(parent);await syncRestoreDirectory(info.recoveryDirectory)
  const saved:Saved={original,base:baseOwner,root:info.profileRoot,directory,manifest,bytes,manifestHash:manifestHash(manifest),created}
  await verifyBytes(saved)
  return Object.freeze({owner:mint(saved),manifest,manifestHash:saved.manifestHash,directory,observation})
}
export async function reopenWorkingOriginals5(original:OwnedRawCapsuleOriginal,base:PreparedCapsule2BaseProjection4,expectedManifestHash:string,expectedPointer?:WorkingOriginalsPointer5){
  assertCapsule2BaseProjectionOriginal4(base,original);const info=readOwnedRawCapsuleOriginal(original),directory=join(info.recoveryDirectory,'knowledge-complete-assets-v2',basename(info.capsuleDirectory),'contexts')
  const text=await readCapsule2AssetManifest(join(directory,'manifest.json'),info.profileRoot),manifest=parseWorkingOriginals5(text,expectedPointer)
  if(text!==capsuleJson(manifest)+'\n'||manifestHash(manifest)!==digest(expectedManifestHash))return fail('规范manifest/domain hash不符')
  const saved:Saved={original,base,root:info.profileRoot,directory,manifest,bytes:Buffer.from(text),manifestHash:expectedManifestHash}
  await rebuild(saved);return mint(saved)
}
export async function readWorkingOriginals5(owner:PreparedWorkingOriginals5){const saved=owners.get(owner);if(!saved)return fail('不是genuine automatic-W owner');return rebuild(saved)}
export async function assertWorkingOriginalBytes5(owner:PreparedWorkingOriginals5){const saved=owners.get(owner);if(!saved)return fail('不是genuine automatic-W owner');await verifyBytes(saved)}

/** Native source/transport seam: only this exact registered owner supplies
 * the full index, verified text and fixed physical members. No caller path or
 * descriptor DTO selects a working inventory. Ordinary material stays compact. */
export async function readWorkingOriginalsInventory5(owner:PreparedWorkingOriginals5){
 const saved=owners.get(owner);if(!saved)return fail('不是genuine working originals owner')
 const value=await rebuild(saved)
 return Object.freeze({manifest:value.manifest,manifestHash:value.manifestHash,pointer:describeWorkingOriginals5(value.manifest),directory:saved.directory,
  files:value.manifest.files.map(file=>({...file,sourcePath:join(saved.directory,'files',file.sha256),sourceRoot:saved.root})),observation:value.observation,records:value.records,baseCommitment:value.baseCommitment})
}
