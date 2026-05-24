import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'

type SlashCommandLike = {
  id: string
  label: string
  description: string
  keywords: string[]
} & (
  | {
      kind: 'type'
      type: DocumentBlock['type']
    }
  | {
      kind: 'action'
      action: 'insert-above' | 'insert-below' | 'insert-child' | 'move-up' | 'move-down' | 'indent' | 'outdent' | 'duplicate' | 'delete'
    }
)

type SlashContextLike = {
  start: number
}

type UseSlashCommandActionsParams<TSlashCommand extends SlashCommandLike> = {
  activeBlockIndex: number | null
  activeCursorPosition: number
  activeSlashContext: SlashContextLike | null
  adjustBlockDepth: (index: number, delta: number, cursorPosition?: number) => void
  buildBlockTypePatch: (
    type: DocumentBlock['type'],
    content: string,
    checked?: boolean,
    depth?: number,
    parentBlockId?: string | null
  ) => DocumentBlockDraft
  buildSiblingDraftBlock: (anchorBlock?: DocumentBlockDraft) => DocumentBlockDraft
  clearBlockSelection: () => void
  draftBlocks: DocumentBlockDraft[]
  duplicateDraftBlock: (index: number, contentOverride?: string) => void
  endBlockDrag: () => void
  getBlockSubtreeEndIndex: (blocks: DocumentBlockDraft[], index: number) => number
  insertChildDraftBlock: (index: number, contentOverride?: string) => void
  insertDraftBlockAt: (index: number, anchorIndex?: number | null) => void
  isNestableBlock: (type: DocumentBlock['type']) => boolean
  moveDraftBlockBySibling: (index: number, direction: -1 | 1, cursorPosition?: number, contentOverride?: string) => boolean
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: Dispatch<SetStateAction<number | null>>
  stripSlashCommand: (content: string, start: number, cursorPosition: number) => string
  updateDraftBlock: (index: number, patch: Partial<DocumentBlockDraft>) => void
}

export function useSlashCommandActions<TSlashCommand extends SlashCommandLike>({
  activeBlockIndex,
  activeCursorPosition,
  activeSlashContext,
  adjustBlockDepth,
  buildBlockTypePatch,
  buildSiblingDraftBlock,
  clearBlockSelection,
  draftBlocks,
  duplicateDraftBlock,
  endBlockDrag,
  getBlockSubtreeEndIndex,
  insertChildDraftBlock,
  insertDraftBlockAt,
  isNestableBlock,
  moveDraftBlockBySibling,
  pushToHistory,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  stripSlashCommand,
  updateDraftBlock
}: UseSlashCommandActionsParams<TSlashCommand>) {
  const removeDraftBlock = useCallback((index: number) => {
    pushToHistory(draftBlocks)
    const subtreeEndIndex = getBlockSubtreeEndIndex(draftBlocks, index)
    const removedCount = subtreeEndIndex - index + 1
    const remainingCount = draftBlocks.length - removedCount
    const nextIndex = remainingCount > 0 ? Math.min(index, remainingCount - 1) : null

    clearBlockSelection()
    setDraftBlocks((previous) => previous.filter((_, currentIndex) => currentIndex < index || currentIndex > subtreeEndIndex))
    setActiveBlockIndex((previous) => {
      if (previous === null) {
        return previous
      }

      if (previous < index) {
        return previous
      }

      if (previous <= subtreeEndIndex) {
        return nextIndex
      }

      return previous - removedCount
    })
    setActiveCursorPosition(0)
    setPendingFocusBlockIndex(nextIndex)
    endBlockDrag()
  }, [
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

  const applySlashCommand = useCallback((command: TSlashCommand) => {
    if (activeBlockIndex === null || !activeSlashContext) {
      return
    }

    const currentBlock = draftBlocks[activeBlockIndex]
    if (!currentBlock) {
      return
    }

    const nextContent = stripSlashCommand(currentBlock.content, activeSlashContext.start, activeCursorPosition)

    if (command.kind === 'type') {
      setDraftBlocks((previous) =>
        previous.map((block, index) =>
          index === activeBlockIndex
            ? {
                ...block,
                ...buildBlockTypePatch(command.type, nextContent, command.type === 'todo' ? currentBlock.checked : false, currentBlock.depth, currentBlock.parentBlockId ?? null)
              }
            : block
        )
      )
      setActiveCursorPosition(nextContent.length)
      setPendingFocusBlockIndex(activeBlockIndex)
      return
    }

    if (command.action === 'insert-above') {
      clearBlockSelection()
      setDraftBlocks((previous) => {
        const next = [...previous]
        next[activeBlockIndex] = {
          ...next[activeBlockIndex],
          content: nextContent
        }
        next.splice(activeBlockIndex, 0, buildSiblingDraftBlock(next[activeBlockIndex]))
        return next
      })
      setActiveBlockIndex(activeBlockIndex)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(activeBlockIndex)
      return
    }

    if (command.action === 'insert-below') {
      clearBlockSelection()
      setDraftBlocks((previous) => {
        const next = [...previous]
        next[activeBlockIndex] = {
          ...next[activeBlockIndex],
          content: nextContent
        }
        next.splice(activeBlockIndex + 1, 0, buildSiblingDraftBlock(next[activeBlockIndex]))
        return next
      })
      setActiveBlockIndex(activeBlockIndex + 1)
      setActiveCursorPosition(0)
      setPendingFocusBlockIndex(activeBlockIndex + 1)
      return
    }

    if (command.action === 'insert-child') {
      insertChildDraftBlock(activeBlockIndex, nextContent)
      return
    }

    if (command.action === 'move-up' || command.action === 'move-down') {
      moveDraftBlockBySibling(activeBlockIndex, command.action === 'move-up' ? -1 : 1, nextContent.length, nextContent)
      return
    }

    if (command.action === 'indent' || command.action === 'outdent') {
      if (!isNestableBlock(currentBlock.type)) {
        updateDraftBlock(activeBlockIndex, { content: nextContent })
        setActiveCursorPosition(nextContent.length)
        setPendingFocusBlockIndex(activeBlockIndex)
        return
      }

      updateDraftBlock(activeBlockIndex, { content: nextContent })
      adjustBlockDepth(activeBlockIndex, command.action === 'indent' ? 1 : -1, nextContent.length)
      return
    }

    if (command.action === 'duplicate') {
      duplicateDraftBlock(activeBlockIndex, nextContent)
      return
    }

    if (command.action === 'delete') {
      removeDraftBlock(activeBlockIndex)
    }
  }, [
    activeBlockIndex,
    activeCursorPosition,
    activeSlashContext,
    adjustBlockDepth,
    buildBlockTypePatch,
    buildSiblingDraftBlock,
    clearBlockSelection,
    draftBlocks,
    duplicateDraftBlock,
    insertChildDraftBlock,
    isNestableBlock,
    moveDraftBlockBySibling,
    removeDraftBlock,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
    stripSlashCommand,
    updateDraftBlock
  ])

  const dismissSlashCommand = useCallback(() => {
    if (activeBlockIndex === null || !activeSlashContext) {
      return
    }

    const currentBlock = draftBlocks[activeBlockIndex]
    if (!currentBlock) {
      return
    }

    const nextContent = stripSlashCommand(currentBlock.content, activeSlashContext.start, activeCursorPosition)
    updateDraftBlock(activeBlockIndex, { content: nextContent })
    setActiveCursorPosition(nextContent.length)
    setPendingFocusBlockIndex(activeBlockIndex)
  }, [activeBlockIndex, activeCursorPosition, activeSlashContext, draftBlocks, setActiveCursorPosition, setPendingFocusBlockIndex, stripSlashCommand, updateDraftBlock])

  const addDraftBlock = useCallback(() => {
    insertDraftBlockAt(draftBlocks.length)
  }, [draftBlocks.length, insertDraftBlockAt])

  return {
    addDraftBlock,
    applySlashCommand,
    dismissSlashCommand,
    removeDraftBlock
  }
}