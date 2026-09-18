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

export function useAppKeyboardShortcuts({
  documents,
  onClearBlockRangeSelection,
  shell
}: UseAppKeyboardShortcutsParams) {
  const composingTargetRef = useRef<EventTarget | null>(null)
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isImeKeyboardEvent(event, composingTargetRef.current !== null && composingTargetRef.current === event.target)) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && /^[1-7]$/.test(event.key)) {
        const pageIndex = Number(event.key) - 1
        const targetPage = PAGE_ORDER[pageIndex]
        if (targetPage) {
          event.preventDefault()
          shell.setActivePage(targetPage)
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        if (shell.activePage !== 'documents') {
          return
        }

        event.preventDefault()
        if (documents.isBlockSearchOpen) {
          documents.closeBlockSearch()
        } else {
          documents.openBlockSearch()
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        if (shell.activePage !== 'documents') {
          return
        }

        event.preventDefault()
        if (documents.isGlobalSearchOpen) {
          documents.closeGlobalSearch()
        } else {
          documents.openGlobalSearch()
        }
      }

      if (event.key === 'Escape' && documents.isGlobalSearchOpen && shell.activePage === 'documents') {
        documents.closeGlobalSearch()
        return
      }

      if (event.key === 'Escape' && shell.activePage === 'documents' && documents.selectedBlockRange) {
        event.preventDefault()
        onClearBlockRangeSelection()
        return
      }

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z') {
        if (documents.isEditing && shell.activePage === 'documents') {
          event.preventDefault()
          documents.undoEdit()
        }
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
        if (documents.isEditing && shell.activePage === 'documents') {
          event.preventDefault()
          documents.redoEdit()
        }
      }

      if (event.altKey && event.key === 'ArrowLeft') {
        if (shell.activePage === 'documents') {
          event.preventDefault()
          documents.navBack()
        }
      }

      if (event.altKey && event.key === 'ArrowRight') {
        if (shell.activePage === 'documents') {
          event.preventDefault()
          documents.navForward()
        }
      }
    }

    const startComposition = (event: CompositionEvent) => { composingTargetRef.current = event.target }
    const endComposition = () => { composingTargetRef.current = null }
    window.addEventListener('compositionstart', startComposition, true)
    window.addEventListener('compositionend', endComposition, true)
    window.addEventListener('blur', endComposition, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('compositionstart', startComposition, true)
      window.removeEventListener('compositionend', endComposition, true)
      window.removeEventListener('blur', endComposition, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    documents,
    onClearBlockRangeSelection,
    shell
  ])
}
