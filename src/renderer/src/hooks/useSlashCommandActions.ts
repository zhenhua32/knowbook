import { isTaskBlockType, canBlockHaveParent, canBlockNestUnder } from '@shared/blockTypes'
import { useCallback, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlock, DocumentBlockDraft } from '@shared/contracts'
import { getBlockSubtreeEndIndex } from '../utils/draftTreeMove'
import { prepareDraftBlockTypeChange } from '../utils/draftTreeTextEditing'
import { removeSlashCommand } from '../utils/editorAssist'

type SlashCommandLike = {
  id: string
  label: string
  description: string
  keywords: string[]
} & (
  | {
      kind: 'type'
      type: DocumentBlock['type']
      templateContent?: string
      templateLanguage?: string
    }
  | {
      kind: 'action'
      action: 'insert-above' | 'insert-below' | 'insert-child' | 'move-up' | 'move-down' | 'indent' | 'outdent' | 'duplicate' | 'delete' | 'columns'
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
  clearBlockSelection: () => void
  draftBlocks: DocumentBlockDraft[]
  duplicateDraftBlock: (index: number, contentOverride?: string) => void
  endBlockDrag: () => void
  insertChildDraftBlock: (index: number, contentOverride?: string) => void
  insertDraftBlockAt: (index: number, anchorIndex?: number | null, contentOverride?: string) => void
  moveDraftBlockBySibling: (index: number, direction: -1 | 1, cursorPosition?: number, contentOverride?: string) => boolean
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: Dispatch<SetStateAction<number | null>>
  updateDraftBlock: (index: number, patch: Partial<DocumentBlockDraft>) => void
}

export function useSlashCommandActions<TSlashCommand extends SlashCommandLike>({
  activeBlockIndex,
  activeCursorPosition,
  activeSlashContext,
  adjustBlockDepth,
  buildBlockTypePatch,
  clearBlockSelection,
  draftBlocks,
  duplicateDraftBlock,
  endBlockDrag,
  insertChildDraftBlock,
  insertDraftBlockAt,
  moveDraftBlockBySibling,
  pushToHistory,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  updateDraftBlock
}: UseSlashCommandActionsParams<TSlashCommand>) {
  const liveBlocks = useRef(draftBlocks)
  liveBlocks.current = draftBlocks
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

    const slashRemoval = removeSlashCommand(
      currentBlock.content,
      activeSlashContext.start,
      activeCursorPosition
    )
    const nextContent = slashRemoval.content

    if (command.kind === 'action' && command.action === 'columns') {
      const before = draftBlocks
      void import('../utils/columnOperations').then(({ completeColumnSlash }) => completeColumnSlash(before, activeBlockIndex, nextContent,
        { isCurrent: () => liveBlocks.current === before, pushToHistory, clearBlockSelection, setDraftBlocks,
          setActiveBlockIndex, setPendingFocusBlockIndex, endBlockDrag })).catch(error => console.warn('Could not load column layout tools.', error))
      return
    }

    if (command.kind === 'type') {
      pushToHistory(draftBlocks)
      if (command.templateContent !== undefined) {
        let targetIndex = activeBlockIndex
        let targetDepth = currentBlock.depth
        let targetParentId = currentBlock.parentBlockId ?? null
        if (nextContent.trim()) {
          let branchIndex = activeBlockIndex
          const byId = new Map(draftBlocks.map((block, index) => [block.id, index]))
          let parentIndex = byId.get(targetParentId ?? undefined)
          while (parentIndex !== undefined && !canBlockNestUnder(draftBlocks[parentIndex].type, command.type)) {
            branchIndex = parentIndex
            targetParentId = draftBlocks[parentIndex].parentBlockId ?? null
            parentIndex = byId.get(targetParentId ?? undefined)
          }
          targetDepth = parentIndex === undefined ? 0 : draftBlocks[parentIndex].depth + 1
          targetIndex = getBlockSubtreeEndIndex(draftBlocks, branchIndex) + 1
        }
        setDraftBlocks((previous) => {
          const next = targetIndex === activeBlockIndex
            ? prepareDraftBlockTypeChange(previous, activeBlockIndex, command.type) : [...previous]
          const target = next[activeBlockIndex]
          const inserted = { ...buildBlockTypePatch(command.type, command.templateContent!, false,
            targetIndex === activeBlockIndex ? target.depth : targetDepth,
            targetIndex === activeBlockIndex ? target.parentBlockId : targetParentId),
            ...(command.templateLanguage ? { language: command.templateLanguage, markdownFormat: { codeInfo: command.templateLanguage } } : {}) }
          next[activeBlockIndex] = { ...target, content: nextContent }
          if (targetIndex === activeBlockIndex) next[activeBlockIndex] = { ...next[activeBlockIndex], ...inserted, id: target.id }
          else next.splice(targetIndex, 0, inserted)
          return next
        })
        setActiveBlockIndex(targetIndex)
        setActiveCursorPosition(command.templateContent.length)
        setPendingFocusBlockIndex(targetIndex)
        return
      }
      setDraftBlocks((previous) => {
        const next = prepareDraftBlockTypeChange(previous, activeBlockIndex, command.type)
        const block = next[activeBlockIndex]
        next[activeBlockIndex] = { ...block, ...buildBlockTypePatch(command.type, nextContent,
          isTaskBlockType(command.type) ? currentBlock.checked : false, block.depth, block.parentBlockId ?? null) }
        return next
      })
      setActiveCursorPosition(slashRemoval.cursorPosition)
      setPendingFocusBlockIndex(activeBlockIndex)
      return
    }

    if (command.action === 'insert-above' || command.action === 'insert-below') {
      insertDraftBlockAt(
        activeBlockIndex + (command.action === 'insert-below' ? 1 : 0),
        activeBlockIndex,
        nextContent
      )
      return
    }

    if (command.action === 'insert-child') {
      insertChildDraftBlock(activeBlockIndex, nextContent)
      return
    }

    if (command.action === 'move-up' || command.action === 'move-down') {
      moveDraftBlockBySibling(
        activeBlockIndex,
        command.action === 'move-up' ? -1 : 1,
        slashRemoval.cursorPosition,
        nextContent
      )
      return
    }

    if (command.action === 'indent' || command.action === 'outdent') {
      if (!canBlockHaveParent(currentBlock.type)) {
        updateDraftBlock(activeBlockIndex, { content: nextContent })
        setActiveCursorPosition(slashRemoval.cursorPosition)
        setPendingFocusBlockIndex(activeBlockIndex)
        return
      }

      updateDraftBlock(activeBlockIndex, { content: nextContent })
      adjustBlockDepth(
        activeBlockIndex,
        command.action === 'indent' ? 1 : -1,
        slashRemoval.cursorPosition
      )
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
    clearBlockSelection,
    draftBlocks,
    duplicateDraftBlock,
    insertChildDraftBlock,
    insertDraftBlockAt,
    moveDraftBlockBySibling,
    pushToHistory,
    removeDraftBlock,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex,
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

    const slashRemoval = removeSlashCommand(
      currentBlock.content,
      activeSlashContext.start,
      activeCursorPosition
    )
    updateDraftBlock(activeBlockIndex, { content: slashRemoval.content })
    setActiveCursorPosition(slashRemoval.cursorPosition)
    setPendingFocusBlockIndex(activeBlockIndex)
  }, [activeBlockIndex, activeCursorPosition, activeSlashContext, draftBlocks, setActiveCursorPosition, setPendingFocusBlockIndex, updateDraftBlock])

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
