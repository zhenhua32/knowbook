import { useEffect, useRef } from 'react'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { PAGE_ORDER } from './useAppShellState'
import type { DocumentsKeyboardState } from '../types/appDomains'
import type { ShellPageState } from '../types/appShell'

type UseAppKeyboardShortcutsParams = {
  documents: DocumentsKeyboardState
  onClearBlockRangeSelection: () => void
  shell: ShellPageState
}

export function useAppKeyboardShortcuts({ documents, onClearBlockRangeSelection, shell }: UseAppKeyboardShortcutsParams) {
  const composingTarget = useRef<EventTarget | null>(null)
  useEffect(() => {
    const blocked = (event: KeyboardEvent) => document.querySelector('.app-confirm-dialog[open], .shortcut-help-dialog[open], .data-recovery-dialog[open]')
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
      const actions: Record<string, (() => void) | undefined> = {
        'mod+f': documents.isBlockSearchOpen ? documents.closeBlockSearch : documents.openBlockSearch,
        'alt+arrowleft': documents.navBack,
        'alt+arrowright': documents.navForward,
        escape: documents.selectedBlockRange ? onClearBlockRangeSelection : undefined,
        'mod+z': documents.isEditing ? documents.undoEdit : undefined,
        'mod+y': documents.isEditing ? documents.redoEdit : undefined
      }
      const action = actions[key === 'mod+shift+z' ? 'mod+y' : key]
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
