import type { Dispatch, SetStateAction } from 'react'
import type { AppFeatureDomainsState, WorkspaceOperationsState } from '../types/appComposition'
import type { DatabaseDomainState, DocumentsDomainState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { DatabasePage } from '../pages/DatabasePage'
import { DocumentsPage } from '../pages/DocumentsPage'
import { AISection } from '../sections/AISection'
import { DashboardSettingsSection } from '../sections/DashboardSettingsSection'
import { PluginsSection } from '../sections/PluginsSection'
import { WorkspaceDashboardSection } from '../sections/WorkspaceDashboardSection'
import { WorkspaceGraphSection } from '../sections/WorkspaceGraphSection'

type AppPageContentProps = {
  database: DatabaseDomainState
  documents: DocumentsDomainState
  features: AppFeatureDomainsState
  shell: AppShellState
  workspace: WorkspaceOperationsState
}

export function AppPageContent({
  database,
  documents,
  features,
  shell,
  workspace
}: AppPageContentProps) {
  return (
    <main className={`content page-${shell.activePage}`}>
      {shell.activePage === 'dashboard' ? (
        <WorkspaceDashboardSection
          isAiEnabled={shell.homeData.aiConfig.enabled}
          onBackupNow={workspace.handleBackup}
          onOpenDocument={documents.openDocumentInDocumentsPage}
          onRestoreBackup={workspace.handleRestoreBackup}
          pluginDashboardCards={features.plugins.pluginDashboardCards}
          recentEvents={shell.homeData.recentEvents}
          summary={shell.homeData.summary}
          ui={shell.ui}
        />
      ) : null}

      {shell.backupMessage ? (
        <p className="flash-message">
          {shell.backupMessage}
          <button className="flash-close" onClick={() => shell.setBackupMessage(null)} type="button">✕</button>
        </p>
      ) : null}

      {shell.activePage === 'graph' ? (
        <WorkspaceGraphSection
          edges={shell.homeData.graph.edges}
          nodes={shell.homeData.graph.nodes}
          onSelectDocument={documents.openDocumentInDocumentsPage}
          selectedDocumentId={documents.selectedDocumentId}
          ui={shell.ui}
        />
      ) : null}

      {shell.activePage === 'database' ? (
        <DatabasePage
          catalogColumns={shell.catalogColumns}
          catalogDocuments={shell.catalogDocuments}
          database={database}
          documentCatalog={shell.homeData.documentCatalog}
          onCatalogColumnsChange={shell.setCatalogColumns}
          onCatalogDocumentsChange={shell.setCatalogDocuments}
          onHomeDataChange={shell.setHomeData}
          onMessage={shell.setBackupMessage}
          onOpenDocument={documents.openDocumentInDocumentsPage}
          selectedDocumentId={documents.selectedDocumentId}
          ui={shell.ui}
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

      {shell.activePage === 'documents' ? (
        <DocumentsPage
          ai={features.ai}
          aiConfig={shell.homeData.aiConfig}
          documentTree={shell.homeData.documentTree}
          documents={documents}
          isZh={shell.isZh}
          onCreateDocument={workspace.handleCreateDocument}
          onDeleteSelectedDocument={workspace.deleteSelectedDocument}
          onMoveSelectedDocument={workspace.moveSelectedDocument}
          plugins={features.plugins}
          ui={shell.ui}
        />
      ) : null}

      {shell.activePage === 'ai' ? <AISection {...features.ai.sectionProps} /> : null}

      {shell.activePage === 'plugins' ? <PluginsSection {...features.plugins.sectionProps} /> : null}

      {shell.activePage === 'dashboard' || shell.activePage === 'settings' ? (
        <DashboardSettingsSection {...features.settingsSectionProps} />
      ) : null}
    </main>
  )
}