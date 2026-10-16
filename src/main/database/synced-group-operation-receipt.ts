import type Database from 'better-sqlite3'
import type { SyncedGroupSaved } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedUuid, SyncedValidationError, validateSyncedGroupSnapshot } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'

export type SyncedGroupOperationRow = { client_operation_id: string; request_hash: string; result_json: string }

/** Transaction-neutral readers only. The caller owns the exact SQLite snapshot;
 * neither this module nor its decoder signs capabilities or writes a receipt. */
export function readSyncedGroupOperationRow(db: Database.Database, id: string): SyncedGroupOperationRow | undefined {
  return db.prepare('SELECT client_operation_id,request_hash,result_json FROM synced_operations WHERE client_operation_id=?')
    .get(id) as SyncedGroupOperationRow | undefined
}

export function validateSyncedOperationLookupInput(input: unknown): string {
  assertSyncedShape(input, ['clientOperationId'])
  if (!isSyncedUuid(input.clientOperationId)) throw new SyncedValidationError('identity', '同步块操作身份无效。')
  return input.clientOperationId
}

/** A future structure writer needs its own closed discriminant/codec. Unknown
 * result shapes cannot acquire group binding sources merely by having a snapshot. */
export function decodeSyncedGroupOperationAck(row: SyncedGroupOperationRow): SyncedGroupSaved {
  try {
    if (!isSyncedUuid(row.client_operation_id) || !/^[a-f0-9]{64}$/.test(row.request_hash)) throw new Error('Invalid receipt identity/hash')
    const value = parseStrictJson(row.result_json, { maxBytes: Math.max(1, Buffer.byteLength(row.result_json)), maxDepth: 32 })
    assertSyncedShape(value, ['status', 'operationId', 'snapshot', 'replayed'])
    if (value.status !== 'saved' && value.status !== 'noop' || value.operationId !== row.client_operation_id || value.replayed !== false) {
      throw new Error('Invalid stored group acknowledgement')
    }
    return { status: value.status, operationId: row.client_operation_id, snapshot: validateSyncedGroupSnapshot(value.snapshot), replayed: false }
  } catch (cause) { throw new Error('同步块操作收据损坏，不能猜测提交结果或重新执行。', { cause }) }
}
