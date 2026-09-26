import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '../utils/lazyWithRetry'
import { RecoveryState } from './RecoveryState'
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
  if (!shell.workspaceReady) return <main className="content">
    {shell.workspaceError ? <RecoveryState title={shell.isZh ? '无法打开工作区' : 'Unable to open the workspace'}
      description={shell.isZh ? '工作区数据读取失败。请重试；若问题持续，可以查看诊断信息或以安全模式启动。' : 'Workspace data could not be loaded. Retry, check diagnostics, or restart in safe mode.'}
      error={shell.workspaceError} onRetry={shell.retryWorkspace} busy={shell.loading} allowRestart />
      : <p role="status">{shell.ui.common.loading}</p>}
  </main>
  return (
    <main className={`content page-${shell.activePage}${shell.activePage === 'documents' ? '' : ' management-page'}`}>
      {shell.workspaceError && <RecoveryState compact title={shell.isZh ? '工作区刷新失败' : 'Workspace refresh failed'}
        description={shell.isZh ? '仍显示上次成功读取的内容。可以重试刷新，当前编辑草稿会保留。' : 'Showing the last loaded data. Retry the refresh; editor drafts are preserved.'}
        error={shell.workspaceError} onRetry={shell.retryWorkspace} busy={shell.loading} />}
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
            catalogReady={shell.catalogReady}
            catalogError={shell.catalogError}
            onRetryCatalog={shell.retryCatalog}
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
