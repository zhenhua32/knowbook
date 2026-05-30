import type { Dispatch, SetStateAction } from 'react'
import type { DocumentCatalogEntry, DocumentDatabaseColumn, HomeData } from '@shared/contracts'
import type { useAppFeatureDomains } from '../hooks/useAppFeatureDomains'
import type { useAppShellState } from '../hooks/useAppShellState'
import type { useDatabaseDomainState } from '../hooks/useDatabaseDomainState'
import type { useDocumentsDomainState } from '../hooks/useDocumentsDomainState'
import type { useWorkspaceOperations } from '../hooks/useWorkspaceOperations'
import type { UiText } from '../i18n'
import { DatabasePage } from '../pages/DatabasePage'
import { DocumentsPage } from '../pages/DocumentsPage'
import { AISection } from '../sections/AISection'
import { DashboardSettingsSection } from '../sections/DashboardSettingsSection'
import { PluginsSection } from '../sections/PluginsSection'
import { WorkspaceDashboardSection } from '../sections/WorkspaceDashboardSection'
import { WorkspaceGraphSection } from '../sections/WorkspaceGraphSection'

type PageId = ReturnType<typeof useAppShellState>['activePage']
type DatabaseDomain = ReturnType<typeof useDatabaseDomainState>
type DocumentsDomain = ReturnType<typeof useDocumentsDomainState>
type WorkspaceOperations = ReturnType<typeof useWorkspaceOperations>
type AppFeatureDomains = ReturnType<typeof useAppFeatureDomains>

type AppPageContentProps = {
  activePage: PageId
  backupMessage: string | null
  catalogColumns: DocumentDatabaseColumn[]
  catalogDocuments: DocumentCatalogEntry[]
  database: DatabaseDomain
  documents: DocumentsDomain
  features: AppFeatureDomains
  homeData: HomeData
  isZh: boolean
  onCatalogColumnsChange: Dispatch<SetStateAction<DocumentDatabaseColumn[]>>
  onCatalogDocumentsChange: Dispatch<SetStateAction<DocumentCatalogEntry[]>>
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
  onMessageChange: (message: string | null) => void
  ui: UiText
  workspace: WorkspaceOperations
}

export function AppPageContent({
  activePage,
  backupMessage,
  catalogColumns,
  catalogDocuments,
  database,
  documents,
  features,
  homeData,
  isZh,
  onCatalogColumnsChange,
  onCatalogDocumentsChange,
  onHomeDataChange,
  onMessageChange,
  ui,
  workspace
}: AppPageContentProps) {
  return (
    <main className={`content page-${activePage}`}>
      {activePage === 'dashboard' ? (
        <WorkspaceDashboardSection
          isAiEnabled={homeData.aiConfig.enabled}
          onBackupNow={workspace.handleBackup}
          onOpenDocument={documents.openDocumentInDocumentsPage}
          onRestoreBackup={workspace.handleRestoreBackup}
          pluginDashboardCards={features.plugins.pluginDashboardCards}
          recentEvents={homeData.recentEvents}
          summary={homeData.summary}
          ui={ui}
        />
      ) : null}

      {backupMessage ? (
        <p className="flash-message">
          {backupMessage}
          <button className="flash-close" onClick={() => onMessageChange(null)} type="button">✕</button>
        </p>
      ) : null}

      {activePage === 'graph' ? (
        <WorkspaceGraphSection
          edges={homeData.graph.edges}
          nodes={homeData.graph.nodes}
          onSelectDocument={documents.openDocumentInDocumentsPage}
          selectedDocumentId={documents.selectedDocumentId}
          ui={ui}
        />
      ) : null}

      {activePage === 'database' ? (
        <DatabasePage
          catalogColumns={catalogColumns}
          catalogDocuments={catalogDocuments}
          database={database}
          documentCatalog={homeData.documentCatalog}
          onCatalogColumnsChange={onCatalogColumnsChange}
          onCatalogDocumentsChange={onCatalogDocumentsChange}
          onHomeDataChange={onHomeDataChange}
          onMessage={onMessageChange}
          onOpenDocument={documents.openDocumentInDocumentsPage}
          selectedDocumentId={documents.selectedDocumentId}
          ui={ui}
          workspaceBoard={{
            beginDrag: workspace.beginDrag,
            dragOverBoardColumnId: workspace.dragOverBoardColumnId,
            draggingDocumentId: workspace.draggingDocumentId,
            dropOnBoardTarget: workspace.dropOnBoardTarget,
            endDrag: workspace.endDrag,
            handleBoardColumnDragOver: workspace.handleBoardColumnDragOver
          }}
        />
      ) : null}

      {activePage === 'documents' ? (
        <DocumentsPage
          ai={features.ai}
          aiConfig={homeData.aiConfig}
          documentTree={homeData.documentTree}
          documents={documents}
          isZh={isZh}
          onCreateDocument={workspace.handleCreateDocument}
          onDeleteSelectedDocument={workspace.deleteSelectedDocument}
          onMoveSelectedDocument={workspace.moveSelectedDocument}
          plugins={features.plugins}
          ui={ui}
        />
      ) : null}

      {activePage === 'ai' ? <AISection {...features.ai.sectionProps} /> : null}

      {activePage === 'plugins' ? <PluginsSection {...features.plugins.sectionProps} /> : null}

      {activePage === 'dashboard' || activePage === 'settings' ? (
        <DashboardSettingsSection {...features.settingsSectionProps} />
      ) : null}
    </main>
  )
}