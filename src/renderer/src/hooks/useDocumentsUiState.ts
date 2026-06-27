import { useCallback, useEffect, useState } from 'react'

const DOCUMENTS_WIDE_MODE_STORAGE_KEY = 'knowbook.documents.wideMode'
const DOCUMENTS_AUX_PANEL_WIDTH_STORAGE_KEY = 'knowbook.documents.auxPanelWidth'
const DEFAULT_DOCUMENTS_AUX_PANEL_WIDTH = 360
const MIN_DOCUMENTS_AUX_PANEL_WIDTH = 280
const MAX_DOCUMENTS_AUX_PANEL_WIDTH = 760

export function useDocumentsUiState() {
  const [documentsAuxPanelOpen, setDocumentsAuxPanelOpen] = useState(false)
  const [documentsAuxPanelWidth, setDocumentsAuxPanelWidthState] = useState(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_DOCUMENTS_AUX_PANEL_WIDTH
    }

    const stored = Number(window.localStorage.getItem(DOCUMENTS_AUX_PANEL_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored)
      ? clampDocumentsAuxPanelWidth(stored)
      : DEFAULT_DOCUMENTS_AUX_PANEL_WIDTH
  })
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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(DOCUMENTS_AUX_PANEL_WIDTH_STORAGE_KEY, String(documentsAuxPanelWidth))
  }, [documentsAuxPanelWidth])

  const clearMoveTarget = useCallback(() => {
    setMoveTargetId('')
  }, [])

  const toggleDocumentsAuxPanel = useCallback(() => {
    setDocumentsAuxPanelOpen((previous) => !previous)
  }, [])

  const toggleDocumentsWideMode = useCallback(() => {
    setDocumentsWideMode((previous) => !previous)
  }, [])

  const setDocumentsAuxPanelWidth = useCallback((value: number) => {
    setDocumentsAuxPanelWidthState(clampDocumentsAuxPanelWidth(value))
  }, [])

  return {
    clearMoveTarget,
    documentsAuxPanelOpen,
    documentsAuxPanelWidth,
    documentsWideMode,
    moveTargetId,
    setDocumentsAuxPanelWidth,
    setMoveTargetId,
    toggleDocumentsAuxPanel,
    toggleDocumentsWideMode
  }
}

function clampDocumentsAuxPanelWidth(value: number): number {
  return Math.max(MIN_DOCUMENTS_AUX_PANEL_WIDTH, Math.min(MAX_DOCUMENTS_AUX_PANEL_WIDTH, Math.round(value)))
}