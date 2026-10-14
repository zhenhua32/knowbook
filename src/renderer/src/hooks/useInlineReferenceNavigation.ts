import type { AppMessageHandler } from '../notify'
import { useCallback, useRef } from 'react'
import type { DocumentBlockDraft, DocumentTreeNode } from '@shared/contracts'

type UseInlineReferenceNavigationParams = {
  documentTree: DocumentTreeNode[]
  draftBlocks: DocumentBlockDraft[]
  onOpenDocument: (documentId: string) => void
  onOpenDocumentBlock: (documentId: string, blockId: string) => void
  onOpenAnchor: (documentId: string, anchor: string) => void
  draftTitle: string
  selectedDocumentId: string | null
  notify: AppMessageHandler
  uiBlockReferenceNotFound: string
}
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
      const { getInlineReferenceTokenAtCursor, resolveInlineReferenceTarget, findInlineReferenceHeading, buildDocumentReferences, buildInlineBlockReferences } = await import("../utils/inlineReferenceTargets")
      if (!isCurrent()) return
      const token = getInlineReferenceTokenAtCursor(content, cursorPosition)
      if (!token) {
        return
      }

      const documentReferences = buildDocumentReferences(documentTree)
      const blockReferences = buildInlineBlockReferences(draftBlocks)

      const target = resolveInlineReferenceTarget(token, documentReferences, blockReferences, selectedDocumentId)
      if (!target) {
        notify(uiBlockReferenceNotFound, 'warning')
        return
      }

      if (target.type === 'document') {
        onOpenDocument(target.documentId)
        return
      }

      if (target.type === 'block') {
        onOpenDocumentBlock(target.documentId, target.blockId)
        return
      }

      try {
        const block = await window.knowbook.getBlockReference(target.documentPath, target.blockId)
        if (!isCurrent()) return
        if (block) { onOpenDocumentBlock(block.documentId, block.block.id); return }
      } catch (error) {
        if (isCurrent()) notify(error instanceof Error ? error.message : uiBlockReferenceNotFound, 'error')
        return
      }
      if (target.blockId.startsWith('^')) { notify(uiBlockReferenceNotFound, 'warning'); return }
      const document = documentReferences.find((entry) => entry.path === target.documentPath)
      const detail = document && (document.id === selectedDocumentId ? { id: document.id, title: draftTitle, blocks: draftBlocks }
        : await window.knowbook.getDocumentDetail(document.id))
      if (!isCurrent()) return
      if (!detail) {
        notify(uiBlockReferenceNotFound, 'warning')
        return
      }
      if (detail.blocks.some((block) => block.id === target.blockId)) onOpenDocumentBlock(detail.id, target.blockId)
      else {
        const heading = findInlineReferenceHeading(target.blockId, detail.blocks, detail.title)
        if (heading) onOpenAnchor(detail.id, heading.slug)
        else notify(uiBlockReferenceNotFound, 'warning')
      }
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
