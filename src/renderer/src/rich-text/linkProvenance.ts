import type { Mark } from 'prosemirror-model'

/** Private PM memory only. DOM rules, Markdown and persisted fingerprints omit it. */
export const RICH_LINK_OCCURRENCE_ATTR = 'knowbookLinkOccurrence'

/** Half-open positions in the serialized node's actual inline PM content. */
export interface RichPmSpan { readonly from: number; readonly to: number }
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
  readonly pmSpans: readonly RichPmSpan[]
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
  constructor(private readonly pmSize: number) {}
  record(mark: Mark, from: number, raw: string, format: RichLinkDestinationTrace['format'], spans: readonly RichPmSpan[]): void {
    const pmSpans: Array<{ from: number; to: number }> = []
    for (const span of spans) {
      const previous = pmSpans.at(-1)
      if (!Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to) || span.from < 0 || span.to <= span.from
        || span.to > this.pmSize || previous && span.from < previous.to) {
        throw new Error('富文本链接的实际 PM 发射范围无效，未生成来源声明。')
      }
      if (previous?.to === span.from) previous.to = span.to
      else pmSpans.push({ from: span.from, to: span.to })
    }
    if (!pmSpans.length) throw new Error('富文本链接缺少实际 PM 发射范围，未生成来源声明。')
    const token = richLinkOccurrence(mark), occurrenceIndex = token === null ? 0 : this.counts.get(token) ?? 0
    if (token !== null) this.counts.set(token, occurrenceIndex + 1)
    this.destinations.push({ token, from, to: from + raw.length, raw, href: mark.attrs.href as string,
      syntax: 'markdown', format, occurrenceIndex, pmSpans: Object.freeze(pmSpans.map(span => Object.freeze(span))) })
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
