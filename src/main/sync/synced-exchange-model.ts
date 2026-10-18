import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson, PUBLICATION_RECORD_MAX_BYTES,
  type PublicationAssetDescriptor, type PublicationObjectDescriptor } from './synced-publication-model'
import { validateConflictDecisions, validateExchangeResolutionBinding, validateExchangeMerges,
  type SyncedExchangeConflictDecision, type ExchangeResolutionBinding, type ExchangeMergeProvenance } from './synced-exchange-conflict-model'

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
export type ExchangeRequest = ExchangeRequestV1 | ExchangeResolveRequest
export interface SyncedExchangeAccepted {
  status: 'applied' | 'noop' | 'deferred'; operationId: string; replayed: boolean
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string
  beforeManifestHash: string; afterManifestHash: string; publishedKeys: string[]; appliedKeys: string[]; acceptedKeys: string[]
  deferred: DeferredExchangeComponent[]; acceptedAt: string
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
  plannerVersion?: 'conflicts-v1'; resolution?: ExchangeResolutionBinding | null; merges?: ExchangeMergeProvenance[]; attemptId?: string
}
export interface ExchangeHostCut {
  kind: 'synced-exchange-host-cut'; version: 1; operationId: string; historyToken: string; journalHash: string
  participants: Array<{ documentId: string; position: number }>; cutAt: string
}
export interface ExchangeReceipt {
  kind: 'synced-exchange-operation'; version: 1 | 2; request: ExchangeRequest; result: SyncedExchangeAccepted; provenance: ExchangeProvenance
}
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
export interface ExchangeJob {
  kind: 'synced-exchange-job'; version: 1 | 2; request: ExchangeRequest; requestHash: string
  attemptId: string; parentAttemptId: string | null; attemptIndex: number
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string; source: ExchangeSeedProof
  descriptor: ExchangePublicationDescriptor; components: ExchangeComponent[]; spoolHash: string; preparedAt: string
  plannerVersion?: 'conflicts-v1'; resolution?: ExchangeResolutionBinding | null
  merges?: ExchangeMergeProvenance[]
}
export type ExchangeJobPhase = 'prepared' | 'possible' | 'remote-confirmed' | 'settled' | 'remote-uncertain' | 'published-local-deferred'
export interface ExchangeJobPhaseFact {
  kind: 'synced-exchange-job-phase'; version: 1; operationId: string; requestHash: string; jobHash: string
  attemptId: string; sequence: number; previousFactHash: string | null
  phase: ExchangeJobPhase; remoteEtag: string | null; recordedAt: string
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
function versionedRoot(value: unknown, kind: string, fields: string[], extras: string[]): asserts value is Record<string, unknown> {
  assertExchangeData(value)
  const revision = value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  root(value, revision === 2 ? [...fields, ...extras] : fields)
  if (value.kind !== kind || (revision !== 1 && revision !== 2)) return publicationInvalid('exchange finite版本无效。')
}
function resolutionFor(request: ExchangeRequest, binding: ExchangeResolutionBinding | null): void {
  if (request.method === 'exchangeSyncedSnapshot') { if (binding !== null) return publicationInvalid('自动exchange不能借显式决定来源。'); return }
  if (!binding || binding.previewId !== request.previewId || binding.decisionsHash !== publicationHash(publicationJson(request.decisions)))
    return publicationInvalid('resolve完整原selectors与preview来源不闭合。')
}
export function validateExchangeRequest(value: unknown): ExchangeRequest {
  assertExchangeData(value)
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
  versionedRoot(value, 'synced-exchange-operation', ['kind', 'version', 'request', 'result', 'provenance'], [])
  const request = validateExchangeRequest(value.request), result = validateExchangeAccepted(value.result), p = value.provenance
  root(p, ['beforeManifestHash', 'afterManifestHash', 'beforeManifestEtag', 'afterManifestEtag', 'planHash', 'source', 'accepted', 'transfers', 'afterStateHash', 'historyArchives', 'hostHistoryCuts',
    ...(value.version === 2 ? ['plannerVersion', 'resolution', 'merges', 'attemptId'] : [])])
  const historyArchives = ordered(list(p.historyArchives, raw => { root(raw, ['groupId', 'indexHash']); return { groupId: uuid(raw.groupId), indexHash: hash(raw.indexHash) } }), row => row.groupId)
  // Execution history length has no wire-record count gate. This is a private finite index, not a new wire budget.
  const hostHistoryCuts = ordered(list(p.hostHistoryCuts, raw => { root(raw, ['historyToken', 'cutHash']); return { historyToken: uuid(raw.historyToken), cutHash: hash(raw.cutHash) } }, Number.MAX_SAFE_INTEGER), row => row.historyToken)
  const provenance: ExchangeProvenance = { beforeManifestHash: hash(p.beforeManifestHash), afterManifestHash: hash(p.afterManifestHash), beforeManifestEtag: opaque(p.beforeManifestEtag), afterManifestEtag: maybeString(p.afterManifestEtag), planHash: hash(p.planHash), afterStateHash: hash(p.afterStateHash), source: validateExchangeSeedProof(p.source), accepted: ordered(list(p.accepted, acceptedSide), row => row.key), transfers: ordered(list(p.transfers, validateExchangeTransfer), row => row.id), historyArchives, hostHistoryCuts }
  if (value.version === 1 && request.method !== 'exchangeSyncedSnapshot') return publicationInvalid('原v1不能伪成resolve。')
  if (value.version === 2) {
    if (p.plannerVersion !== 'conflicts-v1') return publicationInvalid('未知conflict planner。')
    provenance.plannerVersion = 'conflicts-v1'; provenance.resolution = validateExchangeResolutionBinding(p.resolution); provenance.merges = validateExchangeMerges(p.merges)
    provenance.attemptId = uuid(p.attemptId)
    resolutionFor(request, provenance.resolution)
    const accepted = new Map(provenance.accepted.map(row => [row.key, row]))
    for (const merge of provenance.merges) { const side = accepted.get(merge.key)
      if (!side || side.afterHash !== merge.resultHash || side.beforeLocalHash !== merge.localHash || side.beforeRemoteHash !== merge.remoteHash)
        return publicationInvalid('merge来源必须属于准确accepted结果。') }
  }
  if (request.operationId !== result.operationId || provenance.beforeManifestHash !== result.beforeManifestHash || provenance.afterManifestHash !== result.afterManifestHash || publicationJson(provenance.accepted.map(row => row.key)) !== publicationJson(result.acceptedKeys)) return publicationInvalid('exchange原收据没有准确闭合结果。')
  return { kind: 'synced-exchange-operation', version: value.version === 2 ? 2 : 1, request, result, provenance }
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
  versionedRoot(value, 'synced-exchange-job', ['kind', 'version', 'request', 'requestHash', 'attemptId', 'parentAttemptId', 'attemptIndex', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId', 'source', 'descriptor', 'components', 'spoolHash', 'preparedAt'], ['plannerVersion', 'resolution', 'merges'])
  const request = validateExchangeRequest(value.request), descriptor = validateExchangeDescriptor(value.descriptor), workspaceScope = uuid(value.workspaceScope), recoveryEpoch = uuid(value.recoveryEpoch)
  const attemptId = uuid(value.attemptId), parentAttemptId = value.parentAttemptId === null ? null : uuid(value.parentAttemptId), attemptIndex = integer(value.attemptIndex)
  if ((attemptIndex === 0) !== (parentAttemptId === null) || parentAttemptId === attemptId || descriptor.attemptId !== attemptId) return publicationInvalid('exchange原attempt父链无效。')
  if (exchangeRequestHash(request) !== value.requestHash || request.targetFingerprint !== descriptor.targetFingerprint || workspaceScope !== descriptor.workspaceScope || recoveryEpoch !== descriptor.recoveryEpoch) return publicationInvalid('exchange immutable job与原请求不闭合。')
  const components = ordered(list(value.components, validateExchangeComponent), row => publicationJson(row.keys)); disjoint(components)
  const result: ExchangeJob = { kind: 'synced-exchange-job', version: value.version === 2 ? 2 : 1, request, requestHash: hash(value.requestHash), attemptId, parentAttemptId, attemptIndex, workspaceScope, recoveryEpoch, remoteWorkspaceId: uuid(value.remoteWorkspaceId), source: validateExchangeSeedProof(value.source), descriptor, components, spoolHash: hash(value.spoolHash), preparedAt: time(value.preparedAt) }
  if (value.version === 1 && request.method !== 'exchangeSyncedSnapshot') return publicationInvalid('原v1 job不能伪成resolve。')
  if (value.version === 2) { if (value.plannerVersion !== 'conflicts-v1') return publicationInvalid('未知job planner。')
    result.plannerVersion = 'conflicts-v1'; result.resolution = validateExchangeResolutionBinding(value.resolution); result.merges = validateExchangeMerges(value.merges); resolutionFor(request, result.resolution) }
  return result
}
export function validateExchangeJobPhase(value: unknown): ExchangeJobPhaseFact {
  root(value, ['kind', 'version', 'operationId', 'requestHash', 'jobHash', 'attemptId', 'sequence', 'previousFactHash', 'phase', 'remoteEtag', 'recordedAt']); version(value, 'synced-exchange-job-phase')
  if (!phases.includes(value.phase as ExchangeJobPhase)) return publicationInvalid('exchange job phase未知。')
  const sequence = integer(value.sequence), previousFactHash = maybeHash(value.previousFactHash)
  if ((sequence === 0) !== (previousFactHash === null) || sequence === 0 && value.phase !== 'prepared') return publicationInvalid('exchange追加phase链无效。')
  return { kind: 'synced-exchange-job-phase', version: 1, operationId: uuid(value.operationId), requestHash: hash(value.requestHash), jobHash: hash(value.jobHash), attemptId: uuid(value.attemptId), sequence, previousFactHash, phase: value.phase as ExchangeJobPhase, remoteEtag: maybeString(value.remoteEtag), recordedAt: time(value.recordedAt) }
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
