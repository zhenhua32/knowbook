import { useCallback, useMemo } from 'react'
import type { DocumentBlockDraft, DocumentTreeNode } from '@shared/contracts'
import {
  getInlineReferenceTokenAtCursor,
  resolveInlineReferenceTarget
} from '../components/InlineContentRenderer'

type DocumentReferenceEntry = {
  id: string
  title: string
  path: string
}

type UseInlineReferenceNavigationParams = {
  documentTree: DocumentTreeNode[]
  draftBlocks: DocumentBlockDraft[]
  onOpenDocument: (documentId: string) => void
  onOpenDocumentBlock: (documentId: string, blockId: string) => void
  selectedDocumentId: string | null
  setBackupMessage: (message: string | null) => void
  uiBlockReferenceNotFound: string
}

export function useInlineReferenceNavigation({
  documentTree,
  draftBlocks,
  onOpenDocument,
  onOpenDocumentBlock,
  selectedDocumentId,
  setBackupMessage,
  uiBlockReferenceNotFound
}: UseInlineReferenceNavigationParams) {
  const documentReferences = useMemo(() => buildDocumentReferences(documentTree), [documentTree])

  return useCallback(async (content: string, cursorPosition: number) => {
    const token = getInlineReferenceTokenAtCursor(content, cursorPosition)
    if (!token) {
      return
    }

    const blockReferences = new Map(
      draftBlocks
        .filter((block): block is DocumentBlockDraft & { id: string } => Boolean(block.id?.trim()))
        .map((block) => [block.id, { id: block.id, content: block.content }] as const)
    )

    const target = resolveInlineReferenceTarget(token, documentReferences, blockReferences, selectedDocumentId)
    if (!target) {
      setBackupMessage(uiBlockReferenceNotFound)
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

    const blockReference = await window.knowbook.getBlockReference(target.documentPath, target.blockId)
    if (!blockReference) {
      setBackupMessage(uiBlockReferenceNotFound)
      return
    }

    onOpenDocumentBlock(blockReference.documentId, blockReference.block.id)
  }, [
    documentReferences,
    draftBlocks,
    onOpenDocument,
    onOpenDocumentBlock,
    selectedDocumentId,
    setBackupMessage,
    uiBlockReferenceNotFound
  ])
}

function buildDocumentReferences(nodes: DocumentTreeNode[]): DocumentReferenceEntry[] {
  const references: DocumentReferenceEntry[] = []

  for (const node of nodes) {
    references.push({
      id: node.id,
      title: node.title,
      path: node.path
    })
    references.push(...buildDocumentReferences(node.children))
  }

  return references
}