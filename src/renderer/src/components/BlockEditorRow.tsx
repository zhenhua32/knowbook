import { useState } from 'react'
import { detectCodeLanguage } from '@shared/code'
import type { DocumentBlockDraft, DocumentBlock } from '@shared/contracts'
import { BlockEditToolbar } from './BlockEditToolbar'
import { BlockContextMenu } from './BlockContextMenu'
import { CodeBlockLanguageSelector } from './CodeBlockLanguageSelector'

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
  insertDraftBlockAt: (index: number, anchorIndex: number) => void
  removeBlockTag: (index: number, tag: string) => void

  // Callbacks: block interactions
  handleBlockContentChange: (index: number, content: string) => void
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
  beginBlockRangeSelection: (index: number) => void
  extendBlockRangeSelection: (index: number) => void
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
  serializeDraftBlockRange: (blocks: DocumentBlockDraft[], range: { start: number; end: number }) => string
  removeSelectedBlockRange: (range: { start: number; end: number }) => void

  // Callbacks: selection/interaction guards
  getPreviousSiblingSubtreeStartIndex: (blocks: DocumentBlockDraft[], index: number) => number | null
  getNextSiblingSubtreeStartIndex: (blocks: DocumentBlockDraft[], index: number) => number | null
  canMoveSelectedRange: (range: { start: number; end: number }, delta: -1 | 1) => boolean

  // Constants & UI
  BLOCK_INDENT_SIZE: number
  ui: any
  isZh: boolean
}

export function BlockEditorRow(props: BlockEditorRowProps) {
  const {
    block,
    index,
    draftBlocks,
    selectedDocument,
    isSelected,
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
    insertDraftBlockAt,
    removeBlockTag,
    handleBlockContentChange,
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
    beginBlockRangeSelection,
    extendBlockRangeSelection,
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
    serializeDraftBlockRange,
    removeSelectedBlockRange,
    getPreviousSiblingSubtreeStartIndex,
    getNextSiblingSubtreeStartIndex,
    canMoveSelectedRange,
    BLOCK_INDENT_SIZE,
    ui,
    isZh
  } = props

  const isNestableBlock = (type: string) => ['todo', 'bulleted-list', 'numbered-list'].includes(type)
  const effectiveCodeLanguage = block.type === 'code' ? detectCodeLanguage(block.content, block.language) : null

  // 状态管理
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const [editingLanguage, setEditingLanguage] = useState(false)

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

  return (
    <div
      className={`block-editor-row${dropPreview ? ' block-editor-row-drag-over' : ''}${isSelected ? ' block-editor-row-selected' : ''}`}
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
        // Do not hijack native interactions inside editor controls.
        if (target.closest('textarea,button,input,select,option,a,[contenteditable="true"]')) {
          return
        }

        event.preventDefault()
        beginBlockRangeSelection(index)
      }}
      onMouseEnter={(event) => {
        if (!isBlockRangeSelecting) {
          return
        }

        if ((event.buttons & 1) !== 1) {
          endBlockRangeSelection()
          return
        }

        extendBlockRangeSelection(index)
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
      <BlockEditToolbar
        block={block}
        index={index}
        isActive={activeBlockIndex === index}
        onTypeChange={handleBlockTypeChange}
        onDuplicate={() => duplicateDraftBlock(index)}
        onDelete={() => {
          if (selectedBlockRange && isSelected) {
            deleteSelectedBlocks()
          } else {
            if (index > 0) {
              mergeWithPreviousBlock(index)
            } else {
              updateDraftBlock(index, { content: '', type: 'paragraph' })
            }
          }
        }}
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

      {/* ── Context Menu ── */}
      {showContextMenu && (
        <BlockContextMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          blockType={block.type}
          onTypeChange={handleBlockTypeChange}
          onDuplicate={() => duplicateDraftBlock(index)}
          onDelete={() => {
            if (index > 0) {
              mergeWithPreviousBlock(index)
            } else {
              updateDraftBlock(index, { content: '', type: 'paragraph' })
            }
          }}
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
                blockTextareaRefs.current[index] = element
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
              onClick={(event) => captureBlockCursor(index, event.currentTarget)}
              onFocus={(event) => captureBlockCursor(index, event.currentTarget)}
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


                // Tab: insert spaces to prevent focus jump
                if (event.key === 'Tab' && !event.altKey && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault()
                  const el = event.currentTarget
                  const start = el.selectionStart ?? 0
                  const end = el.selectionEnd ?? 0
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

        {/* Tags */}
        {block.tags && block.tags.length > 0 && (
          <div className="block-tags-display">
            {block.tags.map((tag) => (
              <span key={`tag-${tag}`} className="block-tag-badge">
                {tag}
                <button className="block-tag-remove" onClick={() => removeBlockTag(index, tag)} type="button" title={ui.removeTag}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Drop preview */}
        {dropPreview ? (
          <div className="block-drop-preview" style={{ marginInlineStart: `${dropPreview.effectiveDepth * BLOCK_INDENT_SIZE}px` }}>
            <span className="block-drop-preview-badge">{dropPreview.positionLabel}</span>
            <span className="block-drop-preview-meta">{ui.dropPreviewMeta(dropPreview.effectiveDepth, dropPreview.parentText)}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
