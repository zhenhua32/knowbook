import { Mark, type Node as PMNode } from 'prosemirror-model'
import { EditorState, Transaction } from 'prosemirror-state'
import { AddMarkStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, type Step, type StepMap } from 'prosemirror-transform'
import type { MarkdownEnvironment } from '@shared/markdownEngine'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedCanonicalEdit, SyncedOriginV1 } from '@shared/synced-blocks'
import { SyncedValidationError, validateSyncedCanonicalEdit } from '@shared/syncedBlockValidation'
import { validateSyncedBindingClaims } from '@shared/syncedBlockInputs'
import { richBlockEntries, richTextInlineFingerprint, serializeRichTextInlineWithLinkTrace } from './model'
import { richLinkOccurrence, type RichPmSpan } from './linkProvenance'
import { seedRichProvenance, type RichProvenanceSeed } from './richProvenanceSeed'
import { createRichPmDocIndex } from './richPmDocIndex'
import { createRichActualKeyCache, prepareRichActualKeys, type RichActualKeyCache } from './richActualKeys'
import { captureRichObservedStep, copyRichObservedLeaf, isRichObservedStepCurrent, replayRichObservedStep, type ClosedRichObservedStep } from './richObservedStepPayload'

const keyId = (key: Readonly<SyncedBindingKey>) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function invalid(message: string): never { throw new SyncedValidationError('binding', message) }
type Origin = Readonly<{ rank: number }>
type Piece = { from: number; to: number; token: string; href: string; lineage: object;
  source: Readonly<SyncedBindingKey> | null; origin: Origin | null; role: 'direct' | 'reference' | 'new' }
type Physical = { key: Readonly<SyncedBindingKey>; origin: Origin; lineage: object }
type Atom = { pos: number; node: PMNode; keys: Physical[] }
type RawLink = { key: Readonly<SyncedBindingKey>; spans: readonly RichPmSpan[] }
type RawReference = { definition: Origin; spans: readonly RichPmSpan[] }
type RawRecord = { content: string; fingerprint: string; links: readonly RawLink[]; references: readonly RawReference[] }
type Data = { doc: PMNode; blocks: readonly SyncedCanonicalEdit[]; origin: Readonly<SyncedOriginV1>; pieces: readonly Piece[];
  atoms: readonly Atom[]; raw: ReadonlyMap<object, RawRecord>; physical: ReadonlyMap<Origin, Physical>; tokens: ReadonlySet<string>; rank: number;
  actualKeys: RichActualKeyCache }

/** Opaque, immutable local state. Actual PM nodes are immutable PM values;
 * mutable maps/pieces never escape this module or become Main authority. */
export interface RichProvenanceState { readonly generation: string }
const states = new WeakMap<RichProvenanceState, Data>()
function state(generation: string, data: Data): RichProvenanceState {
  const result = Object.freeze({ generation }); states.set(result, data); return result
}
function dataFor(value: RichProvenanceState): Data {
  const data = states.get(value)
  return data ?? invalid('富文本来源世代无效，未生成来源声明。')
}
const carrier = (node: PMNode): object | null => node.attrs.block && typeof node.attrs.block === 'object' ? node.attrs.block : null
const local = (origin: Readonly<SyncedOriginV1>, href: string) => resolveMarkdownDocumentPath(origin.pathAtCreation, href) !== null
const docIndexes = new WeakMap<PMNode, ReturnType<typeof createRichPmDocIndex>>()
function indexFor(doc: PMNode): ReturnType<typeof createRichPmDocIndex> {
  let index = docIndexes.get(doc)
  if (!index) { index = createRichPmDocIndex(doc); docIndexes.set(doc, index) }
  return index
}
// Actual immutable PM node identity is a computation cache only. Neither a
// matching fingerprint nor metadata equality grants a source key or lineage.
const fingerprints = new WeakMap<PMNode, string>()
function fingerprint(node: PMNode): string {
  let value = fingerprints.get(node)
  if (value === undefined) { value = richTextInlineFingerprint(node); fingerprints.set(node, value) }
  return value
}
function markFor(doc: PMNode, from: number, to: number, token: string, href: string): boolean {
  return indexFor(doc).hasLinkMark(from, to, token, href)
}
function hrefAt(doc: PMNode, span: RichPmSpan, token: string): string {
  return indexFor(doc).linkHref(span.from, span.to, token) ?? invalid('播种的实际链接片段不一致或没有实际 PM 内容。')
}
function fromSeed(seed: RichProvenanceSeed): Data {
  let rank = 0
  const byKey = new Map<string, Physical>(), physical = new Map<Origin, Physical>()
  for (const key of seed.sourceInventory) {
    const origin = Object.freeze({ rank: rank++ }), value = { key, origin, lineage: Object.freeze({}) }
    byKey.set(keyId(key), value); physical.set(origin, value)
  }
  const pieces: Piece[] = seed.links.flatMap(link => {
    const source = byKey.get(keyId(link.sourceKey)) ?? invalid('播种缺少实际物理链接来源。')
    return link.pmSpans.map(span => ({ ...span, token: link.token, href: hrefAt(seed.doc, span, link.token),
      source: source.key, origin: source.origin, lineage: source.lineage, role: link.via === 'reference' ? 'reference' as const : 'direct' as const }))
  })
  const atoms: Atom[] = [], raw = new Map<object, RawRecord>()
  const linksByOwner = new Map<string, Array<RichProvenanceSeed['links'][number]>>()
  for (const link of seed.links) { const links = linksByOwner.get(link.ownerBlockId) ?? []; links.push(link); linksByOwner.set(link.ownerBlockId, links) }
  for (const record of seed.blockRecords) {
    if (record.kind === 'atom') {
      if (record.node.isLeaf) atoms.push({ pos: record.pos, node: record.node,
        keys: record.keys.map(key => byKey.get(keyId(key)) ?? invalid('原子块缺少物理目的地。')) })
      continue
    }
    const value = carrier(record.node) ?? invalid('富文本块缺少实际 raw carrier。')
    const links = linksByOwner.get(record.blockId) ?? []
    const directByKey = new Map<string, Array<RichProvenanceSeed['links'][number]>>()
    for (const link of links) if (link.via === 'direct') {
      const id = keyId(link.sourceKey), matches = directByKey.get(id) ?? []; matches.push(link); directByKey.set(id, matches)
    }
    const relative = (spans: readonly RichPmSpan[]) => spans.map(span => ({ from: span.from - record.pos - 1, to: span.to - record.pos - 1 }))
    const directs: RawLink[] = record.keys.map(key => {
      const found = directByKey.get(keyId(key)) ?? []
      if (found.length !== 1 || !found[0].pmSpans.length) invalid('raw 目的地没有唯一实际链接片段。')
      return { key, spans: relative(found[0].pmSpans) }
    })
    raw.set(value, { content: record.node.attrs.block.content, fingerprint: fingerprint(record.node), links: directs,
      references: links.filter(link => link.via === 'reference').map(link => ({
        definition: byKey.get(keyId(link.sourceKey))!.origin, spans: relative(link.pmSpans)
      })) })
  }
  const actual = createRichActualKeyCache({ doc: seed.doc, blocks: seed.blocks, origin: seed.origin })
  if (actual.keys.length !== seed.sourceInventory.length || actual.keys.some((key, index) => keyId(key) !== keyId(seed.sourceInventory[index])))
    invalid('初始实际目的地与播种完整来源不一致。')
  return { doc: seed.doc, blocks: seed.blocks, origin: seed.origin, pieces, atoms, raw, physical,
    tokens: new Set(seed.links.map(link => link.token)), rank, actualKeys: actual.cache }
}

export function seedSyncedRichProvenance(blocks: readonly SyncedCanonicalEdit[], options: {
  origin: SyncedOriginV1; externalReferences?: MarkdownEnvironment['references']; createToken?: () => string
}): { doc: PMNode; state: RichProvenanceState } {
  const seed = seedRichProvenance({ blocks, ...options })
  return { doc: seed.doc, state: state(seed.generation, fromSeed(seed)) }
}

type NewIntent = Readonly<{ step: AddMarkStep; from: number; to: number; token: string }>
type AtomIntent = Readonly<{ step: ReplaceStep; before: PMNode; after: PMNode; doc: PMNode }>
const newIntents = new WeakMap<Transaction, Map<number, NewIntent>>()
const atomIntents = new WeakMap<Transaction, Map<number, AtomIntent>>()

/** The command mints its mark before constructing the actual AddMarkStep.
 * This helper records the real step, not a promise to infer a mark later. */
export function setRichNewLinkIntent(tr: Transaction, intent: { stepIndex: number; from: number; to: number; token: string }): Transaction {
  const step = tr.steps[intent.stepIndex]
  if (!Number.isSafeInteger(intent.stepIndex) || !(step instanceof AddMarkStep) || step.mark.type.name !== 'link'
    || step.from !== intent.from || step.to !== intent.to || typeof intent.token !== 'string' || !intent.token.trim()
    || richLinkOccurrence(step.mark) !== intent.token) invalid('新链接意图与实际 mark step 不一致。')
  const entries = newIntents.get(tr) ?? new Map<number, NewIntent>()
  if (entries.has(intent.stepIndex)) invalid('重复的新链接意图。')
  entries.set(intent.stepIndex, Object.freeze({ step, from: intent.from, to: intent.to, token: intent.token })); newIntents.set(tr, entries)
  return tr
}
const identityFields = new Set(['id', 'parentBlockId', 'depth'])
function sameAtomBody(before: PMNode, after: PMNode): boolean {
  if (before.type !== after.type || !before.isLeaf || !after.isLeaf || !Mark.sameSet(before.marks, after.marks)) return false
  const left = before.attrs.block, right = after.attrs.block
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) if (!identityFields.has(key) && !same(left[key], right[key])) return false
  for (const key of new Set([...Object.keys(before.attrs), ...Object.keys(after.attrs)]))
    if (key !== 'block' && key !== 'listNumber' && !same(before.attrs[key], after.attrs[key])) return false
  return true
}
/** For the actual identity appendTransaction only. This can retain an already
 * tracked atom; it grants no source to an unknown pasted/duplicated atom. */
export function setRichAtomAttributeIntent(tr: Transaction, stepIndex: number): Transaction {
  const step = tr.steps[stepIndex], doc = tr.docs[stepIndex]
  if (!Number.isSafeInteger(stepIndex) || !(step instanceof ReplaceStep) || !doc || step.slice.openStart || step.slice.openEnd
    || step.slice.content.childCount !== 1) invalid('原子身份修复不是实际 leaf replacement。')
  const before = indexFor(doc).nodeAtStart(step.from), after = step.slice.content.firstChild!
  if (!before || step.to !== step.from + before.nodeSize || !sameAtomBody(before, after)) invalid('身份修复改变了原子正文。')
  const entries = atomIntents.get(tr) ?? new Map<number, AtomIntent>()
  if (entries.has(stepIndex)) invalid('重复的原子身份修复。')
  entries.set(stepIndex, Object.freeze({ step, before, after, doc })); atomIntents.set(tr, entries); return tr
}

type Window = { from: number; to: number; nextFrom: number; nextTo: number }
function windows(map: StepMap): Window[] {
  const result: Window[] = []; map.forEach((from, to, nextFrom, nextTo) => result.push({ from, to, nextFrom, nextTo })); return result
}
function survivors(piece: Piece, map: StepMap): Piece[] {
  const edits = windows(map), cuts = new Set<number>([piece.from, piece.to])
  for (const edit of edits) for (const point of [edit.from, edit.to]) if (point > piece.from && point < piece.to) cuts.add(point)
  const points = [...cuts].sort((a, b) => a - b), result: Piece[] = []
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1], to = points[index]
    if (edits.some(edit => edit.from < to && from < edit.to)) continue
    const nextFrom = map.map(from, 1), nextTo = map.map(to, -1)
    if (nextTo > nextFrom) result.push({ ...piece, from: nextFrom, to: nextTo })
  }
  return result
}
function subtract(pieces: readonly Piece[], from: number, to: number): Piece[] {
  return pieces.flatMap(piece => to <= piece.from || from >= piece.to ? [piece] : [
    ...(piece.from < from ? [{ ...piece, to: from }] : []), ...(piece.to > to ? [{ ...piece, from: to }] : [])
  ])
}
const pieceIndexes = new WeakMap<readonly Piece[], readonly Piece[]>()
function orderedPieces(pieces: readonly Piece[]): readonly Piece[] {
  const cached = pieceIndexes.get(pieces)
  if (cached) return cached
  const sorted = [...pieces].sort((a, b) => a.from - b.from)
  for (let index = 1; index < sorted.length; index++) if (sorted[index].from < sorted[index - 1].to)
    invalid('来源片段重复或重叠，未生成来源声明。')
  pieceIndexes.set(pieces, sorted); return sorted
}
function piecesIn(pieces: readonly Piece[], from: number, to: number): Piece[] {
  const sorted = orderedPieces(pieces)
  let low = 0, high = sorted.length
  while (low < high) { const middle = (low + high) >>> 1; if (sorted[middle].to <= from) low = middle + 1; else high = middle }
  const result: Piece[] = []
  for (let index = low; index < sorted.length && sorted[index].from < to; index++) result.push(sorted[index])
  return result
}
function contributors(pieces: readonly Piece[], spans: readonly RichPmSpan[], token?: string | null): Piece[] {
  if (!spans.length) invalid('链接发射缺少实际 PM 内容范围。')
  const result = new Set<Piece>()
  for (const span of spans) {
    let at = span.from
    for (const piece of piecesIn(pieces, span.from, span.to)) {
      if (piece.from > at || token !== undefined && piece.token !== token) invalid('链接发射包含未知或不连续来源。')
      result.add(piece); at = Math.max(at, Math.min(span.to, piece.to))
      if (at === span.to) break
    }
    if (at !== span.to) invalid('链接发射没有完整来源覆盖。')
  }
  const values = [...result], lineage = values[0]?.lineage
  if (!lineage || values.some(piece => piece.lineage !== lineage)) invalid('同一次链接发射混合了不等价来源。')
  return values
}
function inheritInserted(before: readonly Piece[], step: ReplaceStep): Piece[] {
  if (step.slice.openStart || step.slice.openEnd || !step.slice.content.content.every(node => node.isInline)) return []
  const result: Piece[] = []
  let offset = step.from
  step.slice.content.forEach(node => {
    const mark = node.marks.find(item => item.type.name === 'link'), end = offset + node.nodeSize
    if (mark) {
      const token = richLinkOccurrence(mark), href = mark.attrs.href
      const found = before.filter(piece => piece.token === token && piece.href === href
        && (step.from === step.to ? piece.from <= step.from && step.from <= piece.to : piece.from < step.to && step.from < piece.to))
      // A real insertion may sit exactly at an accepted split/join boundary.
      // Equivalent carriers share an unforgeable lineage, not merely an href.
      const source = [...found].sort((a, b) => (a.origin?.rank ?? Number.MAX_SAFE_INTEGER) - (b.origin?.rank ?? Number.MAX_SAFE_INTEGER))[0]
      if (source && found.every(piece => piece.lineage === source.lineage && piece.role === source.role)) {
        if (step.from !== step.to) contributors(found, [{ from: step.from, to: step.to }], token)
        result.push({ ...source, from: offset, to: end })
      }
    }
    offset = end
  })
  return result
}
function mappedAtoms(atoms: readonly Atom[], step: Step, before: PMNode, after: PMNode, intent?: AtomIntent): Atom[] {
  const map = step.getMap(), edits = windows(map), result: Atom[] = []
  for (const atom of atoms) {
    if (intent && atom.pos === (step as ReplaceStep).from && atom.node === intent.before) {
      if (intent.step !== step || intent.doc !== before || indexFor(before).nodeAtStart(atom.pos) !== intent.before
        || indexFor(after).nodeAtStart(atom.pos) !== intent.after) invalid('原子身份 correspondence 不属于这次真实 step。')
      result.push({ ...atom, node: intent.after }); continue
    }
    if (edits.some(edit => edit.from < atom.pos + atom.node.nodeSize && atom.pos < edit.to)) continue
    const pos = map.map(atom.pos, 1), node = indexFor(after).nodeAtStart(pos)
    if (node !== atom.node) invalid('原子节点缺少实际保留 correspondence。')
    result.push({ ...atom, pos })
  }
  return result
}
function transferCarrier(raw: Map<object, RawRecord>, step: ReplaceAroundStep, before: PMNode, after: PMNode): void {
  const old = indexFor(before).nodeAtStart(step.from), next = indexFor(after).nodeAtStart(step.from)
  if (!old?.isTextblock || !next?.isTextblock || step.gapFrom !== step.from + 1
    || step.gapTo !== step.to - 1 || !old.content.eq(next.content)) return
  const oldCarrier = carrier(old), nextCarrier = carrier(next), record = oldCarrier && raw.get(oldCarrier)
  if (record && nextCarrier && next.attrs.block.content === record.content && next.attrs.originalInline === old.attrs.originalInline)
    raw.set(nextCarrier, record)
}
type Emission = { key: SyncedBindingKey; spans: readonly RichPmSpan[]; token: string | null; contributors: Piece[];
  source: Readonly<SyncedBindingKey> | null; lineage: object; origin: Origin | null; copyOnly: boolean; atom?: Atom }
function emit(key: SyncedBindingKey, spans: readonly RichPmSpan[], pieces: readonly Piece[], token?: string | null): Emission {
  const found = contributors(pieces, spans, token)
  const ordered = [...found].sort((a, b) => (a.role === 'reference' ? 1 : 0) - (b.role === 'reference' ? 1 : 0)
    || (a.origin?.rank ?? Number.MAX_SAFE_INTEGER) - (b.origin?.rank ?? Number.MAX_SAFE_INTEGER))
  const source = ordered[0]
  if (found.some(piece => piece.role === 'new') && found.some(piece => piece.role !== 'new')) invalid('新链接意图混合旧来源。')
  return { key, spans, token: token ?? source.token, contributors: found, source: source.source, lineage: source.lineage,
    origin: source.origin, copyOnly: found.every(piece => piece.role === 'reference') }
}
type RichBatch = {
  before: EditorState; transactions: readonly Transaction[]; after: EditorState
}
export type PreparedRichProvenance = { blocks: SyncedCanonicalEdit[]; bindingClaims: SyncedBindingClaim[]; nextState: RichProvenanceState; hasIntent: boolean }
type ProvenStep = { step: Step; before: PMNode; after: PMNode; newIntent?: NewIntent; atomIntent?: AtomIntent }

/** Existing actual-Transaction entry: private witnesses are read only here and
 * at observed capture. Both entries share the same lineage/final AST engine. */
function* actualSteps(batch: RichBatch, initial: PMNode): Generator<ProvenStep> {
  let doc = initial
  for (const transaction of batch.transactions) {
    if (transaction.before !== doc || transaction.docs.length !== transaction.steps.length
      || transaction.mapping.maps.length !== transaction.steps.length) invalid('富文本事务链不完整。')
    for (let index = 0; index < transaction.steps.length; index++) {
      const step = transaction.steps[index], before = transaction.docs[index], after = transaction.docs[index + 1] ?? transaction.doc
      if (before !== doc || !same(windows(step.getMap()), windows(transaction.mapping.maps[index]))) invalid('step map 不属于实际事务。')
      const applied = step.apply(before)
      if (!applied.doc || !applied.doc.eq(after)) invalid('step 的实际结果与事务不一致。')
      yield { step, before, after, newIntent: newIntents.get(transaction)?.get(index), atomIntent: atomIntents.get(transaction)?.get(index) }
      doc = after
    }
    if (doc !== transaction.doc) invalid('事务最终 doc 不一致。')
  }
  if (doc !== batch.after.doc) invalid('富文本最终状态不属于实际事务链。')
}
export function prepareSyncedRichProvenance(previous: RichProvenanceState, batch: RichBatch): PreparedRichProvenance {
  const saved = dataFor(previous)
  if (batch.before.doc !== saved.doc) invalid('富文本候选不属于当前工作来源世代。')
  return prepareProvenSteps(previous, actualSteps(batch, saved.doc), batch.after.doc, batch.transactions)
}

function prepareProvenSteps(previous: RichProvenanceState, evidence: Iterable<ProvenStep>, actualAfter: PMNode,
  transactions?: readonly Transaction[]): PreparedRichProvenance {
  const saved = dataFor(previous)
  let doc = saved.doc, pieces = saved.pieces.map(piece => ({ ...piece })), atoms = saved.atoms.map(atom => ({ ...atom })), rank = saved.rank
  const raw = new Map(saved.raw), tokens = new Set(saved.tokens)
  for (const item of evidence) {
      const { step, before, after } = item
      if (before !== doc) invalid('封闭 step 链不属于当前来源世代。')
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        if (step.mark.type.name === 'link') {
          if (step instanceof RemoveMarkStep) {
            // A manually constructed real RemoveMarkStep may cover marks that
            // are not eq(step.mark). PM retains those, and so must provenance.
            const removed: Array<{ from: number; to: number }> = []
            for (const { node, pos } of indexFor(before).inlineEntries(step.from, step.to)) {
              if (step.mark.isInSet(node.marks)) removed.push({ from: Math.max(step.from, pos), to: Math.min(step.to, pos + node.nodeSize) })
            }
            for (const range of removed) pieces = subtract(pieces, range.from, range.to)
          }
          else {
            const intent = item.newIntent
            if (intent) {
              if (intent.step !== step || tokens.has(intent.token)) invalid('新链接 token 不是本次实际新建。')
              tokens.add(intent.token); pieces = subtract(pieces, step.from, step.to)
              const lineage = Object.freeze({}), href = step.mark.attrs.href
              if (typeof href !== 'string') invalid('新链接没有实际 href。')
              for (const { node, pos } of indexFor(after).inlineEntries(step.from, step.to)) {
                const from = Math.max(step.from, pos), to = Math.min(step.to, pos + node.nodeSize)
                if (to > from && markFor(after, from, to, intent.token, href)) pieces.push({ from, to, token: intent.token,
                  href, lineage, source: null, origin: null, role: 'new' })
              }
            } else {
              const token = richLinkOccurrence(step.mark)
              if (token === null || !markFor(before, step.from, step.to, token, step.mark.attrs.href)) invalid('未声明的新 link mark 或失去来源的 token。')
              contributors(pieces, [{ from: step.from, to: step.to }], token)
            }
          }
        }
      } else if (step instanceof ReplaceAroundStep) {
        const gap = { from: step.gapFrom, to: step.gapTo }, delta = step.from + step.insert - step.gapFrom
        pieces = pieces.flatMap(piece => {
          const result = survivors(piece, step.getMap())
          // The real StepMap preserves the gap. Recheck its interior explicitly,
          // so deleting outer ranges cannot be mistaken for a kept fragment.
          for (const retained of result) if (piece.from < gap.to && gap.from < piece.to) {
            const from = Math.max(piece.from, gap.from), to = Math.min(piece.to, gap.to)
            if (retained.from <= from + delta && retained.to >= to + delta
              && (!markFor(after, from + delta, to + delta, piece.token, piece.href))) invalid('ReplaceAround 丢失真实 gap 链接。')
          }
          return result
        })
        atoms = mappedAtoms(atoms, step, before, after); transferCarrier(raw, step, before, after)
      } else if (step instanceof ReplaceStep) {
        if (step.from === 0 && step.to === before.content.size && step.slice.size) invalid('整页重建没有精确来源 correspondence。')
        const original = pieces
        pieces = pieces.flatMap(piece => survivors(piece, step.getMap()))
        const intent = item.atomIntent
        atoms = mappedAtoms(atoms, step, before, after, intent)
        if (!intent) pieces.push(...inheritInserted(original, step))
      } else invalid('此富文本 step 尚无严格来源支持，未生成来源声明。')
      for (const piece of pieces) if (!markFor(after, piece.from, piece.to, piece.token, piece.href)) invalid('step 改变链接 mark，来源不能自动延续。')
      doc = after
  }
  // Equality checks the result of a previously attested opaque chain. It never
  // turns an arbitrary same-body PM document into a source witness.
  if (doc !== actualAfter && (transactions !== undefined || !doc.eq(actualAfter))) invalid('富文本最终状态不属于实际事务链。')

  const blocks: SyncedCanonicalEdit[] = [], emissions: Emission[] = [], retainedReferences: Array<{ entryPos: number; reference: RawReference; pieces: Piece[] }> = []
  const liveAtomOrigins = new Set(atoms.flatMap(atom => atom.keys.map(item => item.origin)))
  const atomsAt = new Map(atoms.map(atom => [atom.pos, atom]))
  for (const { node, pos } of richBlockEntries(doc)) {
    if (!carrier(node)) invalid('候选缺少真实块属性；先运行实际身份 appendTransaction。')
    const block = structuredClone(node.attrs.block) as SyncedCanonicalEdit
    if (node.type.name === 'text_block') {
      const record = raw.get(carrier(node)!), inBlock = piecesIn(pieces, pos + 1, pos + node.nodeSize - 1)
      let keep = !!record && record.content === block.content && record.fingerprint === fingerprint(node)
        && !inBlock.some(piece => piece.role === 'new')
      if (keep && record) for (const reference of record.references) {
        const spans = reference.spans.map(span => ({ from: span.from + pos + 1, to: span.to + pos + 1 }))
        const found = contributors(pieces, spans), definition = saved.physical.get(reference.definition)
        if (!definition || !liveAtomOrigins.has(reference.definition) || found.some(piece => piece.lineage !== definition.lineage)) { keep = false; break }
      }
      if (keep && record) {
        for (const link of record.links) emissions.push(emit({ ...link.key, blockId: block.id },
          link.spans.map(span => ({ from: span.from + pos + 1, to: span.to + pos + 1 })), pieces))
        for (const reference of record.references) {
          const spans = reference.spans.map(span => ({ from: span.from + pos + 1, to: span.to + pos + 1 }))
          retainedReferences.push({ entryPos: pos, reference, pieces: spans.flatMap(span => contributors(pieces, [span]).map(piece => ({
            ...piece, from: Math.max(span.from, piece.from), to: Math.min(span.to, piece.to)
          }))) })
        }
      } else {
        const rendered = serializeRichTextInlineWithLinkTrace(node)
        block.content = rendered.content
        for (const destination of rendered.linkDestinations) {
          if (!local(saved.origin, destination.href)) continue
          emissions.push(emit({ blockId: block.id, from: destination.from, to: destination.to, raw: destination.raw, syntax: destination.syntax },
            destination.pmSpans.map(span => ({ from: span.from + pos + 1, to: span.to + pos + 1 })), pieces, destination.token))
        }
      }
    } else if (node.isLeaf) {
      const atom = atomsAt.get(pos)
      if (!atom || atom.node !== node) invalid('候选原子块没有保留或身份修复来源。')
      for (const item of atom.keys) emissions.push({ key: { ...item.key, blockId: block.id }, spans: [], token: null,
        contributors: [], source: item.key, lineage: item.lineage, origin: item.origin, copyOnly: false, atom })
    }
    blocks.push(block)
  }
  const checked = validateSyncedCanonicalEdit(blocks)
  const actualResult = transactions === undefined
    ? createRichActualKeyCache({ doc: actualAfter, blocks: checked, origin: saved.origin })
    : prepareRichActualKeys(saved.actualKeys, { before: saved.doc, transactions, after: doc, blocks: checked, origin: saved.origin })
  const actual = actualResult.keys
  const byDestination = new Map(emissions.map(item => [keyId(item.key), item]))
  if (byDestination.size !== emissions.length || actual.length !== emissions.length || actual.some(key => !byDestination.has(keyId(key))))
    invalid('来源未精确覆盖最终 forest 的全部实际目的地。')

  const continueOwners = new Map<string, Emission>()
  for (const emission of emissions) if (emission.source && !emission.copyOnly) {
    const key = keyId(emission.source), old = continueOwners.get(key)
    if (!old || emission.atom || !old.atom && Math.min(...emission.spans.map(span => span.from)) < Math.min(...old.spans.map(span => span.from)))
      continueOwners.set(key, emission)
  }
  const claims = validateSyncedBindingClaims(actual.map(key => {
    const emission = byDestination.get(keyId(key))!
    return !emission.source ? { kind: 'new', destination: key } : continueOwners.get(keyId(emission.source)) === emission
      ? { kind: 'continue', source: emission.source, destination: key }
      : { kind: 'copy', source: { kind: 'current', key: emission.source }, destination: key }
  }))
  const nextPhysical = new Map<Origin, Physical>(), nextPieces: Piece[] = [], nextAtoms = atoms.map(atom => ({ ...atom, keys: [] as Physical[] }))
  const nextAtomsAt = new Map(nextAtoms.map(atom => [atom.pos, atom]))
  for (const emission of emissions) {
    const isContinue = emission.source && continueOwners.get(keyId(emission.source)) === emission
    const origin = isContinue && emission.origin ? emission.origin : Object.freeze({ rank: rank++ })
    const value: Physical = { key: Object.freeze({ ...emission.key }), origin, lineage: emission.lineage }
    nextPhysical.set(origin, value)
    if (emission.atom) nextAtomsAt.get(emission.atom.pos)!.keys.push(value)
    else for (const span of emission.spans) nextPieces.push({ ...span, token: emission.token!, href: emission.contributors[0].href,
      source: value.key, origin, lineage: value.lineage, role: 'direct' })
  }
  for (const retained of retainedReferences) {
    const definition = nextPhysical.get(retained.reference.definition)
    if (!definition) invalid('引用定义未保留，不能静默复用旧 reference use。')
    for (const piece of retained.pieces) nextPieces.push({ ...piece, source: definition.key, origin: definition.origin, lineage: definition.lineage, role: 'reference' })
  }
  const adopted = transactions === undefined ? adoptObservedTail(doc, actualAfter, nextAtoms, raw) : { atoms: nextAtoms, raw }
  return { blocks: checked, bindingClaims: claims, hasIntent: claims.some(claim => claim.kind !== 'continue' || keyId(claim.source) !== keyId(claim.destination)),
    nextState: state(previous.generation, { doc: actualAfter, blocks: checked, origin: saved.origin, pieces: nextPieces, atoms: adopted.atoms, raw: adopted.raw,
      physical: nextPhysical, tokens, rank, actualKeys: actualResult.cache }) }
}

/** Reanchor only after replay and the actual tail have compared equal. Positions
 * are an inspected one-to-one tree correspondence, not block-ID/text matching. */
function adoptObservedTail(replayed: PMNode, actual: PMNode, atoms: readonly Atom[], raw: ReadonlyMap<object, RawRecord>): {
  atoms: Atom[]; raw: Map<object, RawRecord>
} {
  if (!replayed.eq(actual)) invalid('重放结果与实际 tail 不一致。')
  const left = richBlockEntries(replayed), right = richBlockEntries(actual), actualAt = new Map<number, PMNode>(), nextRaw = new Map<object, RawRecord>()
  if (left.length !== right.length) invalid('实际 tail 的块承载不一致。')
  for (let index = 0; index < left.length; index++) {
    const before = left[index], after = right[index]
    if (before.pos !== after.pos || !before.node.eq(after.node)) invalid('实际 tail 的块位置 correspondence 不一致。')
    actualAt.set(after.pos, after.node)
    const oldCarrier = carrier(before.node), nextCarrier = carrier(after.node), record = oldCarrier && raw.get(oldCarrier)
    if (record) {
      if (!nextCarrier || nextCarrier !== after.node.attrs.block) invalid('实际 tail 缺少 raw carrier。')
      nextRaw.set(nextCarrier, record)
    }
  }
  const nextAtoms = atoms.map(atom => {
    const node = actualAt.get(atom.pos)
    if (!node?.isLeaf || !node.eq(atom.node)) invalid('实际 tail 的原子承载不一致。')
    return { ...atom, node }
  })
  return { atoms: nextAtoms, raw: nextRaw }
}

/** Capture-only local identities. Public fields are diagnostics, never authority.
 * The first slice supports only forward edits to the session's latest tail. */
export interface RichObservedCapture { readonly id: string }
export interface RichObservedCursor { readonly id: string }
export interface ObservedRichDelta { readonly id: string }
export type RichObservedCaptureResult = Readonly<{ delta: ObservedRichDelta | null; cursor: RichObservedCursor;
  status: 'replayable' | 'quarantined-layout' }>
type CapturedNewIntent = Readonly<{ from: number; to: number; token: string }>
type CapturedAtomIntent = Readonly<{ before: PMNode }>
type CapturedStep = Readonly<{ payload: ClosedRichObservedStep; newIntent?: CapturedNewIntent; atomIntent?: CapturedAtomIntent }>
type CaptureSession = { base: RichProvenanceState; baseBoundary: object; tailBoundary: object; tailDoc: PMNode;
  tailCursor: RichObservedCursor; count: number; quarantined: boolean }
type CursorData = Readonly<{ session: CaptureSession; boundary: object; count: number }>
type DeltaData = Readonly<{ session: CaptureSession; from: object; to: object; count: number;
  steps: readonly CapturedStep[] | null }>
const observedCaptures = new WeakMap<RichObservedCapture, CaptureSession>()
const observedCursors = new WeakMap<RichObservedCursor, CursorData>()
const observedDeltas = new WeakMap<ObservedRichDelta, DeltaData>()
let observedSerial = 0
const observedIdentity = (kind: string) => Object.freeze({ id: `${kind}:${++observedSerial}` })
function dense<T>(value: readonly T[]): boolean {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
      .every(descriptor => !!descriptor && 'value' in descriptor)
}
function captureSession(capture: RichObservedCapture): CaptureSession {
  return observedCaptures.get(capture) ?? invalid('观察会话无效，未生成来源声明。')
}
export function beginObservedRichCapture(base: RichProvenanceState, actualBase: EditorState): Readonly<{
  capture: RichObservedCapture; cursor: RichObservedCursor
}> {
  const saved = dataFor(base)
  if (!(actualBase instanceof EditorState) || actualBase.doc !== saved.doc) invalid('观察会话必须从实际当前来源 doc 开始。')
  const capture = observedIdentity('rich-capture'), cursor = observedIdentity('rich-cursor'), boundary = Object.freeze({})
  const session: CaptureSession = { base, baseBoundary: boundary, tailBoundary: boundary, tailDoc: saved.doc,
    tailCursor: cursor, count: 0, quarantined: false }
  observedCaptures.set(capture, session); observedCursors.set(cursor, { session, boundary, count: 0 })
  return Object.freeze({ capture, cursor })
}

/** Call synchronously with the real dispatch result before releasing its
 * Transactions. Only closed owned payloads and the real private intent witnesses
 * survive. No Transaction, docs array, selection, or historical root is stored.
 * "replayable" describes the payload layout; final lineage/AST may still reject. */
export function captureObservedRichDelta(capture: RichObservedCapture, batch: RichBatch): RichObservedCaptureResult {
  const session = captureSession(capture)
  if (!(batch.before instanceof EditorState) || !(batch.after instanceof EditorState) || !dense(batch.transactions)
    || batch.before.doc !== session.tailDoc) invalid('观察事务不是本会话最新实际 tail。')
  let doc = session.tailDoc, stepCount = 0, quarantined = false
  const captured: CapturedStep[] = []
  for (const transaction of batch.transactions) {
    if (Object.getPrototypeOf(transaction) !== Transaction.prototype || !dense(transaction.steps) || !dense(transaction.docs)
      || !dense(transaction.mapping.maps) || transaction.before !== doc || transaction.docs.length !== transaction.steps.length
      || transaction.mapping.maps.length !== transaction.steps.length) invalid('观察事务链不完整。')
    for (let index = 0; index < transaction.steps.length; index++) {
      const original = transaction.steps[index], before = transaction.docs[index], after = transaction.docs[index + 1] ?? transaction.doc
      if (before !== doc) invalid('观察 step 的实际 before 不连续。')
      stepCount++
      const payload = captureRichObservedStep(original, before.type.schema), replayed = payload && replayRichObservedStep(payload, before)
      if (!payload || !replayed) quarantined = true
      else {
        if (!replayed.after.eq(after) || !same(windows(replayed.step.getMap()), windows(transaction.mapping.maps[index])))
          invalid('观察到的封闭 step 与实际结果/map 不一致。')
        // The existing lineage entry rejects whole-document rebuilding. Do not
        // retain its inserted whole-forest tree as a historical edge snapshot.
        if (replayed.step instanceof ReplaceStep && replayed.step.from === 0 && replayed.step.to === before.content.size && replayed.step.slice.size) {
          quarantined = true; doc = after; continue
        }
        const newWitness = newIntents.get(transaction)?.get(index), atomWitness = atomIntents.get(transaction)?.get(index)
        let newIntent: CapturedNewIntent | undefined, atomIntent: CapturedAtomIntent | undefined
        if (newWitness) {
          if (newWitness.step !== original || !(replayed.step instanceof AddMarkStep) || replayed.step.from !== newWitness.from
            || replayed.step.to !== newWitness.to || richLinkOccurrence(replayed.step.mark) !== newWitness.token)
            invalid('观察到的新链接意图不属于这次实际 step。')
          newIntent = Object.freeze({ from: newWitness.from, to: newWitness.to, token: newWitness.token })
        }
        if (atomWitness) {
          if (atomWitness.step !== original || atomWitness.doc !== before || !(replayed.step instanceof ReplaceStep)
            || indexFor(before).nodeAtStart(replayed.step.from) !== atomWitness.before
            || indexFor(after).nodeAtStart(replayed.step.from) !== atomWitness.after
            || !sameAtomBody(atomWitness.before, atomWitness.after)) invalid('观察到的原子意图不属于这次实际身份 step。')
          const copy = copyRichObservedLeaf(atomWitness.before, before.type.schema)
          if (!copy) quarantined = true
          else atomIntent = Object.freeze({ before: copy })
        }
        captured.push(Object.freeze({ payload, newIntent, atomIntent }))
      }
      doc = after
    }
    if (doc !== transaction.doc) invalid('观察事务最终 doc 不连续。')
  }
  if (doc !== batch.after.doc) invalid('观察结果不是实际 dispatch 的最终 doc。')
  // Commit the session transition only after the complete batch is inspected.
  if (!stepCount) return Object.freeze({ delta: null, cursor: session.tailCursor,
    status: session.quarantined ? 'quarantined-layout' : 'replayable' })
  const from = session.tailBoundary, to = Object.freeze({}), count = session.count + 1
  const delta = observedIdentity('rich-delta'), cursor = observedIdentity('rich-cursor')
  observedDeltas.set(delta, Object.freeze({ session, from, to, count,
    steps: quarantined ? null : Object.freeze(captured) }))
  observedCursors.set(cursor, Object.freeze({ session, boundary: to, count }))
  session.tailBoundary = to; session.tailDoc = doc; session.tailCursor = cursor; session.count = count
  session.quarantined ||= quarantined
  return Object.freeze({ delta, cursor, status: session.quarantined ? 'quarantined-layout' : 'replayable' })
}

function* observedSteps(session: CaptureSession, edges: readonly DeltaData[]): Generator<ProvenStep> {
  let doc = dataFor(session.base).doc
  for (const edge of edges) for (const captured of edge.steps!) {
    const replayed = replayRichObservedStep(captured.payload, doc) ?? invalid('封闭 step 不能严格重放，未生成来源声明。')
    const { step, after } = replayed
    let newIntent: NewIntent | undefined, atomIntent: AtomIntent | undefined
    if (captured.newIntent) {
      if (!(step instanceof AddMarkStep)) invalid('捕获的新链接意图布局不一致。')
      newIntent = { step, ...captured.newIntent }
    }
    if (captured.atomIntent) {
      if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd || step.slice.content.childCount !== 1)
        invalid('捕获的原子意图布局不一致。')
      const before = indexFor(doc).nodeAtStart(step.from), next = step.slice.content.firstChild!
      if (!before?.isLeaf || !before.eq(captured.atomIntent.before) || step.to !== step.from + before.nodeSize
        || !sameAtomBody(before, next) || indexFor(after).nodeAtStart(step.from) !== next)
        invalid('原子身份重放缺少闭合 correspondence。')
      // An internal transient witness of an already captured real registration.
      // It never enters/re-registers the public Transaction intent maps.
      atomIntent = { step, before, after: next, doc }
    }
    yield { step, before: doc, after, newIntent, atomIntent }
    doc = after
  }
}

/** Latest-tail only. No old-prefix, branch, private Undo/Redo, UI recovery or
 * clipboard receipt support is implied by this forward-path kernel. */
export function prepareObservedRichPath(previous: RichProvenanceState, input: {
  capture: RichObservedCapture; cursor: RichObservedCursor; activeDeltas: readonly ObservedRichDelta[]; actualAfter: EditorState
}): PreparedRichProvenance {
  const session = captureSession(input.capture), cursor = observedCursors.get(input.cursor)
  if (previous !== session.base || input.cursor !== session.tailCursor || !cursor || cursor.session !== session
    || cursor.boundary !== session.tailBoundary || cursor.count !== session.count || !dense(input.activeDeltas)
    || input.activeDeltas.length !== session.count || !(input.actualAfter instanceof EditorState)
    || input.actualAfter.doc !== session.tailDoc) invalid('观察路径不是本来源会话的完整最新实际 tail。')
  let boundary = session.baseBoundary
  const edges: DeltaData[] = []
  for (let index = 0; index < input.activeDeltas.length; index++) {
    const edge = observedDeltas.get(input.activeDeltas[index])
    if (!edge || edge.session !== session || edge.from !== boundary || edge.count !== index + 1 || !edge.steps)
      invalid('观察路径缺边、重排、跨会话或包含隔离 step，未生成来源声明。')
    edges.push(edge); boundary = edge.to
  }
  if (session.quarantined || boundary !== session.tailBoundary) invalid('观察路径含未知 step，未生成来源声明。')
  const result = prepareProvenSteps(previous, observedSteps(session, edges), session.tailDoc)
  // Also recheck after complete parser/serializer finalization. An authentic
  // shared type/schema mutation cannot be legitimized by equal output bytes.
  if (edges.some(edge => edge.steps!.some(step => !isRichObservedStepCurrent(step.payload, session.tailDoc.type.schema))))
    invalid('观察路径的实际 schema/type 已改变，未生成来源声明。')
  return result
}
