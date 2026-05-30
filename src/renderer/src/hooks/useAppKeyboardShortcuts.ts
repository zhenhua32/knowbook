import { useEffect } from 'react'
import { PAGE_ORDER, type PageId } from './useAppShellState'

type BlockSelectionRange = {
  start: number
  end: number
}

type UseAppKeyboardShortcutsParams = {
  activePage: PageId
  closeGlobalSearch: () => void
  isEditing: boolean
  isGlobalSearchOpen: boolean
  navBack: () => void
  navForward: () => void
  onClearBlockRangeSelection: () => void
  openGlobalSearch: () => void
  redoEdit: () => void
  selectedBlockRange: BlockSelectionRange | null
  setActivePage: (page: PageId) => void
  undoEdit: () => void
}

export function useAppKeyboardShortcuts({
  activePage,
  closeGlobalSearch,
  isEditing,
  isGlobalSearchOpen,
  navBack,
  navForward,
  onClearBlockRangeSelection,
  openGlobalSearch,
  redoEdit,
  selectedBlockRange,
  setActivePage,
  undoEdit
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
        if (isGlobalSearchOpen) {
          closeGlobalSearch()
        } else {
          openGlobalSearch()
        }
      }

      if (event.key === 'Escape' && isGlobalSearchOpen && activePage === 'documents') {
        closeGlobalSearch()
        return
      }

      if (event.key === 'Escape' && activePage === 'documents' && selectedBlockRange) {
        event.preventDefault()
        onClearBlockRangeSelection()
        return
      }

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z') {
        if (isEditing && activePage === 'documents') {
          event.preventDefault()
          undoEdit()
        }
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
        if (isEditing && activePage === 'documents') {
          event.preventDefault()
          redoEdit()
        }
      }

      if (event.altKey && event.key === 'ArrowLeft') {
        if (activePage === 'documents') {
          event.preventDefault()
          navBack()
        }
      }

      if (event.altKey && event.key === 'ArrowRight') {
        if (activePage === 'documents') {
          event.preventDefault()
          navForward()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    activePage,
    closeGlobalSearch,
    isEditing,
    isGlobalSearchOpen,
    navBack,
    navForward,
    onClearBlockRangeSelection,
    openGlobalSearch,
    redoEdit,
    selectedBlockRange,
    setActivePage,
    undoEdit
  ])
}