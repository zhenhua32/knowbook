import { markdownEngine } from '@shared/markdownEngine'
import { collectDocumentMarkdownLinks, type MarkdownDocumentLink } from '@shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'
import { type MarkdownSourceOccurrenceObservation,
  type MarkdownSourcePhysicalDestination, type MarkdownSourceUseOccurrence } from '@shared/markdownSourceOccurrences'
import { observeMarkdownSourceCarriers, type MarkdownSourceCarrierFact, type MarkdownSourceCarrierFragment,
  type MarkdownSourceCarrierObservation } from '@shared/markdownSourceCarriers'
import { serializeMarkdownWithEmissionTrace, projectMarkdownEmissionContentRange, projectMarkdownEmissionSourceRange } from '@shared/markdownEmissionTrace'
import { type MarkdownSourceRawSpan } from '@shared/markdownSourceTrace'
import { validateSyncedBindingClaims } from '@shared/syncedBlockInputs'
import { SyncedValidationError, validateSyncedCanonicalEdit, validateSyncedOrigin } from '@shared/syncedBlockValidation'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedCanonicalEdit, SyncedGroupGuard, SyncedOriginV1 } from '@shared/synced-blocks'
import { replaceMarkdownSourceChanges, type MarkdownSourceChange, type MarkdownSourceDraft } from '../../utils/markdownSourceDraft'
import { createMarkdownSourceSession } from '../../utils/markdownSourceSession'
import { applySyncedSourceGroupWithEndpoint, captureSyncedSourceEndpoint, finalizeSyncedSourceReadOwner, readSyncedWorkingEndpointCommitted,
  type SyncedCommittedEndpointReceipt, type SyncedWorkingEndpointReceipt, type SyncedSourceEndpointOpening } from './controller'
import type { SourceReadOwner, SourceReadOwnerAccess, AdoptedSourceSide, SourceSideAdoptionResult, AdoptedSourceSideFacts } from './sourceReadOwner'
export type { SourceReadOwner, AdoptedSourceSide, SourceSideAdoptionResult, AdoptedSourceSideFacts } from './sourceReadOwner'
import { syncedBindingClaimsAreIdentity } from './bindingClaims'
import type { SyncedGroupBinding, SyncedScopeBookmark } from './types'
import { allocateCanonicalSourceDraft, createCanonicalSourceAllocationBasis, readCanonicalSourceAllocation,
  canonicalSourceDraftToBlocksWithManifest, createCanonicalSourceDraftWithManifest, projectOpeningContentRange, projectOpeningSourceRange,
  projectSourceReconciliationContentRange, projectSourceReconciliationRawRange,
  readMarkdownSourceDraftReceipt, readMarkdownSourceOpeningManifest, readMarkdownSourceReconciliationManifest,
  type CanonicalSourceAllocation, type MarkdownSourceAllocationBasis, type MarkdownSourceDraftReceipt,
  type MarkdownSourceOpeningManifest, type MarkdownSourceReconciliationManifest } from './sourceManifest'

type Span = Readonly<{ from: number; to: number }>
type Physical = MarkdownSourcePhysicalDestination
type Observation = MarkdownSourceOccurrenceObservation
type Format = 'markdown' | 'html' | 'bare' | 'wiki'
export interface SourceLedgerOpening { readonly kind: 'source-ledger-opening' }
export type SourceLedgerDraft = MarkdownSourceDraft
export interface SourceScopeLease {
  readonly groupId: string
  readonly hostDocumentId: string
  readonly windowSessionId: string
  readonly hostSession: object
  readonly mountEpoch: object
  readonly bindingEpoch: object
  readonly instanceId: string
  readonly bindingVersion: string
}
export interface SourceFirstApplyLease {
  readonly scope: Readonly<SourceScopeLease>
  readonly expectedEditSequence: number
  readonly guards: Readonly<SyncedGroupGuard>
}
export interface PreparedSourceFirstApply { readonly kind: 'source-first-apply' }
export interface SourceRawFragment extends Span {
  readonly generation: string
  readonly openingFrom: number | null
}
export interface SourceLedgerCandidateFacts {
  readonly opening: SourceLedgerOpening
  readonly receipt: MarkdownSourceDraftReceipt
  readonly beforeReceipt: MarkdownSourceDraftReceipt | null
  readonly fragments: readonly SourceRawFragment[]
  readonly uncertainReason: string | null
}
export interface PreparedSourceFirstApplyFacts {
  readonly draft: SourceLedgerDraft
  readonly opening: SourceLedgerOpening
  readonly draftReceipt: MarkdownSourceDraftReceipt
  readonly lease: SourceFirstApplyLease
  readonly reconciliationManifest: MarkdownSourceReconciliationManifest
  readonly blocks: readonly SyncedCanonicalEdit[]
  readonly bindingClaims: readonly SyncedBindingClaim[]
  readonly hasIntent: boolean
}

type Birth = Readonly<{ receipt: MarkdownSourceDraftReceipt; inserted: Span; via: 'use' | 'destination' }>
  | Readonly<{ receipt: MarkdownSourceDraftReceipt; beforeReceipt: MarkdownSourceDraftReceipt;
      generation: object; destination: Span; via: 'carrier-destination' }>
type Lineage = Readonly<{ source: Readonly<SyncedBindingKey> | null; birth: Birth | null; proven: boolean }>
type Root = { opening: SourceLedgerOpening; manifest: MarkdownSourceOpeningManifest; origin: Readonly<SyncedOriginV1>;
  lease: SourceFirstApplyLease; grammar: readonly unknown[] }
type ReconcileMemo = { kind: 'ready'; value: ReturnType<typeof canonicalSourceDraftToBlocksWithManifest> } | { kind: 'error'; error: unknown }
type Data = { root: Root; facts: SourceLedgerCandidateFacts; observation: Observation | null; roles: MarkdownSourceCarrierObservation | null;
  lineage: ReadonlyMap<Physical, Lineage>; parent?: Data; reconcileMemo?: ReconcileMemo; prepared?: PreparedSourceFirstApply;
  allocation?: CanonicalSourceAllocation; allocationBasis?: MarkdownSourceAllocationBasis;
  geometryMemo?: { manifest: MarkdownSourceReconciliationManifest; result: ReturnType<typeof geometry> } }
type ContentSpan = Span & { index: number }
type LocatedPhysical = { fact: Physical; destination: ContentSpan; use: ContentSpan }
const drafts = new WeakMap<SourceLedgerDraft, Data>()
const openings = new WeakSet<SourceLedgerOpening>()
const prepared = new WeakMap<PreparedSourceFirstApply, PreparedSourceFirstApplyFacts>()
const keyId = (key: Readonly<SyncedBindingKey>) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
const spanId = (span: ContentSpan) => JSON.stringify([span.index, span.from, span.to])
const rawId = (span: Span) => JSON.stringify([span.from, span.to])
const sameSpan = (left: Span | null, right: Span | null) => !!left && !!right && left.from === right.from && left.to === right.to
const sameArray = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((value, index) => value === right[index])
function fail(message: string): never { throw new SyncedValidationError('binding', message + '，未生成来源声明，请保留草稿。') }
const eligible = (origin: Readonly<SyncedOriginV1>, fact: Pick<Physical, 'syntax' | 'url'>) =>
  fact.syntax === 'wiki' || resolveMarkdownDocumentPath(origin.pathAtCreation, fact.url) !== null

/** Only grammar/configuration identities. This never matches source or URLs. */
function grammar(): readonly unknown[] {
  const values: unknown[] = [markdownEngine.parse, markdownEngine.parseInline, markdownEngine.block.parse, markdownEngine.block.State,
    markdownEngine.inline.parse, markdownEngine.core.process, markdownEngine.normalizeLink, markdownEngine.validateLink,
    markdownEngine.helpers.parseLinkLabel, markdownEngine.helpers.parseLinkDestination, markdownEngine.helpers.parseLinkTitle,
    markdownEngine.inline.State, observeMarkdownSourceCarriers]
  const push = Object.getOwnPropertyDescriptor(markdownEngine.inline.State.prototype, 'push')
  values.push(push?.value, push?.get, push?.set, push?.configurable, push?.enumerable, push?.writable)
  for (const [key, value] of Object.entries(markdownEngine.options)) values.push(key, value)
  for (const ruler of [markdownEngine.core.ruler, markdownEngine.block.ruler, markdownEngine.inline.ruler, markdownEngine.inline.ruler2])
    for (const rule of ruler.__rules__) values.push(rule.name, rule.enabled, rule.fn, ...(rule.alt ?? []), null)
  const linkify = markdownEngine.linkify as unknown as { __opts__?: Record<string, unknown>; __schemas__?: Record<string, unknown> }
  for (const [key, value] of Object.entries(linkify.__opts__ ?? {})) values.push(key, value)
  for (const [key, value] of Object.entries(linkify.__schemas__ ?? {})) {
    values.push(key)
    if (value && typeof value === 'object') for (const [field, item] of Object.entries(value)) values.push(field, item)
    else values.push(value)
    values.push(null)
  }
  return Object.freeze(values)
}
/** Adoption only: close the same grammar surface after its final callout.
 * Descriptor reads never evaluate a grammar accessor. Ordinary editing keeps
 * its existing codec; an accessor-bearing configuration cannot adopt a side. */
function ownDataGrammar(): readonly unknown[] | null {
  try {
    const get = (input: unknown, key: string): unknown => {
      if (!input || typeof input !== 'object' && typeof input !== 'function') throw new Error('Invalid grammar object')
      let current: object | null = input
      while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor) {
          if (!Object.hasOwn(descriptor, 'value')) throw new Error('Grammar accessor')
          return descriptor.value
        }
        current = Object.getPrototypeOf(current) as object | null
      }
      return undefined
    }
    const entries = (input: unknown): Array<[string, unknown]> => {
      if (!input || typeof input !== 'object') throw new Error('Invalid grammar entries')
      return Object.entries(Object.getOwnPropertyDescriptors(input)).filter(([, descriptor]) => descriptor.enumerable)
        .map<[string, unknown]>(([key, descriptor]) => {
          if (!Object.hasOwn(descriptor, 'value')) throw new Error('Grammar accessor')
          return [key, descriptor.value]
        })
    }
    const array = (input: unknown): unknown[] => {
      if (!Array.isArray(input)) throw new Error('Invalid grammar array')
      const length = get(input, 'length')
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new Error('Invalid grammar array')
      const result: unknown[] = []
      for (let index = 0; index < length; index++) result.push(get(input, String(index)))
      return result
    }
    const block = get(markdownEngine, 'block'), inline = get(markdownEngine, 'inline'), core = get(markdownEngine, 'core')
    const helpers = get(markdownEngine, 'helpers'), inlineState = get(inline, 'State')
    const values: unknown[] = [get(markdownEngine, 'parse'), get(markdownEngine, 'parseInline'), get(block, 'parse'), get(block, 'State'),
      get(inline, 'parse'), get(core, 'process'), get(markdownEngine, 'normalizeLink'), get(markdownEngine, 'validateLink'),
      get(helpers, 'parseLinkLabel'), get(helpers, 'parseLinkDestination'), get(helpers, 'parseLinkTitle'), inlineState, observeMarkdownSourceCarriers]
    const prototype = get(inlineState, 'prototype')
    if (!prototype || typeof prototype !== 'object') return null
    const push = Object.getOwnPropertyDescriptor(prototype, 'push')
    if (push && !Object.hasOwn(push, 'value')) return null
    values.push(push?.value, push?.get, push?.set, push?.configurable, push?.enumerable, push?.writable)
    for (const [key, value] of entries(get(markdownEngine, 'options'))) values.push(key, value)
    for (const ruler of [get(core, 'ruler'), get(block, 'ruler'), get(inline, 'ruler'), get(inline, 'ruler2')])
      for (const rule of array(get(ruler, '__rules__'))) {
        const alt = get(rule, 'alt')
        values.push(get(rule, 'name'), get(rule, 'enabled'), get(rule, 'fn'), ...(alt === undefined || alt === null ? [] : array(alt)), null)
      }
    const linkify = get(markdownEngine, 'linkify'), options = get(linkify, '__opts__'), schemas = get(linkify, '__schemas__')
    for (const [key, value] of entries(options ?? {})) values.push(key, value)
    for (const [key, value] of entries(schemas ?? {})) {
      values.push(key)
      if (value && typeof value === 'object') for (const [field, item] of entries(value)) values.push(field, item)
      else values.push(value)
      values.push(null)
    }
    return values
  } catch { return null }
}
function plain(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return fail('来源上下文不是封闭数据')
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return fail('来源上下文字段不完整')
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fail('来源上下文不能包含访问器')
    result[key] = descriptor.value
  }
  return result
}
function lease(input: SourceFirstApplyLease): SourceFirstApplyLease {
  const value = plain(input, ['scope', 'expectedEditSequence', 'guards'])
  const scope = plain(value.scope, ['groupId', 'hostDocumentId', 'windowSessionId', 'hostSession', 'mountEpoch', 'bindingEpoch', 'instanceId', 'bindingVersion'])
  const guards = plain(value.guards, ['groupId', 'expectedRevision', 'expectedTopologyRevision'])
  for (const key of ['groupId', 'hostDocumentId', 'windowSessionId', 'instanceId', 'bindingVersion'])
    if (typeof scope[key] !== 'string' || !scope[key]) fail('来源 scope 不完整')
  for (const key of ['hostSession', 'mountEpoch', 'bindingEpoch']) if (!scope[key] || typeof scope[key] !== 'object') fail('来源 epoch 不完整')
  for (const key of ['groupId', 'expectedRevision', 'expectedTopologyRevision']) if (typeof guards[key] !== 'string' || !guards[key]) fail('来源 guard 不完整')
  if (typeof value.expectedEditSequence !== 'number' || !Number.isSafeInteger(value.expectedEditSequence)
    || value.expectedEditSequence < 0 || guards.groupId !== scope.groupId) fail('来源版本不一致')
  // Epoch objects are identity values only; never clone or freeze caller objects.
  return Object.freeze({ scope: Object.freeze(scope) as unknown as SourceScopeLease, expectedEditSequence: value.expectedEditSequence as number,
    guards: Object.freeze(guards) as unknown as SyncedGroupGuard })
}
function sameLease(left: SourceFirstApplyLease, right: SourceFirstApplyLease): boolean {
  return left.expectedEditSequence === right.expectedEditSequence
    && Object.keys(left.scope).every(key => left.scope[key as keyof SourceScopeLease] === right.scope[key as keyof SourceScopeLease])
    && Object.keys(left.guards).every(key => left.guards[key as keyof SyncedGroupGuard] === right.guards[key as keyof SyncedGroupGuard])
}
function data(draft: SourceLedgerDraft): Data {
  const value = drafts.get(draft)
  if (!value || !openings.has(value.root.opening) || readMarkdownSourceDraftReceipt(draft) !== value.facts.receipt) return fail('草稿没有本次来源账本')
  if (!sameArray(value.root.grammar, grammar())) return fail('Markdown 语法上下文已变化')
  if (readMarkdownSourceDraftReceipt(draft) !== value.facts.receipt) return fail('语法回调期间实际草稿已变化')
  return value
}
function observe(source: string): { observation: Observation | null; roles: MarkdownSourceCarrierObservation | null; reason: string | null } {
  try {
    const roles = observeMarkdownSourceCarriers(source), observation = roles.observation
    // Unsupported roles do not invalidate an unchanged whole-use witness.
    // Fine edits below must positively prove their particular role instead.
    return { observation, roles, reason: observation.complete ? null : '存在尚未证明的实际解析范围' }
  } catch { return { observation: null, roles: null, reason: '当前源码的实际解析未闭合' } }
}
function links(blocks: readonly SyncedCanonicalEdit[], origin: Readonly<SyncedOriginV1>): MarkdownDocumentLink[] {
  return collectDocumentMarkdownLinks([...blocks]).filter(link => link.kind !== 'image'
    && (link.kind === 'wiki' || resolveMarkdownDocumentPath(origin.pathAtCreation, link.url) !== null))
}
function linkKey(link: MarkdownDocumentLink, blocks: readonly SyncedCanonicalEdit[]): Readonly<SyncedBindingKey> {
  const block = blocks[link.blockIndex]
  if (!block || link.blockId !== block.id || !Number.isSafeInteger(link.start) || !Number.isSafeInteger(link.end)
    || link.start < 0 || link.end < link.start || link.end > block.content.length) return fail('实际目的地无法映射到最终块')
  return Object.freeze({ blockId: block.id, from: link.start, to: link.end, raw: block.content.slice(link.start, link.end),
    syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' })
}
function format(link: MarkdownDocumentLink): Format { return link.kind === 'wiki' ? 'wiki' : link.syntax === 'html' ? 'html' : link.syntax === 'bare' ? 'bare' : 'markdown' }
function role(link: MarkdownDocumentLink, fact: Physical): boolean { return link.kind === fact.kind && format(link) === fact.format }
function unique<T>(items: readonly T[], message: string): T { return items.length === 1 ? items[0] : fail(message) }
function indexBy<T>(items: readonly T[], identity: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const item of items) { const key = identity(item), values = result.get(key) ?? []; values.push(item); result.set(key, values) }
  return result
}
/** Coordinates select possible payloads only. A projector still has to prove
 * the exact range in both directions; boundaries may have multiple candidates. */
function domains<T>(values: readonly { span: Span; value: T }[]): (span: Span) => T[] {
  const sorted = values.toSorted((left, right) => left.span.from - right.span.from || left.span.to - right.span.to)
  for (let index = 1; index < sorted.length; index++)
    if (sorted[index - 1].span.to > sorted[index].span.from) fail('实际 payload 域重叠，不能唯一归属')
  return span => {
    let low = 0, high = sorted.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (sorted[middle].span.to < span.from) low = middle + 1
      else high = middle
    }
    const result: T[] = []
    for (let index = low; index < sorted.length && sorted[index].span.from <= span.from; index++)
      if (contains(sorted[index].span, span)) result.push(sorted[index].value)
    return result
  }
}
function checkedObservation(value: Observation | null): Observation {
  if (!value?.complete || value.barriers.length || value.physicalDestinations.some(fact => !fact.complete || !fact.destination || !fact.use)
    || value.uses.some(use => !use.complete || !use.use || !use.owner || !use.destination)) return fail('实际 occurrence 仍有未知范围')
  return value
}

export function openCanonicalSourceLedger(input: { blocks: readonly SyncedCanonicalEdit[]; origin: Readonly<SyncedOriginV1>; lease: SourceFirstApplyLease }): {
  draft: SourceLedgerDraft; opening: SourceLedgerOpening
} {
  const origin = Object.freeze(validateSyncedOrigin(input.origin)), currentLease = lease(input.lease)
  const created = createCanonicalSourceDraftWithManifest(input.blocks), observed = observe(created.draft.source)
  const opening: SourceLedgerOpening = Object.freeze({ kind: 'source-ledger-opening' })
  const root: Root = { opening, manifest: created.openingManifest, origin, lease: currentLease, grammar: grammar() }
  const lineage = new Map<Physical, Lineage>()
  let reason = observed.reason
  if (observed.observation?.complete) {
    try {
      const facts = readMarkdownSourceOpeningManifest(created.openingManifest), original = validateSyncedCanonicalEdit(facts.blocks)
      const actual = links(original, origin), used = new Set<Physical>(), seen = new Set<string>()
      const byRaw = indexBy(observed.observation.physicalDestinations.filter(fact => fact.destination), fact => rawId(fact.destination!))
      for (const link of actual) {
        const key = linkKey(link, original), span = projectOpeningContentRange(created.openingManifest, link.blockIndex, key.from, key.to)
        if (!span || !sameSpan(projectOpeningSourceRange(created.openingManifest, link.blockIndex, span.from, span.to), key)) fail('初始目的地投影不唯一')
        const fact = unique(byRaw.get(rawId(span)) ?? [], '初始 physical 目的地不唯一')
        if (used.has(fact) || seen.has(keyId(key)) || !role(link, fact) || link.url !== fact.url) fail('初始 physical 目的地闭集不一致')
        used.add(fact); seen.add(keyId(key)); lineage.set(fact, Object.freeze({ source: key, birth: null, proven: true }))
      }
      for (const fact of observed.observation.physicalDestinations) {
        if (eligible(origin, fact) && !used.has(fact)) fail('初始 physical 目的地未覆盖全部实际 Key')
        if (!lineage.has(fact)) lineage.set(fact, Object.freeze({ source: null, birth: null, proven: true }))
      }
    } catch { reason = '初始 canonical Key 与原始 occurrence 尚未闭合' }
  }
  const receipt = readMarkdownSourceDraftReceipt(created.draft)
  openings.add(opening)
  drafts.set(created.draft, { root, observation: observed.observation, roles: observed.roles, lineage, facts: Object.freeze({ opening, receipt, beforeReceipt: null,
    fragments: Object.freeze(created.draft.source ? [Object.freeze({ from: 0, to: created.draft.source.length, openingFrom: 0, generation: receipt.token })] : []),
    uncertainReason: reason }) })
  return { draft: created.draft, opening }
}
export function readCanonicalSourceLedgerCandidate(draft: SourceLedgerDraft): SourceLedgerCandidateFacts { return data(draft).facts }

/** This is a pure EditorState adapter, not a View/Apply integration. Candidate
 * construction still never advances a global accepted head. */
export function createCanonicalSourceLedgerSession(input: {
  draft: SourceLedgerDraft; isCurrent?: () => boolean; onError?: (error: unknown) => void
}): ReturnType<typeof createMarkdownSourceSession<SourceLedgerDraft>> {
  const keys = ['draft', ...['isCurrent', 'onError'].filter(key => Object.hasOwn(input, key))]
  const parameters = plain(input, keys), draft = parameters.draft as SourceLedgerDraft, root = data(draft).root
  if (parameters.isCurrent !== undefined && typeof parameters.isCurrent !== 'function'
    || parameters.onError !== undefined && typeof parameters.onError !== 'function') fail('session 回调不是实际函数')
  const isCurrent = parameters.isCurrent as (() => boolean) | undefined, onError = parameters.onError as ((error: unknown) => void) | undefined
  return createMarkdownSourceSession({ draft, isCurrent: isCurrent ? () => isCurrent() : undefined,
    onError: onError ? error => onError(error) : undefined, replaceChanges: forkCanonicalSourceLedger,
    validateDraft(candidate) { if (data(candidate).root !== root) fail('replay 不属于本次 opening') } })
}

/** Positive ranges survive only when every byte survives. Boundary insertions
 * are outside the old range; insertions strictly inside retire the carrier. */
function mapped(span: Span, changes: readonly Readonly<MarkdownSourceChange>[], shifts: readonly number[]): Span | null {
  if (span.from === span.to) return null // empty destinations map with a surviving full use, never arbitrary assoc
  let low = 0, high = changes.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (changes[middle].to <= span.from) low = middle + 1
    else high = middle
  }
  if (low < changes.length && changes[low].from < span.to) return null
  const shift = shifts[low]
  return { from: span.from + shift, to: span.to + shift }
}
function applyFragments(before: readonly SourceRawFragment[], changes: readonly Readonly<MarkdownSourceChange>[], length: number, generation: string) {
  const result: SourceRawFragment[] = [], inserted: Span[] = []
  let at = 0, output = 0, fragmentIndex = 0
  const copy = (from: number, to: number) => {
    while (fragmentIndex < before.length && before[fragmentIndex].to <= from) fragmentIndex++
    while (fragmentIndex < before.length && before[fragmentIndex].from < to) {
      const fragment = before[fragmentIndex]
      const first = Math.max(from, fragment.from), last = Math.min(to, fragment.to)
      if (first < last) {
        result.push(Object.freeze({ from: output, to: output + last - first, generation: fragment.generation,
          openingFrom: fragment.openingFrom === null ? null : fragment.openingFrom + first - fragment.from }))
        output += last - first
      }
      if (fragment.to > to) break
      fragmentIndex++
    }
  }
  for (const change of changes) {
    copy(at, change.from)
    if (change.insert) {
      const span = Object.freeze({ from: output, to: output + change.insert.length })
      inserted.push(span); result.push(Object.freeze({ ...span, openingFrom: null, generation })); output = span.to
    }
    at = change.to
  }
  copy(at, length)
  return { fragments: Object.freeze(result), inserted }
}
const contains = (outer: Span, inner: Span) => outer.from <= inner.from && outer.to >= inner.to
function projectionShape(fact: Physical): string {
  const part = (span: Physical['use']) => span && [span.parsed, span.projection.starts.map(at => at - span.from),
    span.projection.ends.map(at => at - span.from), span.projection.boundaries.map(points => points.map(at => at - span.from))]
  return JSON.stringify([part(fact.use), part(fact.destination)])
}
type SlotName = 'display' | 'title' | 'destination'
type EditSlot = { name: SlotName; span: MarkdownSourceRawSpan; coverage: readonly Span[]; cuts: ReadonlySet<number> }
type Layout = { form: 'direct' | 'reference-full' | 'definition'; whole: MarkdownSourceRawSpan;
  slots: readonly EditSlot[]; shell: readonly MarkdownSourceCarrierFragment[] }
type PlannedLayout = { whole: Span; slots: readonly { name: SlotName; span: Span; coverage: readonly Span[] }[];
  shell: readonly Span[]; edited: boolean; destinationChanged: boolean }
function coverage(span: MarkdownSourceRawSpan): Span[] {
  const result: Array<{ from: number; to: number }> = []
  for (let index = 0; index < span.projection.starts.length; index++) {
    const from = span.projection.starts[index], to = span.projection.ends[index], previous = result.at(-1)
    if (previous && from <= previous.to) previous.to = Math.max(previous.to, to)
    else result.push({ from, to })
  }
  return result
}
function editSlot(name: SlotName, span: MarkdownSourceRawSpan): EditSlot {
  // A normalized CRLF or codec group cannot be cut in half. Multiple raw
  // candidates at a removed structural gap do not confer an insertion affinity.
  const counts = new Map<number, number>()
  for (const points of span.projection.boundaries) if (points.length === 1) counts.set(points[0], (counts.get(points[0]) ?? 0) + 1)
  return { name, span, coverage: coverage(span), cuts: new Set([...counts].filter(([, count]) => count === 1).map(([at]) => at)) }
}
function carrierIndex(roles: MarkdownSourceCarrierObservation | null): Map<MarkdownSourceUseOccurrence, MarkdownSourceCarrierFact> {
  const result = new Map<MarkdownSourceUseOccurrence, MarkdownSourceCarrierFact>()
  const blocked = new Set(roles?.barriers.map(value => value.scope) ?? [])
  for (const role of roles?.carriers ?? []) if (role.complete && !blocked.has(role.use.token)) result.set(role.use, role)
  return result
}
function roleLayout(role: MarkdownSourceCarrierFact | undefined): Layout | null {
  if (!role?.complete || !role.use.use || !role.display || role.form !== 'direct' && role.form !== 'reference-full') return null
  const slots = [editSlot('display', role.display.span)]
  if (role.form === 'direct') {
    if (!role.destination?.destination) return null
    slots.push(editSlot('destination', role.destination.destination))
    if (role.title) slots.push(editSlot('title', role.title.span))
    else if (role.titleConsumed) return null
  }
  return { form: role.form, whole: role.use.use, slots, shell: role.shell }
}
/** A definition has one allowed slot from the actual destination helper. Its
 * label/title/whitespace and every source gap remain positively protected. */
function definitionLayout(fact: Physical, source: string): Layout | null {
  if (fact.kind !== 'definition' || !fact.complete || !fact.use || !fact.destination) return null
  const destination = editSlot('destination', fact.destination), parts: MarkdownSourceCarrierFragment[] = []
  let from = fact.use.from
  const add = (to: number) => { if (to > from) parts.push(Object.freeze({ from, to, raw: source.slice(from, to) })); from = to }
  for (const span of destination.coverage) { add(span.from); from = span.to }
  if (!destination.coverage.length) add(destination.span.from)
  add(fact.use.to)
  return { form: 'definition', whole: fact.use, slots: [destination], shell: parts }
}
function relevant(span: Span, changes: readonly Readonly<MarkdownSourceChange>[]): number[] {
  let low = 0, high = changes.length
  while (low < high) { const middle = (low + high) >>> 1; if (changes[middle].to < span.from) low = middle + 1; else high = middle }
  const result: number[] = []
  for (let index = low; index < changes.length && changes[index].from <= span.to; index++) {
    const change = changes[index]
    if (change.from === change.to ? change.from >= span.from && change.from <= span.to : change.from < span.to && change.to > span.from) result.push(index)
  }
  return result
}
function owningRange(change: Readonly<MarkdownSourceChange>, slot: EditSlot): number | null {
  if (!slot.cuts.has(change.from) || !slot.cuts.has(change.to)) return null
  const ranges = slot.coverage.length ? slot.coverage : [slot.span]
  let low = 0, high = ranges.length
  while (low < high) { const middle = (low + high) >>> 1; if (ranges[middle].to < change.from) low = middle + 1; else high = middle }
  return low < ranges.length && contains(ranges[low], change) ? low : null
}
/** Inclusion is a candidate for one actual slot, subsequently verified against
 * both the actual after slot and all surviving shell bytes. It is not a default
 * CM assoc for arbitrary zero-width ranges. */
function changedArea(span: Span, owned: readonly number[], changes: readonly Readonly<MarkdownSourceChange>[], shifts: readonly number[]): Span {
  let low = 0, high = changes.length
  while (low < high) { const middle = (low + high) >>> 1; if (changes[middle].to <= span.from) low = middle + 1; else high = middle }
  let prefix = shifts[low], change = 0
  for (const index of owned) {
    const item = changes[index], delta = item.insert.length - (item.to - item.from)
    change += delta
    if (item.to <= span.from) prefix -= delta
  }
  return { from: span.from + prefix, to: span.to + prefix + change }
}
function planLayout(layout: Layout, changes: readonly Readonly<MarkdownSourceChange>[], shifts: readonly number[]): PlannedLayout | null {
  const relevantChanges = relevant(layout.whole, changes), assigned = new Map<EditSlot, Map<number, number[]>>()
  for (const index of relevantChanges) {
    const change = changes[index], owners = layout.slots.flatMap(slot => {
      const range = owningRange(change, slot)
      return range === null ? [] : [{ slot, range }]
    })
    // Boundary insertions outside the whole use belong to neither its shell nor
    // a slot. Interior/cross-boundary edits require exactly one positive owner.
    if (!owners.length && change.from === change.to && (change.from === layout.whole.from || change.from === layout.whole.to)) continue
    if (owners.length !== 1) return null
    const owner = owners[0], ranges = assigned.get(owner.slot) ?? new Map<number, number[]>()
    const values = ranges.get(owner.range) ?? []; values.push(index); ranges.set(owner.range, values); assigned.set(owner.slot, ranges)
  }
  const owned = [...assigned.values()].flatMap(ranges => [...ranges.values()].flat()), shell: Span[] = []
  for (const part of layout.shell) { const next = mapped(part, changes, shifts); if (!next) return null; shell.push(next) }
  const slots: PlannedLayout['slots'][number][] = []
  for (const slot of layout.slots) {
    const indices = assigned.get(slot), ranges = slot.coverage.length ? slot.coverage : [slot.span], moved: Span[] = []
    for (let index = 0; index < ranges.length; index++) moved.push(changedArea(ranges[index], indices?.get(index) ?? [], changes, shifts))
    const actualCoverage: Array<{ from: number; to: number }> = []
    for (const span of moved) if (span.to > span.from) {
      const previous = actualCoverage.at(-1)
      if (previous && span.from <= previous.to) previous.to = Math.max(previous.to, span.to)
      else actualCoverage.push({ ...span })
    }
    slots.push({ name: slot.name, span: { from: moved[0].from, to: moved.at(-1)!.to }, coverage: actualCoverage })
  }
  return { whole: changedArea(layout.whole, owned, changes, shifts), slots, shell, edited: owned.length > 0,
    destinationChanged: layout.slots.some(slot => slot.name === 'destination' && (assigned.get(slot)?.size ?? 0) > 0) }
}
function matchesLayout(before: Layout, plan: PlannedLayout, after: Layout, source: string): boolean {
  if (before.form !== after.form || !sameSpan(plan.whole, after.whole) || plan.slots.length !== after.slots.length
    || plan.shell.length !== after.shell.length) return false
  for (let index = 0; index < plan.slots.length; index++) {
    const one = plan.slots[index], two = after.slots[index]
    if (one.name !== two.name || !sameSpan(one.span, two.span) || one.coverage.length !== two.coverage.length
      || one.coverage.some((part, at) => !sameSpan(part, two.coverage[at]))) return false
  }
  return plan.shell.every((span, index) => sameSpan(span, after.shell[index])
    && before.shell[index].raw === source.slice(span.from, span.to) && after.shell[index].raw === before.shell[index].raw)
}
export function forkCanonicalSourceLedger(before: SourceLedgerDraft, rawChanges: readonly MarkdownSourceChange[]): SourceLedgerDraft {
  const previous = data(before)
  // Keep the original caller array intact; the actual cold draft port validates
  // its own dense data snapshot before replacement and receipt capture.
  const next = replaceMarkdownSourceChanges(before, rawChanges as MarkdownSourceChange[])
  if (next === before) return before
  const receipt = readMarkdownSourceDraftReceipt(next), changes = receipt.rawChanges
    .filter(change => change.from !== change.to || change.insert !== '').toSorted((a, b) => a.from - b.from || a.to - b.to)
  if (receipt.opening !== previous.facts.receipt.opening || receipt.revision !== previous.facts.receipt.revision + 1) fail('候选 before 边不一致')
  const fragments = applyFragments(previous.facts.fragments, changes, before.source.length, receipt.token), observed = observe(next.source)
  let cursor = 0
  const replayed = changes.map(change => { const part = before.source.slice(cursor, change.from) + change.insert; cursor = change.to; return part }).join('') + before.source.slice(cursor)
  if (replayed !== next.source || fragments.fragments.some((fragment, index) => fragment.from !== (index ? fragments.fragments[index - 1].to : 0))
    || (fragments.fragments.at(-1)?.to ?? 0) !== next.source.length) fail('实际候选与 raw survivor 边不一致')
  const wholeReplacement = changes.length === 1 && changes[0].from === 0 && changes[0].to === before.source.length
  let reason = observed.reason ?? (!wholeReplacement ? previous.facts.uncertainReason : null)
  const lineage = new Map<Physical, Lineage>(), consumed = new Set<Physical>()
  const shifts = [0]
  for (const change of changes) shifts.push(shifts.at(-1)! + change.insert.length - (change.to - change.from))
  const oldPaths: Array<{ fact: Physical; use: Span; destination: Span }> = []
  for (const fact of previous.observation?.physicalDestinations ?? []) {
    if (!fact.use || !fact.destination) continue
    const use = mapped(fact.use, changes, shifts)
    if (use) { const shift = use.from - fact.use.from; oldPaths.push({ fact, use,
      destination: { from: fact.destination.from + shift, to: fact.destination.to + shift } }) }
  }
  const oldByGeometry = indexBy(oldPaths, value => JSON.stringify([rawId(value.use), rawId(value.destination)]))
  const insertions = domains(fragments.inserted.map(span => ({ span, value: span })))
  const oldRoles = carrierIndex(previous.roles), nextRoles = carrierIndex(observed.roles)
  const oldDirect = new Map<Physical, MarkdownSourceCarrierFact>(), nextDirect = new Map<Physical, MarkdownSourceCarrierFact>()
  for (const role of oldRoles.values()) if (role.use.kind === 'direct' && role.destination) oldDirect.set(role.destination, role)
  for (const role of nextRoles.values()) if (role.use.kind === 'direct' && role.destination) nextDirect.set(role.destination, role)
  const fine = new Map<Physical, Array<{ old: Physical; plan: PlannedLayout }>>()
  const editedPhysical = new Set<Physical>(), matchedPhysical = new Set<Physical>()
  const physicalForward = new Map<Physical, Physical>()
  if (observed.observation?.complete) {
    const nextByGeometry = indexBy(observed.observation.physicalDestinations.filter(fact => fact.use && fact.destination),
      fact => JSON.stringify([rawId(fact.use!), rawId(fact.destination!)]))
    for (const old of previous.observation?.physicalDestinations ?? []) {
      const layout = definitionLayout(old, before.source) ?? roleLayout(oldDirect.get(old))
      const plan = layout && planLayout(layout, changes, shifts), destination = plan?.slots.find(slot => slot.name === 'destination')
      if (!layout || !plan || !destination) continue
      if (plan.edited) editedPhysical.add(old)
      for (const next of nextByGeometry.get(JSON.stringify([rawId(plan.whole), rawId(destination.span)])) ?? []) {
        // Physical facts do not own the source string: definition protection
        // must use this exact actual candidate, never a reconstructed source.
        const actual = next.kind === 'definition' ? definitionLayout(next, observed.observation.source) : roleLayout(nextDirect.get(next))
        if (!actual || !matchesLayout(layout, plan, actual, observed.observation.source)
          || old.kind !== next.kind || old.format !== next.format || old.syntax !== next.syntax) continue
        matchedPhysical.add(old)
        const values = fine.get(next) ?? []; values.push({ old, plan }); fine.set(next, values)
      }
    }
  }
  if ([...editedPhysical].some(old => !matchedPhysical.has(old))) reason ??= '实际 role slot 逸出或语法消失，不能自动降为新生'
  if (observed.observation?.complete) {
    for (const fact of observed.observation.physicalDestinations) {
      const candidates = fact.use && fact.destination ? oldByGeometry.get(JSON.stringify([rawId(fact.use), rawId(fact.destination)])) ?? [] : []
      if (candidates.length === 1 && !consumed.has(candidates[0].fact)) {
        const old = candidates[0].fact, inherited = previous.lineage.get(old)
        if (inherited?.proven && old.kind === fact.kind && old.format === fact.format && old.syntax === fact.syntax
          && old.url === fact.url && projectionShape(old) === projectionShape(fact)) {
          consumed.add(old); physicalForward.set(old, fact); lineage.set(fact, inherited); continue
        }
      }
      const proved = fine.get(fact) ?? []
      if (proved.length === 1 && !consumed.has(proved[0].old)) {
        const { old, plan } = proved[0], inherited = previous.lineage.get(old)
        if (inherited?.proven && (plan.destinationChanged || old.url === fact.url)) {
          consumed.add(old); physicalForward.set(old, fact)
          const birth: Birth | null = plan.destinationChanged ? Object.freeze({ via: 'carrier-destination', receipt,
            beforeReceipt: previous.facts.receipt, generation: Object.freeze({}),
            destination: Object.freeze({ from: fact.destination!.from, to: fact.destination!.to }) }) : null
          lineage.set(fact, birth ? Object.freeze({ source: null, birth, proven: true }) : inherited)
          continue
        }
      }
      // Certified birth is deliberately narrower than text recognition: the
      // complete actual use, or its complete nonempty destination, was emitted
      // by one real raw insertion. Edits lacking the positive fine-role proof
      // above are never promoted merely because the resulting URL is known.
      const fullUses = fact.use ? insertions(fact.use) : []
      const fullDestinations = fact.destination && fact.destination.from < fact.destination.to
        ? insertions(fact.destination) : []
      const birth: Birth | null = fullUses.length === 1 ? Object.freeze({ receipt, inserted: fullUses[0], via: 'use' })
        : fullDestinations.length === 1 ? Object.freeze({ receipt, inserted: fullDestinations[0], via: 'destination' }) : null
      lineage.set(fact, Object.freeze({ source: null, birth, proven: birth !== null }))
      if (!birth) reason ??= 'use 内编辑或新生缺少实际 carrier 证明'
    }
    // References do not create physical Keys of their own. Still require a
    // positive changed-use witness: an unchanged definition cannot silently
    // authorize selector/combined-label/shell edits to its uses.
    const oldUses = previous.observation?.uses ?? [], used = new Set<MarkdownSourceUseOccurrence>()
    const wholeUses = indexBy(oldUses.flatMap(use => {
      const span = use.use && mapped(use.use, changes, shifts)
      return span ? [{ use, span }] : []
    }), value => rawId(value.span))
    const fineUses = new Map<string, Array<{ use: MarkdownSourceUseOccurrence; layout: Layout; plan: PlannedLayout }>>()
    for (const use of oldUses) if (use.kind === 'reference') {
      const layout = roleLayout(oldRoles.get(use)), plan = layout && planLayout(layout, changes, shifts)
      if (!layout || !plan) continue
      const key = rawId(plan.whole), values = fineUses.get(key) ?? []
      values.push({ use, layout, plan }); fineUses.set(key, values)
    }
    for (const use of observed.observation.uses) if (use.kind === 'reference' && use.use) {
      const old = (wholeUses.get(rawId(use.use)) ?? []).filter(row => row.use.kind === 'reference' && !used.has(row.use))
      if (old.length === 1) { used.add(old[0].use); continue }
      const after = roleLayout(nextRoles.get(use)), fine = (fineUses.get(rawId(use.use)) ?? []).filter(row => !used.has(row.use)
        && after && matchesLayout(row.layout, row.plan, after, next.source)
        && row.use.destination && physicalForward.get(row.use.destination) === use.destination)
      if (fine.length === 1) { used.add(fine[0].use); continue }
      if (insertions(use.use).length === 1) continue
      reason ??= 'reference use 的 selector、combined label 或 shell 没有实际 carrier 证明'
    }
    if ([...fineUses.values()].flat().some(row => row.plan.edited && !used.has(row.use)))
      reason ??= 'reference display slot 逸出或语法消失，不能自动降为新生'
  }
  if (!sameArray(previous.root.grammar, grammar())) fail('实际解析期间 Markdown 语法上下文已变化')
  drafts.set(next, { root: previous.root, parent: previous, observation: observed.observation, roles: observed.roles, lineage, facts: Object.freeze({ opening: previous.root.opening,
    receipt, beforeReceipt: previous.facts.receipt, fragments: fragments.fragments, uncertainReason: reason }) })
  return next
}

type Reconciled = ReturnType<typeof canonicalSourceDraftToBlocksWithManifest>
function bridge(draft: SourceLedgerDraft, saved: Data, actual: Reconciled) {
  const manifest = readMarkdownSourceReconciliationManifest(actual.manifest)
  if (manifest.draftReceipt !== saved.facts.receipt || manifest.opening !== saved.root.manifest || manifest.source !== draft.source
    || manifest.outputs.length !== actual.blocks.length) fail('reconcile receipt 不是当前候选')
  const blocks = validateSyncedCanonicalEdit(actual.blocks)
  const rawDomains = domains(manifest.outputs.flatMap((row, index) => row.sourceRange ? [{ span: row.sourceRange, value: index }] : []))
  const toSource = (index: number, span: Span): Span | null => {
    const row = manifest.outputs[index], block = blocks[index]
    if (!row || !block || row.outputIndex !== index || row.block.id !== block.id || row.block.content !== block.content
      || row.block.parentBlockId !== block.parentBlockId || row.kind === 'ref' || !row.sourceRange) return null
    const raw = projectSourceReconciliationContentRange(actual.manifest, index, span.from, span.to)
    return raw && sameSpan(projectSourceReconciliationRawRange(actual.manifest, index, raw.from, raw.to), span) ? raw : null
  }
  const fromSource = (span: Span): ContentSpan => {
    const candidates: ContentSpan[] = []
    for (const index of rawDomains(span)) {
      const content = projectSourceReconciliationRawRange(actual.manifest, index, span.from, span.to)
      if (content && sameSpan(toSource(index, content), span)) candidates.push({ index, ...content })
    }
    return unique(candidates, 'raw 到实际输出 payload 的路径不唯一')
  }
  return { blocks, toSource, fromSource }
}
function physicalId(value: LocatedPhysical): string { return JSON.stringify([spanId(value.destination), spanId(value.use), value.fact.kind, value.fact.format]) }
function useId(use: MarkdownSourceUseOccurrence, span: ContentSpan): string { return JSON.stringify([spanId(span), use.kind]) }
function geometry(draft: SourceLedgerDraft, saved: Data, actual: Reconciled) {
  const a = checkedObservation(saved.observation), current = bridge(draft, saved, actual)
  const emission = serializeMarkdownWithEmissionTrace(current.blocks, { normalizeLineEndings: false }), d = checkedObservation(observe(emission.markdown).observation)
  const finalDomains = domains(emission.contentTraces.map((trace, index) => ({ span: { from: trace.sourceFrom, to: trace.sourceTo }, value: index })))
  const fromFinalSource = (span: Span): ContentSpan => {
    const candidates: ContentSpan[] = []
    for (const index of finalDomains(span)) {
      const trace = emission.contentTraces[index]
      const range = projectMarkdownEmissionSourceRange(trace, span.from, span.to)
      if (range && sameSpan(projectMarkdownEmissionContentRange(trace, range.from, range.to), span)) candidates.push({ index, ...range })
    }
    return unique(candidates, 'final emitter payload 投影不唯一')
  }
  const locate = (fact: Physical, project: (span: Span) => ContentSpan): LocatedPhysical => {
    if (!fact.destination || !fact.use) return fail('physical 范围缺失')
    const destination = project(fact.destination), use = project(fact.use)
    if (destination.index !== use.index || !contains(use, destination)) fail('actual use 跨越不同输出块')
    return { fact, destination, use }
  }
  const aRows = a.physicalDestinations.map(fact => locate(fact, current.fromSource))
  const dRows = d.physicalDestinations.map(fact => locate(fact, fromFinalSource)), matched = new Set<Physical>(), aToD = new Map<Physical, Physical>()
  const dByGeometry = indexBy(dRows, physicalId)
  for (const row of aRows) {
    const other = unique(dByGeometry.get(physicalId(row)) ?? [], 'A/D physical 几何路径不唯一')
    if (matched.has(other.fact) || row.fact.url !== other.fact.url || row.fact.syntax !== other.fact.syntax
      || row.fact.active !== other.fact.active || row.fact.use!.parsed !== other.fact.use!.parsed) fail('final physical/context 与当前 raw 不一致')
    matched.add(other.fact); aToD.set(row.fact, other.fact)
  }
  if (matched.size !== dRows.length) fail('A/D physical 闭集不一致')
  const dUses = d.uses.map(use => ({ use, span: fromFinalSource(use.use!) })), usedUses = new Set<MarkdownSourceUseOccurrence>()
  const dUsesByGeometry = indexBy(dUses, other => useId(other.use, other.span))
  const ownerForward = new Map<object, object>(), ownerReverse = new Map<object, object>()
  for (const use of a.uses) {
    const span = current.fromSource(use.use!), other = unique(dUsesByGeometry.get(useId(use, span)) ?? [], 'A/D use 几何路径不唯一')
    if (usedUses.has(other.use) || use.use!.parsed !== other.use.use!.parsed || other.use.destination !== aToD.get(use.destination!))
      fail('reference use 未指向几何对应的实际 first definition')
    const oldOwner = use.owner!, nextOwner = other.use.owner!
    if (ownerForward.has(oldOwner) && ownerForward.get(oldOwner) !== nextOwner
      || ownerReverse.has(nextOwner) && ownerReverse.get(nextOwner) !== oldOwner) fail('actual inline owner 分区发生变化')
    ownerForward.set(oldOwner, nextOwner); ownerReverse.set(nextOwner, oldOwner)
    usedUses.add(other.use)
  }
  if (usedUses.size !== d.uses.length) fail('A/D use 闭集不一致')

  const actualLinks = links(current.blocks, saved.root.origin), keys = actualLinks.map(link => linkKey(link, current.blocks)), seen = new Set<string>(), claimed = new Set<Physical>()
  const aByDestination = indexBy(aRows, row => spanId(row.destination))
  const rows = actualLinks.map((link, index) => {
    const key = keys[index], raw = current.toSource(link.blockIndex, key), row = unique(aByDestination.get(spanId({ index: link.blockIndex, ...key })) ?? [],
      'Main Key 没有唯一 raw physical 路径')
    if (!sameSpan(row.fact.destination, raw) || seen.has(keyId(key)) || claimed.has(row.fact) || !role(link, row.fact) || link.url !== row.fact.url)
      fail('Main physical 闭集不一致')
    seen.add(keyId(key)); claimed.add(row.fact)
    return { key, fact: row.fact }
  })
  const eligibleRows = aRows.filter(row => eligible(saved.root.origin, row.fact))
  if (eligibleRows.length !== rows.length || eligibleRows.some(row => !claimed.has(row.fact))) fail('Main Key 未覆盖全部 eligible physical')
  return { blocks: current.blocks, rows }
}
function checkedGeometry(draft: SourceLedgerDraft, saved: Data, actual: Reconciled) {
  if (saved.geometryMemo?.manifest === actual.manifest) return saved.geometryMemo.result
  const result = geometry(draft, saved, actual)
  // Refused geometry may depend on a caller parser callout; only positive
  // observations are reusable. Allocation itself retains its original memo.
  saved.geometryMemo = { manifest: actual.manifest, result }
  return result
}
export function prepareCanonicalSourceFirstApply(input: { draft: SourceLedgerDraft; lease: SourceFirstApplyLease; freshId?: () => string }): PreparedSourceFirstApply {
  const parameters = plain(input, Object.hasOwn(input, 'freshId') ? ['draft', 'lease', 'freshId'] : ['draft', 'lease'])
  const draft = parameters.draft as SourceLedgerDraft, saved = data(draft), currentLease = lease(parameters.lease as SourceFirstApplyLease)
  if (parameters.freshId !== undefined && typeof parameters.freshId !== 'function') fail('fresh ID 分配器不是实际函数')
  if (!sameLease(saved.root.lease, currentLease)) fail('opening lease 已变化')
  if (saved.prepared) return saved.prepared
  if (saved.facts.uncertainReason) fail(saved.facts.uncertainReason)
  checkedObservation(saved.observation)
  // Allocation is cached even if later geometry refuses this candidate. A
  // repeated prepare cannot silently substitute another set of output IDs.
  if (!saved.reconcileMemo) {
    try { saved.reconcileMemo = { kind: 'ready', value: canonicalSourceDraftToBlocksWithManifest(draft, parameters.freshId as (() => string) | undefined) } }
    catch (error) { saved.reconcileMemo = { kind: 'error', error }; throw error }
  }
  if (saved.reconcileMemo.kind === 'error') throw saved.reconcileMemo.error
  const actual = saved.reconcileMemo.value
  const result = checkedGeometry(draft, saved, actual)
  const continued = new Set<string>()
  const claims = validateSyncedBindingClaims(result.rows.map(({ key, fact }) => {
    const origin = saved.lineage.get(fact)
    if (!origin?.proven || !origin.source && !origin.birth) return fail('实际目的地没有闭合的 raw 来源')
    if (!origin.source) return { kind: 'new', destination: key }
    if (continued.has(keyId(origin.source))) return fail('同一来源没有显式 copy 事实却被重复使用')
    continued.add(keyId(origin.source))
    return { kind: 'continue', source: { ...origin.source }, destination: key }
  }))
  if (!sameArray(saved.root.grammar, grammar())) fail('prepare 期间 Markdown 语法上下文已变化')
  if (data(draft) !== saved) fail('prepare 期间实际草稿已变化')
  const value: PreparedSourceFirstApply = Object.freeze({ kind: 'source-first-apply' })
  const blocks = Object.freeze(result.blocks.map(block => {
    if (block.tags) Object.freeze(block.tags)
    if (block.markdownFormat) Object.freeze(block.markdownFormat)
    return Object.freeze(block)
  }))
  const bindingClaims = Object.freeze(claims.map(claim => {
    Object.freeze(claim.destination)
    if (claim.kind === 'continue') Object.freeze(claim.source)
    return Object.freeze(claim)
  }))
  prepared.set(value, Object.freeze({ draft, opening: saved.root.opening, draftReceipt: saved.facts.receipt,
    lease: saved.root.lease, reconciliationManifest: actual.manifest, blocks, bindingClaims,
    hasIntent: claims.some(claim => claim.kind !== 'continue' || keyId(claim.source) !== keyId(claim.destination)) }))
  saved.prepared = value
  return value
}
export function readPreparedSourceFirstApply(value: PreparedSourceFirstApply): PreparedSourceFirstApplyFacts {
  const facts = prepared.get(value)
  if (!facts) return fail('未知 first Apply preparation')
  const current = data(facts.draft)
  if (facts.draftReceipt !== current.facts.receipt || facts.opening !== current.root.opening || facts.lease !== current.root.lease)
    return fail('preparation 与实际草稿 receipt 错挂')
  return facts
}

export interface SourceCheckpoint { readonly kind: 'source-checkpoint' }
export interface PreparedSourceCheckpoint { readonly kind: 'prepared-source-checkpoint' }
export interface AcceptedSourceCheckpoint { readonly kind: 'accepted-source-checkpoint' }
export interface PreparedSourceCheckpointFacts {
  readonly draft: SourceLedgerDraft
  readonly draftReceipt: MarkdownSourceDraftReceipt
  readonly allocation: CanonicalSourceAllocation
  readonly lease: SourceFirstApplyLease
  readonly blocks: readonly Readonly<SyncedCanonicalEdit>[]
  readonly bindingClaims: readonly Readonly<SyncedBindingClaim>[]
}
export interface AcceptedSourceCheckpointFacts {
  readonly draft: SourceLedgerDraft
  readonly draftReceipt: MarkdownSourceDraftReceipt
  readonly allocation: CanonicalSourceAllocation
  readonly endpoint: SyncedWorkingEndpointReceipt
  readonly committed: SyncedCommittedEndpointReceipt | null
}
export type SourceCheckpointPreparationResult = Readonly<{ status: 'prepared'; preparation: PreparedSourceCheckpoint }>
  | Readonly<{ status: 'noop' | 'needs-history-source' | 'unavailable' }>
export type SourceCheckpointApplyResult = Readonly<{ status: 'accepted'; accepted: AcceptedSourceCheckpoint }>
  | Readonly<{ status: 'unavailable' }>
type CheckpointState = {
  binding: SyncedGroupBinding; root: Root; opening: SyncedSourceEndpointOpening; openingDraft: SourceLedgerDraft; endpoint: SyncedWorkingEndpointReceipt;
  current: ReadonlyMap<Lineage, Readonly<SyncedBindingKey>>; seen: Set<Lineage>;
  staged: PreparedSourceCheckpoint | null; preparing: boolean; applying: boolean
}
type CheckpointPreparation = {
  state: CheckpointState; facts: PreparedSourceCheckpointFacts; tokens: ReadonlyMap<Lineage, Readonly<SyncedBindingKey>>;
  result?: SourceCheckpointApplyResult
}
const checkpoints = new WeakMap<SourceCheckpoint, CheckpointState>()
const checkpointPreparations = new WeakMap<PreparedSourceCheckpoint, CheckpointPreparation>()
const acceptedCheckpoints = new WeakMap<AcceptedSourceCheckpoint, AcceptedSourceCheckpointFacts>()
const acceptedOwners = new WeakMap<AcceptedSourceCheckpoint, CheckpointState>()
const unavailableCheckpoint = Object.freeze({ status: 'unavailable' as const })
const noopCheckpoint = Object.freeze({ status: 'noop' as const })
const historyCheckpoint = Object.freeze({ status: 'needs-history-source' as const })
function orderedCheckpoint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedCheckpoint)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, orderedCheckpoint(item)]))
  return value
}
const sameCheckpointBlocks = (left: readonly Readonly<SyncedCanonicalEdit>[], right: readonly Readonly<SyncedCanonicalEdit>[]) =>
  JSON.stringify(orderedCheckpoint(left)) === JSON.stringify(orderedCheckpoint(right))
function checkpointEndpoint(state: CheckpointState, draft: SourceLedgerDraft, saved: Data) {
  let receiptError: unknown
  const context = captureSyncedSourceEndpoint(state.binding, { expected: state.endpoint, validate: () => {
    try { return data(draft) === saved } catch (error) {
      try { readMarkdownSourceDraftReceipt(draft) } catch { receiptError = error }
      return false
    }
  } })
  if (receiptError !== undefined) throw receiptError
  if (!context || !Object.keys(state.root.lease.scope).every(key =>
    state.root.lease.scope[key as keyof SourceScopeLease] === context.lease.scope[key as keyof SourceScopeLease])) return null
  // The private port closes expected Endpoint identity after the validator.
  // Reading the public live endpoint again here would call scope once more.
  return { read: { working: context.working }, context }
}
/** A real registered working endpoint is the sole Source opening authority.
 * In particular dirty W is allowed without checkpointing or flushing it. */
export function openSyncedSourceCheckpoint(binding: SyncedGroupBinding): {
  checkpoint: SourceCheckpoint; draft: SourceLedgerDraft; opening: SourceLedgerOpening
} | null {
  const context = captureSyncedSourceEndpoint(binding)
  if (!context) return null
  const opened = openCanonicalSourceLedger({ blocks: context.working, origin: context.origin, lease: context.lease })
  const saved = data(opened.draft), tokens = new Map<Lineage, Readonly<SyncedBindingKey>>()
  for (const lineage of saved.lineage.values()) if (lineage.source) tokens.set(lineage, lineage.source)
  const state: CheckpointState = { binding, root: saved.root, opening: context, openingDraft: opened.draft, endpoint: context.endpoint, current: tokens,
    seen: new Set(tokens.keys()), staged: null, preparing: false, applying: false }
  if (!checkpointEndpoint(state, opened.draft, saved)) return null
  const checkpoint: SourceCheckpoint = Object.freeze({ kind: 'source-checkpoint' })
  checkpoints.set(checkpoint, state)
  return { checkpoint, ...opened }
}
function checkpointAllocation(draft: SourceLedgerDraft, saved: Data, freshId?: () => string): CanonicalSourceAllocation {
  if (saved.allocation) return saved.allocation
  let ancestor = saved.parent
  while (ancestor && !ancestor.allocationBasis) ancestor = ancestor.parent
  const allocation = allocateCanonicalSourceDraft(draft, { ...(ancestor?.allocationBasis ? { basis: ancestor.allocationBasis } : {}),
    ...(freshId ? { freshId } : {}) })
  saved.allocation = allocation
  return allocation
}
export function prepareSourceCheckpoint(input: {
  checkpoint: SourceCheckpoint; draft: SourceLedgerDraft; freshId?: () => string
}): SourceCheckpointPreparationResult {
  const parameters = plain(input, Object.hasOwn(input, 'freshId') ? ['checkpoint', 'draft', 'freshId'] : ['checkpoint', 'draft'])
  const state = checkpoints.get(parameters.checkpoint as SourceCheckpoint), draft = parameters.draft as SourceLedgerDraft
  if (!state || state.preparing || state.applying) return unavailableCheckpoint
  if (parameters.freshId !== undefined && typeof parameters.freshId !== 'function') fail('fresh ID 分配器不是实际函数')
  state.preparing = true
  try {
    const saved = data(draft)
    if (saved.root !== state.root) return unavailableCheckpoint
    if (state.staged) {
      const staged = checkpointPreparations.get(state.staged)!
      return staged.facts.draft === draft && checkpointEndpoint(state, draft, saved) && readMarkdownSourceDraftReceipt(draft) === saved.facts.receipt
        ? Object.freeze({ status: 'prepared', preparation: state.staged }) : unavailableCheckpoint
    }
    if (!checkpointEndpoint(state, draft, saved)) return unavailableCheckpoint
    if (saved.facts.uncertainReason) fail(saved.facts.uncertainReason)
    const allocation = checkpointAllocation(draft, saved, parameters.freshId as (() => string) | undefined)
    const allocated = readCanonicalSourceAllocation(allocation)
    const actual: Reconciled = { blocks: allocated.blocks as SyncedCanonicalEdit[], syntax: null, manifest: allocated.reconciliationManifest }
    const result = checkedGeometry(draft, saved, actual), tokens = new Map<Lineage, Readonly<SyncedBindingKey>>()
    const continued = new Set<string>(), values: SyncedBindingClaim[] = []
    for (const { key, fact } of result.rows) {
      const token = saved.lineage.get(fact)
      if (!token?.proven || !token.source && !token.birth) fail('实际目的地没有闭合的 raw 来源')
      if (tokens.has(token)) fail('同一来源没有显式 copy 事实却被重复使用')
      tokens.set(token, key)
      const source = state.current.get(token)
      if (source) {
        if (continued.has(keyId(source))) fail('同一来源没有显式 copy 事实却被重复使用')
        continued.add(keyId(source)); values.push({ kind: 'continue', source: { ...source }, destination: { ...key } })
      } else {
        if (state.seen.has(token)) return historyCheckpoint
        if (!token.birth) return historyCheckpoint
        values.push({ kind: 'new', destination: { ...key } })
      }
    }
    const bindingClaims = validateSyncedBindingClaims(values)
    // Grammar/configuration may be caller-owned. Check the actual draft and
    // actual controller endpoint after the last parser/grammar callout.
    if (data(draft) !== saved) return unavailableCheckpoint
    const endpoint = checkpointEndpoint(state, draft, saved)
    if (!endpoint || readMarkdownSourceDraftReceipt(draft) !== saved.facts.receipt) return unavailableCheckpoint
    if (sameCheckpointBlocks(result.blocks, endpoint.read.working) && syncedBindingClaimsAreIdentity(bindingClaims)) return noopCheckpoint
    saved.allocationBasis ??= createCanonicalSourceAllocationBasis(allocation)
    if (data(draft) !== saved || !checkpointEndpoint(state, draft, saved) || readMarkdownSourceDraftReceipt(draft) !== saved.facts.receipt) return unavailableCheckpoint
    const preparation: PreparedSourceCheckpoint = Object.freeze({ kind: 'prepared-source-checkpoint' })
    const facts: PreparedSourceCheckpointFacts = Object.freeze({ draft, draftReceipt: saved.facts.receipt, allocation,
      lease: lease(endpoint.context.lease), blocks: allocated.blocks,
      bindingClaims: Object.freeze(bindingClaims.map(claim => {
        Object.freeze(claim.destination); if (claim.kind === 'continue') Object.freeze(claim.source); return Object.freeze(claim)
      })) })
    checkpointPreparations.set(preparation, { state, facts, tokens })
    state.staged = preparation
    return Object.freeze({ status: 'prepared', preparation })
  } finally { state.preparing = false }
}
export function readPreparedSourceCheckpoint(preparation: PreparedSourceCheckpoint): PreparedSourceCheckpointFacts {
  const saved = checkpointPreparations.get(preparation)
  if (!saved || data(saved.facts.draft).facts.receipt !== saved.facts.draftReceipt) fail('未知 checkpoint preparation')
  return saved.facts
}
export function applyPreparedSourceCheckpoint(input: {
  preparation: PreparedSourceCheckpoint; transactionId: string; bookmark?: SyncedScopeBookmark | null
}): SourceCheckpointApplyResult {
  const parameters = plain(input, Object.hasOwn(input, 'bookmark') ? ['preparation', 'transactionId', 'bookmark'] : ['preparation', 'transactionId'])
  const saved = checkpointPreparations.get(parameters.preparation as PreparedSourceCheckpoint)
  if (!saved) return unavailableCheckpoint
  if (saved.result) return saved.result
  const { state, facts } = saved
  if (state.preparing || state.applying || state.staged !== parameters.preparation) return unavailableCheckpoint
  state.applying = true
  try {
    if (typeof parameters.transactionId !== 'string' || !parameters.transactionId || data(facts.draft).facts.receipt !== facts.draftReceipt)
      return unavailableCheckpoint
    const endpoint = checkpointEndpoint(state, facts.draft, data(facts.draft))
    if (!endpoint || !sameLease(facts.lease, lease(endpoint.context.lease))
      || readMarkdownSourceDraftReceipt(facts.draft) !== facts.draftReceipt) return unavailableCheckpoint
    const applied = applySyncedSourceGroupWithEndpoint(state.binding, { expectedEditSequence: facts.lease.expectedEditSequence,
      guards: { ...facts.lease.guards }, blocks: facts.blocks as SyncedCanonicalEdit[], bindingClaims: facts.bindingClaims as SyncedBindingClaim[],
      transactionId: parameters.transactionId, bookmark: parameters.bookmark as SyncedScopeBookmark | null ?? null },
    () => data(facts.draft).facts.receipt === facts.draftReceipt)
    if (!applied.accepted) return unavailableCheckpoint
    const accepted: AcceptedSourceCheckpoint = Object.freeze({ kind: 'accepted-source-checkpoint' })
    acceptedCheckpoints.set(accepted, Object.freeze({ draft: facts.draft, draftReceipt: facts.draftReceipt,
      allocation: facts.allocation, endpoint: applied.endpoint, committed: null }))
    acceptedOwners.set(accepted, state)
    state.endpoint = applied.endpoint; state.current = saved.tokens
    for (const token of saved.tokens.keys()) state.seen.add(token)
    state.staged = null
    saved.result = Object.freeze({ status: 'accepted', accepted })
    return saved.result
  } finally { state.applying = false }
}
/** The exact original local acceptance has an independent read-only ACK
 * mailbox, including a first read after the live scope has expired. */
export function readAcceptedSourceCheckpoint(accepted: AcceptedSourceCheckpoint): AcceptedSourceCheckpointFacts | null {
  const facts = acceptedCheckpoints.get(accepted)
  if (!facts || facts.committed) return facts ?? null
  const receipt = readSyncedWorkingEndpointCommitted(facts.endpoint)
  if (receipt) {
    const committed = Object.freeze({ ...facts, committed: receipt })
    acceptedCheckpoints.set(accepted, committed)
    return committed
  }
  return facts
}

// Loaded only by an explicit adoption request. Default editor startup keeps the
// source codec and Main read-owner handshake out of the renderer entry chunk.
let sourceReadOwnerModule: typeof import('./sourceReadOwner') | undefined
async function readOwnerKernel() { return sourceReadOwnerModule ??= await import('./sourceReadOwner') }
/** Internal registry lookup; an arbitrary access adapter cannot mint an owner. */
export function readSourceReadOwnerAccess(checkpoint: SourceCheckpoint): SourceReadOwnerAccess | null {
  const state = checkpoints.get(checkpoint)
  if (!state || !state.opening.readOwner) return null
  return {
    context: state.opening.readOwner, endpoint: state.opening.endpoint, snapshot: state.opening.snapshot,
    accepted: value => acceptedOwners.get(value) === state ? readAcceptedSourceCheckpoint(value) : null,
    capture: endpoint => finalizeSyncedSourceReadOwner(state.binding, state.opening.readOwner!, endpoint,
      () => data(state.openingDraft).root === state.root),
    finalize: (endpoint, fence, validate, accepted) => finalizeSyncedSourceReadOwner(state.binding, state.opening.readOwner!, endpoint, () => {
      const facts = accepted ? acceptedOwners.get(accepted) === state ? readAcceptedSourceCheckpoint(accepted) : null : null
      if (accepted && !facts) return false
      if (!validate()) return false
      const opening = data(state.openingDraft)
      if (facts && data(facts.draft).facts.receipt !== facts.draftReceipt) return false
      const currentGrammar = ownDataGrammar()
      if (!currentGrammar || !sameArray(state.root.grammar, currentGrammar)) return false
      return opening.root === state.root && readMarkdownSourceDraftReceipt(state.openingDraft) === opening.facts.receipt
        && (!facts || readMarkdownSourceDraftReceipt(facts.draft) === facts.draftReceipt)
    }, fence) === fence
  }
}
export async function openSyncedSourceReadOwner(checkpoint: SourceCheckpoint): Promise<SourceReadOwner | null> {
  return (await readOwnerKernel()).openSourceReadOwner(checkpoint)
}
export async function adoptSyncedSourceBaseline(owner: SourceReadOwner): Promise<SourceSideAdoptionResult> {
  return sourceReadOwnerModule ? sourceReadOwnerModule.adoptSourceBaseline(owner) : { status: 'unavailable', reason: 'unknown-owner' }
}
export async function adoptSyncedAcceptedSource(owner: SourceReadOwner, accepted: AcceptedSourceCheckpoint): Promise<SourceSideAdoptionResult> {
  return sourceReadOwnerModule ? sourceReadOwnerModule.adoptAcceptedSource(owner, accepted) : { status: 'unavailable', reason: 'unknown-owner' }
}
export function closeSyncedSourceReadOwner(owner: SourceReadOwner): Promise<void> {
  return sourceReadOwnerModule?.closeSourceReadOwner(owner) ?? Promise.resolve()
}
export function readAdoptedSourceSide(side: AdoptedSourceSide): AdoptedSourceSideFacts | null {
  return sourceReadOwnerModule?.readAdoptedSourceSide(side) ?? null
}
