import { INLINE_TEXT_COLORS, normalizeInlineTextColor, type InlineTextColor } from './inlineTextPresentation'

export const NATIVE_CALLOUT_KINDS = ['note', 'info', 'tip', 'warning', 'danger'] as const
export type NativeCalloutKind = typeof NATIVE_CALLOUT_KINDS[number]
export const NATIVE_CALLOUT_ICONS = ['note', 'info', 'tip', 'warning', 'danger', 'book', 'pin', 'check', 'question'] as const
export type NativeCalloutIcon = typeof NATIVE_CALLOUT_ICONS[number]
export const NATIVE_CONTAINER_TONES = INLINE_TEXT_COLORS

/** Syntax details that affect Markdown meaning but are not visible block text. */
export interface MarkdownBlockFormat {
  listMarker?: '-' | '+' | '*' | '.' | ')'
  listLoose?: boolean
  /** Preserve the original fence info, independently of detected highlighting. */
  codeInfo?: string
  /** An empty fence contains zero lines, unlike a fence with one blank line. */
  emptyCode?: boolean
  calloutKind?: NativeCalloutKind
  calloutIcon?: NativeCalloutIcon
  calloutTone?: InlineTextColor
  /** Authored initial state; personal folding preferences are stored separately. */
  toggleDefaultOpen?: boolean
  /** Layout share in basis points; direct columns in a group total 10,000. */
  columnWeight?: number
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
  if (type === 'callout') {
    if (typeof input.calloutKind === 'string' && (NATIVE_CALLOUT_KINDS as readonly string[]).includes(input.calloutKind)) result.calloutKind = input.calloutKind as NativeCalloutKind
    if (typeof input.calloutIcon === 'string' && (NATIVE_CALLOUT_ICONS as readonly string[]).includes(input.calloutIcon)) result.calloutIcon = input.calloutIcon as NativeCalloutIcon
    const tone = normalizeInlineTextColor(input.calloutTone)
    if (tone) result.calloutTone = tone
  }
  if (type === 'toggle' && typeof input.toggleDefaultOpen === 'boolean') result.toggleDefaultOpen = input.toggleDefaultOpen
  if (type === 'column' && Number.isSafeInteger(input.columnWeight)
    && Number(input.columnWeight) >= 1 && Number(input.columnWeight) <= 10_000) result.columnWeight = Number(input.columnWeight)
  return Object.keys(result).length ? result : undefined
}

export function decodeMarkdownFormat(type: string, json: string | null): MarkdownBlockFormat | undefined {
  try { return normalizeMarkdownFormat(type, json ? JSON.parse(json) : undefined) } catch { return undefined }
}
