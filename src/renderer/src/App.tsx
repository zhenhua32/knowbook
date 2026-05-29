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
import { DatabasePage } from './pages/DatabasePage'
import { DocumentsPage } from './pages/DocumentsPage'
import { AISection } from './sections/AISection'
import { DashboardSettingsSection } from './sections/DashboardSettingsSection'
import { PluginsSection } from './sections/PluginsSection'
import { WorkspaceDashboardSection } from './sections/WorkspaceDashboardSection'
import { WorkspaceGraphSection } from './sections/WorkspaceGraphSection'

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
  const databaseDomain = useDatabaseDomainState()
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
  } = databaseDomain
  const documentsDomain = useDocumentsDomainState({
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
  } = documentsDomain
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
           <DatabasePage
             catalogColumns={catalogColumns}
             catalogDocuments={catalogDocuments}
             database={databaseDomain}
             documentCatalog={homeData.documentCatalog}
             onCatalogColumnsChange={setCatalogColumns}
             onCatalogDocumentsChange={setCatalogDocuments}
             onHomeDataChange={setHomeData}
             onMessage={setBackupMessage}
             onOpenDocument={openDocumentInDocumentsPage}
             selectedDocumentId={selectedDocumentId}
             ui={ui}
             workspaceBoard={{
               beginDrag,
               dragOverBoardColumnId,
               draggingDocumentId,
               dropOnBoardTarget,
               endDrag,
               handleBoardColumnDragOver
             }}
           />
         ) : null}

         {activePage === 'documents' ? (
           <DocumentsPage
             ai={{
               aiAnswer,
               aiAsking,
               aiAutomationsRunning,
               aiContextError,
               aiContextResults,
               aiContextSearching,
               aiPromptDraft,
               askAiOnSelectedDocument,
               findRelatedNotesForPrompt,
               runEnabledAiAutomationsOnSelectedDocument,
               setAiPromptDraft
             }}
             aiConfig={homeData.aiConfig}
             documentTree={homeData.documentTree}
             documents={documentsDomain}
             isZh={isZh}
             onCreateDocument={handleCreateDocument}
             onDeleteSelectedDocument={deleteSelectedDocument}
             onMoveSelectedDocument={moveSelectedDocument}
             plugins={{
               pluginActionBusyKey,
               pluginDocumentActions,
               runPluginDocumentAction
             }}
             ui={ui}
           />
         ) : null}

        {activePage === 'ai' ? <AISection {...aiSectionProps} /> : null}

        {activePage === 'plugins' ? <PluginsSection {...pluginsSectionProps} /> : null}

        {activePage === 'dashboard' || activePage === 'settings' ? <DashboardSettingsSection {...dashboardSettingsSectionProps} /> : null}
      </main>
    </div>
  )
}

function normalizeBlockContentForType(type: string, content: string) {
  if (type === 'divider') {
    return ''
  }

  return content
}

