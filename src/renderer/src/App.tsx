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
    resetAiSession: () => resetAiSessionRef.current(),
    shell
  })

  const workspaceOperations = useWorkspaceOperations({
    documents: documentsDomain,
    shell
  })
  const featureDomains = useAppFeatureDomains({
    handleBackup: workspaceOperations.handleBackup,
    handleRestoreBackup: workspaceOperations.handleRestoreBackup,
    documents: documentsDomain,
    shell
  })
  resetAiSessionRef.current = featureDomains.ai.resetAiSession
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

