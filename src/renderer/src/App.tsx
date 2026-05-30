import { useRef } from 'react'
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
import { useAppShellState } from './hooks/useAppShellState'
import { isNestableBlock, normalizeBlockDepth } from './utils/draftBlockShape'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import { useDatabaseDomainState } from './hooks/useDatabaseDomainState'
import { useDocumentCatalogDatabaseActions } from './hooks/useDocumentCatalogDatabaseActions'
import { useDocumentTodoActions } from './hooks/useDocumentTodoActions'
import { useWorkspaceBackupActions } from './hooks/useWorkspaceBackupActions'
import { useDocumentsDomainState } from './hooks/useDocumentsDomainState'
import { usePluginsDomain } from './hooks/usePluginsDomain'
import { useSettingsDomain } from './hooks/useSettingsDomain'
import { useWorkspaceDocumentManagement } from './hooks/useWorkspaceDocumentManagement'
import { useAiDomain } from './hooks/useAiDomain'
import { WorkspaceShellSidebar } from './components/WorkspaceShellSidebar'
import { DatabasePage } from './pages/DatabasePage'
import { DocumentsPage } from './pages/DocumentsPage'
import { AISection } from './sections/AISection'
import { DashboardSettingsSection } from './sections/DashboardSettingsSection'
import { PluginsSection } from './sections/PluginsSection'
import { WorkspaceDashboardSection } from './sections/WorkspaceDashboardSection'
import { WorkspaceGraphSection } from './sections/WorkspaceGraphSection'

const BLOCK_DRAG_DEPTH_THRESHOLD = 72

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
  useAppKeyboardShortcuts({
    activePage,
    closeGlobalSearch,
    isEditing,
    isGlobalSearchOpen,
    navBack,
    navForward,
    onClearBlockRangeSelection: () => {
      setIsBlockRangeSelecting(false)
      setSelectionAnchorBlockId(null)
      setSelectedBlockRange(null)
    },
    openGlobalSearch,
    redoEdit,
    selectedBlockRange,
    setActivePage,
    undoEdit
  })

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
          <WorkspaceShellSidebar
            activePage={activePage}
            dragOverRoot={dragOverRoot}
            homeData={homeData}
            isZh={isZh}
            navCanGoBack={navCanGoBack}
            navCanGoForward={navCanGoForward}
            onCreateRoot={() => {
              void handleCreateDocument(null)
            }}
            onDragEnd={endDrag}
            onDragOverNode={handleTreeNodeDragOver}
            onDragStart={beginDrag}
            onDropOnDocument={dropOnDocument}
            onDropToRoot={() => {
              void dropToRoot()
            }}
            onNavBack={navBack}
            onNavForward={navForward}
            onOpenGlobalSearch={openGlobalSearch}
            onRootDragLeave={handleRootDragLeave}
            onRootDragOver={handleRootDragOver}
            onSelectDocument={openDocumentInDocumentsPage}
            onSelectPage={setActivePage}
            pageDescription={pageDescription}
            pageItems={pageItems}
            pageTitle={pageTitle}
            pinnedDocumentIds={pinnedDocumentIds}
            selectedDocumentId={selectedDocumentId}
            ui={ui}
            uiLanguage={uiLanguage}
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

