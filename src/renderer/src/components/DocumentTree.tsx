import { memo, useEffect, useMemo, useRef, useState } from 'react'
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

interface FlattenedTreeNode {
  node: DocumentTreeNode
  depth: number
  parentId: string | null
}

const TREE_ROW_HEIGHT = 36
const TREE_ROW_OVERSCAN = 8
const MAX_TREE_INDENT_DEPTH = 12

function flattenDocumentTree(nodes: DocumentTreeNode[]): FlattenedTreeNode[] {
  const flattened: FlattenedTreeNode[] = []
  const stack: FlattenedTreeNode[] = [...nodes].reverse().map((node) => ({ node, depth: 0, parentId: null }))

  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) continue
    flattened.push(entry)
    for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: entry.node.children[index], depth: entry.depth + 1, parentId: entry.node.id })
    }
  }

  return flattened
}

export const DocumentTree = memo(function DocumentTree({
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const revealedPathRef = useRef<string[]>([])
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(TREE_ROW_HEIGHT * 12)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const allNodes = useMemo(() => flattenDocumentTree(nodes), [nodes])
  const nodesById = useMemo(() => new Map(allNodes.map((entry) => [entry.node.id, entry])), [allNodes])
  const selectedPath = useMemo(() => {
    const path: string[] = []
    let id = selectedDocumentId
    while (id) {
      path.push(id)
      id = nodesById.get(id)?.parentId ?? null
    }
    return path
  }, [nodesById, selectedDocumentId])
  const flattenedNodes = useMemo(() => {
    let collapsedDepth: number | null = null
    return allNodes.filter(({ node, depth }) => {
      if (collapsedDepth !== null && depth > collapsedDepth) return false
      collapsedDepth = collapsedIds.has(node.id) ? depth : null
      return true
    })
  }, [allNodes, collapsedIds])
  const selectedIndex = useMemo(
    () => selectedDocumentId ? flattenedNodes.findIndex(({ node }) => node.id === selectedDocumentId) : -1,
    [flattenedNodes, selectedDocumentId]
  )

  useEffect(() => {
    // Reveal navigation targets, but preserve manual collapse when saving refreshes the tree.
    const previousPath = revealedPathRef.current
    if (previousPath.length === selectedPath.length && previousPath.every((id, index) => id === selectedPath[index])) return
    revealedPathRef.current = selectedPath
    setCollapsedIds((previous) => {
      const next = new Set(previous)
      for (const id of selectedPath.slice(1)) next.delete(id)
      return next.size === previous.size ? previous : next
    })
  }, [selectedPath])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return

    const updateViewportHeight = () => {
      setViewportHeight(node.clientHeight || TREE_ROW_HEIGHT * 12)
    }
    updateViewportHeight()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewportHeight)
      return () => window.removeEventListener('resize', updateViewportHeight)
    }

    const observer = new ResizeObserver(updateViewportHeight)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const scrollNode = scrollRef.current
    if (!scrollNode || selectedIndex < 0) return
    const rowTop = selectedIndex * TREE_ROW_HEIGHT
    const rowBottom = rowTop + TREE_ROW_HEIGHT
    if (rowTop < scrollNode.scrollTop) {
      scrollNode.scrollTop = rowTop
    } else if (rowBottom > scrollNode.scrollTop + scrollNode.clientHeight) {
      scrollNode.scrollTop = rowBottom - scrollNode.clientHeight
    }
  }, [selectedIndex])

  const totalHeight = flattenedNodes.length * TREE_ROW_HEIGHT
  // A collapsed subtree can shrink the list before the browser reports its clamped scroll position.
  const effectiveScrollTop = Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight))
  const startIndex = Math.max(0, Math.floor(effectiveScrollTop / TREE_ROW_HEIGHT) - TREE_ROW_OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / TREE_ROW_HEIGHT) + (TREE_ROW_OVERSCAN * 2)
  const endIndex = Math.min(flattenedNodes.length, startIndex + visibleCount)
  const visibleNodes = flattenedNodes.slice(startIndex, endIndex)

  return (
    <div
      className="tree-virtual-scroll"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={scrollRef}
    >
      <ul className="tree-list tree-list-virtual" role="tree" style={{ height: totalHeight }}>
        {visibleNodes.map(({ node, depth }, offset) => {
          const rowIndex = startIndex + offset
          const indentDepth = Math.min(depth, MAX_TREE_INDENT_DEPTH)
          const hasChildren = node.children.length > 0
          const isExpanded = !collapsedIds.has(node.id)
          const toggleLabel = isExpanded ? ui.collapseDocumentChildren(node.title) : ui.expandDocumentChildren(node.title)
          return (
            <li
              aria-expanded={hasChildren ? isExpanded : undefined}
              aria-level={depth + 1}
              aria-selected={selectedDocumentId === node.id}
              className="tree-node tree-node-virtual"
              key={node.id}
              role="treeitem"
              style={{
                paddingLeft: indentDepth * 12,
                transform: `translateY(${rowIndex * TREE_ROW_HEIGHT}px)`
              }}
            >
              {hasChildren ? (
                <button
                  aria-expanded={isExpanded}
                  aria-label={toggleLabel}
                  className="tree-expand-toggle"
                  onClick={() => setCollapsedIds((previous) => {
                    const next = new Set(previous)
                    if (next.has(node.id)) next.delete(node.id)
                    else next.add(node.id)
                    return next
                  })}
                  title={toggleLabel}
                  type="button"
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20">
                    <path d={isExpanded ? 'm5 7.5 5 5 5-5' : 'm7.5 5 5 5-5 5'} />
                  </svg>
                </button>
              ) : <span aria-hidden="true" className="tree-expand-placeholder" />}
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
                  setCollapsedIds((previous) => {
                    if (!previous.has(node.id)) return previous
                    const next = new Set(previous)
                    next.delete(node.id)
                    return next
                  })
                }}
              >
                <span className="tree-button-main">
                  <DocumentIcon />
                  <span className="tree-document-title">{node.title}</span>
                </span>
                <small>{new Date(node.updatedAt).toLocaleDateString(ui.locale)}</small>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
})

function DocumentIcon() {
  return (
    <svg aria-hidden="true" className="tree-document-icon" viewBox="0 0 20 20">
      <path d="M5 2.75h6.5L15 6.25v11H5z" />
      <path d="M11.5 2.75v3.5H15M7.5 10h5M7.5 13h5" />
    </svg>
  )
}
