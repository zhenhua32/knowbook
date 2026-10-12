import { isTaskBlockType, isOrderedListBlockType } from '@shared/blockTypes'
import { getHeadingLevel } from '@shared/markdownEngine'
import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { isNestableBlock } from '../utils/draftBlockShape'
import { materializeDraftFragment } from '../utils/draftTreeFragment'
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
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: (index: number | null, cursorPosition?: number) => void
}

export function useBlockStructureActions({
  buildBlockTypePatch,
  clearBlockSelection,
  draftBlocks,
  endBlockDrag,
  pushToHistory,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex
}: UseBlockStructureActionsParams) {
  const buildSiblingDraftBlock = useCallback((anchorBlock?: DocumentBlockDraft): DocumentBlockDraft => {
    if (anchorBlock && isNestableBlock(anchorBlock.type)) {
      return {
        ...buildBlockTypePatch(anchorBlock.type, '', false, anchorBlock.depth, anchorBlock.parentBlockId ?? null),
        ...(anchorBlock.markdownFormat ? { markdownFormat: { ...anchorBlock.markdownFormat } } : {})
      }
    }

    return buildBlockTypePatch('paragraph', '')
  }, [buildBlockTypePatch, isNestableBlock])

  const insertDraftBlockAt = useCallback((index: number, anchorIndex: number | null = null, contentOverride?: string) => {
    if (anchorIndex !== null && !draftBlocks[anchorIndex]) return

    const nextIndex = anchorIndex !== null && index > anchorIndex
      ? getBlockSubtreeEndIndex(draftBlocks, anchorIndex) + 1
      : Math.max(0, Math.min(index, draftBlocks.length))
    pushToHistory(draftBlocks)
    clearBlockSelection()

    setDraftBlocks((previous) => {
      const next = [...previous]
      if (anchorIndex !== null && contentOverride !== undefined) {
        next[anchorIndex] = { ...next[anchorIndex], content: contentOverride }
      }
      const anchorBlock = anchorIndex !== null ? next[anchorIndex] : undefined
      next.splice(nextIndex, 0, buildSiblingDraftBlock(anchorBlock))
      return next
    })

    setActiveBlockIndex(nextIndex)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(nextIndex, 0)
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
    if (!currentBlock || !isNestableBlock(currentBlock.type)) {
      return
    }

    const childType = getDefaultChildBlockType(currentBlock.type)
    const childDepth = currentBlock.depth + 1
    if (!isNestableBlock(childType) || childDepth > 6) {
      return
    }

    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)

    pushToHistory(draftBlocks)
    clearBlockSelection()

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
    setPendingFocusBlockIndex(subtreeEndIndex + 1, 0)
    endBlockDrag()
  }, [
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getDefaultChildBlockType,
    isNestableBlock,
    pushToHistory,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  ])

  const duplicateDraftBlock = useCallback((index: number, contentOverride?: string) => {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return
    }

    pushToHistory(draftBlocks)
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
    setPendingFocusBlockIndex(duplicatedRootIndex, duplicatedBlocks[0]?.content.length ?? 0)
    endBlockDrag()
  }, [
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    getNormalizedParentBlockId,
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
    const nextIndex = subtreeEndIndex + 1

    pushToHistory(draftBlocks)
    clearBlockSelection()

    const safeStart = Math.max(0, Math.min(selectionStart, currentBlock.content.length))
    const safeEnd = Math.max(safeStart, Math.min(selectionEnd, currentBlock.content.length))
    const leftContent = currentBlock.content.slice(0, safeStart)
    const rightContent = currentBlock.content.slice(safeEnd)
    const nextType = nextTypeOverride ?? (getHeadingLevel(currentBlock.type) ? 'paragraph' : currentBlock.type)

    setDraftBlocks((previous) => {
      const next = [...previous]
      next[index] = {
        ...next[index],
        content: leftContent
      }
      next.splice(
        nextIndex,
        0,
        {
          ...buildBlockTypePatch(nextType, rightContent, isTaskBlockType(nextType) ? false : currentBlock.checked, currentBlock.depth, currentBlock.parentBlockId ?? null),
          // Both fragments retain the source's content attributes, while the
          // new block keeps its own identity, task state and list numbering.
          ...(nextType === currentBlock.type ? {
            ...(currentBlock.tags ? { tags: [...currentBlock.tags] } : {}),
            ...(currentBlock.highlight ? { highlight: currentBlock.highlight } : {}),
            ...(currentBlock.markdownFormat ? { markdownFormat: { ...currentBlock.markdownFormat } } : {}),
            ...(nextType === 'code' && currentBlock.language ? { language: currentBlock.language } : {})
          } : {})
        }
      )
      return next
    })
    setActiveBlockIndex(nextIndex)
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(nextIndex, 0)
    endBlockDrag()
  }, [
    buildBlockTypePatch,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getBlockSubtreeEndIndex,
    pushToHistory,
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
  if (isTaskBlockType(type)) {
    return type
  }

  if (isOrderedListBlockType(type)) {
    return 'numbered-list'
  }

  return 'bulleted-list'
}
