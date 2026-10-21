import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { publicationHash, publicationJson, publicationCompare } from '../sync/synced-publication-model'
import { syncedBlockSchemaObjectNames } from './synced-schema'
import { syncedLifecycleSchemaObjectNames } from './synced-lifecycle-schema-metadata'

export interface RawSqlTableInventory { name: string; columnsHash: string; rows: number; rowSetHash: string }
export interface RawSqlInventory { encoding: string; schemaHash: string; tables: readonly RawSqlTableInventory[]; inventoryHash: string }
const ordinaryTables = ['block_identities', 'document_block_routes', 'backup_restore_identities', 'documents', 'blocks',
  'document_history', 'document_trash', 'document_block_moves', 'document_templates', 'databases', 'document_database_columns',
  'database_saved_views', 'database_entities', 'database_entity_values', 'document_database_values', 'links', 'app_settings']
const quoted = (name: string) => '"' + name.replace(/"/g, '""') + '"'
const namespace = (name: string) => /^(?:synced_|idx_synced_|trg_synced_)/i.test(name)
function refused(message: string): never { throw new Error('恢复知识SQL原件无效：' + message) }

function encoding(db: Database.Database) {
  const actual = db.pragma('encoding', { simple: true })
  if (actual !== 'UTF-8' && actual !== 'UTF-16le' && actual !== 'UTF-16be') return refused('未知数据库TEXT编码')
  return actual
}
function cell(storage: unknown, value: unknown, textEncoding: string): unknown {
  if (storage === 'null' && value === null) return ['null']
  if (storage === 'integer' && typeof value === 'bigint') return ['integer', value.toString()]
  if (storage === 'real' && typeof value === 'number') {
    const bits = Buffer.allocUnsafe(8); bits.writeDoubleLE(value)
    return ['real-ieee754-le', bits.toString('hex')]
  }
  if ((storage === 'text' || storage === 'blob') && value instanceof Uint8Array) {
    const bytes = Buffer.from(value)
    if (storage === 'text') {
      const label = textEncoding.toLowerCase(), decoder = new TextDecoder(label, { fatal: true, ignoreBOM: true })
      let text: string
      try { text = decoder.decode(bytes) } catch { return refused('原SQL TEXT含非法编码字节') }
      const roundtrip = Buffer.from(text, textEncoding === 'UTF-8' ? 'utf8' : 'utf16le')
      if (textEncoding === 'UTF-16be') roundtrip.swap16()
      if (!roundtrip.equals(bytes)) return refused('原SQL TEXT不能无损回读')
    }
    return [storage, bytes.toString('base64')]
  }
  return refused('原SQL storage class与实际值不符')
}
function rawRows(db: Database.Database, table: string, columns: readonly string[], textEncoding: string): IterableIterator<unknown[]> {
  const projection = columns.flatMap(name => {
    const key = quoted(name)
    return [`typeof(${key})`, `CASE WHEN typeof(${key})='text' THEN CAST(${key} AS BLOB) ELSE ${key} END`]
  }).join(',')
  const rows = db.prepare('SELECT ' + projection + ' FROM ' + quoted(table)).safeIntegers(true).raw(true).iterate() as IterableIterator<unknown[]>
  return (function* () {
    for (const row of rows) yield columns.map((_name, index) => cell(row[index * 2], row[index * 2 + 1], textEncoding))
  })()
}

/** Exact typed SQL inventory, independently bound by the original DB/WAL/SHM
 * file inventory. It does not interpret an unknown metadata row as certified
 * history, load K, write SQL, or manufacture a capability. */
export function readRawRestoreSqlInventoryOwned(db: Database.Database): RawSqlInventory {
  if (!db.open || !db.inTransaction) return refused('要求开放原connection的真实自有事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return refused('尚无该schema的完整原件adapter')
  const textEncoding = encoding(db)
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() as
    Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  // Authenticate all schema TEXT bytes before using the driver's object names.
  const schemaRows = [...rawRows(db, 'sqlite_master', ['type', 'name', 'tbl_name', 'sql'], textEncoding)]
    .map(row => publicationJson(row)).sort(publicationCompare)
  const declared = [...syncedBlockSchemaObjectNames(), ...(version === 27 ? syncedLifecycleSchemaObjectNames() : [])]
  const expected = new Map(declared.map(item => [item.name, item.type]))
  for (const row of schema) if (namespace(row.name) && expected.get(row.name) !== row.type) return refused('未知同步namespace：' + row.name)
  const present = new Set(schema.filter(row => row.type === 'table').map(row => row.name))
  const tables = [...new Set([...ordinaryTables, ...declared.filter(item => item.type === 'table').map(item => item.name)])]
    .filter(name => present.has(name)).sort(publicationCompare)
  const result: RawSqlTableInventory[] = []
  for (const name of tables) {
    const columns = db.prepare('SELECT * FROM ' + quoted(name) + ' LIMIT 0').columns().map(item => item.name)
    const hashes: string[] = []
    for (const row of rawRows(db, name, columns, textEncoding)) {
      hashes.push(publicationHash(publicationJson(row)))
    }
    hashes.sort(publicationCompare)
    const rowSet = createHash('sha256').update('knowbook.raw-sql-row-set.v1\0')
    for (const hash of hashes) rowSet.update(hash)
    result.push(Object.freeze({ name, columnsHash: publicationHash(publicationJson(columns)), rows: hashes.length, rowSetHash: rowSet.digest('hex') }))
  }
  const schemaHash = publicationHash(publicationJson({ domain: 'knowbook.raw-sql-schema.v1', encoding: textEncoding, rows: schemaRows }))
  const summary = { encoding: textEncoding, schemaHash, tables: Object.freeze(result) }
  return Object.freeze({ ...summary, inventoryHash: publicationHash(publicationJson({ domain: 'knowbook.raw-sql-inventory.v1', ...summary })) })
}
