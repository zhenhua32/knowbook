import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { getMarkdownShortcut, parsePastedMarkdown } from '../utils/markdownInput'
import { materializePastedDraftFragment, planDraftBlockPaste } from '../utils/draftTreePaste'

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
  setPendingFocusBlockIndex: (index: number | null, cursorPosition?: number) => void
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
      setPendingFocusBlockIndex(index, shortcut.content.length)
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
    let nextBlocks = materializePastedDraftFragment(parsed.map((block) => ({
      ...block,
      language: block.type === 'code' ? normalizeCodeLanguage(block.language) ?? detectCodeLanguage(block.content) ?? undefined : undefined
    })), template)
    if (!nextBlocks) {
      // The editor represents six nested levels. Preserve deeper Markdown
      // verbatim inside one block, so paste never discards its hierarchy.
      nextBlocks = materializePastedDraftFragment([activeRange
        ? buildBlockTypePatch('paragraph', text) : { ...current, content: before + text + after }], template)
    }
    if (!nextBlocks) return false
    const range = activeRange ?? { start, end: start }
    const plan = planDraftBlockPaste(draftBlocks, range, nextBlocks, !activeRange)
    if (!plan) return false
    pushToHistory(draftBlocks)
    clearBlockSelection()
    const fragment = nextBlocks
    setDraftBlocks(previous => planDraftBlockPaste(previous, range, fragment, !activeRange)?.blocks ?? previous)
    const cursor = Math.max(0, nextBlocks.at(-1)!.content.length - after.length)
    setActiveBlockIndex(plan.focusIndex)
    setActiveCursorPosition(cursor)
    setPendingFocusBlockIndex(plan.focusIndex, cursor)
    endBlockDrag()
    return true
  }, [buildBlockTypePatch, draftBlocks, selectedBlockRange, getMultiBlockOperationRange, normalizeCodeLanguage, detectCodeLanguage,
    pushToHistory, clearBlockSelection, setDraftBlocks, setActiveBlockIndex, setActiveCursorPosition,
    setPendingFocusBlockIndex, endBlockDrag])

  return { handleBlockContentChange, handleBlockPaste }
}
