import { useLayoutEffect, useState } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'

type UseBlockFocusStateParams = {
  activeCursorPosition: number
  blockTextareaRefs: { current: Array<HTMLTextAreaElement | null> }
  captureBlockCursor: (index: number, element: HTMLTextAreaElement) => void
  draftBlocks: DocumentBlockDraft[]
  onRevealBlock?: (id: string) => void
}

export function useBlockFocusState({
  activeCursorPosition,
  blockTextareaRefs,
  captureBlockCursor,
  draftBlocks,
  onRevealBlock
}: UseBlockFocusStateParams) {
  const [pendingFocusBlockIndex, setPendingFocusBlockIndex] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (pendingFocusBlockIndex === null) {
      return
    }

    const targetId = draftBlocks[pendingFocusBlockIndex]?.id
    const focusTarget = () => {
      const textarea = blockTextareaRefs.current[pendingFocusBlockIndex]
      if (textarea) {
        textarea.focus()
        const cursor = Math.max(0, Math.min(activeCursorPosition, textarea.value.length))
        textarea.setSelectionRange(cursor, cursor)
        captureBlockCursor(pendingFocusBlockIndex, textarea)
      }
      setPendingFocusBlockIndex(null)
    }
    if (blockTextareaRefs.current[pendingFocusBlockIndex]) {
      focusTarget()
      return
    }
    // A new paragraph inside a folded chapter needs another render first.
    if (targetId) onRevealBlock?.(targetId)
    const frame = requestAnimationFrame(focusTarget)
    return () => cancelAnimationFrame(frame)
  }, [activeCursorPosition, blockTextareaRefs, captureBlockCursor, draftBlocks, onRevealBlock, pendingFocusBlockIndex])

  return {
    pendingFocusBlockIndex,
    setPendingFocusBlockIndex
  }
}
