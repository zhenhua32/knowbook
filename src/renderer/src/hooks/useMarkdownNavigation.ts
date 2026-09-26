import type { AppMessageHandler } from '../notify'
import { useCallback, useMemo } from 'react'
import type { DocumentDetail, DocumentTreeNode } from '@shared/contracts'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'

export function useMarkdownNavigation({ documentTree, selectedDocument, onOpenDocument, onOpenAnchor, onWikiReference, onMessage, isZh }: {
  documentTree: DocumentTreeNode[]
  selectedDocument: DocumentDetail | null
  onOpenDocument: (documentId: string) => void
  onOpenAnchor: (documentId: string, anchor: string) => void
  onWikiReference: (token: string) => void
  onMessage: AppMessageHandler
  isZh: boolean
}) {
  const documentIds = useMemo(() => {
    const ids = new Map<string, string>()
    const visit = (nodes: DocumentTreeNode[]) => nodes.forEach((node) => { ids.set(node.path, node.id); visit(node.children) })
    visit(documentTree)
    return ids
  }, [documentTree])
  return useCallback((url: string) => {
    if (url.startsWith('knowbook-wiki:')) { onWikiReference(url.slice('knowbook-wiki:'.length)); return }
    if (!selectedDocument) return
    const target = resolveMarkdownDocumentPath(selectedDocument.path, url)
    const id = target?.path === selectedDocument.path ? selectedDocument.id : target && documentIds.get(target.path)
    if (!target || !id) {
      let label = url
      try { label = decodeURIComponent(url) } catch { /* Preserve malformed input for the message. */ }
      onMessage(isZh ? `找不到链接目标：${label}` : `Link target not found: ${label}`, 'warning')
      return
    }
    if (url.includes('#')) onOpenAnchor(id, target.fragment)
    else onOpenDocument(id)
  }, [documentIds, isZh, onMessage, onOpenAnchor, onOpenDocument, onWikiReference, selectedDocument])
}
