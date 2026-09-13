import { useCallback, useMemo, useState } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { findBlockSearchMatches } from '../utils/blockSearch'

type UseBlockSearchStateParams = {
  draftBlocks: DocumentBlockDraft[]
  onSelectBlock: (blockIndex: number) => void
}

export function useBlockSearchState({ draftBlocks, onSelectBlock }: UseBlockSearchStateParams) {
  const [blockSearchQuery, setBlockSearchQuery] = useState('')
  const [isBlockSearchOpen, setIsBlockSearchOpen] = useState(false)

  const blockSearchItems = useMemo(() => {
    return findBlockSearchMatches(draftBlocks, blockSearchQuery)
  }, [blockSearchQuery, draftBlocks])

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
