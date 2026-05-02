import type { ReactNode } from 'react'

type PinnedDocument = {
  id: string
  title: string
  path: string
}

type DocumentsSidebarProps = {
  panelLabel: string
  title: string
  navCanGoBack: boolean
  navCanGoForward: boolean
  onNavBack: () => void
  onNavForward: () => void
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
  pinnedDocuments: PinnedDocument[]
  selectedDocumentId: string | null
  onSelectDocument: (documentId: string) => void
  tree: ReactNode
}

export function DocumentsSidebar(props: DocumentsSidebarProps) {
  const {
    panelLabel,
    title,
    navCanGoBack,
    navCanGoForward,
    onNavBack,
    onNavForward,
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
    tree
  } = props

  return (
    <article className="panel tree-panel">
      <div className="panel-head compact-head">
        <div>
          <p className="panel-label">{panelLabel}</p>
          <h3>{title}</h3>
        </div>
        <div className="toolbar-inline">
          <button className="secondary-button nav-btn" disabled={!navCanGoBack} onClick={onNavBack} title={backTitle} type="button">←</button>
          <button className="secondary-button nav-btn" disabled={!navCanGoForward} onClick={onNavForward} title={forwardTitle} type="button">→</button>
          <span className="pill">{rootsCountLabel}</span>
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

      {pinnedDocuments.length > 0 ? (
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
      ) : null}

      {tree}
    </article>
  )
}
