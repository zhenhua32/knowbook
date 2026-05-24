import { useCallback, useState } from 'react'
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

  const openGlobalSearch = useCallback(() => {
    setIsGlobalSearchOpen(true)
    setGlobalSearchQuery('')
    setGlobalSearchResults([])
  }, [])

  const closeGlobalSearch = useCallback(() => {
    setIsGlobalSearchOpen(false)
    setGlobalSearchQuery('')
    setGlobalSearchResults([])
  }, [])

  const updateGlobalSearchQuery = useCallback(async (query: string) => {
    setGlobalSearchQuery(query)

    if (!query.trim()) {
      setGlobalSearchResults([])
      setGlobalSearchLoading(false)
      return
    }

    setGlobalSearchLoading(true)
    try {
      const results = await window.knowbook.searchDocuments(query)
      setGlobalSearchResults(results)
    } finally {
      setGlobalSearchLoading(false)
    }
  }, [])

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