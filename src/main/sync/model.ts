import { createHash } from 'node:crypto'
import type { UpdateDocumentInput } from '../../shared/contracts'

export interface SyncDocument {
  kind: 'document'
  id: string
  parentId: string | null
  sortOrder: number
  createdAt: string
  content: UpdateDocumentInput
}

export type SqlValue = string | number | null
export type SyncRow = Record<string, SqlValue>
export const SYNC_TABLE_COLUMNS = {
  databases: ['id', 'name', 'description', 'created_at'],
  document_database_columns: ['id', 'database_id', 'name', 'type', 'options_json', 'sort_order', 'created_at'],
  database_saved_views: ['id', 'database_id', 'name', 'filter_query', 'filter_scope', 'sort_mode', 'view_mode', 'config_json', 'config_version', 'sort_order', 'created_at'],
  database_entities: ['id', 'database_id', 'title', 'document_id', 'created_at'],
  database_entity_values: ['entity_id', 'column_id', 'value_text'],
  document_database_values: ['document_id', 'column_id', 'value_text', 'entity_id']
} as const
export type SyncTable = keyof typeof SYNC_TABLE_COLUMNS
export const SYNC_TABLES = Object.keys(SYNC_TABLE_COLUMNS) as SyncTable[]

/** Database schema, views and values form one atomic unit in protocol v1. */
export interface SyncDatabases {
  kind: 'databases'
  id: 'databases'
  tables: Record<SyncTable, SyncRow[]>
}
export interface SyncDeletion { kind: 'deleted'; id: string }
export type SyncRecord = SyncDocument | SyncDatabases | SyncDeletion
export interface SyncManifest { version: 1; workspaceId: string; entries: Record<string, string> }
export interface SyncBaseline { localHash: string | null; remoteHash: string }
export interface StoredConflict { local: SyncRecord; remote: SyncRecord; localHash: string; remoteHash: string }
export interface SyncState {
  workspaceId?: string
  baseline: Record<string, SyncBaseline>
  conflicts: Record<string, StoredConflict>
  resolutions: Record<string, { localHash: string; remoteHash: string; choice: 'local' | 'remote' | 'both' }>
  lastSyncAt: string | null
}
export const emptySyncState = (): SyncState => ({ baseline: {}, conflicts: {}, resolutions: {}, lastSyncAt: null })
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
export const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const recordKey = (record: SyncRecord): string => record.kind === 'databases' ? 'databases' : `doc:${record.id}`
export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
export const hashBytes = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export const recordHash = (record: SyncRecord): string => hashBytes(canonicalJson(record))

export function parseManifest(bytes: Uint8Array): SyncManifest {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as SyncManifest
  if (!value || value.version !== 1 || !validId(value.workspaceId) || !value.entries || Array.isArray(value.entries)
    || typeof value.entries !== 'object' || Object.keys(value.entries).length > 100_000
    || Object.entries(value.entries).some(([key, hash]) => !(key === 'databases' || key.startsWith('doc:') && validId(key.slice(4))) || !validHash(hash))) {
    throw new Error('远端同步清单无效或版本不受支持，未修改本地数据。')
  }
  return value
}

export function validateRecord(value: SyncRecord, key: string): SyncRecord {
  const fail = () => { throw new Error('远端文档或数据库格式无效，未修改本地数据。') }
  if (!value || !validId(value.id) || recordKey(value) !== key) return fail()
  if (value.kind === 'deleted') {
    if (!key.startsWith('doc:')) return fail()
  } else if (value.kind === 'document') {
    const content = value.content
    if (value.parentId !== null && !validId(value.parentId) || !Number.isSafeInteger(value.sortOrder)
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || !content || typeof content.title !== 'string' || content.title.length > 500
      || !content.title.trim() || /[/\\\x00-\x1f]/.test(content.title) || ['.', '..'].includes(content.title)
      || typeof content.summary !== 'string' || !Array.isArray(content.blocks) || content.blocks.length > 100_000) return fail()
    const ids = new Set<string>()
    for (const block of content.blocks) {
      if (!validId(block.id) || ids.has(block.id) || typeof block.type !== 'string' || typeof block.content !== 'string'
        || typeof block.checked !== 'boolean' || !Number.isSafeInteger(block.depth) || block.depth < 0
        || block.parentBlockId != null && !validId(block.parentBlockId)
        || block.tags !== undefined && (!Array.isArray(block.tags) || block.tags.some(tag => typeof tag !== 'string'))) return fail()
      ids.add(block.id)
    }
  } else if (value.kind === 'databases') {
    if (value.id !== 'databases' || !value.tables) return fail()
    for (const table of SYNC_TABLES) {
      const rows = value.tables[table], columns: readonly string[] = SYNC_TABLE_COLUMNS[table]
      if (!Array.isArray(rows) || rows.length > 200_000) return fail()
      for (const row of rows) {
        if (!row || Array.isArray(row) || Object.keys(row).length !== columns.length
          || columns.some(column => !Object.hasOwn(row, column) || !['string', 'number'].includes(typeof row[column]) && row[column] !== null)
          || Object.entries(row).some(([column, field]) => (column === 'id' || column.endsWith('_id')) && field !== null && !validId(field))) return fail()
        if ('sort_order' in row && (!Number.isSafeInteger(row.sort_order) || Number(row.sort_order) < 0)) return fail()
        if ('created_at' in row && (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at)))) return fail()
        if (table === 'document_database_columns') {
          if (!['text', 'select', 'multi-select', 'date', 'checkbox'].includes(String(row.type)) || typeof row.options_json !== 'string') return fail()
          const options = JSON.parse(row.options_json)
          if (!Array.isArray(options) || options.some(option => typeof option !== 'string')) return fail()
        }
        if (table === 'database_saved_views') {
          if (row.config_version !== 1 || typeof row.config_json !== 'string') return fail()
          const config = JSON.parse(row.config_json)
          if (!config || typeof config !== 'object' || Array.isArray(config)) return fail()
        }
      }
    }
  } else return fail()
  return value
}

export function conflictPreview(record: SyncRecord): string {
  if (record.kind === 'deleted') return '（已删除）'
  if (record.kind === 'document') return [record.content.title, record.content.summary, ...record.content.blocks.map(block => block.content)].join('\n\n').slice(0, 12_000)
  return JSON.stringify(record.tables, null, 2).slice(0, 12_000)
}
