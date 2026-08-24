import { useState } from 'react'
import type { DatabaseSavedView, DatabaseSavedViewLayoutMode } from '@shared/contracts'
import type { DatabaseWorkspaceText } from '../databaseText'

export function DatabaseViewTabs({
  activeViewId,
  dirty,
  savedViews,
  text,
  onCreateView,
  onDeleteView,
  onMoveView,
  onRenameView,
  onSelectView
}: {
  activeViewId: string
  dirty: boolean
  savedViews: DatabaseSavedView[]
  text: DatabaseWorkspaceText
  onCreateView: (layout: DatabaseSavedViewLayoutMode) => void
  onDeleteView: (view: DatabaseSavedView) => void
  onMoveView: (viewId: string, targetViewId: string) => void
  onRenameView: (view: DatabaseSavedView) => void
  onSelectView: (viewId: string) => void
}) {
  const [draggingViewId, setDraggingViewId] = useState<string | null>(null)
  return (
    <nav aria-label={text.newView} className="dbw-view-tabs">
      <div className="dbw-view-tab-list">
        {savedViews.length === 0 ? (
          <button aria-current="page" className="dbw-view-tab is-active" type="button">
            <LayoutIcon layout="table" />
            {text.all}
            {dirty ? <span aria-label="unsaved" className="dbw-unsaved-dot" /> : null}
          </button>
        ) : savedViews.map((view) => (
          <div
            className={`dbw-view-tab-wrap${activeViewId === view.id ? ' is-active' : ''}${draggingViewId === view.id ? ' is-dragging' : ''}`}
            draggable
            key={view.id}
            onDragEnd={() => setDraggingViewId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDragStart={() => setDraggingViewId(view.id)}
            onDrop={(event) => {
              event.preventDefault()
              if (draggingViewId && draggingViewId !== view.id) onMoveView(draggingViewId, view.id)
              setDraggingViewId(null)
            }}
          >
            <button
              aria-current={activeViewId === view.id ? 'page' : undefined}
              className="dbw-view-tab"
              onClick={() => onSelectView(view.id)}
              onDoubleClick={() => onRenameView(view)}
              type="button"
            >
              <LayoutIcon layout={view.config.layout} />
              <span>{view.name}</span>
              {activeViewId === view.id && dirty ? <span aria-label="unsaved" className="dbw-unsaved-dot" /> : null}
            </button>
            <button
              aria-label={`${text.viewMenu}: ${view.name}`}
              className="dbw-view-tab-menu"
              onClick={() => onDeleteView(view)}
              title={text.deleteView}
              type="button"
            >×</button>
          </div>
        ))}
      </div>

      <details className="dbw-new-view-menu">
        <summary><span aria-hidden="true">＋</span>{text.newView}</summary>
        <div className="dbw-popover dbw-layout-menu">
          <button onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onCreateView('table') }} type="button"><LayoutIcon layout="table" />{text.table}</button>
          <button onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onCreateView('board') }} type="button"><LayoutIcon layout="board" />{text.board}</button>
          <button onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onCreateView('cards') }} type="button"><LayoutIcon layout="cards" />{text.cards}</button>
        </div>
      </details>
    </nav>
  )
}

export function LayoutIcon({ layout }: { layout: DatabaseSavedViewLayoutMode }) {
  return <span aria-hidden="true" className={`dbw-layout-icon dbw-layout-icon-${layout}`} />
}
