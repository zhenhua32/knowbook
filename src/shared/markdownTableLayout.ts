import type { Token } from 'markdown-it'

export type MarkdownTableColumnWidth = number | null
export const DEFAULT_TABLE_COLUMN_WIDTH = 120
export const MIN_TABLE_COLUMN_WIDTH = 120
export const MAX_TABLE_COLUMN_WIDTH = 1200

export function validTableColumnWidth(value: unknown): value is MarkdownTableColumnWidth {
  return value === null || typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_TABLE_COLUMN_WIDTH && value <= MAX_TABLE_COLUMN_WIDTH
}
export function validateTableColumnWidths(value: unknown, columns: number): MarkdownTableColumnWidth[] | undefined {
  return Array.isArray(value) && value.length === columns && value.length > 0 && value.length <= 2048
    && value.every(validTableColumnWidth) ? [...value] : undefined
}
export function isTableLayoutDirectiveLine(line: string): boolean {
  return /^<!-- knowbook:table-widths:/.test(line.trim())
}
export function parseTableColumnWidthsDirective(line: string): MarkdownTableColumnWidth[] | undefined {
  if (line.length > 16_384) return undefined
  const match = /^<!-- knowbook:table-widths:v1 (\[[^\r\n]*\]) -->$/.exec(line.trim())
  if (!match) return undefined
  try {
    const value: unknown = JSON.parse(match[1])
    return Array.isArray(value) ? validateTableColumnWidths(value, value.length) : undefined
  } catch { return undefined }
}
export function serializeTableColumnWidthsDirective(widths: MarkdownTableColumnWidth[]): string {
  if (!validateTableColumnWidths(widths, widths.length)) throw new Error('Invalid table column widths.')
  return `<!-- knowbook:table-widths:v1 ${JSON.stringify(widths)} -->`
}
export function tableColumnWidths(token: Token, columns?: number): MarkdownTableColumnWidth[] | undefined {
  const value: unknown = token.meta?.tableColumnWidths
  return validateTableColumnWidths(value, columns ?? (Array.isArray(value) ? value.length : 0))
}
