import { parseMarkdownTableNode, type ParsedMarkdownTable } from './markdownTable'

export type MarkdownTableEdit = ParsedMarkdownTable & {
  overflow: string[][]
  before: string[]
  after: string[]
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
  return {
    headers,
    alignments: cells.map(({ token }) => (String(token.attrGet('style') ?? '').slice('text-align:'.length) || null) as ParsedMarkdownTable['alignments'][number]),
    rows: rawRows.map((row) => Array.from({ length: headers.length }, (_, column) => row[column] ?? '')),
    overflow: rawRows.map((row) => row.slice(headers.length)),
    before: lines.slice(0, start), after: lines.slice(end)
  }
}

export function serializeEditableMarkdownTable(table: MarkdownTableEdit): string {
  const render = (row: string[]) => '| ' + row.map((cell) => cell.replace(/\r\n?|\n/g, '&#10;').replace(/\t/g, '&#9;').replace(/\|/g, '\\|')).join(' | ') + ' |'
  const delimiters = table.alignments.map((alignment) => alignment === 'center' ? ':---:' : alignment === 'left' ? ':---' : alignment === 'right' ? '---:' : '---')
  return [...table.before, render(table.headers), render(delimiters),
    ...table.rows.map((row, index) => render([...row, ...(table.overflow[index] ?? [])])), ...table.after].join('\n')
}

export type TableOperation =
  | { kind: 'cell'; row: number; column: number; value: string }
  | { kind: 'insert-row' | 'delete-row'; row: number }
  | { kind: 'insert-column' | 'delete-column'; column: number }
  | { kind: 'align'; column: number; alignment: ParsedMarkdownTable['alignments'][number] }
  | { kind: 'paste'; row: number; column: number; cells: string[][] }

/** Row 0 is the header. Operations keep ignored overflow cells and all source
 * outside the table, including reference definitions, intact. */
export function editMarkdownTable(table: MarkdownTableEdit, operation: TableOperation): MarkdownTableEdit {
  const next = { ...table, headers: [...table.headers], alignments: [...table.alignments], rows: table.rows.map((row) => [...row]), overflow: table.overflow.map((row) => [...row]) }
  const rows = [next.headers, ...next.rows]
  switch (operation.kind) {
    case 'cell':
      if (rows[operation.row] && operation.column >= 0 && operation.column < next.headers.length) rows[operation.row][operation.column] = operation.value
      break
    case 'insert-row': {
      const index = Math.max(0, Math.min(next.rows.length, operation.row - 1))
      next.rows.splice(index, 0, next.headers.map(() => ''))
      next.overflow.splice(index, 0, [])
      break
    }
    case 'delete-row':
      if (operation.row > 0 && operation.row <= next.rows.length) { next.rows.splice(operation.row - 1, 1); next.overflow.splice(operation.row - 1, 1) }
      break
    case 'insert-column': {
      const index = Math.max(0, Math.min(next.headers.length, operation.column))
      rows.forEach((row) => row.splice(index, 0, ''))
      next.alignments.splice(index, 0, null)
      break
    }
    case 'delete-column':
      if (next.headers.length > 1 && operation.column >= 0 && operation.column < next.headers.length) {
        rows.forEach((row) => row.splice(operation.column, 1))
        next.alignments.splice(operation.column, 1)
      }
      break
    case 'align':
      if (operation.column >= 0 && operation.column < next.headers.length) next.alignments[operation.column] = operation.alignment
      break
    case 'paste': {
      if (operation.row < 0 || operation.column < 0 || !operation.cells.length) break
      const width = operation.column + Math.max(...operation.cells.map((row) => row.length))
      while (next.headers.length < width) { rows.forEach((row) => row.push('')); next.alignments.push(null) }
      while (rows.length < operation.row + operation.cells.length) {
        const row = next.headers.map(() => '')
        next.rows.push(row); rows.push(row); next.overflow.push([])
      }
      operation.cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => { rows[operation.row + rowIndex][operation.column + columnIndex] = cell }))
      break
    }
  }
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
