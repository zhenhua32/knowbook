import type { DocumentBlock } from '@shared/contracts'
import { collectMarkdownSourceLinks } from '@shared/markdownLinks'
import { parseWikiReference, resolveWikiDocument, wikiDocumentPaths } from '@shared/markdownWiki'
type BlockReferenceCandidate = Pick<DocumentBlock, 'id' | 'content'>

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
