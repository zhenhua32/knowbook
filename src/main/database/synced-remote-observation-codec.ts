import { createHash } from 'node:crypto'
import type { SyncedOriginV1 } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedUuid, validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { parseStrictJson } from '../../shared/strictJson'

export const SYNCED_OBSERVATION_PREFIX = 'synced:remote-exposure-observation:v1:'
export const SYNCED_OBSERVATION_CHANNEL = 'webdav-manifest5-observed'
export const SYNCED_RETIRED_OBSERVATION_CHANNEL = 'webdav-manifest5-retired-observation-anchor'
export interface SyncedObservedIncarnation { groupId: string; creationId: string; createdAt: string; origin: SyncedOriginV1 }
export interface SyncedObservationRemote {
  channel: typeof SYNCED_OBSERVATION_CHANNEL
  targetFingerprint: string; remoteWorkspaceId: string; manifestHash: string; groupHash: string; closureHash: string
}
type ActiveLocal = { state: 'active'; revision: string; topologyRevision: string; semanticHash: string; createHistoryId: string | null }
type RetiredLocal = { state: 'retired-create'; revision: string; topologyRevision: string; semanticHash: string; createHistoryId: string; retiredAt: string; retirementHash: string }
type Base = { kind: 'synced-remote-exposure-observation'; version: 1; workspaceScope: string; recoveryEpoch: string;
  incarnation: SyncedObservedIncarnation; remote: SyncedObservationRemote; observedAt: string }
export type SyncedRemoteObservationMarker = Base & (
  { local: ActiveLocal; persistence: { kind: 'active-confirmed'; attemptId: string } }
  | { local: RetiredLocal; persistence: { kind: 'retired-disabled'; anchorId: string } }
)
export interface SyncedObservationOperationRow { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
export const observationJson = canonicalSyncedPortableJson
export const observationHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export function observationCorrupt(message: string): never { throw new Error('同步块远端观察证据损坏：' + message + '；不会忽略或重建曝光事实。') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : observationCorrupt('UUID 无效') }
function digest(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : observationCorrupt('hash 无效') }
function date(value: unknown): string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : observationCorrupt('日期无效') }
export function validateObservedIncarnation(value: unknown): SyncedObservedIncarnation {
  assertSyncedShape(value, ['groupId', 'creationId', 'createdAt', 'origin'])
  return { groupId: uuid(value.groupId), creationId: uuid(value.creationId), createdAt: date(value.createdAt), origin: validateSyncedOrigin(value.origin) }
}
export function observationKey(value: Pick<SyncedObservedIncarnation, 'groupId' | 'creationId'>): string {
  return SYNCED_OBSERVATION_PREFIX + uuid(value.groupId) + ':' + uuid(value.creationId)
}
export function sameObservedIncarnation(left: SyncedObservedIncarnation, right: SyncedObservedIncarnation): boolean {
  return observationJson(left) === observationJson(right)
}
export function validateRemoteObservationMarker(value: unknown): SyncedRemoteObservationMarker {
  assertSyncedShape(value, ['kind', 'version', 'workspaceScope', 'recoveryEpoch', 'incarnation', 'remote', 'local', 'persistence', 'observedAt'])
  if (value.kind !== 'synced-remote-exposure-observation' || value.version !== 1) return observationCorrupt('不是原有限 namespace')
  const incarnation = validateObservedIncarnation(value.incarnation)
  const base = { kind: 'synced-remote-exposure-observation' as const, version: 1 as const, workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), incarnation, observedAt: date(value.observedAt) }
  assertSyncedShape(value.remote, ['channel', 'targetFingerprint', 'remoteWorkspaceId', 'manifestHash', 'groupHash', 'closureHash'])
  if (value.remote.channel !== SYNCED_OBSERVATION_CHANNEL) return observationCorrupt('远端请求域不符')
  const remote: SyncedObservationRemote = { channel: SYNCED_OBSERVATION_CHANNEL, targetFingerprint: digest(value.remote.targetFingerprint), remoteWorkspaceId: uuid(value.remote.remoteWorkspaceId), manifestHash: digest(value.remote.manifestHash), groupHash: digest(value.remote.groupHash), closureHash: digest(value.remote.closureHash) }
  assertSyncedShape(value.local, ['state', 'revision', 'topologyRevision', 'semanticHash', 'createHistoryId'], ['retiredAt', 'retirementHash'])
  const revision = uuid(value.local.revision), topologyRevision = uuid(value.local.topologyRevision), semanticHash = digest(value.local.semanticHash)
  if (value.local.state === 'active') {
    assertSyncedShape(value.local, ['state', 'revision', 'topologyRevision', 'semanticHash', 'createHistoryId'])
    assertSyncedShape(value.persistence, ['kind', 'attemptId'])
    if (value.persistence.kind !== 'active-confirmed') return observationCorrupt('active 证明分支不符')
    return { ...base, remote, local: { state: 'active', revision, topologyRevision, semanticHash, createHistoryId: value.local.createHistoryId === null ? null : uuid(value.local.createHistoryId) }, persistence: { kind: 'active-confirmed', attemptId: uuid(value.persistence.attemptId) } }
  }
  assertSyncedShape(value.local, ['state', 'revision', 'topologyRevision', 'semanticHash', 'createHistoryId', 'retiredAt', 'retirementHash'])
  assertSyncedShape(value.persistence, ['kind', 'anchorId'])
  if (value.local.state !== 'retired-create' || value.persistence.kind !== 'retired-disabled' || value.persistence.anchorId !== observationKey(incarnation)) return observationCorrupt('retired 锚分支不符')
  return { ...base, remote, local: { state: 'retired-create', revision, topologyRevision, semanticHash, createHistoryId: uuid(value.local.createHistoryId), retiredAt: date(value.local.retiredAt), retirementHash: digest(value.local.retirementHash) }, persistence: { kind: 'retired-disabled', anchorId: observationKey(incarnation) } }
}
export function observationRequestHash(value: SyncedRemoteObservationMarker): string {
  return observationHash(observationJson({ method: 'observeSyncedRemoteExposure', proof: value }))
}
export function decodeRemoteObservationMarker(row: SyncedObservationOperationRow): SyncedRemoteObservationMarker {
  try {
    const value = validateRemoteObservationMarker(parseStrictJson(row.result_json, { maxBytes: 16 * 1024 * 1024, maxDepth: 32 }))
    if (row.client_operation_id !== observationKey(value.incarnation) || row.request_hash !== observationRequestHash(value)
      || row.created_at !== value.observedAt || row.result_json !== observationJson(value)) return observationCorrupt('行/key/完整规范原件不符')
    return value
  } catch (cause) { throw new Error('同步块远端观察收据损坏，不能当作 missing。', { cause }) }
}
