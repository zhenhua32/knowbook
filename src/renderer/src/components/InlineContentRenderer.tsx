import { parseMarkdownInline, type MarkdownNode } from '@shared/markdownEngine'
import { renderMarkdownNodes } from './MarkdownContent'
import type { DocumentBlock } from '@shared/contracts'
import { CrossDocumentBlockReference } from './BlockReference'
import { collectMarkdownSourceLinks } from '@shared/markdownLinks'
import { parseWikiReference, resolveWikiDocument } from '@shared/markdownWiki'

type BlockReferenceCandidate = Pick<DocumentBlock, 'id' | 'content'>

export type InlineReferenceTarget =
  | { type: 'document'; documentId: string }
  | { type: 'block'; documentId: string; blockId: string }
  | { type: 'cross-block'; documentPath: string; blockId: string }

export type StyledSegment = MarkdownNode

export function parseMarkdownStyles(text: string): StyledSegment[] {
  return parseMarkdownInline(text)
}

export function renderStyledContent(segments: StyledSegment[]): React.ReactNode[] {
  return renderMarkdownNodes(segments)
}

export function renderInlineContent(
  content: string,
  onSelectDocument: (documentId: string) => void,
  references: Array<{ id: string; title: string; path: string }>,
  currentBlockId?: string,
  blockReferences?: Map<string, DocumentBlock>,
  currentDocumentId?: string | null
) {
  return renderMarkdownNodes(parseMarkdownInline(content), {
    renderReference: (token, index) => {
      const target = resolveInlineReferenceTarget(token, references, blockReferences, currentDocumentId)
      if (!target) return <span key={index}>{'[[' + token + ']]'}</span>
      if (target.type === 'cross-block') return <CrossDocumentBlockReference key={index} documentPath={target.documentPath} blockId={target.blockId} />
      if (target.type === 'document') return <button key={index} className="inline-link" type="button" onClick={() => onSelectDocument(target.documentId)}>{'[[' + token + ']]'}</button>
      return <span key={index} className="inline-link-block" title="Block reference">{'[[' + token + ']]'}</span>
    }
  })
}

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
    if (resolved.reference.fragment.startsWith('^')) return null
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

  return null
}

export function resolveInlineReference(token: string, references: Array<{ id: string; title: string; path: string }>) {
  return resolveWikiDocument(token, '', {
    byPath: (path) => references.find((entry) => entry.path.toLowerCase() === path.toLowerCase()),
    byTitle: (title) => references.filter((entry) => entry.title.toLowerCase() === title.toLowerCase())
  })?.document ?? null
}

export function resolveBlockReference(token: string, blockReferences: Map<string, BlockReferenceCandidate>, currentDocumentId?: string | null): BlockReferenceCandidate | null {
  // Support [[blockId]] or [[documentPath#blockId]] syntax
  if (token.includes('#')) {
    // Format: [[documentPath#blockId]] - handled by CrossDocumentBlockReference
    return null
  }

  // Try direct block ID match
  const block = blockReferences.get(token)
  if (block) {
    return block
  }

  // Try to find by content prefix match
  for (const [, block] of blockReferences) {
    if (block.content.toLowerCase().startsWith(token.toLowerCase())) {
      return block
    }
  }

  return null
}
