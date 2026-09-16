import { parseMarkdownInline, type MarkdownNode } from '@shared/markdownEngine'
import { renderMarkdownNodes } from './MarkdownContent'
import type { DocumentBlock } from '@shared/contracts'
import { CrossDocumentBlockReference } from './BlockReference'

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
  const safeCursor = Math.max(0, Math.min(cursorPosition, content.length))
  const openIndex = content.lastIndexOf('[[', safeCursor)
  if (openIndex === -1) {
    return null
  }

  const closeIndex = content.indexOf(']]', openIndex + 2)
  if (closeIndex === -1) {
    return null
  }

  if (closeIndex < safeCursor - 1 || safeCursor < openIndex) {
    return null
  }

  const token = content.slice(openIndex + 2, closeIndex).trim()
  if (!token || token.includes('\n')) {
    return null
  }

  return token
}

export function resolveInlineReferenceTarget(
  token: string,
  references: Array<{ id: string; title: string; path: string }>,
  blockReferences?: Map<string, BlockReferenceCandidate>,
  currentDocumentId?: string | null
): InlineReferenceTarget | null {
  if (token.includes('#')) {
    const separatorIndex = token.lastIndexOf('#')
    const documentPath = token.slice(0, separatorIndex).trim()
    const blockId = token.slice(separatorIndex + 1).trim()

    if (documentPath && blockId) {
      return {
        type: 'cross-block',
        documentPath,
        blockId
      }
    }

    return null
  }

  const docTarget = resolveInlineReference(token, references)
  if (docTarget) {
    return {
      type: 'document',
      documentId: docTarget.id
    }
  }

  const blockTarget = blockReferences ? resolveBlockReference(token, blockReferences, currentDocumentId) : null
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
  const byPath = references.find((reference) => reference.path === token)
  if (byPath) {
    return byPath
  }

  const matchedByTitle = references.filter((reference) => reference.title === token)
  if (matchedByTitle.length === 1) {
    return matchedByTitle[0]
  }

  return null
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
