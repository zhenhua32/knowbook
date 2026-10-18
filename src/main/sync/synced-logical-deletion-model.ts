import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import type { SyncedGroupWire } from '../../shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../../shared/syncedBlockPortable'
import type { SyncDeletion } from './model'
import type { SyncedGroupDeletedWire } from '../../shared/synced-blocks'
import { assertExchangeData, exchangeRecordKey } from './synced-exchange-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from './synced-publication-model'
import { validateSyncedProtocol5Record } from './synced-protocol5-model'
import type { TombstoneDeletionIntent, TombstoneIdentityEffect, TombstoneProofReference } from './synced-exchange-tombstone-types'

export const LOGICAL_DELETION_PREFIX = 'synced:logical-deletion:v1:'
export const LOGICAL_DELETION_CHANNEL = 'logical-deletion-denial-v1'
export interface SyncedLogicalDeletionProof {
  kind: 'synced-logical-deletion-proof'; version: 1
  key: string; intentHash: string; baseLiveHash: string; tombstoneHash: string
  deletion: SyncDeletion | SyncedGroupDeletedWire
  before: SyncedPortableHostRecord | SyncedGroupWire
  identities: TombstoneIdentityEffect[]
  localBefore:
    | { kind: 'document'; documentId: string; createdAt: string; path: string; updatedAt: string; keyGuard: string }
    | { kind: 'group'; groupId: string; creationId: string; createdAt: string; origin: SyncedGroupWire['origin'];
        revision: string; topologyRevision: string; historyCursor: string; historyPosition: number; semanticHash: string; keyGuard: string }
  localAfter:
    | { kind: 'document'; documentId: string }
    | { kind: 'group'; groupId: string; revision: string; topologyRevision: string; historyCursor: string; historyPosition: 0 }
  source: { targetFingerprint: string; workspaceId: string; manifestHash: string; closureHash: string }
  scopeAtApply: { workspaceScope: string; recoveryEpoch: string }
  application: { operationId: string; requestHash: string; acceptedAt: string }
  persistence: { kind: 'logical-deletion-denial'; anchorId: string }
}
export interface SyncedLogicalDeletionOperationRow {
  client_operation_id: string; request_hash: string; result_json: string; created_at: string
}
const same = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b)
function shape(value: unknown, fields: string[]): asserts value is Record<string, unknown> { assertSyncedShape(value, fields) }
function opaque(value: unknown): string { return isSyncedBlockId(value) ? value : publicationInvalid('删除证明的稳定身份无效。') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : publicationInvalid('删除证明的UUID无效。') }
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : publicationInvalid('删除证明hash无效。') }
function date(value: unknown): string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : publicationInvalid('删除证明时间无效。') }
function integer(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : publicationInvalid('删除证明历史位置无效。') }
function sorted<T>(rows: T[], key: (row: T) => string): T[] {
  if (rows.some((row, i) => i > 0 && publicationCompare(key(rows[i - 1]), key(row)) >= 0)) return publicationInvalid('删除证明集合不唯一或未规范排序。')
  return rows
}
export function logicalDocumentDeletionKey(id: string): string { return LOGICAL_DELETION_PREFIX + 'doc:' + publicationJson(opaque(id)) }
export function logicalGroupDeletionKey(id: string, creationId: string): string { return LOGICAL_DELETION_PREFIX + 'group:' + uuid(id) + ':' + uuid(creationId) }
export function logicalDeletionAnchorId(before: SyncedPortableHostRecord | SyncedGroupWire): string {
  return before.kind === 'document' ? logicalDocumentDeletionKey(before.id) : logicalGroupDeletionKey(before.id, before.creationId)
}
function identityEffect(value: unknown): TombstoneIdentityEffect {
  shape(value, ['before', 'after']); shape(value.before, ['id', 'last_owner_kind', 'last_owner_id', 'state', 'created_at'])
  const row = value.before
  if (row.state !== 'live' || (row.last_owner_kind !== 'document' && row.last_owner_kind !== 'group')) return publicationInvalid('删除前identity不是真实live owner。')
  const before: TombstoneIdentityEffect['before'] = { id: opaque(row.id), last_owner_kind: row.last_owner_kind, last_owner_id: opaque(row.last_owner_id), state: 'live' as const, created_at: date(row.created_at) }
  if (row.last_owner_kind === 'group') uuid(row.last_owner_id)
  shape(value.after, value.after !== null && typeof value.after === 'object' && Object.getOwnPropertyDescriptor(value.after, 'kind')?.value === 'transferred'
    ? ['kind', 'ownerKind', 'ownerId', 'createdAt'] : ['kind'])
  if (value.after.kind === 'retained') return { before, after: { kind: 'retained' } }
  if (value.after.kind !== 'transferred' || (value.after.ownerKind !== 'document' && value.after.ownerKind !== 'group')) return publicationInvalid('删除identity后果不是准确retained/transfer。')
  const ownerId = value.after.ownerKind === 'group' ? uuid(value.after.ownerId) : opaque(value.after.ownerId)
  return { before, after: { kind: 'transferred', ownerKind: value.after.ownerKind, ownerId, createdAt: date(value.after.createdAt) } }
}
export function logicalDeletionIntentHash(intent: Omit<TombstoneDeletionIntent, 'intentHash'>, source: {
  operationId: string; workspaceScope: string; recoveryEpoch: string; targetFingerprint: string; remoteWorkspaceId: string
}): string {
  return publicationHash(publicationJson({ domain: 'synced-deletion-intent.v1', ...source, ...intent }))
}
/** Finite data only. It neither verifies a remote source nor grants persistence authority. */
export function validateSyncedLogicalDeletionProof(value: unknown): SyncedLogicalDeletionProof {
  assertExchangeData(value)
  shape(value, ['kind', 'version', 'key', 'intentHash', 'baseLiveHash', 'tombstoneHash', 'deletion', 'before', 'identities',
    'localBefore', 'localAfter', 'source', 'scopeAtApply', 'application', 'persistence'])
  if (value.kind !== 'synced-logical-deletion-proof' || value.version !== 1) return publicationInvalid('删除证明finite版本不符。')
  const key = exchangeRecordKey(value.key), before = validateSyncedProtocol5Record(value.before, key), deletion = validateSyncedProtocol5Record(value.deletion, key)
  if ((before.kind !== 'document' && before.kind !== 'synced-group') || (deletion.kind !== 'deleted' && deletion.kind !== 'synced-group-deleted')
    || (before.kind === 'document') !== (deletion.kind === 'deleted')) return publicationInvalid('删除证明必须准确对应同一doc/group前身。')
  const baseLiveHash = hash(value.baseLiveHash), tombstoneHash = hash(value.tombstoneHash), intentHash = hash(value.intentHash)
  if (publicationHash(publicationJson(before)) !== baseLiveHash || publicationHash(publicationJson(deletion)) !== tombstoneHash
    || deletion.kind === 'synced-group-deleted' && (before.kind !== 'synced-group' || deletion.creationId !== before.creationId || deletion.previousHash !== baseLiveHash))
    return publicationInvalid('删除证明前身/墓碑hash/creation不闭合。')
  if (!Array.isArray(value.identities)) return publicationInvalid('删除证明identity闭集不是数组。')
  const identities = sorted(value.identities.map(identityEffect), row => row.before.id), blocks = before.kind === 'document' ? before.content.blocks : before.blocks
  const identityById = new Map(identities.map(row => [row.before.id, row]))
  const canonicalBirths = new Map(before.kind === 'synced-group' ? before.blocks.map(row => [row.id, row.createdAt]) : [])
  if (identityById.size !== blocks.length) return publicationInvalid('删除证明identity不是全部原physical闭集。')
  for (const block of blocks) {
    const row = identityById.get(block.id)
    if (!row || row.before.last_owner_kind !== (before.kind === 'document' ? 'document' : 'group') || row.before.last_owner_id !== before.id
      || before.kind === 'synced-group' && row.before.created_at !== canonicalBirths.get(block.id))
      return publicationInvalid('删除证明identity原owner/birth不符。')
    if (row.after.kind === 'transferred' && row.after.ownerKind === row.before.last_owner_kind && row.after.ownerId === row.before.last_owner_id)
      return publicationInvalid('已删owner不能作为同事务transfer目的。')
  }
  let localBefore: SyncedLogicalDeletionProof['localBefore'], localAfter: SyncedLogicalDeletionProof['localAfter']
  if (before.kind === 'document') {
    shape(value.localBefore, ['kind', 'documentId', 'createdAt', 'path', 'updatedAt', 'keyGuard'])
    shape(value.localAfter, ['kind', 'documentId'])
    if (value.localBefore.kind !== 'document' || value.localAfter.kind !== 'document' || value.localBefore.documentId !== before.id
      || value.localAfter.documentId !== before.id || value.localBefore.createdAt !== before.createdAt || typeof value.localBefore.path !== 'string')
      return publicationInvalid('删除证明doc原birth/path或最终身份不符。')
    localBefore = { kind: 'document', documentId: before.id, createdAt: date(value.localBefore.createdAt), path: value.localBefore.path,
      updatedAt: date(value.localBefore.updatedAt), keyGuard: hash(value.localBefore.keyGuard) }
    localAfter = { kind: 'document', documentId: before.id }
  } else {
    shape(value.localBefore, ['kind', 'groupId', 'creationId', 'createdAt', 'origin', 'revision', 'topologyRevision', 'historyCursor', 'historyPosition', 'semanticHash', 'keyGuard'])
    shape(value.localAfter, ['kind', 'groupId', 'revision', 'topologyRevision', 'historyCursor', 'historyPosition'])
    const old = value.localBefore, next = value.localAfter
    if (old.kind !== 'group' || next.kind !== 'group' || old.groupId !== before.id || next.groupId !== before.id || old.creationId !== before.creationId
      || old.createdAt !== before.createdAt || !same(old.origin, before.origin) || next.historyPosition !== 0)
      return publicationInvalid('删除证明group full tuple不符。')
    localBefore = { kind: 'group', groupId: before.id, creationId: before.creationId, createdAt: before.createdAt, origin: before.origin,
      revision: uuid(old.revision), topologyRevision: uuid(old.topologyRevision), historyCursor: uuid(old.historyCursor), historyPosition: integer(old.historyPosition),
      semanticHash: hash(old.semanticHash), keyGuard: hash(old.keyGuard) }
    localAfter = { kind: 'group', groupId: before.id, revision: uuid(next.revision), topologyRevision: uuid(next.topologyRevision), historyCursor: uuid(next.historyCursor), historyPosition: 0 }
    if (localAfter.revision === localBefore.revision || localAfter.topologyRevision === localBefore.topologyRevision || localAfter.historyCursor === localBefore.historyCursor)
      return publicationInvalid('删除group未mint fresh实际CAS/history屏障。')
  }
  shape(value.source, ['targetFingerprint', 'workspaceId', 'manifestHash', 'closureHash'])
  shape(value.scopeAtApply, ['workspaceScope', 'recoveryEpoch'])
  shape(value.application, ['operationId', 'requestHash', 'acceptedAt'])
  shape(value.persistence, ['kind', 'anchorId'])
  const source = { targetFingerprint: hash(value.source.targetFingerprint), workspaceId: uuid(value.source.workspaceId), manifestHash: hash(value.source.manifestHash), closureHash: hash(value.source.closureHash) }
  const scopeAtApply = { workspaceScope: uuid(value.scopeAtApply.workspaceScope), recoveryEpoch: uuid(value.scopeAtApply.recoveryEpoch) }
  const application = { operationId: uuid(value.application.operationId), requestHash: hash(value.application.requestHash), acceptedAt: date(value.application.acceptedAt) }
  const anchorId = logicalDeletionAnchorId(before)
  if (value.persistence.kind !== 'logical-deletion-denial' || value.persistence.anchorId !== anchorId) return publicationInvalid('删除证明anchor不是准确稳定保留域。')
  const intent = { kind: before.kind === 'document' ? 'document' as const : 'group' as const, key, baseLiveHash, tombstoneHash, before, identities }
  if (logicalDeletionIntentHash(intent, { operationId: application.operationId, ...scopeAtApply, targetFingerprint: source.targetFingerprint, remoteWorkspaceId: source.workspaceId }) !== intentHash)
    return publicationInvalid('删除证明intentHash未认证原完整plan intent。')
  return { kind: 'synced-logical-deletion-proof', version: 1, key, intentHash, baseLiveHash, tombstoneHash, deletion, before, identities,
    localBefore, localAfter, source, scopeAtApply, application, persistence: { kind: 'logical-deletion-denial', anchorId } }
}
export function logicalDeletionRequestHash(proof: SyncedLogicalDeletionProof): string {
  return publicationHash(publicationJson({ domain: 'synced.logical-deletion.apply.v1', proof }))
}
export function logicalDeletionProofReference(proof: SyncedLogicalDeletionProof): TombstoneProofReference {
  return { key: proof.key, intentHash: proof.intentHash, proofHash: publicationHash(publicationJson(proof)), anchorId: proof.persistence.anchorId }
}
