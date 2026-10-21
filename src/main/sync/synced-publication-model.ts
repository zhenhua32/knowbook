import { createHash } from 'node:crypto'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, parseSyncedBlockPayload,
  SYNCED_MAX_BLOCKS, validateSyncedGroupWire, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { canonicalSyncedPortableJson, measureSyncedPortableGroup, measureSyncedPortableHost,
  parseSyncedPortableAssetUri, rewriteSyncedGroupAssets, rewriteSyncedPortableHostAssets,
  type SyncedPortableHostRecord } from '../../shared/syncedBlockPortable'
import { validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { parseDatabaseViewPayload, mapDatabaseViewReferences, serializeDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { parseStrictJson } from '../../shared/strictJson'
import { SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncDatabases, type SyncRow, type SyncTable } from './model'
import { collectSyncedBindingOccurrences } from './synced-binding-occurrences'

export const PUBLICATION_RECORD_MAX_BYTES = 16 * 1024 * 1024
export type SyncedPublicationErrorCode = 'invalid' | 'unsupported' | 'unavailable' | 'asset' | 'spool' | 'transport' | 'database'
export class SyncedPublicationError extends Error {
  constructor(readonly code: SyncedPublicationErrorCode, message: string, cause?: unknown) {
    super('同步组初始发布：' + message, cause === undefined ? undefined : { cause })
    this.name = 'SyncedPublicationError'
  }
}
export function publicationInvalid(message: string): never { throw new SyncedPublicationError('invalid', message) }
export const publicationJson = canonicalSyncedPortableJson
export const publicationHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export function frozenPublicationFacts<T>(value: T): T {
  const clone = JSON.parse(publicationJson(value)) as T
  function freeze(item: unknown): void {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item) }
  }
  freeze(clone); return clone
}
function string(value: unknown): string { return typeof value === 'string' ? value : publicationInvalid('字符串字段无效。') }
function id(value: unknown): string { return isSyncedBlockId(value) ? value : publicationInvalid('稳定身份无效。') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : publicationInvalid('UUID 身份无效。') }
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : publicationInvalid('内容哈希无效。') }
function integer(value: unknown, min = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : publicationInvalid('整数范围无效。')
}
function time(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : publicationInvalid('持久日期无效。')
}
function array<T>(value: unknown, read: (value: unknown) => T, max = SYNCED_MAX_BLOCKS): T[] {
  if (!Array.isArray(value) || value.length > max) return publicationInvalid('数组或原条目门槛无效。')
  return value.map(read)
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) return publicationInvalid('精确闭集中出现重复身份。')
  return items
}
export const publicationCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const physicalKey = (value: { blockId: string; from: number; to: number; raw: string; syntax: string }): string =>
  publicationJson([value.blockId, value.from, value.to, value.raw, value.syntax])

export type InitialPublicationRecord = SyncedPortableHostRecord | SyncDatabases | SyncedGroupWire
export interface SyncedInitialManifest5 {
  version: 5
  workspaceId: string
  entries: Record<string, string>
  syncedInstances: Array<{ documentId: string; instanceId: string; groupId: string; groupHash: string }>
}
export interface PublicationObjectDescriptor { key: string; path: string; hash: string; bytes: number }
export interface PublicationAssetDescriptor { path: string; hash: string; bytes: number; names: string[] }
export interface PublicationMember {
  groupId: string; creationId: string; revision: string; topologyRevision: string; semanticHash: string; portableHash: string
}
export interface PublicationDescriptor {
  kind: 'synced-publication'; version: 1; channel: 'webdav-manifest5'
  workspaceScope: string; recoveryEpoch: string; targetFingerprint: string; localFingerprint: string
  manifest: { path: 'manifest.json'; hash: string; bytes: number }
  objects: PublicationObjectDescriptor[]; assets: PublicationAssetDescriptor[]; members: PublicationMember[]
}
export interface ValidatedInitialSnapshot {
  manifest: SyncedInitialManifest5
  records: Array<{ key: string; record: InitialPublicationRecord }>
  assetNames: Map<string, Set<string>>
}
export function publicationRecordKey(record: InitialPublicationRecord): string {
  return record.kind === 'synced-group' ? 'group:' + record.id : record.kind === 'databases' ? 'databases' : 'doc:' + record.id
}
export function decodePublicationJson(bytes: Uint8Array, maxBytes = PUBLICATION_RECORD_MAX_BYTES): unknown {
  try {
    const source = Buffer.from(bytes).toString('utf8'), value = parseStrictJson(source, { maxBytes, maxDepth: 32 })
    if (!Buffer.from(publicationJson(value)).equals(Buffer.from(bytes))) return publicationInvalid('数据不是准确规范 UTF-8 JSON 原字节。')
    return value
  } catch (cause) {
    if (cause instanceof SyncedPublicationError) throw cause
    throw new SyncedPublicationError('invalid', 'JSON 原字节或资源限制无效。', cause)
  }
}
export function validateInitialManifest5(value: unknown): SyncedInitialManifest5 {
  assertSyncedShape(value, ['version', 'workspaceId', 'entries', 'syncedInstances'])
  if (value.version !== 5) return publicationInvalid('不是 Manifest5。')
  const workspaceId = uuid(value.workspaceId)
  if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return publicationInvalid('entries 不是闭集对象。')
  const entries = Object.entries(value.entries)
  if (entries.length > SYNCED_MAX_BLOCKS) return publicationInvalid('entries 超过原门槛。')
  for (const [key, digest] of entries) {
    if (key !== 'databases' && !(key.startsWith('doc:') && isSyncedBlockId(key.slice(4)))
      && !(key.startsWith('group:') && isSyncedUuid(key.slice(6)))) return publicationInvalid('未知记录键。')
    hash(digest)
  }
  const syncedInstances = unique(array(value.syncedInstances, raw => {
    assertSyncedShape(raw, ['documentId', 'instanceId', 'groupId', 'groupHash'])
    return { documentId: id(raw.documentId), instanceId: uuid(raw.instanceId), groupId: uuid(raw.groupId), groupHash: hash(raw.groupHash) }
  }), item => item.instanceId)
  const sorted = [...syncedInstances].sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  if (publicationJson(sorted) !== publicationJson(syncedInstances)) return publicationInvalid('实例依赖没有按准确身份排序。')
  return { version: 5, workspaceId, entries: Object.fromEntries(entries), syncedInstances }
}
export function validateInitialRecord(value: unknown, key: string): InitialPublicationRecord {
  if (!value || typeof value !== 'object' || !('kind' in value)) return publicationInvalid('对象记录无效。')
  if (value.kind === 'synced-group') {
    const result = validateSyncedGroupWire(value)
    if (key !== 'group:' + result.id) return publicationInvalid('组记录与键不一致。')
    const parsed = collectSyncedBindingOccurrences(result.origin, result.blocks)
    const expected = new Set(parsed.map(physicalKey))
    if (expected.size !== parsed.length || expected.size !== result.bindings.length
      || result.bindings.some(binding => !expected.delete(physicalKey(binding))) || expected.size) return publicationInvalid('组绑定不是完整物理 Key 闭集。')
    return result
  }
  if (value.kind === 'document') {
    const document: unknown = value
    assertSyncedShape(document, ['kind', 'id', 'parentId', 'sortOrder', 'createdAt', 'content'])
    assertSyncedShape(document.content, ['title', 'summary', 'blocks'])
    const title = string(document.content.title)
    if (!title.trim() || title.length > 500 || /[/\\\x00-\x1f]/.test(title) || title === '.' || title === '..') return publicationInvalid('文档标题无效。')
    const result: SyncedPortableHostRecord = { kind: 'document', id: id(document.id),
      parentId: document.parentId === null ? null : id(document.parentId), sortOrder: integer(document.sortOrder), createdAt: time(document.createdAt),
      content: { title, summary: string(document.content.summary), blocks: validateSyncedHostForest(document.content.blocks) } }
    if (key !== 'doc:' + result.id) return publicationInvalid('文档记录与键不一致。')
    return result
  }
  if (value.kind === 'databases') {
    const databases: unknown = value
    assertSyncedShape(databases, ['kind', 'id', 'tables'])
    if (databases.id !== 'databases') return publicationInvalid('数据库原子记录身份无效。')
    assertSyncedShape(databases.tables, SYNC_TABLES)
    const tables = {} as SyncDatabases['tables']
    for (const table of SYNC_TABLES) {
      const columns: readonly string[] = SYNC_TABLE_COLUMNS[table]
      tables[table] = array(databases.tables[table], raw => {
        assertSyncedShape(raw, columns)
        const row: SyncRow = {}
        for (const column of columns) {
          const field = raw[column]
          const nullable = column === 'value_text' || table === 'database_entities' && column === 'document_id' || table === 'document_database_values' && (column === 'document_id' || column === 'entity_id')
          if (column === 'sort_order' || column === 'config_version') integer(field)
          else if (typeof field !== 'string' && !(nullable && field === null)) return publicationInvalid('数据库列不是原 schema 的 TEXT/nullable 类型。')
          if ((column === 'id' || column.endsWith('_id')) && field !== null) id(field)
          row[column] = column === 'sort_order' || column === 'config_version' ? integer(field)
            : typeof field === 'string' || field === null ? field : publicationInvalid('数据库列类型无效。')
        }
        if ('sort_order' in row) integer(row.sort_order)
        if ('created_at' in row) time(row.created_at)
        if (table === 'document_database_columns') {
          if (!['text', 'select', 'multi-select', 'checkbox', 'date'].includes(string(row.type))) return publicationInvalid('数据库列类型无效。')
          const options = parseStrictJson(string(row.options_json), { maxBytes: PUBLICATION_RECORD_MAX_BYTES, maxDepth: 32 })
          if (!Array.isArray(options) || options.some(item => typeof item !== 'string')) return publicationInvalid('数据库选项无效。')
        }
        if (table === 'database_saved_views') {
          if (row.config_version !== 1) return publicationInvalid('保存视图版本无效。')
          const config = parseStrictJson(string(row.config_json), { maxBytes: PUBLICATION_RECORD_MAX_BYTES, maxDepth: 32 })
          if (!config || typeof config !== 'object' || Array.isArray(config)) return publicationInvalid('保存视图配置无效。')
        }
        return row
      }, 200_000)
    }
    if (key !== 'databases') return publicationInvalid('数据库记录键无效。')
    return { kind: 'databases', id: 'databases', tables }
  }
  return publicationInvalid('本初始快照不支持 tombstone 或未知记录类型。')
}

export function validatePublicationCatalog(records: InitialPublicationRecord[]): void {
  const catalogs = records.filter((record): record is SyncDatabases => record.kind === 'databases')
  if (catalogs.length !== 1) return publicationInvalid('完整快照必须恰有数据库原子记录。')
  const tables = catalogs[0].tables
  const uniqueRows = (table: SyncTable, key: (row: SyncRow) => string): Map<string, SyncRow> => {
    const rows = tables[table], result = new Map(rows.map(row => [key(row), row]))
    if (result.size !== rows.length) return publicationInvalid('数据库行身份重复。')
    return result
  }
  const databases = uniqueRows('databases', row => id(row.id)), columns = uniqueRows('document_database_columns', row => id(row.id))
  const views = uniqueRows('database_saved_views', row => id(row.id)), entities = uniqueRows('database_entities', row => id(row.id))
  const documents = new Set(records.filter(record => record.kind === 'document').map(record => record.id))
  const asciiCasefold = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase())
  const viewNames = new Set<string>()
  for (const view of views.values()) {
    const name = string(view.name), nul = name.indexOf('\0')
    const key = publicationJson([view.database_id, asciiCasefold(nul < 0 ? name : name.slice(0, nul)), Buffer.byteLength(name, 'utf8')])
    if (viewNames.has(key)) return publicationInvalid('保存视图违反原 SQLite NOCASE 唯一约束。')
    viewNames.add(key)
  }
  if (!databases.has('catalog')) return publicationInvalid('完整快照缺少 catalog。')
  for (const row of [...columns.values(), ...views.values(), ...entities.values()]) if (!databases.has(id(row.database_id))) return publicationInvalid('数据库定义指向缺失来源。')
  const entityDocuments = new Set<string>()
  for (const row of entities.values()) if (row.document_id !== null) {
    if (!documents.has(id(row.document_id))) return publicationInvalid('实体文档引用缺失。')
    const key = publicationJson([row.database_id, row.document_id])
    if (entityDocuments.has(key)) return publicationInvalid('实体违反原非NULL(database_id,document_id)唯一约束。')
    entityDocuments.add(key)
  }
  for (const table of ['database_entity_values', 'document_database_values'] as const) {
    if (table === 'database_entity_values') uniqueRows(table, row => publicationJson([row.entity_id, row.column_id]))
    else {
      const keys = tables[table].filter(row => row.document_id !== null).map(row => publicationJson([row.document_id, row.column_id]))
      if (new Set(keys).size !== keys.length) return publicationInvalid('文档值违反原非NULL主键约束。')
    }
    for (const row of tables[table]) {
      const column = columns.get(id(row.column_id))
      if (!column) return publicationInvalid('数据库值缺少列定义。')
      if (table === 'document_database_values' && row.document_id !== null && !documents.has(id(row.document_id))) return publicationInvalid('文档值缺少文档。')
      if (row.entity_id !== null) {
        const entity = entities.get(id(row.entity_id))
        if (!entity || entity.database_id !== column.database_id) return publicationInvalid('实体值来源不一致。')
      }
    }
  }
  for (const record of records) if (record.kind !== 'databases') {
    const blocks = record.kind === 'document' ? record.content.blocks : record.blocks
    for (const block of blocks) if (block.type === 'database-view') {
      const payload = parseDatabaseViewPayload(block.content)
      // Missing authored sources remain missing. Existing definitions must not cross their own database.
      if (payload.viewId !== null && views.has(payload.viewId) && views.get(payload.viewId)!.database_id !== payload.databaseId) return publicationInvalid('文内保存视图绑定了其它来源。')
    }
  }
}
export function validateInitialSnapshot(manifestValue: unknown, values: Array<{ key: string; record: unknown }>): ValidatedInitialSnapshot {
  const manifest = validateInitialManifest5(manifestValue), entries = new Map(Object.entries(manifest.entries))
  const records = unique(values.map(({ key, record }) => ({ key, record: validateInitialRecord(record, key) })), value => value.key)
  if (records.length !== entries.size) return publicationInvalid('记录不是完整 manifest 闭集。')
  for (const item of records) if (publicationHash(publicationJson(item.record)) !== entries.get(item.key)) return publicationInvalid('准确对象 hash 与 manifest 不一致。')
  const documents = records.filter((item): item is { key: string; record: SyncedPortableHostRecord } => item.record.kind === 'document')
  const groups = records.filter((item): item is { key: string; record: SyncedGroupWire } => item.record.kind === 'synced-group')
  const documentMap = new Map(documents.map(({ record }) => [record.id, record]))
  const completedParents = new Set<string>()
  for (const { record } of documents) {
    if (completedParents.has(record.id)) continue
    const visited = new Set<string>(); let next: string | null = record.id
    while (next !== null && !completedParents.has(next)) {
      if (visited.has(next) || !documentMap.has(next)) return publicationInvalid('完整文档树缺父级或循环。')
      visited.add(next); next = documentMap.get(next)!.parentId
    }
    for (const id of visited) completedParents.add(id)
  }
  const graph = validateSyncedWorkspaceGraph(documents.map(({ record }) => ({ documentId: record.id, blocks: record.content.blocks })), groups.map(({ record }) => record))
  const expected = [...graph.occurrences.values()].flat().map(item => ({ documentId: item.hostDocumentId,
    instanceId: item.instanceId, groupId: item.groupId, groupHash: entries.get('group:' + item.groupId)! }))
    .sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  if (publicationJson(expected) !== publicationJson(manifest.syncedInstances)) return publicationInvalid('manifest 实例不是全部真实宿主叶闭集。')
  validatePublicationCatalog(records.map(item => item.record))
  const assetNames = new Map<string, Set<string>>()
  const asset = (uri: string): string => {
    const parsed = parseSyncedPortableAssetUri(uri), names = assetNames.get(parsed.hash) ?? new Set<string>()
    names.add(parsed.name); assetNames.set(parsed.hash, names); return uri
  }
  const groupMap = new Map(groups.map(({ record }) => [record.id, record]))
  for (const { record } of groups) { rewriteSyncedGroupAssets(record, asset); measureSyncedPortableGroup(record) }
  for (const { record } of documents) { rewriteSyncedPortableHostAssets(record, asset); measureSyncedPortableHost(record, groupMap) }
  return { manifest, records, assetNames }
}

/** Only the typed databaseId field changes; authored query/config/Origin strings are opaque. */
export function mapPublicationCatalog(records: InitialPublicationRecord[], sourceId: string): InitialPublicationRecord[] {
  const rewrite = (block: SyncedStableBlockDraft): SyncedStableBlockDraft => {
    if (block.type !== 'database-view') return block
    const payload = parseDatabaseViewPayload(block.content)
    if (sourceId !== 'catalog' && payload.databaseId === 'catalog') return publicationInvalid('自定义引用占用了 catalog 保留来源。')
    return { ...block, content: serializeDatabaseViewPayload(mapDatabaseViewReferences(payload, { databaseId: value => value === sourceId ? 'catalog' : value })) }
  }
  return records.map(record => {
    if (record.kind === 'document') return { ...record, content: { ...record.content, blocks: record.content.blocks.map(rewrite) } }
    if (record.kind === 'synced-group') return { ...record, blocks: record.blocks.map(block => ({ ...rewrite(block), createdAt: block.createdAt })) }
    if (sourceId !== 'catalog' && record.tables.databases.some(row => row.id === 'catalog')) return publicationInvalid('自定义数据库占用了 catalog 保留来源。')
    const tables = {} as SyncDatabases['tables']
    for (const table of SYNC_TABLES) tables[table] = record.tables[table].map(row => {
      const next = { ...row }
      if (table === 'databases' && next.id === sourceId) { next.id = 'catalog'; next.created_at = '1970-01-01T00:00:00.000Z' }
      if (next.database_id === sourceId) next.database_id = 'catalog'
      return next
    }).sort((a, b) => publicationCompare(publicationJson(a), publicationJson(b)))
    return { ...record, tables }
  })
}

export function validatePublicationDescriptor(value: unknown): PublicationDescriptor {
  assertSyncedShape(value, ['kind', 'version', 'channel', 'workspaceScope', 'recoveryEpoch', 'targetFingerprint', 'localFingerprint', 'manifest', 'objects', 'assets', 'members'])
  if (value.kind !== 'synced-publication' || value.version !== 1 || value.channel !== 'webdav-manifest5') return publicationInvalid('私有publication版本无效。')
  assertSyncedShape(value.manifest, ['path', 'hash', 'bytes'])
  if (value.manifest.path !== 'manifest.json') return publicationInvalid('manifest路径无效。')
  const objects = unique(array(value.objects, raw => {
    assertSyncedShape(raw, ['key', 'path', 'hash', 'bytes'])
    const digest = hash(raw.hash), path = string(raw.path), key = string(raw.key)
    if (path !== 'objects/' + digest + '.json') return publicationInvalid('对象路径不对应准确hash。')
    return { key, path, hash: digest, bytes: integer(raw.bytes, 1) }
  }), item => item.key)
  const assets = unique(array(value.assets, raw => {
    assertSyncedShape(raw, ['path', 'hash', 'bytes', 'names'])
    const digest = hash(raw.hash), path = string(raw.path), names = unique(array(raw.names, string, Number.MAX_SAFE_INTEGER), name => name)
    if (path !== 'assets/' + digest || !names.length) return publicationInvalid('资产闭集无效。')
    for (const name of names) parseSyncedPortableAssetUri('knowbook-asset://' + digest + '/' + encodeURIComponent(name))
    if (publicationJson(names) !== publicationJson([...names].sort(publicationCompare))) return publicationInvalid('资产名称未排序。')
    return { path, hash: digest, bytes: integer(raw.bytes), names }
  }, Number.MAX_SAFE_INTEGER), item => item.path)
  const members = unique(array(value.members, raw => {
    assertSyncedShape(raw, ['groupId', 'creationId', 'revision', 'topologyRevision', 'semanticHash', 'portableHash'])
    return { groupId: uuid(raw.groupId), creationId: uuid(raw.creationId), revision: uuid(raw.revision), topologyRevision: uuid(raw.topologyRevision),
      semanticHash: hash(raw.semanticHash), portableHash: hash(raw.portableHash) }
  }), item => item.groupId)
  if (!members.length) return publicationInvalid('发布不得为空成员。')
  const sortedKeys = <T>(items: T[], key: (item: T) => string): void => {
    const keys = items.map(key)
    if (publicationJson(keys) !== publicationJson([...keys].sort(publicationCompare))) publicationInvalid('描述符闭集没有规范排序。')
  }
  sortedKeys(objects, item => item.key); sortedKeys(assets, item => item.path); sortedKeys(members, item => item.groupId)
  return { kind: 'synced-publication', version: 1, channel: 'webdav-manifest5', workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch),
    targetFingerprint: hash(value.targetFingerprint), localFingerprint: hash(value.localFingerprint),
    manifest: { path: 'manifest.json', hash: hash(value.manifest.hash), bytes: integer(value.manifest.bytes, 1) }, objects, assets, members }
}
