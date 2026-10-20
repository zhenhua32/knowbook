import type Database from 'better-sqlite3'
import type { SyncedGroupListResult, SyncedGroupSnapshot, SyncedGroupSnapshotsResult, SyncedHistoryState,
  SyncedInstancePosition } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, parseSyncedBlockPayload, SYNCED_MAX_BLOCKS,
  SyncedValidationError, validateSyncedGroupSnapshot, validateSyncedHistoryState } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { assertSyncedLifecycleCoverage, readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { LOGICAL_DELETION_PREFIX } from '../sync/synced-logical-deletion-model'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'

type GroupRow = {
  id: string; creation_id: string; created_at: string; origin_json: string; bindings_json: string
  revision: string; topology_revision: string; history_cursor: string; history_position: number
  undo_token: string | null; redo_token: string | null; redo_position: number | null
}
type BlockRow = {
  id: string; group_id: string; parent_block_id: string | null; sort_order: number; type: string; content: string
  checked: number; depth: number; tags_json: string | null; language: string | null; list_start: number | null
  markdown_format_json: string | null; highlight: string | null; created_at: string
  identity_kind: string | null; identity_owner: string | null; identity_state: string | null; identity_created_at: string | null
  ordinary_collision: number
}
type InstanceRow = {
  instance_id: string; group_id: string; host_document_id: string; binding_version: string
  parent_block_id: string | null; depth: number; block_id: string | null; block_document_id: string | null
  block_parent_id: string | null; block_depth: number | null; block_type: string | null; block_content: string | null
  block_checked: number | null; block_language: string | null; block_list_start: number | null
  block_format: string | null; block_created_at: string | null; parent_type: string | null
  parent_document_id: string | null; parent_depth: number | null; host_exists: string | null
  identity_kind: string | null; identity_owner: string | null; identity_state: string | null; identity_created_at: string | null
  canonical_collision: number; has_children: number
}
type HistoryTail = { position: number; cursor: string; undoToken: string | null; redoToken: string | null; redoPosition: number | null }

function invalid(code: 'forest' | 'identity' | 'binding', message: string): never { throw new SyncedValidationError(code, message) }
function json(source: string): unknown {
  // Localized file URLs are not subject to the portable 5 MiB group budget.
  // Retain strict duplicate-key/depth validation without introducing a new cap.
  return parseStrictJson(source, { maxBytes: Math.max(1, Buffer.byteLength(source, 'utf8')), maxDepth: 32 })
}
function idsInput(value: unknown): string[] {
  assertSyncedShape(value, ['groupIds'])
  if (!Array.isArray(value.groupIds) || value.groupIds.length > SYNCED_MAX_BLOCKS) return invalid('identity', '同步组读取列表无效。')
  const ids = Array.from(value.groupIds, id => isSyncedUuid(id) ? id : invalid('identity', '同步组读取身份无效。'))
  return [...new Set(ids)]
}
function historyTail(tail: HistoryTail): SyncedHistoryState {
  if (!Number.isSafeInteger(tail.position) || tail.position < 0
    || tail.position > 0 && tail.undoToken === null
    || tail.position === 0 && tail.undoToken !== null
    || tail.redoPosition !== null && (tail.redoPosition !== tail.position + 1 || tail.redoToken === null)
    || tail.redoPosition === null && tail.redoToken !== null) {
    throw new Error('同步块历史位置与精确尾记录不一致；不会猜测可撤销版本。')
  }
  return validateSyncedHistoryState({ cursor: tail.cursor, undoToken: tail.undoToken, redoToken: tail.redoToken })
}
function workspaceScope(db: Database.Database): string {
  const state = db.prepare('SELECT workspace_scope FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: string } | undefined
  if (!state || !isSyncedUuid(state.workspace_scope)) throw new Error('持久同步块工作区身份缺失或无效。')
  return state.workspace_scope
}

function readGroups(db: Database.Database, ids: readonly string[]): Map<string, SyncedGroupSnapshot> {
  const deleted = (db.pragma('user_version', { simple: true }) as number) >= 27 ? assertSyncedLogicalDeletionRecords(db) : new Map()
  if (!ids.length) return new Map()
  const encoded = JSON.stringify(ids)
  const lifecycle = (db.pragma('user_version', { simple: true }) as number) >= 27
    ? readSyncedGroupLifecycles(db, ids) : null
  const groups = (db.prepare(`SELECT g.*,undo.id AS undo_token,redo.id AS redo_token,redo.position AS redo_position
    FROM synced_groups g
    LEFT JOIN synced_group_history undo ON undo.group_id=g.id AND undo.position=g.history_position
    LEFT JOIN synced_group_history redo ON redo.group_id=g.id AND redo.position=(
      SELECT min(next.position) FROM synced_group_history next WHERE next.group_id=g.id AND next.position>g.history_position)
    WHERE g.id IN (SELECT value FROM json_each(?))`).all(encoded) as GroupRow[])
    .filter(group => !deleted.has('group:' + group.id) && (lifecycle === null || lifecycle.get(group.id)?.state === 'active'))
  const existing = new Set(groups.map(group => group.id)), groupIds = JSON.stringify([...existing])
  // Forward joins alone cannot expose an extra live identity whose physical
  // canonical row disappeared or belongs to another group. Retained identities
  // are intentionally allowed to have no content row. Scope this check to the
  // requested groups, including a requested missing group with a stale owner.
  if (db.prepare(`SELECT 1 FROM block_identities i
    WHERE i.last_owner_kind='group' AND i.state='live'
      AND i.last_owner_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS(SELECT 1 FROM synced_group_blocks b WHERE b.id=i.id AND b.group_id=i.last_owner_id)
    LIMIT 1`).get(encoded)) return invalid('identity', '共享正文的存活身份缺少匹配的实际归属。')
  const blocks = db.prepare(`SELECT b.*,i.last_owner_kind AS identity_kind,i.last_owner_id AS identity_owner,
      i.state AS identity_state,i.created_at AS identity_created_at,
      EXISTS(SELECT 1 FROM blocks ordinary WHERE ordinary.id=b.id) AS ordinary_collision
    FROM synced_group_blocks b LEFT JOIN block_identities i ON i.id=b.id
    WHERE b.group_id IN (SELECT value FROM json_each(?)) ORDER BY b.group_id,b.sort_order,b.id`).all(groupIds) as BlockRow[]
  const byGroup = new Map<string, BlockRow[]>()
  for (const block of blocks) {
    if (block.identity_kind !== 'group' || block.identity_owner !== block.group_id || block.identity_state !== 'live'
      || block.identity_created_at !== block.created_at || block.ordinary_collision) return invalid('identity', '共享正文块与全局实际归属不一致。')
    const list = byGroup.get(block.group_id) ?? []
    if (!Number.isSafeInteger(block.sort_order) || block.sort_order < 0 || list.length && list[list.length - 1].sort_order >= block.sort_order) {
      return invalid('forest', '共享正文块的顺序无效或不唯一。')
    }
    if (block.checked !== 0 && block.checked !== 1) return invalid('forest', '共享正文块的勾选状态无效。')
    list.push(block); byGroup.set(block.group_id, list)
  }
  const rows = db.prepare(`SELECT i.*,b.id AS block_id,b.document_id AS block_document_id,
      b.parent_block_id AS block_parent_id,b.depth AS block_depth,b.type AS block_type,b.content AS block_content,
      b.checked AS block_checked,b.language AS block_language,b.list_start AS block_list_start,
      b.markdown_format_json AS block_format,b.created_at AS block_created_at,
      p.type AS parent_type,p.document_id AS parent_document_id,p.depth AS parent_depth,d.id AS host_exists,
      bi.last_owner_kind AS identity_kind,bi.last_owner_id AS identity_owner,bi.state AS identity_state,bi.created_at AS identity_created_at,
      EXISTS(SELECT 1 FROM synced_group_blocks child WHERE child.id=i.instance_id) AS canonical_collision,
      EXISTS(SELECT 1 FROM blocks child WHERE child.parent_block_id=i.instance_id) AS has_children
    FROM synced_instances i LEFT JOIN blocks b ON b.id=i.instance_id LEFT JOIN blocks p ON p.id=b.parent_block_id
    LEFT JOIN documents d ON d.id=i.host_document_id LEFT JOIN block_identities bi ON bi.id=i.instance_id
    WHERE i.group_id IN (SELECT value FROM json_each(?)) ORDER BY i.group_id,i.host_document_id,i.instance_id`).all(groupIds) as InstanceRow[]
  const registered = new Map<string, InstanceRow>(), positions = new Map<string, SyncedInstancePosition[]>()
  for (const row of rows) {
    if (row.block_id !== row.instance_id || row.block_document_id !== row.host_document_id || row.host_exists !== row.host_document_id
      || row.block_type !== 'synced-block' || row.block_parent_id !== row.parent_block_id || row.block_depth !== row.depth
      || row.block_content === null || parseSyncedBlockPayload(row.block_content).groupId !== row.group_id
      || row.block_checked !== 0 || row.block_language !== null || row.block_list_start !== null || row.block_format !== null || row.has_children
      || (row.depth === 0 ? row.parent_block_id !== null || row.parent_type !== null
        : row.parent_block_id === null || row.parent_type === null || row.parent_document_id !== row.host_document_id || row.parent_depth !== row.depth - 1)) {
      return invalid('binding', '同步引用登记与真实宿主叶块或父级不一致。')
    }
    if (row.identity_kind !== 'document' || row.identity_owner !== row.host_document_id || row.identity_state !== 'live'
      || row.identity_created_at !== row.block_created_at || row.canonical_collision) return invalid('identity', '同步实例与全局实际归属不一致。')
    registered.set(row.instance_id, row)
    const list = positions.get(row.group_id) ?? []
    list.push({ instanceId: row.instance_id, hostDocumentId: row.host_document_id, bindingVersion: row.binding_version,
      parentBlockId: row.block_parent_id, depth: row.depth, parentType: row.parent_type })
    positions.set(row.group_id, list)
  }
  // Registry-only enumeration could mislabel an unregistered real leaf as an
  // orphan. Check the reverse association for these exact requested groups.
  const leaves = db.prepare(`SELECT id,content FROM blocks WHERE type='synced-block' AND
    CASE WHEN json_valid(content) THEN json_extract(content,'$.groupId') ELSE NULL END IN (SELECT value FROM json_each(?))`)
    .all(groupIds) as Array<{ id: string; content: string }>
  for (const leaf of leaves) {
    const groupId = parseSyncedBlockPayload(leaf.content).groupId
    if (!registered.has(leaf.id) || registered.get(leaf.id)!.group_id !== groupId) {
      return invalid('binding', '真实同步引用缺少准确的实例登记。')
    }
  }
  const result = new Map<string, SyncedGroupSnapshot>()
  for (const group of groups) {
    const canonical = (byGroup.get(group.id) ?? []).map(block => ({
      id: block.id, type: block.type, content: block.content, checked: block.checked === 1, depth: block.depth,
      parentBlockId: block.parent_block_id, createdAt: block.created_at,
      ...(block.tags_json === null ? {} : { tags: json(block.tags_json) }),
      ...(block.language === null ? {} : { language: block.language }),
      ...(block.list_start === null ? {} : { listStart: block.list_start }),
      ...(block.markdown_format_json === null ? {} : { markdownFormat: json(block.markdown_format_json) }),
      ...(block.highlight === null ? {} : { highlight: block.highlight })
    }))
    const snapshot = validateSyncedGroupSnapshot({ groupId: group.id, creationId: group.creation_id, createdAt: group.created_at,
      revision: group.revision, topologyRevision: group.topology_revision, origin: json(group.origin_json), bindings: json(group.bindings_json),
      blocks: canonical, instances: positions.get(group.id) ?? [], history: historyTail({ position: group.history_position,
        cursor: group.history_cursor, undoToken: group.undo_token, redoToken: group.redo_token, redoPosition: group.redo_position }),
      maxRelativeDepth: canonical.reduce((maximum, block) => Math.max(maximum, block.depth), 0) })
    result.set(group.id, snapshot)
  }
  return result
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
