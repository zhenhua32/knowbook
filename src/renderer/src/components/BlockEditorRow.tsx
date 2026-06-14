import { useState, useRef, useEffect, memo } from 'react'
import { detectCodeLanguage } from '@shared/code'
import type { DocumentBlockDraft, DocumentBlock } from '@shared/contracts'
import { BlockEditToolbar } from './BlockEditToolbar'
import { BlockContextMenu } from './BlockContextMenu'
import { BlockRichMediaPreview } from './BlockRichMediaPreview'
import { CodeBlockLanguageSelector } from './CodeBlockLanguageSelector'
import { serializeDraftBlockRange } from '../utils/draftClipboard'

export type BlockDropPreview = {
  positionLabel: string
  effectiveDepth: number
  parentText: string | null
}

export type BlockEditorRowProps = {
  // Block data
  block: DocumentBlockDraft
  index: number
  draftBlocks: DocumentBlockDraft[]
  selectedDocument: { id: string; title: string }

  // Row state
  isSelected: boolean
  isHighlighted: boolean
  dropPreview: BlockDropPreview | null
  indentPx: number
  numberLabel: string
  activeBlockIndex: number | null
  collapsedBlockIds: Set<string>

  // Editor context
  activeSlashContext: { query: string } | null
  filteredSlashCommands: Array<{ id: string; label: string; description: string }>
  activeSlashCommand: { id: string } | null | undefined
  selectedBlockRange: { start: number; end: number } | null
  selectedBlockCount: number

  // References
  blockTextareaRefs: React.MutableRefObject<Array<HTMLTextAreaElement | null>>

  // Callbacks: block operations
  updateDraftBlock: (index: number, patch: Partial<DocumentBlockDraft>) => void
  updateBlockHighlight: (index: number, highlight: string | undefined) => void
  insertDraftBlockAt: (index: number, anchorIndex: number) => void

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
  adjustSelectedBlocksDepth: (delta: -1 | 1, index: number, cursorPos: number) => void
  adjustBlockDepth: (index: number, delta: -1 | 1, cursorPos: number) => void
  deleteSelectedBlocks: () => void
  duplicateSelectedBlocks: () => void
  duplicateDraftBlock: (index: number) => void
  selectBlockRange: (index: number, extendSelection?: boolean) => void
  selectAllBlocks: () => void
  notifyBlockMouseDown: (index: number) => void
  handleBlockMouseEnter: (index: number, buttonsHeld: boolean) => void
  endBlockRangeSelection: () => void
  isBlockRangeSelecting: boolean

  // Callbacks: block structure
  continueBlockAt: (index: number, start: number, end: number) => void
  downgradeBlockAt: (index: number) => void
  mergeWithPreviousBlock: (index: number) => void
  splitDraftBlock: (index: number, start: number, end: number) => void

  // Callbacks: helpers
  blockHasChildren: (index: number) => boolean
  toggleBlockCollapse: (blockId: string) => void
  isSelectionCoherent: (range: { start: number; end: number }) => boolean
  getVisibleBlockCountInRange: (range: { start: number; end: number }) => number
  getMultiBlockOperationRange: (range: { start: number; end: number }) => { start: number; end: number }
  removeSelectedBlockRange: (range: { start: number; end: number }) => void

  // Callbacks: selection/interaction guards
  canMoveSelectedRange: (range: { start: number; end: number }, delta: -1 | 1) => boolean

  // Constants & UI
  BLOCK_INDENT_SIZE: number
  ui: any
  isZh: boolean
}

function resizeBlockTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return
  }

  // Preserve scroll positions to prevent the document from jumping 
  // when we temporarily shrink the textarea to measure its true scrollHeight.
  const scrollContainer = textarea.closest('.content') || document.documentElement
  const scrollTop = scrollContainer.scrollTop

  textarea.style.height = '0px'
  const newHeight = `${textarea.scrollHeight}px`
  textarea.style.height = newHeight

  // If the layout thrashing caused the browser to clamp scroll position, restore it
  if (scrollContainer.scrollTop !== scrollTop) {
    scrollContainer.scrollTop = scrollTop
  }
}

function isNestableBlockType(type: DocumentBlock['type']): boolean {
  return ['todo', 'bulleted-list', 'numbered-list'].includes(type)
}

export const BlockEditorRow = memo(function BlockEditorRow(props: BlockEditorRowProps) {
  const {
    block,
    index,
    draftBlocks,
    selectedDocument,
    isSelected,
    isHighlighted,
    dropPreview,
    indentPx,
    numberLabel,
    activeBlockIndex,
    collapsedBlockIds,
    activeSlashContext,
    filteredSlashCommands,
    activeSlashCommand,
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
    adjustSelectedBlocksDepth,
    adjustBlockDepth,
    deleteSelectedBlocks,
    duplicateSelectedBlocks,
    duplicateDraftBlock,
    selectBlockRange,
    selectAllBlocks,
    notifyBlockMouseDown,
    handleBlockMouseEnter,
    endBlockRangeSelection,
    isBlockRangeSelecting,
    continueBlockAt,
    downgradeBlockAt,
    mergeWithPreviousBlock,
    splitDraftBlock,
    blockHasChildren,
    toggleBlockCollapse,
    isSelectionCoherent,
    getVisibleBlockCountInRange,
    getMultiBlockOperationRange,
    removeSelectedBlockRange,
    canMoveSelectedRange,
    BLOCK_INDENT_SIZE,
    ui,
    isZh
  } = props

  const isNestableBlock = (type: string) => ['todo', 'bulleted-list', 'numbered-list'].includes(type)
  const effectiveCodeLanguage = block.type === 'code' ? detectCodeLanguage(block.content, block.language) : null
  const shouldShowRichMediaPreview = !['code', 'math', 'divider'].includes(block.type)

  // 状态管理
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const [editingLanguage, setEditingLanguage] = useState(false)
  const [showBlockToolbar, setShowBlockToolbar] = useState(false)
  const blockToolbarRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

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

    const frame = requestAnimationFrame(() => resizeBlockTextarea(textarea))
    return () => cancelAnimationFrame(frame)
  }, [block.content, block.type])

  const handleBlockTypeChange = (newType: string) => {
    if (newType === 'divider') {
      updateDraftBlock(index, { type: newType, content: '' })
    } else {
      updateDraftBlock(index, { type: newType })
    }
  }

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setShowContextMenu(true)
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
      className={`block-editor-row${dropPreview ? ' block-editor-row-drag-over' : ''}${isSelected && selectedBlockCount > 1 ? ' block-editor-row-selected' : ''}${isHighlighted ? ' block-editor-row-highlighted' : ''}`}
      key={block.id ?? `${selectedDocument.id}-draft-${index}`}
      style={{
        ...(block.highlight ? { background: `var(--highlight-${block.highlight})` } : undefined),
        paddingLeft: `${indentPx}px`
      }}
      onContextMenu={handleContextMenu}
      onMouseDown={(event) => {
        if (event.button !== 0) {
          return
        }

        const target = event.target as HTMLElement
        // Keep button interactions native (add block / drag handle / collapse toggle).
        if (target.closest('button')) {
          return
        }

        // Record the block where mouse was pressed; actual range selection only starts
        // if the pointer moves to a different block while the button remains held.
        notifyBlockMouseDown(index)
      }}
      onMouseEnter={(event) => {
        handleBlockMouseEnter(index, (event.buttons & 1) === 1)
      }}
      onMouseUp={(event) => {
        if (event.button === 0) {
          endBlockRangeSelection()
        }
      }}
      onDragOver={(event) => {
        event.preventDefault()
        setDragOverBlockIndex(index)
        setDragOverBlockDepth(getDraggedBlockDepthPreview(index, event.clientX, event.currentTarget))
      }}
      onDrop={(event) => {
        event.preventDefault()
        dropBlockAt(index, getDraggedBlockDepthPreview(index, event.clientX, event.currentTarget))
      }}
    >
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
          onClick={() => setShowBlockToolbar(prev => !prev)}
          type="button"
        >
          ⋮⋮
        </button>
        {block.id && blockHasChildren(index) ? (
          <button
            aria-label={collapsedBlockIds.has(block.id) ? ui.expandBlock : ui.collapseBlock}
            className={`block-collapse-toggle${collapsedBlockIds.has(block.id) ? ' block-collapse-toggle-collapsed' : ''}`}
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
          onHighlightChange={(highlight) => updateBlockHighlight(index, highlight)}
          onTypeChange={handleBlockTypeChange}
          onDuplicate={() => duplicateDraftBlock(index)}
          onDelete={handleDeleteBlock}
          typeOptions={{
            paragraph: ui.blockTypeOptions?.paragraph || 'Paragraph',
            'heading-1': ui.blockTypeOptions?.['heading-1'] || 'Heading 1',
            'heading-2': ui.blockTypeOptions?.['heading-2'] || 'Heading 2',
            todo: ui.blockTypeOptions?.todo || 'Todo',
            code: ui.blockTypeOptions?.code || 'Code',
            math: ui.blockTypeOptions?.math || 'Math',
            quote: ui.blockTypeOptions?.quote || 'Quote',
            'bulleted-list': ui.blockTypeOptions?.['bulleted-list'] || 'Bulleted list',
            'numbered-list': ui.blockTypeOptions?.['numbered-list'] || 'Numbered list',
            divider: ui.blockTypeOptions?.divider || 'Divider'
          }}
          ui={ui}
          isZh={isZh}
        />
      </div>

      {/* ── Context Menu ── */}
      {showContextMenu && (
        <BlockContextMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          blockType={block.type}
          onTypeChange={handleBlockTypeChange}
          onDuplicate={() => duplicateDraftBlock(index)}
          onDelete={handleDeleteBlock}
          onClose={() => setShowContextMenu(false)}
          typeOptions={{
            paragraph: ui.blockTypeOptions?.paragraph || 'Paragraph',
            'heading-1': ui.blockTypeOptions?.['heading-1'] || 'Heading 1',
            'heading-2': ui.blockTypeOptions?.['heading-2'] || 'Heading 2',
            todo: ui.blockTypeOptions?.todo || 'Todo',
            code: ui.blockTypeOptions?.code || 'Code',
            math: ui.blockTypeOptions?.math || 'Math',
            quote: ui.blockTypeOptions?.quote || 'Quote',
            'bulleted-list': ui.blockTypeOptions?.['bulleted-list'] || 'Bulleted list',
            'numbered-list': ui.blockTypeOptions?.['numbered-list'] || 'Numbered list',
            divider: ui.blockTypeOptions?.divider || 'Divider'
          }}
          ui={ui}
          isZh={isZh}
        />
      )}

      {/* ── Content area ── */}
      <div className="block-content-area">
        {block.type === 'divider' ? (
          <div className="block-divider-line" />
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            {/* Type-specific prefix */}
            {block.type === 'todo' && (
              <input
                className="block-todo-checkbox"
                type="checkbox"
                checked={block.checked}
                onChange={(event) => updateDraftBlock(index, { checked: event.target.checked })}
              />
            )}
            {block.type === 'bulleted-list' && <span className="block-bullet-dot" />}
            {block.type === 'numbered-list' && <span className="block-number-label">{numberLabel}</span>}
            {block.type === 'code' && (
              editingLanguage ? (
                <CodeBlockLanguageSelector
                  currentLanguage={block.language ?? effectiveCodeLanguage ?? undefined}
                  onChange={(lang) => updateDraftBlock(index, { language: lang })}
                  onBlur={() => setEditingLanguage(false)}
                  isZh={isZh}
                />
              ) : (
                <span
                  className="block-code-language-badge"
                  onClick={() => setEditingLanguage(true)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setEditingLanguage(true)
                  }}
                  role="button"
                  title={isZh ? '点击修改语言' : 'Click to edit language'}
                >
                  {effectiveCodeLanguage || (isZh ? '自动检测' : 'Auto detect')}
                </span>
              )
            )}

            {/* The textarea */}
            <textarea
              className={`block-inline-textarea type-${block.type}`}
              spellCheck={false}
              ref={(element) => {
                textareaRef.current = element
                blockTextareaRefs.current[index] = element
                resizeBlockTextarea(element)
              }}
              placeholder={
                block.type === 'heading-1'
                  ? isZh
                    ? '标题 1'
                    : 'Heading 1'
                  : block.type === 'heading-2'
                    ? isZh
                      ? '标题 2'
                      : 'Heading 2'
                    : block.type === 'todo'
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
                            : block.type === 'bulleted-list'
                              ? isZh
                                ? '列表项'
                                : 'List item'
                              : block.type === 'numbered-list'
                                ? isZh
                                  ? '列表项'
                                  : 'List item'
                                : isZh
                                  ? '输入文字，或 / 唤出命令'
                                  : 'Type text or / for commands'
              }
              onChange={(event) => {
                resizeBlockTextarea(event.currentTarget)
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
                if (!selectedBlockRange || !isSelected) return
                if (
                  selectedBlockCount === 1 &&
                  (event.currentTarget.selectionStart ?? 0) !== (event.currentTarget.selectionEnd ?? 0)
                )
                  return
                const range = getMultiBlockOperationRange(selectedBlockRange)
                event.clipboardData.setData('text/plain', serializeDraftBlockRange(draftBlocks, range))
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
                event.clipboardData.setData('text/plain', serializeDraftBlockRange(draftBlocks, range))
                event.preventDefault()
                removeSelectedBlockRange(range)
              }}
              onMouseDown={(event) => {
                // Shift+Click: manually extend block selection to this row
                if (event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault()
                  selectBlockRange(index, true)
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
                resizeBlockTextarea(event.currentTarget)
                captureBlockCursor(index, event.currentTarget)
              }}
              onKeyDown={(event) => {
                // Ctrl/Cmd+A: select all blocks when block is empty or all text already selected
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !event.shiftKey && !event.altKey) {
                  const el = event.currentTarget
                  const isEmpty = el.value.trim() === ''
                  const allSelected = el.selectionStart === 0 && el.selectionEnd === el.value.length
                  if (isEmpty || allSelected) {
                    event.preventDefault()
                    selectAllBlocks()
                    return
                  }
                }

                // Arrow moves to next/prev block natively if caret is at the bounds
                if (
                  (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey
                ) {
                  const el = event.currentTarget
                  const atTop = el.selectionStart === 0 && el.selectionEnd === 0
                  const atBottom = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
                  if (event.key === 'ArrowUp' && atTop && index > 0) {
                    event.preventDefault()
                    const prev = blockTextareaRefs.current[index - 1]
                    if (prev) {
                      prev.focus()
                      prev.setSelectionRange(prev.value.length, prev.value.length)
                    }
                    return
                  } else if (event.key === 'ArrowDown' && atBottom && index < draftBlocks.length - 1) {
                    event.preventDefault()
                    const next = blockTextareaRefs.current[index + 1]
                    if (next) {
                      next.focus()
                      next.setSelectionRange(0, 0)
                    }
                    return
                  }
                }

                // Shift+ArrowUp/Down: extend block selection
                if (event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey &&
                    (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                  const el = event.currentTarget
                  const atTop = el.selectionStart === 0 && el.selectionEnd === 0
                  const atBottom = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
                  const wouldLeaveBounds = (event.key === 'ArrowUp' && atTop) || (event.key === 'ArrowDown' && atBottom)
                  if (wouldLeaveBounds || (selectedBlockRange && selectedBlockRange.start !== selectedBlockRange.end)) {
                    event.preventDefault()
                    const targetIndex = event.key === 'ArrowUp' ? index - 1 : index + 1
                    if (targetIndex >= 0 && targetIndex < draftBlocks.length) {
                      selectBlockRange(targetIndex, true)
                    }
                    return
                  }
                }

                // Alt+Arrow: move block
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

                // Slash command navigation
                if (activeBlockIndex === index && activeSlashContext) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setSelectedSlashCommandIndex((p) =>
                      filteredSlashCommands.length === 0 ? 0 : (p + 1) % filteredSlashCommands.length
                    )
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setSelectedSlashCommandIndex((p) =>
                      filteredSlashCommands.length === 0 ? 0 : (p - 1 + filteredSlashCommands.length) % filteredSlashCommands.length
                    )
                    return
                  }
                  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                    if (activeSlashCommand) {
                      event.preventDefault()
                      applySlashCommand(activeSlashCommand as any)
                      return
                    }
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    dismissSlashCommand()
                    return
                  }
                }


                // Tab / Shift+Tab: adjust nesting for list-like blocks, otherwise keep the current space insertion behavior.
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

                // Enter to continue
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
                  if (['heading-1', 'heading-2', 'todo', 'quote', 'bulleted-list', 'numbered-list'].includes(block.type)) {
                    downgradeBlockAt(index)
                  } else if (index > 0) {
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
              onKeyUp={(event) => captureBlockCursor(index, event.currentTarget)}
              onSelect={(event) => captureBlockCursor(index, event.currentTarget)}
              rows={1}
              value={block.content}
            />
          </div>
        )}

        {/* Drop preview */}
        {dropPreview ? (
          <div className="block-drop-preview" style={{ marginInlineStart: `${dropPreview.effectiveDepth * BLOCK_INDENT_SIZE}px` }}>
            <span className="block-drop-preview-badge">{dropPreview.positionLabel}</span>
            <span className="block-drop-preview-meta">{ui.dropPreviewMeta(dropPreview.effectiveDepth, dropPreview.parentText)}</span>
          </div>
        ) : null}

        {shouldShowRichMediaPreview ? <BlockRichMediaPreview content={block.content} ui={ui} /> : null}
      </div>
    </div>
  )
})
