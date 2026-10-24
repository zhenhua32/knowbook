import type Database from 'better-sqlite3'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2ApplicationColumns,
  capsule2RawSqlValueBytesExpression } from './restore-knowledge-capsule2-raw-model'

type Row = Record<string, unknown>
const bad = (message: string): never => { throw new Error('capsule2 preference/activity无效：' + message + '；不修原件，不授配置、Markdown、执行或安装权。') }
const text = (value: unknown): string => typeof value === 'string' ? value : bad('设置/活动原字段不是TEXT')

/** Full retained preferences/activity storage, not the Store's pruned40/recent8
 * projections. Ordinary settings are extensible opaque TEXT, including empty
 * keys and non-JSON values. Historical activity details may be malformed or a
 * future JSON format; the existing Main reader deliberately keeps it readable.
 * Preserve all original strings and storage bytes without interpreting a key,
 * value, display string or path as a Markdown body or execution capability.
 * Reserved sync metadata still requires the outer total2 family validators.
 * This assertion creates no classified-settings DTO, certificate or permit. */
export function assertRawCapsule2PreferencesOwned(db: Database.Database): void {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return bad('要求真实readonly/query-only/FKON来源事务')
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return bad('仅准确schema26/27')
  const tables = ['app_settings', 'workspace_events'] as const, application = capsule2ApplicationColumns()
  let totalRows = 0n, totalBytes = 0n
  for (const table of tables) {
    const columns = application.get(table)!
    const actual = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<{ name: string }>
    if (actual.length !== columns.length || actual.some((column, index) => column.name !== columns[index])) return bad('原设置/活动列闭集变化')
    const measured = db.prepare('SELECT count(*),COALESCE(sum(' + capsule2RawSqlValueBytesExpression(columns) + '),0) FROM ' + table).safeIntegers(true).raw(true).get() as unknown[]
    if (typeof measured[0] !== 'bigint' || typeof measured[1] !== 'bigint' || measured[0] < 0n || measured[1] < 0n) return bad('原完整表预算无效')
    totalRows += measured[0]; totalBytes += measured[1]
    if (totalRows > BigInt(CAPSULE2_RAW_MAX_ROWS) || totalBytes > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES)) return bad('完整设置/活动超来源预算，不能截断或过滤')
  }
  const settings = db.prepare('SELECT * FROM app_settings ORDER BY key').safeIntegers(true).all() as Row[]
  const keys = new Set<string>()
  for (const row of settings) {
    const key = text(row.key)
    if (keys.has(key)) return bad('设置主身份重复')
    keys.add(key); text(row.value); text(row.updated_at)
  }
  const events = db.prepare('SELECT * FROM workspace_events ORDER BY id').safeIntegers(true).all() as Row[]
  const identities = new Set<string>()
  for (const row of events) {
    const id = text(row.id)
    if (identities.has(id)) return bad('活动主身份重复')
    identities.add(id)
    text(row.type); text(row.title); text(row.description); text(row.created_at)
    if (row.document_id !== null) text(row.document_id)
    if (row.details_json !== null) text(row.details_json)
  }
}
