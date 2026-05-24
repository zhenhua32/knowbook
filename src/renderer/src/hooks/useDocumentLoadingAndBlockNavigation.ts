import { useEffect } from 'react'
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
  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocument(null)
      setDetailLoading(false)
      onNoDocumentSelected()
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
        onNoDocumentSelected()
        setDetailLoading(false)
        return
      }

      setSelectedDocument(detail)
      onDocumentLoaded(detail)
      setDetailLoading(false)
    }).catch(() => {
      if (mounted) {
        setDetailLoading(false)
      }
    })

    return () => {
      mounted = false
    }
  }, [onDocumentLoaded, onNoDocumentSelected, selectedDocumentId, setDetailLoading, setSelectedDocument])

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
      onPendingTargetMissing()
      return
    }

    onPendingTargetResolved(targetIndex, pendingBlockNavigationTarget.blockId)
    clearPendingTarget()
  }, [
    clearPendingTarget,
    draftBlocks,
    onPendingTargetMissing,
    onPendingTargetResolved,
    pendingBlockNavigationTarget,
    selectedDocument,
    selectedDocumentId
  ])
}
