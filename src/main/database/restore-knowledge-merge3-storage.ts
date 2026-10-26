import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES,
  capsule2ApplicationColumns, type Capsule2Encoding, type Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'
import { validateCoverageCapsuleReference, validateCoverageRootReference } from './restore-knowledge-coverage-model'
import { DURABLE_SQL_DAG_MAX_DEPTH } from './restore-knowledge-dag-model'
import { graph3Encode, graph3Text } from './restore-knowledge-graph3-data'
import type { Root3Witness } from './restore-knowledge-root3-model'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from './restore-knowledge-sql-cell'

/** This is a pure storage transform. A witness/DTO/hash is not a Main owner,
 * SQL reader, merge policy, foreign-key proof or installation capability. */
export const MERGE3_CONTENT_TABLES = Object.freeze(['blocks', 'database_entities', 'database_entity_values', 'database_saved_views',
  'databases', 'document_database_columns', 'document_database_values', 'document_templates', 'documents',
  'synced_group_blocks', 'synced_groups', 'synced_instances'] as const)
export type Merge3ContentTable = typeof MERGE3_CONTENT_TABLES[number]
export type Merge3Side = 'source' | 'current'
export interface Merge3Material {
  readonly payload: string; readonly materialHash: string; readonly witness: Root3Witness
}
export interface Merge3OriginalRowRef extends Merge3Material {
  readonly side: Merge3Side; readonly table: Merge3ContentTable; readonly sourceRowId: string; readonly originalRowHash: string
}
export interface Merge3InputRow {
  readonly key: string; readonly ref: Merge3OriginalRowRef
  readonly originalCells: readonly RawRestoreSqlCell[]
  /** Candidate values, aligned to target columns and encoded as target TEXT. */
  readonly cells: readonly RawRestoreSqlCell[]
  /** NULL means no automatic portable equality, including every NULL-key row. */
  readonly primaryKeyCells: readonly RawRestoreSqlCell[] | null
}
export type Merge3Row = Merge3InputRow
export interface PreparedMerge3Table {
  readonly kind: 'restore-merge3-prepared-content-table'; readonly version: 1
  readonly name: Merge3ContentTable; readonly columns: readonly string[]; readonly primaryKey: readonly string[]
  readonly sourceEncoding: Capsule2Encoding; readonly currentEncoding: Capsule2Encoding; readonly targetEncoding: Capsule2Encoding
  readonly originalColumns: { readonly source: readonly string[]; readonly current: readonly string[] }
  readonly sourceRows: readonly Merge3InputRow[]; readonly currentRows: readonly Merge3InputRow[]
  readonly preparedHash: string
}
export interface Merge3SelectedRow { readonly rowKey: string; readonly replaceCurrentRowKey: string | null }
export interface Merge3RowDisposition {
  readonly rowKey: string; readonly status: 'selected' | 'replaced' | 'excluded' | 'conflict'
  /** An explicit outer policy/scope/decision locator; storage does not interpret it. */
  readonly decision: string
}
export interface Merge3FinishedDisposition extends Merge3RowDisposition { readonly sourceRef: Merge3OriginalRowRef }
export interface MergedRow3 {
  readonly key: string; readonly targetRowId: string; readonly cells: readonly RawRestoreSqlCell[]
  readonly sourceRef: Merge3OriginalRowRef; readonly replaces: Merge3OriginalRowRef | null
}
export interface FinishedMerge3Table {
  readonly kind: 'restore-merge3-selected-content-table'; readonly version: 1
  readonly preparedHash: string
  readonly table: { readonly name: Merge3ContentTable; readonly role: 'content'; readonly columns: readonly string[]
    readonly primaryKey: readonly string[]; readonly encoding: Capsule2Encoding; readonly rows: readonly MergedRow3[] }
  readonly dispositions: readonly Merge3FinishedDisposition[]; readonly conflicts: readonly Merge3FinishedDisposition[]
  readonly complete: boolean; readonly semanticValidationComplete: false; readonly permit: false
  readonly storageHash: string
}
export interface PrepareMerge3TableInput {
  readonly sourceOriginal: Capsule2RawSqlTable; readonly sourceCandidate: Capsule2RawSqlTable; readonly currentOriginal: Capsule2RawSqlTable
  readonly sourceEncoding: Capsule2Encoding; readonly currentEncoding: Capsule2Encoding
  readonly source: Merge3Material; readonly current: Merge3Material
}
const fail = (message: string): never => { throw new Error('merge3存储候选无效：' + message + '；纯数据不授SQL或安装权。') }
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const primaryKeys = {
  blocks: ['id'], database_entities: ['id'], database_entity_values: ['entity_id', 'column_id'], database_saved_views: ['id'],
  databases: ['id'], document_database_columns: ['id'], document_database_values: ['document_id', 'column_id'],
  document_templates: ['id'], documents: ['id'], synced_group_blocks: ['id'], synced_groups: ['id'], synced_instances: ['instance_id']
} as const satisfies Record<Merge3ContentTable, readonly string[]>
const fixedColumns = new Map(capsule2ApplicationColumns())
fixedColumns.set('synced_groups', ['id', 'creation_id', 'created_at', 'origin_json', 'bindings_json', 'revision', 'topology_revision', 'history_cursor', 'history_position'])
fixedColumns.set('synced_group_blocks', ['id', 'group_id', 'parent_block_id', 'sort_order', 'type', 'content', 'checked', 'depth',
  'tags_json', 'language', 'list_start', 'markdown_format_json', 'highlight', 'created_at'])
fixedColumns.set('synced_instances', ['instance_id', 'group_id', 'host_document_id', 'binding_version', 'parent_block_id', 'depth'])
const int64 = (value: unknown): value is string => typeof value === 'string' && value.length <= 20 && /^(?:0|-?[1-9][0-9]*)$/.test(value)
  && BigInt(value) >= -(2n ** 63n) && BigInt(value) < 2n ** 63n
const digest = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : fail('完整原件hash无效')
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return fail('数组超预算/含hole或额外字段')
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : fail('数组含访问器')
  })
}
function encoding(value: unknown): Capsule2Encoding {
  return value === 'UTF-8' || value === 'UTF-16le' || value === 'UTF-16be' ? value : fail('未知TEXT编码')
}
function tableName(value: unknown): Merge3ContentTable {
  return MERGE3_CONTENT_TABLES.includes(value as Merge3ContentTable) ? value as Merge3ContentTable : fail('不是固定12张content表')
}
function columns(value: unknown, table: Merge3ContentTable): string[] {
  const names = array(value, 512)
  if (!same([...names].sort(), [...fixedColumns.get(table)!].sort())) return fail('完整列闭集不一致：' + table)
  return names as string[]
}
function pk(value: unknown, table: Merge3ContentTable): string[] {
  const names = array(value, 8)
  return same(names, primaryKeys[table]) ? names as string[] : fail('固定PK不一致：' + table)
}
interface Budget { rows: number; valueBytes: number; jsonBytes: number }
const budget = (): Budget => ({ rows: 0, valueBytes: 0, jsonBytes: 0 })
function take(b: Budget, field: keyof Budget, amount: number): void {
  const limit = field === 'rows' ? CAPSULE2_RAW_MAX_ROWS : field === 'valueBytes' ? CAPSULE2_RAW_MAX_VALUE_BYTES : CAPSULE2_RAW_MAX_JSON_BYTES
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > limit - b[field]) return fail('完整' + field + '超原有限预算，不截断')
  b[field] += amount
}
function jsonBudget(value: unknown): void {
  // Count actual JSON bytes before serializing the whole DTO. Descriptors are
  // inspected first, so neither getters nor toJSON can run in this data layer.
  const b = budget(), ancestors = new Set<object>()
  const stack: Array<{ value: unknown; exit?: boolean }> = [{ value }]
  while (stack.length) {
    const task = stack.pop()!, item = task.value
    if (task.exit) { ancestors.delete(item as object); continue }
    if (typeof item === 'string') { take(b, 'jsonBytes', Buffer.byteLength(JSON.stringify(item))); continue }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) {
      take(b, 'jsonBytes', String(item).length); continue
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) return fail('JSON含非data值或循环')
    ancestors.add(item); stack.push({ value: item, exit: true })
    if (Array.isArray(item)) {
      const values = array(item, CAPSULE2_RAW_MAX_ROWS * 2)
      take(b, 'jsonBytes', 2 + Math.max(0, values.length - 1))
      for (let index = values.length - 1; index >= 0; index--) stack.push({ value: values[index] })
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)) return fail('JSON不是plain data对象')
      const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors)
      take(b, 'jsonBytes', 2 + Math.max(0, keys.length - 1))
      for (const key of keys) {
        const descriptor = typeof key === 'string' ? descriptors[key] : null
        if (!descriptor?.enumerable || !('value' in descriptor)) return fail('JSON含访问器/非enumerable字段')
        take(b, 'jsonBytes', Buffer.byteLength(JSON.stringify(key)) + 1)
        stack.push({ value: descriptor.value })
      }
    }
  }
}
export { jsonBudget as assertMerge3JsonBudget }
function cell(value: unknown, textEncoding: Capsule2Encoding, b: Budget): RawRestoreSqlCell {
  const tuple = array(value, 2), tag = tuple[0]
  if (tag === 'null' && tuple.length === 1) { take(b, 'valueBytes', 8); return ['null'] }
  if (tuple.length !== 2 || typeof tuple[1] !== 'string') return fail('原storage cell格式无效')
  if (tag === 'integer' && int64(tuple[1])) { take(b, 'valueBytes', 8); return ['integer', tuple[1]] }
  if (tag === 'real-ieee754-le' && /^[0-9a-f]{16}$/.test(tuple[1])) { take(b, 'valueBytes', 8); return ['real-ieee754-le', tuple[1]] }
  if ((tag === 'text' || tag === 'blob') && tuple[1].length % 4 === 0) {
    const padding = tuple[1].endsWith('==') ? 2 : tuple[1].endsWith('=') ? 1 : 0
    take(b, 'valueBytes', tuple[1].length / 4 * 3 - padding)
    const bytes = Buffer.from(tuple[1], 'base64')
    if (bytes.toString('base64') === tuple[1]) return rawRestoreSqlCell(tag, bytes, textEncoding)
  }
  return fail('未知storage class或非canonical原字节')
}
function cells(value: unknown, width: number, textEncoding: Capsule2Encoding, b: Budget): RawRestoreSqlCell[] {
  const values = array(value, 512)
  if (values.length !== width) return fail('完整原行宽度不一致')
  take(b, 'rows', 1)
  const checked = values.map(value => cell(value, textEncoding, b))
  take(b, 'jsonBytes', Buffer.byteLength(capsuleJson(checked)))
  return checked
}
function material(value: unknown, side: Merge3Side): Merge3Material {
  const source = capsuleRecord(value, ['payload', 'materialHash', 'witness'])
  const witness = capsuleRecord(source.witness, ['domain', 'side', 'capsule', 'projectionHash'])
  if (witness.side !== side) return fail('witness side与原行角色不同')
  return { payload: digest(source.payload), materialHash: digest(source.materialHash), witness: {
    domain: array(witness.domain, DURABLE_SQL_DAG_MAX_DEPTH).map(validateCoverageRootReference), side,
    capsule: validateCoverageCapsuleReference(witness.capsule), projectionHash: digest(witness.projectionHash)
  } }
}
function originalRowHash(name: Merge3ContentTable, columnNames: readonly string[], primaryKey: readonly string[],
  textEncoding: Capsule2Encoding, sourceRowId: string, originalCells: readonly RawRestoreSqlCell[]): string {
  return hash('knowbook.restore.merge3.original-row.v1', { table: name, columns: columnNames, primaryKey, encoding: textEncoding, sourceRowId, cells: originalCells })
}
function rowKey(ref: Merge3OriginalRowRef): string {
  // The locator includes its side and actual rowid. A matching value/hash in a
  // different domain, table, material or occurrence is never a merged row.
  return capsuleJson([ref.side, ref.payload, ref.materialHash, ref.table, ref.sourceRowId,
    hash('knowbook.restore.merge3.row-witness.v1', ref.witness)])
}
function primaryKeyCells(columnNames: readonly string[], primaryKey: readonly string[], row: readonly RawRestoreSqlCell[]) {
  const result = primaryKey.map(name => row[columnNames.indexOf(name)])
  // All application content PK values are TEXT identities; numeric coercion is
  // not a portable identity proof. NULL remains an occurrence, never a key.
  if (result.some(value => value[0] === 'null')) return null
  if (result.some(value => value[0] !== 'text')) return fail('非NULL content PK不是TEXT身份')
  return result
}
function originalTable(value: unknown, textEncoding: Capsule2Encoding) {
  const table = capsuleRecord(value, ['name', 'role', 'columns', 'primaryKey', 'rows']), name = tableName(table.name)
  if (table.role !== 'content') return fail('表role不是content')
  const columnNames = columns(table.columns, name), primaryKey = pk(table.primaryKey, name), b = budget()
  let previous: bigint | null = null
  const rows = array(table.rows, CAPSULE2_RAW_MAX_ROWS).map(value => {
    const row = capsuleRecord(value, ['sourceRowId', 'cells'])
    if (!int64(row.sourceRowId) || previous !== null && previous >= BigInt(row.sourceRowId)) return fail('原rowid不合法或未严格递增')
    previous = BigInt(row.sourceRowId)
    return { sourceRowId: row.sourceRowId, cells: cells(row.cells, columnNames.length, textEncoding, b) }
  })
  const result = { name, role: 'content' as const, columns: columnNames, primaryKey, rows }
  jsonBudget(result)
  return result
}

export function prepareMerge3Table(input: PrepareMerge3TableInput): PreparedMerge3Table {
  const value = capsuleRecord(input, ['sourceOriginal', 'sourceCandidate', 'currentOriginal', 'sourceEncoding', 'currentEncoding', 'source', 'current'])
  const sourceEncoding = encoding(value.sourceEncoding), currentEncoding = encoding(value.currentEncoding)
  const source = originalTable(value.sourceOriginal, sourceEncoding), candidate = originalTable(value.sourceCandidate, sourceEncoding)
  const current = originalTable(value.currentOriginal, currentEncoding)
  if (source.name !== candidate.name || source.name !== current.name || !same(source.rows.map(row => row.sourceRowId), candidate.rows.map(row => row.sourceRowId)))
    return fail('source候选必须逐原行对应同一表，不得新增/省略/合并occurrence')
  const sourceMaterial = material(value.source, 'source'), currentMaterial = material(value.current, 'current')
  const targetColumns = current.columns, primaryKey = current.primaryKey, preparedBudget = budget()
  const makeRows = (side: Merge3Side, original: typeof source, incoming: typeof source, meta: Merge3Material,
    originalEncoding: Capsule2Encoding): Merge3InputRow[] => {
    const b = budget()
    return original.rows.map((row, index) => {
      const incomingRow = incoming.rows[index]
      const aligned = targetColumns.map(name => {
        const value = incomingRow.cells[incoming.columns.indexOf(name)]
        return value[0] === 'text' && originalEncoding !== currentEncoding ? graph3Encode(graph3Text(value, originalEncoding), currentEncoding) : value
      })
      const targetCells = cells(aligned, targetColumns.length, currentEncoding, b)
      const ref: Merge3OriginalRowRef = { ...meta, side, table: source.name, sourceRowId: row.sourceRowId,
        originalRowHash: originalRowHash(source.name, original.columns, primaryKey, originalEncoding, row.sourceRowId, row.cells) }
      const result = { key: rowKey(ref), ref, originalCells: row.cells,
        cells: targetCells, primaryKeyCells: primaryKeyCells(targetColumns, primaryKey, targetCells) }
      take(preparedBudget, 'jsonBytes', Buffer.byteLength(capsuleJson(result)))
      return result
    })
  }
  const body = { kind: 'restore-merge3-prepared-content-table' as const, version: 1 as const, name: source.name,
    columns: targetColumns, primaryKey, sourceEncoding, currentEncoding, targetEncoding: currentEncoding,
    originalColumns: { source: source.columns, current: current.columns },
    sourceRows: makeRows('source', source, candidate, sourceMaterial, sourceEncoding), currentRows: makeRows('current', current, current, currentMaterial, currentEncoding) }
  jsonBudget(body)
  return freezeCapsuleValue({ ...body, preparedHash: hash('knowbook.restore.merge3.prepared-table.v1', body) })
}

/** Validate data afresh, including full original-row hashes. This intentionally
 * accepts a consistent plain-data clone; it never treats one as an owned read. */
function preparedTable(input: PreparedMerge3Table): PreparedMerge3Table {
  const value = capsuleRecord(input, ['kind', 'version', 'name', 'columns', 'primaryKey', 'sourceEncoding', 'currentEncoding', 'targetEncoding',
    'originalColumns', 'sourceRows', 'currentRows', 'preparedHash'])
  if (value.kind !== 'restore-merge3-prepared-content-table' || value.version !== 1) return fail('未知prepared格式')
  const name = tableName(value.name), targetColumns = columns(value.columns, name), primaryKey = pk(value.primaryKey, name)
  const sourceEncoding = encoding(value.sourceEncoding), currentEncoding = encoding(value.currentEncoding)
  if (encoding(value.targetEncoding) !== currentEncoding) return fail('目标TEXT编码必须为current编码')
  const original = capsuleRecord(value.originalColumns, ['source', 'current'])
  const originalColumns = { source: columns(original.source, name), current: columns(original.current, name) }
  if (!same(originalColumns.current, targetColumns)) return fail('目标列必须是真实current列顺序')
  const keys = new Set<string>(), preparedBudget = budget()
  const readRows = (side: Merge3Side, input: unknown): Merge3InputRow[] => {
    const originalBudget = budget(), targetBudget = budget(), textEncoding = side === 'source' ? sourceEncoding : currentEncoding
    let previous: bigint | null = null
    return array(input, CAPSULE2_RAW_MAX_ROWS).map(input => {
      const row = capsuleRecord(input, ['key', 'ref', 'originalCells', 'cells', 'primaryKeyCells'])
      const ref = capsuleRecord(row.ref, ['payload', 'materialHash', 'witness', 'side', 'table', 'sourceRowId', 'originalRowHash'])
      if (ref.side !== side || ref.table !== name || !int64(ref.sourceRowId) || previous !== null && previous >= BigInt(ref.sourceRowId))
        return fail('原row ref角色/表/rowid变化')
      previous = BigInt(ref.sourceRowId)
      const meta = material({ payload: ref.payload, materialHash: ref.materialHash, witness: ref.witness }, side)
      const originalCells = cells(row.originalCells, originalColumns[side].length, textEncoding, originalBudget)
      const targetCells = cells(row.cells, targetColumns.length, currentEncoding, targetBudget)
      const originalRowRef: Merge3OriginalRowRef = { ...meta, side, table: name, sourceRowId: ref.sourceRowId,
        originalRowHash: originalRowHash(name, originalColumns[side], primaryKey, textEncoding, ref.sourceRowId, originalCells) }
      if (ref.originalRowHash !== originalRowRef.originalRowHash || row.key !== rowKey(originalRowRef)
        || keys.has(String(row.key))) return fail('完整原行hash/key不一致或重复')
      keys.add(String(row.key))
      const keyCells = primaryKeyCells(targetColumns, primaryKey, targetCells)
      // Validate the supplied redundant PK without evaluating accessors.
      const declared = row.primaryKeyCells === null ? null : array(row.primaryKeyCells, 8).map(value => cell(value, currentEncoding, budget()))
      if (!same(declared, keyCells)) return fail('目标PK与完整cell不一致')
      if (side === 'current' && !same(originalCells, targetCells)) return fail('current保留行不得改写原值')
      const result = { key: String(row.key), ref: originalRowRef, originalCells, cells: targetCells, primaryKeyCells: keyCells }
      take(preparedBudget, 'jsonBytes', Buffer.byteLength(capsuleJson(result)))
      return result
    })
  }
  const body = { kind: 'restore-merge3-prepared-content-table' as const, version: 1 as const, name, columns: targetColumns, primaryKey,
    sourceEncoding, currentEncoding, targetEncoding: currentEncoding, originalColumns,
    sourceRows: readRows('source', value.sourceRows), currentRows: readRows('current', value.currentRows) }
  jsonBudget(body)
  if (digest(value.preparedHash) !== hash('knowbook.restore.merge3.prepared-table.v1', body)) return fail('prepared完整hash不一致')
  return { ...body, preparedHash: value.preparedHash as string }
}

export function finishMerge3Table(input: PreparedMerge3Table, selectedRows: readonly Merge3SelectedRow[],
  dispositions: readonly Merge3RowDisposition[]): FinishedMerge3Table {
  const prepared = preparedTable(input), all = [...prepared.sourceRows, ...prepared.currentRows], rows = new Map(all.map(row => [row.key, row]))
  const choices = new Map<string, Merge3SelectedRow>()
  for (const input of array(selectedRows, CAPSULE2_RAW_MAX_ROWS)) {
    const value = capsuleRecord(input, ['rowKey', 'replaceCurrentRowKey'])
    if (typeof value.rowKey !== 'string' || !rows.has(value.rowKey) || choices.has(value.rowKey)
      || value.replaceCurrentRowKey !== null && (typeof value.replaceCurrentRowKey !== 'string' || !rows.has(value.replaceCurrentRowKey))) return fail('选择引用缺失/重复')
    choices.set(value.rowKey, { rowKey: value.rowKey, replaceCurrentRowKey: value.replaceCurrentRowKey as string | null })
  }
  const seen = new Set<string>(), checkedDispositions: Merge3RowDisposition[] = [], dispositionBudget = budget()
  for (const input of array(dispositions, CAPSULE2_RAW_MAX_ROWS * 2)) {
    const value = capsuleRecord(input, ['rowKey', 'status', 'decision'])
    if (typeof value.rowKey !== 'string' || !rows.has(value.rowKey) || seen.has(value.rowKey)
      || typeof value.status !== 'string' || !['selected', 'replaced', 'excluded', 'conflict'].includes(value.status)
      || typeof value.decision !== 'string' || !value.decision.trim().length
      || value.decision.length > 16_384 || (value.status === 'selected') !== choices.has(value.rowKey)) return fail('每原行必须恰有准确显式disposition')
    seen.add(value.rowKey)
    const checked = { rowKey: value.rowKey, status: value.status as Merge3RowDisposition['status'], decision: value.decision }
    take(dispositionBudget, 'jsonBytes', Buffer.byteLength(capsuleJson(checked)))
    checkedDispositions.push(checked)
  }
  if (seen.size !== rows.size) return fail('存在无disposition原行')
  const byDisposition = new Map(checkedDispositions.map(row => [row.rowKey, row]))
  const occupied = new Set(prepared.currentRows.map(row => row.ref.sourceRowId)), targetRowIds = new Set<string>(), targetKeys = new Set<string>()
  const output: MergedRow3[] = [], b = budget()
  let next = 1n
  const selected = all.filter(row => choices.has(row.key)) // stable original rowid order, independent of caller choice order
  for (const row of selected) {
    const choice = choices.get(row.key)!, replaced = choice.replaceCurrentRowKey === null ? null : rows.get(choice.replaceCurrentRowKey)!
    if (replaced && (row.ref.side !== 'source' || replaced.ref.side !== 'current' || byDisposition.get(replaced.key)!.status !== 'replaced'
      || row.primaryKeyCells === null || replaced.primaryKeyCells === null || !same(row.primaryKeyCells, replaced.primaryKeyCells)))
      return fail('只有显式准确非NULL PK来源替换可复用current rowid')
    let targetRowId: string
    if (row.ref.side === 'current') {
      if (replaced) return fail('current保留不能声明替换别行')
      targetRowId = row.ref.sourceRowId
    } else if (replaced) targetRowId = replaced.ref.sourceRowId
    else {
      while (occupied.has(next.toString()) || targetRowIds.has(next.toString())) next++
      if (next >= 2n ** 63n) return fail('未占用正int64 rowid耗尽')
      targetRowId = next.toString(); next++
    }
    if (targetRowIds.has(targetRowId)) return fail('目标rowid被重复认领')
    targetRowIds.add(targetRowId)
    if (row.primaryKeyCells !== null) {
      const identity = capsuleJson(row.primaryKeyCells)
      if (targetKeys.has(identity)) return fail('目标非NULL PK重复，storage不自动upsert')
      targetKeys.add(identity)
    }
    const targetCells = cells(row.cells, prepared.columns.length, prepared.currentEncoding, b)
    const target: MergedRow3 = { key: row.key, targetRowId, cells: targetCells, sourceRef: row.ref, replaces: replaced?.ref ?? null }
    const { cells: _cells, ...targetMetadata } = target
    take(b, 'jsonBytes', Buffer.byteLength(capsuleJson(targetMetadata)))
    output.push(target)
  }
  output.sort((a, b) => BigInt(a.targetRowId) < BigInt(b.targetRowId) ? -1 : 1)
  const orderedDispositions = all.map(row => ({ ...byDisposition.get(row.key)!, sourceRef: row.ref }))
  const conflicts = orderedDispositions.filter(row => row.status === 'conflict')
  const body = { kind: 'restore-merge3-selected-content-table' as const, version: 1 as const, preparedHash: prepared.preparedHash,
    table: { name: prepared.name, role: 'content' as const, columns: prepared.columns, primaryKey: prepared.primaryKey,
      encoding: prepared.currentEncoding, rows: output }, dispositions: orderedDispositions, conflicts, complete: conflicts.length === 0,
    semanticValidationComplete: false as const, permit: false as const }
  jsonBudget(body)
  return freezeCapsuleValue({ ...body, storageHash: hash('knowbook.restore.merge3.selected-table.v1', body) })
}

/** Planning convenience only. Decoded BigInts/Buffers are deliberately not
 * stored in the serializable DTO or any hash. No SQL is read by this helper. */
export function merge3RowValues(prepared: PreparedMerge3Table, row: Merge3InputRow): Record<string, unknown> {
  const metadata = capsuleRecord(prepared, ['kind', 'version', 'name', 'columns', 'primaryKey', 'sourceEncoding', 'currentEncoding',
    'targetEncoding', 'originalColumns', 'sourceRows', 'currentRows', 'preparedHash'])
  const columnNames = columns(metadata.columns, tableName(metadata.name)), textEncoding = encoding(metadata.targetEncoding)
  const input = capsuleRecord(row, ['key', 'ref', 'originalCells', 'cells', 'primaryKeyCells'])
  const values = cells(input.cells, columnNames.length, textEncoding, budget())
  return Object.fromEntries(columnNames.map((column, index) => {
    const value = values[index]
    return [column, value[0] === 'null' ? null : value[0] === 'text' ? graph3Text(value, textEncoding)
      : value[0] === 'integer' ? BigInt(value[1]) : value[0] === 'real-ieee754-le' ? Buffer.from(value[1], 'hex').readDoubleLE()
        : Buffer.from(value[1], 'base64')]
  }))
}

/** Aggregate the ACTUAL selected rows, not caller budget counters. The outer
 * complete candidate must call this for its fixed 12-table closure. */
export function assertMerge3StorageTablesBudget(tables: readonly FinishedMerge3Table[]): void {
  const input = array(tables, MERGE3_CONTENT_TABLES.length), names = new Set<string>(), b = budget()
  let targetEncoding: Capsule2Encoding | null = null
  for (const value of input) {
    const finished = capsuleRecord(value, ['kind', 'version', 'preparedHash', 'table', 'dispositions', 'conflicts', 'complete',
      'semanticValidationComplete', 'permit', 'storageHash'])
    const table = capsuleRecord(finished.table, ['name', 'role', 'columns', 'primaryKey', 'encoding', 'rows'])
    const name = tableName(table.name), namesInTable = columns(table.columns, name), textEncoding = encoding(table.encoding)
    pk(table.primaryKey, name)
    if (names.has(name) || table.role !== 'content') return fail('完整目标表闭集重复/role变化')
    if (targetEncoding !== null && targetEncoding !== textEncoding) return fail('完整目标各表TEXT编码不一致')
    targetEncoding = textEncoding
    names.add(name)
    for (const input of array(table.rows, CAPSULE2_RAW_MAX_ROWS)) {
      const row = capsuleRecord(input, ['key', 'targetRowId', 'cells', 'sourceRef', 'replaces'])
      if (!int64(row.targetRowId)) return fail('目标rowid无效')
      cells(row.cells, namesInTable.length, textEncoding, b)
    }
  }
  if (names.size !== MERGE3_CONTENT_TABLES.length) return fail('完整目标必须包含固定12张content表')
  jsonBudget(tables)
}
