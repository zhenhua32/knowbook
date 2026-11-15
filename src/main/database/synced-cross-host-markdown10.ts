import type { DocumentBlockDraft } from '../../shared/contracts'
import { serializeMarkdownWithBlockRanges } from '../../shared/markdown'
import type { MarkdownDocumentLink } from '../../shared/markdownLinkMaintenance'
import { projectedMarkdownContentPosition } from '../../shared/markdownNativeText'
import { observeMarkdownSourceOccurrences } from '../../shared/markdownSourceOccurrences'
import type { MarkdownToken } from '../../shared/markdownEngine'

export function isExtendedCrossMoveLink(link: MarkdownDocumentLink): boolean {
  return link.kind === 'definition' || link.kind === 'link' && link.syntax === 'html'
}

export function extendedCrossMoveLinkKey(link: MarkdownDocumentLink): string {
  return JSON.stringify([link.blockIndex, link.start, link.end, link.kind, link.url])
}

/** Prove indexed source positions with the actual parser occurrence and its
 * final link token. A shared image definition would also change a non-link. */
export function proveExtendedCrossMoveLinks(blocks: DocumentBlockDraft[]): ReadonlySet<string> {
  const { markdown, ranges, contentProjections } = serializeMarkdownWithBlockRanges(blocks)
  const observed = observeMarkdownSourceOccurrences(markdown)
  const proved = new Set<string>()
  if (!observed.complete) return proved

  const imageLabels = new Set<string>()
  const visit = (tokens: readonly MarkdownToken[]) => {
    for (const token of tokens) {
      if (token.type === 'image' && typeof token.meta?.label === 'string') imageLabels.add(token.meta.label)
      if (token.children) visit(token.children)
    }
  }
  visit(observed.tokens)
  const usable = new Set(observed.uses.flatMap(use => {
    const fact = use.destination
    if (!use.complete || !fact?.destination || use.token.type !== 'link_open') return []
    if (fact.kind === 'definition') {
      const label = use.token.meta?.label
      return fact.active && use.kind === 'reference' && typeof label === 'string' && !imageLabels.has(label) ? [fact] : []
    }
    return fact.format === 'html' && use.kind === 'direct' && use.token.meta?.html === true ? [fact] : []
  }))
  const lines = markdown.split('\n'), offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
  let line = 0, rangeIndex = 0
  for (const fact of [...usable].sort((a, b) => a.destination!.from - b.destination!.from)) {
    const span = fact.destination!
    while (line + 1 < offsets.length && offsets[line + 1] <= span.from) line++
    while (rangeIndex < ranges.length && ranges[rangeIndex].endLine <= line) rangeIndex++
    const range = ranges[rangeIndex], block = blocks[rangeIndex]
    if (!range || !block || line < range.startLine || ['code', 'math', 'frontmatter', 'database-view'].includes(block.type)) continue
    const start = projectedMarkdownContentPosition(block, range, markdown, lines, offsets, span.from, contentProjections?.[rangeIndex])
    const end = projectedMarkdownContentPosition(block, range, markdown, lines, offsets, span.to, contentProjections?.[rangeIndex], true)
    if (start === null || end === null || end <= start || span.raw !== block.content.slice(start, end)) continue
    proved.add(extendedCrossMoveLinkKey({ blockIndex: rangeIndex, start, end, kind: fact.kind, url: fact.url }))
  }
  return proved
}
