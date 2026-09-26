import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentIndexEntry, GlobalSearchResult } from '@shared/contracts'
import { getErrorMessage } from '../utils/errorMessage'

type UseGlobalDocumentSearchParams = {
  documentCatalog: DocumentIndexEntry[]
  onOpenDocument: (documentId: string) => void
}

export function useGlobalDocumentSearch({ documentCatalog, onOpenDocument }: UseGlobalDocumentSearchParams) {
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

  const openGlobalSearch = useCallback(() => {
    cancelPendingSearch()
    setGlobalSearchError(null)
    setGlobalSearchLoading(false)
    setIsGlobalSearchOpen(true)
    setGlobalSearchQuery('')
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

    if (!query.trim()) {
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

  const handleGlobalSearchNavigate = useCallback((result: GlobalSearchResult) => {
    const document = documentCatalog.find((entry) => entry.id === result.documentId)
    if (!document) {
      return
    }

    onOpenDocument(document.id)
    closeGlobalSearch()
  }, [closeGlobalSearch, documentCatalog, onOpenDocument])

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
