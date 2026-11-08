import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedUuid, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { readHistoricalExactRows } from './synced-history-evidence-support'
import { hostEqual, hostHash } from './synced-host-journal'
import { hostJson, hostTime } from './synced-host-document-read'

type GroupIncarnation = Pick<SyncedGroupSnapshot, 'groupId' | 'creationId' | 'createdAt' | 'origin'>
export type OriginalHistoryRow = {
  id: string
  group_id: string
  position: number
  before_json: string
  after_json: string
  before_hash: string
  after_hash: string
  created_at: string
}

/** An immutable journal side is read as actual SQLite TEXT on the caller's
 * transaction. Both sides bind the same physical group incarnation and can
 * later serve as the basis of a metadata-only effective projection. */
export function readSyncedGroupHistoryOriginalOwned(db: Database.Database, group: GroupIncarnation, token: string, expectedPosition?: number) {
  const row = readHistoricalExactRows<OriginalHistoryRow>(db, 'synced_group_history',
    ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'],
    'id=? AND group_id=?', [token, group.groupId])[0]
  if (!row || expectedPosition !== undefined && row.position !== expectedPosition) return null
  return decodeSyncedGroupHistoryOriginal(group, row)
}

export function decodeSyncedGroupHistoryOriginal(group: GroupIncarnation, value: unknown) {
  assertSyncedShape(value, ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'])
  if (!isSyncedUuid(value.id) || value.group_id !== group.groupId || typeof value.before_json !== 'string'
    || typeof value.after_json !== 'string' || typeof value.before_hash !== 'string' || typeof value.after_hash !== 'string') {
    throw new Error('同步块历史原行形状无效。')
  }
  const row = value as OriginalHistoryRow
  const decode = (source: string, hash: string) => {
    const side = validateSyncedGroupWire(hostJson(source))
    if (hostHash(side) !== hash || side.id !== group.groupId || side.creationId !== group.creationId
      || side.createdAt !== group.createdAt || !hostEqual(side.origin, group.origin)) throw new Error('History semantic identity/hash mismatch')
    return side
  }
  try {
    if (!Number.isSafeInteger(row.position) || row.position < 1) throw new Error('History position invalid')
    hostTime(row.created_at)
    return { row, before: decode(row.before_json, row.before_hash), after: decode(row.after_json, row.after_hash) }
  } catch (cause) {
    throw new Error('同步块历史内容或校验值损坏，未恢复。', { cause })
  }
}
