import type { StateInline, Token } from 'markdown-it'
import { markdownEngine } from './markdownEngine'
import { observeMarkdownSourceOccurrencesWithPort, type MarkdownSourceOccurrenceBarrier,
  type MarkdownSourceOccurrenceObservation, type MarkdownSourcePhysicalDestination,
  type MarkdownSourceUseOccurrence } from './markdownSourceOccurrences'
import type { MarkdownRawRuleReads } from './markdownSourceLinks'
import type { MarkdownSourceRawSpan, MarkdownSourceRawTrace } from './markdownSourceTrace'

export type MarkdownSourceCarrierFragment = Readonly<{ from: number; to: number; raw: string }>
export type MarkdownSourceCarrierSlot = Readonly<{
  role: 'display' | 'title'
  span: MarkdownSourceRawSpan
  /** Exact raw coverage, not the convex hull through quote/list/native gaps. */
  rawRanges: readonly MarkdownSourceCarrierFragment[]
}>
export type MarkdownSourceCarrierFact = Readonly<{
  use: MarkdownSourceUseOccurrence
  form: 'direct' | 'reference-full' | 'reference-collapsed' | 'reference-shortcut' | null
  display: MarkdownSourceCarrierSlot | null
  title: MarkdownSourceCarrierSlot | null
  titleConsumed: boolean
  destination: MarkdownSourcePhysicalDestination | null
  selector: null | Readonly<{ role: 'reference-selector' | 'combined-selector-display'; span: MarkdownSourceRawSpan }>
  /** Non-slot bytes remain protected, including structural gaps and selectors.
   * Destination bytes are separately protected by destination.destination. */
  shell: readonly MarkdownSourceCarrierFragment[]
  complete: boolean
  reason: string | null
}>
export interface MarkdownSourceCarrierObservation {
  readonly observation: MarkdownSourceOccurrenceObservation
  readonly carriers: readonly MarkdownSourceCarrierFact[]
  readonly barriers: readonly MarkdownSourceOccurrenceBarrier[]
  /** Completeness of actual USE roles, not permission to edit definitions. */
  readonly complete: boolean
}

type LabelRead = { state: StateInline; source: string; max: number; start: number; end: number; disableNested: boolean | undefined }
type DestinationRead = { source: string; max: number; start: number; end: number; ok: boolean; value: string }
type TitleRead = { source: string; max: number; start: number; end: number; ok: boolean; value: string; marker: number; continuation: boolean }
type Push = { token: Token; source: string; from: number; to: number }
type Frame = { state: StateInline; source: string; start: number; max: number; depth: number;
  invalid: boolean; labels: LabelRead[]; destinations: DestinationRead[]; titles: TitleRead[]; pushes: Push[] }
type Accepted = { frame: Frame; push: Push; finalPos: number; finalMax: number; label: unknown;
  title: unknown; href: unknown; tokenType: string; tag: string; nesting: number; reference: object | null }
let activeFrame: Frame | undefined
const point = (value: number, max: number) => Number.isSafeInteger(value) && value >= 0 && value <= max
const inside = (outer: { from: number; to: number }, inner: { from: number; to: number }) => inner.from >= outer.from && inner.to <= outer.to
const same = (left: { from: number; to: number }, right: { from: number; to: number }) => left.from === right.from && left.to === right.to
const fragment = (source: string, from: number, to: number): MarkdownSourceCarrierFragment => Object.freeze({ from, to, raw: source.slice(from, to) })
const only = <T>(values: readonly T[]): T | null => values.length === 1 ? values[0] : null

/** Inspect data descriptors without adding reads of an injected result getter
 * before the installed rule itself reads that result. Unknown helpers cannot
 * confer role authority, but their actual return value is not changed. */
function resultFields(value: object, names: readonly string[]): Record<string, unknown> | null {
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null)
  for (const name of names) {
    const descriptor = descriptors[name]
    if (!descriptor || !('value' in descriptor)) return null
    result[name] = descriptor.value
  }
  return result
}
function dataPush(state: StateInline): StateInline['push'] | null {
  let owner: object | null = state
  const seen = new Set<object>()
  while (owner && !seen.has(owner)) {
    seen.add(owner)
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'push')
    if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function' ? descriptor.value : null
    owner = Object.getPrototypeOf(owner)
  }
  return null
}

/** Only this opt-in path wraps title/push. Silent label lookahead executes
 * inside helper depth, including cached skipToken paths. No role is selected by
 * read order or by a count that includes nested helper invocations. */
function captureInline(state: StateInline, rule: 'link' | 'image', start: number, run: () => boolean,
  acceptedTokens: WeakMap<Token, Accepted>): { accepted: boolean; reads: MarkdownRawRuleReads } {
  const frame: Frame = { state, source: state.src, start, max: state.posMax, depth: 0,
    invalid: false, labels: [], destinations: [], titles: [], pushes: [] }, previous = activeFrame
  const helpers = markdownEngine.helpers, destination = helpers.parseLinkDestination, label = helpers.parseLinkLabel, title = helpers.parseLinkTitle
  // Looking up state.push here would invoke an accessor ahead of the actual
  // rule, and could freeze a getter's changing delegates into one function.
  const ownPush = Object.getOwnPropertyDescriptor(state, 'push'), push = dataPush(state)
  let installed = false
  activeFrame = frame
  try {
    // Keep the actual method receiver and argument count, including delegation
    // through an outer observer wrapper. No private frame becomes a receiver.
    helpers.parseLinkLabel = function (this: typeof helpers, target, from, disableNested) {
      if (activeFrame !== frame) return Reflect.apply(label, this, arguments)
      const depth = frame.depth++, source = target.src, max = target.posMax
      try {
        const end: number = Reflect.apply(label, this, arguments)
        if (depth === 0) frame.labels.push({ state: target, source, max, start: from, end, disableNested })
        return end
      } finally { frame.depth-- }
    }
    helpers.parseLinkDestination = function (this: typeof helpers, source, from, max) {
      if (activeFrame !== frame) return Reflect.apply(destination, this, arguments)
      const depth = frame.depth++
      try {
        const result: ReturnType<typeof destination> = Reflect.apply(destination, this, arguments)
        if (depth === 0) {
          const values = resultFields(result, ['pos', 'ok', 'str'])
          if (!values || typeof values.pos !== 'number' || typeof values.ok !== 'boolean' || typeof values.str !== 'string') frame.invalid = true
          else frame.destinations.push({ source, max, start: from, end: values.pos, ok: values.ok, value: values.str })
        }
        return result
      } finally { frame.depth-- }
    }
    helpers.parseLinkTitle = function (this: typeof helpers, source, from, max, continuation) {
      if (activeFrame !== frame) return Reflect.apply(title, this, arguments)
      const depth = frame.depth++
      try {
        const result: ReturnType<typeof title> = Reflect.apply(title, this, arguments)
        if (depth === 0) {
          const values = resultFields(result, ['pos', 'ok', 'str', 'marker'])
          if (!values || typeof values.pos !== 'number' || typeof values.ok !== 'boolean' || typeof values.str !== 'string' || typeof values.marker !== 'number') frame.invalid = true
          else frame.titles.push({ source, max, start: from, end: values.pos, ok: values.ok, value: values.str, marker: values.marker, continuation: continuation !== undefined })
        }
        return result
      } finally { frame.depth-- }
    }
    if (push && (!ownPush || ownPush.configurable)) {
      Object.defineProperty(state, 'push', { configurable: true, enumerable: ownPush?.enumerable ?? false, writable: true,
        value: function (this: StateInline, type: string, tag: string, nesting: -1 | 0 | 1): Token {
          const source = this.src, from = this.pos, to = this.posMax
          const token = push.call(this, type, tag, nesting)
          if (activeFrame === frame && this === state && type === 'link_open' && frame.depth === 0) frame.pushes.push({ token, source, from, to })
          return token
        } })
      installed = true
    } else frame.invalid = true
    const accepted = run()
    if (accepted && rule === 'link') for (const emitted of frame.pushes) {
      const token = emitted.token, branch = token.meta?.label
      acceptedTokens.set(token, { frame, push: emitted, finalPos: state.pos, finalMax: state.posMax,
        label: branch, title: token.attrGet('title'), href: token.attrGet('href'), tokenType: token.type,
        tag: token.tag, nesting: token.nesting, reference: typeof branch === 'string' ? state.env.references?.[branch] ?? null : null })
    }
    // A nested image's legacy post-processing runs after its real rule frame
    // has returned, with the outer frame active again. Those auxiliary calls
    // have the image/label's actual smaller max, not this rule's entry max.
    // Filter by real invocation context, never href, text or helper order.
    return { accepted, reads: {
      labels: frame.labels.filter(read => read.state === state && read.source === frame.source && read.max === frame.max),
      destinations: frame.destinations.filter(read => read.source === frame.source && read.max === frame.max)
    } }
  } finally {
    try {
      if (installed) {
        if (ownPush) Object.defineProperty(state, 'push', ownPush)
        else delete (state as Partial<StateInline>).push
      }
    } finally {
      helpers.parseLinkDestination = destination; helpers.parseLinkLabel = label; helpers.parseLinkTitle = title; activeFrame = previous
    }
  }
}

function ranges(source: string, span: MarkdownSourceRawSpan): readonly MarkdownSourceCarrierFragment[] | null {
  if (!point(span.from, source.length) || !point(span.to, source.length) || span.to < span.from || span.raw !== source.slice(span.from, span.to)) return null
  if (span.from === span.to) return Object.freeze([])
  const values: Array<{ from: number; to: number }> = []
  for (let index = 0; index < span.projection.starts.length; index++) {
    const from = span.projection.starts[index], to = span.projection.ends[index]
    if (!point(from, source.length) || !point(to, source.length) || to <= from || !inside(span, { from, to })) return null
    const previous = values.at(-1)
    if (previous && from < previous.from) return null
    if (previous && from <= previous.to) previous.to = Math.max(previous.to, to)
    else values.push({ from, to })
  }
  if (values[0]?.from !== span.from || values.at(-1)?.to !== span.to) return null
  return Object.freeze(values.map(value => fragment(source, value.from, value.to)))
}
function slot(source: string, role: MarkdownSourceCarrierSlot['role'], span: MarkdownSourceRawSpan | null): MarkdownSourceCarrierSlot | null {
  const rawRanges = span && ranges(source, span)
  return span && rawRanges ? Object.freeze({ role, span, rawRanges }) : null
}
/** Preserve all gaps; split protection at certified empty insertion slots so
 * a later consumer never has to choose an arbitrary assoc for a zero width. */
function shell(source: string, use: MarkdownSourceRawSpan, slots: readonly MarkdownSourceRawSpan[]): readonly MarkdownSourceCarrierFragment[] | null {
  const editable: MarkdownSourceCarrierFragment[] = [], points: number[] = []
  for (const span of slots) {
    if (!inside(use, span)) return null
    const coverage = ranges(source, span)
    if (!coverage) return null
    editable.push(...coverage)
    if (span.from === span.to) points.push(span.from)
  }
  editable.sort((a, b) => a.from - b.from || a.to - b.to)
  for (let index = 1; index < editable.length; index++) if (editable[index].from < editable[index - 1].to) return null
  const cuts = [...new Set([use.from, use.to, ...points, ...editable.flatMap(value => [value.from, value.to])])].sort((a, b) => a - b)
  const result: MarkdownSourceCarrierFragment[] = []
  let at = 0
  for (let index = 1; index < cuts.length; index++) {
    const from = cuts[index - 1], to = cuts[index]
    while (at < editable.length && editable[at].to <= from) at++
    if (at >= editable.length || editable[at].from >= to) result.push(fragment(source, from, to))
    else if (editable[at].from > from || editable[at].to < to) return null
  }
  return Object.freeze(result)
}

function carrier(source: string, trace: MarkdownSourceRawTrace, state: StateInline, use: MarkdownSourceUseOccurrence, accepted: Accepted | undefined): MarkdownSourceCarrierFact {
  const incomplete = (reason: string): MarkdownSourceCarrierFact => Object.freeze({ use, form: null, display: null, title: null,
    titleConsumed: false, destination: use.destination, selector: null, shell: Object.freeze([]), complete: false, reason })
  if (!use.complete || !use.use || !use.destination?.destination) return incomplete('unproven-actual-use')
  if (!accepted) return incomplete('unsupported-use-role')
  const { frame, push } = accepted
  if (frame.invalid || frame.state !== state || frame.source !== state.src || frame.max !== accepted.finalMax || push.source !== frame.source
    || accepted.tokenType !== 'link_open' || accepted.tag !== 'a' || accepted.nesting !== 1
    || !point(frame.start, frame.source.length) || !point(frame.max, frame.source.length)
    || !point(accepted.finalPos, frame.max) || !point(push.from, frame.max) || !point(push.to, frame.max)) return incomplete('unproven-rule-frame')
  const primary = only(frame.labels.filter(read => read.state === state && read.source === frame.source && read.max === frame.max
    && read.start === frame.start && read.disableNested === true && read.end >= 0 && read.start + 1 === push.from && read.end === push.to))
  if (!primary || primary.start >= primary.end || accepted.finalPos <= primary.end) return incomplete('unproven-primary-label')
  const whole = trace.inlineRange(state, frame.start, accepted.finalPos)
  if (!whole || !same(whole, use.use) || whole.parsed !== use.use.parsed) return incomplete('unproven-final-cursor')
  const displaySpan = trace.inlineRange(state, push.from, push.to)
  if (!displaySpan) return incomplete('unmapped-display')
  if (typeof accepted.label === 'string') {
    if (use.kind !== 'reference' || accepted.reference !== use.reference || accepted.reference === null) return incomplete('unproven-reference-branch')
    const selectors = frame.labels.filter(read => read.state === state && read.source === frame.source && read.max === frame.max
      && read.disableNested === undefined && read.end >= read.start + 1 && accepted.finalPos === read.end + 1)
    const selected = only(selectors)
    let form: 'reference-full' | 'reference-collapsed' | 'reference-shortcut', selectorSpan: MarkdownSourceRawSpan | null
    if (selected) {
      // Accepted malformed-direct fallbacks may consume nonadjacent selectors.
      // They are real uses but are not the normal full-reference role proof.
      if (selected.start !== primary.end + 1) return incomplete('nonadjacent-reference-selector')
      selectorSpan = trace.inlineRange(state, selected.start + 1, selected.end)
      form = selected.end === selected.start + 1 ? 'reference-collapsed' : 'reference-full'
    } else {
      if (selectors.length || accepted.finalPos !== primary.end + 1) return incomplete('unproven-reference-selector')
      selectorSpan = displaySpan; form = 'reference-shortcut'
    }
    if (!selectorSpan) return incomplete('unmapped-reference-selector')
    const display = form === 'reference-full' ? slot(source, 'display', displaySpan) : null
    if (form === 'reference-full' && !display) return incomplete('unmapped-display')
    // Collapsed references select their display, not the consumed empty [].
    const selector = Object.freeze({ role: form === 'reference-full' ? 'reference-selector' as const : 'combined-selector-display' as const,
      span: form === 'reference-full' ? selectorSpan : displaySpan })
    const protectedShell = shell(source, whole, display ? [display.span] : [])
    if (!protectedShell) return incomplete('unmapped-protected-shell')
    return Object.freeze({ use, form, display, title: null, titleConsumed: false, destination: use.destination, selector,
      shell: protectedShell, complete: true, reason: null })
  }
  if (accepted.label !== undefined || use.kind !== 'direct' || use.destination.format !== 'markdown') return incomplete('unproven-direct-branch')
  const read = only(frame.destinations.filter(value => value.source === frame.source && value.max === frame.max))
  if (!read || !point(read.start, frame.max) || frame.source[primary.end + 1] !== '(' || frame.source[accepted.finalPos - 1] !== ')') return incomplete('unproven-direct-destination')
  let titleConsumed = false, titleSlot: MarkdownSourceCarrierSlot | null = null
  if (read.ok) {
    if (!point(read.end, frame.max) || read.end < read.start) return incomplete('unproven-destination-result')
    const titleRead = only(frame.titles.filter(value => value.source === frame.source && value.max === frame.max && !value.continuation))
    if (!titleRead) return incomplete('unproven-title-invocation')
    titleConsumed = titleRead.start > read.end && titleRead.start < frame.max && titleRead.ok
    if (titleConsumed) {
      if (!point(titleRead.end, frame.max) || titleRead.end <= titleRead.start + 1 || titleRead.end > accepted.finalPos - 1
        || ![34, 39, 41].includes(titleRead.marker) || accepted.title !== (titleRead.value || null)) return incomplete('unproven-consumed-title')
      titleSlot = slot(source, 'title', trace.inlineRange(state, titleRead.start + 1, titleRead.end - 1))
      if (!titleSlot) return incomplete('unmapped-title')
    } else if (accepted.title !== null) return incomplete('unproven-title-attribute')
  } else if (frame.titles.length || accepted.title !== null || accepted.href !== '') return incomplete('unproven-empty-destination')
  const display = slot(source, 'display', displaySpan)
  if (!display) return incomplete('unmapped-display')
  const protectedShell = shell(source, whole, [display.span, use.destination.destination, ...(titleSlot ? [titleSlot.span] : [])])
  if (!protectedShell) return incomplete('unmapped-protected-shell')
  return Object.freeze({ use, form: 'direct', display, title: titleSlot, titleConsumed, destination: use.destination, selector: null,
    shell: protectedShell, complete: true, reason: null })
}

/** One actual parse, no target lookup, ledger mutation or new/copy claims.
 * Definitions deliberately have no label/title slots; Wiki/HTML/autolink and
 * unknown scopes remain unsupported role barriers even if raw facts exist. */
export function observeMarkdownSourceCarriers(source: string, options: { documentTitle?: string } = {}): MarkdownSourceCarrierObservation {
  const accepted = new WeakMap<Token, Accepted>(), carriers: MarkdownSourceCarrierFact[] = [], snapshots: Array<{ use: MarkdownSourceUseOccurrence; receipt: Accepted }> = []
  const observation = observeMarkdownSourceOccurrencesWithPort(source, options, {
    captureInlineRule(state, rule, start, run) { return captureInline(state, rule, start, run, accepted) },
    link(trace, state, use) {
      const receipt = accepted.get(use.token)
      carriers.push(carrier(source, trace, state, use, receipt))
      if (receipt) snapshots.push({ use, receipt })
    }
  })
  const barriers: MarkdownSourceOccurrenceBarrier[] = []
  for (const value of carriers) if (!value.complete) barriers.push(Object.freeze({ scope: value.use.token, range: value.use.use, reason: value.reason! }))
  for (const { use, receipt } of snapshots) if (use.token.meta?.label !== receipt.label || use.token.attrGet('title') !== receipt.title
    || use.token.attrGet('href') !== receipt.href || use.token.type !== receipt.tokenType || use.token.tag !== receipt.tag || use.token.nesting !== receipt.nesting)
    barriers.push(Object.freeze({ scope: use.token, range: use.use, reason: 'post-rule-carrier-token-rewrite' }))
  return Object.freeze({ observation, carriers: Object.freeze(carriers), barriers: Object.freeze(barriers),
    complete: observation.complete && barriers.length === 0 && carriers.length === observation.uses.length })
}
