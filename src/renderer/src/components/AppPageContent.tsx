import { lazy, Suspense } from 'react'
import type { AppFeatureDomainsState, WorkspaceOperationsState } from '../types/appComposition'
import type { DatabaseDomainState, DocumentsDomainState } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { PluginSlot } from './PluginSlot'

const DocumentsPage = lazy(async () => {
  const module = await import('../pages/DocumentsPage')
  return { default: module.DocumentsPage }
})
const MarkdownImportReportDialog = lazy(() => import('./MarkdownImportReportDialog'))

const DatabasePage = lazy(async () => {
  const module = await import('../pages/DatabasePage')
  return { default: module.DatabasePage }
})

const AISection = lazy(async () => {
  const module = await import('../sections/AISection')
  return { default: module.AISection }
})

const DashboardSettingsSection = lazy(async () => {
  const module = await import('../sections/DashboardSettingsSection')
  return { default: module.DashboardSettingsSection }
})

const PluginsSection = lazy(async () => {
  const module = await import('../sections/PluginsSection')
  return { default: module.PluginsSection }
})

const WorkspaceDashboardSection = lazy(async () => {
  const module = await import('../sections/WorkspaceDashboardSection')
  return { default: module.WorkspaceDashboardSection }
})

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
  const pluginUiContributions = shell.homeData.pluginUiContributions ?? []
  const documentContext = documents.selectedDocumentId
    ? { documentId: documents.selectedDocumentId }
    : undefined
  const databaseContext = database.databaseEntityDatabaseId
    ? { databaseId: database.databaseEntityDatabaseId }
    : undefined
  return (
    <main className={`content page-${shell.activePage}${shell.activePage === 'documents' ? '' : ' management-page'}`}>
      {workspace.importReport && <div><button type="button" className="secondary-button" onClick={() => workspace.setImportReportOpen(true)}>
        {shell.isZh ? '查看最近导入报告' : 'View latest import report'}
      </button></div>}
      {workspace.importReport && workspace.isImportReportOpen && <Suspense fallback={null}>
        <MarkdownImportReportDialog report={workspace.importReport} isZh={shell.isZh}
          onClose={() => workspace.setImportReportOpen(false)} onLocate={(documentId, blockId) => {
            if (blockId) documents.openDocumentBlockInDocumentsPage(documentId, blockId)
            else documents.openDocumentInDocumentsPage(documentId)
          }} />
      </Suspense>}

      <Suspense fallback={<p className="muted">{shell.ui.common.loading}</p>}>
        {shell.activePage === 'dashboard' ? (
          <>
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
          <PluginSlot contributions={pluginUiContributions} slot="workspace.dashboard" />
          </>
        ) : null}

        {shell.activePage === 'database' ? (
          <>
          <PluginSlot context={databaseContext} contributions={pluginUiContributions} slot="database.view.tabs" />
          <DatabasePage
            catalogColumns={shell.catalogColumns}
            catalogDocuments={shell.catalogDocuments}
            catalogLoading={shell.catalogLoading}
            database={database}
            documentCatalog={shell.catalogDocuments}
            onCatalogColumnsChange={shell.setCatalogColumns}
            onCatalogDocumentsChange={shell.setCatalogDocuments}
            onHomeDataChange={shell.setHomeData}
            onMessage={shell.notify}
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
          <PluginSlot context={databaseContext} contributions={pluginUiContributions} slot="database.record.actions" />
          </>
        ) : null}

        {shell.activePage === 'documents' ? (
          <>
          <PluginSlot context={documentContext} contributions={pluginUiContributions} slot="documents.header.actions" />
          <PluginSlot context={documentContext} contributions={pluginUiContributions} slot="documents.editor.toolbar" />
          <DocumentsPage
            ai={features.ai}
            aiConfig={shell.homeData.aiConfig}
            pluginMenuContent={<PluginSlot context={documentContext} contributions={pluginUiContributions} slot="documents.header.menu" />}
            documentTree={shell.homeData.documentTree}
            documents={documents}
            isZh={shell.isZh}
            onClipWebPage={workspace.handleClipWebPage}
            onCreateDocument={workspace.handleCreateDocument}
            onDeleteSelectedDocument={workspace.deleteSelectedDocument}
            onMoveSelectedDocument={workspace.moveSelectedDocument}
            plugins={features.plugins}
            ui={shell.ui}
          />
          <PluginSlot context={documentContext} contributions={pluginUiContributions} slot="documents.block.context-menu" />
          <PluginSlot context={documentContext} contributions={pluginUiContributions} slot="documents.aux-panel" />
          </>
        ) : null}

        {shell.activePage === 'ai' ? <><PluginSlot contributions={pluginUiContributions} slot="assistant.tools" /><AISection {...features.ai.sectionProps} /><PluginSlot contributions={pluginUiContributions} slot="assistant.message.cards" /></> : null}

        {shell.activePage === 'plugins' ? <PluginsSection {...features.plugins.sectionProps} /> : null}

        {shell.activePage === 'dashboard' || shell.activePage === 'settings' ? (
          <><DashboardSettingsSection {...features.settingsSectionProps} />{shell.activePage === 'settings' ? <PluginSlot contributions={pluginUiContributions} slot="settings.sections" /> : null}</>
        ) : null}
      </Suspense>
    </main>
  )
}
