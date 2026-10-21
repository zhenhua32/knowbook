import type Database from 'better-sqlite3'
import { capsuleJson } from './restore-knowledge-capsule-model'
import { rawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { readRawPriorKnowledgeCoverageOwned } from './restore-knowledge-coverage-raw-read'
import { readHistoricalRowLocator } from './synced-history-evidence-support'
import type { CoverageSqlRowReference } from './restore-knowledge-coverage-model'
import { CAPSULE2_READER, CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2RawInvalid,
  capsule2RawSqlValueBytesExpression, validateCapsule2RawCoverageSupports, type Capsule2CoverageSupport, type Capsule2RawCoverageSupports } from './restore-knowledge-capsule2-raw-model'

const quote = (value: string): string => '"' + value.replace(/"/g, '""') + '"'
const keys = { app_settings: 'key', synced_operations: 'client_operation_id', synced_exposure_attempts: 'id' } as const
function preflight(db: Database.Database, version: 26 | 27): void {
  // These are exactly the fixed old SQL-support families the existing raw C
  // reader can traverse. No caller table/key list controls certification.
  const names = ['app_settings', 'synced_operations', 'synced_groups', 'synced_host_history', 'synced_group_history', 'synced_group_pins',
    ...(version === 27 ? ['synced_exposure_attempts', 'synced_group_exposure_members', 'synced_group_lifecycle', 'synced_group_retirements'] : [])]
  let rows = 0n, bytes = 0n
  for (const name of names) {
    const columns = db.prepare('SELECT * FROM ' + quote(name) + ' LIMIT 0').columns().map(column => column.name)
    if (!columns.length || columns.length > 512) return capsule2RawInvalid('mandatory前置列预算无效')
    const size = capsule2RawSqlValueBytesExpression(columns)
    const value = db.prepare('SELECT count(*),coalesce(sum(' + size + '),0) FROM ' + quote(name)).safeIntegers(true).raw(true).get() as unknown[]
    if (typeof value[0] !== 'bigint' || typeof value[1] !== 'bigint' || value[0] < 0n || value[1] < 0n) return capsule2RawInvalid('mandatory原预算不是非负INTEGER')
    rows += value[0]; bytes += value[1]
    if (rows > BigInt(CAPSULE2_RAW_MAX_ROWS) || bytes > BigInt(CAPSULE2_RAW_MAX_VALUE_BYTES))
      return capsule2RawInvalid('完整mandatory SQL支持超准备预算，不能截取支持或降empty')
  }
}
/** Complete C/link/Receipt2/anchor and optional B/R originals, from this actual
 * SQL snapshot only. Roots remain unresolved. This is not total historical2,
 * an accepted relationship, a capsule2 certificate or an installer permit. */
export function readRawCapsule2CoverageSupportsOwned(db: Database.Database): Capsule2RawCoverageSupports {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return capsule2RawInvalid('mandatory读取要求独立readonly query-only/FKON owned事务')
  const version = db.pragma('user_version', { simple: true }), encoding = db.pragma('encoding', { simple: true })
  if (version !== 26 && version !== 27 || encoding !== 'UTF-8' && encoding !== 'UTF-16le' && encoding !== 'UTF-16be')
    return capsule2RawInvalid('mandatory原schema/编码未支持')
  preflight(db, version)
  const requirements = readRawPriorKnowledgeCoverageOwned(db), expected = new Map<string, CoverageSqlRowReference>()
  for (const entry of requirements.entries) for (const support of Object.values(entry.supports)) if (support) {
    const key = capsuleJson([support.table, support.key]), previous = expected.get(key)
    if (previous && previous.rowHash !== support.rowHash) return capsule2RawInvalid('实际mandatory locator同key/hash矛盾')
    expected.set(key, support)
  }
  const supports: Capsule2CoverageSupport[] = []
  for (const [, reference] of [...expected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    // The existing full-row domain is authenticated again, independently of
    // the raw storage-cell artifact below. No caller hash is accepted as fact.
    const actual = readHistoricalRowLocator(db, reference.table, reference.key)
    if (capsuleJson(actual) !== capsuleJson(reference)) return capsule2RawInvalid('mandatory真实全行locator/hash变化')
    const columns = db.prepare('SELECT * FROM ' + quote(reference.table) + ' LIMIT 0').columns().map(column => column.name)
    if (columns.some(name => !/^[a-z_][a-z0-9_]*$/.test(name) || ['rowid', '_rowid_', 'oid'].includes(name))) return capsule2RawInvalid('mandatory列不属于准确schema')
    const projection = columns.flatMap(name => ['typeof(' + quote(name) + ')', 'CASE WHEN typeof(' + quote(name) + ")='text' THEN CAST(" + quote(name) + ' AS BLOB) ELSE ' + quote(name) + ' END']).join(',')
    const rows = db.prepare('SELECT _rowid_,' + projection + ' FROM ' + quote(reference.table) + ' WHERE ' + quote(keys[reference.table]) + '=?').safeIntegers(true).raw(true).all(...reference.key) as unknown[][]
    if (rows.length !== 1) return capsule2RawInvalid('mandatory完整原行缺失/重复')
    const raw = rows[0], rowid = raw[0]
    if (typeof rowid !== 'bigint') return capsule2RawInvalid('mandatory rowid原证据不是INTEGER')
    supports.push({ reference, columns, row: { sourceRowId: rowid.toString(),
      cells: columns.map((_name, index) => rawRestoreSqlCell(raw[index * 2 + 1], raw[index * 2 + 2], encoding)) } })
  }
  return validateCapsule2RawCoverageSupports({ kind: 'restore-knowledge-capsule2-raw-coverage-supports', version: 1, forReader: CAPSULE2_READER,
    encoding, requirements, supports, state: 'unresolved-sql-supports-only', certified: false, acceptedCoverage: false })
}
