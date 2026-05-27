import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import type {
  BackupResult,
  BlockReferenceResult,
  DatabaseEntity,
  DatabaseSavedView,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  DocumentDatabase,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  DocumentDatabaseFieldValue,
  DocumentBlock,
  DocumentBlockDraft,
  DocumentCatalogEntry,
  DocumentDetail,
  DocumentSuggestion,
  DocumentTreeNode,
  GlobalSearchResult,
  HomeData,
  LinkedDocument,
  PluginDashboardCard,
  PluginDescriptor,
  PluginDocumentAction,
  PluginSettingDescriptor,
  PluginSettingValue,
  WorkspaceGraphEdge,
  WorkspaceGraphNode
} from '@shared/contracts'
import { detectCodeLanguage, normalizeCodeLanguage } from '@shared/code'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import {
  UI_LANGUAGE_SETTING_KEY,
  detectPreferredUiLanguage,
  getActiveUiText,
  getUiText,
  isUiLanguage,
  setActiveUiLanguage,
  type UiLanguage
} from './i18n'
import { WorkspaceGraph } from './components/WorkspaceGraph'
import { PageNavWithWorkspaceTree } from './components/PageNavWithWorkspaceTree'
import { isDefaultDocumentDatabase } from './components/database/databaseFieldUtils'
import { isNestableBlock, normalizeBlockDepth } from './utils/draftBlockShape'
import { useAiState } from './hooks/useAiState'
import { useBlockSearchState } from './hooks/useBlockSearchState'
import { useBlockSelectionState } from './hooks/useBlockSelectionState'
import { useBlockInputActions } from './hooks/useBlockInputActions'
import { useBlockCollapseState } from './hooks/useBlockCollapseState'
import { useBlockFocusState } from './hooks/useBlockFocusState'
import { useBlockDragState } from './hooks/useBlockDragState'
import { useDatabaseDerivedState } from './hooks/useDatabaseDerivedState'
import { useDatabaseColumnActions } from './hooks/useDatabaseColumnActions'
import { useDatabaseEntityActions } from './hooks/useDatabaseEntityActions'
import { useDatabaseEntityBulkActions } from './hooks/useDatabaseEntityBulkActions'
import { useDatabasePageActions } from './hooks/useDatabasePageActions'
import { useDatabaseWorkspaceActions } from './hooks/useDatabaseWorkspaceActions'
import { useDocumentCatalogDatabaseActions } from './hooks/useDocumentCatalogDatabaseActions'
import { useDocumentTodoActions } from './hooks/useDocumentTodoActions'
import { useWorkspaceBackupActions } from './hooks/useWorkspaceBackupActions'
import { useDocumentsBlockEditorPresentation } from './hooks/useDocumentsBlockEditorPresentation'
import { useDocumentsDetailPresentation } from './hooks/useDocumentsDetailPresentation'
import { useDocumentsLoadingOrchestration } from './hooks/useDocumentsLoadingOrchestration'
import { useDocumentsUiState } from './hooks/useDocumentsUiState'
import { useDatabaseSectionPresentation } from './hooks/useDatabaseSectionPresentation'
import { useHighlightedBlockState } from './hooks/useHighlightedBlockState'
import { useDocumentEditorState } from './hooks/useDocumentEditorState'
import { useEditorAssistState } from './hooks/useEditorAssistState'
import { useBlockDragDropActions } from './hooks/useBlockDragDropActions'
import { useGlobalDocumentSearch } from './hooks/useGlobalDocumentSearch'
import { useInlineReferenceNavigation } from './hooks/useInlineReferenceNavigation'
import { useMultiBlockActions } from './hooks/useMultiBlockActions'
import { useSlashCommandActions } from './hooks/useSlashCommandActions'
import { useBlockStructureActions } from './hooks/useBlockStructureActions'
import { useSingleBlockTreeActions } from './hooks/useSingleBlockTreeActions'
import { useDocumentNavigationState } from './hooks/useDocumentNavigationState'
import { usePluginManagement } from './hooks/usePluginManagement'
import { useSettingsState } from './hooks/useSettingsState'
import { useWorkspaceDocumentManagement } from './hooks/useWorkspaceDocumentManagement'
import { AISection } from './sections/AISection'
import { DatabaseSection } from './sections/DatabaseSection'
import { DashboardSettingsSection } from './sections/DashboardSettingsSection'
import { DocumentsSection } from './sections/DocumentsSection'
import { PluginsSection } from './sections/PluginsSection'

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
  recentEvents: [],
  documentCatalog: [],
  databaseColumns: [],
  aiConfig: {
    enabled: false,
    baseUrl: '',
    embeddingBaseUrl: '',
    model: '',
    embeddingModel: '',
    autoSummaryOnSave: false,
    hasApiKey: false,
    hasEmbeddingApiKey: false
  },
  documentTree: [],
  graph: {
    nodes: [],
    edges: []
  },
  initialDocumentId: null,
  plugins: [],
  pluginDashboardCards: [],
  pluginDocumentActions: [],
  pluginHost: {
    roots: [],
    writableRoot: null
  }
}

const BLOCK_INDENT_SIZE = 24
const BLOCK_DRAG_DEPTH_THRESHOLD = 72
const BOARD_GROUP_BY_PARENT = '__parent__'

type PageId = 'dashboard' | 'documents' | 'database' | 'graph' | 'ai' | 'plugins' | 'settings'
type DatabaseWorkspaceView = 'catalog' | 'standalone'
type StandaloneDatabaseEntityViewMode = DatabaseSavedViewLayoutMode
type DatabaseEntityFilterScope = '' | '__document__' | string
type DatabaseEntitySortMode = DatabaseSavedViewSortMode
const PAGE_ORDER: PageId[] = ['documents', 'dashboard', 'database', 'graph', 'ai', 'plugins', 'settings']

type BlockDropPreview = {
  positionLabel: string
  effectiveDepth: number
  parentText: string | null
}

type BlockSelectionRange = {
  start: number
  end: number
}

type DraftBlockUpdater = DocumentBlockDraft[] | ((previous: DocumentBlockDraft[]) => DocumentBlockDraft[])

type TreeAwareBlock = {
  id?: string
  parentBlockId?: string | null
  depth: number
}

function getNormalizedBlockId(block: TreeAwareBlock | undefined): string | null {
  return block?.id?.trim() ? block.id : null
}

function getNormalizedParentBlockId(block: TreeAwareBlock | undefined): string | null {
  return block?.parentBlockId?.trim() ? block.parentBlockId : null
}

function buildTreeAwareBlockIndexById(blocks: TreeAwareBlock[]): Map<string, number> {
  const indexById = new Map<string, number>()
  for (let index = 0; index < blocks.length; index += 1) {
    const blockId = getNormalizedBlockId(blocks[index])
    if (blockId) {
      indexById.set(blockId, index)
    }
  }
  return indexById
}

function isBlockDescendantOf(rootId: string, blocks: TreeAwareBlock[], candidateIndex: number, indexById: Map<string, number>): boolean {
  const candidate = blocks[candidateIndex]
  if (!candidate) {
    return false
  }

  const visitedParentIds = new Set<string>()
  let currentParentId = getNormalizedParentBlockId(candidate)

  while (currentParentId) {
    if (currentParentId === rootId) {
      return true
    }

    if (visitedParentIds.has(currentParentId)) {
      return false
    }

    visitedParentIds.add(currentParentId)
    const parentIndex = indexById.get(currentParentId)
    if (parentIndex === undefined || parentIndex >= candidateIndex) {
      return false
    }

    currentParentId = getNormalizedParentBlockId(blocks[parentIndex])
  }

  return false
}

function getBlockSubtreeEndIndex(blocks: TreeAwareBlock[], index: number) {
  const root = blocks[index]
  if (!root) {
    return index
  }

  const rootId = getNormalizedBlockId(root)
  if (!rootId) {
    let fallbackEndIndex = index
    for (let currentIndex = index + 1; currentIndex < blocks.length; currentIndex += 1) {
      if (blocks[currentIndex].depth <= root.depth) {
        break
      }

      fallbackEndIndex = currentIndex
    }

    return fallbackEndIndex
  }

  const indexById = buildTreeAwareBlockIndexById(blocks)

  let endIndex = index
  for (let currentIndex = index + 1; currentIndex < blocks.length; currentIndex += 1) {
    if (blocks[currentIndex].depth <= root.depth) {
      break
    }

    if (!isBlockDescendantOf(rootId, blocks, currentIndex, indexById)) {
      break
    }

    endIndex = currentIndex
  }

  return endIndex
}

function getPreviousSiblingSubtreeStartIndex(blocks: TreeAwareBlock[], index: number) {
  const root = blocks[index]
  if (!root) {
    return null
  }

  const rootParentBlockId = getNormalizedParentBlockId(root)

  for (let currentIndex = index - 1; currentIndex >= 0; currentIndex -= 1) {
    if (blocks[currentIndex].depth === root.depth) {
      if (getNormalizedParentBlockId(blocks[currentIndex]) === rootParentBlockId) {
        return currentIndex
      }
      continue
    }

    if (blocks[currentIndex].depth < root.depth) {
      break
    }
  }

  return null
}

function getNextSiblingSubtreeStartIndex(blocks: TreeAwareBlock[], index: number) {
  const root = blocks[index]
  if (!root) {
    return null
  }

  const rootParentBlockId = getNormalizedParentBlockId(root)
  const subtreeEndIndex = getBlockSubtreeEndIndex(blocks, index)
  for (let currentIndex = subtreeEndIndex + 1; currentIndex < blocks.length; currentIndex += 1) {
    if (blocks[currentIndex].depth === root.depth) {
      if (getNormalizedParentBlockId(blocks[currentIndex]) === rootParentBlockId) {
        return currentIndex
      }
      continue
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

function resolveDraftBlockRelationship(
  type: string,
  requestedDepth: number,
  requestedParentBlockId: string | null | undefined,
  id: string,
  resolvedDepthById: Map<string, number>,
  depthStack: Array<string | null>
) {
  const trimmedParentBlockId = requestedParentBlockId?.trim() ? requestedParentBlockId : null
  const explicitParentDepth = trimmedParentBlockId && trimmedParentBlockId !== id ? resolvedDepthById.get(trimmedParentBlockId) : undefined

  if (explicitParentDepth !== undefined) {
    const explicitDepth = normalizeBlockDepth(type, explicitParentDepth + 1)
    if (explicitDepth > explicitParentDepth) {
      return {
        depth: explicitDepth,
        parentBlockId: trimmedParentBlockId
      }
    }
  }

  let depth = normalizeBlockDepth(type, requestedDepth)
  while (depth > 0 && !depthStack[depth - 1]) {
    depth -= 1
  }

  return {
    depth,
    parentBlockId: depth > 0 ? depthStack[depth - 1] ?? null : null
  }
}

function normalizeDraftBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
  const seenIds = new Set<string>()
  const resolvedDepthById = new Map<string, number>()
  const depthStack: Array<string | null> = []

  return blocks.map((block) => {
    const requestedId = block.id?.trim() ? block.id : null
    const id = requestedId && !seenIds.has(requestedId) ? requestedId : createDraftBlockId()
    seenIds.add(id)

    const type = block.type.trim() || 'paragraph'
    const checked = type === 'todo' ? Boolean(block.checked) : false

    const { depth, parentBlockId } = resolveDraftBlockRelationship(
      type,
      block.depth ?? 0,
      block.parentBlockId,
      id,
      resolvedDepthById,
      depthStack
    )

    depthStack.length = depth + 1
    depthStack[depth] = id
    resolvedDepthById.set(id, depth)

    return {
      ...block,
      id,
      type,
      checked,
      language: type === 'code' ? (detectCodeLanguage(block.content, block.language) ?? undefined) : undefined,
      depth,
      parentBlockId
    }
  })
}

function buildBlockTypePatch(type: string, content: string, checked = false, depth = 0, parentBlockId?: string | null): DocumentBlockDraft {
  return {
    type,
    content: normalizeBlockContentForType(type, content),
    checked: type === 'todo' ? checked : false,
    depth: normalizeBlockDepth(type, depth),
    parentBlockId: isNestableBlock(type) ? (parentBlockId?.trim() ? parentBlockId : null) : null
  }
}

function materializeDraftFragment(blocks: DocumentBlockDraft[], rootParentBlockId: string | null): DocumentBlockDraft[] {
  if (blocks.length === 0) {
    return blocks
  }

  const minDepth = Math.min(...blocks.map((block) => normalizeBlockDepth(block.type, block.depth)))
  const depthStack: Array<string | null> = []

  return blocks.map((block) => {
    const id = createDraftBlockId()
    const depth = normalizeBlockDepth(block.type, block.depth)
    const parentBlockId = isNestableBlock(block.type)
      ? depth === minDepth
        ? rootParentBlockId
        : depthStack[depth - 1] ?? rootParentBlockId
      : null

    depthStack.length = depth + 1
    depthStack[depth] = id

    return {
      ...block,
      id,
      checked: block.type === 'todo' ? Boolean(block.checked) : false,
      depth,
      parentBlockId
    }
  })
}

function resolveDraftInsertionPlacement(
  blocks: DocumentBlockDraft[],
  insertionIndex: number,
  type: string,
  requestedDepth: number
): { depth: number; parentBlockId: string | null; parentText: string | null } {
  const resolvedDepthById = new Map<string, number>()
  const depthStack: Array<string | null> = []
  const textById = new Map<string, string>()
  const boundedInsertionIndex = Math.max(0, Math.min(insertionIndex, blocks.length))

  for (let index = 0; index < boundedInsertionIndex; index += 1) {
    const block = blocks[index]
    const id = getNormalizedBlockId(block) ?? `__insertion-context-${index}`
    const { depth, parentBlockId } = resolveDraftBlockRelationship(
      block.type,
      block.depth,
      block.parentBlockId,
      id,
      resolvedDepthById,
      depthStack
    )

    depthStack.length = depth + 1
    depthStack[depth] = id
    resolvedDepthById.set(id, depth)
    textById.set(id, getBlockTreeText(block.type, block.content))
  }

  const placement = resolveDraftBlockRelationship(type, requestedDepth, null, '__insertion-candidate__', resolvedDepthById, depthStack)

  return {
    ...placement,
    parentText: placement.parentBlockId ? textById.get(placement.parentBlockId) ?? null : null
  }
}

function shiftDraftFragmentDepth(
  blocks: DocumentBlockDraft[],
  depthDelta: number,
  rootParentBlockId: string | null,
  rootIds: Set<string>
): DocumentBlockDraft[] {
  return blocks.map((block) => {
    const blockId = getNormalizedBlockId(block)
    const isRoot = blockId ? rootIds.has(blockId) : false

    if (!isNestableBlock(block.type)) {
      return isRoot
        ? {
            ...block,
            parentBlockId: null
          }
        : block
    }

    return {
      ...block,
      depth: normalizeBlockDepth(block.type, block.depth + depthDelta),
      parentBlockId: isRoot ? rootParentBlockId : block.parentBlockId ?? null
    }
  })
}

function validateBlockTreeStructure(blocks: DocumentBlockDraft[]): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (blocks.length === 0) {
    return { valid: true, errors: [] }
  }

  const knownIds = new Set(blocks.map((block) => block.id).filter((id): id is string => Boolean(id)))
  const seenIds = new Set<string>()
  const resolvedDepthById = new Map<string, number>()
  const resolvedTypeById = new Map<string, string>()

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    const blockId = getNormalizedBlockId(block)

    if (!blockId) {
      errors.push(`Block ${i}: missing block id`)
    } else if (seenIds.has(blockId)) {
      errors.push(`Block ${i}: duplicate ID "${blockId}"`)
    } else {
      seenIds.add(blockId)
    }

    if (block.depth < 0) {
      errors.push(`Block ${i}: negative depth ${block.depth}`)
    }

    if (block.depth > 6) {
      errors.push(`Block ${i}: depth ${block.depth} exceeds maximum 6`)
    }

    if (!isNestableBlock(block.type) && block.depth > 0) {
      errors.push(`Block ${i}: non-nestable type "${block.type}" has depth ${block.depth} > 0`)
    }

    const parentBlockId = getNormalizedParentBlockId(block)
    if (!isNestableBlock(block.type) && parentBlockId) {
      errors.push(`Block ${i}: non-nestable type "${block.type}" cannot have parentBlockId "${parentBlockId}"`)
    }

    if (parentBlockId) {
      if (!blockId) {
        errors.push(`Block ${i}: child block is missing its own id`)
      } else if (parentBlockId === blockId) {
        errors.push(`Block ${i}: parentBlockId cannot reference itself`)
      } else if (!knownIds.has(parentBlockId)) {
        errors.push(`Block ${i}: parentBlockId "${parentBlockId}" does not exist in this document`)
      } else if (!seenIds.has(parentBlockId)) {
        errors.push(`Block ${i}: parentBlockId "${parentBlockId}" must appear before the child in flat order`)
      } else {
        const parentDepth = resolvedDepthById.get(parentBlockId)
        const parentType = resolvedTypeById.get(parentBlockId)

        if (parentDepth === undefined) {
          errors.push(`Block ${i}: parentBlockId "${parentBlockId}" could not be resolved`)
        } else {
          if (block.depth !== parentDepth + 1) {
            errors.push(`Block ${i}: depth ${block.depth} does not match parent depth ${parentDepth} + 1`)
          }

          if (parentType && !isNestableBlock(parentType)) {
            errors.push(`Block ${i}: parentBlockId "${parentBlockId}" points to non-nestable type "${parentType}"`)
          }
        }
      }
    } else if (block.depth > 0) {
      errors.push(`Block ${i}: root block cannot have depth ${block.depth} without parentBlockId`)
    }

    if (blockId) {
      resolvedDepthById.set(blockId, block.depth)
      resolvedTypeById.set(blockId, block.type)
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
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
  const placement = resolveDraftInsertionPlacement(
    remainingBlocks,
    insertionIndex,
    rootBlock.type,
    targetDepth === null ? rootBlock.depth : targetDepth
  )

  return {
    positionLabel: sourceIndex < targetIndex ? 'Drop after' : 'Drop before',
    effectiveDepth: placement.depth,
    parentText: placement.parentText
  }
}

export function App() {
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(detectPreferredUiLanguage())
  const [uiLanguageHydrated, setUiLanguageHydrated] = useState(false)
  const [homeData, setHomeData] = useState<HomeData>(emptyState)
  const [catalogColumns, setCatalogColumns] = useState<DocumentDatabaseColumn[]>([])
  const [catalogDocuments, setCatalogDocuments] = useState<DocumentCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [activePage, setActivePage] = useState<PageId>('documents')
  const [catalogQuery, setCatalogQuery] = useState('')
  const deferredCatalogQuery = useDeferredValue(catalogQuery)
  const [databaseWorkspaceView, setDatabaseWorkspaceView] = useState<DatabaseWorkspaceView>('catalog')
  const [boardGroupBy, setBoardGroupBy] = useState(BOARD_GROUP_BY_PARENT)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  // 自动清除消息（3秒后）
  useEffect(() => {
    if (!backupMessage) return
    const timer = setTimeout(() => setBackupMessage(null), 3000)
    return () => clearTimeout(timer)
  }, [backupMessage])
  const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
  const [activeCursorPosition, setActiveCursorPosition] = useState<number>(0)
  const [isCreatingDatabaseColumn, setIsCreatingDatabaseColumn] = useState(false)
  const [databaseColumnNameDraft, setDatabaseColumnNameDraft] = useState('')
  const [databaseColumnTypeDraft, setDatabaseColumnTypeDraft] = useState<DocumentDatabaseColumnType>('text')
  const [databaseColumnOptionsDraft, setDatabaseColumnOptionsDraft] = useState('')
  const [databases, setDatabases] = useState<DocumentDatabase[]>([])
  const [selectedDatabaseColumns, setSelectedDatabaseColumns] = useState<DocumentDatabaseColumn[]>([])
  const [databaseEntities, setDatabaseEntities] = useState<DatabaseEntity[]>([])
  const [isCreatingDatabase, setIsCreatingDatabase] = useState(false)
  const [databaseNameDraft, setDatabaseNameDraft] = useState('')
  const [databaseDescriptionDraft, setDatabaseDescriptionDraft] = useState('')
  const [isCreatingDatabaseEntity, setIsCreatingDatabaseEntity] = useState(false)
  const [databaseEntityDatabaseId, setDatabaseEntityDatabaseId] = useState('')
  const [databaseSavedViews, setDatabaseSavedViews] = useState<DatabaseSavedView[]>([])
  const [activeDatabaseSavedViewId, setActiveDatabaseSavedViewId] = useState('')
  const [isCreatingDatabaseSavedView, setIsCreatingDatabaseSavedView] = useState(false)
  const [databaseSavedViewNameDraft, setDatabaseSavedViewNameDraft] = useState('')
  const [databaseEntityDocumentId, setDatabaseEntityDocumentId] = useState('')
  const [databaseEntityFieldValues, setDatabaseEntityFieldValues] = useState<Record<string, DocumentDatabaseFieldValue>>({})
  const [databaseEntityBulkFieldValues, setDatabaseEntityBulkFieldValues] = useState<Record<string, DocumentDatabaseFieldValue>>({})
  const [databaseEntityFilterQuery, setDatabaseEntityFilterQuery] = useState('')
  const [databaseEntityFilterScope, setDatabaseEntityFilterScope] = useState<DatabaseEntityFilterScope>('')
  const [databaseEntitySortMode, setDatabaseEntitySortMode] = useState<DatabaseEntitySortMode>('updated-desc')
  const [databaseEntityViewMode, setDatabaseEntityViewMode] = useState<StandaloneDatabaseEntityViewMode>('cards')
  const [selectedDatabaseEntityIds, setSelectedDatabaseEntityIds] = useState<string[]>([])
  const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const {
    clearMoveTarget,
    documentsAuxPanelOpen,
    moveTargetId,
    setMoveTargetId,
    toggleDocumentsAuxPanel
  } = useDocumentsUiState()
  const {
    dragOverBlockDepth,
    dragOverBlockIndex,
    draggingBlockIndex,
    endBlockDrag,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setDraggingBlockIndex
  } = useBlockDragState()
  const {
    flashHighlightedBlock,
    highlightedBlockId,
    setHighlightedBlockId
  } = useHighlightedBlockState()
  setActiveUiLanguage(uiLanguage)
  const ui = getUiText(uiLanguage)
  const {
    detailLoading,
    navBack,
    navCanGoBack,
    navCanGoForward,
    navForward,
    openDocumentBlockInDocumentsPage,
    openDocumentInDocumentsPage,
    pendingBlockNavigationTarget,
    pinnedDocumentIds,
    selectedDocument,
    selectedDocumentId,
    setDetailLoading,
    setPendingBlockNavigationTarget,
    setSelectedDocument,
    setSelectedDocumentId,
    togglePinDocument
  } = useDocumentNavigationState({
    onActivePageChange: (page) => setActivePage(page),
    onBeforeOpenDocument: () => setHighlightedBlockId(null)
  })
  const {
    autoSaveFlash,
    canRedo,
    canUndo,
    clearEditorSession,
    copyDocumentAsMarkdown,
    draftBlocks,
    draftSummary,
    draftTitle,
    isEditing,
    isSaving,
    loadDocumentIntoEditor,
    mdCopyFlash,
    pushToHistory,
    redoEdit,
    saveDocument,
    saveDocumentAsMarkdown,
    setDraftBlocks,
    setDraftSummary,
    setDraftTitle,
    setIsSaving,
    updateBlockHighlight,
    updateDraftBlock,
    undoEdit
  } = useDocumentEditorState({
    normalizeDraftBlocks,
    onHomeDataChange: setHomeData,
    onMessage: setBackupMessage,
    onSelectedDocumentChange: setSelectedDocument,
    selectedDocument,
    selectedDocumentId,
    ui,
    validateBlockTreeStructure
  })
  const {
    blockHasChildren,
    collapsedBlockIds,
    revealBlockAncestors,
    toggleBlockCollapse
  } = useBlockCollapseState({
    draftBlocks,
    getBlockSubtreeEndIndex
  })
  const {
    aiEnabledDraft,
    setAiEnabledDraft,
    aiBaseUrlDraft,
    setAiBaseUrlDraft,
    aiEmbeddingBaseUrlDraft,
    setAiEmbeddingBaseUrlDraft,
    aiModelDraft,
    setAiModelDraft,
    aiEmbeddingModelDraft,
    setAiEmbeddingModelDraft,
    aiAutoSummaryOnSaveDraft,
    setAiAutoSummaryOnSaveDraft,
    aiApiKeyDraft,
    setAiApiKeyDraft,
    aiEmbeddingApiKeyDraft,
    setAiEmbeddingApiKeyDraft,
    aiSaving,
    aiPromptDraft,
    setAiPromptDraft,
    aiAnswer,
    aiAsking,
    aiAutomationsRunning,
    aiContextResults,
    aiContextSearching,
    aiContextError,
    saveAiConfig,
    findRelatedNotesForPrompt,
    askAiOnSelectedDocument,
    runEnabledAiAutomationsOnSelectedDocument,
    resetAiSession
  } = useAiState({
    aiConfig: homeData.aiConfig,
    selectedDocumentId,
    ui,
    onHomeDataChange: setHomeData,
    onSelectedDocumentChange: setSelectedDocument,
    onDraftSummaryChange: setDraftSummary,
    onMessage: setBackupMessage
  })
  const {
    pluginBusyId,
    pluginSettingBusyKey,
    pluginSettingDrafts,
    pluginActionBusyKey,
    pluginInventoryBusy,
    updatePluginSettingDraft,
    setPluginEnabled,
    reloadPlugins,
    installPluginFromFolder,
    removePlugin,
    updatePluginSetting,
    reloadPlugin,
    runPluginDocumentAction
  } = usePluginManagement({
    plugins: homeData.plugins ?? [],
    selectedDocumentId,
    selectedDocument,
    ui,
    onHomeDataChange: setHomeData,
    onSelectedDocumentChange: setSelectedDocument,
    onDraftSummaryChange: setDraftSummary,
    onMessage: setBackupMessage
  })
  const {
    appUpdateState,
    appUpdateRefreshing,
    checkForAppUpdates,
    installAppUpdate
  } = useSettingsState({
    isSettingsPageActive: activePage === 'settings',
    ui,
    onMessage: setBackupMessage
  })
  const {
    activeLinkContext,
    activeSlashCommand,
    activeSlashContext,
    blockSuggestions,
    captureBlockCursor,
    clearEditorAssistSuggestions,
    filteredSlashCommands,
    insertBlockSuggestion,
    insertLinkSuggestion,
    linkSuggestions,
    setSelectedSlashCommandIndex,
    slashPanelPos
  } = useEditorAssistState({
    activeBlockIndex,
    activeCursorPosition,
    blockTextareaRefs,
    draftBlocks,
    isEditing,
    selectedDocumentId,
    selectedDocumentPresent: Boolean(selectedDocument),
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    uiLanguage
  })
  const {
    pendingFocusBlockIndex,
    setPendingFocusBlockIndex
  } = useBlockFocusState({
    activeCursorPosition,
    blockTextareaRefs,
    captureBlockCursor,
    draftBlocks
  })
  const {
    closeGlobalSearch,
    globalSearchLoading,
    globalSearchQuery,
    globalSearchResults,
    handleGlobalSearchNavigate,
    isGlobalSearchOpen,
    openGlobalSearch,
    updateGlobalSearchQuery
  } = useGlobalDocumentSearch({
    documentCatalog: homeData.documentCatalog,
    onOpenDocument: openDocumentInDocumentsPage
  })
  const {
    canMoveSelectedRange,
    canMoveSelectionDown,
    canMoveSelectionUp,
    clearBlockSelection,
    endBlockRangeSelection,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    getVisibleBlockCountInRange,
    getVisibleBlockEntries,
    getVisibleBlocks,
    getVisibleSiblingSelectionSlice,
    handleBlockMouseEnter,
    isBlockRangeSelecting,
    isBlockSelected,
    isSelectionCoherent,
    notifyBlockMouseDown,
    selectAllBlocks,
    selectBlockRange,
    selectedBlockActionCount,
    selectedBlockConversionType,
    selectedBlockCount,
    selectedBlockHasHiddenCollapsedContent,
    selectedBlockInteractionIssue,
    selectedBlockRange,
    selectedVisibleBlockCount,
    selectedVisibleSiblingSlice,
    selectionAnchorBlockId,
    setIsBlockRangeSelecting,
    setSelectedBlockConversionType,
    setSelectedBlockRange,
    setSelectionAnchorBlockId
  } = useBlockSelectionState({
    activeBlockIndex,
    collapsedBlockIds,
    draftBlocks,
    getBlockSubtreeEndIndex,
    getNextSiblingSubtreeStartIndex,
    getNormalizedBlockId,
    getNormalizedParentBlockId,
    getPreviousSiblingSubtreeStartIndex,
    onActiveBlockChange: setActiveBlockIndex,
    visibleSliceCrossParentGuard: ui.visibleSliceCrossParentGuard
  })
  useDocumentsLoadingOrchestration({
    clearEditorAssistSuggestions,
    clearEditorSession,
    clearMoveTarget,
    draftBlocks,
    endBlockDrag,
    flashHighlightedBlock,
    loadDocumentIntoEditor,
    pendingBlockNavigationTarget,
    resetAiSession,
    revealBlockAncestors,
    selectedDocument,
    selectedDocumentId,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setBackupMessage,
    setDetailLoading,
    setHighlightedBlockId,
    setPendingBlockNavigationTarget,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectedDocument,
    setSelectionAnchorBlockId,
    uiBlockReferenceNotFound: ui.blockReferenceNotFound
  })
  const {
    adjustSelectedBlocksDepth,
    convertSelectedBlocks,
    copySelectedBlocks,
    copySelectedBlocksAsPlainText,
    cutSelectedBlocks,
    deleteSelectedBlocks,
    duplicateSelectedBlocks,
    moveSelectedBlocks,
    removeSelectedBlockRange
  } = useMultiBlockActions({
    activeBlockIndex,
    activeCursorPosition,
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    getNextSiblingSubtreeStartIndex,
    getNormalizedBlockId,
    getNormalizedParentBlockId,
    getPreviousSiblingSubtreeStartIndex,
    getVisibleSiblingSelectionSlice,
    isNestableBlock,
    materializeDraftFragment,
    normalizeBlockDepth,
    pushToHistory,
    resolveDraftInsertionPlacement,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setBackupMessage,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectionAnchorBlockId,
    shiftDraftFragmentDepth,
    ui: {
      convertedBlocks: ui.convertedBlocks,
      copiedBlocks: ui.copiedBlocks,
      copiedPlainText: ui.copiedPlainText,
      copyFailed: ui.copyFailed,
      copyTextFailed: ui.copyTextFailed,
      cutBlocks: ui.cutBlocks,
      cutFailed: ui.cutFailed,
      deletedBlocks: ui.deletedBlocks,
      duplicatedBlocks: ui.duplicatedBlocks,
      invalidVisibleTreeSlice: ui.invalidVisibleTreeSlice
    }
  })
  const {
    duplicateDraftBlock,
    insertChildDraftBlock,
    insertDraftBlockAt,
    splitDraftBlock
  } = useBlockStructureActions({
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getNormalizedParentBlockId,
    materializeDraftFragment,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  })
  const {
    adjustBlockDepth,
    continueBlockAt,
    downgradeBlockAt,
    mergeWithPreviousBlock,
    moveDraftBlockBySibling,
    moveDraftSubtree
  } = useSingleBlockTreeActions({
    activeCursorPosition,
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getNextSiblingSubtreeStartIndex,
    getNormalizedBlockId,
    getPreviousSiblingSubtreeStartIndex,
    isNestableBlock,
    normalizeBlockDepth,
    pushToHistory,
    resolveDraftInsertionPlacement,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    shiftDraftFragmentDepth,
    splitDraftBlock,
    updateDraftBlock
  })
  const {
    addDraftBlock,
    applySlashCommand,
    dismissSlashCommand,
    removeDraftBlock
  } = useSlashCommandActions({
    activeBlockIndex,
    activeCursorPosition,
    activeSlashContext,
    adjustBlockDepth,
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    duplicateDraftBlock,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    insertChildDraftBlock,
    insertDraftBlockAt,
    moveDraftBlockBySibling,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    updateDraftBlock
  })
  const {
    beginBlockDrag,
    dropBlockAt,
    getDraggedBlockDepthPreview
  } = useBlockDragDropActions({
    blockDragDepthThreshold: BLOCK_DRAG_DEPTH_THRESHOLD,
    draftBlocks,
    dragOverBlockDepth,
    draggingBlockIndex,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    isNestableBlock,
    moveDraftSubtree,
    normalizeBlockDepth,
    pushToHistory,
    selectedBlockRange,
    setBackupMessage,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setDraggingBlockIndex
  })
  const {
    blockSearchItems,
    blockSearchQuery,
    closeBlockSearch,
    handleBlockSearchSelect,
    isBlockSearchOpen,
    openBlockSearch,
    setBlockSearchQuery
  } = useBlockSearchState({
    activeBlockIndex,
    draftBlocks,
    onSelectBlock: (blockIndex) => {
      setActiveBlockIndex(blockIndex)
      setPendingFocusBlockIndex(blockIndex)
    }
  })
  useEffect(() => {
    let mounted = true

    window.knowbook.getHomeData().then((data) => {
      if (mounted) {
        setHomeData(data)
        setLoading(false)
        setSelectedDocumentId((current) => current ?? data.initialDocumentId)
      }
    })

    window.knowbook.getDatabases().then((items) => {
      if (mounted) {
        setDatabases(items)
        setDatabaseEntityDatabaseId((current) => current || items[0]?.id || '')
      }
    })

    window.knowbook.getSetting(UI_LANGUAGE_SETTING_KEY).then((value) => {
      if (!mounted) {
        return
      }

      if (isUiLanguage(value)) {
        setUiLanguage(value)
      }
      setUiLanguageHydrated(true)
    })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    setCatalogColumns(homeData.databaseColumns)
    setCatalogDocuments(homeData.documentCatalog)
  }, [homeData.databaseColumns, homeData.documentCatalog])

  useEffect(() => {
    let mounted = true

    if (!databaseEntityDatabaseId) {
      setDatabaseSavedViews([])
      setActiveDatabaseSavedViewId('')
      setIsCreatingDatabaseSavedView(false)
      setDatabaseSavedViewNameDraft('')
      setSelectedDatabaseColumns([])
      setDatabaseEntities([])
      setDatabaseEntityFieldValues({})
      setDatabaseEntityBulkFieldValues({})
      setDatabaseEntityFilterQuery('')
      setDatabaseEntityFilterScope('')
      setDatabaseEntitySortMode('updated-desc')
      setDatabaseEntityViewMode('cards')
      setSelectedDatabaseEntityIds([])
      return () => {
        mounted = false
      }
    }

    setDatabaseSavedViews([])
    setActiveDatabaseSavedViewId('')
    setIsCreatingDatabaseSavedView(false)
    setDatabaseSavedViewNameDraft('')
    setDatabaseEntityFilterQuery('')
    setDatabaseEntityFilterScope('')
    setDatabaseEntitySortMode('updated-desc')
    setDatabaseEntityViewMode('cards')

    Promise.all([
      window.knowbook.getDatabaseEntities(databaseEntityDatabaseId),
      window.knowbook.getDocumentDatabaseColumns(databaseEntityDatabaseId),
      window.knowbook.getDatabaseSavedViews(databaseEntityDatabaseId)
    ]).then(([items, columns, views]) => {
      if (mounted) {
        setDatabaseEntities(items)
        setSelectedDatabaseColumns(columns)
        setDatabaseSavedViews(views)
        setDatabaseEntityFieldValues({})
        setDatabaseEntityBulkFieldValues({})
        setSelectedDatabaseEntityIds([])
      }
    })

    return () => {
      mounted = false
    }
  }, [databaseEntityDatabaseId])

  useEffect(() => {
    const nextStandaloneDatabases = databases.filter((database) => !isDefaultDocumentDatabase(database))

    if (nextStandaloneDatabases.length === 0) {
      if (databaseEntityDatabaseId) {
        setDatabaseEntityDatabaseId('')
      }
      return
    }

    if (!nextStandaloneDatabases.some((database) => database.id === databaseEntityDatabaseId)) {
      setDatabaseEntityDatabaseId(nextStandaloneDatabases[0].id)
    }
  }, [databaseEntityDatabaseId, databases])

  useEffect(() => {
    if (!databaseEntityFilterScope || databaseEntityFilterScope === '__document__') {
      return
    }

    if (!selectedDatabaseColumns.some((column) => column.id === databaseEntityFilterScope)) {
      setDatabaseEntityFilterScope('')
    }
  }, [databaseEntityFilterScope, selectedDatabaseColumns])

  useEffect(() => {
    const visibleEntityIdSet = new Set(filteredStandaloneDatabaseEntityIds)
    setSelectedDatabaseEntityIds((current) => {
      const next = current.filter((entityId) => visibleEntityIdSet.has(entityId))
      return next.length === current.length ? current : next
    })
  }, [databaseEntities, databaseEntityFilterQuery, databaseEntityFilterScope, databaseEntitySortMode, homeData.documentCatalog, selectedDatabaseColumns])

  useEffect(() => {
    document.documentElement.lang = uiLanguage
  }, [uiLanguage])

  useEffect(() => {
    if (!uiLanguageHydrated) {
      return
    }

    void window.knowbook.saveSetting(UI_LANGUAGE_SETTING_KEY, uiLanguage)
  }, [uiLanguage, uiLanguageHydrated])

  useEffect(() => {
    if (activePage !== 'documents') {
      closeGlobalSearch()
      closeBlockSearch()
    }
  }, [activePage, closeBlockSearch, closeGlobalSearch])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && /^[1-7]$/.test(event.key)) {
        const pageIndex = Number(event.key) - 1
        const targetPage = PAGE_ORDER[pageIndex]
        if (targetPage) {
          event.preventDefault()
          setActivePage(targetPage)
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        if (activePage !== 'documents') {
          return
        }

        event.preventDefault()
        if (isGlobalSearchOpen) {
          closeGlobalSearch()
        } else {
          openGlobalSearch()
        }
      }
      if (event.key === 'Escape' && isGlobalSearchOpen && activePage === 'documents') {
        closeGlobalSearch()
        return
      }
      if (event.key === 'Escape' && activePage === 'documents' && selectedBlockRange) {
        event.preventDefault()
        setIsBlockRangeSelecting(false)
        setSelectionAnchorBlockId(null)
        setSelectedBlockRange(null)
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z') {
        if (isEditing && activePage === 'documents') { event.preventDefault(); undoEdit() }
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
        if (isEditing && activePage === 'documents') { event.preventDefault(); redoEdit() }
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        if (activePage === 'documents') {
          event.preventDefault(); navBack()
        }
      }
      if (event.altKey && event.key === 'ArrowRight') {
        if (activePage === 'documents') {
          event.preventDefault(); navForward()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activePage, isGlobalSearchOpen, isEditing, navBack, navForward, redoEdit, selectedBlockRange, undoEdit])

  useEffect(() => {
    function handleMouseUp() {
      endBlockRangeSelection()
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleMouseUp)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleMouseUp)
    }
  }, [endBlockRangeSelection])

  // Auto-resize textareas to fit content
  useEffect(() => {
    if (!isEditing) return
    const textareas = blockTextareaRefs.current
    for (const textarea of textareas) {
      if (!textarea) continue
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
  }, [draftBlocks, isEditing])

  const {
    handleBackup,
    handleRestoreBackup,
    refreshWorkspaceAfterStorageMutation
  } = useWorkspaceBackupActions({
    selectedDocumentId,
    setBackupMessage,
    setHomeData,
    setSelectedDocument,
    setSelectedDocumentId,
    ui
  })

  const { toggleTodoBlockChecked } = useDocumentTodoActions({
    selectedDocument,
    setBackupMessage,
    setHomeData,
    setIsSaving,
    setSelectedDocument,
    todoUpdateFailedMessage: ui.todoUpdateFailed
  })

  const {
    createDatabase,
    deleteCurrentDatabase,
    switchDatabaseWorkspaceView
  } = useDatabaseWorkspaceActions({
    databaseEntityDatabaseId,
    databaseDescriptionDraft,
    databaseNameDraft,
    databases,
    setBackupMessage,
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setDatabaseDescriptionDraft,
    setDatabaseEntities,
    setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDatabaseId,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setDatabaseNameDraft,
    setDatabaseWorkspaceView,
    setDatabases,
    setIsCreatingDatabase,
    setIsCreatingDatabaseColumn,
    setIsCreatingDatabaseEntity,
    setSelectedDatabaseEntityIds,
    ui
  })

  const {
    beginCurrentDatabaseSavedViewCreation,
    cancelCurrentDatabaseSavedViewCreation,
    deleteCurrentDatabaseSavedView,
    handleDatabaseSavedViewSelect,
    refreshDatabasePageData,
    refreshDocumentCatalogData,
    saveCurrentDatabaseSavedView,
    updateCurrentDatabaseSavedView
  } = useDatabasePageActions({
    activeDatabaseSavedViewId,
    databaseEntityDatabaseId,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    databaseSavedViewNameDraft,
    databaseSavedViews,
    setActiveDatabaseSavedViewId,
    setBackupMessage,
    setCatalogColumns,
    setCatalogDocuments,
    setDatabaseEntities,
    setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode,
    setDatabaseEntityViewMode,
    setDatabaseSavedViewNameDraft,
    setDatabaseSavedViews,
    setHomeData,
    setIsCreatingDatabaseSavedView,
    setSelectedDatabaseColumns,
    setSelectedDatabaseEntityIds,
    ui
  })

  const {
    updateDocumentDatabaseValue
  } = useDocumentCatalogDatabaseActions({
    setBackupMessage,
    setCatalogDocuments,
    setHomeData
  })

  const {
    beginDrag,
    deleteSelectedDocument,
    dragOverBoardColumnId,
    dragOverRoot,
    draggingDocumentId,
    dropOnBoardTarget,
    dropOnDocument,
    dropToRoot,
    endDrag,
    handleBoardColumnDragOver,
    handleCreateDocument,
    handleRootDragLeave,
    handleRootDragOver,
    handleTreeNodeDragOver,
    moveSelectedDocument
  } = useWorkspaceDocumentManagement({
    catalogColumns,
    catalogDocuments,
    moveTargetId,
    onClearEditorSession: clearEditorSession,
    onDetailLoadingChange: setDetailLoading,
    onHomeDataChange: setHomeData,
    onMessage: setBackupMessage,
    onMoveTargetIdChange: setMoveTargetId,
    onSelectedDocumentChange: setSelectedDocument,
    onSelectedDocumentIdChange: setSelectedDocumentId,
    onUpdateDocumentDatabaseValue: updateDocumentDatabaseValue,
    selectedDocument,
    selectedDocumentId,
    ui
  })

  const {
    handleBlockContentChange,
    handleBlockPaste
  } = useBlockInputActions({
    buildBlockTypePatch,
    clearBlockSelection,
    detectCodeLanguage,
    draftBlocks,
    endBlockDrag,
    getMultiBlockOperationRange,
    getNormalizedParentBlockId,
    materializeDraftFragment,
    normalizeCodeLanguage,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    updateDraftBlock
  })

  const navigateInlineReferenceAtCursor = useInlineReferenceNavigation({
    documentTree: homeData.documentTree,
    draftBlocks,
    onOpenDocument: openDocumentInDocumentsPage,
    onOpenDocumentBlock: openDocumentBlockInDocumentsPage,
    selectedDocumentId,
    setBackupMessage,
    uiBlockReferenceNotFound: ui.blockReferenceNotFound
  })
  const plugins = homeData.plugins ?? []
  const pluginDashboardCards = homeData.pluginDashboardCards ?? []
  const pluginDocumentActions = homeData.pluginDocumentActions ?? []
  const pluginRoots = homeData.pluginHost?.roots ?? []
  const pluginWritableRoot = homeData.pluginHost?.writableRoot ?? null
  const {
    activeDatabaseSavedView,
    boardColumns,
    boardGroupableColumns,
    boardGroupingColumn,
    databasePageHint,
    databasePageTitle,
    databaseSavedViewDirty,
    filteredCatalog,
    filteredStandaloneDatabaseEntityIds,
    filteredStandaloneDatabaseEntityRows,
    selectedDatabase,
    selectedDatabaseEntityIdSet,
    selectedVisibleDatabaseEntitiesHaveLinkedDocument,
    selectedVisibleDatabaseEntityIds,
    standaloneDatabases
  } = useDatabaseDerivedState({
    activeDatabaseSavedViewId,
    boardGroupBy,
    catalogColumns,
    catalogDocuments,
    databaseEntities,
    databaseEntityDatabaseId,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    databaseSavedViews,
    databaseWorkspaceView,
    databases,
    deferredCatalogQuery,
    documentCatalog: homeData.documentCatalog,
    isDatabasePageActive: activePage === 'database',
    selectedDatabaseColumns,
    selectedDatabaseEntityIds,
    uiDocumentCatalogHint: ui.documentCatalogHint,
    uiDocumentCatalogTitle: ui.documentCatalogTitle,
    uiStandaloneDatabasesHint: ui.standaloneDatabasesHint,
    uiStandaloneDatabasesTitle: ui.standaloneDatabasesTitle
  })
  const {
    createDatabaseColumn,
    deleteDatabaseColumn,
    moveDatabaseColumn,
    renameDatabaseColumn,
    updateDatabaseColumnOptions
  } = useDatabaseColumnActions({
    databaseColumnNameDraft,
    databaseColumnOptionsDraft,
    databaseColumnTypeDraft,
    databaseWorkspaceView,
    refreshDatabasePageData,
    refreshDocumentCatalogData,
    selectedDatabase,
    setBackupMessage,
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setIsCreatingDatabaseColumn,
    ui
  })
  const {
    createDatabaseEntity,
    deleteDatabaseEntity,
    updateDatabaseEntityDocument,
    updateDatabaseEntityField
  } = useDatabaseEntityActions({
    databaseEntityDatabaseId,
    databaseEntityDocumentId,
    databaseEntityFieldValues,
    refreshDatabasePageData,
    setBackupMessage,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setIsCreatingDatabaseEntity,
    ui
  })
  const {
    applyDatabaseEntityFieldToSelected,
    clearDatabaseEntityFieldFromSelected,
    clearSelectedDatabaseEntityDocuments,
    deleteSelectedDatabaseEntities,
    selectVisibleDatabaseEntities,
    toggleDatabaseEntitySelection,
    updateDatabaseEntityBulkFieldValue
  } = useDatabaseEntityBulkActions({
    databaseEntityBulkFieldValues,
    databaseEntityDatabaseId,
    filteredStandaloneDatabaseEntityIds,
    refreshDatabasePageData,
    selectedVisibleDatabaseEntityIds,
    setBackupMessage,
    setDatabaseEntityBulkFieldValues,
    setSelectedDatabaseEntityIds,
    ui
  })
  const {
    board: databaseBoardProps,
    catalog: databaseCatalogProps,
    standalone: databaseStandaloneProps
  } = useDatabaseSectionPresentation({
    activeDatabaseSavedView,
    activeDatabaseSavedViewId,
    applyDatabaseEntityFieldToSelected,
    beginDrag,
    beginCurrentDatabaseSavedViewCreation,
    boardColumns,
    boardGroupBy,
    boardGroupableColumns,
    boardGroupingColumn,
    cancelCurrentDatabaseSavedViewCreation,
    catalogColumns,
    catalogQuery,
    clearDatabaseEntityFieldFromSelected,
    clearSelectedDatabaseEntityDocuments,
    createDatabase,
    createDatabaseColumn,
    createDatabaseEntity,
    databaseDescriptionDraft,
    databaseColumnNameDraft,
    databaseColumnOptionsDraft,
    databaseColumnTypeDraft,
    databaseEntities,
    databaseEntityBulkFieldValues,
    databaseEntityDatabaseId,
    databaseEntityDocumentId,
    databaseEntityFieldValues,
    databaseEntityFilterQuery,
    databaseEntityFilterScope,
    databaseEntitySortMode,
    databaseEntityViewMode,
    databaseNameDraft,
    databaseSavedViewDirty,
    databaseSavedViewNameDraft,
    databaseSavedViews,
    deleteCurrentDatabase,
    deleteCurrentDatabaseSavedView,
    deleteDatabaseColumn,
    deleteDatabaseEntity,
    deleteSelectedDatabaseEntities,
    dragOverBoardColumnId,
    draggingDocumentId,
    documentCatalog: homeData.documentCatalog,
    dropOnBoardTarget,
    endDrag,
    filteredCatalog,
    filteredStandaloneDatabaseEntityRows,
    handleDatabaseSavedViewSelect,
    handleBoardColumnDragOver,
    isCreatingDatabaseColumn,
    isCreatingDatabase,
    isCreatingDatabaseEntity,
    isCreatingDatabaseSavedView,
    moveDatabaseColumn,
    openDocumentInDocumentsPage,
    parentGroupValue: BOARD_GROUP_BY_PARENT,
    renameDatabaseColumn,
    saveCurrentDatabaseSavedView,
    selectVisibleDatabaseEntities,
    selectedDatabase,
    selectedDatabaseColumns,
    selectedDatabaseEntityIdSet,
    selectedEntitiesHaveLinkedDocument: selectedVisibleDatabaseEntitiesHaveLinkedDocument,
    selectedDocumentId,
    selectedVisibleDatabaseEntityIds,
    setBoardGroupBy,
    setCatalogQuery,
    setDatabaseDescriptionDraft,
    setDatabaseEntityBulkFieldValues,
    setDatabaseEntityDatabaseId,
    setDatabaseEntityDocumentId,
    setDatabaseEntityFieldValues,
    setDatabaseEntityFilterQuery,
    setDatabaseEntityFilterScope,
    setDatabaseEntitySortMode,
    setDatabaseEntityViewMode,
    setDatabaseColumnNameDraft,
    setDatabaseColumnOptionsDraft,
    setDatabaseColumnTypeDraft,
    setDatabaseNameDraft,
    setDatabaseSavedViewNameDraft,
    setIsCreatingDatabase,
    setIsCreatingDatabaseColumn,
    setIsCreatingDatabaseEntity,
    setSelectedDatabaseEntityIds,
    standaloneDatabases,
    toggleDatabaseEntitySelection,
    updateCurrentDatabaseSavedView,
    updateDatabaseColumnOptions,
    updateDatabaseEntityBulkFieldValue,
    updateDatabaseEntityDocument,
    updateDatabaseEntityField,
    updateDocumentDatabaseValue
  })
  const isZh = uiLanguage === 'zh-CN'
  const pageItems: Array<{ id: PageId; label: string; description: string }> = [
    {
      id: 'documents',
      label: isZh ? '文档' : 'Documents',
      description: isZh ? '目录树 + 编辑器' : 'Tree + editor'
    },
    {
      id: 'dashboard',
      label: isZh ? '总览' : 'Dashboard',
      description: isZh ? '工作区状态与统计' : 'Workspace summary'
    },
    {
      id: 'database',
      label: isZh ? '数据库' : 'Database',
      description: isZh ? '表格与看板视图' : 'Table + board views'
    },
    {
      id: 'graph',
      label: isZh ? '图谱' : 'Graph',
      description: isZh ? '知识关系拓扑' : 'Knowledge topology'
    },
    {
      id: 'ai',
      label: isZh ? 'AI 助手' : 'AI Assistant',
      description: isZh ? '问答与检索增强' : 'Q&A and semantic retrieval'
    },
    {
      id: 'plugins',
      label: isZh ? '插件中心' : 'Plugins',
      description: isZh ? '插件安装与管理' : 'Plugin management'
    },
    {
      id: 'settings',
      label: isZh ? '配置中心' : 'Settings',
      description: isZh ? '语言、AI、备份' : 'Language, AI, backup'
    }
  ]

  const pageTitle = pageItems.find((item) => item.id === activePage)?.label ?? ''
  const pageDescription = pageItems.find((item) => item.id === activePage)?.description ?? ''
  const {
    blockEditorRowSharedProps: documentsBlockEditorRowSharedProps,
    floatingSlashCommandPanelProps: documentsFloatingSlashCommandPanelProps,
    linkSuggestionPanelProps: documentsLinkSuggestionPanelProps,
    outlinePanelProps: documentsOutlinePanelProps,
    selectionToolbarProps: documentsSelectionToolbarProps,
    visibleEditorRows: visibleDocumentEditorRows
  } = useDocumentsBlockEditorPresentation({
    activeBlockIndex,
    activeLinkContext,
    activeSlashCommand,
    activeSlashContext,
    adjustBlockDepth,
    adjustSelectedBlocksDepth,
    applySlashCommand,
    beginBlockDrag,
    blockSuggestions,
    blockHasChildren,
    blockTextareaRefs,
    BLOCK_INDENT_SIZE,
    canMoveSelectedRange,
    canMoveSelectionDown,
    canMoveSelectionUp,
    captureBlockCursor,
    collapsedBlockIds,
    clearBlockSelection,
    continueBlockAt,
    convertSelectedBlocks,
    copySelectedBlocks,
    copySelectedBlocksAsPlainText,
    cutSelectedBlocks,
    deleteSelectedBlocks,
    dismissSlashCommand,
    draftBlocks,
    dragOverBlockDepth,
    dragOverBlockIndex,
    draggingBlockIndex,
    downgradeBlockAt,
    dropBlockAt,
    duplicateDraftBlock,
    duplicateSelectedBlocks,
    endBlockDrag,
    endBlockRangeSelection,
    filteredSlashCommands,
    getBlockDropPreview,
    getDraggedBlockDepthPreview,
    getMultiBlockOperationRange,
    getNextSiblingSubtreeStartIndex,
    getPreviousSiblingSubtreeStartIndex,
    getVisibleBlockCountInRange,
    getVisibleBlocks,
    handleBlockContentChange,
    handleBlockMouseEnter,
    handleBlockPaste,
    insertDraftBlockAt,
    insertBlockSuggestion,
    insertLinkSuggestion,
    isBlockRangeSelecting,
    isBlockSelected,
    isSelectionCoherent,
    isZh,
    linkSuggestions,
    mergeWithPreviousBlock,
    moveDraftBlockBySibling,
    moveSelectedBlocks,
    navigateInlineReferenceAtCursor,
    notifyBlockMouseDown,
    onSelectOutlineBlock: (blockIndex) => {
      setActiveBlockIndex(blockIndex)
      setPendingFocusBlockIndex(blockIndex)
    },
    removeSelectedBlockRange,
    selectAllBlocks,
    selectBlockRange,
    selectedBlockActionCount,
    selectedBlockCount,
    selectedBlockConversionType,
    selectedBlockHasHiddenCollapsedContent,
    selectedBlockInteractionIssue,
    selectedBlockRange,
    selectedDocument,
    selectedVisibleBlockCount,
    selectedVisibleSiblingSlice,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setSelectedBlockConversionType,
    setSelectedSlashCommandIndex,
    slashPanelPos,
    splitDraftBlock,
    toggleBlockCollapse,
    ui,
    updateBlockHighlight,
    updateDraftBlock
  })
  const {
    auxPanelProps: documentsAuxPanelProps,
    previewHeaderProps: documentsPreviewHeaderProps,
    relationGroups: documentsRelationGroups,
    statsBarProps: documentsStatsBarProps,
    summaryCardProps: documentsSummaryCardProps
  } = useDocumentsDetailPresentation({
    aiAnswer,
    aiAsking,
    aiAutomationsRunning,
    aiContextError,
    aiContextResults,
    aiContextSearching,
    aiEnabled: homeData.aiConfig.enabled,
    aiPromptDraft,
    autoSaveFlash,
    canRedo,
    canUndo,
    detailLoading,
    documentTree: homeData.documentTree,
    documentsAuxPanelOpen,
    draftBlocks,
    draftSummary,
    draftTitle,
    hasApiKey: homeData.aiConfig.hasApiKey,
    isZh,
    isSaving,
    mdCopyFlash,
    moveTargetId,
    onAddChild: () => {
      if (selectedDocument) {
        void handleCreateDocument(selectedDocument.id)
      }
    },
    onAiPromptChange: setAiPromptDraft,
    onAskAi: () => {
      void askAiOnSelectedDocument()
    },
    onCopyMarkdown: () => {
      void copyDocumentAsMarkdown()
    },
    onDelete: () => {
      void deleteSelectedDocument()
    },
    onFindRelatedNotes: () => {
      void findRelatedNotesForPrompt()
    },
    onMove: () => {
      void moveSelectedDocument()
    },
    onMoveTargetChange: setMoveTargetId,
    onOpenDocument: openDocumentInDocumentsPage,
    onRedo: redoEdit,
    onRunEnabledAutomations: () => {
      void runEnabledAiAutomationsOnSelectedDocument()
    },
    onRunPluginAction: (action) => {
      void runPluginDocumentAction(action)
    },
    onSave: () => {
      void saveDocument()
    },
    onSaveMarkdown: () => {
      void saveDocumentAsMarkdown()
    },
    onSummaryChange: setDraftSummary,
    onToggleAuxPanel: toggleDocumentsAuxPanel,
    onTogglePin: () => {
      if (selectedDocument) {
        togglePinDocument(selectedDocument.id)
      }
    },
    onTitleChange: setDraftTitle,
    onUndo: undoEdit,
    pinnedDocumentIds,
    pluginActionBusyKey,
    pluginDocumentActions,
    selectedDocument,
    selectedDocumentId,
    ui
  })

  useEffect(() => {
    if (boardGroupBy === BOARD_GROUP_BY_PARENT) {
      return
    }

    if (!boardGroupableColumns.some((column) => column.id === boardGroupBy)) {
      setBoardGroupBy(BOARD_GROUP_BY_PARENT)
    }
  }, [boardGroupBy, boardGroupableColumns])

return (
     <div className="shell" data-testid="shell">
       <div className="sidebar">
            <PageNavWithWorkspaceTree
            activePage={activePage}
            pageItems={pageItems}
            onSelectPage={(pageId) => setActivePage(pageId as PageId)}
            pageTitle={pageTitle}
            pageDescription={pageDescription}
            brandEyebrow={ui.brandEyebrow}
            navLabel={isZh ? '页面导航' : 'Navigation'}
            currentPageLabel={isZh ? '当前页面' : 'Current page'}
            currentPageHint={isZh ? '默认启动页为文档页，配置与特色功能已拆分到独立页面。' : 'Documents is now the default entry page, and feature modules are separated into dedicated pages.'}
            backTitle={`${ui.back} (Alt+←)`}
            forwardTitle={`${ui.forward} (Alt+→)`}
            rootsCountLabel={ui.rootsCount(homeData.documentTree.length)}
            onOpenGlobalSearch={openGlobalSearch}
            globalSearchTitle={`${ui.globalSearch} (Ctrl+K)`}
            onCreateRoot={() => { void handleCreateDocument(null) }}
            newRootLabel={ui.newRoot}
            dropToRootLabel={ui.dropToRoot}
            dragOverRoot={dragOverRoot}
            onRootDragOver={handleRootDragOver}
            onRootDragLeave={handleRootDragLeave}
             onDropToRoot={() => { void dropToRoot() }}
             pinnedSectionLabel={ui.pinnedSectionLabel}
             pinnedDocuments={homeData.documentCatalog.filter((document) => pinnedDocumentIds.has(document.id))}
             selectedDocumentId={selectedDocumentId}
             onSelectDocument={openDocumentInDocumentsPage}
             documentTreeNodes={homeData.documentTree}
             workspaceGraphNodes={homeData.graph.nodes}
             workspaceGraphEdges={homeData.graph.edges}
             navCanGoBack={navCanGoBack}
             navCanGoForward={navCanGoForward}
             onNavBack={navBack}
             onNavForward={navForward}
             onSelectGraphNode={openDocumentInDocumentsPage}
             onDragStart={beginDrag}
             onDragEnd={endDrag}
             onDragOverNode={handleTreeNodeDragOver}
             onDropOnNode={dropOnDocument}
             uiLanguage={uiLanguage}
             totalDocumentsCount={homeData.summary.documents}
           />
        </div>

        <main className={`content page-${activePage}`}>
        {activePage === 'dashboard' ? (
          <section className="hero">
            <div>
              <p className="eyebrow">{ui.workspaceStatusEyebrow}</p>
              <h2>{ui.workspaceStatusTitle}</h2>
              <p className="hero-copy">{ui.workspaceStatusBody}</p>
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <button className="secondary-button" onClick={handleRestoreBackup} type="button">
                {ui.restoreBackup}
              </button>
              <button className="primary-button" onClick={handleBackup} type="button">
                {ui.runBackupNow}
              </button>
            </div>
          </section>
        ) : null}

        {backupMessage ? (
          <p className="flash-message">
            {backupMessage}
            <button className="flash-close" onClick={() => setBackupMessage(null)} type="button">✕</button>
          </p>
        ) : null}

        {activePage === 'dashboard' ? (
          <section className="stats-grid">
            <article className="stat-card">
              <span className="stat-label">{ui.documentsLabel}</span>
              <strong>{homeData.summary.documents}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">{ui.blocksLabel}</span>
              <strong>{homeData.summary.blocks}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">{ui.linksLabel}</span>
              <strong>{homeData.summary.links}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">{ui.aiLabel}</span>
              <strong>{ui.aiReadyState(homeData.aiConfig.enabled)}</strong>
            </article>
          </section>
        ) : null}

        {activePage === 'dashboard' ? (
          <section className="detail-grid">
            <article className="panel large-panel">
              <div className="panel-head">
                <div>
                  <p className="panel-label">{ui.automationFeedLabel}</p>
                  <h3>{ui.recentEventsTitle}</h3>
                </div>
              </div>
              {homeData.recentEvents.length > 0 ? (
                <div className="event-feed">
                  {homeData.recentEvents.map((event) => (
                    <button
                      className="event-feed-item"
                      disabled={!event.documentId}
                      key={event.id}
                      onClick={() => {
                        if (event.documentId) {
                          openDocumentInDocumentsPage(event.documentId)
                        }
                      }}
                      type="button"
                    >
                      <div className="event-feed-head">
                        <strong>{event.title}</strong>
                        <span>{new Date(event.createdAt).toLocaleTimeString(ui.locale, { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <span className="event-feed-description">{event.description}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mini-hint">{ui.noAutomationEvents}</p>
              )}
            </article>
          </section>
        ) : null}

        {activePage === 'dashboard' && pluginDashboardCards.length > 0 ? (
          <section className="plugin-dashboard-grid">
            {pluginDashboardCards.map((card: PluginDashboardCard) => (
              <article className="panel plugin-dashboard-card" key={`${card.pluginId}:${card.id}`}>
                <div className="plugin-dashboard-head">
                  <p className="panel-label">{ui.pluginCardLabel}</p>
                  <span className="pill">{card.pluginId}</span>
                </div>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </section>
        ) : null}

         {activePage === 'graph' ? <section className="graph-grid" data-testid="graph-grid">
           <article className="panel graph-panel">
            <div className="panel-head compact-head">
              <div>
                <p className="panel-label">{ui.knowledgeGraphLabel}</p>
                <h3>{ui.knowledgeGraphTitle}</h3>
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
              onSelect={openDocumentInDocumentsPage}
            />
          </article>
        </section> : null}

         {activePage === 'database' ? (
           <DatabaseSection
             board={databaseBoardProps}
             catalog={databaseCatalogProps}
             databasePageHint={databasePageHint}
             databasePageTitle={databasePageTitle}
             databaseWorkspaceView={databaseWorkspaceView}
             onSwitchDatabaseWorkspaceView={switchDatabaseWorkspaceView}
             standalone={databaseStandaloneProps}
             ui={ui}
           />
         ) : null}

         {activePage === 'documents' ? (
           <DocumentsSection
             addBlockLabel={ui.addBlock}
             blockEditorRowSharedProps={documentsBlockEditorRowSharedProps}
             blockSearchPanelProps={{
               isOpen: isBlockSearchOpen,
               items: blockSearchItems,
               noMatchText: ui.noBlocksMatchSearch,
               onClose: closeBlockSearch,
               onQueryChange: setBlockSearchQuery,
               onSelect: handleBlockSearchSelect,
               placeholder: ui.searchBlocksPlaceholder,
               query: blockSearchQuery
             }}
             blocksPanelLabel={ui.blocksPanelLabel}
             documentStatsBarProps={documentsStatsBarProps}
             documentsAuxPanelProps={documentsAuxPanelProps}
             editorHelpText={ui.editorHelpText}
             emptyDocumentStateText={ui.emptyDocumentState}
             floatingSlashCommandPanelProps={documentsFloatingSlashCommandPanelProps}
             linkSuggestionPanelProps={documentsLinkSuggestionPanelProps}
             onAddBlock={addDraftBlock}
             onEditorKeyDown={(event) => {
               if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
                 event.preventDefault()
                 openBlockSearch()
               }
             }}
             outlinePanelProps={documentsOutlinePanelProps}
             previewHeaderProps={documentsPreviewHeaderProps}
             relationGroups={documentsRelationGroups}
             selectedDocument={selectedDocument}
             selectionToolbarProps={documentsSelectionToolbarProps}
             summaryCardProps={documentsSummaryCardProps}
             visibleEditorRows={visibleDocumentEditorRows}
           />
         ) : null}

        {activePage === 'ai' ? (
          <AISection
            aiAnswer={aiAnswer}
            aiAsking={aiAsking}
            aiAutomationsRunning={aiAutomationsRunning}
            aiContextError={aiContextError}
            aiContextResults={aiContextResults}
            aiContextSearching={aiContextSearching}
            aiEnabled={homeData.aiConfig.enabled}
            aiPromptDraft={aiPromptDraft}
            hasApiKey={homeData.aiConfig.hasApiKey}
            isZh={isZh}
            onAiPromptChange={setAiPromptDraft}
            onAskAi={() => {
              void askAiOnSelectedDocument()
            }}
            onFindRelatedNotes={() => {
              void findRelatedNotesForPrompt()
            }}
            onOpenDocument={openDocumentInDocumentsPage}
            onRunEnabledAutomations={() => {
              void runEnabledAiAutomationsOnSelectedDocument()
            }}
            selectedDocument={selectedDocument}
            ui={ui}
          />
        ) : null}

        {activePage === 'plugins' ? (
          <PluginsSection
            onInstallPluginFromFolder={() => {
              void installPluginFromFolder()
            }}
            onReloadPlugin={(plugin) => {
              void reloadPlugin(plugin)
            }}
            onReloadPlugins={() => {
              void reloadPlugins()
            }}
            onRemovePlugin={(plugin) => {
              void removePlugin(plugin)
            }}
            onSetPluginEnabled={(plugin, enabled) => {
              void setPluginEnabled(plugin, enabled)
            }}
            onUpdatePluginSetting={(plugin, setting, value) => {
              void updatePluginSetting(plugin, setting, value)
            }}
            onUpdatePluginSettingDraft={updatePluginSettingDraft}
            pluginBusyId={pluginBusyId}
            pluginInventoryBusy={pluginInventoryBusy}
            pluginRoots={pluginRoots}
            pluginSettingBusyKey={pluginSettingBusyKey}
            pluginSettingDrafts={pluginSettingDrafts}
            plugins={plugins}
            ui={ui}
          />
        ) : null}

        {activePage === 'dashboard' || activePage === 'settings' ? (
          <DashboardSettingsSection
            aiApiKeyDraft={aiApiKeyDraft}
            aiAutoSummaryOnSaveDraft={aiAutoSummaryOnSaveDraft}
            aiBaseUrlDraft={aiBaseUrlDraft}
            aiEmbeddingApiKeyDraft={aiEmbeddingApiKeyDraft}
            aiEmbeddingBaseUrlDraft={aiEmbeddingBaseUrlDraft}
            aiEmbeddingModelDraft={aiEmbeddingModelDraft}
            aiEnabledDraft={aiEnabledDraft}
            aiEndpoint={homeData.aiConfig.baseUrl}
            aiModelDraft={aiModelDraft}
            aiSaving={aiSaving}
            appUpdateRefreshing={appUpdateRefreshing}
            appUpdateState={appUpdateState}
            isSettingsPage={activePage === 'settings'}
            isZh={isZh}
            loading={loading}
            onAiApiKeyChange={setAiApiKeyDraft}
            onAiAutoSummaryOnSaveChange={setAiAutoSummaryOnSaveDraft}
            onAiBaseUrlChange={setAiBaseUrlDraft}
            onAiEmbeddingApiKeyChange={setAiEmbeddingApiKeyDraft}
            onAiEmbeddingBaseUrlChange={setAiEmbeddingBaseUrlDraft}
            onAiEmbeddingModelChange={setAiEmbeddingModelDraft}
            onAiEnabledChange={setAiEnabledDraft}
            onAiModelChange={setAiModelDraft}
            onBackupNow={() => {
              void handleBackup()
            }}
            onCheckForAppUpdates={() => {
              void checkForAppUpdates()
            }}
            onInstallAppUpdate={() => {
              void installAppUpdate()
            }}
            onOpenDocument={openDocumentInDocumentsPage}
            onOpenPlugins={() => {
              setActivePage('plugins')
            }}
            onRestoreBackup={() => {
              void handleRestoreBackup()
            }}
            onSaveAiConfig={() => {
              void saveAiConfig()
            }}
            onUiLanguageChange={setUiLanguage}
            recentDocuments={homeData.recentDocuments}
            summary={homeData.summary}
            ui={ui}
            uiLanguage={uiLanguage}
          />
        ) : null}
      </main>

      {activePage === 'documents' && isGlobalSearchOpen && (
        <div className="global-search-overlay" onClick={closeGlobalSearch}>
          <div className="global-search-modal" onClick={(e) => e.stopPropagation()}>
            <div className="global-search-header">
              <input
                autoFocus
                className="global-search-input"
                placeholder={ui.globalSearchPlaceholder}
                type="text"
                value={globalSearchQuery}
                onChange={(event) => {
                  void updateGlobalSearchQuery(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeGlobalSearch()
                }}
              />
              <button className="secondary-button" onClick={closeGlobalSearch} type="button">✕</button>
            </div>
            <div className="global-search-results">
              {globalSearchLoading && <p className="mini-hint">{ui.globalSearchLoading}</p>}
              {!globalSearchLoading && globalSearchQuery && globalSearchResults.length === 0 && (
                <p className="mini-hint">{ui.globalSearchNoResults}</p>
              )}
              {!globalSearchLoading && !globalSearchQuery && (
                <p className="mini-hint">{ui.globalSearchPrompt}</p>
              )}
              {globalSearchResults.map((result, idx) => (
                <button
                  className="global-search-result"
                  key={idx}
                  onClick={() => handleGlobalSearchNavigate(result)}
                  type="button"
                >
                  <div className="global-search-result-header">
                    <span className="global-search-doc-path">{result.documentPath}</span>
                    <span className={`global-search-match-badge ${result.matchType === 'title' ? 'global-search-match-title' : 'global-search-match-block'}`}>
                      {result.matchType === 'title' ? ui.titleMatchLabel : result.blockType ?? ui.blockMatchFallback}
                    </span>
                  </div>
                  <strong className="global-search-doc-title">{result.documentTitle}</strong>
                  {result.snippet && (
                    <p className="global-search-snippet">{result.snippet}</p>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function normalizeBlockContentForType(type: string, content: string) {
  if (type === 'divider') {
    return ''
  }

  return content
}

function getBlockTreeText(type: string, content: string): string {
  if (type === 'divider') {
    return getActiveUiText().horizontalDivider
  }

  const normalizedContent = content.trim()
  if (!normalizedContent) {
    return getActiveUiText().emptyBlock
  }

  return normalizedContent.length > 72 ? `${normalizedContent.slice(0, 72)}...` : normalizedContent
}