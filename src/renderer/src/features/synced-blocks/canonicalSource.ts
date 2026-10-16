import { normalizeCodeLanguage } from '@shared/code'
import { isNativeStructureBlockType } from '@shared/blockTypes'
import type { MarkdownBlockSourceRange, MarkdownSourceStrictResult, MarkdownSourceSyntaxBlock } from '@shared/markdown'
import { parseMarkdownSourceStrict } from '@shared/markdownSource'
import type { SyncedCanonicalEdit, SyncedStableBlockDraft } from '@shared/synced-blocks'
import { isSyncedBlockId, isSyncedUuid, SyncedValidationError, validateSyncedCanonicalEdit } from '@shared/syncedBlockValidation'
import { createMarkdownSourceDraft, type MarkdownSourceDraft, type MarkdownSourceDraftSerializer } from '../../utils/markdownSourceDraft'

type Anchor = MarkdownSourceDraft['anchors'][number]
type Span = { from: number; to: number }
export type MarkdownSourceReconcileOutput = { block: SyncedStableBlockDraft; parentIndex: number | null; range: Span }
type Output = MarkdownSourceReconcileOutput
export interface MarkdownSourceReconciliationPort {
  /** Cold caller owns this actual parser invocation; ordinary callers omit it. */
  parseCanonical?(source: string): MarkdownSourceStrictResult
  emitted(output: Readonly<Output>, fact: Readonly<{ kind: 'syntax' | 'retained' | 'ref'; syntaxFrom: number; syntaxTo: number;
    anchor: Anchor | undefined; referenceKey: string | null }>): void
  emptyRetained(output: Readonly<Output>, anchor: Anchor): void
  sorted(outputs: readonly Readonly<Output>[], syntaxOutputs: ReadonlyMap<number, Readonly<Output>>): void
  unchanged(draft: MarkdownSourceDraft, blocks: readonly SyncedCanonicalEdit[]): void
  emptyCreated(block: Readonly<SyncedStableBlockDraft>): void
}
export interface MarkdownSourceReconciliationOptions {
  freshId?: () => string
  references?: ReadonlyMap<string, SyncedStableBlockDraft>
  observation?: MarkdownSourceReconciliationPort
}

function invalid(message: string, code: 'forest' | 'identity' = 'forest'): never {
  throw new SyncedValidationError(code, message)
}

/** The source dialog and its edit transactions keep raw UTF-16 coordinates. */
function sourceSpans(source: string, ranges: readonly MarkdownBlockSourceRange[]): Span[] {
  const starts = [0]
  for (const match of source.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length)
  return ranges.map(range => {
    const from = (starts[range.startLine] ?? source.length) + (range.startLine === 0 && source.startsWith('\uFEFF') ? 1 : 0)
    let to = starts[range.endLine] ?? source.length
    if (source[to - 1] === '\n') to--
    if (source[to - 1] === '\r') to--
    return { from, to: Math.max(from, to) }
  })
}

const intersects = (left: Span, right: Span) => left.from < right.to && right.from < left.to
const coversPoint = (span: Span, point: number) => span.from < point && point < span.to
function lowerBound<T>(values: readonly T[], before: (value: T) => boolean): number {
  let low = 0, high = values.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (before(values[middle])) low = middle + 1
    else high = middle
  }
  return low
}

export function createCanonicalSourceDraft(blocks: readonly SyncedCanonicalEdit[], serializer?: MarkdownSourceDraftSerializer): MarkdownSourceDraft {
  return createMarkdownSourceDraft(validateSyncedCanonicalEdit(blocks), serializer)
}

/** Identity comes from surviving local edit anchors, never pasted metadata.
 * Syntax owns depth/parent positions; the final validator never repairs them. */
export function reconcileMarkdownSourceDraft(draft: MarkdownSourceDraft, parsed: MarkdownSourceStrictResult, options: MarkdownSourceReconciliationOptions = {}): SyncedStableBlockDraft[] {
  if (typeof draft.source !== 'string' || typeof draft.initialSource !== 'string' || !Array.isArray(draft.anchors)) invalid('Invalid canonical source draft.')
  const openingById = new Map<string, SyncedStableBlockDraft>()
  for (const raw of draft.initialBlocks) {
    const { id, parentBlockId, ...block } = raw
    if (!isSyncedBlockId(id) || openingById.has(id) || parentBlockId !== null && !isSyncedBlockId(parentBlockId))
      invalid('Invalid opening source identity.', 'identity')
    openingById.set(id, { ...block, id, parentBlockId })
  }
  const originalBlocks = new Set(draft.initialBlocks)
  const anchors = Array.from(draft.anchors, anchor => {
    if (!anchor || !originalBlocks.has(anchor.block) || typeof anchor.block.id !== 'string' || !openingById.has(anchor.block.id)
      || !Number.isSafeInteger(anchor.from) || !Number.isSafeInteger(anchor.to) || anchor.from < 0 || anchor.to < anchor.from
      || anchor.to > draft.source.length || typeof anchor.original !== 'string') invalid('Invalid canonical source identity anchor.')
    return anchor
  }).sort((left, right) => left.from - right.from || left.to - right.to)
  const ranges = sourceSpans(draft.source, parsed.sourceRanges)
  const closers = sourceSpans(draft.source, parsed.closingRanges)
  const used = new Set<string>(), reserved = new Set(openingById.keys())
  for (const reference of options.references?.values() ?? []) {
    if (!isSyncedBlockId(reference.id) || reference.type !== 'synced-block') invalid('Invalid source reference identity.', 'identity')
    reserved.add(reference.id)
  }
  const outputs: Output[] = [], syntaxOutputs = new Map<number, Output>()
  const nextId = () => {
    const id = (options.freshId ?? (() => crypto.randomUUID()))()
    if (!isSyncedUuid(id) || reserved.has(id)) invalid('A new canonical block identity must be fresh.', 'identity')
    reserved.add(id)
    return id
  }
  const oldBlock = (anchor: Anchor) => openingById.get(anchor.block.id!)!
  const claim = (anchor: Anchor | undefined) => {
    if (!anchor) return undefined
    const block = oldBlock(anchor)
    if (block.type === 'synced-block' || used.has(block.id)) return undefined
    used.add(block.id)
    return block
  }
  const byStart = new Map(ranges.map((range, index) => [range.from, index]))
  const byEnd = new Map(ranges.map((range, index) => [range.to, index]))
  const orderedClosers = [...closers].sort((left, right) => left.from - right.from)
  const precedingEnd: number[] = []
  let maximumEnd = -1
  for (const anchor of anchors) { precedingEnd.push(maximumEnd); maximumEnd = Math.max(maximumEnd, anchor.to) }
  const refPrefix = [0]
  for (const block of parsed.blocks) refPrefix.push(refPrefix.at(-1)! + (block.refKey === null ? 0 : 1))
  const retained = new Map<number, { anchor: Anchor; last: number }>()
  for (let at = 0; at < anchors.length; at++) {
    const anchor = anchors[at]
    if (oldBlock(anchor).type === 'synced-block' || anchor.from === anchor.to || draft.source.slice(anchor.from, anchor.to) !== anchor.original) continue
    const first = byStart.get(anchor.from), last = byEnd.get(anchor.to)
    if (first === undefined || last === undefined || last < first || retained.has(first)) continue
    // A native closing shell belongs to its owner, not a preceding paragraph.
    // An untouched grouping must not swallow another surviving editable block.
    const close = orderedClosers[lowerBound(orderedClosers, range => range.to <= anchor.from)]
    if (close && intersects(close, anchor) || precedingEnd[at] > anchor.from
      || at + 1 < anchors.length && anchors[at + 1].from < anchor.to || refPrefix[last + 1] !== refPrefix[first]) continue
    retained.set(first, { anchor, last })
  }

  const annotated = (syntax: MarkdownSourceSyntaxBlock, previous: SyncedStableBlockDraft | undefined): SyncedStableBlockDraft => {
    const info = syntax.markdownFormat?.codeInfo ?? syntax.language ?? ''
    const oldInfo = previous?.markdownFormat?.codeInfo ?? previous?.language ?? ''
    const language = syntax.type === 'code' ? previous?.type === 'code' && info === oldInfo ? previous.language
      : normalizeCodeLanguage(info.split(/\s+/, 1)[0]) ?? undefined : undefined
    const markdownFormat = syntax.type === 'toggle' && previous?.type === 'toggle'
      && (syntax.markdownFormat?.toggleDefaultOpen ?? true) === (previous.markdownFormat?.toggleDefaultOpen ?? true)
      ? previous.markdownFormat : syntax.markdownFormat
    return { id: previous?.id ?? nextId(), type: syntax.type, content: syntax.content, checked: syntax.checked ?? false,
      depth: syntax.depth, parentBlockId: null,
      ...(previous?.tags === undefined ? {} : { tags: [...previous.tags] }),
      ...(previous?.highlight === undefined ? {} : { highlight: previous.highlight }),
      ...(language === undefined ? {} : { language }),
      ...(syntax.listStart === undefined ? {} : { listStart: syntax.listStart }),
      ...(markdownFormat === undefined ? {} : { markdownFormat: { ...markdownFormat } }) }
  }
  let anchorCursor = 0
  for (let index = 0; index < parsed.blocks.length; index++) {
    const syntax = parsed.blocks[index], retainedBlock = retained.get(index)
    let output: Output
    let last = index
    let kind: 'syntax' | 'retained' | 'ref' = 'syntax'
    let claimedAnchor: Anchor | undefined
    if (syntax.refKey !== null) {
      const reference = options.references?.get(syntax.refKey)
      if (!reference || syntax.type !== 'synced-block' || reference.content !== syntax.content || used.has(reference.id))
        invalid('A source reference is missing, repeated or changed.', 'identity')
      used.add(reference.id)
      output = { block: { ...reference, depth: syntax.depth, parentBlockId: null }, parentIndex: syntax.parentIndex, range: ranges[index] }
      kind = 'ref'
    } else if (retainedBlock && !used.has(oldBlock(retainedBlock.anchor).id)) {
      const previous = claim(retainedBlock.anchor)!
      last = retainedBlock.last
      output = { block: { ...previous, depth: syntax.depth, parentBlockId: null }, parentIndex: syntax.parentIndex,
        range: { from: ranges[index].from, to: ranges[last].to } }
      kind = 'retained'; claimedAnchor = retainedBlock.anchor
    } else {
      while (anchorCursor < anchors.length && anchors[anchorCursor].to <= ranges[index].from) anchorCursor++
      let anchor: Anchor | undefined
      for (let cursor = anchorCursor; cursor < anchors.length && anchors[cursor].from < ranges[index].to; cursor++) {
        const candidate = anchors[cursor], block = oldBlock(candidate)
        if (block.type !== 'synced-block' && !used.has(block.id) && intersects(candidate, ranges[index])) { anchor = candidate; break }
      }
      const previous = claim(anchor)
      output = { block: annotated(syntax, previous), parentIndex: syntax.parentIndex, range: ranges[index] }
      claimedAnchor = previous ? anchor : undefined
    }
    outputs.push(output)
    options.observation?.emitted(output, { kind, syntaxFrom: index, syntaxTo: last, anchor: claimedAnchor, referenceKey: syntax.refKey })
    for (let child = index; child <= last; child++) syntaxOutputs.set(child, output)
    index = last
  }

  // Empty paragraphs have no parser token. Preserve an existing one only when
  // its blank separators survive, and derive its scope from the current shells.
  const obstacles = [...ranges, ...closers].sort((left, right) => left.from - right.from || left.to - right.to)
  const obstaclesByEnd = [...obstacles].sort((left, right) => left.to - right.to)
  const scopes = parsed.closingRanges.map((close, index) => ({ index: close.index, close: closers[index] }))
    .filter(value => isNativeStructureBlockType(parsed.blocks[value.index].type))
    .sort((left, right) => ranges[left.index].to - ranges[right.index].to)
  const scopeByIndex = new Map(scopes.map(scope => [scope.index, scope]))
  for (const anchor of anchors) {
    if (anchor.from !== anchor.to || used.has(oldBlock(anchor).id) || oldBlock(anchor).type !== 'paragraph'
      || oldBlock(anchor).content !== '') continue
    const point = anchor.from
    const nextObstacle = obstaclesByEnd[lowerBound(obstaclesByEnd, range => range.to <= point)]
    if (nextObstacle && coversPoint(nextObstacle, point)) continue
    const before = obstaclesByEnd[lowerBound(obstaclesByEnd, range => range.to <= point) - 1]
    const after = obstacles[lowerBound(obstacles, range => range.from < point)]
    if (before && point - before.to < 2 || after && after.from - point < 2) continue
    let owner: (typeof scopes)[number] | undefined = scopes[lowerBound(scopes, scope => ranges[scope.index].to <= point) - 1]
    while (owner && point >= owner.close.from) {
      let parentIndex: number | null = parsed.blocks[owner.index].parentIndex
      while (parentIndex !== null && !scopeByIndex.has(parentIndex)) parentIndex = parsed.blocks[parentIndex].parentIndex
      owner = parentIndex === null ? undefined : scopeByIndex.get(parentIndex)
    }
    const previous = claim(anchor)!
    const output = { block: { ...previous, depth: owner ? parsed.blocks[owner.index].depth + 1 : 0, parentBlockId: null },
      parentIndex: owner?.index ?? null, range: { from: point, to: point } }
    outputs.push(output)
    options.observation?.emptyRetained(output, anchor)
  }
  outputs.sort((left, right) => left.range.from - right.range.from || left.range.to - right.range.to)
  for (const output of outputs) {
    const parent = output.parentIndex === null ? null : syntaxOutputs.get(output.parentIndex)
    if (output.parentIndex !== null && (!parent || parent === output)) invalid('A canonical source parent was removed by grouping.')
    output.block.parentBlockId = parent?.block.id ?? null
  }
  options.observation?.sorted(outputs, syntaxOutputs)
  return outputs.map(output => output.block)
}

export function canonicalSourceDraftToBlocks(draft: MarkdownSourceDraft, freshId: () => string = () => crypto.randomUUID(),
  observation?: MarkdownSourceReconciliationPort): SyncedCanonicalEdit[] {
  const opening = validateSyncedCanonicalEdit(draft.initialBlocks)
  if (draft.source === draft.initialSource && draft.anchors.length === draft.initialBlocks.length
    && draft.anchors.every((anchor, index) => anchor.block === draft.initialBlocks[index])) {
    observation?.unchanged(draft, opening)
    return opening
  }
  const syntax = observation?.parseCanonical ? observation.parseCanonical(draft.source) : parseMarkdownSourceStrict(draft.source, { mode: 'canonical' })
  const blocks = reconcileMarkdownSourceDraft(draft, syntax, { freshId, observation })
  // Explicit front-end handling for deleting the entire group. No persistence
  // normalizer or empty-column rule invents this real replacement paragraph.
  if (!blocks.length) {
    const id = freshId()
    if (!isSyncedUuid(id) || opening.some(block => block.id === id)) invalid('A replacement paragraph identity must be fresh.', 'identity')
    const replacement = { id, type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null }
    blocks.push(replacement)
    observation?.emptyCreated(replacement)
  }
  return validateSyncedCanonicalEdit(blocks)
}
