import type { AppMessageHandler } from '../notify'
import { useCallback, useMemo } from 'react'
import type { DocumentBlockDraft, DocumentTreeNode } from '@shared/contracts'
import { getMarkdownHeadingTargets } from '@shared/markdownLinkMaintenance'
import { findWikiHeading } from '@shared/markdownWiki'
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

    const document = documentReferences.find((entry) => entry.path === target.documentPath)
    const detail = document && (document.id === selectedDocumentId ? { id: document.id, title: draftTitle, blocks: draftBlocks }
      : await window.knowbook.getDocumentDetail(document.id))
    if (!detail) {
      notify(uiBlockReferenceNotFound, 'warning')
      return
    }
    if (detail.blocks.some((block) => block.id === target.blockId)) onOpenDocumentBlock(detail.id, target.blockId)
    else {
      const heading = findWikiHeading(target.blockId, getMarkdownHeadingTargets(detail.blocks, detail.title))
      if (heading) onOpenAnchor(detail.id, heading.slug)
      else notify(uiBlockReferenceNotFound, 'warning')
    }
  }, [
    documentReferences,
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
