import { useEffect, useState } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'

type UseBlockFocusStateParams = {
  activeCursorPosition: number
  blockTextareaRefs: { current: Array<HTMLTextAreaElement | null> }
  captureBlockCursor: (index: number, element: HTMLTextAreaElement) => void
  draftBlocks: DocumentBlockDraft[]
}

export function useBlockFocusState({
  activeCursorPosition,
  blockTextareaRefs,
  captureBlockCursor,
  draftBlocks
}: UseBlockFocusStateParams) {
  const [pendingFocusBlockIndex, setPendingFocusBlockIndex] = useState<number | null>(null)

  useEffect(() => {
    if (pendingFocusBlockIndex === null) {
      return
    }

    const textarea = blockTextareaRefs.current[pendingFocusBlockIndex]
    if (!textarea) {
      setPendingFocusBlockIndex(null)
      return
    }

    textarea.focus()
    const cursor = Math.max(0, Math.min(activeCursorPosition, textarea.value.length))
    textarea.setSelectionRange(cursor, cursor)
    captureBlockCursor(pendingFocusBlockIndex, textarea)
    setPendingFocusBlockIndex(null)
  }, [activeCursorPosition, blockTextareaRefs, captureBlockCursor, draftBlocks, pendingFocusBlockIndex])

  return {
    pendingFocusBlockIndex,
    setPendingFocusBlockIndex
  }
}