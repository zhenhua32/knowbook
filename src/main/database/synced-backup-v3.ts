import type Database from 'better-sqlite3'
import type { DatabaseSavedView, DocumentDatabaseColumn, DocumentDatabaseColumnType, DocumentDatabaseFieldValue } from '../../shared/contracts'
import type { SyncedGroupSnapshot, SyncedGroupWire } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import type { ExportDocument, ExportStandaloneDatabase, ExportStandaloneDatabaseEntity } from './store'
import { readStrictHostDocument, hostJson, hostTime } from './synced-host-document-read'
import { assertSyncedBlockSchema } from './synced-schema'
import { assertSyncedLifecycleSchema } from './synced-lifecycle-schema'
import { readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from './synced-lifecycle-state'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { assertSyncedStoredBindings } from './synced-block-links'
import { strictSavedViewConfig, validateFieldValues } from '../backup/v2-format'
import { publicationCompare, publicationHash, publicationJson, publicationInvalid, frozenPublicationFacts, SyncedPublicationError } from '../sync/synced-publication-model'

/** Main-internal opaque capture. Its diagnostic DTO is never a caller permit. */
export interface SyncedBackupV3Capture { readonly kind: 'synced-backup-v3-capture' }
export interface SyncedBackupV3Snapshot {
  workspaceScope: string; recoveryEpoch: string; fingerprint: string
  documents: ExportDocument[]; catalog: ExportStandaloneDatabase; standaloneDatabases: ExportStandaloneDatabase[]
  groups: Array<{ wire: SyncedGroupWire; sourceRevision: string }>
  hosts: Array<{ id: string; parentId: string | null; sortOrder: number; createdAt: string }>
}
type Member = { groupId: string; creationId: string; revision: string; topologyRevision: string; semanticHash: string }
type Saved = { db: Database.Database; snapshot: SyncedBackupV3Snapshot; members: Member[]; claimed: null | {
  snapshotId: string; destination: string; archiveHash: string; requestHash: string; targetHash: string; createdAt: string
} }
const captures = new WeakMap<SyncedBackupV3Capture, Saved>()
const channel = 'backup-v3'
const metadataKey = (id: string): string => 'synced.backup.v3.' + id
type Row = Record<string, unknown>
const bad = (message: string): never => publicationInvalid('V3 原始数据库快照无效：' + message)
const text = (value: unknown): string => typeof value === 'string' ? value : bad('应为 TEXT')
const id = (value: unknown): string => isSyncedBlockId(value) ? value : bad('身份无效')
const integer = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : bad('排序非非负整数')
function outer(db: Database.Database): void {
  if (!db.open || db.readonly) throw new SyncedPublicationError('unavailable', 'V3 写出要求开放且可写的原 connection。')
  if (db.inTransaction) return bad('不接受调用方事务')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) return bad('外键未开启')
  if (db.pragma('user_version', { simple: true }) !== 27) throw new SyncedPublicationError('unsupported', 'V3 Main producer 仅接受已迁移的 schema27，不迁移或修复。')
}
function identity(db: Database.Database): { workspaceScope: string; recoveryEpoch: string } {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as Row | undefined
  if (!row || !isSyncedUuid(row.workspace_scope) || !isSyncedUuid(row.recovery_epoch)) return bad('workspace/recovery 身份损坏')
  return { workspaceScope: row.workspace_scope, recoveryEpoch: row.recovery_epoch }
}
const sortedRows = (db: Database.Database, table: string): Row[] => (db.prepare('SELECT * FROM ' + table).all() as Row[])
  .sort((a, b) => publicationCompare(publicationJson(a), publicationJson(b)))
function field(column: DocumentDatabaseColumn, value: unknown): DocumentDatabaseFieldValue {
  if (value === null) return null
  const source = text(value)
  const parsed = column.type === 'checkbox' ? source === 'true' ? true : source === 'false' ? false : bad('checkbox 原值无效')
    : column.type === 'multi-select' ? hostJson(source) : source
  return validateFieldValues({ [column.id]: parsed }, [column])[column.id]
}
function catalog(db: Database.Database, documents: ExportDocument[]): { catalog: ExportStandaloneDatabase; standaloneDatabases: ExportStandaloneDatabase[] } {
  const setting = db.prepare("SELECT value FROM app_settings WHERE key='database.defaultId'").get() as Row | undefined
  if (!setting) return bad('默认 catalog 配置缺失')
  const defaultId = id(setting.value), paths = new Map(documents.map(item => [item.id, item.path]))
  const databaseRows = sortedRows(db, 'databases'), columnRows = sortedRows(db, 'document_database_columns')
  const entityRows = sortedRows(db, 'database_entities'), viewRows = sortedRows(db, 'database_saved_views')
  const entityValueRows = sortedRows(db, 'database_entity_values'), documentValueRows = sortedRows(db, 'document_database_values')
  const sources = new Map<string, ExportStandaloneDatabase>(), columns = new Map<string, { databaseId: string; column: DocumentDatabaseColumn }>()
  const entities = new Map<string, { databaseId: string; entity: ExportStandaloneDatabaseEntity }>()
  for (const row of databaseRows) {
    const databaseId = id(row.id)
    if (sources.has(databaseId)) return bad('数据库 ID 重复')
    sources.set(databaseId, { id: databaseId, name: text(row.name), description: text(row.description),
      createdAt: hostTime(row.created_at), updatedAt: hostTime(row.updated_at), columns: [], savedViews: [], entities: [] })
  }
  const catalog = sources.get(defaultId)
  if (!catalog) return bad('默认 catalog 不是真实行')
  for (const row of columnRows) {
    const databaseId = id(row.database_id), owner = sources.get(databaseId), columnId = id(row.id), type = text(row.type)
    if (!owner || columns.has(columnId) || !['text', 'select', 'multi-select', 'date', 'checkbox'].includes(type)) return bad('字段类型或 owner 无效')
    const options = hostJson(text(row.options_json))
    if (!Array.isArray(options) || options.some(option => typeof option !== 'string') || new Set(options).size !== options.length
      || type !== 'select' && type !== 'multi-select' && options.length) return bad('字段原 options 无效')
    const column: DocumentDatabaseColumn = { id: columnId, name: text(row.name), type: type as DocumentDatabaseColumnType,
      options: options as string[], sortOrder: integer(row.sort_order) }
    hostTime(row.created_at); hostTime(row.updated_at)
    owner.columns.push(column); columns.set(columnId, { databaseId, column })
  }
  for (const row of entityRows) {
    const databaseId = id(row.database_id), owner = sources.get(databaseId), entityId = id(row.id)
    if (!owner || entities.has(entityId)) return bad('实体 owner 或 ID 无效')
    const documentId = row.document_id === null ? null : id(row.document_id)
    if (documentId !== null && !paths.has(documentId)) return bad('实体绑定了缺失文档')
    const entity: ExportStandaloneDatabaseEntity = { id: entityId, title: text(row.title), documentId,
      documentPath: documentId === null ? null : paths.get(documentId)!, createdAt: hostTime(row.created_at), updatedAt: hostTime(row.updated_at), fieldValues: Object.create(null) }
    owner.entities.push(entity); entities.set(entityId, { databaseId, entity })
  }
  // Legacy entity-backed rows are represented exactly, without running Store's migration/repair.
  const entityValues = (rows: Row[]): void => { for (const row of rows) {
    const owner = entities.get(id(row.entity_id)), source = columns.get(id(row.column_id))
    if (!owner || !source || source.databaseId !== owner.databaseId) return bad('实体值跨数据库或缺失 owner')
    hostTime(row.updated_at)
    const next = field(source.column, row.value_text), values = owner.entity.fieldValues
    if (Object.hasOwn(values, source.column.id) && publicationJson(values[source.column.id]) !== publicationJson(next)) return bad('两种实体值存储冲突')
    values[source.column.id] = next
  } }
  entityValues(entityValueRows)
  entityValues(documentValueRows.filter(row => row.entity_id !== null))
  const docById = new Map(documents.map(document => [document.id, document]))
  for (const row of documentValueRows) {
    if (row.entity_id !== null) {
      if (row.document_id !== null) {
        const owner = entities.get(id(row.entity_id))!
        if (owner.entity.documentId !== id(row.document_id)) return bad('旧实体值 document_id 与实体绑定不符')
      }
      continue
    }
    if (row.document_id === null) return bad('无文档/实体 owner 的孤立值不能无损表示为 V3 Export')
    const document = docById.get(id(row.document_id)), source = columns.get(id(row.column_id))
    if (!document || !source || source.databaseId !== defaultId) return bad('普通文档值不属于真实默认 catalog')
    hostTime(row.updated_at)
    document.documentDatabaseFieldValues[source.column.id] = field(source.column, row.value_text)
  }
  const viewNames = new Set<string>()
  for (const row of viewRows) {
    const databaseId = id(row.database_id), owner = sources.get(databaseId), name = text(row.name)
    if (!owner || row.config_version !== 1) return bad('saved view owner/version 无效')
    // Exact SQLite NOCASE semantics: ASCII folding stops at NUL, then compares UTF-8 byte length.
    const nul = name.indexOf('\0'), prefix = name.slice(0, nul < 0 ? name.length : nul).replace(/[A-Z]/g, char => char.toLowerCase())
    const nameKey = publicationJson([databaseId, prefix, Buffer.byteLength(name)])
    if (viewNames.has(nameKey)) return bad('saved view 名字重复')
    viewNames.add(nameKey)
    const legacy = { filterQuery: text(row.filter_query), filterScope: text(row.filter_scope), sortMode: text(row.sort_mode), viewMode: text(row.view_mode) }
    const config = strictSavedViewConfig(text(row.config_json), row.config_version, legacy)
    const view: DatabaseSavedView = { id: id(row.id), databaseId, name, ...legacy,
      sortMode: legacy.sortMode as DatabaseSavedView['sortMode'], viewMode: legacy.viewMode as DatabaseSavedView['viewMode'],
      config, configVersion: 1, sortOrder: integer(row.sort_order), createdAt: hostTime(row.created_at), updatedAt: hostTime(row.updated_at) }
    owner.savedViews.push(view)
  }
  for (const source of sources.values()) {
    source.columns.sort((a, b) => a.sortOrder - b.sortOrder || publicationCompare(a.id, b.id))
    source.savedViews.sort((a, b) => a.sortOrder - b.sortOrder || publicationCompare(a.id, b.id))
    source.entities.sort((a, b) => publicationCompare(a.id, b.id))
  }
  for (const document of documents) document.documentDatabaseColumns = catalog.columns.map(column => ({ ...column, options: [...column.options] }))
  return { catalog, standaloneDatabases: [...sources.values()].filter(source => source.id !== defaultId).sort((a, b) => publicationCompare(a.id, b.id)) }
}
function wire(snapshot: SyncedGroupSnapshot): SyncedGroupWire {
  return { kind: 'synced-group', id: snapshot.groupId, creationId: snapshot.creationId, createdAt: snapshot.createdAt,
    origin: snapshot.origin, bindings: snapshot.bindings, blocks: snapshot.blocks }
}
function snapshot(db: Database.Database): { snapshot: SyncedBackupV3Snapshot; members: Member[] } {
  if (!db.inTransaction) return bad('读取必须拥有一致事务')
  assertSyncedBlockSchema(db); assertSyncedLifecycleSchema(db)
  const foreignKeys = db.pragma('foreign_key_check')
  if (!Array.isArray(foreignKeys) || foreignKeys.length) return bad('真实 FK 损坏')
  const scope = identity(db), deleted = assertSyncedLogicalDeletionRecords(db)
  const documents: ExportDocument[] = [], hosts: SyncedBackupV3Snapshot['hosts'] = [], graphDocuments: Array<{ documentId: string; blocks: NonNullable<ReturnType<typeof readStrictHostDocument>>['content']['blocks'] }> = []
  for (const row of sortedRows(db, 'documents')) {
    const documentId = id(row.id), host = readStrictHostDocument(db, documentId)
    if (!host || deleted.has('doc:' + documentId)) return bad('真实宿主缺失或已有效删除')
    documents.push({ id: documentId, title: host.detail.title, path: host.detail.path, summary: host.detail.summary,
      updatedAt: host.detail.updatedAt, blocks: host.detail.blocks, documentDatabaseColumns: [], documentDatabaseFieldValues: Object.create(null) })
    hosts.push({ id: documentId, parentId: host.parentId, sortOrder: host.sortOrder, createdAt: host.createdAt })
    graphDocuments.push({ documentId, blocks: host.content.blocks })
  }
  const documentsById = new Map(documents.map(document => [document.id, document]))
  for (const host of hosts) {
    const document = documentsById.get(host.id)!, parent = host.parentId === null ? null : documentsById.get(host.parentId)
    if (!document.title || document.title !== document.title.trim() || /[/\\\x00-\x1f]/.test(document.title)
      || document.title === '.' || document.title === '..' || host.parentId !== null && !parent
      || document.path !== (parent ? parent.path + '/' : '') + document.title) return bad('原 parent/title/materialized path 不闭合')
  }
  const ids = sortedRows(db, 'synced_groups').map(row => isSyncedUuid(row.id) ? row.id : bad('组 ID 无效'))
  const groups: SyncedBackupV3Snapshot['groups'] = [], members: Member[] = [], instances = new Map<string, { groupId: string; hostDocumentId: string; bindingVersion: string; parentBlockId: string | null; depth: number }>()
  for (let from = 0; from < ids.length; from += SYNCED_MAX_BLOCKS) {
    const batch = ids.slice(from, from + SYNCED_MAX_BLOCKS), life = readSyncedGroupLifecycles(db, batch)
    const result = getSyncedGroupSnapshots(db, { groupIds: batch })
    if (result.workspaceScope !== scope.workspaceScope) return bad('组 scope 漂移')
    for (const item of result.items) {
      if (item.status !== 'ready') {
        if (!deleted.has('group:' + item.groupId) && life.get(item.groupId)?.state !== 'retired-create') return bad('活动组不可以 missing')
        continue
      }
      const group = wire(item.snapshot)
      assertSyncedStoredBindings(db, group.origin, group.blocks, group.bindings)
      groups.push({ wire: group, sourceRevision: item.snapshot.revision })
      members.push({ groupId: group.id, creationId: group.creationId, revision: item.snapshot.revision,
        topologyRevision: item.snapshot.topologyRevision, semanticHash: syncedLifecycleSemanticHash(group) })
      for (const instance of item.snapshot.instances) {
        if (instances.has(instance.instanceId)) return bad('实例 ID 重复')
        instances.set(instance.instanceId, { groupId: group.id, ...instance })
      }
    }
  }
  groups.sort((a, b) => publicationCompare(a.wire.id, b.wire.id)); members.sort((a, b) => publicationCompare(a.groupId, b.groupId))
  const graph = validateSyncedWorkspaceGraph(graphDocuments, groups.map(group => group.wire))
  const owners = sortedRows(db, 'block_identities').filter(row => row.state === 'live')
  if (owners.length !== graph.owners.size) return bad('全部实际 live owner 非完整物理闭集')
  for (const row of owners) {
    const owner = graph.owners.get(id(row.id))
    if (!owner || row.last_owner_kind !== owner.kind || row.last_owner_id !== owner.id) return bad('实际 owner 不匹配')
    hostTime(row.created_at)
  }
  const actualInstances = sortedRows(db, 'synced_instances')
  if (actualInstances.length !== instances.size) return bad('实例数不是真实叶闭集')
  for (const row of actualInstances) {
    const instance = instances.get(text(row.instance_id))
    if (!instance || row.group_id !== instance.groupId || row.host_document_id !== instance.hostDocumentId
      || row.binding_version !== instance.bindingVersion || row.parent_block_id !== instance.parentBlockId || row.depth !== instance.depth) return bad('实际实例绑定不匹配')
  }
  const catalogs = catalog(db, documents)
  documents.sort((a, b) => publicationCompare(a.id, b.id)); hosts.sort((a, b) => publicationCompare(a.id, b.id))
  // Raw source rows retain actual timestamps, birth, topology and history cursor. No MAX(updated_at) shortcut.
  const raw = Object.fromEntries(['documents', 'blocks', 'databases', 'document_database_columns', 'database_saved_views',
    'database_entities', 'database_entity_values', 'document_database_values', 'synced_groups', 'synced_group_blocks',
    'synced_instances', 'block_identities', 'synced_group_lifecycle', 'synced_group_retirements', 'synced_group_pins'].map(table => [table, sortedRows(db, table)]))
  const fingerprint = publicationHash(publicationJson({ ...scope, catalogId: catalogs.catalog.id, raw,
    deleted: [...deleted].map(([key, proof]) => [key, publicationHash(publicationJson(proof))]).sort(([a], [b]) => publicationCompare(a, b)) }))
  return { snapshot: { ...scope, fingerprint, documents, ...catalogs, groups, hosts }, members }
}
export function captureSyncedBackupV3(db: Database.Database): SyncedBackupV3Capture {
  outer(db)
  const read = db.transaction(() => snapshot(db))(), capture = Object.freeze({ kind: 'synced-backup-v3-capture' as const })
  captures.set(capture, { db, ...read, claimed: null }); return capture
}
export function readSyncedBackupV3Capture(capture: SyncedBackupV3Capture): SyncedBackupV3Snapshot | null {
  const saved = captures.get(capture); return saved ? frozenPublicationFacts(saved.snapshot) : null
}
function savedCapture(db: Database.Database, capture: SyncedBackupV3Capture): Saved {
  const saved = captures.get(capture)
  if (!saved || saved.db !== db) throw new SyncedPublicationError('unavailable', '不是原 connection 的真实 V3 capture。')
  const now = identity(db)
  if (now.workspaceScope !== saved.snapshot.workspaceScope || now.recoveryEpoch !== saved.snapshot.recoveryEpoch) throw new SyncedPublicationError('unavailable', 'V3 原 workspace/recovery 世代失效。')
  return saved
}
/** Only a real capture can commit exposure; all real current CAS members are read privately. */
export function claimSyncedBackupV3(db: Database.Database, capture: SyncedBackupV3Capture,
  input: { snapshotId: string; destination: string; archiveHash: string }): void {
  outer(db)
  assertSyncedShape(input, ['snapshotId', 'destination', 'archiveHash'])
  if (!isSyncedUuid(input.snapshotId) || typeof input.destination !== 'string' || !/^[a-f0-9]{64}$/.test(input.archiveHash)) return bad('claim 输入无效')
  db.transaction(() => {
    const saved = savedCapture(db, capture)
    if (saved.claimed) throw new SyncedPublicationError('unavailable', 'V3 capture 已消费，不覆盖或重分配。')
    const current = snapshot(db)
    if (current.snapshot.fingerprint !== saved.snapshot.fingerprint) throw new SyncedPublicationError('unavailable', 'V3 原完整快照在首文件前已变化。')
    const targetHash = publicationHash(publicationJson({ domain: 'synced-backup-v3-destination.v1', destination: input.destination }))
    const createdAt = new Date().toISOString(), body = { domain: 'synced-backup-v3-export.v1', ...input,
      workspaceScope: saved.snapshot.workspaceScope, recoveryEpoch: saved.snapshot.recoveryEpoch,
      fingerprint: saved.snapshot.fingerprint, members: saved.members, createdAt }
    const requestHash = publicationHash(publicationJson(body))
    if (db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(metadataKey(input.snapshotId))
      || db.prepare('SELECT 1 FROM synced_exposure_attempts WHERE id=?').get(input.snapshotId)) throw new SyncedPublicationError('unavailable', 'snapshotId 已使用。')
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(metadataKey(input.snapshotId), publicationJson(body), createdAt)
    if (saved.members.length) {
      db.prepare("INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,?,?,?,'possible',?,NULL)")
        .run(input.snapshotId, requestHash, channel, targetHash, input.archiveHash, createdAt)
      const insert = db.prepare('INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash) VALUES(?,?,?,?,?,?)')
      for (const member of saved.members) insert.run(input.snapshotId, member.groupId, member.creationId, member.revision, member.topologyRevision, member.semanticHash)
    }
    saved.claimed = { ...input, requestHash, targetHash, createdAt }
  }).immediate()
}
/** Confirmation is historical completion of the exact private claim, never a new write lease. */
export function confirmSyncedBackupV3(db: Database.Database, capture: SyncedBackupV3Capture): void {
  outer(db)
  db.transaction(() => {
    const saved = savedCapture(db, capture), claimed = saved.claimed
    if (!claimed) throw new SyncedPublicationError('unavailable', '没有原 V3 possible claim。')
    assertSyncedBlockSchema(db); assertSyncedLifecycleSchema(db)
    const metadata = db.prepare('SELECT value FROM app_settings WHERE key=?').get(metadataKey(claimed.snapshotId)) as { value: string } | undefined
    if (!metadata || publicationHash(metadata.value) !== claimed.requestHash) return bad('V3 原导出请求元数据损坏')
    if (!saved.members.length) return
    const row = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(claimed.snapshotId) as Row | undefined
    if (!row || row.channel !== channel || row.request_hash !== claimed.requestHash || row.target_fingerprint !== claimed.targetHash
      || row.publication_hash !== claimed.archiveHash || row.created_at !== claimed.createdAt || row.state !== 'possible' || row.confirmed_at !== null) return bad('V3 原 attempt 损坏')
    const members = db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=?').all(claimed.snapshotId) as Row[]
    const actual = members.map(member => ({ groupId: member.group_id, creationId: member.creation_id, revision: member.revision,
      topologyRevision: member.topology_revision, semanticHash: member.semantic_hash })).sort((a, b) => publicationCompare(text(a.groupId), text(b.groupId)))
    if (publicationJson(actual) !== publicationJson(saved.members)) return bad('V3 原成员闭集损坏')
    db.prepare("UPDATE synced_exposure_attempts SET state='confirmed',confirmed_at=? WHERE id=? AND state='possible'").run(new Date().toISOString(), claimed.snapshotId)
  }).immediate()
}
