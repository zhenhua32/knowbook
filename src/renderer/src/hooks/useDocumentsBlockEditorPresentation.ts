import { useMemo, useRef } from 'react'
import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { getActiveUiText } from '../i18n'
import { isNestableBlock } from '../utils/draftBlockShape'
import { getBlockDropPreview } from '../utils/draftTreePlacement'
import { BlockEditorRow } from '../components/BlockEditorRow'
import { BlockSelectionToolbar } from '../components/BlockSelectionToolbar'
import { DocumentOutlinePanel } from '../components/DocumentOutlinePanel'
import { FloatingSlashCommandPanel } from '../components/FloatingSlashCommandPanel'
import { LinkSuggestionPanel } from '../components/LinkSuggestionPanel'

type VisibleEditorRow = Pick<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'hasChildren' | 'indentPx' | 'index' | 'isHighlighted' | 'isSelected' | 'numberLabel'>
type SharedBlockEditorRowProps = Omit<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'hasChildren' | 'indentPx' | 'index' | 'isHighlighted' | 'isSelected' | 'numberLabel'>
type SharedBlockEditorRowBaseProps = Omit<SharedBlockEditorRowProps, 'draftBlockCount' | 'getDraftBlocks' | 'isHighlighted' | 'selectedDocument' | 'setSelectedSlashCommandIndex'> & {
  setSelectedSlashCommandIndex: Dispatch<SetStateAction<number>>
}
type OutlinePanelProps = ComponentProps<typeof DocumentOutlinePanel>
type SelectionToolbarProps = ComponentProps<typeof BlockSelectionToolbar>
type LinkSuggestionPanelProps = ComponentProps<typeof LinkSuggestionPanel>
type FloatingSlashCommandPanelProps = ComponentProps<typeof FloatingSlashCommandPanel>

type UseDocumentsBlockEditorPresentationParams = SharedBlockEditorRowBaseProps & {
  activeLinkContext: { query: string } | null
  blockSearchQuery: string
  blockSuggestions: DocumentBlockDraft[]
  canMoveSelectionDown: boolean
  canMoveSelectionUp: boolean
  clearBlockSelection: () => void
  convertSelectedBlocks: (type: DocumentBlock['type']) => void
  copySelectedBlocks: () => void
  copySelectedBlocksAsPlainText: () => void
  cutSelectedBlocks: () => void
  onOpenSelectionAiEditor: () => void
  dragOverBlockDepth: number | null
  dragOverBlockIndex: number | null
  draggingBlockIndex: number | null
  draftBlocks: DocumentBlockDraft[]
  getDraftBlocks: () => DocumentBlockDraft[]
  getVisibleBlockEntries: (blocks: DocumentBlockDraft[]) => Array<{ block: DocumentBlockDraft; index: number }>
  highlightedBlockId: string | null
  insertBlockSuggestion: LinkSuggestionPanelProps['onSelectBlockSuggestion']
  insertLinkSuggestion: LinkSuggestionPanelProps['onSelectLinkSuggestion']
  isBlockSelected: (index: number) => boolean
  linkSuggestions: LinkSuggestionPanelProps['linkSuggestions']
  onSelectOutlineBlock: (blockIndex: number) => void
  selectedDocument: SharedBlockEditorRowProps['selectedDocument'] | null
  selectedBlockActionCount: number
  selectedBlockConversionType: DocumentBlock['type']
  selectedBlockHasHiddenCollapsedContent: boolean
  selectedBlockInteractionIssue: string | null
  selectedVisibleBlockCount: number
  selectedVisibleSiblingSlice: unknown
  setSelectedBlockConversionType: (type: DocumentBlock['type']) => void
  slashPanelPos: { x: number; y: number } | null
}

export function useDocumentsBlockEditorPresentation({
  activeBlockIndex,
  activeLinkContext,
  activeSlashCommand,
  activeSlashContext,
  adjustBlockDepth,
  adjustSelectedBlocksDepth,
  applySlashCommand,
  beginBlockDrag,
  blockSearchQuery,
  blockSuggestions,
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
  onOpenSelectionAiEditor,
  deleteSelectedBlocks,
  dismissSlashCommand,
  draftBlocks,
  getDraftBlocks,
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
  getDraggedBlockDepthPreview,
  getMultiBlockOperationRange,
  getVisibleBlockCountInRange,
  getVisibleBlockEntries,
  handleBlockContentChange,
  highlightedBlockId,
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
  onSelectOutlineBlock,
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
}: UseDocumentsBlockEditorPresentationParams) {
  const visibleEditorRows = useMemo<VisibleEditorRow[]>(() => {
    if (!selectedDocument) {
      return []
    }

    const childParentIds = new Set(
      draftBlocks
        .map((block) => block.parentBlockId?.trim())
        .filter((parentBlockId): parentBlockId is string => Boolean(parentBlockId))
    )
    const numberedCountsByDepth = new Map<number, number>()

    return getVisibleBlockEntries(draftBlocks).map(({ block, index }) => {
      const dropPreview =
        draggingBlockIndex !== null && dragOverBlockIndex === index
          ? getBlockDropPreview(draftBlocks, draggingBlockIndex, index, dragOverBlockDepth)
          : null
      const isSelected = isBlockSelected(index)
      const isHighlighted = Boolean(block.id) && block.id === highlightedBlockId
      const indentPx = isNestableBlock(block.type) ? block.depth * BLOCK_INDENT_SIZE : 0

      let numberLabel = ''
      if (block.type === 'numbered-list') {
        for (const depth of numberedCountsByDepth.keys()) {
          if (depth > block.depth) {
            numberedCountsByDepth.delete(depth)
          }
        }
        const count = (numberedCountsByDepth.get(block.depth) ?? 0) + 1
        numberedCountsByDepth.set(block.depth, count)
        numberLabel = `${count}.`
      } else {
        numberedCountsByDepth.clear()
      }

      return {
        block,
        dropPreview,
        hasChildren: Boolean(block.id && childParentIds.has(block.id)),
        indentPx,
        index,
        isSelected,
        isHighlighted,
        isSearchMatch: blockSearchQuery.trim().length > 0 && (
          block.content.toLowerCase().includes(blockSearchQuery.toLowerCase()) ||
          block.type.toLowerCase().includes(blockSearchQuery.toLowerCase())
        ),
        numberLabel
      }
    })
  }, [
    BLOCK_INDENT_SIZE,
    dragOverBlockDepth,
    dragOverBlockIndex,
    draggingBlockIndex,
    draftBlocks,
    getBlockDropPreview,
    getVisibleBlockEntries,
    blockSearchQuery,
    isBlockSelected,
    isNestableBlock,
    selectedDocument
  ])

  const outlineItems = useMemo<OutlinePanelProps['items']>(() => {
    return draftBlocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.type === 'heading-1' || block.type === 'heading-2')
      .map(({ block, index }) => ({
        index,
        level: block.type === 'heading-1' ? 1 as const : 2 as const,
        title: block.content
      }))
  }, [draftBlocks])

  const outlinePanelProps: OutlinePanelProps | null = selectedDocument
    ? {
        emptyHeadingTitleLevel1: isZh ? '标题 1' : 'Heading 1',
        emptyHeadingTitleLevel2: isZh ? '标题 2' : 'Heading 2',
        items: outlineItems,
        onSelect: onSelectOutlineBlock,
        title: isZh ? '大纲' : 'Outline'
      }
    : null

  const selectionToolbarProps: SelectionToolbarProps | null = selectedBlockRange
    ? {
        canMoveDown: canMoveSelectionDown,
        canMoveUp: canMoveSelectionUp,
        clearLabel: ui.clear,
         conversionOptions: {
           paragraph: getBlockConversionLabel('paragraph'),
           todo: getBlockConversionLabel('todo'),
           quote: getBlockConversionLabel('quote'),
           'bulleted-list': getBlockConversionLabel('bulleted-list'),
           'numbered-list': getBlockConversionLabel('numbered-list'),
           table: getBlockConversionLabel('table')
         },
        convertLabel: ui.convert,
        copyBlocksLabel: ui.copyBlocks,
        copyTextLabel: ui.copyText,
        cutLabel: ui.cut,
        deleteLabel: ui.common.delete,
        duplicateLabel: ui.duplicate,
        aiEditLabel: ui.aiEditSelection,
        hasCrossParent: selectedBlockCount > 1 && !selectedBlockInteractionIssue && !selectedVisibleSiblingSlice,
        hasHiddenCollapsedContent: selectedBlockHasHiddenCollapsedContent,
        hintLabel: ui.blockSelectionHint({
          start: selectedBlockRange.start,
          end: selectedBlockRange.end,
          actionCount: selectedBlockActionCount,
          selectedCount: selectedBlockCount,
          incoherent: !isSelectionCoherent(selectedBlockRange),
          hasHiddenCollapsedContent: selectedBlockHasHiddenCollapsedContent,
          selectedBlockInteractionIssue: selectedBlockCount > 1 ? selectedBlockInteractionIssue : null
        }),
        interactionIssue: selectedBlockInteractionIssue,
        isIncoherent: !isSelectionCoherent(selectedBlockRange),
        moveDownLabel: ui.moveDown,
        moveUpLabel: ui.moveUp,
        onClear: clearBlockSelection,
        onConvert: () => convertSelectedBlocks(selectedBlockConversionType),
        onConversionTypeChange: setSelectedBlockConversionType,
        onCopyBlocks: copySelectedBlocks,
        onCopyText: copySelectedBlocksAsPlainText,
        onCut: cutSelectedBlocks,
        onDelete: deleteSelectedBlocks,
        onDuplicate: duplicateSelectedBlocks,
        onOpenAiEdit: onOpenSelectionAiEditor,
        onMoveDown: () => moveSelectedBlocks(1),
        onMoveUp: () => moveSelectedBlocks(-1),
        rangeEnd: selectedBlockRange.end,
        rangeStart: selectedBlockRange.start,
        selectedBlockActionCount,
        selectedBlockConversionType,
        selectedBlockCount,
        selectedVisibleBlockCount,
        summaryLabel: ui.blockSelectionSummary({
          visibleCount: selectedVisibleBlockCount,
          selectedCount: selectedBlockCount,
          actionCount: selectedBlockActionCount,
          incoherent: !isSelectionCoherent(selectedBlockRange),
          hasHiddenCollapsedContent: selectedBlockHasHiddenCollapsedContent,
          selectedBlockInteractionIssue,
          hasCrossParent: selectedBlockCount > 1 && !selectedBlockInteractionIssue && !selectedVisibleSiblingSlice
        })
      }
    : null

  const linkSuggestionPanelProps: LinkSuggestionPanelProps | null = activeLinkContext
    ? {
        blockSuggestions,
        blocksLabel: ui.blocksInDocument,
        linkedDocsLabel: ui.linkedDocuments,
        linkSuggestions,
        noMatchingLabel: ui.noMatchingSuggestions,
        onSelectBlockSuggestion: insertBlockSuggestion,
        onSelectLinkSuggestion: insertLinkSuggestion,
        query: activeLinkContext.query,
        queryLabel: ui.linkQuery
      }
    : null

  const floatingSlashCommandPanelProps: FloatingSlashCommandPanelProps | null = activeSlashContext && slashPanelPos
    ? {
        activeCommandId: activeSlashCommand?.id,
        commands: filteredSlashCommands.map((command) => ({
          id: command.id,
          label: command.label,
          description: command.description
        })),
        noMatchingLabel: ui.noMatchingCommands,
        onHoverCommand: setSelectedSlashCommandIndex,
        onSelectCommand: (command) => {
          const fullCommand = filteredSlashCommands.find((candidate) => candidate.id === command.id)
          if (fullCommand) {
            applySlashCommand(fullCommand)
          }
        },
        query: activeSlashContext.query,
        x: slashPanelPos.x,
        y: slashPanelPos.y
      }
    : null

  const rowActions = useStableCallbackProps({
    adjustBlockDepth,
    adjustSelectedBlocksDepth,
    applySlashCommand,
    beginBlockDrag,
    canMoveSelectedRange,
    captureBlockCursor,
    continueBlockAt,
    deleteSelectedBlocks,
    dismissSlashCommand,
    downgradeBlockAt,
    dropBlockAt,
    duplicateDraftBlock,
    duplicateSelectedBlocks,
    endBlockDrag,
    endBlockRangeSelection,
    getDraggedBlockDepthPreview,
    getMultiBlockOperationRange,
    getVisibleBlockCountInRange,
    handleBlockContentChange,
    handleBlockMouseEnter,
    handleBlockPaste,
    insertDraftBlockAt,
    isSelectionCoherent,
    mergeWithPreviousBlock,
    moveDraftBlockBySibling,
    moveSelectedBlocks,
    navigateInlineReferenceAtCursor,
    notifyBlockMouseDown,
    onOpenSelectionAiEditor,
    removeSelectedBlockRange,
    selectAllBlocks,
    selectBlockRange,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setSelectedSlashCommandIndex,
    splitDraftBlock,
    toggleBlockCollapse,
    updateBlockHighlight,
    updateDraftBlock
  })

  const blockEditorRowSharedProps: SharedBlockEditorRowProps | null = selectedDocument
    ? {
        ...rowActions,
        activeBlockIndex,
        activeSlashCommand,
        activeSlashContext,
        blockTextareaRefs,
        BLOCK_INDENT_SIZE,
        collapsedBlockIds,
        draftBlockCount: draftBlocks.length,
        filteredSlashCommands,
        getDraftBlocks,
        isBlockRangeSelecting,
        isZh,
        selectedBlockCount,
        selectedBlockRange,
        selectedDocument,
        ui
      }
    : null

  return {
    blockEditorRowSharedProps,
    floatingSlashCommandPanelProps,
    linkSuggestionPanelProps,
    outlinePanelProps,
    selectionToolbarProps,
    visibleEditorRows
  }
}

function useStableCallbackProps<T extends Record<string, (...args: any[]) => any>>(callbacks: T): T {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  return useMemo(() => Object.fromEntries(
    Object.keys(callbacks).map((key) => [
      key,
      (...args: any[]) => callbacksRef.current[key](...args)
    ])
  ) as T, [])
}

function getBlockConversionLabel(type: DocumentBlock['type']): string {
  return getActiveUiText().conversionOptions[type] ?? type
}
