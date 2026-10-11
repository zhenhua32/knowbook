import { useCallback, useLayoutEffect, useState, type SetStateAction } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { focusBlockTextarea } from '../utils/textareaLayout'

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
  const [pendingFocus, setPendingFocus] = useState<{ index: number; cursorPosition?: number } | null>(null)
  const pendingFocusBlockIndex = pendingFocus?.index ?? null
  const setPendingFocusBlockIndex = useCallback((next: SetStateAction<number | null>, cursorPosition?: number) => {
    setPendingFocus(previous => {
      const index = typeof next === 'function' ? next(previous?.index ?? null) : next
      return index === null ? null : { index, cursorPosition: cursorPosition ?? (typeof next === 'function' ? previous?.cursorPosition : undefined) }
    })
  }, [])

  useLayoutEffect(() => {
    if (pendingFocusBlockIndex === null) {
      return
    }

    const targetId = draftBlocks[pendingFocusBlockIndex]?.id
    const focusTarget = () => {
      const textarea = blockTextareaRefs.current[pendingFocusBlockIndex]
      if (textarea) {
        focusBlockTextarea(textarea)
        // A late selection callback from the old textarea must not replace the
        // caret requested by a structural edit in the same keyboard event.
        const cursor = Math.max(0, Math.min(pendingFocus?.cursorPosition ?? activeCursorPosition, textarea.value.length))
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
  }, [activeCursorPosition, blockTextareaRefs, captureBlockCursor, draftBlocks, onRevealBlock, pendingFocus, pendingFocusBlockIndex, setPendingFocusBlockIndex])

  return {
    pendingFocusBlockIndex,
    setPendingFocusBlockIndex
  }
}
