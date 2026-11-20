import { TextDecoder } from 'node:util'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { capsuleJsonStoredArray } from './restore-knowledge-capsule-json-hash'
import { capsule2RawTableRows, capsule2RawTableRowCount, scopedCapsule2RawSqlTable, scopedCapsule2TableRowEncoding,
  scopedCapsule2TableRowLookup, type Capsule2Encoding, type Capsule2RawContent, type Capsule2RawSqlRow,
  type Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'
import type { RawRestoreSqlCell } from './restore-knowledge-sql-cell'
import type { readRootRestoreIdentityGraphInputs3 } from './restore-knowledge-identity3-read'

export type Graph3Inputs = Awaited<ReturnType<typeof readRootRestoreIdentityGraphInputs3>>
export class RestoreGraph3Conflict extends Error { constructor(readonly code: string, readonly detail: unknown) { super('恢复候选图冲突：' + code) } }
export const graph3Conflict = (code: string, detail: unknown): never => { throw new RestoreGraph3Conflict(code, detail) }
export const graph3Key = (...values: unknown[]) => capsuleJson(values)
export function graph3Text(cell: RawRestoreSqlCell, encoding: string): string {
  if (cell[0] !== 'text') return graph3Conflict('expected-original-text', cell[0])
  return new TextDecoder(encoding.toLowerCase(), { fatal: true, ignoreBOM: true }).decode(Buffer.from(cell[1], 'base64'))
}
export function graph3Encode(text: string, encoding: Capsule2Encoding): RawRestoreSqlCell {
  const bytes = Buffer.from(text, encoding === 'UTF-8' ? 'utf8' : 'utf16le')
  if (encoding === 'UTF-16be') bytes.swap16()
  return ['text', bytes.toString('base64')]
}
export function graph3Value(cell: RawRestoreSqlCell, encoding: Capsule2Encoding): unknown {
  return cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, encoding)
    : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE()
      : Buffer.from(cell[1], 'base64')
}
function decodeGraph3Row(table: Capsule2RawSqlTable, row: Capsule2RawSqlRow, encoding: Capsule2Encoding) {
  return Object.fromEntries(table.columns.map((column, index) => [column, graph3Value(row.cells[index], encoding)]))
}

export function graph3TableLayout({ name, role, columns, primaryKey }: Capsule2RawSqlTable) {
  return { name, role, columns, primaryKey }
}

export function graph3TablesHashInput(tables: readonly Capsule2RawSqlTable[]) {
  return tables.map(table => {
    const encoded = scopedCapsule2TableRowEncoding(table)
    return encoded ? { ...graph3TableLayout(table), rows: capsuleJsonStoredArray<Capsule2RawSqlRow>(encoded) } : table
  })
}

export function freezeGraph3Tables(tables: readonly Capsule2RawSqlTable[]) {
  for (const table of tables) if (!scopedCapsule2TableRowEncoding(table)) freezeCapsuleValue(table)
  return Object.freeze(tables)
}

export function graph3ChangedCells(table: Capsule2RawSqlTable, original: Capsule2RawSqlTable) {
  const changes: Array<{ table: string; sourceRowId: string; columns: string[] }> = []
  for (const row of capsule2RawTableRows(table)) {
    const before = findGraph3OriginalRow(original, row.sourceRowId) ?? graph3Conflict('missing-original-cell-row', row.sourceRowId)
    const columns = table.columns.filter((_, column) => {
      const old = before.cells[column], current = row.cells[column]
      return old[0] !== current[0] || old[1] !== current[1]
    })
    if (columns.length) changes.push({ table: table.name, sourceRowId: row.sourceRowId, columns })
  }
  return changes
}

export function graph3Rows(content: Pick<Capsule2RawContent,'tables' | 'encoding'>, name: string) {
  const table = content.tables.find(table => table.name === name)
  if (!table) return graph3Conflict('missing-source-table', name)
  return table.rows.map(row => ({ original: row, table, value: decodeGraph3Row(table, row, content.encoding) }))
}

/** Capsule2 validates ascending signed SQLite rowids before graph planning. */
export function findGraph3OriginalRow(table: Capsule2RawSqlTable, sourceRowId: string): Capsule2RawSqlRow | undefined {
  if (typeof sourceRowId !== 'string' || !/^(?:0|-?[1-9][0-9]{0,18})$/.test(sourceRowId)) return
  const storedLookup = scopedCapsule2TableRowLookup(table)
  if (storedLookup) return storedLookup(sourceRowId)
  const target = BigInt(sourceRowId)
  let start = 0, end = table.rows.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2), row = table.rows[middle]
    if (row.sourceRowId === sourceRowId) return row
    if (BigInt(row.sourceRowId) < target) start = middle + 1
    else end = middle
  }
}
/** Rewrite only declared fields. Other cells retain original storage classes,
 * exact bytes, column order and rowid evidence; there is no generic SQL writer. */
export function graph3PatchTable(table: Capsule2RawSqlTable, encoding: Capsule2Encoding,
  transform: (value: Record<string,unknown>, rowId: string) => Record<string,string | null | bigint>): Capsule2RawSqlTable {
  function changesFor(original: Capsule2RawSqlRow) {
    const value = decodeGraph3Row(table, original, encoding)
    const changes = transform(value,original.sourceRowId)
    for (const column of Object.keys(changes)) if (!table.columns.includes(column)) return graph3Conflict('unknown-target-column',{table:table.name,column})
    const patches: Array<readonly [number, RawRestoreSqlCell]> = []
    for (const [index, column] of table.columns.entries()) {
      if (!Object.hasOwn(changes, column)) continue
      const changed = changes[column]
      if (changed === value[column]) continue
      patches.push([index, changed === null ? ['null'] : typeof changed === 'bigint' ? ['integer', changed.toString()] : graph3Encode(changed, encoding)])
    }
    return patches
  }
  function apply(original: Capsule2RawSqlRow, patches?: readonly (readonly [number, RawRestoreSqlCell])[]) {
    if (!patches?.length) return original
    const cells = [...original.cells]
    for (const [index, cell] of patches) cells[index] = cell
    return { ...original, cells }
  }
  const lookup = scopedCapsule2TableRowLookup(table)
  if (!lookup) return { ...table, rows: table.rows.map(original => apply(original, changesFor(original))) }
  const patches = new Map<string, ReturnType<typeof changesFor>>()
  for (const row of capsule2RawTableRows(table)) {
    const changed = changesFor(row)
    if (changed.length) patches.set(row.sourceRowId, freezeCapsuleValue(changed))
  }
  if (!patches.size) return table
  const rows = { *[Symbol.iterator]() {
    for (const row of capsule2RawTableRows(table)) yield apply(row, patches.get(row.sourceRowId))
  } }
  return scopedCapsule2RawSqlTable(graph3TableLayout(table), { count: capsule2RawTableRowCount(table), rows,
    *encoded() { for (const row of rows) yield capsuleJson(row) },
    byRowId(id) { const row = lookup(id); return row && apply(row, patches.get(id)) }
  })
}
