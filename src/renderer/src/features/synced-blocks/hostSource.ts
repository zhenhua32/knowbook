import type { SyncedHostWorkingBefore, SyncedReferenceIdentity, SyncedStableBlockDraft, SyncedStructureInput } from '@shared/synced-blocks'
import { parseMarkdownSourceStrict, serializeMarkdownHostSource } from '@shared/markdownSource'
import { assertSyncedShape, isSyncedBlockId, parseSyncedBlockPayload, serializeSyncedBlockPayload, SyncedValidationError,
  validateSyncedHostForest } from '@shared/syncedBlockValidation'
import { replaceMarkdownSourceChanges, type MarkdownSourceChange, type MarkdownSourceDraft } from '../../utils/markdownSourceDraft'
import { reconcileMarkdownSourceDraft } from './canonicalSource'
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
  return seal({ ...draft, source: references.source, ordinary, references })
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
    blocks = validateSyncedHostForest(reconcileMarkdownSourceDraft(draft.ordinary, parsed, { freshId, references }))
  }
  return { hostsWorkingBefore: [structuredClone(draft.opening)], finalAfter: [{ documentId: draft.opening.documentId,
    title: draft.opening.workingBefore.title, summary: draft.opening.workingBefore.summary, blocks }],
  newRefSources: draft.references.anchors.flatMap(anchor => anchor.newRefSource === null ? [] : [structuredClone(anchor.newRefSource)]) }
}
