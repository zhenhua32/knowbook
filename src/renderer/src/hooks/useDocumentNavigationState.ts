import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentDetail } from '@shared/contracts'

export type PendingBlockNavigationTarget = {
  documentId: string
  blockId: string
}

type UseDocumentNavigationStateParams = {
  onActivePageChange: (page: 'documents') => void
}

export function useDocumentNavigationState({ onActivePageChange }: UseDocumentNavigationStateParams) {
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetail | null>(null)
  const [pendingBlockNavigationTarget, setPendingBlockNavigationTarget] = useState<PendingBlockNavigationTarget | null>(null)
  const [pinnedDocumentIds, setPinnedDocumentIds] = useState<Set<string>>(new Set())
  const [navCanGoBack, setNavCanGoBack] = useState(false)
  const [navCanGoForward, setNavCanGoForward] = useState(false)
  const navHistoryRef = useRef<string[]>([])
  const navPointerRef = useRef<number>(-1)
  const isNavJumpRef = useRef<boolean>(false)

  const openDocumentInDocumentsPage = useCallback((documentId: string) => {
    setPendingBlockNavigationTarget(null)
    setSelectedDocumentId(documentId)
    onActivePageChange('documents')
  }, [onActivePageChange])

  const openDocumentBlockInDocumentsPage = useCallback((documentId: string, blockId: string) => {
    setPendingBlockNavigationTarget({ documentId, blockId })
    setSelectedDocumentId(documentId)
    onActivePageChange('documents')
  }, [onActivePageChange])

  const togglePinDocument = useCallback((documentId: string) => {
    setPinnedDocumentIds((previous) => {
      const next = new Set(previous)
      if (next.has(documentId)) {
        next.delete(documentId)
      } else {
        next.add(documentId)
      }
      void window.knowbook.saveSetting('pinned_documents', JSON.stringify([...next]))
      return next
    })
  }, [])

  const navBack = useCallback(() => {
    const pointer = navPointerRef.current
    if (pointer <= 0) {
      return
    }

    const newPointer = pointer - 1
    navPointerRef.current = newPointer
    isNavJumpRef.current = true
    setSelectedDocumentId(navHistoryRef.current[newPointer])
    setNavCanGoBack(newPointer > 0)
    setNavCanGoForward(true)
  }, [])

  const navForward = useCallback(() => {
    const history = navHistoryRef.current
    const pointer = navPointerRef.current
    if (pointer >= history.length - 1) {
      return
    }

    const newPointer = pointer + 1
    navPointerRef.current = newPointer
    isNavJumpRef.current = true
    setSelectedDocumentId(history[newPointer])
    setNavCanGoBack(true)
    setNavCanGoForward(newPointer < history.length - 1)
  }, [])

  useEffect(() => {
    let mounted = true

    window.knowbook.getSetting('pinned_documents').then((value) => {
      if (!mounted || !value) {
        return
      }

      try {
        const ids: string[] = JSON.parse(value)
        setPinnedDocumentIds(new Set(ids))
      } catch {
        // Ignore invalid persisted pinned document payloads.
      }
    })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!selectedDocumentId) {
      return
    }

    if (isNavJumpRef.current) {
      isNavJumpRef.current = false
      return
    }

    const history = navHistoryRef.current
    const pointer = navPointerRef.current
    const trimmed = history.slice(0, pointer + 1)
    trimmed.push(selectedDocumentId)
    navHistoryRef.current = trimmed.slice(-50)
    navPointerRef.current = navHistoryRef.current.length - 1
    setNavCanGoBack(navPointerRef.current > 0)
    setNavCanGoForward(false)
  }, [selectedDocumentId])

  return {
    detailLoading,
    navBack,
    navCanGoBack,
    navCanGoForward,
    navForward,
    openDocumentBlockInDocumentsPage,
    openDocumentInDocumentsPage,
    pendingBlockNavigationTarget,
    pinnedDocumentIds,
    selectedDocument,
    selectedDocumentId,
    setDetailLoading,
    setPendingBlockNavigationTarget,
    setSelectedDocument,
    setSelectedDocumentId,
    togglePinDocument
  }
}
