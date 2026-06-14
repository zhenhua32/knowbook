import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DocumentBlockAiEditMode, DocumentBlockDraft, PreviewDocumentBlockAiEditInput } from '@shared/contracts'
import type { UiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'

type BlockRange = {
  start: number
  end: number
}

type UseDocumentSelectionAiStateParams = {
  aiEnabled: boolean
  documentsAuxPanelOpen: boolean
  draftBlocks: DocumentBlockDraft[]
  draftSummary: string
  draftTitle: string
  getMultiBlockOperationRange: (range: BlockRange) => BlockRange
  handleBlockPaste: (index: number, pastedText: string, selectionStart: number, selectionEnd: number) => boolean
  hasApiKey: boolean
  onOpenAuxPanel: () => void
  selectedBlockRange: BlockRange | null
  selectedDocument: { id: string; title: string; path: string } | null
  ui: UiText
}

function cloneDraftBlock(block: DocumentBlockDraft): DocumentBlockDraft {
  return {
    id: block.id,
    type: block.type,
    content: block.content,
    checked: Boolean(block.checked),
    depth: block.depth,
    parentBlockId: block.parentBlockId ?? null,
    tags: block.tags ? [...block.tags] : undefined,
    language: block.language,
    highlight: block.highlight
  }
}

export function useDocumentSelectionAiState({
  aiEnabled,
  documentsAuxPanelOpen,
  draftBlocks,
  draftSummary,
  draftTitle,
  getMultiBlockOperationRange,
  handleBlockPaste,
  hasApiKey,
  onOpenAuxPanel,
  selectedBlockRange,
  selectedDocument,
  ui
}: UseDocumentSelectionAiStateParams) {
  const [mode, setModeState] = useState<DocumentBlockAiEditMode>('summarize')
  const [customInstruction, setCustomInstructionState] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [previewSourceSignature, setPreviewSourceSignature] = useState<string | null>(null)

  const clearPreview = useCallback(() => {
    setPreviewText('')
    setPreviewError('')
    setPreviewSourceSignature(null)
  }, [])

  const selectedBlockCount = selectedBlockRange ? selectedBlockRange.end - selectedBlockRange.start + 1 : 0
  const operationRange = useMemo(() => {
    return selectedBlockRange ? getMultiBlockOperationRange(selectedBlockRange) : null
  }, [getMultiBlockOperationRange, selectedBlockRange])

  const selectedBlocks = useMemo(() => {
    if (!operationRange) {
      return [] as DocumentBlockDraft[]
    }

    return draftBlocks.slice(operationRange.start, operationRange.end + 1).map(cloneDraftBlock)
  }, [draftBlocks, operationRange])

  const previewInput = useMemo<PreviewDocumentBlockAiEditInput | null>(() => {
    if (!selectedDocument || !operationRange || selectedBlocks.length === 0) {
      return null
    }

    return {
      documentId: selectedDocument.id,
      documentTitle: draftTitle.trim() || selectedDocument.title || 'Untitled',
      documentPath: selectedDocument.path,
      documentSummary: draftSummary.trim(),
      selectedBlocks,
      mode,
      instruction: mode === 'custom' ? customInstruction.trim() : undefined
    }
  }, [customInstruction, draftSummary, draftTitle, mode, operationRange, selectedBlocks, selectedDocument])

  const previewSignature = useMemo(() => {
    return previewInput ? JSON.stringify(previewInput) : null
  }, [previewInput])

  const isPreviewStale = Boolean(previewSourceSignature && previewSignature && previewSourceSignature !== previewSignature)
  const canGeneratePreview = Boolean(previewInput && aiEnabled && hasApiKey && !previewBusy && (mode !== 'custom' || customInstruction.trim()))
  const canApplyPreview = Boolean(previewText && operationRange && !previewBusy && !isPreviewStale)

  useEffect(() => {
    clearPreview()
  }, [clearPreview, selectedDocument?.id])

  const openSelectionAiEditor = useCallback(() => {
    if (!documentsAuxPanelOpen) {
      onOpenAuxPanel()
    }
  }, [documentsAuxPanelOpen, onOpenAuxPanel])

  const setMode = useCallback((nextMode: DocumentBlockAiEditMode) => {
    setModeState((previous) => {
      if (previous !== nextMode) {
        setPreviewText('')
        setPreviewError('')
        setPreviewSourceSignature(null)
      }
      return nextMode
    })
  }, [])

  const setCustomInstruction = useCallback((value: string) => {
    setCustomInstructionState(value)
    setPreviewText('')
    setPreviewError('')
    setPreviewSourceSignature(null)
  }, [])

  const generatePreview = useCallback(async () => {
    if (!previewInput || !aiEnabled || !hasApiKey || (previewInput.mode === 'custom' && !previewInput.instruction)) {
      return
    }

    setPreviewBusy(true)
    setPreviewError('')

    try {
      const result = await window.knowbook.previewDocumentBlockAiEdit(previewInput)
      setPreviewText(result.replacementText)
      setPreviewSourceSignature(previewSignature)
    } catch (error) {
      setPreviewText('')
      setPreviewSourceSignature(null)
      setPreviewError(getErrorMessage(error, ui.aiRequestFailed))
    } finally {
      setPreviewBusy(false)
    }
  }, [aiEnabled, hasApiKey, previewInput, previewSignature, ui.aiRequestFailed])

  const applyPreview = useCallback(() => {
    if (!previewText || !operationRange || isPreviewStale) {
      return false
    }

    const applied = handleBlockPaste(operationRange.start, previewText, 0, 0)
    if (applied) {
      clearPreview()
    }

    return applied
  }, [clearPreview, handleBlockPaste, isPreviewStale, operationRange, previewText])

  return {
    applyPreview,
    canApplyPreview,
    canGeneratePreview,
    clearPreview,
    customInstruction,
    generatePreview,
    isPreviewStale,
    mode,
    openSelectionAiEditor,
    previewBusy,
    previewError,
    previewText,
    selectedBlockActionCount: selectedBlocks.length,
    selectedBlockCount,
    selectedBlocksAvailable: selectedBlocks.length > 0,
    setCustomInstruction,
    setMode
  }
}