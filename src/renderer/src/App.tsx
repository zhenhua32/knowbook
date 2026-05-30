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
import { useAppFeatureDomains } from './hooks/useAppFeatureDomains'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import { useDatabaseDomainState } from './hooks/useDatabaseDomainState'
import { useDocumentsDomainState } from './hooks/useDocumentsDomainState'
import { useWorkspaceOperations } from './hooks/useWorkspaceOperations'
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
    clearEditorSession,
    closeGlobalSearch,
    isEditing,
    isGlobalSearchOpen,
    moveTargetId,
    navBack,
    navCanGoBack,
    navCanGoForward,
    navForward,
    openDocumentInDocumentsPage,
    openGlobalSearch,
    pinnedDocumentIds,
    redoEdit,
    selectedBlockRange,
    selectedDocument,
    selectedDocumentId,
    setDetailLoading,
    setDraftSummary,
    setIsBlockRangeSelecting,
    setMoveTargetId,
    setSelectedBlockRange,
    setSelectedDocument,
    setSelectedDocumentId,
    setSelectionAnchorBlockId,
    undoEdit
  } = documentsDomain

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
    handleBackup,
    handleBoardColumnDragOver,
    handleCreateDocument,
    handleRestoreBackup,
    handleRootDragLeave,
    handleRootDragOver,
    handleTreeNodeDragOver,
    moveSelectedDocument
  } = useWorkspaceOperations({
    catalogColumns,
    catalogDocuments,
    moveTargetId,
    onClearEditorSession: clearEditorSession,
    selectedDocument,
    selectedDocumentId,
    setBackupMessage,
    setCatalogDocuments,
    setDetailLoading,
    setHomeData,
    setMoveTargetId,
    setSelectedDocument,
    setSelectedDocumentId,
    ui
  })
  const {
    ai: aiDomain,
    plugins: pluginsDomain,
    settingsSectionProps: dashboardSettingsSectionProps
  } = useAppFeatureDomains({
    activePage,
    handleBackup,
    handleRestoreBackup,
    homeData,
    isZh,
    loading,
    onHomeDataChange: setHomeData,
    onMessage: setBackupMessage,
    onOpenDocument: openDocumentInDocumentsPage,
    onSelectedDocumentChange: setSelectedDocument,
    onSetActivePage: setActivePage,
    onUiLanguageChange: setUiLanguage,
    selectedDocument,
    selectedDocumentId,
    setDraftSummary,
    ui,
    uiLanguage
  })
  resetAiSessionRef.current = aiDomain.resetAiSession
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
            pluginDashboardCards={pluginsDomain.pluginDashboardCards}
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
             ai={aiDomain}
             aiConfig={homeData.aiConfig}
             documentTree={homeData.documentTree}
             documents={documentsDomain}
             isZh={isZh}
             onCreateDocument={handleCreateDocument}
             onDeleteSelectedDocument={deleteSelectedDocument}
             onMoveSelectedDocument={moveSelectedDocument}
             plugins={pluginsDomain}
             ui={ui}
           />
         ) : null}

        {activePage === 'ai' ? <AISection {...aiDomain.sectionProps} /> : null}

        {activePage === 'plugins' ? <PluginsSection {...pluginsDomain.sectionProps} /> : null}

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

