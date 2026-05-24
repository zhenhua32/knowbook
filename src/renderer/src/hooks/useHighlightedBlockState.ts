import { useCallback, useEffect, useRef, useState } from 'react'

export function useHighlightedBlockState() {
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null)
  const highlightedBlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashHighlightedBlock = useCallback((blockId: string) => {
    setHighlightedBlockId(blockId)
    if (highlightedBlockTimerRef.current) {
      clearTimeout(highlightedBlockTimerRef.current)
    }

    highlightedBlockTimerRef.current = setTimeout(() => {
      setHighlightedBlockId((current) => (current === blockId ? null : current))
      highlightedBlockTimerRef.current = null
    }, 2200)
  }, [])

  useEffect(() => {
    return () => {
      if (highlightedBlockTimerRef.current) {
        clearTimeout(highlightedBlockTimerRef.current)
      }
    }
  }, [])

  return {
    flashHighlightedBlock,
    highlightedBlockId,
    setHighlightedBlockId
  }
}