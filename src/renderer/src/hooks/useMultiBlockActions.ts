import { isTaskBlockType } from '@shared/blockTypes'
import type { AppMessageHandler } from '../notify'
import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { getActiveUiText } from '../i18n'
import { serializeDraftBlockRange } from '../utils/draftClipboard'
import { planDraftBlockDepthChange, planDraftSubtreePlacement } from '../utils/draftTreeDepthChange'
import { materializeDraftFragment } from '../utils/draftTreeFragment'
import { reparentOrphanedBlocksAfterRangeDeletion } from '../utils/draftTreePlacement'
import { planBlockAction } from '../utils/documentBlockActions'
import {
  getBlockSubtreeEndIndex,
  getNextSiblingSubtreeStartIndex,
  getNormalizedBlockId,
  getNormalizedParentBlockId,
  getPreviousSiblingSubtreeStartIndex,
  moveContiguousBlockRange,
  remapIndexAfterSubtreeMove
} from '../utils/draftTreeMove'

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
  getMultiBlockInteractionGuard: (range: BlockSelectionRange) => string | null
  getMultiBlockOperationRange: (range: BlockSelectionRange) => BlockSelectionRange
  getVisibleSiblingSelectionSlice: (range: BlockSelectionRange) => VisibleSelectionSlice | null
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  selectedBlockRange: BlockSelectionRange | null
  selectionAnchorBlockId?: string | null
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  notify: AppMessageHandler
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: (index: number | null, cursorPosition?: number) => void
  setSelectedBlockRange: Dispatch<SetStateAction<BlockSelectionRange | null>>
  setSelectionAnchorBlockId: Dispatch<SetStateAction<string | null>>
  ui: MultiBlockUiText
}

export function useMultiBlockActions({
  activeBlockIndex,
  activeCursorPosition,
  buildBlockTypePatch,
  clearBlockSelection,
  draftBlocks,
  endBlockDrag,
  getMultiBlockInteractionGuard,
  getMultiBlockOperationRange,
  getVisibleSiblingSelectionSlice,
  pushToHistory,
  selectedBlockRange,
  selectionAnchorBlockId,
  setActiveBlockIndex,
  setActiveCursorPosition,
  notify,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  setSelectedBlockRange,
  setSelectionAnchorBlockId,
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

  const moveSelectedBlocksTo = useCallback((targetIndex: number, targetDepth: number | null) => {
    if (!selectedBlockRange) return
    const issue = getMultiBlockInteractionGuard(selectedBlockRange)
    if (issue) { notify(issue, 'warning'); return }
    const range = getMultiBlockOperationRange(selectedBlockRange)
    if (targetIndex < 0 || targetIndex >= draftBlocks.length || (targetIndex >= range.start && targetIndex <= range.end)) return
    const insertionIndex = range.start < targetIndex ? targetIndex - (range.end - range.start + 1) + 1 : targetIndex
    const depth = targetDepth ?? draftBlocks[range.start].depth
    const plan = planDraftSubtreePlacement(draftBlocks, range, insertionIndex, depth)
    if (!plan) return
    pushToHistory(draftBlocks)
    setDraftBlocks(previous => planDraftSubtreePlacement(previous, range, insertionIndex, depth)?.blocks ?? previous)
    const remap = (index: number) => remapIndexAfterSubtreeMove(index, range.start, range.end, insertionIndex) ?? index
    setSelectedBlockRange({ start: remap(selectedBlockRange.start), end: remap(selectedBlockRange.end) })
    setSelectionAnchorBlockId(selectionAnchorBlockId ?? getNormalizedBlockId(draftBlocks[selectedBlockRange.start]))
    const focusIndex = remap(activeBlockIndex ?? selectedBlockRange.end)
    setActiveBlockIndex(focusIndex)
    setActiveCursorPosition(activeCursorPosition)
    setPendingFocusBlockIndex(focusIndex, activeCursorPosition)
    endBlockDrag()
  }, [activeBlockIndex, activeCursorPosition, draftBlocks, endBlockDrag, getMultiBlockInteractionGuard,
    getMultiBlockOperationRange, notify, pushToHistory, selectedBlockRange, selectionAnchorBlockId,
    setActiveBlockIndex, setActiveCursorPosition, setDraftBlocks, setPendingFocusBlockIndex, setSelectedBlockRange, setSelectionAnchorBlockId])

  const moveSelectedBlocks = useCallback((delta: -1 | 1) => {
    if (!selectedBlockRange) {
      return
    }

    const interactionIssue = getMultiBlockInteractionGuard(selectedBlockRange)
    if (interactionIssue) {
      notify(interactionIssue, 'warning')
      return
    }

    const visibleSiblingSlice = getVisibleSiblingSelectionSlice(selectedBlockRange)
    if (!visibleSiblingSlice) {
      notify(ui.invalidVisibleTreeSlice, 'warning')
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
    getPreviousSiblingSubtreeStartIndex,
    getVisibleSiblingSelectionSlice,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    notify,
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
      notify(interactionIssue, 'warning')
      return
    }

    const operationRange = getMultiBlockOperationRange(selectedBlockRange)
    const plan = planDraftBlockDepthChange(draftBlocks, operationRange, delta)
    if (!plan) return

    pushToHistory(draftBlocks)
    setDraftBlocks((previous) => planDraftBlockDepthChange(previous, operationRange, delta)?.blocks ?? previous)
    const remap = (index: number) => remapIndexAfterSubtreeMove(index, operationRange.start, operationRange.end, plan.insertionIndex) ?? index
    const start = remap(selectedBlockRange.start), end = remap(selectedBlockRange.end)
    setSelectedBlockRange({ start, end })
    setSelectionAnchorBlockId(getNormalizedBlockId(plan.blocks[start]))
    setActiveBlockIndex(remap(focusIndex))
    setActiveCursorPosition(cursorPosition)
    setPendingFocusBlockIndex(remap(focusIndex))
    endBlockDrag()
  }, [
    activeCursorPosition,
    draftBlocks,
    endBlockDrag,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    notify,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    setSelectedBlockRange,
    setSelectionAnchorBlockId
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

    const ids = draftBlocks.slice(operationRange.start, operationRange.end + 1).map(block => block.id!)
    setDraftBlocks(previous => planBlockAction(previous, ids, 'convert', nextType) ?? previous)
    setActiveBlockIndex(focusIndex)
    setPendingFocusBlockIndex(focusIndex)
    endBlockDrag()
    notify(ui.convertedBlocks(operationCount, getBlockTypeLabel(nextType)))
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
    notify,
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

    const modifiedBlocks = reparentOrphanedBlocksAfterRangeDeletion(draftBlocks, range.start, range.end)

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
    pushToHistory,
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
      notify(ui.copiedBlocks(count))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.copyFailed
      notify(message, 'error')
    }
  }, [draftBlocks, getMultiBlockOperationRange, selectedBlockRange, notify, ui])

  const copySelectedBlocksAsPlainText = useCallback(async () => {
    if (!selectedBlockRange) {
      return
    }

    const range = getMultiBlockOperationRange(selectedBlockRange)
    const text = serializeDraftBlockRangeAsPlainText(draftBlocks, range)
    const count = range.end - range.start + 1

    try {
      await window.knowbook.writeClipboardText(text)
      notify(ui.copiedPlainText(count))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.copyTextFailed
      notify(message, 'error')
    }
  }, [draftBlocks, getMultiBlockOperationRange, selectedBlockRange, serializeDraftBlockRangeAsPlainText, notify, ui])

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
      notify(ui.cutBlocks(count))
    } catch (error) {
      const message = error instanceof Error ? error.message : ui.cutFailed
      notify(message, 'error')
    }
  }, [draftBlocks, getMultiBlockOperationRange, removeSelectedBlockRange, selectedBlockRange, notify, ui])

  const deleteSelectedBlocks = useCallback(() => {
    if (!selectedBlockRange) {
      return
    }

    const range = getMultiBlockOperationRange(selectedBlockRange)
    const count = range.end - range.start + 1
    removeSelectedBlockRange(range)
    notify(ui.deletedBlocks(count))
  }, [getMultiBlockOperationRange, removeSelectedBlockRange, selectedBlockRange, notify, ui])

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
    notify(ui.duplicatedBlocks(count))
  }, [
    draftBlocks,
    endBlockDrag,
    getMultiBlockOperationRange,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    notify,
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
    moveSelectedBlocksTo,
    removeSelectedBlockRange
  }
}

function renderDraftBlockAsPlainText(block: DocumentBlockDraft): string {
  if (isTaskBlockType(block.type)) {
    return `${block.checked ? '[x]' : '[ ]'} ${block.content}`.trim()
  }

  if (block.type === 'divider') {
    return ''
  }

  return block.content
}
