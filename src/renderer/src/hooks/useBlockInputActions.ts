import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'

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
  getNormalizedParentBlockId: (block: DocumentBlockDraft | undefined) => string | null
  isNestableBlock: (type: DocumentBlockDraft['type']) => boolean
  materializeDraftFragment: (blocks: DocumentBlockDraft[], rootParentBlockId: string | null) => DocumentBlockDraft[]
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
  getNormalizedParentBlockId,
  isNestableBlock,
  materializeDraftFragment,
  normalizeCodeLanguage,
  pushToHistory,
  selectedBlockRange,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  setPendingFocusBlockIndex,
  updateDraftBlock
}: UseBlockInputActionsParams) {
  const resolveMarkdownBlockShortcut = useCallback((block: DocumentBlockDraft): DocumentBlockDraft | null => {
    const { type, content } = block
    const parentBlockId = block.parentBlockId ?? null

    if (content === '---') {
      return buildBlockTypePatch('divider', '', false, block.depth, parentBlockId)
    }

    if (content.startsWith('## ')) {
      return buildBlockTypePatch('heading-2', content.slice(3).replace(/^\s/, ''), false, block.depth, parentBlockId)
    }

    if (content.startsWith('# ')) {
      return buildBlockTypePatch('heading-1', content.slice(2).replace(/^\s/, ''), false, block.depth, parentBlockId)
    }

    if (content.startsWith('$$ ')) {
      return buildBlockTypePatch('math', content.slice(3).replace(/^\s/, ''), false, block.depth, parentBlockId)
    }

    if (content.startsWith('- [x] ') || content.startsWith('- [X] ')) {
      return buildBlockTypePatch('todo', content.slice(6).replace(/^\s/, ''), true, block.depth, parentBlockId)
    }

    if (content.startsWith('- [ ] ')) {
      return buildBlockTypePatch('todo', content.slice(6).replace(/^\s/, ''), false, block.depth, parentBlockId)
    }

    if (content.startsWith('> ')) {
      return buildBlockTypePatch('quote', content.slice(2).replace(/^\s/, ''), false, block.depth, parentBlockId)
    }

    if (content.startsWith('- ')) {
      return buildBlockTypePatch('bulleted-list', content.slice(2).replace(/^\s/, ''), false, block.depth, parentBlockId)
    }

    const orderedPrefix = content.match(/^\d+\.\s+/)?.[0]
    if (orderedPrefix) {
      return buildBlockTypePatch('numbered-list', content.slice(orderedPrefix.length).replace(/^\s/, ''), false, block.depth, parentBlockId)
    }

    if (content.startsWith('```') && ['paragraph', 'heading-1', 'heading-2', 'todo', 'quote', 'bulleted-list', 'numbered-list', 'math'].includes(type)) {
      return buildBlockTypePatch('code', content.slice(3).replace(/^\s/, ''), false, block.depth, parentBlockId)
    }

    return null
  }, [buildBlockTypePatch])

  const normalizePastedLineBlock = useCallback((template: DocumentBlockDraft, content: string): DocumentBlockDraft => {
    const draft = buildBlockTypePatch(template.type, content, template.checked, template.depth, template.parentBlockId ?? null)
    return resolveMarkdownBlockShortcut(draft) ?? draft
  }, [buildBlockTypePatch, resolveMarkdownBlockShortcut])

  const looksLikeStructuredBlockPaste = useCallback((text: string) => {
    return (
      /\n\s*\n/.test(text) ||
      /(^|\n)\s*```/.test(text) ||
      /(^|\n)\s*\$\$/.test(text) ||
      /(^|\n)##\s/.test(text) ||
      /(^|\n)#\s/.test(text) ||
      /(^|\n)>\s/.test(text) ||
      /(^|\n)\s*-\s\[[xX ]\]\s/.test(text) ||
      /(^|\n)\s*-\s/.test(text) ||
      /(^|\n)\s*\d+\.\s/.test(text) ||
      /(^|\n)\s*---\s*(\n|$)/.test(text)
    )
  }, [])

  const adjustPastedBlocksDepth = useCallback((blocks: DocumentBlockDraft[], targetDepth: number): DocumentBlockDraft[] => {
    if (blocks.length === 0) {
      return blocks
    }

    const minDepth = Math.min(...blocks.map((block) => block.depth))
    if (minDepth === targetDepth) {
      return blocks
    }

    const depthDelta = targetDepth - minDepth
    const adjusted = blocks.map((block) => ({
      ...block,
      depth: Math.max(0, block.depth + depthDelta)
    }))

    const normalized: DocumentBlockDraft[] = []
    for (const block of adjusted) {
      if (normalized.length === 0) {
        normalized.push(block)
        continue
      }

      const prevBlock = normalized[normalized.length - 1]
      const maxAllowedDepth = prevBlock.depth + 1

      if (isNestableBlock(block.type) && block.depth > maxAllowedDepth) {
        normalized.push({
          ...block,
          depth: maxAllowedDepth
        })
      } else {
        normalized.push(block)
      }
    }

    return normalized
  }, [isNestableBlock])

  const parseStructuredPastedBlocks = useCallback((text: string): DocumentBlockDraft[] => {
    const blocks: DocumentBlockDraft[] = []
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    let paragraphLines: string[] = []

    const flushParagraph = () => {
      if (paragraphLines.length === 0) {
        return
      }

      blocks.push(buildBlockTypePatch('paragraph', paragraphLines.join('\n')))
      paragraphLines = []
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const trimmed = line.trim()

      if (trimmed === '') {
        flushParagraph()
        continue
      }

      if (trimmed === '$$') {
        flushParagraph()
        const mathLines: string[] = []
        index += 1
        while (index < lines.length && lines[index].trim() !== '$$') {
          mathLines.push(lines[index])
          index += 1
        }
        blocks.push(buildBlockTypePatch('math', mathLines.join('\n')))
        continue
      }

      if (trimmed.startsWith('```')) {
        flushParagraph()
        const fencedLanguage = normalizeCodeLanguage(trimmed.slice(3).trim())
        const codeLines: string[] = []
        index += 1
        while (index < lines.length && !lines[index].trim().startsWith('```')) {
          codeLines.push(lines[index])
          index += 1
        }
        blocks.push({
          ...buildBlockTypePatch('code', codeLines.join('\n')),
          language: fencedLanguage ?? undefined
        })
        continue
      }

      if (trimmed === '---') {
        flushParagraph()
        blocks.push(buildBlockTypePatch('divider', ''))
        continue
      }

      const todoMatch = line.match(/^(\s*)-\s\[([xX ])\]\s+(.*)$/)
      if (todoMatch) {
        flushParagraph()
        blocks.push(buildBlockTypePatch('todo', todoMatch[3], todoMatch[2].toLowerCase() === 'x', Math.floor(todoMatch[1].length / 2)))
        continue
      }

      const bulletMatch = line.match(/^(\s*)-\s+(.*)$/)
      if (bulletMatch) {
        flushParagraph()
        blocks.push(buildBlockTypePatch('bulleted-list', bulletMatch[2], false, Math.floor(bulletMatch[1].length / 2)))
        continue
      }

      const numberedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/)
      if (numberedMatch) {
        flushParagraph()
        blocks.push(buildBlockTypePatch('numbered-list', numberedMatch[2], false, Math.floor(numberedMatch[1].length / 2)))
        continue
      }

      if (line.startsWith('## ')) {
        flushParagraph()
        blocks.push(buildBlockTypePatch('heading-2', line.slice(3).replace(/^\s/, '')))
        continue
      }

      if (line.startsWith('# ')) {
        flushParagraph()
        blocks.push(buildBlockTypePatch('heading-1', line.slice(2).replace(/^\s/, '')))
        continue
      }

      if (line.startsWith('$$ ')) {
        flushParagraph()
        blocks.push(buildBlockTypePatch('math', line.slice(3).replace(/^\s/, '')))
        continue
      }

      if (line.startsWith('> ')) {
        flushParagraph()
        const quoteLines = [line.slice(2)]
        while (index + 1 < lines.length && lines[index + 1].startsWith('> ')) {
          index += 1
          quoteLines.push(lines[index].slice(2))
        }
        blocks.push(buildBlockTypePatch('quote', quoteLines.join('\n')))
        continue
      }

      paragraphLines.push(line)
    }

    flushParagraph()
    return blocks
  }, [buildBlockTypePatch, normalizeCodeLanguage])

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