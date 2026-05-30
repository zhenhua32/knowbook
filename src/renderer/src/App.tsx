import { useRef } from 'react'
import { useAppShellState } from './hooks/useAppShellState'
import { useAppFeatureDomains } from './hooks/useAppFeatureDomains'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import { useDatabaseDomainState } from './hooks/useDatabaseDomainState'
import { useDocumentsDomainState } from './hooks/useDocumentsDomainState'
import { useWorkspaceOperations } from './hooks/useWorkspaceOperations'
import { AppPageContent } from './components/AppPageContent'
import { WorkspaceShellSidebar } from './components/WorkspaceShellSidebar'

export function App() {
  const resetAiSessionRef = useRef<() => void>(() => undefined)
  const shell = useAppShellState()
  const databaseDomain = useDatabaseDomainState()
  const documentsDomain = useDocumentsDomainState({
    activePage: shell.activePage,
    documentCatalog: shell.homeData.documentCatalog,
    documentTree: shell.homeData.documentTree,
    initialDocumentId: shell.homeData.initialDocumentId,
    onActivePageChange: shell.setActivePage,
    onBackupMessage: shell.setBackupMessage,
    onHomeDataChange: shell.setHomeData,
    resetAiSession: () => resetAiSessionRef.current(),
    ui: shell.ui,
    uiLanguage: shell.uiLanguage
  })

  const workspaceOperations = useWorkspaceOperations({
    catalogColumns: shell.catalogColumns,
    catalogDocuments: shell.catalogDocuments,
    documents: documentsDomain,
    shell,
    ui: shell.ui
  })
  const featureDomains = useAppFeatureDomains({
    activePage: shell.activePage,
    handleBackup: workspaceOperations.handleBackup,
    handleRestoreBackup: workspaceOperations.handleRestoreBackup,
    homeData: shell.homeData,
    isZh: shell.isZh,
    loading: shell.loading,
    documents: documentsDomain,
    shell,
    ui: shell.ui,
    uiLanguage: shell.uiLanguage
  })
  resetAiSessionRef.current = featureDomains.ai.resetAiSession
  useAppKeyboardShortcuts({
    activePage: shell.activePage,
    documents: documentsDomain,
    onClearBlockRangeSelection: () => {
      documentsDomain.setIsBlockRangeSelecting(false)
      documentsDomain.setSelectionAnchorBlockId(null)
      documentsDomain.setSelectedBlockRange(null)
    },
    setActivePage: shell.setActivePage,
  })
return (
     <div className="shell" data-testid="shell">
       <div className="sidebar">
          <WorkspaceShellSidebar
            documents={documentsDomain}
            shell={shell}
            workspace={workspaceOperations}
          />
        </div>

        <AppPageContent
          database={databaseDomain}
          documents={documentsDomain}
          features={featureDomains}
          shell={shell}
          workspace={workspaceOperations}
        />
    </div>
  )
}

