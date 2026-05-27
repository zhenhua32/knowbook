import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { getActiveUiText } from '../i18n'
import { serializeDraftBlockRange } from '../utils/draftClipboard'

type BlockSelectionRange = {
  start: number
  end: number
}

type VisibleBlockEntry = {
  block: DocumentBlockDraft
  index: number
}

type VisibleSelectionSlice = {
  visibleEntries: VisibleBlockEntry[]
  operationRange: BlockSelectionRange
}

type MultiBlockUiText = {
  convertedBlocks: (count: number, label: string) => string
  copiedBlocks: (count: number) => string
  copiedPlainText: (count: number) => string
  copyFailed: string
  copyTextFailed: string
  cutBlocks: (count: number) => string
  cutFailed: string
  deletedBlocks: (count: number) => string
  duplicatedBlocks: (count: number) => string
  invalidVisibleTreeSlice: string
}

type UseMultiBlockActionsParams = {
  activeBlockIndex: number | null
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
  getMultiBlockInteractionGuard: (range: BlockSelectionRange) => string | null
  getMultiBlockOperationRange: (range: BlockSelectionRange) => BlockSelectionRange
  getNextSiblingSubtreeStartIndex: (blocks: DocumentBlockDraft[], index: number) => number | null
  getNormalizedBlockId: (block: DocumentBlockDraft | undefined) => string | null
  getNormalizedParentBlockId: (block: DocumentBlockDraft | undefined) => string | null
  getPreviousSiblingSubtreeStartIndex: (blocks: DocumentBlockDraft[], index: number) => number | null
  getVisibleSiblingSelectionSlice: (range: BlockSelectionRange) => VisibleSelectionSlice | null
  isNestableBlock: (type: DocumentBlock['type']) => boolean
  materializeDraftFragment: (blocks: DocumentBlockDraft[], rootParentBlockId: string | null) => DocumentBlockDraft[]
  moveContiguousBlockRange: (blocks: DocumentBlockDraft[], range: BlockSelectionRange, targetIndex: number) => DocumentBlockDraft[]
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
  selectedBlockRange: BlockSelectionRange | null
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setBackupMessage: Dispatch<SetStateAction<string | null>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: Dispatch<SetStateAction<number | null>>
  setSelectedBlockRange: Dispatch<SetStateAction<BlockSelectionRange | null>>
  setSelectionAnchorBlockId: Dispatch<SetStateAction<string | null>>
  shiftDraftFragmentDepth: (
    blocks: DocumentBlockDraft[],
    depthDelta: number,
    rootParentBlockId: string | null,
    rootIds: Set<string>
  ) => DocumentBlockDraft[]
  ui: MultiBlockUiText
}

export function useMultiBlockActions({
  activeBlockIndex,
  activeCursorPosition,
  buildBlockTypePatch,
  clearBlockSelection,
  draftBlocks,
  endBlockDrag,
  getBlockSubtreeEndIndex,
  getFragmentLocalRootIds,
  getMultiBlockInteractionGuard,
  getMultiBlockOperationRange,
  getNextSiblingSubtreeStartIndex,
  getNormalizedBlockId,
  getNormalizedParentBlockId,
  getPreviousSiblingSubtreeStartIndex,
  getVisibleSiblingSelectionSlice,
  isNestableBlock,
  materializeDraftFragment,
  moveContiguousBlockRange,
  normalizeBlockDepth,
  pushToHistory,
  remapIndexAfterSubtreeMove,
  resolveDraftInsertionPlacement,
  selectedBlockRange,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setBackupMessage,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  setSelectedBlockRange,
  setSelectionAnchorBlockId,
  shiftDraftFragmentDepth,
  ui
}: UseMultiBlockActionsParams) {
  const getBlockTypeLabel = useCallback((type: DocumentBlock['type']) => {
    return getActiveUiText().blockTypeBadges[type] ?? getActiveUiText().blockTypeBadges.paragraph
  }, [])

  const serializeDraftBlockRangeAsPlainText = useCallback((blocks: DocumentBlockDraft[], range: BlockSelectionRange) => {
    return blocks
      .slice(range.start, range.end + 1)
      .map((block) => renderDraftBlockAsPlainText(block))
      .join('\n\n')
  }, [])

  const moveSelectedBlocks = useCallback((delta: -1 | 1) => {
    if (!selectedBlockRange) {
      return
    }

    const interactionIssue = getMultiBlockInteractionGuard(selectedBlockRange)
    if (interactionIssue) {
      setBackupMessage(interactionIssue)
      return
    }

    const visibleSiblingSlice = getVisibleSiblingSelectionSlice(selectedBlockRange)
    if (!visibleSiblingSlice) {
      setBackupMessage(ui.invalidVisibleTreeSlice)
      return
    }

    const firstVisibleEntry = visibleSiblingSlice.visibleEntries[0]
    const lastVisibleEntry = visibleSiblingSlice.visibleEntries[visibleSiblingSlice.visibleEntries.length - 1]
    if (!firstVisibleEntry || !lastVisibleEntry) {
      return
    }

    const siblingIndex =
      delta === -1
        ? getPreviousSiblingSubtreeStartIndex(draftBlocks, firstVisibleEntry.index)
        : getNextSiblingSubtreeStartIndex(draftBlocks, lastVisibleEntry.index)

    if (siblingIndex === null) {
      return
    }

    pushToHistory(draftBlocks)

    const operationRange = visibleSiblingSlice.operationRange
    const targetIndex = delta === -1 ? siblingIndex : getBlockSubtreeEndIndex(draftBlocks, siblingIndex)
    const nextBlocks = moveContiguousBlockRange(draftBlocks, operationRange, targetIndex)

    const movedCount = operationRange.end - operationRange.start + 1
    const insertionIndex = operationRange.start < targetIndex ? Math.max(0, targetIndex - movedCount + 1) : targetIndex
    const newStartIndex = remapIndexAfterSubtreeMove(operationRange.start, operationRange.start, operationRange.end, insertionIndex) ?? operationRange.start
    const newEndIndex = remapIndexAfterSubtreeMove(operationRange.end, operationRange.start, operationRange.end, insertionIndex) ?? operationRange.end
    const nextFocusIndex = remapIndexAfterSubtreeMove(
      activeBlockIndex ?? lastVisibleEntry.index,
      operationRange.start,
      operationRange.end,
      insertionIndex
    ) ?? newEndIndex

    setDraftBlocks(nextBlocks)
    setSelectedBlockRange({
      start: newStartIndex,
      end: newEndIndex
    })
    setSelectionAnchorBlockId(getNormalizedBlockId(nextBlocks[newStartIndex]) ?? null)
    setActiveBlockIndex(nextFocusIndex)
    setPendingFocusBlockIndex(nextFocusIndex)
    endBlockDrag()
  }, [
    activeBlockIndex,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getMultiBlockInteractionGuard,
    getNextSiblingSubtreeStartIndex,
    getNormalizedBlockId,
    getPreviousSiblingSubtreeStartIndex,
    getVisibleSiblingSelectionSlice,
    moveContiguousBlockRange,
    pushToHistory,
    remapIndexAfterSubtreeMove,
    selectedBlockRange,
    setActiveBlockIndex,
    setBackupMessage,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectionAnchorBlockId,
    ui.invalidVisibleTreeSlice
  ])

  const adjustSelectedBlocksDepth = useCallback((delta: -1 | 1, focusIndex: number, cursorPosition = activeCursorPosition) => {
    if (!selectedBlockRange) {
      return
    }

    const interactionIssue = getMultiBlockInteractionGuard(selectedBlockRange)
    if (interactionIssue) {
      setBackupMessage(interactionIssue)
      return
    }

    const operationRange = getMultiBlockOperationRange(selectedBlockRange)
    pushToHistory(draftBlocks)

    const selectedNestableBlocks = draftBlocks
      .slice(operationRange.start, operationRange.end + 1)
      .filter((block) => isNestableBlock(block.type))

    if (selectedNestableBlocks.length === 0) {
      return
    }

    const minDepth = Math.min(...selectedNestableBlocks.map((block) => block.depth))
    const appliedDelta =
      delta === 1
        ? Math.min(...selectedNestableBlocks.map((block) => normalizeBlockDepth(block.type, block.depth + 1) - block.depth))
        : Math.max(...selectedNestableBlocks.map((block) => normalizeBlockDepth(block.type, block.depth - 1) - block.depth))

    if (appliedDelta === 0) {
      return
    }

    if (appliedDelta > 0) {
      const precedingBlock = operationRange.start > 0 ? draftBlocks[operationRange.start - 1] : null
      if (!precedingBlock) {
        console.warn('Cannot indent: no preceding block found as parent.')
        return
      }

      const nextMinDepth = minDepth + appliedDelta
      if (precedingBlock.depth + 1 < nextMinDepth) {
        console.warn(`Cannot indent to depth ${nextMinDepth}: preceding block depth is ${precedingBlock.depth}. Max indent is ${precedingBlock.depth + 1}.`)
        return
      }

      for (let index = operationRange.start; index <= operationRange.end; index += 1) {
        const block = draftBlocks[index]
        if (!block || !isNestableBlock(block.type)) {
          continue
        }

        const nextBlockDepth = normalizeBlockDepth(block.type, block.depth + appliedDelta)

        if (index === selectedBlockRange.start) {
          continue
        }

        const previousBlock = draftBlocks[index - 1]
        if (previousBlock.depth < nextBlockDepth - 1) {
          console.warn(`Cannot indent multi-block range: block at index ${index} would have insufficient preceding block depth for its new depth ${nextBlockDepth}.`)
          return
        }
      }
    }

    setDraftBlocks((previous) => {
      const next = [...previous]
      const operationBlocks = next.slice(operationRange.start, operationRange.end + 1)
      const rootIds = getFragmentLocalRootIds(operationBlocks)
      const firstAdjustableRootOffset = operationBlocks.findIndex((block) => {
        const blockId = getNormalizedBlockId(block)
        return Boolean(blockId && rootIds.has(blockId) && isNestableBlock(block.type))
      })

      if (firstAdjustableRootOffset === -1) {
        return previous
      }

      const firstAdjustableRootIndex = operationRange.start + firstAdjustableRootOffset
      const firstAdjustableRoot = next[firstAdjustableRootIndex]
      if (!firstAdjustableRoot) {
        return previous
      }

      const placement = resolveDraftInsertionPlacement(
        next,
        firstAdjustableRootIndex,
        firstAdjustableRoot.type,
        firstAdjustableRoot.depth + appliedDelta
      )

      next.splice(
        operationRange.start,
        operationBlocks.length,
        ...shiftDraftFragmentDepth(operationBlocks, placement.depth - firstAdjustableRoot.depth, placement.parentBlockId, rootIds)
      )
      return next
    })
    setActiveBlockIndex(focusIndex)
    setActiveCursorPosition(cursorPosition)
    setPendingFocusBlockIndex(focusIndex)
    endBlockDrag()
  }, [
    activeCursorPosition,
    draftBlocks,
    endBlockDrag,
    getFragmentLocalRootIds,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    getNormalizedBlockId,
    isNestableBlock,
    normalizeBlockDepth,
    pushToHistory,
    resolveDraftInsertionPlacement,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setBackupMessage,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    shiftDraftFragmentDepth
  ])

  const convertSelectedBlocks = useCallback((nextType: DocumentBlock['type']) => {
    if (!selectedBlockRange) {
      return
    }

    const operationRange = getMultiBlockOperationRange(selectedBlockRange)
    const operationCount = operationRange.end - operationRange.start + 1
    pushToHistory(draftBlocks)

    const focusIndex =
      activeBlockIndex !== null && activeBlockIndex >= operationRange.start && activeBlockIndex <= operationRange.end
        ? activeBlockIndex
        : operationRange.start

    setDraftBlocks((previous) =>
      previous.map((block, currentIndex) => {
        if (currentIndex < operationRange.start || currentIndex > operationRange.end) {
          return block
        }

        return buildBlockTypePatch(nextType, block.content, nextType === 'todo' ? block.checked : false, block.depth, block.parentBlockId ?? null)
      })
    )
    setActiveBlockIndex(focusIndex)
    setPendingFocusBlockIndex(focusIndex)
    endBlockDrag()
    setBackupMessage(ui.convertedBlocks(operationCount, getBlockTypeLabel(nextType)))
  }, [
    activeBlockIndex,
    buildBlockTypePatch,
    draftBlocks,
    endBlockDrag,
    getBlockTypeLabel,
    getMultiBlockOperationRange,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    setBackupMessage,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    ui
  ])

  const removeSelectedBlockRange = useCallback((range: BlockSelectionRange) => {
    pushToHistory(draftBlocks)
    const lastRemovedBlock = draftBlocks[range.end]
    if (!lastRemovedBlock) {
      return
    }

    const modifiedBlocks: DocumentBlockDraft[] = []

    for (let index = 0; index < draftBlocks.length; index += 1) {
      const block = draftBlocks[index]
      if (!block) {
        continue
      }

      if (index >= range.start && index <= range.end) {
        continue
      }

      if (index > range.end && block.depth > lastRemovedBlock.depth) {
        const requestedDepth = normalizeBlockDepth(block.type, block.depth + (lastRemovedBlock.depth - block.depth))
        const placement = resolveDraftInsertionPlacement(modifiedBlocks, modifiedBlocks.length, block.type, requestedDepth)
        modifiedBlocks.push({
          ...block,
          depth: placement.depth,
          parentBlockId: placement.parentBlockId
        })
        continue
      }

      modifiedBlocks.push(block)
    }

    const remainingCount = modifiedBlocks.length
    const nextIndex = remainingCount > 0 ? Math.min(range.start, remainingCount - 1) : null

    clearBlockSelection()
    setDraftBlocks(modifiedBlocks)
    setActiveBlockIndex(nextIndex)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(nextIndex)
    endBlockDrag()
  }, [
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    normalizeBlockDepth,
    pushToHistory,
    resolveDraftInsertionPlacement,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  ])

  const copySelectedBlocks = useCallback(async () => {
    if (!selectedBlockRange) {
      return
    }

    const range = getMultiBlockOperationRange(selectedBlockRange)
    const text = serializeDraftBlockRange(draftBlocks, range)
    const count = range.end - range.start + 1

    try {
      await window.knowbook.writeClipboardText(text)
      setBackupMessage(ui.copiedBlocks(count))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.copyFailed
      setBackupMessage(message)
    }
  }, [draftBlocks, getMultiBlockOperationRange, selectedBlockRange, setBackupMessage, ui])

  const copySelectedBlocksAsPlainText = useCallback(async () => {
    if (!selectedBlockRange) {
      return
    }

    const range = getMultiBlockOperationRange(selectedBlockRange)
    const text = serializeDraftBlockRangeAsPlainText(draftBlocks, range)
    const count = range.end - range.start + 1

    try {
      await window.knowbook.writeClipboardText(text)
      setBackupMessage(ui.copiedPlainText(count))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.copyTextFailed
      setBackupMessage(message)
    }
  }, [draftBlocks, getMultiBlockOperationRange, selectedBlockRange, serializeDraftBlockRangeAsPlainText, setBackupMessage, ui])

  const cutSelectedBlocks = useCallback(async () => {
    if (!selectedBlockRange) {
      return
    }

    const range = getMultiBlockOperationRange(selectedBlockRange)
    const text = serializeDraftBlockRange(draftBlocks, range)
    const count = range.end - range.start + 1

    try {
      await window.knowbook.writeClipboardText(text)
      removeSelectedBlockRange(range)
      setBackupMessage(ui.cutBlocks(count))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.cutFailed
      setBackupMessage(message)
    }
  }, [draftBlocks, getMultiBlockOperationRange, removeSelectedBlockRange, selectedBlockRange, setBackupMessage, ui])

  const deleteSelectedBlocks = useCallback(() => {
    if (!selectedBlockRange) {
      return
    }

    const range = getMultiBlockOperationRange(selectedBlockRange)
    const count = range.end - range.start + 1
    removeSelectedBlockRange(range)
    setBackupMessage(ui.deletedBlocks(count))
  }, [getMultiBlockOperationRange, removeSelectedBlockRange, selectedBlockRange, setBackupMessage, ui])

  const duplicateSelectedBlocks = useCallback(() => {
    if (!selectedBlockRange) {
      return
    }

    pushToHistory(draftBlocks)

    const range = getMultiBlockOperationRange(selectedBlockRange)
    const duplicatedBlocks = materializeDraftFragment(
      draftBlocks.slice(range.start, range.end + 1),
      getNormalizedParentBlockId(draftBlocks[range.start])
    )
    const count = duplicatedBlocks.length
    const duplicatedRange = {
      start: range.end + 1,
      end: range.end + count
    }

    setDraftBlocks((previous) => {
      const next = [...previous]
      next.splice(range.end + 1, 0, ...duplicatedBlocks)
      return next
    })
    setSelectionAnchorBlockId(duplicatedBlocks[0]?.id ?? null)
    setSelectedBlockRange(duplicatedRange)
    setActiveBlockIndex(duplicatedRange.start)
    setActiveCursorPosition(duplicatedBlocks[0]?.content.length ?? 0)
    setPendingFocusBlockIndex(duplicatedRange.start)
    endBlockDrag()
    setBackupMessage(ui.duplicatedBlocks(count))
  }, [
    draftBlocks,
    endBlockDrag,
    getMultiBlockOperationRange,
    getNormalizedParentBlockId,
    materializeDraftFragment,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setBackupMessage,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectionAnchorBlockId,
    ui
  ])

  return {
    adjustSelectedBlocksDepth,
    convertSelectedBlocks,
    copySelectedBlocks,
    copySelectedBlocksAsPlainText,
    cutSelectedBlocks,
    deleteSelectedBlocks,
    duplicateSelectedBlocks,
    moveSelectedBlocks,
    removeSelectedBlockRange
  }
}

function renderDraftBlockAsPlainText(block: DocumentBlockDraft): string {
  if (block.type === 'todo') {
    return `${block.checked ? '[x]' : '[ ]'} ${block.content}`.trim()
  }

  if (block.type === 'divider') {
    return ''
  }

  return block.content
}