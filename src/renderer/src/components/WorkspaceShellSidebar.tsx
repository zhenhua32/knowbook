import type { HomeData } from '@shared/contracts'
import type { PageId } from '../hooks/useAppShellState'
import type { useDocumentsDomainState } from '../hooks/useDocumentsDomainState'
import type { useWorkspaceOperations } from '../hooks/useWorkspaceOperations'
import type { UiLanguage, UiText } from '../i18n'
import { PageNavWithWorkspaceTree } from './PageNavWithWorkspaceTree'

type DocumentsSidebarState = Pick<ReturnType<typeof useDocumentsDomainState>,
  'navCanGoBack'
  | 'navCanGoForward'
  | 'navBack'
  | 'navForward'
  | 'openDocumentInDocumentsPage'
  | 'openGlobalSearch'
  | 'pinnedDocumentIds'
  | 'selectedDocumentId'
>

type WorkspaceSidebarActions = Pick<ReturnType<typeof useWorkspaceOperations>,
  'beginDrag'
  | 'dragOverRoot'
  | 'dropOnDocument'
  | 'dropToRoot'
  | 'endDrag'
  | 'handleCreateDocument'
  | 'handleRootDragLeave'
  | 'handleRootDragOver'
  | 'handleTreeNodeDragOver'
>

type WorkspaceShellSidebarProps = {
  activePage: PageId
  documents: DocumentsSidebarState
  homeData: HomeData
  isZh: boolean
  onSelectPage: (pageId: PageId) => void
  pageDescription: string
  pageItems: Array<{
    id: PageId
    label: string
    description: string
  }>
  pageTitle: string
  ui: UiText
  uiLanguage: UiLanguage
  workspace: WorkspaceSidebarActions
}

export function WorkspaceShellSidebar({
  activePage,
  documents,
  homeData,
  isZh,
  onSelectPage,
  pageDescription,
  pageItems,
  pageTitle,
  ui,
  uiLanguage,
  workspace
}: WorkspaceShellSidebarProps) {
  const pinnedDocuments = homeData.documentCatalog.filter((document) => documents.pinnedDocumentIds.has(document.id))

  return (
    <PageNavWithWorkspaceTree
      activePage={activePage}
      pageItems={pageItems}
      onSelectPage={(pageId) => onSelectPage(pageId as PageId)}
      pageTitle={pageTitle}
      pageDescription={pageDescription}
      brandEyebrow={ui.brandEyebrow}
      navLabel={isZh ? '页面导航' : 'Navigation'}
      currentPageLabel={isZh ? '当前页面' : 'Current page'}
      currentPageHint={isZh ? '默认启动页为文档页，配置与特色功能已拆分到独立页面。' : 'Documents is now the default entry page, and feature modules are separated into dedicated pages.'}
      backTitle={`${ui.back} (Alt+←)`}
      forwardTitle={`${ui.forward} (Alt+→)`}
      rootsCountLabel={ui.rootsCount(homeData.documentTree.length)}
      onOpenGlobalSearch={documents.openGlobalSearch}
      globalSearchTitle={`${ui.globalSearch} (Ctrl+K)`}
      onCreateRoot={() => {
        void workspace.handleCreateDocument(null)
      }}
      newRootLabel={ui.newRoot}
      dropToRootLabel={ui.dropToRoot}
      dragOverRoot={workspace.dragOverRoot}
      onRootDragOver={workspace.handleRootDragOver}
      onRootDragLeave={workspace.handleRootDragLeave}
      onDropToRoot={() => {
        void workspace.dropToRoot()
      }}
      pinnedSectionLabel={ui.pinnedSectionLabel}
      pinnedDocuments={pinnedDocuments}
      selectedDocumentId={documents.selectedDocumentId}
      onSelectDocument={documents.openDocumentInDocumentsPage}
      documentTreeNodes={homeData.documentTree}
      workspaceGraphNodes={homeData.graph.nodes}
      workspaceGraphEdges={homeData.graph.edges}
      navCanGoBack={documents.navCanGoBack}
      navCanGoForward={documents.navCanGoForward}
      onNavBack={documents.navBack}
      onNavForward={documents.navForward}
      onSelectGraphNode={documents.openDocumentInDocumentsPage}
      onDragStart={workspace.beginDrag}
      onDragEnd={workspace.endDrag}
      onDragOverNode={workspace.handleTreeNodeDragOver}
      onDropOnNode={workspace.dropOnDocument}
      uiLanguage={uiLanguage}
      totalDocumentsCount={homeData.summary.documents}
    />
  )
}