import type { Mark } from 'prosemirror-model'

/** Private PM memory only. DOM rules, Markdown and persisted fingerprints omit it. */
export const RICH_LINK_OCCURRENCE_ATTR = 'knowbookLinkOccurrence'

export interface RichLinkDestinationTrace {
  token: string | null
  from: number
  to: number
  raw: string
  href: string
  syntax: 'markdown'
  format: 'markdown' | 'html' | 'autolink'
  /** Mechanical emission count for this token, not a continue/copy authority. */
  occurrenceIndex: number
}
export interface RichInlineLinkSerialization {
  content: string
  linkDestinations: RichLinkDestinationTrace[]
}

function tokenValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !value.trim()) throw new Error('富文本链接的临时来源标识无效。')
  return value
}
export function richLinkOccurrence(mark: Mark): string | null {
  if (mark.type.name !== 'link') throw new Error('只有真实链接 mark 可以携带临时来源标识。')
  return tokenValue(mark.attrs[RICH_LINK_OCCURRENCE_ATTR])
}
export function withRichLinkOccurrence(mark: Mark, token: string | null): Mark {
  if (mark.type.name !== 'link') throw new Error('只有真实链接 mark 可以携带临时来源标识。')
  const value = tokenValue(token)
  return mark.attrs[RICH_LINK_OCCURRENCE_ATTR] === value ? mark
    : mark.type.create({ ...mark.attrs, [RICH_LINK_OCCURRENCE_ATTR]: value })
}

/** Serializers call this at the actual destination write, never after matching
 * URLs in the final source. The final slice check is only an emission invariant. */
export class RichLinkTraceCollector {
  private readonly counts = new Map<string, number>()
  private readonly destinations: RichLinkDestinationTrace[] = []
  record(mark: Mark, from: number, raw: string, format: RichLinkDestinationTrace['format']): void {
    const token = richLinkOccurrence(mark), occurrenceIndex = token === null ? 0 : this.counts.get(token) ?? 0
    if (token !== null) this.counts.set(token, occurrenceIndex + 1)
    this.destinations.push({ token, from, to: from + raw.length, raw, href: mark.attrs.href as string,
      syntax: 'markdown', format, occurrenceIndex })
  }
  finish(content: string): RichLinkDestinationTrace[] {
    for (const item of this.destinations) {
      if (!Number.isSafeInteger(item.from) || item.from < 0 || item.to > content.length || content.slice(item.from, item.to) !== item.raw) {
        throw new Error('富文本链接的实际发射范围与输出不一致，未生成来源声明。')
      }
    }
    return this.destinations.map(item => ({ ...item }))
  }
}
