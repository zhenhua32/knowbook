import { useMemo } from 'react'
import type { ComponentProps } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { BlockEditorRow } from '../components/BlockEditorRow'
import { DocumentOutlinePanel } from '../components/DocumentOutlinePanel'

type VisibleEditorRow = Pick<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'indentPx' | 'index' | 'isSelected' | 'numberLabel'>
type SharedBlockEditorRowProps = Omit<ComponentProps<typeof BlockEditorRow>, 'block' | 'dropPreview' | 'indentPx' | 'index' | 'isSelected' | 'numberLabel'>
type SharedBlockEditorRowBaseProps = Omit<SharedBlockEditorRowProps, 'isHighlighted' | 'selectedDocument'>
type OutlinePanelProps = ComponentProps<typeof DocumentOutlinePanel>

type UseDocumentsBlockEditorPresentationParams = SharedBlockEditorRowBaseProps & {
  dragOverBlockDepth: number | null
  dragOverBlockIndex: number | null
  draggingBlockIndex: number | null
  getBlockDropPreview: (
    blocks: DocumentBlockDraft[],
    draggingIndex: number,
    targetIndex: number,
    targetDepth: number | null
  ) => ComponentProps<typeof BlockEditorRow>['dropPreview']
  getVisibleBlocks: (blocks: DocumentBlockDraft[]) => DocumentBlockDraft[]
  isBlockSelected: (index: number) => boolean
  isNestableBlock: (type: DocumentBlock['type']) => boolean
  onSelectOutlineBlock: (blockIndex: number) => void
  selectedDocument: SharedBlockEditorRowProps['selectedDocument'] | null
}

export function useDocumentsBlockEditorPresentation({
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
  isBlockRangeSelecting,
  isBlockSelected,
  isNestableBlock,
  isSelectionCoherent,
  isZh,
  mergeWithPreviousBlock,
  moveDraftBlockBySibling,
  moveSelectedBlocks,
  navigateInlineReferenceAtCursor,
  notifyBlockMouseDown,
  onSelectOutlineBlock,
  removeSelectedBlockRange,
  selectAllBlocks,
  selectBlockRange,
  selectedBlockCount,
  selectedBlockRange,
  selectedDocument,
  serializeDraftBlockRange,
  setDragOverBlockDepth,
  setDragOverBlockIndex,
  setSelectedSlashCommandIndex,
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
        getNextSiblingSubtreeStartIndex,
        getPreviousSiblingSubtreeStartIndex,
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
        serializeDraftBlockRange,
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
    outlinePanelProps,
    visibleEditorRows
  }
}