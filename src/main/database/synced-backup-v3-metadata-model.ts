import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'

export interface SyncedBackupV3HistoricalMetadata {
  domain: 'synced-backup-v3-export.v1'
  snapshotId: string; destination: string; archiveHash: string; workspaceScope: string; recoveryEpoch: string
  fingerprint: string; members: Array<{ groupId: string; creationId: string; revision: string; topologyRevision: string; semanticHash: string }>
  createdAt: string
}
const invalid = (): never => publicationInvalid('V3 原导出metadata闭形或历史支持损坏。')
const uuid = (value: unknown): string => isSyncedUuid(value) ? value : invalid()
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : invalid()
export const syncedBackupV3HistoricalKey = (id: string): string => 'synced.backup.v3.' + uuid(id)
export function validateSyncedBackupV3HistoricalMetadata(value: unknown): SyncedBackupV3HistoricalMetadata {
  assertSyncedShape(value, ['domain', 'snapshotId', 'destination', 'archiveHash', 'workspaceScope', 'recoveryEpoch', 'fingerprint', 'members', 'createdAt'])
  if (value.domain !== 'synced-backup-v3-export.v1' || typeof value.destination !== 'string' || !Array.isArray(value.members)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return invalid()
  const members = value.members.map(raw => {
    assertSyncedShape(raw, ['groupId', 'creationId', 'revision', 'topologyRevision', 'semanticHash'])
    return { groupId: uuid(raw.groupId), creationId: uuid(raw.creationId), revision: uuid(raw.revision),
      topologyRevision: uuid(raw.topologyRevision), semanticHash: hash(raw.semanticHash) }
  })
  if (members.some((member, index) => index > 0 && publicationCompare(members[index - 1].groupId, member.groupId) >= 0)) return invalid()
  return { domain: value.domain, snapshotId: uuid(value.snapshotId), destination: value.destination, archiveHash: hash(value.archiveHash),
    workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), fingerprint: hash(value.fingerprint), members, createdAt: value.createdAt }
}
export const syncedBackupV3HistoricalRequestHash = (value: SyncedBackupV3HistoricalMetadata): string => publicationHash(publicationJson(value))
export const syncedBackupV3HistoricalTargetHash = (destination: string): string =>
  publicationHash(publicationJson({ domain: 'synced-backup-v3-destination.v1', destination }))
