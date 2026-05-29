import { useCallback, useDeferredValue, useEffect, useRef } from 'react'
import type {
  BackupResult,
  BlockReferenceResult,
  DatabaseEntity,
  DatabaseSavedView,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  DocumentDatabase,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  DocumentDatabaseFieldValue,
  DocumentBlock,
  DocumentBlockDraft,
  DocumentDetail,
  DocumentSuggestion,
  GlobalSearchResult,
  LinkedDocument,
  PluginDashboardCard,
  PluginDescriptor,
  PluginDocumentAction,
  PluginSettingDescriptor,
  PluginSettingValue,
  WorkspaceGraphEdge,
  WorkspaceGraphNode
} from '@shared/contracts'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { useAppShellState, PAGE_ORDER, type PageId } from './hooks/useAppShellState'
import { PageNavWithWorkspaceTree } from './components/PageNavWithWorkspaceTree'
import { isNestableBlock, normalizeBlockDepth } from './utils/draftBlockShape'
import {
  BOARD_GROUP_BY_PARENT,
  useDatabaseDomainState
} from './hooks/useDatabaseDomainState'
import { useDatabaseDerivedState } from './hooks/useDatabaseDerivedState'
import { useDatabaseColumnActions } from './hooks/useDatabaseColumnActions'
import { useDatabaseEntityActions } from './hooks/useDatabaseEntityActions'
import { useDatabaseEntityBulkActions } from './hooks/useDatabaseEntityBulkActions'
import { useDatabasePageActions } from './hooks/useDatabasePageActions'
import { useDatabaseWorkspaceActions } from './hooks/useDatabaseWorkspaceActions'
import { useDocumentCatalogDatabaseActions } from './hooks/useDocumentCatalogDatabaseActions'
import { useDocumentTodoActions } from './hooks/useDocumentTodoActions'
import { useWorkspaceBackupActions } from './hooks/useWorkspaceBackupActions'
import { useDocumentsDomainState } from './hooks/useDocumentsDomainState'
import { useDocumentsBlockEditorPresentation } from './hooks/useDocumentsBlockEditorPresentation'
import { useDocumentsDetailPresentation } from './hooks/useDocumentsDetailPresentation'
import { useDatabaseSectionPresentation } from './hooks/useDatabaseSectionPresentation'
import { usePluginsDomain } from './hooks/usePluginsDomain'
import { useSettingsDomain } from './hooks/useSettingsDomain'
import { useWorkspaceDocumentManagement } from './hooks/useWorkspaceDocumentManagement'
import { useAiDomain } from './hooks/useAiDomain'
import { AISection } from './sections/AISection'
import { DatabaseSection } from './sections/DatabaseSection'
import { DashboardSettingsSection } from './sections/DashboardSettingsSection'
import { DocumentsSection } from './sections/DocumentsSection'
import { PluginsSection } from './sections/PluginsSection'
import { WorkspaceDashboardSection } from './sections/WorkspaceDashboardSection'
import { WorkspaceGraphSection } from './sections/WorkspaceGraphSection'

const BLOCK_INDENT_SIZE = 24
const BLOCK_DRAG_DEPTH_THRESHOLD = 72

type BlockSelectionRange = {
  start: number
  end: number
}

type DraftBlockUpdater = DocumentBlockDraft[] | ((previous: DocumentBlockDraft[]) => DocumentBlockDraft[])

function buildBlockTypePatch(type: string, content: string, checked = false, depth = 0, parentBlockId?: string | null): DocumentBlockDraft {
  return {
    type,
    content: normalizeBlockContentForType(type, content),
    checked: type === 'todo' ? checked : false,
    depth: normalizeBlockDepth(type, depth),
    parentBlockId: isNestableBlock(type) ? (parentBlockId?.trim() ? parentBlockId : null) : null
  }
}

export function App() {
  const resetAiSessionRef = useRef<() => void>(() => undefined)
  const {
    activePage,
    backupMessage,
    catalogColumns,
    catalogDocuments,
    homeData,
    isZh,
    loading,
    pageDescription,
    pageItems,
    pageTitle,
    setActivePage,
    setBackupMessage,
    setCatalogColumns,
    setCatalogDocuments,
    setHomeData,
    setUiLanguage,
    ui,
    uiLanguage
  } = useAppShellState()
  const {
    activeDatabaseSavedViewId,
    boardGroupBy,
    catalogQuery,
    databaseColumnNameDraft,
    databaseColumnOptionsDraft,
    databaseColumnTypeDraft,
    databaseDescriptionDraft,
    databaseEntities,
    databaseEntityBulkFieldValues,
    databaseEntityDatabaseId,
    databaseEntityDocumentId,
    databaseEntityFieldValues,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    databaseNameDraft,
    databaseSavedViewNameDraft,
    databaseSavedViews,
    databases,
    deferredCatalogQuery,
    isCreatingDatabase,
    isCreatingDatabaseColumn,
    isCreatingDatabaseEntity,
    isCreatingDatabaseSavedView,
    selectedDatabaseColumns,
    selectedDatabaseEntityIds,
    setActiveDatabaseSavedViewId,
    setBoardGroupBy,
    setCatalogQuery,
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setDatabaseDescriptionDraft,
    setDatabaseEntities,
    setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDatabaseId,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode,
    setDatabaseEntityViewMode,
    setDatabaseNameDraft,
    setDatabaseSavedViewNameDraft,
    setDatabaseSavedViews,
    setDatabases,
    setDatabaseWorkspaceView,
    setIsCreatingDatabase,
    setIsCreatingDatabaseColumn,
    setIsCreatingDatabaseEntity,
    setIsCreatingDatabaseSavedView,
    setSelectedDatabaseColumns,
    setSelectedDatabaseEntityIds,
    databaseWorkspaceView
  } = useDatabaseDomainState()
  const {
    activeBlockIndex,
    activeCursorPosition,
    activeLinkContext,
    activeSlashCommand,
    activeSlashContext,
    addDraftBlock,
    adjustBlockDepth,
    adjustSelectedBlocksDepth,
    applySlashCommand,
    autoSaveFlash,
    beginBlockDrag,
    blockHasChildren,
    blockSearchItems,
    blockSearchQuery,
    blockSuggestions,
    blockTextareaRefs,
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
  } = useDocumentsDomainState({
    activePage,
    blockDragDepthThreshold: BLOCK_DRAG_DEPTH_THRESHOLD,
    buildBlockTypePatch,
    documentCatalog: homeData.documentCatalog,
    documentTree: homeData.documentTree,
    initialDocumentId: homeData.initialDocumentId,
    onActivePageChange: (page) => setActivePage(page),
    onBackupMessage: setBackupMessage,
    onHomeDataChange: setHomeData,
    resetAiSession: () => resetAiSessionRef.current(),
    ui,
    uiLanguage
  })
  const {
    aiApiKeyDraft,
    aiAnswer,
    aiAsking,
    aiAutoSummaryOnSaveDraft,
    aiAutomationsRunning,
    aiBaseUrlDraft,
    aiContextError,
    aiContextResults,
    aiContextSearching,
    aiEmbeddingApiKeyDraft,
    aiEmbeddingBaseUrlDraft,
    aiEmbeddingModelDraft,
    aiEnabledDraft,
    aiModelDraft,
    aiPromptDraft,
    aiSaving,
    askAiOnSelectedDocument,
    findRelatedNotesForPrompt,
    resetAiSession,
    runEnabledAiAutomationsOnSelectedDocument,
    saveAiConfig,
    sectionProps: aiSectionProps,
    setAiApiKeyDraft,
    setAiAutoSummaryOnSaveDraft,
    setAiBaseUrlDraft,
    setAiEmbeddingApiKeyDraft,
    setAiEmbeddingBaseUrlDraft,
    setAiEmbeddingModelDraft,
    setAiEnabledDraft,
    setAiModelDraft,
    setAiPromptDraft
  } = useAiDomain({
    aiConfig: homeData.aiConfig,
    isZh,
    onDraftSummaryChange: setDraftSummary,
    onHomeDataChange: setHomeData,
    onMessage: setBackupMessage,
    onOpenDocument: openDocumentInDocumentsPage,
    onSelectedDocumentChange: setSelectedDocument,
    selectedDocument,
    selectedDocumentId,
    ui
  })
  resetAiSessionRef.current = resetAiSession
  const {
    pluginActionBusyKey,
    pluginDashboardCards,
    pluginDocumentActions,
    runPluginDocumentAction,
    sectionProps: pluginsSectionProps
  } = usePluginsDomain({
    homeData,
    onDraftSummaryChange: setDraftSummary,
    onHomeDataChange: setHomeData,
    onMessage: setBackupMessage,
    onSelectedDocumentChange: setSelectedDocument,
    selectedDocument,
    selectedDocumentId,
    ui
  })
  const {
    sectionProps: dashboardSettingsSectionProps
  } = useSettingsDomain({
    aiApiKeyDraft,
    aiAutoSummaryOnSaveDraft,
    aiBaseUrlDraft,
    aiEmbeddingApiKeyDraft,
    aiEmbeddingBaseUrlDraft,
    aiEmbeddingModelDraft,
    aiEnabledDraft,
    aiEndpoint: homeData.aiConfig.baseUrl,
    aiModelDraft,
    aiSaving,
    isSettingsPage: activePage === 'settings',
    isZh,
    loading,
    onAiApiKeyChange: setAiApiKeyDraft,
    onAiAutoSummaryOnSaveChange: setAiAutoSummaryOnSaveDraft,
    onAiBaseUrlChange: setAiBaseUrlDraft,
    onAiEmbeddingApiKeyChange: setAiEmbeddingApiKeyDraft,
    onAiEmbeddingBaseUrlChange: setAiEmbeddingBaseUrlDraft,
    onAiEmbeddingModelChange: setAiEmbeddingModelDraft,
    onAiEnabledChange: setAiEnabledDraft,
    onAiModelChange: setAiModelDraft,
    onBackupNow: () => {
      void handleBackup()
    },
    onMessage: (message) => setBackupMessage(message),
    onOpenDocument: openDocumentInDocumentsPage,
    onOpenPlugins: () => {
      setActivePage('plugins')
    },
    onRestoreBackup: () => {
      void handleRestoreBackup()
    },
    onSaveAiConfig: () => {
      void saveAiConfig()
    },
    onUiLanguageChange: setUiLanguage,
    recentDocuments: homeData.recentDocuments,
    summary: homeData.summary,
    ui,
    uiLanguage
  })
  useEffect(() => {
    const visibleEntityIdSet = new Set(filteredStandaloneDatabaseEntityIds)
    setSelectedDatabaseEntityIds((current) => {
      const next = current.filter((entityId) => visibleEntityIdSet.has(entityId))
      return next.length === current.length ? current : next
    })
  }, [databaseEntities, databaseEntityFilterQuery, databaseEntityFilterScope, databaseEntitySortMode, homeData.documentCatalog, selectedDatabaseColumns])

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
        setIsBlockRangeSelecting(false)
        setSelectionAnchorBlockId(null)
        setSelectedBlockRange(null)
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z') {
        if (isEditing && activePage === 'documents') { event.preventDefault(); undoEdit() }
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
        if (isEditing && activePage === 'documents') { event.preventDefault(); redoEdit() }
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        if (activePage === 'documents') {
          event.preventDefault(); navBack()
        }
      }
      if (event.altKey && event.key === 'ArrowRight') {
        if (activePage === 'documents') {
          event.preventDefault(); navForward()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activePage, isGlobalSearchOpen, isEditing, navBack, navForward, redoEdit, selectedBlockRange, undoEdit])

  const {
    handleBackup,
    handleRestoreBackup,
    refreshWorkspaceAfterStorageMutation
  } = useWorkspaceBackupActions({
    selectedDocumentId,
    setBackupMessage,
    setHomeData,
    setSelectedDocument,
    setSelectedDocumentId,
    ui
  })

  const { toggleTodoBlockChecked } = useDocumentTodoActions({
    selectedDocument,
    setBackupMessage,
    setHomeData,
    setIsSaving,
    setSelectedDocument,
    todoUpdateFailedMessage: ui.todoUpdateFailed
  })

  const {
    createDatabase,
    deleteCurrentDatabase,
    switchDatabaseWorkspaceView
  } = useDatabaseWorkspaceActions({
    databaseEntityDatabaseId,
    databaseDescriptionDraft,
    databaseNameDraft,
    databases,
    setBackupMessage,
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setDatabaseDescriptionDraft,
    setDatabaseEntities,
    setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDatabaseId,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setDatabaseNameDraft,
    setDatabaseWorkspaceView,
    setDatabases,
    setIsCreatingDatabase,
    setIsCreatingDatabaseColumn,
    setIsCreatingDatabaseEntity,
    setSelectedDatabaseEntityIds,
    ui
  })

  const {
    beginCurrentDatabaseSavedViewCreation,
    cancelCurrentDatabaseSavedViewCreation,
    deleteCurrentDatabaseSavedView,
    handleDatabaseSavedViewSelect,
    refreshDatabasePageData,
    refreshDocumentCatalogData,
    saveCurrentDatabaseSavedView,
    updateCurrentDatabaseSavedView
  } = useDatabasePageActions({
    activeDatabaseSavedViewId,
    databaseEntityDatabaseId,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    databaseSavedViewNameDraft,
    databaseSavedViews,
    setActiveDatabaseSavedViewId,
    setBackupMessage,
    setCatalogColumns,
    setCatalogDocuments,
    setDatabaseEntities,
    setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode,
    setDatabaseEntityViewMode,
    setDatabaseSavedViewNameDraft,
    setDatabaseSavedViews,
    setHomeData,
    setIsCreatingDatabaseSavedView,
    setSelectedDatabaseColumns,
    setSelectedDatabaseEntityIds,
    ui
  })

  const {
    updateDocumentDatabaseValue
  } = useDocumentCatalogDatabaseActions({
    setBackupMessage,
    setCatalogDocuments,
    setHomeData
  })

  const {
    beginDrag,
    deleteSelectedDocument,
    dragOverBoardColumnId,
    dragOverRoot,
    draggingDocumentId,
    dropOnBoardTarget,
    dropOnDocument,
    dropToRoot,
    endDrag,
    handleBoardColumnDragOver,
    handleCreateDocument,
    handleRootDragLeave,
    handleRootDragOver,
    handleTreeNodeDragOver,
    moveSelectedDocument
  } = useWorkspaceDocumentManagement({
    catalogColumns,
    catalogDocuments,
    moveTargetId,
    onClearEditorSession: clearEditorSession,
    onDetailLoadingChange: setDetailLoading,
    onHomeDataChange: setHomeData,
    onMessage: setBackupMessage,
    onMoveTargetIdChange: setMoveTargetId,
    onSelectedDocumentChange: setSelectedDocument,
    onSelectedDocumentIdChange: setSelectedDocumentId,
    onUpdateDocumentDatabaseValue: updateDocumentDatabaseValue,
    selectedDocument,
    selectedDocumentId,
    ui
  })
  const {
    activeDatabaseSavedView,
    boardColumns,
    boardGroupableColumns,
    boardGroupingColumn,
    databasePageHint,
    databasePageTitle,
    databaseSavedViewDirty,
    filteredCatalog,
    filteredStandaloneDatabaseEntityIds,
    filteredStandaloneDatabaseEntityRows,
    selectedDatabase,
    selectedDatabaseEntityIdSet,
    selectedVisibleDatabaseEntitiesHaveLinkedDocument,
    selectedVisibleDatabaseEntityIds,
    standaloneDatabases
  } = useDatabaseDerivedState({
    activeDatabaseSavedViewId,
    boardGroupBy,
    catalogColumns,
    catalogDocuments,
    databaseEntities,
    databaseEntityDatabaseId,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    databaseSavedViews,
    databaseWorkspaceView,
    databases,
    deferredCatalogQuery,
    documentCatalog: homeData.documentCatalog,
    isDatabasePageActive: activePage === 'database',
    selectedDatabaseColumns,
    selectedDatabaseEntityIds,
    uiDocumentCatalogHint: ui.documentCatalogHint,
    uiDocumentCatalogTitle: ui.documentCatalogTitle,
    uiStandaloneDatabasesHint: ui.standaloneDatabasesHint,
    uiStandaloneDatabasesTitle: ui.standaloneDatabasesTitle
  })
  const {
    createDatabaseColumn,
    deleteDatabaseColumn,
    moveDatabaseColumn,
    renameDatabaseColumn,
    updateDatabaseColumnOptions
  } = useDatabaseColumnActions({
    databaseColumnNameDraft,
    databaseColumnOptionsDraft,
    databaseColumnTypeDraft,
    databaseWorkspaceView,
    refreshDatabasePageData,
    refreshDocumentCatalogData,
    selectedDatabase,
    setBackupMessage,
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setIsCreatingDatabaseColumn,
    ui
  })
  const {
    createDatabaseEntity,
    deleteDatabaseEntity,
    updateDatabaseEntityDocument,
    updateDatabaseEntityField
  } = useDatabaseEntityActions({
    databaseEntityDatabaseId,
    databaseEntityDocumentId,
    databaseEntityFieldValues,
    refreshDatabasePageData,
    setBackupMessage,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setIsCreatingDatabaseEntity,
    ui
  })
  const {
    applyDatabaseEntityFieldToSelected,
    clearDatabaseEntityFieldFromSelected,
    clearSelectedDatabaseEntityDocuments,
    deleteSelectedDatabaseEntities,
    selectVisibleDatabaseEntities,
    toggleDatabaseEntitySelection,
    updateDatabaseEntityBulkFieldValue
  } = useDatabaseEntityBulkActions({
    databaseEntityBulkFieldValues,
    databaseEntityDatabaseId,
    filteredStandaloneDatabaseEntityIds,
    refreshDatabasePageData,
    selectedVisibleDatabaseEntityIds,
    setBackupMessage,
    setDatabaseEntityBulkFieldValues,
    setSelectedDatabaseEntityIds,
    ui
  })
  const {
    board: databaseBoardProps,
    catalog: databaseCatalogProps,
    standalone: databaseStandaloneProps
  } = useDatabaseSectionPresentation({
    activeDatabaseSavedView,
    activeDatabaseSavedViewId,
    applyDatabaseEntityFieldToSelected,
    beginDrag,
    beginCurrentDatabaseSavedViewCreation,
    boardColumns,
    boardGroupBy,
    boardGroupableColumns,
    boardGroupingColumn,
    cancelCurrentDatabaseSavedViewCreation,
    catalogColumns,
    catalogQuery,
    clearDatabaseEntityFieldFromSelected,
    clearSelectedDatabaseEntityDocuments,
    createDatabase,
    createDatabaseColumn,
    createDatabaseEntity,
    databaseDescriptionDraft,
    databaseColumnNameDraft,
    databaseColumnOptionsDraft,
    databaseColumnTypeDraft,
    databaseEntities,
    databaseEntityBulkFieldValues,
    databaseEntityDatabaseId,
    databaseEntityDocumentId,
    databaseEntityFieldValues,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    databaseNameDraft,
    databaseSavedViewDirty,
    databaseSavedViewNameDraft,
    databaseSavedViews,
    deleteCurrentDatabase,
    deleteCurrentDatabaseSavedView,
    deleteDatabaseColumn,
    deleteDatabaseEntity,
    deleteSelectedDatabaseEntities,
    dragOverBoardColumnId,
    draggingDocumentId,
    documentCatalog: homeData.documentCatalog,
    dropOnBoardTarget,
    endDrag,
    filteredCatalog,
    filteredStandaloneDatabaseEntityRows,
    handleDatabaseSavedViewSelect,
    handleBoardColumnDragOver,
    isCreatingDatabaseColumn,
    isCreatingDatabase,
    isCreatingDatabaseEntity,
    isCreatingDatabaseSavedView,
    moveDatabaseColumn,
    openDocumentInDocumentsPage,
    parentGroupValue: BOARD_GROUP_BY_PARENT,
    renameDatabaseColumn,
    saveCurrentDatabaseSavedView,
    selectVisibleDatabaseEntities,
    selectedDatabase,
    selectedDatabaseColumns,
    selectedDatabaseEntityIdSet,
    selectedEntitiesHaveLinkedDocument: selectedVisibleDatabaseEntitiesHaveLinkedDocument,
    selectedDocumentId,
    selectedVisibleDatabaseEntityIds,
    setBoardGroupBy,
    setCatalogQuery,
    setDatabaseDescriptionDraft,
    setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDatabaseId,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode,
    setDatabaseEntityViewMode,
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setDatabaseNameDraft,
    setDatabaseSavedViewNameDraft,
    setIsCreatingDatabase,
    setIsCreatingDatabaseColumn,
    setIsCreatingDatabaseEntity,
    setSelectedDatabaseEntityIds,
    standaloneDatabases,
    toggleDatabaseEntitySelection,
    updateCurrentDatabaseSavedView,
    updateDatabaseColumnOptions,
    updateDatabaseEntityBulkFieldValue,
    updateDatabaseEntityDocument,
    updateDatabaseEntityField,
    updateDocumentDatabaseValue
  })
  const {
    blockEditorRowSharedProps: documentsBlockEditorRowSharedProps,
    floatingSlashCommandPanelProps: documentsFloatingSlashCommandPanelProps,
    linkSuggestionPanelProps: documentsLinkSuggestionPanelProps,
    outlinePanelProps: documentsOutlinePanelProps,
    selectionToolbarProps: documentsSelectionToolbarProps,
    visibleEditorRows: visibleDocumentEditorRows
  } = useDocumentsBlockEditorPresentation({
    activeBlockIndex,
    activeLinkContext,
    activeSlashCommand,
    activeSlashContext,
    adjustBlockDepth,
    adjustSelectedBlocksDepth,
    applySlashCommand,
    beginBlockDrag,
    blockSuggestions,
    blockHasChildren,
    blockTextareaRefs,
    BLOCK_INDENT_SIZE,
    canMoveSelectedRange,
    canMoveSelectionDown,
    canMoveSelectionUp,
    captureBlockCursor,
    collapsedBlockIds,
    clearBlockSelection,
    continueBlockAt,
    convertSelectedBlocks,
    copySelectedBlocks,
    copySelectedBlocksAsPlainText,
    cutSelectedBlocks,
    deleteSelectedBlocks,
    dismissSlashCommand,
    draftBlocks,
    dragOverBlockDepth,
    dragOverBlockIndex,
    draggingBlockIndex,
    downgradeBlockAt,
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
    handleBlockContentChange,
    handleBlockMouseEnter,
    handleBlockPaste,
    insertDraftBlockAt,
    insertBlockSuggestion,
    insertLinkSuggestion,
    isBlockRangeSelecting,
    isBlockSelected,
    isSelectionCoherent,
    isZh,
    linkSuggestions,
    mergeWithPreviousBlock,
    moveDraftBlockBySibling,
    moveSelectedBlocks,
    navigateInlineReferenceAtCursor,
    notifyBlockMouseDown,
    onSelectOutlineBlock: (blockIndex) => {
      setActiveBlockIndex(blockIndex)
      setPendingFocusBlockIndex(blockIndex)
    },
    removeSelectedBlockRange,
    selectAllBlocks,
    selectBlockRange,
    selectedBlockActionCount,
    selectedBlockCount,
    selectedBlockConversionType,
    selectedBlockHasHiddenCollapsedContent,
    selectedBlockInteractionIssue,
    selectedBlockRange,
    selectedDocument,
    selectedVisibleBlockCount,
    selectedVisibleSiblingSlice,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setSelectedBlockConversionType,
    setSelectedSlashCommandIndex,
    slashPanelPos,
    splitDraftBlock,
    toggleBlockCollapse,
    ui,
    updateBlockHighlight,
    updateDraftBlock
  })
  const {
    auxPanelProps: documentsAuxPanelProps,
    previewHeaderProps: documentsPreviewHeaderProps,
    relationGroups: documentsRelationGroups,
    statsBarProps: documentsStatsBarProps,
    summaryCardProps: documentsSummaryCardProps
  } = useDocumentsDetailPresentation({
    aiAnswer,
    aiAsking,
    aiAutomationsRunning,
    aiContextError,
    aiContextResults,
    aiContextSearching,
    aiEnabled: homeData.aiConfig.enabled,
    aiPromptDraft,
    autoSaveFlash,
    canRedo,
    canUndo,
    detailLoading,
    documentTree: homeData.documentTree,
    documentsAuxPanelOpen,
    draftBlocks,
    draftSummary,
    draftTitle,
    hasApiKey: homeData.aiConfig.hasApiKey,
    isZh,
    isSaving,
    mdCopyFlash,
    moveTargetId,
    onAddChild: () => {
      if (selectedDocument) {
        void handleCreateDocument(selectedDocument.id)
      }
    },
    onAiPromptChange: setAiPromptDraft,
    onAskAi: () => {
      void askAiOnSelectedDocument()
    },
    onCopyMarkdown: () => {
      void copyDocumentAsMarkdown()
    },
    onDelete: () => {
      void deleteSelectedDocument()
    },
    onFindRelatedNotes: () => {
      void findRelatedNotesForPrompt()
    },
    onMove: () => {
      void moveSelectedDocument()
    },
    onMoveTargetChange: setMoveTargetId,
    onOpenDocument: openDocumentInDocumentsPage,
    onRedo: redoEdit,
    onRunEnabledAutomations: () => {
      void runEnabledAiAutomationsOnSelectedDocument()
    },
    onRunPluginAction: (action) => {
      void runPluginDocumentAction(action)
    },
    onSave: () => {
      void saveDocument()
    },
    onSaveMarkdown: () => {
      void saveDocumentAsMarkdown()
    },
    onSummaryChange: setDraftSummary,
    onToggleAuxPanel: toggleDocumentsAuxPanel,
    onTogglePin: () => {
      if (selectedDocument) {
        togglePinDocument(selectedDocument.id)
      }
    },
    onTitleChange: setDraftTitle,
    onUndo: undoEdit,
    pinnedDocumentIds,
    pluginActionBusyKey,
    pluginDocumentActions,
    selectedDocument,
    selectedDocumentId,
    ui
  })

  useEffect(() => {
    if (boardGroupBy === BOARD_GROUP_BY_PARENT) {
      return
    }

    if (!boardGroupableColumns.some((column) => column.id === boardGroupBy)) {
      setBoardGroupBy(BOARD_GROUP_BY_PARENT)
    }
  }, [boardGroupBy, boardGroupableColumns])

return (
     <div className="shell" data-testid="shell">
       <div className="sidebar">
            <PageNavWithWorkspaceTree
            activePage={activePage}
            pageItems={pageItems}
            onSelectPage={(pageId) => setActivePage(pageId as PageId)}
            pageTitle={pageTitle}
            pageDescription={pageDescription}
            brandEyebrow={ui.brandEyebrow}
            navLabel={isZh ? '页面导航' : 'Navigation'}
            currentPageLabel={isZh ? '当前页面' : 'Current page'}
            currentPageHint={isZh ? '默认启动页为文档页，配置与特色功能已拆分到独立页面。' : 'Documents is now the default entry page, and feature modules are separated into dedicated pages.'}
            backTitle={`${ui.back} (Alt+←)`}
            forwardTitle={`${ui.forward} (Alt+→)`}
            rootsCountLabel={ui.rootsCount(homeData.documentTree.length)}
            onOpenGlobalSearch={openGlobalSearch}
            globalSearchTitle={`${ui.globalSearch} (Ctrl+K)`}
            onCreateRoot={() => { void handleCreateDocument(null) }}
            newRootLabel={ui.newRoot}
            dropToRootLabel={ui.dropToRoot}
            dragOverRoot={dragOverRoot}
            onRootDragOver={handleRootDragOver}
            onRootDragLeave={handleRootDragLeave}
             onDropToRoot={() => { void dropToRoot() }}
             pinnedSectionLabel={ui.pinnedSectionLabel}
             pinnedDocuments={homeData.documentCatalog.filter((document) => pinnedDocumentIds.has(document.id))}
             selectedDocumentId={selectedDocumentId}
             onSelectDocument={openDocumentInDocumentsPage}
             documentTreeNodes={homeData.documentTree}
             workspaceGraphNodes={homeData.graph.nodes}
             workspaceGraphEdges={homeData.graph.edges}
             navCanGoBack={navCanGoBack}
             navCanGoForward={navCanGoForward}
             onNavBack={navBack}
             onNavForward={navForward}
             onSelectGraphNode={openDocumentInDocumentsPage}
             onDragStart={beginDrag}
             onDragEnd={endDrag}
             onDragOverNode={handleTreeNodeDragOver}
             onDropOnNode={dropOnDocument}
             uiLanguage={uiLanguage}
             totalDocumentsCount={homeData.summary.documents}
           />
        </div>

        <main className={`content page-${activePage}`}>
        {activePage === 'dashboard' ? (
          <WorkspaceDashboardSection
            isAiEnabled={homeData.aiConfig.enabled}
            onBackupNow={handleBackup}
            onOpenDocument={openDocumentInDocumentsPage}
            onRestoreBackup={handleRestoreBackup}
            pluginDashboardCards={pluginDashboardCards}
            recentEvents={homeData.recentEvents}
            summary={homeData.summary}
            ui={ui}
          />
        ) : null}

        {backupMessage ? (
          <p className="flash-message">
            {backupMessage}
            <button className="flash-close" onClick={() => setBackupMessage(null)} type="button">✕</button>
          </p>
        ) : null}

         {activePage === 'graph' ? (
           <WorkspaceGraphSection
             edges={homeData.graph.edges}
             nodes={homeData.graph.nodes}
             onSelectDocument={openDocumentInDocumentsPage}
             selectedDocumentId={selectedDocumentId}
             ui={ui}
           />
         ) : null}

         {activePage === 'database' ? (
           <DatabaseSection
             board={databaseBoardProps}
             catalog={databaseCatalogProps}
             databasePageHint={databasePageHint}
             databasePageTitle={databasePageTitle}
             databaseWorkspaceView={databaseWorkspaceView}
             onSwitchDatabaseWorkspaceView={switchDatabaseWorkspaceView}
             standalone={databaseStandaloneProps}
             ui={ui}
           />
         ) : null}

         {activePage === 'documents' ? (
           <DocumentsSection
             addBlockLabel={ui.addBlock}
             blockEditorRowSharedProps={documentsBlockEditorRowSharedProps}
             blockSearchPanelProps={{
               isOpen: isBlockSearchOpen,
               items: blockSearchItems,
               noMatchText: ui.noBlocksMatchSearch,
               onClose: closeBlockSearch,
               onQueryChange: setBlockSearchQuery,
               onSelect: handleBlockSearchSelect,
               placeholder: ui.searchBlocksPlaceholder,
               query: blockSearchQuery
             }}
             blocksPanelLabel={ui.blocksPanelLabel}
             documentStatsBarProps={documentsStatsBarProps}
             documentsAuxPanelProps={documentsAuxPanelProps}
             editorHelpText={ui.editorHelpText}
             emptyDocumentStateText={ui.emptyDocumentState}
             floatingSlashCommandPanelProps={documentsFloatingSlashCommandPanelProps}
             linkSuggestionPanelProps={documentsLinkSuggestionPanelProps}
             onAddBlock={addDraftBlock}
             onEditorKeyDown={(event) => {
               if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
                 event.preventDefault()
                 openBlockSearch()
               }
             }}
             outlinePanelProps={documentsOutlinePanelProps}
             previewHeaderProps={documentsPreviewHeaderProps}
             relationGroups={documentsRelationGroups}
             selectedDocument={selectedDocument}
             selectionToolbarProps={documentsSelectionToolbarProps}
             summaryCardProps={documentsSummaryCardProps}
             visibleEditorRows={visibleDocumentEditorRows}
           />
         ) : null}

        {activePage === 'ai' ? <AISection {...aiSectionProps} /> : null}

        {activePage === 'plugins' ? <PluginsSection {...pluginsSectionProps} /> : null}

        {activePage === 'dashboard' || activePage === 'settings' ? <DashboardSettingsSection {...dashboardSettingsSectionProps} /> : null}
      </main>

      {activePage === 'documents' && isGlobalSearchOpen && (
        <div className="global-search-overlay" onClick={closeGlobalSearch}>
          <div className="global-search-modal" onClick={(e) => e.stopPropagation()}>
            <div className="global-search-header">
              <input
                autoFocus
                className="global-search-input"
                placeholder={ui.globalSearchPlaceholder}
                type="text"
                value={globalSearchQuery}
                onChange={(event) => {
                  void updateGlobalSearchQuery(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeGlobalSearch()
                }}
              />
              <button className="secondary-button" onClick={closeGlobalSearch} type="button">✕</button>
            </div>
            <div className="global-search-results">
              {globalSearchLoading && <p className="mini-hint">{ui.globalSearchLoading}</p>}
              {!globalSearchLoading && globalSearchQuery && globalSearchResults.length === 0 && (
                <p className="mini-hint">{ui.globalSearchNoResults}</p>
              )}
              {!globalSearchLoading && !globalSearchQuery && (
                <p className="mini-hint">{ui.globalSearchPrompt}</p>
              )}
              {globalSearchResults.map((result, idx) => (
                <button
                  className="global-search-result"
                  key={idx}
                  onClick={() => handleGlobalSearchNavigate(result)}
                  type="button"
                >
                  <div className="global-search-result-header">
                    <span className="global-search-doc-path">{result.documentPath}</span>
                    <span className={`global-search-match-badge ${result.matchType === 'title' ? 'global-search-match-title' : 'global-search-match-block'}`}>
                      {result.matchType === 'title' ? ui.titleMatchLabel : result.blockType ?? ui.blockMatchFallback}
                    </span>
                  </div>
                  <strong className="global-search-doc-title">{result.documentTitle}</strong>
                  {result.snippet && (
                    <p className="global-search-snippet">{result.snippet}</p>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function normalizeBlockContentForType(type: string, content: string) {
  if (type === 'divider') {
    return ''
  }

  return content
}

