import { useCallback, useMemo, useRef, useState } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import {
  getBlockSubtreeEndIndex,
  getNextSiblingSubtreeStartIndex,
  getNormalizedBlockId,
  getNormalizedParentBlockId,
  getPreviousSiblingSubtreeStartIndex
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

type UseBlockSelectionStateParams = {
  activeBlockIndex: number | null
  collapsedBlockIds: Set<string>
  draftBlocks: DocumentBlockDraft[]
  onActiveBlockChange: (index: number) => void
  visibleSliceCrossParentGuard: string
  selectionStaleGuard: string
}

export function useBlockSelectionState({
  activeBlockIndex,
  collapsedBlockIds,
  draftBlocks,
  onActiveBlockChange,
  visibleSliceCrossParentGuard,
  selectionStaleGuard
}: UseBlockSelectionStateParams) {
  const [selectionAnchorBlockId, setSelectionAnchorBlockId] = useState<string | null>(null)
  const [selectedBlockRange, setSelectedBlockRange] = useState<BlockSelectionRange | null>(null)
  const [isBlockRangeSelecting, setIsBlockRangeSelecting] = useState(false)
  const [selectedBlockConversionType, setSelectedBlockConversionType] = useState<DocumentBlock['type']>('paragraph')
  const blockMouseDownOrigin = useRef<number | null>(null)

  const getVisibleBlockEntries = useCallback((blocks: DocumentBlockDraft[]): VisibleBlockEntry[] => {
    const entries: VisibleBlockEntry[] = []

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (!block) {
        continue
      }

      entries.push({ block, index })

      const blockId = getNormalizedBlockId(block)
      if (blockId && collapsedBlockIds.has(blockId)) {
        while (index + 1 < blocks.length && blocks[index + 1].depth > block.depth) {
          index += 1
        }
      }
    }

    return entries
  }, [collapsedBlockIds, getNormalizedBlockId])

  const getVisibleBlocks = useCallback((blocks: DocumentBlockDraft[]) => {
    return getVisibleBlockEntries(blocks).map(({ block }) => block)
  }, [getVisibleBlockEntries])

  const getSelectedVisibleBlockEntries = useCallback((range: BlockSelectionRange) => {
    return getVisibleBlockEntries(draftBlocks).filter(({ index }) => index >= range.start && index <= range.end)
  }, [draftBlocks, getVisibleBlockEntries])

  const getVisibleBlockCountInRange = useCallback((range: BlockSelectionRange) => {
    return getSelectedVisibleBlockEntries(range).length
  }, [getSelectedVisibleBlockEntries])

  const getVisibleSelectionSlice = useCallback((range: BlockSelectionRange): VisibleSelectionSlice | null => {
    const visibleEntries = getSelectedVisibleBlockEntries(range)
    if (visibleEntries.length === 0) {
      return null
    }

    const firstEntry = visibleEntries[0]
    const lastEntry = visibleEntries[visibleEntries.length - 1]

    return {
      visibleEntries,
      operationRange: {
        start: firstEntry.index,
        end: getBlockSubtreeEndIndex(draftBlocks, lastEntry.index)
      }
    }
  }, [draftBlocks, getBlockSubtreeEndIndex, getSelectedVisibleBlockEntries])

  const getVisibleSiblingSelectionSlice = useCallback((range: BlockSelectionRange): VisibleSelectionSlice | null => {
    const slice = getVisibleSelectionSlice(range)
    if (!slice) {
      return null
    }

    const firstEntry = slice.visibleEntries[0]
    if (!firstEntry) {
      return null
    }

    const referenceDepth = firstEntry.block.depth
    const referenceParentBlockId = getNormalizedParentBlockId(firstEntry.block)
    const isSiblingSlice = slice.visibleEntries.every(
      ({ block }) => block.depth === referenceDepth && getNormalizedParentBlockId(block) === referenceParentBlockId
    )

    return isSiblingSlice ? slice : null
  }, [getNormalizedParentBlockId, getVisibleSelectionSlice])

  const selectionIncludesHiddenCollapsedContent = useCallback((range: BlockSelectionRange) => {
    return getVisibleBlockCountInRange(range) < range.end - range.start + 1
  }, [getVisibleBlockCountInRange])

  const getMultiBlockInteractionGuard = useCallback((range: BlockSelectionRange): string | null => {
    if (range.start === range.end) {
      return null
    }

    const visibleSelectionSlice = getVisibleSelectionSlice(range)
    if (!visibleSelectionSlice) {
      return selectionStaleGuard
    }

    if (visibleSelectionSlice.visibleEntries.length === 1) {
      return null
    }

    if (!getVisibleSiblingSelectionSlice(range)) {
      return visibleSliceCrossParentGuard
    }

    return null
  }, [getVisibleSelectionSlice, getVisibleSiblingSelectionSlice, selectionStaleGuard, visibleSliceCrossParentGuard])

  const canMoveSelectedRange = useCallback((range: BlockSelectionRange, delta: -1 | 1) => {
    const visibleSiblingSlice = getVisibleSiblingSelectionSlice(range)
    if (!visibleSiblingSlice) {
      return false
    }

    const anchorEntry = delta === -1
      ? visibleSiblingSlice.visibleEntries[0]
      : visibleSiblingSlice.visibleEntries[visibleSiblingSlice.visibleEntries.length - 1]

    if (!anchorEntry) {
      return false
    }

    return delta === -1
      ? getPreviousSiblingSubtreeStartIndex(draftBlocks, anchorEntry.index) !== null
      : getNextSiblingSubtreeStartIndex(draftBlocks, anchorEntry.index) !== null
  }, [draftBlocks, getNextSiblingSubtreeStartIndex, getPreviousSiblingSubtreeStartIndex, getVisibleSiblingSelectionSlice])

  const clearBlockSelection = useCallback(() => {
    setIsBlockRangeSelecting(false)
    setSelectionAnchorBlockId(null)
    setSelectedBlockRange(null)
  }, [])

  const endBlockRangeSelection = useCallback(() => {
    blockMouseDownOrigin.current = null
    setIsBlockRangeSelecting(false)
  }, [])

  const notifyBlockMouseDown = useCallback((index: number) => {
    blockMouseDownOrigin.current = index
  }, [])

  const selectBlockRange = useCallback((index: number, extendSelection = false) => {
    const visibleEntries = getVisibleBlockEntries(draftBlocks)
    const targetVisibleIndex = visibleEntries.findIndex((entry) => entry.index === index)
    const targetBlockId = getNormalizedBlockId(draftBlocks[index])
    const resolvedAnchorId = selectionAnchorBlockId ??
      (activeBlockIndex !== null ? getNormalizedBlockId(draftBlocks[activeBlockIndex]) : null)

    if (!extendSelection || !resolvedAnchorId || targetVisibleIndex === -1) {
      setSelectionAnchorBlockId(targetBlockId)
      setSelectedBlockRange({ start: index, end: index })
      onActiveBlockChange(index)
      return
    }

    const anchorVisibleIndex = visibleEntries.findIndex(({ block }) => getNormalizedBlockId(block) === resolvedAnchorId)
    const resolvedAnchorVisibleIndex = anchorVisibleIndex === -1 ? targetVisibleIndex : anchorVisibleIndex
    const rangeStartEntry = visibleEntries[Math.min(resolvedAnchorVisibleIndex, targetVisibleIndex)]
    const rangeEndEntry = visibleEntries[Math.max(resolvedAnchorVisibleIndex, targetVisibleIndex)]

    if (!rangeStartEntry || !rangeEndEntry) {
      setSelectionAnchorBlockId(targetBlockId)
      setSelectedBlockRange({ start: index, end: index })
      onActiveBlockChange(index)
      return
    }

    setSelectionAnchorBlockId(resolvedAnchorId)
    setSelectedBlockRange({
      start: rangeStartEntry.index,
      end: rangeEndEntry.index
    })
    onActiveBlockChange(index)
  }, [activeBlockIndex, draftBlocks, getNormalizedBlockId, getVisibleBlockEntries, onActiveBlockChange, selectionAnchorBlockId])

  const handleBlockMouseEnter = useCallback((index: number, buttonsHeld: boolean) => {
    const origin = blockMouseDownOrigin.current

    if (!buttonsHeld) {
      blockMouseDownOrigin.current = null
      if (isBlockRangeSelecting) {
        setIsBlockRangeSelecting(false)
      }
      return
    }

    if (origin === null || index === origin) {
      return
    }

    if (!isBlockRangeSelecting) {
      const originBlockId = getNormalizedBlockId(draftBlocks[origin])
      const visibleEntries = getVisibleBlockEntries(draftBlocks)
      const originVisibleIndex = visibleEntries.findIndex((entry) => entry.index === origin)
      const targetVisibleIndex = visibleEntries.findIndex((entry) => entry.index === index)

      if (originVisibleIndex !== -1 && targetVisibleIndex !== -1) {
        const startEntry = visibleEntries[Math.min(originVisibleIndex, targetVisibleIndex)]
        const endEntry = visibleEntries[Math.max(originVisibleIndex, targetVisibleIndex)]

        if (startEntry && endEntry) {
          setIsBlockRangeSelecting(true)
          setSelectionAnchorBlockId(originBlockId ?? null)
          setSelectedBlockRange({ start: startEntry.index, end: endEntry.index })
          onActiveBlockChange(index)
        }
      }
      return
    }

    selectBlockRange(index, true)
  }, [draftBlocks, getNormalizedBlockId, getVisibleBlockEntries, isBlockRangeSelecting, onActiveBlockChange, selectBlockRange])

  const isBlockSelected = useCallback((index: number) => {
    return selectedBlockRange ? index >= selectedBlockRange.start && index <= selectedBlockRange.end : false
  }, [selectedBlockRange])

  const isSelectionCoherent = useCallback((range: BlockSelectionRange) => {
    if (range.start === range.end) {
      return true
    }

    const visibleEntries = getSelectedVisibleBlockEntries(range)
    if (visibleEntries.length === 0) {
      return true
    }

    const depthSet = new Set(visibleEntries.map(({ block }) => block.depth))
    return depthSet.size === 1
  }, [getSelectedVisibleBlockEntries])

  const selectAllBlocks = useCallback(() => {
    if (draftBlocks.length === 0) {
      return
    }

    const firstBlockId = getNormalizedBlockId(draftBlocks[0])
    setSelectionAnchorBlockId(firstBlockId)
    setSelectedBlockRange({ start: 0, end: draftBlocks.length - 1 })
    onActiveBlockChange(0)
  }, [draftBlocks, getNormalizedBlockId, onActiveBlockChange])

  const getMultiBlockOperationRange = useCallback((range: BlockSelectionRange): BlockSelectionRange => {
    if (range.start === range.end) {
      return {
        start: range.start,
        end: getBlockSubtreeEndIndex(draftBlocks, range.start)
      }
    }

    return getVisibleSelectionSlice(range)?.operationRange ?? range
  }, [draftBlocks, getBlockSubtreeEndIndex, getVisibleSelectionSlice])

  const selectedBlockCount = selectedBlockRange ? selectedBlockRange.end - selectedBlockRange.start + 1 : 0
  const selectedVisibleBlockCount = selectedBlockRange ? getVisibleBlockCountInRange(selectedBlockRange) : 0
  const selectedBlockActionRange = selectedBlockRange ? getMultiBlockOperationRange(selectedBlockRange) : null
  const selectedBlockActionCount = selectedBlockActionRange ? selectedBlockActionRange.end - selectedBlockActionRange.start + 1 : 0
  const selectedBlockHasHiddenCollapsedContent = selectedBlockRange ? selectionIncludesHiddenCollapsedContent(selectedBlockRange) : false
  const selectedBlockInteractionIssue = selectedBlockRange ? getMultiBlockInteractionGuard(selectedBlockRange) : null
  const selectedVisibleSiblingSlice = selectedBlockRange ? getVisibleSiblingSelectionSlice(selectedBlockRange) : null

  const canMoveSelectionUp = useMemo(() => {
    if (!selectedBlockRange) {
      return false
    }

    return selectedBlockCount === 1
      ? getPreviousSiblingSubtreeStartIndex(draftBlocks, selectedBlockRange.start) !== null
      : selectedBlockInteractionIssue === null && canMoveSelectedRange(selectedBlockRange, -1)
  }, [canMoveSelectedRange, draftBlocks, getPreviousSiblingSubtreeStartIndex, selectedBlockCount, selectedBlockInteractionIssue, selectedBlockRange])

  const canMoveSelectionDown = useMemo(() => {
    if (!selectedBlockRange) {
      return false
    }

    return selectedBlockCount === 1
      ? getNextSiblingSubtreeStartIndex(draftBlocks, selectedBlockRange.start) !== null
      : selectedBlockInteractionIssue === null && canMoveSelectedRange(selectedBlockRange, 1)
  }, [canMoveSelectedRange, draftBlocks, getNextSiblingSubtreeStartIndex, selectedBlockCount, selectedBlockInteractionIssue, selectedBlockRange])

  return {
    canMoveSelectedRange,
    canMoveSelectionDown,
    canMoveSelectionUp,
    clearBlockSelection,
    endBlockRangeSelection,
    getMultiBlockInteractionGuard,
    getMultiBlockOperationRange,
    getVisibleBlockCountInRange,
    getVisibleBlockEntries,
    getVisibleBlocks,
    getVisibleSiblingSelectionSlice,
    handleBlockMouseEnter,
    isBlockRangeSelecting,
    isBlockSelected,
    isSelectionCoherent,
    notifyBlockMouseDown,
    selectAllBlocks,
    selectBlockRange,
    selectedBlockActionCount,
    selectedBlockConversionType,
    selectedBlockCount,
    selectedBlockHasHiddenCollapsedContent,
    selectedBlockInteractionIssue,
    selectedBlockRange,
    selectedVisibleBlockCount,
    selectedVisibleSiblingSlice,
    selectionAnchorBlockId,
    setIsBlockRangeSelecting,
    setSelectedBlockConversionType,
    setSelectedBlockRange,
    setSelectionAnchorBlockId
  }
}
