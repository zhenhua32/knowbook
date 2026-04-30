import { renderToString } from 'katex'
import { useEffect, useRef, useState } from 'react'
import type {
  BackupResult,
  DocumentBlock,
  DocumentBlockDraft,
  DocumentCatalogEntry,
  DocumentDetail,
  DocumentSuggestion,
  DocumentTreeNode,
  HomeData,
  LinkedDocument,
  WorkspaceGraphEdge,
  WorkspaceGraphNode
} from '@shared/contracts'

const emptyState: HomeData = {
  summary: {
    databasePath: '',
    backupRoot: '',
    documents: 0,
    blocks: 0,
    links: 0,
    lastBackupAt: null
  },
  recentDocuments: [],
  documentCatalog: [],
  aiConfig: {
    enabled: false,
    baseUrl: '',
    model: '',
    hasApiKey: false
  },
  documentTree: [],
  graph: {
    nodes: [],
    edges: []
  },
  initialDocumentId: null
}

const BLOCK_INDENT_SIZE = 24
const BLOCK_DRAG_DEPTH_THRESHOLD = 72

type BlockDropPreview = {
  positionLabel: string
  effectiveDepth: number
  parentText: string | null
}

type BlockSelectionRange = {
  start: number
  end: number
}

type BlockSlashCommand = {
  id: string
  label: string
  description: string
  keywords: string[]
} &
  (
    | {
        kind: 'type'
        type: DocumentBlock['type']
      }
    | {
        kind: 'action'
      action: 'insert-above' | 'insert-below' | 'insert-child' | 'move-up' | 'move-down' | 'indent' | 'outdent' | 'duplicate' | 'delete'
      }
  )

const blockSlashCommands: BlockSlashCommand[] = [
  {
    id: 'text',
    label: 'Text',
    description: 'Convert the current block into a plain paragraph.',
    keywords: ['paragraph', 'plain', 'p'],
    kind: 'type',
    type: 'paragraph'
  },
  {
    id: 'h1',
    label: 'Heading 1',
    description: 'Promote this block to a top-level heading.',
    keywords: ['title', 'heading-1', 'header'],
    kind: 'type',
    type: 'heading-1'
  },
  {
    id: 'h2',
    label: 'Heading 2',
    description: 'Convert this block to a section heading.',
    keywords: ['subtitle', 'heading-2', 'section'],
    kind: 'type',
    type: 'heading-2'
  },
  {
    id: 'todo',
    label: 'Todo',
    description: 'Turn this block into an unchecked todo item.',
    keywords: ['task', 'checkbox', 'checklist'],
    kind: 'type',
    type: 'todo'
  },
  {
    id: 'code',
    label: 'Code',
    description: 'Switch this block into a code block.',
    keywords: ['snippet', 'pre', 'terminal'],
    kind: 'type',
    type: 'code'
  },
  {
    id: 'math',
    label: 'Math Formula',
    description: 'Render this block as a KaTeX display equation.',
    keywords: ['latex', 'equation', 'formula', 'katex'],
    kind: 'type',
    type: 'math'
  },
  {
    id: 'quote',
    label: 'Quote',
    description: 'Convert this block into a quoted callout.',
    keywords: ['blockquote', 'callout', 'cite'],
    kind: 'type',
    type: 'quote'
  },
  {
    id: 'bullet',
    label: 'Bulleted List',
    description: 'Turn this block into a bulleted list item.',
    keywords: ['unordered', 'list', 'dash'],
    kind: 'type',
    type: 'bulleted-list'
  },
  {
    id: 'numbered',
    label: 'Numbered List',
    description: 'Turn this block into an ordered list item.',
    keywords: ['ordered', 'list', 'number'],
    kind: 'type',
    type: 'numbered-list'
  },
  {
    id: 'divider',
    label: 'Divider',
    description: 'Insert a horizontal divider block.',
    keywords: ['separator', 'rule', 'hr'],
    kind: 'type',
    type: 'divider'
  },
  {
    id: 'above',
    label: 'Insert Above',
    description: 'Insert a new sibling block above the current block.',
    keywords: ['insert', 'before', 'up'],
    kind: 'action',
    action: 'insert-above'
  },
  {
    id: 'below',
    label: 'Insert Below',
    description: 'Insert a new sibling block below the current block.',
    keywords: ['insert', 'after', 'down'],
    kind: 'action',
    action: 'insert-below'
  },
  {
    id: 'child',
    label: 'Insert Child',
    description: 'Insert a nested child block below the current subtree.',
    keywords: ['child', 'sub-block', 'nested', 'descendant'],
    kind: 'action',
    action: 'insert-child'
  },
  {
    id: 'up',
    label: 'Move Up',
    description: 'Move the current block subtree above the previous sibling subtree.',
    keywords: ['reorder', 'before', 'raise'],
    kind: 'action',
    action: 'move-up'
  },
  {
    id: 'down',
    label: 'Move Down',
    description: 'Move the current block subtree below the next sibling subtree.',
    keywords: ['reorder', 'after', 'lower'],
    kind: 'action',
    action: 'move-down'
  },
  {
    id: 'indent',
    label: 'Indent Block',
    description: 'Increase nesting for todo and list blocks.',
    keywords: ['nest', 'tab', 'right', 'depth'],
    kind: 'action',
    action: 'indent'
  },
  {
    id: 'outdent',
    label: 'Outdent Block',
    description: 'Decrease nesting for todo and list blocks.',
    keywords: ['shift-tab', 'left', 'unnest', 'depth'],
    kind: 'action',
    action: 'outdent'
  },
  {
    id: 'duplicate',
    label: 'Duplicate Block',
    description: 'Clone the current block subtree below the original.',
    keywords: ['copy', 'clone', 'repeat'],
    kind: 'action',
    action: 'duplicate'
  },
  {
    id: 'delete',
    label: 'Delete Block',
    description: 'Remove the current block subtree from the draft.',
    keywords: ['remove', 'trash', 'clear'],
    kind: 'action',
    action: 'delete'
  }
]

function isNestableBlock(type: string) {
  return ['todo', 'bulleted-list', 'numbered-list'].includes(type)
}

function normalizeBlockDepth(type: string, depth: number) {
  return isNestableBlock(type) ? Math.max(0, Math.min(6, Math.trunc(depth))) : 0
}

function getBlockSubtreeEndIndex(blocks: Array<{ depth: number }>, index: number) {
  const root = blocks[index]
  if (!root) {
    return index
  }

  let endIndex = index
  for (let currentIndex = index + 1; currentIndex < blocks.length; currentIndex += 1) {
    if (blocks[currentIndex].depth <= root.depth) {
      break
    }

    endIndex = currentIndex
  }

  return endIndex
}

function getPreviousSiblingSubtreeStartIndex(blocks: Array<{ depth: number }>, index: number) {
  const root = blocks[index]
  if (!root) {
    return null
  }

  for (let currentIndex = index - 1; currentIndex >= 0; currentIndex -= 1) {
    if (blocks[currentIndex].depth === root.depth) {
      return currentIndex
    }

    if (blocks[currentIndex].depth < root.depth) {
      break
    }
  }

  return null
}

function getNextSiblingSubtreeStartIndex(blocks: Array<{ depth: number }>, index: number) {
  const root = blocks[index]
  if (!root) {
    return null
  }

  const subtreeEndIndex = getBlockSubtreeEndIndex(blocks, index)
  for (let currentIndex = subtreeEndIndex + 1; currentIndex < blocks.length; currentIndex += 1) {
    if (blocks[currentIndex].depth === root.depth) {
      return currentIndex
    }

    if (blocks[currentIndex].depth < root.depth) {
      break
    }
  }

  return null
}

function createDraftBlockId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizeDraftBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
  const seenIds = new Set<string>()
  const depthStack: Array<string | null> = []

  return blocks.map((block) => {
    const requestedId = block.id?.trim() ? block.id : null
    const id = requestedId && !seenIds.has(requestedId) ? requestedId : createDraftBlockId()
    seenIds.add(id)

    const type = block.type.trim() || 'paragraph'
    const checked = type === 'todo' ? Boolean(block.checked) : false

    let depth = normalizeBlockDepth(type, block.depth ?? 0)
    while (depth > 0 && !depthStack[depth - 1]) {
      depth -= 1
    }

    const parentBlockId = depth > 0 ? depthStack[depth - 1] ?? null : null

    depthStack.length = depth + 1
    depthStack[depth] = id

    return {
      ...block,
      id,
      type,
      checked,
      depth,
      parentBlockId
    }
  })
}

function areDraftBlocksEqual(left: DocumentBlockDraft[], right: DocumentBlockDraft[]) {
  if (left.length !== right.length) {
    return false
  }

  return left.every((block, index) => {
    const nextBlock = right[index]
    return (
      nextBlock !== undefined &&
      block.id === nextBlock.id &&
      block.type === nextBlock.type &&
      block.content === nextBlock.content &&
      block.checked === nextBlock.checked &&
      block.depth === nextBlock.depth &&
      (block.parentBlockId ?? null) === (nextBlock.parentBlockId ?? null)
    )
  })
}

function buildBlockTypePatch(type: string, content: string, checked = false, depth = 0): DocumentBlockDraft {
  return {
    type,
    content: normalizeBlockContentForType(type, content),
    checked: type === 'todo' ? checked : false,
    depth: normalizeBlockDepth(type, depth)
  }
}

function buildSiblingDraftBlock(anchorBlock?: DocumentBlockDraft): DocumentBlockDraft {
  if (anchorBlock && isNestableBlock(anchorBlock.type)) {
    return buildBlockTypePatch(anchorBlock.type, '', false, anchorBlock.depth)
  }

  return buildBlockTypePatch('paragraph', '')
}

function getDefaultChildBlockType(type: string): DocumentBlock['type'] {
  if (type === 'todo') {
    return 'todo'
  }

  if (type === 'numbered-list') {
    return 'numbered-list'
  }

  return 'bulleted-list'
}

function getBlockDropPreview(
  blocks: DocumentBlockDraft[],
  sourceIndex: number,
  targetIndex: number,
  targetDepth: number | null
): BlockDropPreview | null {
  const subtreeEndIndex = getBlockSubtreeEndIndex(blocks, sourceIndex)
  if (targetIndex >= sourceIndex && targetIndex <= subtreeEndIndex) {
    return null
  }

  const movedBlocks = blocks.slice(sourceIndex, subtreeEndIndex + 1)
  const rootBlock = movedBlocks[0]
  if (!rootBlock) {
    return null
  }

  const remainingBlocks = [...blocks]
  remainingBlocks.splice(sourceIndex, movedBlocks.length)

  const insertionIndex = sourceIndex < targetIndex ? Math.max(0, targetIndex - movedBlocks.length + 1) : targetIndex
  const nextRootDepth = targetDepth === null ? rootBlock.depth : normalizeBlockDepth(rootBlock.type, targetDepth)
  const appliedDelta = nextRootDepth - rootBlock.depth
  const normalizedMovedBlocks = movedBlocks.map((block) =>
    isNestableBlock(block.type)
      ? {
          ...block,
          depth: normalizeBlockDepth(block.type, block.depth + appliedDelta)
        }
      : block
  )

  const nextBlocks = [...remainingBlocks]
  nextBlocks.splice(insertionIndex, 0, ...normalizedMovedBlocks)

  const depthStack: Array<{ text: string } | null> = []

  for (const [index, block] of nextBlocks.entries()) {
    let effectiveDepth = normalizeBlockDepth(block.type, block.depth)
    while (effectiveDepth > 0 && !depthStack[effectiveDepth - 1]) {
      effectiveDepth -= 1
    }

    const parent = effectiveDepth > 0 ? depthStack[effectiveDepth - 1] : null
    if (index === insertionIndex) {
      return {
        positionLabel: sourceIndex < targetIndex ? 'Drop after' : 'Drop before',
        effectiveDepth,
        parentText: parent?.text ?? null
      }
    }

    depthStack.length = effectiveDepth + 1
    depthStack[effectiveDepth] = {
      text: getBlockTreeText(block.type, block.content)
    }
  }

  return null
}

function normalizeBlockSelectionRange(start: number, end: number): BlockSelectionRange {
  return {
    start: Math.min(start, end),
    end: Math.max(start, end)
  }
}

function isValidSiblingRange(blocks: DocumentBlockDraft[], range: BlockSelectionRange): boolean {
  if (range.start >= blocks.length || range.end >= blocks.length) {
    return false
  }

  const referenceDepth = blocks[range.start].depth

  for (let i = range.start; i <= range.end; i += 1) {
    if (blocks[i].depth !== referenceDepth) {
      return false
    }
  }

  return true
}

function moveBlockRange(blocks: DocumentBlockDraft[], range: BlockSelectionRange, delta: -1 | 1): DocumentBlockDraft[] {
  const isValidSiblings = isValidSiblingRange(blocks, range)
  
  if (!isValidSiblings) {
    return blocks
  }

  const referenceDepth = blocks[range.start].depth

  if (delta === -1) {
    if (range.start === 0) {
      return blocks
    }

    let prevSiblingIndex: number | null = null
    for (let i = range.start - 1; i >= 0; i -= 1) {
      if (blocks[i].depth === referenceDepth) {
        prevSiblingIndex = i
        break
      }

      if (blocks[i].depth < referenceDepth) {
        return blocks
      }
    }

    if (prevSiblingIndex === null) {
      return blocks
    }

    const movedBlocks = blocks.slice(range.start, range.end + 1)
    const next = [...blocks]
    next.splice(range.start, movedBlocks.length)
    next.splice(prevSiblingIndex, 0, ...movedBlocks)
    return next
  } else {
    if (range.end >= blocks.length - 1) {
      return blocks
    }

    let nextSiblingIndex: number | null = null
    for (let i = range.end + 1; i < blocks.length; i += 1) {
      if (blocks[i].depth === referenceDepth) {
        nextSiblingIndex = i
        break
      }

      if (blocks[i].depth < referenceDepth) {
        return blocks
      }
    }

    if (nextSiblingIndex === null) {
      return blocks
    }

    const movedBlocks = blocks.slice(range.start, range.end + 1)
    const next = [...blocks]
    next.splice(range.start, movedBlocks.length)
    next.splice(nextSiblingIndex - movedBlocks.length + 1, 0, ...movedBlocks)
    return next
  }
}

function moveIndexAfterRangeMove(index: number | null, range: BlockSelectionRange, delta: -1 | 1): number | null {
  if (index === null) {
    return index
  }

  if (index >= range.start && index <= range.end) {
    return index + delta
  }

  if (delta === -1 && index === range.start - 1) {
    return range.end
  }

  if (delta === 1 && index === range.end + 1) {
    return range.start
  }

  return index
}

function remapIndexAfterSubtreeMove(
  index: number | null,
  sourceIndex: number,
  subtreeEndIndex: number,
  insertionIndex: number
): number | null {
  if (index === null) {
    return index
  }

  const subtreeSize = subtreeEndIndex - sourceIndex + 1

  if (index >= sourceIndex && index <= subtreeEndIndex) {
    return insertionIndex + (index - sourceIndex)
  }

  if (sourceIndex < insertionIndex && index > subtreeEndIndex && index <= insertionIndex + subtreeSize - 1) {
    return index - subtreeSize
  }

  if (sourceIndex > insertionIndex && index >= insertionIndex && index < sourceIndex) {
    return index + subtreeSize
  }

  return index
}

function toDraftBlock(block: Pick<DocumentBlock, 'id' | 'type' | 'content' | 'checked' | 'depth' | 'parentBlockId'>): DocumentBlockDraft {
  return {
    id: block.id,
    type: block.type,
    content: block.content,
    checked: Boolean(block.checked),
    depth: normalizeBlockDepth(block.type, block.depth),
    parentBlockId: block.parentBlockId ?? null
  }
}

export function App() {
  const [homeData, setHomeData] = useState<HomeData>(emptyState)
  const [loading, setLoading] = useState(true)
  const [catalogQuery, setCatalogQuery] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetail | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSummary, setDraftSummary] = useState('')
  const [draftBlocks, setDraftBlocks] = useState<DocumentBlockDraft[]>([])
  const [draggingBlockIndex, setDraggingBlockIndex] = useState<number | null>(null)
  const [dragOverBlockIndex, setDragOverBlockIndex] = useState<number | null>(null)
  const [dragOverBlockDepth, setDragOverBlockDepth] = useState<number | null>(null)
  const [pendingFocusBlockIndex, setPendingFocusBlockIndex] = useState<number | null>(null)
  const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
  const [selectionAnchorBlockIndex, setSelectionAnchorBlockIndex] = useState<number | null>(null)
  const [selectedBlockRange, setSelectedBlockRange] = useState<BlockSelectionRange | null>(null)
  const [selectedBlockConversionType, setSelectedBlockConversionType] = useState<DocumentBlock['type']>('paragraph')
  const [activeCursorPosition, setActiveCursorPosition] = useState<number>(0)
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0)
  const [linkSuggestions, setLinkSuggestions] = useState<DocumentSuggestion[]>([])
  const [moveTargetId, setMoveTargetId] = useState('')
  const [draggingDocumentId, setDraggingDocumentId] = useState<string | null>(null)
  const [dragOverDocumentId, setDragOverDocumentId] = useState<string | null>(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)
  const [aiEnabledDraft, setAiEnabledDraft] = useState(false)
  const [aiBaseUrlDraft, setAiBaseUrlDraft] = useState('')
  const [aiModelDraft, setAiModelDraft] = useState('')
  const [aiApiKeyDraft, setAiApiKeyDraft] = useState('')
  const [aiSaving, setAiSaving] = useState(false)
  const [aiPromptDraft, setAiPromptDraft] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiAsking, setAiAsking] = useState(false)
  const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])

  useEffect(() => {
    let mounted = true

    window.knowbook.getHomeData().then((data) => {
      if (mounted) {
        setHomeData(data)
        setLoading(false)
        setSelectedDocumentId((current) => current ?? data.initialDocumentId)
        setAiEnabledDraft(data.aiConfig.enabled)
        setAiBaseUrlDraft(data.aiConfig.baseUrl)
        setAiModelDraft(data.aiConfig.model)
        setAiApiKeyDraft('')
      }
    })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocument(null)
      setPendingFocusBlockIndex(null)
      setSelectionAnchorBlockIndex(null)
      setSelectedBlockRange(null)
      return
    }

    let mounted = true
    setDetailLoading(true)

    window.knowbook.getDocumentDetail(selectedDocumentId).then((detail) => {
      if (mounted) {
        setSelectedDocument(detail)
        setDraggingBlockIndex(null)
        setDragOverBlockIndex(null)
        setDragOverBlockDepth(null)
        setPendingFocusBlockIndex(null)
        setActiveBlockIndex(null)
        setSelectionAnchorBlockIndex(null)
        setSelectedBlockRange(null)
        setActiveCursorPosition(0)
        setLinkSuggestions([])
        setMoveTargetId('')
        setIsEditing(false)
        setDraftTitle(detail?.title ?? '')
        setDraftSummary(detail?.summary ?? '')
        setDraftBlocks(detail?.blocks.map(toDraftBlock) ?? [])
        setDetailLoading(false)
      }
    })

    return () => {
      mounted = false
    }
  }, [selectedDocumentId])

  useEffect(() => {
    const normalizedDraftBlocks = normalizeDraftBlocks(draftBlocks)
    if (!areDraftBlocksEqual(draftBlocks, normalizedDraftBlocks)) {
      setDraftBlocks(normalizedDraftBlocks)
    }
  }, [draftBlocks])

  const activeLinkContext =
    activeBlockIndex !== null
      ? getOpenLinkContext(draftBlocks[activeBlockIndex]?.content ?? '', activeCursorPosition)
      : null
  const activeLinkQuery = activeLinkContext?.query ?? null
  const activeSlashContext =
    activeLinkContext || activeBlockIndex === null
      ? null
      : getSlashCommandContext(draftBlocks[activeBlockIndex]?.content ?? '', activeCursorPosition)
  const filteredSlashCommands = blockSlashCommands.filter((command) => {
    const query = activeSlashContext?.query.trim().toLowerCase() ?? ''
    if (!query) {
      return true
    }

    return [command.id, command.label, ...command.keywords]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })
  const activeSlashCommand = filteredSlashCommands[selectedSlashCommandIndex] ?? filteredSlashCommands[0] ?? null
  const selectedBlockCount = selectedBlockRange ? selectedBlockRange.end - selectedBlockRange.start + 1 : 0
  const selectedBlockActionRange = selectedBlockRange ? getSelectedBlockActionRange(selectedBlockRange) : null
  const selectedBlockActionCount = selectedBlockActionRange ? selectedBlockActionRange.end - selectedBlockActionRange.start + 1 : 0

  useEffect(() => {
    if (!activeSlashContext || filteredSlashCommands.length === 0) {
      setSelectedSlashCommandIndex(0)
      return
    }

    setSelectedSlashCommandIndex((previous) => Math.min(previous, filteredSlashCommands.length - 1))
  }, [activeBlockIndex, activeSlashContext?.query, filteredSlashCommands.length])

  useEffect(() => {
    if (!isEditing || !activeLinkContext) {
      setLinkSuggestions([])
      return
    }

    let mounted = true
    window.knowbook.getDocumentSuggestions(activeLinkContext.query, selectedDocumentId).then((suggestions) => {
      if (mounted) {
        setLinkSuggestions(suggestions)
      }
    })

    return () => {
      mounted = false
    }
  }, [activeLinkQuery, isEditing, selectedDocumentId])

  useEffect(() => {
    if (pendingFocusBlockIndex === null) {
      return
    }

    const textarea = blockTextareaRefs.current[pendingFocusBlockIndex]
    if (!textarea) {
      setPendingFocusBlockIndex(null)
      return
    }

    textarea.focus()
    const cursor = Math.max(0, Math.min(activeCursorPosition, textarea.value.length))
    textarea.setSelectionRange(cursor, cursor)
    captureBlockCursor(pendingFocusBlockIndex, textarea)
    setPendingFocusBlockIndex(null)
  }, [activeCursorPosition, draftBlocks, pendingFocusBlockIndex])

  async function handleBackup() {
    const result: BackupResult = await window.knowbook.triggerBackup()
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)
    const nextDocumentId = selectedDocumentId ?? refreshed.initialDocumentId
    if (!selectedDocumentId && nextDocumentId) {
      setSelectedDocumentId(nextDocumentId)
    }
    if (selectedDocumentId) {
      const detail = await window.knowbook.getDocumentDetail(selectedDocumentId)
      setSelectedDocument(detail)
    }
    setBackupMessage(`Exported ${result.exported} markdown files at ${new Date(result.at).toLocaleString()}.`)
  }

  async function handleCreateDocument(parentId: string | null) {
    const created = await window.knowbook.createDocument(parentId)
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)
    setSelectedDocumentId(created.id)
    const detail = await window.knowbook.getDocumentDetail(created.id)
    setSelectedDocument(detail)
    setIsEditing(true)
    setDraftTitle(detail?.title ?? '')
    setDraftSummary(detail?.summary ?? '')
    setDraftBlocks(detail?.blocks.map(toDraftBlock) ?? [])
    setPendingFocusBlockIndex(null)
    setSelectionAnchorBlockIndex(null)
    setSelectedBlockRange(null)
  }

  function startEdit() {
    if (!selectedDocument) {
      return
    }

    setDraftTitle(selectedDocument.title)
    setDraftSummary(selectedDocument.summary)
    setDraftBlocks(selectedDocument.blocks.map(toDraftBlock))
    setPendingFocusBlockIndex(null)
    setSelectionAnchorBlockIndex(null)
    setSelectedBlockRange(null)
    setIsEditing(true)
  }

  function cancelEdit() {
    if (!selectedDocument) {
      setIsEditing(false)
      return
    }

    setDraftTitle(selectedDocument.title)
    setDraftSummary(selectedDocument.summary)
    setDraftBlocks(selectedDocument.blocks.map(toDraftBlock))
    setPendingFocusBlockIndex(null)
    setSelectionAnchorBlockIndex(null)
    setSelectedBlockRange(null)
    setIsEditing(false)
  }

  async function saveDocument() {
    if (!selectedDocumentId || !selectedDocument) {
      return
    }

    setIsSaving(true)
    await window.knowbook.updateDocument(selectedDocumentId, {
      title: draftTitle,
      summary: draftSummary,
      blocks: draftBlocks
    })

    const [refreshedHome, refreshedDetail] = await Promise.all([
      window.knowbook.getHomeData(),
      window.knowbook.getDocumentDetail(selectedDocumentId)
    ])
    setHomeData(refreshedHome)
    setSelectedDocument(refreshedDetail)
    setIsEditing(false)
    setIsSaving(false)
    setPendingFocusBlockIndex(null)
    setDraggingBlockIndex(null)
    setDragOverBlockIndex(null)
    setDragOverBlockDepth(null)
    setLinkSuggestions([])
    setSelectionAnchorBlockIndex(null)
    setSelectedBlockRange(null)
  }

  async function toggleTodoBlockChecked(index: number, checked: boolean) {
    if (!selectedDocument) {
      return
    }

    setIsSaving(true)

    try {
      const nextBlocks = selectedDocument.blocks.map((block, currentIndex) =>
        currentIndex === index
          ? {
              ...block,
              checked
            }
          : block
      )

      await window.knowbook.updateDocument(selectedDocument.id, {
        title: selectedDocument.title,
        summary: selectedDocument.summary,
        blocks: nextBlocks.map(toDraftBlock)
      })

      const [refreshedHome, refreshedDetail] = await Promise.all([
        window.knowbook.getHomeData(),
        window.knowbook.getDocumentDetail(selectedDocument.id)
      ])
      setHomeData(refreshedHome)
      setSelectedDocument(refreshedDetail)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Todo update failed.'
      setBackupMessage(message)
    } finally {
      setIsSaving(false)
    }
  }

  async function deleteSelectedDocument() {
    if (!selectedDocument) {
      return
    }

    const accepted = window.confirm(`Delete "${selectedDocument.title}"? Child documents will be kept and reparented.`)
    if (!accepted) {
      return
    }

    await window.knowbook.deleteDocument(selectedDocument.id)
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)

    const nextId = refreshed.initialDocumentId
    setSelectedDocumentId(nextId)
    setIsEditing(false)

    if (nextId) {
      const detail = await window.knowbook.getDocumentDetail(nextId)
      setSelectedDocument(detail)
    } else {
      setSelectedDocument(null)
    }
  }

  async function moveSelectedDocument() {
    if (!selectedDocument || !moveTargetId) {
      return
    }

    const newParentId = moveTargetId === '__root__' ? null : moveTargetId
    await handleMoveDocument(selectedDocument.id, newParentId, `Moved "${selectedDocument.title}" successfully.`)
  }

  async function handleMoveDocument(documentId: string, newParentId: string | null, successMessage?: string) {
    try {
      await window.knowbook.moveDocument(documentId, newParentId)
      const refreshedHome = await window.knowbook.getHomeData()
      setHomeData(refreshedHome)

      if (selectedDocumentId) {
        const refreshedDetail = await window.knowbook.getDocumentDetail(selectedDocumentId)
        setSelectedDocument(refreshedDetail)
      }

      setMoveTargetId('')
      if (successMessage) {
        setBackupMessage(successMessage)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Move failed.'
      setBackupMessage(message)
    } finally {
      setDraggingDocumentId(null)
      setDragOverDocumentId(null)
      setDragOverRoot(false)
    }
  }

  function beginDrag(documentId: string) {
    setDraggingDocumentId(documentId)
  }

  function endDrag() {
    setDraggingDocumentId(null)
    setDragOverDocumentId(null)
    setDragOverRoot(false)
  }

  async function dropOnDocument(targetId: string) {
    if (!draggingDocumentId || draggingDocumentId === targetId) {
      endDrag()
      return
    }

    await handleMoveDocument(draggingDocumentId, targetId)
  }

  async function dropToRoot() {
    if (!draggingDocumentId) {
      endDrag()
      return
    }

    await handleMoveDocument(draggingDocumentId, null)
  }

  async function saveAiConfig() {
    setAiSaving(true)
    await window.knowbook.updateAiConfig({
      enabled: aiEnabledDraft,
      baseUrl: aiBaseUrlDraft,
      model: aiModelDraft,
      apiKey: aiApiKeyDraft
    })
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)
    setAiEnabledDraft(refreshed.aiConfig.enabled)
    setAiBaseUrlDraft(refreshed.aiConfig.baseUrl)
    setAiModelDraft(refreshed.aiConfig.model)
    setAiApiKeyDraft('')
    setAiSaving(false)
    setBackupMessage('AI settings saved.')
  }

  async function askAiOnSelectedDocument() {
    if (!selectedDocumentId || !aiPromptDraft.trim()) {
      return
    }

    setAiAsking(true)
    try {
      const result = await window.knowbook.askAiAboutDocument({
        documentId: selectedDocumentId,
        prompt: aiPromptDraft.trim()
      })
      setAiAnswer(result.answer)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI request failed.'
      setAiAnswer(message)
    } finally {
      setAiAsking(false)
    }
  }

  function updateDraftBlock(index: number, patch: Partial<DocumentBlockDraft>) {
    setDraftBlocks((previous) =>
      previous.map((block, currentIndex) =>
        currentIndex === index
          ? {
              ...block,
              ...patch
            }
          : block
      )
    )
  }

    function clearBlockSelection() {
      setSelectionAnchorBlockIndex(null)
      setSelectedBlockRange(null)
    }

    function isBlockSelected(index: number) {
      return selectedBlockRange ? index >= selectedBlockRange.start && index <= selectedBlockRange.end : false
    }

    function selectBlockRange(index: number, extendSelection = false) {
      const anchorIndex = extendSelection && selectionAnchorBlockIndex !== null ? selectionAnchorBlockIndex : index
      setSelectionAnchorBlockIndex(anchorIndex)
      setSelectedBlockRange(normalizeBlockSelectionRange(anchorIndex, index))
      setActiveBlockIndex(index)
    }

    function getSelectedBlockActionRange(range: BlockSelectionRange): BlockSelectionRange {
      if (range.start !== range.end) {
        return range
      }

      return {
        start: range.start,
        end: getBlockSubtreeEndIndex(draftBlocks, range.start)
      }
    }

    function moveSelectedBlocks(delta: -1 | 1) {
      if (!selectedBlockRange) {
        return
      }

      if (selectedBlockRange.start === selectedBlockRange.end) {
        const rootIndex = selectedBlockRange.start
        const siblingIndex =
          delta === -1 ? getPreviousSiblingSubtreeStartIndex(draftBlocks, rootIndex) : getNextSiblingSubtreeStartIndex(draftBlocks, rootIndex)

        if (siblingIndex === null) {
          return
        }

        const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, rootIndex)
        const targetIndex = delta === -1 ? siblingIndex : getBlockSubtreeEndIndex(draftBlocks, siblingIndex)
        const subtreeSize = subtreeEndIndex - rootIndex + 1
        const insertionIndex = rootIndex < targetIndex ? Math.max(0, targetIndex - subtreeSize + 1) : targetIndex
        const nextIndex = remapIndexAfterSubtreeMove(rootIndex, rootIndex, subtreeEndIndex, insertionIndex) ?? rootIndex

        moveDraftSubtree(rootIndex, targetIndex, null, rootIndex)
        setSelectionAnchorBlockIndex(nextIndex)
        setSelectedBlockRange({
          start: nextIndex,
          end: nextIndex
        })
        endBlockDrag()
        return
      }

      if (!isValidSiblingRange(draftBlocks, selectedBlockRange)) {
        return
      }

      const previousBlocks = draftBlocks
      const nextBlocks = moveBlockRange(previousBlocks, selectedBlockRange, delta)
      
      if (nextBlocks === previousBlocks) {
        return
      }

      const isMovedUp = delta === -1
      const referenceDepth = draftBlocks[selectedBlockRange.start].depth
      
      let newStartIndex = selectedBlockRange.start
      let newEndIndex = selectedBlockRange.end
      
      if (isMovedUp) {
        for (let i = selectedBlockRange.start - 1; i >= 0; i -= 1) {
          if (nextBlocks[i].depth === referenceDepth) {
            newStartIndex = i
            newEndIndex = i + (selectedBlockRange.end - selectedBlockRange.start)
            break
          }
        }
      } else {
        for (let i = selectedBlockRange.end + 1; i < nextBlocks.length; i += 1) {
          if (nextBlocks[i].depth === referenceDepth) {
            newStartIndex = i - (selectedBlockRange.end - selectedBlockRange.start)
            newEndIndex = i
            break
          }
        }
      }

      setDraftBlocks(nextBlocks)
      setSelectedBlockRange({
        start: newStartIndex,
        end: newEndIndex
      })
      setSelectionAnchorBlockIndex((previous) => (previous === null ? null : previous))
      setActiveBlockIndex(newEndIndex)
      setPendingFocusBlockIndex(newEndIndex)
      endBlockDrag()
    }

    function adjustSelectedBlocksDepth(delta: -1 | 1, focusIndex: number, cursorPosition = activeCursorPosition) {
      if (!selectedBlockRange) {
        return
      }

      const selectedNestableBlocks = draftBlocks
        .slice(selectedBlockRange.start, selectedBlockRange.end + 1)
        .filter((block) => isNestableBlock(block.type))

      if (selectedNestableBlocks.length === 0) {
        return
      }

      const appliedDelta =
        delta === 1
          ? Math.min(...selectedNestableBlocks.map((block) => normalizeBlockDepth(block.type, block.depth + 1) - block.depth))
          : Math.max(...selectedNestableBlocks.map((block) => normalizeBlockDepth(block.type, block.depth - 1) - block.depth))

      if (appliedDelta === 0) {
        return
      }

      setDraftBlocks((previous) =>
        previous.map((block, currentIndex) => {
          if (currentIndex < selectedBlockRange.start || currentIndex > selectedBlockRange.end || !isNestableBlock(block.type)) {
            return block
          }

          return {
            ...block,
            depth: normalizeBlockDepth(block.type, block.depth + appliedDelta)
          }
        })
      )
      setActiveBlockIndex(focusIndex)
      setActiveCursorPosition(cursorPosition)
      setPendingFocusBlockIndex(focusIndex)
      endBlockDrag()
    }

    function convertSelectedBlocks(nextType: DocumentBlock['type']) {
      if (!selectedBlockRange) {
        return
      }

      const focusIndex =
        activeBlockIndex !== null && activeBlockIndex >= selectedBlockRange.start && activeBlockIndex <= selectedBlockRange.end
          ? activeBlockIndex
          : selectedBlockRange.start

      setDraftBlocks((previous) =>
        previous.map((block, currentIndex) => {
          if (currentIndex < selectedBlockRange.start || currentIndex > selectedBlockRange.end) {
            return block
          }

          return buildBlockTypePatch(nextType, block.content, nextType === 'todo' ? block.checked : false, block.depth)
        })
      )
      setActiveBlockIndex(focusIndex)
      setPendingFocusBlockIndex(focusIndex)
      endBlockDrag()
      setBackupMessage(`Converted ${selectedBlockCount} blocks to ${getBlockTypeLabel(nextType)}.`)
    }

    function removeSelectedBlockRange(range: BlockSelectionRange) {
      const remainingCount = draftBlocks.length - (range.end - range.start + 1)
      const nextIndex = remainingCount > 0 ? Math.min(range.start, remainingCount - 1) : null

      clearBlockSelection()
      setDraftBlocks((previous) => previous.filter((_, index) => index < range.start || index > range.end))
      setActiveBlockIndex(nextIndex)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(nextIndex)
      endBlockDrag()
    }

    async function copySelectedBlocks() {
      if (!selectedBlockRange) {
        return
      }

      const range = getSelectedBlockActionRange(selectedBlockRange)
      const text = serializeDraftBlockRange(draftBlocks, range)
      const count = range.end - range.start + 1

      try {
        await window.knowbook.writeClipboardText(text)
        setBackupMessage(`Copied ${count} blocks as block sequence.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Copy failed.'
        setBackupMessage(message)
      }
    }

    async function copySelectedBlocksAsPlainText() {
      if (!selectedBlockRange) {
        return
      }

      const range = getSelectedBlockActionRange(selectedBlockRange)
      const text = serializeDraftBlockRangeAsPlainText(draftBlocks, range)
      const count = range.end - range.start + 1

      try {
        await window.knowbook.writeClipboardText(text)
        setBackupMessage(`Copied ${count} blocks as plain text.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Copy text failed.'
        setBackupMessage(message)
      }
    }

    async function cutSelectedBlocks() {
      if (!selectedBlockRange) {
        return
      }

      const range = getSelectedBlockActionRange(selectedBlockRange)
      const text = serializeDraftBlockRange(draftBlocks, range)
      const count = range.end - range.start + 1

      try {
        await window.knowbook.writeClipboardText(text)
        removeSelectedBlockRange(range)
        setBackupMessage(`Cut ${count} blocks to clipboard.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cut failed.'
        setBackupMessage(message)
      }
    }

    function deleteSelectedBlocks() {
      if (!selectedBlockRange) {
        return
      }

      const range = getSelectedBlockActionRange(selectedBlockRange)
      const count = range.end - range.start + 1
      removeSelectedBlockRange(range)
      setBackupMessage(`Deleted ${count} blocks.`)
    }

    function duplicateSelectedBlocks() {
      if (!selectedBlockRange) {
        return
      }

      const range = getSelectedBlockActionRange(selectedBlockRange)
      const duplicatedBlocks = draftBlocks.slice(range.start, range.end + 1).map((block) => ({
        ...block,
        checked: block.type === 'todo' ? block.checked : false,
        depth: normalizeBlockDepth(block.type, block.depth)
      }))
      const count = duplicatedBlocks.length
      const duplicatedRange = {
        start: range.end + 1,
        end: range.end + count
      }

      setDraftBlocks((previous) => {
        const next = [...previous]
        next.splice(range.end + 1, 0, ...duplicatedBlocks)
        return next
      })
      setSelectionAnchorBlockIndex(duplicatedRange.start)
      setSelectedBlockRange(duplicatedRange)
      setActiveBlockIndex(duplicatedRange.start)
      setActiveCursorPosition(duplicatedBlocks[0]?.content.length ?? 0)
      setPendingFocusBlockIndex(duplicatedRange.start)
      endBlockDrag()
      setBackupMessage(`Duplicated ${count} blocks.`)
    }

  function handleBlockContentChange(index: number, content: string) {
    const shortcut = resolveMarkdownBlockShortcut(draftBlocks[index] ?? buildBlockTypePatch('paragraph', ''))
    if (shortcut) {
      updateDraftBlock(index, shortcut)
      setActiveBlockIndex(index)
      setActiveCursorPosition(shortcut.content.length)
      setPendingFocusBlockIndex(index)
      return
    }

    updateDraftBlock(index, { content })
  }

  function handleBlockPaste(index: number, pastedText: string, selectionStart: number, selectionEnd: number) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return false
    }

    const normalizedText = pastedText.replace(/\r\n?/g, '\n')
    const activeRange =
      selectedBlockRange && index >= selectedBlockRange.start && index <= selectedBlockRange.end
        ? getSelectedBlockActionRange(selectedBlockRange)
        : null

    if (activeRange) {
      const templateBlock = draftBlocks[activeRange.start] ?? currentBlock
      const lines = normalizedText.split('\n')
      let nextBlocks = looksLikeStructuredBlockPaste(normalizedText)
        ? parseStructuredPastedBlocks(normalizedText)
        : lines.map((line) => normalizePastedLineBlock(templateBlock, line))

      if (nextBlocks.length === 0) {
        return false
      }

      nextBlocks = adjustPastedBlocksDepth(nextBlocks, templateBlock.depth)

      clearBlockSelection()
      setDraftBlocks((previous) => {
        const next = [...previous]
        next.splice(activeRange.start, activeRange.end - activeRange.start + 1, ...nextBlocks)
        return next
      })

      const focusIndex = activeRange.start + nextBlocks.length - 1
      const focusBlock = nextBlocks[nextBlocks.length - 1]
      setActiveBlockIndex(focusIndex)
      setActiveCursorPosition(focusBlock?.content.length ?? 0)
      setPendingFocusBlockIndex(focusIndex)
      endBlockDrag()
      return true
    }

    if (!normalizedText.includes('\n')) {
      return false
    }

    clearBlockSelection()

    const before = currentBlock.content.slice(0, selectionStart)
    const after = currentBlock.content.slice(selectionEnd)
    const lines = normalizedText.split('\n')
    const firstLine = lines[0] ?? ''
    const lastLine = lines[lines.length - 1] ?? ''
    const middleLines = lines.slice(1, -1)
    const nextBlocks = [
      normalizePastedLineBlock(currentBlock, `${before}${firstLine}`),
      ...middleLines.map((line) => normalizePastedLineBlock(currentBlock, line)),
      normalizePastedLineBlock(currentBlock, `${lastLine}${after}`)
    ]

    setDraftBlocks((previous) => {
      const next = [...previous]
      next.splice(index, 1, ...nextBlocks)
      return next
    })

    const focusIndex = index + nextBlocks.length - 1
    setActiveBlockIndex(focusIndex)
    setActiveCursorPosition(lastLine.length)
    setPendingFocusBlockIndex(focusIndex)
    endBlockDrag()
    return true
  }

  function insertDraftBlockAt(index: number, anchorIndex: number | null = null) {
    const nextIndex = Math.max(0, Math.min(index, draftBlocks.length))
    clearBlockSelection()

    setDraftBlocks((previous) => {
      const next = [...previous]
      const anchorBlock = anchorIndex !== null ? next[anchorIndex] : undefined
      next.splice(nextIndex, 0, buildSiblingDraftBlock(anchorBlock))
      return next
    })

    setActiveBlockIndex(nextIndex)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(nextIndex)
    endBlockDrag()
  }

  function insertChildDraftBlock(index: number, contentOverride?: string) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    clearBlockSelection()

    const childType = getDefaultChildBlockType(currentBlock.type)
    const childDepth = currentBlock.depth + 1
    if (!isNestableBlock(childType) || childDepth > 6) {
      return
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)

    setDraftBlocks((previous) => {
      const next = [...previous]
      if (contentOverride !== undefined) {
        next[index] = {
          ...next[index],
          content: contentOverride
        }
      }

      next.splice(subtreeEndIndex + 1, 0, buildBlockTypePatch(childType, '', false, childDepth))
      return next
    })

    setActiveBlockIndex(subtreeEndIndex + 1)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(subtreeEndIndex + 1)
    endBlockDrag()
  }

  function duplicateDraftBlock(index: number, contentOverride?: string) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    clearBlockSelection()

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)
    const duplicatedRootIndex = subtreeEndIndex + 1
    const duplicatedBlocks = draftBlocks.slice(index, subtreeEndIndex + 1).map((block, offset) => ({
      ...block,
      content: offset === 0 ? contentOverride ?? block.content : block.content,
      checked: block.type === 'todo' ? block.checked : false,
      depth: normalizeBlockDepth(block.type, block.depth)
    }))

    setDraftBlocks((previous) => {
      const next = [...previous]
      if (contentOverride !== undefined) {
        next[index] = {
          ...next[index],
          content: contentOverride
        }
      }

      next.splice(duplicatedRootIndex, 0, ...duplicatedBlocks)
      return next
    })
    setActiveBlockIndex(duplicatedRootIndex)
    setActiveCursorPosition(duplicatedBlocks[0]?.content.length ?? 0)
    setPendingFocusBlockIndex(duplicatedRootIndex)
    endBlockDrag()
  }

  function splitDraftBlock(index: number, selectionStart: number, selectionEnd = selectionStart, nextTypeOverride?: string) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)
    if (subtreeEndIndex > index) {
      console.warn('Cannot split a block with child blocks. Please delete or move child blocks first.')
      return
    }

    clearBlockSelection()

    const safeStart = Math.max(0, Math.min(selectionStart, currentBlock.content.length))
    const safeEnd = Math.max(safeStart, Math.min(selectionEnd, currentBlock.content.length))
    const leftContent = currentBlock.content.slice(0, safeStart)
    const rightContent = currentBlock.content.slice(safeEnd)
    const nextType = nextTypeOverride ?? (currentBlock.type === 'heading-1' || currentBlock.type === 'heading-2' ? 'paragraph' : currentBlock.type)

    setDraftBlocks((previous) => {
      const next = [...previous]
      next[index] = {
        ...next[index],
        content: leftContent
      }
      next.splice(
        index + 1,
        0,
        buildBlockTypePatch(nextType, rightContent, nextType === 'todo' ? false : currentBlock.checked, currentBlock.depth)
      )
      return next
    })
    setActiveBlockIndex(index + 1)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(index + 1)
    endBlockDrag()
  }

  function continueBlockAt(index: number, selectionStart: number, selectionEnd = selectionStart) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    const exitsToParagraph = ['heading-1', 'heading-2', 'todo', 'bulleted-list', 'numbered-list']
    if (currentBlock.content.trim() === '' && exitsToParagraph.includes(currentBlock.type)) {
      if (isNestableBlock(currentBlock.type) && currentBlock.depth > 0) {
        adjustBlockDepth(index, -1, 0)
        return
      }

      updateDraftBlock(index, buildBlockTypePatch('paragraph', ''))
      setActiveBlockIndex(index)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(index)
      return
    }

    if (['heading-1', 'heading-2', 'todo', 'bulleted-list', 'numbered-list'].includes(currentBlock.type)) {
      const nextType = currentBlock.type === 'heading-1' || currentBlock.type === 'heading-2' ? 'paragraph' : currentBlock.type
      splitDraftBlock(index, selectionStart, selectionEnd, nextType)
    }
  }

  function downgradeBlockAt(index: number) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    if (!['heading-1', 'heading-2', 'todo', 'quote', 'bulleted-list', 'numbered-list'].includes(currentBlock.type)) {
      return
    }

    if (isNestableBlock(currentBlock.type) && currentBlock.depth > 0) {
      adjustBlockDepth(index, -1, 0)
      return
    }

    updateDraftBlock(index, buildBlockTypePatch('paragraph', currentBlock.content))
    setActiveBlockIndex(index)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(index)
  }

  function adjustBlockDepth(index: number, delta: number, cursorPosition = activeCursorPosition) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock || !isNestableBlock(currentBlock.type)) {
      return
    }

    const nextRootDepth = normalizeBlockDepth(currentBlock.type, currentBlock.depth + delta)
    const appliedDelta = nextRootDepth - currentBlock.depth
    if (appliedDelta === 0) {
      return
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)

    setDraftBlocks((previous) =>
      previous.map((block, currentIndex) => {
        if (currentIndex < index || currentIndex > subtreeEndIndex) {
          return block
        }

        if (!isNestableBlock(block.type)) {
          return block
        }

        return {
          ...block,
          depth: normalizeBlockDepth(block.type, block.depth + appliedDelta)
        }
      })
    )
    setActiveBlockIndex(index)
    setActiveCursorPosition(cursorPosition)
    setPendingFocusBlockIndex(index)
  }

  function moveDraftSubtree(sourceIndex: number, targetIndex: number, targetDepth: number | null, focusIndexOverride?: number | null) {
    clearBlockSelection()
    setDraftBlocks((previous) => {
      const subtreeEndIndex = getBlockSubtreeEndIndex(previous, sourceIndex)
      const movedBlocks = previous.slice(sourceIndex, subtreeEndIndex + 1)
      const next = [...previous]
      next.splice(sourceIndex, movedBlocks.length)

      const insertionIndex = sourceIndex < targetIndex ? Math.max(0, targetIndex - movedBlocks.length + 1) : targetIndex
      const rootBlock = movedBlocks[0]
      if (!rootBlock) {
        return previous
      }

      const nextRootDepth = targetDepth === null ? rootBlock.depth : normalizeBlockDepth(rootBlock.type, targetDepth)
      const appliedDelta = nextRootDepth - rootBlock.depth
      const normalizedMovedBlocks = movedBlocks.map((block) =>
        isNestableBlock(block.type)
          ? {
              ...block,
              depth: normalizeBlockDepth(block.type, block.depth + appliedDelta)
            }
          : block
      )

      next.splice(insertionIndex, 0, ...normalizedMovedBlocks)
      return next
    })

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, sourceIndex)
    const subtreeSize = subtreeEndIndex - sourceIndex + 1
    const insertionIndex = sourceIndex < targetIndex ? Math.max(0, targetIndex - subtreeSize + 1) : targetIndex

    setActiveBlockIndex((previous) =>
      remapIndexAfterSubtreeMove(
        focusIndexOverride === undefined ? previous : focusIndexOverride,
        sourceIndex,
        subtreeEndIndex,
        insertionIndex
      )
    )
    setPendingFocusBlockIndex((previous) =>
      remapIndexAfterSubtreeMove(
        focusIndexOverride === undefined ? previous : focusIndexOverride,
        sourceIndex,
        subtreeEndIndex,
        insertionIndex
      )
    )
  }

  function moveDraftBlockBySibling(index: number, direction: -1 | 1, cursorPosition = activeCursorPosition, contentOverride?: string) {
    const siblingIndex =
      direction === -1 ? getPreviousSiblingSubtreeStartIndex(draftBlocks, index) : getNextSiblingSubtreeStartIndex(draftBlocks, index)

    if (contentOverride !== undefined) {
      updateDraftBlock(index, { content: contentOverride })
    }

    if (siblingIndex === null) {
      setActiveBlockIndex(index)
      setActiveCursorPosition(contentOverride?.length ?? cursorPosition)
      setPendingFocusBlockIndex(index)
      return false
    }

    const targetIndex = direction === -1 ? siblingIndex : getBlockSubtreeEndIndex(draftBlocks, siblingIndex)
    moveDraftSubtree(index, targetIndex, null, index)
    setActiveCursorPosition(contentOverride?.length ?? cursorPosition)
    return true
  }

  function applySlashCommand(command: BlockSlashCommand) {
    if (activeBlockIndex === null || !activeSlashContext) {
      return
    }

    const currentBlock = draftBlocks[activeBlockIndex]
    if (!currentBlock) {
      return
    }

    const nextContent = stripSlashCommand(currentBlock.content, activeSlashContext.start, activeCursorPosition)

    if (command.kind === 'type') {
      setDraftBlocks((previous) =>
        previous.map((block, index) =>
          index === activeBlockIndex
            ? {
                ...block,
                ...buildBlockTypePatch(command.type, nextContent, command.type === 'todo' ? currentBlock.checked : false, currentBlock.depth)
              }
            : block
        )
      )
      setActiveCursorPosition(nextContent.length)
      setPendingFocusBlockIndex(activeBlockIndex)
      return
    }

    if (command.action === 'insert-above') {
      clearBlockSelection()
      setDraftBlocks((previous) => {
        const next = [...previous]
        next[activeBlockIndex] = {
          ...next[activeBlockIndex],
          content: nextContent
        }
        next.splice(activeBlockIndex, 0, buildSiblingDraftBlock(next[activeBlockIndex]))
        return next
      })
      setActiveBlockIndex(activeBlockIndex)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(activeBlockIndex)
      return
    }

    if (command.action === 'insert-below') {
      clearBlockSelection()
      setDraftBlocks((previous) => {
        const next = [...previous]
        next[activeBlockIndex] = {
          ...next[activeBlockIndex],
          content: nextContent
        }
        next.splice(activeBlockIndex + 1, 0, buildSiblingDraftBlock(next[activeBlockIndex]))
        return next
      })
      setActiveBlockIndex(activeBlockIndex + 1)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(activeBlockIndex + 1)
      return
    }

    if (command.action === 'insert-child') {
      insertChildDraftBlock(activeBlockIndex, nextContent)
      return
    }

    if (command.action === 'move-up' || command.action === 'move-down') {
      moveDraftBlockBySibling(activeBlockIndex, command.action === 'move-up' ? -1 : 1, nextContent.length, nextContent)
      return
    }

    if (command.action === 'indent' || command.action === 'outdent') {
      if (!isNestableBlock(currentBlock.type)) {
        setDraftBlocks((previous) =>
          previous.map((block, index) =>
            index === activeBlockIndex
              ? {
                  ...block,
                  content: nextContent
                }
              : block
          )
        )
        setActiveCursorPosition(nextContent.length)
        setPendingFocusBlockIndex(activeBlockIndex)
        return
      }

      setDraftBlocks((previous) =>
        previous.map((block, index) =>
          index === activeBlockIndex
            ? {
                ...block,
                content: nextContent,
                depth: normalizeBlockDepth(block.type, block.depth + (command.action === 'indent' ? 1 : -1))
              }
            : block
        )
      )
      setActiveCursorPosition(nextContent.length)
      setPendingFocusBlockIndex(activeBlockIndex)
      return
    }

    if (command.action === 'duplicate') {
      duplicateDraftBlock(activeBlockIndex, nextContent)
      return
    }

    if (command.action === 'delete') {
      removeDraftBlock(activeBlockIndex)
    }
  }

  function dismissSlashCommand() {
    if (activeBlockIndex === null || !activeSlashContext) {
      return
    }

    const currentBlock = draftBlocks[activeBlockIndex]
    if (!currentBlock) {
      return
    }

    const nextContent = stripSlashCommand(currentBlock.content, activeSlashContext.start, activeCursorPosition)
    setDraftBlocks((previous) =>
      previous.map((block, index) =>
        index === activeBlockIndex
          ? {
              ...block,
              content: nextContent
            }
          : block
      )
    )
    setActiveCursorPosition(nextContent.length)
    setPendingFocusBlockIndex(activeBlockIndex)
  }

  function addDraftBlock() {
    insertDraftBlockAt(draftBlocks.length)
  }

  function removeDraftBlock(index: number) {
    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)
    const removedCount = subtreeEndIndex - index + 1
    const remainingCount = draftBlocks.length - removedCount
    const nextIndex = remainingCount > 0 ? Math.min(index, remainingCount - 1) : null

    clearBlockSelection()
    setDraftBlocks((previous) => previous.filter((_, currentIndex) => currentIndex < index || currentIndex > subtreeEndIndex))
    setActiveBlockIndex((previous) => {
      if (previous === null) {
        return previous
      }

      if (previous < index) {
        return previous
      }

      if (previous <= subtreeEndIndex) {
        return nextIndex
      }

      return previous - removedCount
    })
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(nextIndex)
    endBlockDrag()
  }

  function beginBlockDrag(index: number) {
    setDraggingBlockIndex(index)
    setDragOverBlockIndex(index)
    setDragOverBlockDepth(draftBlocks[index]?.depth ?? null)
  }

  function endBlockDrag() {
    setDraggingBlockIndex(null)
    setDragOverBlockIndex(null)
    setDragOverBlockDepth(null)
  }

  function getDraggedBlockDepthPreview(targetIndex: number, clientX: number, element: HTMLDivElement) {
    if (draggingBlockIndex === null) {
      return null
    }

    const draggingBlock = draftBlocks[draggingBlockIndex]
    if (!draggingBlock || !isNestableBlock(draggingBlock.type)) {
      return null
    }

    const targetBlock = draftBlocks[targetIndex]
    const anchorDepth = targetBlock && isNestableBlock(targetBlock.type) ? targetBlock.depth : 0
    const contentColumnStart = element.getBoundingClientRect().left + 48 + 160 + 20
    const horizontalDelta = clientX - contentColumnStart
    const depthDelta = horizontalDelta > BLOCK_DRAG_DEPTH_THRESHOLD ? 1 : horizontalDelta < -BLOCK_DRAG_DEPTH_THRESHOLD ? -1 : 0

    return normalizeBlockDepth(draggingBlock.type, anchorDepth + depthDelta)
  }

  function dropBlockAt(targetIndex: number, targetDepth = dragOverBlockDepth) {
    if (draggingBlockIndex === null) {
      endBlockDrag()
      return
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, draggingBlockIndex)
    if (targetIndex >= draggingBlockIndex && targetIndex <= subtreeEndIndex) {
      endBlockDrag()
      return
    }

    moveDraftSubtree(draggingBlockIndex, targetIndex, targetDepth)

    endBlockDrag()
  }

  function captureBlockCursor(index: number, element: HTMLTextAreaElement) {
    setActiveBlockIndex(index)
    setActiveCursorPosition(element.selectionStart ?? element.value.length)
  }

  function insertLinkSuggestion(suggestion: DocumentSuggestion) {
    if (activeBlockIndex === null || !activeLinkContext) {
      return
    }

    const replacement = `[[${suggestion.path}]]`
    setDraftBlocks((previous) =>
      previous.map((block, index) => {
        if (index !== activeBlockIndex) {
          return block
        }

        return {
          ...block,
          content: `${block.content.slice(0, activeLinkContext.start)}${replacement}${block.content.slice(activeCursorPosition)}`
        }
      })
    )
    setActiveCursorPosition(activeLinkContext.start + replacement.length)
    setLinkSuggestions([])
  }

  const moveOptions = flattenTree(homeData.documentTree)
    .filter((option) => option.id !== selectedDocumentId)
    .map((option) => ({
      ...option,
      label: `${'  '.repeat(option.depth)}${option.title}`
    }))
  const documentReferences = buildDocumentReferences(homeData.documentTree)
  const filteredCatalog = homeData.documentCatalog.filter((document) => {
    const query = catalogQuery.trim().toLowerCase()
    if (!query) {
      return true
    }

    return [document.title, document.path, document.summary]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })
  const boardColumns = buildBoardColumns(filteredCatalog)

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">KB</span>
          <div>
            <p className="eyebrow">Local-first knowledge OS</p>
            <h1>KnowBook</h1>
          </div>
        </div>

        <div className="panel panel-accent">
          <p className="panel-label">Implementation Slice</p>
          <h2>Phase 1.5 workspace shell</h2>
          <p>
            The desktop shell now exposes a real document tree, detail preview, scheduled markdown exports, and API-driven AI configuration from the same SQLite source.
          </p>
        </div>

        <div className="panel">
          <p className="panel-label">Next up</p>
          <ul className="panel-list">
            <li>Editable block canvas backed by the existing document detail API</li>
            <li>Document drag-to-reparent flow</li>
            <li>AI provider settings and embeddings pipeline</li>
          </ul>
        </div>

        <div className="panel">
          <p className="panel-label">AI settings</p>
          <h3>Cloud API configuration</h3>
          <div className="editor-fields">
            <label className="toggle-row">
              <input checked={aiEnabledDraft} onChange={(event) => setAiEnabledDraft(event.target.checked)} type="checkbox" />
              <span>Enable AI features</span>
            </label>
            <label className="editor-label">
              Base URL
              <input className="editor-input" onChange={(event) => setAiBaseUrlDraft(event.target.value)} type="text" value={aiBaseUrlDraft} />
            </label>
            <label className="editor-label">
              Model
              <input className="editor-input" onChange={(event) => setAiModelDraft(event.target.value)} type="text" value={aiModelDraft} />
            </label>
            <label className="editor-label">
              API Key (leave blank to keep current)
              <input className="editor-input" onChange={(event) => setAiApiKeyDraft(event.target.value)} type="password" value={aiApiKeyDraft} />
            </label>
            <p className="mini-hint">Current key: {homeData.aiConfig.hasApiKey ? 'configured' : 'missing'}</p>
            <button className="secondary-button" disabled={aiSaving} onClick={saveAiConfig} type="button">
              {aiSaving ? 'Saving...' : 'Save AI settings'}
            </button>
          </div>
        </div>
      </aside>

      <main className="content">
        <section className="hero">
          <div>
            <p className="eyebrow">Workspace status</p>
            <h2>Workspace navigation is alive</h2>
            <p className="hero-copy">
              SQLite remains the source of truth, markdown backups export into a nested tree, and the renderer can now browse document hierarchy and inspect document relationships over the preload bridge.
            </p>
          </div>
          <button className="primary-button" onClick={handleBackup} type="button">
            Run backup now
          </button>
        </section>

        {backupMessage ? <p className="flash-message">{backupMessage}</p> : null}

        <section className="stats-grid">
          <article className="stat-card">
            <span className="stat-label">Documents</span>
            <strong>{homeData.summary.documents}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">Blocks</span>
            <strong>{homeData.summary.blocks}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">Links</span>
            <strong>{homeData.summary.links}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">AI</span>
            <strong>{homeData.aiConfig.enabled ? 'API ready' : 'Disabled'}</strong>
          </article>
        </section>

        <section className="graph-grid">
          <article className="panel graph-panel">
            <div className="panel-head compact-head">
              <div>
                <p className="panel-label">Knowledge graph</p>
                <h3>Workspace topology</h3>
              </div>
              <div className="toolbar-inline">
                <span className="pill">{homeData.graph.nodes.length} nodes</span>
                <span className="pill">{homeData.graph.edges.length} edges</span>
              </div>
            </div>

            <WorkspaceGraph
              edges={homeData.graph.edges}
              nodes={homeData.graph.nodes}
              selectedDocumentId={selectedDocumentId}
              onSelect={setSelectedDocumentId}
            />
          </article>
        </section>

        <section className="database-grid">
          <article className="panel database-panel">
            <div className="panel-head compact-head">
              <div>
                <p className="panel-label">Database view</p>
                <h3>Document catalog</h3>
              </div>
              <div className="toolbar-inline">
                <input
                  className="editor-input table-search"
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  placeholder="Search documents..."
                  type="text"
                  value={catalogQuery}
                />
                <span className="pill">{filteredCatalog.length} rows</span>
              </div>
            </div>

            <DocumentCatalogTable
              documents={filteredCatalog}
              onSelect={setSelectedDocumentId}
              selectedDocumentId={selectedDocumentId}
            />
          </article>

          <article className="panel board-panel">
            <div className="panel-head compact-head">
              <div>
                <p className="panel-label">Board view</p>
                <h3>Grouped by parent bucket</h3>
              </div>
              <span className="pill">{boardColumns.length} columns</span>
            </div>

            <DocumentBoard
              columns={boardColumns}
              onSelect={setSelectedDocumentId}
              selectedDocumentId={selectedDocumentId}
            />
          </article>
        </section>

        <section className="workspace-grid">
          <article className="panel tree-panel">
            <div className="panel-head compact-head">
              <div>
                <p className="panel-label">Workspace tree</p>
                <h3>Seeded documents</h3>
              </div>
              <div className="toolbar-inline">
                <span className="pill">{homeData.documentTree.length} roots</span>
                <button className="secondary-button" onClick={() => handleCreateDocument(null)} type="button">
                  New root
                </button>
              </div>
            </div>

            <div
              className={`root-drop-zone${dragOverRoot ? ' root-drop-zone-active' : ''}`}
              onDragOver={(event) => {
                event.preventDefault()
                if (draggingDocumentId) {
                  setDragOverRoot(true)
                  setDragOverDocumentId(null)
                }
              }}
              onDragLeave={() => setDragOverRoot(false)}
              onDrop={async (event) => {
                event.preventDefault()
                await dropToRoot()
              }}
            >
              Drop here to move document to root
            </div>

            <DocumentTree
              nodes={homeData.documentTree}
              selectedDocumentId={selectedDocumentId}
              onSelect={setSelectedDocumentId}
              draggingDocumentId={draggingDocumentId}
              dragOverDocumentId={dragOverDocumentId}
              onDragStart={beginDrag}
              onDragEnd={endDrag}
              onDragOverNode={(documentId) => {
                if (draggingDocumentId && draggingDocumentId !== documentId) {
                  setDragOverDocumentId(documentId)
                  setDragOverRoot(false)
                }
              }}
              onDropOnNode={dropOnDocument}
            />
          </article>

          <article className="panel preview-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Document preview</p>
                <h3>{selectedDocument?.title ?? 'Select a document'}</h3>
              </div>
              <div className="toolbar-inline">
                {selectedDocument ? (
                  <button className="secondary-button" onClick={() => handleCreateDocument(selectedDocument.id)} type="button">
                    Add child
                  </button>
                ) : null}
                {selectedDocument && !isEditing ? (
                  <button className="secondary-button" onClick={startEdit} type="button">
                    Edit
                  </button>
                ) : null}
                {selectedDocument && isEditing ? (
                  <>
                    <button className="secondary-button" disabled={isSaving} onClick={cancelEdit} type="button">
                      Cancel
                    </button>
                    <button className="secondary-button" disabled={isSaving} onClick={saveDocument} type="button">
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                  </>
                ) : null}
                {selectedDocument && !isEditing ? (
                  <button className="danger-button" onClick={deleteSelectedDocument} type="button">
                    Delete
                  </button>
                ) : null}
                {selectedDocument && !isEditing ? (
                  <>
                    <select className="editor-select compact-select" onChange={(event) => setMoveTargetId(event.target.value)} value={moveTargetId}>
                      <option value="">Move to...</option>
                      <option value="__root__">(Root)</option>
                      {moveOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button className="secondary-button" disabled={!moveTargetId} onClick={moveSelectedDocument} type="button">
                      Move
                    </button>
                  </>
                ) : null}
                {detailLoading ? <span className="pill">Loading...</span> : <span className="pill">{isEditing ? 'Editing' : 'Read only'}</span>}
              </div>
            </div>

            {selectedDocument ? (
              <>
                <div className="document-summary-card">
                  <p className="document-path">{selectedDocument.path}</p>
                  {isEditing ? (
                    <div className="editor-fields">
                      <label className="editor-label">
                        Title
                        <input className="editor-input" onChange={(event) => setDraftTitle(event.target.value)} type="text" value={draftTitle} />
                      </label>
                      <label className="editor-label">
                        Summary
                        <textarea
                          className="editor-textarea"
                          onChange={(event) => setDraftSummary(event.target.value)}
                          rows={3}
                          value={draftSummary}
                        />
                      </label>
                    </div>
                  ) : (
                    <p className="document-summary">{selectedDocument.summary}</p>
                  )}
                  <p className="document-updated">Updated {new Date(selectedDocument.updatedAt).toLocaleString()}</p>
                </div>

                <div className="preview-section">
                  <p className="panel-label">Blocks</p>
                  {isEditing ? (
                    <div className="block-editor-list">
                      {selectedBlockRange ? (
                        <div className="block-selection-toolbar">
                          <div>
                            <strong>
                              {selectedBlockCount} block{selectedBlockCount === 1 ? '' : 's'} selected
                              {selectedBlockActionCount > selectedBlockCount ? ` · subtree ${selectedBlockActionCount} blocks` : ''}
                            </strong>
                            <p className="mini-hint">
                              Rows {selectedBlockRange.start + 1}-{selectedBlockRange.end + 1}. Use Shift + Select to extend a contiguous range, convert the whole slice to a shared block type, copy blocks or plain text, cut/delete/duplicate the whole slice, use Alt + ArrowUp/ArrowDown to move it, Tab / Shift+Tab to adjust nesting, use Delete or Backspace to remove it from the keyboard, or paste to replace it.
                              {selectedBlockActionCount > selectedBlockCount
                                ? ' For a single selected parent block, copy/cut/duplicate/delete and paste-replace expand to the full subtree.'
                                : ''}
                            </p>
                          </div>
                          <div className="block-selection-actions">
                            <select
                              className="editor-select compact-select"
                              onChange={(event) => setSelectedBlockConversionType(event.target.value as DocumentBlock['type'])}
                              value={selectedBlockConversionType}
                            >
                              <option value="paragraph">As Text</option>
                              <option value="todo">As Todo</option>
                              <option value="quote">As Quote</option>
                              <option value="bulleted-list">As Bullet</option>
                              <option value="numbered-list">As Numbered</option>
                            </select>
                            <button className="secondary-button" onClick={() => convertSelectedBlocks(selectedBlockConversionType)} type="button">
                              Convert
                            </button>
                            <button className="secondary-button" onClick={copySelectedBlocks} type="button">
                              Copy Blocks
                            </button>
                            <button className="secondary-button" onClick={copySelectedBlocksAsPlainText} type="button">
                              Copy Text
                            </button>
                            <button className="secondary-button" onClick={cutSelectedBlocks} type="button">
                              Cut
                            </button>
                            <button className="secondary-button" onClick={duplicateSelectedBlocks} type="button">
                              Duplicate
                            </button>
                            <button className="danger-button" onClick={deleteSelectedBlocks} type="button">
                              Delete
                            </button>
                            <button
                              className="secondary-button"
                              disabled={
                                selectedBlockCount === 1
                                  ? getPreviousSiblingSubtreeStartIndex(draftBlocks, selectedBlockRange.start) === null
                                  : selectedBlockRange.start === 0
                              }
                              onClick={() => moveSelectedBlocks(-1)}
                              type="button"
                            >
                              Move Up
                            </button>
                            <button
                              className="secondary-button"
                              disabled={
                                selectedBlockCount === 1
                                  ? getNextSiblingSubtreeStartIndex(draftBlocks, selectedBlockRange.start) === null
                                  : selectedBlockRange.end === draftBlocks.length - 1
                              }
                              onClick={() => moveSelectedBlocks(1)}
                              type="button"
                            >
                              Move Down
                            </button>
                            <button className="secondary-button" onClick={clearBlockSelection} type="button">
                              Clear
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {draftBlocks.map((block, index) => {
                        const dropPreview =
                          draggingBlockIndex !== null && dragOverBlockIndex === index
                            ? getBlockDropPreview(draftBlocks, draggingBlockIndex, index, dragOverBlockDepth)
                            : null
                        const isSelected = isBlockSelected(index)

                        return (
                          <div
                            className={`block-editor-row${dropPreview ? ' block-editor-row-drag-over' : ''}${isSelected ? ' block-editor-row-selected' : ''}`}
                            key={block.id ?? `${selectedDocument.id}-draft-${index}`}
                            onDragOver={(event) => {
                              event.preventDefault()
                              if (draggingBlockIndex !== null) {
                                setDragOverBlockIndex(index)
                                setDragOverBlockDepth(getDraggedBlockDepthPreview(index, event.clientX, event.currentTarget))
                              }
                            }}
                            onDrop={(event) => {
                              event.preventDefault()
                              dropBlockAt(index, getDraggedBlockDepthPreview(index, event.clientX, event.currentTarget))
                            }}
                          >
                          <button
                            aria-label="Drag block"
                            className="block-drag-handle"
                            draggable
                            onDragEnd={endBlockDrag}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = 'move'
                              beginBlockDrag(index)
                            }}
                            type="button"
                          >
                            ⋮⋮
                          </button>
                          <select
                            className="editor-select"
                            onChange={(event) => updateDraftBlock(index, buildBlockTypePatch(event.target.value, block.content, block.checked, block.depth))}
                            value={block.type}
                          >
                            <option value="paragraph">Paragraph</option>
                            <option value="heading-1">Heading 1</option>
                            <option value="heading-2">Heading 2</option>
                            <option value="todo">Todo</option>
                            <option value="code">Code</option>
                            <option value="math">Math Formula</option>
                            <option value="quote">Quote</option>
                            <option value="bulleted-list">Bulleted List</option>
                            <option value="numbered-list">Numbered List</option>
                            <option value="divider">Divider</option>
                          </select>
                          {block.type === 'divider' ? (
                            <div className="block-divider-editor">Divider block</div>
                          ) : (
                            <textarea
                              className="editor-textarea block-editor-textarea"
                              style={isNestableBlock(block.type) ? { marginInlineStart: `${block.depth * BLOCK_INDENT_SIZE}px` } : undefined}
                              ref={(element) => {
                                blockTextareaRefs.current[index] = element
                              }}
                              onChange={(event) => {
                                handleBlockContentChange(index, event.target.value)
                                captureBlockCursor(index, event.target)
                              }}
                              onPaste={(event) => {
                                if (
                                  handleBlockPaste(
                                    index,
                                    event.clipboardData.getData('text/plain'),
                                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                    event.currentTarget.selectionEnd ?? event.currentTarget.value.length
                                  )
                                ) {
                                  event.preventDefault()
                                }
                              }}
                              onCopy={(event) => {
                                if (!selectedBlockRange || !isSelected) {
                                  return
                                }

                                if (
                                  selectedBlockCount === 1 &&
                                  (event.currentTarget.selectionStart ?? 0) !== (event.currentTarget.selectionEnd ?? 0)
                                ) {
                                  return
                                }

                                const range = getSelectedBlockActionRange(selectedBlockRange)
                                event.clipboardData.setData('text/plain', serializeDraftBlockRange(draftBlocks, range))
                                event.preventDefault()
                              }}
                              onCut={(event) => {
                                if (!selectedBlockRange || !isSelected) {
                                  return
                                }

                                if (
                                  selectedBlockCount === 1 &&
                                  (event.currentTarget.selectionStart ?? 0) !== (event.currentTarget.selectionEnd ?? 0)
                                ) {
                                  return
                                }

                                const range = getSelectedBlockActionRange(selectedBlockRange)
                                event.clipboardData.setData('text/plain', serializeDraftBlockRange(draftBlocks, range))
                                event.preventDefault()
                                removeSelectedBlockRange(range)
                              }}
                              onClick={(event) => captureBlockCursor(index, event.currentTarget)}
                              onFocus={(event) => captureBlockCursor(index, event.currentTarget)}
                              onKeyDown={(event) => {
                                if (
                                  event.altKey &&
                                  !event.shiftKey &&
                                  !event.metaKey &&
                                  !event.ctrlKey &&
                                  (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                                ) {
                                  event.preventDefault()
                                  if (selectedBlockRange && isSelected && selectedBlockCount > 1) {
                                    moveSelectedBlocks(event.key === 'ArrowUp' ? -1 : 1)
                                  } else {
                                    moveDraftBlockBySibling(
                                      index,
                                      event.key === 'ArrowUp' ? -1 : 1,
                                      event.currentTarget.selectionStart ?? event.currentTarget.value.length
                                    )
                                  }
                                  return
                                }

                                if (activeBlockIndex === index && activeSlashContext) {
                                  if (event.key === 'ArrowDown') {
                                    event.preventDefault()
                                    setSelectedSlashCommandIndex((previous) =>
                                      filteredSlashCommands.length === 0 ? 0 : (previous + 1) % filteredSlashCommands.length
                                    )
                                    return
                                  }

                                  if (event.key === 'ArrowUp') {
                                    event.preventDefault()
                                    setSelectedSlashCommandIndex((previous) =>
                                      filteredSlashCommands.length === 0
                                        ? 0
                                        : (previous - 1 + filteredSlashCommands.length) % filteredSlashCommands.length
                                    )
                                    return
                                  }

                                  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                                    if (activeSlashCommand) {
                                      event.preventDefault()
                                      applySlashCommand(activeSlashCommand)
                                      return
                                    }
                                  }

                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    dismissSlashCommand()
                                    return
                                  }
                                }

                                if (
                                  selectedBlockRange &&
                                  selectedBlockCount > 1 &&
                                  isSelected &&
                                  !event.altKey &&
                                  !event.metaKey &&
                                  !event.ctrlKey &&
                                  event.key === 'Tab'
                                ) {
                                  event.preventDefault()
                                  adjustSelectedBlocksDepth(
                                    event.shiftKey ? -1 : 1,
                                    index,
                                    event.currentTarget.selectionStart ?? event.currentTarget.value.length
                                  )
                                  return
                                }

                                if (event.key === 'Tab' && isNestableBlock(block.type)) {
                                  event.preventDefault()
                                  adjustBlockDepth(
                                    index,
                                    event.shiftKey ? -1 : 1,
                                    event.currentTarget.selectionStart ?? event.currentTarget.value.length
                                  )
                                  return
                                }

                                if (
                                  selectedBlockRange &&
                                  selectedBlockCount > 1 &&
                                  isSelected &&
                                  !event.shiftKey &&
                                  !event.altKey &&
                                  !event.metaKey &&
                                  !event.ctrlKey &&
                                  (event.key === 'Backspace' || event.key === 'Delete') &&
                                  (event.currentTarget.selectionStart ?? 0) === (event.currentTarget.selectionEnd ?? 0)
                                ) {
                                  event.preventDefault()
                                  deleteSelectedBlocks()
                                  return
                                }

                                if (
                                  event.key === 'Enter' &&
                                  !event.shiftKey &&
                                  !event.altKey &&
                                  !event.metaKey &&
                                  !event.ctrlKey &&
                                  ['heading-1', 'heading-2', 'todo', 'bulleted-list', 'numbered-list'].includes(block.type)
                                ) {
                                  event.preventDefault()
                                  continueBlockAt(
                                    index,
                                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                    event.currentTarget.selectionEnd ?? event.currentTarget.value.length
                                  )
                                  return
                                }

                                if (
                                  event.key === 'Backspace' &&
                                  !event.shiftKey &&
                                  !event.altKey &&
                                  !event.metaKey &&
                                  !event.ctrlKey &&
                                  (event.currentTarget.selectionStart ?? 0) === 0 &&
                                  (event.currentTarget.selectionEnd ?? 0) === 0 &&
                                  ['heading-1', 'heading-2', 'todo', 'quote', 'bulleted-list', 'numbered-list'].includes(block.type)
                                ) {
                                  event.preventDefault()
                                  downgradeBlockAt(index)
                                  return
                                }

                                if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
                                  event.preventDefault()
                                  if (selectedBlockRange && isSelected) {
                                    duplicateSelectedBlocks()
                                  } else {
                                    duplicateDraftBlock(index)
                                  }
                                  return
                                }

                                if (event.altKey && event.key === 'Enter') {
                                  event.preventDefault()
                                  splitDraftBlock(
                                    index,
                                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                    event.currentTarget.selectionEnd ?? event.currentTarget.value.length
                                  )
                                  return
                                }

                                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                                  event.preventDefault()
                                  insertDraftBlockAt(index + 1, index)
                                }
                              }}
                              onKeyUp={(event) => captureBlockCursor(index, event.currentTarget)}
                              onSelect={(event) => captureBlockCursor(index, event.currentTarget)}
                              rows={block.type === 'code' ? 5 : block.type === 'math' ? 3 : 2}
                              value={block.content}
                            />
                          )}
                          <div className="block-editor-actions">
                            <button
                              className={`secondary-button block-select-button${isSelected ? ' block-select-button-active' : ''}`}
                              onClick={(event) => selectBlockRange(index, event.shiftKey)}
                              type="button"
                            >
                              {isSelected ? 'Selected' : 'Select'}
                            </button>
                            {block.type === 'todo' ? (
                              <label className="block-todo-toggle">
                                <input
                                  checked={block.checked}
                                  onChange={(event) => updateDraftBlock(index, { checked: event.target.checked })}
                                  type="checkbox"
                                />
                                <span>{block.checked ? 'Checked' : 'Unchecked'}</span>
                              </label>
                            ) : null}
                            {isNestableBlock(block.type) ? (
                              <>
                                <span className="block-depth-indicator">Depth {block.depth}</span>
                                <button className="secondary-button block-insert-button" onClick={() => adjustBlockDepth(index, -1)} type="button">
                                  Outdent
                                </button>
                                <button className="secondary-button block-insert-button" onClick={() => adjustBlockDepth(index, 1)} type="button">
                                  Indent
                                </button>
                              </>
                            ) : null}
                            {block.type !== 'divider' ? (
                              <button className="secondary-button block-insert-button" onClick={() => insertChildDraftBlock(index)} type="button">
                                + Child
                              </button>
                            ) : null}
                            <button className="secondary-button block-insert-button" onClick={() => insertDraftBlockAt(index, index)} type="button">
                              + Above
                            </button>
                            <button className="secondary-button block-insert-button" onClick={() => insertDraftBlockAt(index + 1, index)} type="button">
                              + Below
                            </button>
                            <button
                              className="secondary-button block-insert-button"
                              disabled={getPreviousSiblingSubtreeStartIndex(draftBlocks, index) === null}
                              onClick={() => moveDraftBlockBySibling(index, -1)}
                              type="button"
                            >
                              Move Up
                            </button>
                            <button
                              className="secondary-button block-insert-button"
                              disabled={getNextSiblingSubtreeStartIndex(draftBlocks, index) === null}
                              onClick={() => moveDraftBlockBySibling(index, 1)}
                              type="button"
                            >
                              Move Down
                            </button>
                            <button className="secondary-button block-insert-button" onClick={() => duplicateDraftBlock(index)} type="button">
                              Duplicate
                            </button>
                            <button className="danger-button" onClick={() => removeDraftBlock(index)} type="button">
                              Remove
                            </button>
                          </div>
                          {dropPreview ? (
                            <div
                              className="block-drop-preview"
                              style={{ marginInlineStart: `${dropPreview.effectiveDepth * BLOCK_INDENT_SIZE}px` }}
                            >
                              <span className="block-drop-preview-badge">{dropPreview.positionLabel}</span>
                              <span className="block-drop-preview-meta">
                                Depth {dropPreview.effectiveDepth} · {dropPreview.parentText ? `Child of ${dropPreview.parentText}` : 'Root level'}
                              </span>
                            </div>
                          ) : null}
                          </div>
                        )
                      })}
                      <button className="secondary-button" onClick={addDraftBlock} type="button">
                        Add block
                      </button>
                      <DraftBlockTreeOutline blocks={draftBlocks} />
                      {activeSlashContext ? (
                        <div className="link-helper-panel">
                          <p className="panel-label">Slash Commands</p>
                          <p className="mini-hint">Current query: {activeSlashContext.query || '(all commands)'}</p>
                          <div className="relation-list">
                            {filteredSlashCommands.length > 0 ? (
                              filteredSlashCommands.map((command, commandIndex) => (
                                <button
                                  className={`relation-chip${activeSlashCommand?.id === command.id ? ' relation-chip-active' : ''}`}
                                  key={`slash-${command.id}`}
                                  onClick={() => applySlashCommand(command)}
                                  onMouseEnter={() => setSelectedSlashCommandIndex(commandIndex)}
                                  type="button"
                                >
                                  <strong>/{command.id}</strong>
                                  <span>{command.label}</span>
                                  <small>{command.description}</small>
                                </button>
                              ))
                            ) : (
                              <p className="empty-text">No matching commands.</p>
                            )}
                          </div>
                          <p className="mini-hint">Use Up/Down to navigate, Tab or Enter to confirm, and Escape to dismiss.</p>
                        </div>
                      ) : activeLinkContext ? (
                        <div className="link-helper-panel">
                          <p className="panel-label">Link Suggestions</p>
                          <p className="mini-hint">Current query: {activeLinkContext.query || '(all documents)'}</p>
                          <div className="relation-list">
                            {linkSuggestions.length > 0 ? (
                              linkSuggestions.map((suggestion) => (
                                <button className="relation-chip" key={`suggestion-${suggestion.id}`} onClick={() => insertLinkSuggestion(suggestion)} type="button">
                                  <strong>{suggestion.title}</strong>
                                  <span>{suggestion.path}</span>
                                </button>
                              ))
                            ) : (
                              <p className="empty-text">No matching documents.</p>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="mini-hint">Type / for block commands, use # / ## / &gt; / - / 1. / - [ ] / - [x] / $$ / --- / ``` for markdown shortcuts, paste multi-line text to split it into multiple blocks, or paste over a selected block range to replace the whole slice, use Select then Shift + Select to create a contiguous multi-block range, convert the selected slice from the toolbar, copy the selected slice as blocks or plain text from the toolbar, or use Ctrl/Cmd + C/X/Shift + D, Delete/Backspace, Alt + ArrowUp/ArrowDown, and Tab / Shift+Tab for block-sequence copy, cut, duplicate, delete, keyboard move, and keyboard nesting, use /child or the Child button to append nested child blocks, press Enter to continue headings/lists/todos, Tab or Shift+Tab to indent list-like blocks, drag blocks left or right while moving to adjust list nesting and preview the resulting parent/depth, Backspace at block start to downgrade format, Ctrl/Cmd + Shift + D to duplicate, Alt + Enter to split at cursor, [[文档名]] or [[路径]] to create a bidirectional link, and press Ctrl/Cmd + Enter to insert a block below.</p>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="block-preview-list">
                        {selectedDocument.blocks.map((block, index) => (
                          <div className="block-preview" key={block.id}>
                            {renderBlock(block, setSelectedDocumentId, documentReferences, (checked) => toggleTodoBlockChecked(index, checked))}
                          </div>
                        ))}
                      </div>
                      <BlockTreeOutline blocks={selectedDocument.blocks} />
                    </>
                  )}
                </div>

                <div className="relation-grid">
                  <RelationList
                    title="Children"
                    emptyText="No child documents yet"
                    links={selectedDocument.children.map((child) => ({
                      id: child.id,
                      title: child.title,
                      path: child.path,
                      label: 'child'
                    }))}
                    onSelect={setSelectedDocumentId}
                  />
                  <RelationList
                    title="Outgoing links"
                    emptyText="No outgoing links yet"
                    links={selectedDocument.outgoingLinks}
                    onSelect={setSelectedDocumentId}
                  />
                  <RelationList
                    title="Backlinks"
                    emptyText="No backlinks yet"
                    links={selectedDocument.backlinks}
                    onSelect={setSelectedDocumentId}
                  />
                </div>

                <div className="preview-section">
                  <p className="panel-label">Ask AI</p>
                  <div className="ai-panel">
                    <textarea
                      className="editor-textarea"
                      onChange={(event) => setAiPromptDraft(event.target.value)}
                      placeholder="例如：基于当前文档，给我 3 条结构优化建议"
                      rows={3}
                      value={aiPromptDraft}
                    />
                    <button className="secondary-button" disabled={aiAsking || !aiPromptDraft.trim()} onClick={askAiOnSelectedDocument} type="button">
                      {aiAsking ? 'Thinking...' : 'Ask AI'}
                    </button>
                    {aiAnswer ? <pre className="ai-answer">{aiAnswer}</pre> : null}
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-preview">
                <p>Select a document from the tree or recent list to inspect its blocks and relationships.</p>
              </div>
            )}
          </article>
        </section>

        <section className="detail-grid">
          <article className="panel large-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Storage</p>
                <h3>SQLite and nested markdown backup</h3>
              </div>
              {loading ? <span className="pill">Loading...</span> : <span className="pill">Ready</span>}
            </div>
            <dl className="meta-grid">
              <div>
                <dt>Database path</dt>
                <dd>{homeData.summary.databasePath || 'Initializing...'}</dd>
              </div>
              <div>
                <dt>Backup root</dt>
                <dd>{homeData.summary.backupRoot || 'Initializing...'}</dd>
              </div>
              <div>
                <dt>Last backup</dt>
                <dd>{homeData.summary.lastBackupAt ? new Date(homeData.summary.lastBackupAt).toLocaleString() : 'Not yet exported'}</dd>
              </div>
              <div>
                <dt>AI endpoint</dt>
                <dd>{homeData.aiConfig.baseUrl}</dd>
              </div>
            </dl>
          </article>

          <article className="panel large-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Recent documents</p>
                <h3>Seeded from the bootstrap store</h3>
              </div>
            </div>

            <div className="document-list">
              {homeData.recentDocuments.map((document) => (
                <button className="document-row document-button" key={document.id} onClick={() => setSelectedDocumentId(document.id)} type="button">
                  <div>
                    <strong>{document.title}</strong>
                    <p>{document.path}</p>
                  </div>
                  <div className="document-meta">
                    <span>{document.blockCount} blocks</span>
                    <span>{new Date(document.updatedAt).toLocaleDateString()}</span>
                  </div>
                </button>
              ))}
            </div>
          </article>
        </section>
      </main>
    </div>
  )
}

function DocumentTree({
  nodes,
  selectedDocumentId,
  onSelect,
  draggingDocumentId,
  dragOverDocumentId,
  onDragStart,
  onDragEnd,
  onDragOverNode,
  onDropOnNode
}: {
  nodes: DocumentTreeNode[]
  selectedDocumentId: string | null
  onSelect: (documentId: string) => void
  draggingDocumentId: string | null
  dragOverDocumentId: string | null
  onDragStart: (documentId: string) => void
  onDragEnd: () => void
  onDragOverNode: (documentId: string) => void
  onDropOnNode: (documentId: string) => Promise<void>
}) {
  return (
    <ul className="tree-list">
      {nodes.map((node) => (
        <li className="tree-node" key={node.id}>
          <button
            className={`tree-button${selectedDocumentId === node.id ? ' tree-button-active' : ''}${dragOverDocumentId === node.id ? ' tree-button-drag-over' : ''}`}
            onClick={() => onSelect(node.id)}
            type="button"
            draggable
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
            <span>{node.title}</span>
            <small>{new Date(node.updatedAt).toLocaleDateString()}</small>
          </button>
          <p className="tree-path">{node.path}</p>
          {node.children.length > 0 ? (
            <div className="tree-children">
              <DocumentTree
                nodes={node.children}
                selectedDocumentId={selectedDocumentId}
                onSelect={onSelect}
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

function WorkspaceGraph({
  nodes,
  edges,
  selectedDocumentId,
  onSelect
}: {
  nodes: WorkspaceGraphNode[]
  edges: WorkspaceGraphEdge[]
  selectedDocumentId: string | null
  onSelect: (documentId: string) => void
}) {
  const width = 920
  const height = 320
  const layout = buildGraphLayout(nodes, width, height)
  const positionMap = new Map(layout.map((node) => [node.id, node]))

  return (
    <div className="graph-surface">
      <svg className="graph-svg" viewBox={`0 0 ${width} ${height}`}>
        {edges.map((edge, index) => {
          const source = positionMap.get(edge.sourceId)
          const target = positionMap.get(edge.targetId)
          if (!source || !target) {
            return null
          }

          return (
            <line
              className={`graph-edge graph-edge-${edge.kind}`}
              key={`edge-${edge.kind}-${index}`}
              x1={source.x}
              x2={target.x}
              y1={source.y}
              y2={target.y}
            />
          )
        })}

        {layout.map((node) => (
          <g className="graph-node-group" key={node.id} onClick={() => onSelect(node.id)}>
            <circle
              className={`graph-node${selectedDocumentId === node.id ? ' graph-node-active' : ''}`}
              cx={node.x}
              cy={node.y}
              r={selectedDocumentId === node.id ? 12 : 9}
            />
            <text className="graph-node-label" textAnchor="middle" x={node.x} y={node.y + 24}>
              {node.title}
            </text>
          </g>
        ))}
      </svg>
      <div className="graph-legend">
        <span><i className="legend-swatch legend-swatch-tree" /> Tree edge</span>
        <span><i className="legend-swatch legend-swatch-link" /> Reference link</span>
      </div>
    </div>
  )
}

function DocumentCatalogTable({
  documents,
  onSelect,
  selectedDocumentId
}: {
  documents: DocumentCatalogEntry[]
  onSelect: (documentId: string) => void
  selectedDocumentId: string | null
}) {
  return (
    <div className="catalog-table-wrap">
      <table className="catalog-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Path</th>
            <th>Blocks</th>
            <th>Links</th>
            <th>Children</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr
              className={selectedDocumentId === document.id ? 'catalog-row-active' : ''}
              key={document.id}
              onClick={() => onSelect(document.id)}
            >
              <td>
                <strong>{document.title}</strong>
                <p className="catalog-summary">{document.summary}</p>
              </td>
              <td>{document.path}</td>
              <td>{document.blockCount}</td>
              <td>{document.linkCount}</td>
              <td>{document.childCount}</td>
              <td>{new Date(document.updatedAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DocumentBoard({
  columns,
  onSelect,
  selectedDocumentId
}: {
  columns: Array<{ id: string; title: string; items: DocumentCatalogEntry[] }>
  onSelect: (documentId: string) => void
  selectedDocumentId: string | null
}) {
  return (
    <div className="board-wrap">
      {columns.map((column) => (
        <section className="board-column" key={column.id}>
          <div className="board-column-head">
            <strong>{column.title}</strong>
            <span>{column.items.length}</span>
          </div>

          <div className="board-card-list">
            {column.items.map((document) => (
              <button
                className={`board-card${selectedDocumentId === document.id ? ' board-card-active' : ''}`}
                key={document.id}
                onClick={() => onSelect(document.id)}
                type="button"
              >
                <strong>{document.title}</strong>
                <p>{document.path}</p>
                <div className="board-card-meta">
                  <span>{document.blockCount} blocks</span>
                  <span>{document.linkCount} links</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function RelationList({
  title,
  links,
  emptyText,
  onSelect
}: {
  title: string
  links: LinkedDocument[]
  emptyText: string
  onSelect: (documentId: string) => void
}) {
  return (
    <section className="relation-panel">
      <p className="panel-label">{title}</p>
      {links.length > 0 ? (
        <div className="relation-list">
          {links.map((link) => (
            <button className="relation-chip" key={`${title}-${link.id}`} onClick={() => onSelect(link.id)} type="button">
              <strong>{link.title}</strong>
              <span>{link.path}</span>
              <small>{link.label}</small>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-text">{emptyText}</p>
      )}
    </section>
  )
}

type BlockTreePreviewNode = {
  id: string
  type: string
  content: string
  depth: number
  children: BlockTreePreviewNode[]
}

function BlockTreeOutline({ blocks }: { blocks: DocumentBlock[] }) {
  const roots = buildBlockTree(blocks)

  return (
    <div className="block-tree-panel">
      <div className="panel-head compact-head">
        <div>
          <p className="panel-label">Block tree</p>
          <h4>Saved hierarchy</h4>
        </div>
        <div className="toolbar-inline">
          <span className="pill">{blocks.length} nodes</span>
          <span className="pill">parent_block_id</span>
        </div>
      </div>
      {roots.length > 0 ? <BlockTreeList nodes={roots} /> : <p className="empty-text">No block relationships yet.</p>}
    </div>
  )
}

function DraftBlockTreeOutline({ blocks }: { blocks: DocumentBlockDraft[] }) {
  const roots = buildDraftBlockTree(blocks)

  return (
    <div className="block-tree-panel">
      <div className="panel-head compact-head">
        <div>
          <p className="panel-label">Draft tree</p>
          <h4>Draft hierarchy</h4>
        </div>
        <div className="toolbar-inline">
          <span className="pill">{blocks.length} nodes</span>
          <span className="pill">depth preview</span>
        </div>
      </div>
      {roots.length > 0 ? <BlockTreeList nodes={roots} /> : <p className="empty-text">No draft blocks yet.</p>}
    </div>
  )
}

function BlockTreeList({ nodes }: { nodes: BlockTreePreviewNode[] }) {
  return (
    <ul className="block-tree-list">
      {nodes.map((node) => (
        <li className="block-tree-item" key={node.id}>
          <div className="block-tree-node">
            <span className="block-tree-type">{getBlockTypeLabel(node.type)}</span>
            <span className="block-tree-text">{getBlockTreeText(node.type, node.content)}</span>
            <small className="block-tree-meta">depth {node.depth}</small>
          </div>
          {node.children.length > 0 ? (
            <div className="block-tree-children">
              <BlockTreeList nodes={node.children} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function renderBlock(
  block: DocumentBlock,
  onSelectDocument: (documentId: string) => void,
  references: Array<{ id: string; title: string; path: string }>,
  onToggleTodo?: (checked: boolean) => void
) {
  const indentStyle = isNestableBlock(block.type) ? { marginInlineStart: `${block.depth * BLOCK_INDENT_SIZE}px` } : undefined

  if (block.type === 'heading-1') {
    return <h4 className="block-heading"># {renderInlineContent(block.content, onSelectDocument, references)}</h4>
  }

  if (block.type === 'heading-2') {
    return <h5 className="block-heading">## {renderInlineContent(block.content, onSelectDocument, references)}</h5>
  }

  if (block.type === 'todo') {
    return (
      <label className={`block-todo${block.checked ? ' block-todo-checked' : ''}`} style={indentStyle}>
        <input checked={block.checked} onChange={(event) => onToggleTodo?.(event.target.checked)} type="checkbox" />
        <span>{renderInlineContent(block.content, onSelectDocument, references)}</span>
      </label>
    )
  }

  if (block.type === 'quote') {
    return <blockquote className="block-quote">{renderInlineContent(block.content, onSelectDocument, references)}</blockquote>
  }

  if (block.type === 'bulleted-list') {
    return <p className="block-bulleted-list" style={indentStyle}>- {renderInlineContent(block.content, onSelectDocument, references)}</p>
  }

  if (block.type === 'numbered-list') {
    return <p className="block-numbered-list" style={indentStyle}>1. {renderInlineContent(block.content, onSelectDocument, references)}</p>
  }

  if (block.type === 'divider') {
    return <hr className="block-divider" />
  }

  if (block.type === 'math') {
    return <div className="block-math" dangerouslySetInnerHTML={{ __html: renderMathBlock(block.content) }} />
  }

  if (block.type === 'code') {
    return <pre className="block-code">{block.content}</pre>
  }

  return <p className="block-paragraph">{renderInlineContent(block.content, onSelectDocument, references)}</p>
}

function flattenTree(nodes: DocumentTreeNode[], depth = 0): Array<{ id: string; title: string; depth: number }> {
  const flattened: Array<{ id: string; title: string; depth: number }> = []

  for (const node of nodes) {
    flattened.push({
      id: node.id,
      title: node.title,
      depth
    })
    flattened.push(...flattenTree(node.children, depth + 1))
  }

  return flattened
}

function getOpenLinkContext(content: string, cursorPosition: number): { query: string; start: number } | null {
  const safeCursor = Math.max(0, Math.min(cursorPosition, content.length))
  const beforeCursor = content.slice(0, safeCursor)
  const start = beforeCursor.lastIndexOf('[[')

  if (start === -1) {
    return null
  }

  const openSegment = beforeCursor.slice(start + 2)
  if (openSegment.includes(']]') || openSegment.includes('\n')) {
    return null
  }

  return {
    query: openSegment.trim(),
    start
  }
}

function getSlashCommandContext(content: string, cursorPosition: number): { query: string; start: number } | null {
  const safeCursor = Math.max(0, Math.min(cursorPosition, content.length))
  const beforeCursor = content.slice(0, safeCursor)
  const lineStart = beforeCursor.lastIndexOf('\n') + 1
  const lineBeforeCursor = beforeCursor.slice(lineStart)
  const trimmedStart = lineBeforeCursor.trimStart()

  if (!trimmedStart.startsWith('/')) {
    return null
  }

  if (trimmedStart.includes(' ')) {
    return null
  }

  return {
    query: trimmedStart.slice(1),
    start: lineStart + lineBeforeCursor.indexOf('/')
  }
}

function stripSlashCommand(content: string, start: number, cursorPosition: number) {
  const safeCursor = Math.max(0, Math.min(cursorPosition, content.length))
  const next = `${content.slice(0, start)}${content.slice(safeCursor)}`
  return next.trim() === '' ? '' : next
}

function normalizeBlockContentForType(type: string, content: string) {
  if (type === 'divider') {
    return ''
  }

  return content
}

function resolveMarkdownBlockShortcut(block: DocumentBlockDraft): DocumentBlockDraft | null {
  const { type, content } = block

  if (content === '---') {
    return buildBlockTypePatch('divider', '')
  }

  if (content.startsWith('## ')) {
    return buildBlockTypePatch('heading-2', content.slice(3).replace(/^\s/, ''))
  }

  if (content.startsWith('# ')) {
    return buildBlockTypePatch('heading-1', content.slice(2).replace(/^\s/, ''))
  }

  if (content.startsWith('$$ ')) {
    return buildBlockTypePatch('math', content.slice(3).replace(/^\s/, ''))
  }

  if (content.startsWith('- [x] ') || content.startsWith('- [X] ')) {
    return buildBlockTypePatch('todo', content.slice(6).replace(/^\s/, ''), true, block.depth)
  }

  if (content.startsWith('- [ ] ')) {
    return buildBlockTypePatch('todo', content.slice(6).replace(/^\s/, ''), false, block.depth)
  }

  if (content.startsWith('> ')) {
    return buildBlockTypePatch('quote', content.slice(2).replace(/^\s/, ''))
  }

  if (content.startsWith('- ')) {
    return buildBlockTypePatch('bulleted-list', content.slice(2).replace(/^\s/, ''), false, block.depth)
  }

  const orderedPrefix = content.match(/^\d+\.\s+/)?.[0]
  if (orderedPrefix) {
    return buildBlockTypePatch('numbered-list', content.slice(orderedPrefix.length).replace(/^\s/, ''), false, block.depth)
  }

  if (content.startsWith('```') && ['paragraph', 'heading-1', 'heading-2', 'todo', 'quote', 'bulleted-list', 'numbered-list', 'math'].includes(type)) {
    return buildBlockTypePatch('code', content.slice(3).replace(/^\s/, ''))
  }

  return null
}

function normalizePastedLineBlock(template: DocumentBlockDraft, content: string): DocumentBlockDraft {
  const draft = buildBlockTypePatch(template.type, content, template.checked, template.depth)
  return resolveMarkdownBlockShortcut(draft) ?? draft
}

function renderDraftBlockForClipboard(block: DocumentBlockDraft): string {
  const indent = '  '.repeat(Math.max(0, block.depth))

  if (block.type === 'heading-1') {
    return `# ${block.content}`
  }

  if (block.type === 'heading-2') {
    return `## ${block.content}`
  }

  if (block.type === 'todo') {
    return `${indent}- [${block.checked ? 'x' : ' '}] ${block.content}`
  }

  if (block.type === 'quote') {
    return block.content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
  }

  if (block.type === 'bulleted-list') {
    return `${indent}- ${block.content}`
  }

  if (block.type === 'numbered-list') {
    return `${indent}1. ${block.content}`
  }

  if (block.type === 'divider') {
    return '---'
  }

  if (block.type === 'math') {
    return ['$$', block.content, '$$'].join('\n')
  }

  if (block.type === 'code') {
    return ['```txt', block.content, '```'].join('\n')
  }

  return block.content
}

function renderDraftBlockAsPlainText(block: DocumentBlockDraft): string {
  if (block.type === 'todo') {
    return `${block.checked ? '[x]' : '[ ]'} ${block.content}`.trim()
  }

  if (block.type === 'divider') {
    return ''
  }

  return block.content
}

function serializeDraftBlockRange(blocks: DocumentBlockDraft[], range: BlockSelectionRange): string {
  return blocks
    .slice(range.start, range.end + 1)
    .map((block) => renderDraftBlockForClipboard(block))
    .join('\n\n')
}

function serializeDraftBlockRangeAsPlainText(blocks: DocumentBlockDraft[], range: BlockSelectionRange): string {
  return blocks
    .slice(range.start, range.end + 1)
    .map((block) => renderDraftBlockAsPlainText(block))
    .join('\n\n')
}

function looksLikeStructuredBlockPaste(text: string): boolean {
  return (
    /\n\s*\n/.test(text) ||
    /(^|\n)\s*```/.test(text) ||
    /(^|\n)\s*\$\$/.test(text) ||
    /(^|\n)##\s/.test(text) ||
    /(^|\n)#\s/.test(text) ||
    /(^|\n)>\s/.test(text) ||
    /(^|\n)\s*-\s\[[xX ]\]\s/.test(text) ||
    /(^|\n)\s*-\s/.test(text) ||
    /(^|\n)\s*\d+\.\s/.test(text) ||
    /(^|\n)\s*---\s*(\n|$)/.test(text)
  )
}

function adjustPastedBlocksDepth(blocks: DocumentBlockDraft[], targetDepth: number): DocumentBlockDraft[] {
  if (blocks.length === 0) {
    return blocks
  }

  const minDepth = Math.min(...blocks.map((block) => block.depth))
  if (minDepth === targetDepth) {
    return blocks
  }

  const depthDelta = targetDepth - minDepth
  return blocks.map((block) => ({
    ...block,
    depth: Math.max(0, block.depth + depthDelta)
  }))
}

function parseStructuredPastedBlocks(text: string): DocumentBlockDraft[] {
  const blocks: DocumentBlockDraft[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraphLines: string[] = []

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return
    }

    blocks.push(buildBlockTypePatch('paragraph', paragraphLines.join('\n')))
    paragraphLines = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed === '') {
      flushParagraph()
      continue
    }

    if (trimmed === '$$') {
      flushParagraph()
      const mathLines: string[] = []
      index += 1
      while (index < lines.length && lines[index].trim() !== '$$') {
        mathLines.push(lines[index])
        index += 1
      }
      blocks.push(buildBlockTypePatch('math', mathLines.join('\n')))
      continue
    }

    if (trimmed.startsWith('```')) {
      flushParagraph()
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      blocks.push(buildBlockTypePatch('code', codeLines.join('\n')))
      continue
    }

    if (trimmed === '---') {
      flushParagraph()
      blocks.push(buildBlockTypePatch('divider', ''))
      continue
    }

    const todoMatch = line.match(/^(\s*)-\s\[([xX ])\]\s+(.*)$/)
    if (todoMatch) {
      flushParagraph()
      blocks.push(buildBlockTypePatch('todo', todoMatch[3], todoMatch[2].toLowerCase() === 'x', Math.floor(todoMatch[1].length / 2)))
      continue
    }

    const bulletMatch = line.match(/^(\s*)-\s+(.*)$/)
    if (bulletMatch) {
      flushParagraph()
      blocks.push(buildBlockTypePatch('bulleted-list', bulletMatch[2], false, Math.floor(bulletMatch[1].length / 2)))
      continue
    }

    const numberedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/)
    if (numberedMatch) {
      flushParagraph()
      blocks.push(buildBlockTypePatch('numbered-list', numberedMatch[2], false, Math.floor(numberedMatch[1].length / 2)))
      continue
    }

    if (line.startsWith('## ')) {
      flushParagraph()
      blocks.push(buildBlockTypePatch('heading-2', line.slice(3).replace(/^\s/, '')))
      continue
    }

    if (line.startsWith('# ')) {
      flushParagraph()
      blocks.push(buildBlockTypePatch('heading-1', line.slice(2).replace(/^\s/, '')))
      continue
    }

    if (line.startsWith('$$ ')) {
      flushParagraph()
      blocks.push(buildBlockTypePatch('math', line.slice(3).replace(/^\s/, '')))
      continue
    }

    if (line.startsWith('> ')) {
      flushParagraph()
      const quoteLines = [line.slice(2)]
      while (index + 1 < lines.length && lines[index + 1].startsWith('> ')) {
        index += 1
        quoteLines.push(lines[index].slice(2))
      }
      blocks.push(buildBlockTypePatch('quote', quoteLines.join('\n')))
      continue
    }

    paragraphLines.push(line)
  }

  flushParagraph()
  return blocks
}

function renderMathBlock(content: string): string {
  return renderToString(content, {
    displayMode: true,
    throwOnError: false,
    strict: 'ignore'
  })
}

function buildDocumentReferences(nodes: DocumentTreeNode[]): Array<{ id: string; title: string; path: string }> {
  const references: Array<{ id: string; title: string; path: string }> = []

  for (const node of nodes) {
    references.push({
      id: node.id,
      title: node.title,
      path: node.path
    })
    references.push(...buildDocumentReferences(node.children))
  }

  return references
}

function renderInlineContent(
  content: string,
  onSelectDocument: (documentId: string) => void,
  references: Array<{ id: string; title: string; path: string }>
) {
  const segments: Array<string | { id: string; label: string }> = []
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g)
  let lastIndex = 0

  for (const match of matches) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      segments.push(content.slice(lastIndex, start))
    }

    const token = match[1]?.trim() ?? ''
    const target = resolveInlineReference(token, references)
    if (target) {
      segments.push({
        id: target.id,
        label: token
      })
    } else {
      segments.push(match[0])
    }

    lastIndex = start + match[0].length
  }

  if (lastIndex < content.length) {
    segments.push(content.slice(lastIndex))
  }

  if (segments.length === 0) {
    return content
  }

  return segments.map((segment, index) => {
    if (typeof segment === 'string') {
      return <span key={`text-${index}`}>{segment}</span>
    }

    return (
      <button className="inline-link" key={`link-${segment.id}-${index}`} onClick={() => onSelectDocument(segment.id)} type="button">
        [[{segment.label}]]
      </button>
    )
  })
}

function resolveInlineReference(token: string, references: Array<{ id: string; title: string; path: string }>) {
  const byPath = references.find((reference) => reference.path === token)
  if (byPath) {
    return byPath
  }

  const matchedByTitle = references.filter((reference) => reference.title === token)
  if (matchedByTitle.length === 1) {
    return matchedByTitle[0]
  }

  return null
}

function buildGraphLayout(nodes: WorkspaceGraphNode[], width: number, height: number) {
  if (nodes.length === 0) {
    return [] as Array<WorkspaceGraphNode & { x: number; y: number }>
  }

  const centerX = width / 2
  const centerY = height / 2
  const maxDepth = Math.max(...nodes.map((node) => node.depth), 0)
  const ringStep = maxDepth > 0 ? Math.min(72, 120 / maxDepth) : 0

  return nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2
    const radius = 38 + node.depth * (ringStep || 48)

    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    }
  })
}

function buildBoardColumns(documents: DocumentCatalogEntry[]) {
  const columnMap = new Map<string, { id: string; title: string; items: DocumentCatalogEntry[] }>()

  for (const document of documents) {
    const segments = document.path.split('/')
    const bucket = segments.length === 1 ? 'Root' : segments[segments.length - 2]
    const key = bucket.toLowerCase()
    if (!columnMap.has(key)) {
      columnMap.set(key, {
        id: key,
        title: bucket,
        items: []
      })
    }

    columnMap.get(key)?.items.push(document)
  }

  return [...columnMap.values()].map((column) => ({
    ...column,
    items: [...column.items].sort((left, right) => left.path.localeCompare(right.path))
  }))
}

function buildBlockTree(blocks: DocumentBlock[]): BlockTreePreviewNode[] {
  const nodeMap = new Map<string, BlockTreePreviewNode>()
  const roots: BlockTreePreviewNode[] = []

  for (const block of blocks) {
    nodeMap.set(block.id, {
      id: block.id,
      type: block.type,
      content: block.content,
      depth: block.depth,
      children: []
    })
  }

  for (const block of blocks) {
    const node = nodeMap.get(block.id)
    if (!node) {
      continue
    }

    const parent = block.parentBlockId ? nodeMap.get(block.parentBlockId) : null
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortOrderMap = new Map(blocks.map((block) => [block.id, block.sortOrder]))
  const sortNodes = (nodes: BlockTreePreviewNode[]) => {
    nodes.sort((left, right) => (sortOrderMap.get(left.id) ?? 0) - (sortOrderMap.get(right.id) ?? 0))
    nodes.forEach((node) => sortNodes(node.children))
  }

  sortNodes(roots)
  return roots
}

function buildDraftBlockTree(blocks: DocumentBlockDraft[]): BlockTreePreviewNode[] {
  const normalizedBlocks = normalizeDraftBlocks(blocks)
  const nodeMap = new Map<string, BlockTreePreviewNode>()
  const roots: BlockTreePreviewNode[] = []

  for (const block of normalizedBlocks) {
    if (!block.id) {
      continue
    }

    nodeMap.set(block.id, {
      id: block.id,
      type: block.type,
      content: block.content,
      depth: block.depth,
      children: []
    })
  }

  for (const block of normalizedBlocks) {
    if (!block.id) {
      continue
    }

    const node = nodeMap.get(block.id)
    if (!node) {
      continue
    }

    const parent = block.parentBlockId ? nodeMap.get(block.parentBlockId) : null
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortOrderMap = new Map(normalizedBlocks.map((block, index) => [block.id ?? `draft-${index}`, index]))
  const sortNodes = (nodes: BlockTreePreviewNode[]) => {
    nodes.sort((left, right) => (sortOrderMap.get(left.id) ?? 0) - (sortOrderMap.get(right.id) ?? 0))
    nodes.forEach((node) => sortNodes(node.children))
  }

  sortNodes(roots)

  return roots
}

function getBlockTypeLabel(type: string): string {
  switch (type) {
    case 'heading-1':
      return 'H1'
    case 'heading-2':
      return 'H2'
    case 'todo':
      return 'Todo'
    case 'code':
      return 'Code'
    case 'math':
      return 'Math'
    case 'quote':
      return 'Quote'
    case 'bulleted-list':
      return 'Bullet'
    case 'numbered-list':
      return 'Number'
    case 'divider':
      return 'Divider'
    default:
      return 'Text'
  }
}

function getBlockTreeText(type: string, content: string): string {
  if (type === 'divider') {
    return 'Horizontal divider'
  }

  const normalizedContent = content.trim()
  if (!normalizedContent) {
    return '(empty block)'
  }

  return normalizedContent.length > 72 ? `${normalizedContent.slice(0, 72)}...` : normalizedContent
}