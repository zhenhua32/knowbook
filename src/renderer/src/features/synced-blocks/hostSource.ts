import type { SyncedHostWorkingBefore, SyncedReferenceIdentity, SyncedStableBlockDraft, SyncedStructureInput, SyncedStructureApplied } from '@shared/synced-blocks'
import { parseMarkdownSourceStrict, serializeMarkdownHostSource } from '@shared/markdownSource'
import { assertSyncedShape, isSyncedBlockId, parseSyncedBlockPayload, serializeSyncedBlockPayload, SyncedValidationError,
  validateSyncedHostForest } from '@shared/syncedBlockValidation'
import { replaceMarkdownSourceChanges, type MarkdownSourceChange, type MarkdownSourceDraft } from '../../utils/markdownSourceDraft'
import { reconcileMarkdownSourceDraft, type MarkdownSourceReconciliationPort } from './canonicalSource'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { applySyncedSourceChanges, copySyncedSourceRange, createSyncedSourceSnapshot, insertSyncedSourceReference,
  moveSyncedSourceRange, type SyncedSourceIdFactory, type SyncedSourceRangeOperation, type SyncedSourceSnapshot } from './sourceAnchors'

export type SyncedHostSourceDraft = Readonly<{
  source: string
  opening: SyncedHostWorkingBefore
  ordinary: MarkdownSourceDraft
  references: SyncedSourceSnapshot
  initialOrdinary: MarkdownSourceDraft
  initialReferences: SyncedSourceSnapshot
}>
type HostFinal = Extract<SyncedStructureInput, { mode: 'host-final' }>
export type PreparedSyncedHostSource = Pick<HostFinal, 'hostsWorkingBefore' | 'finalAfter' | 'newRefSources'>
const owned = new WeakSet<object>()
type TrackedChange = { previous: SyncedHostSourceDraft; changes: readonly MarkdownSourceChange[] }
// Only a captured in-flight submission starts tracking. Ordinary cold draft
// editing does not retain an unbounded parent chain for every prior keystroke.
const trackedChanges = new WeakMap<SyncedHostSourceDraft, TrackedChange | null>()
const freshUuid = () => crypto.randomUUID()
function invalid(message: string): never { throw new SyncedValidationError('forest', message) }

function sealOrdinary(draft: MarkdownSourceDraft): MarkdownSourceDraft {
  for (const anchor of draft.anchors) Object.freeze(anchor)
  Object.freeze(draft.anchors)
  return Object.freeze(draft)
}
function seal(draft: SyncedHostSourceDraft): SyncedHostSourceDraft {
  if (draft.source !== draft.ordinary.source || draft.source !== draft.references.source) invalid('Source draft coordinates diverged.')
  const result = Object.freeze(draft)
  owned.add(result)
  return result
}
function current(draft: SyncedHostSourceDraft): void {
  if (!owned.has(draft)) invalid('Source draft does not belong to this opening session.')
}
function assertNewReferenceIdentities(draft: SyncedHostSourceDraft, references: SyncedSourceSnapshot): void {
  const openingIds = new Set(draft.opening.workingBefore.blocks.map(block => block.id))
  if (references.anchors.some(anchor => anchor.newRefSource !== null && openingIds.has(anchor.instanceId))) {
    throw new SyncedValidationError('identity', 'A new source reference cannot reuse any opening block identity.')
  }
}
function sourceSpans(source: string, ranges: readonly { index: number; startLine: number; endLine: number }[]) {
  const starts = [0]
  for (const match of source.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length)
  return ranges.map(range => {
    const from = starts[range.startLine] ?? source.length
    let to = starts[range.endLine] ?? source.length
    if (source[to - 1] === '\n') to--
    if (source[to - 1] === '\r') to--
    return { ...range, from, to: Math.max(from, to) }
  })
}

/** Capture the complete pre-action W. This is a renderer draft, not proof of
 * current persistence/guards. The structure coordinator must check its host
 * session/edit sequence and attach real P/group/instance guards before IPC. */
export function createSyncedHostSourceDraft(input: SyncedHostWorkingBefore,
  options: { sessionKey?: string; freshKey?: SyncedSourceIdFactory } = {}): SyncedHostSourceDraft {
  assertSyncedShape(input, ['documentId', 'expectedPersistedUpdatedAt', 'workingBefore'])
  assertSyncedShape(input.workingBefore, ['title', 'summary', 'blocks'])
  if (!isSyncedBlockId(input.documentId) || typeof input.expectedPersistedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(input.expectedPersistedUpdatedAt)) || typeof input.workingBefore.title !== 'string'
    || typeof input.workingBefore.summary !== 'string') invalid('Invalid full host Source opening.')
  const blocks = validateSyncedHostForest(input.workingBefore.blocks)
  for (const block of blocks) {
    if (block.tags) Object.freeze(block.tags)
    if (block.markdownFormat) Object.freeze(block.markdownFormat)
    Object.freeze(block)
  }
  Object.freeze(blocks)
  const opening = Object.freeze({ documentId: input.documentId, expectedPersistedUpdatedAt: input.expectedPersistedUpdatedAt,
    workingBefore: Object.freeze({ title: input.workingBefore.title, summary: input.workingBefore.summary, blocks }) })
  const encoded = serializeMarkdownHostSource(blocks)
  const spans = sourceSpans(encoded.markdown, encoded.ranges)
  if (spans.length !== blocks.length || new Set(spans.map(span => span.index)).size !== blocks.length) invalid('Source serializer omitted a host block.')
  const ordinary = sealOrdinary({ source: encoded.markdown, initialSource: encoded.markdown, initialBlocks: blocks,
    anchors: spans.flatMap(span => {
      const block = blocks[span.index]
      if (!block) return invalid('Source serializer returned an unknown host block.')
      return block.type === 'synced-block' ? [] : [{ block, from: span.from, to: span.to, original: encoded.markdown.slice(span.from, span.to) }]
    }) })
  const key = options.freshKey ?? freshUuid
  const references = createSyncedSourceSnapshot({ sessionKey: options.sessionKey ?? freshUuid(), sourceDocumentId: opening.documentId,
    source: encoded.markdown, anchors: encoded.references.map(ref => {
      const block = blocks[ref.index]
      if (block?.type !== 'synced-block') return invalid('Source reference is not an actual host atom.')
      return { key: key(), instanceId: block.id, groupId: parseSyncedBlockPayload(block.content).groupId,
        from: ref.from, to: ref.to, newRefSource: null }
    }) })
  return seal({ source: encoded.markdown, opening, ordinary, references, initialOrdinary: ordinary, initialReferences: references })
}

export function applySyncedHostSourceChanges(draft: SyncedHostSourceDraft,
  changes: readonly MarkdownSourceChange[]): SyncedHostSourceDraft {
  current(draft)
  const references = applySyncedSourceChanges(draft.references, changes)
  const ordinary = sealOrdinary(replaceMarkdownSourceChanges(draft.ordinary, [...changes]))
  if (references === draft.references && ordinary === draft.ordinary) return draft
  const next = seal({ ...draft, source: references.source, ordinary, references })
  if (trackedChanges.has(draft)) trackedChanges.set(next, { previous: draft,
    changes: Object.freeze(changes.map(change => Object.freeze({ ...change }))) })
  return next
}

/** An explicit move carries complete ordinary anchors and reference provenance.
 * Partial ordinary selections keep the usual source replacement semantics. */
export function moveSyncedHostSourceRange(draft: SyncedHostSourceDraft, operation: SyncedSourceRangeOperation): SyncedHostSourceDraft {
  current(draft)
  const references = moveSyncedSourceRange(draft.references, operation)
  if (references === draft.references) return draft
  const selected = draft.ordinary.anchors.filter(anchor => operation.from <= anchor.from && anchor.to <= operation.to
    && (anchor.from !== anchor.to || anchor.from < operation.to))
  const movedBlocks = new Set(selected.map(anchor => anchor.block))
  const selectedText = draft.source.slice(operation.from, operation.to)
  const emptyOnlyMove = selected.length > 0 && selected.every(anchor => anchor.from === anchor.to) && /^\s*$/.test(selectedText)
  // Inserting a complete moved block into an empty paragraph consumes that
  // destination slot. Its generic text anchor must not claim the moved ID.
  const targetEmptyAnchors = selected.length ? draft.ordinary.anchors.filter(anchor => anchor.from === anchor.to
    && anchor.from === operation.insertAt && !movedBlocks.has(anchor.block)) : []
  const occupiedEmptySlots = new Set(targetEmptyAnchors.map(anchor => anchor.block))
  const edited = replaceMarkdownSourceChanges(draft.ordinary, [
    { from: operation.from, to: operation.to, insert: '' },
    { from: operation.insertAt, to: operation.insertAt, insert: selectedText }
  ])
  const at = operation.insertAt < operation.from ? operation.insertAt : operation.insertAt - (operation.to - operation.from)
  const anchors = [...edited.anchors.filter(anchor => !movedBlocks.has(anchor.block) && !occupiedEmptySlots.has(anchor.block)),
    ...selected.map(anchor => ({ ...anchor, from: at + anchor.from - operation.from, to: at + anchor.to - operation.from })),
    // Moving an empty slot's separators does not fill a different empty slot.
    ...(emptyOnlyMove ? targetEmptyAnchors.map(anchor => ({ ...anchor, from: at + selectedText.length, to: at + selectedText.length })) : [])]
    .sort((left, right) => left.from - right.from || left.to - right.to)
  const ordinary = sealOrdinary({ ...edited, anchors })
  return seal({ ...draft, source: references.source, ordinary, references })
}
export function copySyncedHostSourceRange(draft: SyncedHostSourceDraft, operation: SyncedSourceRangeOperation,
  freshId?: SyncedSourceIdFactory): SyncedHostSourceDraft {
  current(draft)
  const references = copySyncedSourceRange(draft.references, operation, freshId)
  assertNewReferenceIdentities(draft, references)
  const copiedText = draft.source.slice(operation.from, operation.to)
  const edited = replaceMarkdownSourceChanges(draft.ordinary, [{ from: operation.insertAt, to: operation.insertAt, insert: copiedText }])
  // Generic typing fills an empty paragraph using its old identity. An explicit
  // copy instead creates independent content and must not borrow that identity
  // or its annotations from the destination's expanded zero-length anchor.
  const filledEmptySlots = new Set(copiedText.trim() ? draft.ordinary.anchors.filter(anchor => anchor.from === anchor.to
    && anchor.from === operation.insertAt).map(anchor => anchor.block) : [])
  const ordinary = sealOrdinary({ ...edited, anchors: edited.anchors.filter(anchor => !filledEmptySlots.has(anchor.block)) })
  return seal({ ...draft, source: references.source, ordinary, references })
}
export function insertSyncedHostSourceReference(draft: SyncedHostSourceDraft,
  insertion: Readonly<{ at: number; identity: SyncedReferenceIdentity }>, freshId?: SyncedSourceIdFactory): SyncedHostSourceDraft {
  current(draft)
  const references = insertSyncedSourceReference(draft.references, insertion, freshId)
  assertNewReferenceIdentities(draft, references)
  const length = references.source.length - draft.source.length
  const ordinary = sealOrdinary(replaceMarkdownSourceChanges(draft.ordinary, [{ from: insertion.at, to: insertion.at,
    insert: references.source.slice(insertion.at, insertion.at + length) }]))
  return seal({ ...draft, source: references.source, ordinary, references })
}

/** Prepare exactly the existing host-final fields; this neither calls IPC nor
 * flushes/checkpoints a group. Main still proves the full candidate graph and
 * every working/internal source, including workspace and creation identity. */
export function prepareSyncedHostSourceApply(draft: SyncedHostSourceDraft,
  freshId?: SyncedSourceIdFactory): PreparedSyncedHostSource {
  return prepareHostSource(draft, freshId)
}
function prepareHostSource(draft: SyncedHostSourceDraft,
  freshId?: SyncedSourceIdFactory, observation?: MarkdownSourceReconciliationPort): PreparedSyncedHostSource {
  current(draft)
  let blocks: SyncedStableBlockDraft[]
  if (draft.ordinary === draft.initialOrdinary && draft.references === draft.initialReferences) {
    blocks = structuredClone(draft.opening.workingBefore.blocks)
  } else {
    const parsed = parseMarkdownSourceStrict(draft.source, { mode: 'internal-host', references: draft.references.anchors.map(anchor => ({
      key: anchor.key, from: anchor.from, to: anchor.to, payload: serializeSyncedBlockPayload({ version: 1, groupId: anchor.groupId })
    })) })
    const initial = new Map(draft.opening.workingBefore.blocks.map(block => [block.id, block]))
    const references = new Map<string, SyncedStableBlockDraft>()
    for (const anchor of draft.references.anchors) {
      const source = anchor.newRefSource?.kind === 'working' && anchor.newRefSource.sourceDocumentId === draft.opening.documentId
        ? initial.get(anchor.newRefSource.sourceInstanceId) : initial.get(anchor.instanceId)
      const original = source?.type === 'synced-block' && parseSyncedBlockPayload(source.content).groupId === anchor.groupId ? source : undefined
      references.set(anchor.key, { ...original, id: anchor.instanceId, type: 'synced-block', checked: false, depth: 0, parentBlockId: null,
        content: serializeSyncedBlockPayload({ version: 1, groupId: anchor.groupId }) })
    }
    blocks = validateSyncedHostForest(reconcileMarkdownSourceDraft(draft.ordinary, parsed, { freshId, references, ...(observation ? { observation } : {}) }))
  }
  return { hostsWorkingBefore: [structuredClone(draft.opening)], finalAfter: [{ documentId: draft.opening.documentId,
    title: draft.opening.workingBefore.title, summary: draft.opening.workingBefore.summary, blocks }],
  newRefSources: draft.references.anchors.flatMap(anchor => anchor.newRefSource === null ? [] : [structuredClone(anchor.newRefSource)]) }
}

export interface SyncedHostSourceSubmission { readonly kind: 'captured-host-source-submission' }
export interface SyncedHostSourceCheckpoint { readonly kind: 'accepted-host-source-checkpoint' }
export interface SyncedHostSourceApplyOutcome { accepted: boolean; checkpoint?: SyncedHostSourceCheckpoint }
type Captured = { draft: SyncedHostSourceDraft; prepared: PreparedSyncedHostSource; ranges: ReadonlyMap<string, { from: number; to: number }> }
type Accepted = { baseDraft: SyncedHostSourceDraft; next: SyncedHostSourceCurrent;
  rebase: (draft: SyncedHostSourceDraft) => SyncedHostSourceDraft | null }
const submissions = new WeakMap<SyncedHostSourceSubmission, Captured>()
const capturedDrafts = new WeakMap<SyncedHostSourceDraft, SyncedHostSourceSubmission>()
const checkpoints = new WeakMap<SyncedHostSourceCheckpoint, Accepted>()
const equalContent = (left: SyncedHostWorkingBefore['workingBefore'], right: SyncedHostWorkingBefore['workingBefore']) =>
  left.title === right.title && left.summary === right.summary && areDocumentDraftBlocksEqual(left.blocks, right.blocks)
function freezeValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freezeValue(item); Object.freeze(value) }
  return value
}

/** A new, explicit cold capture. Old prepare callers retain their allocation,
 * fields and behavior. This handle owns this exact parse/allocation/range set. */
export function captureSyncedHostSourceSubmission(draft: SyncedHostSourceDraft): SyncedHostSourceSubmission {
  current(draft)
  const previous = capturedDrafts.get(draft)
  if (previous) return previous
  const ranges = new Map<string, { from: number; to: number }>()
  const observation: MarkdownSourceReconciliationPort = {
    emitted: () => {}, emptyRetained: () => {}, unchanged: () => {}, emptyCreated: () => {},
    sorted(outputs) { for (const output of outputs) if (output.block.type !== 'synced-block') {
      if (ranges.has(output.block.id)) invalid('The submitted source emitted a duplicate identity.')
      ranges.set(output.block.id, Object.freeze({ ...output.range }))
    } }
  }
  const prepared = freezeValue(prepareHostSource(draft, undefined, observation))
  if (draft.ordinary === draft.initialOrdinary && draft.references === draft.initialReferences) {
    for (const anchor of draft.ordinary.anchors) ranges.set(anchor.block.id!, Object.freeze({ from: anchor.from, to: anchor.to }))
  }
  const ordinary = prepared.finalAfter[0].blocks.filter(block => block.type !== 'synced-block')
  if (ranges.size !== ordinary.length || ordinary.some(block => !ranges.has(block.id))) invalid('The actual submitted parse did not close its ordinary source ranges.')
  const handle = Object.freeze({ kind: 'captured-host-source-submission' as const })
  submissions.set(handle, { draft, prepared, ranges }); capturedDrafts.set(draft, handle)
  if (!trackedChanges.has(draft)) trackedChanges.set(draft, null)
  return handle
}
export function readSyncedHostSourceSubmission(handle: SyncedHostSourceSubmission): PreparedSyncedHostSource {
  const captured = submissions.get(handle)
  if (!captured) invalid('This Source submission is not an original captured handle.')
  return captured.prepared
}

/** Called by the runtime only after its actual original Main ACK was adopted.
 * It adds no Main permission: future writes still use the same opaque fence. */
export function acceptSyncedHostSourceCheckpoint(handle: SyncedHostSourceSubmission, input: SyncedStructureInput,
  result: SyncedStructureApplied, before: SyncedHostSourceCurrent, next: SyncedHostSourceCurrent): SyncedHostSourceCheckpoint {
  const captured = submissions.get(handle), row = result.hosts[0]
  if (!captured || input.mode !== 'host-final' || input.reason !== 'source-apply' || result.operationId !== input.clientOperationId
    || result.hosts.length !== 1 || !row || row.documentId !== before.host.documentId || row.after.id !== before.host.documentId
    || captured.prepared.hostsWorkingBefore.length !== 1 || captured.prepared.finalAfter.length !== 1
    || input.hostsWorkingBefore.length !== 1 || input.finalAfter.length !== 1
    || JSON.stringify(input.hostsWorkingBefore) !== JSON.stringify(captured.prepared.hostsWorkingBefore)
    || JSON.stringify(input.finalAfter) !== JSON.stringify(captured.prepared.finalAfter)
    || JSON.stringify(input.newRefSources) !== JSON.stringify(captured.prepared.newRefSources)
    || before.host.documentId !== captured.draft.opening.documentId
    || before.host.expectedPersistedUpdatedAt !== captured.draft.opening.expectedPersistedUpdatedAt
    || !equalContent(before.host.workingBefore, captured.draft.opening.workingBefore)
    || !equalContent(row.logicalBefore, before.host.workingBefore)
    || next.hostSession !== before.hostSession || !Number.isSafeInteger(next.editSequence) || next.editSequence < 0
    || next.host.documentId !== row.after.id || next.host.expectedPersistedUpdatedAt !== row.after.updatedAt) invalid('The actual original Source acknowledgement does not close this submitted opening.')
  const blocks = validateSyncedHostForest(row.after.blocks.map(({ sortOrder: _sort, ...block }) => block))
  const after = { title: row.after.title, summary: row.after.summary, blocks }
  if (!equalContent(after, captured.prepared.finalAfter[0]) || !equalContent(after, next.host.workingBefore)) invalid('The Source checkpoint cannot adopt a latest or different body.')
  const opening = freezeValue({ documentId: row.after.id, expectedPersistedUpdatedAt: row.after.updatedAt, workingBefore: after })
  const byId = new Map(blocks.map(block => [block.id, block]))
  const ordinary = sealOrdinary({ source: captured.draft.source, initialSource: captured.draft.source, initialBlocks: blocks,
    anchors: blocks.flatMap(block => {
      if (block.type === 'synced-block') return []
      const range = captured.ranges.get(block.id)
      if (!range || range.from < 0 || range.to < range.from || range.to > captured.draft.source.length) invalid('The original accepted source range is unavailable.')
      return [{ block, ...range, original: captured.draft.source.slice(range.from, range.to) }]
    }).sort((left, right) => left.from - right.from || left.to - right.to) })
  const anchors = captured.draft.references.anchors.map(anchor => {
    const block = byId.get(anchor.instanceId)
    if (!block || block.type !== 'synced-block' || parseSyncedBlockPayload(block.content).groupId !== anchor.groupId) invalid('The accepted reference is not the actual submitted instance.')
    return { key: anchor.key, instanceId: anchor.instanceId, groupId: anchor.groupId, from: anchor.from, to: anchor.to, newRefSource: null }
  })
  if (anchors.length !== blocks.filter(block => block.type === 'synced-block').length) invalid('The accepted reference source set is incomplete.')
  const references = createSyncedSourceSnapshot({ sessionKey: freshUuid(), sourceDocumentId: opening.documentId, source: captured.draft.source, anchors })
  const baseDraft = seal({ source: captured.draft.source, opening, ordinary, references, initialOrdinary: ordinary, initialReferences: references })
  const rebased = new WeakMap<SyncedHostSourceDraft, SyncedHostSourceDraft>([[captured.draft, baseDraft]])
  const rebase = (draft: SyncedHostSourceDraft): SyncedHostSourceDraft | null => {
    if (!owned.has(draft)) return null
    const path: Array<{ draft: SyncedHostSourceDraft; edge: TrackedChange }> = []
    let at = draft
    while (!rebased.has(at)) {
      const edge = trackedChanges.get(at)
      if (!edge) return null // CM replay before submitted A does not mint a new reference source.
      path.push({ draft: at, edge }); at = edge.previous
    }
    let value = rebased.get(at)!
    for (const step of path.reverse()) {
      if (value.source !== step.edge.previous.source) invalid('The actual post-submit Source parent bytes changed.')
      value = applySyncedHostSourceChanges(value, step.edge.changes)
      if (value.source !== step.draft.source) invalid('The actual post-submit Source changes do not reproduce the retained raw bytes.')
      rebased.set(step.draft, value)
    }
    return value
  }
  const checkpoint = Object.freeze({ kind: 'accepted-host-source-checkpoint' as const })
  checkpoints.set(checkpoint, { baseDraft, next: { hostSession: before.hostSession, editSequence: next.editSequence, host: opening }, rebase })
  return checkpoint
}
export function readSyncedHostSourceCheckpoint(handle: SyncedHostSourceCheckpoint) {
  const checkpoint = checkpoints.get(handle)
  if (!checkpoint) invalid('This Source checkpoint is not an original accepted handle.')
  return checkpoint
}
