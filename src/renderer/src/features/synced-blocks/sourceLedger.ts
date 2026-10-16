import { markdownEngine } from '@shared/markdownEngine'
import { collectDocumentMarkdownLinks, type MarkdownDocumentLink } from '@shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'
import { observeMarkdownSourceOccurrences, type MarkdownSourceOccurrenceObservation,
  type MarkdownSourcePhysicalDestination, type MarkdownSourceUseOccurrence } from '@shared/markdownSourceOccurrences'
import { serializeMarkdownWithEmissionTrace, projectMarkdownEmissionContentRange, projectMarkdownEmissionSourceRange } from '@shared/markdownEmissionTrace'
import { projectMarkdownSourceContentRange, projectMarkdownSourceRawRange } from '@shared/markdownSourceTrace'
import { validateSyncedBindingClaims } from '@shared/syncedBlockInputs'
import { SyncedValidationError, validateSyncedCanonicalEdit, validateSyncedOrigin } from '@shared/syncedBlockValidation'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedCanonicalEdit, SyncedGroupGuard, SyncedOriginV1 } from '@shared/synced-blocks'
import { replaceMarkdownSourceChanges, type MarkdownSourceChange, type MarkdownSourceDraft } from '../../utils/markdownSourceDraft'
import { createMarkdownSourceSession } from '../../utils/markdownSourceSession'
import { canonicalSourceDraftToBlocksWithManifest, createCanonicalSourceDraftWithManifest, projectOpeningContentRange, projectOpeningSourceRange,
  readMarkdownSourceDraftReceipt, readMarkdownSourceOpeningManifest, readMarkdownSourceReconciliationManifest,
  type MarkdownSourceDraftReceipt, type MarkdownSourceOpeningManifest, type MarkdownSourceReconciliationManifest } from './sourceManifest'

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
type Lineage = Readonly<{ source: Readonly<SyncedBindingKey> | null; birth: Birth | null; proven: boolean }>
type Root = { opening: SourceLedgerOpening; manifest: MarkdownSourceOpeningManifest; origin: Readonly<SyncedOriginV1>;
  lease: SourceFirstApplyLease; grammar: readonly unknown[] }
type ReconcileMemo = { kind: 'ready'; value: ReturnType<typeof canonicalSourceDraftToBlocksWithManifest> } | { kind: 'error'; error: unknown }
type Data = { root: Root; facts: SourceLedgerCandidateFacts; observation: Observation | null;
  lineage: ReadonlyMap<Physical, Lineage>; reconcileMemo?: ReconcileMemo; prepared?: PreparedSourceFirstApply }
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
    markdownEngine.helpers.parseLinkLabel, markdownEngine.helpers.parseLinkDestination]
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
  return value
}
function observe(source: string): { observation: Observation | null; reason: string | null } {
  try {
    const observation = observeMarkdownSourceOccurrences(source)
    return { observation, reason: observation.complete ? null : '存在尚未证明的实际解析范围' }
  } catch { return { observation: null, reason: '当前源码的实际解析未闭合' } }
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
  drafts.set(created.draft, { root, observation: observed.observation, lineage, facts: Object.freeze({ opening, receipt, beforeReceipt: null,
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
  if (observed.observation?.complete) {
    for (const fact of observed.observation.physicalDestinations) {
      const candidates = fact.use && fact.destination ? oldByGeometry.get(JSON.stringify([rawId(fact.use), rawId(fact.destination)])) ?? [] : []
      if (candidates.length === 1 && !consumed.has(candidates[0].fact)) {
        const old = candidates[0].fact, inherited = previous.lineage.get(old)
        if (inherited?.proven && old.kind === fact.kind && old.format === fact.format && old.syntax === fact.syntax
          && old.url === fact.url && projectionShape(old) === projectionShape(fact)) {
          consumed.add(old); lineage.set(fact, inherited); continue
        }
      }
      // Certified birth is deliberately narrower than text recognition: the
      // complete actual use, or its complete nonempty destination, was emitted
      // by one real raw insertion. Partial href/label/shell edits lack carriers.
      const fullUses = fact.use ? insertions(fact.use) : []
      const fullDestinations = fact.destination && fact.destination.from < fact.destination.to
        ? insertions(fact.destination) : []
      const birth: Birth | null = fullUses.length === 1 ? Object.freeze({ receipt, inserted: fullUses[0], via: 'use' })
        : fullDestinations.length === 1 ? Object.freeze({ receipt, inserted: fullDestinations[0], via: 'destination' }) : null
      lineage.set(fact, Object.freeze({ source: null, birth, proven: birth !== null }))
      if (!birth) reason ??= 'use 内编辑或新生缺少实际 carrier 证明'
    }
  }
  if (!sameArray(previous.root.grammar, grammar())) fail('实际解析期间 Markdown 语法上下文已变化')
  drafts.set(next, { root: previous.root, observation: observed.observation, lineage, facts: Object.freeze({ opening: previous.root.opening,
    receipt, beforeReceipt: previous.facts.receipt, fragments: fragments.fragments, uncertainReason: reason }) })
  return next
}

type Reconciled = ReturnType<typeof canonicalSourceDraftToBlocksWithManifest>
function bridge(draft: SourceLedgerDraft, saved: Data, actual: Reconciled) {
  const manifest = readMarkdownSourceReconciliationManifest(actual.manifest), opening = readMarkdownSourceOpeningManifest(saved.root.manifest)
  if (manifest.draftReceipt !== saved.facts.receipt || manifest.opening !== saved.root.manifest || manifest.source !== draft.source
    || manifest.outputs.length !== actual.blocks.length) fail('reconcile receipt 不是当前候选')
  const blocks = validateSyncedCanonicalEdit(actual.blocks)
  const anchors = new Map(opening.anchors.map(anchor => [anchor.openingIndex, anchor]))
  if (anchors.size !== opening.anchors.length) fail('opening anchor 不唯一')
  const rawDomains = domains(manifest.outputs.flatMap((row, index) => row.sourceRange ? [{ span: row.sourceRange, value: index }] : []))
  const toSource = (index: number, span: Span): Span | null => {
    const row = manifest.outputs[index], block = blocks[index]
    if (!row || !block || row.outputIndex !== index || row.block.id !== block.id || row.block.content !== block.content
      || row.block.parentBlockId !== block.parentBlockId || row.kind === 'ref' || !row.sourceRange) return null
    if (row.kind === 'syntax') {
      if (row.syntaxIndices.length !== 1) return null
      const syntaxIndex = row.syntaxIndices[0], trace = actual.syntax?.contentTraces[syntaxIndex]
      if (!trace || trace.index !== syntaxIndex || trace.content !== block.content || manifest.syntaxToOutput[syntaxIndex] !== index) return null
      const raw = projectMarkdownSourceContentRange(trace, span.from, span.to)
      return raw && contains(row.sourceRange, raw) && sameSpan(projectMarkdownSourceRawRange(trace, raw.from, raw.to), span) ? raw : null
    }
    if (row.kind !== 'retained' && row.kind !== 'empty-retained' || !row.anchor) return null
    const anchor = anchors.get(row.anchor.openingIndex)
    if (!anchor) return null
    const old = opening.blocks[anchor.openingIndex]
    if (old?.content !== block.content || !sameSpan(row.sourceRange, row.anchor)
      || draft.source.slice(row.anchor.from, row.anchor.to) !== row.anchor.original || row.anchor.original !== anchor.original) return null
    const raw = projectOpeningContentRange(saved.root.manifest, anchor.openingIndex, span.from, span.to)
    if (!raw || !contains(anchor, raw) || !sameSpan(projectOpeningSourceRange(saved.root.manifest, anchor.openingIndex, raw.from, raw.to), span)) return null
    const shift = row.anchor.from - anchor.from, result = { from: raw.from + shift, to: raw.to + shift }
    return contains(row.sourceRange, result) ? result : null
  }
  const fromSource = (span: Span): ContentSpan => {
    const candidates: ContentSpan[] = []
    for (const index of rawDomains(span)) {
      const row = manifest.outputs[index]
      let content: Span | null = null
      if (row.kind === 'syntax' && row.syntaxIndices.length === 1) {
        const trace = actual.syntax?.contentTraces[row.syntaxIndices[0]]
        if (trace) content = projectMarkdownSourceRawRange(trace, span.from, span.to)
      } else if ((row.kind === 'retained' || row.kind === 'empty-retained') && row.anchor) {
        const anchor = anchors.get(row.anchor.openingIndex)
        if (anchor) {
          const shift = row.anchor.from - anchor.from
          content = projectOpeningSourceRange(saved.root.manifest, anchor.openingIndex, span.from - shift, span.to - shift)
        }
      }
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
  const emission = serializeMarkdownWithEmissionTrace(current.blocks, { normalizeLineEndings: false }), d = checkedObservation(observeMarkdownSourceOccurrences(emission.markdown))
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
  const result = geometry(draft, saved, actual)
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
