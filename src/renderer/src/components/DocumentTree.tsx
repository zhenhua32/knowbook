import { useState, useEffect } from 'react'
import type { DocumentTreeNode } from '@shared/contracts'
import { getActiveUiText } from '../i18n'

type DocumentTreeProps = {
  nodes: DocumentTreeNode[]
  selectedDocumentId: string | null
  onSelect: (documentId: string) => void
  onOpenContextMenu: (node: DocumentTreeNode, x: number, y: number) => void
  draggingDocumentId: string | null
  dragOverDocumentId: string | null
  onDragStart: (documentId: string) => void
  onDragEnd: () => void
  onDragOverNode: (documentId: string) => void
  onDropOnNode: (documentId: string) => Promise<void>
}

export function DocumentTree({
  nodes,
  selectedDocumentId,
  onSelect,
  onOpenContextMenu,
  draggingDocumentId,
  dragOverDocumentId,
  onDragStart,
  onDragEnd,
  onDragOverNode,
  onDropOnNode
}: DocumentTreeProps) {
  const ui = getActiveUiText()

  return (
    <ul className="tree-list">
      {nodes.map((node) => (
        <li className="tree-node" key={node.id}>
          <button
            className={`tree-button${selectedDocumentId === node.id ? ' tree-button-active' : ''}${dragOverDocumentId === node.id ? ' tree-button-drag-over' : ''}`}
            onClick={() => onSelect(node.id)}
            type="button"
            draggable
            onContextMenu={(event) => {
              event.preventDefault()
              onOpenContextMenu(node, event.clientX, event.clientY)
            }}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', node.id)
              onDragStart(node.id)
            }}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
              event.preventDefault()
              if (draggingDocumentId !== node.id) {
                onDragOverNode(node.id)
              }
            }}
            onDrop={async (event) => {
              event.preventDefault()
              await onDropOnNode(node.id)
            }}
          >
            <span className="tree-button-main">
              <DocumentIcon />
              <span className="tree-document-title">{node.title}</span>
            </span>
            <small>{new Date(node.updatedAt).toLocaleDateString(ui.locale)}</small>
          </button>
          <p className="tree-path" title={node.path}>{node.path}</p>
          {node.children.length > 0 ? (
            <div className="tree-children">
              <DocumentTree
                nodes={node.children}
                selectedDocumentId={selectedDocumentId}
                onSelect={onSelect}
                onOpenContextMenu={onOpenContextMenu}
                draggingDocumentId={draggingDocumentId}
                dragOverDocumentId={dragOverDocumentId}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOverNode={onDragOverNode}
                onDropOnNode={onDropOnNode}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function DocumentIcon() {
  return (
    <svg aria-hidden="true" className="tree-document-icon" viewBox="0 0 20 20">
      <path d="M5 2.75h6.5L15 6.25v11H5z" />
      <path d="M11.5 2.75v3.5H15M7.5 10h5M7.5 13h5" />
    </svg>
  )
}
