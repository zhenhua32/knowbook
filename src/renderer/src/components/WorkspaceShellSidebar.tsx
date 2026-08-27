import type { PageId } from '../hooks/useAppShellState'
import type { DocumentsSidebarState, WorkspaceSidebarActions } from '../types/appDomains'
import type { AppShellState } from '../types/appShell'
import { PageNavWithWorkspaceTree } from './PageNavWithWorkspaceTree'
import { PluginSlot } from './PluginSlot'

type WorkspaceShellSidebarProps = {
  documents: DocumentsSidebarState
  shell: AppShellState
  workspace: WorkspaceSidebarActions
}

export function WorkspaceShellSidebar({
  documents,
  shell,
  workspace
}: WorkspaceShellSidebarProps) {
  const pinnedDocuments = shell.homeData.documentCatalog.filter((document) => documents.pinnedDocumentIds.has(document.id))

  return (
    <>
    <PageNavWithWorkspaceTree
      activePage={shell.activePage}
      pageItems={shell.pageItems}
      onSelectPage={(pageId) => shell.setActivePage(pageId as PageId)}
      pageTitle={shell.pageTitle}
      pageDescription={shell.pageDescription}
      brandEyebrow={shell.ui.brandEyebrow}
      navLabel={shell.isZh ? '页面导航' : 'Navigation'}
      currentPageLabel={shell.isZh ? '当前页面' : 'Current page'}
      currentPageHint={shell.isZh ? '默认启动页为文档页，配置与特色功能已拆分到独立页面。' : 'Documents is now the default entry page, and feature modules are separated into dedicated pages.'}
      backTitle={`${shell.ui.back} (Alt+←)`}
      forwardTitle={`${shell.ui.forward} (Alt+→)`}
      rootsCountLabel={shell.ui.rootsCount(shell.homeData.documentTree.length)}
      onOpenGlobalSearch={documents.openGlobalSearch}
      globalSearchTitle={`${shell.ui.globalSearch} (Ctrl+K)`}
      onCreateRoot={() => {
        void workspace.handleCreateDocument(null)
      }}
      newRootLabel={shell.ui.newRoot}
      dropToRootLabel={shell.ui.dropToRoot}
      dragOverRoot={workspace.dragOverRoot}
      onRootDragOver={workspace.handleRootDragOver}
      onRootDragLeave={workspace.handleRootDragLeave}
      onDropToRoot={() => {
        void workspace.dropToRoot()
      }}
      pinnedSectionLabel={shell.ui.pinnedSectionLabel}
      pinnedDocuments={pinnedDocuments}
      pinnedDocumentIds={documents.pinnedDocumentIds}
      activeDocumentReadyId={documents.selectedDocument?.id ?? null}
      selectedDocumentId={documents.selectedDocumentId}
      detailLoading={documents.detailLoading}
      isSaving={documents.isSaving}
      onSelectDocument={documents.openDocumentInDocumentsPage}
      onTogglePinDocument={documents.togglePinDocument}
      onCopyDocumentMarkdown={(documentId) => {
        void workspace.copyDocumentMarkdown(documentId)
      }}
      onExportDocumentMarkdown={(documentId) => {
        void workspace.exportDocumentMarkdown(documentId)
      }}
      onCreateChildDocument={(parentId) => {
        void workspace.handleCreateDocument(parentId)
      }}
      onDeleteDocument={(documentId, title) => {
        void workspace.deleteDocumentById(documentId, title)
      }}
      onSaveDocument={() => {
        void documents.saveDocument()
      }}
      documentTreeNodes={shell.homeData.documentTree}
      navCanGoBack={documents.navCanGoBack}
      navCanGoForward={documents.navCanGoForward}
      onNavBack={documents.navBack}
      onNavForward={documents.navForward}
      onDragStart={workspace.beginDrag}
      onDragEnd={workspace.endDrag}
      onDragOverNode={workspace.handleTreeNodeDragOver}
      onDropOnNode={workspace.dropOnDocument}
      uiLanguage={shell.uiLanguage}
      isNavCollapsed={shell.isNavCollapsed}
      onToggleNavCollapse={shell.toggleNavCollapse}
      totalDocumentsCount={shell.homeData.summary.documents}
    />
    <PluginSlot contributions={shell.homeData.pluginUiContributions} slot="navigation.primary" />
    </>
  )
}
