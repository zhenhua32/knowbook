import { useCallback, useEffect, useState } from 'react'

const DOCUMENTS_WIDE_MODE_STORAGE_KEY = 'knowbook.documents.wideMode'

export function useDocumentsUiState() {
  const [documentsAuxPanelOpen, setDocumentsAuxPanelOpen] = useState(false)
  const [documentsWideMode, setDocumentsWideMode] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return window.localStorage.getItem(DOCUMENTS_WIDE_MODE_STORAGE_KEY) === '1'
  })
  const [moveTargetId, setMoveTargetId] = useState('')

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(DOCUMENTS_WIDE_MODE_STORAGE_KEY, documentsWideMode ? '1' : '0')
  }, [documentsWideMode])

  const clearMoveTarget = useCallback(() => {
    setMoveTargetId('')
  }, [])

  const toggleDocumentsAuxPanel = useCallback(() => {
    setDocumentsAuxPanelOpen((previous) => !previous)
  }, [])

  const toggleDocumentsWideMode = useCallback(() => {
    setDocumentsWideMode((previous) => !previous)
  }, [])

  return {
    clearMoveTarget,
    documentsAuxPanelOpen,
    documentsWideMode,
    moveTargetId,
    setMoveTargetId,
    toggleDocumentsAuxPanel,
    toggleDocumentsWideMode
  }
}