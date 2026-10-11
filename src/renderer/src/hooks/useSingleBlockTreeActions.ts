import { getHeadingLevel } from '@shared/markdownEngine'
import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { isNestableBlock } from '../utils/draftBlockShape'
import { planDraftBlockDepthChange, planDraftSubtreePlacement } from '../utils/draftTreeDepthChange'
import { shiftDraftFragmentDepth } from '../utils/draftTreeFragment'
import { promoteDraftBlockChildren } from '../utils/draftTreeTextEditing'
import {
  getBlockSubtreeEndIndex,
  getFragmentLocalRootIds,
  getNextSiblingSubtreeStartIndex,
  getPreviousSiblingSubtreeStartIndex,
  remapIndexAfterSubtreeMove
} from '../utils/draftTreeMove'

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
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: Dispatch<SetStateAction<number | null>>
  splitDraftBlock: (index: number, selectionStart: number, selectionEnd?: number, nextTypeOverride?: DocumentBlock['type']) => void
  updateDraftBlock: (index: number, patch: Partial<DocumentBlockDraft>) => void
}

export function useSingleBlockTreeActions({
  activeCursorPosition,
  buildBlockTypePatch,
  clearBlockSelection,
  draftBlocks,
  endBlockDrag,
  pushToHistory,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  splitDraftBlock,
  updateDraftBlock
}: UseSingleBlockTreeActionsParams) {
  const adjustBlockDepth = useCallback((index: number, delta: number, cursorPosition = activeCursorPosition) => {
    const currentBlock = draftBlocks[index]
    if (!currentBlock || !isNestableBlock(currentBlock.type)) {
      return
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)
    const range = { start: index, end: subtreeEndIndex }
    const plan = planDraftBlockDepthChange(draftBlocks, range, delta)
    if (!plan) return

    pushToHistory(draftBlocks)
    clearBlockSelection()
    setDraftBlocks((previous) => planDraftBlockDepthChange(previous, range, delta)?.blocks ?? previous)
    const focusIndex = remapIndexAfterSubtreeMove(index, index, subtreeEndIndex, plan.insertionIndex)
    setActiveBlockIndex(focusIndex)
    setActiveCursorPosition(cursorPosition)
    setPendingFocusBlockIndex(focusIndex)
    endBlockDrag()
  }, [
    activeCursorPosition,
    draftBlocks,
    clearBlockSelection,
    endBlockDrag,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  ])

  const continueBlockAt = useCallback((index: number, selectionStart: number, selectionEnd = selectionStart) => {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    const exitsToParagraph = ['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list']
    if (currentBlock.content.trim() === '' && exitsToParagraph.includes(currentBlock.type)) {
      if (isNestableBlock(currentBlock.type) && currentBlock.depth > 0) {
        adjustBlockDepth(index, -1, 0)
        return
      }

      pushToHistory(draftBlocks)
      setDraftBlocks((previous) => {
        const next = promoteDraftBlockChildren(previous, index)
        next[index] = { ...next[index], ...buildBlockTypePatch('paragraph', '', false) }
        return next
      })
      setActiveBlockIndex(index)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(index)
      return
    }

    if (['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list'].includes(currentBlock.type)) {
      const nextType = getHeadingLevel(currentBlock.type) ? 'paragraph' : currentBlock.type
      splitDraftBlock(index, selectionStart, selectionEnd, nextType)
    }
  }, [adjustBlockDepth, buildBlockTypePatch, draftBlocks, isNestableBlock, pushToHistory, setActiveBlockIndex, setActiveCursorPosition, setDraftBlocks, setPendingFocusBlockIndex, splitDraftBlock])

  const downgradeBlockAt = useCallback((index: number) => {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    if (!['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6', 'todo', 'numbered-todo', 'quote', 'bulleted-list', 'numbered-list'].includes(currentBlock.type)) {
      return
    }

    if (isNestableBlock(currentBlock.type) && currentBlock.depth > 0) {
      adjustBlockDepth(index, -1, 0)
      return
    }

    pushToHistory(draftBlocks)
    setDraftBlocks((previous) => {
      const next = promoteDraftBlockChildren(previous, index)
      next[index] = { ...next[index], ...buildBlockTypePatch('paragraph', currentBlock.content, false) }
      return next
    })
    setActiveBlockIndex(index)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(index)
  }, [adjustBlockDepth, buildBlockTypePatch, draftBlocks, isNestableBlock, pushToHistory, setActiveBlockIndex, setActiveCursorPosition, setDraftBlocks, setPendingFocusBlockIndex])

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

    const currentSubtreeEnd = getBlockSubtreeEndIndex(draftBlocks, index)

    const isMergeable =
      previousBlock.type === currentBlock.type &&
      previousBlock.depth === currentBlock.depth &&
      !['code', 'math', 'divider', 'frontmatter', 'html'].includes(currentBlock.type)

    if (!isMergeable) {
      return
    }

    pushToHistory(draftBlocks)

    const mergedContent = previousBlock.content + currentBlock.content
    const focusPosition = previousBlock.content.length

    clearBlockSelection()

    setDraftBlocks((previous) => {
      const next = isNestableBlock(previousBlock.type) ? [...previous] : promoteDraftBlockChildren(previous, index)
      next[index - 1] = {
        ...previousBlock,
        content: mergedContent
      }
      if (isNestableBlock(previousBlock.type) && currentSubtreeEnd > index) {
        const children = previous.slice(index + 1, currentSubtreeEnd + 1)
        next.splice(index + 1, children.length, ...shiftDraftFragmentDepth(children, 0, previousBlock.id ?? null, getFragmentLocalRootIds(children)))
      }
      next.splice(index, 1)
      return next
    })

    setActiveBlockIndex(index - 1)
    setActiveCursorPosition(focusPosition)
    setPendingFocusBlockIndex(index - 1)
    endBlockDrag()
  }, [clearBlockSelection, draftBlocks, endBlockDrag, getBlockSubtreeEndIndex, pushToHistory, setActiveBlockIndex, setActiveCursorPosition, setDraftBlocks, setPendingFocusBlockIndex])

  const moveDraftSubtree = useCallback((sourceIndex: number, targetIndex: number, targetDepth: number | null, focusIndexOverride?: number | null) => {
    const rootBlock = draftBlocks[sourceIndex]
    if (!rootBlock) return
    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, sourceIndex)
    if (targetIndex >= sourceIndex && targetIndex <= subtreeEndIndex) return
    const range = { start: sourceIndex, end: subtreeEndIndex }
    const subtreeSize = subtreeEndIndex - sourceIndex + 1
    const insertionIndex = sourceIndex < targetIndex ? Math.max(0, targetIndex - subtreeSize + 1) : targetIndex
    const requestedDepth = targetDepth ?? rootBlock.depth
    const plan = planDraftSubtreePlacement(draftBlocks, range, insertionIndex, requestedDepth)
    if (!plan) return
    pushToHistory(draftBlocks)
    clearBlockSelection()
    setDraftBlocks((previous) => planDraftSubtreePlacement(previous, range, insertionIndex, requestedDepth)?.blocks ?? previous)

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
  }, [clearBlockSelection, draftBlocks, pushToHistory, setActiveBlockIndex, setDraftBlocks, setPendingFocusBlockIndex])

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
