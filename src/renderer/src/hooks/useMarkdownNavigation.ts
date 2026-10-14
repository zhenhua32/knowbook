import type { AppMessageHandler } from '../notify'
import { useCallback, useMemo, useRef } from 'react'
import type { DocumentDetail, DocumentTreeNode } from '@shared/contracts'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'

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
    if (url.startsWith('knowbook-wiki:')) { onWikiReference(url.slice('knowbook-wiki:'.length)); return }
    if (!selectedDocument) return
    const isCurrent = () => sequence === request.current && liveDocument.current?.id === selectedDocument.id
    const target = resolveMarkdownDocumentPath(selectedDocument.path, url)
    try {
      if (target?.fragment) {
        const block = await window.knowbook.getBlockReference(target.path, target.fragment)
        if (!isCurrent()) return
        if (block) { onOpenDocumentBlock(block.documentId, block.block.id); return }
        if (target.fragment.startsWith('^')) {
          onMessage(isZh ? '找不到块链接目标。' : 'Block link target not found.', 'warning')
          return
        }
      }
      const id = target?.path === selectedDocument.path ? selectedDocument.id : target && documentIds.get(target.path)
      if (!isCurrent()) return
      if (!target || !id) {
        let label = url
        try { label = decodeURIComponent(url) } catch { /* Preserve malformed input for the message. */ }
        onMessage(isZh ? '找不到链接目标：' + label : 'Link target not found: ' + label, 'warning')
        return
      }
      if (url.includes('#')) onOpenAnchor(id, target.fragment)
      else onOpenDocument(id)
    } catch (error) {
      if (isCurrent()) onMessage(error instanceof Error ? error.message : (isZh ? '打开链接失败' : 'Could not open link'), 'error')
    }
  }, [documentIds, isZh, onMessage, onOpenAnchor, onOpenDocument, onOpenDocumentBlock, onWikiReference, selectedDocument])
}
