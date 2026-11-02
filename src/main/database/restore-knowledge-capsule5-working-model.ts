// Pure Working5 grammar only. Parsing never authorizes paths or mints owners.
import {parseStrictJson} from '../../shared/strictJson'
import {capsuleBytesHash,capsuleJson,capsuleRecord,freezeCapsuleValue} from './restore-knowledge-capsule-model'
import {CAPSULE2_RAW_MAX_JSON_BYTES} from './restore-knowledge-capsule2-raw-model'
import {DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES} from './restore-knowledge-dag-model'
import {validateCapsule2BaseProjectionPointer4,type Capsule2BaseProjectionPointer4} from './restore-knowledge-capsule2-base-projection4'
import {validateCapsule2MergeContextInventory4} from './restore-knowledge-capsule2-merge-contexts4'
import type {Capsule2MergeContextCapture3} from './restore-knowledge-capsule2-merge-contexts'
const fail=(reason:string):never=>{throw new Error('working5 model: '+reason)}
const hash=(domain:string,value:unknown)=>capsuleBytesHash(domain+'\0'+capsuleJson(value))
const digest=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail('hash无效')
const number=(value:unknown):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:fail('有限计数无效')
export interface SettledBinding {readonly jobSettingKey:string;readonly sourceRowId:string;readonly originalRowHash:string;readonly locatorHash:string;readonly contextHash:string;readonly bindingHash:string}
export interface WorkingOriginalsManifest5 {
  readonly kind:'capsule5-merge-working-originals';readonly version:1;readonly scope:'all-original-merge-working-records'
  readonly families:readonly [2,3,4,5,6,7];readonly sourceContentHash:string;readonly baseProjection:Capsule2BaseProjectionPointer4;readonly workingEvidenceHash:string
  readonly settledBindings:readonly SettledBinding[];readonly captures:readonly Capsule2MergeContextCapture3[]
  readonly files:readonly {readonly sha256:string;readonly bytes:number}[]
  readonly observation:{readonly hash:string;readonly scopeCount:number;readonly unsupportedHolders:number;readonly pendingBindings:number;readonly settledPortableBindings:number}
  readonly allAssetScopesCaptured:false;readonly otherHeldPayloadScopesComplete:false;readonly acceptedCoverage:false;readonly effective:false;readonly installPermit:false
}
export function validateWorkingOriginalsManifest5(value:unknown):WorkingOriginalsManifest5 {
  const row=capsuleRecord(value,['kind','version','scope','families','sourceContentHash','baseProjection','workingEvidenceHash','settledBindings','captures','files','observation',
    'allAssetScopesCaptured','otherHeldPayloadScopesComplete','acceptedCoverage','effective','installPermit'])
  if(row.kind!=='capsule5-merge-working-originals'||row.version!==1||row.scope!=='all-original-merge-working-records'||capsuleJson(row.families)!==capsuleJson([2,3,4,5,6,7])||row.allAssetScopesCaptured!==false
    ||row.otherHeldPayloadScopesComplete!==false||row.acceptedCoverage!==false||row.effective!==false||row.installPermit!==false)return fail('格式或权限提升')
  const baseProjection=validateCapsule2BaseProjectionPointer4(row.baseProjection)
  const grammar={kind:'capsule2-source-merge-context-originals',version:3,sourceContentHash:row.sourceContentHash,baseManifestHash:baseProjection.baseManifestHash,
    settledEvidenceHash:row.workingEvidenceHash,settledBindings:row.settledBindings,captures:row.captures,files:row.files,certified:false,semanticValidationComplete:false,permit:false}
  const validated=validateCapsule2MergeContextInventory4({...grammar,inventoryHash:hash('knowbook.capsule4.source-merge-context-inventory.v3',grammar)})
  const observed=capsuleRecord(row.observation,['hash','scopeCount','unsupportedHolders','pendingBindings','settledPortableBindings'])
  return freezeCapsuleValue({kind:row.kind,version:1,scope:row.scope,families:[2,3,4,5,6,7] as const,sourceContentHash:validated.sourceContentHash,baseProjection,workingEvidenceHash:validated.settledEvidenceHash,
    settledBindings:validated.settledBindings,captures:validated.captures,files:validated.files,observation:{hash:digest(observed.hash),scopeCount:number(observed.scopeCount),
      unsupportedHolders:number(observed.unsupportedHolders),pendingBindings:number(observed.pendingBindings),settledPortableBindings:number(observed.settledPortableBindings)},
    allAssetScopesCaptured:false,otherHeldPayloadScopesComplete:false,acceptedCoverage:false,effective:false,installPermit:false})
}

export interface WorkingOriginalsPointer5 {
 readonly version:1;readonly manifestHash:string;readonly manifestFile:{readonly bytes:number;readonly sha256:string}
 readonly originalFileBytes:number;readonly fileCount:number;readonly filesHash:string
}
export const workingOriginalsManifestHash5=(value:WorkingOriginalsManifest5)=>hash('knowbook.capsule5.merge-working-originals.v1',value)
export function describeWorkingOriginals5(value:WorkingOriginalsManifest5):WorkingOriginalsPointer5{
 const text=capsuleJson(value)+'\n',originalFileBytes=value.files.reduce((n,file)=>n+file.bytes,0)
 if(Buffer.byteLength(text)>CAPSULE2_RAW_MAX_JSON_BYTES||!Number.isSafeInteger(originalFileBytes)||originalFileBytes>DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES)return fail('完整working原件预算无效')
 return freezeCapsuleValue({version:1,manifestHash:workingOriginalsManifestHash5(value),manifestFile:{bytes:Buffer.byteLength(text),sha256:capsuleBytesHash(text)},
  originalFileBytes,fileCount:value.files.length,filesHash:hash('knowbook.capsule5.working-file-index.v1',value.files)})
}
export function validateWorkingOriginalsPointer5(value:unknown):WorkingOriginalsPointer5{
 const row=capsuleRecord(value,['version','manifestHash','manifestFile','originalFileBytes','fileCount','filesHash']),file=capsuleRecord(row.manifestFile,['bytes','sha256'])
 const bytes=number(file.bytes),originalFileBytes=number(row.originalFileBytes),fileCount=number(row.fileCount)
 if(row.version!==1||bytes>CAPSULE2_RAW_MAX_JSON_BYTES||originalFileBytes>DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES||fileCount===0&&originalFileBytes!==0)return fail('compact working pointer版本/预算不符')
 return freezeCapsuleValue({version:1,manifestHash:digest(row.manifestHash),manifestFile:{bytes,sha256:digest(file.sha256)},originalFileBytes,fileCount,filesHash:digest(row.filesHash)})
}
export function parseWorkingOriginals5(text:string,expectedPointer?:WorkingOriginalsPointer5):WorkingOriginalsManifest5{
 const value=validateWorkingOriginalsManifest5(parseStrictJson(text,{maxBytes:CAPSULE2_RAW_MAX_JSON_BYTES,maxDepth:12}))
 if(text!==capsuleJson(value)+'\n')return fail('不是完整规范working原字节')
 if(expectedPointer&&capsuleJson(describeWorkingOriginals5(value))!==capsuleJson(validateWorkingOriginalsPointer5(expectedPointer)))return fail('实际working原件的raw SHA/bytes/domain/index不属于compact pointer')
 return value
}
