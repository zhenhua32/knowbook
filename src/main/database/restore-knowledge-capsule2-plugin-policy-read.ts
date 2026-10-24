import type Database from 'better-sqlite3'
import { appSchema } from './schema'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2RawSqlValueBytesExpression } from './restore-knowledge-capsule2-raw-model'
import { assertStoredPluginPolicyRow, STORED_PLUGIN_POLICY_TABLES, type StoredPluginPolicyTable } from '../plugin-platform/repository'

type Row = Record<string, unknown>
type Column = { name: string; type: 'TEXT' | 'INTEGER'; nullable: boolean }
type Layout = { columns: Column[]; primary: string[]; references: Array<{ column: string; table: StoredPluginPolicyTable; target: string }> }
const bad = (message: string): never => { throw new Error('capsule2 plugin policy无效：' + message + '；不修原件，不授artifact/运行/grant/命令/安装权。') }
// Fixed application DDL only. No source-provided schema, table list or row
// selector becomes a validation policy. This caches no database observation.
const layouts = new Map<StoredPluginPolicyTable, Layout>()
for (const match of appSchema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*) \(([\s\S]*?)\n\);/g)) {
  const table = STORED_PLUGIN_POLICY_TABLES.find(name => name === match[1])
  if (!table) continue
  const columns: Column[] = [], primary: string[] = [], references: Layout['references'] = []
  for (const column of match[2].matchAll(/^  ([a-z_][a-z0-9_]*) (TEXT|INTEGER)\b(.*)$/gm)) {
    columns.push({ name: column[1], type: column[2] as Column['type'], nullable: !/NOT NULL|PRIMARY KEY/.test(column[3]) })
    if (/PRIMARY KEY/.test(column[3])) primary.push(column[1])
    const ref = /REFERENCES ([a-z_][a-z0-9_]*)\(([a-z_][a-z0-9_]*)\)/.exec(column[3])
    if (ref) {
      const target = STORED_PLUGIN_POLICY_TABLES.find(name => name === ref[1])
      if (!target) bad('固定插件外键目标不在完整family内')
      references.push({ column: column[1], table: target!, target: ref[2] })
    }
  }
  const composite = /PRIMARY KEY\s*\(([^)]+)\)/.exec(match[2])
  if (composite) primary.push(...composite[1].split(',').map(key => key.trim()))
  if (!columns.length || !primary.length) bad('固定插件DDL无法完整解释')
  layouts.set(table, { columns, primary, references })
}
if (layouts.size !== STORED_PLUGIN_POLICY_TABLES.length) bad('固定插件family不完整')

/** Complete retained v2/v3 storage, never paginated/active-only repository
 * getters. Every actual row is bounded, typed and decoded by the existing
 * stored reader; declared application FK support is checked independently of
 * source DDL. Opaque manifests, commands, paths, epochs and revoked/expired
 * grants remain data, not evidence of artifact bytes or current authorization.
 * No repository constructor, host, recovery, command or OS action is invoked. */
export function assertRawCapsule2PluginPolicyOwned(db: Database.Database): void {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return bad('要求真实readonly/query-only/FKON来源事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return bad('仅准确schema26/27')
  let totalRows = 0n, totalBytes = 0n
  for (const table of STORED_PLUGIN_POLICY_TABLES) {
    const layout = layouts.get(table)!
    const actual = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string; type: string; pk: number }>
    const primary = actual.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name)
    if (actual.length !== layout.columns.length || actual.some((column, i) => column.name !== layout.columns[i].name || column.type.toUpperCase() !== layout.columns[i].type)
      || JSON.stringify(primary) !== JSON.stringify(layout.primary)) return bad('原插件列/存储声明/主键闭集变化')
    const cost = capsule2RawSqlValueBytesExpression(layout.columns.map(column => column.name))
    const size = db.prepare('SELECT count(*),COALESCE(sum(' + cost + '),0) FROM ' + table).safeIntegers(true).raw(true).get() as unknown[]
    if (typeof size[0] !== 'bigint' || typeof size[1] !== 'bigint' || size[0] < 0n || size[1] < 0n) return bad('原完整插件预算无效')
    totalRows += size[0]; totalBytes += size[1]
    if (totalRows > BigInt(CAPSULE2_RAW_MAX_ROWS) || totalBytes > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES)) return bad('完整插件family超来源预算，不能分页或截断')
  }
  const all = new Map<StoredPluginPolicyTable, Row[]>(), indexes = new Map<StoredPluginPolicyTable, Map<string, Row>>()
  for (const table of STORED_PLUGIN_POLICY_TABLES) {
    const layout = layouts.get(table)!, rows: Row[] = [], index = new Map<string, Row>()
    for (const original of db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').safeIntegers(true).all() as Row[]) {
      const row: Row = Object.create(null)
      for (const column of layout.columns) {
        const value = original[column.name]
        if (value === null && column.nullable) row[column.name] = null
        else if (column.type === 'TEXT' && typeof value === 'string') row[column.name] = value
        else if (column.type === 'INTEGER' && typeof value === 'bigint' && value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) row[column.name] = Number(value)
        else return bad('原插件字段不是准确TEXT/INTEGER/nullable存储')
      }
      const key = JSON.stringify(layout.primary.map(column => row[column]))
      if (index.has(key)) return bad('原插件主身份重复')
      try { assertStoredPluginPolicyRow(table, row) } catch { return bad('原插件行不能由现有stored decoder完整读取') }
      index.set(key, row); rows.push(row)
    }
    all.set(table, rows); indexes.set(table, index)
  }
  for (const [table, rows] of all) for (const reference of layouts.get(table)!.references) {
    const target = layouts.get(reference.table)!
    if (target.primary.length !== 1 || target.primary[0] !== reference.target) return bad('固定插件外键不是已知原主身份')
    for (const row of rows) if (row[reference.column] !== null && !indexes.get(reference.table)!.has(JSON.stringify([row[reference.column]]))) return bad('原插件外键缺完整支持行')
  }
}
