import type { AppMessageHandler } from '../notify'
import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { canBlockHaveParent, isListBlockType, isContainerBlockType } from '@shared/blockTypes'
import { normalizeBlockDepth } from '../utils/draftBlockShape'

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
  getMultiBlockInteractionGuard: (range: BlockSelectionRange) => string | null
  moveDraftSubtree: (sourceIndex: number, targetIndex: number, targetDepth: number | null, focusIndexOverride?: number | null) => void
  moveSelectedBlocksTo: (targetIndex: number, targetDepth: number | null) => void
  selectedBlockRange: BlockSelectionRange | null
  notify: AppMessageHandler
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
  getMultiBlockInteractionGuard,
  moveDraftSubtree,
  moveSelectedBlocksTo,
  selectedBlockRange,
  notify,
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
        notify(interactionIssue, 'warning')
        return
      }
    }

    setDraggingBlockIndex(index)
    setDragOverBlockIndex(index)
    setDragOverBlockDepth(draftBlocks[index]?.depth ?? null)
  }, [draftBlocks, getMultiBlockInteractionGuard, selectedBlockRange, notify, setDragOverBlockDepth, setDragOverBlockIndex, setDraggingBlockIndex])

  const getDraggedBlockDepthPreview = useCallback((targetIndex: number, clientX: number, element: HTMLDivElement) => {
    if (draggingBlockIndex === null) {
      return null
    }

    const draggingBlock = draftBlocks[draggingBlockIndex]
    if (!draggingBlock || !canBlockHaveParent(draggingBlock.type)) {
      return null
    }

    const targetBlock = draftBlocks[targetIndex]
    // Mixed children can nest in native containers; ordinary non-list roots still reorder at depth zero.
    if (!isListBlockType(draggingBlock.type) && !isContainerBlockType(targetBlock?.type ?? '') && !targetBlock?.parentBlockId) return 0
    const anchorDepth = targetBlock && canBlockHaveParent(targetBlock.type) ? targetBlock.depth : 0
    const contentColumnStart = element.getBoundingClientRect().left + 48 + 160 + 20
    const horizontalDelta = clientX - contentColumnStart
    const depthDelta = horizontalDelta > blockDragDepthThreshold ? 1 : horizontalDelta < -blockDragDepthThreshold ? -1 : 0

    return normalizeBlockDepth(draggingBlock.type, anchorDepth + depthDelta)
  }, [blockDragDepthThreshold, draftBlocks, draggingBlockIndex, normalizeBlockDepth])

  const dropBlockAt = useCallback((targetIndex: number, targetDepth = dragOverBlockDepth) => {
    if (draggingBlockIndex === null) {
      endBlockDrag()
      return
    }
    const sourceBlock = draftBlocks[draggingBlockIndex]
    if (!sourceBlock) {
      endBlockDrag()
      return
    }

    const isMultiBlockDrag = selectedBlockRange && draggingBlockIndex >= selectedBlockRange.start && draggingBlockIndex <= selectedBlockRange.end && selectedBlockRange.start !== selectedBlockRange.end

    if (isMultiBlockDrag) {
      moveSelectedBlocksTo(targetIndex, targetDepth)
    } else {
      moveDraftSubtree(draggingBlockIndex, targetIndex, targetDepth)
    }

    endBlockDrag()
  }, [
    dragOverBlockDepth,
    draggingBlockIndex,
    draftBlocks,
    endBlockDrag,
    moveDraftSubtree,
    moveSelectedBlocksTo,
    selectedBlockRange
  ])

  return {
    beginBlockDrag,
    dropBlockAt,
    getDraggedBlockDepthPreview
  }
}
