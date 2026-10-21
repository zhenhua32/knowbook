import { createHash } from 'node:crypto'
import { appSchema } from './schema'
import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from './restore-knowledge-sql-cell'
import { syncedBlockSchemaObjectNames } from './synced-schema'
import { syncedLifecycleSchemaObjectNames } from './synced-lifecycle-schema-metadata'
import { validateRawPriorCoverageRequirements, type CoverageSqlRowReference, type RawPriorCoverageRequirements } from './restore-knowledge-coverage-model'

/** Prepared raw seams for the finite reader already named by CoverageCapsuleReference.
 * These are data DTOs. This module contains no capsule2 manifest/seal/certificate factory. */
export const CAPSULE2_READER = 'knowbook-durable-sql-coverage-v2' as const
export const CAPSULE2_RAW_MAX_ROWS = 100_000
export const CAPSULE2_RAW_MAX_VALUE_BYTES = 64 * 1024 * 1024
export const CAPSULE2_RAW_MAX_JSON_BYTES = 128 * 1024 * 1024
// This is a conservative value-byte cost, not SQLite file/page length: exact
// original TEXT/BLOB bytes, and eight bytes per INTEGER, REAL or NULL cell.
// Rowid evidence, schema/column metadata and requirements are not value cells;
// their encoded DTO size is covered separately by MAX_JSON_BYTES.
const FIXED_CELL_VALUE_BYTES = 8
export type Capsule2Encoding = 'UTF-8' | 'UTF-16le' | 'UTF-16be'
export type Capsule2TableRole = 'content' | 'identity-evidence' | 'execution-history-evidence' | 'derived' | 'policy-unresolved'
export interface Capsule2RawSqlRow { readonly sourceRowId: string; readonly cells: readonly RawRestoreSqlCell[] }
export interface Capsule2RawSqlTable {
  readonly name: string; readonly role: Capsule2TableRole; readonly columns: readonly string[]
  readonly primaryKey: readonly string[]; readonly rows: readonly Capsule2RawSqlRow[]
}
/** Bounded uncertified observation only. SchemaHash and table columns/PK names
 * summarize schema; complete DDL/schema typed rows remain in the physical DB. */
export interface Capsule2RawContent {
  readonly kind: 'restore-knowledge-capsule2-raw-content'; readonly version: 1; readonly forReader: typeof CAPSULE2_READER
  readonly schemaVersion: 26 | 27; readonly encoding: Capsule2Encoding
  readonly workspaceScope: string; readonly recoveryEpoch: string; readonly schemaHash: string; readonly legacyInventoryHash: string
  readonly derivedTablesNotRepeated: readonly string[]; readonly tables: readonly Capsule2RawSqlTable[]
  readonly state: 'raw-storage-only'; readonly semanticValidationComplete: false; readonly certified: false
}
export interface Capsule2CoverageSupport {
  readonly reference: CoverageSqlRowReference; readonly columns: readonly string[]; readonly row: Capsule2RawSqlRow
}
export interface Capsule2RawCoverageSupports {
  readonly kind: 'restore-knowledge-capsule2-raw-coverage-supports'; readonly version: 1; readonly forReader: typeof CAPSULE2_READER
  readonly encoding: Capsule2Encoding
  readonly requirements: RawPriorCoverageRequirements; readonly supports: readonly Capsule2CoverageSupport[]
  readonly state: 'unresolved-sql-supports-only'; readonly certified: false; readonly acceptedCoverage: false
}
export function capsule2RawInvalid(message: string): never { throw new Error('capsule2原SQL接缝无效：' + message + '；仅raw数据，不授认证/empty/安装权。') }
const hash = (domain: string, value: unknown): string => createHash('sha256').update(domain + '\0' + capsuleJson(value)).digest('hex')
const qname = (value: unknown): value is string => typeof value === 'string' && /^[a-z_][a-z0-9_]*$/.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
function int64Decimal(value: unknown): value is string {
  // An actual SQLite signed INTEGER/rowid has at most 20 canonical decimal
  // characters. Bound the spelling before regex/BigInt can traverse huge DTOs.
  return typeof value === 'string' && value.length <= 20 && /^(?:0|-?[1-9][0-9]*)$/.test(value)
    && BigInt(value) >= -(2n ** 63n) && BigInt(value) < 2n ** 63n
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1)
    return capsule2RawInvalid('数组超预算/含hole或额外字段')
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, index)
    return field?.enumerable && 'value' in field ? field.value : capsule2RawInvalid('数组不是enumerable data元素')
  })
}
function names(value: unknown): string[] {
  const values = list(value, 512)
  if (values.some(item => !qname(item)) || new Set(values).size !== values.length) return capsule2RawInvalid('原表/列名不是有限准确闭集')
  return values as string[]
}
function columnNames(value: unknown): string[] {
  const columns = names(value)
  if (!columns.length) return capsule2RawInvalid('完整原行列闭集不得为空')
  return columns
}
/** Same cost rule as the pure DTO accumulator below. Fixed source table scans
 * may cover more rows than the materialized mandatory-support DTO. No caller
 * can supply a limit or an attestation that a source scan happened. */
export function capsule2RawSqlValueBytesExpression(columns: readonly string[]): string {
  if (!columns.length || columns.length > 512 || columns.some(name => !qname(name))) return capsule2RawInvalid('value bytes列不是有限准确SQL列')
  return columns.map(name => {
    const column = '"' + name + '"'
    return 'CASE WHEN typeof(' + column + ") IN ('text','blob') THEN length(CAST(" + column + ' AS BLOB)) ELSE ' + FIXED_CELL_VALUE_BYTES + ' END'
  }).join('+')
}
interface RawBudget { rows: number; valueBytes: number }
function takeValueBytes(budget: RawBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > CAPSULE2_RAW_MAX_VALUE_BYTES - budget.valueBytes)
    return capsule2RawInvalid('完整raw DTO value bytes超准备预算，不截断')
  budget.valueBytes += bytes
}
function cell(value: unknown, encoding: Capsule2Encoding, budget: RawBudget): RawRestoreSqlCell {
  const row = list(value, 2), tag = row[0]
  if (tag === 'null' && row.length === 1) { takeValueBytes(budget, FIXED_CELL_VALUE_BYTES); return ['null'] }
  if (row.length !== 2 || typeof row[1] !== 'string') return capsule2RawInvalid('原storage cell无效')
  if (tag === 'integer' && int64Decimal(row[1])) {
    takeValueBytes(budget, FIXED_CELL_VALUE_BYTES); return ['integer', row[1]]
  }
  if (tag === 'real-ieee754-le' && /^[0-9a-f]{16}$/.test(row[1])) {
    takeValueBytes(budget, FIXED_CELL_VALUE_BYTES); return ['real-ieee754-le', row[1]]
  }
  if ((tag === 'text' || tag === 'blob') && row[1].length % 4 === 0) {
    // Canonical base64 length gives the exact decoded byte count. Charge the
    // fixed budget before Buffer allocation; the roundtrip still rejects all
    // malformed/noncanonical forms, then the one original cell codec owns TEXT.
    const padding = row[1].endsWith('==') ? 2 : row[1].endsWith('=') ? 1 : 0
    takeValueBytes(budget, row[1].length / 4 * 3 - padding)
    const bytes = Buffer.from(row[1], 'base64')
    if (bytes.toString('base64') === row[1]) return rawRestoreSqlCell(tag, bytes, encoding)
  }
  return capsule2RawInvalid('未知storage tag或非canonical原值')
}
function row(value: unknown, columns: number, encoding: Capsule2Encoding, budget: RawBudget): Capsule2RawSqlRow {
  if (++budget.rows > CAPSULE2_RAW_MAX_ROWS) return capsule2RawInvalid('完整raw DTO总行数超准备预算，不截断')
  const record = capsuleRecord(value, ['sourceRowId', 'cells'])
  if (!int64Decimal(record.sourceRowId)) return capsule2RawInvalid('原rowid证据无效')
  const cells = list(record.cells, 512).map(value => cell(value, encoding, budget))
  if (cells.length !== columns) return capsule2RawInvalid('完整原行列宽变化')
  return { sourceRowId: record.sourceRowId, cells }
}
/** DDL strings are the existing pure application metadata, never executed here.
 * Final synced DDL has its own exact metadata assertion in the raw reader. */
export function capsule2ApplicationColumns(): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>()
  for (const match of appSchema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*) \(([\s\S]*?)\n\);/g)) {
    const columns = [...match[2].matchAll(/^  ([a-z_][a-z0-9_]*) (?:TEXT|INTEGER|REAL|BLOB)\b/gm)].map(item => item[1])
    if (!columns.length || new Set(columns).size !== columns.length) return capsule2RawInvalid('固定DDL列清单无法解析')
    result.set(match[1], Object.freeze(columns))
  }
  result.set('blocks', Object.freeze([...(result.get('blocks') ?? []), 'markdown_format_json', 'list_start']))
  result.set('document_templates', Object.freeze(['id', 'name', 'description', 'title', 'summary', 'blocks_json', 'created_at']))
  return result
}
export function capsule2FixedDataTables(version: 26 | 27): readonly string[] {
  return Object.freeze([...new Set([...capsule2ApplicationColumns().keys(), ...syncedBlockSchemaObjectNames().filter(item => item.type === 'table').map(item => item.name),
    ...(version === 27 ? syncedLifecycleSchemaObjectNames().filter(item => item.type === 'table').map(item => item.name) : [])])].sort())
}
export function capsule2DerivedFtsDefinitions(): ReadonlyMap<string, string> {
  return new Map([...appSchema.matchAll(/CREATE VIRTUAL TABLE IF NOT EXISTS ([a-z_]+) USING fts5\([\s\S]*?\n\);/g)].map(match => [match[1], match[0]]))
}
export function capsule2DerivedFtsTables(): readonly string[] {
  return Object.freeze([...capsule2DerivedFtsDefinitions().keys()].flatMap(name => [name,
    ...['data', 'idx', 'content', 'docsize', 'config'].map(suffix => name + '_' + suffix)]).sort())
}
const contentTables = new Set(['documents', 'blocks', 'databases', 'document_database_columns', 'database_saved_views',
  'database_entities', 'database_entity_values', 'document_database_values', 'document_templates', 'synced_groups', 'synced_group_blocks', 'synced_instances'])
const identityTables = new Set(['block_identities', 'document_block_routes', 'backup_restore_identities'])
const derivedTables = new Set(['links', 'markdown_link_sources', 'document_search_ids', 'block_search_ids'])
export function capsule2TableRole(name: string): Capsule2TableRole {
  return contentTables.has(name) ? 'content' : identityTables.has(name) ? 'identity-evidence' : derivedTables.has(name) ? 'derived'
    : name.startsWith('synced_') || name === 'document_history' || name === 'document_trash' || name === 'document_block_moves'
      ? 'execution-history-evidence' : 'policy-unresolved'
}
export function validateCapsule2RawContent(input: unknown): Capsule2RawContent {
  const value = capsuleRecord(input, ['kind', 'version', 'forReader', 'schemaVersion', 'encoding', 'workspaceScope', 'recoveryEpoch', 'schemaHash',
    'legacyInventoryHash', 'derivedTablesNotRepeated', 'tables', 'state', 'semanticValidationComplete', 'certified'])
  if (value.kind !== 'restore-knowledge-capsule2-raw-content' || value.version !== 1 || value.forReader !== CAPSULE2_READER
    || value.schemaVersion !== 26 && value.schemaVersion !== 27 || !['UTF-8', 'UTF-16le', 'UTF-16be'].includes(value.encoding as string)
    || !uuid(value.workspaceScope) || !uuid(value.recoveryEpoch) || !digest(value.schemaHash) || !digest(value.legacyInventoryHash)
    || value.state !== 'raw-storage-only' || value.semanticValidationComplete !== false || value.certified !== false) return capsule2RawInvalid('raw content格式或非授权状态变化')
  const encoding = value.encoding as Capsule2Encoding
  const budget: RawBudget = { rows: 0, valueBytes: 0 }
  const tables = list(value.tables, 128).map(source => {
    const table = capsuleRecord(source, ['name', 'role', 'columns', 'primaryKey', 'rows'])
    if (!qname(table.name) || table.role !== capsule2TableRole(table.name)) return capsule2RawInvalid('表族/role无效')
    const columns = columnNames(table.columns), primaryKey = names(table.primaryKey)
    if (primaryKey.some(key => !columns.includes(key))) return capsule2RawInvalid('原PK不属于完整列')
    const rows = list(table.rows, CAPSULE2_RAW_MAX_ROWS).map(item => row(item, columns.length, encoding, budget))
    if (rows.some((item, index) => index > 0 && BigInt(rows[index - 1].sourceRowId) >= BigInt(item.sourceRowId)))
      return capsule2RawInvalid('原rowid顺序/完整行总预算不闭合')
    return { name: table.name, role: capsule2TableRole(table.name), columns, primaryKey, rows }
  })
  if (capsuleJson(tables.map(table => table.name)) !== capsuleJson(capsule2FixedDataTables(value.schemaVersion))) return capsule2RawInvalid('原表全集有未知/缺失/重复或未排序')
  const derivedTablesNotRepeated = names(value.derivedTablesNotRepeated)
  if (capsuleJson(derivedTablesNotRepeated) !== capsuleJson(capsule2DerivedFtsTables())) return capsule2RawInvalid('derived FTS原闭集未知/缺失/未排序')
  const result = { ...value, tables, derivedTablesNotRepeated } as unknown as Capsule2RawContent
  if (Buffer.byteLength(capsuleJson(result)) > CAPSULE2_RAW_MAX_JSON_BYTES) return capsule2RawInvalid('完整raw JSON超预算，不截断')
  return freezeCapsuleValue(result)
}
export const capsule2RawContentHash = (value: Capsule2RawContent): string => hash('knowbook.capsule2.raw-content.v1', validateCapsule2RawContent(value))
export function validateCapsule2RawCoverageSupports(input: unknown): Capsule2RawCoverageSupports {
  const value = capsuleRecord(input, ['kind', 'version', 'forReader', 'encoding', 'requirements', 'supports', 'state', 'certified', 'acceptedCoverage'])
  if (value.kind !== 'restore-knowledge-capsule2-raw-coverage-supports' || value.version !== 1 || value.forReader !== CAPSULE2_READER
    || !['UTF-8', 'UTF-16le', 'UTF-16be'].includes(value.encoding as string)
    || value.state !== 'unresolved-sql-supports-only' || value.certified !== false || value.acceptedCoverage !== false) return capsule2RawInvalid('coverage raw格式不是有限未授权态')
  const encoding = value.encoding as Capsule2Encoding
  const budget: RawBudget = { rows: 0, valueBytes: 0 }
  const requirements = validateRawPriorCoverageRequirements(value.requirements), expected = new Map<string, CoverageSqlRowReference>()
  for (const entry of requirements.entries) for (const support of Object.values(entry.supports)) if (support) {
    const key = capsuleJson([support.table, support.key]), previous = expected.get(key)
    if (previous && previous.rowHash !== support.rowHash) return capsule2RawInvalid('mandatory locator同key矛盾hash')
    expected.set(key, support)
  }
  const supports = list(value.supports, CAPSULE2_RAW_MAX_ROWS).map(source => {
    const support = capsuleRecord(source, ['reference', 'columns', 'row']), fields = capsuleRecord(support.reference, ['table', 'key', 'rowHash'])
    const key = capsuleJson([fields.table, fields.key]), wanted = expected.get(key), columns = columnNames(support.columns)
    if (!wanted || capsuleJson(wanted) !== capsuleJson(fields)) return capsule2RawInvalid('非mandatory/伪造的support locator')
    expected.delete(key)
    return { reference: wanted, columns, row: row(support.row, columns.length, encoding, budget) }
  })
  if (expected.size || supports.some((support, index) => index > 0 && capsuleJson([supports[index - 1].reference.table, supports[index - 1].reference.key]) >= capsuleJson([support.reference.table, support.reference.key])))
    return capsule2RawInvalid('mandatory支持全集有缺失/未排序')
  const result: Capsule2RawCoverageSupports = { kind: 'restore-knowledge-capsule2-raw-coverage-supports', version: 1, forReader: CAPSULE2_READER,
    encoding, requirements, supports, state: 'unresolved-sql-supports-only', certified: false, acceptedCoverage: false }
  if (Buffer.byteLength(capsuleJson(result)) > CAPSULE2_RAW_MAX_JSON_BYTES) return capsule2RawInvalid('完整mandatory支持超raw预算')
  return freezeCapsuleValue(result)
}
export const capsule2RawCoverageSupportsHash = (value: Capsule2RawCoverageSupports): string => hash('knowbook.capsule2.raw-coverage-supports.v1', validateCapsule2RawCoverageSupports(value))
/** Counts/hash only. Full raw rows include secrets and never belong in a UI,
 * diagnostic log, public backup wire or sparse-fact permission exchange. */
export function diagnoseCapsule2RawContent(value: Capsule2RawContent) {
  const raw = validateCapsule2RawContent(value)
  return freezeCapsuleValue({ kind: 'capsule2-raw-preparation-summary' as const, version: 1 as const,
    schemaVersion: raw.schemaVersion, contentHash: capsule2RawContentHash(raw),
    tables: raw.tables.map(table => ({ name: table.name, role: table.role, rows: table.rows.length })),
    policyUnresolvedTables: raw.tables.filter(table => table.role === 'policy-unresolved').map(table => table.name),
    certified: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const })
}
