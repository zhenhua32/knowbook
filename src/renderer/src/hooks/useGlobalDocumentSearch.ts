import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentCatalogEntry, GlobalSearchResult } from '@shared/contracts'

type UseGlobalDocumentSearchParams = {
  documentCatalog: DocumentCatalogEntry[]
  onOpenDocument: (documentId: string) => void
}

export function useGlobalDocumentSearch({ documentCatalog, onOpenDocument }: UseGlobalDocumentSearchParams) {
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [globalSearchResults, setGlobalSearchResults] = useState<GlobalSearchResult[]>([])
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false)
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false)
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
    setIsGlobalSearchOpen(true)
    setGlobalSearchQuery('')
    setGlobalSearchResults([])
  }, [])

  const closeGlobalSearch = useCallback(() => {
    cancelPendingSearch()
    setIsGlobalSearchOpen(false)
    setGlobalSearchQuery('')
    setGlobalSearchResults([])
    setGlobalSearchLoading(false)
  }, [cancelPendingSearch])

  const updateGlobalSearchQuery = useCallback((query: string) => {
    cancelPendingSearch()
    setGlobalSearchQuery(query)

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
    globalSearchQuery,
    globalSearchResults,
    handleGlobalSearchNavigate,
    isGlobalSearchOpen,
    openGlobalSearch,
    updateGlobalSearchQuery
  }
}
