import { realpathSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { publicationCompare, publicationHash, publicationJson } from '../sync/synced-publication-model'
import { assertSyncedLifecycleSchema } from './synced-lifecycle-schema'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { hasAnySyncedObservationPending } from './synced-remote-observation-pending'
import { assertSyncedRemoteObservationRecords } from './synced-remote-observation-read'
import { readSyncedPersistentPublicationSnapshot } from './synced-publication'
import { assertSyncedBlockSchema } from './synced-schema'
import { restoreFail } from './restore-safety-model'

/** A local rejection-only capture, never a coverage proof or an installation permit. */
export interface RestoreKnowledgeCapture { readonly kind: 'restore-knowledge-capture' }
export interface RestoreKnowledgeDiagnostic {
  readonly schemaVersion: number
  readonly workspaceScope: string | null
  readonly recoveryEpoch: string | null
  readonly fingerprint: string
  readonly schemaHash: string
  readonly status: 'empty' | 'present' | 'unsupported'
  readonly reasons: readonly string[]
  readonly tables: readonly Readonly<{ name: string; rows: number; hash: string }>[]
  readonly metadata: readonly Readonly<{ key: string; updatedAt: string; hash: string }>[]
}
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null }
type Row = Record<string, unknown>
type Saved = { db: Database.Database; path: string; diagnostic: RestoreKnowledgeDiagnostic }
const captures = new WeakMap<RestoreKnowledgeCapture, Saved>()
const sync26 = ['synced_workspace_state', 'synced_groups', 'synced_group_blocks', 'synced_instances',
  'synced_operations', 'synced_group_history', 'synced_host_history', 'synced_host_history_documents',
  'synced_host_history_state', 'synced_group_pins']
const sync27 = ['synced_group_lifecycle', 'synced_group_retirements', 'synced_exposure_attempts', 'synced_group_exposure_members']
const watched = [...sync26, ...sync27, 'block_identities', 'document_block_routes', 'backup_restore_identities',
  'documents', 'blocks', 'document_history', 'document_trash', 'document_block_moves', 'document_templates',
  'databases', 'document_database_columns', 'database_saved_views', 'database_entities', 'database_entity_values',
  'document_database_values', 'links', 'app_settings']
const indexes26 = ['idx_synced_group_blocks_order', 'idx_synced_group_blocks_parent', 'idx_synced_instances_group',
  'idx_synced_instances_host', 'idx_synced_group_pins_owner']
const triggers26 = [
  ...['blocks', 'synced_group_blocks'].flatMap(table => ['insert_guard', 'insert', 'update_guard', 'delete']
    .map(action => `trg_synced_${table}_identity_${action}`)),
  'trg_synced_identity_delete', 'trg_synced_identity_id_update', 'trg_synced_blocks_owner_update',
  'trg_synced_group_blocks_owner_update', 'trg_synced_blocks_instance_update', 'trg_synced_blocks_leaf_insert',
  'trg_synced_blocks_leaf_update', ...['insert', 'update'].flatMap(action => [
    `trg_synced_identity_${action}_consistency`, `trg_synced_instance_${action}_guard`])
]
const triggers27 = ['lifecycle_insert_guard', 'lifecycle_update_guard', 'lifecycle_delete_guard',
  'lifecycle_group_identity', 'lifecycle_journal_update', 'retirement_insert_guard', 'retirement_update_guard',
  'retirement_delete_guard', 'lifecycle_canonical_insert', 'lifecycle_canonical_update', 'lifecycle_instance_insert',
  'lifecycle_instance_update', 'exposure_attempt_insert', 'exposure_attempt_update', 'exposure_attempt_delete',
  'exposure_member_insert', 'exposure_member_update', 'exposure_member_delete', 'exposure_member_mark_possible',
  'exposure_attempt_mark_confirmed'].map(name => 'trg_synced_' + name)
const namespace = (name: string): boolean => /^(?:synced_|idx_synced_|trg_synced_)/i.test(name)
const quoted = (name: string): string => '"' + name.replace(/"/g, '""') + '"'
const digest = (value: unknown): string => publicationHash(publicationJson(value))

function owned(db: Database.Database): void {
  if (!db.open || !db.inTransaction) return restoreFail('同步知识审计要求原 connection 的真实自有事务。')
}
function databasePath(db: Database.Database): string {
  if (db.name === ':memory:' || db.name === '') return db.name
  return realpathSync.native(db.name)
}
/** Preserve SQL storage classes and large integer bytes; JSON is only the hash encoding. */
function cell(value: unknown): unknown {
  if (value === null) return ['null']
  if (typeof value === 'string') return ['text', value]
  if (typeof value === 'bigint') return ['integer', value.toString()]
  if (typeof value === 'number' && Number.isFinite(value)) return ['real', Object.is(value, -0) ? '-0' : String(value)]
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('base64')]
  return restoreFail('同步知识原 SQL 值无法准确捕获。')
}
function tableFact(db: Database.Database, name: string): RestoreKnowledgeDiagnostic['tables'][number] {
  const columns = db.prepare('SELECT * FROM ' + quoted(name)).columns().map(column => column.name)
  // SQLite can contain TEXT that is not valid UTF-8. Hash its original bytes,
  // rather than the driver's replacement-character decoding. The explicit
  // storage class also keeps TEXT distinct from a BLOB with identical bytes.
  const projection = columns.flatMap(name => {
    const column = quoted(name)
    return [`typeof(${column})`, `CASE WHEN typeof(${column})='text' THEN CAST(${column} AS BLOB) ELSE ${column} END`]
  }).join(',')
  const statement = db.prepare('SELECT ' + projection + ' FROM ' + quoted(name)).safeIntegers(true).raw(true)
  const rows = (statement.all() as unknown[][]).map(row => publicationJson(row.map(cell))).sort(publicationCompare)
  return Object.freeze({ name, rows: rows.length, hash: digest({ columns, rows }) })
}
function hasReference(value: unknown): boolean {
  return Array.isArray(value) && value.some(block => block !== null && typeof block === 'object'
    && 'type' in block && block.type === 'synced-block')
}
function contentReference(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'blocks' in value && hasReference(value.blocks)
}
function historyReferences(db: Database.Database, present: Set<string>, version: number): string[] {
  const reasons: string[] = []
  const check = (table: string, column: string, contains: (value: unknown) => boolean): void => {
    if (!present.has(table)) return
    for (const row of db.prepare('SELECT ' + quoted(column) + ' AS source FROM ' + quoted(table)).all() as Array<{ source: unknown }>) {
      let value: unknown
      try {
        if (typeof row.source !== 'string') throw new Error('JSON 不是原字符串')
        value = JSON.parse(row.source)
      } catch (cause) {
        // The existing ordinary inspector owns legacy corruption policy. Do not add
        // a new template/history JSON restriction to schema 1–25 here.
        if (version < 26) continue
        throw new Error('普通历史原JSON损坏；不会当作同步知识为空：' + table + '.' + column, { cause })
      }
      if (contains(value)) { reasons.push('同步历史来源：' + table + '.' + column); break }
    }
  }
  check('document_history', 'content_json', contentReference)
  check('document_trash', 'snapshot_json', value => value !== null && typeof value === 'object'
    && 'content' in value && contentReference(value.content))
  for (const column of ['before_json', 'after_json']) check('document_block_moves', column, value => Array.isArray(value)
    && value.some(side => side !== null && typeof side === 'object' && 'content' in side && contentReference(side.content)))
  check('document_templates', 'blocks_json', hasReference)
  return reasons
}

function inspect(db: Database.Database): RestoreKnowledgeDiagnostic {
  owned(db)
  const schemaVersion: unknown = db.pragma('user_version', { simple: true })
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 27)
    return restoreFail('同步知识审计不支持该 schema 版本。')
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() as SchemaRow[]
  const present = new Set(schema.filter(row => row.type === 'table').map(row => row.name))
  const reasons: string[] = [], unsupported: string[] = []
  const expected = new Map<string, string>(schemaVersion < 26 ? [] : [
    ...sync26.map(name => [name, 'table'] as const), ...indexes26.map(name => [name, 'index'] as const),
    ...triggers26.map(name => [name, 'trigger'] as const), ...(schemaVersion >= 27 ? [
      ...sync27.map(name => [name, 'table'] as const), ['idx_synced_group_exposure_members_group', 'index'] as const,
      ...triggers27.map(name => [name, 'trigger'] as const)] : [])])
  for (const row of schema) if (namespace(row.name) && expected.get(row.name) !== row.type)
    unsupported.push('未知同步 namespace：' + row.type + ':' + row.name)
  let workspaceScope: string | null = null, recoveryEpoch: string | null = null
  if (schemaVersion >= 26) {
    assertSyncedBlockSchema(db)
    if ((db.pragma('foreign_key_check') as unknown[]).length) return restoreFail('同步知识原数据库外键不完整。')
    const state = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as Row | undefined
    if (!state || !isSyncedUuid(state.workspace_scope) || !isSyncedUuid(state.recovery_epoch)) return restoreFail('同步知识 scope/epoch 损坏。')
    workspaceScope = state.workspace_scope; recoveryEpoch = state.recovery_epoch
    if (schemaVersion >= 27) {
      assertSyncedLifecycleSchema(db)
      assertSyncedLogicalDeletionRecords(db)
      assertSyncedRemoteObservationRecords(db)
    }
  }
  for (const name of [...sync26.slice(1), ...sync27]) if (present.has(name)
    && db.prepare('SELECT 1 FROM ' + quoted(name) + ' LIMIT 1').get()) reasons.push('同步表非空：' + name)
  const physical = present.has('blocks') && Boolean(db.prepare("SELECT 1 FROM blocks WHERE type='synced-block' LIMIT 1").get())
  if (physical) reasons.push('真实正文含同步实例：blocks')
  let groupOwner = false
  if (present.has('block_identities')) for (const row of db.prepare('SELECT last_owner_kind,last_owner_id FROM block_identities').all() as Row[]) {
    if (row.last_owner_kind === 'group') groupOwner = true
    if (row.last_owner_kind === 'reserved' && typeof row.last_owner_id === 'string'
      && /^(?:sync5:|sync\.webdav\.protocol5|synced\.)/i.test(row.last_owner_id)) reasons.push('同步保留身份来源：' + row.last_owner_id)
  }
  if (groupOwner) reasons.push('仍保同步 owner 身份：block_identities')
  if (schemaVersion >= 26 && (physical || groupOwner || db.prepare('SELECT 1 FROM synced_groups LIMIT 1').get()
    || db.prepare('SELECT 1 FROM synced_instances LIMIT 1').get())) {
    if (schemaVersion >= 27) readSyncedPersistentPublicationSnapshot(db)
    else unsupported.push('尚不支持恢复 schema26 同步正文；不推定完整生命周期知识。')
  }
  reasons.push(...historyReferences(db, present, schemaVersion))
  const metadata: Array<RestoreKnowledgeDiagnostic['metadata'][number]> = []
  if (present.has('app_settings')) for (const row of db.prepare('SELECT key,value,updated_at FROM app_settings ORDER BY key').all() as Row[]) {
    if (typeof row.key !== 'string' || !/^(?:sync\.webdav\.protocol5|synced\.backup\.v3)/i.test(row.key)) continue
    if (typeof row.value !== 'string' || typeof row.updated_at !== 'string') return restoreFail('同步私有 metadata 原 SQL 列损坏。')
    metadata.push(Object.freeze({ key: row.key, updatedAt: row.updated_at, hash: digest(row) }))
    // Presence is captured exactly, but no generic validator can certify every
    // saved job/preview/backup format as installation authority in this slice.
    unsupported.push('尚不支持恢复同步私有 metadata：' + row.key)
  }
  const pending = hasAnySyncedObservationPending()
  if (pending) reasons.push('当前进程仍有未持久化的远端曝光拒绝份额。')
  const tables = [...new Set([...watched, ...schema.filter(row => row.type === 'table' && namespace(row.name)).map(row => row.name)])]
    .filter(name => present.has(name)).sort(publicationCompare).map(name => tableFact(db, name))
  const relevant = new Set(tables.map(table => table.name))
  const schemaHash = digest(schema.filter(row => relevant.has(row.tbl_name) || namespace(row.name)))
  const status = unsupported.length ? 'unsupported' as const : reasons.length ? 'present' as const : 'empty' as const
  const frozenReasons = Object.freeze([...new Set([...reasons, ...unsupported])].sort(publicationCompare))
  const facts = { schemaVersion, workspaceScope, recoveryEpoch, schemaHash, status, reasons: frozenReasons,
    tables: Object.freeze(tables), metadata: Object.freeze(metadata) }
  return Object.freeze({ ...facts, fingerprint: digest({ ...facts, pending }) })
}

/** Reads only the caller's real SQLite snapshot; never changes epoch, evidence or history. */
export function auditRestoreKnowledgeConnection(db: Database.Database): RestoreKnowledgeCapture {
  owned(db)
  const path = databasePath(db), diagnostic = inspect(db)
  const capture = Object.freeze({ kind: 'restore-knowledge-capture' as const })
  captures.set(capture, { db, path, diagnostic })
  return capture
}
export function readRestoreKnowledgeCapture(capture: RestoreKnowledgeCapture): RestoreKnowledgeDiagnostic | null {
  const saved = captures.get(capture)
  return saved?.db.open ? saved.diagnostic : null
}
/** A hash/diagnostic supplied by a caller is never accepted in place of the private capture. */
export function assertEmptyRestoreKnowledge(db: Database.Database, capture: RestoreKnowledgeCapture): void {
  owned(db)
  const saved = captures.get(capture)
  if (!saved || saved.db !== db || saved.path !== databasePath(db)) return restoreFail('不是本 connection／路径的原同步知识审计 capture。')
  const current = inspect(db)
  if (current.fingerprint !== saved.diagnostic.fingerprint) return restoreFail('原同步知识／历史审计快照已变化，必须重新审计。')
  if (current.status !== 'empty') return restoreFail('尚不支持恢复包含同步块正文或同步知识／历史的数据库：' + current.reasons.join('；'))
}
