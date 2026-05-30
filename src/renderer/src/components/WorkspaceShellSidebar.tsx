import type { HomeData } from '@shared/contracts'
import type { PageId } from '../hooks/useAppShellState'
import type { UiLanguage, UiText } from '../i18n'
import { PageNavWithWorkspaceTree } from './PageNavWithWorkspaceTree'

type WorkspaceShellSidebarProps = {
  activePage: PageId
  dragOverRoot: boolean
  homeData: HomeData
  isZh: boolean
  navCanGoBack: boolean
  navCanGoForward: boolean
  onCreateRoot: () => Promise<unknown> | void
  onDragEnd: () => void
  onDragOverNode: (documentId: string) => void
  onDragStart: (documentId: string) => void
  onDropOnDocument: (documentId: string) => Promise<void>
  onDropToRoot: () => Promise<unknown> | void
  onNavBack: () => void
  onNavForward: () => void
  onOpenGlobalSearch: () => void
  onRootDragLeave: () => void
  onRootDragOver: () => void
  onSelectDocument: (documentId: string) => void
  onSelectPage: (pageId: PageId) => void
  pageDescription: string
  pageItems: Array<{
    id: PageId
    label: string
    description: string
  }>
  pageTitle: string
  pinnedDocumentIds: Set<string>
  selectedDocumentId: string | null
  ui: UiText
  uiLanguage: UiLanguage
}

export function WorkspaceShellSidebar({
  activePage,
  dragOverRoot,
  homeData,
  isZh,
  navCanGoBack,
  navCanGoForward,
  onCreateRoot,
  onDragEnd,
  onDragOverNode,
  onDragStart,
  onDropOnDocument,
  onDropToRoot,
  onNavBack,
  onNavForward,
  onOpenGlobalSearch,
  onRootDragLeave,
  onRootDragOver,
  onSelectDocument,
  onSelectPage,
  pageDescription,
  pageItems,
  pageTitle,
  pinnedDocumentIds,
  selectedDocumentId,
  ui,
  uiLanguage
}: WorkspaceShellSidebarProps) {
  const pinnedDocuments = homeData.documentCatalog.filter((document) => pinnedDocumentIds.has(document.id))

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
      onOpenGlobalSearch={onOpenGlobalSearch}
      globalSearchTitle={`${ui.globalSearch} (Ctrl+K)`}
      onCreateRoot={onCreateRoot}
      newRootLabel={ui.newRoot}
      dropToRootLabel={ui.dropToRoot}
      dragOverRoot={dragOverRoot}
      onRootDragOver={onRootDragOver}
      onRootDragLeave={onRootDragLeave}
      onDropToRoot={onDropToRoot}
      pinnedSectionLabel={ui.pinnedSectionLabel}
      pinnedDocuments={pinnedDocuments}
      selectedDocumentId={selectedDocumentId}
      onSelectDocument={onSelectDocument}
      documentTreeNodes={homeData.documentTree}
      workspaceGraphNodes={homeData.graph.nodes}
      workspaceGraphEdges={homeData.graph.edges}
      navCanGoBack={navCanGoBack}
      navCanGoForward={navCanGoForward}
      onNavBack={onNavBack}
      onNavForward={onNavForward}
      onSelectGraphNode={onSelectDocument}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOverNode={onDragOverNode}
      onDropOnNode={onDropOnDocument}
      uiLanguage={uiLanguage}
      totalDocumentsCount={homeData.summary.documents}
    />
  )
}