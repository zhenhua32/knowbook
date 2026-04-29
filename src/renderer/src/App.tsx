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
    description: 'Insert a new paragraph block above the current block.',
    keywords: ['insert', 'before', 'up'],
    kind: 'action',
    action: 'insert-above'
  },
  {
    id: 'below',
    label: 'Insert Below',
    description: 'Insert a new paragraph block below the current block.',
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
    description: 'Move the current block one slot upward.',
    keywords: ['reorder', 'before', 'raise'],
    kind: 'action',
    action: 'move-up'
  },
  {
    id: 'down',
    label: 'Move Down',
    description: 'Move the current block one slot downward.',
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
    description: 'Clone the current block below the original.',
    keywords: ['copy', 'clone', 'repeat'],
    kind: 'action',
    action: 'duplicate'
  },
  {
    id: 'delete',
    label: 'Delete Block',
    description: 'Remove the current block from the draft.',
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

function buildBlockTypePatch(type: string, content: string, checked = false, depth = 0): DocumentBlockDraft {
  return {
    type,
    content: normalizeBlockContentForType(type, content),
    checked: type === 'todo' ? checked : false,
    depth: normalizeBlockDepth(type, depth)
  }
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

function moveBlockRange(blocks: DocumentBlockDraft[], range: BlockSelectionRange, delta: -1 | 1): DocumentBlockDraft[] {
  const movedBlocks = blocks.slice(range.start, range.end + 1)
  const next = [...blocks]
  next.splice(range.start, movedBlocks.length)
  next.splice(delta === -1 ? range.start - 1 : range.start + 1, 0, ...movedBlocks)
  return next
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

function toDraftBlock(block: Pick<DocumentBlock, 'type' | 'content' | 'checked' | 'depth'>): DocumentBlockDraft {
  return {
    type: block.type,
    content: block.content,
    checked: Boolean(block.checked),
    depth: normalizeBlockDepth(block.type, block.depth)
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

    function moveSelectedBlocks(delta: -1 | 1) {
      if (!selectedBlockRange) {
        return
      }

      if ((delta === -1 && selectedBlockRange.start === 0) || (delta === 1 && selectedBlockRange.end === draftBlocks.length - 1)) {
        return
      }

      setDraftBlocks((previous) => moveBlockRange(previous, selectedBlockRange, delta))
      setSelectedBlockRange({
        start: selectedBlockRange.start + delta,
        end: selectedBlockRange.end + delta
      })
      setSelectionAnchorBlockIndex((previous) => (previous === null ? null : previous + delta))
      setActiveBlockIndex((previous) => moveIndexAfterRangeMove(previous, selectedBlockRange, delta))
      setPendingFocusBlockIndex((previous) => moveIndexAfterRangeMove(previous, selectedBlockRange, delta))
      endBlockDrag()
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

  function insertDraftBlockAt(index: number) {
    const nextIndex = Math.max(0, Math.min(index, draftBlocks.length))
    clearBlockSelection()

    setDraftBlocks((previous) => {
      const next = [...previous]
      next.splice(nextIndex, 0, {
        type: 'paragraph',
        content: '',
        checked: false,
        depth: 0
      })
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

    const duplicated = {
      ...currentBlock,
      content: contentOverride ?? currentBlock.content,
      checked: currentBlock.type === 'todo' ? currentBlock.checked : false,
      depth: normalizeBlockDepth(currentBlock.type, currentBlock.depth)
    }

    setDraftBlocks((previous) => {
      const next = [...previous]
      next.splice(index + 1, 0, duplicated)
      if (contentOverride !== undefined) {
        next[index] = {
          ...next[index],
          content: contentOverride
        }
      }
      return next
    })
    setActiveBlockIndex(index + 1)
    setActiveCursorPosition(duplicated.content.length)
    setPendingFocusBlockIndex(index + 1)
    endBlockDrag()
  }

  function splitDraftBlock(index: number, selectionStart: number, selectionEnd = selectionStart, nextTypeOverride?: string) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
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

  function moveDraftSubtree(sourceIndex: number, targetIndex: number, targetDepth: number | null) {
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

    setActiveBlockIndex((previous) => {
      if (previous === null) {
        return previous
      }

      if (previous >= sourceIndex && previous <= subtreeEndIndex) {
        return insertionIndex + (previous - sourceIndex)
      }

      if (sourceIndex < insertionIndex && previous > subtreeEndIndex && previous <= targetIndex) {
        return previous - subtreeSize
      }

      if (sourceIndex > insertionIndex && previous >= insertionIndex && previous < sourceIndex) {
        return previous + subtreeSize
      }

      return previous
    })
    setPendingFocusBlockIndex((previous) => {
      if (previous === null) {
        return previous
      }

      if (previous >= sourceIndex && previous <= subtreeEndIndex) {
        return insertionIndex + (previous - sourceIndex)
      }

      if (sourceIndex < insertionIndex && previous > subtreeEndIndex && previous <= targetIndex) {
        return previous - subtreeSize
      }

      if (sourceIndex > insertionIndex && previous >= insertionIndex && previous < sourceIndex) {
        return previous + subtreeSize
      }

      return previous
    })
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
        next.splice(activeBlockIndex, 0, {
          type: 'paragraph',
          content: '',
          checked: false,
          depth: 0
        })
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
        next.splice(activeBlockIndex + 1, 0, {
          type: 'paragraph',
          content: '',
          checked: false,
          depth: 0
        })
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
      clearBlockSelection()
      const targetIndex =
        command.action === 'move-up'
          ? Math.max(0, activeBlockIndex - 1)
          : Math.min(draftBlocks.length - 1, activeBlockIndex + 1)

      setDraftBlocks((previous) => {
        const next = [...previous]
        const [moved] = next.splice(activeBlockIndex, 1)
        next.splice(targetIndex, 0, {
          ...moved,
          content: nextContent
        })
        return next
      })
      setActiveBlockIndex(targetIndex)
      setActiveCursorPosition(nextContent.length)
      setPendingFocusBlockIndex(targetIndex)
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
      clearBlockSelection()
      const nextIndex = draftBlocks.length > 1 ? Math.min(activeBlockIndex, draftBlocks.length - 2) : null
      setDraftBlocks((previous) => previous.filter((_, index) => index !== activeBlockIndex))
      setActiveBlockIndex(nextIndex)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(nextIndex)
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
    clearBlockSelection()
    setDraftBlocks((previous) => previous.filter((_, currentIndex) => currentIndex !== index))
    setActiveBlockIndex((previous) => {
      if (previous === null) {
        return previous
      }

      if (previous === index) {
        return null
      }

      if (previous > index) {
        return previous - 1
      }

      return previous
    })
    setPendingFocusBlockIndex(null)
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
                            <strong>{selectedBlockCount} block{selectedBlockCount === 1 ? '' : 's'} selected</strong>
                            <p className="mini-hint">
                              Rows {selectedBlockRange.start + 1}-{selectedBlockRange.end + 1}. Use Shift + Select to extend a contiguous range.
                            </p>
                          </div>
                          <div className="block-selection-actions">
                            <button
                              className="secondary-button"
                              disabled={selectedBlockRange.start === 0}
                              onClick={() => moveSelectedBlocks(-1)}
                              type="button"
                            >
                              Move Up
                            </button>
                            <button
                              className="secondary-button"
                              disabled={selectedBlockRange.end === draftBlocks.length - 1}
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
                            key={`${selectedDocument.id}-draft-${index}`}
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
                              onClick={(event) => captureBlockCursor(index, event.currentTarget)}
                              onFocus={(event) => captureBlockCursor(index, event.currentTarget)}
                              onKeyDown={(event) => {
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
                                  duplicateDraftBlock(index)
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
                                  insertDraftBlockAt(index + 1)
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
                            <button className="secondary-button block-insert-button" onClick={() => insertDraftBlockAt(index)} type="button">
                              + Above
                            </button>
                            <button className="secondary-button block-insert-button" onClick={() => insertDraftBlockAt(index + 1)} type="button">
                              + Below
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
                        <p className="mini-hint">Type / for block commands, use # / ## / &gt; / - / 1. / - [ ] / - [x] / $$ / --- / ``` for markdown shortcuts, paste multi-line text to split it into multiple blocks, use Select then Shift + Select to create a contiguous multi-block range, use /child or the Child button to append nested child blocks, press Enter to continue headings/lists/todos, Tab or Shift+Tab to indent list-like blocks, drag blocks left or right while moving to adjust list nesting and preview the resulting parent/depth, Backspace at block start to downgrade format, Ctrl/Cmd + Shift + D to duplicate, Alt + Enter to split at cursor, [[文档名]] or [[路径]] to create a bidirectional link, and press Ctrl/Cmd + Enter to insert a block below.</p>
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
  const roots: BlockTreePreviewNode[] = []
  const depthStack: Array<BlockTreePreviewNode | null> = []

  for (const [index, block] of blocks.entries()) {
    let effectiveDepth = normalizeBlockDepth(block.type, block.depth)
    while (effectiveDepth > 0 && !depthStack[effectiveDepth - 1]) {
      effectiveDepth -= 1
    }

    const node: BlockTreePreviewNode = {
      id: `draft-${index}`,
      type: block.type,
      content: block.content,
      depth: effectiveDepth,
      children: []
    }

    const parent = effectiveDepth > 0 ? depthStack[effectiveDepth - 1] : null
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }

    depthStack.length = effectiveDepth + 1
    depthStack[effectiveDepth] = node
  }

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