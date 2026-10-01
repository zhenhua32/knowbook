import { useEffect, useRef } from 'react'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { PAGE_ORDER } from './useAppShellState'
import type { DocumentsKeyboardState } from '../types/appDomains'
import type { ShellPageState } from '../types/appShell'
import { openQuickCapture } from '../documentCapture'

type UseAppKeyboardShortcutsParams = {
  documents: DocumentsKeyboardState
  onClearBlockRangeSelection: () => void
  shell: ShellPageState
}

export function useAppKeyboardShortcuts({ documents, onClearBlockRangeSelection, shell }: UseAppKeyboardShortcutsParams) {
  const composingTarget = useRef<EventTarget | null>(null)
  useEffect(() => {
    // Settings retain hidden panels and their drafts. Only visible surfaces block shortcuts.
    const blocked = (event: KeyboardEvent) => Array.from(document.querySelectorAll<HTMLElement>('[data-block-shortcuts]'))
      .some((surface) => !surface.closest('[hidden], [inert]') && surface.getClientRects().length > 0)
      || isImeKeyboardEvent(event, composingTarget.current !== null && composingTarget.current === event.target)
    const chord = (event: KeyboardEvent) => [event.ctrlKey || event.metaKey ? 'mod' : '', event.altKey ? 'alt' : '',
      event.shiftKey ? 'shift' : '', event.key.toLowerCase()].filter(Boolean).join('+')
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if (blocked(event)) return
      const key = chord(event)
      if (key === 'f1') {
        event.preventDefault(); event.stopPropagation()
        if (!event.repeat) void import('../openShortcutHelp').then(({ openShortcutHelp }) => openShortcutHelp())
        return
      }
      // Source owns an unapplied draft. Only nested shortcut help may open
      // over it; switching pages would unmount the dialog and lose that draft.
      if (document.querySelector('dialog.document-markdown-source[open]')) {
        if (['mod+k', 'mod+shift+p', 'mod+shift+f', 'mod+shift+n', 'alt+arrowleft', 'alt+arrowright'].includes(key)
          || /^mod\+[1-6]$/.test(key)) {
          event.preventDefault(); event.stopPropagation()
        }
        return
      }
      if (key === 'mod+shift+n') {
        event.preventDefault(); event.stopPropagation()
        if (!event.repeat && !documents.isGlobalSearchOpen) openQuickCapture()
        return
      }
      if (key === 'mod+shift+f') {
        event.preventDefault(); event.stopPropagation()
        if (!event.repeat) {
          const query = documents.isGlobalSearchOpen && !documents.globalSearchQuery.trimStart().startsWith('>')
            ? documents.globalSearchQuery : undefined
          documents.closeGlobalSearch()
          shell.openWorkspaceSearch(query)
        }
        return
      }
      if (event.target instanceof Element && event.target.closest('.global-search-modal')) return
      if (key !== 'mod+k' && key !== 'mod+shift+p') return
      event.preventDefault(); event.stopPropagation()
      if (key === 'mod+shift+p') documents.openGlobalSearch('commands')
      else if (documents.isGlobalSearchOpen) documents.closeGlobalSearch()
      else documents.openGlobalSearch()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (blocked(event) || event.defaultPrevented) return
      const key = chord(event)
      if (documents.isGlobalSearchOpen) {
        if (event.key === 'Escape') { event.preventDefault(); documents.closeGlobalSearch() }
        return
      }
      if (/^mod\+[1-6]$/.test(key)) {
        event.preventDefault(); shell.setActivePage(PAGE_ORDER[Number(key.at(-1)) - 1]); return
      }
      if (shell.activePage !== 'documents') return
      if (key === 'mod+s') {
        event.preventDefault()
        if (!event.repeat && documents.isEditing && !documents.detailLoading
          && documents.selectedDocumentId && documents.selectedDocument?.id === documents.selectedDocumentId
          && !documents.documentLoadError) void documents.saveDocument()
        return
      }
      const actionKey = key === 'mod+shift+z' ? 'mod+y' : key
      // Metadata and auxiliary inputs keep their own history. Only body editors
      // share the document's block history, including Markdown table cells.
      if ((actionKey === 'mod+z' || actionKey === 'mod+y') && event.target instanceof HTMLElement
        && (event.target.matches('textarea, input:not([type="checkbox"]):not([type="radio"])') || event.target.isContentEditable)
        && !event.target.matches('textarea.block-inline-textarea, .markdown-table-editor textarea')) return
      const actions: Record<string, (() => void) | undefined> = {
        'mod+f': documents.isBlockSearchOpen ? documents.closeBlockSearch : documents.openBlockSearch,
        'alt+arrowleft': documents.navBack,
        'alt+arrowright': documents.navForward,
        escape: documents.selectedBlockRange ? onClearBlockRangeSelection : undefined,
        'mod+z': documents.isEditing ? documents.undoEdit : undefined,
        'mod+y': documents.isEditing ? documents.redoEdit : undefined
      }
      const action = actions[actionKey]
      if (action) { event.preventDefault(); action() }
    }
    const startComposition = (event: CompositionEvent) => { composingTarget.current = event.target }
    const endComposition = () => { composingTarget.current = null }
    const controller = new AbortController()
    const capture = { capture: true, signal: controller.signal }
    window.addEventListener('compositionstart', startComposition, capture)
    window.addEventListener('compositionend', endComposition, capture)
    window.addEventListener('blur', endComposition, capture)
    window.addEventListener('keydown', handleGlobalShortcut, capture)
    window.addEventListener('keydown', handleKeyDown, { signal: controller.signal })
    return () => controller.abort()
  }, [documents, onClearBlockRangeSelection, shell])
}
