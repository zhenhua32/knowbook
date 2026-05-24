import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'

type BlockSelectionRange = {
  start: number
  end: number
}

type UseBlockInputActionsParams = {
  adjustPastedBlocksDepth: (blocks: DocumentBlockDraft[], targetDepth: number) => DocumentBlockDraft[]
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
  getNormalizedParentBlockId: (block: DocumentBlockDraft | undefined) => string | null
  looksLikeStructuredBlockPaste: (text: string) => boolean
  materializeDraftFragment: (blocks: DocumentBlockDraft[], rootParentBlockId: string | null) => DocumentBlockDraft[]
  normalizeCodeLanguage: (language: string | undefined | null) => string | undefined | null
  normalizePastedLineBlock: (template: DocumentBlockDraft, content: string) => DocumentBlockDraft
  parseStructuredPastedBlocks: (text: string) => DocumentBlockDraft[]
  pushToHistory: (blocks: DocumentBlockDraft[]) => void
  resolveMarkdownBlockShortcut: (block: DocumentBlockDraft) => DocumentBlockDraft | null
  selectedBlockRange: BlockSelectionRange | null
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  setPendingFocusBlockIndex: Dispatch<SetStateAction<number | null>>
  updateDraftBlock: (index: number, patch: Partial<DocumentBlockDraft>) => void
}

export function useBlockInputActions({
  adjustPastedBlocksDepth,
  buildBlockTypePatch,
  clearBlockSelection,
  detectCodeLanguage,
  draftBlocks,
  endBlockDrag,
  getMultiBlockOperationRange,
  getNormalizedParentBlockId,
  looksLikeStructuredBlockPaste,
  materializeDraftFragment,
  normalizeCodeLanguage,
  normalizePastedLineBlock,
  parseStructuredPastedBlocks,
  pushToHistory,
  resolveMarkdownBlockShortcut,
  selectedBlockRange,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  updateDraftBlock
}: UseBlockInputActionsParams) {
  const handleBlockContentChange = useCallback((index: number, content: string) => {
    const currentBlock = draftBlocks[index] ?? buildBlockTypePatch('paragraph', '')
    const shortcut = resolveMarkdownBlockShortcut({
      ...currentBlock,
      content
    })
    if (shortcut) {
      updateDraftBlock(index, shortcut)
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
    resolveMarkdownBlockShortcut,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setPendingFocusBlockIndex,
    updateDraftBlock
  ])

  const handleBlockPaste = useCallback((index: number, pastedText: string, selectionStart: number, selectionEnd: number) => {
    const currentBlock = draftBlocks[index]
    if (!currentBlock) {
      return false
    }
    pushToHistory(draftBlocks)

    const normalizedText = pastedText.replace(/\r\n?/g, '\n')
    const activeRange =
      selectedBlockRange && index >= selectedBlockRange.start && index <= selectedBlockRange.end
        ? getMultiBlockOperationRange(selectedBlockRange)
        : null

    if (activeRange) {
      const templateBlock = draftBlocks[activeRange.start] ?? currentBlock
      const lines = normalizedText.split('\n')
      let nextBlocks = looksLikeStructuredBlockPaste(normalizedText)
        ? parseStructuredPastedBlocks(normalizedText)
        : lines.filter((line) => line.trim() !== '').map((line) => normalizePastedLineBlock(templateBlock, line))

      if (nextBlocks.length === 0) {
        return false
      }

      nextBlocks = materializeDraftFragment(
        adjustPastedBlocksDepth(nextBlocks, templateBlock.depth),
        getNormalizedParentBlockId(templateBlock)
      )

      clearBlockSelection()
      setDraftBlocks((previous) => {
        const next = [...previous]
        next.splice(activeRange.start, activeRange.end - activeRange.start + 1, ...nextBlocks)
        return next
      })

      const focusIndex = activeRange.start + nextBlocks.length - 1
      const focusBlock = nextBlocks[nextBlocks.length - 1]
      setActiveBlockIndex(focusIndex)
      setActiveCursorPosition(focusBlock?.content.length ?? 0)
      setPendingFocusBlockIndex(focusIndex)
      endBlockDrag()
      return true
    }

    if (!normalizedText.includes('\n')) {
      return false
    }

    clearBlockSelection()

    const before = currentBlock.content.slice(0, selectionStart)
    const after = currentBlock.content.slice(selectionEnd)
    const lines = normalizedText.split('\n')
    const firstLine = lines[0] ?? ''
    const lastLine = lines[lines.length - 1] ?? ''
    const middleLines = lines.slice(1, -1).filter((line) => line.trim() !== '')
    const nextBlocks = materializeDraftFragment([
      normalizePastedLineBlock(currentBlock, `${before}${firstLine}`),
      ...middleLines.map((line) => normalizePastedLineBlock(currentBlock, line)),
      normalizePastedLineBlock(currentBlock, `${lastLine}${after}`)
    ], getNormalizedParentBlockId(currentBlock))

    setDraftBlocks((previous) => {
      const next = [...previous]
      next.splice(index, 1, ...nextBlocks)
      return next
    })

    const focusIndex = index + nextBlocks.length - 1
    setActiveBlockIndex(focusIndex)
    setActiveCursorPosition(lastLine.length)
    setPendingFocusBlockIndex(focusIndex)
    endBlockDrag()
    return true
  }, [
    adjustPastedBlocksDepth,
    clearBlockSelection,
    draftBlocks,
    endBlockDrag,
    getMultiBlockOperationRange,
    getNormalizedParentBlockId,
    looksLikeStructuredBlockPaste,
    materializeDraftFragment,
    normalizePastedLineBlock,
    parseStructuredPastedBlocks,
    pushToHistory,
    selectedBlockRange,
    setActiveBlockIndex,
    setActiveCursorPosition,
    setDraftBlocks,
    setPendingFocusBlockIndex
  ])

  return {
    handleBlockContentChange,
    handleBlockPaste
  }
}