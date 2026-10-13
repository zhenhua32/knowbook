import type { EditorHistoryBookmark } from '../utils/editorHistoryFocus'

export type RichTextHistoryBridge = {
  capture: () => EditorHistoryBookmark
  restore: (bookmark: EditorHistoryBookmark) => void
}

// The document's existing history owns both source and rich text transactions.
// A bridge lets it capture rendered text offsets without importing the editor.
const bridges = new WeakMap<HTMLElement, RichTextHistoryBridge>()
export function registerRichTextHistoryBridge(element: HTMLElement, bridge: RichTextHistoryBridge): () => void {
  bridges.set(element, bridge)
  return () => { bridges.delete(element) }
}
export function getRichTextHistoryBridge(element: HTMLElement): RichTextHistoryBridge | undefined {
  const host = element.closest<HTMLElement>('.knowbook-rich-text-editor')
  return host ? bridges.get(host) : undefined
}
