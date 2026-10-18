import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import { assertConflictData } from './synced-exchange-conflict-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from './synced-publication-model'
import { validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot, type SyncedProtocol5Snapshot } from './synced-protocol5-model'
import { validateKnowledgeDeletionReference, type KnowledgeAuthority, type KnowledgeDeletionReference, type FixedDenial } from './synced-exchange-knowledge-model'
import type { ExchangeComponent, ExchangeDeferredReason, SyncedExchangeResult } from './synced-exchange-model'
import type { ExchangePlanIdentity } from './synced-exchange-plan'
import type { TombstoneExchangePlan, TombstoneExchangeState, TombstonePlanInput, TombstoneBaselineEntry } from './synced-exchange-tombstone-types'
import type { DeletionChoiceIntent } from './synced-logical-deletion-choice-model'

/** Closed data only. Runtime must mint these from its actual reader/capture; no DTO is a write grant. */
export type DeletionChoice = 'keep-live' | 'keep-delete'
export interface SyncedExchangeDeletionDecision { componentId: string; choice: DeletionChoice }
export interface DeletionChoiceResolution { previewId: string; previewHash: string; decisionsHash: string }
export interface DeletionChoiceRecordSource { key: string; baseHash: string | null; localHash: string | null; remoteHash: string | null }
export interface DeletionChoiceComponentFence extends ExchangeComponent {
  componentId: string; deletionKeys: string[]; fixedDenials: FixedDenial[]
}
export interface DeletionChoicePreviewComponent extends DeletionChoiceComponentFence {
  records: DeletionChoiceRecordSource[]; choices: DeletionChoice[]
  keepLiveReason: ExchangeDeferredReason | null; keepDeleteReason: ExchangeDeferredReason | null
}
export interface SyncedExchangeDeletionPreview {
  kind: 'synced-exchange-deletion-preview'; version: 1; previewId: string; previewHash: string
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string; targetFingerprint: string
  stateGeneration: string; remoteManifestHash: string; createdAt: string; components: DeletionChoicePreviewComponent[]
}
export interface SyncedExchangeDeletionPreviewInput { previewId: string; userDataRoot: string; target: WebDavSyncConfig }
export interface SyncedExchangeDeletionResolveInput {
  operationId: string; userDataRoot: string; target: WebDavSyncConfig; previewId: string; decisions: SyncedExchangeDeletionDecision[]
}
export type SyncedExchangeDeletionPreviewResult = { status: 'ready'; preview: SyncedExchangeDeletionPreview }
  | { status: 'missing' } | { status: 'unsupported'; reason: 'schema-27-required' | 'protocol5-required' }
  | { status: 'stale'; side: 'local' | 'remote' }
export type SyncedExchangeDeletionResolveResult = SyncedExchangeResult
export interface DeletionChoiceSnapshot {
  manifest: SyncedProtocol5Snapshot['manifest']; records: SyncedProtocol5Snapshot['records']
}
export interface DeletionChoiceRemoteSource { manifestHash: string; closureHash: string; etag: string }
export interface DeletionChoicePlanInput extends Omit<TombstonePlanInput, 'authority'> {
  authority: KnowledgeAuthority
  remoteSource: DeletionChoiceRemoteSource
  /** Exact immutable preview/source facts, not caller-supplied replacement records. */
  resolution: DeletionChoiceResolution | null
  selections?: Array<{ preview: DeletionChoicePreviewComponent; decision: SyncedExchangeDeletionDecision }>
}
export interface DeletionDecisionSource {
  domain: 'synced-exchange.deletion-decisions.v1'
  databasePath: string; targetFingerprint: string; workspaceScope: string; recoveryEpoch: string
  remoteWorkspaceId: string; state: TombstoneExchangeState
  localPhysical: DeletionChoiceSnapshot; localKnowledge: DeletionChoiceSnapshot; remote: DeletionChoiceSnapshot
  baseRecords: SyncedProtocol5Snapshot['records']; authority: KnowledgeAuthority
  localFingerprint: string; remoteSource: DeletionChoiceRemoteSource
  componentFences: DeletionChoiceComponentFence[]
  resolution: DeletionChoiceResolution | null; decisions: SyncedExchangeDeletionDecision[]
  /** Original private preview facts remain historical input even when today's component partition changes. */
  selections: Array<{ preview: DeletionChoicePreviewComponent; decision: SyncedExchangeDeletionDecision }>
}
export interface DeletionChoicePlan extends Omit<TombstoneExchangePlan, 'plannerVersion' | 'deletions'> {
  plannerVersion: 'delete-choices-v1'; deletions: DeletionChoiceIntent[]
  decisionSource: DeletionDecisionSource; decisionSourceHash: string
  componentFences: DeletionChoiceComponentFence[]; deletionPreviews: DeletionChoicePreviewComponent[]
}

const same = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b)
function shape(value: unknown, fields: string[], optional: string[] = []): asserts value is Record<string, unknown> { assertSyncedShape(value, fields, optional) }
function opaque(value: unknown): string { return isSyncedBlockId(value) ? value : publicationInvalid('删除决定稳定身份无效。') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : publicationInvalid('删除决定UUID无效。') }
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : publicationInvalid('删除决定hash无效。') }
function date(value: unknown): string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : publicationInvalid('删除决定日期无效。') }
function key(value: unknown): string {
  if (typeof value === 'string' && (value === 'databases' || value.startsWith('doc:') && isSyncedBlockId(value.slice(4)) || value.startsWith('group:') && isSyncedUuid(value.slice(6)))) return value
  return publicationInvalid('删除决定完整record key无效。')
}
function list<T>(value: unknown, read: (raw: unknown) => T): T[] { if (!Array.isArray(value)) return publicationInvalid('删除决定集合不是数组。'); return value.map(read) }
function ordered<T>(rows: T[], identity: (row: T) => string): T[] {
  if (rows.some((row, i) => i > 0 && publicationCompare(identity(rows[i - 1]), identity(row)) >= 0)) return publicationInvalid('删除决定集合不唯一或未排序。')
  return rows
}
const reasons: readonly ExchangeDeferredReason[] = ['diverged','incarnation','owner-source','unknown-birth','history-pin','catalog','path','dependency','tombstone','local-removal','baseline-missing']
function reason(value: unknown): ExchangeDeferredReason | null {
  if (value === null) return null
  if (typeof value === 'string' && reasons.includes(value as ExchangeDeferredReason)) return value as ExchangeDeferredReason
  return publicationInvalid('删除决定blocked原因未知。')
}
function component(value: unknown): ExchangeComponent {
  shape(value, ['keys','localSignature','remoteSignature','dependencySignature'])
  const keys = ordered(list(value.keys, key), row => row)
  if (!keys.length) return publicationInvalid('删除决定组件不能为空。')
  return {keys,localSignature:hash(value.localSignature),remoteSignature:hash(value.remoteSignature),dependencySignature:hash(value.dependencySignature)}
}
export function validateDeletionDecisions(value: unknown): SyncedExchangeDeletionDecision[] {
  assertConflictData(value)
  return ordered(list(value, raw => {
    shape(raw,['componentId','choice'])
    if (raw.choice !== 'keep-live' && raw.choice !== 'keep-delete') return publicationInvalid('删除决定只允许明确保live/保删除。')
    return {componentId:hash(raw.componentId),choice:raw.choice}
  }), row => row.componentId)
}
export function deletionDecisionsHash(value: unknown): string { return publicationHash(publicationJson(validateDeletionDecisions(value))) }
export function validateDeletionChoiceResolution(value: unknown): DeletionChoiceResolution | null {
  if (value === null) return null
  assertConflictData(value); shape(value,['previewId','previewHash','decisionsHash'])
  return {previewId:uuid(value.previewId),previewHash:hash(value.previewHash),decisionsHash:hash(value.decisionsHash)}
}
export function validateDeletionChoiceFence(value: unknown): DeletionChoiceComponentFence {
  assertConflictData(value); shape(value,['keys','localSignature','remoteSignature','dependencySignature','componentId','deletionKeys','fixedDenials'])
  const {componentId,deletionKeys,fixedDenials,...part}=value, checked=component(part)
  const deleted=ordered(list(deletionKeys,key),row=>row), fixed=ordered(list(fixedDenials, raw=>{
    shape(raw,['key','tombstoneHash','deletionOperationId','intentHash','proofHash','anchorId','baselineHash'])
    const {baselineHash,...reference}=raw
    return {...validateKnowledgeDeletionReference(reference),baselineHash:hash(baselineHash)}
  }),row=>row.key)
  if (deleted.some(row=>!checked.keys.includes(row)) || fixed.some(row=>!checked.keys.includes(row.key)) || fixed.some(row=>deleted.includes(row.key))) return publicationInvalid('删除决定组件/fixed/新删除keys不闭合。')
  return {...checked,componentId:hash(componentId),deletionKeys:deleted,fixedDenials:fixed}
}
export function validateDeletionChoicePreviewComponent(value: unknown): DeletionChoicePreviewComponent {
  assertConflictData(value); shape(value,['keys','localSignature','remoteSignature','dependencySignature','componentId','deletionKeys','fixedDenials','records','choices','keepLiveReason','keepDeleteReason'])
  const {records,choices,keepLiveReason,keepDeleteReason,...fence}=value, checked=validateDeletionChoiceFence(fence)
  const sources=ordered(list(records,raw=>{shape(raw,['key','baseHash','localHash','remoteHash']);return {key:key(raw.key),baseHash:raw.baseHash===null?null:hash(raw.baseHash),localHash:raw.localHash===null?null:hash(raw.localHash),remoteHash:raw.remoteHash===null?null:hash(raw.remoteHash)}}),row=>row.key)
  const live=reason(keepLiveReason), deletion=reason(keepDeleteReason), expected:DeletionChoice[]=[]
  if (live===null) expected.push('keep-live')
  if (deletion===null) expected.push('keep-delete')
  if (!same(sources.map(row=>row.key),checked.keys) || !same(choices,expected)) return publicationInvalid('删除预览records/eligible choices不闭合。')
  return {...checked,records:sources,choices:expected,keepLiveReason:live,keepDeleteReason:deletion}
}
export function validateDeletionChoicePreview(value: unknown): SyncedExchangeDeletionPreview {
  assertConflictData(value);shape(value,['kind','version','previewId','previewHash','workspaceScope','recoveryEpoch','remoteWorkspaceId','targetFingerprint','stateGeneration','remoteManifestHash','createdAt','components'])
  if(value.kind!=='synced-exchange-deletion-preview'||value.version!==1)return publicationInvalid('删除预览finite域不符。')
  return {kind:'synced-exchange-deletion-preview',version:1,previewId:uuid(value.previewId),previewHash:hash(value.previewHash),workspaceScope:uuid(value.workspaceScope),recoveryEpoch:uuid(value.recoveryEpoch),remoteWorkspaceId:uuid(value.remoteWorkspaceId),targetFingerprint:hash(value.targetFingerprint),stateGeneration:uuid(value.stateGeneration),remoteManifestHash:hash(value.remoteManifestHash),createdAt:date(value.createdAt),components:ordered(list(value.components,validateDeletionChoicePreviewComponent),row=>row.componentId)}
}
function baseline(value: unknown): TombstoneBaselineEntry {
  shape(value,['key','local','remoteHash','commonHash','dependencyKeys','dependencySignature','acceptedOperationId'])
  const raw=value.local
  if(raw===null||typeof raw!=='object')return publicationInvalid('删除决定baseline local缺失。')
  const kind=Object.getOwnPropertyDescriptor(raw,'kind')?.value
  shape(raw,kind==='live'?['kind','hash']:['kind','tombstoneHash','deletionOperationId','intentHash'])
  const local=kind==='live'?{kind:'live' as const,hash:hash(raw.hash)}:kind==='absent'?{kind:'absent' as const,tombstoneHash:hash(raw.tombstoneHash),deletionOperationId:uuid(raw.deletionOperationId),intentHash:hash(raw.intentHash)}:publicationInvalid('删除决定baseline local种类无效。')
  const recordKey=key(value.key), dependencyKeys=ordered(list(value.dependencyKeys,key),row=>row)
  if(dependencyKeys.includes(recordKey))return publicationInvalid('删除决定baseline自依赖。')
  return {key:recordKey,local,remoteHash:hash(value.remoteHash),commonHash:value.commonHash===null?null:hash(value.commonHash),dependencyKeys,dependencySignature:hash(value.dependencySignature),acceptedOperationId:uuid(value.acceptedOperationId)}
}
function state2(value: unknown): TombstoneExchangeState {
  shape(value,['kind','version','databasePath','targetFingerprint','workspaceScope','recoveryEpoch','remoteWorkspaceId','generation','currentOperationId','source','baseline','deferred','lastSyncAt'])
  if(value.kind!=='synced-exchange-state'||value.version!==2)return publicationInvalid('删除决定只接state2。')
  const source=value.source;shape(source,['kind','operationId','manifestHash','portableDigest'])
  if(source.kind!=='initial-receipt'&&source.kind!=='confirmed-publication'&&source.kind!=='current-equality')return publicationInvalid('删除决定seed种类无效。')
  const rows=ordered(list(value.baseline,baseline),row=>row.key), keys=new Set(rows.map(row=>row.key))
  if(rows.some(row=>row.dependencyKeys.some(id=>!keys.has(id))))return publicationInvalid('删除决定baseline缺旧依赖。')
  const deferred=list(value.deferred,raw=>{shape(raw,['keys','localSignature','remoteSignature','dependencySignature','reason']);const {reason:why,...body}=raw;const whyValue=reason(why);if(whyValue===null)return publicationInvalid('删除决定deferred缺reason。');return {...component(body),reason:whyValue}})
  return {kind:'synced-exchange-state',version:2,databasePath:opaque(value.databasePath),targetFingerprint:hash(value.targetFingerprint),workspaceScope:uuid(value.workspaceScope),recoveryEpoch:uuid(value.recoveryEpoch),remoteWorkspaceId:uuid(value.remoteWorkspaceId),generation:uuid(value.generation),currentOperationId:value.currentOperationId===null?null:uuid(value.currentOperationId),source:{kind:source.kind,operationId:source.operationId===null?null:uuid(source.operationId),manifestHash:hash(source.manifestHash),portableDigest:hash(source.portableDigest)},baseline:rows,deferred,lastSyncAt:date(value.lastSyncAt)}
}
function snapshot(value: unknown): DeletionChoiceSnapshot {
  shape(value,['manifest','records'])
  const records=list(value.records,raw=>{shape(raw,['key','hash','record']);const recordKey=key(raw.key),record=validateSyncedProtocol5Record(raw.record,recordKey);if(publicationHash(publicationJson(record))!==raw.hash)return publicationInvalid('删除决定snapshot原record/hash不符。');return {key:recordKey,hash:hash(raw.hash),record}})
  const result=validateSyncedProtocol5Snapshot(value.manifest,records.map(({key,record})=>({key,record})))
  if(!same(result.records,records))return publicationInvalid('删除决定snapshot原顺序/hash不符。')
  return {manifest:result.manifest,records:result.records}
}
function authority(value: unknown): KnowledgeAuthority {
  shape(value,['catalogId','identities','occupiedDocumentIds','historyComponents','pinnedGroupIds','deletedFacts','pins','deletionProofReferences'],['knownGroupIds','missingBaseKeys','deferredKeys','keyGuards'])
  const identities=list<ExchangePlanIdentity>(value.identities,raw=>{shape(raw,['id','last_owner_kind','last_owner_id','state','created_at']);if(raw.last_owner_kind!=='document'&&raw.last_owner_kind!=='group'&&raw.last_owner_kind!=='reserved'||raw.state!=='live'&&raw.state!=='retained')return publicationInvalid('删除决定identity种类无效。');return {id:opaque(raw.id),last_owner_kind:raw.last_owner_kind,last_owner_id:opaque(raw.last_owner_id),state:raw.state,created_at:raw.created_at===null?null:date(raw.created_at)}})
  if(new Set(identities.map(row=>row.id)).size!==identities.length)return publicationInvalid('删除决定identity重复。')
  const deletedFacts=list(value.deletedFacts,raw=>{shape(raw,['key','tombstoneHash','deletionOperationId','intentHash']);return {key:key(raw.key),tombstoneHash:hash(raw.tombstoneHash),deletionOperationId:uuid(raw.deletionOperationId),intentHash:hash(raw.intentHash)}})
  const deletionProofReferences=ordered(list(value.deletionProofReferences,validateKnowledgeDeletionReference),row=>row.key), refs=new Map(deletionProofReferences.map(row=>[row.key,row]))
  if(refs.size!==deletedFacts.length||deletedFacts.some(row=>{const ref=refs.get(row.key);return !ref||ref.tombstoneHash!==row.tombstoneHash||ref.deletionOperationId!==row.deletionOperationId||ref.intentHash!==row.intentHash}))return publicationInvalid('删除决定原proof/facts不闭合。')
  const pins=list(value.pins,raw=>{shape(raw,['groupId','kind','pinId','sourceHash']);if(typeof raw.kind!=='string'||!raw.kind.length)return publicationInvalid('删除决定pin kind无效。');return {groupId:uuid(raw.groupId),kind:raw.kind,pinId:opaque(raw.pinId),sourceHash:hash(raw.sourceHash)}})
  return {catalogId:opaque(value.catalogId),identities,occupiedDocumentIds:list(value.occupiedDocumentIds,opaque),historyComponents:list(value.historyComponents,row=>list(row,key)),pinnedGroupIds:list(value.pinnedGroupIds,uuid),deletedFacts,pins,deletionProofReferences,
    ...(value.knownGroupIds===undefined?{}:{knownGroupIds:list(value.knownGroupIds,uuid)}),...(value.missingBaseKeys===undefined?{}:{missingBaseKeys:list(value.missingBaseKeys,key)}),...(value.deferredKeys===undefined?{}:{deferredKeys:list(value.deferredKeys,key)}),...(value.keyGuards===undefined?{}:{keyGuards:list(value.keyGuards,raw=>{shape(raw,['key','fingerprint']);return {key:key(raw.key),fingerprint:hash(raw.fingerprint)}})})}
}
export function validateDeletionDecisionSource(value: unknown): DeletionDecisionSource {
  assertConflictData(value)
  shape(value,['domain','databasePath','targetFingerprint','workspaceScope','recoveryEpoch','remoteWorkspaceId','state','localPhysical','localKnowledge','remote','baseRecords','authority','localFingerprint','remoteSource','componentFences','resolution','decisions','selections'])
  if(value.domain!=='synced-exchange.deletion-decisions.v1')return publicationInvalid('删除决定历史原像域无效。')
  const state=state2(value.state), localPhysical=snapshot(value.localPhysical),localKnowledge=snapshot(value.localKnowledge),remote=snapshot(value.remote),auth=authority(value.authority)
  const remoteSource=value.remoteSource;shape(remoteSource,['manifestHash','closureHash','etag'])
  const checkedRemote={manifestHash:hash(remoteSource.manifestHash),closureHash:hash(remoteSource.closureHash),etag:opaque(remoteSource.etag)}
  const databasePath=opaque(value.databasePath),targetFingerprint=hash(value.targetFingerprint),workspaceScope=uuid(value.workspaceScope),recoveryEpoch=uuid(value.recoveryEpoch),remoteWorkspaceId=uuid(value.remoteWorkspaceId)
  if(state.databasePath!==databasePath||state.targetFingerprint!==targetFingerprint||state.workspaceScope!==workspaceScope||state.recoveryEpoch!==recoveryEpoch||state.remoteWorkspaceId!==remoteWorkspaceId||localPhysical.manifest.workspaceId!==workspaceScope||localKnowledge.manifest.workspaceId!==workspaceScope||remote.manifest.workspaceId!==remoteWorkspaceId||publicationHash(publicationJson(remote.manifest))!==checkedRemote.manifestHash)return publicationInvalid('删除决定历史path/scope/epoch/remote来源不闭合。')
  const baseByKey=new Map(state.baseline.map(row=>[row.key,row]))
  const baseRecords=ordered(list(value.baseRecords,raw=>{shape(raw,['key','hash','record']);const id=key(raw.key),record=validateSyncedProtocol5Record(raw.record,id),digest=hash(raw.hash),row=baseByKey.get(id);if(!row||digest!==(row.commonHash??row.remoteHash)||publicationHash(publicationJson(record))!==digest)return publicationInvalid('删除决定原B不属于准确基线。');return {key:id,hash:digest,record}}),row=>row.key)
  const componentFences=ordered(list(value.componentFences,validateDeletionChoiceFence),row=>row.componentId),used=new Set<string>()
  for(const fence of componentFences)for(const id of fence.keys){if(used.has(id))return publicationInvalid('删除决定组件重叠。');used.add(id)}
  const resolution=validateDeletionChoiceResolution(value.resolution),decisions=validateDeletionDecisions(value.decisions)
  if(resolution===null?decisions.length>0:deletionDecisionsHash(decisions)!==resolution.decisionsHash)return publicationInvalid('删除决定原preview/decision hash不符。')
  const selections=ordered(list(value.selections,raw=>{
    shape(raw,['preview','decision'])
    const preview=validateDeletionChoicePreviewComponent(raw.preview),decision=validateDeletionDecisions([raw.decision])[0]
    if(preview.componentId!==decision.componentId||!preview.deletionKeys.length||!preview.choices.includes(decision.choice))return publicationInvalid('删除决定原private preview本身没有该可执行选择。')
    return {preview,decision}
  }),row=>row.decision.componentId)
  const originalKeys=new Set<string>()
  for(const row of selections)for(const id of row.preview.keys){if(originalKeys.has(id))return publicationInvalid('删除决定原preview组件互相重叠。');originalKeys.add(id)}
  if([...originalKeys].some(id=>!used.has(id)))return publicationInvalid('删除决定原preview含当前完整知识图未知key；必须重新预览。')
  if(!same(selections.map(row=>row.decision),decisions))return publicationInvalid('删除决定required原selections与request决定不闭合。')
  return {domain:'synced-exchange.deletion-decisions.v1',databasePath,targetFingerprint,workspaceScope,recoveryEpoch,remoteWorkspaceId,state,localPhysical,localKnowledge,remote,baseRecords,authority:auth,localFingerprint:hash(value.localFingerprint),remoteSource:checkedRemote,componentFences,resolution,decisions,selections}
}
export function deletionDecisionSourceHash(value: DeletionDecisionSource): string { return publicationHash(publicationJson(validateDeletionDecisionSource(value))) }
