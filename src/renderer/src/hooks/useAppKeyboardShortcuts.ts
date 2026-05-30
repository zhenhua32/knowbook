import { useEffect } from 'react'
import type { useDocumentsDomainState } from './useDocumentsDomainState'
import { PAGE_ORDER, type PageId } from './useAppShellState'

type DocumentsKeyboardState = Pick<ReturnType<typeof useDocumentsDomainState>,
  'closeGlobalSearch'
  | 'isEditing'
  | 'isGlobalSearchOpen'
  | 'navBack'
  | 'navForward'
  | 'openGlobalSearch'
  | 'redoEdit'
  | 'selectedBlockRange'
  | 'undoEdit'
>

type UseAppKeyboardShortcutsParams = {
  activePage: PageId
  documents: DocumentsKeyboardState
  onClearBlockRangeSelection: () => void
  setActivePage: (page: PageId) => void
}

export function useAppKeyboardShortcuts({
  activePage,
  documents,
  onClearBlockRangeSelection,
  setActivePage
}: UseAppKeyboardShortcutsParams) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && /^[1-7]$/.test(event.key)) {
        const pageIndex = Number(event.key) - 1
        const targetPage = PAGE_ORDER[pageIndex]
        if (targetPage) {
          event.preventDefault()
          setActivePage(targetPage)
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        if (activePage !== 'documents') {
          return
        }

        event.preventDefault()
        if (documents.isGlobalSearchOpen) {
          documents.closeGlobalSearch()
        } else {
          documents.openGlobalSearch()
        }
      }

      if (event.key === 'Escape' && documents.isGlobalSearchOpen && activePage === 'documents') {
        documents.closeGlobalSearch()
        return
      }

      if (event.key === 'Escape' && activePage === 'documents' && documents.selectedBlockRange) {
        event.preventDefault()
        onClearBlockRangeSelection()
        return
      }

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z') {
        if (documents.isEditing && activePage === 'documents') {
          event.preventDefault()
          documents.undoEdit()
        }
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
        if (documents.isEditing && activePage === 'documents') {
          event.preventDefault()
          documents.redoEdit()
        }
      }

      if (event.altKey && event.key === 'ArrowLeft') {
        if (activePage === 'documents') {
          event.preventDefault()
          documents.navBack()
        }
      }

      if (event.altKey && event.key === 'ArrowRight') {
        if (activePage === 'documents') {
          event.preventDefault()
          documents.navForward()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    activePage,
    documents,
    onClearBlockRangeSelection,
    setActivePage
  ])
}