import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import type { SyncedGroupWire, SyncedGroupDeletedWire } from '../../shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../../shared/syncedBlockPortable'
import type { SyncDeletion } from './model'
import type { SyncedLogicalDeletionProof } from './synced-logical-deletion-model'
import type { TombstoneIdentityEffect, TombstoneProofReference } from './synced-exchange-tombstone-types'
import { assertConflictData } from './synced-exchange-conflict-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from './synced-publication-model'
import { validateSyncedProtocol5Record } from './synced-protocol5-model'

export interface DeletionChoiceProofBinding {
  previewId: string; previewHash: string; decisionsHash: string; decisionSourceHash: string
  componentId: string; choice: 'keep-delete'
}
export interface DeletionChoiceIntent {
  kind: 'document' | 'group'; key: string
  /** Accurate remote predecessor B; never relabel the changed L as this record. */
  base: SyncedPortableHostRecord | SyncedGroupWire; baseLiveHash: string
  /** Actual physical live L explicitly accepted for removal. */
  before: SyncedPortableHostRecord | SyncedGroupWire; localBeforeHash: string
  tombstoneHash: string; identities: TombstoneIdentityEffect[]; decision: DeletionChoiceProofBinding; intentHash: string
}
export interface SyncedLogicalDeletionChoiceProof extends Omit<SyncedLogicalDeletionProof, 'version' | 'baseLiveHash'> {
  version: 2; base: SyncedPortableHostRecord | SyncedGroupWire; baseLiveHash: string
  localBeforeHash: string; decision: DeletionChoiceProofBinding
}
const same=(a:unknown,b:unknown):boolean=>publicationJson(a)===publicationJson(b)
function shape(v:unknown,fields:string[]):asserts v is Record<string,unknown>{assertSyncedShape(v,fields)}
function opaque(v:unknown):string{return isSyncedBlockId(v)?v:publicationInvalid('删除选择证明稳定身份无效。')}
function uuid(v:unknown):string{return isSyncedUuid(v)?v:publicationInvalid('删除选择证明UUID无效。')}
function hash(v:unknown):string{return typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:publicationInvalid('删除选择证明hash无效。')}
function date(v:unknown):string{return typeof v==='string'&&Number.isFinite(Date.parse(v))?v:publicationInvalid('删除选择证明时间无效。')}
function integer(v:unknown):number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:publicationInvalid('删除选择证明历史位置无效。')}
function key(v:unknown):string{if(typeof v==='string'&&(v.startsWith('doc:')&&isSyncedBlockId(v.slice(4))||v.startsWith('group:')&&isSyncedUuid(v.slice(6))))return v;return publicationInvalid('删除选择证明key不是doc/group。')}
export function validateDeletionChoiceProofBinding(value:unknown):DeletionChoiceProofBinding {
  assertConflictData(value);shape(value,['previewId','previewHash','decisionsHash','decisionSourceHash','componentId','choice'])
  if(value.choice!=='keep-delete')return publicationInvalid('永久删除首证只能来自明确保删除选择。')
  return {previewId:uuid(value.previewId),previewHash:hash(value.previewHash),decisionsHash:hash(value.decisionsHash),decisionSourceHash:hash(value.decisionSourceHash),componentId:hash(value.componentId),choice:'keep-delete'}
}
function identityEffect(value:unknown):TombstoneIdentityEffect {
  shape(value,['before','after']);shape(value.before,['id','last_owner_kind','last_owner_id','state','created_at'])
  const raw=value.before
  if(raw.state!=='live'||raw.last_owner_kind!=='document'&&raw.last_owner_kind!=='group')return publicationInvalid('删除选择identity不是实际live。')
  const ownerKind=raw.last_owner_kind,ownerId=ownerKind==='group'?uuid(raw.last_owner_id):opaque(raw.last_owner_id)
  const before:TombstoneIdentityEffect['before']={id:opaque(raw.id),last_owner_kind:ownerKind,last_owner_id:ownerId,state:'live',created_at:date(raw.created_at)}
  const next=value.after,tag=next!==null&&typeof next==='object'?Object.getOwnPropertyDescriptor(next,'kind')?.value:null
  shape(next,tag==='transferred'?['kind','ownerKind','ownerId','createdAt']:['kind'])
  if(next.kind==='retained')return {before,after:{kind:'retained'}}
  if(next.kind!=='transferred'||next.ownerKind!=='document'&&next.ownerKind!=='group')return publicationInvalid('删除选择identity后果无效。')
  return {before,after:{kind:'transferred',ownerKind:next.ownerKind,ownerId:next.ownerKind==='group'?uuid(next.ownerId):opaque(next.ownerId),createdAt:date(next.createdAt)}}
}
function livePair(base:SyncedPortableHostRecord|SyncedGroupWire,before:SyncedPortableHostRecord|SyncedGroupWire):boolean {
  if(base.kind!==before.kind||base.id!==before.id)return false
  if(base.kind==='synced-group')return before.kind==='synced-group'&&same([base.creationId,base.createdAt,base.origin],[before.creationId,before.createdAt,before.origin])
  return before.kind==='document'&&base.createdAt===before.createdAt
}
export function validateDeletionChoiceIntent(value:unknown):DeletionChoiceIntent {
  assertConflictData(value);shape(value,['kind','key','base','baseLiveHash','before','localBeforeHash','tombstoneHash','identities','decision','intentHash'])
  const id=key(value.key),base=validateSyncedProtocol5Record(value.base,id),before=validateSyncedProtocol5Record(value.before,id)
  if((base.kind!=='document'&&base.kind!=='synced-group')||(before.kind!=='document'&&before.kind!=='synced-group')||!livePair(base,before)||value.kind!==(before.kind==='document'?'document':'group'))return publicationInvalid('删除选择B/L不是同一真实doc/incarnation。')
  const baseLiveHash=hash(value.baseLiveHash),localBeforeHash=hash(value.localBeforeHash)
  if(publicationHash(publicationJson(base))!==baseLiveHash||publicationHash(publicationJson(before))!==localBeforeHash)return publicationInvalid('删除选择真实B和当前L双hash不符。')
  if(!Array.isArray(value.identities))return publicationInvalid('删除选择identity不是闭集。')
  const identities=value.identities.map(identityEffect)
  if(identities.some((row,i)=>i>0&&publicationCompare(identities[i-1].before.id,row.before.id)>=0))return publicationInvalid('删除选择identity未唯一排序。')
  const blocks=before.kind==='document'?before.content.blocks:before.blocks,index=new Map(identities.map(row=>[row.before.id,row])),births=new Map(before.kind==='synced-group'?before.blocks.map(row=>[row.id,row.createdAt]):[])
  if(index.size!==blocks.length)return publicationInvalid('删除选择identity没有完整覆盖实际当前L。')
  for(const block of blocks){const effect=index.get(block.id)
    if(!effect||effect.before.last_owner_kind!==(before.kind==='document'?'document':'group')||effect.before.last_owner_id!==before.id||before.kind==='synced-group'&&effect.before.created_at!==births.get(block.id))return publicationInvalid('删除选择identity owner/birth不是实际L。')
    if(effect.after.kind==='transferred'&&effect.after.ownerKind===effect.before.last_owner_kind&&effect.after.ownerId===effect.before.last_owner_id)return publicationInvalid('删除来源不可又作为转域目的。')
  }
  return {kind:before.kind==='document'?'document':'group',key:id,base,baseLiveHash,before,localBeforeHash,tombstoneHash:hash(value.tombstoneHash),identities,decision:validateDeletionChoiceProofBinding(value.decision),intentHash:hash(value.intentHash)}
}
export function logicalDeletionChoiceIntentHash(intent:Omit<DeletionChoiceIntent,'intentHash'>,source:{operationId:string;workspaceScope:string;recoveryEpoch:string;targetFingerprint:string;remoteWorkspaceId:string}):string {
  return publicationHash(publicationJson({domain:'synced-deletion-intent.v2',...source,...intent}))
}
export function logicalDeletionChoiceAnchorId(before:SyncedPortableHostRecord|SyncedGroupWire):string {
  const prefix='synced:logical-deletion:v1:'
  return before.kind==='document'?prefix+'doc:'+publicationJson(opaque(before.id)):prefix+'group:'+uuid(before.id)+':'+uuid(before.creationId)
}
/** Read-only finite data validation; no DB, opaque source, permit or proof minting authority. */
export function validateSyncedLogicalDeletionChoiceProof(value:unknown):SyncedLogicalDeletionChoiceProof {
  assertConflictData(value)
  shape(value,['kind','version','key','intentHash','base','baseLiveHash','localBeforeHash','tombstoneHash','deletion','before','identities','decision','localBefore','localAfter','source','scopeAtApply','application','persistence'])
  if(value.kind!=='synced-logical-deletion-proof'||value.version!==2)return publicationInvalid('删除选择证明finite版本无效。')
  const candidate=validateDeletionChoiceIntent({kind:(value.before as Record<string,unknown>)?.kind==='document'?'document':'group',key:value.key,base:value.base,baseLiveHash:value.baseLiveHash,before:value.before,localBeforeHash:value.localBeforeHash,tombstoneHash:value.tombstoneHash,identities:value.identities,decision:value.decision,intentHash:value.intentHash})
  const deletion=validateSyncedProtocol5Record(value.deletion,candidate.key)
  if(deletion.kind!=='deleted'&&deletion.kind!=='synced-group-deleted'||(candidate.before.kind==='document')!==(deletion.kind==='deleted')||publicationHash(publicationJson(deletion))!==candidate.tombstoneHash)return publicationInvalid('删除选择首证没有原准确remote墓碑。')
  if(deletion.kind==='synced-group-deleted'&&(candidate.base.kind!=='synced-group'||deletion.creationId!==candidate.base.creationId||deletion.previousHash!==candidate.baseLiveHash))return publicationInvalid('删除选择墓碑previousHash不属于真实B。')
  let localBefore:SyncedLogicalDeletionProof['localBefore'],localAfter:SyncedLogicalDeletionProof['localAfter']
  const before=candidate.before,old=value.localBefore,next=value.localAfter
  if(before.kind==='document'){
    shape(old,['kind','documentId','createdAt','path','updatedAt','keyGuard']);shape(next,['kind','documentId'])
    if(old.kind!=='document'||next.kind!=='document'||old.documentId!==before.id||next.documentId!==before.id||old.createdAt!==before.createdAt||typeof old.path!=='string')return publicationInvalid('删除选择文档实际birth/path不符。')
    localBefore={kind:'document',documentId:before.id,createdAt:date(old.createdAt),path:old.path,updatedAt:date(old.updatedAt),keyGuard:hash(old.keyGuard)}
    localAfter={kind:'document',documentId:before.id}
  }else{
    shape(old,['kind','groupId','creationId','createdAt','origin','revision','topologyRevision','historyCursor','historyPosition','semanticHash','keyGuard']);shape(next,['kind','groupId','revision','topologyRevision','historyCursor','historyPosition'])
    if(old.kind!=='group'||next.kind!=='group'||old.groupId!==before.id||next.groupId!==before.id||old.creationId!==before.creationId||old.createdAt!==before.createdAt||!same(old.origin,before.origin)||next.historyPosition!==0)return publicationInvalid('删除选择组实际tuple不符。')
    localBefore={kind:'group',groupId:before.id,creationId:before.creationId,createdAt:before.createdAt,origin:before.origin,revision:uuid(old.revision),topologyRevision:uuid(old.topologyRevision),historyCursor:uuid(old.historyCursor),historyPosition:integer(old.historyPosition),semanticHash:hash(old.semanticHash),keyGuard:hash(old.keyGuard)}
    localAfter={kind:'group',groupId:before.id,revision:uuid(next.revision),topologyRevision:uuid(next.topologyRevision),historyCursor:uuid(next.historyCursor),historyPosition:0}
    if(localAfter.revision===localBefore.revision||localAfter.topologyRevision===localBefore.topologyRevision||localAfter.historyCursor===localBefore.historyCursor)return publicationInvalid('删除选择组缺fresh本机CAS/history屏障。')
  }
  const rawSource=value.source,rawScope=value.scopeAtApply,rawApplication=value.application,rawPersistence=value.persistence
  shape(rawSource,['targetFingerprint','workspaceId','manifestHash','closureHash']);shape(rawScope,['workspaceScope','recoveryEpoch']);shape(rawApplication,['operationId','requestHash','acceptedAt']);shape(rawPersistence,['kind','anchorId'])
  const source={targetFingerprint:hash(rawSource.targetFingerprint),workspaceId:uuid(rawSource.workspaceId),manifestHash:hash(rawSource.manifestHash),closureHash:hash(rawSource.closureHash)}
  const scopeAtApply={workspaceScope:uuid(rawScope.workspaceScope),recoveryEpoch:uuid(rawScope.recoveryEpoch)},application={operationId:uuid(rawApplication.operationId),requestHash:hash(rawApplication.requestHash),acceptedAt:date(rawApplication.acceptedAt)}
  const anchorId=logicalDeletionChoiceAnchorId(before)
  if(rawPersistence.kind!=='logical-deletion-denial'||rawPersistence.anchorId!==anchorId)return publicationInvalid('删除选择锚域不是准确永久身份。')
  const {intentHash,...intent}=candidate
  if(logicalDeletionChoiceIntentHash(intent,{operationId:application.operationId,...scopeAtApply,targetFingerprint:source.targetFingerprint,remoteWorkspaceId:source.workspaceId})!==intentHash)return publicationInvalid('删除选择首证intentHash不闭合。')
  return {kind:'synced-logical-deletion-proof',version:2,key:candidate.key,intentHash,base:candidate.base,baseLiveHash:candidate.baseLiveHash,localBeforeHash:candidate.localBeforeHash,tombstoneHash:candidate.tombstoneHash,deletion,before,identities:candidate.identities,decision:candidate.decision,localBefore,localAfter,source,scopeAtApply,application,persistence:{kind:'logical-deletion-denial',anchorId}}
}
export function logicalDeletionChoiceRequestHash(proof:SyncedLogicalDeletionChoiceProof):string{return publicationHash(publicationJson({domain:'synced.logical-deletion.apply.v2',proof}))}
export function logicalDeletionChoiceProofReference(proof:SyncedLogicalDeletionChoiceProof):TombstoneProofReference{return {key:proof.key,intentHash:proof.intentHash,proofHash:publicationHash(publicationJson(proof)),anchorId:proof.persistence.anchorId}}
