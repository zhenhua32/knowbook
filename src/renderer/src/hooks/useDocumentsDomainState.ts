import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { detectCodeLanguage, normalizeCodeLanguage } from '@shared/code'
import type { AppShellState } from '../types/appShell'
import { useBlockSearchState } from './useBlockSearchState'
import { useBlockSelectionState } from './useBlockSelectionState'
import { useBlockInputActions } from './useBlockInputActions'
import { useBlockCollapseState } from './useBlockCollapseState'
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
    checked: type === 'todo' ? checked : false,
    depth: normalizeBlockDepth(type, depth),
    parentBlockId: isNestableBlock(type) ? (parentBlockId?.trim() ? parentBlockId : null) : null
  }), [])

  const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
  const [activeCursorPosition, setActiveCursorPosition] = useState<number>(0)
  const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const updateBackupMessage: Dispatch<SetStateAction<string | null>> = useCallback((value) => {
    onBackupMessage(typeof value === 'function' ? value(null) : value)
  }, [onBackupMessage])

  const {
    clearMoveTarget,
    documentsAuxPanelOpen,
    moveTargetId,
    setMoveTargetId,
    toggleDocumentsAuxPanel
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
    setHighlightedBlockId
  } = useHighlightedBlockState()
  const {
    detailLoading,
    navBack,
    navCanGoBack,
    navCanGoForward,
    navForward,
    openDocumentBlockInDocumentsPage,
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
    onBeforeOpenDocument: () => setHighlightedBlockId(null)
  })

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
    isEditing,
    isSaving,
    loadDocumentIntoEditor,
    mdCopyFlash,
    pushToHistory,
    redoEdit,
    saveDocument,
    saveDocumentAsMarkdown,
    setDraftBlocks,
    setDraftSummary,
    setDraftTitle,
    setIsSaving,
    updateBlockHighlight,
    updateDraftBlock,
    undoEdit
  } = useDocumentEditorState({
    onHomeDataChange,
    onMessage: onBackupMessage,
    onSelectedDocumentChange: setSelectedDocument,
    selectedDocument,
    selectedDocumentId,
    ui
  })
  const {
    blockHasChildren,
    collapsedBlockIds,
    revealBlockAncestors,
    toggleBlockCollapse
  } = useBlockCollapseState({
    draftBlocks
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
    draftBlocks,
    onActiveBlockChange: setActiveBlockIndex,
    visibleSliceCrossParentGuard: ui.visibleSliceCrossParentGuard
  })

  useDocumentsLoadingOrchestration({
    clearEditorAssistSuggestions,
    clearEditorSession,
    clearMoveTarget,
    draftBlocks,
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
    activeBlockIndex,
    draftBlocks,
    onSelectBlock: (blockIndex) => {
      setActiveBlockIndex(blockIndex)
      setPendingFocusBlockIndex(blockIndex)
    }
  })
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

  useEffect(() => {
    if (!isEditing) {
      return
    }

    const textareas = blockTextareaRefs.current
    for (const textarea of textareas) {
      if (!textarea) {
        continue
      }
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
  }, [draftBlocks, isEditing])

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
    downgradeBlockAt,
    dragOverBlockDepth,
    dragOverBlockIndex,
    draftBlocks,
    draftSummary,
    draftTitle,
    draggingBlockIndex,
    dropBlockAt,
    duplicateDraftBlock,
    duplicateSelectedBlocks,
    endBlockDrag,
    endBlockRangeSelection,
    filteredSlashCommands,
    getDraggedBlockDepthPreview,
    getMultiBlockOperationRange,
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
    insertBlockSuggestion,
    insertDraftBlockAt,
    insertLinkSuggestion,
    isBlockRangeSelecting,
    isBlockSearchOpen,
    isBlockSelected,
    isEditing,
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
    togglePinDocument,
    undoEdit,
    updateBlockHighlight,
    updateDraftBlock,
    updateGlobalSearchQuery
  }
}