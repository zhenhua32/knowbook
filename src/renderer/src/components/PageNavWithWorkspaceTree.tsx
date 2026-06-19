import { useState } from 'react'
import type { DocumentTreeNode } from '@shared/contracts'
import { PageRail } from './PageRail'
import { DocumentTree } from './DocumentTree'
import { DocumentTreeContextMenu } from './DocumentTreeContextMenu'
import type { UiLanguage } from '../i18n'
import { getUiText } from '../i18n'

type PageNavWithWorkspaceTreeProps = {
  activePage: string
  pageItems: Array<{
    id: string
    label: string
    description: string
  }>
  onSelectPage: (pageId: string) => void
  pageTitle: string
  pageDescription: string
  brandEyebrow: string
  navLabel: string
  currentPageLabel: string
  currentPageHint: string
  backTitle: string
  forwardTitle: string
  rootsCountLabel: string
  onOpenGlobalSearch: () => void
  globalSearchTitle: string
  onCreateRoot: () => void
  newRootLabel: string
  dropToRootLabel: string
  dragOverRoot: boolean
  onRootDragOver: () => void
  onRootDragLeave: () => void
  onDropToRoot: () => void
  pinnedSectionLabel: string
  pinnedDocuments: Array<{
    id: string
    title: string
    path: string
  }>
  pinnedDocumentIds: Set<string>
  activeDocumentReadyId: string | null
  selectedDocumentId: string | null
  detailLoading: boolean
  isSaving: boolean
  onSelectDocument: (documentId: string) => void
  onTogglePinDocument: (documentId: string) => void
  onCopyDocumentMarkdown: (documentId: string) => void
  onExportDocumentMarkdown: (documentId: string) => void
  onCreateChildDocument: (parentId: string) => void
  onDeleteDocument: (documentId: string, title: string) => void
  onSaveDocument: () => void
  documentTreeNodes: DocumentTreeNode[]
  navCanGoBack: boolean
  navCanGoForward: boolean
  onNavBack: () => void
  onNavForward: () => void
  onDragStart: (documentId: string) => void
  onDragEnd: () => void
  onDragOverNode: (documentId: string) => void
  onDropOnNode: (documentId: string) => Promise<void>
  uiLanguage: UiLanguage
  isNavCollapsed?: boolean
  onToggleNavCollapse?: () => void
  totalDocumentsCount?: number
}

export function PageNavWithWorkspaceTree(props: PageNavWithWorkspaceTreeProps) {
  const {
    activePage,
    pageItems,
    onSelectPage,
    pageTitle,
    pageDescription,
    brandEyebrow,
    navLabel,
    currentPageLabel,
    currentPageHint,
    backTitle,
    forwardTitle,
    rootsCountLabel,
    onOpenGlobalSearch,
    globalSearchTitle,
    onCreateRoot,
    newRootLabel,
    dropToRootLabel,
    dragOverRoot,
    onRootDragOver,
    onRootDragLeave,
    onDropToRoot,
    pinnedSectionLabel,
    pinnedDocuments,
    pinnedDocumentIds,
    activeDocumentReadyId,
    selectedDocumentId,
    detailLoading,
    isSaving,
    onSelectDocument,
    onTogglePinDocument,
    onCopyDocumentMarkdown,
    onExportDocumentMarkdown,
    onCreateChildDocument,
    onDeleteDocument,
    onSaveDocument,
    onDragStart,
    onDragEnd,
    onDragOverNode,
    onDropOnNode,
    documentTreeNodes,
    navCanGoBack,
    navCanGoForward,
    onNavBack,
    onNavForward,
    uiLanguage,
    isNavCollapsed = false,
    onToggleNavCollapse,
    totalDocumentsCount
  } = props

  const [treeContextMenu, setTreeContextMenu] = useState<{ node: DocumentTreeNode; x: number; y: number } | null>(null)
  const ui = getUiText(uiLanguage)
  const isZh = uiLanguage === 'zh-CN'
  const collapseSidebarLabel = isZh ? '收起左侧栏' : 'Collapse sidebar'
  const expandSidebarLabel = isZh ? '展开左侧栏' : 'Expand sidebar'

  const handleTreeContextMenu = (node: DocumentTreeNode, x: number, y: number) => {
    onSelectDocument(node.id)
    setTreeContextMenu({ node, x, y })
  }

  const canSaveContextDocument = Boolean(
    treeContextMenu
    && selectedDocumentId === treeContextMenu.node.id
    && activeDocumentReadyId === treeContextMenu.node.id
    && !detailLoading
  )

  return (
    <div className={`sidebar-combined ${isNavCollapsed ? 'collapsed' : ''}`}>
      {/* Compact Horizontal Navigation Rail */}
      <PageRail
        activePage={activePage}
        brandEyebrow={brandEyebrow}
        collapseTitle={collapseSidebarLabel}
        currentPageLabel={currentPageLabel}
        currentPageHint={currentPageHint}
        expandTitle={expandSidebarLabel}
        isCollapsed={isNavCollapsed}
        navLabel={navLabel}
        onToggleCollapse={onToggleNavCollapse}
        pageDescription={pageDescription}
        pageItems={pageItems}
        pageTitle={pageTitle}
        onSelectPage={onSelectPage}
      />

      {/* Workspace Tree Section */}
      <div className="workspace-nav-content">
        <div className="tree-nav-section">
          <div className="tree-toolbar-compact">
            <button className="icon-btn nav-btn" disabled={!navCanGoBack} onClick={onNavBack} title={backTitle} type="button">←</button>
            <button className="icon-btn nav-btn" disabled={!navCanGoForward} onClick={onNavForward} title={forwardTitle} type="button">→</button>
            <button className="icon-btn" onClick={onOpenGlobalSearch} title={globalSearchTitle} type="button">🔍</button>
            <button className="icon-btn" onClick={onCreateRoot} title={newRootLabel} type="button">+</button>
          </div>

          <div
            className={`root-drop-zone-compact${dragOverRoot ? ' root-drop-zone-active' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              onRootDragOver()
            }}
            onDragLeave={onRootDragLeave}
            onDrop={(event) => {
              event.preventDefault()
              onDropToRoot()
            }}
          >
            {dropToRootLabel}
          </div>

          {pinnedDocuments.length > 0 && (
            <div className="pinned-section-compact">
              {pinnedDocuments.map((document) => (
                <button
                  key={document.id}
                  className={`pinned-doc-item-compact${selectedDocumentId === document.id ? ' pinned-doc-item-active' : ''}`}
                  onClick={() => onSelectDocument(document.id)}
                  type="button"
                  title={document.title}
                >
                  <span className="pinned-doc-title-compact">{document.title}</span>
                </button>
              ))}
            </div>
          )}

          <div className="tree-wrapper">
            {documentTreeNodes && documentTreeNodes.length > 0 ? (
              <DocumentTree
                nodes={documentTreeNodes}
                selectedDocumentId={selectedDocumentId}
                onSelect={onSelectDocument}
                onOpenContextMenu={handleTreeContextMenu}
                draggingDocumentId={null}
                dragOverDocumentId={null}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOverNode={onDragOverNode}
                onDropOnNode={onDropOnNode}
              />
            ) : (
              <div style={{ padding: '20px', textAlign: 'center', color: '#6b5b4a', fontSize: '13px' }}>
                {isZh ? '还没有文档' : 'No documents yet'}
              </div>
            )}
          </div>
        </div>
      </div>

      {treeContextMenu ? (
        <DocumentTreeContextMenu
          x={treeContextMenu.x}
          y={treeContextMenu.y}
          ui={ui}
          isZh={isZh}
          documentTitle={treeContextMenu.node.title}
          isPinned={pinnedDocumentIds.has(treeContextMenu.node.id)}
          canSave={canSaveContextDocument}
          isSaving={isSaving && canSaveContextDocument}
          onTogglePin={() => onTogglePinDocument(treeContextMenu.node.id)}
          onCopyMarkdown={() => {
            void onCopyDocumentMarkdown(treeContextMenu.node.id)
          }}
          onSaveMarkdown={() => {
            void onExportDocumentMarkdown(treeContextMenu.node.id)
          }}
          onAddChild={() => {
            void onCreateChildDocument(treeContextMenu.node.id)
          }}
          onSave={() => {
            void onSaveDocument()
          }}
          onDelete={() => {
            void onDeleteDocument(treeContextMenu.node.id, treeContextMenu.node.title)
          }}
          onClose={() => setTreeContextMenu(null)}
        />
      ) : null}
    </div>
  )
}
