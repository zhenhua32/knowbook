export interface ParsedMarkdownTable {
  headers: string[]
  alignments: Array<'left' | 'center' | 'right' | null>
  rows: string[][]
}

export function parseMarkdownTable(content: string): ParsedMarkdownTable | null {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length < 2) {
    return null
  }

  const headerLine = lines[0]
  const separatorLine = lines[1]

  if (!headerLine.includes('|') || !separatorLine.includes('|')) {
    return null
  }

  if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separatorLine)) {
    return null
  }

  const parseRow = (line: string): string[] => {
    const trimmed = line.trim()
    const inner = trimmed.startsWith('|') && trimmed.endsWith('|')
      ? trimmed.slice(1, -1)
      : trimmed
    return inner.split('|').map((cell) => cell.trim())
  }

  const headers = parseRow(headerLine)
  const separatorCells = parseRow(separatorLine)
  if (headers.length !== separatorCells.length) {
    return null
  }

  const alignments: Array<'left' | 'center' | 'right' | null> = separatorCells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })

  const rows = lines.slice(2).map(parseRow)

  return { headers, alignments, rows }
}

export function isMarkdownTable(content: string): boolean {
  return parseMarkdownTable(content) !== null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderMarkdownTableHtml(content: string): string | null {
  const table = parseMarkdownTable(content)
  if (!table) {
    return null
  }

  const alignAttr = (a: 'left' | 'center' | 'right' | null) =>
    a ? ` style="text-align:${a}"` : ''

  const headerCells = table.headers
    .map((header, index) => `<th${alignAttr(table.alignments[index])}>${escapeHtml(header)}</th>`)
    .join('')

  const bodyRows = table.rows.map((row) => {
    const cells = row.map((cell, i) => `<td${alignAttr(table.alignments[i])}>${escapeHtml(cell)}</td>`).join('')
    return `<tr>${cells}</tr>`
  }).join('')

  return `<table class="block-markdown-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
}
