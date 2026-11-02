// Compact observer3 commitments; full Working5 scopes remain private read data.
import {capsuleBytesHash,capsuleJson,capsuleRecord,freezeCapsuleValue} from './restore-knowledge-capsule-model'
import type {createRoot5WorkingScopeObserver5} from './restore-knowledge-assets5-working-scopes'
type Observation=ReturnType<ReturnType<typeof createRoot5WorkingScopeObserver5>['finish']>
export interface Capsule5AssetScopeSupplementDescriptor5 {
 readonly version:3;readonly observerVersion:3;readonly scope:'all-original-merge-working-records'
 readonly sourceContentHash:string;readonly observationHash:string;readonly baseManifestHash:string;readonly workingEvidenceHash:string
 readonly scopeCount:number;readonly referenceCount:number;readonly referenceUris:readonly string[]
 readonly unsupportedHolders:{readonly count:number;readonly hash:string}
 readonly scopeBindingsHash:string;readonly pendingPortableBindingsHash:string;readonly settledPortableBindingsHash:string
}
const fail=(reason:string):never=>{throw new Error('working5 supplemental descriptor: '+reason)}
const hash=(domain:string,value:unknown)=>capsuleBytesHash(domain+'\0'+capsuleJson(value))
const digest=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail('hash无效')
const integer=(value:unknown):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:fail('计数无效')
export function describeCapsule5AssetScopeSupplement5(value:Observation):Capsule5AssetScopeSupplementDescriptor5 {
 const referenceCount=value.scopes.reduce((n,scope)=>n+scope.destinations.length,0);if(!Number.isSafeInteger(referenceCount))return fail('引用总数越界')
 return freezeCapsuleValue({version:3,observerVersion:3,scope:'all-original-merge-working-records',sourceContentHash:value.sourceContentHash,observationHash:value.observationHash,
  baseManifestHash:value.baseManifestHash,workingEvidenceHash:value.workingEvidenceHash,scopeCount:value.scopes.length,referenceCount,
  referenceUris:[...new Set(value.scopes.flatMap(scope=>scope.destinations.map(item=>item.uri)))].sort(),
  unsupportedHolders:{count:value.unsupportedHolders.length,hash:hash('knowbook.capsule5.working-unsupported.v1',value.unsupportedHolders)},
  scopeBindingsHash:hash('knowbook.capsule5.working-scope-bindings.v1',value.scopes.map(scope=>({source:scope.source,family:scope.family,jobSettingKey:scope.jobSettingKey,jobHash:scope.jobHash,
   contextHash:scope.contextHash,recordKey:scope.recordKey,resultHash:scope.resultHash,evidenceKind:scope.evidenceKind}))),
  pendingPortableBindingsHash:hash('knowbook.capsule5.pending-portable-bindings.v1',value.pendingPortableBindings),
  settledPortableBindingsHash:hash('knowbook.capsule5.settled-portable-bindings.v1',value.settledPortableBindings)})
}
export function validateCapsule5AssetScopeSupplement5(value:unknown):Capsule5AssetScopeSupplementDescriptor5 {
 const row=capsuleRecord(value,['version','observerVersion','scope','sourceContentHash','observationHash','baseManifestHash','workingEvidenceHash','scopeCount','referenceCount','referenceUris',
  'unsupportedHolders','scopeBindingsHash','pendingPortableBindingsHash','settledPortableBindingsHash'])
 if(row.version!==3||row.observerVersion!==3||row.scope!=='all-original-merge-working-records'||!Array.isArray(row.referenceUris))return fail('未知版本/scope')
 const referenceCount=integer(row.referenceCount),referenceUris=row.referenceUris.map(uri=>typeof uri==='string'?uri:fail('URI不是TEXT'))
 if(referenceUris.length>referenceCount||referenceCount>0&&referenceUris.length===0||referenceUris.some((uri,i)=>i>0&&referenceUris[i-1]>=uri))return fail('URI集合不闭合')
 const unsupported=capsuleRecord(row.unsupportedHolders,['count','hash'])
 return freezeCapsuleValue({version:3,observerVersion:3,scope:'all-original-merge-working-records',sourceContentHash:digest(row.sourceContentHash),observationHash:digest(row.observationHash),
  baseManifestHash:digest(row.baseManifestHash),workingEvidenceHash:digest(row.workingEvidenceHash),scopeCount:integer(row.scopeCount),referenceCount,referenceUris,
  unsupportedHolders:{count:integer(unsupported.count),hash:digest(unsupported.hash)},scopeBindingsHash:digest(row.scopeBindingsHash),
  pendingPortableBindingsHash:digest(row.pendingPortableBindingsHash),settledPortableBindingsHash:digest(row.settledPortableBindingsHash)})
}
export const capsule5CombinedAssetUris5=(base:readonly string[],supplement:Capsule5AssetScopeSupplementDescriptor5)=>[...new Set([...base,...supplement.referenceUris])].sort()
