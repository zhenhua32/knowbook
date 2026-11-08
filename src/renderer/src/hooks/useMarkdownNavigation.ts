import type { AppMessageHandler } from '../notify'
import { useCallback, useMemo, useRef } from 'react'
import type { DocumentDetail, DocumentTreeNode } from '@shared/contracts'

export function useMarkdownNavigation({ documentTree, selectedDocument, onOpenDocument, onOpenAnchor, onOpenDocumentBlock, onWikiReference, onMessage, isZh }: {
  documentTree: DocumentTreeNode[]
  selectedDocument: DocumentDetail | null
  onOpenDocument: (documentId: string) => void
  onOpenAnchor: (documentId: string, anchor: string) => void
  onOpenDocumentBlock: (documentId: string, blockId: string) => void
  onWikiReference: (token: string) => void
  onMessage: AppMessageHandler
  isZh: boolean
}) {
  const liveDocument = useRef(selectedDocument), request = useRef(0)
  if (liveDocument.current?.id !== selectedDocument?.id) request.current += 1
  liveDocument.current = selectedDocument
  const documentIds = useMemo(() => {
    const ids = new Map<string, string>()
    const visit = (nodes: DocumentTreeNode[]) => nodes.forEach(node => { ids.set(node.path, node.id); visit(node.children) })
    visit(documentTree)
    return ids
  }, [documentTree])
  return useCallback(async (url: string) => {
    const sequence = ++request.current
    const isCurrent = () => sequence === request.current && liveDocument.current?.id === selectedDocument?.id
    try {
      const { navigateMarkdownLink } = await import('../utils/inlineReferenceTargets')
      if (isCurrent()) await navigateMarkdownLink(url, {
        selectedDocument, documentIds, onOpenDocument, onOpenAnchor, onOpenDocumentBlock, onWikiReference, onMessage, isZh, isCurrent
      })
    } catch (error) {
      if (isCurrent()) onMessage(error instanceof Error ? error.message : (isZh ? '打开链接失败' : 'Could not open link'), 'error')
    }
  }, [documentIds, isZh, onMessage, onOpenAnchor, onOpenDocument, onOpenDocumentBlock, onWikiReference, selectedDocument])
}
