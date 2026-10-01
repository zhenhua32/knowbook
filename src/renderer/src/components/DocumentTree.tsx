import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DocumentTreeNode } from '@shared/contracts'
import { getActiveUiText } from '../i18n'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'

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
  onDragLeaveNode?: (documentId: string) => void
  onDropOnNode: (documentId: string) => Promise<void>
}

interface FlattenedTreeNode {
  node: DocumentTreeNode
  depth: number
  parentId: string | null
  position: number
  siblingCount: number
}

const TREE_ROW_HEIGHT = 36
const TREE_ROW_OVERSCAN = 8
const MAX_TREE_INDENT_DEPTH = 12

function flattenDocumentTree(nodes: DocumentTreeNode[]): FlattenedTreeNode[] {
  const flattened: FlattenedTreeNode[] = []
  const stack: FlattenedTreeNode[] = nodes.map((node, index) => ({ node, depth: 0, parentId: null, position: index + 1, siblingCount: nodes.length })).reverse()

  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) continue
    flattened.push(entry)
    for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: entry.node.children[index], depth: entry.depth + 1, parentId: entry.node.id, position: index + 1, siblingCount: entry.node.children.length })
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
  onDragLeaveNode,
  onDropOnNode
}: DocumentTreeProps) {
  const ui = getActiveUiText()
  const scrollRef = useRef<HTMLDivElement>(null)
  const revealedPathRef = useRef<string[]>([])
  const rowsRef = useRef(new Map<string, HTMLLIElement>())
  const pendingFocusRef = useRef<string | null>(null)
  const pendingRevealRef = useRef<string | null>(null)
  const previousFocusPathRef = useRef<string[]>([]), previousFocusIndexRef = useRef(0)
  const previousSelectionRef = useRef<string | null | undefined>(undefined)
  const hadTreeFocusRef = useRef(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(TREE_ROW_HEIGHT * 12)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [focusedId, setFocusedId] = useState<string | null>(selectedDocumentId ?? nodes[0]?.id ?? null)
  const [focusRevision, setFocusRevision] = useState(0)
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
  const visibleIndexById = useMemo(() => new Map(flattenedNodes.map(({ node }, index) => [node.id, index])), [flattenedNodes])
  let rovingId = focusedId
  while (rovingId && !visibleIndexById.has(rovingId)) rovingId = nodesById.get(rovingId)?.parentId ?? null
  rovingId ??= previousFocusPathRef.current.find((id) => visibleIndexById.has(id))
    ?? flattenedNodes[Math.min(previousFocusIndexRef.current, flattenedNodes.length - 1)]?.node.id ?? null
  const rovingIndex = rovingId ? visibleIndexById.get(rovingId)! : -1

  useLayoutEffect(() => {
    // Reveal navigation targets, but preserve manual collapse when saving refreshes the tree.
    const previousPath = revealedPathRef.current
    if (previousPath.length === selectedPath.length && previousPath.every((id, index) => id === selectedPath[index])) return
    revealedPathRef.current = selectedPath
    if (!scrollRef.current?.contains(document.activeElement)) pendingRevealRef.current = selectedDocumentId
    setCollapsedIds((previous) => {
      const next = new Set(previous)
      for (const id of selectedPath.slice(1)) next.delete(id)
      return next.size === previous.size ? previous : next
    })
  }, [selectedPath])

  const revealRow = (index: number) => {
    const scrollNode = scrollRef.current
    if (!scrollNode || index < 0) return
    // clientHeight rounds fractional CSS pixels; use the visible height so the last row stays fully in view.
    const height = Math.min(scrollNode.clientHeight || viewportHeight, scrollNode.getBoundingClientRect().height || viewportHeight)
    let next = Math.min(scrollNode.scrollTop, Math.max(0, flattenedNodes.length * TREE_ROW_HEIGHT - height))
    const rowTop = index * TREE_ROW_HEIGHT, rowBottom = rowTop + TREE_ROW_HEIGHT
    if (rowTop < next) next = rowTop
    else if (rowBottom > next + height) next = rowBottom - height
    scrollNode.scrollTop = Math.ceil(next)
    // A programmatic scroll must render its target before attempting DOM focus.
    setScrollTop(scrollNode.scrollTop)
  }

  const focusRow = (id: string) => {
    pendingFocusRef.current = id
    setFocusedId(id)
    setFocusRevision((value) => value + 1)
    revealRow(visibleIndexById.get(id) ?? -1)
  }

  const toggleNode = (id: string) => setCollapsedIds((previous) => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  useLayoutEffect(() => {
    const scrollNode = scrollRef.current
    if (!scrollNode) return
    const inside = scrollNode.contains(document.activeElement)
    const lostRow = hadTreeFocusRef.current && document.activeElement === document.body
    const selectionChanged = previousSelectionRef.current !== selectedDocumentId
    previousSelectionRef.current = selectedDocumentId
    if (selectionChanged) {
      // A newly opened or created document is revealed even while the tree retains focus.
      pendingRevealRef.current = selectedDocumentId
      if (!inside && !lostRow) setFocusedId(selectedDocumentId ?? flattenedNodes[0]?.node.id ?? null)
    }
    if (focusedId !== rovingId && !(selectionChanged && !inside && !lostRow)) {
      setFocusedId(rovingId)
      if (inside || lostRow) pendingFocusRef.current = rovingId
    }
    const requested = pendingFocusRef.current
    if (requested) {
      const target = visibleIndexById.has(requested) ? requested : rovingId
      if (target) {
        revealRow(visibleIndexById.get(target) ?? -1)
        rowsRef.current.get(target)?.focus({ preventScroll: true })
      }
      pendingFocusRef.current = null
    } else if (inside && rovingIndex >= 0 && rovingIndex !== previousFocusIndexRef.current) {
      // Refreshing row objects or wheel scrolling must not snap back to the retained row.
      revealRow(rovingIndex)
    }
    if (pendingRevealRef.current && visibleIndexById.has(pendingRevealRef.current)) {
      revealRow(visibleIndexById.get(pendingRevealRef.current)!)
      pendingRevealRef.current = null
    }
    previousFocusIndexRef.current = Math.max(0, rovingIndex)
    const path: string[] = []
    let id: string | null = rovingId
    while (id) { path.push(id); id = nodesById.get(id)?.parentId ?? null }
    previousFocusPathRef.current = path
  }, [focusedId, rovingId, flattenedNodes, selectedDocumentId, viewportHeight, focusRevision])

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

  // Chromium rounds maximum scrollTop; a pixel at the end keeps the final row visible at fractional zoom.
  const totalHeight = flattenedNodes.length * TREE_ROW_HEIGHT + (flattenedNodes.length ? 1 : 0)
  // A collapsed subtree can shrink the list before the browser reports its clamped scroll position.
  const effectiveScrollTop = Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight))
  const startIndex = Math.max(0, Math.floor(effectiveScrollTop / TREE_ROW_HEIGHT) - TREE_ROW_OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / TREE_ROW_HEIGHT) + (TREE_ROW_OVERSCAN * 2)
  const endIndex = Math.min(flattenedNodes.length, startIndex + visibleCount)
  const renderedIndices = Array.from({ length: endIndex - startIndex }, (_, index) => startIndex + index)
  // Retain at most one extra row: wheel scrolling cannot unmount the Tab entry or menu trigger.
  if (rovingIndex >= 0 && (rovingIndex < startIndex || rovingIndex >= endIndex)) renderedIndices.push(rovingIndex)
  renderedIndices.sort((a, b) => a - b)

  const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>, entry: FlattenedTreeNode, index: number) => {
    if (isImeKeyboardEvent(event.nativeEvent) || event.altKey || event.ctrlKey || event.metaKey) return
    const { node, parentId } = entry
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault(); event.stopPropagation()
      focusRow(node.id)
      const rect = event.currentTarget.getBoundingClientRect()
      onOpenContextMenu(node, rect.left + Math.min(24 + Math.min(entry.depth, MAX_TREE_INDENT_DEPTH) * 12, rect.width), rect.bottom)
      return
    }
    if (event.shiftKey) return
    if (event.key === 'Enter' || event.key === ' ') {
      // Nested native buttons keep their own activation, including expand-button Enter/Space.
      if (event.target !== event.currentTarget) return
      event.preventDefault(); event.stopPropagation(); onSelect(node.id)
      return
    }
    let target: string | undefined
    if (event.key === 'ArrowDown') target = flattenedNodes[Math.min(index + 1, flattenedNodes.length - 1)]?.node.id
    else if (event.key === 'ArrowUp') target = flattenedNodes[Math.max(0, index - 1)]?.node.id
    else if (event.key === 'Home') target = flattenedNodes[0]?.node.id
    else if (event.key === 'End') target = flattenedNodes.at(-1)?.node.id
    else if (event.key === 'ArrowRight') {
      if (node.children.length && collapsedIds.has(node.id)) toggleNode(node.id)
      else if (node.children.length) target = node.children[0].id
    } else if (event.key === 'ArrowLeft') {
      if (node.children.length && !collapsedIds.has(node.id)) toggleNode(node.id)
      else target = parentId ?? undefined
    } else return
    event.preventDefault(); event.stopPropagation()
    focusRow(target ?? node.id)
  }

  return (
    <div
      className="tree-virtual-scroll"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={scrollRef}
    >
      <ul className="tree-list tree-list-virtual" role="tree" aria-label={ui.locale.startsWith('zh') ? '文档树' : 'Document tree'} style={{ height: totalHeight }}>
        {renderedIndices.map((rowIndex) => {
          const entry = flattenedNodes[rowIndex]
          const { node, depth, position, siblingCount } = entry
          const indentDepth = Math.min(depth, MAX_TREE_INDENT_DEPTH)
          const hasChildren = node.children.length > 0
          const isExpanded = !collapsedIds.has(node.id)
          const toggleLabel = isExpanded ? ui.collapseDocumentChildren(node.title) : ui.expandDocumentChildren(node.title)
          return (
            <li
              aria-expanded={hasChildren ? isExpanded : undefined}
              aria-level={depth + 1}
              aria-label={node.title}
              aria-posinset={position}
              aria-setsize={siblingCount}
              aria-selected={selectedDocumentId === node.id}
              className="tree-node tree-node-virtual"
              key={node.id}
              role="treeitem"
              tabIndex={rovingId === node.id ? 0 : -1}
              ref={(row) => { if (row) rowsRef.current.set(node.id, row); else rowsRef.current.delete(node.id) }}
              onFocusCapture={() => { hadTreeFocusRef.current = true; setFocusedId(node.id) }}
              onBlurCapture={(event) => {
                if (event.relatedTarget && !scrollRef.current?.contains(event.relatedTarget as Node)) hadTreeFocusRef.current = false
              }}
              onKeyDown={(event) => handleKeyDown(event, entry, rowIndex)}
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
                  onClick={() => { focusRow(node.id); toggleNode(node.id) }}
                  title={toggleLabel}
                  type="button"
                  tabIndex={-1}
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20">
                    <path d={isExpanded ? 'm5 7.5 5 5 5-5' : 'm7.5 5 5 5-5 5'} />
                  </svg>
                </button>
              ) : <span aria-hidden="true" className="tree-expand-placeholder" />}
              <button
                className={`tree-button${selectedDocumentId === node.id ? ' tree-button-active' : ''}${dragOverDocumentId === node.id ? ' tree-button-drag-over' : ''}${draggingDocumentId === node.id ? ' tree-button-dragging' : ''}`}
                onClick={() => { focusRow(node.id); onSelect(node.id) }}
                type="button"
                tabIndex={-1}
                draggable
                onContextMenu={(event) => {
                  event.preventDefault()
                  focusRow(node.id)
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
                  onDragOverNode(node.id)
                }}
                onDragLeave={(event) => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                    onDragLeaveNode?.(node.id)
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
