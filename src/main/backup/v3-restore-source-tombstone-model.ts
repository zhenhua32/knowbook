import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { assertExchangeData } from '../sync/synced-exchange-model'
import { validateSyncedProtocol5Record } from '../sync/synced-protocol5-model'
import { publicationHash, publicationJson, validateInitialManifest5 } from '../sync/synced-publication-model'
import { requireStrongEtag } from '../sync/webdav-client'

type SourceIdentity = { sourceGroupId: string; sourceCreationId: string }
const invalid = (reason: string): never => { throw new Error('V3 恢复的 WebDAV 退场旁证无效：' + reason) }
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid('摘要格式错误。')
const canonicalHash = (value: unknown) => publicationHash(publicationJson(value))

function readManifestEvidence(value: unknown, head = false) {
  assertSyncedShape(value, head ? ['hash', 'manifest', 'etag'] : ['hash', 'manifest'])
  const hash = digest(value.hash), manifest = validateInitialManifest5(value.manifest)
  if (!manifest.history || !manifest.entries.databases || canonicalHash(manifest) !== hash
    || manifest.syncedInstances.some(row => manifest.entries['group:' + row.groupId] !== row.groupHash))
    return invalid('清单或引用的原字节与摘要不符。')
  return { hash, manifest, history: manifest.history }
}

function readRecordEvidence(value: unknown, key: string) {
  assertSyncedShape(value, ['hash', 'record'])
  const hash = digest(value.hash), record = validateSyncedProtocol5Record(value.record, key)
  if (canonicalHash(record) !== hash || canonicalHash(value.record) !== hash) return invalid('对象的原字节与摘要不符。')
  return { hash, record }
}

/** Verify the locally sealed canonical wire evidence, without connecting to WebDAV. */
export function validateV3RestoreSourceTombstoneEvidence(value: unknown, expected?: SourceIdentity) {
  assertExchangeData(value)
  assertSyncedShape(value, ['kind', 'version', 'key', 'targetFingerprint', 'workspace', 'remoteWorkspaceId',
    'seedManifestHash', 'acceptedManifestHash', 'closureHash', 'head', 'transition', 'tombstone', 'previous', 'executionAuthorized'], ['rejoinHash'])
  if (value.kind !== 'v3-restore-source-tombstone' || value.version !== 1 || value.executionAuthorized !== false
    || typeof value.key !== 'string' || !value.key.startsWith('group:') || !isSyncedUuid(value.key.slice(6))
    || !isSyncedUuid(value.remoteWorkspaceId)) return invalid('身份或版本错误。')
  assertSyncedShape(value.workspace, ['workspaceScope', 'recoveryEpoch'])
  if (!isSyncedUuid(value.workspace.workspaceScope) || !isSyncedUuid(value.workspace.recoveryEpoch)) return invalid('本机工作区身份错误。')
  for (const hash of [value.targetFingerprint, value.seedManifestHash, value.acceptedManifestHash, value.closureHash]) digest(hash)
  if (Object.hasOwn(value, 'rejoinHash')) digest(value.rejoinHash)

  assertSyncedShape(value.head, ['hash', 'manifest', 'etag'])
  const etag = typeof value.head.etag === 'string' ? value.head.etag : null
  requireStrongEtag(etag)
  assertSyncedShape(value.transition, ['before', 'deleted'])
  const head = readManifestEvidence(value.head, true), before = readManifestEvidence(value.transition.before)
  const deleted = readManifestEvidence(value.transition.deleted)
  const tombstone = readRecordEvidence(value.tombstone, value.key), previous = readRecordEvidence(value.previous, value.key)
  if ([head, before, deleted].some(row => row.manifest.workspaceId !== value.remoteWorkspaceId
    || row.history.targetFingerprint !== head.history.targetFingerprint))
    return invalid('远端工作区或历史目标不同。')
  const originalGroup = previous.record, removedGroup = tombstone.record
  if (removedGroup.kind !== 'synced-group-deleted' || originalGroup.kind !== 'synced-group'
    || removedGroup.creationId !== originalGroup.creationId || removedGroup.previousHash !== previous.hash
    || before.manifest.entries[value.key] !== previous.hash || deleted.history.previousHash !== before.hash
    || deleted.manifest.entries[value.key] !== tombstone.hash || head.manifest.entries[value.key] !== tombstone.hash
    || [deleted, head].some(row => row.manifest.syncedInstances.some(instance => instance.groupId === originalGroup.id)))
    return invalid('墓碑没有准确承接原组和直接前驱。')
  const { id: groupId, creationId } = originalGroup
  if (expected && (expected.sourceGroupId !== groupId || expected.sourceCreationId !== creationId)) return invalid('原组身份不同。')
  return { groupId, creationId, headHash: head.hash, etag }
}
