import type { DocumentBlockDraft } from '@shared/contracts'
import type { MarkdownSourceStrictOptions } from '@shared/markdown'
import { parseMarkdownSourceStrictWithTrace, type MarkdownSourceStrictTracedResult } from '@shared/markdownSource'
import { serializeMarkdownWithEmissionTrace, projectMarkdownEmissionContentRange, projectMarkdownEmissionSourceRange,
  type MarkdownEmissionContentTrace } from '@shared/markdownEmissionTrace'
import type { SyncedCanonicalEdit, SyncedStableBlockDraft } from '@shared/synced-blocks'
import { SyncedValidationError } from '@shared/syncedBlockValidation'
import { createMarkdownSourceDraft, observeMarkdownSourceDraft, type MarkdownSourceChange, type MarkdownSourceDraft,
  type MarkdownSourceDraftObservationPort, type MarkdownSourceDraftSerializer } from '../../utils/markdownSourceDraft'
import { canonicalSourceDraftToBlocks, createCanonicalSourceDraft, reconcileMarkdownSourceDraft,
  type MarkdownSourceReconciliationOptions, type MarkdownSourceReconciliationPort, type MarkdownSourceReconcileOutput } from './canonicalSource'

type Span = Readonly<{ from: number; to: number }>
type Anchor = MarkdownSourceDraft['anchors'][number]
type Output = Readonly<MarkdownSourceReconcileOutput>
export interface MarkdownSourceOpeningManifest { readonly kind: 'source-opening'; readonly token: string }
export interface MarkdownSourceReconciliationManifest { readonly kind: 'source-reconciliation'; readonly token: string }
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
type OpeningBase = { initialBlocks: DocumentBlockDraft[]; blocks: readonly DocumentBlockDraft[] }
const openings = new WeakMap<MarkdownSourceOpeningManifest, MarkdownSourceOpeningFacts>()
const openingBases = new WeakMap<MarkdownSourceOpeningManifest, OpeningBase>()
const reconciliations = new WeakMap<MarkdownSourceReconciliationManifest, MarkdownSourceReconciliationFacts>()
const drafts = new WeakMap<MarkdownSourceDraft, DraftRecord>()
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
function capture(draft: MarkdownSourceDraft, receipt: MarkdownSourceDraftReceipt): void {
  let base = openingBases.get(receipt.opening)
  if (!base) {
    if (!Object.isFrozen(draft.initialBlocks)) invalid('The cold opening snapshot must be immutable.')
    base = { initialBlocks: draft.initialBlocks, blocks: draft.initialBlocks }
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
      rawChanges: changes.map(change => ({ from: change.from, to: change.to, insert: change.insert })) }))
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
  anchor: MarkdownSourceAnchorFact | null; referenceKey: string | null }
function collector(draft: MarkdownSourceDraft) {
  const current = record(draft), emitted = new Map<Output, Captured>()
  let rows: MarkdownSourceOutputFact[] = [], syntaxToOutput: Array<number | null> = []
  let syntax: MarkdownSourceStrictTracedResult | null = null
  const parse = (options: MarkdownSourceStrictOptions) => {
    if (syntax) invalid('A source manifest cannot replace its actual parser invocation.')
    syntax = freeze(parseMarkdownSourceStrictWithTrace(draft.source, options))
    return syntax
  }
  const anchorFact = (anchor: Anchor | undefined) => anchor ? current.anchorFacts.get(anchor) ?? invalid('The mapper claimed a non-observed anchor.') : null
  const port: MarkdownSourceReconciliationPort = {
    parseCanonical(source) {
      if (source !== draft.source) invalid('The actual parser source differs from its draft receipt.')
      return parse({ mode: 'canonical' })
    },
    emitted(output, fact) {
      if (emitted.has(output)) invalid('The mapper emitted an output twice.')
      emitted.set(output, { kind: fact.kind, basis: 'syntax', ordinal: emitted.size, anchor: anchorFact(fact.anchor), referenceKey: fact.referenceKey })
    },
    emptyRetained(output, anchor) {
      if (emitted.has(output)) invalid('The mapper emitted an empty output twice.')
      emitted.set(output, { kind: 'empty-retained', basis: 'syntax', ordinal: emitted.size, anchor: anchorFact(anchor), referenceKey: null })
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
          parent: { kind: 'syntax', syntaxIndex: output.parentIndex, outputIndex: parentIndex ?? null, blockId: parentOutput?.block.id ?? null } }
      })
    },
    unchanged(_draft, blocks) {
      if (_draft !== draft || blocks.length !== draft.anchors.length) invalid('Invalid actual unchanged source observation.')
      rows = blocks.map<MarkdownSourceOutputFact>((block, outputIndex) => ({ kind: block.type === 'paragraph' && block.content === '' ? 'empty-retained' : 'retained',
        basis: 'opening', emissionOrdinal: outputIndex, outputIndex, block, sourceRange: { from: draft.anchors[outputIndex].from, to: draft.anchors[outputIndex].to },
        syntaxIndices: [], anchor: anchorFact(draft.anchors[outputIndex]), referenceKey: null,
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
  const observed = collector(draft), blocks = canonicalSourceDraftToBlocks(draft, freshId, observed.port)
  return { blocks, syntax: observed.syntax(), manifest: observed.finish(blocks) }
}
