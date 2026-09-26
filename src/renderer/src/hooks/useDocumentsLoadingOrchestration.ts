import type { AppMessageHandler } from '../notify'
import { useCallback } from 'react'
import type { DocumentBlockDraft, DocumentDetail } from '@shared/contracts'
import { useDocumentLoadingAndBlockNavigation } from './useDocumentLoadingAndBlockNavigation'
import type { PendingBlockNavigationTarget } from './useDocumentNavigationState'

type BlockSelectionRange = {
  start: number
  end: number
}

type UseDocumentsLoadingOrchestrationParams = {
  clearEditorAssistSuggestions: () => void
  clearEditorSession: () => void
  clearMoveTarget: () => void
  draftBlocks: DocumentBlockDraft[]
  draftTitle: string
  onNavigateMarkdownHeading: (index: number, headingIndex: number) => void
  endBlockDrag: () => void
  flashHighlightedBlock: (blockId: string) => void
  loadDocumentIntoEditor: (detail: DocumentDetail, editing?: boolean) => void
  pendingBlockNavigationTarget: PendingBlockNavigationTarget | null
  resetAiSession: () => void
  revealBlockAncestors: (blockId: string) => void
  selectedDocument: DocumentDetail | null
  selectedDocumentId: string | null
  setActiveBlockIndex: (index: number | null) => void
  setActiveCursorPosition: (position: number) => void
  notify: AppMessageHandler
  setDetailLoading: (loading: boolean) => void
  setHighlightedBlockId: (blockId: string | null) => void
  setPendingBlockNavigationTarget: (target: PendingBlockNavigationTarget | null) => void
  setPendingFocusBlockIndex: (index: number | null) => void
  setSelectedBlockRange: (range: BlockSelectionRange | null) => void
  setSelectedDocument: (detail: DocumentDetail | null) => void
  setSelectionAnchorBlockId: (blockId: string | null) => void
  uiBlockReferenceNotFound: string
}

export function useDocumentsLoadingOrchestration({
  clearEditorAssistSuggestions,
  clearEditorSession,
  clearMoveTarget,
  draftBlocks,
  draftTitle,
  onNavigateMarkdownHeading,
  endBlockDrag,
  flashHighlightedBlock,
  loadDocumentIntoEditor,
  pendingBlockNavigationTarget,
  resetAiSession,
  revealBlockAncestors,
  selectedDocument,
  selectedDocumentId,
  setActiveBlockIndex,
  setActiveCursorPosition,
  notify,
  setDetailLoading,
  setHighlightedBlockId,
  setPendingBlockNavigationTarget,
  setPendingFocusBlockIndex,
  setSelectedBlockRange,
  setSelectedDocument,
  setSelectionAnchorBlockId,
  uiBlockReferenceNotFound
}: UseDocumentsLoadingOrchestrationParams) {
  const clearPendingTarget = useCallback(() => {
    setPendingBlockNavigationTarget(null)
  }, [setPendingBlockNavigationTarget])

  const handleNoDocumentSelected = useCallback(() => {
    clearEditorSession()
    setPendingFocusBlockIndex(null)
    setSelectionAnchorBlockId(null)
    setSelectedBlockRange(null)
    clearPendingTarget()
    setHighlightedBlockId(null)
    resetAiSession()
  }, [
    clearEditorSession,
    clearPendingTarget,
    resetAiSession,
    setHighlightedBlockId,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectionAnchorBlockId
  ])

  const handleDocumentLoaded = useCallback((detail: DocumentDetail) => {
    endBlockDrag()
    setPendingFocusBlockIndex(null)
    setActiveBlockIndex(null)
    setSelectionAnchorBlockId(null)
    setSelectedBlockRange(null)
    setActiveCursorPosition(0)
    clearEditorAssistSuggestions()
    clearMoveTarget()
    loadDocumentIntoEditor(detail, true)
    resetAiSession()
  }, [
    clearEditorAssistSuggestions,
    clearMoveTarget,
    endBlockDrag,
    loadDocumentIntoEditor,
    resetAiSession,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectionAnchorBlockId
  ])

  const handlePendingTargetResolved = useCallback((targetIndex: number, blockId: string, headingIndex?: number) => {
    if (blockId) revealBlockAncestors(blockId)
    setSelectedBlockRange(null)
    if (headingIndex !== undefined) {
      setHighlightedBlockId(null)
      setPendingFocusBlockIndex(null)
      onNavigateMarkdownHeading(targetIndex, headingIndex)
      return
    }
    setSelectionAnchorBlockId(blockId)
    setActiveBlockIndex(targetIndex)
    setPendingFocusBlockIndex(targetIndex)
    flashHighlightedBlock(blockId)
  }, [
    flashHighlightedBlock,
    onNavigateMarkdownHeading,
    setHighlightedBlockId,
    revealBlockAncestors,
    setActiveBlockIndex,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectionAnchorBlockId
  ])

  const handlePendingTargetMissing = useCallback(() => {
    notify(uiBlockReferenceNotFound, 'warning')
  }, [notify, uiBlockReferenceNotFound])

  useDocumentLoadingAndBlockNavigation({
    clearPendingTarget,
    draftBlocks,
    draftTitle,
    onDocumentLoaded: handleDocumentLoaded,
    onNoDocumentSelected: handleNoDocumentSelected,
    onPendingTargetMissing: handlePendingTargetMissing,
    onPendingTargetResolved: handlePendingTargetResolved,
    pendingBlockNavigationTarget,
    selectedDocument,
    selectedDocumentId,
    setDetailLoading,
    setSelectedDocument
  })
}
