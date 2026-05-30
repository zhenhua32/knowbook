import { useEffect } from 'react'
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
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && /^[1-7]$/.test(event.key)) {
        const pageIndex = Number(event.key) - 1
        const targetPage = PAGE_ORDER[pageIndex]
        if (targetPage) {
          event.preventDefault()
          shell.setActivePage(targetPage)
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

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    documents,
    onClearBlockRangeSelection,
    shell
  ])
}