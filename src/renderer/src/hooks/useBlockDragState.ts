import { useCallback, useState } from 'react'

export function useBlockDragState() {
  const [draggingBlockIndex, setDraggingBlockIndex] = useState<number | null>(null)
  const [dragOverBlockIndex, setDragOverBlockIndex] = useState<number | null>(null)
  const [dragOverBlockDepth, setDragOverBlockDepth] = useState<number | null>(null)

  const endBlockDrag = useCallback(() => {
    setDraggingBlockIndex(null)
    setDragOverBlockIndex(null)
    setDragOverBlockDepth(null)
  }, [])

  return {
    dragOverBlockDepth,
    dragOverBlockIndex,
    draggingBlockIndex,
    endBlockDrag,
    setDragOverBlockDepth,
    setDragOverBlockIndex,
    setDraggingBlockIndex
  }
}