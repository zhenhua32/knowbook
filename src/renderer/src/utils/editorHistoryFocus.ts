import type { DocumentBlockDraft } from '@shared/contracts'
import { focusBlockTextarea } from './textareaLayout'

export type EditorHistoryBookmark = {
  blockId?: string
  index: number
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none'
  cell?: { row: number; column: number; editing: boolean }
}

export const restoreTableHistoryFocusEvent = 'knowbook:restore-table-history-focus'

export function captureEditorHistoryBookmark(blocks: DocumentBlockDraft[], target?: EventTarget | null): EditorHistoryBookmark | null {
  if (typeof document === 'undefined') return null
  const active = target === undefined ? document.activeElement : target
  if (!(active instanceof HTMLElement)) return null
  const row = active.closest<HTMLElement>('.block-editor-row[data-block-index]')
  if (!row) return null
  const index = Number(row.dataset.blockIndex)
  if (!blocks[index]) return null
  const cell = active.closest<HTMLElement>('[data-row][data-column]')
  const input = active.matches('textarea') ? active as HTMLTextAreaElement : null
  if (!cell && !input?.matches('.block-inline-textarea')) return null
  return {
    blockId: blocks[index].id, index,
    start: input?.selectionStart ?? 0, end: input?.selectionEnd ?? 0,
    direction: input?.selectionDirection ?? 'none',
    cell: cell ? { row: Number(cell.dataset.row), column: Number(cell.dataset.column), editing: Boolean(input) } : undefined
  }
}

export function restoreEditorHistoryBookmark(bookmark: EditorHistoryBookmark, blocks: DocumentBlockDraft[]): boolean {
  const matchingIndex = bookmark.blockId ? blocks.findIndex(block => block.id === bookmark.blockId) : -1
  const index = matchingIndex >= 0 ? matchingIndex : Math.min(bookmark.index, blocks.length - 1)
  const row = document.querySelector<HTMLElement>(`.block-editor-row[data-block-index="${index}"]`)
  if (!row) return false
  const table = bookmark.cell && row.querySelector<HTMLElement>('.markdown-table-editor')
  if (table) {
    table.dispatchEvent(new CustomEvent(restoreTableHistoryFocusEvent, { detail: bookmark }))
    return true
  }
  const input = row.querySelector<HTMLTextAreaElement>('.block-inline-textarea')
  if (!input) return false
  focusBlockTextarea(input)
  input.setSelectionRange(Math.min(bookmark.start, input.value.length), Math.min(bookmark.end, input.value.length), bookmark.direction)
  return true
}
