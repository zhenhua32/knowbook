import { useEffect, useRef } from 'react'
import type { DocumentBlockDraft, DocumentDetail } from '@shared/contracts'
import type { PendingBlockNavigationTarget } from './useDocumentNavigationState'

type UseDocumentLoadingAndBlockNavigationParams = {
  selectedDocumentId: string | null
  selectedDocument: DocumentDetail | null
  setSelectedDocument: (detail: DocumentDetail | null) => void
  setDetailLoading: (loading: boolean) => void
  clearPendingTarget: () => void
  pendingBlockNavigationTarget: PendingBlockNavigationTarget | null
  draftBlocks: DocumentBlockDraft[]
  onNoDocumentSelected: () => void
  onDocumentLoaded: (detail: DocumentDetail) => void
  onPendingTargetResolved: (targetIndex: number, blockId: string) => void
  onPendingTargetMissing: () => void
}

export function useDocumentLoadingAndBlockNavigation({
  selectedDocumentId,
  selectedDocument,
  setSelectedDocument,
  setDetailLoading,
  clearPendingTarget,
  pendingBlockNavigationTarget,
  draftBlocks,
  onNoDocumentSelected,
  onDocumentLoaded,
  onPendingTargetResolved,
  onPendingTargetMissing
}: UseDocumentLoadingAndBlockNavigationParams) {
  const callbackRef = useRef({
    onDocumentLoaded,
    onNoDocumentSelected,
    onPendingTargetMissing,
    onPendingTargetResolved
  })

  callbackRef.current = {
    onDocumentLoaded,
    onNoDocumentSelected,
    onPendingTargetMissing,
    onPendingTargetResolved
  }

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocument(null)
      setDetailLoading(false)
      callbackRef.current.onNoDocumentSelected()
      return
    }

    let mounted = true
    setDetailLoading(true)

    window.knowbook.getDocumentDetail(selectedDocumentId).then((detail) => {
      if (!mounted) {
        return
      }

      if (!detail) {
        setSelectedDocument(null)
        callbackRef.current.onNoDocumentSelected()
        setDetailLoading(false)
        return
      }

      setSelectedDocument(detail)
      callbackRef.current.onDocumentLoaded(detail)
      setDetailLoading(false)
    }).catch(() => {
      if (mounted) {
        setDetailLoading(false)
      }
    })

    return () => {
      mounted = false
    }
  }, [selectedDocumentId, setDetailLoading, setSelectedDocument])

  useEffect(() => {
    if (!pendingBlockNavigationTarget || pendingBlockNavigationTarget.documentId !== selectedDocumentId) {
      return
    }

    if (!selectedDocument) {
      return
    }

    const targetIndex = draftBlocks.findIndex((block) => block.id === pendingBlockNavigationTarget.blockId)
    if (targetIndex === -1) {
      clearPendingTarget()
      callbackRef.current.onPendingTargetMissing()
      return
    }

    callbackRef.current.onPendingTargetResolved(targetIndex, pendingBlockNavigationTarget.blockId)
    clearPendingTarget()
  }, [
    clearPendingTarget,
    draftBlocks,
    pendingBlockNavigationTarget,
    selectedDocument,
    selectedDocumentId
  ])
}
