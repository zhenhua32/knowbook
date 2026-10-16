import type { Node as PMNode } from 'prosemirror-model'
import { richLinkOccurrence } from './linkProvenance'

export interface RichPmInlineEntry { readonly node: PMNode; readonly pos: number }
export interface RichPmDocIndex {
  readonly doc: PMNode
  /** Exact old markFor coverage: structural gaps and unmarked content fail. */
  hasLinkMark(from: number, to: number, token: string, href: string): boolean
  /** Uniform href of the actually intersecting inline nodes, like hrefAt.
   * This does not itself prove complete coverage across structural gaps. */
  linkHref(from: number, to: number, token: string): string | undefined
  /** Only actual node starts. Unlike PM nodeAt, text interiors do not match. */
  nodeAtStart(pos: number): PMNode | undefined
  /** The same inline-only / no-inline-descendants visits as nodesBetween. */
  inlineEntries(from: number, to: number): readonly RichPmInlineEntry[]
}
type InlineSpan = { readonly entry: RichPmInlineEntry; readonly end: number }
const noEntries: readonly RichPmInlineEntry[] = Object.freeze([])

/** One traversal of this exact immutable PM document. No document/mark/DOM
 * mutation, target lookup, source inference or fingerprint-based reuse. */
export function createRichPmDocIndex(doc: PMNode): RichPmDocIndex {
  const spans: InlineSpan[] = [], starts = new Map<number, PMNode>()
  const visit = (node: PMNode, pos: number, insideInline: boolean) => {
    starts.set(pos, node)
    if (node.isInline && !insideInline) spans.push({ entry: Object.freeze({ node, pos }), end: pos + node.nodeSize })
    node.forEach((child, offset) => visit(child, pos + 1 + offset, insideInline || node.isInline))
  }
  doc.forEach((node, offset) => visit(node, offset, false))
  const valid = (from: number, to: number) => Number.isSafeInteger(from) && Number.isSafeInteger(to)
    && from >= 0 && from <= to && to <= doc.content.size
  const forEachInline = (from: number, to: number, callback: (span: InlineSpan) => void): boolean => {
    if (!valid(from, to)) return false
    let low = 0, high = spans.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (spans[middle].end <= from) low = middle + 1
      else high = middle
    }
    for (let index = low; index < spans.length && spans[index].entry.pos < to; index++) callback(spans[index])
    return true
  }
  return Object.freeze({
    doc,
    hasLinkMark(from: number, to: number, token: string, href: string): boolean {
      let covered = 0, accepted = true
      const bounded = forEachInline(from, to, ({ entry: { node, pos }, end }) => {
        const width = Math.max(0, Math.min(to, end) - Math.max(from, pos))
        const mark = node.marks.find(item => item.type.name === 'link')
        // Do not stop after a mismatch: a later malformed token must retain
        // the old actual nodesBetween rejection behavior.
        if (width && (!mark || richLinkOccurrence(mark) !== token || mark.attrs.href !== href)) accepted = false
        covered += width
      })
      return bounded && accepted && covered === to - from
    },
    linkHref(from: number, to: number, token: string): string | undefined {
      let href: string | undefined, accepted = true
      const bounded = forEachInline(from, to, ({ entry: { node } }) => {
        const mark = node.marks.find(item => item.type.name === 'link')
        if (!mark || richLinkOccurrence(mark) !== token || typeof mark.attrs.href !== 'string') { accepted = false; return }
        if (href !== undefined && href !== mark.attrs.href) accepted = false
        href = mark.attrs.href
      })
      return bounded && accepted ? href : undefined
    },
    nodeAtStart: (pos: number) => starts.get(pos),
    inlineEntries(from: number, to: number): readonly RichPmInlineEntry[] {
      const entries: RichPmInlineEntry[] = []
      if (!forEachInline(from, to, span => entries.push(span.entry)) || !entries.length) return noEntries
      return Object.freeze(entries)
    }
  })
}
