import { Suspense, useCallback, useEffect, useRef } from 'react'
import { useAppShellState } from './hooks/useAppShellState'
import { useAppFeatureDomains } from './hooks/useAppFeatureDomains'
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts'
import { useDatabaseDomainState } from './hooks/useDatabaseDomainState'
import { useDocumentsDomainState } from './hooks/useDocumentsDomainState'
import { useWorkspaceOperations } from './hooks/useWorkspaceOperations'
import { ErrorBoundary } from './components/ErrorBoundary'
import { lazyWithRetry } from './utils/lazyWithRetry'
import { WorkspaceShellSidebar } from './components/WorkspaceShellSidebar'
import { PluginUiPreparationHost } from './components/PluginUiPreparationHost'

const AppPageContent = lazyWithRetry(async () => ({ default: (await import('./components/AppPageContent')).AppPageContent }))
const GlobalSearchPalette = lazyWithRetry(() => import('./components/GlobalSearchPalette'))

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
      {documentsDomain.isGlobalSearchOpen && <ErrorBoundary onNavigate={documentsDomain.closeGlobalSearch} navigateLabel={shell.isZh ? '关闭搜索' : 'Close search'}>
        <Suspense fallback={null}><GlobalSearchPalette documents={documentsDomain} shell={shell} workspace={workspaceOperations} /></Suspense>
      </ErrorBoundary>}
      <div className="shell" data-testid="shell">
        <div className={`sidebar${shell.isNavCollapsed ? ' collapsed' : ''}`}>
          <ErrorBoundary page>
            <WorkspaceShellSidebar
              documents={documentsDomain}
              shell={shell}
              workspace={workspaceOperations}
            />
          </ErrorBoundary>
        </div>

        <ErrorBoundary
          page
          resetKey={`${shell.activePage}:${documentsDomain.selectedDocumentId}:${databaseDomain.databaseEntityDatabaseId}`}
          onNavigate={() => shell.setActivePage(shell.activePage === 'dashboard' ? 'documents' : 'dashboard')}
          navigateLabel={shell.activePage === 'dashboard' ? (shell.isZh ? '返回文档' : 'Go to documents') : undefined}
        >
          <Suspense fallback={<main className="content" role="status">{shell.ui.common.loading}</main>}>
            <AppPageContent
              database={databaseDomain}
              documents={documentsDomain}
              features={featureDomains}
              shell={shell}
              workspace={workspaceOperations}
            />
          </Suspense>
        </ErrorBoundary>
      </div>
    </>
  )
}

