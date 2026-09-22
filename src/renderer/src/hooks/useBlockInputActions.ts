import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { isNestableBlock } from '../utils/draftBlockShape'
import { getMarkdownShortcut, parsePastedMarkdown } from '../utils/markdownInput'
import { materializeDraftFragment } from '../utils/draftTreeFragment'
import { getNormalizedParentBlockId } from '../utils/draftTreeMove'

type BlockSelectionRange = {
  start: number
  end: number
}

type UseBlockInputActionsParams = {
  buildBlockTypePatch: (
    type: DocumentBlockDraft['type'],
    content: string,
    checked?: boolean,
    depth?: number,
    parentBlockId?: string | null
  ) => DocumentBlockDraft
  clearBlockSelection: () => void
  detectCodeLanguage: (content: string) => string | undefined | null
  draftBlocks: DocumentBlockDraft[]
  endBlockDrag: () => void
  getMultiBlockOperationRange: (range: BlockSelectionRange) => BlockSelectionRange
  normalizeCodeLanguage: (language: string | undefined | null) => string | undefined | null
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  selectedBlockRange: BlockSelectionRange | null
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: Dispatch<SetStateAction<number | null>>
  updateDraftBlock: (index: number, patch: Partial<DocumentBlockDraft>) => void
}

export function useBlockInputActions({
  buildBlockTypePatch,
  clearBlockSelection,
  detectCodeLanguage,
  draftBlocks,
  endBlockDrag,
  getMultiBlockOperationRange,
  normalizeCodeLanguage,
  pushToHistory,
  selectedBlockRange,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  updateDraftBlock
}: UseBlockInputActionsParams) {
  const handleBlockContentChange = useCallback((index: number, content: string) => {
    const currentBlock = draftBlocks[index] ?? buildBlockTypePatch('paragraph', '')
    const shortcut = getMarkdownShortcut(currentBlock, content)
    if (shortcut) {
      updateDraftBlock(index, { ...shortcut,
        language: shortcut.type === 'code' ? normalizeCodeLanguage(shortcut.language) ?? detectCodeLanguage(shortcut.content) ?? undefined : undefined
      })
      setActiveBlockIndex(index)
      setActiveCursorPosition(shortcut.content.length)
      setPendingFocusBlockIndex(index)
      return
    }

    updateDraftBlock(index, {
      content,
      ...(currentBlock.type === 'code' && !normalizeCodeLanguage(currentBlock.language)
        ? { language: detectCodeLanguage(content) ?? undefined }
        : {})
    })
  }, [
    buildBlockTypePatch,
    detectCodeLanguage,
    draftBlocks,
    normalizeCodeLanguage,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setPendingFocusBlockIndex,
    updateDraftBlock
  ])

  const handleBlockPaste = useCallback((index: number, pastedText: string, selectionStart: number, selectionEnd: number) => {
    const current = draftBlocks[index]
    if (!current) return false
    const activeRange = selectedBlockRange && index >= selectedBlockRange.start && index <= selectedBlockRange.end
      ? getMultiBlockOperationRange(selectedBlockRange) : null
    // Source editors own their newlines. Pasting code must never invoke shortcuts.
    if (!activeRange && ['code', 'math', 'table', 'frontmatter', 'html'].includes(current.type)) return false
    const text = pastedText.replace(/\r\n?/g, '\n')
    if (!activeRange && !text.includes('\n')) return false
    const start = activeRange?.start ?? index
    const template = draftBlocks[start]
    const before = activeRange ? '' : current.content.slice(0, selectionStart)
    const after = activeRange ? '' : current.content.slice(selectionEnd)
    let parsed = parsePastedMarkdown(before + text + after)
    if (!parsed.length) return false
    // A plain multiline paste inside an existing block retains that block's type.
    if (!activeRange && parsed.length === 1 && parsed[0].type === 'paragraph') {
      parsed = [{ ...current, content: before + text + after }]
    }
    const baseDepth = Math.min(...parsed.map((block) => block.depth))
    const nextBlocks = materializeDraftFragment(parsed.map((block) => ({
      ...block,
      depth: isNestableBlock(block.type) ? block.depth - baseDepth + template.depth : 0,
      language: block.type === 'code' ? normalizeCodeLanguage(block.language) ?? detectCodeLanguage(block.content) ?? undefined : undefined
    })), getNormalizedParentBlockId(template))
    // Editing a single block should preserve its ID and all incoming references.
    if (!activeRange && nextBlocks.length && current.id) {
      const generatedId = nextBlocks[0].id
      nextBlocks[0].id = current.id
      nextBlocks[0].tags = current.tags
      nextBlocks[0].highlight = current.highlight
      for (const block of nextBlocks) if (block.parentBlockId === generatedId) block.parentBlockId = current.id
    }
    pushToHistory(draftBlocks)
    clearBlockSelection()
    setDraftBlocks((previous) => {
      const next = [...previous]
      next.splice(start, activeRange ? activeRange.end - start + 1 : 1, ...nextBlocks)
      return next
    })
    const focusIndex = start + nextBlocks.length - 1
    setActiveBlockIndex(focusIndex)
    setActiveCursorPosition(Math.max(0, nextBlocks.at(-1)!.content.length - after.length))
    setPendingFocusBlockIndex(focusIndex)
    endBlockDrag()
    return true
  }, [draftBlocks, selectedBlockRange, getMultiBlockOperationRange, normalizeCodeLanguage, detectCodeLanguage,
    pushToHistory, clearBlockSelection, setDraftBlocks, setActiveBlockIndex, setActiveCursorPosition,
    setPendingFocusBlockIndex, endBlockDrag])

  return { handleBlockContentChange, handleBlockPaste }
}
