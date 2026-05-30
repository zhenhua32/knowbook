import { useRef } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { useAppShellState } from './hooks/useAppShellState'
import { isNestableBlock, normalizeBlockDepth } from './utils/draftBlockShape'
import { useAppFeatureDomains } from './hooks/useAppFeatureDomains'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import { useDatabaseDomainState } from './hooks/useDatabaseDomainState'
import { useDocumentsDomainState } from './hooks/useDocumentsDomainState'
import { useWorkspaceOperations } from './hooks/useWorkspaceOperations'
import { AppPageContent } from './components/AppPageContent'
import { WorkspaceShellSidebar } from './components/WorkspaceShellSidebar'

const BLOCK_DRAG_DEPTH_THRESHOLD = 72

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

  const workspaceOperations = useWorkspaceOperations({
    catalogColumns,
    catalogDocuments,
    documents: documentsDomain,
    shell: {
      setBackupMessage,
      setCatalogDocuments,
      setHomeData
    },
    ui
  })
  const featureDomains = useAppFeatureDomains({
    activePage,
    handleBackup: workspaceOperations.handleBackup,
    handleRestoreBackup: workspaceOperations.handleRestoreBackup,
    homeData,
    isZh,
    loading,
    documents: documentsDomain,
    shell: {
      setActivePage,
      setBackupMessage,
      setHomeData,
      setUiLanguage
    },
    ui,
    uiLanguage
  })
  resetAiSessionRef.current = featureDomains.ai.resetAiSession
  useAppKeyboardShortcuts({
    activePage,
    documents: documentsDomain,
    onClearBlockRangeSelection: () => {
      documentsDomain.setIsBlockRangeSelecting(false)
      documentsDomain.setSelectionAnchorBlockId(null)
      documentsDomain.setSelectedBlockRange(null)
    },
    setActivePage,
  })
return (
     <div className="shell" data-testid="shell">
       <div className="sidebar">
          <WorkspaceShellSidebar
            activePage={activePage}
            documents={documentsDomain}
            homeData={homeData}
            isZh={isZh}
            onSelectPage={setActivePage}
            pageDescription={pageDescription}
            pageItems={pageItems}
            pageTitle={pageTitle}
            ui={ui}
            uiLanguage={uiLanguage}
            workspace={workspaceOperations}
          />
        </div>

        <AppPageContent
          activePage={activePage}
          backupMessage={backupMessage}
          catalogColumns={catalogColumns}
          catalogDocuments={catalogDocuments}
          database={databaseDomain}
          documents={documentsDomain}
          features={featureDomains}
          homeData={homeData}
          isZh={isZh}
          onCatalogColumnsChange={setCatalogColumns}
          onCatalogDocumentsChange={setCatalogDocuments}
          onHomeDataChange={setHomeData}
          onMessageChange={setBackupMessage}
          ui={ui}
          workspace={workspaceOperations}
        />
    </div>
  )
}

function normalizeBlockContentForType(type: string, content: string) {
  if (type === 'divider') {
    return ''
  }

  return content
}

