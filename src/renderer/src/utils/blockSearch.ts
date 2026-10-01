import type { DocumentBlockDraft } from '@shared/contracts'

export type BlockSearchTextRange = { start: number; end: number }

function isSurrogateBoundary(content: string, offset: number): boolean {
  const current = content.charCodeAt(offset), previous = content.charCodeAt(offset - 1)
  return current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
}

function rawRange(content: string, folded: string, start: number, end: number): BlockSearchTextRange {
  if (content.length === folded.length) return { start, end }
  let rawOffset = 0, foldedOffset = 0, rawStart = 0
  for (const character of content) {
    const nextFoldedOffset = foldedOffset + character.toLocaleLowerCase().length
    if (foldedOffset <= start && start < nextFoldedOffset) rawStart = rawOffset
    if (end <= nextFoldedOffset) return { start: rawStart, end: rawOffset + character.length }
    rawOffset += character.length
    foldedOffset = nextFoldedOffset
  }
  return { start: rawStart, end: content.length }
}

export function findBlockSearchTextRanges(content: string, text: string, firstOnly = false): BlockSearchTextRange[] {
  const query = text.trim().toLocaleLowerCase()
  if (!query) return []
  // Fold the complete string once so contextual casing (such as final sigma)
  // stays consistent with document search. Only expanded casing needs mapping.
  const folded = content.toLocaleLowerCase(), ranges: BlockSearchTextRange[] = []
  for (let start = folded.indexOf(query); start >= 0; start = folded.indexOf(query, start + query.length)) {
    const range = rawRange(content, folded, start, start + query.length)
    const previous = ranges.at(-1)
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end)
    else ranges.push(range)
    if (firstOnly) break
  }
  return ranges
}

export function findBlockSearchMatches(blocks: DocumentBlockDraft[], text: string) {
  const query = text.trim().toLocaleLowerCase()
  if (!query) return []
  return blocks.flatMap((block, index) => {
    const match = findBlockSearchTextRanges(block.content, query, true)[0]
    if (!match && !block.type.toLocaleLowerCase().includes(query)) return []
    let start = Math.max(0, (match?.start ?? 0) - 36)
    if (isSurrogateBoundary(block.content, start)) start--
    let end = Math.min(block.content.length, start + 120)
    if (isSurrogateBoundary(block.content, end)) end--
    const prefixLength = start > 0 ? 1 : 0
    return [{ index, type: block.type,
      contentPreview: `${start > 0 ? '…' : ''}${block.content.slice(start, end)}${end < block.content.length ? '…' : ''}`,
      previewMatchRange: match ? {
        start: prefixLength + match.start - start,
        end: prefixLength + Math.min(match.end, end) - start
      } : null
    }]
  })
}
