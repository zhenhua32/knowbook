import { renderToString } from 'katex'
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildBoardColumns,
  getBoardDropFieldValue,
  isBoardGroupableColumn,
  type BoardColumn,
  type BoardDropTarget
} from '@shared/board'
import type {
  AppUpdateState,
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
import { PageRail } from './components/PageRail'
import { DocumentsSidebar } from './components/DocumentsSidebar'
import { WorkspaceGraph } from './components/WorkspaceGraph'
import { PageNavWithWorkspaceTree } from './components/PageNavWithWorkspaceTree'
import { DocumentPreviewHeader } from './components/DocumentPreviewHeader'
import { DocumentsAuxPanel } from './components/DocumentsAuxPanel'
import { DocumentStatsBar } from './components/DocumentStatsBar'
import { DocumentSummaryCard } from './components/DocumentSummaryCard'
import { DocumentOutlinePanel } from './components/DocumentOutlinePanel'
import { BlockSearchPanel } from './components/BlockSearchPanel'
import { CrossDocumentBlockReference } from './components/BlockReference'
import {
  getInlineReferenceTokenAtCursor,
  renderInlineContent,
  renderStyledContent,
  parseMarkdownStyles,
  resolveInlineReference,
  resolveInlineReferenceTarget,
  resolveBlockReference
} from './components/InlineContentRenderer'
import { BlockSelectionToolbar } from './components/BlockSelectionToolbar'
import { SlashCommandPanel } from './components/SlashCommandPanel'
import { FloatingSlashCommandPanel } from './components/FloatingSlashCommandPanel'
import { LinkSuggestionPanel } from './components/LinkSuggestionPanel'
import { BlockEditorRow } from './components/BlockEditorRow'
import { CodeBlockPreview } from './components/CodeBlockPreview'
import { useAiState } from './hooks/useAiState'
import { usePluginManagement } from './hooks/usePluginManagement'
import { useSettingsState } from './hooks/useSettingsState'
import { AISection } from './sections/AISection'
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
const CATALOG_ROW_HEIGHT = 108
const CATALOG_ROW_OVERSCAN = 6

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

type PendingBlockNavigationTarget = {
  documentId: string
  blockId: string
}

type DraftBlockUpdater = DocumentBlockDraft[] | ((previous: DocumentBlockDraft[]) => DocumentBlockDraft[])

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

function getDatabaseColumnTypeLabel(type: DocumentDatabaseColumnType): string {
  return getActiveUiText().databaseColumnTypes[type]
}

function getBlockTypeOptionLabel(type: string): string {
  return getActiveUiText().blockTypeOptions[type] ?? type
}

function getBlockConversionLabel(type: string): string {
  return getActiveUiText().conversionOptions[type] ?? type
}

function isDefaultDocumentDatabase(database: DocumentDatabase): boolean {
  return database.name === 'Default' && database.description === 'Default database'
}

function buildBlockSlashCommands(language: UiLanguage): BlockSlashCommand[] {
  const ui = getUiText(language)

  return [
    {
      id: 'text',
      label: getBlockTypeOptionLabel('paragraph'),
      description: language === 'zh-CN' ? '把当前块转换为普通段落。' : 'Convert the current block into a plain paragraph.',
      keywords: ['paragraph', 'plain', 'p', 'text', '文本', '段落'],
      kind: 'type',
      type: 'paragraph'
    },
    {
      id: 'h1',
      label: getBlockTypeOptionLabel('heading-1'),
      description: language === 'zh-CN' ? '把当前块提升为一级标题。' : 'Promote this block to a top-level heading.',
      keywords: ['title', 'heading-1', 'header', '标题', '一级'],
      kind: 'type',
      type: 'heading-1'
    },
    {
      id: 'h2',
      label: getBlockTypeOptionLabel('heading-2'),
      description: language === 'zh-CN' ? '把当前块转换为二级标题。' : 'Convert this block to a section heading.',
      keywords: ['subtitle', 'heading-2', 'section', '标题', '二级'],
      kind: 'type',
      type: 'heading-2'
    },
    {
      id: 'todo',
      label: getBlockTypeOptionLabel('todo'),
      description: language === 'zh-CN' ? '把当前块转换为未勾选的待办项。' : 'Turn this block into an unchecked todo item.',
      keywords: ['task', 'checkbox', 'checklist', 'todo', '待办'],
      kind: 'type',
      type: 'todo'
    },
    {
      id: 'code',
      label: getBlockTypeOptionLabel('code'),
      description: language === 'zh-CN' ? '把当前块切换成代码块。' : 'Switch this block into a code block.',
      keywords: ['snippet', 'pre', 'terminal', 'code', '代码'],
      kind: 'type',
      type: 'code'
    },
    {
      id: 'math',
      label: getBlockTypeOptionLabel('math'),
      description: language === 'zh-CN' ? '把当前块渲染为 KaTeX 公式。' : 'Render this block as a KaTeX display equation.',
      keywords: ['latex', 'equation', 'formula', 'katex', '公式'],
      kind: 'type',
      type: 'math'
    },
    {
      id: 'quote',
      label: getBlockTypeOptionLabel('quote'),
      description: language === 'zh-CN' ? '把当前块转换为引用块。' : 'Convert this block into a quoted callout.',
      keywords: ['blockquote', 'callout', 'cite', 'quote', '引用'],
      kind: 'type',
      type: 'quote'
    },
    {
      id: 'bullet',
      label: getBlockTypeOptionLabel('bulleted-list'),
      description: language === 'zh-CN' ? '把当前块转换为无序列表项。' : 'Turn this block into a bulleted list item.',
      keywords: ['unordered', 'list', 'dash', 'bullet', '列表', '无序'],
      kind: 'type',
      type: 'bulleted-list'
    },
    {
      id: 'numbered',
      label: getBlockTypeOptionLabel('numbered-list'),
      description: language === 'zh-CN' ? '把当前块转换为有序列表项。' : 'Turn this block into an ordered list item.',
      keywords: ['ordered', 'list', 'number', '列表', '有序'],
      kind: 'type',
      type: 'numbered-list'
    },
    {
      id: 'divider',
      label: getBlockTypeOptionLabel('divider'),
      description: language === 'zh-CN' ? '插入一个水平分隔线块。' : 'Insert a horizontal divider block.',
      keywords: ['separator', 'rule', 'hr', 'divider', '分隔线'],
      kind: 'type',
      type: 'divider'
    },
    {
      id: 'above',
      label: language === 'zh-CN' ? '在上方插入' : 'Insert Above',
      description: language === 'zh-CN' ? '在当前块上方插入一个同级块。' : 'Insert a new sibling block above the current block.',
      keywords: ['insert', 'before', 'up', '上方', '插入'],
      kind: 'action',
      action: 'insert-above'
    },
    {
      id: 'below',
      label: language === 'zh-CN' ? '在下方插入' : 'Insert Below',
      description: language === 'zh-CN' ? '在当前块下方插入一个同级块。' : 'Insert a new sibling block below the current block.',
      keywords: ['insert', 'after', 'down', '下方', '插入'],
      kind: 'action',
      action: 'insert-below'
    },
    {
      id: 'child',
      label: language === 'zh-CN' ? '插入子块' : 'Insert Child',
      description: language === 'zh-CN' ? '在当前子树下方插入一个嵌套子块。' : 'Insert a nested child block below the current subtree.',
      keywords: ['child', 'sub-block', 'nested', 'descendant', '子块', '嵌套'],
      kind: 'action',
      action: 'insert-child'
    },
    {
      id: 'up',
      label: ui.moveUp,
      description: language === 'zh-CN' ? '把当前块子树移动到上一个同级子树之前。' : 'Move the current block subtree above the previous sibling subtree.',
      keywords: ['reorder', 'before', 'raise', '上移', '移动'],
      kind: 'action',
      action: 'move-up'
    },
    {
      id: 'down',
      label: ui.moveDown,
      description: language === 'zh-CN' ? '把当前块子树移动到下一个同级子树之后。' : 'Move the current block subtree below the next sibling subtree.',
      keywords: ['reorder', 'after', 'lower', '下移', '移动'],
      kind: 'action',
      action: 'move-down'
    },
    {
      id: 'indent',
      label: language === 'zh-CN' ? '增加缩进' : 'Indent Block',
      description: language === 'zh-CN' ? '增加待办和列表块的嵌套层级。' : 'Increase nesting for todo and list blocks.',
      keywords: ['nest', 'tab', 'right', 'depth', '缩进', '嵌套'],
      kind: 'action',
      action: 'indent'
    },
    {
      id: 'outdent',
      label: language === 'zh-CN' ? '减少缩进' : 'Outdent Block',
      description: language === 'zh-CN' ? '降低待办和列表块的嵌套层级。' : 'Decrease nesting for todo and list blocks.',
      keywords: ['shift-tab', 'left', 'unnest', 'depth', '取消缩进', '提升'],
      kind: 'action',
      action: 'outdent'
    },
    {
      id: 'duplicate',
      label: ui.duplicate,
      description: language === 'zh-CN' ? '在原块下方复制一份当前块子树。' : 'Clone the current block subtree below the original.',
      keywords: ['copy', 'clone', 'repeat', '复制', '克隆'],
      kind: 'action',
      action: 'duplicate'
    },
    {
      id: 'delete',
      label: ui.common.delete,
      description: language === 'zh-CN' ? '删除当前块子树。' : 'Remove the current block subtree.',
      keywords: ['remove', 'trash', 'del', 'delete', '删除'],
      kind: 'action',
      action: 'delete'
    }
  ]
}

function isNestableBlock(type: string) {
  return ['todo', 'bulleted-list', 'numbered-list'].includes(type)
}

function normalizeBlockDepth(type: string, depth: number) {
  return isNestableBlock(type) ? Math.max(0, Math.min(6, Math.trunc(depth))) : 0
}

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

function expandAncestorBlocks(
  blocks: TreeAwareBlock[],
  targetBlockId: string,
  collapsedBlockIds: Set<string>
): Set<string> {
  const nextCollapsedBlockIds = new Set(collapsedBlockIds)
  const indexById = buildTreeAwareBlockIndexById(blocks)
  const visitedParentIds = new Set<string>()
  let currentBlockId: string | null = targetBlockId

  while (currentBlockId) {
    if (visitedParentIds.has(currentBlockId)) {
      break
    }

    visitedParentIds.add(currentBlockId)
    const currentIndex = indexById.get(currentBlockId)
    if (currentIndex === undefined) {
      break
    }

    const parentBlockId = getNormalizedParentBlockId(blocks[currentIndex])
    if (!parentBlockId) {
      break
    }

    nextCollapsedBlockIds.delete(parentBlockId)
    currentBlockId = parentBlockId
  }

  return nextCollapsedBlockIds
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

function normalizeDatabaseColumnOptionsInput(input: string): string[] {
  return [...new Set(input.split(',').map((option) => option.trim()).filter(Boolean))]
}

function formatDocumentDatabaseFieldValueForSearch(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) {
    return value.join(' ')
  }

  if (typeof value === 'boolean') {
    return value ? 'checked true yes' : 'unchecked false no'
  }

  return value ?? ''
}

function formatDocumentDatabaseFieldValueForDraft(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) {
    return value.join(', ')
  }

  return typeof value === 'string' ? value : ''
}

function normalizeDocumentDatabaseFieldValue(value: DocumentDatabaseFieldValue): DocumentDatabaseFieldValue {
  if (Array.isArray(value)) {
    const normalizedValues = [...new Set(value.map((item) => item.trim()).filter(Boolean))]
    return normalizedValues.length > 0 ? normalizedValues : null
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim()
    return normalizedValue.length > 0 ? normalizedValue : null
  }

  return value
}

function areDocumentDatabaseFieldValuesEqual(left: DocumentDatabaseFieldValue, right: DocumentDatabaseFieldValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftValues = Array.isArray(left) ? [...left].sort() : []
    const rightValues = Array.isArray(right) ? [...right].sort() : []

    if (leftValues.length !== rightValues.length) {
      return false
    }

    return leftValues.every((value, index) => value === rightValues[index])
  }

  return left === right
}

function formatDocumentCatalogFieldValueForDisplay(value: DocumentDatabaseFieldValue): string {
  if (Array.isArray(value)) {
    return value.join(', ')
  }

  if (typeof value === 'boolean') {
    return value ? 'True' : 'False'
  }

  return value ?? ''
}

function compactDocumentDatabaseFieldValues(values: Record<string, DocumentDatabaseFieldValue>): Record<string, DocumentDatabaseFieldValue> {
  const compacted: Record<string, DocumentDatabaseFieldValue> = {}

  for (const [columnId, value] of Object.entries(values)) {
    const normalizedValue = normalizeDocumentDatabaseFieldValue(value)
    if (normalizedValue !== null) {
      compacted[columnId] = normalizedValue
    }
  }

  return compacted
}

function setDocumentCatalogFieldValue(
  entries: DocumentCatalogEntry[],
  documentId: string,
  columnId: string,
  value: DocumentDatabaseFieldValue
): { entries: DocumentCatalogEntry[]; previousValue: DocumentDatabaseFieldValue | undefined } {
  let previousValue: DocumentDatabaseFieldValue | undefined

  return {
    entries: entries.map((entry) => {
      if (entry.id !== documentId) {
        return entry
      }

      previousValue = entry.fieldValues[columnId]
      return {
        ...entry,
        fieldValues: {
          ...entry.fieldValues,
          [columnId]: value
        }
      }
    }),
    previousValue
  }
}

function restoreDocumentCatalogFieldValue(
  entries: DocumentCatalogEntry[],
  documentId: string,
  columnId: string,
  previousValue: DocumentDatabaseFieldValue | undefined
): DocumentCatalogEntry[] {
  return entries.map((entry) => {
    if (entry.id !== documentId) {
      return entry
    }

    const nextFieldValues = { ...entry.fieldValues }
    if (previousValue === undefined) {
      delete nextFieldValues[columnId]
    } else {
      nextFieldValues[columnId] = previousValue
    }

    return {
      ...entry,
      fieldValues: nextFieldValues
    }
  })
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

function buildBlockTypePatch(type: string, content: string, checked = false, depth = 0, parentBlockId?: string | null): DocumentBlockDraft {
  return {
    type,
    content: normalizeBlockContentForType(type, content),
    checked: type === 'todo' ? checked : false,
    depth: normalizeBlockDepth(type, depth),
    parentBlockId: isNestableBlock(type) ? (parentBlockId?.trim() ? parentBlockId : null) : null
  }
}

function buildSiblingDraftBlock(anchorBlock?: DocumentBlockDraft): DocumentBlockDraft {
  if (anchorBlock && isNestableBlock(anchorBlock.type)) {
    return buildBlockTypePatch(anchorBlock.type, '', false, anchorBlock.depth, anchorBlock.parentBlockId ?? null)
  }

  return buildBlockTypePatch('paragraph', '')
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

function getFragmentLocalRootIds(blocks: DocumentBlockDraft[]): Set<string> {
  const blockIds = new Set(blocks.map((block) => getNormalizedBlockId(block)).filter((id): id is string => Boolean(id)))
  const rootIds = new Set<string>()

  for (const block of blocks) {
    const blockId = getNormalizedBlockId(block)
    if (!blockId) {
      continue
    }

    const parentBlockId = getNormalizedParentBlockId(block)
    if (!parentBlockId || !blockIds.has(parentBlockId)) {
      rootIds.add(blockId)
    }
  }

  return rootIds
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

function getDefaultChildBlockType(type: string): DocumentBlock['type'] {
  if (type === 'todo') {
    return 'todo'
  }

  if (type === 'numbered-list') {
    return 'numbered-list'
  }

  return 'bulleted-list'
}

function canChangeBlockType(fromType: string, toType: string, hasChildren: boolean): boolean {
  if (!hasChildren) {
    return true
  }

  const fromNestable = isNestableBlock(fromType)
  const toNestable = isNestableBlock(toType)

  if (fromNestable && !toNestable) {
    console.warn(`Cannot convert nestable block type "${fromType}" to non-nestable type "${toType}" when it has child blocks.`)
    return false
  }

  return true
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

function normalizeBlockSelectionRange(start: number, end: number): BlockSelectionRange {
  return {
    start: Math.min(start, end),
    end: Math.max(start, end)
  }
}

function findAdjacentSiblingIndexForRange(blocks: DocumentBlockDraft[], range: BlockSelectionRange, delta: -1 | 1): number | null {
  if (!isValidSiblingRange(blocks, range)) {
    return null
  }

  const referenceBlock = blocks[range.start]
  if (!referenceBlock) {
    return null
  }

  const referenceDepth = referenceBlock.depth
  const referenceParentBlockId = getNormalizedParentBlockId(referenceBlock)

  if (delta === -1) {
    for (let i = range.start - 1; i >= 0; i -= 1) {
      if (blocks[i].depth === referenceDepth && getNormalizedParentBlockId(blocks[i]) === referenceParentBlockId) {
        return i
      }

      if (blocks[i].depth < referenceDepth) {
        return null
      }
    }

    return null
  }

  for (let i = range.end + 1; i < blocks.length; i += 1) {
    if (blocks[i].depth === referenceDepth && getNormalizedParentBlockId(blocks[i]) === referenceParentBlockId) {
      return i
    }

    if (blocks[i].depth < referenceDepth) {
      return null
    }
  }

  return null
}

function canMoveBlockRange(blocks: DocumentBlockDraft[], range: BlockSelectionRange, delta: -1 | 1): boolean {
  return findAdjacentSiblingIndexForRange(blocks, range, delta) !== null
}

function isValidSiblingRange(blocks: DocumentBlockDraft[], range: BlockSelectionRange): boolean {
  if (range.start >= blocks.length || range.end >= blocks.length) {
    return false
  }

  const referenceBlock = blocks[range.start]
  if (!referenceBlock) {
    return false
  }

  const referenceDepth = referenceBlock.depth
  const referenceParentBlockId = getNormalizedParentBlockId(referenceBlock)

  for (let i = range.start; i <= range.end; i += 1) {
    if (blocks[i].depth !== referenceDepth) {
      return false
    }

    if (getNormalizedParentBlockId(blocks[i]) !== referenceParentBlockId) {
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

  if (delta === -1) {
    const prevSiblingIndex = findAdjacentSiblingIndexForRange(blocks, range, -1)
    if (prevSiblingIndex === null) {
      return blocks
    }

    const movedBlocks = blocks.slice(range.start, range.end + 1)
    const next = [...blocks]
    next.splice(range.start, movedBlocks.length)
    next.splice(prevSiblingIndex, 0, ...movedBlocks)
    return next
  } else {
    const nextSiblingIndex = findAdjacentSiblingIndexForRange(blocks, range, 1)
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

function moveContiguousBlockRange(blocks: DocumentBlockDraft[], range: BlockSelectionRange, targetIndex: number): DocumentBlockDraft[] {
  const movedBlocks = blocks.slice(range.start, range.end + 1)
  const next = [...blocks]
  next.splice(range.start, movedBlocks.length)

  const insertionIndex = range.start < targetIndex ? Math.max(0, targetIndex - movedBlocks.length + 1) : targetIndex
  next.splice(insertionIndex, 0, ...movedBlocks)
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

function toDraftBlock(block: Pick<DocumentBlock, 'id' | 'type' | 'content' | 'checked' | 'depth' | 'parentBlockId' | 'tags' | 'language' | 'highlight'>): DocumentBlockDraft {
  return {
    id: block.id,
    type: block.type,
    content: block.content,
    checked: Boolean(block.checked),
    depth: normalizeBlockDepth(block.type, block.depth),
    parentBlockId: block.parentBlockId ?? null,
    language: block.language,
    highlight: block.highlight
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
  const [documentsAuxPanelOpen, setDocumentsAuxPanelOpen] = useState(false)
  const [catalogQuery, setCatalogQuery] = useState('')
  const deferredCatalogQuery = useDeferredValue(catalogQuery)
  const [databaseWorkspaceView, setDatabaseWorkspaceView] = useState<DatabaseWorkspaceView>('catalog')
  const [boardGroupBy, setBoardGroupBy] = useState(BOARD_GROUP_BY_PARENT)
  const [detailLoading, setDetailLoading] = useState(false)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  // 自动清除消息（3秒后）
  useEffect(() => {
    if (!backupMessage) return
    const timer = setTimeout(() => setBackupMessage(null), 3000)
    return () => clearTimeout(timer)
  }, [backupMessage])
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetail | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSummary, setDraftSummary] = useState('')
  const [draftBlocks, setDraftBlocksState] = useState<DocumentBlockDraft[]>([])
  const [draggingBlockIndex, setDraggingBlockIndex] = useState<number | null>(null)
  const [dragOverBlockIndex, setDragOverBlockIndex] = useState<number | null>(null)
  const [dragOverBlockDepth, setDragOverBlockDepth] = useState<number | null>(null)
  const [pendingFocusBlockIndex, setPendingFocusBlockIndex] = useState<number | null>(null)
  const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null)
  const [selectionAnchorBlockId, setSelectionAnchorBlockId] = useState<string | null>(null)
  const [selectedBlockRange, setSelectedBlockRange] = useState<BlockSelectionRange | null>(null)
  const [isBlockRangeSelecting, setIsBlockRangeSelecting] = useState(false)
  const [selectedBlockConversionType, setSelectedBlockConversionType] = useState<DocumentBlock['type']>('paragraph')
  const [activeCursorPosition, setActiveCursorPosition] = useState<number>(0)
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0)
  const [linkSuggestions, setLinkSuggestions] = useState<DocumentSuggestion[]>([])
  const [blockSuggestions, setBlockSuggestions] = useState<DocumentBlockDraft[]>([])
  const [moveTargetId, setMoveTargetId] = useState('')
  const [draggingDocumentId, setDraggingDocumentId] = useState<string | null>(null)
  const [dragOverDocumentId, setDragOverDocumentId] = useState<string | null>(null)
  const [dragOverBoardColumnId, setDragOverBoardColumnId] = useState<string | null>(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)
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
  const [blockSearchQuery, setBlockSearchQuery] = useState('')
  const [isBlockSearchOpen, setIsBlockSearchOpen] = useState(false)
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchResult[]>([])
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false)
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false)
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Set<string>>(new Set())
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null)
  const [pendingBlockNavigationTarget, setPendingBlockNavigationTarget] = useState<PendingBlockNavigationTarget | null>(null)
  const [autoSaveFlash, setAutoSaveFlash] = useState(false)
  const [mdCopyFlash, setMdCopyFlash] = useState(false)
  const [pinnedDocumentIds, setPinnedDocumentIds] = useState<Set<string>>(new Set())
  const navHistoryRef = useRef<string[]>([])
  const navPointerRef = useRef<number>(-1)
  const isNavJumpRef = useRef<boolean>(false)
  const [navCanGoBack, setNavCanGoBack] = useState(false)
  const [navCanGoForward, setNavCanGoForward] = useState(false)
  const blockTextareaRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const editHistoryRef = useRef<DocumentBlockDraft[][]>([])
  const editHistoryPointerRef = useRef<number>(-1)
  const isRestoringHistoryRef = useRef<boolean>(false)
  const historyDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blockMouseDownOrigin = useRef<number | null>(null)
  const highlightedBlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  setActiveUiLanguage(uiLanguage)
  const ui = getUiText(uiLanguage)
  const blockSlashCommands = buildBlockSlashCommands(uiLanguage)
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

  function getAppUpdateStatusText(state: AppUpdateState | null): string {
    if (!state) {
      return ui.common.loading
    }

    switch (state.status) {
      case 'idle':
        return ui.updateStatusIdle
      case 'checking':
        return ui.updateStatusChecking
      case 'available':
        return ui.updateStatusAvailable(state.availableVersion)
      case 'downloading':
        return ui.updateStatusDownloading(state.progressPercent)
      case 'downloaded':
        return ui.updateStatusDownloaded(state.downloadedVersion ?? state.availableVersion)
      case 'not-available':
        return ui.updateStatusNotAvailable
      case 'unsupported':
        return ui.updateStatusUnsupported
      case 'error':
        return ui.updateStatusError(state.error)
      default:
        return state.message
    }
  }

  function flashHighlightedBlock(blockId: string) {
    setHighlightedBlockId(blockId)
    if (highlightedBlockTimerRef.current) {
      clearTimeout(highlightedBlockTimerRef.current)
    }

    highlightedBlockTimerRef.current = setTimeout(() => {
      setHighlightedBlockId((current) => (current === blockId ? null : current))
      highlightedBlockTimerRef.current = null
    }, 2200)
  }

  function setDraftBlocks(next: DraftBlockUpdater) {
    setDraftBlocksState((previous) => {
      const resolved = typeof next === 'function' ? next(previous) : next
      return normalizeDraftBlocks(resolved)
    })
  }

  function pushToHistory(blocks: DocumentBlockDraft[]) {
    if (isRestoringHistoryRef.current) return
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }
    const history = editHistoryRef.current
    const pointer = editHistoryPointerRef.current
    const trimmed = history.slice(0, pointer + 1)
    trimmed.push(blocks.map((b) => ({ ...b })))
    editHistoryRef.current = trimmed.slice(-80)
    editHistoryPointerRef.current = editHistoryRef.current.length - 1
  }

  function scheduleHistorySnapshot(blocks: DocumentBlockDraft[]) {
    if (isRestoringHistoryRef.current) return
    if (historyDebounceTimerRef.current) clearTimeout(historyDebounceTimerRef.current)
    historyDebounceTimerRef.current = setTimeout(() => {
      historyDebounceTimerRef.current = null
      const history = editHistoryRef.current
      const pointer = editHistoryPointerRef.current
      const trimmed = history.slice(0, pointer + 1)
      trimmed.push(blocks.map((b) => ({ ...b })))
      editHistoryRef.current = trimmed.slice(-80)
      editHistoryPointerRef.current = editHistoryRef.current.length - 1
    }, 600)
  }

  function undoEdit() {
    const pointer = editHistoryPointerRef.current
    if (pointer <= 0) return
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }
    isRestoringHistoryRef.current = true
    const newPointer = pointer - 1
    editHistoryPointerRef.current = newPointer
    setDraftBlocks(editHistoryRef.current[newPointer].map((b) => ({ ...b })))
    setTimeout(() => { isRestoringHistoryRef.current = false }, 0)
  }

  function redoEdit() {
    const history = editHistoryRef.current
    const pointer = editHistoryPointerRef.current
    if (pointer >= history.length - 1) return
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current)
      historyDebounceTimerRef.current = null
    }
    isRestoringHistoryRef.current = true
    const newPointer = pointer + 1
    editHistoryPointerRef.current = newPointer
    setDraftBlocks(history[newPointer].map((b) => ({ ...b })))
    setTimeout(() => { isRestoringHistoryRef.current = false }, 0)
  }

  function getBlockSearchResults() {
    if (!blockSearchQuery.trim() || draftBlocks.length === 0) {
      return []
    }

    const query = blockSearchQuery.toLowerCase()
    return draftBlocks.filter((block) => {
      const content = block.content.toLowerCase()
      const type = block.type.toLowerCase()
      return content.includes(query) || type.includes(query)
    })
  }

  async function runGlobalSearch(query: string) {
    if (!query.trim()) {
      setGlobalSearchResults([])
      return
    }
    setGlobalSearchLoading(true)
    try {
      const results = await window.knowbook.searchDocuments(query)
      setGlobalSearchResults(results)
    } finally {
      setGlobalSearchLoading(false)
    }
  }

  function openGlobalSearch() {
    setIsGlobalSearchOpen(true)
    setGlobalSearchQuery('')
    setGlobalSearchResults([])
  }

  function closeGlobalSearch() {
    setIsGlobalSearchOpen(false)
    setGlobalSearchQuery('')
    setGlobalSearchResults([])
  }

  function handleGlobalSearchNavigate(result: GlobalSearchResult) {
    const document = homeData.documentCatalog.find((d: DocumentCatalogEntry) => d.id === result.documentId)
    if (document) {
      openDocumentInDocumentsPage(document.id)
      closeGlobalSearch()
    }
  }

  const openDocumentInDocumentsPage = useCallback((documentId: string) => {
    setPendingBlockNavigationTarget(null)
    setHighlightedBlockId(null)
    setSelectedDocumentId(documentId)
    setActivePage('documents')
  }, [])

  function openDocumentBlockInDocumentsPage(documentId: string, blockId: string) {
    setPendingBlockNavigationTarget({ documentId, blockId })
    setActivePage('documents')
    setSelectedDocumentId(documentId)
  }

  async function navigateInlineReferenceAtCursor(content: string, cursorPosition: number) {
    const token = getInlineReferenceTokenAtCursor(content, cursorPosition)
    if (!token) {
      return
    }

    const blockReferences = new Map(
      draftBlocks
        .filter((block): block is DocumentBlockDraft & { id: string } => Boolean(block.id?.trim()))
        .map((block) => [block.id, { id: block.id, content: block.content }] as const)
    )

    const target = resolveInlineReferenceTarget(token, documentReferences, blockReferences, selectedDocumentId)
    if (!target) {
      setBackupMessage(ui.blockReferenceNotFound)
      return
    }

    if (target.type === 'document') {
      openDocumentInDocumentsPage(target.documentId)
      return
    }

    if (target.type === 'block') {
      openDocumentBlockInDocumentsPage(target.documentId, target.blockId)
      return
    }

    const blockReference = await window.knowbook.getBlockReference(target.documentPath, target.blockId)
    if (!blockReference) {
      setBackupMessage(ui.blockReferenceNotFound)
      return
    }

    openDocumentBlockInDocumentsPage(blockReference.documentId, blockReference.block.id)
  }

  function updateBlockHighlight(index: number, highlight: string | undefined) {
    updateDraftBlock(index, {
      ...draftBlocks[index],
      highlight
    })
  }

  function getDocumentStats() {
    const blocks = draftBlocks
    const blockCount = blocks.length
    const allText = blocks.map((b) => b.content).join(' ')
    const wordCount = allText.trim() === '' ? 0 : allText.trim().split(/\s+/).length
    const charCount = allText.length
    const codeBlockCount = blocks.filter((b) => b.type === 'code').length
    const todoCount = blocks.filter((b) => b.type === 'todo').length
    return { blockCount, wordCount, charCount, codeBlockCount, todoCount }
  }

  function getVisibleBlockEntries(blocks: DocumentBlockDraft[]): Array<{ block: DocumentBlockDraft; index: number }> {
    const entries: Array<{ block: DocumentBlockDraft; index: number }> = []

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (!block) {
        continue
      }

      entries.push({ block, index })

      const blockId = getNormalizedBlockId(block)
      if (blockId && collapsedBlockIds.has(blockId)) {
        const subtreeEndIndex = getBlockSubtreeEndIndex(blocks, index)
        if (subtreeEndIndex > index) {
          index = subtreeEndIndex
        }
      }
    }

    return entries
  }

  function getVisibleBlockCountInRange(range: BlockSelectionRange): number {
    return getVisibleBlockEntries(draftBlocks).filter(({ index }) => index >= range.start && index <= range.end).length
  }

  function getSelectedVisibleBlockEntries(range: BlockSelectionRange): Array<{ block: DocumentBlockDraft; index: number }> {
    return getVisibleBlockEntries(draftBlocks).filter(({ index }) => index >= range.start && index <= range.end)
  }

  function getVisibleSelectionSlice(range: BlockSelectionRange): {
    visibleEntries: Array<{ block: DocumentBlockDraft; index: number }>
    operationRange: BlockSelectionRange
  } | null {
    const visibleEntries = getSelectedVisibleBlockEntries(range)
    if (visibleEntries.length === 0) {
      return null
    }

    const firstEntry = visibleEntries[0]
    const lastEntry = visibleEntries[visibleEntries.length - 1]

    return {
      visibleEntries,
      operationRange: {
        start: firstEntry.index,
        end: getBlockSubtreeEndIndex(draftBlocks, lastEntry.index)
      }
    }
  }

  function getVisibleSiblingSelectionSlice(range: BlockSelectionRange): {
    visibleEntries: Array<{ block: DocumentBlockDraft; index: number }>
    operationRange: BlockSelectionRange
  } | null {
    const slice = getVisibleSelectionSlice(range)
    if (!slice) {
      return null
    }

    const firstEntry = slice.visibleEntries[0]
    if (!firstEntry) {
      return null
    }

    const referenceDepth = firstEntry.block.depth
    const referenceParentBlockId = getNormalizedParentBlockId(firstEntry.block)
    const isSiblingSlice = slice.visibleEntries.every(
      ({ block }) => block.depth === referenceDepth && getNormalizedParentBlockId(block) === referenceParentBlockId
    )

    return isSiblingSlice ? slice : null
  }

  function selectionIncludesHiddenCollapsedContent(range: BlockSelectionRange): boolean {
    return getVisibleBlockCountInRange(range) < range.end - range.start + 1
  }

  function getMultiBlockInteractionGuard(range: BlockSelectionRange): string | null {
    if (range.start === range.end) {
      return null
    }

    const visibleSelectionSlice = getVisibleSelectionSlice(range)
    if (!visibleSelectionSlice) {
      return 'The current selection no longer maps to visible rows. Clear the selection and reselect the blocks you want to move.'
    }

    if (visibleSelectionSlice.visibleEntries.length === 1) {
      return null
    }

    if (!getVisibleSiblingSelectionSlice(range)) {
      return ui.visibleSliceCrossParentGuard
    }

    return null
  }

  function canMoveSelectedRange(range: BlockSelectionRange, delta: -1 | 1): boolean {
    const visibleSiblingSlice = getVisibleSiblingSelectionSlice(range)
    if (!visibleSiblingSlice) {
      return false
    }

    const anchorEntry = delta === -1 ? visibleSiblingSlice.visibleEntries[0] : visibleSiblingSlice.visibleEntries[visibleSiblingSlice.visibleEntries.length - 1]
    if (!anchorEntry) {
      return false
    }

    return delta === -1
      ? getPreviousSiblingSubtreeStartIndex(draftBlocks, anchorEntry.index) !== null
      : getNextSiblingSubtreeStartIndex(draftBlocks, anchorEntry.index) !== null
  }

  function blockHasChildren(blockIndex: number): boolean {
    return getBlockSubtreeEndIndex(draftBlocks, blockIndex) > blockIndex
  }

  function toggleBlockCollapse(blockId: string) {
    const newCollapsed = new Set(collapsedBlockIds)
    if (newCollapsed.has(blockId)) {
      newCollapsed.delete(blockId)
    } else {
      newCollapsed.add(blockId)
    }
    setCollapsedBlockIds(newCollapsed)
  }

  function getVisibleBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
    return getVisibleBlockEntries(blocks).map(({ block }) => block)
  }

  function getBlockSuggestionsForLink(query: string): DocumentBlockDraft[] {
    if (!query.trim() || draftBlocks.length === 0) {
      return draftBlocks.slice(0, 5) // Show first 5 blocks by default
    }

    const lowerQuery = query.toLowerCase()
    const matches = draftBlocks.filter((block) => {
      const content = block.content.toLowerCase()
      const type = block.type.toLowerCase()
      return content.includes(lowerQuery) || type.includes(lowerQuery)
    })

    return matches.slice(0, 5) // Limit to 5 suggestions
  }

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

    window.knowbook.getSetting('pinned_documents').then((value) => {
      if (mounted && value) {
        try {
          const ids: string[] = JSON.parse(value)
          setPinnedDocumentIds(new Set(ids))
        } catch { /* ignore */ }
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
    if (!selectedDocumentId) {
      setSelectedDocument(null)
      setPendingFocusBlockIndex(null)
      setSelectionAnchorBlockId(null)
      setSelectedBlockRange(null)
      setPendingBlockNavigationTarget(null)
      setHighlightedBlockId(null)
      resetAiSession()
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
        setSelectionAnchorBlockId(null)
        setSelectedBlockRange(null)
        setActiveCursorPosition(0)
        setLinkSuggestions([])
        setMoveTargetId('')
        setDraftTitle(detail?.title ?? '')
        setDraftSummary(detail?.summary ?? '')
        const initialBlocks = detail?.blocks.map(toDraftBlock) ?? []
        setDraftBlocks(initialBlocks)
        setIsEditing(true)
        editHistoryRef.current = [initialBlocks.map((b) => ({ ...b }))]
        editHistoryPointerRef.current = 0
        isRestoringHistoryRef.current = false
        resetAiSession()
        setDetailLoading(false)
      }
    })

    return () => {
      mounted = false
    }
  }, [selectedDocumentId])

  useEffect(() => {
    if (!pendingBlockNavigationTarget || pendingBlockNavigationTarget.documentId !== selectedDocumentId) {
      return
    }

    if (!selectedDocument) {
      return
    }

    const targetIndex = draftBlocks.findIndex((block) => block.id === pendingBlockNavigationTarget.blockId)
    if (targetIndex === -1) {
      setPendingBlockNavigationTarget(null)
      setBackupMessage(ui.blockReferenceNotFound)
      return
    }

    setCollapsedBlockIds((previous) => expandAncestorBlocks(draftBlocks, pendingBlockNavigationTarget.blockId, previous))
    setSelectedBlockRange(null)
    setSelectionAnchorBlockId(pendingBlockNavigationTarget.blockId)
    setActiveBlockIndex(targetIndex)
    setPendingFocusBlockIndex(targetIndex)
    flashHighlightedBlock(pendingBlockNavigationTarget.blockId)
    setPendingBlockNavigationTarget(null)
  }, [draftBlocks, pendingBlockNavigationTarget, selectedDocument, selectedDocumentId, ui.blockReferenceNotFound])

  useEffect(() => {
    return () => {
      if (highlightedBlockTimerRef.current) {
        clearTimeout(highlightedBlockTimerRef.current)
      }
    }
  }, [])

  // Track navigation history
  useEffect(() => {
    if (!selectedDocumentId) return
    if (isNavJumpRef.current) {
      isNavJumpRef.current = false
      return
    }
    const history = navHistoryRef.current
    const pointer = navPointerRef.current
    // Trim forward history when navigating to a new doc
    const trimmed = history.slice(0, pointer + 1)
    trimmed.push(selectedDocumentId)
    navHistoryRef.current = trimmed.slice(-50)
    navPointerRef.current = navHistoryRef.current.length - 1
    setNavCanGoBack(navPointerRef.current > 0)
    setNavCanGoForward(false)
  }, [selectedDocumentId])

  useEffect(() => {
    if (isEditing && !isRestoringHistoryRef.current) {
      scheduleHistorySnapshot(draftBlocks)
    }
  }, [draftBlocks, isEditing])

  useEffect(() => {
    if (activePage !== 'documents') {
      setIsGlobalSearchOpen(false)
      setIsBlockSearchOpen(false)
    }
  }, [activePage])

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
      blockMouseDownOrigin.current = null
      setIsBlockRangeSelecting(false)
    }

    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleMouseUp)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleMouseUp)
    }
  }, [])

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
  const blockSearchItems = getBlockSearchResults().map((block) => {
    const blockIndex = draftBlocks.indexOf(block)
    return {
      index: blockIndex,
      type: block.type,
      contentPreview: block.content.slice(0, 100),
      isHighlighted: activeBlockIndex === blockIndex
    }
  })
  const selectedBlockCount = selectedBlockRange ? selectedBlockRange.end - selectedBlockRange.start + 1 : 0
  const selectedVisibleBlockCount = selectedBlockRange ? getVisibleBlockCountInRange(selectedBlockRange) : 0
  const selectedBlockActionRange = selectedBlockRange ? getMultiBlockOperationRange(selectedBlockRange) : null
  const selectedBlockActionCount = selectedBlockActionRange ? selectedBlockActionRange.end - selectedBlockActionRange.start + 1 : 0
  const selectedBlockHasHiddenCollapsedContent = selectedBlockRange ? selectionIncludesHiddenCollapsedContent(selectedBlockRange) : false
  const selectedBlockInteractionIssue = selectedBlockRange ? getMultiBlockInteractionGuard(selectedBlockRange) : null
  const selectedVisibleSiblingSlice = selectedBlockRange ? getVisibleSiblingSelectionSlice(selectedBlockRange) : null
  const canMoveSelectionUp = selectedBlockRange ? (
    selectedBlockCount === 1
      ? getPreviousSiblingSubtreeStartIndex(draftBlocks, selectedBlockRange.start) !== null
      : selectedBlockInteractionIssue === null && canMoveSelectedRange(selectedBlockRange, -1)
  ) : false
  const canMoveSelectionDown = selectedBlockRange ? (
    selectedBlockCount === 1
      ? getNextSiblingSubtreeStartIndex(draftBlocks, selectedBlockRange.start) !== null
      : selectedBlockInteractionIssue === null && canMoveSelectedRange(selectedBlockRange, 1)
  ) : false

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
      setBlockSuggestions([])
      return
    }

    let mounted = true
    
    // Get document suggestions
    window.knowbook.getDocumentSuggestions(activeLinkContext.query, selectedDocumentId).then((suggestions) => {
      if (mounted) {
        setLinkSuggestions(suggestions)
      }
    })
    
    // Get block suggestions from current document
    if (isEditing && selectedDocument) {
      const blockSuggs = getBlockSuggestionsForLink(activeLinkContext.query)
      if (mounted) {
        setBlockSuggestions(blockSuggs)
      }
    }

    return () => {
      mounted = false
    }
  }, [activeLinkQuery, isEditing, selectedDocumentId, selectedDocument, draftBlocks])

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

  // 计算浮动斜杠面板的位置
  const slashPanelPos = (() => {
    if (!activeSlashContext || activeBlockIndex === null) {
      return null
    }

    const textarea = blockTextareaRefs.current[activeBlockIndex]
    if (!textarea) return null

    // 获取 textarea 在屏幕中的位置
    const rect = textarea.getBoundingClientRect()

    // 计算光标在 textarea 中的坐标（粗略估计）
    // 实际应用中可能需要更精确的计算
    const lineHeight = parseInt(window.getComputedStyle(textarea).lineHeight)
    const lines = textarea.value.substring(0, activeCursorPosition).split('\n')
    const currentLine = lines.length - 1
    const offsetX = lines[currentLine].length * 8 // 粗略估计字符宽度

    return {
      x: rect.left + offsetX,
      y: rect.top + currentLine * lineHeight + lineHeight + 10 // 在光标下方显示
    }
  })()

  async function refreshWorkspaceAfterStorageMutation() {
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
  }

  async function handleBackup() {
    const result: BackupResult = await window.knowbook.triggerBackup()
    await refreshWorkspaceAfterStorageMutation()
    setBackupMessage(ui.backupExported(result.exported, result.at))
  }

  async function handleRestoreBackup() {
    try {
      const result = await window.knowbook.restoreBackupFromFolder()
      if (!result) {
        return
      }

      await refreshWorkspaceAfterStorageMutation()
      setBackupMessage(ui.backupRestored(
        result.restored,
        result.created,
        result.updated,
        result.deleted,
        result.conflictsResolved,
        result.placeholdersCreated,
        result.at
      ))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.backupRestoreFailed
      setBackupMessage(message)
    }
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
    setSelectionAnchorBlockId(null)
    setSelectedBlockRange(null)
  }

  function startEdit() {
    if (!selectedDocument) {
      return
    }

    const initialBlocks = selectedDocument.blocks.map(toDraftBlock)
    setDraftTitle(selectedDocument.title)
    setDraftSummary(selectedDocument.summary)
    setDraftBlocks(initialBlocks)
    setPendingFocusBlockIndex(null)
    setSelectionAnchorBlockId(null)
    setSelectedBlockRange(null)
    setCollapsedBlockIds(new Set())
    setIsEditing(true)
    editHistoryRef.current = [initialBlocks.map((b) => ({ ...b }))]
    editHistoryPointerRef.current = 0
    isRestoringHistoryRef.current = false
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
    setSelectionAnchorBlockId(null)
    setSelectedBlockRange(null)
    setCollapsedBlockIds(new Set())
    setIsEditing(false)
    editHistoryRef.current = []
    editHistoryPointerRef.current = -1
  }

  async function saveDocument() {
    if (!selectedDocumentId || !selectedDocument) {
      return
    }

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }

    const normalizedDraftBlocks = normalizeDraftBlocks(draftBlocks)
    const validation = validateBlockTreeStructure(normalizedDraftBlocks)
    if (!validation.valid) {
      console.error('Tree structure validation failed:', validation.errors)
      setBackupMessage(ui.cannotSaveInvalidBlockTree(validation.errors))
      return
    }

    setIsSaving(true)
    await window.knowbook.updateDocument(selectedDocumentId, {
      title: draftTitle,
      summary: draftSummary,
      blocks: normalizedDraftBlocks
    })

    const [refreshedHome, refreshedDetail] = await Promise.all([
      window.knowbook.getHomeData(),
      window.knowbook.getDocumentDetail(selectedDocumentId)
    ])
    setHomeData(refreshedHome)
    setSelectedDocument(refreshedDetail)
    setIsSaving(false)
    setAutoSaveFlash(true)
    setTimeout(() => setAutoSaveFlash(false), 2000)
  }

  // Debounced auto-save: saves 800ms after last change
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isEditing || isSaving || !selectedDocumentId || !selectedDocument) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(async () => {
      const normalizedDraftBlocks = normalizeDraftBlocks(draftBlocks)
      const validation = validateBlockTreeStructure(normalizedDraftBlocks)
      if (!validation.valid) return
      setIsSaving(true)
      await window.knowbook.updateDocument(selectedDocumentId, {
        title: draftTitle,
        summary: draftSummary,
        blocks: normalizedDraftBlocks
      })
      const [refreshedHome, refreshedDetail] = await Promise.all([
        window.knowbook.getHomeData(),
        window.knowbook.getDocumentDetail(selectedDocumentId)
      ])
      setHomeData(refreshedHome)
      setSelectedDocument(refreshedDetail)
      setIsSaving(false)
      setAutoSaveFlash(true)
      setTimeout(() => setAutoSaveFlash(false), 2000)
    }, 800)
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [draftBlocks, draftTitle, draftSummary])

  function togglePinDocument(documentId: string) {
    setPinnedDocumentIds((prev) => {
      const next = new Set(prev)
      if (next.has(documentId)) {
        next.delete(documentId)
      } else {
        next.add(documentId)
      }
      window.knowbook.saveSetting('pinned_documents', JSON.stringify([...next]))
      return next
    })
  }

  function blocksToMarkdown(blocks: DocumentBlock[]): string {
    return serializeBlocksToMarkdown(blocks)
  }

  function buildDocumentMarkdown(document: Pick<DocumentDetail, 'title' | 'blocks'>): string {
    const body = blocksToMarkdown(document.blocks)
    return body.trim() === '' ? `# ${document.title}\n` : `# ${document.title}\n\n${body}`
  }

  async function copyDocumentAsMarkdown() {
    if (!selectedDocument) return
    const markdown = buildDocumentMarkdown(selectedDocument)
    await window.knowbook.writeClipboardText(markdown)
    setMdCopyFlash(true)
    setTimeout(() => setMdCopyFlash(false), 2000)
  }

  async function saveDocumentAsMarkdown() {
    if (!selectedDocument) return

    const baseName = selectedDocument.path.split('/').filter(Boolean).at(-1) || selectedDocument.title || 'document'
    const savedPath = await window.knowbook.saveMarkdownFile(`${baseName}.md`, buildDocumentMarkdown(selectedDocument))

    if (savedPath) {
      setBackupMessage(ui.markdownExportedPath(savedPath))
    }
  }

  function navBack() {
    const pointer = navPointerRef.current
    if (pointer <= 0) return
    const newPointer = pointer - 1
    navPointerRef.current = newPointer
    isNavJumpRef.current = true
    setSelectedDocumentId(navHistoryRef.current[newPointer])
    setNavCanGoBack(newPointer > 0)
    setNavCanGoForward(true)
  }

  function navForward() {
    const history = navHistoryRef.current
    const pointer = navPointerRef.current
    if (pointer >= history.length - 1) return
    const newPointer = pointer + 1
    navPointerRef.current = newPointer
    isNavJumpRef.current = true
    setSelectedDocumentId(history[newPointer])
    setNavCanGoBack(true)
    setNavCanGoForward(newPointer < history.length - 1)
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
      const message = error instanceof Error ? error.message : ui.todoUpdateFailed
      setBackupMessage(message)
    } finally {
      setIsSaving(false)
    }
  }

  async function deleteSelectedDocument() {
    if (!selectedDocument) {
      return
    }

    const accepted = window.confirm(ui.confirmDeleteDocument(selectedDocument.title))
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
    await handleMoveDocument(selectedDocument.id, newParentId, ui.movedDocumentSuccess(selectedDocument.title))
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
      const message = error instanceof Error ? error.message : ui.moveFailed
      setBackupMessage(message)
    } finally {
      setDraggingDocumentId(null)
      setDragOverDocumentId(null)
      setDragOverBoardColumnId(null)
      setDragOverRoot(false)
    }
  }

  function beginDrag(documentId: string) {
    setDraggingDocumentId(documentId)
  }

  function endDrag() {
    setDraggingDocumentId(null)
    setDragOverDocumentId(null)
    setDragOverBoardColumnId(null)
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

  async function dropOnBoardColumn(parentId: string | null) {
    if (!draggingDocumentId) {
      endDrag()
      return
    }

    const draggingDocument = catalogDocuments.find((document) => document.id === draggingDocumentId)
    if (draggingDocument && (draggingDocument.parentId ?? null) === parentId) {
      endDrag()
      return
    }

    await handleMoveDocument(draggingDocumentId, parentId)
  }

  async function dropOnBoardTarget(target: BoardDropTarget) {
    if (!draggingDocumentId) {
      endDrag()
      return
    }

    const draggingDocument = catalogDocuments.find((document) => document.id === draggingDocumentId)
    if (!draggingDocument) {
      endDrag()
      return
    }

    if (target.kind === 'parent') {
      await dropOnBoardColumn(target.parentId)
      return
    }

    const targetColumn = catalogColumns.find((column) => column.id === target.columnId)
    if (!targetColumn) {
      endDrag()
      return
    }

    const nextFieldValue = getBoardDropFieldValue(
      targetColumn,
      draggingDocument.fieldValues[target.columnId] ?? null,
      target.value
    )

    if (nextFieldValue === undefined) {
      endDrag()
      return
    }

    await updateDocumentDatabaseValue(draggingDocumentId, target.columnId, nextFieldValue)
    endDrag()
  }

  function switchDatabaseWorkspaceView(nextView: DatabaseWorkspaceView) {
    setDatabaseWorkspaceView(nextView)
    setIsCreatingDatabaseColumn(false)
    setDatabaseColumnNameDraft('')
    setDatabaseColumnTypeDraft('text')
    setDatabaseColumnOptionsDraft('')
    setIsCreatingDatabase(false)
    setDatabaseNameDraft('')
    setDatabaseDescriptionDraft('')
    setIsCreatingDatabaseEntity(false)
    setDatabaseEntityDocumentId('')
    setDatabaseEntityFieldValues({})
    setDatabaseEntityBulkFieldValues({})
    setSelectedDatabaseEntityIds([])
  }

  async function createDatabaseColumn() {
    if (databaseWorkspaceView === 'standalone' && !selectedDatabase) {
      setBackupMessage(ui.noIndependentDatabasesYet)
      return
    }

    try {
      const createdColumn = await window.knowbook.createDocumentDatabaseColumn({
        databaseId: databaseWorkspaceView === 'standalone' ? selectedDatabase?.id : undefined,
        name: databaseColumnNameDraft,
        type: databaseColumnTypeDraft,
        options: normalizeDatabaseColumnOptionsInput(databaseColumnOptionsDraft)
      })
      if (databaseWorkspaceView === 'catalog') {
        await refreshDocumentCatalogData()
      } else {
        await refreshDatabasePageData()
      }
      setIsCreatingDatabaseColumn(false)
      setDatabaseColumnNameDraft('')
      setDatabaseColumnTypeDraft('text')
      setDatabaseColumnOptionsDraft('')
      setBackupMessage(ui.databaseColumnAdded(createdColumn.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnCreateFailed
      setBackupMessage(message)
    }
  }

  async function renameDatabaseColumn(columnId: string, name: string) {
    try {
      await window.knowbook.renameDocumentDatabaseColumn({ columnId, name })
      if (databaseWorkspaceView === 'catalog') {
        await refreshDocumentCatalogData()
      } else {
        await refreshDatabasePageData()
      }
      setBackupMessage(ui.databaseColumnRenamed(name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnRenameFailed
      setBackupMessage(message)
    }
  }

  async function moveDatabaseColumn(columnId: string, direction: 'left' | 'right') {
    try {
      await window.knowbook.moveDocumentDatabaseColumn({ columnId, direction })
      if (databaseWorkspaceView === 'catalog') {
        await refreshDocumentCatalogData()
      } else {
        await refreshDatabasePageData()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnReorderFailed
      setBackupMessage(message)
    }
  }

  async function updateDatabaseColumnOptions(columnId: string, optionsInput: string) {
    const options = normalizeDatabaseColumnOptionsInput(optionsInput)

    try {
      await window.knowbook.updateDocumentDatabaseColumnOptions({ columnId, options })
      if (databaseWorkspaceView === 'catalog') {
        await refreshDocumentCatalogData()
      } else {
        await refreshDatabasePageData()
      }
      setBackupMessage(ui.databaseColumnOptionsUpdated)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnOptionsUpdateFailed
      setBackupMessage(message)
    }
  }

   async function deleteDatabaseColumn(columnId: string, columnName: string) {
    const accepted = window.confirm(ui.confirmDeleteDatabaseColumn(columnName))
    if (!accepted) {
      return
    }

    try {
      await window.knowbook.deleteDocumentDatabaseColumn(columnId)
      if (databaseWorkspaceView === 'catalog') {
        await refreshDocumentCatalogData()
      } else {
        await refreshDatabasePageData()
      }
      setBackupMessage(ui.databaseColumnDeleted(columnName))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseColumnDeleteFailed
      setBackupMessage(message)
    }
  }

  async function createDatabase() {
    try {
      const createdDatabase = await window.knowbook.createDocumentDatabase({
        name: databaseNameDraft,
        description: databaseDescriptionDraft.trim() || undefined
      })
      const refreshedDatabases = await window.knowbook.getDatabases()
      setDatabases(refreshedDatabases)
      setDatabaseWorkspaceView('standalone')
      setDatabaseEntityDatabaseId(createdDatabase.id)
      setDatabaseEntities([])
      setIsCreatingDatabase(false)
      setIsCreatingDatabaseEntity(true)
      setDatabaseNameDraft('')
      setDatabaseDescriptionDraft('')
      setBackupMessage(ui.databaseCreated(createdDatabase.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseCreateFailed
      setBackupMessage(message)
    }
  }

  async function deleteCurrentDatabase() {
    if (!selectedDatabase) {
      return
    }

    if (!window.confirm(ui.confirmDeleteDatabase(selectedDatabase.name))) {
      return
    }

    try {
      await window.knowbook.deleteDatabase(selectedDatabase.id)
      const refreshedDatabases = await window.knowbook.getDatabases()
      setDatabases(refreshedDatabases)
      setIsCreatingDatabaseColumn(false)
      setIsCreatingDatabaseEntity(false)
      setDatabaseColumnNameDraft('')
      setDatabaseColumnTypeDraft('text')
      setDatabaseColumnOptionsDraft('')
      setDatabaseEntityDocumentId('')
      setDatabaseEntityFieldValues({})
      setDatabaseEntityBulkFieldValues({})
      setSelectedDatabaseEntityIds([])
      setBackupMessage(ui.databaseDeleted(selectedDatabase.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseDeleteFailed
      setBackupMessage(message)
    }
  }

  function applyDatabaseSavedView(view: DatabaseSavedView) {
    setActiveDatabaseSavedViewId(view.id)
    setDatabaseEntityFilterQuery(view.filterQuery)
    setDatabaseEntityFilterScope(view.filterScope as DatabaseEntityFilterScope)
    setDatabaseEntitySortMode(view.sortMode)
    setDatabaseEntityViewMode(view.viewMode)
    setSelectedDatabaseEntityIds([])
  }

  function handleDatabaseSavedViewSelect(viewId: string) {
    if (!viewId) {
      setActiveDatabaseSavedViewId('')
      return
    }

    const nextView = databaseSavedViews.find((view) => view.id === viewId)
    if (!nextView) {
      return
    }

    applyDatabaseSavedView(nextView)
  }

  function beginCurrentDatabaseSavedViewCreation() {
    const suggestedName = activeDatabaseSavedView?.name ?? ui.databaseSavedViewDefaultName(databaseSavedViews.length + 1)
    setDatabaseSavedViewNameDraft(suggestedName)
    setIsCreatingDatabaseSavedView(true)
  }

  function cancelCurrentDatabaseSavedViewCreation() {
    setIsCreatingDatabaseSavedView(false)
    setDatabaseSavedViewNameDraft('')
  }

  async function saveCurrentDatabaseSavedView() {
    if (!databaseEntityDatabaseId) {
      return
    }

    const nextName = databaseSavedViewNameDraft.trim()
    if (!nextName.trim()) {
      return
    }

    try {
      const createdView = await window.knowbook.createDatabaseSavedView({
        databaseId: databaseEntityDatabaseId,
        name: nextName,
        filterQuery: databaseEntityFilterQuery,
        filterScope: databaseEntityFilterScope,
        sortMode: databaseEntitySortMode,
        viewMode: databaseEntityViewMode
      })
      setDatabaseSavedViews((current) => [createdView, ...current.filter((view) => view.id !== createdView.id)])
      applyDatabaseSavedView(createdView)
      setIsCreatingDatabaseSavedView(false)
      setDatabaseSavedViewNameDraft('')
      await refreshDatabasePageData(databaseEntityDatabaseId, createdView.id)
      setBackupMessage(ui.databaseSavedViewCreated(createdView.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseSavedViewCreateFailed
      setBackupMessage(message)
    }
  }

  async function updateCurrentDatabaseSavedView() {
    if (!activeDatabaseSavedView) {
      return
    }

    try {
      const updatedView = await window.knowbook.updateDatabaseSavedView({
        viewId: activeDatabaseSavedView.id,
        filterQuery: databaseEntityFilterQuery,
        filterScope: databaseEntityFilterScope,
        sortMode: databaseEntitySortMode,
        viewMode: databaseEntityViewMode
      })
      await refreshDatabasePageData(databaseEntityDatabaseId, updatedView.id)
      setBackupMessage(ui.databaseSavedViewUpdated(updatedView.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseSavedViewUpdateFailed
      setBackupMessage(message)
    }
  }

  async function deleteCurrentDatabaseSavedView() {
    if (!activeDatabaseSavedView) {
      return
    }

    if (!window.confirm(ui.confirmDeleteDatabaseSavedView(activeDatabaseSavedView.name))) {
      return
    }

    try {
      await window.knowbook.deleteDatabaseSavedView(activeDatabaseSavedView.id)
      await refreshDatabasePageData(databaseEntityDatabaseId, '')
      setBackupMessage(ui.databaseSavedViewDeleted(activeDatabaseSavedView.name))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseSavedViewDeleteFailed
      setBackupMessage(message)
    }
  }

  async function createDatabaseEntity() {
    try {
      await window.knowbook.createDatabaseEntity({
        databaseId: databaseEntityDatabaseId,
        documentId: databaseEntityDocumentId || undefined,
        fieldValues: compactDocumentDatabaseFieldValues(databaseEntityFieldValues)
      })
      await refreshDatabasePageData(databaseEntityDatabaseId)
      setIsCreatingDatabaseEntity(false)
      setDatabaseEntityDocumentId('')
      setDatabaseEntityFieldValues({})
      setBackupMessage(ui.databaseEntityCreated)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntityCreateFailed
      setBackupMessage(message)
    }
  }

  async function updateDatabaseEntity(
    entityId: string,
    fieldValues?: Record<string, DocumentDatabaseFieldValue>,
    documentId?: string | null
  ) {
    try {
      const input: {
        entityId: string
        fieldValues?: Record<string, DocumentDatabaseFieldValue>
        documentId?: string | null
      } = { entityId }

      if (fieldValues) {
        input.fieldValues = Object.fromEntries(
          Object.entries(fieldValues).map(([columnId, value]) => [columnId, normalizeDocumentDatabaseFieldValue(value)])
        )
      }

      if (documentId !== undefined) {
        input.documentId = documentId
      }

      await window.knowbook.updateDatabaseEntity(input)
      await refreshDatabasePageData(databaseEntityDatabaseId)
      setBackupMessage(ui.databaseEntityUpdated)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntityUpdateFailed
      setBackupMessage(message)
    }
  }

  async function updateDatabaseEntityField(entity: DatabaseEntity, columnId: string, value: DocumentDatabaseFieldValue) {
    await updateDatabaseEntity(entity.id, {
      ...entity.fieldValues,
      [columnId]: normalizeDocumentDatabaseFieldValue(value)
    })
  }

  async function updateDatabaseEntityDocument(entity: DatabaseEntity, documentId: string | null) {
    await updateDatabaseEntity(entity.id, undefined, documentId)
  }

  async function deleteDatabaseEntity(entityId: string) {
    if (!window.confirm(ui.confirmDeleteDatabaseEntity)) {
      return
    }
    try {
      await window.knowbook.deleteDatabaseEntity(entityId)
      await refreshDatabasePageData(databaseEntityDatabaseId)
      setBackupMessage(ui.databaseEntityDeleted)
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntityDeleteFailed
      setBackupMessage(message)
    }
  }

  async function deleteSelectedDatabaseEntities() {
    if (selectedVisibleDatabaseEntityIds.length === 0) {
      return
    }

    if (!window.confirm(ui.confirmDeleteDatabaseEntities(selectedVisibleDatabaseEntityIds.length))) {
      return
    }

    try {
      for (const entityId of selectedVisibleDatabaseEntityIds) {
        await window.knowbook.deleteDatabaseEntity(entityId)
      }

      await refreshDatabasePageData(databaseEntityDatabaseId)
      setSelectedDatabaseEntityIds([])
      setBackupMessage(ui.databaseEntitiesDeleted(selectedVisibleDatabaseEntityIds.length))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntitiesDeleteFailed
      setBackupMessage(message)
    }
  }

  async function updateSelectedDatabaseEntities(input: {
    fieldValues?: Record<string, DocumentDatabaseFieldValue>
    documentId?: string | null
  }) {
    if (selectedVisibleDatabaseEntityIds.length === 0) {
      return
    }

    const entityIds = [...selectedVisibleDatabaseEntityIds]
    const count = entityIds.length

    try {
      for (const entityId of entityIds) {
        await window.knowbook.updateDatabaseEntity({
          entityId,
          fieldValues: input.fieldValues,
          documentId: input.documentId
        })
      }

      await refreshDatabasePageData(databaseEntityDatabaseId)
      setBackupMessage(ui.databaseEntitiesUpdated(count))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.databaseEntitiesUpdateFailed
      setBackupMessage(message)
    }
  }

  function updateDatabaseEntityBulkFieldValue(columnId: string, value: DocumentDatabaseFieldValue) {
    setDatabaseEntityBulkFieldValues((current) => ({
      ...current,
      [columnId]: normalizeDocumentDatabaseFieldValue(value)
    }))
  }

  async function applyDatabaseEntityFieldToSelected(columnId: string) {
    await updateSelectedDatabaseEntities({
      fieldValues: {
        [columnId]: databaseEntityBulkFieldValues[columnId] ?? null
      }
    })
  }

  async function clearDatabaseEntityFieldFromSelected(columnId: string) {
    setDatabaseEntityBulkFieldValues((current) => ({
      ...current,
      [columnId]: null
    }))

    await updateSelectedDatabaseEntities({
      fieldValues: {
        [columnId]: null
      }
    })
  }

  async function clearSelectedDatabaseEntityDocuments() {
    await updateSelectedDatabaseEntities({ documentId: null })
  }

  function toggleDatabaseEntitySelection(entityId: string, checked: boolean) {
    setSelectedDatabaseEntityIds((current) => {
      if (checked) {
        return current.includes(entityId) ? current : [...current, entityId]
      }

      return current.filter((candidate) => candidate !== entityId)
    })
  }

  function selectVisibleDatabaseEntities() {
    setSelectedDatabaseEntityIds(filteredStandaloneDatabaseEntityIds)
  }

  const updateDocumentDatabaseValue = useCallback(async (documentId: string, columnId: string, value: DocumentDatabaseFieldValue) => {
    let previousFieldValue: DocumentDatabaseFieldValue | undefined

    setCatalogDocuments((previous) => {
      const nextState = setDocumentCatalogFieldValue(previous, documentId, columnId, value)
      previousFieldValue = nextState.previousValue
      return nextState.entries
    })
    setHomeData((previous) => {
      const nextState = setDocumentCatalogFieldValue(previous.documentCatalog, documentId, columnId, value)
      return {
        ...previous,
        documentCatalog: nextState.entries
      }
    })

    try {
      await window.knowbook.updateDocumentDatabaseValue({ documentId, columnId, value })
    } catch (error) {
      setCatalogDocuments((previous) => restoreDocumentCatalogFieldValue(previous, documentId, columnId, previousFieldValue))
      setHomeData((previous) => ({
        ...previous,
        documentCatalog: restoreDocumentCatalogFieldValue(previous.documentCatalog, documentId, columnId, previousFieldValue)
      }))
      const message = error instanceof Error ? error.message : 'Failed to update database value.'
      setBackupMessage(message)
    }
  }, [])

  const refreshDocumentCatalogData = useCallback(async () => {
    const [refreshedColumns, refreshedCatalog] = await Promise.all([
      window.knowbook.getDocumentDatabaseColumns(),
      window.knowbook.getDocumentCatalog()
    ])
    setCatalogColumns(refreshedColumns)
    setCatalogDocuments(refreshedCatalog)
  }, [])

  async function refreshDatabasePageData(
    targetDatabaseId: string | null = databaseEntityDatabaseId,
    preferredSavedViewId?: string
  ) {
    const [refreshedHome, refreshedEntities, refreshedColumns, refreshedViews] = await Promise.all([
      window.knowbook.getHomeData(),
      targetDatabaseId ? window.knowbook.getDatabaseEntities(targetDatabaseId) : Promise.resolve([]),
      window.knowbook.getDocumentDatabaseColumns(targetDatabaseId),
      targetDatabaseId ? window.knowbook.getDatabaseSavedViews(targetDatabaseId) : Promise.resolve([])
    ])
    setHomeData(refreshedHome)
    setDatabaseEntities(refreshedEntities)
    setSelectedDatabaseColumns(refreshedColumns)
    setDatabaseSavedViews(refreshedViews)
    setActiveDatabaseSavedViewId((current) => {
      const nextId = preferredSavedViewId ?? current
      return nextId && refreshedViews.some((view) => view.id === nextId) ? nextId : ''
    })
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
      setIsBlockRangeSelecting(false)
      setSelectionAnchorBlockId(null)
      setSelectedBlockRange(null)
    }

    function beginBlockRangeSelection(index: number) {
      setIsBlockRangeSelecting(true)
      selectBlockRange(index, false)
    }

    function extendBlockRangeSelection(index: number) {
      if (!isBlockRangeSelecting) {
        return
      }

      selectBlockRange(index, true)
    }

    function endBlockRangeSelection() {
      blockMouseDownOrigin.current = null
      setIsBlockRangeSelecting(false)
    }

    function notifyBlockMouseDown(index: number) {
      blockMouseDownOrigin.current = index
    }

    function handleBlockMouseEnter(index: number, buttonsHeld: boolean) {
      const origin = blockMouseDownOrigin.current

      if (!buttonsHeld) {
        blockMouseDownOrigin.current = null
        if (isBlockRangeSelecting) setIsBlockRangeSelecting(false)
        return
      }

      if (origin === null || index === origin) return

      if (!isBlockRangeSelecting) {
        // First entry into a different block while mouse is held — start drag range selection
        const originBlockId = getNormalizedBlockId(draftBlocks[origin])
        const visibleEntries = getVisibleBlockEntries(draftBlocks)
        const originVIdx = visibleEntries.findIndex((e) => e.index === origin)
        const targetVIdx = visibleEntries.findIndex((e) => e.index === index)

        if (originVIdx !== -1 && targetVIdx !== -1) {
          const startEntry = visibleEntries[Math.min(originVIdx, targetVIdx)]
          const endEntry = visibleEntries[Math.max(originVIdx, targetVIdx)]
          if (startEntry && endEntry) {
            setIsBlockRangeSelecting(true)
            setSelectionAnchorBlockId(originBlockId ?? null)
            setSelectedBlockRange({ start: startEntry.index, end: endEntry.index })
            setActiveBlockIndex(index)
          }
        }
      } else {
        // Already in drag-select, extend from existing anchor
        selectBlockRange(index, true)
      }
    }

    function isBlockSelected(index: number) {
      return selectedBlockRange ? index >= selectedBlockRange.start && index <= selectedBlockRange.end : false
    }

    function isSelectionCoherent(range: BlockSelectionRange): boolean {
      if (range.start === range.end) {
        return true
      }

      const visibleEntries = getSelectedVisibleBlockEntries(range)
      if (visibleEntries.length === 0) {
        return true
      }

      const depthSet = new Set(visibleEntries.map(({ block }) => block.depth))
      return depthSet.size === 1
    }

    function selectBlockRange(index: number, extendSelection = false) {
      const visibleEntries = getVisibleBlockEntries(draftBlocks)
      const targetVisibleIndex = visibleEntries.findIndex((entry) => entry.index === index)
      const targetBlockId = getNormalizedBlockId(draftBlocks[index])

      // When extending but no anchor set, fall back to activeBlockIndex as the anchor
      const resolvedAnchorId = selectionAnchorBlockId ??
        (activeBlockIndex !== null ? getNormalizedBlockId(draftBlocks[activeBlockIndex]) : null)

      if (!extendSelection || !resolvedAnchorId || targetVisibleIndex === -1) {
        setSelectionAnchorBlockId(targetBlockId)
        setSelectedBlockRange({ start: index, end: index })
        setActiveBlockIndex(index)
        return
      }

      const anchorVisibleIndex = visibleEntries.findIndex(({ block }) => getNormalizedBlockId(block) === resolvedAnchorId)
      const resolvedAnchorVisibleIndex = anchorVisibleIndex === -1 ? targetVisibleIndex : anchorVisibleIndex
      const rangeStartEntry = visibleEntries[Math.min(resolvedAnchorVisibleIndex, targetVisibleIndex)]
      const rangeEndEntry = visibleEntries[Math.max(resolvedAnchorVisibleIndex, targetVisibleIndex)]

      if (!rangeStartEntry || !rangeEndEntry) {
        setSelectionAnchorBlockId(targetBlockId)
        setSelectedBlockRange({ start: index, end: index })
        setActiveBlockIndex(index)
        return
      }

      setSelectionAnchorBlockId(resolvedAnchorId)
      setSelectedBlockRange({
        start: rangeStartEntry.index,
        end: rangeEndEntry.index
      })
      setActiveBlockIndex(index)
    }

    function selectAllBlocks() {
      if (draftBlocks.length === 0) return
      const firstBlockId = getNormalizedBlockId(draftBlocks[0])
      setSelectionAnchorBlockId(firstBlockId)
      setSelectedBlockRange({ start: 0, end: draftBlocks.length - 1 })
      setActiveBlockIndex(0)
    }

    function getSelectedBlockActionRange(range: BlockSelectionRange): BlockSelectionRange {
      if (range.start !== range.end) {
        return getMultiBlockOperationRange(range)
      }

      return {
        start: range.start,
        end: getBlockSubtreeEndIndex(draftBlocks, range.start)
      }
    }

    function getMultiBlockOperationRange(range: BlockSelectionRange): BlockSelectionRange {
      if (range.start === range.end) {
        return getSelectedBlockActionRange(range)
      }

      return getVisibleSelectionSlice(range)?.operationRange ?? range
    }

    function moveSelectedBlocks(delta: -1 | 1) {
      if (!selectedBlockRange) {
        return
      }

      const interactionIssue = getMultiBlockInteractionGuard(selectedBlockRange)
      if (interactionIssue) {
        setBackupMessage(interactionIssue)
        return
      }

      const visibleSiblingSlice = getVisibleSiblingSelectionSlice(selectedBlockRange)
      if (!visibleSiblingSlice) {
        setBackupMessage(ui.invalidVisibleTreeSlice)
        return
      }

      const firstVisibleEntry = visibleSiblingSlice.visibleEntries[0]
      const lastVisibleEntry = visibleSiblingSlice.visibleEntries[visibleSiblingSlice.visibleEntries.length - 1]
      if (!firstVisibleEntry || !lastVisibleEntry) {
        return
      }

      const siblingIndex =
        delta === -1
          ? getPreviousSiblingSubtreeStartIndex(draftBlocks, firstVisibleEntry.index)
          : getNextSiblingSubtreeStartIndex(draftBlocks, lastVisibleEntry.index)

      if (siblingIndex === null) {
        return
      }

      pushToHistory(draftBlocks)

      const operationRange = visibleSiblingSlice.operationRange
      const targetIndex = delta === -1 ? siblingIndex : getBlockSubtreeEndIndex(draftBlocks, siblingIndex)
      const nextBlocks = moveContiguousBlockRange(draftBlocks, operationRange, targetIndex)
      
      const movedCount = operationRange.end - operationRange.start + 1
      const insertionIndex = operationRange.start < targetIndex ? Math.max(0, targetIndex - movedCount + 1) : targetIndex
      const newStartIndex = remapIndexAfterSubtreeMove(operationRange.start, operationRange.start, operationRange.end, insertionIndex) ?? operationRange.start
      const newEndIndex = remapIndexAfterSubtreeMove(operationRange.end, operationRange.start, operationRange.end, insertionIndex) ?? operationRange.end
      const nextFocusIndex = remapIndexAfterSubtreeMove(
        activeBlockIndex ?? lastVisibleEntry.index,
        operationRange.start,
        operationRange.end,
        insertionIndex
      ) ?? newEndIndex

      setDraftBlocks(nextBlocks)
      setSelectedBlockRange({
        start: newStartIndex,
        end: newEndIndex
      })
      setSelectionAnchorBlockId(getNormalizedBlockId(nextBlocks[newStartIndex]) ?? null)
      setActiveBlockIndex(nextFocusIndex)
      setPendingFocusBlockIndex(nextFocusIndex)
      endBlockDrag()
    }

    function adjustSelectedBlocksDepth(delta: -1 | 1, focusIndex: number, cursorPosition = activeCursorPosition) {
      if (!selectedBlockRange) {
        return
      }

      const interactionIssue = getMultiBlockInteractionGuard(selectedBlockRange)
      if (interactionIssue) {
        setBackupMessage(interactionIssue)
        return
      }

      const operationRange = getMultiBlockOperationRange(selectedBlockRange)
      pushToHistory(draftBlocks)

      const selectedNestableBlocks = draftBlocks
        .slice(operationRange.start, operationRange.end + 1)
        .filter((block) => isNestableBlock(block.type))

      if (selectedNestableBlocks.length === 0) {
        return
      }

      const minDepth = Math.min(...selectedNestableBlocks.map((block) => block.depth))
      const appliedDelta =
        delta === 1
          ? Math.min(...selectedNestableBlocks.map((block) => normalizeBlockDepth(block.type, block.depth + 1) - block.depth))
          : Math.max(...selectedNestableBlocks.map((block) => normalizeBlockDepth(block.type, block.depth - 1) - block.depth))

      if (appliedDelta === 0) {
        return
      }

      if (appliedDelta > 0) {
        const precedingBlock = operationRange.start > 0 ? draftBlocks[operationRange.start - 1] : null
        if (!precedingBlock) {
          console.warn('Cannot indent: no preceding block found as parent.')
          return
        }

        const nextMinDepth = minDepth + appliedDelta
        if (precedingBlock.depth + 1 < nextMinDepth) {
          console.warn(`Cannot indent to depth ${nextMinDepth}: preceding block depth is ${precedingBlock.depth}. Max indent is ${precedingBlock.depth + 1}.`)
          return
        }

        for (let i = operationRange.start; i <= operationRange.end; i += 1) {
          const block = draftBlocks[i]
          if (!isNestableBlock(block.type)) {
            continue
          }

          const nextBlockDepth = normalizeBlockDepth(block.type, block.depth + appliedDelta)

          if (i === selectedBlockRange.start) {
            continue
          }

          const prevBlock = draftBlocks[i - 1]
          if (prevBlock.depth < nextBlockDepth - 1) {
            console.warn(`Cannot indent multi-block range: block at index ${i} would have insufficient preceding block depth for its new depth ${nextBlockDepth}.`)
            return
          }
        }
      }

      setDraftBlocks((previous) => {
        const next = [...previous]
        const operationBlocks = next.slice(operationRange.start, operationRange.end + 1)
        const rootIds = getFragmentLocalRootIds(operationBlocks)
        const firstAdjustableRootOffset = operationBlocks.findIndex((block) => {
          const blockId = getNormalizedBlockId(block)
          return Boolean(blockId && rootIds.has(blockId) && isNestableBlock(block.type))
        })

        if (firstAdjustableRootOffset === -1) {
          return previous
        }

        const firstAdjustableRootIndex = operationRange.start + firstAdjustableRootOffset
        const firstAdjustableRoot = next[firstAdjustableRootIndex]
        if (!firstAdjustableRoot) {
          return previous
        }

        const placement = resolveDraftInsertionPlacement(
          next,
          firstAdjustableRootIndex,
          firstAdjustableRoot.type,
          firstAdjustableRoot.depth + appliedDelta
        )

        next.splice(
          operationRange.start,
          operationBlocks.length,
          ...shiftDraftFragmentDepth(operationBlocks, placement.depth - firstAdjustableRoot.depth, placement.parentBlockId, rootIds)
        )
        return next
      })
      setActiveBlockIndex(focusIndex)
      setActiveCursorPosition(cursorPosition)
      setPendingFocusBlockIndex(focusIndex)
      endBlockDrag()
    }

    function convertSelectedBlocks(nextType: DocumentBlock['type']) {
      if (!selectedBlockRange) {
        return
      }

      const operationRange = getMultiBlockOperationRange(selectedBlockRange)
      const operationCount = operationRange.end - operationRange.start + 1
      pushToHistory(draftBlocks)

      const focusIndex =
        activeBlockIndex !== null && activeBlockIndex >= operationRange.start && activeBlockIndex <= operationRange.end
          ? activeBlockIndex
          : operationRange.start

      setDraftBlocks((previous) =>
        previous.map((block, currentIndex) => {
          if (currentIndex < operationRange.start || currentIndex > operationRange.end) {
            return block
          }

          return buildBlockTypePatch(nextType, block.content, nextType === 'todo' ? block.checked : false, block.depth, block.parentBlockId ?? null)
        })
      )
      setActiveBlockIndex(focusIndex)
      setPendingFocusBlockIndex(focusIndex)
      endBlockDrag()
      setBackupMessage(ui.convertedBlocks(operationCount, getBlockTypeLabel(nextType)))
    }

    function removeSelectedBlockRange(range: BlockSelectionRange) {
      pushToHistory(draftBlocks)
      const lastRemovedBlock = draftBlocks[range.end]
      if (!lastRemovedBlock) {
        return
      }

      const modifiedBlocks: DocumentBlockDraft[] = []
      
      for (let i = 0; i < draftBlocks.length; i += 1) {
        const block = draftBlocks[i]
        
        if (i >= range.start && i <= range.end) {
          continue
        }

        if (i > range.end) {
          if (block.depth > lastRemovedBlock.depth) {
            const requestedDepth = normalizeBlockDepth(block.type, block.depth + (lastRemovedBlock.depth - block.depth))
            const placement = resolveDraftInsertionPlacement(modifiedBlocks, modifiedBlocks.length, block.type, requestedDepth)
            modifiedBlocks.push({
              ...block,
              depth: placement.depth,
              parentBlockId: placement.parentBlockId
            })
            continue
          }
        }

        modifiedBlocks.push(block)
      }

      const remainingCount = modifiedBlocks.length
      const nextIndex = remainingCount > 0 ? Math.min(range.start, remainingCount - 1) : null

      clearBlockSelection()
      setDraftBlocks(modifiedBlocks)
      setActiveBlockIndex(nextIndex)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(nextIndex)
      endBlockDrag()
    }

    async function copySelectedBlocks() {
      if (!selectedBlockRange) {
        return
      }

      const range = getMultiBlockOperationRange(selectedBlockRange)
      const text = serializeDraftBlockRange(draftBlocks, range)
      const count = range.end - range.start + 1

      try {
        await window.knowbook.writeClipboardText(text)
        setBackupMessage(ui.copiedBlocks(count))
      } catch (error) {
        const message = error instanceof Error ? error.message : ui.copyFailed
        setBackupMessage(message)
      }
    }

    async function copySelectedBlocksAsPlainText() {
      if (!selectedBlockRange) {
        return
      }

      const range = getMultiBlockOperationRange(selectedBlockRange)
      const text = serializeDraftBlockRangeAsPlainText(draftBlocks, range)
      const count = range.end - range.start + 1

      try {
        await window.knowbook.writeClipboardText(text)
        setBackupMessage(ui.copiedPlainText(count))
      } catch (error) {
        const message = error instanceof Error ? error.message : ui.copyTextFailed
        setBackupMessage(message)
      }
    }

    async function cutSelectedBlocks() {
      if (!selectedBlockRange) {
        return
      }

      const range = getMultiBlockOperationRange(selectedBlockRange)
      const text = serializeDraftBlockRange(draftBlocks, range)
      const count = range.end - range.start + 1

      try {
        await window.knowbook.writeClipboardText(text)
        removeSelectedBlockRange(range)
        setBackupMessage(ui.cutBlocks(count))
      } catch (error) {
        const message = error instanceof Error ? error.message : ui.cutFailed
        setBackupMessage(message)
      }
    }

    function deleteSelectedBlocks() {
      if (!selectedBlockRange) {
        return
      }

      const range = getMultiBlockOperationRange(selectedBlockRange)
      const count = range.end - range.start + 1
      removeSelectedBlockRange(range)
      setBackupMessage(ui.deletedBlocks(count))
    }

    function duplicateSelectedBlocks() {
      if (!selectedBlockRange) {
        return
      }
      pushToHistory(draftBlocks)

      const range = getMultiBlockOperationRange(selectedBlockRange)
      const duplicatedBlocks = materializeDraftFragment(
        draftBlocks.slice(range.start, range.end + 1),
        getNormalizedParentBlockId(draftBlocks[range.start])
      )
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
      setSelectionAnchorBlockId(duplicatedBlocks[0]?.id ?? null)
      setSelectedBlockRange(duplicatedRange)
      setActiveBlockIndex(duplicatedRange.start)
      setActiveCursorPosition(duplicatedBlocks[0]?.content.length ?? 0)
      setPendingFocusBlockIndex(duplicatedRange.start)
      endBlockDrag()
      setBackupMessage(ui.duplicatedBlocks(count))
    }

  function handleBlockContentChange(index: number, content: string) {
    const currentBlock = draftBlocks[index] ?? buildBlockTypePatch('paragraph', '')
    const shortcut = resolveMarkdownBlockShortcut({
      ...currentBlock,
      content
    })
    if (shortcut) {
      updateDraftBlock(index, shortcut)
      setActiveBlockIndex(index)
      setActiveCursorPosition(shortcut.content.length)
      setPendingFocusBlockIndex(index)
      return
    }

    updateDraftBlock(index, {
      content,
      ...(currentBlock.type === 'code' && !normalizeCodeLanguage(currentBlock.language)
        ? { language: detectCodeLanguage(content) ?? undefined }
        : {})
    })
  }

  function handleBlockPaste(index: number, pastedText: string, selectionStart: number, selectionEnd: number) {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return false
    }
    pushToHistory(draftBlocks)

    const normalizedText = pastedText.replace(/\r\n?/g, '\n')
    const activeRange =
      selectedBlockRange && index >= selectedBlockRange.start && index <= selectedBlockRange.end
        ? getMultiBlockOperationRange(selectedBlockRange)
        : null

    if (activeRange) {
      const templateBlock = draftBlocks[activeRange.start] ?? currentBlock
      const lines = normalizedText.split('\n')
      let nextBlocks = looksLikeStructuredBlockPaste(normalizedText)
        ? parseStructuredPastedBlocks(normalizedText)
        : lines.filter((line) => line.trim() !== '').map((line) => normalizePastedLineBlock(templateBlock, line))

      if (nextBlocks.length === 0) {
        return false
      }

      nextBlocks = materializeDraftFragment(
        adjustPastedBlocksDepth(nextBlocks, templateBlock.depth),
        getNormalizedParentBlockId(templateBlock)
      )

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
    const middleLines = lines.slice(1, -1).filter((line) => line.trim() !== '')
    const nextBlocks = materializeDraftFragment([
      normalizePastedLineBlock(currentBlock, `${before}${firstLine}`),
      ...middleLines.map((line) => normalizePastedLineBlock(currentBlock, line)),
      normalizePastedLineBlock(currentBlock, `${lastLine}${after}`)
    ], getNormalizedParentBlockId(currentBlock))

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
    pushToHistory(draftBlocks)
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

      next.splice(subtreeEndIndex + 1, 0, buildBlockTypePatch(childType, '', false, childDepth, currentBlock.id))
      return next
    })

    setActiveBlockIndex(subtreeEndIndex + 1)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(subtreeEndIndex + 1)
    endBlockDrag()
  }

  function duplicateDraftBlock(index: number, contentOverride?: string) {
    pushToHistory(draftBlocks)
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    clearBlockSelection()

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)
    const duplicatedRootIndex = subtreeEndIndex + 1
    const duplicatedBlocks = materializeDraftFragment(
      draftBlocks.slice(index, subtreeEndIndex + 1).map((block, offset) => ({
        ...block,
        content: offset === 0 ? contentOverride ?? block.content : block.content
      })),
      getNormalizedParentBlockId(currentBlock)
    )

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
        buildBlockTypePatch(nextType, rightContent, nextType === 'todo' ? false : currentBlock.checked, currentBlock.depth, currentBlock.parentBlockId ?? null)
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

      updateDraftBlock(index, buildBlockTypePatch('paragraph', '', false, currentBlock.depth, currentBlock.parentBlockId ?? null))
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

    updateDraftBlock(index, buildBlockTypePatch('paragraph', currentBlock.content, false, currentBlock.depth, currentBlock.parentBlockId ?? null))
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

    if (appliedDelta > 0) {
      const precedingBlock = index > 0 ? draftBlocks[index - 1] : null
      if (!precedingBlock) {
        console.warn('Cannot indent: no preceding block found as parent.')
        return
      }

      if (precedingBlock.depth + 1 < nextRootDepth) {
        console.warn(`Cannot indent to depth ${nextRootDepth}: preceding block depth is ${precedingBlock.depth}. Max indent is ${precedingBlock.depth + 1}.`)
        return
      }
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)

    setDraftBlocks((previous) => {
      const subtreeBlocks = previous.slice(index, subtreeEndIndex + 1)
      const rootId = getNormalizedBlockId(previous[index])
      const rootIds = new Set<string>(rootId ? [rootId] : [])
      const placement = resolveDraftInsertionPlacement(previous, index, currentBlock.type, nextRootDepth)
      const next = [...previous]

      next.splice(index, subtreeBlocks.length, ...shiftDraftFragmentDepth(subtreeBlocks, placement.depth - currentBlock.depth, placement.parentBlockId, rootIds))
      return next
    })
    setActiveBlockIndex(index)
    setActiveCursorPosition(cursorPosition)
    setPendingFocusBlockIndex(index)
  }

  function mergeWithPreviousBlock(index: number) {
    if (index === 0) {
      return
    }

    const currentBlock = draftBlocks[index]
    const previousBlock = draftBlocks[index - 1]

    if (!currentBlock || !previousBlock) {
      return
    }

    const previousSubtreeEnd = getBlockSubtreeEndIndex(draftBlocks, index - 1)
    if (previousSubtreeEnd !== index - 1) {
      console.warn('Cannot merge into a block with children. Please move or delete child blocks first.')
      return
    }
    pushToHistory(draftBlocks)

    const currentSubtreeStart = index
    const currentSubtreeEnd = getBlockSubtreeEndIndex(draftBlocks, index)

    const isMergeable =
      previousBlock.type === currentBlock.type &&
      previousBlock.depth === currentBlock.depth &&
      !['code', 'math', 'divider'].includes(currentBlock.type)

    if (!isMergeable) {
      return
    }

    const mergedContent = previousBlock.content + currentBlock.content
    const focusPosition = previousBlock.content.length

    clearBlockSelection()

    setDraftBlocks((previous) => {
      const next = [...previous]
      next[index - 1] = {
        ...previousBlock,
        content: mergedContent
      }
      next.splice(currentSubtreeStart, currentSubtreeEnd - currentSubtreeStart + 1)
      return next
    })

    setActiveBlockIndex(index - 1)
    setActiveCursorPosition(focusPosition)
    setPendingFocusBlockIndex(index - 1)
    endBlockDrag()
  }

  function moveDraftSubtree(sourceIndex: number, targetIndex: number, targetDepth: number | null, focusIndexOverride?: number | null) {
    pushToHistory(draftBlocks)
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

      const placement = resolveDraftInsertionPlacement(
        next,
        insertionIndex,
        rootBlock.type,
        targetDepth === null ? rootBlock.depth : targetDepth
      )
      const normalizedMovedBlocks = shiftDraftFragmentDepth(
        movedBlocks,
        placement.depth - rootBlock.depth,
        placement.parentBlockId,
        getFragmentLocalRootIds(movedBlocks)
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
                ...buildBlockTypePatch(command.type, nextContent, command.type === 'todo' ? currentBlock.checked : false, currentBlock.depth, currentBlock.parentBlockId ?? null)
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
        {
          const next = [...previous]
          const current = next[activeBlockIndex]
          if (!current) {
            return previous
          }

          next[activeBlockIndex] = {
            ...current,
            content: nextContent
          }

          const nextRootDepth = normalizeBlockDepth(current.type, current.depth + (command.action === 'indent' ? 1 : -1))
          const appliedDelta = nextRootDepth - current.depth
          if (appliedDelta === 0) {
            return next
          }

          if (appliedDelta > 0) {
            const precedingBlock = activeBlockIndex > 0 ? next[activeBlockIndex - 1] : null
            if (!precedingBlock) {
              console.warn('Cannot indent: no preceding block found as parent.')
              return next
            }

            if (precedingBlock.depth < nextRootDepth) {
              console.warn(`Cannot indent to depth ${nextRootDepth}: preceding block depth is ${precedingBlock.depth}. Max indent is ${precedingBlock.depth + 1}.`)
              return next
            }
          }

          const subtreeEndIndex = getBlockSubtreeEndIndex(next, activeBlockIndex)
          const subtreeBlocks = next.slice(activeBlockIndex, subtreeEndIndex + 1)
          const rootId = getNormalizedBlockId(current)
          const rootIds = new Set<string>(rootId ? [rootId] : [])
          const placement = resolveDraftInsertionPlacement(next, activeBlockIndex, current.type, nextRootDepth)

          next.splice(
            activeBlockIndex,
            subtreeBlocks.length,
            ...shiftDraftFragmentDepth(subtreeBlocks, placement.depth - current.depth, placement.parentBlockId, rootIds)
          )
          return next
        }
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
    pushToHistory(draftBlocks)
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
    const activeMultiBlockRange =
      selectedBlockRange && index >= selectedBlockRange.start && index <= selectedBlockRange.end && selectedBlockRange.start !== selectedBlockRange.end
        ? selectedBlockRange
        : null

    if (activeMultiBlockRange) {
      const interactionIssue = getMultiBlockInteractionGuard(activeMultiBlockRange)
      if (interactionIssue) {
        setBackupMessage(interactionIssue)
        return
      }
    }

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
    pushToHistory(draftBlocks)

    const sourceBlock = draftBlocks[draggingBlockIndex]
    if (!sourceBlock) {
      endBlockDrag()
      return
    }

    const isMultiBlockDrag = selectedBlockRange && draggingBlockIndex >= selectedBlockRange.start && draggingBlockIndex <= selectedBlockRange.end && selectedBlockRange.start !== selectedBlockRange.end

    let dragSourceRange: BlockSelectionRange
    let dragSubtreeSize: number

    if (isMultiBlockDrag && selectedBlockRange) {
      const interactionIssue = getMultiBlockInteractionGuard(selectedBlockRange)
      if (interactionIssue) {
        setBackupMessage(interactionIssue)
        endBlockDrag()
        return
      }

      dragSourceRange = getMultiBlockOperationRange(selectedBlockRange)
      dragSubtreeSize = dragSourceRange.end - dragSourceRange.start + 1
    } else {
      const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, draggingBlockIndex)
      dragSourceRange = { start: draggingBlockIndex, end: subtreeEndIndex }
      dragSubtreeSize = dragSourceRange.end - dragSourceRange.start + 1
    }

    if (targetIndex >= dragSourceRange.start && targetIndex <= dragSourceRange.end) {
      console.warn('Cannot drag a block range into its own subtree.')
      endBlockDrag()
      return
    }

    if (targetIndex === dragSourceRange.start - 1 && targetDepth === sourceBlock.depth) {
      console.warn('Block is already at this position.')
      endBlockDrag()
      return
    }

    if (targetIndex === dragSourceRange.end + 1 && targetDepth === sourceBlock.depth) {
      console.warn('Block is already at this position.')
      endBlockDrag()
      return
    }

    if (targetDepth !== null && isMultiBlockDrag) {
      const nextRootDepth = normalizeBlockDepth(sourceBlock.type, targetDepth)
      const appliedDelta = nextRootDepth - sourceBlock.depth

      for (let i = dragSourceRange.start; i <= dragSourceRange.end; i += 1) {
        const block = draftBlocks[i]
        if (!isNestableBlock(block.type)) {
          continue
        }

        const nextBlockDepth = normalizeBlockDepth(block.type, block.depth + appliedDelta)

        if (i !== dragSourceRange.start && targetIndex > dragSourceRange.end) {
          const precedingIndex = targetIndex - dragSubtreeSize + (i - dragSourceRange.start)
          if (precedingIndex >= 0) {
            const precedingBlock = draftBlocks[precedingIndex]
            if (precedingBlock && precedingBlock.depth < nextBlockDepth - 1) {
              console.warn(`Cannot drop multi-block range: block at index ${i} would lack sufficient preceding block depth at target location.`)
              endBlockDrag()
              return
            }
          }
        }
      }
    }

    if (targetDepth !== null) {
      const nextRootDepth = normalizeBlockDepth(sourceBlock.type, targetDepth)
      if (nextRootDepth !== targetDepth) {
        console.warn(`Invalid depth ${targetDepth} for block type ${sourceBlock.type}. Clamped to ${nextRootDepth}.`)
      }
    }

    if (isMultiBlockDrag) {
      moveDraftSubtree(dragSourceRange.start, targetIndex, targetDepth)
    } else {
      moveDraftSubtree(draggingBlockIndex, targetIndex, targetDepth)
    }

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
    setBlockSuggestions([])
  }

  function insertBlockSuggestion(block: DocumentBlockDraft) {
    if (activeBlockIndex === null || !activeLinkContext || !block.id) {
      return
    }

    const replacement = `[[${block.id}]]`
    setDraftBlocks((previous) =>
      previous.map((currentBlock, index) => {
        if (index !== activeBlockIndex) {
          return currentBlock
        }

        return {
          ...currentBlock,
          content: `${currentBlock.content.slice(0, activeLinkContext.start)}${replacement}${currentBlock.content.slice(activeCursorPosition)}`
        }
      })
    )
    setActiveCursorPosition(activeLinkContext.start + replacement.length)
    setLinkSuggestions([])
    setBlockSuggestions([])
  }

  const moveOptions = flattenTree(homeData.documentTree)
    .filter((option) => option.id !== selectedDocumentId)
    .map((option) => ({
      ...option,
      label: `${'  '.repeat(option.depth)}${option.title}`
    }))
  const documentReferences = buildDocumentReferences(homeData.documentTree)
  const plugins = homeData.plugins ?? []
  const pluginDashboardCards = homeData.pluginDashboardCards ?? []
  const pluginDocumentActions = homeData.pluginDocumentActions ?? []
  const pluginRoots = homeData.pluginHost?.roots ?? []
  const pluginWritableRoot = homeData.pluginHost?.writableRoot ?? null
  const boardGroupableColumns = useMemo(
    () => catalogColumns.filter(isBoardGroupableColumn),
    [catalogColumns]
  )
  const boardGroupingColumn = boardGroupBy === BOARD_GROUP_BY_PARENT
    ? null
    : boardGroupableColumns.find((column) => column.id === boardGroupBy) ?? null
  const standaloneDatabases = databases.filter((database) => !isDefaultDocumentDatabase(database))
  const selectedDatabase = standaloneDatabases.find((database) => database.id === databaseEntityDatabaseId) ?? null
  const activeDatabaseSavedView = databaseSavedViews.find((view) => view.id === activeDatabaseSavedViewId) ?? null
  const databaseSavedViewDirty = activeDatabaseSavedView !== null && (
    activeDatabaseSavedView.filterQuery !== databaseEntityFilterQuery
    || activeDatabaseSavedView.filterScope !== databaseEntityFilterScope
    || activeDatabaseSavedView.sortMode !== databaseEntitySortMode
    || activeDatabaseSavedView.viewMode !== databaseEntityViewMode
  )
  const databasePageColumns = databaseWorkspaceView === 'standalone' ? selectedDatabaseColumns : catalogColumns
  const databasePageTitle = databaseWorkspaceView === 'standalone' ? ui.standaloneDatabasesTitle : ui.documentCatalogTitle
  const databasePageHint = databaseWorkspaceView === 'standalone' ? ui.standaloneDatabasesHint : ui.documentCatalogHint
  const isDocumentCatalogViewActive = activePage === 'database' && databaseWorkspaceView === 'catalog'
  const trimmedDatabaseEntityFilterQuery = databaseEntityFilterQuery.trim().toLowerCase()
  const standaloneDatabaseEntityRows = databaseEntities.map((entity) => {
    const linkedDocument = entity.documentId
      ? homeData.documentCatalog.find((document) => document.id === entity.documentId) ?? null
      : null

    return {
      entity,
      linkedDocument,
      searchableDocumentText: [linkedDocument?.title ?? '', linkedDocument?.path ?? ''].join(' ').trim(),
      searchableFieldText: selectedDatabaseColumns
        .map((column) => formatDocumentDatabaseFieldValueForSearch(entity.fieldValues[column.id] ?? null))
        .join(' ')
    }
  })
  const filteredStandaloneDatabaseEntityRows = standaloneDatabaseEntityRows
    .filter(({ entity, searchableDocumentText, searchableFieldText }) => {
      if (!trimmedDatabaseEntityFilterQuery) {
        return true
      }

      if (databaseEntityFilterScope === '__document__') {
        return searchableDocumentText.toLowerCase().includes(trimmedDatabaseEntityFilterQuery)
      }

      if (databaseEntityFilterScope) {
        return formatDocumentDatabaseFieldValueForSearch(entity.fieldValues[databaseEntityFilterScope] ?? null)
          .toLowerCase()
          .includes(trimmedDatabaseEntityFilterQuery)
      }

      return [searchableDocumentText, searchableFieldText]
        .join(' ')
        .toLowerCase()
        .includes(trimmedDatabaseEntityFilterQuery)
    })
    .sort((left, right) => {
      if (databaseEntitySortMode === 'updated-asc') {
        return new Date(left.entity.updatedAt).getTime() - new Date(right.entity.updatedAt).getTime()
      }

      if (databaseEntitySortMode === 'created-desc') {
        return new Date(right.entity.createdAt).getTime() - new Date(left.entity.createdAt).getTime()
      }

      if (databaseEntitySortMode === 'created-asc') {
        return new Date(left.entity.createdAt).getTime() - new Date(right.entity.createdAt).getTime()
      }

      return new Date(right.entity.updatedAt).getTime() - new Date(left.entity.updatedAt).getTime()
    })
  const filteredStandaloneDatabaseEntityIds = filteredStandaloneDatabaseEntityRows.map(({ entity }) => entity.id)
  const selectedDatabaseEntityIdSet = new Set(selectedDatabaseEntityIds)
  const selectedVisibleDatabaseEntityIds = filteredStandaloneDatabaseEntityIds.filter((entityId) => selectedDatabaseEntityIdSet.has(entityId))
  const selectedVisibleDatabaseEntityRows = filteredStandaloneDatabaseEntityRows.filter(({ entity }) => selectedDatabaseEntityIdSet.has(entity.id))
  const selectedVisibleDatabaseEntitiesHaveLinkedDocument = selectedVisibleDatabaseEntityRows.some(({ entity }) => Boolean(entity.documentId))
  const trimmedCatalogQuery = deferredCatalogQuery.trim().toLowerCase()
  const filteredCatalog = useMemo(() => {
    if (!isDocumentCatalogViewActive) {
      return catalogDocuments
    }

    return catalogDocuments.filter((document) => {
      if (!trimmedCatalogQuery) {
        return true
      }

      const dynamicFieldSearchText = Object.values(document.fieldValues)
        .map((value) => formatDocumentDatabaseFieldValueForSearch(value))
        .join(' ')

      return [document.title, document.path, document.summary, dynamicFieldSearchText]
        .join(' ')
        .toLowerCase()
        .includes(trimmedCatalogQuery)
    })
  }, [catalogDocuments, isDocumentCatalogViewActive, trimmedCatalogQuery])
  const boardColumns = useMemo(() => {
    if (!isDocumentCatalogViewActive) {
      return []
    }

    return buildBoardColumns(filteredCatalog, boardGroupingColumn)
  }, [boardGroupingColumn, filteredCatalog, isDocumentCatalogViewActive])
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
            onCreateRoot={() => handleCreateDocument(null)}
            newRootLabel={ui.newRoot}
            dropToRootLabel={ui.dropToRoot}
            dragOverRoot={dragOverRoot}
            onRootDragOver={() => {
              if (draggingDocumentId) {
                setDragOverRoot(true)
                setDragOverDocumentId(null)
              }
            }}
            onRootDragLeave={() => setDragOverRoot(false)}
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
             onDragOverNode={(documentId) => {
               if (draggingDocumentId && draggingDocumentId !== documentId) {
                 setDragOverDocumentId(documentId)
                 setDragOverRoot(false)
               }
             }}
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
                          setSelectedDocumentId(event.documentId)
                          setActivePage('documents')
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

         {activePage === 'database' ? <section className="database-grid" data-testid="database-grid">
           <article className="panel database-panel">
            <div className="panel-head compact-head">
              <div>
                <p className="panel-label">{ui.databaseViewLabel}</p>
                <h3>{databasePageTitle}</h3>
              </div>
               <div className="toolbar-inline">
                 <button
                   className={databaseWorkspaceView === 'catalog' ? 'primary-button' : 'secondary-button'}
                   onClick={() => switchDatabaseWorkspaceView('catalog')}
                   type="button"
                 >
                   {ui.documentCatalogTitle}
                 </button>
                 <button
                   className={databaseWorkspaceView === 'standalone' ? 'primary-button' : 'secondary-button'}
                   onClick={() => switchDatabaseWorkspaceView('standalone')}
                   type="button"
                 >
                   {ui.standaloneDatabasesTitle}
                 </button>
               </div>
            </div>

            <p className="mini-hint">{databasePageHint}</p>

            {databaseWorkspaceView === 'catalog' ? (
              <>
                <div className="toolbar-inline">
                  <button className="secondary-button" onClick={() => setIsCreatingDatabaseColumn((previous) => !previous)} type="button">
                    {isCreatingDatabaseColumn ? ui.closeSchema : ui.addColumn}
                  </button>
                  <input
                    className="editor-input table-search"
                    onChange={(event) => setCatalogQuery(event.target.value)}
                    placeholder={ui.searchDocumentsPlaceholder}
                    type="text"
                    value={catalogQuery}
                  />
                  <span className="pill">{ui.customColumnsCount(catalogColumns.length)}</span>
                  <span className="pill">{ui.rowsCount(filteredCatalog.length)}</span>
                </div>

                {isCreatingDatabaseColumn ? (
                  <div className="database-schema-form">
                    <label className="editor-label">
                      {ui.columnName}
                      <input className="editor-input" onChange={(event) => setDatabaseColumnNameDraft(event.target.value)} type="text" value={databaseColumnNameDraft} />
                    </label>
                    <label className="editor-label">
                      {ui.fieldType}
                      <select className="editor-input" onChange={(event) => setDatabaseColumnTypeDraft(event.target.value as DocumentDatabaseColumnType)} value={databaseColumnTypeDraft}>
                        {Object.entries(ui.databaseColumnTypes).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    {databaseColumnTypeDraft === 'select' || databaseColumnTypeDraft === 'multi-select' ? (
                      <label className="editor-label database-schema-options">
                        {ui.options}
                        <input
                          className="editor-input"
                          onChange={(event) => setDatabaseColumnOptionsDraft(event.target.value)}
                          placeholder={ui.optionsCommaHint}
                          type="text"
                          value={databaseColumnOptionsDraft}
                        />
                      </label>
                    ) : null}
                    <div className="database-schema-actions">
                      <button
                        className="secondary-button"
                        disabled={databaseColumnNameDraft.trim().length === 0 || ((databaseColumnTypeDraft === 'select' || databaseColumnTypeDraft === 'multi-select') && normalizeDatabaseColumnOptionsInput(databaseColumnOptionsDraft).length === 0)}
                        onClick={() => void createDatabaseColumn()}
                        type="button"
                      >
                        {ui.saveColumn}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setIsCreatingDatabaseColumn(false)
                          setDatabaseColumnNameDraft('')
                          setDatabaseColumnTypeDraft('text')
                          setDatabaseColumnOptionsDraft('')
                        }}
                        type="button"
                      >
                        {ui.common.cancel}
                      </button>
                    </div>
                  </div>
                 ) : null}

                {catalogColumns.length > 0 ? (
                  <div className="database-schema-chip-row">
                    {catalogColumns.map((column, index) => (
                      <DatabaseSchemaColumnCard
                        column={column}
                        isFirst={index === 0}
                        isLast={index === catalogColumns.length - 1}
                        key={column.id}
                        onDelete={deleteDatabaseColumn}
                        onMove={moveDatabaseColumn}
                        onUpdateOptions={updateDatabaseColumnOptions}
                        onRename={renameDatabaseColumn}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mini-hint">{ui.noCustomColumnsYet}</p>
                )}

                <DocumentCatalogTable
                  columns={catalogColumns}
                  documents={filteredCatalog}
                  onSelect={openDocumentInDocumentsPage}
                  onUpdateField={updateDocumentDatabaseValue}
                  selectedDocumentId={selectedDocumentId}
                />
              </>
            ) : (
              <>
                <div className="toolbar-inline">
                  <button
                    className="secondary-button"
                    disabled={!selectedDatabase && !isCreatingDatabaseColumn}
                    onClick={() => setIsCreatingDatabaseColumn((previous) => !previous)}
                    type="button"
                  >
                    {isCreatingDatabaseColumn ? ui.closeSchema : ui.addColumn}
                  </button>
                  <button className="secondary-button" onClick={() => setIsCreatingDatabase((previous) => !previous)} type="button">
                    {isCreatingDatabase ? ui.common.cancel : ui.addDatabase}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!selectedDatabase && !isCreatingDatabaseEntity}
                    onClick={() => setIsCreatingDatabaseEntity((previous) => !previous)}
                    type="button"
                  >
                    {isCreatingDatabaseEntity ? ui.common.cancel : ui.addEntity}
                  </button>
                  <span className="pill">{ui.customColumnsCount(selectedDatabaseColumns.length)}</span>
                  <span className="pill">{ui.rowsCount(databaseEntities.length)}</span>
                </div>

                {isCreatingDatabase ? (
                  <div className="database-schema-form">
                    <label className="editor-label">
                      {ui.databaseName}
                      <input className="editor-input" onChange={(event) => setDatabaseNameDraft(event.target.value)} type="text" value={databaseNameDraft} />
                    </label>
                    <label className="editor-label">
                      {ui.databaseDescription}
                      <input className="editor-input" onChange={(event) => setDatabaseDescriptionDraft(event.target.value)} type="text" value={databaseDescriptionDraft} />
                    </label>
                    <div className="database-schema-actions">
                      <button
                        className="secondary-button"
                        disabled={databaseNameDraft.trim().length === 0}
                        onClick={() => void createDatabase()}
                        type="button"
                      >
                        {ui.createDatabase}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setIsCreatingDatabase(false)
                          setDatabaseNameDraft('')
                          setDatabaseDescriptionDraft('')
                        }}
                        type="button"
                      >
                        {ui.common.cancel}
                      </button>
                    </div>
                  </div>
                ) : null}

                {isCreatingDatabaseColumn ? (
                  <div className="database-schema-form">
                    <label className="editor-label">
                      {ui.columnName}
                      <input className="editor-input" onChange={(event) => setDatabaseColumnNameDraft(event.target.value)} type="text" value={databaseColumnNameDraft} />
                    </label>
                    <label className="editor-label">
                      {ui.fieldType}
                      <select className="editor-input" onChange={(event) => setDatabaseColumnTypeDraft(event.target.value as DocumentDatabaseColumnType)} value={databaseColumnTypeDraft}>
                        {Object.entries(ui.databaseColumnTypes).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    {databaseColumnTypeDraft === 'select' || databaseColumnTypeDraft === 'multi-select' ? (
                      <label className="editor-label database-schema-options">
                        {ui.options}
                        <input
                          className="editor-input"
                          onChange={(event) => setDatabaseColumnOptionsDraft(event.target.value)}
                          placeholder={ui.optionsCommaHint}
                          type="text"
                          value={databaseColumnOptionsDraft}
                        />
                      </label>
                    ) : null}
                    <div className="database-schema-actions">
                      <button
                        className="secondary-button"
                        disabled={!selectedDatabase || databaseColumnNameDraft.trim().length === 0 || ((databaseColumnTypeDraft === 'select' || databaseColumnTypeDraft === 'multi-select') && normalizeDatabaseColumnOptionsInput(databaseColumnOptionsDraft).length === 0)}
                        onClick={() => void createDatabaseColumn()}
                        type="button"
                      >
                        {ui.saveColumn}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setIsCreatingDatabaseColumn(false)
                          setDatabaseColumnNameDraft('')
                          setDatabaseColumnTypeDraft('text')
                          setDatabaseColumnOptionsDraft('')
                        }}
                        type="button"
                      >
                        {ui.common.cancel}
                      </button>
                    </div>
                  </div>
                 ) : null}

                {isCreatingDatabaseEntity ? (
                  <div className="database-schema-form">
                    <label className="editor-label">
                      Database
                      <select
                        className="editor-input"
                        onChange={(event) => setDatabaseEntityDatabaseId(event.target.value)}
                        value={databaseEntityDatabaseId}
                      >
                        <option value="">{ui.selectDatabasePlaceholder}</option>
                        {standaloneDatabases.map((database) => (
                          <option key={database.id} value={database.id}>{database.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="editor-label">
                      {ui.linkToDocumentOptional}
                      <select
                        className="editor-input database-entity-document-select"
                        onChange={(event) => setDatabaseEntityDocumentId(event.target.value)}
                        value={databaseEntityDocumentId}
                      >
                        <option value="">{ui.noLinkedDocument}</option>
                        {homeData.documentCatalog.map((document) => (
                          <option key={document.id} value={document.id}>{document.path}</option>
                        ))}
                      </select>
                    </label>
                    {selectedDatabaseColumns.length > 0 ? (
                      <div className="database-entity-field-grid database-entity-field-grid-form">
                        {selectedDatabaseColumns.map((column) => (
                          <label className="editor-label database-entity-field" key={`draft-${column.id}`}>
                            {column.name}
                            <DatabaseFieldEditor
                              column={column}
                              textCommitMode="change"
                              value={databaseEntityFieldValues[column.id] ?? null}
                              onChangeValue={(value) => {
                                const normalizedValue = normalizeDocumentDatabaseFieldValue(value)
                                setDatabaseEntityFieldValues((previous) => {
                                  const nextFieldValues = { ...previous }
                                  if (normalizedValue === null) {
                                    delete nextFieldValues[column.id]
                                  } else {
                                    nextFieldValues[column.id] = normalizedValue
                                  }
                                  return nextFieldValues
                                })
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    ) : null}
                    <div className="database-schema-actions">
                      <button
                        className="secondary-button"
                        onClick={() => void createDatabaseEntity()}
                        type="button"
                        disabled={!databaseEntityDatabaseId}
                      >
                        {ui.createEntity}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setIsCreatingDatabaseEntity(false)
                          setDatabaseEntityDocumentId('')
                          setDatabaseEntityFieldValues({})
                        }}
                        type="button"
                      >
                        {ui.common.cancel}
                      </button>
                    </div>
                  </div>
                ) : null}

                {standaloneDatabases.length > 0 ? (
                  <>
                    <div className="toolbar-inline" style={{ flexWrap: 'wrap', marginBottom: '12px' }}>
                      {standaloneDatabases.map((database) => (
                        <button
                          className={database.id === databaseEntityDatabaseId ? 'primary-button' : 'secondary-button'}
                          key={database.id}
                          onClick={() => setDatabaseEntityDatabaseId(database.id)}
                          type="button"
                        >
                          {database.name}
                        </button>
                      ))}
                    </div>

                    {selectedDatabase ? (
                      <>
                        <div className="toolbar-inline" style={{ flexWrap: 'wrap', marginBottom: '12px', justifyContent: 'flex-start' }}>
                          <span className="pill">{ui.databaseSavedViewsLabel}</span>
                          <select
                            className="editor-input database-saved-view-select"
                            onChange={(event) => handleDatabaseSavedViewSelect(event.target.value)}
                            value={activeDatabaseSavedViewId}
                          >
                            <option value="">{ui.databaseSavedViewDraftOption}</option>
                            {databaseSavedViews.map((view) => (
                              <option key={view.id} value={view.id}>{view.name}</option>
                            ))}
                          </select>
                          <button
                            className="secondary-button database-saved-view-create-button"
                            onClick={() => beginCurrentDatabaseSavedViewCreation()}
                            type="button"
                          >
                            {ui.saveCurrentDatabaseView}
                          </button>
                          {isCreatingDatabaseSavedView ? (
                            <>
                              <input
                                aria-label={ui.databaseSavedViewNamePrompt}
                                className="editor-input database-saved-view-name-input"
                                onChange={(event) => setDatabaseSavedViewNameDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void saveCurrentDatabaseSavedView()
                                  }

                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    cancelCurrentDatabaseSavedViewCreation()
                                  }
                                }}
                                placeholder={ui.databaseSavedViewNamePrompt}
                                type="text"
                                value={databaseSavedViewNameDraft}
                              />
                              <button
                                className="secondary-button database-saved-view-confirm-button"
                                disabled={!databaseSavedViewNameDraft.trim()}
                                onClick={() => void saveCurrentDatabaseSavedView()}
                                type="button"
                              >
                                {ui.saveCurrentDatabaseView}
                              </button>
                              <button
                                className="secondary-button database-saved-view-cancel-button"
                                onClick={() => cancelCurrentDatabaseSavedViewCreation()}
                                type="button"
                              >
                                {ui.common.cancel}
                              </button>
                            </>
                          ) : null}
                          <button
                            className="secondary-button database-saved-view-update-button"
                            disabled={!activeDatabaseSavedView || !databaseSavedViewDirty}
                            onClick={() => void updateCurrentDatabaseSavedView()}
                            type="button"
                          >
                            {ui.updateCurrentDatabaseView}
                          </button>
                          <button
                            className="secondary-button database-saved-view-delete-button"
                            disabled={!activeDatabaseSavedView}
                            onClick={() => void deleteCurrentDatabaseSavedView()}
                            type="button"
                          >
                            {ui.deleteCurrentDatabaseView}
                          </button>
                          <button
                            className="secondary-button database-delete-button"
                            onClick={() => void deleteCurrentDatabase()}
                            type="button"
                          >
                            {ui.deleteCurrentDatabase}
                          </button>
                        </div>

                        {databaseEntities.length > 0 ? (
                        <>
                          <div className="toolbar-inline" style={{ flexWrap: 'wrap', marginBottom: '12px', justifyContent: 'flex-start' }}>
                            <input
                              className="editor-input database-entity-filter-query"
                              onChange={(event) => setDatabaseEntityFilterQuery(event.target.value)}
                              placeholder={ui.searchDatabaseEntitiesPlaceholder}
                              type="search"
                              value={databaseEntityFilterQuery}
                            />
                            <select
                              className="editor-input database-entity-filter-scope-select"
                              onChange={(event) => setDatabaseEntityFilterScope(event.target.value as DatabaseEntityFilterScope)}
                              value={databaseEntityFilterScope}
                            >
                              <option value="">{ui.databaseEntityFilterAllFields}</option>
                              <option value="__document__">{ui.databaseEntityFilterLinkedDocument}</option>
                              {selectedDatabaseColumns.map((column) => (
                                <option key={column.id} value={column.id}>{ui.databaseEntityFilterField(column.name)}</option>
                              ))}
                            </select>
                            <select
                              className="editor-input database-entity-sort-select"
                              onChange={(event) => setDatabaseEntitySortMode(event.target.value as DatabaseEntitySortMode)}
                              value={databaseEntitySortMode}
                            >
                              <option value="updated-desc">{ui.databaseEntitySortUpdatedDesc}</option>
                              <option value="updated-asc">{ui.databaseEntitySortUpdatedAsc}</option>
                              <option value="created-desc">{ui.databaseEntitySortCreatedDesc}</option>
                              <option value="created-asc">{ui.databaseEntitySortCreatedAsc}</option>
                            </select>
                            <span className="pill">{ui.databaseEntityViewModeLabel}</span>
                            <button
                              className={databaseEntityViewMode === 'cards' ? 'primary-button database-entity-cards-view-button' : 'secondary-button database-entity-cards-view-button'}
                              onClick={() => setDatabaseEntityViewMode('cards')}
                              type="button"
                            >
                              {ui.databaseEntityCardsView}
                            </button>
                            <button
                              className={databaseEntityViewMode === 'table' ? 'primary-button database-entity-table-view-button' : 'secondary-button database-entity-table-view-button'}
                              onClick={() => setDatabaseEntityViewMode('table')}
                              type="button"
                            >
                              {ui.databaseEntityTableView}
                            </button>
                            <span className="pill">{ui.filteredRowsCount(filteredStandaloneDatabaseEntityRows.length, databaseEntities.length)}</span>
                          </div>

                          <div className="toolbar-inline" style={{ flexWrap: 'wrap', marginBottom: '12px', justifyContent: 'flex-start' }}>
                            <button
                              className="secondary-button database-entity-select-visible-button"
                              disabled={filteredStandaloneDatabaseEntityRows.length === 0}
                              onClick={selectVisibleDatabaseEntities}
                              type="button"
                            >
                              {ui.selectVisibleDatabaseEntities}
                            </button>
                            <button
                              className="secondary-button"
                              disabled={selectedVisibleDatabaseEntityIds.length === 0}
                              onClick={() => setSelectedDatabaseEntityIds([])}
                              type="button"
                            >
                              {ui.common.clear}
                            </button>
                            <button
                              className="secondary-button database-entity-delete-selected-button"
                              disabled={selectedVisibleDatabaseEntityIds.length === 0}
                              onClick={() => void deleteSelectedDatabaseEntities()}
                              type="button"
                            >
                              {ui.deleteSelectedDatabaseEntities(selectedVisibleDatabaseEntityIds.length)}
                            </button>
                            <span className="pill">{ui.selectedDatabaseEntitiesCount(selectedVisibleDatabaseEntityIds.length)}</span>
                          </div>

                          {selectedVisibleDatabaseEntityIds.length > 0 ? (
                            <section className="database-entity-bulk-panel">
                              <div className="database-entity-bulk-panel-head">
                                <div>
                                  <p className="panel-label">{ui.databaseEntityBulkEditLabel}</p>
                                  <h4>{ui.databaseEntityBulkEditTitle(selectedVisibleDatabaseEntityIds.length)}</h4>
                                </div>
                                <div className="toolbar-inline" style={{ justifyContent: 'flex-start' }}>
                                  <button
                                    className="secondary-button database-entity-bulk-document-clear-button"
                                    disabled={!selectedVisibleDatabaseEntitiesHaveLinkedDocument}
                                    onClick={() => void clearSelectedDatabaseEntityDocuments()}
                                    type="button"
                                  >
                                    {ui.clearSelectedDatabaseEntityDocuments(selectedVisibleDatabaseEntityIds.length)}
                                  </button>
                                  <button
                                    className="secondary-button"
                                    onClick={() => setDatabaseEntityBulkFieldValues({})}
                                    type="button"
                                  >
                                    {ui.common.clear}
                                  </button>
                                </div>
                              </div>
                              <p className="mini-hint">{ui.databaseEntityBulkEditHint}</p>
                              {selectedDatabaseColumns.length > 0 ? (
                                <div className="database-entity-field-grid">
                                  {selectedDatabaseColumns.map((column) => (
                                    <div
                                      className="database-entity-bulk-field"
                                      data-column-id={column.id}
                                      data-column-name={column.name}
                                      key={`bulk-${column.id}`}
                                    >
                                      <label className="editor-label database-entity-field">
                                        {column.name}
                                        <DatabaseFieldEditor
                                          column={column}
                                          textCommitMode="change"
                                          value={databaseEntityBulkFieldValues[column.id] ?? null}
                                          onChangeValue={(value) => {
                                            updateDatabaseEntityBulkFieldValue(column.id, value)
                                          }}
                                        />
                                      </label>
                                      <div className="database-entity-bulk-field-actions">
                                        <button
                                          className="secondary-button database-entity-bulk-field-apply-button"
                                          onClick={() => void applyDatabaseEntityFieldToSelected(column.id)}
                                          type="button"
                                        >
                                          {ui.applySelectedDatabaseEntityField(column.name, selectedVisibleDatabaseEntityIds.length)}
                                        </button>
                                        <button
                                          className="secondary-button database-entity-bulk-field-clear-button"
                                          onClick={() => void clearDatabaseEntityFieldFromSelected(column.id)}
                                          type="button"
                                        >
                                          {ui.clearSelectedDatabaseEntityField(column.name, selectedVisibleDatabaseEntityIds.length)}
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </section>
                          ) : null}

                          <p className="mini-hint">{databaseEntityViewMode === 'table' ? ui.databaseEntityTableHint : ui.databaseEntityCardsHint}</p>

                          {filteredStandaloneDatabaseEntityRows.length > 0 ? (
                            databaseEntityViewMode === 'table' ? (
                              <StandaloneDatabaseEntityTable
                                columns={selectedDatabaseColumns}
                                documentCatalog={homeData.documentCatalog}
                                entities={filteredStandaloneDatabaseEntityRows}
                                onDeleteEntity={deleteDatabaseEntity}
                                onToggleSelection={toggleDatabaseEntitySelection}
                                onUpdateDocument={updateDatabaseEntityDocument}
                                onUpdateField={updateDatabaseEntityField}
                                selectedEntityIds={selectedDatabaseEntityIdSet}
                              />
                            ) : (
                              <div className="document-list" style={{ marginBottom: '16px' }}>
                                {filteredStandaloneDatabaseEntityRows.map(({ entity, linkedDocument }) => {
                                  const entityLabel = linkedDocument?.title ?? `Entity ${entity.id.slice(0, 8)}`

                                  return (
                                    <div className="document-row" key={entity.id}>
                                      <div className={`database-entity-card${selectedDatabaseEntityIdSet.has(entity.id) ? ' database-entity-card-selected' : ''}`}>
                                        <div className="database-entity-head">
                                          <div className="database-entity-head-main">
                                            <label className="database-entity-select-toggle">
                                              <input
                                                aria-label={ui.selectDatabaseEntity(entityLabel)}
                                                checked={selectedDatabaseEntityIdSet.has(entity.id)}
                                                className="database-entity-select-checkbox"
                                                onChange={(event) => toggleDatabaseEntitySelection(entity.id, event.target.checked)}
                                                type="checkbox"
                                              />
                                            </label>
                                            <div>
                                              <strong>{entityLabel}</strong>
                                              <p>{linkedDocument?.path ?? ui.noLinkedDocument}</p>
                                            </div>
                                          </div>
                                          <div className="document-meta">
                                            <span>{new Date(entity.updatedAt).toLocaleDateString(ui.locale)}</span>
                                            <button className="secondary-button" onClick={() => void deleteDatabaseEntity(entity.id)} type="button">
                                              {ui.common.delete}
                                            </button>
                                          </div>
                                        </div>
                                        <label className="editor-label" style={{ marginBottom: '12px' }}>
                                          {ui.linkToDocumentOptional}
                                          <select
                                            className="editor-input database-entity-document-select"
                                            onChange={(event) => {
                                              void updateDatabaseEntityDocument(entity, event.target.value || null)
                                            }}
                                            value={entity.documentId ?? ''}
                                          >
                                            <option value="">{ui.noLinkedDocument}</option>
                                            {homeData.documentCatalog.map((document) => (
                                              <option key={document.id} value={document.id}>{document.path}</option>
                                            ))}
                                          </select>
                                        </label>
                                        {selectedDatabaseColumns.length > 0 ? (
                                          <div className="database-entity-field-grid">
                                            {selectedDatabaseColumns.map((column) => (
                                              <label className="editor-label database-entity-field" key={`${entity.id}-${column.id}`}>
                                                {column.name}
                                                <DatabaseFieldEditor
                                                  column={column}
                                                  value={entity.fieldValues[column.id] ?? null}
                                                  onChangeValue={(value) => {
                                                    void updateDatabaseEntityField(entity, column.id, value)
                                                  }}
                                                />
                                              </label>
                                            ))}
                                          </div>
                                        ) : null}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )
                          ) : (
                            <p className="mini-hint">{ui.noFilteredDatabaseEntitiesYet(selectedDatabase.name)}</p>
                          )}
                        </>
                        ) : (
                          <p className="mini-hint">{ui.noDatabaseEntitiesYet(selectedDatabase.name)}</p>
                        )}
                      </>
                    ) : null}
                  </>
                ) : (
                  <p className="mini-hint">{ui.noIndependentDatabasesYet}</p>
                )}

                {selectedDatabaseColumns.length > 0 ? (
                  <div className="database-schema-chip-row">
                    {selectedDatabaseColumns.map((column, index) => (
                      <DatabaseSchemaColumnCard
                        column={column}
                        isFirst={index === 0}
                        isLast={index === selectedDatabaseColumns.length - 1}
                        key={column.id}
                        onDelete={deleteDatabaseColumn}
                        onMove={moveDatabaseColumn}
                        onUpdateOptions={updateDatabaseColumnOptions}
                        onRename={renameDatabaseColumn}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mini-hint">{selectedDatabase ? ui.noStandaloneDatabaseColumnsYet(selectedDatabase.name) : ui.noIndependentDatabasesYet}</p>
                )}
              </>
            )}
          </article>

          {databaseWorkspaceView === 'catalog' ? (
            <article className="panel board-panel">
              <div className="panel-head compact-head">
                <div>
                  <p className="panel-label">{ui.boardViewLabel}</p>
                  <h3>{ui.boardGroupedBy(boardGroupingColumn?.name ?? null)}</h3>
                </div>
                <div className="toolbar-inline">
                  <select className="editor-input" onChange={(event) => setBoardGroupBy(event.target.value)} value={boardGroupBy}>
                    <option value={BOARD_GROUP_BY_PARENT}>{ui.parentBucket}</option>
                    {boardGroupableColumns.map((column) => (
                      <option key={column.id} value={column.id}>{column.name} ({getDatabaseColumnTypeLabel(column.type)})</option>
                    ))}
                  </select>
                  <span className="pill">{ui.boardColumnsCount(boardColumns.length)}</span>
                </div>
              </div>

              <p className="mini-hint">
                {boardGroupingColumn
                  ? ui.boardHintForColumn(boardGroupingColumn.name, boardGroupingColumn.type === 'multi-select')
                  : ui.boardHintForParent}
              </p>

              <DocumentBoard
                columns={boardColumns}
                onSelect={openDocumentInDocumentsPage}
                selectedDocumentId={selectedDocumentId}
                draggingDocumentId={draggingDocumentId}
                dragOverColumnId={dragOverBoardColumnId}
                onDragStart={beginDrag}
                onDragEnd={endDrag}
                onDragOverColumn={(columnId) => {
                  if (draggingDocumentId) {
                    setDragOverBoardColumnId(columnId)
                    setDragOverDocumentId(null)
                    setDragOverRoot(false)
                  }
                }}
                onDropOnColumn={dropOnBoardTarget}
              />
            </article>
          ) : null}
        </section> : null}

         {activePage === 'documents' ? <section className="workspace-grid" data-testid="workspace-grid">
           <article className="panel preview-panel">
            <DocumentPreviewHeader
              autoSaveFlash={autoSaveFlash}
              canRedo={editHistoryPointerRef.current < editHistoryRef.current.length - 1}
              canUndo={editHistoryPointerRef.current > 0}
              detailLoading={detailLoading}
              documentsAuxPanelOpen={documentsAuxPanelOpen}
              isPinned={selectedDocument ? pinnedDocumentIds.has(selectedDocument.id) : false}
              isSaving={isSaving}
              isZh={isZh}
              mdCopyFlash={mdCopyFlash}
              moveOptions={moveOptions}
              moveTargetId={moveTargetId}
              onAddChild={() => {
                if (selectedDocument) {
                  void handleCreateDocument(selectedDocument.id)
                }
              }}
              onCopyMarkdown={() => {
                void copyDocumentAsMarkdown()
              }}
              onDelete={() => {
                void deleteSelectedDocument()
              }}
              onMove={() => {
                void moveSelectedDocument()
              }}
              onMoveTargetChange={setMoveTargetId}
              onRedo={redoEdit}
              onSave={() => {
                void saveDocument()
              }}
              onSaveMarkdown={() => {
                void saveDocumentAsMarkdown()
              }}
              onToggleAuxPanel={() => setDocumentsAuxPanelOpen((previous) => !previous)}
              onTogglePin={() => {
                if (selectedDocument) {
                  togglePinDocument(selectedDocument.id)
                }
              }}
              onUndo={undoEdit}
              selectedDocumentId={selectedDocumentId}
              selectedDocumentTitle={selectedDocument?.title ?? null}
              ui={ui}
            />

            {selectedDocument ? (
              <>
                <DocumentSummaryCard
                  onSummaryChange={setDraftSummary}
                  onTitleChange={setDraftTitle}
                  path={selectedDocument.path}
                  summary={draftSummary}
                  summaryLabel={ui.common.summary}
                  title={draftTitle}
                  titleLabel={ui.common.title}
                  updatedText={ui.updatedAt(selectedDocument.updatedAt)}
                />

                <DocumentOutlinePanel
                  emptyHeadingTitleLevel1={isZh ? '标题 1' : 'Heading 1'}
                  emptyHeadingTitleLevel2={isZh ? '标题 2' : 'Heading 2'}
                  items={draftBlocks
                    .map((block, index) => ({ block, index }))
                    .filter(({ block }) => block.type === 'heading-1' || block.type === 'heading-2')
                    .map(({ block, index }) => ({
                      index,
                      level: block.type === 'heading-1' ? 1 : 2,
                      title: block.content
                    }))}
                  onSelect={(blockIndex) => {
                    setActiveBlockIndex(blockIndex)
                    setPendingFocusBlockIndex(blockIndex)
                  }}
                  title={isZh ? '大纲' : 'Outline'}
                />

                <div className="preview-section">
                  <p className="panel-label">{ui.blocksPanelLabel}</p>
                    <div
                      className="block-editor-list"
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
                          event.preventDefault()
                          setIsBlockSearchOpen(true)
                        }
                      }}
                    >
                      <BlockSearchPanel
                        isOpen={isBlockSearchOpen}
                        items={blockSearchItems}
                        noMatchText={ui.noBlocksMatchSearch}
                        onClose={() => {
                          setIsBlockSearchOpen(false)
                          setBlockSearchQuery('')
                        }}
                        onQueryChange={setBlockSearchQuery}
                        onSelect={(blockIndex) => {
                          setActiveBlockIndex(blockIndex)
                          setIsBlockSearchOpen(false)
                          setBlockSearchQuery('')
                          setPendingFocusBlockIndex(blockIndex)
                        }}
                        placeholder={ui.searchBlocksPlaceholder}
                        query={blockSearchQuery}
                      />
                      {selectedBlockRange ? (
                        <BlockSelectionToolbar
                          canMoveDown={canMoveSelectionDown}
                          canMoveUp={canMoveSelectionUp}
                          clearLabel={ui.clear}
                          conversionOptions={{
                            paragraph: getBlockConversionLabel('paragraph'),
                            todo: getBlockConversionLabel('todo'),
                            quote: getBlockConversionLabel('quote'),
                            'bulleted-list': getBlockConversionLabel('bulleted-list'),
                            'numbered-list': getBlockConversionLabel('numbered-list')
                          }}
                          convertLabel={ui.convert}
                          copyBlocksLabel={ui.copyBlocks}
                          copyTextLabel={ui.copyText}
                          cutLabel={ui.cut}
                          deleteLabel={ui.common.delete}
                          duplicateLabel={ui.duplicate}
                          hasCrossParent={selectedBlockCount > 1 && !selectedBlockInteractionIssue && !selectedVisibleSiblingSlice}
                          hasHiddenCollapsedContent={selectedBlockHasHiddenCollapsedContent}
                          hintLabel={ui.blockSelectionHint({
                            start: selectedBlockRange.start,
                            end: selectedBlockRange.end,
                            actionCount: selectedBlockActionCount,
                            selectedCount: selectedBlockCount,
                            incoherent: !isSelectionCoherent(selectedBlockRange),
                            hasHiddenCollapsedContent: selectedBlockHasHiddenCollapsedContent,
                            selectedBlockInteractionIssue: selectedBlockCount > 1 ? selectedBlockInteractionIssue : null
                          })}
                          interactionIssue={selectedBlockInteractionIssue}
                          isIncoherent={!isSelectionCoherent(selectedBlockRange)}
                          moveDownLabel={ui.moveDown}
                          moveUpLabel={ui.moveUp}
                          onClear={clearBlockSelection}
                          onConvert={() => convertSelectedBlocks(selectedBlockConversionType)}
                          onConversionTypeChange={setSelectedBlockConversionType}
                          onCopyBlocks={copySelectedBlocks}
                          onCopyText={copySelectedBlocksAsPlainText}
                          onCut={cutSelectedBlocks}
                          onDelete={deleteSelectedBlocks}
                          onDuplicate={duplicateSelectedBlocks}
                          onMoveDown={() => moveSelectedBlocks(1)}
                          onMoveUp={() => moveSelectedBlocks(-1)}
                          rangeEnd={selectedBlockRange.end}
                          rangeStart={selectedBlockRange.start}
                          selectedBlockActionCount={selectedBlockActionCount}
                          selectedBlockConversionType={selectedBlockConversionType}
                          selectedBlockCount={selectedBlockCount}
                          selectedVisibleBlockCount={selectedVisibleBlockCount}
                          summaryLabel={ui.blockSelectionSummary({
                            visibleCount: selectedVisibleBlockCount,
                            selectedCount: selectedBlockCount,
                            actionCount: selectedBlockActionCount,
                            incoherent: !isSelectionCoherent(selectedBlockRange),
                            hasHiddenCollapsedContent: selectedBlockHasHiddenCollapsedContent,
                            selectedBlockInteractionIssue,
                            hasCrossParent: selectedBlockCount > 1 && !selectedBlockInteractionIssue && !selectedVisibleSiblingSlice
                          })}
                        />
                      ) : null}
                      {getVisibleBlocks(draftBlocks).map((block, filteredIndex) => {
                        const index = draftBlocks.indexOf(block)
                        const dropPreview =
                          draggingBlockIndex !== null && dragOverBlockIndex === index
                            ? getBlockDropPreview(draftBlocks, draggingBlockIndex, index, dragOverBlockDepth)
                            : null
                        const isSelected = isBlockSelected(index)
                        const indentPx = isNestableBlock(block.type) ? block.depth * BLOCK_INDENT_SIZE : 0

                        // Compute number label for numbered-list
                        let numberLabel = ''
                        if (block.type === 'numbered-list') {
                          let count = 0
                          for (let i = index; i >= 0; i--) {
                            const b = draftBlocks[i]
                            if (b.type !== 'numbered-list' || b.depth < block.depth) break
                            if (b.depth === block.depth) count++
                          }
                          numberLabel = `${count}.`
                        }

                        return (
                          <BlockEditorRow
                            key={block.id ?? `${selectedDocument.id}-draft-${index}`}
                            activeBlockIndex={activeBlockIndex}
                            activeSlashCommand={activeSlashCommand}
                            activeSlashContext={activeSlashContext}
                            adjustBlockDepth={adjustBlockDepth}
                            adjustSelectedBlocksDepth={adjustSelectedBlocksDepth}
                            applySlashCommand={applySlashCommand}
                            beginBlockDrag={beginBlockDrag}
                            notifyBlockMouseDown={notifyBlockMouseDown}
                            handleBlockMouseEnter={handleBlockMouseEnter}
                            block={block}
                            blockHasChildren={blockHasChildren}
                            blockTextareaRefs={blockTextareaRefs}
                            BLOCK_INDENT_SIZE={BLOCK_INDENT_SIZE}
                            canMoveSelectedRange={canMoveSelectedRange}
                            captureBlockCursor={captureBlockCursor}
                            continueBlockAt={continueBlockAt}
                            deleteSelectedBlocks={deleteSelectedBlocks}
                            dismissSlashCommand={dismissSlashCommand}
                            draftBlocks={draftBlocks}
                            downgradeBlockAt={downgradeBlockAt}
                            dropBlockAt={dropBlockAt}
                            dropPreview={dropPreview}
                            duplicateDraftBlock={duplicateDraftBlock}
                            duplicateSelectedBlocks={duplicateSelectedBlocks}
                            endBlockDrag={endBlockDrag}
                            endBlockRangeSelection={endBlockRangeSelection}
                            filteredSlashCommands={filteredSlashCommands}
                            getDraggedBlockDepthPreview={getDraggedBlockDepthPreview}
                            getMultiBlockOperationRange={getMultiBlockOperationRange}
                            getNextSiblingSubtreeStartIndex={getNextSiblingSubtreeStartIndex}
                            getPreviousSiblingSubtreeStartIndex={getPreviousSiblingSubtreeStartIndex}
                            getVisibleBlockCountInRange={getVisibleBlockCountInRange}
                            handleBlockContentChange={handleBlockContentChange}
                            navigateInlineReferenceAtCursor={navigateInlineReferenceAtCursor}
                            handleBlockPaste={handleBlockPaste}
                            indentPx={indentPx}
                            index={index}
                            isHighlighted={block.id === highlightedBlockId}
                            isBlockRangeSelecting={isBlockRangeSelecting}
                            isSelected={isSelected}
                            isSelectionCoherent={isSelectionCoherent}
                            isZh={uiLanguage === 'zh-CN'}
                            mergeWithPreviousBlock={mergeWithPreviousBlock}
                            moveSelectedBlocks={moveSelectedBlocks}
                            moveDraftBlockBySibling={moveDraftBlockBySibling}
                            numberLabel={numberLabel}
                            removeSelectedBlockRange={removeSelectedBlockRange}
                            selectBlockRange={selectBlockRange}
                            selectAllBlocks={selectAllBlocks}
                            selectedBlockCount={selectedBlockCount}
                            selectedBlockRange={selectedBlockRange}
                            selectedDocument={selectedDocument}
                            serializeDraftBlockRange={serializeDraftBlockRange}
                            setDragOverBlockDepth={setDragOverBlockDepth}
                            setDragOverBlockIndex={setDragOverBlockIndex}
                            setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
                            splitDraftBlock={splitDraftBlock}
                            toggleBlockCollapse={toggleBlockCollapse}
                            ui={ui}
                            updateDraftBlock={updateDraftBlock}
                            updateBlockHighlight={updateBlockHighlight}
                            insertDraftBlockAt={insertDraftBlockAt}
                            collapsedBlockIds={collapsedBlockIds}
                          />
                        )
                      })}
                      <button className="secondary-button" onClick={addDraftBlock} type="button">
                        {ui.addBlock}
                      </button>
                      {activeLinkContext ? (
                        <LinkSuggestionPanel
                          blockSuggestions={blockSuggestions}
                          blocksLabel={ui.blocksInDocument}
                          linkedDocsLabel={ui.linkedDocuments}
                          linkSuggestions={linkSuggestions}
                          noMatchingLabel={ui.noMatchingSuggestions}
                          onSelectBlockSuggestion={insertBlockSuggestion}
                          onSelectLinkSuggestion={insertLinkSuggestion}
                          query={activeLinkContext.query}
                          queryLabel={ui.linkQuery}
                        />
                      ) : (
                        <p className="mini-hint">{ui.editorHelpText}</p>
                      )}
                    </div>
                </div>

                {/* ── Floating Slash Command Panel ── */}
                {activeSlashContext && slashPanelPos ? (
                  <FloatingSlashCommandPanel
                    x={slashPanelPos.x}
                    y={slashPanelPos.y}
                    query={activeSlashContext.query}
                    commands={filteredSlashCommands.map((cmd) => ({
                      id: cmd.id,
                      label: cmd.label,
                      description: cmd.description
                    }))}
                    activeCommandId={activeSlashCommand?.id}
                    noMatchingLabel={ui.noMatchingCommands}
                    onSelectCommand={(cmd) => {
                      const fullCommand = filteredSlashCommands.find((c) => c.id === cmd.id)
                      if (fullCommand) {
                        applySlashCommand(fullCommand)
                      }
                    }}
                    onHoverCommand={setSelectedSlashCommandIndex}
                  />
                ) : null}

                <DocumentsAuxPanel
                  aiAnswer={aiAnswer}
                  aiAsking={aiAsking}
                  aiAutomationsRunning={aiAutomationsRunning}
                  aiContextError={aiContextError}
                  aiContextResults={aiContextResults}
                  aiContextSearching={aiContextSearching}
                  aiEnabled={homeData.aiConfig.enabled}
                  aiPromptDraft={aiPromptDraft}
                  hasApiKey={homeData.aiConfig.hasApiKey}
                  isOpen={documentsAuxPanelOpen}
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
                  onRunPluginAction={(action: PluginDocumentAction) => {
                    void runPluginDocumentAction(action)
                  }}
                  pluginActionBusyKey={pluginActionBusyKey}
                  pluginDocumentActions={pluginDocumentActions}
                  relationContent={(
                    <div className="relation-grid">
                      <RelationList
                        title={ui.relationChildrenTitle}
                        emptyText={ui.relationChildrenEmpty}
                        links={selectedDocument.children.map((child) => ({
                          id: child.id,
                          title: child.title,
                          path: child.path,
                          label: 'child'
                        }))}
                        onSelect={openDocumentInDocumentsPage}
                      />
                      <RelationList
                        title={ui.relationOutgoingTitle}
                        emptyText={ui.relationOutgoingEmpty}
                        links={selectedDocument.outgoingLinks}
                        onSelect={openDocumentInDocumentsPage}
                      />
                      <RelationList
                        title={ui.relationBacklinksTitle}
                        emptyText={ui.relationBacklinksEmpty}
                        links={selectedDocument.backlinks}
                        onSelect={openDocumentInDocumentsPage}
                      />
                    </div>
                  )}
                  ui={ui}
                />

                {(() => {
                  const stats = getDocumentStats()
                  return (
                    <DocumentStatsBar
                      blockCount={stats.blockCount}
                      blocksLabel={ui.docStatBlocks}
                      charCount={stats.charCount}
                      charsLabel={ui.docStatCharacters}
                      codeBlockCount={stats.codeBlockCount}
                      codeBlocksLabel={ui.docStatCodeBlocks}
                      todoCount={stats.todoCount}
                      todosLabel={ui.docStatTodos}
                      wordCount={stats.wordCount}
                      wordsLabel={ui.docStatWords}
                    />
                  )
                })()}
              </>
            ) : (
              <div className="empty-preview">
                <p>{ui.emptyDocumentState}</p>
              </div>
            )}
          </article>
        </section> : null}

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
          <section className="detail-grid">
          <article className="panel large-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">{ui.storageLabel}</p>
                <h3>{ui.storageTitle}</h3>
              </div>
              {loading ? <span className="pill">{ui.common.loading}</span> : <span className="pill">{ui.common.ready}</span>}
            </div>
            <dl className="meta-grid">
              <div>
                <dt>{ui.databasePath}</dt>
                <dd>{homeData.summary.databasePath || ui.initializing}</dd>
              </div>
              <div>
                <dt>{ui.backupRoot}</dt>
                <dd>{homeData.summary.backupRoot || ui.initializing}</dd>
              </div>
              <div>
                <dt>{ui.lastBackup}</dt>
                <dd>{homeData.summary.lastBackupAt ? new Date(homeData.summary.lastBackupAt).toLocaleString(ui.locale) : ui.notYetExported}</dd>
              </div>
              <div>
                <dt>{ui.aiEndpoint}</dt>
                <dd>{homeData.aiConfig.baseUrl}</dd>
              </div>
            </dl>
            {activePage === 'settings' ? (
              <div className="editor-fields" style={{ marginTop: '16px' }}>
                <label className="editor-label">
                  {ui.languageSwitchLabel}
                  <select className="editor-input" onChange={(event) => setUiLanguage(event.target.value as UiLanguage)} value={uiLanguage}>
                    <option value="zh-CN">{ui.languageOptionZh}</option>
                    <option value="en-US">{ui.languageOptionEn}</option>
                  </select>
                </label>
                <label className="toggle-row">
                  <input checked={aiEnabledDraft} onChange={(event) => setAiEnabledDraft(event.target.checked)} type="checkbox" />
                  <span>{ui.enableAiFeatures}</span>
                </label>
                <label className="toggle-row">
                  <input checked={aiAutoSummaryOnSaveDraft} onChange={(event) => setAiAutoSummaryOnSaveDraft(event.target.checked)} type="checkbox" />
                  <span>{ui.autoSummaryWhenEmpty}</span>
                </label>
                {/* 普通模型 */}
                <label className="editor-label">
                  {ui.baseUrl}
                  <input className="editor-input" onChange={(event) => setAiBaseUrlDraft(event.target.value)} type="text" value={aiBaseUrlDraft} />
                </label>
                <label className="editor-label">
                  {ui.model}
                  <input className="editor-input" onChange={(event) => setAiModelDraft(event.target.value)} type="text" value={aiModelDraft} />
                </label>
                <label className="editor-label">
                  {ui.apiKeyLabel}
                  <input className="editor-input" onChange={(event) => setAiApiKeyDraft(event.target.value)} type="password" value={aiApiKeyDraft} />
                </label>
                {/* 向量模型 */}
                <label className="editor-label">
                  {ui.embeddingBaseUrl}
                  <input className="editor-input" onChange={(event) => setAiEmbeddingBaseUrlDraft(event.target.value)} type="text" placeholder={isZh ? '留空则自动推导' : 'Leave blank to auto-derive'} value={aiEmbeddingBaseUrlDraft} />
                </label>
                <label className="editor-label">
                  {ui.embeddingModel}
                  <input className="editor-input" onChange={(event) => setAiEmbeddingModelDraft(event.target.value)} type="text" value={aiEmbeddingModelDraft} />
                </label>
                <label className="editor-label">
                  {ui.embeddingApiKeyLabel}
                  <input className="editor-input" onChange={(event) => setAiEmbeddingApiKeyDraft(event.target.value)} type="password" placeholder={isZh ? '留空则使用上述 Key' : 'Leave blank to use above key'} value={aiEmbeddingApiKeyDraft} />
                </label>
                <button className="secondary-button" disabled={aiSaving} onClick={saveAiConfig} type="button">
                  {aiSaving ? ui.common.saving : ui.saveAiSettings}
                </button>
                <button className="secondary-button" onClick={() => setActivePage('plugins')} type="button">
                  {isZh ? '打开插件中心' : 'Open plugin center'}
                </button>
                <button className="secondary-button" onClick={handleRestoreBackup} type="button">
                  {ui.restoreBackup}
                </button>
                <button className="primary-button" onClick={handleBackup} type="button">
                  {ui.runBackupNow}
                </button>
                <div
                  style={{
                    marginTop: '8px',
                    padding: '16px',
                    borderRadius: '18px',
                    border: '1px solid rgba(91, 72, 44, 0.18)',
                    background: 'rgba(255, 252, 246, 0.86)',
                    display: 'grid',
                    gap: '12px'
                  }}
                >
                  <div>
                    <p className="panel-label">{ui.appUpdateLabel}</p>
                    <h3 style={{ margin: '4px 0 0' }}>{ui.appUpdateTitle}</h3>
                    <p style={{ margin: '8px 0 0', color: 'rgba(91, 72, 44, 0.76)' }}>{ui.appUpdateDescription}</p>
                  </div>
                  <dl className="meta-grid">
                    <div>
                      <dt>{ui.currentVersionLabel}</dt>
                      <dd>{appUpdateState?.currentVersion ?? ui.initializing}</dd>
                    </div>
                    <div>
                      <dt>{ui.availableVersionLabel}</dt>
                      <dd>{appUpdateState?.downloadedVersion ?? appUpdateState?.availableVersion ?? ui.common.none}</dd>
                    </div>
                    <div>
                      <dt>{ui.updateStatusField}</dt>
                      <dd>{getAppUpdateStatusText(appUpdateState)}</dd>
                    </div>
                    <div>
                      <dt>{ui.lastCheckedLabel}</dt>
                      <dd>{appUpdateState?.checkedAt ? new Date(appUpdateState.checkedAt).toLocaleString(ui.locale) : ui.notCheckedYet}</dd>
                    </div>
                  </dl>
                  <div>
                    <strong>{ui.releaseNotesLabel}</strong>
                    <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', color: 'rgba(91, 72, 44, 0.8)' }}>
                      {appUpdateState?.releaseNotes ?? ui.noReleaseNotes}
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <button
                      className="secondary-button"
                      disabled={appUpdateRefreshing || appUpdateState?.status === 'checking' || appUpdateState?.updatesEnabled === false}
                      onClick={checkForAppUpdates}
                      type="button"
                    >
                      {appUpdateRefreshing || appUpdateState?.status === 'checking' ? ui.checkingForUpdates : ui.checkForUpdates}
                    </button>
                    <button
                      className="primary-button"
                      disabled={!appUpdateState?.canInstall}
                      onClick={installAppUpdate}
                      type="button"
                    >
                      {ui.installUpdateNow}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </article>

          <article className="panel large-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">{ui.recentDocumentsLabel}</p>
                <h3>{ui.recentDocumentsTitle}</h3>
              </div>
            </div>

            <div className="document-list">
              {homeData.recentDocuments.map((document) => (
                <button className="document-row document-button" key={document.id} onClick={() => openDocumentInDocumentsPage(document.id)} type="button">
                  <div>
                    <strong>{document.title}</strong>
                    <p>{document.path}</p>
                  </div>
                  <div className="document-meta">
                    <span>{document.blockCount} {ui.docStatBlocks}</span>
                    <span>{new Date(document.updatedAt).toLocaleDateString(ui.locale)}</span>
                  </div>
                </button>
              ))}
            </div>
          </article>
        </section>
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
                  setGlobalSearchQuery(event.target.value)
                  runGlobalSearch(event.target.value)
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

const DocumentCatalogTable = memo(function DocumentCatalogTable({
  columns,
  documents,
  onSelect,
  onUpdateField,
  selectedDocumentId
}: {
  columns: DocumentDatabaseColumn[]
  documents: DocumentCatalogEntry[]
  onSelect: (documentId: string) => void
  onUpdateField: (documentId: string, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
  selectedDocumentId: string | null
}) {
  const ui = getActiveUiText()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(CATALOG_ROW_HEIGHT * 5)

  const gridTemplateColumns = useMemo(() => {
    const dynamicColumns = columns.map(() => 'minmax(180px, 1.15fr)')
    return [
      'minmax(220px, 1.7fr)',
      'minmax(220px, 1.45fr)',
      ...dynamicColumns,
      'minmax(84px, 0.55fr)',
      'minmax(84px, 0.55fr)',
      'minmax(84px, 0.55fr)',
      'minmax(120px, 0.7fr)'
    ].join(' ')
  }, [columns])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) {
      return
    }

    const updateViewportHeight = () => {
      setViewportHeight(node.clientHeight || CATALOG_ROW_HEIGHT * 5)
    }

    updateViewportHeight()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewportHeight)
      return () => {
        window.removeEventListener('resize', updateViewportHeight)
      }
    }

    const observer = new ResizeObserver(() => {
      updateViewportHeight()
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])

  const totalHeight = documents.length * CATALOG_ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / CATALOG_ROW_HEIGHT) - CATALOG_ROW_OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / CATALOG_ROW_HEIGHT) + (CATALOG_ROW_OVERSCAN * 2)
  const endIndex = Math.min(documents.length, startIndex + visibleCount)
  const visibleDocuments = documents.slice(startIndex, endIndex)

  return (
    <div className="catalog-table-wrap">
      <div className="catalog-virtual-table">
        <div className="catalog-virtual-head" style={{ gridTemplateColumns }}>
          <div className="catalog-virtual-header-cell">{ui.common.title}</div>
          <div className="catalog-virtual-header-cell">{ui.common.path}</div>
          {columns.map((column) => (
            <div className="catalog-virtual-header-cell" key={column.id}>{column.name}</div>
          ))}
          <div className="catalog-virtual-header-cell">{ui.tableHeaderBlocks}</div>
          <div className="catalog-virtual-header-cell">{ui.tableHeaderLinks}</div>
          <div className="catalog-virtual-header-cell">{ui.tableHeaderChildren}</div>
          <div className="catalog-virtual-header-cell">{ui.tableHeaderUpdated}</div>
        </div>

        <div
          className="catalog-virtual-scroll"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop)
          }}
          ref={scrollRef}
        >
          <div className="catalog-virtual-spacer" style={{ height: totalHeight }}>
            {visibleDocuments.map((document, offset) => {
              const rowIndex = startIndex + offset

              return (
                <div
                  className={`catalog-virtual-row${selectedDocumentId === document.id ? ' catalog-row-active' : ''}`}
                  data-document-id={document.id}
                  key={document.id}
                  onClick={() => onSelect(document.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(document.id)
                    }
                  }}
                  role="button"
                  style={{
                    gridTemplateColumns,
                    transform: `translateY(${rowIndex * CATALOG_ROW_HEIGHT}px)`
                  }}
                  tabIndex={0}
                >
                  <div className="catalog-virtual-cell catalog-title-cell">
                    <strong className="catalog-title-text">{document.title}</strong>
                    <p className="catalog-summary">{document.summary}</p>
                  </div>
                  <div className="catalog-virtual-cell catalog-path-cell" title={document.path}>{document.path}</div>
                  {columns.map((column) => (
                    <div className="catalog-virtual-cell catalog-cell-field" data-column-id={column.id} key={`${document.id}-${column.id}`}>
                      <DocumentCatalogFieldCell
                        column={column}
                        documentId={document.id}
                        onUpdateField={onUpdateField}
                        value={document.fieldValues[column.id] ?? null}
                      />
                    </div>
                  ))}
                  <div className="catalog-virtual-cell catalog-metric-cell">{document.blockCount}</div>
                  <div className="catalog-virtual-cell catalog-metric-cell">{document.linkCount}</div>
                  <div className="catalog-virtual-cell catalog-metric-cell">{document.childCount}</div>
                  <div className="catalog-virtual-cell catalog-updated-cell">{new Date(document.updatedAt).toLocaleDateString(ui.locale)}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
})

function StandaloneDatabaseEntityTable({
  columns,
  documentCatalog,
  entities,
  onDeleteEntity,
  onToggleSelection,
  onUpdateDocument,
  onUpdateField,
  selectedEntityIds
}: {
  columns: DocumentDatabaseColumn[]
  documentCatalog: DocumentCatalogEntry[]
  entities: Array<{ entity: DatabaseEntity; linkedDocument: DocumentCatalogEntry | null }>
  onDeleteEntity: (entityId: string) => Promise<void>
  onToggleSelection: (entityId: string, checked: boolean) => void
  onUpdateDocument: (entity: DatabaseEntity, documentId: string | null) => Promise<void>
  onUpdateField: (entity: DatabaseEntity, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
  selectedEntityIds: Set<string>
}) {
  const ui = getActiveUiText()

  return (
    <div className="catalog-table-wrap database-entity-table-wrap">
      <table className="catalog-table database-entity-table">
        <thead>
          <tr>
            <th>{ui.common.select}</th>
            <th>{ui.databaseEntityTableEntity}</th>
            <th>{ui.linkToDocumentOptional}</th>
            {columns.map((column) => (
              <th key={column.id}>{column.name}</th>
            ))}
            <th>{ui.tableHeaderUpdated}</th>
            <th>{ui.databaseEntityTableActions}</th>
          </tr>
        </thead>
        <tbody>
          {entities.map(({ entity, linkedDocument }) => {
            const entityLabel = linkedDocument?.title ?? `Entity ${entity.id.slice(0, 8)}`

            return (
              <tr className={selectedEntityIds.has(entity.id) ? 'catalog-row-active' : ''} key={entity.id}>
                <td>
                  <label className="database-entity-select-toggle database-entity-table-select-toggle">
                    <input
                      aria-label={ui.selectDatabaseEntity(entityLabel)}
                      checked={selectedEntityIds.has(entity.id)}
                      className="database-entity-select-checkbox"
                      onChange={(event) => onToggleSelection(entity.id, event.target.checked)}
                      type="checkbox"
                    />
                  </label>
                </td>
                <td>
                  <strong>{entityLabel}</strong>
                  <p className="catalog-summary">{linkedDocument?.path ?? entity.id}</p>
                </td>
                <td className="catalog-cell-field">
                  <select
                    className="catalog-cell-input database-entity-document-select"
                    onChange={(event) => {
                      void onUpdateDocument(entity, event.target.value || null)
                    }}
                    value={entity.documentId ?? ''}
                  >
                    <option value="">{ui.noLinkedDocument}</option>
                    {documentCatalog.map((document) => (
                      <option key={document.id} value={document.id}>{document.path}</option>
                    ))}
                  </select>
                </td>
                {columns.map((column) => (
                  <td className="catalog-cell-field" data-column-id={column.id} key={`${entity.id}-${column.id}`}>
                    <DatabaseFieldEditor
                      column={column}
                      value={entity.fieldValues[column.id] ?? null}
                      onChangeValue={(value) => {
                        void onUpdateField(entity, column.id, value)
                      }}
                    />
                  </td>
                ))}
                <td>{new Date(entity.updatedAt).toLocaleDateString(ui.locale)}</td>
                <td>
                  <button className="secondary-button" onClick={() => void onDeleteEntity(entity.id)} type="button">
                    {ui.common.delete}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DatabaseSchemaColumnCard({
  column,
  isFirst,
  isLast,
  onDelete,
  onMove,
  onUpdateOptions,
  onRename
}: {
  column: DocumentDatabaseColumn
  isFirst: boolean
  isLast: boolean
  onDelete: (columnId: string, columnName: string) => Promise<void>
  onMove: (columnId: string, direction: 'left' | 'right') => Promise<void>
  onUpdateOptions: (columnId: string, optionsInput: string) => Promise<void>
  onRename: (columnId: string, name: string) => Promise<void>
}) {
  const ui = getActiveUiText()
  const [draftName, setDraftName] = useState(column.name)
  const [draftOptions, setDraftOptions] = useState(column.options.join(', '))

  useEffect(() => {
    setDraftName(column.name)
  }, [column.id, column.name])

  useEffect(() => {
    setDraftOptions(column.options.join(', '))
  }, [column.id, column.options.join('\u0000')])

  const commitRename = async () => {
    const normalizedName = draftName.trim()
    if (!normalizedName) {
      setDraftName(column.name)
      return
    }

    if (normalizedName === column.name) {
      if (draftName !== column.name) {
        setDraftName(column.name)
      }
      return
    }

    await onRename(column.id, normalizedName)
  }

  const commitOptions = async () => {
    const normalizedOptions = normalizeDatabaseColumnOptionsInput(draftOptions)
    const currentOptionsKey = column.options.join('\u0000')
    const nextOptionsKey = normalizedOptions.join('\u0000')

    if (nextOptionsKey === currentOptionsKey) {
      if (draftOptions !== column.options.join(', ')) {
        setDraftOptions(column.options.join(', '))
      }
      return
    }

    if (normalizedOptions.length === 0) {
      setDraftOptions(column.options.join(', '))
      return
    }

    await onUpdateOptions(column.id, normalizedOptions.join(', '))
  }

  return (
    <div className="database-schema-chip">
      <input
        className="database-schema-name-input"
        onBlur={() => {
          void commitRename()
        }}
        onChange={(event) => setDraftName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          }
        }}
        type="text"
        value={draftName}
      />
      <small>
        {getDatabaseColumnTypeLabel(column.type)}
      </small>
      {(column.type === 'select' || column.type === 'multi-select') ? (
        <input
          className="database-schema-options-input"
          onBlur={() => {
            void commitOptions()
          }}
          onChange={(event) => setDraftOptions(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
          placeholder={ui.optionPlaceholder}
          type="text"
          value={draftOptions}
        />
      ) : null}
      <div className="database-schema-chip-actions">
        <button
          className="database-schema-chip-button"
          disabled={isFirst}
          onClick={() => {
            void onMove(column.id, 'left')
          }}
          type="button"
        >
          {ui.left}
        </button>
        <button
          className="database-schema-chip-button"
          disabled={isLast}
          onClick={() => {
            void onMove(column.id, 'right')
          }}
          type="button"
        >
          {ui.right}
        </button>
        <button
          className="database-schema-chip-button database-schema-chip-delete"
          onClick={() => {
            void onDelete(column.id, column.name)
          }}
          type="button"
        >
          {ui.common.delete}
        </button>
      </div>
    </div>
  )
}

const DocumentCatalogFieldCell = memo(function DocumentCatalogFieldCell({
  column,
  documentId,
  onUpdateField,
  value
}: {
  column: DocumentDatabaseColumn
  documentId: string
  onUpdateField: (documentId: string, columnId: string, value: DocumentDatabaseFieldValue) => Promise<void>
  value: DocumentDatabaseFieldValue
}) {
  const ui = getActiveUiText()
  const [isEditing, setIsEditing] = useState(false)
  const [draftValue, setDraftValue] = useState('')
  const [draftMultiValue, setDraftMultiValue] = useState<string[]>([])

  useEffect(() => {
    setDraftValue(formatDocumentDatabaseFieldValueForDraft(value))
    setDraftMultiValue(Array.isArray(value) ? value : [])
  }, [value])

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    event.stopPropagation()
  }

  const closeEditor = () => {
    setIsEditing(false)
    setDraftValue(formatDocumentDatabaseFieldValueForDraft(value))
    setDraftMultiValue(Array.isArray(value) ? value : [])
  }

  const commitValue = async (nextValue: DocumentDatabaseFieldValue) => {
    const normalizedValue = normalizeDocumentDatabaseFieldValue(nextValue)
    setIsEditing(false)

    if (areDocumentDatabaseFieldValuesEqual(normalizedValue, value)) {
      return
    }

    await onUpdateField(documentId, column.id, normalizedValue)
  }

  const displayValue = formatDocumentCatalogFieldValueForDisplay(value)
  const emptyLabel = column.type === 'select' || column.type === 'multi-select' ? ui.common.select : ui.common.value

  if (column.type === 'checkbox') {
    return (
      <label className="catalog-checkbox" onClick={stopEventPropagation}>
        <input
          checked={value === true}
          onChange={(event) => {
            void onUpdateField(documentId, column.id, event.target.checked)
          }}
          type="checkbox"
        />
      </label>
    )
  }

  if (column.type === 'multi-select') {
    return (
      <div className="catalog-field-shell" onClick={stopEventPropagation}>
        {isEditing ? (
          <CatalogMultiSelectEditor
            column={column}
            onApply={() => {
              void commitValue(draftMultiValue)
            }}
            onCancel={closeEditor}
            onToggleOption={(option, checked) => {
              setDraftMultiValue((current) => {
                if (checked) {
                  return current.includes(option) ? current : [...current, option]
                }

                return current.filter((item) => item !== option)
              })
            }}
            selectedValues={draftMultiValue}
          />
        ) : (
          <button
            className={`catalog-value-button${displayValue ? '' : ' catalog-value-empty'}`}
            onClick={() => setIsEditing(true)}
            type="button"
          >
            {displayValue || emptyLabel}
          </button>
        )}
      </div>
    )
  }

  if (column.type === 'select') {
    return (
      <div className="catalog-field-shell" onClick={stopEventPropagation}>
        {isEditing ? (
          <select
            autoFocus
            className="catalog-cell-input"
            onBlur={() => setIsEditing(false)}
            onChange={(event) => {
              void commitValue(event.target.value || null)
            }}
            onClick={stopEventPropagation}
            value={typeof value === 'string' ? value : ''}
          >
            <option value="">{ui.common.select}</option>
            {column.options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ) : (
          <button
            className={`catalog-value-button${displayValue ? '' : ' catalog-value-empty'}`}
            onClick={() => setIsEditing(true)}
            type="button"
          >
            {displayValue || emptyLabel}
          </button>
        )}
      </div>
    )
  }

  if (column.type === 'date') {
    return (
      <div className="catalog-field-shell" onClick={stopEventPropagation}>
        {isEditing ? (
          <input
            autoFocus
            className="catalog-cell-input"
            onBlur={() => {
              void commitValue(draftValue)
            }}
            onChange={(event) => {
              setDraftValue(event.target.value)
            }}
            onClick={stopEventPropagation}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                closeEditor()
                return
              }

              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            type="date"
            value={draftValue}
          />
        ) : (
          <button
            className={`catalog-value-button${displayValue ? '' : ' catalog-value-empty'}`}
            onClick={() => setIsEditing(true)}
            type="button"
          >
            {displayValue || emptyLabel}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="catalog-field-shell" onClick={stopEventPropagation}>
      {isEditing ? (
        <input
          autoFocus
          className="catalog-cell-input"
          onBlur={() => {
            void commitValue(draftValue)
          }}
          onChange={(event) => {
            setDraftValue(event.target.value)
          }}
          onClick={stopEventPropagation}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              closeEditor()
              return
            }

            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
          placeholder={ui.common.value}
          type="text"
          value={draftValue}
        />
      ) : (
        <button
          className={`catalog-value-button${displayValue ? '' : ' catalog-value-empty'}`}
          onClick={() => setIsEditing(true)}
          type="button"
        >
          {displayValue || emptyLabel}
        </button>
      )}
    </div>
  )
})

function CatalogMultiSelectEditor({
  column,
  onApply,
  onCancel,
  onToggleOption,
  selectedValues
}: {
  column: DocumentDatabaseColumn
  onApply: () => void
  onCancel: () => void
  onToggleOption: (option: string, checked: boolean) => void
  selectedValues: string[]
}) {
  const ui = getActiveUiText()

  return (
    <div className="catalog-multi-select-editor" onClick={(event) => event.stopPropagation()}>
      <div className="catalog-multi-select-options">
        {column.options.map((option) => (
          <label className="catalog-multi-select-option" key={option}>
            <input
              checked={selectedValues.includes(option)}
              onChange={(event) => {
                onToggleOption(option, event.target.checked)
              }}
              type="checkbox"
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
      <div className="catalog-inline-actions">
        <button className="secondary-button" onClick={onApply} type="button">{ui.common.save}</button>
        <button className="secondary-button" onClick={onCancel} type="button">{ui.common.cancel}</button>
      </div>
    </div>
  )
}

function DatabaseFieldEditor({
  column,
  value,
  onChangeValue,
  stopPropagation = false,
  textCommitMode = 'blur'
}: {
  column: DocumentDatabaseColumn
  value: DocumentDatabaseFieldValue
  onChangeValue: (value: DocumentDatabaseFieldValue) => void | Promise<void>
  stopPropagation?: boolean
  textCommitMode?: 'blur' | 'change'
}) {
  const ui = getActiveUiText()
  const [draftValue, setDraftValue] = useState('')

  useEffect(() => {
    setDraftValue(formatDocumentDatabaseFieldValueForDraft(value))
  }, [value])

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation()
    }
  }

  const commitTextValue = (nextDraftValue: string) => {
    void onChangeValue(normalizeDocumentDatabaseFieldValue(nextDraftValue))
  }

  if (column.type === 'checkbox') {
    return (
      <label className="catalog-checkbox" onClick={stopEventPropagation}>
        <input
          checked={value === true}
          onChange={(event) => {
            void onChangeValue(event.target.checked)
          }}
          type="checkbox"
        />
      </label>
    )
  }

  if (column.type === 'select') {
    return (
      <select
        className="catalog-cell-input"
        onChange={(event) => {
          void onChangeValue(event.target.value || null)
        }}
        onClick={stopEventPropagation}
        value={typeof value === 'string' ? value : ''}
      >
        <option value="">{ui.common.select}</option>
        {column.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    )
  }

  if (column.type === 'multi-select') {
    return (
      <select
        className="catalog-cell-input catalog-cell-multi-select"
        multiple
        onChange={(event) => {
          const nextValues = Array.from(event.target.selectedOptions, (option) => option.value)
          void onChangeValue(nextValues)
        }}
        onClick={stopEventPropagation}
        size={Math.min(Math.max(column.options.length, 3), 5)}
        value={Array.isArray(value) ? value : []}
      >
        {column.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    )
  }

  if (column.type === 'date') {
    return (
      <input
        className="catalog-cell-input"
        onChange={(event) => {
          void onChangeValue(event.target.value || null)
        }}
        onClick={stopEventPropagation}
        type="date"
        value={typeof value === 'string' ? value : ''}
      />
    )
  }

  return (
    <input
      className="catalog-cell-input"
      onBlur={() => {
        if (textCommitMode === 'blur') {
          commitTextValue(draftValue)
        }
      }}
      onChange={(event) => {
        const nextDraftValue = event.target.value
        setDraftValue(nextDraftValue)
        if (textCommitMode === 'change') {
          commitTextValue(nextDraftValue)
        }
      }}
      onClick={stopEventPropagation}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
      placeholder={ui.common.value}
      type="text"
      value={draftValue}
    />
  )
}

function DocumentBoard({
  columns,
  onSelect,
  selectedDocumentId,
  draggingDocumentId,
  dragOverColumnId,
  onDragStart,
  onDragEnd,
  onDragOverColumn,
  onDropOnColumn
}: {
  columns: BoardColumn[]
  onSelect: (documentId: string) => void
  selectedDocumentId: string | null
  draggingDocumentId: string | null
  dragOverColumnId: string | null
  onDragStart: (documentId: string) => void
  onDragEnd: () => void
  onDragOverColumn: (columnId: string) => void
  onDropOnColumn: (target: BoardDropTarget) => Promise<void>
}) {
  const ui = getActiveUiText()

  return (
    <div className="board-wrap">
      {columns.map((column) => (
        <section
          className={`board-column${dragOverColumnId === column.id ? ' board-column-drag-over' : ''}`}
          key={column.id}
          onDragOver={(event) => {
            event.preventDefault()
            if (draggingDocumentId) {
              onDragOverColumn(column.id)
            }
          }}
          onDrop={async (event) => {
            event.preventDefault()
            await onDropOnColumn(column.dropTarget)
          }}
        >
          <div className="board-column-head">
            <strong>{column.title}</strong>
            <span>{column.items.length}</span>
          </div>

          <div className="board-card-list">
            {column.items.map((document) => (
              <button
                className={`board-card${selectedDocumentId === document.id ? ' board-card-active' : ''}${draggingDocumentId === document.id ? ' board-card-dragging' : ''}`}
                key={document.id}
                onClick={() => onSelect(document.id)}
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', document.id)
                  onDragStart(document.id)
                }}
                onDragEnd={onDragEnd}
              >
                <strong>{document.title}</strong>
                <p>{document.path}</p>
                <div className="board-card-meta">
                  <span>{document.blockCount} {ui.docStatBlocks}</span>
                  <span>{document.linkCount} {ui.common.links}</span>
                </div>
              </button>
            ))}
            {column.items.length === 0 ? <p className="board-column-drop-hint">{ui.boardDropHint}</p> : null}
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
              {link.contextSnippet ? (
                <span className="relation-chip-context">{link.contextSnippet.slice(0, 120)}{link.contextSnippet.length > 120 ? '…' : ''}</span>
              ) : (
                <small>{link.label}</small>
              )}
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-text">{emptyText}</p>
      )}
    </section>
  )
}

function renderBlock(
  block: DocumentBlock,
  onSelectDocument: (documentId: string) => void,
  references: Array<{ id: string; title: string; path: string }>,
  onToggleTodo?: (checked: boolean) => void,
  allBlocks?: DocumentBlock[],
  currentDocumentId?: string | null
) {
  const indentStyle = isNestableBlock(block.type) ? { marginInlineStart: `${block.depth * BLOCK_INDENT_SIZE}px` } : undefined
  const blockReferences = allBlocks ? buildBlockReferencesMap(allBlocks) : new Map()

  if (block.type === 'heading-1') {
    return <h4 className="block-heading"># {renderInlineContent(block.content, onSelectDocument, references, block.id, blockReferences, currentDocumentId)}</h4>
  }

  if (block.type === 'heading-2') {
    return <h5 className="block-heading">## {renderInlineContent(block.content, onSelectDocument, references, block.id, blockReferences, currentDocumentId)}</h5>
  }

  if (block.type === 'todo') {
    return (
      <label className={`block-todo${block.checked ? ' block-todo-checked' : ''}`} style={indentStyle}>
        <input checked={block.checked} onChange={(event) => onToggleTodo?.(event.target.checked)} type="checkbox" />
        <span>{renderInlineContent(block.content, onSelectDocument, references, block.id, blockReferences, currentDocumentId)}</span>
      </label>
    )
  }

  if (block.type === 'quote') {
    return <blockquote className="block-quote">{renderInlineContent(block.content, onSelectDocument, references, block.id, blockReferences, currentDocumentId)}</blockquote>
  }

  if (block.type === 'bulleted-list') {
    return <p className="block-bulleted-list" style={indentStyle}>- {renderInlineContent(block.content, onSelectDocument, references, block.id, blockReferences, currentDocumentId)}</p>
  }

  if (block.type === 'numbered-list') {
    return <p className="block-numbered-list" style={indentStyle}>1. {renderInlineContent(block.content, onSelectDocument, references, block.id, blockReferences, currentDocumentId)}</p>
  }

  if (block.type === 'divider') {
    return <hr className="block-divider" />
  }

  if (block.type === 'math') {
    return <div className="block-math" dangerouslySetInnerHTML={{ __html: renderMathBlock(block.content) }} />
  }

  if (block.type === 'code') {
    const effectiveLanguage = detectCodeLanguage(block.content, block.language)
    return (
      <div className="block-code-wrapper">
        {effectiveLanguage && (
          <span className={`block-code-language${block.language ? '' : ' block-code-language-auto'}`}>
            {effectiveLanguage}
            {block.language ? '' : ' auto'}
          </span>
        )}
        <CodeBlockPreview code={block.content} language={effectiveLanguage} />
      </div>
    )
  }

  return <p className="block-paragraph">{renderInlineContent(block.content, onSelectDocument, references, block.id, blockReferences, currentDocumentId)}</p>
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
  const parentBlockId = block.parentBlockId ?? null

  if (content === '---') {
    return buildBlockTypePatch('divider', '', false, block.depth, parentBlockId)
  }

  if (content.startsWith('## ')) {
    return buildBlockTypePatch('heading-2', content.slice(3).replace(/^\s/, ''), false, block.depth, parentBlockId)
  }

  if (content.startsWith('# ')) {
    return buildBlockTypePatch('heading-1', content.slice(2).replace(/^\s/, ''), false, block.depth, parentBlockId)
  }

  if (content.startsWith('$$ ')) {
    return buildBlockTypePatch('math', content.slice(3).replace(/^\s/, ''), false, block.depth, parentBlockId)
  }

  if (content.startsWith('- [x] ') || content.startsWith('- [X] ')) {
    return buildBlockTypePatch('todo', content.slice(6).replace(/^\s/, ''), true, block.depth, parentBlockId)
  }

  if (content.startsWith('- [ ] ')) {
    return buildBlockTypePatch('todo', content.slice(6).replace(/^\s/, ''), false, block.depth, parentBlockId)
  }

  if (content.startsWith('> ')) {
    return buildBlockTypePatch('quote', content.slice(2).replace(/^\s/, ''), false, block.depth, parentBlockId)
  }

  if (content.startsWith('- ')) {
    return buildBlockTypePatch('bulleted-list', content.slice(2).replace(/^\s/, ''), false, block.depth, parentBlockId)
  }

  const orderedPrefix = content.match(/^\d+\.\s+/)?.[0]
  if (orderedPrefix) {
    return buildBlockTypePatch('numbered-list', content.slice(orderedPrefix.length).replace(/^\s/, ''), false, block.depth, parentBlockId)
  }

  if (content.startsWith('```') && ['paragraph', 'heading-1', 'heading-2', 'todo', 'quote', 'bulleted-list', 'numbered-list', 'math'].includes(type)) {
    return buildBlockTypePatch('code', content.slice(3).replace(/^\s/, ''), false, block.depth, parentBlockId)
  }

  return null
}

function normalizePastedLineBlock(template: DocumentBlockDraft, content: string): DocumentBlockDraft {
  const draft = buildBlockTypePatch(template.type, content, template.checked, template.depth, template.parentBlockId ?? null)
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
    return ['```' + (block.language ?? 'txt'), block.content, '```'].join('\n')
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
  const adjusted = blocks.map((block) => ({
    ...block,
    depth: Math.max(0, block.depth + depthDelta)
  }))

  const normalized: DocumentBlockDraft[] = []
  for (const block of adjusted) {
    if (normalized.length === 0) {
      normalized.push(block)
      continue
    }

    const prevBlock = normalized[normalized.length - 1]
    const maxAllowedDepth = prevBlock.depth + 1

    if (isNestableBlock(block.type) && block.depth > maxAllowedDepth) {
      normalized.push({
        ...block,
        depth: maxAllowedDepth
      })
    } else {
      normalized.push(block)
    }
  }

  return normalized
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
      const fencedLanguage = normalizeCodeLanguage(trimmed.slice(3).trim())
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      blocks.push({
        ...buildBlockTypePatch('code', codeLines.join('\n')),
        language: fencedLanguage ?? undefined
      })
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

function buildBlockReferencesMap(blocks: DocumentBlock[]): Map<string, DocumentBlock> {
  const map = new Map<string, DocumentBlock>()
  for (const block of blocks) {
    map.set(block.id, block)
  }
  return map
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

function getBlockTypeLabel(type: string): string {
  return getActiveUiText().blockTypeBadges[type] ?? getActiveUiText().blockTypeBadges.paragraph
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