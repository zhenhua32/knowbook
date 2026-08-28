import { useCallback, useEffect, useRef } from 'react'
import { useAppShellState } from './hooks/useAppShellState'
import { useAppFeatureDomains } from './hooks/useAppFeatureDomains'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import { useDatabaseDomainState } from './hooks/useDatabaseDomainState'
import { useDocumentsDomainState } from './hooks/useDocumentsDomainState'
import { useWorkspaceOperations } from './hooks/useWorkspaceOperations'
import { AppPageContent } from './components/AppPageContent'
import { WorkspaceShellSidebar } from './components/WorkspaceShellSidebar'
import { PluginUiPreparationHost } from './components/PluginUiPreparationHost'

export function App() {
  const resetAiSessionRef = useRef<() => void>(() => undefined)
  const resetAiSession = useCallback(() => {
    resetAiSessionRef.current()
  }, [])
  const shell = useAppShellState()
  const databaseDomain = useDatabaseDomainState(shell.activePage === 'database')
  const documentsDomain = useDocumentsDomainState({
    resetAiSession,
    shell
  })

  const workspaceOperations = useWorkspaceOperations({
    documents: documentsDomain,
    reloadDatabaseDomain: databaseDomain.reloadDatabaseDomain,
    shell
  })
  const featureDomains = useAppFeatureDomains({
    handleBackup: workspaceOperations.handleBackup,
    handleRestoreBackup: workspaceOperations.handleRestoreBackup,
    documents: documentsDomain,
    shell
  })
  useEffect(() => {
    resetAiSessionRef.current = featureDomains.ai.resetAiSession
  })
  useAppKeyboardShortcuts({
    documents: documentsDomain,
    onClearBlockRangeSelection: () => {
      documentsDomain.setIsBlockRangeSelecting(false)
      documentsDomain.setSelectionAnchorBlockId(null)
      documentsDomain.setSelectedBlockRange(null)
    },
    shell,
  })
return (
    <>
     <PluginUiPreparationHost />
     <div className="shell" data-testid="shell">
       <div className={`sidebar${shell.isNavCollapsed ? ' collapsed' : ''}`}>
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
    </>
  )
}

