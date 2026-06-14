import { useCallback, useMemo, useState } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'

type UseBlockSearchStateParams = {
  activeBlockIndex: number | null
  draftBlocks: DocumentBlockDraft[]
  onSelectBlock: (blockIndex: number) => void
}

export function useBlockSearchState({ activeBlockIndex, draftBlocks, onSelectBlock }: UseBlockSearchStateParams) {
  const [blockSearchQuery, setBlockSearchQuery] = useState('')
  const [isBlockSearchOpen, setIsBlockSearchOpen] = useState(false)

  const blockSearchItems = useMemo(() => {
    if (!blockSearchQuery.trim() || draftBlocks.length === 0) {
      return []
    }

    const query = blockSearchQuery.toLowerCase()
    return draftBlocks
      .filter((block) => {
        const content = block.content.toLowerCase()
        const type = block.type.toLowerCase()
        return content.includes(query) || type.includes(query)
      })
      .map((block) => {
        const blockIndex = draftBlocks.indexOf(block)
        return {
          contentPreview: block.content.slice(0, 100),
          index: blockIndex,
          isHighlighted: activeBlockIndex === blockIndex,
          type: block.type
        }
      })
  }, [activeBlockIndex, blockSearchQuery, draftBlocks])

  const openBlockSearch = useCallback(() => {
    setIsBlockSearchOpen(true)
  }, [])

  const closeBlockSearch = useCallback(() => {
    setIsBlockSearchOpen(false)
    setBlockSearchQuery('')
  }, [])

  const handleBlockSearchSelect = useCallback((blockIndex: number) => {
    onSelectBlock(blockIndex)
  }, [onSelectBlock])

  return {
    blockSearchItems,
    blockSearchQuery,
    closeBlockSearch,
    handleBlockSearchSelect,
    isBlockSearchOpen,
    openBlockSearch,
    setBlockSearchQuery
  }
}