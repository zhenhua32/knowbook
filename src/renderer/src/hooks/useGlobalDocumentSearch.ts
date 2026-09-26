import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSearchResult } from '@shared/contracts'
import { getErrorMessage } from '../utils/errorMessage'

type UseGlobalDocumentSearchParams = {
  onOpenDocument: (documentId: string) => boolean | void | Promise<boolean | void>
  onOpenBlock?: (documentId: string, blockId: string) => boolean | void | Promise<boolean | void>
}

export function useGlobalDocumentSearch({ onOpenDocument, onOpenBlock }: UseGlobalDocumentSearchParams) {
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchResult[]>([])
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false)
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false)
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestSequenceRef = useRef(0)

  const cancelPendingSearch = useCallback(() => {
    searchRequestSequenceRef.current += 1
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
  }, [])

  useEffect(() => cancelPendingSearch, [cancelPendingSearch])

  const openGlobalSearch = useCallback((mode?: 'commands') => {
    cancelPendingSearch()
    setGlobalSearchError(null)
    setGlobalSearchLoading(false)
    setIsGlobalSearchOpen(true)
    setGlobalSearchQuery(mode === 'commands' ? '>' : '')
    setGlobalSearchResults([])
  }, [cancelPendingSearch])

  const closeGlobalSearch = useCallback(() => {
    cancelPendingSearch()
    setIsGlobalSearchOpen(false)
    setGlobalSearchQuery('')
    setGlobalSearchResults([])
    setGlobalSearchLoading(false)
    setGlobalSearchError(null)
  }, [cancelPendingSearch])

  const updateGlobalSearchQuery = useCallback((query: string) => {
    cancelPendingSearch()
    setGlobalSearchQuery(query)
    setGlobalSearchError(null)
    setGlobalSearchResults([])

    if (!query.trim() || query.trimStart().startsWith('>')) {
      setGlobalSearchResults([])
      setGlobalSearchLoading(false)
      return
    }

    setGlobalSearchLoading(true)
    const requestSequence = searchRequestSequenceRef.current
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null
      void window.knowbook.searchDocuments(query).then((results) => {
        if (searchRequestSequenceRef.current === requestSequence) {
          setGlobalSearchResults(results)
        }
      }).catch((error) => {
        if (searchRequestSequenceRef.current === requestSequence) {
          setGlobalSearchResults([])
          setGlobalSearchError(getErrorMessage(error, 'Search could not be completed.'))
          console.warn('Failed to search documents.', error)
        }
      }).finally(() => {
        if (searchRequestSequenceRef.current === requestSequence) {
          setGlobalSearchLoading(false)
        }
      })
    }, 160)
  }, [cancelPendingSearch])

  const handleGlobalSearchNavigate = useCallback(async (result: GlobalSearchResult, documentOnly = false) => {
    const sequence = searchRequestSequenceRef.current
    const opened = result.blockId && onOpenBlock && !documentOnly
      ? await onOpenBlock(result.documentId, result.blockId)
      : await onOpenDocument(result.documentId)
    // A blocked save must keep the query; a late completion must not close a new search.
    if (opened === false) return false
    if (sequence === searchRequestSequenceRef.current) closeGlobalSearch()
    return true
  }, [closeGlobalSearch, onOpenDocument, onOpenBlock])

  return {
    closeGlobalSearch,
    globalSearchLoading,
    globalSearchError,
    retryGlobalSearch: () => updateGlobalSearchQuery(globalSearchQuery),
    globalSearchQuery,
    globalSearchResults,
    handleGlobalSearchNavigate,
    isGlobalSearchOpen,
    openGlobalSearch,
    updateGlobalSearchQuery
  }
}
