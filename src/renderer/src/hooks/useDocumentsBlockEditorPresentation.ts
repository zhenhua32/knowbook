import { useMemo } from 'react'
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

type VisibleEditorRow = Pick<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'indentPx' | 'index' | 'isSelected' | 'numberLabel'>
type SharedBlockEditorRowProps = Omit<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'indentPx' | 'index' | 'isSelected' | 'numberLabel'>
type SharedBlockEditorRowBaseProps = Omit<SharedBlockEditorRowProps, 'isHighlighted' | 'selectedDocument' | 'setSelectedSlashCommandIndex'> & {
  setSelectedSlashCommandIndex: Dispatch<SetStateAction<number>>
}
type OutlinePanelProps = ComponentProps<typeof DocumentOutlinePanel>
type SelectionToolbarProps = ComponentProps<typeof BlockSelectionToolbar>
type LinkSuggestionPanelProps = ComponentProps<typeof LinkSuggestionPanel>
type FloatingSlashCommandPanelProps = ComponentProps<typeof FloatingSlashCommandPanel>

type UseDocumentsBlockEditorPresentationParams = SharedBlockEditorRowBaseProps & {
  activeLinkContext: { query: string } | null
  blockSuggestions: DocumentBlockDraft[]
  canMoveSelectionDown: boolean
  canMoveSelectionUp: boolean
  clearBlockSelection: () => void
  convertSelectedBlocks: (type: DocumentBlock['type']) => void
  copySelectedBlocks: () => void
  copySelectedBlocksAsPlainText: () => void
  cutSelectedBlocks: () => void
  dragOverBlockDepth: number | null
  dragOverBlockIndex: number | null
  draggingBlockIndex: number | null
  getVisibleBlocks: (blocks: DocumentBlockDraft[]) => DocumentBlockDraft[]
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
  getDraggedBlockDepthPreview,
  getMultiBlockOperationRange,
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

    return getVisibleBlocks(draftBlocks).map((block) => {
      const index = draftBlocks.indexOf(block)
      const dropPreview =
        draggingBlockIndex !== null && dragOverBlockIndex === index
          ? getBlockDropPreview(draftBlocks, draggingBlockIndex, index, dragOverBlockDepth)
          : null
      const isSelected = isBlockSelected(index)
      const indentPx = isNestableBlock(block.type) ? block.depth * BLOCK_INDENT_SIZE : 0

      let numberLabel = ''
      if (block.type === 'numbered-list') {
        let count = 0
        for (let currentIndex = index; currentIndex >= 0; currentIndex -= 1) {
          const candidateBlock = draftBlocks[currentIndex]
          if (candidateBlock.type !== 'numbered-list' || candidateBlock.depth < block.depth) {
            break
          }
          if (candidateBlock.depth === block.depth) {
            count += 1
          }
        }
        numberLabel = `${count}.`
      }

      return {
        block,
        dropPreview,
        indentPx,
        index,
        isSelected,
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
    getVisibleBlocks,
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
          'numbered-list': getBlockConversionLabel('numbered-list')
        },
        convertLabel: ui.convert,
        copyBlocksLabel: ui.copyBlocks,
        copyTextLabel: ui.copyText,
        cutLabel: ui.cut,
        deleteLabel: ui.common.delete,
        duplicateLabel: ui.duplicate,
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

  const blockEditorRowSharedProps: SharedBlockEditorRowProps | null = selectedDocument
    ? {
        activeBlockIndex,
        activeSlashCommand,
        activeSlashContext,
        adjustBlockDepth,
        adjustSelectedBlocksDepth,
        applySlashCommand,
        beginBlockDrag,
        blockHasChildren,
        blockTextareaRefs,
        BLOCK_INDENT_SIZE,
        canMoveSelectedRange,
        captureBlockCursor,
        collapsedBlockIds,
        continueBlockAt,
        deleteSelectedBlocks,
        dismissSlashCommand,
        draftBlocks,
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
        handleBlockContentChange,
        handleBlockMouseEnter,
        handleBlockPaste,
        insertDraftBlockAt,
        isBlockRangeSelecting,
        isHighlighted: false,
        isSelectionCoherent,
        isZh,
        mergeWithPreviousBlock,
        moveDraftBlockBySibling,
        moveSelectedBlocks,
        navigateInlineReferenceAtCursor,
        notifyBlockMouseDown,
        removeSelectedBlockRange,
        selectAllBlocks,
        selectBlockRange,
        selectedBlockCount,
        selectedBlockRange,
        selectedDocument,
        setDragOverBlockDepth,
        setDragOverBlockIndex,
        setSelectedSlashCommandIndex,
        splitDraftBlock,
        toggleBlockCollapse,
        ui,
        updateBlockHighlight,
        updateDraftBlock
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

function getBlockConversionLabel(type: DocumentBlock['type']): string {
  return getActiveUiText().conversionOptions[type] ?? type
}