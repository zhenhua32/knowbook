/** Syntax details that affect Markdown meaning but are not visible block text. */
export interface MarkdownBlockFormat {
  listMarker?: '-' | '+' | '*' | '.' | ')'
  listLoose?: boolean
  /** Preserve the original fence info, independently of detected highlighting. */
  codeInfo?: string
  /** An empty fence contains zero lines, unlike a fence with one blank line. */
  emptyCode?: boolean
}

export function normalizeMarkdownFormat(type: string, value: unknown): MarkdownBlockFormat | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const result: MarkdownBlockFormat = {}
  if (['todo', 'bulleted-list', 'numbered-todo', 'numbered-list'].includes(type)) {
    const ordered = type.startsWith('numbered-')
    if (typeof input.listMarker === 'string' && (ordered ? ['.', ')'] : ['-', '+', '*']).includes(input.listMarker)) {
      result.listMarker = input.listMarker as MarkdownBlockFormat['listMarker']
    }
    if (typeof input.listLoose === 'boolean') result.listLoose = input.listLoose
  }
  if (type === 'code') {
    if (typeof input.codeInfo === 'string' && !/[\r\n]/.test(input.codeInfo)) result.codeInfo = input.codeInfo
    if (input.emptyCode === true) result.emptyCode = true
  }
  return Object.keys(result).length ? result : undefined
}

export function decodeMarkdownFormat(type: string, json: string | null): MarkdownBlockFormat | undefined {
  try { return normalizeMarkdownFormat(type, json ? JSON.parse(json) : undefined) } catch { return undefined }
}
