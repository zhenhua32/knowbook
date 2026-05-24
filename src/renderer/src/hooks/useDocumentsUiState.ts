import { useCallback, useState } from 'react'

export function useDocumentsUiState() {
  const [documentsAuxPanelOpen, setDocumentsAuxPanelOpen] = useState(false)
  const [moveTargetId, setMoveTargetId] = useState('')

  const clearMoveTarget = useCallback(() => {
    setMoveTargetId('')
  }, [])

  const toggleDocumentsAuxPanel = useCallback(() => {
    setDocumentsAuxPanelOpen((previous) => !previous)
  }, [])

  return {
    clearMoveTarget,
    documentsAuxPanelOpen,
    moveTargetId,
    setMoveTargetId,
    toggleDocumentsAuxPanel
  }
}