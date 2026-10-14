import { useCallback, useRef } from 'react'
import type { InlineReferenceNavigationContext } from '../utils/inlineReferenceTargets'

type UseInlineReferenceNavigationParams = Omit<InlineReferenceNavigationContext, 'isCurrent'>
export function useInlineReferenceNavigation({
  documentTree,
  draftBlocks,
  onOpenDocument,
  onOpenDocumentBlock,
  onOpenAnchor,
  draftTitle,
  selectedDocumentId,
  notify,
  uiBlockReferenceNotFound
}: UseInlineReferenceNavigationParams) {
  const activeDocument = useRef(selectedDocumentId), request = useRef(0)
  if (activeDocument.current !== selectedDocumentId) { activeDocument.current = selectedDocumentId; request.current += 1 }

  return useCallback(async (content: string, cursorPosition: number) => {
    const sequence = ++request.current
    const isCurrent = () => request.current === sequence && activeDocument.current === selectedDocumentId
    try {
      const { navigateInlineReference } = await import("../utils/inlineReferenceTargets")
      if (!isCurrent()) return
      return navigateInlineReference(content, cursorPosition, { documentTree, draftBlocks, onOpenDocument, onOpenDocumentBlock,
        onOpenAnchor, draftTitle, selectedDocumentId, notify, uiBlockReferenceNotFound, isCurrent })
    } catch (error) {
      if (isCurrent()) notify(error instanceof Error ? error.message : uiBlockReferenceNotFound, "error")
    }
  }, [
    documentTree,
    draftBlocks,
    onOpenDocument,
    onOpenDocumentBlock,
    onOpenAnchor,
    draftTitle,
    selectedDocumentId,
    notify,
    uiBlockReferenceNotFound
  ])
}
