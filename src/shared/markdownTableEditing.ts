import { parseMarkdownTableNode, type ParsedMarkdownTable } from './markdownTable'
import { tableColumnWidths, validTableColumnWidth, validateTableColumnWidths, serializeTableColumnWidthsDirective,
  type MarkdownTableColumnWidth } from './markdownTableLayout'

export type MarkdownTableEdit = ParsedMarkdownTable & {
  overflow: string[][]
  before: string[]
  after: string[]
}

// Keep source fidelity private: consumers operate only on the table model.
const sourceSnapshots = new WeakMap<MarkdownTableEdit, { source: string; fingerprint: string }>()
function fingerprint(table: MarkdownTableEdit): string {
  return JSON.stringify([table.headers, table.alignments, table.rows, table.overflow, table.before, table.after,
    validateTableColumnWidths(table.widths, table.headers.length) ?? null])
}

// GFM treats a pipe immediately after a backslash as cell content, even
// inside code spans. Remove exactly that escape and restore it on output.
function splitRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  for (const character of line.trim()) {
    if (character !== '|') cell += character
    else if (cell.endsWith('\\')) cell = cell.slice(0, -1) + '|'
    else { cells.push(cell); cell = '' }
  }
  cells.push(cell)
  if (cells[0] === '') cells.shift()
  if (cells.at(-1) === '') cells.pop()
  return cells.map((value) => value.trim())
}

export function parseEditableMarkdownTable(source: string): MarkdownTableEdit | null {
  const table = parseMarkdownTableNode(source)
  if (!table?.token.map) return null
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const [start, end] = table.token.map
  const headers = splitRow(lines[start])
  const cells = table.children.find((node) => node.token.type === 'thead_open')?.children[0]?.children ?? []
  const rawRows = lines.slice(start + 2, end).map(splitRow)
  const widths = tableColumnWidths(table.token, headers.length)
  const layoutMap: unknown = table.token.meta?.tableLayoutMap
  const layoutLine = widths && Array.isArray(layoutMap) && layoutMap.length === 2
    && Number.isInteger(layoutMap[0]) && layoutMap[0] === start - 1 && layoutMap[1] === start ? layoutMap[0] as number : -1
  const result: MarkdownTableEdit = {
    headers,
    alignments: cells.map(({ token }) => (String(token.attrGet('style') ?? '').slice('text-align:'.length) || null) as ParsedMarkdownTable['alignments'][number]),
    rows: rawRows.map((row) => Array.from({ length: headers.length }, (_, column) => row[column] ?? '')),
    overflow: rawRows.map((row) => row.slice(headers.length)),
    before: lines.slice(0, start).filter((_line, index) => index !== layoutLine), after: lines.slice(end),
    ...(widths ? { widths } : {})
  }
  sourceSnapshots.set(result, { source, fingerprint: fingerprint(result) })
  return result
}

export function serializeEditableMarkdownTable(table: MarkdownTableEdit): string {
  const original = sourceSnapshots.get(table)
  if (original && fingerprint(table) === original.fingerprint) return original.source
  const render = (row: string[]) => '| ' + row.map((cell) => cell.replace(/\r\n?|\n/g, '&#10;').replace(/\t/g, '&#9;').replace(/\|/g, '\\|')).join(' | ') + ' |'
  const delimiters = table.alignments.map((alignment) => alignment === 'center' ? ':---:' : alignment === 'left' ? ':---' : alignment === 'right' ? '---:' : '---')
  const widths = validateTableColumnWidths(table.widths, table.headers.length)
  return [...table.before, ...(widths ? [serializeTableColumnWidthsDirective(widths)] : []), render(table.headers), render(delimiters),
    ...table.rows.map((row, index) => render([...row, ...(table.overflow[index] ?? [])])), ...table.after].join('\n')
}

export type TableOperation =
  | { kind: 'cell'; row: number; column: number; value: string }
  | { kind: 'insert-row' | 'delete-row'; row: number }
  | { kind: 'insert-column' | 'delete-column'; column: number }
  | { kind: 'align'; column: number; alignment: ParsedMarkdownTable['alignments'][number] }
  | { kind: 'paste'; row: number; column: number; cells: string[][] }
  /** Row 0 is immutable as a structural header; destinations are final indices. */
  | { kind: 'move-row'; row: number; toRow: number }
  | { kind: 'move-column'; column: number; toColumn: number }
  | { kind: 'column-width'; column: number; width: MarkdownTableColumnWidth }

function validIndex(value: number, length: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < length
}
function move<T>(items: T[], from: number, to: number): void { items.splice(to, 0, ...items.splice(from, 1)) }

/** Operations preserve overflow and all source outside the bound table. */
export function editMarkdownTable(table: MarkdownTableEdit, operation: TableOperation): MarkdownTableEdit {
  const widths = validateTableColumnWidths(table.widths, table.headers.length)
  const next: MarkdownTableEdit = { ...table, headers: [...table.headers], alignments: [...table.alignments],
    rows: table.rows.map((row) => [...row]), overflow: table.overflow.map((row) => [...row]), before: [...table.before], after: [...table.after],
    ...(widths ? { widths } : {}) }
  const rows = [next.headers, ...next.rows]
  switch (operation.kind) {
    case 'cell':
      if (validIndex(operation.row, rows.length) && validIndex(operation.column, next.headers.length)) rows[operation.row][operation.column] = operation.value
      break
    case 'insert-row': {
      if (!validIndex(operation.row - 1, next.rows.length + 1)) break
      next.rows.splice(operation.row - 1, 0, next.headers.map(() => ''))
      next.overflow.splice(operation.row - 1, 0, [])
      break
    }
    case 'delete-row':
      if (validIndex(operation.row - 1, next.rows.length)) { next.rows.splice(operation.row - 1, 1); next.overflow.splice(operation.row - 1, 1) }
      break
    case 'insert-column': {
      if (!validIndex(operation.column, next.headers.length + 1)) break
      rows.forEach((row) => row.splice(operation.column, 0, ''))
      next.alignments.splice(operation.column, 0, null)
      next.widths?.splice(operation.column, 0, null)
      break
    }
    case 'delete-column':
      if (next.headers.length > 1 && validIndex(operation.column, next.headers.length)) {
        rows.forEach((row) => row.splice(operation.column, 1))
        next.alignments.splice(operation.column, 1)
        next.widths?.splice(operation.column, 1)
      }
      break
    case 'align':
      if (validIndex(operation.column, next.headers.length) && [null, 'left', 'center', 'right'].includes(operation.alignment)) next.alignments[operation.column] = operation.alignment
      break
    case 'move-row':
      if (validIndex(operation.row - 1, next.rows.length) && validIndex(operation.toRow - 1, next.rows.length)) {
        move(next.rows, operation.row - 1, operation.toRow - 1)
        move(next.overflow, operation.row - 1, operation.toRow - 1)
      }
      break
    case 'move-column':
      if (validIndex(operation.column, next.headers.length) && validIndex(operation.toColumn, next.headers.length)) {
        rows.forEach(row => move(row, operation.column, operation.toColumn))
        move(next.alignments, operation.column, operation.toColumn)
        if (next.widths) move(next.widths, operation.column, operation.toColumn)
      }
      break
    case 'column-width':
      if (validIndex(operation.column, next.headers.length) && validTableColumnWidth(operation.width)
        && (next.widths?.[operation.column] ?? null) !== operation.width) {
        next.widths ??= next.headers.map(() => null)
        next.widths[operation.column] = operation.width
      }
      break
    case 'paste': {
      if (!Number.isSafeInteger(operation.row) || !Number.isSafeInteger(operation.column) || operation.row < 0 || operation.column < 0
        || !operation.cells.length || !operation.cells.some(row => row.length)) break
      const width = operation.column + Math.max(...operation.cells.map((row) => row.length))
      while (next.headers.length < width) { rows.forEach((row) => row.push('')); next.alignments.push(null); next.widths?.push(null) }
      while (rows.length < operation.row + operation.cells.length) {
        const row = next.headers.map(() => '')
        next.rows.push(row); rows.push(row); next.overflow.push([])
      }
      operation.cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => { rows[operation.row + rowIndex][operation.column + columnIndex] = cell }))
      break
    }
  }
  if (fingerprint(next) === fingerprint(table)) return table
  const original = sourceSnapshots.get(table)
  if (original) sourceSnapshots.set(next, original)
  return next
}

/** Spreadsheet TSV, including quoted tabs/newlines and escaped quotes. */
export function parseTableClipboard(text: string): string[][] {
  const source = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = [[]]
  let value = '', quoted = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '"' && (quoted || value === '')) {
      if (quoted && source[index + 1] === '"') { value += '"'; index++ }
      else quoted = !quoted
    } else if (!quoted && (character === '\t' || character === '\n')) {
      rows.at(-1)!.push(value); value = ''
      if (character === '\n') rows.push([])
    } else value += character
  }
  rows.at(-1)!.push(value)
  if (source.endsWith('\n') && rows.at(-1)?.length === 1 && rows.at(-1)![0] === '') rows.pop()
  return rows
}
