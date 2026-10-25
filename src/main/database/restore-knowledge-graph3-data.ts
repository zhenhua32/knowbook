import { TextDecoder } from 'node:util'
import { capsuleJson } from './restore-knowledge-capsule-model'
import type { Capsule2Encoding, Capsule2RawContent, Capsule2RawSqlTable } from './restore-knowledge-capsule2-raw-model'
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
export function graph3Rows(content: Pick<Capsule2RawContent,'tables' | 'encoding'>, name: string) {
  const table = content.tables.find(table => table.name === name)
  if (!table) return graph3Conflict('missing-source-table', name)
  return table.rows.map(row => ({ original: row, table, value: Object.fromEntries(table.columns.map((column,index) => {
    const cell = row.cells[index]
    return [column, cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell,content.encoding)
      : cell[0] === 'integer' ? BigInt(cell[1]) : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1],'hex').readDoubleLE() : Buffer.from(cell[1],'base64')]
  })) as Record<string, unknown> }))
}
/** Rewrite only declared fields. Other cells retain original storage classes,
 * exact bytes, column order and rowid evidence; there is no generic SQL writer. */
export function graph3PatchTable(table: Capsule2RawSqlTable, encoding: Capsule2Encoding,
  transform: (value: Record<string,unknown>, rowId: string) => Record<string,string | null | bigint>): Capsule2RawSqlTable {
  const rows = graph3Rows({ tables:[table], encoding },table.name)
  return { ...table, rows: rows.map(({original,value})=>{
    const changes = transform(value,original.sourceRowId)
    for (const column of Object.keys(changes)) if (!table.columns.includes(column)) return graph3Conflict('unknown-target-column',{table:table.name,column})
    return { ...original, cells: original.cells.map((cell,index)=>{
      const column=table.columns[index]
      if (!Object.hasOwn(changes,column) || changes[column]===value[column]) return cell
      const changed=changes[column]
      return changed===null ? ['null'] : typeof changed==='bigint' ? ['integer',changed.toString()] : graph3Encode(changed,encoding)
    }) }
  }) }
}
