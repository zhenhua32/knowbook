import { useState } from 'react'
import type { DocumentTreeNode } from '@shared/contracts'
import { PageRail } from './PageRail'
import { WorkspaceGraph } from './WorkspaceGraph'
import { DocumentTree } from './DocumentTree'
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
  selectedDocumentId: string | null
  onSelectDocument: (documentId: string) => void
  documentTreeNodes: DocumentTreeNode[]
  workspaceGraphNodes: any[]
  workspaceGraphEdges: any[]
  navCanGoBack: boolean
  navCanGoForward: boolean
  onNavBack: () => void
  onNavForward: () => void
  onSelectGraphNode: (documentId: string) => void
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
    selectedDocumentId,
    onSelectDocument,
    onDragStart,
    onDragEnd,
    onDragOverNode,
    onDropOnNode,
    documentTreeNodes,
    workspaceGraphNodes,
    workspaceGraphEdges,
    navCanGoBack,
    navCanGoForward,
    onNavBack,
    onNavForward,
    onSelectGraphNode,
    uiLanguage,
    isNavCollapsed = false,
    onToggleNavCollapse,
    totalDocumentsCount
  } = props

  const [showWorkspaceGraph, setShowWorkspaceGraph] = useState(false)
  const ui = getUiText(uiLanguage)
  const isZh = uiLanguage === 'zh-CN'

  const handleGraphToggle = () => {
    setShowWorkspaceGraph(!showWorkspaceGraph)
  }

  return (
    <div className={`sidebar-combined ${isNavCollapsed ? 'collapsed' : ''}`}>
      {/* Compact Horizontal Navigation Rail */}
      <PageRail
        activePage={activePage}
        brandEyebrow={brandEyebrow}
        currentPageLabel={currentPageLabel}
        currentPageHint={currentPageHint}
        navLabel={navLabel}
        pageDescription={pageDescription}
        pageItems={pageItems}
        pageTitle={pageTitle}
        onSelectPage={onSelectPage}
      />

      {/* Workspace Tree and Graph Section */}
      <div className="workspace-nav-content">
        {/* Quick Access Buttons */}
        <div className="workspace-quick-actions">
          <button
            className={`quick-action-btn ${showWorkspaceGraph ? '' : 'active'}`}
            onClick={() => setShowWorkspaceGraph(false)}
            title={ui.workspaceTreeLabel}
            type="button"
          >
            📂
            <span>{ui.treeView}</span>
          </button>
          <button
            className={`quick-action-btn ${showWorkspaceGraph ? 'active' : ''}`}
            onClick={handleGraphToggle}
            title={ui.knowledgeGraphLabel}
            type="button"
          >
            🕸️
            <span>{ui.graphView}</span>
          </button>
        </div>

        {/* Workspace Graph (Compact View) */}
        {showWorkspaceGraph && workspaceGraphNodes.length > 0 && (
          <div className="workspace-graph-section">
            <div className="panel-head compact-head">
              <div>
                <p className="panel-label">{ui.knowledgeGraphLabel}</p>
                <h4>{ui.workspaceTopology}</h4>
              </div>
              <div className="toolbar-inline">
                <span className="pill">{workspaceGraphNodes.length} {ui.nodes}</span>
                <span className="pill">{workspaceGraphEdges.length} {ui.edges}</span>
              </div>
            </div>
            <WorkspaceGraph
              nodes={workspaceGraphNodes}
              edges={workspaceGraphEdges}
              selectedDocumentId={selectedDocumentId}
              onSelect={onSelectGraphNode}
              isCompact={true}
            />
          </div>
        )}

        {/* Tree Navigation */}
        {!showWorkspaceGraph && (
          <div className="tree-nav-section">
              <div className="panel-head compact-head">
                <div>
                  <p className="panel-label">{ui.workspaceTreeLabel}</p>
                  <h4>{ui.seededDocumentsTitle}</h4>
                </div>
                <div className="toolbar-inline">
                  <button className="secondary-button nav-btn" disabled={!navCanGoBack} onClick={onNavBack} title={backTitle} type="button">←</button>
                  <button className="secondary-button nav-btn" disabled={!navCanGoForward} onClick={onNavForward} title={forwardTitle} type="button">→</button>
                  <span className="pill">{rootsCountLabel}</span>
                  {totalDocumentsCount !== undefined && (
                    <span className="pill" title={isZh ? '所有文档总数' : 'Total documents'}>
                      {isZh ? '全部' : 'All'}: {totalDocumentsCount}
                    </span>
                  )}
                  <button className="secondary-button" onClick={onOpenGlobalSearch} title={globalSearchTitle} type="button">🔍</button>
                  <button className="secondary-button" onClick={onCreateRoot} type="button">{newRootLabel}</button>
                </div>
              </div>

            <div
              className={`root-drop-zone${dragOverRoot ? ' root-drop-zone-active' : ''}`}
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
              <div className="pinned-section">
                <p className="pinned-section-label">{pinnedSectionLabel}</p>
                {pinnedDocuments.map((document) => (
                  <button
                    key={document.id}
                    className={`pinned-doc-item${selectedDocumentId === document.id ? ' pinned-doc-item-active' : ''}`}
                    onClick={() => onSelectDocument(document.id)}
                    type="button"
                  >
                    <span className="pinned-doc-title">{document.title}</span>
                    <span className="pinned-doc-path">{document.path}</span>
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
        )}
      </div>
    </div>
  )
}
