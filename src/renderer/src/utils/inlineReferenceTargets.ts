import type { DocumentBlock, DocumentBlockDraft, DocumentTreeNode } from '@shared/contracts'
import { collectMarkdownSourceLinks } from '@shared/markdownLinks'
import { findWikiHeading, parseWikiReference, resolveWikiDocument, wikiDocumentPaths } from '@shared/markdownWiki'
import { getMarkdownHeadingTargets } from '@shared/markdownLinkMaintenance'
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
