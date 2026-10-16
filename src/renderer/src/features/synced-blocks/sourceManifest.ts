import type { DocumentBlockDraft } from '@shared/contracts'
import type { MarkdownSourceStrictOptions } from '@shared/markdown'
import { parseMarkdownSourceStrictWithTrace, type MarkdownSourceStrictTracedResult } from '@shared/markdownSource'
import { serializeMarkdownWithEmissionTrace, projectMarkdownEmissionContentRange, projectMarkdownEmissionSourceRange,
  type MarkdownEmissionContentTrace } from '@shared/markdownEmissionTrace'
import type { SyncedCanonicalEdit, SyncedStableBlockDraft } from '@shared/synced-blocks'
import { SyncedValidationError, validateSyncedCanonicalEdit } from '@shared/syncedBlockValidation'
import { projectMarkdownSourceContentRange, projectMarkdownSourceRawRange } from '@shared/markdownSourceTrace'
import { createMarkdownSourceDraft, observeMarkdownSourceDraft, type MarkdownSourceChange, type MarkdownSourceDraft,
  type MarkdownSourceDraftObservationPort, type MarkdownSourceDraftSerializer } from '../../utils/markdownSourceDraft'
import { canonicalSourceDraftToBlocks, createCanonicalSourceDraft, reconcileMarkdownSourceDraft,
  type MarkdownSourceReconciliationOptions, type MarkdownSourceReconciliationPort, type MarkdownSourceReconcileOutput } from './canonicalSource'
import type { MarkdownSourceIdentityView } from './canonicalSource'

type Span = Readonly<{ from: number; to: number }>
type Anchor = MarkdownSourceDraft['anchors'][number]
type Output = Readonly<MarkdownSourceReconcileOutput>
export interface MarkdownSourceOpeningManifest { readonly kind: 'source-opening'; readonly token: string }
export interface MarkdownSourceReconciliationManifest { readonly kind: 'source-reconciliation'; readonly token: string }
export interface CanonicalSourceAllocation { readonly kind: 'canonical-source-allocation' }
export interface MarkdownSourceAllocationBasis { readonly kind: 'source-allocation-basis' }
export interface MarkdownSourceAllocationAnchorFact {
  readonly basis: MarkdownSourceAllocationBasis
  readonly outputIndex: number
  readonly blockId: string
  readonly from: number
  readonly to: number
  readonly original: string
}
export interface MarkdownSourceAnchorFact {
  readonly openingIndex: number
  readonly blockId: string | undefined
  readonly from: number
  readonly to: number
  readonly original: string
}
export interface MarkdownSourceOpeningFacts {
  readonly source: string
  readonly blocks: readonly Readonly<DocumentBlockDraft>[]
  readonly anchors: readonly MarkdownSourceAnchorFact[]
  readonly contentTraces: readonly MarkdownEmissionContentTrace[]
}
export interface MarkdownSourceDraftReceipt {
  readonly opening: MarkdownSourceOpeningManifest
  readonly token: string
  readonly revision: number
  /** This one candidate batch, still in its actual before raw coordinates.
   * It is not an accepted CM ledger and does not imply continue/copy/new. */
  readonly rawChanges: readonly Readonly<MarkdownSourceChange>[]
}
export interface MarkdownSourceOutputFact {
  readonly kind: 'syntax' | 'retained' | 'empty-retained' | 'empty-created' | 'ref'
  readonly basis: 'syntax' | 'opening' | 'created'
  readonly emissionOrdinal: number
  readonly outputIndex: number
  readonly block: Readonly<SyncedStableBlockDraft>
  readonly sourceRange: Span | null
  readonly syntaxIndices: readonly number[]
  readonly anchor: MarkdownSourceAnchorFact | null
  /** Present only in the opt-in allocation path, never a forged openingIndex. */
  readonly allocationAnchor?: MarkdownSourceAllocationAnchorFact
  readonly referenceKey: string | null
  readonly parent: Readonly<{ kind: 'syntax'; syntaxIndex: number | null; outputIndex: number | null; blockId: string | null }
    | { kind: 'opening'; blockId: string | null } | { kind: 'created'; blockId: null }>
}
export interface MarkdownSourceReconciliationFacts {
  readonly opening: MarkdownSourceOpeningManifest
  readonly draftReceipt: MarkdownSourceDraftReceipt
  readonly source: string
  readonly outputs: readonly MarkdownSourceOutputFact[]
  /** Actual sort order in terms of the original outputs.push ordinal. */
  readonly sortPermutation: readonly number[]
  readonly syntaxToOutput: readonly (number | null)[]
}
type DraftRecord = {
  source: string; initialSource: string; initialBlocks: DocumentBlockDraft[]; blocks: readonly DocumentBlockDraft[];
  anchorArray: Anchor[]; anchors: readonly Anchor[]; prototype: object | null; ownKeys: readonly PropertyKey[];
  anchorFacts: ReadonlyMap<Anchor, MarkdownSourceAnchorFact>; receipt: MarkdownSourceDraftReceipt
}
type OpeningBase = { initialBlocks: DocumentBlockDraft[]; blocks: readonly DocumentBlockDraft[]; issuedIds: Set<string> }
type RawEdge = { parent: MarkdownSourceDraftReceipt; changes: readonly Readonly<MarkdownSourceChange>[];
  textChanges: readonly Readonly<MarkdownSourceChange>[]; beforeLength: number; afterLength: number }
type Projection = { toRaw: (range: Span) => Span | null; fromRaw: (range: Span) => Span | null }
type BasisRecord = { receipt: MarkdownSourceDraftReceipt; source: string; blocks: SyncedCanonicalEdit[]; anchors: Anchor[];
  projections: readonly Projection[]; allocation: CanonicalSourceAllocation }
type Overlay = { basis: MarkdownSourceAllocationBasis; view: MarkdownSourceIdentityView; facts: ReadonlyMap<Anchor, MarkdownSourceAllocationAnchorFact> }
type CanonicalResult = { blocks: SyncedCanonicalEdit[]; syntax: MarkdownSourceStrictTracedResult | null; manifest: MarkdownSourceReconciliationManifest }
type AllocationMemo = { kind: 'running' } | { kind: 'error'; error: unknown } | { kind: 'ready'; value: CanonicalResult;
  basis: MarkdownSourceAllocationBasis | null; allocation?: CanonicalSourceAllocation }
export interface CanonicalSourceAllocationFacts {
  readonly draftReceipt: MarkdownSourceDraftReceipt
  readonly source: string
  readonly basis: MarkdownSourceAllocationBasis | null
  readonly blocks: readonly Readonly<SyncedCanonicalEdit>[]
  readonly reconciliationManifest: MarkdownSourceReconciliationManifest
}
const openings = new WeakMap<MarkdownSourceOpeningManifest, MarkdownSourceOpeningFacts>()
const openingBases = new WeakMap<MarkdownSourceOpeningManifest, OpeningBase>()
const reconciliations = new WeakMap<MarkdownSourceReconciliationManifest, MarkdownSourceReconciliationFacts>()
const drafts = new WeakMap<MarkdownSourceDraft, DraftRecord>()
const rawEdges = new WeakMap<MarkdownSourceDraftReceipt, RawEdge>()
const runtimes = new WeakMap<MarkdownSourceReconciliationManifest, { syntax: MarkdownSourceStrictTracedResult | null }>()
const allocationMemos = new WeakMap<MarkdownSourceDraft, AllocationMemo>()
const allocations = new WeakMap<CanonicalSourceAllocation, CanonicalSourceAllocationFacts>()
const bases = new WeakMap<MarkdownSourceAllocationBasis, BasisRecord>()
const basisByAllocation = new WeakMap<CanonicalSourceAllocation, MarkdownSourceAllocationBasis>()
const outputProjections = new WeakMap<MarkdownSourceReconciliationManifest, Map<number, Projection>>()
const openingAnchorIndices = new WeakMap<MarkdownSourceOpeningManifest, ReadonlyMap<number, MarkdownSourceAnchorFact>>()
function invalid(message: string): never { throw new SyncedValidationError('forest', message) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== null && prototype !== Object.prototype) invalid('Source facts require immutable plain data.')
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) invalid('Source facts cannot contain an accessor or symbolic property.')
      freeze(descriptor.value)
    }
    Object.freeze(value)
  }
  return value
}
function record(draft: MarkdownSourceDraft): DraftRecord {
  const value = drafts.get(draft)
  const keys = value && Reflect.ownKeys(draft)
  if (!value || Object.getPrototypeOf(draft) !== value.prototype || !keys || keys.length !== value.ownKeys.length
    || keys.some((key, index) => key !== value.ownKeys[index] || !Object.hasOwn(Object.getOwnPropertyDescriptor(draft, key)!, 'value'))
    || draft.source !== value.source || draft.initialSource !== value.initialSource || draft.initialBlocks !== value.initialBlocks
    || draft.initialBlocks.length !== value.blocks.length || draft.anchors !== value.anchorArray || draft.anchors.length !== value.anchors.length)
    return invalid('Source draft has no current immutable observation receipt.')
  // These exact arrays and all nested values were privately allocated and
  // frozen by the cold factory. Identity is safe only with that invariant;
  // caller-owned mutable arrays are never admitted here.
  return value
}
function capture(draft: MarkdownSourceDraft, receipt: MarkdownSourceDraftReceipt, previous?: DraftRecord): void {
  let base = openingBases.get(receipt.opening)
  if (!base) {
    if (!Object.isFrozen(draft.initialBlocks)) invalid('The cold opening snapshot must be immutable.')
    base = { initialBlocks: draft.initialBlocks, blocks: draft.initialBlocks,
      issuedIds: new Set(draft.initialBlocks.flatMap(block => block.id === undefined ? [] : [block.id])) }
    openingBases.set(receipt.opening, base)
  } else if (base.initialBlocks !== draft.initialBlocks) invalid('An observed candidate changed its opening block snapshot.')
  const indices = new Map(draft.initialBlocks.map((block, index) => [block, index]))
  const anchorFacts = new Map<Anchor, MarkdownSourceAnchorFact>()
  for (const anchor of draft.anchors) {
    const index = indices.get(anchor.block)
    if (index === undefined || !Number.isSafeInteger(anchor.from) || !Number.isSafeInteger(anchor.to)
      || anchor.from < 0 || anchor.to < anchor.from || anchor.to > draft.source.length || typeof anchor.original !== 'string')
      invalid('Invalid actual source anchor observation.')
    anchorFacts.set(anchor, Object.freeze({ openingIndex: index, blockId: anchor.block.id, from: anchor.from, to: anchor.to, original: anchor.original }))
  }
  // All anchors come from this actual create/replace invocation, not caller
  // inputs. Replace helpers construct new arrays/anchors rather than mutate.
  freeze(draft.anchors)
  drafts.set(draft, { source: draft.source, initialSource: draft.initialSource, initialBlocks: draft.initialBlocks, blocks: base.blocks,
    anchorArray: draft.anchors, anchors: draft.anchors, prototype: Object.getPrototypeOf(draft), ownKeys: Reflect.ownKeys(draft), anchorFacts, receipt })
  if (previous) rawEdges.set(receipt, { parent: previous.receipt, changes: receipt.rawChanges,
    textChanges: Object.freeze(receipt.rawChanges.filter(change => previous.source.slice(change.from, change.to) !== change.insert)),
    beforeLength: previous.source.length, afterLength: draft.source.length })
}
function snapshotChange(source: string, raw: unknown): Readonly<MarkdownSourceChange> {
  if (!raw || typeof raw !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).length !== 3) invalid('A source change must be a closed plain data object.')
  const from = Object.getOwnPropertyDescriptor(raw, 'from'), to = Object.getOwnPropertyDescriptor(raw, 'to'), insert = Object.getOwnPropertyDescriptor(raw, 'insert')
  if (!from || !to || !insert || !Object.hasOwn(from, 'value') || !Object.hasOwn(to, 'value') || !Object.hasOwn(insert, 'value')
    || !Number.isSafeInteger(from.value) || !Number.isSafeInteger(to.value) || from.value < 0 || to.value < from.value
    || to.value > source.length || typeof insert.value !== 'string') invalid('Invalid raw source change observation.')
  return Object.freeze({ from: from.value, to: to.value, insert: insert.value })
}
const observation: MarkdownSourceDraftObservationPort = {
  check: draft => { record(draft) },
  prepareChange(before, raw) { record(before); return snapshotChange(before.source, raw) },
  prepareChanges(before, raw) {
    record(before)
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || Reflect.ownKeys(raw).length !== raw.length + 1)
      invalid('Source changes require a plain dense data array.')
    const changes: Readonly<MarkdownSourceChange>[] = []
    for (let index = 0; index < raw.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Source changes cannot contain an accessor or sparse item.')
      changes.push(snapshotChange(before.source, descriptor.value))
    }
    const ordered = [...changes].sort((left, right) => left.from - right.from || left.to - right.to)
    for (let index = 1; index < ordered.length; index++) if (ordered[index].from < ordered[index - 1].to || ordered[index].from === ordered[index - 1].from)
      invalid('Overlapping raw source change observation.')
    return Object.freeze(changes)
  },
  changed(before, after, raw) {
    const previous = record(before)
    if (after === before || after.initialBlocks !== before.initialBlocks || after.initialSource !== before.initialSource
      || previous.receipt.revision === Number.MAX_SAFE_INTEGER) invalid('Invalid observed source candidate.')
    const isList = (value: MarkdownSourceChange | readonly MarkdownSourceChange[]): value is readonly MarkdownSourceChange[] => Array.isArray(value)
    const changes = isList(raw) ? raw : [raw]
    // This registers a candidate only. Repeating a CM filter from the same
    // before creates another immutable receipt; it advances no accepted ledger.
    capture(after, freeze({ opening: previous.receipt.opening, token: crypto.randomUUID(), revision: previous.receipt.revision + 1,
      rawChanges: changes.map(change => ({ from: change.from, to: change.to, insert: change.insert })) }), previous)
  }
}

function createOpening(create: (serializer: MarkdownSourceDraftSerializer) => MarkdownSourceDraft) {
  const invocations: Array<ReturnType<typeof serializeMarkdownWithEmissionTrace>> = []
  const serializer = (original: DocumentBlockDraft[]) => {
    const actual = serializeMarkdownWithEmissionTrace(original, { normalizeLineEndings: true })
    invocations.push(actual); return actual
  }
  const draft = create(serializer)
  const rendered = invocations[0]
  if (invocations.length !== 1 || !rendered || rendered.markdown !== draft.source || rendered.contentTraces.length !== draft.initialBlocks.length
    || rendered.contentTraces.some((trace, index) => trace.index !== index || trace.content !== draft.initialBlocks[index].content || trace.source !== draft.source))
    invalid('The opening manifest did not observe the actual source serializer.')
  freeze(draft.initialBlocks)
  const opening: MarkdownSourceOpeningManifest = Object.freeze({ kind: 'source-opening', token: crypto.randomUUID() })
  capture(draft, freeze({ opening, token: crypto.randomUUID(), revision: 0, rawChanges: [] }))
  const current = record(draft)
  openings.set(opening, freeze({ source: rendered.markdown, blocks: structuredClone(draft.initialBlocks),
    anchors: [...current.anchorFacts.values()], contentTraces: rendered.contentTraces }))
  observeMarkdownSourceDraft(draft, observation)
  return { draft, openingManifest: opening }
}
function cloneOpeningInput<T extends DocumentBlockDraft>(blocks: readonly T[]): T[] {
  if (!Array.isArray(blocks) || Object.getPrototypeOf(blocks) !== Array.prototype || Reflect.ownKeys(blocks).length !== blocks.length + 1)
    invalid('A cold source opening requires a plain dense input array.')
  const originals: T[] = [], seen = new Set<T>()
  for (let index = 0; index < blocks.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(blocks, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('A cold source opening cannot read an accessor or sparse item.')
    const block = blocks[index]
    if (seen.has(block)) invalid('Repeated original block objects have no unique source occurrence receipt.')
    seen.add(block); originals.push(block)
  }
  return structuredClone(originals)
}
export function createMarkdownSourceDraftWithManifest(blocks: DocumentBlockDraft[]) {
  const owned = cloneOpeningInput(blocks)
  return createOpening(serializer => createMarkdownSourceDraft(owned, serializer))
}
export function createCanonicalSourceDraftWithManifest(blocks: readonly SyncedCanonicalEdit[]) {
  const owned = cloneOpeningInput(blocks)
  return createOpening(serializer => createCanonicalSourceDraft(owned, serializer))
}
export function readMarkdownSourceOpeningManifest(manifest: MarkdownSourceOpeningManifest): MarkdownSourceOpeningFacts {
  return openings.get(manifest) ?? invalid('Unknown source opening manifest.')
}
export function readMarkdownSourceDraftReceipt(draft: MarkdownSourceDraft): MarkdownSourceDraftReceipt { return record(draft).receipt }
export function projectOpeningContentRange(manifest: MarkdownSourceOpeningManifest, index: number, from: number, to: number): Span | null {
  const trace = readMarkdownSourceOpeningManifest(manifest).contentTraces[index]
  return Number.isSafeInteger(index) && index >= 0 && trace ? projectMarkdownEmissionContentRange(trace, from, to) : null
}
export function projectOpeningSourceRange(manifest: MarkdownSourceOpeningManifest, index: number, from: number, to: number): Span | null {
  const trace = readMarkdownSourceOpeningManifest(manifest).contentTraces[index]
  return Number.isSafeInteger(index) && index >= 0 && trace ? projectMarkdownEmissionSourceRange(trace, from, to) : null
}

type Captured = { kind: MarkdownSourceOutputFact['kind']; basis: MarkdownSourceOutputFact['basis']; ordinal: number;
  anchor: MarkdownSourceAnchorFact | null; allocationAnchor?: MarkdownSourceAllocationAnchorFact; referenceKey: string | null }
function collector(draft: MarkdownSourceDraft, overlay?: Overlay) {
  const current = record(draft), emitted = new Map<Output, Captured>()
  let rows: MarkdownSourceOutputFact[] = [], syntaxToOutput: Array<number | null> = []
  let syntax: MarkdownSourceStrictTracedResult | null = null
  const parse = (options: MarkdownSourceStrictOptions) => {
    if (syntax) invalid('A source manifest cannot replace its actual parser invocation.')
    syntax = freeze(parseMarkdownSourceStrictWithTrace(draft.source, options))
    return syntax
  }
  const anchorFact = (anchor: Anchor | undefined) => {
    if (!anchor) return { anchor: null }
    if (overlay) {
      const allocationAnchor = overlay.facts.get(anchor) ?? invalid('The mapper claimed a non-observed allocation anchor.')
      return { anchor: null, allocationAnchor }
    }
    return { anchor: current.anchorFacts.get(anchor) ?? invalid('The mapper claimed a non-observed anchor.') }
  }
  const port: MarkdownSourceReconciliationPort = {
    parseCanonical(source) {
      if (source !== draft.source) invalid('The actual parser source differs from its draft receipt.')
      return parse({ mode: 'canonical' })
    },
    emitted(output, fact) {
      if (emitted.has(output)) invalid('The mapper emitted an output twice.')
      emitted.set(output, { kind: fact.kind, basis: 'syntax', ordinal: emitted.size, ...anchorFact(fact.anchor), referenceKey: fact.referenceKey })
    },
    emptyRetained(output, anchor) {
      if (emitted.has(output)) invalid('The mapper emitted an empty output twice.')
      emitted.set(output, { kind: 'empty-retained', basis: 'syntax', ordinal: emitted.size, ...anchorFact(anchor), referenceKey: null })
    },
    sorted(outputs, syntaxOutputs) {
      if (outputs.length !== emitted.size) invalid('The mapper omitted an output observation.')
      const indices = new Map(outputs.map((output, index) => [output, index])), syntax = new Map<Output, number[]>()
      syntaxToOutput = []
      for (const [index, output] of syntaxOutputs) {
        const position = indices.get(output)
        if (position === undefined) invalid('A syntax output disappeared from the actual sort.')
        syntaxToOutput[index] = position
        const values = syntax.get(output) ?? []; values.push(index); syntax.set(output, values)
      }
      rows = outputs.map<MarkdownSourceOutputFact>((output, outputIndex) => {
        const fact = emitted.get(output) ?? invalid('An unknown output entered the final source sort.')
        const parentOutput = output.parentIndex === null ? null : syntaxOutputs.get(output.parentIndex)
        const parentIndex = parentOutput == null ? null : indices.get(parentOutput)
        if (output.parentIndex !== null && (parentIndex === undefined || parentIndex === null)) invalid('The source parent receipt is missing.')
        return { kind: fact.kind, basis: fact.basis, emissionOrdinal: fact.ordinal, outputIndex, block: output.block,
          sourceRange: { ...output.range }, syntaxIndices: syntax.get(output) ?? [], anchor: fact.anchor, referenceKey: fact.referenceKey,
          ...(fact.allocationAnchor ? { allocationAnchor: fact.allocationAnchor } : {}),
          parent: { kind: 'syntax', syntaxIndex: output.parentIndex, outputIndex: parentIndex ?? null, blockId: parentOutput?.block.id ?? null } }
      })
    },
    unchanged(_draft, blocks) {
      if (_draft !== draft || blocks.length !== draft.anchors.length) invalid('Invalid actual unchanged source observation.')
      rows = blocks.map<MarkdownSourceOutputFact>((block, outputIndex) => ({ kind: block.type === 'paragraph' && block.content === '' ? 'empty-retained' : 'retained',
        basis: 'opening', emissionOrdinal: outputIndex, outputIndex, block, sourceRange: { from: draft.anchors[outputIndex].from, to: draft.anchors[outputIndex].to },
        syntaxIndices: [], ...anchorFact(draft.anchors[outputIndex]), referenceKey: null,
        parent: { kind: 'opening', blockId: block.parentBlockId } }))
    },
    emptyCreated(block) {
      if (rows.length || emitted.size) invalid('A created empty paragraph cannot replace an observed output.')
      rows = [{ kind: 'empty-created', basis: 'created', emissionOrdinal: 0, outputIndex: 0, block, sourceRange: null,
        syntaxIndices: [], anchor: null, referenceKey: null, parent: { kind: 'created', blockId: null } }]
    }
  }
  const finish = (blocks: readonly SyncedStableBlockDraft[]): MarkdownSourceReconciliationManifest => {
    record(draft)
    if (blocks.length !== rows.length || rows.some((row, index) => row.outputIndex !== index || row.block.id !== blocks[index].id
      || row.block.content !== blocks[index].content || row.block.parentBlockId !== blocks[index].parentBlockId))
      invalid('Final blocks differ from their actual source output receipts.')
    const manifest: MarkdownSourceReconciliationManifest = Object.freeze({ kind: 'source-reconciliation', token: crypto.randomUUID() })
    reconciliations.set(manifest, freeze({ opening: current.receipt.opening, draftReceipt: current.receipt, source: draft.source,
      outputs: rows.map((row, index) => ({ ...row, block: structuredClone(blocks[index]) })), sortPermutation: rows.map(row => row.emissionOrdinal),
      syntaxToOutput: Array.from(syntaxToOutput, value => value ?? null) }))
    runtimes.set(manifest, { syntax })
    return manifest
  }
  return { port, finish, parse, syntax: () => syntax }
}
export function readMarkdownSourceReconciliationManifest(manifest: MarkdownSourceReconciliationManifest): MarkdownSourceReconciliationFacts {
  return reconciliations.get(manifest) ?? invalid('Unknown source reconciliation manifest.')
}
export function reconcileMarkdownSourceDraftWithManifest(draft: MarkdownSourceDraft, sourceOptions: MarkdownSourceStrictOptions,
  options: Omit<MarkdownSourceReconciliationOptions, 'observation'> = {}) {
  const observed = collector(draft), syntax = observed.parse(sourceOptions)
  const blocks = reconcileMarkdownSourceDraft(draft, syntax, { ...options, observation: observed.port })
  return { blocks, syntax, manifest: observed.finish(blocks) }
}
export function canonicalSourceDraftToBlocksWithManifest(draft: MarkdownSourceDraft, freshId: () => string = () => crypto.randomUUID()) {
  return canonicalOnce(draft, null, freshId)
}

function basisRecord(basis: MarkdownSourceAllocationBasis): BasisRecord {
  return bases.get(basis) ?? invalid('Unknown actual source allocation basis.')
}
/** Interval arithmetic only. Same effective disjoint-change policy as the
 * existing raw draft mapper; no parser, metadata, text/URL correspondence. */
function mapBasisAnchors(anchors: readonly Anchor[], changes: readonly Readonly<MarkdownSourceChange>[]): Anchor[] {
  const edits = [...changes].sort((a, b) => a.from - b.from || a.to - b.to).map(change => ({ ...change, shift: 0, claimed: false }))
  let shift = 0
  for (const edit of edits) { edit.shift = shift; shift += edit.insert.length - (edit.to - edit.from) }
  return anchors.flatMap(anchor => {
    let low = 0, high = edits.length
    while (low < high) { const middle = (low + high) >>> 1; if (edits[middle].to <= anchor.from) low = middle + 1; else high = middle }
    if (anchor.from === anchor.to && low > 0 && edits[low - 1].from === anchor.from && edits[low - 1].to === anchor.to) low--
    const precedingShift = edits[low]?.shift ?? shift
    let from = anchor.from + precedingShift, to = anchor.to + precedingShift
    for (let at = low; at < edits.length; at++) {
      const edit = edits[at]
      if (edit.from > anchor.to || edit.from === anchor.to && anchor.from !== anchor.to) break
      const editFrom = edit.from + edit.shift, editTo = edit.to + edit.shift
      if (from === to && from === editFrom && editFrom === editTo) { edit.claimed = true; to = from + edit.insert.length; continue }
      if (to <= editFrom) break
      const delta = edit.insert.length - (edit.to - edit.from)
      if (from >= editTo) { from += delta; to += delta; continue }
      if (editFrom <= from && editTo >= to && (!edit.insert || edit.claimed)) return []
      edit.claimed = true; from = from < editFrom ? from : editFrom; to = to > editTo ? to + delta : editFrom + edit.insert.length
    }
    return [{ ...anchor, from, to }]
  })
}
function mappedOverlay(draft: MarkdownSourceDraft, basis: MarkdownSourceAllocationBasis): Overlay {
  const current = record(draft), saved = basisRecord(basis)
  if (saved.receipt.opening !== current.receipt.opening) invalid('An allocation basis belongs to another actual opening.')
  const edges: RawEdge[] = [], visited = new Set<MarkdownSourceDraftReceipt>()
  let receipt = current.receipt
  while (receipt !== saved.receipt) {
    if (visited.has(receipt)) invalid('The raw source path contains a cycle.')
    visited.add(receipt)
    const edge = rawEdges.get(receipt) ?? invalid('An allocation basis is not an actual ancestor of this draft.')
    edges.push(edge); receipt = edge.parent
  }
  let anchors = [...saved.anchors], length = saved.source.length
  for (const edge of edges.reverse()) {
    if (edge.beforeLength !== length) invalid('The actual raw edge length differs from its allocation basis.')
    anchors = mapBasisAnchors(anchors, edge.textChanges); length = edge.afterLength
  }
  if (length !== current.source.length || anchors.some(anchor => anchor.from < 0 || anchor.to < anchor.from || anchor.to > length))
    invalid('The mapped allocation anchors differ from the actual descendant.')
  const outputByBlock = new Map(saved.blocks.map((block, index) => [block, index]))
  const facts = new Map<Anchor, MarkdownSourceAllocationAnchorFact>()
  for (const anchor of anchors) {
    const outputIndex = outputByBlock.get(anchor.block as SyncedCanonicalEdit)
    if (outputIndex === undefined || typeof anchor.block.id !== 'string') invalid('The allocation anchor lost its actual output identity.')
    facts.set(anchor, freeze({ basis, outputIndex, blockId: anchor.block.id, from: anchor.from, to: anchor.to, original: anchor.original }))
  }
  freeze(anchors)
  return { basis, view: { blocks: saved.blocks, anchors }, facts }
}
function canonicalOnce(draft: MarkdownSourceDraft, basis: MarkdownSourceAllocationBasis | null, freshId: () => string, exactBasis = false): CanonicalResult {
  const current = record(draft), memo = allocationMemos.get(draft)
  if (memo) {
    if (memo.kind === 'running') invalid('This actual draft is already being allocated.')
    if (memo.kind === 'error') throw memo.error
    if ((exactBasis || basis !== null) && memo.basis !== basis) invalid('The first allocation basis of an actual draft cannot be replaced.')
    return memo.value
  }
  if (typeof freshId !== 'function') invalid('The actual fresh identity allocator must be a function.')
  const overlay = basis ? mappedOverlay(draft, basis) : undefined
  const root = openingBases.get(current.receipt.opening) ?? invalid('Missing actual allocation root.')
  allocationMemos.set(draft, { kind: 'running' })
  try {
    const observed = collector(draft, overlay)
    const fresh = () => {
      const id = freshId()
      if (typeof id === 'string') {
        if (root.issuedIds.has(id)) throw new SyncedValidationError('identity', 'An allocated identity cannot be reissued in this source opening.')
        root.issuedIds.add(id)
      }
      return id
    }
    const blocks = canonicalSourceDraftToBlocks(draft, fresh, observed.port, overlay?.view)
    const value = freeze({ blocks, syntax: observed.syntax(), manifest: observed.finish(blocks) })
    allocationMemos.set(draft, { kind: 'ready', value, basis })
    return value
  } catch (error) { allocationMemos.set(draft, { kind: 'error', error }); throw error }
}
/** Allocation only: no accepted endpoint, link claims, target or persistence. */
export function allocateCanonicalSourceDraft(draft: MarkdownSourceDraft, options: {
  basis?: MarkdownSourceAllocationBasis; freshId?: () => string
} = {}): CanonicalSourceAllocation {
  if (!options || typeof options !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(options))) invalid('Invalid allocation options.')
  const descriptors = Object.getOwnPropertyDescriptors(options)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !['basis', 'freshId'].includes(key)
    || !Object.hasOwn(descriptors[key], 'value'))) invalid('Allocation options require closed own data.')
  const basis = descriptors.basis?.value as MarkdownSourceAllocationBasis | undefined
  const freshId = descriptors.freshId?.value as (() => string) | undefined
  if (basis !== undefined) basisRecord(basis)
  if (freshId !== undefined && typeof freshId !== 'function') invalid('The actual fresh identity allocator must be a function.')
  const existing = allocationMemos.get(draft)
  // Reading an already-issued allocation without a basis is idempotent. The
  // first registration below must still match the C's exact null/non-null
  // basis, and an explicit alternative basis can never replace that choice.
  if (basis === undefined && existing?.kind === 'ready' && existing.allocation) {
    record(draft)
    return existing.allocation
  }
  const value = canonicalOnce(draft, basis ?? null, freshId ?? (() => crypto.randomUUID()), true)
  const memo = allocationMemos.get(draft)
  if (!memo || memo.kind !== 'ready') invalid('The actual allocation result was not registered.')
  const facts = readMarkdownSourceReconciliationManifest(value.manifest)
  if (facts.outputs.some(row => row.sourceRange === null) && (draft.source !== '' || facts.outputs.length !== 1
    || facts.outputs[0].kind !== 'empty-created')) invalid('A nonempty raw source has no proven empty-document slot.')
  if (!memo.allocation) {
    const allocation: CanonicalSourceAllocation = Object.freeze({ kind: 'canonical-source-allocation' })
    allocations.set(allocation, freeze({ draftReceipt: facts.draftReceipt, source: facts.source, basis: memo.basis,
      blocks: value.blocks, reconciliationManifest: value.manifest }))
    memo.allocation = allocation
  }
  return memo.allocation
}
export function readCanonicalSourceAllocation(allocation: CanonicalSourceAllocation): CanonicalSourceAllocationFacts {
  return allocations.get(allocation) ?? invalid('Unknown actual source allocation.')
}
const sameRange = (left: Span | null, right: Span) => !!left && left.from === right.from && left.to === right.to
const within = (outer: Span, inner: Span) => outer.from <= inner.from && inner.to <= outer.to
function outputProjection(manifest: MarkdownSourceReconciliationManifest, index: number): Projection {
  const cached = outputProjections.get(manifest)?.get(index)
  if (cached) return cached
  const projection = buildOutputProjection(manifest, index)
  let entries = outputProjections.get(manifest)
  if (!entries) { entries = new Map(); outputProjections.set(manifest, entries) }
  entries.set(index, projection)
  return projection
}
function buildOutputProjection(manifest: MarkdownSourceReconciliationManifest, index: number): Projection {
  const facts = readMarkdownSourceReconciliationManifest(manifest), row = facts.outputs[index]
  const runtime = runtimes.get(manifest) ?? invalid('Missing actual reconciliation runtime.')
  const range = row.sourceRange
  if (!range) {
    if (row.kind !== 'empty-created' || facts.source !== '' || facts.outputs.length !== 1 || row.block.content !== '')
      invalid('No actual empty-document carrier is available.')
    const empty = (span: Span) => span.from === 0 && span.to === 0 ? { from: 0, to: 0 } : null
    return { toRaw: empty, fromRaw: empty }
  }
  if (row.kind === 'syntax' && row.syntaxIndices.length === 1) {
    const trace = runtime.syntax?.contentTraces[row.syntaxIndices[0]]
    if (!trace || trace.content !== row.block.content) invalid('The actual syntax payload projection is missing.')
    return {
      toRaw(span) { const raw = projectMarkdownSourceContentRange(trace, span.from, span.to)
        return raw && within(range, raw) && sameRange(projectMarkdownSourceRawRange(trace, raw.from, raw.to), span) ? raw : null },
      fromRaw(span) { const content = within(range, span) && projectMarkdownSourceRawRange(trace, span.from, span.to)
        return content && sameRange(projectMarkdownSourceContentRange(trace, content.from, content.to), span) ? content : null }
    }
  }
  if (row.kind !== 'retained' && row.kind !== 'empty-retained') invalid('The allocation row has no retained source carrier.')
  let original: Span & { original: string }, projection: Projection
  if (row.allocationAnchor) {
    const prior = basisRecord(row.allocationAnchor.basis), at = row.allocationAnchor.outputIndex
    original = prior.anchors[at] ?? invalid('Missing prior allocation anchor.')
    if (prior.blocks[at].content !== row.block.content || row.allocationAnchor.original !== original.original)
      invalid('The prior actual allocation payload changed.')
    projection = prior.projections[at]
  } else if (row.anchor) {
    const opening = readMarkdownSourceOpeningManifest(facts.opening), at = row.anchor.openingIndex
    let anchors = openingAnchorIndices.get(facts.opening)
    if (!anchors) {
      anchors = new Map(opening.anchors.map(anchor => [anchor.openingIndex, anchor]))
      if (anchors.size !== opening.anchors.length) invalid('The actual opening anchor index is not unique.')
      openingAnchorIndices.set(facts.opening, anchors)
    }
    original = anchors.get(at) ?? invalid('Missing original opening anchor.')
    if (opening.blocks[at].content !== row.block.content || row.anchor.original !== original.original) invalid('The original opening payload changed.')
    projection = { toRaw: span => projectOpeningContentRange(facts.opening, at, span.from, span.to),
      fromRaw: span => projectOpeningSourceRange(facts.opening, at, span.from, span.to) }
  } else invalid('The retained row has no actual identity-basis receipt.')
  const anchor = row.allocationAnchor ?? row.anchor!
  if (!sameRange(range, anchor) || facts.source.slice(anchor.from, anchor.to) !== anchor.original) invalid('The retained raw carrier changed.')
  const shift = anchor.from - original.from
  return {
    toRaw(span) { const raw = projection.toRaw(span), moved = raw && { from: raw.from + shift, to: raw.to + shift }
      return moved && within(range, moved) && sameRange(projection.fromRaw(raw!), span) ? moved : null },
    fromRaw(span) { const old = { from: span.from - shift, to: span.to - shift }, content = within(range, span) && projection.fromRaw(old)
      return content && sameRange(projection.toRaw(content), old) ? content : null }
  }
}
/** Actual C geometry, including retained rows whose carrier came from a real
 * ancestor allocation rather than the cold opening. */
export function projectSourceReconciliationContentRange(manifest: MarkdownSourceReconciliationManifest, index: number, from: number, to: number): Span | null {
  const facts = readMarkdownSourceReconciliationManifest(manifest)
  return Number.isSafeInteger(index) && index >= 0 && index < facts.outputs.length && Number.isSafeInteger(from)
    && Number.isSafeInteger(to) && from >= 0 && to >= from ? outputProjection(manifest, index).toRaw({ from, to }) : null
}
export function projectSourceReconciliationRawRange(manifest: MarkdownSourceReconciliationManifest, index: number, from: number, to: number): Span | null {
  const facts = readMarkdownSourceReconciliationManifest(manifest)
  return Number.isSafeInteger(index) && index >= 0 && index < facts.outputs.length && Number.isSafeInteger(from)
    && Number.isSafeInteger(to) && from >= 0 && to >= from ? outputProjection(manifest, index).fromRaw({ from, to }) : null
}
/** The handle proves a real C allocation, not that a controller accepted it. */
export function createCanonicalSourceAllocationBasis(allocation: CanonicalSourceAllocation): MarkdownSourceAllocationBasis {
  const existing = basisByAllocation.get(allocation)
  if (existing) return existing
  const facts = readCanonicalSourceAllocation(allocation), rows = readMarkdownSourceReconciliationManifest(facts.reconciliationManifest).outputs
  const blocks = validateSyncedCanonicalEdit(facts.blocks), projections = rows.map((_row, index) => outputProjection(facts.reconciliationManifest, index))
  const anchors = rows.map<Anchor>((row, index) => {
    const range = row.sourceRange ?? (facts.source === '' && row.kind === 'empty-created' ? { from: 0, to: 0 } : null)
    if (!range) invalid('A null source range cannot invent an allocation slot.')
    return { ...range, block: blocks[index], original: facts.source.slice(range.from, range.to) }
  })
  freeze(blocks); freeze(anchors)
  const basis: MarkdownSourceAllocationBasis = Object.freeze({ kind: 'source-allocation-basis' })
  bases.set(basis, { receipt: facts.draftReceipt, source: facts.source, blocks, anchors, projections, allocation })
  basisByAllocation.set(allocation, basis)
  return basis
}
export function projectSourceAllocationContentRange(basis: MarkdownSourceAllocationBasis, index: number, from: number, to: number): Span | null {
  const saved = basisRecord(basis), projection = saved.projections[index]
  return Number.isSafeInteger(index) && index >= 0 && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from
    && projection ? projection.toRaw({ from, to }) : null
}
export function projectSourceAllocationRawRange(basis: MarkdownSourceAllocationBasis, index: number, from: number, to: number): Span | null {
  const saved = basisRecord(basis), projection = saved.projections[index]
  return Number.isSafeInteger(index) && index >= 0 && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from
    && projection ? projection.fromRaw({ from, to }) : null
}
