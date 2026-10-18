import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { assertConflictData, type ConflictPreviewComponent, type ConflictPreviewRecord, type SyncedExchangeConflictDecision } from './synced-exchange-conflict-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from './synced-publication-model'
import type { ExchangeComponent, ExchangeDeferredReason } from './synced-exchange-model'
import type { BothPrivateSelection } from './synced-exchange-both-model'
import type { SyncedBothOwnerSourceLinks, SyncedBothForkProof, SyncedBothLinkProjection, SyncedBothSourceComponent } from './synced-exchange-both-types'
import type { SyncedProtocol5Snapshot } from './synced-protocol5-model'
import type { TombstoneAcceptedSide, TombstoneBaselineEntry, TombstoneExchangePlan, TombstonePlanAuthority, TombstonePlanInput } from './synced-exchange-tombstone-types'

export interface KnowledgeDeletionReference {
  key: string; tombstoneHash: string; deletionOperationId: string; intentHash: string; proofHash: string; anchorId: string
}
export interface FixedDenial extends KnowledgeDeletionReference { baselineHash: string }
export interface KnowledgeComponentFence extends ExchangeComponent {
  componentId: string; mutableKeys: string[]; fixedDenialKeys: string[]; fixedDenials: FixedDenial[]
}
export interface KnowledgeSource {
  domain: 'synced-exchange.knowledge-selection.v1'
  databasePath: string; targetFingerprint: string; workspaceScope: string; recoveryEpoch: string
  sourceStateHash: string; localPhysicalManifestHash: string; localKnowledgeManifestHash: string
  deleted: KnowledgeDeletionReference[]; absentBaseline: TombstoneBaselineEntry[]
}
export interface KnowledgeAuthority extends TombstonePlanAuthority { deletionProofReferences: readonly KnowledgeDeletionReference[] }
export interface KnowledgePlanInput extends Omit<TombstonePlanInput, 'authority'> {
  authority: KnowledgeAuthority
  conflictSelections?: Array<{ preview: ConflictPreviewComponent; decision: SyncedExchangeConflictDecision }>
}
export interface KnowledgeComponentFacts {
  component: SyncedBothSourceComponent; fence: KnowledgeComponentFence
  componentFence: KnowledgeComponentFence; mutableKeys: string[]; fixedDenialKeys: string[]
  records: ConflictPreviewRecord[]; conflictedKeys: string[]
  selectedOriginal: SyncedProtocol5Snapshot | null; reason: ExchangeDeferredReason | null
}
export type KnowledgeLiveAcceptedSide = Omit<TombstoneAcceptedSide, 'local'> & { local: { kind: 'live'; hash: string } }
export interface KnowledgeConflictPlan extends Omit<TombstoneExchangePlan, 'plannerVersion' | 'deletions' | 'acceptedSides'> {
  plannerVersion: 'knowledge-conflicts-v1'; knowledgeSource: KnowledgeSource; knowledgeHash: string
  componentFences: KnowledgeComponentFence[]; acceptedSides: KnowledgeLiveAcceptedSide[]; conflictPreviews: ConflictPreviewComponent[]
}
export interface KnowledgeForkPlan extends Omit<KnowledgeConflictPlan, 'plannerVersion'> {
  plannerVersion: 'knowledge-forks-v1'; forks: SyncedBothForkProof[]; projections: SyncedBothLinkProjection[]
}
export type KnowledgeForkSelection = BothPrivateSelection
export type KnowledgeSourceLinks = SyncedBothOwnerSourceLinks[]
export interface KnowledgeForkPlanInput extends KnowledgePlanInput { bothSelections: BothPrivateSelection[]; sourceLinks: SyncedBothOwnerSourceLinks[] }

const same = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b)
function shape(value: unknown, fields: string[]): asserts value is Record<string, unknown> { assertConflictData(value); assertSyncedShape(value, fields) }
function string(value: unknown): string { return typeof value === 'string' ? value : publicationInvalid('knowledge字符串无效。') }
function opaque(value: unknown): string { return isSyncedBlockId(value) ? value : publicationInvalid('knowledge稳定身份无效。') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : publicationInvalid('knowledge UUID无效。') }
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : publicationInvalid('knowledge hash无效。') }
function key(value: unknown): string {
  const result = string(value)
  if (result === 'databases' || result.startsWith('doc:') && isSyncedBlockId(result.slice(4)) || result.startsWith('group:') && isSyncedUuid(result.slice(6))) return result
  return publicationInvalid('knowledge完整record key无效。')
}
function list<T>(value: unknown, read: (raw: unknown) => T): T[] {
  if (!Array.isArray(value)) return publicationInvalid('knowledge有限集合不是数组。')
  return value.map(read)
}
function ordered<T>(values: T[], identity: (row: T) => string): T[] {
  if (values.some((row, index) => index > 0 && publicationCompare(identity(values[index - 1]), identity(row)) >= 0)) return publicationInvalid('knowledge集合不唯一或未规范排序。')
  return values
}
export function validateKnowledgeDeletionReference(value: unknown): KnowledgeDeletionReference {
  shape(value, ['key', 'tombstoneHash', 'deletionOperationId', 'intentHash', 'proofHash', 'anchorId'])
  return { key: key(value.key), tombstoneHash: hash(value.tombstoneHash), deletionOperationId: uuid(value.deletionOperationId),
    intentHash: hash(value.intentHash), proofHash: hash(value.proofHash), anchorId: opaque(value.anchorId) }
}
function absentBaseline(value: unknown): TombstoneBaselineEntry {
  shape(value, ['key', 'local', 'remoteHash', 'commonHash', 'dependencyKeys', 'dependencySignature', 'acceptedOperationId'])
  shape(value.local, ['kind', 'tombstoneHash', 'deletionOperationId', 'intentHash'])
  if (value.local.kind !== 'absent') return publicationInvalid('knowledge原absence不得换成live或新删除。')
  const local = { kind: 'absent' as const, tombstoneHash: hash(value.local.tombstoneHash), deletionOperationId: uuid(value.local.deletionOperationId), intentHash: hash(value.local.intentHash) }
  const recordKey = key(value.key), dependencyKeys = ordered(list(value.dependencyKeys, key), item => item)
  const remoteHash = hash(value.remoteHash), commonHash = value.commonHash === null ? null : hash(value.commonHash)
  if (dependencyKeys.includes(recordKey) || remoteHash !== local.tombstoneHash || commonHash !== local.tombstoneHash) return publicationInvalid('knowledge原absent接受行的两侧知识不闭合。')
  return { key: recordKey, local, remoteHash, commonHash, dependencyKeys, dependencySignature: hash(value.dependencySignature), acceptedOperationId: uuid(value.acceptedOperationId) }
}
/** Pure historical preimage validation. No database, source handle, permit, or exchange-model runtime import. */
export function validateKnowledgeSource(value: unknown): KnowledgeSource {
  shape(value, ['domain', 'databasePath', 'targetFingerprint', 'workspaceScope', 'recoveryEpoch', 'sourceStateHash',
    'localPhysicalManifestHash', 'localKnowledgeManifestHash', 'deleted', 'absentBaseline'])
  if (value.domain !== 'synced-exchange.knowledge-selection.v1') return publicationInvalid('knowledge来源域不符。')
  const deleted = ordered(list(value.deleted, validateKnowledgeDeletionReference), row => row.key)
  const absent = ordered(list(value.absentBaseline, absentBaseline), row => row.key), references = new Map(deleted.map(row => [row.key, row]))
  if (new Set(deleted.map(row => row.anchorId)).size !== deleted.length) return publicationInvalid('knowledge多个key复用同一稳定denial anchor。')
  for (const row of absent) {
    const reference = references.get(row.key)
    if (row.local.kind !== 'absent' || !reference || reference.tombstoneHash !== row.local.tombstoneHash || reference.deletionOperationId !== row.local.deletionOperationId || reference.intentHash !== row.local.intentHash)
      return publicationInvalid('knowledge原absent行没有准确原proof来源。')
  }
  return { domain: 'synced-exchange.knowledge-selection.v1', databasePath: opaque(value.databasePath), targetFingerprint: hash(value.targetFingerprint),
    workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), sourceStateHash: hash(value.sourceStateHash),
    localPhysicalManifestHash: hash(value.localPhysicalManifestHash), localKnowledgeManifestHash: hash(value.localKnowledgeManifestHash), deleted, absentBaseline: absent }
}
export function knowledgeSourceHash(value: KnowledgeSource): string { return publicationHash(publicationJson(validateKnowledgeSource(value))) }
export function validateKnowledgeComponentFence(value: unknown): KnowledgeComponentFence {
  shape(value, ['keys', 'localSignature', 'remoteSignature', 'dependencySignature', 'componentId', 'mutableKeys', 'fixedDenialKeys', 'fixedDenials'])
  const keys = ordered(list(value.keys, key), item => item), mutableKeys = ordered(list(value.mutableKeys, key), item => item), fixedDenialKeys = ordered(list(value.fixedDenialKeys, key), item => item)
  const fixedDenials = ordered(list(value.fixedDenials, raw => {
    shape(raw, ['key', 'tombstoneHash', 'deletionOperationId', 'intentHash', 'proofHash', 'anchorId', 'baselineHash'])
    const { baselineHash, ...reference } = raw
    return { ...validateKnowledgeDeletionReference(reference), baselineHash: hash(baselineHash) }
  }), row => row.key)
  if (!keys.length || !same([...mutableKeys, ...fixedDenialKeys].sort(publicationCompare), keys) || new Set([...mutableKeys, ...fixedDenialKeys]).size !== keys.length || !same(fixedDenials.map(row => row.key), fixedDenialKeys))
    return publicationInvalid('knowledge mutable/fixed不是完整组件的准确partition。')
  return { keys, mutableKeys, fixedDenialKeys, fixedDenials, componentId: hash(value.componentId), localSignature: hash(value.localSignature),
    remoteSignature: hash(value.remoteSignature), dependencySignature: hash(value.dependencySignature) }
}
