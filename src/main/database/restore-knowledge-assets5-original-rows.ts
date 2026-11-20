import { capsule2RawTableRows, scopedCapsule2TableIdLookup, scopedCapsule2TableRowLookup,
  type Capsule2RawContent, type Capsule2RawSqlRow } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Value } from './restore-knowledge-graph3-data'

/** Keep original table and row identity while reading just the columns needed
 * to choose an asset owner. Decode a full row only after choosing its scope. */
export function readWorkingAssetOriginalTable5(raw: Capsule2RawContent, name: string) {
  const table = raw.tables.find(table => table.name === name) ?? graph3Conflict('missing-source-table', name)
  function cell(original: Capsule2RawSqlRow, column: string) {
    const index = table.columns.indexOf(column)
    return index < 0 ? undefined : graph3Value(original.cells[index], raw.encoding)
  }
  function read(original: Capsule2RawSqlRow) {
    const value = Object.fromEntries(table.columns.map((column, index) => [column, graph3Value(original.cells[index], raw.encoding)]))
    return { table, original, value }
  }
  function indexBy(column: string) {
    const lookup = column === 'id' ? scopedCapsule2TableIdLookup(table) : undefined
    if (lookup) return { get: lookup }
    const stored = scopedCapsule2TableRowLookup(table)
    const rows = new Map<string, Capsule2RawSqlRow | string>()
    for (const original of capsule2RawTableRows(table)) rows.set(String(cell(original, column)), stored ? original.sourceRowId : original)
    return { get(id: string) {
      const row = rows.get(id)
      return typeof row === 'string' ? stored!(row) : row
    } }
  }
  function cachedCell(column: string) {
    const values = new Map<Capsule2RawSqlRow, unknown>()
    return (original: Capsule2RawSqlRow) => {
      if (!values.has(original)) values.set(original, cell(original, column))
      return values.get(original)
    }
  }
  return { table, cell, read, indexBy, cachedCell }
}
