import type { DocumentBlockDraft } from '@shared/contracts'
import { focusBlockTextarea } from './textareaLayout'
import { getRichTextHistoryBridge } from '../rich-text/history'
import { getSyncedEditorIsland, isDatabaseEditorIsland } from './editorIsland'

export type EditorHistoryBookmark = {
  blockId?: string
  index: number
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none'
  cell?: { row: number; column: number; editing: boolean }
  richText?: {
    kind?: 'text' | 'node' | 'all'
    anchor: { blockId?: string; index: number; offset: number }
    head: { blockId?: string; index: number; offset: number }
  }
}

export const restoreTableHistoryFocusEvent = 'knowbook:restore-table-history-focus'
type TableHistorySelection = Pick<EditorHistoryBookmark, 'start' | 'end' | 'direction'> & { cell: NonNullable<EditorHistoryBookmark['cell']> }
const tableHistorySelections = new WeakMap<HTMLElement, { source: string; nextSource: string; before: TableHistorySelection; after: TableHistorySelection }>()

/** A drag checkpoint addresses the original logical cell while its DOM previews a new position. */
export function withTableHistorySelection(element: HTMLElement, selection: { source: string; nextSource: string; before: TableHistorySelection; after: TableHistorySelection }, action: () => void): void {
  tableHistorySelections.set(element, selection)
  try { action() } finally { tableHistorySelections.delete(element) }
}

export function captureEditorHistoryBookmark(blocks: DocumentBlockDraft[], target?: EventTarget | null, root?: HTMLElement): EditorHistoryBookmark | null {
  if (typeof document === 'undefined') return null
  const active = target === undefined ? document.activeElement : target
  if (!(active instanceof HTMLElement)) return null
  if (root ? !root.contains(active) : getSyncedEditorIsland(active)) return null
  if (isDatabaseEditorIsland(active)) return null
  const cell = active.closest<HTMLElement>('[data-row][data-column]')
  const table = active.closest<HTMLElement>('.markdown-table-editor')
  const tableScope = table && tableHistorySelections.get(table)
  const richText = !cell && !tableScope && getRichTextHistoryBridge(active)
  if (richText) return richText.capture()
  const row = active.closest<HTMLElement>('.block-editor-row[data-block-index]')
  if (!row) return null
  const index = Number(row.dataset.blockIndex)
  if (!blocks[index]) return null
  const tableSelection = tableScope && (blocks[index].content === tableScope.source ? tableScope.before
    : blocks[index].content === tableScope.nextSource ? tableScope.after : null)
  const input = active.matches('textarea') ? active as HTMLTextAreaElement : null
  if (!cell && !tableSelection && !input?.matches('.block-inline-textarea')) return null
  return {
    blockId: blocks[index].id, index,
    start: tableSelection?.start ?? input?.selectionStart ?? 0, end: tableSelection?.end ?? input?.selectionEnd ?? 0,
    direction: tableSelection?.direction ?? input?.selectionDirection ?? 'none',
    cell: tableSelection?.cell ?? (cell ? { row: Number(cell.dataset.row), column: Number(cell.dataset.column), editing: Boolean(input) } : undefined)
  }
}

export function restoreEditorHistoryBookmark(bookmark: EditorHistoryBookmark, blocks: DocumentBlockDraft[], root?: HTMLElement): boolean {
  const query = (selector: string): HTMLElement | undefined => [...(root ?? document).querySelectorAll<HTMLElement>(selector)]
    .find(element => root || !getSyncedEditorIsland(element))
  if (bookmark.richText) {
    const host = root?.matches('.knowbook-rich-text-editor') ? root : query('.knowbook-rich-text-editor')
    const bridge = host && getRichTextHistoryBridge(host)
    if (bridge) { bridge.restore(bookmark); return true }
  }
  const matchingIndex = bookmark.blockId ? blocks.findIndex(block => block.id === bookmark.blockId) : -1
  const index = matchingIndex >= 0 ? matchingIndex : Math.min(bookmark.index, blocks.length - 1)
  const row = query(`.block-editor-row[data-block-index="${index}"]`)
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

/** A paired undo waits for IPC; later user activity must not reclaim its cursor. */
export function captureAsyncHistoryFocusPermission(): { canRestore: () => boolean; dispose: () => void } {
  const owner = document, view = owner.defaultView!
  const opener = owner.activeElement instanceof HTMLElement && owner.activeElement !== owner.body
    && owner.activeElement !== owner.documentElement ? owner.activeElement : null
  const trigger = opener?.closest('.document-header-action-menu')
    ? owner.querySelector<HTMLElement>('.document-header-more-button') : null
  let owned = true
  const abandon = () => { owned = false }
  const focus = (event: FocusEvent) => {
    if (event.target !== owner.body && event.target !== opener && event.target !== trigger
      && !(event.target instanceof HTMLElement && opener?.contains(event.target))) abandon()
  }
  const events = ['pointerdown', 'keydown', 'compositionstart'] as const
  for (const type of events) owner.addEventListener(type, abandon, true)
  owner.addEventListener('focusin', focus, true)
  view.addEventListener('blur', abandon)
  return {
    canRestore: () => owned && owner.hasFocus()
      && ![...owner.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
        .some(element => element.isConnected && element.getClientRects().length > 0),
    dispose: () => {
      for (const type of events) owner.removeEventListener(type, abandon, true)
      owner.removeEventListener('focusin', focus, true)
      view.removeEventListener('blur', abandon)
    }
  }
}
