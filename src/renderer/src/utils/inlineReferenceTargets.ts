import type { DocumentBlock, DocumentBlockDraft, DocumentTreeNode } from '@shared/contracts'
import { collectMarkdownSourceLinks } from '@shared/markdownLinks'
import { findWikiHeading, parseWikiReference, resolveWikiDocument, wikiDocumentPaths } from '@shared/markdownWiki'
import { getMarkdownHeadingTargets } from '@shared/markdownLinkMaintenance'
import type { AppMessageHandler } from '../notify'
type BlockReferenceCandidate = Pick<DocumentBlock, 'id' | 'content'>

export function buildInlineBlockReferences(blocks: DocumentBlockDraft[]) {
  return new Map(blocks
    .filter((block): block is DocumentBlockDraft & { id: string } => Boolean(block.id?.trim()))
    .map((block) => [block.id, { id: block.id, content: block.content }] as const))
}

export type InlineReferenceTarget =
  | { type: 'document'; documentId: string }
  | { type: 'block'; documentId: string; blockId: string }
  | { type: 'cross-block'; documentPath: string; blockId: string }

export function getInlineReferenceTokenAtCursor(content: string, cursorPosition: number): string | null {
  return collectMarkdownSourceLinks(content).find((link) => link.kind === 'wiki'
    && cursorPosition >= link.start - 2 && cursorPosition <= link.end + 1)?.url ?? null
}

export function resolveInlineReferenceTarget(
  token: string,
  references: Array<{ id: string; title: string; path: string }>,
  blockReferences?: Map<string, BlockReferenceCandidate>,
  currentDocumentId?: string | null
): InlineReferenceTarget | null {
  const resolved = resolveWikiDocument(token, references.find((entry) => entry.id === currentDocumentId)?.path ?? '', {
    byPath: (path) => references.find((entry) => entry.path === path) ?? references.find((entry) => entry.path.toLowerCase() === path.toLowerCase()),
    byTitle: (title) => references.filter((entry) => entry.title.toLowerCase() === title.toLowerCase())
  })
  if (resolved) {
    return resolved.reference.fragment ? { type: 'cross-block', documentPath: resolved.document.path, blockId: resolved.reference.fragment }
      : { type: 'document', documentId: resolved.document.id }
  }
  const reference = parseWikiReference(token)
  const blockTarget = !reference.hasFragment && blockReferences ? blockReferences.get(reference.target) : null
  if (blockTarget && currentDocumentId) {
    return {
      type: 'block',
      documentId: currentDocumentId,
      blockId: blockTarget.id
    }
  }

  if (reference.hasFragment && reference.path) {
    const sourcePath = references.find(entry => entry.id === currentDocumentId)?.path ?? ''
    const path = wikiDocumentPaths(reference.path, sourcePath)[0]
    if (path) return { type: 'cross-block', documentPath: path, blockId: reference.fragment }
  }
  return null
}

/** Heading fallback shares the inline-navigation chunk and its existing await. */
export function findInlineReferenceHeading(fragment: string, blocks: DocumentBlockDraft[], title: string) {
  return findWikiHeading(fragment, getMarkdownHeadingTargets(blocks, title))
}

type DocumentReferenceEntry = {
  id: string
  title: string
  path: string
}


export function buildDocumentReferences(nodes: DocumentTreeNode[]): DocumentReferenceEntry[] {
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

export type InlineReferenceNavigationContext = {
  documentTree: DocumentTreeNode[]
  draftBlocks: DocumentBlockDraft[]
  onOpenDocument: (documentId: string) => void
  onOpenDocumentBlock: (documentId: string, blockId: string) => void
  onOpenAnchor: (documentId: string, anchor: string) => void
  draftTitle: string
  selectedDocumentId: string | null
  notify: AppMessageHandler
  uiBlockReferenceNotFound: string
  isCurrent: () => boolean
}

/** Runs after the hook's existing cold import, with the same IPC continuation guards. */
export async function navigateInlineReference(content: string, cursorPosition: number, {
  documentTree, draftBlocks, onOpenDocument, onOpenDocumentBlock, onOpenAnchor, draftTitle,
  selectedDocumentId, notify, uiBlockReferenceNotFound, isCurrent
}: InlineReferenceNavigationContext): Promise<void> {
  try {
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
}
