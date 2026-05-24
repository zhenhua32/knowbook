import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'

type BlockSelectionRange = {
  start: number
  end: number
}

type UseBlockDragDropActionsParams = {
  blockDragDepthThreshold: number
  draftBlocks: DocumentBlockDraft[]
  dragOverBlockDepth: number | null
  draggingBlockIndex: number | null
  endBlockDrag: () => void
  getBlockSubtreeEndIndex: (blocks: DocumentBlockDraft[], index: number) => number
  getMultiBlockInteractionGuard: (range: BlockSelectionRange) => string | null
  getMultiBlockOperationRange: (range: BlockSelectionRange) => BlockSelectionRange
  isNestableBlock: (type: DocumentBlock['type']) => boolean
  moveDraftSubtree: (sourceIndex: number, targetIndex: number, targetDepth: number | null, focusIndexOverride?: number | null) => void
  normalizeBlockDepth: (type: DocumentBlock['type'], depth: number) => number
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  selectedBlockRange: BlockSelectionRange | null
  setBackupMessage: Dispatch<SetStateAction<string | null>>
  setDragOverBlockDepth: Dispatch<SetStateAction<number | null>>
  setDragOverBlockIndex: Dispatch<SetStateAction<number | null>>
  setDraggingBlockIndex: Dispatch<SetStateAction<number | null>>
}

export function useBlockDragDropActions({
  blockDragDepthThreshold,
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
}: UseBlockDragDropActionsParams) {
  const beginBlockDrag = useCallback((index: number) => {
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
  }, [draftBlocks, getMultiBlockInteractionGuard, selectedBlockRange, setBackupMessage, setDragOverBlockDepth, setDragOverBlockIndex, setDraggingBlockIndex])

  const getDraggedBlockDepthPreview = useCallback((targetIndex: number, clientX: number, element: HTMLDivElement) => {
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
    const depthDelta = horizontalDelta > blockDragDepthThreshold ? 1 : horizontalDelta < -blockDragDepthThreshold ? -1 : 0

    return normalizeBlockDepth(draggingBlock.type, anchorDepth + depthDelta)
  }, [blockDragDepthThreshold, draftBlocks, draggingBlockIndex, isNestableBlock, normalizeBlockDepth])

  const dropBlockAt = useCallback((targetIndex: number, targetDepth = dragOverBlockDepth) => {
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

      for (let index = dragSourceRange.start; index <= dragSourceRange.end; index += 1) {
        const block = draftBlocks[index]
        if (!block || !isNestableBlock(block.type)) {
          continue
        }

        const nextBlockDepth = normalizeBlockDepth(block.type, block.depth + appliedDelta)

        if (index !== dragSourceRange.start && targetIndex > dragSourceRange.end) {
          const precedingIndex = targetIndex - dragSubtreeSize + (index - dragSourceRange.start)
          if (precedingIndex >= 0) {
            const precedingBlock = draftBlocks[precedingIndex]
            if (precedingBlock && precedingBlock.depth < nextBlockDepth - 1) {
              console.warn(`Cannot drop multi-block range: block at index ${index} would lack sufficient preceding block depth at target location.`)
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
  }, [
    dragOverBlockDepth,
    draggingBlockIndex,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    isNestableBlock,
    moveDraftSubtree,
    normalizeBlockDepth,
    pushToHistory,
    selectedBlockRange,
    setBackupMessage
  ])

  return {
    beginBlockDrag,
    dropBlockAt,
    getDraggedBlockDepthPreview
  }
}