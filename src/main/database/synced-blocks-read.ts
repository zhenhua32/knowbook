import type Database from 'better-sqlite3'
import type { SyncedGroupListResult, SyncedGroupSnapshotsResult, SyncedHistoryState } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { assertSyncedLifecycleCoverage } from './synced-lifecycle-state'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { LOGICAL_DELETION_PREFIX } from '../sync/synced-logical-deletion-model'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { readRawSyncedGroupSnapshotsOwned as readGroups, readRawSyncedWorkspaceScopeOwned as workspaceScope,
  decodeRawSyncedHistoryTail as historyTail } from './synced-blocks-raw-read'

function invalid(code: 'forest' | 'identity' | 'binding', message: string): never { throw new SyncedValidationError(code, message) }
function idsInput(value: unknown): string[] {
  assertSyncedShape(value, ['groupIds'])
  if (!Array.isArray(value.groupIds) || value.groupIds.length > SYNCED_MAX_BLOCKS) return invalid('identity', '同步组读取列表无效。')
  const ids = Array.from(value.groupIds, id => isSyncedUuid(id) ? id : invalid('identity', '同步组读取身份无效。'))
  return [...new Set(ids)]
}

/** Every result, including its namespace and instance positions, shares one SQLite snapshot. */
export function getSyncedGroupSnapshots(db: Database.Database, input: unknown): SyncedGroupSnapshotsResult {
  const ids = idsInput(input)
  return db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 27) assertSyncedRecoveryBoundaryRecords(db)
    const scope = workspaceScope(db), snapshots = readGroups(db, ids)
    return { workspaceScope: scope, items: ids.map(groupId => {
      const snapshot = snapshots.get(groupId)
      return snapshot ? { status: 'ready' as const, snapshot } : { status: 'missing' as const, groupId }
    }) }
  })()
}

export function listSyncedGroups(db: Database.Database, input: unknown): SyncedGroupListResult {
  assertSyncedShape(input, ['query', 'offset', 'limit'])
  if (typeof input.query !== 'string' || typeof input.offset !== 'number' || !Number.isSafeInteger(input.offset) || input.offset < 0
    || typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    return invalid('forest', '同步组搜索或分页参数无效。')
  }
  const { query, offset, limit } = input
  return db.transaction(() => {
    workspaceScope(db)
    const lifecycle = (db.pragma('user_version', { simple: true }) as number) >= 27
    if (lifecycle) assertSyncedRecoveryBoundaryRecords(db)
    if (lifecycle) assertSyncedLifecycleCoverage(db)
    if (lifecycle) assertSyncedLogicalDeletionRecords(db)
    // Use the same active predicate before count and pagination; filtering the
    // returned page afterward would leak totals and create short/empty pages.
    const active = lifecycle ? `EXISTS(SELECT 1 FROM synced_group_lifecycle l WHERE l.group_id=g.id AND l.state='active') AND
      NOT EXISTS(SELECT 1 FROM synced_operations o WHERE o.client_operation_id='${LOGICAL_DELETION_PREFIX}group:'||g.id||':'||g.creation_id) AND ` : ''
    const where = active + `(?='' OR instr(lower(json_extract(g.origin_json,'$.pathAtCreation')),lower(?))>0
      OR EXISTS(SELECT 1 FROM synced_group_blocks b WHERE b.group_id=g.id AND instr(lower(b.content),lower(?))>0))`
    const total = (db.prepare(`SELECT count(*) AS count FROM synced_groups g WHERE ${where}`).get(query, query, query) as { count: number }).count
    const page = db.prepare(`SELECT g.id FROM synced_groups g WHERE ${where} ORDER BY g.created_at DESC,g.id LIMIT ? OFFSET ?`)
      .all(query, query, query, limit, offset) as Array<{ id: string }>
    const snapshots = readGroups(db, page.map(row => row.id))
    return { total, items: page.map(({ id }) => {
      const snapshot = snapshots.get(id)
      if (!snapshot) throw new Error('同一读取事务中的同步组消失。')
      return { groupId: id, originPath: snapshot.origin.pathAtCreation, liveInstances: snapshot.instances.length,
        preview: snapshot.blocks.filter(block => !['columns', 'column', 'database-view'].includes(block.type))
          .map(block => block.content).join('\n').replace(/\s+/g, ' ').trim().slice(0, 200) }
    }) }
  })()
}

export function getSyncedHostHistory(db: Database.Database, input: unknown): SyncedHistoryState {
  assertSyncedShape(input, ['documentId'])
  if (!isSyncedBlockId(input.documentId)) return invalid('identity', '宿主文档身份无效。')
  return db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= 27) assertSyncedRecoveryBoundaryRecords(db)
    const row = db.prepare(`SELECT s.cursor,s.position,undo.id AS undo_token,redo.id AS redo_token,next_entry.position AS redo_position
      FROM synced_host_history_state s
      LEFT JOIN synced_host_history_documents current_entry ON current_entry.document_id=s.document_id AND current_entry.position=s.position
      LEFT JOIN synced_host_history undo ON undo.id=current_entry.history_id
      LEFT JOIN synced_host_history_documents next_entry ON next_entry.document_id=s.document_id AND next_entry.position=(
        SELECT min(future.position) FROM synced_host_history_documents future WHERE future.document_id=s.document_id AND future.position>s.position)
      LEFT JOIN synced_host_history redo ON redo.id=next_entry.history_id WHERE s.document_id=?`).get(input.documentId) as
      { cursor: string; position: number; undo_token: string | null; redo_token: string | null; redo_position: number | null } | undefined
    if (!row) throw new Error('宿主同步历史状态尚未初始化。')
    return historyTail({ cursor: row.cursor, position: row.position, undoToken: row.undo_token,
      redoToken: row.redo_token, redoPosition: row.redo_position })
  })()
}
