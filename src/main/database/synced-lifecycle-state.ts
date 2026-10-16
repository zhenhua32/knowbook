import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedGroupWire, SyncedInstanceGuard } from '../../shared/synced-blocks'
import { validateSyncedInstanceGuard } from '../../shared/syncedBlockInputs'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'

export type SyncedLifecycleState = 'active' | 'retired-create'
export type SyncedExposureState = 'never' | 'unknown' | 'possible' | 'confirmed'
export interface SyncedGroupLifecycle {
  groupId: string
  creationId: string
  state: SyncedLifecycleState
  stateVersion: number
  exposure: SyncedExposureState
  createHistoryId: string | null
  activationRevision: string
  activationTopologyRevision: string
  activationHash: string
  activationInstances: SyncedInstanceGuard[]
}
type StateRow = {
  group_id: string; creation_id: string; state: string; state_version: number; exposure_state: string
  create_history_id: string | null; activation_revision: string; activation_topology_revision: string
  activation_hash: string; activation_instances_json: string; created_at: string; updated_at: string
}
type GroupRow = { id: string; creation_id: string; created_at: string; origin_json: string }
type RetirementRow = {
  group_id: string; creation_id: string; create_history_id: string; wire_json: string; semantic_hash: string; retired_at: string
}
const digestPattern = /^[a-f0-9]{64}$/
const encode = canonicalSyncedPortableJson
export const syncedLifecycleSemanticHash = (value: unknown): string => createHash('sha256').update(encode(value)).digest('hex')
const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
function refused(message: string): never { throw new Error(`同步块 schema27 生命周期无效：${message}；不会自动修复状态。`) }
function json(source: string): unknown {
  return parseStrictJson(source, { maxBytes: Math.max(1, Buffer.byteLength(source, 'utf8')), maxDepth: 32 })
}

/** Cheap coverage checks belong to every schema-27 startup and list operation.
 * Full frozen bodies and physical retirement invariants are checked only for
 * the requested real groups below, never by sweeping unrelated content. */
export function assertSyncedLifecycleCoverage(db: Database.Database): void {
  if (db.prepare(`SELECT 1 FROM synced_groups g LEFT JOIN synced_group_lifecycle l ON l.group_id=g.id
    WHERE l.group_id IS NULL OR l.creation_id IS NOT g.creation_id LIMIT 1`).get()
    || db.prepare(`SELECT 1 FROM synced_group_lifecycle l LEFT JOIN synced_groups g ON g.id=l.group_id
      LEFT JOIN synced_group_retirements r ON r.group_id=l.group_id
      WHERE g.id IS NULL OR l.creation_id IS NOT g.creation_id OR l.state NOT IN ('active','retired-create')
        OR typeof(l.state_version)<>'integer' OR l.state_version<1
        OR l.exposure_state NOT IN ('never','unknown','possible','confirmed')
        OR (l.exposure_state='never' AND l.create_history_id IS NULL)
        OR (l.state='retired-create' AND (r.group_id IS NULL OR l.exposure_state<>'never'
          OR l.create_history_id IS NULL OR r.creation_id IS NOT l.creation_id OR r.create_history_id IS NOT l.create_history_id))
        OR (l.state='active' AND r.group_id IS NOT NULL) LIMIT 1`).get()) {
    refused('真实组的状态行缺失、身份不匹配或 active／retired 定义不完整')
  }
}

function activationInstances(source: string): SyncedInstanceGuard[] {
  const value = json(source)
  if (!Array.isArray(value)) return refused('activation 使用者集合不是数组')
  const instances = value.map(validateSyncedInstanceGuard)
  if (new Set(instances.map(item => item.instanceId)).size !== instances.length) return refused('activation 使用者身份重复')
  return instances
}

function assertCreateJournal(db: Database.Database, group: GroupRow, historyId: string): void {
  const journal = db.prepare('SELECT action_json FROM synced_host_history WHERE id=?').get(historyId) as { action_json: string } | undefined
  if (!journal) refused('create journal 缺失')
  const action = json(journal.action_json), origin = json(group.origin_json)
  assertSyncedShape(action, ['kind', 'documentId', 'selectedRootIds', 'groupId', 'instanceId'])
  assertSyncedShape(origin, ['version', 'documentId', 'pathAtCreation', 'firstInstanceId'])
  if (action.kind !== 'create' || action.groupId !== group.id || action.documentId !== origin.documentId
    || action.instanceId !== origin.firstInstanceId || !isSyncedUuid(action.instanceId)
    || !Array.isArray(action.selectedRootIds) || !action.selectedRootIds.length
    || action.selectedRootIds.some(id => !isSyncedBlockId(id))
    || new Set(action.selectedRootIds).size !== action.selectedRootIds.length) {
    refused('create journal 不是该 incarnation 的原创建操作')
  }
}

function assertExposure(db: Database.Database, state: StateRow): void {
  const rows = db.prepare(`SELECT m.creation_id,m.revision,m.topology_revision,m.semantic_hash,
      a.id,a.request_hash,a.channel,a.target_fingerprint,a.publication_hash,a.state,a.created_at,a.confirmed_at
    FROM synced_group_exposure_members m LEFT JOIN synced_exposure_attempts a ON a.id=m.attempt_id
    WHERE m.group_id=?`).all(state.group_id) as Array<{
    creation_id: string; revision: string; topology_revision: string; semantic_hash: string; id: string | null
    request_hash: string; channel: string; target_fingerprint: string; publication_hash: string
    state: string; created_at: string; confirmed_at: string | null
  }>
  for (const row of rows) {
    if (row.creation_id !== state.creation_id || !isSyncedUuid(row.id) || !isSyncedUuid(row.revision)
      || !isSyncedUuid(row.topology_revision) || !digestPattern.test(row.semantic_hash)
      || !digestPattern.test(row.request_hash) || !digestPattern.test(row.target_fingerprint)
      || !digestPattern.test(row.publication_hash) || typeof row.channel !== 'string' || !row.channel.trim()
      || !validTime(row.created_at) || !['possible', 'confirmed'].includes(row.state)
      || (row.state === 'confirmed' ? !validTime(row.confirmed_at) : row.confirmed_at !== null)) {
      refused('曝光记录与当前 incarnation 或 attempt 不一致')
    }
  }
  const confirmed = rows.some(row => row.state === 'confirmed')
  if ((state.exposure_state === 'never' || state.exposure_state === 'unknown') && rows.length
    || state.exposure_state === 'possible' && (!rows.length || confirmed)
    || state.exposure_state === 'confirmed' && !confirmed) {
    refused('曝光状态与不可删除的真实发布记录不一致')
  }
}

function assertRetirement(db: Database.Database, group: GroupRow, state: StateRow, retirement: RetirementRow): void {
  if (retirement.group_id !== group.id || retirement.creation_id !== group.creation_id
    || retirement.create_history_id !== state.create_history_id || !validTime(retirement.retired_at)
    || !digestPattern.test(retirement.semantic_hash)) refused('冻结退役定义的身份或时间不一致')
  const wire: SyncedGroupWire = validateSyncedGroupWire(json(retirement.wire_json))
  if (wire.id !== group.id || wire.creationId !== group.creation_id || wire.createdAt !== group.created_at
    || encode(wire.origin) !== encode(json(group.origin_json))
    || syncedLifecycleSemanticHash(wire) !== retirement.semantic_hash
    || retirement.semantic_hash !== state.activation_hash) refused('冻结退役正文或 activation 的准确哈希不匹配')
  if (db.prepare('SELECT 1 FROM synced_group_blocks WHERE group_id=? LIMIT 1').get(group.id)
    || db.prepare('SELECT 1 FROM synced_instances WHERE group_id=? LIMIT 1').get(group.id)
    || db.prepare(`SELECT 1 FROM block_identities WHERE last_owner_kind='group' AND last_owner_id=? AND state='live' LIMIT 1`).get(group.id)
    || db.prepare('SELECT 1 FROM synced_group_pins WHERE group_id=? LIMIT 1').get(group.id)
    || db.prepare(`SELECT 1 FROM blocks WHERE type='synced-block'
      AND CASE WHEN json_valid(content) THEN json_extract(content,'$.groupId') ELSE NULL END=? LIMIT 1`).get(group.id)) {
    refused('retired-create 仍有实际 canonical、引用、存活身份或 pin')
  }
}

/** This reader never changes metadata and does not infer never from absence.
 * The complete W→A journal and inverse still belong to the structure writer;
 * this module only verifies the persistent lifecycle envelope and frozen wire. */
export function readSyncedGroupLifecycles(db: Database.Database, groupIds: readonly string[]): Map<string, SyncedGroupLifecycle> {
  const result = new Map<string, SyncedGroupLifecycle>()
  if (!groupIds.length) return result
  const encoded = JSON.stringify(groupIds)
  if (db.prepare(`SELECT 1 FROM synced_group_lifecycle l LEFT JOIN synced_groups g ON g.id=l.group_id
    WHERE l.group_id IN (SELECT value FROM json_each(?)) AND g.id IS NULL LIMIT 1`).get(encoded)) {
    refused('所请求组的生命周期失去稳定 group 行')
  }
  const groups = db.prepare(`SELECT id,creation_id,created_at,origin_json FROM synced_groups
    WHERE id IN (SELECT value FROM json_each(?))`).all(encoded) as GroupRow[]
  for (const group of groups) {
    const state = db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(group.id) as StateRow | undefined
    if (!state || state.creation_id !== group.creation_id || !isSyncedUuid(group.id) || !isSyncedUuid(group.creation_id)
      || !['active', 'retired-create'].includes(state.state) || !Number.isSafeInteger(state.state_version) || state.state_version < 1
      || !['never', 'unknown', 'possible', 'confirmed'].includes(state.exposure_state)
      || !isSyncedUuid(state.activation_revision) || !isSyncedUuid(state.activation_topology_revision)
      || !digestPattern.test(state.activation_hash) || !validTime(state.created_at) || !validTime(state.updated_at)
      || state.create_history_id !== null && !isSyncedUuid(state.create_history_id)) {
      refused('所请求真实组的生命周期行缺失或字段无效')
    }
    const instances = activationInstances(state.activation_instances_json)
    if (state.exposure_state === 'never' && state.create_history_id === null) refused('never 没有真实 create journal')
    if (state.create_history_id !== null) assertCreateJournal(db, group, state.create_history_id)
    assertExposure(db, state)
    const retirement = db.prepare('SELECT * FROM synced_group_retirements WHERE group_id=?').get(group.id) as RetirementRow | undefined
    if (state.state === 'retired-create') {
      if (!retirement || state.exposure_state !== 'never' || state.create_history_id === null) refused('退役状态缺少冻结定义或仍有可能曝光')
      assertRetirement(db, group, state, retirement)
    } else if (retirement) refused('active 组遗留退役定义')
    result.set(group.id, { groupId: group.id, creationId: group.creation_id, state: state.state as SyncedLifecycleState,
      stateVersion: state.state_version, exposure: state.exposure_state as SyncedExposureState,
      createHistoryId: state.create_history_id, activationRevision: state.activation_revision,
      activationTopologyRevision: state.activation_topology_revision, activationHash: state.activation_hash,
      activationInstances: instances })
  }
  return result
}
