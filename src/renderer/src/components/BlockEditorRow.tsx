import { isTaskBlockType, isOrderedListBlockType, isContainerBlockType, canBlockOwnChildren } from '@shared/blockTypes'
import { getHeadingLevel, type MarkdownEnvironment } from '@shared/markdownEngine'
import { htmlClipboardToMarkdown } from '@shared/htmlClipboard'
import { hasAdvancedMarkdown, type MarkdownDocumentModel } from '@shared/markdownDocument'
import { lazy, memo, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MarkdownBlockContent, MarkdownMermaidPreview } from './MarkdownContent'
import { MarkdownBlockNodesContext } from './MarkdownDocumentContext'
import { detectCodeLanguage } from '@shared/code'
import type { DocumentBlockDraft, DocumentBlock } from '@shared/contracts'
import { BlockEditToolbar } from './BlockEditToolbar'
import { blockConversionLabels } from '../utils/blockConversionTypes'
import { BlockRichMediaPreview } from './BlockRichMediaPreview'
import { CodeBlockLanguageSelector } from './CodeBlockLanguageSelector'
import { MarkdownTablePreview } from './MarkdownTablePreview'
import { extractBlockRichMedia } from '../utils/blockRichMedia'
import { serializeDraftBlockRange } from '../utils/draftClipboard'
import { scheduleTextareaResize as resizeBlockTextarea, focusBlockTextarea } from '../utils/textareaLayout'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { formatMarkdownSelection, markdownFormatShortcut, type MarkdownFormat } from '../utils/markdownFormatting'
import { editCodeIndentation } from '../utils/codeIndentation'
import type { SourceInlinePresentationAction } from './SourceInlinePresentationToolbar'
import { nativeContainerPresentation } from '../utils/nativeContainerPresentation'
import { isDatabaseEditorIsland } from '../utils/editorIsland'
import { canAiEditBlockText } from '@shared/blockAiEligibility'

const BlockContextMenu = lazy(() => import('./BlockContextMenu').then(module => ({ default: module.BlockContextMenu })))
const InlineDatabaseView = lazy(() => import('../features/database/InlineDatabaseView'))
const MarkdownTableEditor = lazy(() => import('./MarkdownTableEditor').then((module) => ({ default: module.MarkdownTableEditor })))
const SourceInlinePresentationToolbar = lazy(() => import('./SourceInlinePresentationToolbar').then(module => ({ default: module.SourceInlinePresentationToolbar })))
const MarkdownFormatToolbar = lazy(() => import('./BlockFormatToolbar').then((module) => ({ default: module.BlockFormatToolbar })))
const NativeContainerControls = lazy(() => import('./NativeContainerControls').then(module => ({ default: module.NativeContainerControls })))

const CodeBlockPreview = lazy(async () => {
  const [module] = await Promise.all([
    import('./CodeBlockPreview'),
    import('highlight.js/styles/github-dark.css')
  ])
  return { default: module.CodeBlockPreview }
})

const MathBlockPreview = lazy(async () => {
  const [module] = await Promise.all([
    import('./MathBlockPreview'),
    import('katex/dist/katex.min.css'), import('../styles/markdown-advanced.css')
  ])
  return { default: module.MathBlockPreview }
})

export type BlockDropPreview = {
  positionLabel: string
  effectiveDepth: number
  parentText: string | null
}

export type BlockEditorRowProps = {
  markdownDocument?: MarkdownDocumentModel
  markdownReferences?: MarkdownEnvironment['references']
  // Block data
  block: DocumentBlockDraft
  index: number
  draftBlockCount: number
  getDraftBlocks: () => DocumentBlockDraft[]
  selectedDocument: { id: string; title: string }

  // Row state
  isSelected: boolean
  isHighlighted: boolean
  isSearchMatch?: boolean
  hasChildren: boolean
  dropPreview: BlockDropPreview | null
  indentPx: number
  numberLabel: string
  activeBlockIndex: number | null
  collapsedBlockIds: Set<string>

  // Editor context
  activeSlashContext: { query: string } | null
  filteredSlashCommands: Array<{ id: string; label: string; description: string }>
  activeSlashCommand: { id: string } | null | undefined
  slashCommandsUnavailable?: boolean
  retrySlashCommands?: () => void
  selectedBlockRange: { start: number; end: number } | null
  selectedBlockCount: number

  // References
  blockTextareaRefs: React.MutableRefObject<Array<HTMLTextAreaElement | null>>

  getSelectedBlockActionIds?: () => string[]
  onOpenBlockActions?: (input: { blockIds: string[]; x: number; y: number }) => void

  // Callbacks: block operations
  updateDraftBlock: (index: number, patch: Partial<DocumentBlockDraft>) => void
  checkpointDraft?: () => void
  updateBlockHighlight: (index: number, highlight: string | undefined) => void
  insertDraftBlockAt: (index: number, anchorIndex: number) => void
  insertChildDraftBlock?: (index: number, contentOverride?: string, childTypeOverride?: DocumentBlock['type']) => void

  // Callbacks: block interactions
  handleBlockContentChange: (index: number, content: string) => void
  navigateInlineReferenceAtCursor: (content: string, cursorPosition: number) => void | Promise<void>
  captureBlockCursor: (index: number, target: HTMLTextAreaElement) => void
  handleBlockPaste: (index: number, text: string, start: number, end: number) => boolean

  // Callbacks: drag/drop
  beginBlockDrag: (index: number) => void
  endBlockDrag: () => void
  getDraggedBlockDepthPreview: (targetIndex: number, clientX: number, element: HTMLDivElement) => number | null
  dropBlockAt: (index: number, depth: number | null) => void
  setDragOverBlockIndex: (index: number | null) => void
  setDragOverBlockDepth: (depth: number | null) => void

  // Callbacks: selection & multi-block
  moveSelectedBlocks: (delta: -1 | 1) => void
  moveDraftBlockBySibling: (index: number, delta: -1 | 1, cursorPos: number) => void
  setSelectedSlashCommandIndex: (fn: (prev: number) => number) => void
  applySlashCommand: (command: any) => void
  dismissSlashCommand: () => void
  handleLinkSuggestionKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  adjustSelectedBlocksDepth: (delta: -1 | 1, index: number, cursorPos: number) => void
  adjustBlockDepth: (index: number, delta: -1 | 1, cursorPos: number) => void
  deleteSelectedBlocks: () => void
  duplicateSelectedBlocks: () => void
  duplicateDraftBlock: (index: number) => void
  selectBlockRange: (index: number, extendSelection?: boolean) => void
  getBlockSelectionFocusIndex?: () => number | null
  clearBlockSelection?: () => void
  selectAllBlocks: () => void
  notifyBlockMouseDown: (index: number) => void
  handleBlockMouseEnter: (index: number, buttonsHeld: boolean) => void
  endBlockRangeSelection: () => void
  isBlockRangeSelecting: boolean

  // Callbacks: block structure
  continueBlockAt: (index: number, start: number, end: number) => void
  downgradeBlockAt: (index: number) => void
  mergeWithPreviousBlock: (index: number) => void
  mergeWithNextBlock?: (index: number, nextVisibleIndex: number) => boolean
  splitDraftBlock: (index: number, start: number, end: number) => void

  // Callbacks: helpers
  toggleBlockCollapse: (blockId: string) => void
  isSelectionCoherent: (range: { start: number; end: number }) => boolean
  getVisibleBlockCountInRange: (range: { start: number; end: number }) => number
  getMultiBlockOperationRange: (range: { start: number; end: number }) => { start: number; end: number }
  removeSelectedBlockRange: (range: { start: number; end: number }) => void

  // Callbacks: selection/interaction guards
  canMoveSelectedRange: (range: { start: number; end: number }, delta: -1 | 1) => boolean

  // Callbacks: AI
  onOpenSelectionAiEditor: () => void

  // Constants & UI
  BLOCK_INDENT_SIZE: number
  ui: any
  isZh: boolean
}

const isNestableBlockType = canBlockOwnChildren

export const BlockEditorRow = memo(function BlockEditorRow(props: BlockEditorRowProps) {
  const {
    block,
    index,
    draftBlockCount,
    getDraftBlocks,
    selectedDocument,
    isSelected,
    isHighlighted,
    isSearchMatch,
    hasChildren,
    dropPreview,
    indentPx,
    numberLabel,
    activeBlockIndex,
    collapsedBlockIds,
    activeSlashContext,
    filteredSlashCommands,
    activeSlashCommand,
    slashCommandsUnavailable = false,
    retrySlashCommands,
    selectedBlockRange,
    selectedBlockCount,
    blockTextareaRefs,
    updateDraftBlock,
    updateBlockHighlight,
    insertDraftBlockAt,
    handleBlockContentChange,
    navigateInlineReferenceAtCursor,
    captureBlockCursor,
    handleBlockPaste,
    beginBlockDrag,
    endBlockDrag,
    getDraggedBlockDepthPreview,
    dropBlockAt,
    setDragOverBlockIndex,
    setDragOverBlockDepth,
    moveSelectedBlocks,
    moveDraftBlockBySibling,
    setSelectedSlashCommandIndex,
    applySlashCommand,
    dismissSlashCommand,
    handleLinkSuggestionKeyDown,
    adjustSelectedBlocksDepth,
    adjustBlockDepth,
    deleteSelectedBlocks,
    duplicateSelectedBlocks,
    duplicateDraftBlock,
    selectBlockRange,
    getBlockSelectionFocusIndex,
    clearBlockSelection,
    selectAllBlocks,
    notifyBlockMouseDown,
    handleBlockMouseEnter,
    endBlockRangeSelection,
    isBlockRangeSelecting,
    continueBlockAt,
    downgradeBlockAt,
    mergeWithPreviousBlock,
    mergeWithNextBlock,
    splitDraftBlock,
    toggleBlockCollapse,
    isSelectionCoherent,
    getVisibleBlockCountInRange,
    getMultiBlockOperationRange,
    removeSelectedBlockRange,
     canMoveSelectedRange,
     onOpenSelectionAiEditor,
     BLOCK_INDENT_SIZE,
     ui,
     isZh
   } = props

  const nativeContainer = isContainerBlockType(block.type) ? nativeContainerPresentation(block.type, block.markdownFormat) : null
  const effectiveCodeLanguage = block.type === 'code' ? detectCodeLanguage(block.content, block.language) : null
  const nodes = useContext(MarkdownBlockNodesContext)
  const isMermaid = block.type === 'code' && /^mermaid(?:\s|$)/i.test((block.markdownFormat?.codeInfo ?? block.language ?? '').trim())
  const showAdvancedPreview = !['code', 'math', 'divider', 'table', 'frontmatter', 'database-view'].includes(block.type) && nodes && hasAdvancedMarkdown(nodes)
  const mediaEligible = !['code', 'math', 'divider', 'table', 'frontmatter', 'database-view'].includes(block.type)
  const richMedia = mediaEligible ? extractBlockRichMedia(block.content, props.markdownReferences) : { images: [], links: [] }
  const shouldShowRichMediaPreview = mediaEligible && (!showAdvancedPreview || richMedia.images.length > 0)
  const hasRichMedia = shouldShowRichMediaPreview && (richMedia.images.length > 0 || richMedia.links.length > 0)

  // 状态管理
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const [inlinePresentationHint, setInlinePresentationHint] = useState('')
  const [editingLanguage, setEditingLanguage] = useState(false)
  const [showBlockToolbar, setShowBlockToolbar] = useState(false)
  const [isMediaSourceExpanded, setIsMediaSourceExpanded] = useState(false)
  const [isTableSourceExpanded, setIsTableSourceExpanded] = useState(false)
  const InputColumn = block.type === 'table' ? 'details' : 'div'
  const canFormat = !['code', 'math', 'divider', 'table', 'frontmatter', 'html', 'database-view'].includes(block.type)
  const blockToolbarRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)
  const pendingTextSelection = useRef<{ content: string; start: number; end: number;
    direction?: 'forward' | 'backward' | 'none'; checkpoint?: boolean } | null>(null)
  useLayoutEffect(() => {
    const selection = pendingTextSelection.current, textarea = textareaRef.current
    if (!selection || !textarea || textarea.value !== selection.content) return
    pendingTextSelection.current = null
    textarea.focus()
    textarea.setSelectionRange(selection.start, selection.end, selection.direction)
    captureBlockCursor(index, textarea)
    // Keep each indentation separate from typing that follows immediately.
    if (selection.checkpoint) props.checkpointDraft?.()
  })
  const applyFormat = (format: MarkdownFormat) => {
    const textarea = textareaRef.current
    if (!textarea || !canFormat || composingRef.current) return
    const result = formatMarkdownSelection(textarea.value, textarea.selectionStart, textarea.selectionEnd, format, isZh ? '链接文字' : 'Link')
    if (result.content === textarea.value) {
      textarea.focus(); textarea.setSelectionRange(result.start, result.end); captureBlockCursor(index, textarea)
      return
    }
    pendingTextSelection.current = result
    props.checkpointDraft?.()
    updateDraftBlock(index, { content: result.content })
  }
  const applySourceInlinePresentation = async (action: SourceInlinePresentationAction) => {
    const textarea = textareaRef.current
    if (!textarea || !canFormat || composingRef.current) return
    const source = textarea.value, start = textarea.selectionStart, end = textarea.selectionEnd
    const direction = textarea.selectionDirection, blocks = getDraftBlocks(), owner = textarea.ownerDocument
    const belongsToEditor = (target: EventTarget | null) => target instanceof HTMLElement
      && (target === textarea || Boolean(target.closest('.source-inline-presentation-toolbar')) && target.closest('.block-editor-row') === textarea.closest('.block-editor-row'))
    if (!belongsToEditor(owner.activeElement)) return
    let abandoned = false
    const abandon = () => { abandoned = true }
    const focusChanged = (event: FocusEvent) => { if (!belongsToEditor(event.target)) abandon() }
    owner.addEventListener('pointerdown', abandon, true)
    owner.addEventListener('keydown', abandon, true)
    owner.addEventListener('compositionstart', abandon, true)
    owner.addEventListener('focusin', focusChanged, true)
    owner.defaultView?.addEventListener('blur', abandon)
    try {
      // The toolbar and the safe formatter share a lazy chunk; source mode
      // does not pull the ProseMirror model into the initial renderer bundle.
      const { formatSourceInlinePresentation } = await import('./SourceInlinePresentationToolbar')
      if (abandoned || composingRef.current || textareaRef.current !== textarea || !textarea.isConnected
        || textarea.closest('[inert]') || getDraftBlocks() !== blocks || textarea.value !== source
        || textarea.selectionStart !== start || textarea.selectionEnd !== end || textarea.selectionDirection !== direction) return
      const latestIndex = block.id ? blocks.findIndex(candidate => candidate.id === block.id) : index
      if (latestIndex < 0 || blocks[latestIndex]?.content !== source) return
      const result = formatSourceInlinePresentation(source, start, end, action, direction, props.markdownReferences)
      if (!result) {
        setInlinePresentationHint(isZh ? '请选择完整的可格式化文字。' : 'Select complete text that can be formatted.')
        return
      }
      setInlinePresentationHint('')
      if (result.content === source) return
      pendingTextSelection.current = result
      props.checkpointDraft?.()
      updateDraftBlock(latestIndex, { content: result.content })
    } catch {
      if (!abandoned && textareaRef.current === textarea) setInlinePresentationHint(isZh ? '格式工具加载失败，请重试。' : 'Could not load the formatting tools. Please retry.')
    } finally {
      owner.removeEventListener('pointerdown', abandon, true)
      owner.removeEventListener('keydown', abandon, true)
      owner.removeEventListener('compositionstart', abandon, true)
      owner.removeEventListener('focusin', focusChanged, true)
      owner.defaultView?.removeEventListener('blur', abandon)
    }
  }
  const getAdjacentVisibleIndex = (delta: -1 | 1, fromIndex = index) => {
    for (let next = fromIndex + delta; next >= 0 && next < draftBlockCount; next += delta) {
      if (blockTextareaRefs.current[next]) return next
    }
    return null
  }
  const registerTextarea = useCallback((element: HTMLTextAreaElement | null) => {
    const previousElement = textareaRef.current
    textareaRef.current = element
    const slots = blockTextareaRefs.current
    if (element) {
      slots[index] = element
      resizeBlockTextarea(element)
    } else if (slots[index] === previousElement) {
      slots[index] = null
    }
  }, [blockTextareaRefs, index])

  // 点击外部关闭工具栏
  useEffect(() => {
    if (!showBlockToolbar) return

    const handleClickOutside = (event: MouseEvent) => {
      if (blockToolbarRef.current && !blockToolbarRef.current.contains(event.target as Node)) {
        setShowBlockToolbar(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showBlockToolbar])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }

    resizeBlockTextarea(textarea)
  }, [block.content, block.type])

  const handleBlockTypeChange = (newType: string) => {
    if (block.type === 'database-view') return
    if (newType === block.type) return
    props.checkpointDraft?.()
    if (newType === 'divider') {
      updateDraftBlock(index, { type: newType, content: '' })
    } else {
      updateDraftBlock(index, { type: newType })
    }
  }

  const openBlockActions = (x: number, y: number) => {
    if (composingRef.current) return
    if (props.onOpenBlockActions) {
      const blocks = getDraftBlocks()
      const currentIndex = blocks.findIndex(candidate => candidate.id === block.id)
      if (!block.id || currentIndex < 0) return
      const insideSelection = selectedBlockRange && isSelected && currentIndex >= selectedBlockRange.start && currentIndex <= selectedBlockRange.end
      const selectedIds = insideSelection ? props.getSelectedBlockActionIds?.()
        ?? blocks.slice(selectedBlockRange.start, selectedBlockRange.end + 1).map(candidate => candidate.id) : [block.id]
      const blockIds = selectedIds.filter((id): id is string => Boolean(id))
      if (blockIds.length) props.onOpenBlockActions({ blockIds, x, y })
      return
    }
    setContextMenuPos({ x, y })
    setShowContextMenu(true)
  }
  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isDatabaseEditorIsland(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    openBlockActions(event.clientX, event.clientY)
  }

  const handleDeleteBlock = () => {
    if (selectedBlockRange && isSelected) {
      deleteSelectedBlocks()
      return
    }

    removeSelectedBlockRange({ start: index, end: index })
  }

  return (
    <div
      data-block-index={index}
      data-block-id={block.id}
      data-heading-level={getHeadingLevel(block.type) ?? undefined}
      data-native-container={nativeContainer ? block.type : undefined}
      data-native-container-tone={block.type === 'callout' ? nativeContainer?.tone : undefined}
      className={`block-editor-row${dropPreview ? ' block-editor-row-drag-over' : ''}${isSelected && selectedBlockCount > 1 ? ' block-editor-row-selected' : ''}${isHighlighted ? ' block-editor-row-highlighted' : ''}${isSearchMatch ? ' block-editor-row-search-match' : ''}`}
      key={block.id ?? `${selectedDocument.id}-draft-${index}`}
      style={{
        ...(block.highlight ? { background: `var(--highlight-${block.highlight})` } : undefined),
        paddingLeft: `${indentPx}px`
      }}
      onContextMenu={handleContextMenu}
      onKeyDown={(event) => {
        if (isDatabaseEditorIsland(event.target)) return
        if (isImeKeyboardEvent(event.nativeEvent, composingRef.current)) return
        if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
          event.preventDefault(); event.stopPropagation()
          const bounds = event.currentTarget.getBoundingClientRect()
          openBlockActions(bounds.left, bounds.bottom)
        }
      }}
      onMouseDown={(event) => {
        if (isDatabaseEditorIsland(event.target)) return
        if (event.button !== 0) {
          return
        }

        const target = event.target as HTMLElement
        // Keep button interactions native (add block / drag handle / collapse toggle).
        if (target.closest('button,input,select,summary,.native-container-controls')) {
          return
        }

        // Record the block where mouse was pressed; actual range selection only starts
        // if the pointer moves to a different block while the button remains held.
        notifyBlockMouseDown(index)
      }}
      onMouseEnter={(event) => {
        if (isDatabaseEditorIsland(event.target)) return
        handleBlockMouseEnter(index, (event.buttons & 1) === 1)
      }}
      onMouseUp={(event) => {
        if (event.button === 0) {
          endBlockRangeSelection()
        }
      }}
      onDragOver={(event) => {
        if (isDatabaseEditorIsland(event.target)) return
        event.preventDefault()
        setDragOverBlockIndex(index)
        setDragOverBlockDepth(getDraggedBlockDepthPreview(index, event.clientX, event.currentTarget))
      }}
      onDrop={(event) => {
        if (isDatabaseEditorIsland(event.target)) return
        event.preventDefault()
        dropBlockAt(index, getDraggedBlockDepthPreview(index, event.clientX, event.currentTarget))
      }}
    >
      {block.id && hasChildren && (getHeadingLevel(block.type)) ? (
        <button type="button" className="block-collapse-toggle section-collapse-toggle"
          aria-expanded={!collapsedBlockIds.has(block.id)}
          aria-label={`${collapsedBlockIds.has(block.id) ? (isZh ? '展开章节' : 'Expand section') : (isZh ? '折叠章节' : 'Collapse section')}：${block.content}`}
          onMouseDown={(event) => event.preventDefault()} onClick={() => toggleBlockCollapse(block.id!)}>
          {collapsedBlockIds.has(block.id) ? '▸' : '▾'}
        </button>
      ) : null}
      {/* ── Left gutter: hover controls ── */}
      <div className="block-hover-controls">
        <button
          aria-label="Add block below"
          className="block-hover-add"
          onClick={() => insertDraftBlockAt(index + 1, index)}
          type="button"
        >
          +
        </button>
        <button
          aria-label={ui.dragBlock}
          className="block-drag-handle"
          draggable
          onDragEnd={endBlockDrag}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            beginBlockDrag(index)
          }}
          onClick={(event) => {
            if (props.onOpenBlockActions) {
              const bounds = event.currentTarget.getBoundingClientRect()
              openBlockActions(bounds.left, bounds.bottom)
            } else setShowBlockToolbar(prev => !prev)
          }}
          type="button"
        >
          ⋮⋮
        </button>
        {block.id && hasChildren && !getHeadingLevel(block.type) && block.type !== 'toggle' ? (
          <button
            aria-label={collapsedBlockIds.has(block.id) ? ui.expandBlock : ui.collapseBlock}
            className={`block-collapse-toggle${collapsedBlockIds.has(block.id) ? ' block-collapse-toggle-collapsed' : ''}`}
            aria-expanded={!collapsedBlockIds.has(block.id)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => block.id && toggleBlockCollapse(block.id)}
            type="button"
          >
            {collapsedBlockIds.has(block.id) ? '▶' : '▼'}
          </button>
        ) : null}
      </div>

   {/* ── Block Edit Toolbar (Notion style) ── */}
       <div ref={blockToolbarRef}>
         <BlockEditToolbar
           block={block}
           index={index}
           isActive={showBlockToolbar}
           onHighlightChange={(highlight) => { if (highlight !== block.highlight) { props.checkpointDraft?.(); updateBlockHighlight(index, highlight) } }}
           onTypeChange={handleBlockTypeChange}
           onDuplicate={() => duplicateDraftBlock(index)}
           onDelete={handleDeleteBlock}
           aiEditDisabled={!canAiEditBlockText(props.getDraftBlocks(), { start: index, end: index })}
           onAiEdit={() => {
             if (!canAiEditBlockText(props.getDraftBlocks(), { start: index, end: index })) return
             selectBlockRange(index)
             onOpenSelectionAiEditor()
           }}
            typeOptions={blockConversionLabels(ui.blockTypeOptions ?? {})}
            ui={ui}
            isZh={isZh}
          />
        </div>

       {/* ── Context Menu ── */}
      {showContextMenu && !props.onOpenBlockActions && <Suspense fallback={null}>
        <BlockContextMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          blockType={block.type}
          onTypeChange={handleBlockTypeChange}
          onDuplicate={() => duplicateDraftBlock(index)}
          onDelete={handleDeleteBlock}
          onClose={() => setShowContextMenu(false)}
           typeOptions={blockConversionLabels(ui.blockTypeOptions ?? {})}
           ui={ui}
           isZh={isZh}
         />
      </Suspense>}

      {/* ── Content area ── */}
      <div className="block-content-area">
        {block.type === 'database-view' && block.id ? <Suspense fallback={<p role="status">{isZh ? '正在加载数据库视图…' : 'Loading database view…'}</p>}>
          <InlineDatabaseView blockId={block.id} content={block.content} mode="edit" />
        </Suspense> : block.type === 'divider' ? (
          <div className="block-divider-line" />
        ) : (
          <div className={`block-editor-input-row${hasRichMedia ? ' block-editor-input-row-media' : ''}`}>
            {/* Type-specific prefix */}
            {isOrderedListBlockType(block.type) && <span className="block-number-label">{numberLabel}</span>}
            {isTaskBlockType(block.type) && (
              <input
                className="block-todo-checkbox"
                type="checkbox"
                checked={block.checked}
                aria-label={isZh ? '待办状态' : 'Todo status'}
                onChange={(event) => { props.checkpointDraft?.(); updateDraftBlock(index, { checked: event.target.checked }) }}
              />
            )}
            {block.type === 'bulleted-list' && <span className="block-bullet-dot" />}
            {block.type === 'callout' && <span className="native-container-icon" data-native-container-icon={nativeContainer?.icon} aria-hidden="true" />}
            {block.type === 'toggle' && block.id && <button type="button" className="native-toggle-control"
              aria-expanded={!collapsedBlockIds.has(block.id)} aria-label={collapsedBlockIds.has(block.id) ? ui.expandBlock : ui.collapseBlock}
              onMouseDown={event => event.preventDefault()} onClick={() => { if (!composingRef.current) toggleBlockCollapse(block.id!) }} />}
            {block.type === 'code' && (
              editingLanguage ? (
                <CodeBlockLanguageSelector
                  currentLanguage={block.language ?? effectiveCodeLanguage ?? undefined}
                  onChange={(lang) => {
                    if (lang === block.language && lang === block.markdownFormat?.codeInfo) return
                    props.checkpointDraft?.()
                    updateDraftBlock(index, { language: lang, markdownFormat: { ...block.markdownFormat, codeInfo: lang } })
                  }}
                  onBlur={() => setEditingLanguage(false)}
                  isZh={isZh}
                />
              ) : (
                <button
                  className="block-code-language-badge"
                  type="button"
                  aria-label={isZh ? '修改代码语言' : 'Edit code language'}
                  onClick={() => setEditingLanguage(true)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setEditingLanguage(true)
                  }}
                  title={isZh ? '点击修改语言' : 'Click to edit language'}
                >
                  {effectiveCodeLanguage || (isZh ? '自动检测' : 'Auto detect')}
                </button>
              )
            )}

            <InputColumn
              className={`block-editor-input-column${block.type === 'table' ? ' markdown-table-source' : ''}`}
              open={block.type === 'table' ? isTableSourceExpanded : undefined}
              onToggle={(event) => {
                if (block.type === 'table') { setIsTableSourceExpanded((event.currentTarget as HTMLDetailsElement).open); resizeBlockTextarea(textareaRef.current) }
              }}
              onBlur={(event) => {
                // Keep the state intact when focus moves from the editor to its toggle.
                if (hasRichMedia && !event.currentTarget.contains(event.relatedTarget)) {
                  setIsMediaSourceExpanded(false)
                }
              }}
            >
              {block.type === 'table' ? <summary>{isZh ? '编辑表格源码' : 'Edit table source'}</summary> : null}
              {block.type === 'frontmatter' ? <span>{isZh ? '文档属性（YAML）' : 'Document properties (YAML)'}</span> : null}
              {nativeContainer && <Suspense fallback={null}><NativeContainerControls type={block.type as 'callout' | 'toggle'}
                format={block.markdownFormat} isZh={isZh} typeOptions={ui.blockTypeOptions ?? {}}
                onChange={markdownFormat => {
                  if (composingRef.current) return
                  props.checkpointDraft?.(); updateDraftBlock(index, { markdownFormat }); props.checkpointDraft?.()
                }} onAddChild={props.insertChildDraftBlock ? type => {
                  if (!composingRef.current) props.insertChildDraftBlock?.(index, undefined, type)
                } : undefined} onReturnToTitle={() => textareaRef.current?.focus()} /></Suspense>}
              {canFormat && activeBlockIndex === index ? <Suspense fallback={null}>
                <MarkdownFormatToolbar textareaRef={textareaRef} isZh={isZh} onFormat={applyFormat} onReturnToEditor={() => textareaRef.current?.focus()}>
                  <SourceInlinePresentationToolbar isZh={isZh} onApply={action => { void applySourceInlinePresentation(action) }}
                    onReturnToEditor={() => textareaRef.current?.focus()} />
                  {inlinePresentationHint ? <p className="mini-hint" role="status">{inlinePresentationHint}</p> : null}
                </MarkdownFormatToolbar>
              </Suspense> : null}
              {hasRichMedia ? (
                <button
                  aria-expanded={isMediaSourceExpanded}
                  className="block-media-source-toggle"
                  onClick={(event) => {
                    setIsMediaSourceExpanded(!isMediaSourceExpanded)
                    if (isMediaSourceExpanded) {
                      event.currentTarget.focus()
                    } else {
                      requestAnimationFrame(() => textareaRef.current?.focus())
                    }
                  }}
                  type="button"
                >
                  <span className="block-media-source-toggle-icon">
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="M4 5.5h12M4 10h8M4 14.5h10" />
                    </svg>
                  </span>
                  <span className="block-media-source-toggle-copy">
                    <strong>{isZh ? '媒体内容' : 'Media content'}</strong>
                    <small>
                      {[
                        richMedia.images.length > 0
                          ? (isZh ? `${richMedia.images.length} 张图片` : `${richMedia.images.length} image${richMedia.images.length > 1 ? 's' : ''}`)
                          : null,
                        richMedia.links.length > 0
                          ? (isZh ? `${richMedia.links.length} 个链接` : `${richMedia.links.length} link${richMedia.links.length > 1 ? 's' : ''}`)
                          : null
                      ].filter(Boolean).join(' · ')}
                    </small>
                  </span>
                  <span className="block-media-source-toggle-action">
                    {isMediaSourceExpanded
                      ? (isZh ? '收起源内容' : 'Collapse source')
                      : (isZh ? '编辑源内容' : 'Edit source')}
                  </span>
                </button>
              ) : null}

              {/* The textarea */}
              <textarea
              className={`block-inline-textarea type-${block.type}${hasRichMedia ? ' block-rich-media-source-input' : ''}${isMediaSourceExpanded ? ' expanded' : ''}`}
              spellCheck={false}
              aria-label={nativeContainer ? (isZh ? block.type === 'callout' ? '提示块标题' : '折叠块标题' : block.type === 'callout' ? 'Callout title' : 'Toggle title') : undefined}
              ref={registerTextarea}
              placeholder={
                getHeadingLevel(block.type)
                  ? (isZh ? '标题 ' : 'Heading ') + getHeadingLevel(block.type)
                    : isTaskBlockType(block.type)
                      ? isZh
                        ? '待办事项'
                        : 'Todo'
                      : block.type === 'quote'
                        ? isZh
                          ? '引用'
                          : 'Quote'
                        : block.type === 'code'
                          ? isZh
                            ? '代码'
                            : 'Code'
                          : block.type === 'math'
                            ? isZh
                              ? '公式'
                              : 'Math'
                            : block.type === 'table'
                              ? isZh
                                ? '使用 Markdown 表格语法编辑'
                                : 'Edit using Markdown table syntax'
                            : block.type === 'bulleted-list'
                              ? isZh
                                ? '列表项'
                                : 'List item'
                              : isOrderedListBlockType(block.type)
                                ? isZh
                                  ? '列表项'
                                  : 'List item'
                                : isZh
                                  ? '输入文字，或 / 唤出命令'
                                  : 'Type text or / for commands'
              }
              onChange={(event) => {
                setInlinePresentationHint('')
                resizeBlockTextarea(event.currentTarget)
                if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) {
                  updateDraftBlock(index, { content: event.target.value })
                } else {
                  handleBlockContentChange(index, event.target.value)
                }
                captureBlockCursor(index, event.target)
              }}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={(event) => {
                composingRef.current = false
                updateDraftBlock(index, { content: event.currentTarget.value })
                resizeBlockTextarea(event.currentTarget)
                captureBlockCursor(index, event.currentTarget)
              }}
              onBlur={() => { composingRef.current = false }}
              onPaste={(event) => {
                const textarea = event.currentTarget
                const start = textarea.selectionStart ?? textarea.value.length
                const end = textarea.selectionEnd ?? textarea.value.length
                const markdown = !['code', 'math', 'table', 'frontmatter', 'html'].includes(block.type) &&
                  event.clipboardData.files.length === 0
                  ? event.clipboardData.getData('application/x-knowbook-markdown') ||
                    (event.clipboardData.getData('text/html').includes('data-knowbook-markdown-source="true"')
                      ? event.clipboardData.getData('text/plain') : htmlClipboardToMarkdown(event.clipboardData.getData('text/html'))) : ''
                if (
                  handleBlockPaste(
                    index,
                    markdown || event.clipboardData.getData('text/plain'),
                    start,
                    end
                  )
                ) {
                  event.preventDefault()
                } else if (markdown) {
                  // A single formatted line stays in this block. Native textarea
                  // paste would otherwise discard its HTML formatting.
                  event.preventDefault()
                  const content = textarea.value.slice(0, start) + markdown + textarea.value.slice(end)
                  const cursor = start + markdown.length
                  if (content === textarea.value) {
                    textarea.setSelectionRange(cursor, cursor)
                    captureBlockCursor(index, textarea)
                    return
                  }
                  captureBlockCursor(index, textarea)
                  props.checkpointDraft?.()
                  pendingTextSelection.current = { content, start: cursor, end: cursor, checkpoint: true }
                  updateDraftBlock(index, { content })
                }
              }}
              onCopy={(event) => {
                if (!selectedBlockRange || !isSelected) return
                if (
                  selectedBlockCount === 1 &&
                  (event.currentTarget.selectionStart ?? 0) !== (event.currentTarget.selectionEnd ?? 0)
                )
                  return
                const range = getMultiBlockOperationRange(selectedBlockRange)
                event.clipboardData.setData('text/plain', serializeDraftBlockRange(getDraftBlocks(), range))
                event.preventDefault()
              }}
              onCut={(event) => {
                if (!selectedBlockRange || !isSelected) return
                if (
                  selectedBlockCount === 1 &&
                  (event.currentTarget.selectionStart ?? 0) !== (event.currentTarget.selectionEnd ?? 0)
                )
                  return
                const range = getMultiBlockOperationRange(selectedBlockRange)
                event.clipboardData.setData('text/plain', serializeDraftBlockRange(getDraftBlocks(), range))
                event.preventDefault()
                removeSelectedBlockRange(range)
              }}
              onMouseDown={(event) => {
                // Shift+Click: manually extend block selection to this row
                if (event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault()
                  selectBlockRange(index, true)
                } else {
                  clearBlockSelection?.()
                }
              }}
              onClick={(event) => {
                captureBlockCursor(index, event.currentTarget)
                if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
                  void navigateInlineReferenceAtCursor(
                    block.content,
                    event.currentTarget.selectionStart ?? event.currentTarget.value.length
                  )
                }
              }}
              onFocus={(event) => {
                if (hasRichMedia) {
                  setIsMediaSourceExpanded(true)
                }
                resizeBlockTextarea(event.currentTarget)
                captureBlockCursor(index, event.currentTarget)
              }}
              onKeyDown={(event) => {
                if (isImeKeyboardEvent(event.nativeEvent, composingRef.current)) {
                  // Leave candidate selection to the IME, including the final Enter.
                  event.stopPropagation()
                  return
                }
                if (canFormat && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'u') {
                  event.preventDefault(); event.stopPropagation()
                  void applySourceInlinePresentation({ kind: 'underline' })
                  return
                }
                const format = canFormat ? markdownFormatShortcut(event) : null
                if (format) { event.preventDefault(); event.stopPropagation(); applyFormat(format); return }
                if (canFormat && event.altKey && event.key === 'F10' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                  event.preventDefault(); event.stopPropagation()
                  event.currentTarget.closest('.block-editor-input-column')?.querySelector<HTMLButtonElement>('.markdown-format-toolbar button')?.focus()
                  return
                }
                if (activeBlockIndex === index && handleLinkSuggestionKeyDown?.(event)) return
                // Suggestions own unmodified navigation before block boundaries.
                // Modified arrows and Shift+Enter retain their editor meaning.
                if (activeBlockIndex === index && activeSlashContext && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault(); event.stopPropagation()
                    const delta = event.key === 'ArrowDown' ? 1 : -1
                    setSelectedSlashCommandIndex((previous) => filteredSlashCommands.length === 0
                      ? 0 : (previous + delta + filteredSlashCommands.length) % filteredSlashCommands.length)
                    return
                  }
                  if ((event.key === 'Enter' || event.key === 'Tab') && (activeSlashCommand || slashCommandsUnavailable)) {
                    event.preventDefault(); event.stopPropagation()
                    if (activeSlashCommand) applySlashCommand(activeSlashCommand as any)
                    else if (event.key === 'Enter') retrySlashCommands?.()
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation()
                    dismissSlashCommand()
                    return
                  }
                }
                const blockSelectionKey = event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey &&
                  (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                const moveBlockKey = event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey &&
                  (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                if (selectedBlockRange && !moveBlockKey && (!blockSelectionKey || event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) &&
                    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  clearBlockSelection?.()
                }
                // Ctrl/Cmd+A: select all blocks when block is empty or all text already selected
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !event.shiftKey && !event.altKey) {
                  const el = event.currentTarget
                  const isEmpty = el.value.trim() === ''
                  const allSelected = el.selectionStart === 0 && el.selectionEnd === el.value.length
                  if (isEmpty || allSelected) {
                    event.preventDefault()
                    selectAllBlocks()
                    // The second Select All switches from text to block selection.
                    el.setSelectionRange(el.value.length, el.value.length)
                    return
                  }
                  clearBlockSelection?.()
                }

                // Unmodified arrows cross blocks only at an absolute text boundary.
                if (
                  ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey
                ) {
                  const el = event.currentTarget
                  const backwards = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                  const boundary = backwards ? 0 : el.value.length
                  if (el.selectionStart === boundary && el.selectionEnd === boundary) {
                    const targetIndex = getAdjacentVisibleIndex(backwards ? -1 : 1)
                    const target = targetIndex === null ? null : blockTextareaRefs.current[targetIndex]
                    if (target && targetIndex !== null) {
                      event.preventDefault()
                      focusBlockTextarea(target)
                      const position = backwards ? target.value.length : 0
                      target.setSelectionRange(position, position)
                      captureBlockCursor(targetIndex, target)
                      return
                    }
                  }
                }

                // Shift+ArrowUp/Down: extend block selection
                if (blockSelectionKey) {
                  const el = event.currentTarget
                  const atTop = el.selectionStart === 0 && el.selectionEnd === 0
                  const atBottom = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
                  const wouldLeaveBounds = (event.key === 'ArrowUp' && atTop) || (event.key === 'ArrowDown' && atBottom)
                  const focusIndex = isSelected ? getBlockSelectionFocusIndex?.() ?? null : null
                  if (el.selectionStart === el.selectionEnd && (wouldLeaveBounds || focusIndex !== null)) {
                    const backwards = event.key === 'ArrowUp'
                    const targetIndex = getAdjacentVisibleIndex(backwards ? -1 : 1, focusIndex ?? index)
                    if (targetIndex !== null) {
                      event.preventDefault()
                      selectBlockRange(targetIndex, true)
                      const target = blockTextareaRefs.current[targetIndex]!
                      focusBlockTextarea(target)
                      const position = backwards ? 0 : target.value.length
                      target.setSelectionRange(position, position)
                      captureBlockCursor(targetIndex, target)
                    } else if (focusIndex !== null) {
                      // Keep the range intact at the first/last visible block.
                      event.preventDefault()
                    }
                    return
                  }
                }

                // Alt+Arrow: move block
                if (moveBlockKey) {
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

                // Lists retain Tab nesting; source indents text; prose can return to its format toolbar.
                if (event.key === 'Tab' && !event.altKey && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault()
                  const el = event.currentTarget
                  const start = el.selectionStart ?? 0
                  const end = el.selectionEnd ?? 0

                  if (selectedBlockRange && isSelected && selectedBlockCount > 1) {
                    adjustSelectedBlocksDepth(event.shiftKey ? -1 : 1, index, start)
                    return
                  }

                  if (isNestableBlockType(block.type)) {
                    adjustBlockDepth(index, event.shiftKey ? -1 : 1, start)
                    return
                  }

                  if (canFormat) {
                    const blocks = getDraftBlocks()
                    const currentIndex = block.id ? blocks.findIndex(candidate => candidate.id === block.id) : index
                    const current = blocks[currentIndex]
                    const nativeParent = current?.parentBlockId && blocks.some(candidate => candidate.id === current.parentBlockId && isContainerBlockType(candidate.type))
                    let previous = currentIndex - 1
                    while (current && previous >= 0 && blocks[previous].depth > current.depth) previous--
                    const sibling = blocks[previous]
                    const previousNative = current && sibling && sibling.depth === current.depth
                      && (sibling.parentBlockId ?? null) === (current.parentBlockId ?? null) && isContainerBlockType(sibling.type)
                    if (current && (nativeParent || !event.shiftKey && previousNative)) {
                      adjustBlockDepth(currentIndex, event.shiftKey ? -1 : 1, start)
                      return
                    }
                  }

                  if (!canFormat) {
                    const result = editCodeIndentation(el.value, start, end, event.shiftKey, el.selectionDirection)
                    if (result.content !== el.value) {
                      pendingTextSelection.current = { ...result, checkpoint: true }
                      props.checkpointDraft?.()
                      updateDraftBlock(index, { content: result.content })
                    }
                    return
                  }

                  if (canFormat && event.shiftKey) {
                    [...el.closest('.block-editor-input-column')!.querySelectorAll<HTMLButtonElement>('.markdown-format-toolbar button')].at(-1)?.focus()
                    return
                  }

                  const spaces = '  '
                  const newValue = el.value.slice(0, start) + spaces + el.value.slice(end)
                  handleBlockContentChange(index, newValue)
                  // restore cursor after React re-render
                  requestAnimationFrame(() => {
                    el.selectionStart = start + spaces.length
                    el.selectionEnd = start + spaces.length
                  })
                  return
                }

                // Multi-block Delete
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

                // Delete at the end joins only the next visible text block.
                if (
                  event.key === 'Delete' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  event.currentTarget.selectionStart === event.currentTarget.value.length &&
                  event.currentTarget.selectionEnd === event.currentTarget.value.length
                ) {
                  const nextIndex = getAdjacentVisibleIndex(1)
                  if (nextIndex !== null && mergeWithNextBlock?.(index, nextIndex)) event.preventDefault()
                  return
                }

                // Enter to continue
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  ['paragraph', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list', 'callout', 'toggle'].includes(block.type)
                ) {
                  event.preventDefault()
                  const continueText = block.type === 'paragraph' ? splitDraftBlock : continueBlockAt
                  continueText(
                    index,
                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                    event.currentTarget.selectionEnd ?? event.currentTarget.value.length
                  )
                  return
                }

                // Backspace at start
                if (
                  event.key === 'Backspace' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  (event.currentTarget.selectionStart ?? 0) === 0 &&
                  (event.currentTarget.selectionEnd ?? 0) === 0
                ) {
                  event.preventDefault()
                  if (['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6', 'todo', 'numbered-todo', 'quote', 'bulleted-list', 'numbered-list', 'callout', 'toggle'].includes(block.type)) {
                    downgradeBlockAt(index)
                  } else if (index > 0 && blockTextareaRefs.current[index - 1]) {
                    mergeWithPreviousBlock(index)
                  }
                  return
                }

                // Cmd/Ctrl+Shift+D: duplicate
                if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
                  event.preventDefault()
                  if (selectedBlockRange && isSelected) {
                    duplicateSelectedBlocks()
                  } else {
                    duplicateDraftBlock(index)
                  }
                  return
                }

                // Alt+Enter: split
                if (event.altKey && event.key === 'Enter') {
                  event.preventDefault()
                  splitDraftBlock(
                    index,
                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                    event.currentTarget.selectionEnd ?? event.currentTarget.value.length
                  )
                  return
                }

                // Cmd/Ctrl+Enter: insert below
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  insertDraftBlockAt(index + 1, index)
                }
              }}
              onKeyUp={(event) => {
                if (event.currentTarget === document.activeElement) captureBlockCursor(index, event.currentTarget)
              }}
              onSelect={(event) => captureBlockCursor(index, event.currentTarget)}
              rows={1}
              value={block.content}
            />
            </InputColumn>
          </div>
        )}

        {/* Drop preview */}
        {dropPreview ? (
          <div className="block-drop-preview" style={{ marginInlineStart: `${dropPreview.effectiveDepth * BLOCK_INDENT_SIZE}px` }}>
            <span className="block-drop-preview-badge">{dropPreview.positionLabel}</span>
            <span className="block-drop-preview-meta">{ui.dropPreviewMeta(dropPreview.effectiveDepth, dropPreview.parentText)}</span>
          </div>
        ) : null}

        {shouldShowRichMediaPreview ? <BlockRichMediaPreview content={block.content} ui={ui} isZh={isZh}
          onImageBegin={() => props.checkpointDraft?.()} onImageCommit={(occurrence, _next, content) => {
            const current = getDraftBlocks()[index]
            if (!current || current.id !== block.id || current.content !== occurrence.originalContent) return
            props.checkpointDraft?.()
            updateDraftBlock(index, { content })
          }} /> : null}
        {showAdvancedPreview ? <div className="markdown-advanced-preview" aria-label={isZh ? 'Markdown 预览' : 'Markdown preview'}>
          <MarkdownBlockContent hideImages={richMedia.images.length > 0} onReference={(label) => { void navigateInlineReferenceAtCursor(`[[${label}]]`, 2) }} />
        </div> : null}
        {block.type === 'table' ? (
          <Suspense fallback={<MarkdownTablePreview content={block.content} label={isZh ? '表格预览' : 'Table preview'} />}>
            <MarkdownTableEditor content={block.content} sessionKey={`${selectedDocument.id}:${block.id}`} isZh={isZh} onBeginEdit={props.checkpointDraft}
              onChange={(content, transaction) => { if (transaction) props.checkpointDraft?.(); updateDraftBlock(index, { content }) }} />
          </Suspense>
        ) : null}
        {block.type === 'code' && block.content.trim() ? (
          isMermaid ? <MarkdownMermaidPreview source={block.content} label={isZh ? 'Mermaid 图表' : 'Mermaid diagram'} /> : <Suspense fallback={<div className="block-structured-preview-loading">{ui.common.loading}</div>}>
            <CodeBlockPreview
              code={block.content}
              label={isZh ? '代码预览' : 'Code preview'}
              language={effectiveCodeLanguage}
            />
          </Suspense>
        ) : null}
        {block.type === 'math' && block.content.trim() ? (
          <Suspense fallback={<div className="block-structured-preview-loading">{ui.common.loading}</div>}>
            <MathBlockPreview expression={block.content} label={isZh ? '公式预览' : 'Math preview'} />
          </Suspense>
        ) : null}
      </div>
    </div>
  )
})
