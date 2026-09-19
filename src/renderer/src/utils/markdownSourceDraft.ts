import { parseMarkdownBlocks, serializeMarkdownWithBlockRanges, type MarkdownBlockSourceRange } from '@shared/markdown'
import type { DocumentBlockDraft } from '@shared/contracts'

export type MarkdownSourceChange = { from: number; to: number; insert: string }
type SourceAnchor = { block: DocumentBlockDraft; from: number; to: number; original: string }
export type MarkdownSourceDraft = { source: string; anchors: SourceAnchor[]; initialSource: string; initialBlocks: DocumentBlockDraft[] }

function sourceOffsets(source: string, ranges: MarkdownBlockSourceRange[]) {
  const lines = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lines.push(i + 1)
  return ranges.map((range) => {
    const from = lines[range.startLine] ?? source.length
    let to = lines[range.endLine] ?? source.length
    if (to > from && source[to - 1] === '\n') to--
    return { from, to }
  })
}

export function createMarkdownSourceDraft(blocks: DocumentBlockDraft[]): MarkdownSourceDraft {
  const { markdown: source, ranges } = serializeMarkdownWithBlockRanges(blocks.map((block) => ({ ...block, content: block.content.replace(/\r\n?/g, '\n') })))
  const anchors = sourceOffsets(source, ranges).map((range, index) => ({
    ...range, block: blocks[index], original: source.slice(range.from, range.to)
  }))
  return { source, anchors, initialSource: source, initialBlocks: blocks }
}

/** Capture one native text replacement. The pre-input selection prevents an
 * insertion next to repeated text from being attributed to a different block. */
export function markdownSourceChange(before: string, after: string, selectionStart = before.length, selectionEnd?: number): MarkdownSourceChange {
  let from = 0
  while (from < Math.min(selectionStart, before.length, after.length) && before[from] === after[from]) from++
  let to = before.length, end = after.length
  while (to > Math.max(from, selectionEnd ?? from) && end > from && before[to - 1] === after[end - 1]) { to--; end-- }
  return { from, to, insert: after.slice(from, end) }
}

/** Keep identities attached to surviving source through each input transaction,
 * rather than guessing identities from duplicate paragraph contents on save. */
export function replaceMarkdownSource(draft: MarkdownSourceDraft, change: MarkdownSourceChange): MarkdownSourceDraft {
  const { from, to, insert } = change
  if (from < 0 || to < from || to > draft.source.length) throw new Error('Invalid Markdown source change')
  if (draft.source.slice(from, to) === insert) return draft
  const delta = insert.length - (to - from)
  let replacementClaimed = false
  const anchors = draft.anchors.flatMap((anchor) => {
    if (anchor.from === anchor.to && anchor.from === from && from === to) {
      replacementClaimed = true
      return [{ ...anchor, to: from + insert.length }]
    }
    if (anchor.to <= from) return [anchor]
    if (anchor.from >= to) return [{ ...anchor, from: anchor.from + delta, to: anchor.to + delta }]
    const covered = from <= anchor.from && to >= anchor.to
    if (covered && (!insert || replacementClaimed)) return []
    replacementClaimed = true
    return [{ ...anchor,
      from: anchor.from < from ? anchor.from : from,
      to: anchor.to > to ? anchor.to + delta : from + insert.length
    }]
  })
  return { ...draft, source: draft.source.slice(0, from) + insert + draft.source.slice(to), anchors }
}

/** Reparse syntax only when the user applies the source draft. Metadata and
 * references follow surviving blocks; pasted metadata cannot claim other IDs. */
export function markdownSourceDraftToBlocks(draft: MarkdownSourceDraft): DocumentBlockDraft[] {
  if (draft.source === draft.initialSource && draft.anchors.length === draft.initialBlocks.length
    && draft.anchors.every((anchor, index) => anchor.block === draft.initialBlocks[index])) return draft.initialBlocks
  const ranges: MarkdownBlockSourceRange[] = []
  const parsed = parseMarkdownBlocks(draft.source, ranges)
  const offsets = sourceOffsets(draft.source, ranges)
  const used = new Set<SourceAnchor>()
  const byStart = new Map(offsets.map((range, index) => [range.from, index]))
  const byEnd = new Map(offsets.map((range, index) => [range.to, index]))
  const retained = new Map<number, { anchor: SourceAnchor; last: number }>()
  for (const anchor of draft.anchors) {
    const first = byStart.get(anchor.from), last = byEnd.get(anchor.to)
    // An untouched block may itself contain several paragraphs. Preserve its
    // original grouping when the parser still has boundaries on both sides.
    if (first !== undefined && last !== undefined && last >= first
      && draft.source.slice(anchor.from, anchor.to) === anchor.original) {
      retained.set(first, { anchor, last })
      used.add(anchor)
    }
  }
  const blocks: DocumentBlockDraft[] = []
  const outputRanges: Array<{ from: number; to: number }> = []
  let anchorCursor = 0
  for (let index = 0; index < parsed.length; index++) {
    const block = parsed[index], range = offsets[index], retainedBlock = retained.get(index)
    if (retainedBlock) {
      blocks.push({ ...retainedBlock.anchor.block, depth: block.depth ?? 0, parentBlockId: null })
      outputRanges.push({ from: range.from, to: offsets[retainedBlock.last].to })
      index = retainedBlock.last
      continue
    }
    while (anchorCursor < draft.anchors.length && draft.anchors[anchorCursor].to <= range.from) anchorCursor++
    let anchor: SourceAnchor | undefined
    for (let cursor = anchorCursor; cursor < draft.anchors.length && draft.anchors[cursor].from < range.to; cursor++) {
      const candidate = draft.anchors[cursor]
      if (!used.has(candidate) && candidate.to > range.from) { anchor = candidate; used.add(candidate); break }
    }
    blocks.push({ type: block.type, content: block.content, checked: block.checked ?? false, depth: block.depth ?? 0,
      language: block.language ?? undefined, listStart: block.listStart, markdownFormat: block.markdownFormat,
      id: anchor?.block.id, tags: anchor?.block.tags, highlight: anchor?.block.highlight, parentBlockId: null })
    outputRanges.push(range)
  }
  // Empty editable blocks have no parser token. Keep them only while their
  // surrounding blank separators remain, rather than reintroducing deleted gaps.
  let position = 0
  for (const anchor of draft.anchors.filter(anchor => anchor.from === anchor.to && !used.has(anchor))) {
    while (position < outputRanges.length && outputRanges[position].from < anchor.from) position++
    const before = outputRanges[position - 1], after = outputRanges[position]
    if ((!before || anchor.from - before.to >= 2) && (!after || after.from - anchor.to >= 2)) {
      blocks.splice(position, 0, { ...anchor.block, parentBlockId: null })
      outputRanges.splice(position, 0, { from: anchor.from, to: anchor.to })
      position++
    }
  }
  return blocks
}
