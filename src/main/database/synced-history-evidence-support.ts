import type Database from 'better-sqlite3'
import { TextDecoder } from 'node:util'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'
import type { RawHistoricalEvidenceFact, RawHistoricalEvidenceFamily, RawHistoricalEvidenceLocator,
  RawHistoricalEvidenceTable } from './synced-history-evidence-model'

export type HistoricalOperationRow = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
export type HistoricalMetadataRow = { key: string; value: string; updated_at: string }
export function historicalEvidenceInvalid(message: string): never { return publicationInvalid('原同步历史证据：' + message) }
export function assertHistoricalEvidenceOwned(db: Database.Database): void {
  if (!db.open || !db.inTransaction) return historicalEvidenceInvalid('要求开放原connection的真实自有事务。')
}
/** Preserve exact SQL TEXT spelling. Replacement decoding or a storage-class
 * coercion cannot create an original historical record. Column/table names
 * below are Main-owned constants, never caller input. */
export function readHistoricalExactRows<T>(db: Database.Database, table: RawHistoricalEvidenceTable,
  columns: readonly string[], where = '', parameters: readonly (string | number)[] = []): T[] {
  assertHistoricalEvidenceOwned(db)
  const encoding = String(db.pragma('encoding', { simple: true })).toLowerCase()
  const label = encoding === 'utf-8' ? 'utf-8' : encoding === 'utf-16le' ? 'utf-16le' : encoding === 'utf-16be' ? 'utf-16be' : null
  if (!label) return historicalEvidenceInvalid('不支持原数据库TEXT编码；不会推定empty。')
  const decoder = new TextDecoder(label, { fatal: true, ignoreBOM: true })
  const selection = columns.map(column => `${column},typeof(${column}) AS __type_${column},CAST(${column} AS BLOB) AS __bytes_${column}`).join(',')
  return (db.prepare('SELECT ' + selection + ' FROM ' + table + (where ? ' WHERE ' + where : '')).all(...parameters) as Record<string, unknown>[])
    .map(raw => {
      const result: Record<string, unknown> = {}
      for (const column of columns) {
        const kind = raw['__type_' + column], value = raw[column]
        if (kind === 'null' && value === null) { result[column] = null; continue }
        if (kind === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) { result[column] = value; continue }
        if (kind !== 'text' || typeof value !== 'string' || !Buffer.isBuffer(raw['__bytes_' + column]))
          return historicalEvidenceInvalid(table + '原TEXT列storage class损坏。')
        let text: string
        const originalBytes = raw['__bytes_' + column] as Buffer
        try { text = decoder.decode(originalBytes) } catch { return historicalEvidenceInvalid(table + '原TEXT编码无效。') }
        if (text !== raw[column]) return historicalEvidenceInvalid(table + '原TEXT解码不等于SQL列。')
        const encoded = Buffer.from(text, label === 'utf-8' ? 'utf8' : 'utf16le')
        if (label === 'utf-16be') encoded.swap16()
        if (!encoded.equals(originalBytes)) return historicalEvidenceInvalid(table + '原TEXT回编码字节不相等。')
        result[column] = text
      }
      return result as T
    })
}
export function readHistoricalTextRows<T>(db: Database.Database, table: RawHistoricalEvidenceTable,
  columns: readonly string[], where = '', parameters: readonly (string | number)[] = []): T[] {
  return readHistoricalExactRows<Record<string, unknown>>(db, table, columns, where, parameters).map(row => {
    if (columns.some(column => typeof row[column] !== 'string')) return historicalEvidenceInvalid(table + '原TEXT列损坏。')
    return row as T
  })
}
export function readHistoricalOperations(db: Database.Database): HistoricalOperationRow[] {
  return readHistoricalTextRows(db, 'synced_operations', ['client_operation_id', 'request_hash', 'result_json', 'created_at'])
}
export function readHistoricalMetadata(db: Database.Database): HistoricalMetadataRow[] {
  return readHistoricalTextRows(db, 'app_settings', ['key', 'value', 'updated_at'])
}
export function historicalRowLocator(table: RawHistoricalEvidenceTable, key: readonly (string | number)[], row: unknown): RawHistoricalEvidenceLocator {
  return Object.freeze({ table, key: Object.freeze([...key]), rowHash: publicationHash(publicationJson(row)) })
}
const primaryKeys: Record<RawHistoricalEvidenceTable, readonly string[]> = {
  synced_operations: ['client_operation_id'], app_settings: ['key'], synced_exposure_attempts: ['id'],
  synced_group_exposure_members: ['attempt_id', 'group_id'], synced_group_pins: ['group_id', 'kind', 'pin_id'],
  synced_host_history: ['id'], synced_group_history: ['id'], synced_groups: ['id'], synced_group_lifecycle: ['group_id'],
  synced_group_retirements: ['group_id'], block_identities: ['id']
}
/** Full original row hash for a locator whose consumer must be able to reread
 * it without knowing an undocumented projection of the table's columns. */
export function readHistoricalRowLocator(db: Database.Database, table: RawHistoricalEvidenceTable,
  key: readonly (string | number)[]): RawHistoricalEvidenceLocator {
  assertHistoricalEvidenceOwned(db)
  const columns = (db.pragma('table_info(' + table + ')') as Array<{ name: string }>).map(column => column.name)
  const keys = primaryKeys[table]
  if (!columns.length || columns.some(column => !/^[a-z_][a-z0-9_]*$/.test(column)) || key.length !== keys.length)
    return historicalEvidenceInvalid('原完整行locator表/列/主键无效。')
  const rows = readHistoricalExactRows<Record<string, unknown>>(db, table, columns, keys.map(column => column + '=?').join(' AND '), key)
  if (rows.length !== 1) return historicalEvidenceInvalid('原完整行locator缺失或重复。')
  return historicalRowLocator(table, key, rows[0])
}
export function historicalOperationLocator(row: HistoricalOperationRow): RawHistoricalEvidenceLocator {
  return historicalRowLocator('synced_operations', [row.client_operation_id], row)
}
export function historicalMetadataLocator(row: HistoricalMetadataRow): RawHistoricalEvidenceLocator {
  return historicalRowLocator('app_settings', [row.key], row)
}
export function historicalFact(family: RawHistoricalEvidenceFamily, version: number | null,
  locator: RawHistoricalEvidenceLocator, supports: readonly RawHistoricalEvidenceLocator[] = [],
  evidenceClass: RawHistoricalEvidenceFact['evidenceClass'] = 'durable-only'): RawHistoricalEvidenceFact {
  const unique = new Map<string, RawHistoricalEvidenceLocator>()
  for (const support of supports) {
    const key = publicationJson([support.table, support.key]), old = unique.get(key)
    if (old && old.rowHash !== support.rowHash) return historicalEvidenceInvalid('同一原支持locator出现矛盾rowHash。')
    unique.set(key, support)
  }
  const ordered = [...unique].sort(([left], [right]) => publicationCompare(left, right)).map(([, support]) => support)
  return Object.freeze({ family, version, evidenceClass, locator, supports: Object.freeze(ordered) })
}
export function historicalTime(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
export function historicalHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
