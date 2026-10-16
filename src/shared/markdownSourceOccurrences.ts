import type { StateInline, Token } from 'markdown-it'
import { assertNativeContainerParse } from './markdownContainers'
import { decodeNativeLiteralText } from './markdownNativeText'
import { createMarkdownSourceRawTrace, type MarkdownSourceRawSpan } from './markdownSourceTrace'
import type { MarkdownRawOccurrenceObserver, MarkdownRawRuleReads } from './markdownSourceLinks'
import { markdownEngine } from './markdownEngine'
export type { MarkdownSourceRawSpan } from './markdownSourceTrace'

type MutableRuleReads = { destinations: Array<{ source: string; start: number; end: number; ok: boolean; value: string }>;
  labels: Array<{ state: StateInline; start: number; end: number }> }
let activeReads: MutableRuleReads | undefined
/** Invocations are recorded while the installed rule actually executes. Nested
 * rules own another frame, including nested cold observers. No helper is left
 * installed after a callback or parser failure. This code stays in this cold
 * module rather than the ordinary parser's eager rule installer. */
function captureRule(run: () => boolean): { accepted: boolean; reads: MarkdownRawRuleReads } {
  const reads: MutableRuleReads = { destinations: [], labels: [] }, previousReads = activeReads
  const destination = markdownEngine.helpers.parseLinkDestination, label = markdownEngine.helpers.parseLinkLabel
  activeReads = reads
  markdownEngine.helpers.parseLinkDestination = (source, start, max) => {
    const result = destination(source, start, max)
    if (activeReads === reads) reads.destinations.push({ source, start, end: result.pos, ok: result.ok, value: result.str })
    return result
  }
  markdownEngine.helpers.parseLinkLabel = (state, start, disableNested) => {
    const end = label(state, start, disableNested)
    if (activeReads === reads) reads.labels.push({ state, start, end })
    return end
  }
  try { return { accepted: run(), reads } }
  finally { activeReads = previousReads; markdownEngine.helpers.parseLinkDestination = destination; markdownEngine.helpers.parseLinkLabel = label }
}

export type MarkdownSourcePhysicalDestination = Readonly<{
  /** Identity receipts only. Facts below never read these mutable objects again. */
  token: Token
  inlineTokens: readonly Token[] | null
  kind: 'link' | 'definition' | 'wiki' | 'autolink'
  syntax: 'markdown' | 'wiki'
  format: 'markdown' | 'html' | 'bare' | 'wiki'
  destination: MarkdownSourceRawSpan | null
  /** Full actual declaration/markup, including a definition's authored title. */
  use: MarkdownSourceRawSpan | null
  url: string
  reference: object | null
  /** Only definitions have an active value. Inactive duplicates stay physical. */
  active: boolean | null
  complete: boolean
}>
export type MarkdownSourceUseOccurrence = Readonly<{
  token: Token
  /** Captured actual inline owner; array identity alone cannot prove scope. */
  owner: Token | null
  inlineTokens: readonly Token[]
  kind: 'direct' | 'reference' | 'wiki' | 'autolink'
  use: MarkdownSourceRawSpan | null
  /** Reference uses share their first definition; they create no physical key. */
  destination: MarkdownSourcePhysicalDestination | null
  reference: object | null
  complete: boolean
}>
export type MarkdownSourceOccurrenceBarrier = Readonly<{
  scope: object
  range: MarkdownSourceRawSpan | null
  reason: string
}>
export interface MarkdownSourceOccurrenceObservation {
  readonly source: string
  /** Same parse as the receipts, not tokens from an equivalent second parse. */
  readonly tokens: readonly Token[]
  readonly physicalDestinations: readonly MarkdownSourcePhysicalDestination[]
  readonly uses: readonly MarkdownSourceUseOccurrence[]
  readonly barriers: readonly MarkdownSourceOccurrenceBarrier[]
  readonly complete: boolean
}

/** Cold source facts only: no target lookup, provenance claims, ledger or UI.
 * Normal parser calls do not opt in, allocate this inventory or change shape.
 * A false complete value is significant even when both inventories are empty. */
export function observeMarkdownSourceOccurrences(source: string, options: { documentTitle?: string } = {}): MarkdownSourceOccurrenceObservation {
  if (typeof source !== 'string' || !options || typeof options !== 'object'
    || options.documentTitle !== undefined && typeof options.documentTitle !== 'string') throw new Error('Invalid Markdown occurrence source')
  const trace = createMarkdownSourceRawTrace(source)
  const physical: MarkdownSourcePhysicalDestination[] = [], uses: MarkdownSourceUseOccurrence[] = [], barriers: MarkdownSourceOccurrenceBarrier[] = []
  const definitions = new Map<object, MarkdownSourcePhysicalDestination>(), observed = new Map<Token, { use: MarkdownSourceUseOccurrence; url: string; tokenType: string; owner: Token | null }>()
  const barrier = (scope: object, range: MarkdownSourceRawSpan | null, reason: string) => {
    barriers.push(Object.freeze({ scope, range, reason }))
  }
  const observer: MarkdownRawOccurrenceObserver = {
    captureRule,
    definition(state, token, startLine, read, reference) {
      const destination = read ? trace.referenceRange(state, startLine, read.source, read.start, read.end) : null
      const use = trace.referenceUse(state, token)
      const active = !!reference && !definitions.has(reference)
      // Native reference normalization belongs to the real installed rule.
      // Its finite decode changes the URL, not the actual helper's raw span.
      const url = read ? state.env.nativeLiteralEscaped ? decodeNativeLiteralText(read.url).content : read.url : ''
      const fact: MarkdownSourcePhysicalDestination = Object.freeze({ token, inlineTokens: null, kind: 'definition', syntax: 'markdown', format: 'markdown',
        destination, use, url, reference: reference ?? null, active, complete: !!destination && !!use && !!reference })
      physical.push(fact)
      // Register the first actual parser object even when its projection is
      // unproven. A later duplicate must never take over that object's source.
      if (reference && active) definitions.set(reference, fact)
      if (!fact.complete) barrier(token, use, 'unmapped-definition')
    },
    link(state, token, rawUse, rawDestination, reference) {
      const use = trace.inlineRange(state, rawUse.start, rawUse.end), owner = trace.inlineOwner(state)
      const isReference = typeof token.meta?.label === 'string'
      const kind = isReference ? 'reference' : rawDestination?.kind === 'wiki' ? 'wiki' : rawDestination?.kind === 'autolink' ? 'autolink' : 'direct'
      const actualUrl = token.type === 'wiki_link' ? rawDestination?.url ?? token.content : token.attrGet('href')
      const stringUrl = typeof actualUrl === 'string'
      // A malformed token has no certified URL. The empty placeholder below
      // belongs only to its incomplete fact, never to an accepted empty href.
      const url = stringUrl ? actualUrl : ''
      if (!stringUrl) barrier(token, use, 'non-string-link-href')
      let destination = isReference ? reference && definitions.get(reference) || null : null
      if (!isReference) {
        const range = rawDestination ? trace.inlineRange(state, rawDestination.start, rawDestination.end) : null
        const fact: MarkdownSourcePhysicalDestination = Object.freeze({ token, inlineTokens: state.tokens,
          kind: rawDestination?.kind === 'wiki' ? 'wiki' : rawDestination?.kind === 'autolink' ? 'autolink' : 'link',
          syntax: rawDestination?.kind === 'wiki' ? 'wiki' : 'markdown',
          format: rawDestination?.kind === 'wiki' ? 'wiki' : rawDestination?.syntax === 'html' ? 'html' : rawDestination?.syntax === 'bare' ? 'bare' : 'markdown',
          destination: range, use, url, reference: null, active: null, complete: stringUrl && !!range && !!use })
        physical.push(fact); destination = fact
      }
      const fact: MarkdownSourceUseOccurrence = Object.freeze({ token, owner, inlineTokens: state.tokens, kind, use,
        destination, reference: reference ?? null, complete: !!owner && stringUrl && !!use && !!destination?.complete && url === destination.url })
      uses.push(fact)
      if (observed.has(token)) barrier(token, use, 'duplicate-actual-token-event')
      observed.set(token, { use: fact, url, tokenType: token.type, owner })
      if (!owner) barrier(token, use, 'unmapped-inline-owner')
      if (!fact.complete) barrier(token, use, isReference ? 'unproven-reference-use' : 'unmapped-direct-use')
    },
    unknownInline(state, start, end, reason) { barrier(state.tokens, trace.inlineRange(state, start, end), reason) }
  }
  const environment = {
    documentTitle: options.documentTitle ?? '', markdownRawOccurrences: observer,
    // Enable the existing HTML creation-point trace. Its legacy global spans
    // are deliberately ignored; only raw relative successful-rule facts above
    // pass through the independent actual token-text projection.
    markdownLinkProvenance: { definition() {}, link() {} }
  }
  const tokens = trace.parse(environment)
  assertNativeContainerParse(environment)
  barriers.push(...trace.scopes)
  const finalTokens = new Map<Token, number>()
  const visit = (items: readonly Token[], owner: Token | null) => {
    for (const token of items) {
      finalTokens.set(token, (finalTokens.get(token) ?? 0) + 1)
      if (token.type === 'image') continue
      const event = observed.get(token)
      if (event && owner !== event.owner) barrier(token, event.use.use, 'post-rule-inline-owner-relocation')
      if (token.type === 'link_open' || token.type === 'wiki_link') {
        if (!event) barrier(token, null, 'unobserved-final-link-token')
        else {
          const url = token.type === 'wiki_link' ? token.content : token.attrGet('href')
          if (typeof url !== 'string') barrier(token, event.use.use, 'non-string-link-href')
          else if (url !== event.url) barrier(token, event.use.use, 'post-rule-link-rewrite')
        }
      }
      if (token.children) visit(token.children, token)
    }
  }
  visit(tokens, null)
  for (const [token, event] of observed) {
    if (!finalTokens.has(token)) barrier(token, event.use.use, 'successful-use-not-in-final-parse')
    else if (finalTokens.get(token) !== 1 || token.type !== event.tokenType) barrier(token, event.use.use, 'post-rule-link-token-rewrite')
  }
  return Object.freeze({ source, tokens, physicalDestinations: Object.freeze(physical), uses: Object.freeze(uses),
    barriers: Object.freeze(barriers), complete: barriers.length === 0 && physical.every(fact => fact.complete) && uses.every(fact => fact.complete) })
}
