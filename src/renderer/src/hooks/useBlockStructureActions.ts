import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { isNestableBlock } from '../utils/draftBlockShape'
import { getBlockSubtreeEndIndex, getNormalizedParentBlockId } from '../utils/draftTreeMove'

type UseBlockStructureActionsParams = {
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
  materializeDraftFragment: (blocks: DocumentBlockDraft[], rootParentBlockId: string | null) => DocumentBlockDraft[]
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: Dispatch<SetStateAction<number | null>>
}

export function useBlockStructureActions({
  buildBlockTypePatch,
  clearBlockSelection,
  draftBlocks,
  endBlockDrag,
  materializeDraftFragment,
  pushToHistory,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex
}: UseBlockStructureActionsParams) {
  const buildSiblingDraftBlock = useCallback((anchorBlock?: DocumentBlockDraft): DocumentBlockDraft => {
    if (anchorBlock && isNestableBlock(anchorBlock.type)) {
      return buildBlockTypePatch(anchorBlock.type, '', false, anchorBlock.depth, anchorBlock.parentBlockId ?? null)
    }

    return buildBlockTypePatch('paragraph', '')
  }, [buildBlockTypePatch, isNestableBlock])

  const insertDraftBlockAt = useCallback((index: number, anchorIndex: number | null = null) => {
    pushToHistory(draftBlocks)
    const nextIndex = Math.max(0, Math.min(index, draftBlocks.length))
    clearBlockSelection()

    setDraftBlocks((previous) => {
      const next = [...previous]
      const anchorBlock = anchorIndex !== null ? next[anchorIndex] : undefined
      next.splice(nextIndex, 0, buildSiblingDraftBlock(anchorBlock))
      return next
    })

    setActiveBlockIndex(nextIndex)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(nextIndex)
    endBlockDrag()
  }, [
    buildSiblingDraftBlock,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  ])

  const insertChildDraftBlock = useCallback((index: number, contentOverride?: string) => {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    clearBlockSelection()

    const childType = getDefaultChildBlockType(currentBlock.type)
    const childDepth = currentBlock.depth + 1
    if (!isNestableBlock(childType) || childDepth > 6) {
      return
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)

    setDraftBlocks((previous) => {
      const next = [...previous]
      if (contentOverride !== undefined) {
        next[index] = {
          ...next[index],
          content: contentOverride
        }
      }

      next.splice(subtreeEndIndex + 1, 0, buildBlockTypePatch(childType, '', false, childDepth, currentBlock.id))
      return next
    })

    setActiveBlockIndex(subtreeEndIndex + 1)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(subtreeEndIndex + 1)
    endBlockDrag()
  }, [
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getDefaultChildBlockType,
    isNestableBlock,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  ])

  const duplicateDraftBlock = useCallback((index: number, contentOverride?: string) => {
    pushToHistory(draftBlocks)
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    clearBlockSelection()

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)
    const duplicatedRootIndex = subtreeEndIndex + 1
    const duplicatedBlocks = materializeDraftFragment(
      draftBlocks.slice(index, subtreeEndIndex + 1).map((block, offset) => ({
        ...block,
        content: offset === 0 ? contentOverride ?? block.content : block.content
      })),
      getNormalizedParentBlockId(currentBlock)
    )

    setDraftBlocks((previous) => {
      const next = [...previous]
      if (contentOverride !== undefined) {
        next[index] = {
          ...next[index],
          content: contentOverride
        }
      }

      next.splice(duplicatedRootIndex, 0, ...duplicatedBlocks)
      return next
    })
    setActiveBlockIndex(duplicatedRootIndex)
    setActiveCursorPosition(duplicatedBlocks[0]?.content.length ?? 0)
    setPendingFocusBlockIndex(duplicatedRootIndex)
    endBlockDrag()
  }, [
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getNormalizedParentBlockId,
    materializeDraftFragment,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  ])

  const splitDraftBlock = useCallback((
    index: number,
    selectionStart: number,
    selectionEnd = selectionStart,
    nextTypeOverride?: DocumentBlock['type']
  ) => {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)
    if (subtreeEndIndex > index) {
      console.warn('Cannot split a block with child blocks. Please delete or move child blocks first.')
      return
    }

    clearBlockSelection()

    const safeStart = Math.max(0, Math.min(selectionStart, currentBlock.content.length))
    const safeEnd = Math.max(safeStart, Math.min(selectionEnd, currentBlock.content.length))
    const leftContent = currentBlock.content.slice(0, safeStart)
    const rightContent = currentBlock.content.slice(safeEnd)
    const nextType = nextTypeOverride ?? (currentBlock.type === 'heading-1' || currentBlock.type === 'heading-2' ? 'paragraph' : currentBlock.type)

    setDraftBlocks((previous) => {
      const next = [...previous]
      next[index] = {
        ...next[index],
        content: leftContent
      }
      next.splice(
        index + 1,
        0,
        buildBlockTypePatch(nextType, rightContent, nextType === 'todo' ? false : currentBlock.checked, currentBlock.depth, currentBlock.parentBlockId ?? null)
      )
      return next
    })
    setActiveBlockIndex(index + 1)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(index + 1)
    endBlockDrag()
  }, [
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  ])

  return {
    duplicateDraftBlock,
    insertChildDraftBlock,
    insertDraftBlockAt,
    splitDraftBlock
  }
}

function getDefaultChildBlockType(type: DocumentBlock['type']): DocumentBlock['type'] {
  if (type === 'todo') {
    return 'todo'
  }

  if (type === 'numbered-list') {
    return 'numbered-list'
  }

  return 'bulleted-list'
}