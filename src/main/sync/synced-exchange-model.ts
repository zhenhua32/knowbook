import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson, PUBLICATION_RECORD_MAX_BYTES,
  type PublicationAssetDescriptor, type PublicationObjectDescriptor } from './synced-publication-model'
import { validateConflictDecisions, validateExchangeResolutionBinding, validateExchangeMerges,
  type SyncedExchangeConflictDecision, type ExchangeResolutionBinding, type ExchangeMergeProvenance } from './synced-exchange-conflict-model'
import * as B from './synced-exchange-both-model'
import type { SyncedExchangeBothForkSummary, SyncedExchangeBothPublishedBlock, SyncedBothForkProof } from './synced-exchange-both-types'
import type { TombstoneAcceptedSide, TombstoneBaselineEntry, TombstoneDeletionIntent, TombstoneExchangeState,
  TombstoneIdentityEffect, TombstoneLocalOutcome, TombstoneProofReference } from './synced-exchange-tombstone-types'
import { validateSyncedProtocol5Record } from './synced-protocol5-model'
import { validateKnowledgeSource, knowledgeSourceHash, type KnowledgeSource } from './synced-exchange-knowledge-model'
import * as DC from './synced-exchange-deletion-choice-model'
import { planSyncedDeletionChoicesFromSource } from './synced-exchange-deletion-choice-plan'
import { validateDeletionChoiceIntent, logicalDeletionChoiceIntentHash, type DeletionChoiceIntent } from './synced-logical-deletion-choice-model'

export type ExchangeHash = string
export type ExchangeDeferredReason = 'diverged' | 'incarnation' | 'owner-source' | 'unknown-birth' | 'history-pin'
  | 'catalog' | 'path' | 'dependency' | 'tombstone' | 'local-removal' | 'baseline-missing'
export interface ExchangeComponent {
  keys: string[]; localSignature: string; remoteSignature: string; dependencySignature: string
}
export interface DeferredExchangeComponent extends ExchangeComponent { reason: ExchangeDeferredReason }
export interface ExchangeBaselineEntry {
  key: string; localHash: string | null; remoteHash: string; commonHash: string | null
  dependencyKeys: string[]; dependencySignature: string; acceptedOperationId: string
}
export interface ExchangeSeedProof {
  kind: 'initial-receipt' | 'confirmed-publication' | 'current-equality'
  operationId: string | null; manifestHash: string; portableDigest: string
}
export interface ExchangeState {
  kind: 'synced-exchange-state'; version: 1; databasePath: string; targetFingerprint: string
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string; generation: string; currentOperationId: string | null
  source: ExchangeSeedProof; baseline: ExchangeBaselineEntry[]; deferred: DeferredExchangeComponent[]; lastSyncAt: string
}
export interface ExchangeRequestV1 {
  method: 'exchangeSyncedSnapshot'; operationId: string; databasePath: string; targetFingerprint: string
}
export interface ExchangeResolveRequest {
  method: 'resolveSyncedExchangeConflicts'; operationId: string; databasePath: string; targetFingerprint: string
  previewId: string; decisions: SyncedExchangeConflictDecision[]
}
export interface ExchangeDeletionRequest extends Omit<ExchangeResolveRequest, 'method' | 'decisions'> {
  method: 'resolveSyncedExchangeDeletions'; decisions: DC.SyncedExchangeDeletionDecision[]
}
export type ExchangeRequest = ExchangeRequestV1 | ExchangeResolveRequest | B.BothRequest | ExchangeDeletionRequest
export interface SyncedExchangeAccepted {
  status: 'applied' | 'noop' | 'deferred'; operationId: string; replayed: boolean
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string
  beforeManifestHash: string; afterManifestHash: string; publishedKeys: string[]; appliedKeys: string[]; acceptedKeys: string[]
  deferred: DeferredExchangeComponent[]; acceptedAt: string
  forks?: SyncedExchangeBothForkSummary[]
}
export type SyncedExchangeResult = SyncedExchangeAccepted | { status: 'missing' }
  | { status: 'unsupported'; reason: 'schema-27-required' | 'protocol5-required' }
  | { status: 'stale'; side: 'local' | 'remote' }
export interface ExchangeTransfer {
  id: string; fromKind: 'document' | 'group'; fromId: string; fromCreatedAt: string
  toKind: 'document' | 'group'; toId: string; toCreatedAt: string
}
export interface ExchangeAcceptedSide {
  key: string; beforeLocalHash: string | null; beforeRemoteHash: string | null; afterHash: string
  dependencyKeys: string[]; dependencySignature: string
}
export interface ExchangeProvenance {
  beforeManifestHash: string; afterManifestHash: string; beforeManifestEtag: string; afterManifestEtag: string | null
  planHash: string; source: ExchangeSeedProof; accepted: ExchangeAcceptedSide[]; transfers: ExchangeTransfer[]
  afterStateHash: string; historyArchives: Array<{ groupId: string; indexHash: string }>
  hostHistoryCuts: Array<{ historyToken: string; cutHash: string }>
  plannerVersion?: 'conflicts-v1' | 'forks-v1'; resolution?: ExchangeResolutionBinding | B.BothResolution | null; merges?: ExchangeMergeProvenance[]; attemptId?: string
  forks?: SyncedBothForkProof[]
}
export interface ExchangeHostCut {
  kind: 'synced-exchange-host-cut'; version: 1; operationId: string; historyToken: string; journalHash: string
  participants: Array<{ documentId: string; position: number }>; cutAt: string
}
export interface LegacyExchangeReceipt {
  kind: 'synced-exchange-operation'; version: 1 | 2 | 3; request: ExchangeRequest; result: SyncedExchangeAccepted; provenance: ExchangeProvenance
}
export interface TombstoneExchangeReceipt {
  kind: 'synced-exchange-operation'; version: 4; request: ExchangeRequestV1; result: SyncedExchangeAccepted
  provenance: Omit<ExchangeProvenance, 'accepted' | 'plannerVersion' | 'resolution' | 'forks'> & {
    plannerVersion: 'tombstones-v1'; accepted: TombstoneAcceptedSide[]; deletions: TombstoneProofReference[]; attemptId: string; merges: ExchangeMergeProvenance[]
    resolution?: never; forks?: never
  }
}
export interface KnowledgeConflictReceipt {
  kind: 'synced-exchange-operation'; version: 5; request: ExchangeResolveRequest; result: SyncedExchangeAccepted
  provenance: Omit<TombstoneExchangeReceipt['provenance'], 'plannerVersion' | 'deletions' | 'resolution' | 'forks'> & {
    plannerVersion: 'knowledge-conflicts-v1'; knowledgeHash: string; resolution: ExchangeResolutionBinding; forks?: never
  }
}
export interface KnowledgeForkReceipt {
  kind: 'synced-exchange-operation'; version: 6; request: B.BothRequest; result: SyncedExchangeAccepted
  provenance: Omit<TombstoneExchangeReceipt['provenance'], 'plannerVersion' | 'deletions' | 'resolution' | 'forks'> & {
    plannerVersion: 'knowledge-forks-v1'; knowledgeHash: string; resolution: B.BothResolution; forks: SyncedBothForkProof[]
  }
}
export interface DeletionChoiceReceipt {
  kind: 'synced-exchange-operation'; version: 7; request: ExchangeDeletionRequest; result: SyncedExchangeAccepted
  provenance: Omit<TombstoneExchangeReceipt['provenance'], 'plannerVersion' | 'resolution'> & {
    plannerVersion: 'delete-choices-v1'; decisionSourceHash: string; resolution: DC.DeletionChoiceResolution
  }
}
export type ExchangeReceipt = LegacyExchangeReceipt | TombstoneExchangeReceipt | KnowledgeConflictReceipt | KnowledgeForkReceipt | DeletionChoiceReceipt
export interface ExchangePublicationMember {
  groupId: string; creationId: string; revision: string; topologyRevision: string; semanticHash: string; nextPortableHash: string
}
export interface ExchangePublicationDescriptor {
  kind: 'synced-exchange-publication'; version: 1; attemptId: string; workspaceScope: string; recoveryEpoch: string; targetFingerprint: string
  localFingerprint: string; planHash: string; expectedRemote: { etag: string; manifestHash: string }
  next: { manifestHash: string; objects: PublicationObjectDescriptor[]; assets: PublicationAssetDescriptor[] }
  members: ExchangePublicationMember[]
}
/** Immutable original job. Progress is a separate fact; never rewrite these bytes after a 412/possible. */
export interface LegacyExchangeJob {
  kind: 'synced-exchange-job'; version: 1 | 2 | 3; request: ExchangeRequest; requestHash: string
  attemptId: string; parentAttemptId: string | null; attemptIndex: number
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string; source: ExchangeSeedProof
  descriptor: ExchangePublicationDescriptor; components: ExchangeComponent[]; spoolHash: string; preparedAt: string
  plannerVersion?: 'conflicts-v1' | 'forks-v1'; resolution?: ExchangeResolutionBinding | B.BothResolution | null
  merges?: ExchangeMergeProvenance[]
  forks?: SyncedBothForkProof[]
}
export interface TombstoneExchangeJob extends Omit<LegacyExchangeJob, 'version' | 'request' | 'plannerVersion' | 'resolution' | 'forks'> {
  version: 4; request: ExchangeRequestV1; plannerVersion: 'tombstones-v1'; deletions: TombstoneDeletionIntent[]; merges: ExchangeMergeProvenance[]
  resolution?: never; forks?: never
}
export interface KnowledgeConflictJob extends Omit<LegacyExchangeJob, 'version' | 'request' | 'plannerVersion' | 'resolution' | 'forks'> {
  version: 5; request: ExchangeResolveRequest; plannerVersion: 'knowledge-conflicts-v1'
  knowledgeSource: KnowledgeSource; knowledgeHash: string; resolution: ExchangeResolutionBinding; merges: ExchangeMergeProvenance[]; forks?: never
}
export interface KnowledgeForkJob extends Omit<LegacyExchangeJob, 'version' | 'request' | 'plannerVersion' | 'resolution' | 'forks'> {
  version: 6; request: B.BothRequest; plannerVersion: 'knowledge-forks-v1'
  knowledgeSource: KnowledgeSource; knowledgeHash: string; resolution: B.BothResolution; merges: ExchangeMergeProvenance[]; forks: SyncedBothForkProof[]
}
export interface DeletionChoiceJob extends Omit<LegacyExchangeJob, 'version' | 'request' | 'plannerVersion' | 'resolution' | 'forks'> {
  version: 7; request: ExchangeDeletionRequest; plannerVersion: 'delete-choices-v1'; resolution: DC.DeletionChoiceResolution
  decisionSource: DC.DeletionDecisionSource; decisionSourceHash: string; deletions: DeletionChoiceIntent[]; merges: ExchangeMergeProvenance[]; forks?: never
}
export type ExchangeJob = LegacyExchangeJob | TombstoneExchangeJob | KnowledgeConflictJob | KnowledgeForkJob | DeletionChoiceJob
export type AnyExchangeState = ExchangeState | TombstoneExchangeState
export type ExchangeJobPhase = 'prepared' | 'possible' | 'remote-confirmed' | 'settled' | 'remote-uncertain' | 'published-local-deferred' | 'blocked'
export interface ExchangeJobPhaseFact {
  kind: 'synced-exchange-job-phase'; version: 1 | 2; operationId: string; requestHash: string; jobHash: string
  attemptId: string; sequence: number; previousFactHash: string | null
  phase: ExchangeJobPhase; remoteEtag: string | null; recordedAt: string
  blocked?: SyncedExchangeBothPublishedBlock | null
}

const reasons: readonly ExchangeDeferredReason[] = ['diverged', 'incarnation', 'owner-source', 'unknown-birth', 'history-pin', 'catalog', 'path', 'dependency', 'tombstone', 'local-removal', 'baseline-missing']
const phases: readonly ExchangeJobPhase[] = ['prepared', 'possible', 'remote-confirmed', 'settled', 'remote-uncertain', 'published-local-deferred']
const str = (v: unknown): string => typeof v === 'string' ? v : publicationInvalid('exchange字符串无效。')
const opaque = (v: unknown): string => isSyncedBlockId(v) ? v : publicationInvalid('exchange原稳定身份无效。')
const uuid = (v: unknown): string => isSyncedUuid(v) ? v : publicationInvalid('exchange UUID无效。')
const hash = (v: unknown): string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : publicationInvalid('exchange hash无效。')
const time = (v: unknown): string => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : publicationInvalid('exchange日期无效。')
const maybeHash = (v: unknown): string | null => v === null ? null : hash(v)
const maybeString = (v: unknown): string | null => v === null ? null : str(v)
function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : publicationInvalid('exchange整数范围无效。')
}
export function exchangeRecordKey(value: unknown): string {
  const key = str(value)
  if (key === 'databases' || key.startsWith('doc:') && isSyncedBlockId(key.slice(4)) || key.startsWith('group:') && isSyncedUuid(key.slice(6))) return key
  return publicationInvalid('exchange记录键无效。')
}
/** New finite data boundaries reject rather than JSON-normalize caller objects. Strings/opaque IDs stay exact. */
export function assertExchangeData(value: unknown): void {
  const seen = new Set<object>()
  function visit(item: unknown, depth: number): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || seen.has(item)) return publicationInvalid('exchange不是有限JSON数据。')
    if (depth >= 32) return publicationInvalid('exchange容器深度超过原JSON门槛。')
    seen.add(item)
    const keys = Reflect.ownKeys(item), descriptors = Object.getOwnPropertyDescriptors(item)
    if (keys.some(key => typeof key !== 'string')) return publicationInvalid('exchange不接受symbol字段。')
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || keys.length !== item.length + 1) return publicationInvalid('exchange数组含空洞、额外字段或非原数组原型。')
      for (let i = 0; i < item.length; i++) {
        const d = descriptors[String(i)]
        if (!d || !('value' in d) || !d.enumerable) return publicationInvalid('exchange数组不是准确dense数据。')
        visit(d.value, depth + 1)
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)) return publicationInvalid('exchange对象原型无效。')
      for (const key of keys as string[]) {
        const d = descriptors[key]
        if (!d || !('value' in d) || !d.enumerable || ['__proto__', 'constructor', 'prototype'].includes(key)) return publicationInvalid('exchange对象字段无效。')
        visit(d.value, depth + 1)
      }
    }
    seen.delete(item)
  }
  visit(value, 0)
}
function list<T>(v: unknown, read: (raw: unknown) => T, max = SYNCED_MAX_BLOCKS): T[] {
  if (!Array.isArray(v) || v.length > max) return publicationInvalid('exchange数组超过原条目门槛。')
  return v.map(read)
}
function ordered<T>(items: T[], key: (item: T) => string): T[] {
  const keys = items.map(key)
  if (new Set(keys).size !== keys.length || keys.some((value, i) => i > 0 && publicationCompare(keys[i - 1], value) >= 0)) return publicationInvalid('exchange集合没有准确唯一排序。')
  return items
}
export function exchangeKeys(v: unknown): string[] { assertExchangeData(v); return ordered(list(v, exchangeRecordKey), value => value) }
function root(value: unknown, required: readonly string[]): asserts value is Record<string, unknown> { assertExchangeData(value); assertSyncedShape(value, required) }
function version(value: Record<string, unknown>, kind: string): void { if (value.kind !== kind || value.version !== 1) return publicationInvalid('exchange finite版本无效。') }
function versionedRoot(value: unknown, kind: string, fields: string[], extras: string[], third: string[] = []): asserts value is Record<string, unknown> {
  assertExchangeData(value)
  const revision = value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  root(value, revision === 2 ? [...fields, ...extras] : revision === 3 ? [...fields, ...third] : fields)
  if (value.kind !== kind || (revision !== 1 && revision !== 2 && revision !== 3)) return publicationInvalid('exchange finite版本无效。')
}
function resolutionFor(request: ExchangeRequest, binding: ExchangeResolutionBinding | null): void {
  if (request.method === 'exchangeSyncedSnapshot') { if (binding !== null) return publicationInvalid('自动exchange不能借显式决定来源。'); return }
  if (!binding || binding.previewId !== request.previewId || binding.decisionsHash !== publicationHash(publicationJson(request.decisions)))
    return publicationInvalid('resolve完整原selectors与preview来源不闭合。')
}
export function validateExchangeRequest(value: unknown): ExchangeRequest {
  assertExchangeData(value)
  if (value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'method')?.value === 'resolveSyncedExchangeDeletions') {
    root(value,['method','operationId','databasePath','targetFingerprint','previewId','decisions'])
    return {method:'resolveSyncedExchangeDeletions',operationId:uuid(value.operationId),databasePath:opaque(value.databasePath),targetFingerprint:hash(value.targetFingerprint),previewId:uuid(value.previewId),decisions:DC.validateDeletionDecisions(value.decisions)}
  }
  if (value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'method')?.value === 'resolveSyncedExchangeBoth') return B.validateBothRequest(value)
  if (!value || typeof value !== 'object' || !('method' in value)) return publicationInvalid('exchange method不符。')
  const raw: unknown = value
  if (value.method === 'exchangeSyncedSnapshot') {
    root(raw, ['method', 'operationId', 'databasePath', 'targetFingerprint'])
    return { method: 'exchangeSyncedSnapshot', operationId: uuid(raw.operationId), databasePath: opaque(raw.databasePath), targetFingerprint: hash(raw.targetFingerprint) }
  }
  root(raw, ['method', 'operationId', 'databasePath', 'targetFingerprint', 'previewId', 'decisions'])
  if (raw.method !== 'resolveSyncedExchangeConflicts') return publicationInvalid('exchange method不符。')
  return { method: 'resolveSyncedExchangeConflicts', operationId: uuid(raw.operationId), databasePath: opaque(raw.databasePath), targetFingerprint: hash(raw.targetFingerprint),
    previewId: uuid(raw.previewId), decisions: validateConflictDecisions(raw.decisions) }
}
export function validateExchangeSeedProof(value: unknown): ExchangeSeedProof {
  root(value, ['kind', 'operationId', 'manifestHash', 'portableDigest'])
  if (!['initial-receipt', 'confirmed-publication', 'current-equality'].includes(str(value.kind))) return publicationInvalid('exchange共同来源种类无效。')
  const operationId = value.kind === 'current-equality' ? value.operationId === null ? null : publicationInvalid('等值seed不得伪造原操作。') : uuid(value.operationId)
  return { kind: value.kind as ExchangeSeedProof['kind'], operationId, manifestHash: hash(value.manifestHash), portableDigest: hash(value.portableDigest) }
}
export function validateExchangeComponent(value: unknown): ExchangeComponent {
  root(value, ['keys', 'localSignature', 'remoteSignature', 'dependencySignature'])
  const keys = exchangeKeys(value.keys); if (!keys.length) return publicationInvalid('exchange空依赖分量。')
  return { keys, localSignature: hash(value.localSignature), remoteSignature: hash(value.remoteSignature), dependencySignature: hash(value.dependencySignature) }
}
export function validateDeferredExchangeComponent(value: unknown): DeferredExchangeComponent {
  root(value, ['keys', 'localSignature', 'remoteSignature', 'dependencySignature', 'reason'])
  if (!reasons.includes(value.reason as ExchangeDeferredReason)) return publicationInvalid('exchange暂缓原因未知。')
  return { ...validateExchangeComponent({ keys: value.keys, localSignature: value.localSignature, remoteSignature: value.remoteSignature, dependencySignature: value.dependencySignature }), reason: value.reason as ExchangeDeferredReason }
}
export function validateExchangeBaseline(value: unknown): ExchangeBaselineEntry {
  root(value, ['key', 'localHash', 'remoteHash', 'commonHash', 'dependencyKeys', 'dependencySignature', 'acceptedOperationId'])
  const key = exchangeRecordKey(value.key), dependencyKeys = exchangeKeys(value.dependencyKeys)
  if (dependencyKeys.includes(key)) return publicationInvalid('exchange baseline不把自身伪作依赖。')
  return { key, localHash: maybeHash(value.localHash), remoteHash: hash(value.remoteHash), commonHash: maybeHash(value.commonHash), dependencyKeys, dependencySignature: hash(value.dependencySignature), acceptedOperationId: uuid(value.acceptedOperationId) }
}
export function validateExchangeState(value: unknown): ExchangeState {
  root(value, ['kind', 'version', 'databasePath', 'targetFingerprint', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'generation', 'currentOperationId', 'source', 'baseline', 'deferred', 'lastSyncAt'])
  version(value, 'synced-exchange-state')
  const deferred = ordered(list(value.deferred, validateDeferredExchangeComponent), row => publicationJson(row.keys)); disjoint(deferred)
  return { kind: 'synced-exchange-state', version: 1, databasePath: opaque(value.databasePath), targetFingerprint: hash(value.targetFingerprint), workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), remoteWorkspaceId: uuid(value.remoteWorkspaceId), generation: uuid(value.generation), currentOperationId: value.currentOperationId === null ? null : uuid(value.currentOperationId), source: validateExchangeSeedProof(value.source), baseline: ordered(list(value.baseline, validateExchangeBaseline), row => row.key), deferred, lastSyncAt: time(value.lastSyncAt) }
}
export function validateExchangeAccepted(value: unknown): SyncedExchangeAccepted {
  root(value, ['status', 'operationId', 'replayed', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'beforeManifestHash', 'afterManifestHash', 'publishedKeys', 'appliedKeys', 'acceptedKeys', 'deferred', 'acceptedAt'])
  if (!['applied', 'noop', 'deferred'].includes(str(value.status)) || typeof value.replayed !== 'boolean') return publicationInvalid('exchange结果无效。')
  const publishedKeys = exchangeKeys(value.publishedKeys), appliedKeys = exchangeKeys(value.appliedKeys), acceptedKeys = exchangeKeys(value.acceptedKeys)
  const deferred = ordered(list(value.deferred, validateDeferredExchangeComponent), row => publicationJson(row.keys)), accepted = new Set(acceptedKeys)
  disjoint(deferred)
  if ([...publishedKeys, ...appliedKeys].some(key => !accepted.has(key)) || deferred.some(row => row.keys.some(key => accepted.has(key)))) return publicationInvalid('exchange结算与暂缓集合不互斥闭合。')
  const status = publishedKeys.length || appliedKeys.length ? 'applied' : deferred.length ? 'deferred' : 'noop'
  if (value.status !== status) return publicationInvalid('exchange状态与真实变更集合不符。')
  return { status, operationId: uuid(value.operationId), replayed: value.replayed, workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), remoteWorkspaceId: uuid(value.remoteWorkspaceId), beforeManifestHash: hash(value.beforeManifestHash), afterManifestHash: hash(value.afterManifestHash), publishedKeys, appliedKeys, acceptedKeys, deferred, acceptedAt: time(value.acceptedAt) }
}
export function validateExchangeTransfer(value: unknown): ExchangeTransfer {
  root(value, ['id', 'fromKind', 'fromId', 'fromCreatedAt', 'toKind', 'toId', 'toCreatedAt'])
  if (!['document', 'group'].includes(str(value.fromKind)) || !['document', 'group'].includes(str(value.toKind))) return publicationInvalid('exchange物理owner种类无效。')
  return { id: opaque(value.id), fromKind: value.fromKind as ExchangeTransfer['fromKind'], fromId: opaque(value.fromId), fromCreatedAt: time(value.fromCreatedAt), toKind: value.toKind as ExchangeTransfer['toKind'], toId: opaque(value.toId), toCreatedAt: time(value.toCreatedAt) }
}
function acceptedSide(value: unknown): ExchangeAcceptedSide {
  root(value, ['key', 'beforeLocalHash', 'beforeRemoteHash', 'afterHash', 'dependencyKeys', 'dependencySignature'])
  const key = exchangeRecordKey(value.key), dependencyKeys = exchangeKeys(value.dependencyKeys)
  if (dependencyKeys.includes(key)) return publicationInvalid('exchange accepted side不把自身伪作依赖。')
  return { key, beforeLocalHash: maybeHash(value.beforeLocalHash), beforeRemoteHash: maybeHash(value.beforeRemoteHash), afterHash: hash(value.afterHash), dependencyKeys, dependencySignature: hash(value.dependencySignature) }
}
export function validateExchangeReceipt(value: unknown): ExchangeReceipt {
  if (value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 7) return validateDeletionChoiceReceipt(value)
  const tag = value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  if (tag === 5 || tag === 6) return validateKnowledgeExchangeReceipt(value)
  if (value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 4) return validateTombstoneExchangeReceipt(value)
  versionedRoot(value, 'synced-exchange-operation', ['kind', 'version', 'request', 'result', 'provenance'], [])
  let result: SyncedExchangeAccepted
  if (value.version === 3) {
    assertExchangeData(value.result)
    assertSyncedShape(value.result, ['status', 'operationId', 'replayed', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'beforeManifestHash', 'afterManifestHash', 'publishedKeys', 'appliedKeys', 'acceptedKeys', 'deferred', 'acceptedAt', 'forks'])
    const { forks, ...original } = value.result
    result = { ...validateExchangeAccepted(original), forks: B.validateBothSummaries(forks) }
  } else result = validateExchangeAccepted(value.result)
  const request = validateExchangeRequest(value.request), p = value.provenance
  root(p, ['beforeManifestHash', 'afterManifestHash', 'beforeManifestEtag', 'afterManifestEtag', 'planHash', 'source', 'accepted', 'transfers', 'afterStateHash', 'historyArchives', 'hostHistoryCuts',
    ...(value.version === 2 ? ['plannerVersion', 'resolution', 'merges', 'attemptId'] : value.version === 3 ? ['plannerVersion', 'resolution', 'merges', 'forks', 'attemptId'] : [])])
  const historyArchives = ordered(list(p.historyArchives, raw => { root(raw, ['groupId', 'indexHash']); return { groupId: uuid(raw.groupId), indexHash: hash(raw.indexHash) } }), row => row.groupId)
  // Execution history length has no wire-record count gate. This is a private finite index, not a new wire budget.
  const hostHistoryCuts = ordered(list(p.hostHistoryCuts, raw => { root(raw, ['historyToken', 'cutHash']); return { historyToken: uuid(raw.historyToken), cutHash: hash(raw.cutHash) } }, Number.MAX_SAFE_INTEGER), row => row.historyToken)
  const provenance: ExchangeProvenance = { beforeManifestHash: hash(p.beforeManifestHash), afterManifestHash: hash(p.afterManifestHash), beforeManifestEtag: opaque(p.beforeManifestEtag), afterManifestEtag: maybeString(p.afterManifestEtag), planHash: hash(p.planHash), afterStateHash: hash(p.afterStateHash), source: validateExchangeSeedProof(p.source), accepted: ordered(list(p.accepted, acceptedSide), row => row.key), transfers: ordered(list(p.transfers, validateExchangeTransfer), row => row.id), historyArchives, hostHistoryCuts }
  if (value.version === 1 && request.method !== 'exchangeSyncedSnapshot') return publicationInvalid('原v1不能伪成resolve。')
  if (value.version === 2) {
    if (request.method !== 'exchangeSyncedSnapshot' && request.method !== 'resolveSyncedExchangeConflicts') return publicationInvalid('原v2收据不接受both方法。')
    if (p.plannerVersion !== 'conflicts-v1') return publicationInvalid('未知conflict planner。')
    provenance.plannerVersion = 'conflicts-v1'; provenance.resolution = validateExchangeResolutionBinding(p.resolution); provenance.merges = validateExchangeMerges(p.merges)
    provenance.attemptId = uuid(p.attemptId)
    resolutionFor(request, provenance.resolution)
    const accepted = new Map(provenance.accepted.map(row => [row.key, row]))
    for (const merge of provenance.merges) { const side = accepted.get(merge.key)
      if (!side || side.afterHash !== merge.resultHash || side.beforeLocalHash !== merge.localHash || side.beforeRemoteHash !== merge.remoteHash)
        return publicationInvalid('merge来源必须属于准确accepted结果。') }
  }
  if (value.version === 3) {
    if (request.method !== 'resolveSyncedExchangeBoth' || p.plannerVersion !== 'forks-v1') return publicationInvalid('v3只能消费原both方法/算法。')
    const binding = B.validateBothResolution(p.resolution), forks = B.validateBothForkProofs(p.forks)
    if (binding.previewId !== request.previewId || binding.decisionsHash !== publicationHash(publicationJson(request.decisions))
      || forks.some(row => row.allocationHash !== binding.allocationHash) || publicationJson(forks.map(row => row.summary)) !== publicationJson(result.forks))
      return publicationInvalid('v3决定/分配/实际fork summary不闭合。')
    provenance.plannerVersion = 'forks-v1'; provenance.resolution = binding; provenance.forks = forks
    provenance.merges = validateExchangeMerges(p.merges); provenance.attemptId = uuid(p.attemptId)
    const accepted = new Map(provenance.accepted.map(row => [row.key, row]))
    for (const proof of forks) for (const row of proof.results) if (accepted.get(row.key)?.afterHash !== row.hash) return publicationInvalid('v3 fork结果不属于原accepted图。')
    for (const merge of provenance.merges) { const side = accepted.get(merge.key)
      if (!side || side.afterHash !== merge.resultHash || side.beforeLocalHash !== merge.localHash || side.beforeRemoteHash !== merge.remoteHash) return publicationInvalid('v3无关merge来源不闭合。') }
  }
  if (request.operationId !== result.operationId || provenance.beforeManifestHash !== result.beforeManifestHash || provenance.afterManifestHash !== result.afterManifestHash || publicationJson(provenance.accepted.map(row => row.key)) !== publicationJson(result.acceptedKeys)) return publicationInvalid('exchange原收据没有准确闭合结果。')
  return { kind: 'synced-exchange-operation', version: value.version === 3 ? 3 : value.version === 2 ? 2 : 1, request, result, provenance }
}
export const exchangeHostCutKey = (historyToken: string): string => 'sync.webdav.protocol5.exchange-host-cut.v1.' + uuid(historyToken)
export function validateExchangeHostCut(value: unknown): ExchangeHostCut {
  root(value, ['kind', 'version', 'operationId', 'historyToken', 'journalHash', 'participants', 'cutAt']); version(value, 'synced-exchange-host-cut')
  const participants = ordered(list(value.participants, raw => {
    root(raw, ['documentId', 'position']); const position = integer(raw.position)
    if (!position) return publicationInvalid('exchange history cut position不是原正整数。')
    return { documentId: opaque(raw.documentId), position }
  }, Number.MAX_SAFE_INTEGER), row => row.documentId)
  if (!participants.length) return publicationInvalid('exchange history cut缺准确原参与者。')
  return { kind: 'synced-exchange-host-cut', version: 1, operationId: uuid(value.operationId), historyToken: uuid(value.historyToken),
    journalHash: hash(value.journalHash), participants, cutAt: time(value.cutAt) }
}
function objectDescriptor(value: unknown): PublicationObjectDescriptor {
  root(value, ['key', 'path', 'hash', 'bytes'])
  const digest = hash(value.hash), bytes = integer(value.bytes, PUBLICATION_RECORD_MAX_BYTES)
  if (!bytes || value.path !== 'objects/' + digest + '.json') return publicationInvalid('exchange对象spool描述无效。')
  return { key: exchangeRecordKey(value.key), path: 'objects/' + digest + '.json', hash: digest, bytes }
}
function assetDescriptor(value: unknown): PublicationAssetDescriptor {
  root(value, ['path', 'hash', 'bytes', 'names'])
  const digest = hash(value.hash), names = ordered(list(value.names, str), name => name)
  if (!names.length || value.path !== 'assets/' + digest) return publicationInvalid('exchange资产spool描述无效。')
  for (const name of names) parseSyncedPortableAssetUri('knowbook-asset://' + digest + '/' + encodeURIComponent(name))
  return { path: 'assets/' + digest, hash: digest, bytes: integer(value.bytes, ATTACHMENT_MAX_FILE_BYTES), names }
}
function member(value: unknown): ExchangePublicationMember {
  root(value, ['groupId', 'creationId', 'revision', 'topologyRevision', 'semanticHash', 'nextPortableHash'])
  return { groupId: uuid(value.groupId), creationId: uuid(value.creationId), revision: uuid(value.revision), topologyRevision: uuid(value.topologyRevision), semanticHash: hash(value.semanticHash), nextPortableHash: hash(value.nextPortableHash) }
}
export function validateExchangeDescriptor(value: unknown): ExchangePublicationDescriptor {
  root(value, ['kind', 'version', 'attemptId', 'workspaceScope', 'recoveryEpoch', 'targetFingerprint', 'localFingerprint', 'planHash', 'expectedRemote', 'next', 'members']); version(value, 'synced-exchange-publication')
  const expected = value.expectedRemote, next = value.next
  root(expected, ['etag', 'manifestHash']); root(next, ['manifestHash', 'objects', 'assets'])
  const objects = ordered(list(next.objects, objectDescriptor), row => row.key), assets = ordered(list(next.assets, assetDescriptor), row => row.path), members = ordered(list(value.members, member), row => row.groupId)
  const objectHashes = new Map(objects.map(row => [row.key, row.hash]))
  if (members.some(row => objectHashes.get('group:' + row.groupId) !== row.nextPortableHash)) return publicationInvalid('exchange当前成员与nextportable没有准确join。')
  return { kind: 'synced-exchange-publication', version: 1, attemptId: uuid(value.attemptId), workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), targetFingerprint: hash(value.targetFingerprint), localFingerprint: hash(value.localFingerprint), planHash: hash(value.planHash), expectedRemote: { etag: opaque(expected.etag), manifestHash: hash(expected.manifestHash) }, next: { manifestHash: hash(next.manifestHash), objects, assets }, members }
}
export function validateExchangeJob(value: unknown): ExchangeJob {
  if (value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 7) return validateDeletionChoiceJob(value).job
  const tag = value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  if (tag === 5 || tag === 6) return validateKnowledgeExchangeJob(value)
  if (value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 4) return validateTombstoneExchangeJob(value)
  versionedRoot(value, 'synced-exchange-job', ['kind', 'version', 'request', 'requestHash', 'attemptId', 'parentAttemptId', 'attemptIndex', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'source', 'descriptor', 'components', 'spoolHash', 'preparedAt'], ['plannerVersion', 'resolution', 'merges'], ['plannerVersion', 'resolution', 'merges', 'forks'])
  const request = validateExchangeRequest(value.request), descriptor = validateExchangeDescriptor(value.descriptor), workspaceScope = uuid(value.workspaceScope), recoveryEpoch = uuid(value.recoveryEpoch)
  const attemptId = uuid(value.attemptId), parentAttemptId = value.parentAttemptId === null ? null : uuid(value.parentAttemptId), attemptIndex = integer(value.attemptIndex)
  if ((attemptIndex === 0) !== (parentAttemptId === null) || parentAttemptId === attemptId || descriptor.attemptId !== attemptId) return publicationInvalid('exchange原attempt父链无效。')
  if (exchangeRequestHash(request) !== value.requestHash || request.targetFingerprint !== descriptor.targetFingerprint || workspaceScope !== descriptor.workspaceScope || recoveryEpoch !== descriptor.recoveryEpoch) return publicationInvalid('exchange immutable job与原请求不闭合。')
  const components = ordered(list(value.components, validateExchangeComponent), row => publicationJson(row.keys)); disjoint(components)
  const result: LegacyExchangeJob = { kind: 'synced-exchange-job', version: value.version === 3 ? 3 : value.version === 2 ? 2 : 1, request, requestHash: hash(value.requestHash), attemptId, parentAttemptId, attemptIndex, workspaceScope, recoveryEpoch, remoteWorkspaceId: uuid(value.remoteWorkspaceId), source: validateExchangeSeedProof(value.source), descriptor, components, spoolHash: hash(value.spoolHash), preparedAt: time(value.preparedAt) }
  if (value.version === 1 && request.method !== 'exchangeSyncedSnapshot') return publicationInvalid('原v1 job不能伪成resolve。')
  if (value.version === 2) { if (value.plannerVersion !== 'conflicts-v1') return publicationInvalid('未知job planner。')
    if (request.method !== 'exchangeSyncedSnapshot' && request.method !== 'resolveSyncedExchangeConflicts') return publicationInvalid('原v2 job不接受both方法。')
    result.plannerVersion = 'conflicts-v1'; result.resolution = validateExchangeResolutionBinding(value.resolution); result.merges = validateExchangeMerges(value.merges); resolutionFor(request, result.resolution) }
  if (value.version === 3) {
    if (request.method !== 'resolveSyncedExchangeBoth' || value.plannerVersion !== 'forks-v1') return publicationInvalid('v3 job算法/方法不一致。')
    const binding = B.validateBothResolution(value.resolution), forks = B.validateBothForkProofs(value.forks)
    if (binding.previewId !== request.previewId || binding.decisionsHash !== publicationHash(publicationJson(request.decisions)) || forks.some(row => row.allocationHash !== binding.allocationHash)) return publicationInvalid('v3 immutable allocation/selector来源不闭合。')
    result.plannerVersion = 'forks-v1'; result.resolution = binding; result.forks = forks; result.merges = validateExchangeMerges(value.merges)
  }
  return result
}
export function validateExchangeJobPhase(value: unknown): ExchangeJobPhaseFact {
  assertExchangeData(value)
  if (value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 2) {
    root(value, ['kind', 'version', 'operationId', 'requestHash', 'jobHash', 'attemptId', 'sequence', 'previousFactHash', 'phase', 'remoteEtag', 'recordedAt', 'blocked'])
    if (value.kind !== 'synced-exchange-job-phase' || ![...phases, 'blocked'].includes(value.phase as ExchangeJobPhase)) return publicationInvalid('v3 phase版本/状态无效。')
    const sequence = integer(value.sequence), previousFactHash = maybeHash(value.previousFactHash), blocked = value.blocked === null ? null : B.validateBothPublishedBlock(value.blocked)
    if ((sequence === 0) !== (previousFactHash === null) || sequence === 0 && value.phase !== 'prepared' || (value.phase === 'blocked') !== (blocked !== null)) return publicationInvalid('v3追加phase/block不闭合。')
    const result: ExchangeJobPhaseFact = { kind: 'synced-exchange-job-phase', version: 2, operationId: uuid(value.operationId), requestHash: hash(value.requestHash), jobHash: hash(value.jobHash), attemptId: uuid(value.attemptId), sequence, previousFactHash, phase: value.phase as ExchangeJobPhase, remoteEtag: maybeString(value.remoteEtag), recordedAt: time(value.recordedAt), blocked }
    if (blocked && (blocked.operationId !== result.operationId || blocked.attemptId !== result.attemptId || blocked.publishedManifestETag !== result.remoteEtag)) return publicationInvalid('v3 blocked不是该原attempt事实。')
    return result
  }
  root(value, ['kind', 'version', 'operationId', 'requestHash', 'jobHash', 'attemptId', 'sequence', 'previousFactHash', 'phase', 'remoteEtag', 'recordedAt']); version(value, 'synced-exchange-job-phase')
  if (!phases.includes(value.phase as ExchangeJobPhase)) return publicationInvalid('exchange job phase未知。')
  const sequence = integer(value.sequence), previousFactHash = maybeHash(value.previousFactHash)
  if ((sequence === 0) !== (previousFactHash === null) || sequence === 0 && value.phase !== 'prepared') return publicationInvalid('exchange追加phase链无效。')
  return { kind: 'synced-exchange-job-phase', version: 1, operationId: uuid(value.operationId), requestHash: hash(value.requestHash), jobHash: hash(value.jobHash), attemptId: uuid(value.attemptId), sequence, previousFactHash, phase: value.phase as ExchangeJobPhase, remoteEtag: maybeString(value.remoteEtag), recordedAt: time(value.recordedAt) }
}
export function validateTombstoneLocalOutcome(value: unknown): TombstoneLocalOutcome {
  assertExchangeData(value)
  const kind = value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : undefined
  root(value, kind === 'absent' ? ['kind', 'tombstoneHash', 'deletionOperationId', 'intentHash'] : ['kind', 'hash'])
  if (kind === 'live') return { kind, hash: hash(value.hash) }
  if (kind !== 'absent') return publicationInvalid('tombstone本机结果不是live/absent。')
  return { kind, tombstoneHash: hash(value.tombstoneHash), deletionOperationId: uuid(value.deletionOperationId), intentHash: hash(value.intentHash) }
}
export function validateTombstoneProofReference(value: unknown): TombstoneProofReference {
  root(value, ['key', 'intentHash', 'proofHash', 'anchorId'])
  return { key: exchangeRecordKey(value.key), intentHash: hash(value.intentHash), proofHash: hash(value.proofHash), anchorId: opaque(value.anchorId) }
}
export function validateTombstoneIdentityEffect(value: unknown): TombstoneIdentityEffect {
  root(value, ['before', 'after']); root(value.before, ['id', 'last_owner_kind', 'last_owner_id', 'state', 'created_at'])
  const before = value.before
  if ((before.last_owner_kind !== 'document' && before.last_owner_kind !== 'group') || before.state !== 'live') return publicationInvalid('tombstone原identity不是真实live。')
  const checked: TombstoneIdentityEffect['before'] = { id: opaque(before.id), last_owner_kind: before.last_owner_kind, last_owner_id: before.last_owner_kind === 'group' ? uuid(before.last_owner_id) : opaque(before.last_owner_id), state: 'live' as const, created_at: time(before.created_at) }
  assertExchangeData(value.after)
  const kind = value.after !== null && typeof value.after === 'object' ? Object.getOwnPropertyDescriptor(value.after, 'kind')?.value : undefined
  root(value.after, kind === 'transferred' ? ['kind', 'ownerKind', 'ownerId', 'createdAt'] : ['kind'])
  if (kind === 'retained') return { before: checked, after: { kind } }
  if (kind !== 'transferred' || (value.after.ownerKind !== 'document' && value.after.ownerKind !== 'group')) return publicationInvalid('tombstoneidentity后果无效。')
  return { before: checked, after: { kind, ownerKind: value.after.ownerKind, ownerId: value.after.ownerKind === 'group' ? uuid(value.after.ownerId) : opaque(value.after.ownerId), createdAt: time(value.after.createdAt) } }
}
export function validateTombstoneDeletionIntent(value: unknown): TombstoneDeletionIntent {
  root(value, ['kind', 'key', 'baseLiveHash', 'tombstoneHash', 'before', 'identities', 'intentHash'])
  const key = exchangeRecordKey(value.key), before = validateSyncedProtocol5Record(value.before, key)
  if ((before.kind !== 'document' && before.kind !== 'synced-group') || value.kind !== (before.kind === 'document' ? 'document' : 'group')
    || publicationHash(publicationJson(before)) !== value.baseLiveHash) return publicationInvalid('tombstoneintent缺准确live前身。')
  const identities = ordered(list(value.identities, validateTombstoneIdentityEffect), row => row.before.id), byId = new Map(identities.map(row => [row.before.id, row]))
  const blocks = before.kind === 'document' ? before.content.blocks : before.blocks
  const births = new Map(before.kind === 'synced-group' ? before.blocks.map(row => [row.id, row.createdAt]) : [])
  if (blocks.length !== identities.length || blocks.some(block => { const row = byId.get(block.id)
    return !row || row.before.last_owner_kind !== value.kind || row.before.last_owner_id !== before.id || before.kind === 'synced-group' && row.before.created_at !== births.get(block.id) }))
    return publicationInvalid('tombstoneintent不是全部实际physical原owner/birth闭集。')
  return { kind: before.kind === 'document' ? 'document' : 'group', key, before, baseLiveHash: hash(value.baseLiveHash), tombstoneHash: hash(value.tombstoneHash), identities, intentHash: hash(value.intentHash) }
}
function tombstoneSide(value: unknown): TombstoneAcceptedSide {
  root(value, ['key', 'beforeLocalHash', 'beforeRemoteHash', 'local', 'remoteHash', 'commonHash', 'dependencyKeys', 'dependencySignature'])
  const key = exchangeRecordKey(value.key), local = validateTombstoneLocalOutcome(value.local), remoteHash = hash(value.remoteHash), commonHash = hash(value.commonHash), dependencyKeys = exchangeKeys(value.dependencyKeys)
  if (dependencyKeys.includes(key) || remoteHash !== commonHash || (local.kind === 'live' ? local.hash : local.tombstoneHash) !== remoteHash)
    return publicationInvalid('tombstoneaccepted两侧知识和原依赖不闭合。')
  return { key, beforeLocalHash: maybeHash(value.beforeLocalHash), beforeRemoteHash: maybeHash(value.beforeRemoteHash), local, remoteHash, commonHash, dependencyKeys, dependencySignature: hash(value.dependencySignature) }
}
export function validateTombstoneExchangeState(value: unknown): TombstoneExchangeState {
  root(value, ['kind', 'version', 'databasePath', 'targetFingerprint', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'generation', 'currentOperationId', 'source', 'baseline', 'deferred', 'lastSyncAt'])
  if (value.kind !== 'synced-exchange-state' || value.version !== 2) return publicationInvalid('tombstonestate finite版本不符。')
  const baseline = ordered(list(value.baseline, raw => {
    root(raw, ['key', 'local', 'remoteHash', 'commonHash', 'dependencyKeys', 'dependencySignature', 'acceptedOperationId'])
    const key = exchangeRecordKey(raw.key), dependencyKeys = exchangeKeys(raw.dependencyKeys)
    if (dependencyKeys.includes(key)) return publicationInvalid('tombstonestate不把自身伪作依赖。')
    return { key, local: validateTombstoneLocalOutcome(raw.local), remoteHash: hash(raw.remoteHash), commonHash: maybeHash(raw.commonHash), dependencyKeys,
      dependencySignature: hash(raw.dependencySignature), acceptedOperationId: uuid(raw.acceptedOperationId) } satisfies TombstoneBaselineEntry
  }), row => row.key)
  const deferred = ordered(list(value.deferred, validateDeferredExchangeComponent), row => publicationJson(row.keys)); disjoint(deferred)
  return { kind: 'synced-exchange-state', version: 2, databasePath: opaque(value.databasePath), targetFingerprint: hash(value.targetFingerprint), workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), remoteWorkspaceId: uuid(value.remoteWorkspaceId), generation: uuid(value.generation), currentOperationId: value.currentOperationId === null ? null : uuid(value.currentOperationId), source: validateExchangeSeedProof(value.source), baseline, deferred, lastSyncAt: time(value.lastSyncAt) }
}
export function validateAnyExchangeState(value: unknown): AnyExchangeState {
  return value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 2 ? validateTombstoneExchangeState(value) : validateExchangeState(value)
}
export function liftTombstoneExchangeState(value: ExchangeState): TombstoneExchangeState {
  return validateTombstoneExchangeState({ ...value, version: 2, baseline: value.baseline.map(row => ({ key: row.key,
    local: row.localHash === null ? publicationInvalid('旧absence不能假升为已接受删除。') : { kind: 'live', hash: row.localHash },
    remoteHash: row.remoteHash, commonHash: row.commonHash, dependencyKeys: row.dependencyKeys, dependencySignature: row.dependencySignature, acceptedOperationId: row.acceptedOperationId })) })
}
function validateTombstoneExchangeJob(value: unknown): TombstoneExchangeJob {
  root(value, ['kind', 'version', 'request', 'requestHash', 'attemptId', 'parentAttemptId', 'attemptIndex', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'source', 'descriptor', 'components', 'spoolHash', 'preparedAt', 'plannerVersion', 'merges', 'deletions'])
  if (value.kind !== 'synced-exchange-job' || value.version !== 4 || value.plannerVersion !== 'tombstones-v1') return publicationInvalid('tombstonejob算法/版本不符。')
  const request = validateExchangeRequest(value.request)
  if (request.method !== 'exchangeSyncedSnapshot') return publicationInvalid('tombstonejob只接受真实exchange入口。')
  const descriptor = validateExchangeDescriptor(value.descriptor), attemptId = uuid(value.attemptId), parentAttemptId = value.parentAttemptId === null ? null : uuid(value.parentAttemptId), attemptIndex = integer(value.attemptIndex)
  const workspaceScope = uuid(value.workspaceScope), recoveryEpoch = uuid(value.recoveryEpoch), remoteWorkspaceId = uuid(value.remoteWorkspaceId)
  if ((attemptIndex === 0) !== (parentAttemptId === null) || parentAttemptId === attemptId || descriptor.attemptId !== attemptId
    || exchangeRequestHash(request) !== value.requestHash || request.targetFingerprint !== descriptor.targetFingerprint || workspaceScope !== descriptor.workspaceScope || recoveryEpoch !== descriptor.recoveryEpoch)
    return publicationInvalid('tombstonejob原请求/attempt/scope不闭合。')
  const components = ordered(list(value.components, validateExchangeComponent), row => publicationJson(row.keys)); disjoint(components)
  const deletions = ordered(list(value.deletions, validateTombstoneDeletionIntent), row => row.key)
  for (const { intentHash, ...intent } of deletions) if (intentHash !== publicationHash(publicationJson({ domain: 'synced-deletion-intent.v1',
    operationId: request.operationId, workspaceScope, recoveryEpoch, targetFingerprint: request.targetFingerprint, remoteWorkspaceId, ...intent }))) return publicationInvalid('tombstonejob原intent完整来源hash损坏。')
  return { kind: 'synced-exchange-job', version: 4, request, requestHash: hash(value.requestHash), attemptId, parentAttemptId, attemptIndex, workspaceScope, recoveryEpoch, remoteWorkspaceId,
    source: validateExchangeSeedProof(value.source), descriptor, components, spoolHash: hash(value.spoolHash), preparedAt: time(value.preparedAt), plannerVersion: 'tombstones-v1', merges: validateExchangeMerges(value.merges), deletions }
}
function validateTombstoneExchangeReceipt(value: unknown): TombstoneExchangeReceipt {
  root(value, ['kind', 'version', 'request', 'result', 'provenance'])
  if (value.kind !== 'synced-exchange-operation' || value.version !== 4) return publicationInvalid('tombstonereceipt版本不符。')
  const request = validateExchangeRequest(value.request), result = validateExchangeAccepted(value.result), p = value.provenance
  if (request.method !== 'exchangeSyncedSnapshot') return publicationInvalid('tombstonereceipt不能伪造resolve/both。')
  root(p, ['beforeManifestHash', 'afterManifestHash', 'beforeManifestEtag', 'afterManifestEtag', 'planHash', 'source', 'accepted', 'transfers', 'afterStateHash', 'historyArchives', 'hostHistoryCuts', 'plannerVersion', 'merges', 'attemptId', 'deletions'])
  if (p.plannerVersion !== 'tombstones-v1') return publicationInvalid('tombstonereceipt算法不符。')
  const accepted = ordered(list(p.accepted, tombstoneSide), row => row.key), deletions = ordered(list(p.deletions, validateTombstoneProofReference), row => row.key)
  const acceptedByKey = new Map(accepted.map(row => [row.key, row])), deletionKeys = new Set(deletions.map(ref => ref.key))
  const transfers = ordered(list(p.transfers, validateExchangeTransfer), row => row.id)
  for (const ref of deletions) { const side = acceptedByKey.get(ref.key)
    if (!side || side.local.kind !== 'absent' || side.local.deletionOperationId !== request.operationId || side.local.intentHash !== ref.intentHash)
      return publicationInvalid('tombstonereceipt删除ref不是本次准确accepted absence。') }
  for (const side of accepted) if (side.local.kind === 'absent' && side.local.deletionOperationId === request.operationId && !deletionKeys.has(side.key)) return publicationInvalid('tombstonereceipt漏本次真实删除proof。')
  const historyArchives = ordered(list(p.historyArchives, raw => { root(raw, ['groupId', 'indexHash']); return { groupId: uuid(raw.groupId), indexHash: hash(raw.indexHash) } }), row => row.groupId)
  const hostHistoryCuts = ordered(list(p.hostHistoryCuts, raw => { root(raw, ['historyToken', 'cutHash']); return { historyToken: uuid(raw.historyToken), cutHash: hash(raw.cutHash) } }, Number.MAX_SAFE_INTEGER), row => row.historyToken)
  const provenance: TombstoneExchangeReceipt['provenance'] = { beforeManifestHash: hash(p.beforeManifestHash), afterManifestHash: hash(p.afterManifestHash), beforeManifestEtag: opaque(p.beforeManifestEtag), afterManifestEtag: maybeString(p.afterManifestEtag),
    planHash: hash(p.planHash), source: validateExchangeSeedProof(p.source), accepted, transfers, afterStateHash: hash(p.afterStateHash), historyArchives, hostHistoryCuts,
    plannerVersion: 'tombstones-v1', merges: validateExchangeMerges(p.merges), attemptId: uuid(p.attemptId), deletions }
  const byKey = new Map(accepted.map(row => [row.key, row]))
  for (const merge of provenance.merges) { const side = byKey.get(merge.key)
    if (!side || side.local.kind !== 'live' || side.local.hash !== merge.resultHash || side.beforeLocalHash !== merge.localHash || side.beforeRemoteHash !== merge.remoteHash) return publicationInvalid('tombstone无关live合并来源不闭合。') }
  if (request.operationId !== result.operationId || provenance.beforeManifestHash !== result.beforeManifestHash || provenance.afterManifestHash !== result.afterManifestHash || publicationJson(accepted.map(row => row.key)) !== publicationJson(result.acceptedKeys)) return publicationInvalid('tombstonereceipt结果闭集不符。')
  return { kind: 'synced-exchange-operation', version: 4, request, result, provenance }
}
export function exchangeTargetFingerprint(target: WebDavSyncConfig): string { return publicationHash(publicationJson({ kind: 'webdav-target', version: 1, channel: 'webdav-manifest5-exchange', url: target.url, username: target.username, directory: target.directory })) }
export const exchangeRequestHash = (request: ExchangeRequest): string => publicationHash(publicationJson(validateExchangeRequest(request)))
export const exchangeStateKey = (targetFingerprint: string): string => 'sync.webdav.protocol5.exchange.v1.' + hash(targetFingerprint)
export const exchangeJobPrefix = (operationId: string): string => 'sync.webdav.protocol5.exchange-job.v1.' + uuid(operationId) + '.'
export const exchangeJobKey = (operationId: string, attemptId: string): string => exchangeJobPrefix(operationId) + uuid(attemptId)
export const exchangeJobHeadKey = (operationId: string): string => 'sync.webdav.protocol5.exchange-job-head.v1.' + uuid(operationId)
export const exchangeJobPhaseKey = (operationId: string, attemptId: string, sequence: number): string => 'sync.webdav.protocol5.exchange-job-phase.v1.' + uuid(operationId) + '.' + uuid(attemptId) + '.' + integer(sequence)
export const exchangeJobHash = (job: ExchangeJob): string => publicationHash(publicationJson(validateExchangeJob(job)))
export function parseExchangeStored(source: string): unknown { return parseStrictJson(source, { maxBytes: Math.max(1, Buffer.byteLength(source, 'utf8')), maxDepth: 32 }) }
function disjoint(components: readonly ExchangeComponent[]): void {
  const seen = new Set<string>()
  for (const component of components) for (const key of component.keys) { if (seen.has(key)) return publicationInvalid('exchange不同依赖分量重叠。'); seen.add(key) }
}

/** New formats are decoded through strict, explicit roots. Projection below only
 * reuses already-frozen scalar/selector/fork rules; no old stored bytes are upgraded. */
function validateKnowledgeExchangeJob(value: unknown): KnowledgeConflictJob | KnowledgeForkJob {
  assertExchangeData(value)
  const fork = value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 6
  root(value, ['kind','version','request','requestHash','attemptId','parentAttemptId','attemptIndex','workspaceScope','recoveryEpoch','remoteWorkspaceId','source','descriptor','components','spoolHash','preparedAt','plannerVersion','resolution','merges','knowledgeSource','knowledgeHash',...(fork?['forks']:[])])
  if (value.kind !== 'synced-exchange-job' || value.version !== (fork?6:5)
    || value.plannerVersion !== (fork?'knowledge-forks-v1':'knowledge-conflicts-v1')) return publicationInvalid('knowledge job格式/算法不匹配。')
  const knowledgeSource = validateKnowledgeSource(value.knowledgeSource), knowledgeHash = hash(value.knowledgeHash)
  if (knowledgeSourceHash(knowledgeSource) !== knowledgeHash) return publicationInvalid('knowledge job缺准确原preimage/hash。')
  const { knowledgeSource: _source, knowledgeHash: _hash, ...legacy } = value
  const checked = validateExchangeJob({...legacy,version:fork?3:2,plannerVersion:fork?'forks-v1':'conflicts-v1'})
  if (knowledgeSource.databasePath !== checked.request.databasePath || knowledgeSource.targetFingerprint !== checked.request.targetFingerprint
    || knowledgeSource.workspaceScope !== checked.workspaceScope || knowledgeSource.recoveryEpoch !== checked.recoveryEpoch)
    return publicationInvalid('knowledge job原path/scope/epoch与知识preimage不符。')
  if (fork) {
    if (checked.version !== 3 || checked.request.method !== 'resolveSyncedExchangeBoth' || !checked.forks) return publicationInvalid('knowledge fork job缺准确both来源。')
    return {...checked,version:6,request:checked.request,plannerVersion:'knowledge-forks-v1',knowledgeSource,knowledgeHash,
      resolution:B.validateBothResolution(checked.resolution),merges:validateExchangeMerges(checked.merges),forks:checked.forks}
  }
  if (checked.version !== 2 || checked.request.method !== 'resolveSyncedExchangeConflicts') return publicationInvalid('knowledge conflict job只接受显式resolve。')
  const resolution=validateExchangeResolutionBinding(checked.resolution)
  if (!resolution) return publicationInvalid('knowledge conflict job缺真实preview。')
  const {forks:_forks,...withoutForks}=checked
  return {...withoutForks,version:5,request:checked.request,plannerVersion:'knowledge-conflicts-v1',knowledgeSource,knowledgeHash,resolution,merges:validateExchangeMerges(checked.merges)}
}
function validateKnowledgeExchangeReceipt(value: unknown): KnowledgeConflictReceipt | KnowledgeForkReceipt {
  root(value,['kind','version','request','result','provenance'])
  const fork=value.version===6,p=value.provenance
  if (value.kind!=='synced-exchange-operation' || ![5,6].includes(value.version as number)) return publicationInvalid('knowledge receipt版本无效。')
  root(p,['beforeManifestHash','afterManifestHash','beforeManifestEtag','afterManifestEtag','planHash','source','accepted','transfers','afterStateHash','historyArchives','hostHistoryCuts','plannerVersion','resolution','merges','attemptId','knowledgeHash',...(fork?['forks']:[])])
  if (p.plannerVersion!==(fork?'knowledge-forks-v1':'knowledge-conflicts-v1')) return publicationInvalid('knowledge receipt算法无效。')
  const accepted=ordered(list(p.accepted,tombstoneSide),row=>row.key)
  const projected=accepted.map(row=>{
    if (row.local.kind!=='live' || row.local.hash!==row.remoteHash || row.commonHash!==row.remoteHash) return publicationInvalid('knowledge receipt本次只接受准确live结果；不能重签absence。')
    return {key:row.key,beforeLocalHash:row.beforeLocalHash,beforeRemoteHash:row.beforeRemoteHash,afterHash:row.local.hash,dependencyKeys:row.dependencyKeys,dependencySignature:row.dependencySignature}
  })
  const {knowledgeHash:_hash,...prior}=p
  const original=validateExchangeReceipt({...value,version:fork?3:2,provenance:{...prior,plannerVersion:fork?'forks-v1':'conflicts-v1',accepted:projected}})
  const knowledgeHash=hash(p.knowledgeHash)
  if (fork) {
    if (original.version!==3 || original.request.method!=='resolveSyncedExchangeBoth' || !original.provenance.forks) return publicationInvalid('knowledge fork receipt来源无效。')
    return {...original,version:6,request:original.request,provenance:{...original.provenance,accepted,plannerVersion:'knowledge-forks-v1',knowledgeHash,
      resolution:B.validateBothResolution(original.provenance.resolution),merges:validateExchangeMerges(original.provenance.merges),attemptId:uuid(original.provenance.attemptId),forks:original.provenance.forks}}
  }
  if (original.version!==2 || original.request.method!=='resolveSyncedExchangeConflicts') return publicationInvalid('knowledge conflict receipt来源无效。')
  const resolution=validateExchangeResolutionBinding(original.provenance.resolution)
  if (!resolution) return publicationInvalid('knowledge conflict receipt缺原preview。')
  const {forks:_forks,...withoutForks}=original.provenance
  return {...original,version:5,request:original.request,provenance:{...withoutForks,accepted,plannerVersion:'knowledge-conflicts-v1',knowledgeHash,
    resolution,merges:validateExchangeMerges(original.provenance.merges),attemptId:uuid(original.provenance.attemptId)}}
}

/** The plan is the result of this exact validation, not a caller-supplied proof.
 * No result is cached: each invocation checks its own complete input again. */
export function validateExchangeJobWithPlan(value: unknown): { job: ExchangeJob; deletionPlan: DC.DeletionChoicePlan | null } {
  if (value !== null && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 7)
    return validateDeletionChoiceJob(value)
  return { job: validateExchangeJob(value), deletionPlan: null }
}
function validateDeletionChoiceJob(value: unknown): { job: DeletionChoiceJob; deletionPlan: DC.DeletionChoicePlan } {
  root(value,['kind','version','request','requestHash','attemptId','parentAttemptId','attemptIndex','workspaceScope','recoveryEpoch','remoteWorkspaceId','source','descriptor','components','spoolHash','preparedAt','plannerVersion','resolution','merges','deletions','decisionSource','decisionSourceHash'])
  if(value.kind!=='synced-exchange-job'||value.version!==7||value.plannerVersion!=='delete-choices-v1')return publicationInvalid('删除选择job版本/算法不符。')
  const request=validateExchangeRequest(value.request)
  if(request.method!=='resolveSyncedExchangeDeletions')return publicationInvalid('删除选择job只接受原显式入口。')
  const descriptor=validateExchangeDescriptor(value.descriptor),attemptId=uuid(value.attemptId),parentAttemptId=value.parentAttemptId===null?null:uuid(value.parentAttemptId),attemptIndex=integer(value.attemptIndex)
  const workspaceScope=uuid(value.workspaceScope),recoveryEpoch=uuid(value.recoveryEpoch),remoteWorkspaceId=uuid(value.remoteWorkspaceId)
  if((attemptIndex===0)!==(parentAttemptId===null)||parentAttemptId===attemptId||descriptor.attemptId!==attemptId||exchangeRequestHash(request)!==value.requestHash
    ||request.targetFingerprint!==descriptor.targetFingerprint||workspaceScope!==descriptor.workspaceScope||recoveryEpoch!==descriptor.recoveryEpoch)return publicationInvalid('删除选择job原请求/attempt/scope不闭合。')
  const resolution=DC.validateDeletionChoiceResolution(value.resolution),decisionSource=DC.validateDeletionDecisionSource(value.decisionSource),decisionSourceHash=hash(value.decisionSourceHash)
  if(!resolution||resolution.previewId!==request.previewId||resolution.decisionsHash!==DC.deletionDecisionsHash(request.decisions)
    ||publicationJson(decisionSource.resolution)!==publicationJson(resolution)||publicationJson(decisionSource.decisions)!==publicationJson(request.decisions)
    ||DC.deletionDecisionSourceHash(decisionSource)!==decisionSourceHash||decisionSource.databasePath!==request.databasePath||decisionSource.targetFingerprint!==request.targetFingerprint
    ||decisionSource.workspaceScope!==workspaceScope||decisionSource.recoveryEpoch!==recoveryEpoch||decisionSource.remoteWorkspaceId!==remoteWorkspaceId
    ||decisionSource.localFingerprint!==descriptor.localFingerprint||decisionSource.remoteSource.manifestHash!==descriptor.expectedRemote.manifestHash||decisionSource.remoteSource.etag!==descriptor.expectedRemote.etag)
    return publicationInvalid('删除选择job缺准确历史decision原像/真实remote来源。')
  const components=ordered(list(value.components,validateExchangeComponent),row=>publicationJson(row.keys));disjoint(components)
  const deletions=ordered(list(value.deletions,validateDeletionChoiceIntent),row=>row.key),merges=validateExchangeMerges(value.merges),source=validateExchangeSeedProof(value.source)
  for(const {intentHash,...intent}of deletions)if(intentHash!==logicalDeletionChoiceIntentHash(intent,{operationId:request.operationId,workspaceScope,recoveryEpoch,targetFingerprint:request.targetFingerprint,remoteWorkspaceId})
    ||intent.decision.decisionSourceHash!==decisionSourceHash||intent.decision.previewId!==resolution.previewId||intent.decision.previewHash!==resolution.previewHash||intent.decision.decisionsHash!==resolution.decisionsHash)
    return publicationInvalid('删除选择job双hash/原决定/完整intent不闭合。')
  // Recompute the exact historical planner from its immutable preimage. This
  // path never consults today's state/head, a live database, or removable spool.
  const plan=planSyncedDeletionChoicesFromSource(decisionSource,request.operationId)
  if(publicationJson(plan.deletions)!==publicationJson(deletions)||publicationJson(plan.merges)!==publicationJson(merges)||publicationJson(plan.components)!==publicationJson(components)
    ||publicationJson(source)!==publicationJson(decisionSource.state.source)||plan.planHash!==descriptor.planHash||plan.beforeManifestHash!==descriptor.expectedRemote.manifestHash
    ||plan.afterManifestHash!==descriptor.next.manifestHash||plan.decisionSourceHash!==decisionSourceHash)return publicationInvalid('删除选择job不属于准确历史全图planner。')
  const job: DeletionChoiceJob = {kind:'synced-exchange-job',version:7,request,requestHash:hash(value.requestHash),attemptId,parentAttemptId,attemptIndex,workspaceScope,recoveryEpoch,remoteWorkspaceId,source,descriptor,components,spoolHash:hash(value.spoolHash),preparedAt:time(value.preparedAt),plannerVersion:'delete-choices-v1',resolution,decisionSource,decisionSourceHash,deletions,merges}
  return { job, deletionPlan: plan }
}
function validateDeletionChoiceReceipt(value: unknown): DeletionChoiceReceipt {
  root(value,['kind','version','request','result','provenance'])
  if(value.kind!=='synced-exchange-operation'||value.version!==7)return publicationInvalid('删除选择receipt版本不符。')
  const request=validateExchangeRequest(value.request),result=validateExchangeAccepted(value.result),p=value.provenance
  if(request.method!=='resolveSyncedExchangeDeletions')return publicationInvalid('删除选择receipt方法不符。')
  root(p,['beforeManifestHash','afterManifestHash','beforeManifestEtag','afterManifestEtag','planHash','source','accepted','transfers','afterStateHash','historyArchives','hostHistoryCuts','plannerVersion','merges','attemptId','deletions','resolution','decisionSourceHash'])
  const resolution=DC.validateDeletionChoiceResolution(p.resolution)
  if(p.plannerVersion!=='delete-choices-v1'||!resolution||resolution.previewId!==request.previewId||resolution.decisionsHash!==DC.deletionDecisionsHash(request.decisions))return publicationInvalid('删除选择receipt原preview/决定不符。')
  const accepted=ordered(list(p.accepted,tombstoneSide),row=>row.key),deletions=ordered(list(p.deletions,validateTombstoneProofReference),row=>row.key),byKey=new Map(accepted.map(row=>[row.key,row]))
  const deletionKeys=new Set(deletions.map(row=>row.key))
  for(const ref of deletions){const side=byKey.get(ref.key);if(!side||side.local.kind!=='absent'||side.local.deletionOperationId!==request.operationId||side.local.intentHash!==ref.intentHash)return publicationInvalid('删除选择receipt漏准确本次absence/首证。')}
  for(const side of accepted)if(side.local.kind==='absent'&&side.local.deletionOperationId===request.operationId&&!deletionKeys.has(side.key))return publicationInvalid('删除选择receipt缺本次首证。')
  const historyArchives=ordered(list(p.historyArchives,raw=>{root(raw,['groupId','indexHash']);return {groupId:uuid(raw.groupId),indexHash:hash(raw.indexHash)}}),row=>row.groupId)
  const hostHistoryCuts=ordered(list(p.hostHistoryCuts,raw=>{root(raw,['historyToken','cutHash']);return {historyToken:uuid(raw.historyToken),cutHash:hash(raw.cutHash)}},Number.MAX_SAFE_INTEGER),row=>row.historyToken)
  const provenance:DeletionChoiceReceipt['provenance']={beforeManifestHash:hash(p.beforeManifestHash),afterManifestHash:hash(p.afterManifestHash),beforeManifestEtag:opaque(p.beforeManifestEtag),afterManifestEtag:maybeString(p.afterManifestEtag),planHash:hash(p.planHash),source:validateExchangeSeedProof(p.source),accepted,transfers:ordered(list(p.transfers,validateExchangeTransfer),row=>row.id),afterStateHash:hash(p.afterStateHash),historyArchives,hostHistoryCuts,plannerVersion:'delete-choices-v1',merges:validateExchangeMerges(p.merges),attemptId:uuid(p.attemptId),deletions,resolution,decisionSourceHash:hash(p.decisionSourceHash)}
  for(const merge of provenance.merges){const side=byKey.get(merge.key);if(!side||side.local.kind!=='live'||side.local.hash!==merge.resultHash||side.beforeLocalHash!==merge.localHash||side.beforeRemoteHash!==merge.remoteHash)return publicationInvalid('删除选择receipt的无关live合并来源不符。')}
  if(request.operationId!==result.operationId||provenance.beforeManifestHash!==result.beforeManifestHash||provenance.afterManifestHash!==result.afterManifestHash||publicationJson(accepted.map(row=>row.key))!==publicationJson(result.acceptedKeys))return publicationInvalid('删除选择receipt结果闭集不符。')
  return {kind:'synced-exchange-operation',version:7,request,result,provenance}
}
