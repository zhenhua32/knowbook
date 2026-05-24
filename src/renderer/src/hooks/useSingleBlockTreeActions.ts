import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'

type UseSingleBlockTreeActionsParams = {
  activeCursorPosition: number
  buildBlockTypePatch: (
    type: DocumentBlock['type'],
    content: string,
    checked?: boolean,
    depth?: number,
    parentBlockId?: string | null
  ) => DocumentBlockDraft
  clearBlockSelection: () => void
  draftBlocks: DocumentBlockDraft[]
  endBlockDrag: () => void
  getBlockSubtreeEndIndex: (blocks: DocumentBlockDraft[], index: number) => number
  getFragmentLocalRootIds: (blocks: DocumentBlockDraft[]) => Set<string>
  getNextSiblingSubtreeStartIndex: (blocks: DocumentBlockDraft[], index: number) => number | null
  getNormalizedBlockId: (block: DocumentBlockDraft | undefined) => string | null
  getPreviousSiblingSubtreeStartIndex: (blocks: DocumentBlockDraft[], index: number) => number | null
  isNestableBlock: (type: DocumentBlock['type']) => boolean
  normalizeBlockDepth: (type: DocumentBlock['type'], depth: number) => number
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  remapIndexAfterSubtreeMove: (
    candidateIndex: number | null,
    sourceStart: number,
    sourceEnd: number,
    insertionIndex: number
  ) => number | null
  resolveDraftInsertionPlacement: (
    blocks: DocumentBlockDraft[],
    insertionIndex: number,
    rootType: DocumentBlock['type'],
    requestedDepth: number
  ) => { depth: number; parentBlockId: string | null }
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: Dispatch<SetStateAction<number | null>>
  shiftDraftFragmentDepth: (
    blocks: DocumentBlockDraft[],
    depthDelta: number,
    rootParentBlockId: string | null,
    rootIds: Set<string>
  ) => DocumentBlockDraft[]
  splitDraftBlock: (index: number, selectionStart: number, selectionEnd?: number, nextTypeOverride?: DocumentBlock['type']) => void
  updateDraftBlock: (index: number, patch: Partial<DocumentBlockDraft>) => void
}

export function useSingleBlockTreeActions({
  activeCursorPosition,
  buildBlockTypePatch,
  clearBlockSelection,
  draftBlocks,
  endBlockDrag,
  getBlockSubtreeEndIndex,
  getFragmentLocalRootIds,
  getNextSiblingSubtreeStartIndex,
  getNormalizedBlockId,
  getPreviousSiblingSubtreeStartIndex,
  isNestableBlock,
  normalizeBlockDepth,
  pushToHistory,
  remapIndexAfterSubtreeMove,
  resolveDraftInsertionPlacement,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  shiftDraftFragmentDepth,
  splitDraftBlock,
  updateDraftBlock
}: UseSingleBlockTreeActionsParams) {
  const adjustBlockDepth = useCallback((index: number, delta: number, cursorPosition = activeCursorPosition) => {
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
  }, [
    activeCursorPosition,
    draftBlocks,
    getBlockSubtreeEndIndex,
    getNormalizedBlockId,
    isNestableBlock,
    normalizeBlockDepth,
    resolveDraftInsertionPlacement,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    shiftDraftFragmentDepth
  ])

  const continueBlockAt = useCallback((index: number, selectionStart: number, selectionEnd = selectionStart) => {
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
  }, [adjustBlockDepth, buildBlockTypePatch, draftBlocks, isNestableBlock, setActiveBlockIndex, setActiveCursorPosition, setPendingFocusBlockIndex, splitDraftBlock, updateDraftBlock])

  const downgradeBlockAt = useCallback((index: number) => {
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
  }, [adjustBlockDepth, buildBlockTypePatch, draftBlocks, isNestableBlock, setActiveBlockIndex, setActiveCursorPosition, setPendingFocusBlockIndex, updateDraftBlock])

  const mergeWithPreviousBlock = useCallback((index: number) => {
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
  }, [clearBlockSelection, draftBlocks, endBlockDrag, getBlockSubtreeEndIndex, pushToHistory, setActiveBlockIndex, setActiveCursorPosition, setDraftBlocks, setPendingFocusBlockIndex])

  const moveDraftSubtree = useCallback((sourceIndex: number, targetIndex: number, targetDepth: number | null, focusIndexOverride?: number | null) => {
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
  }, [clearBlockSelection, draftBlocks, getBlockSubtreeEndIndex, getFragmentLocalRootIds, pushToHistory, remapIndexAfterSubtreeMove, resolveDraftInsertionPlacement, setActiveBlockIndex, setDraftBlocks, setPendingFocusBlockIndex, shiftDraftFragmentDepth])

  const moveDraftBlockBySibling = useCallback((index: number, direction: -1 | 1, cursorPosition = activeCursorPosition, contentOverride?: string) => {
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
  }, [activeCursorPosition, draftBlocks, getBlockSubtreeEndIndex, getNextSiblingSubtreeStartIndex, getPreviousSiblingSubtreeStartIndex, moveDraftSubtree, setActiveBlockIndex, setActiveCursorPosition, setPendingFocusBlockIndex, updateDraftBlock])

  return {
    adjustBlockDepth,
    continueBlockAt,
    downgradeBlockAt,
    mergeWithPreviousBlock,
    moveDraftBlockBySibling,
    moveDraftSubtree
  }
}