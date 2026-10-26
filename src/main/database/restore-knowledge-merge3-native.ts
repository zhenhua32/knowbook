import Database from 'better-sqlite3'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES,
  capsule2ApplicationColumns, type Capsule2Encoding } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Text } from './restore-knowledge-graph3-data'
import { MERGE3_CONTENT_TABLES, assertMerge3JsonBudget, type FinishedMerge3Table, type Merge3ContentTable } from './restore-knowledge-merge3-storage'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from './restore-knowledge-sql-cell'

type Table = FinishedMerge3Table['table']
type Collation = 'BINARY' | 'NOCASE'
export interface Merge3NativeConflict {
  readonly code: string; readonly table: Merge3ContentTable; readonly rowKeys: readonly string[]
  readonly detail: { readonly constraint: string; readonly columns: readonly string[]; readonly collations: readonly Collation[]; readonly count: number }
}
interface Check {
  rule: string; code: string; table: Merge3ContentTable; constraint: string; columns: string[]; collations: Collation[]
  rowsChecked: number; nullKeyRowsSkipped: number; duplicateGroups: number
}
interface Entry { rule: string; table: Merge3ContentTable; rowKey: string; first: string; second: string; collation: Collation }
const fail = (code: string, detail: unknown): never => graph3Conflict('merge-native-' + code, detail)
const same = (left: unknown, right: unknown) => capsuleJson(left) === capsuleJson(right)
const fixedColumns = new Map(capsule2ApplicationColumns())
fixedColumns.set('synced_groups', ['id', 'creation_id', 'created_at', 'origin_json', 'bindings_json', 'revision', 'topology_revision', 'history_cursor', 'history_position'])
fixedColumns.set('synced_group_blocks', ['id', 'group_id', 'parent_block_id', 'sort_order', 'type', 'content', 'checked', 'depth', 'tags_json', 'language', 'list_start', 'markdown_format_json', 'highlight', 'created_at'])
fixedColumns.set('synced_instances', ['instance_id', 'group_id', 'host_document_id', 'binding_version', 'parent_block_id', 'depth'])
const primaryKey = (name: Merge3ContentTable): string[] => name === 'database_entity_values' ? ['entity_id', 'column_id']
  : name === 'document_database_values' ? ['document_id', 'column_id'] : [name === 'synced_instances' ? 'instance_id' : 'id']
const int64 = (value: unknown): value is string => typeof value === 'string' && value.length <= 20 && /^(?:0|-?[1-9][0-9]*)$/.test(value)
  && BigInt(value) >= -(2n ** 63n) && BigInt(value) < 2n ** 63n
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1)
    return fail('finite-array', null)
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : fail('array-accessor', index)
  })
}
function encoding(value: unknown): Capsule2Encoding {
  return value === 'UTF-8' || value === 'UTF-16le' || value === 'UTF-16be' ? value : fail('encoding', value)
}
function text(value: unknown): string { return typeof value === 'string' ? value : fail('text', typeof value) }

/** Actual SQLite comparison of complete candidate storage keys. This writable
 * bounded :memory: database is ONLY a collation instrument, never a stage,
 * readonly source reader, foreign-key proof or installation certification.
 * It does not instantiate Store or touch source/current/history/guards. */
export function checkMerge3NativeStorage3(input: readonly Table[]) {
  assertMerge3JsonBudget(input)
  const tables = array(input, MERGE3_CONTENT_TABLES.length), names = new Set<string>(), keys = new Set<string>()
  const checks: Check[] = [], entries: Entry[] = []
  let rows = 0, valueBytes = 0, jsonBytes = 2, targetEncoding: Capsule2Encoding | null = null
  const take = (kind: 'value' | 'json', bytes: number) => {
    const previous = kind === 'value' ? valueBytes : jsonBytes, limit = kind === 'value' ? CAPSULE2_RAW_MAX_VALUE_BYTES : CAPSULE2_RAW_MAX_JSON_BYTES
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit - previous) return fail(kind + '-budget', null)
    if (kind === 'value') valueBytes += bytes; else jsonBytes += bytes
  }
  function cell(value: unknown, enc: Capsule2Encoding): RawRestoreSqlCell {
    const tuple = array(value, 2)
    if (tuple[0] === 'null' && tuple.length === 1) { take('value', 8); return ['null'] }
    if (tuple.length !== 2 || typeof tuple[1] !== 'string') return fail('storage-cell', null)
    if (tuple[0] === 'integer' && int64(tuple[1])) { take('value', 8); return ['integer', tuple[1]] }
    if (tuple[0] === 'real-ieee754-le' && /^[0-9a-f]{16}$/.test(tuple[1])) { take('value', 8); return ['real-ieee754-le', tuple[1]] }
    if ((tuple[0] === 'text' || tuple[0] === 'blob') && tuple[1].length % 4 === 0) {
      const padding = tuple[1].endsWith('==') ? 2 : tuple[1].endsWith('=') ? 1 : 0
      take('value', tuple[1].length / 4 * 3 - padding)
      const bytes = Buffer.from(tuple[1], 'base64')
      if (bytes.toString('base64') === tuple[1]) return rawRestoreSqlCell(tuple[0], bytes, enc)
    }
    return fail('storage-cell', null)
  }
  function add(check: Check, rowKey: string, cells: readonly RawRestoreSqlCell[], columns: readonly string[], enc: Capsule2Encoding) {
    const values = check.columns.map(column => cells[columns.indexOf(column)])
    // SQLite UNIQUE/PRIMARY KEY comparisons leave every NULL-key occurrence
    // independent. This also matches the existing nullable document values.
    if (values.some(value => value[0] === 'null')) { check.nullKeyRowsSkipped++; return }
    if (values.some(value => value[0] !== 'text')) return fail('comparison-key-storage-class', { table: check.table, rowKey })
    check.rowsChecked++
    entries.push({ rule: check.rule, table: check.table, rowKey, first: graph3Text(values[0], enc),
      second: values.length === 2 ? graph3Text(values[1], enc) : '', collation: check.collations[check.collations.length - 1] })
  }
  for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
    const source = capsuleRecord(tables[tableIndex], ['name', 'role', 'columns', 'primaryKey', 'encoding', 'rows'])
    if (!MERGE3_CONTENT_TABLES.includes(source.name as Merge3ContentTable) || source.role !== 'content' || names.has(String(source.name))) return fail('table-closure', source.name)
    const name = source.name as Merge3ContentTable, enc = encoding(source.encoding), columns = array(source.columns, 512).map(text)
    if (!same([...columns].sort(), [...fixedColumns.get(name)!].sort()) || !same(array(source.primaryKey, 2), primaryKey(name))) return fail('fixed-columns-or-pk', name)
    if (targetEncoding !== null && targetEncoding !== enc) return fail('mixed-target-encoding', name)
    targetEncoding = enc; names.add(name)
    const tableChecks: Check[] = [{ rule: name + ':primary-key', code: 'native-binary-primary-key-duplicate', table: name,
      constraint: 'non-null-primary-key', columns: primaryKey(name), collations: primaryKey(name).map(() => 'BINARY'),
      rowsChecked: 0, nullKeyRowsSkipped: 0, duplicateGroups: 0 }]
    if (name === 'documents') tableChecks.push({ rule: name + ':slug', code: 'native-binary-document-slug-duplicate', table: name,
      constraint: 'document-slug', columns: ['slug'], collations: ['BINARY'], rowsChecked: 0, nullKeyRowsSkipped: 0, duplicateGroups: 0 })
    if (name === 'database_saved_views') tableChecks.push({ rule: name + ':database-name', code: 'native-nocase-saved-view-name-duplicate', table: name,
      constraint: 'database-saved-view-name', columns: ['database_id', 'name'], collations: ['BINARY', 'NOCASE'], rowsChecked: 0, nullKeyRowsSkipped: 0, duplicateGroups: 0 })
    if (name === 'database_entities') tableChecks.push({ rule: name + ':database-document', code: 'native-binary-database-document-duplicate', table: name,
      constraint: 'non-null-database-entity-document', columns: ['database_id', 'document_id'], collations: ['BINARY', 'BINARY'], rowsChecked: 0, nullKeyRowsSkipped: 0, duplicateGroups: 0 })
    checks.push(...tableChecks)
    const tableRows = array(source.rows, CAPSULE2_RAW_MAX_ROWS)
    take('json', Buffer.byteLength(capsuleJson({ ...source, rows: [] })) + (tableIndex ? 1 : 0))
    for (let index = 0; index < tableRows.length; index++) {
      const row = capsuleRecord(tableRows[index], ['key', 'targetRowId', 'cells', 'sourceRef', 'replaces']), rowKey = text(row.key)
      if (++rows > CAPSULE2_RAW_MAX_ROWS || keys.has(rowKey) || !int64(row.targetRowId)) return fail('row-closure-or-budget', { table: name, rowKey })
      keys.add(rowKey)
      const cells = array(row.cells, 512).map(value => cell(value, enc))
      if (cells.length !== columns.length) return fail('row-width', name)
      take('json', Buffer.byteLength(capsuleJson(row)) + (index ? 1 : 0))
      for (const check of tableChecks) add(check, rowKey, cells, columns, enc)
    }
  }
  if (names.size !== MERGE3_CONTENT_TABLES.length || targetEncoding === null) return fail('complete-twelve-tables-required', null)
  const conflicts: Merge3NativeConflict[] = [], checkByRule = new Map(checks.map(check => [check.rule, check]))
  let conflictKeyMinimumBytes = 0
  const db = new Database(':memory:')
  try {
    db.pragma("encoding = '" + targetEncoding + "'")
    db.exec(`CREATE TABLE comparisons (ordinal INTEGER PRIMARY KEY, rule TEXT NOT NULL, table_name TEXT NOT NULL,
      row_key TEXT NOT NULL, first_key TEXT NOT NULL, second_key TEXT NOT NULL, name_collation TEXT NOT NULL);
      CREATE INDEX comparisons_binary ON comparisons(name_collation,rule,first_key COLLATE BINARY,second_key COLLATE BINARY);
      CREATE INDEX comparisons_nocase ON comparisons(name_collation,rule,first_key COLLATE BINARY,second_key COLLATE NOCASE);`)
    const insert = db.prepare('INSERT INTO comparisons(rule,table_name,row_key,first_key,second_key,name_collation) VALUES(?,?,?,?,?,?)')
    db.transaction(() => { for (const entry of entries) insert.run(entry.rule, entry.table, entry.rowKey, entry.first, entry.second, entry.collation) })()
    for (const collation of ['BINARY', 'NOCASE'] as const) {
      // All grouping and membership comparisons stay in this actual engine.
      // Never round-trip a representative NUL-containing name through JS and
      // then use JS folding/equality to reconstruct its conflict membership.
      const duplicateRows = db.prepare(`WITH duplicates AS (
        SELECT MIN(ordinal) AS representative FROM comparisons WHERE name_collation=?
        GROUP BY rule,first_key COLLATE BINARY,second_key COLLATE ${collation} HAVING COUNT(*)>1
      ) SELECT d.representative,e.rule,e.row_key FROM duplicates d
        JOIN comparisons r ON r.ordinal=d.representative
        JOIN comparisons e ON e.rule=r.rule COLLATE BINARY AND e.first_key=r.first_key COLLATE BINARY
          AND e.second_key=r.second_key COLLATE ${collation} AND e.name_collation=r.name_collation
        ORDER BY d.representative,e.ordinal`).iterate(collation) as IterableIterator<{ representative: number; rule: string; row_key: string }>
      let representative: number | null = null
      let selected: { rowKeys: string[]; detail: { constraint: string; columns: string[]; collations: Collation[]; count: number } } | null = null
      for (const row of duplicateRows) {
        if (representative !== row.representative) {
          const check = checkByRule.get(row.rule) ?? fail('unknown-native-rule', row.rule)
          check.duplicateGroups++
          selected = { rowKeys: [], detail: { constraint: check.constraint, columns: check.columns, collations: check.collations, count: 0 } }
          representative = row.representative
          conflicts.push({ code: check.code, table: check.table, rowKeys: selected.rowKeys,
            detail: selected.detail })
        }
        conflictKeyMinimumBytes += Buffer.byteLength(capsuleJson(row.row_key))
        if (conflictKeyMinimumBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('conflict-row-key-budget', null)
        selected!.rowKeys.push(row.row_key)
        // The result records all conflicting rows, never just one LIMIT probe.
        selected!.detail.count++
      }
    }
  } finally { db.close() }
  const body = { kind: 'root-restore-native-storage-checks' as const, version: 3 as const, scope: 'candidate-storage-collations-only' as const,
    engine: 'SQLite' as const, database: ':memory:' as const, targetEncoding, checkedRows: rows, comparisonRows: entries.length,
    checks, conflicts, sourceSqlRead: false as const, stagingDatabase: false as const, foreignKeysValidated: false as const,
    semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return fail('result-json-budget', null)
  return freezeCapsuleValue({ ...body, nativeStorageHash: capsuleBytesHash('knowbook.restore.merge3.native.v1\0' + encoded) })
}
