import { isTaskBlockType } from '@shared/blockTypes'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { detectCodeLanguage, normalizeCodeLanguage } from '@shared/code'
import type { AppShellState } from '../types/appShell'
import { useBlockSearchState } from './useBlockSearchState'
import { useBlockSelectionState } from './useBlockSelectionState'
import { useBlockInputActions } from './useBlockInputActions'
import { useBlockCollapseState } from './useBlockCollapseState'
import { useDocumentFoldingActions } from './useDocumentFoldingActions'
import { useBlockFocusState } from './useBlockFocusState'
import { useBlockDragState } from './useBlockDragState'
import { useDocumentsLoadingOrchestration } from './useDocumentsLoadingOrchestration'
import { useDocumentsUiState } from './useDocumentsUiState'
import { useHighlightedBlockState } from './useHighlightedBlockState'
import { useDocumentEditorState } from './useDocumentEditorState'
import { useEditorAssistState } from './useEditorAssistState'
import { useBlockDragDropActions } from './useBlockDragDropActions'
import { useGlobalDocumentSearch } from './useGlobalDocumentSearch'
import { useInlineReferenceNavigation } from './useInlineReferenceNavigation'
import { useMarkdownNavigation } from './useMarkdownNavigation'
import { useMultiBlockActions } from './useMultiBlockActions'
import { useSlashCommandActions } from './useSlashCommandActions'
import { useBlockStructureActions } from './useBlockStructureActions'
import { useSingleBlockTreeActions } from './useSingleBlockTreeActions'
import { useDocumentNavigationState } from './useDocumentNavigationState'
import { isNestableBlock, normalizeBlockDepth } from '../utils/draftBlockShape'

const BLOCK_DRAG_DEPTH_THRESHOLD = 72

type BuildBlockTypePatch = (type: string, content: string, checked?: boolean, depth?: number, parentBlockId?: string | null) => DocumentBlockDraft

type UseDocumentsDomainStateParams = {
  resetAiSession: () => void
  shell: AppShellState
}

export function useDocumentsDomainState({
  resetAiSession,
  shell
}: UseDocumentsDomainStateParams) {
  const {
    activePage,
    homeData: {
      documentCatalog,
      documentTree,
      initialDocumentId
    },
    setActivePage: onActivePageChange,
    setBackupMessage: onBackupMessage,
    setHomeData: onHomeDataChange,
    ui,
    uiLanguage
  } = shell

  const buildBlockTypePatch: BuildBlockTypePatch = useCallback((type, content, checked = false, depth = 0, parentBlockId) => ({
    type,
    content: type === 'divider' ? '' : content,
    checked: isTaskBlockType(type) ? checked : false,
    depth: normalizeBlockDepth(type, depth),
    parentBlockId: isNestableBlock(type) ? (parentBlockId?.trim() ? parentBlockId : null) : null
  }), [])

  const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
  const [isReadingMode, setIsReadingMode] = useState(false)
  const [blockNavigationRequest, setBlockNavigationRequest] = useState<{
    index: number; documentId: string; sequence: number; headingIndex?: number
  } | null>(null)
  const [activeCursorPosition, setActiveCursorPosition] = useState<number>(0)
  const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const flushPendingDocumentChangesRef = useRef<() => Promise<boolean>>(async () => true)
  const updateBackupMessage: Dispatch<SetStateAction<string | null>> = useCallback((value) => {
    onBackupMessage(typeof value === 'function' ? value(null) : value)
  }, [onBackupMessage])

  const {
    clearMoveTarget,
    documentsAuxPanelOpen,
    documentsAuxPanelWidth,
    documentsWideMode,
    moveTargetId,
    setDocumentsAuxPanelWidth,
    setMoveTargetId,
    toggleDocumentsAuxPanel,
    toggleDocumentsWideMode
  } = useDocumentsUiState()
  const {
    dragOverBlockDepth,
    dragOverBlockIndex,
    draggingBlockIndex,
    endBlockDrag,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setDraggingBlockIndex
  } = useBlockDragState()
  const {
    flashHighlightedBlock,
    highlightedBlockId,
    setHighlightedBlockId
  } = useHighlightedBlockState()
  const handleBeforeOpenDocument = useCallback(async () => {
    setHighlightedBlockId(null)
    return flushPendingDocumentChangesRef.current()
  }, [setHighlightedBlockId])
  const {
    detailLoading,
    navBack,
    navCanGoBack,
    navCanGoForward,
    navForward,
    openDocumentBlockInDocumentsPage,
    openDocumentAnchorInDocumentsPage,
    openDocumentInDocumentsPage,
    pendingBlockNavigationTarget,
    pinnedDocumentIds,
    selectedDocument,
    selectedDocumentId,
    setDetailLoading,
    setPendingBlockNavigationTarget,
    setSelectedDocument,
    setSelectedDocumentId,
    togglePinDocument
  } = useDocumentNavigationState({
    onActivePageChange,
    onBeforeOpenDocument: handleBeforeOpenDocument
  })

  useEffect(() => {
    // A directory/search jump belongs to the current visit, not a later page mount.
    setBlockNavigationRequest(null)
  }, [activePage, selectedDocumentId])

  useEffect(() => {
    if (!initialDocumentId) {
      return
    }

    setSelectedDocumentId((current) => current ?? initialDocumentId)
  }, [initialDocumentId, setSelectedDocumentId])

  const {
    canRedo,
    canUndo,
    cancelPendingAutoSave,
    clearEditorSession,
    copyDocumentAsMarkdown,
    draftBlocks,
    draftSummary,
    draftTitle,
    flushPendingChanges,
    getDraftBlocks,
    hasPendingDraftChanges,
    getDraftMarkdownExport,
    isEditing,
    isSaving,
    loadDocumentIntoEditor,
    mdCopyFlash,
    pushToHistory,
    checkpointDraft,
    redoEdit,
    saveDocument,
    saveDocumentAsMarkdown,
    saveStatus,
    setDraftBlocks,
    setDraftSummary,
    setDraftTitle,
    setIsSaving,
    updateBlockHighlight,
    updateDraftBlock,
    undoEdit
  } = useDocumentEditorState({
    isReadingMode,
    onHomeDataChange,
    onMessage: onBackupMessage,
    onSelectedDocumentChange: setSelectedDocument,
    selectedDocument,
    selectedDocumentId,
    ui
  })
  flushPendingDocumentChangesRef.current = flushPendingChanges

  useEffect(() => {
    if (!selectedDocumentId || !selectedDocument || isSaving || hasPendingDraftChanges) {
      return
    }

    const catalogEntry = documentCatalog.find((entry) => entry.id === selectedDocumentId)
    if (!catalogEntry || catalogEntry.updatedAt === selectedDocument.updatedAt) {
      return
    }

    let cancelled = false
    void window.knowbook.getDocumentDetail(selectedDocumentId).then((detail) => {
      if (cancelled || !detail) {
        return
      }
      setSelectedDocument(detail)
      loadDocumentIntoEditor(detail, true)
    }).catch((error) => {
      console.warn('Failed to refresh externally updated document.', error)
    })

    return () => {
      cancelled = true
    }
  }, [
    documentCatalog,
    hasPendingDraftChanges,
    isSaving,
    loadDocumentIntoEditor,
    selectedDocument,
    selectedDocumentId,
    setSelectedDocument
  ])

  const {
    blockHasChildren,
    collapsedBlockIds,
    revealBlockAncestors,
    focusedHeadingId,
    focusedSection,
    sections,
    foldView,
    setFoldView
  } = useBlockCollapseState({
    draftBlocks,
    documentId: !detailLoading && selectedDocument?.id === selectedDocumentId ? selectedDocumentId : null
  })
  const {
    activeLinkContext,
    activeSlashCommand,
    activeSlashContext,
    blockSuggestions,
    captureBlockCursor,
    clearEditorAssistSuggestions,
    filteredSlashCommands,
    insertBlockSuggestion,
    insertLinkSuggestion,
    linkSuggestions,
    setSelectedSlashCommandIndex,
    slashPanelPos
  } = useEditorAssistState({
    activeBlockIndex,
    activeCursorPosition,
    blockTextareaRefs,
    draftBlocks,
    isEditing,
    selectedDocumentId,
    selectedDocumentPresent: Boolean(selectedDocument),
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    uiLanguage
  })
  const {
    setPendingFocusBlockIndex
  } = useBlockFocusState({
    onRevealBlock: revealBlockAncestors,
    activeCursorPosition,
    blockTextareaRefs,
    captureBlockCursor,
    draftBlocks
  })
  const {
    closeGlobalSearch,
    globalSearchLoading,
    globalSearchQuery,
    globalSearchResults,
    handleGlobalSearchNavigate,
    isGlobalSearchOpen,
    openGlobalSearch,
    updateGlobalSearchQuery
  } = useGlobalDocumentSearch({
    documentCatalog,
    onOpenDocument: openDocumentInDocumentsPage
  })
  const {
    canMoveSelectedRange,
    canMoveSelectionDown,
    canMoveSelectionUp,
    clearBlockSelection,
    endBlockRangeSelection,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    getVisibleBlockEntries,
    getVisibleBlockCountInRange,
    getVisibleBlocks,
    getVisibleSiblingSelectionSlice,
    handleBlockMouseEnter,
    isBlockRangeSelecting,
    isBlockSelected,
    isSelectionCoherent,
    notifyBlockMouseDown,
    selectAllBlocks,
    selectBlockRange,
    selectedBlockActionCount,
    selectedBlockConversionType,
    selectedBlockCount,
    selectedBlockHasHiddenCollapsedContent,
    selectedBlockInteractionIssue,
    selectedBlockRange,
    selectedVisibleBlockCount,
    selectedVisibleSiblingSlice,
    setIsBlockRangeSelecting,
    setSelectedBlockConversionType,
    setSelectedBlockRange,
    setSelectionAnchorBlockId
  } = useBlockSelectionState({
    activeBlockIndex,
    collapsedBlockIds,
    focusedHeadingId,
    draftBlocks,
    onActiveBlockChange: setActiveBlockIndex,
    visibleSliceCrossParentGuard: ui.visibleSliceCrossParentGuard,
    selectionStaleGuard: ui.selectionStaleGuard
  })

  const { toggleBlockCollapse, collapseAllSections, expandAllSections, focusSection, exitSectionFocus } = useDocumentFoldingActions({
    documentId: selectedDocumentId, draftBlocks, sections, foldView, setFoldView,
    activeBlockIndex, selectedBlockRange, blockTextareaRefs, clearBlockSelection,
    setActiveBlockIndex, setActiveCursorPosition, setSelectedBlockRange, setSelectionAnchorBlockId,
    setPendingFocusBlockIndex, clearEditorAssistSuggestions, endBlockDrag,
    onScrollToBlock: (index) => {
      if (selectedDocumentId) setBlockNavigationRequest((previous) => ({ index, documentId: selectedDocumentId, sequence: (previous?.sequence ?? 0) + 1 }))
    }
  })

  useDocumentsLoadingOrchestration({
    clearEditorAssistSuggestions,
    clearEditorSession,
    clearMoveTarget,
    draftBlocks,
    draftTitle,
    onNavigateMarkdownHeading: (index, headingIndex) => {
      if (index < 0) exitSectionFocus()
      if (selectedDocumentId) setBlockNavigationRequest((previous) => ({ index, headingIndex, documentId: selectedDocumentId, sequence: (previous?.sequence ?? 0) + 1 }))
    },
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
    setBackupMessage: onBackupMessage,
    setDetailLoading,
    setHighlightedBlockId,
    setPendingBlockNavigationTarget,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectedDocument,
    setSelectionAnchorBlockId,
    uiBlockReferenceNotFound: ui.blockReferenceNotFound
  })

  const {
    adjustSelectedBlocksDepth,
    convertSelectedBlocks,
    copySelectedBlocks,
    copySelectedBlocksAsPlainText,
    cutSelectedBlocks,
    deleteSelectedBlocks,
    duplicateSelectedBlocks,
    moveSelectedBlocks,
    removeSelectedBlockRange
  } = useMultiBlockActions({
    activeBlockIndex,
    activeCursorPosition,
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    getVisibleSiblingSelectionSlice,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setBackupMessage: updateBackupMessage,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectionAnchorBlockId,
    ui: {
      convertedBlocks: ui.convertedBlocks,
      copiedBlocks: ui.copiedBlocks,
      copiedPlainText: ui.copiedPlainText,
      copyFailed: ui.copyFailed,
      copyTextFailed: ui.copyTextFailed,
      cutBlocks: ui.cutBlocks,
      cutFailed: ui.cutFailed,
      deletedBlocks: ui.deletedBlocks,
      duplicatedBlocks: ui.duplicatedBlocks,
      invalidVisibleTreeSlice: ui.invalidVisibleTreeSlice
    }
  })
  const {
    duplicateDraftBlock,
    insertChildDraftBlock,
    insertDraftBlockAt,
    splitDraftBlock
  } = useBlockStructureActions({
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  })
  const {
    adjustBlockDepth,
    continueBlockAt,
    downgradeBlockAt,
    mergeWithPreviousBlock,
    moveDraftBlockBySibling,
    moveDraftSubtree
  } = useSingleBlockTreeActions({
    activeCursorPosition,
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    splitDraftBlock,
    updateDraftBlock
  })
  const {
    addDraftBlock,
    applySlashCommand,
    dismissSlashCommand,
    removeDraftBlock
  } = useSlashCommandActions({
    activeBlockIndex,
    activeCursorPosition,
    activeSlashContext,
    adjustBlockDepth,
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    duplicateDraftBlock,
    endBlockDrag,
    insertChildDraftBlock,
    insertDraftBlockAt,
    moveDraftBlockBySibling,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    updateDraftBlock
  })
  const {
    beginBlockDrag,
    dropBlockAt,
    getDraggedBlockDepthPreview
  } = useBlockDragDropActions({
    blockDragDepthThreshold: BLOCK_DRAG_DEPTH_THRESHOLD,
    draftBlocks,
    dragOverBlockDepth,
    draggingBlockIndex,
    endBlockDrag,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    moveDraftSubtree,
    pushToHistory,
    selectedBlockRange,
    setBackupMessage: updateBackupMessage,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setDraggingBlockIndex
  })
  const {
    blockSearchItems,
    blockSearchQuery,
    closeBlockSearch,
    handleBlockSearchSelect,
    isBlockSearchOpen,
    openBlockSearch,
    setBlockSearchQuery
  } = useBlockSearchState({
    draftBlocks,
    onSelectBlock: (blockIndex) => {
      setActiveBlockIndex(blockIndex)
      setPendingFocusBlockIndex(blockIndex)
    }
  })
  const navigateToBlock = useCallback((index: number) => {
    if (!selectedDocumentId || !draftBlocks[index]) return
    const blockId = draftBlocks[index].id
    if (blockId) revealBlockAncestors(blockId)
    clearBlockSelection()
    setBlockNavigationRequest((previous) => ({ index, documentId: selectedDocumentId, sequence: (previous?.sequence ?? 0) + 1 }))
  }, [clearBlockSelection, draftBlocks, revealBlockAncestors, selectedDocumentId])
  const {
    handleBlockContentChange,
    handleBlockPaste
  } = useBlockInputActions({
    buildBlockTypePatch,
    clearBlockSelection,
    detectCodeLanguage,
    draftBlocks,
    endBlockDrag,
    getMultiBlockOperationRange,
    normalizeCodeLanguage,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    updateDraftBlock
  })

  const navigateInlineReferenceAtCursor = useInlineReferenceNavigation({
    documentTree,
    draftBlocks,
    onOpenDocument: openDocumentInDocumentsPage,
    onOpenDocumentBlock: openDocumentBlockInDocumentsPage,
    selectedDocumentId,
    setBackupMessage: onBackupMessage,
    uiBlockReferenceNotFound: ui.blockReferenceNotFound
  })

  const navigateMarkdownLink = useMarkdownNavigation({
    documentTree, selectedDocument, onOpenDocument: openDocumentInDocumentsPage,
    onOpenAnchor: openDocumentAnchorInDocumentsPage, onMessage: onBackupMessage, isZh: uiLanguage === 'zh-CN'
  })

  useEffect(() => {
    if (activePage !== 'documents') {
      closeGlobalSearch()
      closeBlockSearch()
    }
  }, [activePage, closeBlockSearch, closeGlobalSearch])

  useEffect(() => {
    function handleMouseUp() {
      endBlockRangeSelection()
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleMouseUp)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleMouseUp)
    }
  }, [endBlockRangeSelection])

  return {
    activeBlockIndex,
    activeCursorPosition,
    activeLinkContext,
    activeSlashCommand,
    activeSlashContext,
    addDraftBlock,
    adjustBlockDepth,
    adjustSelectedBlocksDepth,
    applySlashCommand,
    beginBlockDrag,
    blockHasChildren,
    blockSearchItems,
    focusedHeadingId,
    focusedSection,
    collapseAllSections,
    expandAllSections,
    focusSection,
    exitSectionFocus,
    blockSearchQuery,
    blockSuggestions,
    blockTextareaRefs,
    cancelPendingAutoSave,
    canMoveSelectedRange,
    canMoveSelectionDown,
    canMoveSelectionUp,
    canRedo,
    canUndo,
    captureBlockCursor,
    clearBlockSelection,
    clearEditorSession,
    closeBlockSearch,
    closeGlobalSearch,
    collapsedBlockIds,
    continueBlockAt,
    convertSelectedBlocks,
    copyDocumentAsMarkdown,
    copySelectedBlocks,
    copySelectedBlocksAsPlainText,
    cutSelectedBlocks,
    deleteSelectedBlocks,
    detailLoading,
    dismissSlashCommand,
    documentsAuxPanelOpen,
    documentsAuxPanelWidth,
    documentsWideMode,
    downgradeBlockAt,
    dragOverBlockDepth,
    dragOverBlockIndex,
    draftBlocks,
    draftSummary,
    draftTitle,
    flushPendingChanges,
    getDraftBlocks,
    draggingBlockIndex,
    getDraftMarkdownExport,
    revealBlockAncestors,
    dropBlockAt,
    duplicateDraftBlock,
    duplicateSelectedBlocks,
    endBlockDrag,
    endBlockRangeSelection,
    filteredSlashCommands,
    getDraggedBlockDepthPreview,
    getMultiBlockOperationRange,
    getVisibleBlockEntries,
    getVisibleBlockCountInRange,
    getVisibleBlocks,
    getVisibleSiblingSelectionSlice,
    globalSearchLoading,
    globalSearchQuery,
    globalSearchResults,
    handleBlockContentChange,
    handleBlockMouseEnter,
    handleBlockPaste,
    handleBlockSearchSelect,
    handleGlobalSearchNavigate,
    highlightedBlockId,
    insertBlockSuggestion,
    insertDraftBlockAt,
    insertLinkSuggestion,
    isBlockRangeSelecting,
    isBlockSearchOpen,
    isBlockSelected,
    isEditing,
    isReadingMode,
    setIsReadingMode,
    blockNavigationRequest,
    navigateToBlock,
    isGlobalSearchOpen,
    isSaving,
    isSelectionCoherent,
    linkSuggestions,
    mdCopyFlash,
    mergeWithPreviousBlock,
    moveDraftBlockBySibling,
    moveSelectedBlocks,
    moveTargetId,
    navBack,
    navCanGoBack,
    navCanGoForward,
    navForward,
    navigateInlineReferenceAtCursor,
    navigateMarkdownLink,
    notifyBlockMouseDown,
    openBlockSearch,
    openDocumentBlockInDocumentsPage,
    openDocumentInDocumentsPage,
    openGlobalSearch,
    pinnedDocumentIds,
    redoEdit,
    removeSelectedBlockRange,
    saveDocument,
    saveDocumentAsMarkdown,
    saveStatus,
    selectAllBlocks,
    selectBlockRange,
    selectedBlockActionCount,
    selectedBlockConversionType,
    selectedBlockCount,
    selectedBlockHasHiddenCollapsedContent,
    selectedBlockInteractionIssue,
    selectedBlockRange,
    selectedDocument,
    selectedDocumentId,
    selectedVisibleBlockCount,
    selectedVisibleSiblingSlice,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDocumentsAuxPanelWidth,
    setBlockSearchQuery,
    setDetailLoading,
    setDraftBlocks,
    setDraftSummary,
    setDraftTitle,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setIsBlockRangeSelecting,
    setIsSaving,
    setMoveTargetId,
    setPendingFocusBlockIndex,
    setSelectedBlockConversionType,
    setSelectedBlockRange,
    setSelectedDocument,
    setSelectedDocumentId,
    setSelectedSlashCommandIndex,
    setSelectionAnchorBlockId,
    slashPanelPos,
    splitDraftBlock,
    toggleBlockCollapse,
    toggleDocumentsAuxPanel,
    toggleDocumentsWideMode,
    togglePinDocument,
    undoEdit,
    checkpointDraft,
    updateBlockHighlight,
    updateDraftBlock,
    updateGlobalSearchQuery
  }
}
