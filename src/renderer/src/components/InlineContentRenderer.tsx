import type { DocumentBlock } from '@shared/contracts'
import { CrossDocumentBlockReference } from './BlockReference'

export type StyledSegment = {
  type: 'bold' | 'italic' | 'code' | 'strikethrough' | 'text'
  content: string
}

export function parseMarkdownStyles(text: string): StyledSegment[] {
  const segments: StyledSegment[] = []
  let buffer = ''
  let i = 0

  while (i < text.length) {
    // Check for **bold**
    if (text[i] === '*' && text[i + 1] === '*') {
      const endIndex = text.indexOf('**', i + 2)
      if (endIndex !== -1) {
        if (buffer) {
          segments.push({ type: 'text', content: buffer })
          buffer = ''
        }
        segments.push({ type: 'bold', content: text.slice(i + 2, endIndex) })
        i = endIndex + 2
        continue
      }
    }

    // Check for ~~strikethrough~~
    if (text[i] === '~' && text[i + 1] === '~') {
      const endIndex = text.indexOf('~~', i + 2)
      if (endIndex !== -1) {
        if (buffer) {
          segments.push({ type: 'text', content: buffer })
          buffer = ''
        }
        segments.push({ type: 'strikethrough', content: text.slice(i + 2, endIndex) })
        i = endIndex + 2
        continue
      }
    }

    // Check for `code`
    if (text[i] === '`') {
      const closeIndex = text.indexOf('`', i + 1)
      if (closeIndex !== -1) {
        if (buffer) {
          segments.push({ type: 'text', content: buffer })
          buffer = ''
        }
        segments.push({ type: 'code', content: text.slice(i + 1, closeIndex) })
        i = closeIndex + 1
        continue
      }
    }

    // Check for *italic* or _italic_ (but not ** or __)
    if ((text[i] === '*' && text[i + 1] !== '*') || (text[i] === '_' && text[i + 1] !== '_')) {
      const delimiter = text[i]
      let j = i + 1
      while (j < text.length && text[j] !== delimiter) {
        j++
      }
      if (j < text.length && text[j] === delimiter) {
        if (buffer) {
          segments.push({ type: 'text', content: buffer })
          buffer = ''
        }
        segments.push({ type: 'italic', content: text.slice(i + 1, j) })
        i = j + 1
        continue
      }
    }

    buffer += text[i]
    i++
  }

  if (buffer) {
    segments.push({ type: 'text', content: buffer })
  }

  return segments.length === 0 ? [{ type: 'text', content: text }] : segments
}

export function renderStyledContent(segments: StyledSegment[]): React.ReactNode[] {
  return segments.map((segment, index) => {
    switch (segment.type) {
      case 'bold':
        return <strong key={`styled-${index}`}>{segment.content}</strong>
      case 'italic':
        return <em key={`styled-${index}`}>{segment.content}</em>
      case 'code':
        return <code key={`styled-${index}`} className="inline-code">{segment.content}</code>
      case 'strikethrough':
        return <del key={`styled-${index}`}>{segment.content}</del>
      default:
        return <span key={`styled-${index}`}>{segment.content}</span>
    }
  })
}

export function renderInlineContent(
  content: string,
  onSelectDocument: (documentId: string) => void,
  references: Array<{ id: string; title: string; path: string }>,
  currentBlockId?: string,
  blockReferences?: Map<string, DocumentBlock>,
  currentDocumentId?: string | null
) {
  const segments: Array<
    string |
    { type: 'document'; id: string; label: string } |
    { type: 'block'; id: string; blockId: string; label: string } |
    { type: 'cross-block'; documentPath: string; blockId: string; label: string }
  > = []
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g)
  let lastIndex = 0

  for (const match of matches) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      segments.push(content.slice(lastIndex, start))
    }

    const token = match[1]?.trim() ?? ''

    // Check for cross-document block reference [[documentPath#blockId]]
    if (token.includes('#')) {
      const [documentPath, blockId] = token.split('#')
      if (documentPath && blockId) {
        segments.push({
          type: 'cross-block',
          documentPath,
          blockId,
          label: token
        })
        lastIndex = start + match[0].length
        continue
      }
    }

    // Try to resolve as document reference first
    const docTarget = resolveInlineReference(token, references)
    if (docTarget) {
      segments.push({
        type: 'document',
        id: docTarget.id,
        label: token
      })
    } else if (blockReferences && blockReferences.size > 0) {
      // Try to resolve as block reference
      const blockTarget = resolveBlockReference(token, blockReferences, currentDocumentId)
      if (blockTarget) {
        segments.push({
          type: 'block',
          id: currentDocumentId || '',
          blockId: blockTarget.id,
          label: token
        })
      } else {
        segments.push(match[0])
      }
    } else {
      segments.push(match[0])
    }

    lastIndex = start + match[0].length
  }

  if (lastIndex < content.length) {
    segments.push(content.slice(lastIndex))
  }

  if (segments.length === 0) {
    return renderStyledContent(parseMarkdownStyles(content))
  }

  return segments.map((segment, index) => {
    if (typeof segment === 'string') {
      return <span key={`text-${index}`}>{renderStyledContent(parseMarkdownStyles(segment))}</span>
    }

    if (segment.type === 'document') {
      return (
        <button className="inline-link" key={`link-${segment.id}-${index}`} onClick={() => onSelectDocument(segment.id)} type="button">
          [[{segment.label}]]
        </button>
      )
    }

    if (segment.type === 'cross-block') {
      return <CrossDocumentBlockReference key={`cross-${index}`} documentPath={segment.documentPath} blockId={segment.blockId} />
    }

    // Block reference - needs special handling (currently just display as link)
    return (
      <span className="inline-link-block" key={`block-link-${segment.blockId}-${index}`} title={'Block reference'}>
        [[{segment.label}]]
      </span>
    )
  })
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

export function resolveBlockReference(token: string, blockReferences: Map<string, DocumentBlock>, currentDocumentId?: string | null): DocumentBlock | null {
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
