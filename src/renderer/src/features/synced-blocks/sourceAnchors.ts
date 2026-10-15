import type { SyncedNewRefSource, SyncedReferenceIdentity } from '@shared/synced-blocks'
import { parseMarkdownSourceStrict } from '@shared/markdownSource'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, serializeSyncedBlockPayload, SYNCED_BLOCK_FENCE_INFO } from '@shared/syncedBlockValidation'
import type { MarkdownSourceChange } from '../../utils/markdownSourceDraft'

export type SyncedSourceRange = Readonly<{ from: number; to: number }>
export type SyncedSourceReferenceProvenance = Readonly<Extract<SyncedNewRefSource, { kind: 'working' }>>
  | Readonly<Omit<Extract<SyncedNewRefSource, { kind: 'internal' }>, 'identity'> & { identity: Readonly<SyncedReferenceIdentity> }>
export type SyncedSourceReferenceAnchor = Readonly<{
  key: string
  sessionKey: string
  instanceId: string
  groupId: string
  from: number
  to: number
  original: string
  immutableRanges: readonly SyncedSourceRange[]
  newRefSource: SyncedSourceReferenceProvenance | null
}>
export type SyncedSourceSnapshot = Readonly<{
  sessionKey: string
  sourceDocumentId: string
  source: string
  anchors: readonly SyncedSourceReferenceAnchor[]
}>
export type SyncedSourceReferenceSeed = Pick<SyncedSourceReferenceAnchor, 'key' | 'instanceId' | 'groupId' | 'from' | 'to' | 'newRefSource'>
export type SyncedSourceSnapshotInput = Omit<SyncedSourceSnapshot, 'anchors'> & Readonly<{ anchors: readonly SyncedSourceReferenceSeed[] }>
export type SyncedSourceRangeOperation = Readonly<{ from: number; to: number; insertAt: number }>
export type SyncedSourceIdFactory = () => string

export class SyncedSourceAnchorError extends Error {
  constructor(readonly code: 'shape' | 'range' | 'identity' | 'protected', message: string) {
    super(message)
    this.name = 'SyncedSourceAnchorError'
  }
}
const ownedSnapshots = new WeakSet<object>()
function fail(code: SyncedSourceAnchorError['code'], message = 'Invalid synced source anchor transaction'): never {
  throw new SyncedSourceAnchorError(code, message)
}
function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  try { assertSyncedShape(value, keys) } catch { fail('shape') }
}
function dense<T>(items: readonly T[]): void {
  if (!Array.isArray(items) || Object.keys(items).length !== items.length) fail('shape')
  for (let index = 0; index < items.length; index++) if (!Object.hasOwn(items, index)) fail('shape')
}
function opaque(value: unknown): string { return isSyncedBlockId(value) ? value : fail('identity') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : fail('identity') }
function position(value: unknown, length: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= length ? value : fail('range')
}
function range(value: SyncedSourceRange, length: number): SyncedSourceRange {
  shape(value, ['from', 'to'])
  const from = position(value.from, length), to = position(value.to, length)
  if (from >= to) fail('range')
  return Object.freeze({ from, to })
}
function identity(value: SyncedReferenceIdentity): SyncedReferenceIdentity {
  shape(value, ['workspaceScope', 'groupId', 'creationId'])
  return Object.freeze({ workspaceScope: uuid(value.workspaceScope), groupId: uuid(value.groupId), creationId: uuid(value.creationId) })
}
function provenance(value: SyncedSourceReferenceProvenance | null, instanceId: string, groupId: string): SyncedSourceReferenceProvenance | null {
  if (value === null) return null
  if (value?.kind === 'working') {
    shape(value, ['kind', 'instanceId', 'sourceDocumentId', 'sourceInstanceId'])
    if (uuid(value.instanceId) !== instanceId) fail('identity')
    return Object.freeze({ kind: 'working', instanceId, sourceDocumentId: opaque(value.sourceDocumentId), sourceInstanceId: uuid(value.sourceInstanceId) })
  }
  if (value?.kind === 'internal') {
    shape(value, ['kind', 'instanceId', 'identity'])
    if (uuid(value.instanceId) !== instanceId) fail('identity')
    const ref = identity(value.identity)
    if (ref.groupId !== groupId) fail('identity')
    return Object.freeze({ kind: 'internal', instanceId, identity: ref })
  }
  return fail('shape')
}

/** These are raw character ranges, not a second Markdown grammar. The strict
 * parser proves the core fence boundaries at creation/Apply. Only leading
 * horizontal whitespace on subsequent source lines is editable inside a core;
 * line endings, markers, info and payload remain protected. Empty gaps matter
 * too: indentation can be inserted before an unindented payload/closing line. */
function protection(source: string, from: number, to: number) {
  const gaps: SyncedSourceRange[] = [], immutableRanges: SyncedSourceRange[] = []
  let index = from
  while (index < to) {
    const char = source[index++]
    if (char !== '\r' && char !== '\n') continue
    if (char === '\r' && source[index] === '\n') index++
    const start = index
    while (index < to && (source[index] === ' ' || source[index] === '\t')) index++
    gaps.push({ from: start, to: index })
  }
  let cursor = from
  for (const gap of gaps) {
    if (cursor < gap.from) immutableRanges.push(Object.freeze({ from: cursor, to: gap.from }))
    cursor = gap.to
  }
  if (cursor < to) immutableRanges.push(Object.freeze({ from: cursor, to }))
  return { gaps, immutableRanges: Object.freeze(immutableRanges) }
}

/** Make an owned immutable value, never freeze or mutate caller-owned objects. */
function snapshot(value: SyncedSourceSnapshot): SyncedSourceSnapshot {
  shape(value, ['sessionKey', 'sourceDocumentId', 'source', 'anchors'])
  const sessionKey = opaque(value.sessionKey), sourceDocumentId = opaque(value.sourceDocumentId)
  if (typeof value.source !== 'string') fail('shape')
  dense(value.anchors)
  const keys = new Set<string>(), ids = new Set<string>()
  let previousEnd = 0
  const anchors = value.anchors.map(anchor => {
    shape(anchor, ['key', 'sessionKey', 'instanceId', 'groupId', 'from', 'to', 'original', 'immutableRanges', 'newRefSource'])
    const key = opaque(anchor.key), instanceId = uuid(anchor.instanceId), groupId = uuid(anchor.groupId)
    const from = position(anchor.from, value.source.length), to = position(anchor.to, value.source.length)
    if (anchor.sessionKey !== sessionKey || keys.has(key) || ids.has(instanceId)) fail('identity')
    if (from >= to || from < previousEnd) fail('range')
    if (typeof anchor.original !== 'string' || value.source.slice(from, to) !== anchor.original) fail('range')
    keys.add(key); ids.add(instanceId); previousEnd = to
    dense(anchor.immutableRanges)
    const immutableRanges = protection(value.source, from, to).immutableRanges
    if (anchor.immutableRanges.length !== immutableRanges.length) fail('protected')
    anchor.immutableRanges.forEach((item, index) => {
      const checked = range(item, value.source.length)
      if (checked.from !== immutableRanges[index].from || checked.to !== immutableRanges[index].to) fail('protected')
    })
    return Object.freeze({ key, sessionKey, instanceId, groupId, from, to, original: anchor.original,
      immutableRanges: Object.freeze(immutableRanges), newRefSource: provenance(anchor.newRefSource, instanceId, groupId) })
  })
  const result = Object.freeze({ sessionKey, sourceDocumentId, source: value.source, anchors: Object.freeze(anchors) })
  ownedSnapshots.add(result)
  return result
}

/** Only the initial, locally assembled reference expectations confer draft
 * identity. The parser proves actual closed fence tokens, not matching text.
 * The caller still owns workspace/provenance authorization; Main rechecks it. */
export function createSyncedSourceSnapshot(input: SyncedSourceSnapshotInput): SyncedSourceSnapshot {
  shape(input, ['sessionKey', 'sourceDocumentId', 'source', 'anchors'])
  if (typeof input.source !== 'string') fail('shape')
  dense(input.anchors)
  const result = snapshot({ ...input, anchors: input.anchors.map(seed => {
    shape(seed, ['key', 'instanceId', 'groupId', 'from', 'to', 'newRefSource'])
    const from = position(seed.from, input.source.length), to = position(seed.to, input.source.length)
    return { ...seed, sessionKey: input.sessionKey, original: input.source.slice(from, to),
      immutableRanges: protection(input.source, from, to).immutableRanges }
  }) })
  parseMarkdownSourceStrict(result.source, { mode: 'internal-host', references: result.anchors.map(anchor => ({
    key: anchor.key, from: anchor.from, to: anchor.to,
    payload: serializeSyncedBlockPayload({ version: 1, groupId: anchor.groupId })
  })) })
  return result
}

function edits(source: string, changes: readonly MarkdownSourceChange[]): MarkdownSourceChange[] {
  dense(changes)
  const ordered = changes.map(change => {
    shape(change, ['from', 'to', 'insert'])
    const from = position(change.from, source.length), to = position(change.to, source.length)
    if (from > to || typeof change.insert !== 'string') fail('range')
    return { from, to, insert: change.insert }
  }).sort((a, b) => a.from - b.from || a.to - b.to)
  let previous: MarkdownSourceChange | undefined
  for (const change of ordered) {
    if (previous && (change.from < previous.to || change.from === previous.from)) fail('range')
    previous = change
  }
  return ordered
}
function shifted(anchor: SyncedSourceReferenceAnchor, delta: number): SyncedSourceReferenceAnchor {
  return { ...anchor, from: anchor.from + delta, to: anchor.to + delta,
    immutableRanges: anchor.immutableRanges.map(item => ({ from: item.from + delta, to: item.to + delta })) }
}
function atSource(anchor: SyncedSourceReferenceAnchor, source: string, from: number, to: number): SyncedSourceReferenceAnchor {
  return { ...anchor, from, to, original: source.slice(from, to), immutableRanges: protection(source, from, to).immutableRanges }
}

/** Disjoint replacements use the original raw UTF-16 coordinates. A replacement
 * covering an entire reference removes its identity even if the inserted public
 * text is identical. No scan ever reattaches that identity to matching text.
 * Ordinary syntax may be temporarily incomplete; strict Apply parses later. */
export function applySyncedSourceChanges(input: SyncedSourceSnapshot, changes: readonly MarkdownSourceChange[]): SyncedSourceSnapshot {
  const before = snapshot(input), ordered = edits(before.source, changes)
  let cursor = 0
  const parts: string[] = []
  for (const change of ordered) { parts.push(before.source.slice(cursor, change.from), change.insert); cursor = change.to }
  parts.push(before.source.slice(cursor))
  const source = parts.join('')
  const shifts = [0]
  for (const change of ordered) shifts.push(shifts[shifts.length - 1] + change.insert.length - (change.to - change.from))
  const anchors = before.anchors.flatMap(anchor => {
    let low = 0, high = ordered.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (ordered[middle].to <= anchor.from) low = middle + 1
      else high = middle
    }
    const preceding = shifts[low]
    let within = 0
    const gaps = protection(before.source, anchor.from, anchor.to).gaps
    for (let index = low; index < ordered.length; index++) {
      const change = ordered[index]
      if (change.from >= anchor.to) break
      if (change.from <= anchor.from && change.to >= anchor.to) return []
      if (change.from === change.to ? change.from > anchor.from && change.from < anchor.to
        : change.from < anchor.to && change.to > anchor.from) {
        if (!/^[ \t]*$/.test(change.insert) || !gaps.some(gap => change.from >= gap.from && change.to <= gap.to)) {
          fail('protected', 'A protected reference fence cannot be partially changed')
        }
        within += change.insert.length - (change.to - change.from)
      }
    }
    return [atSource(anchor, source, anchor.from + preceding, anchor.to + preceding + within)]
  })
  if (source === before.source && anchors.length === before.anchors.length
    && anchors.every((anchor, index) => anchor.from === before.anchors[index].from && anchor.to === before.anchors[index].to)) return ownedSnapshots.has(input) ? input : before
  return snapshot({ ...before, source, anchors })
}

function operation(input: SyncedSourceSnapshot, raw: SyncedSourceRangeOperation) {
  const before = snapshot(input)
  shape(raw, ['from', 'to', 'insertAt'])
  const selected = range({ from: raw.from, to: raw.to }, before.source.length)
  const insertAt = position(raw.insertAt, before.source.length)
  if (insertAt > selected.from && insertAt < selected.to) fail('range')
  for (const anchor of before.anchors) {
    const overlap = selected.from < anchor.to && selected.to > anchor.from
    if (overlap && !(selected.from <= anchor.from && selected.to >= anchor.to)) fail('protected')
    if (insertAt > anchor.from && insertAt < anchor.to) fail('protected')
  }
  return { before, ...selected, insertAt,
    selected: before.anchors.filter(anchor => selected.from <= anchor.from && selected.to >= anchor.to) }
}

/** Explicit move is the only source operation that carries existing instance
 * identities across a delete/insert pair. The destination is in old coordinates. */
export function moveSyncedSourceRange(input: SyncedSourceSnapshot, raw: SyncedSourceRangeOperation): SyncedSourceSnapshot {
  const { before, from, to, insertAt, selected } = operation(input, raw)
  if (insertAt === from || insertAt === to) return ownedSnapshots.has(input) ? input : before
  const removed = applySyncedSourceChanges(before, [{ from, to, insert: '' }])
  const at = insertAt < from ? insertAt : insertAt - (to - from)
  const inserted = applySyncedSourceChanges(removed, [{ from: at, to: at, insert: before.source.slice(from, to) }])
  return snapshot({ ...inserted, anchors: [...inserted.anchors, ...selected.map(anchor => shifted(anchor, at - from))].sort((a, b) => a.from - b.from) })
}

function fresh(factory: SyncedSourceIdFactory, occupied: Set<string>): string {
  const value = uuid(factory())
  if (occupied.has(value)) fail('identity')
  occupied.add(value)
  return value
}
function copiedSource(anchor: SyncedSourceReferenceAnchor, instanceId: string, documentId: string): SyncedSourceReferenceProvenance {
  const previous = anchor.newRefSource
  return previous ? { ...previous, instanceId } : { kind: 'working', instanceId, sourceDocumentId: documentId, sourceInstanceId: anchor.instanceId }
}

/** Copies allocate fresh reference identities. Copies of a draft copy keep its
 * original working/internal provenance instead of citing an uncommitted copy. */
export function copySyncedSourceRange(input: SyncedSourceSnapshot, raw: SyncedSourceRangeOperation,
  factory: SyncedSourceIdFactory = () => crypto.randomUUID()): SyncedSourceSnapshot {
  const { before, from, to, insertAt, selected } = operation(input, raw)
  const occupied = new Set(before.anchors.map(anchor => anchor.instanceId)), keys = new Set(before.anchors.map(anchor => anchor.key))
  const copies = selected.map(anchor => {
    const instanceId = fresh(factory, occupied), key = fresh(factory, keys)
    return { ...shifted(anchor, insertAt - from), key, instanceId, newRefSource: copiedSource(anchor, instanceId, before.sourceDocumentId) }
  })
  const inserted = applySyncedSourceChanges(before, [{ from: insertAt, to: insertAt, insert: before.source.slice(from, to) }])
  return snapshot({ ...inserted, anchors: [...inserted.anchors, ...copies].sort((a, b) => a.from - b.from) })
}

/** This accepts a candidate internal identity, not a claim that validation has
 * already happened. The caller must verify its internal envelope; Main must
 * verify workspace, creation and guards again. Public Markdown/MIME is no proof.
 * Canonical fence text is built here; callers cannot smuggle a different payload. */
export function insertSyncedSourceReference(input: SyncedSourceSnapshot,
  insertion: Readonly<{ at: number; identity: SyncedReferenceIdentity }>,
  factory: SyncedSourceIdFactory = () => crypto.randomUUID()): SyncedSourceSnapshot {
  const before = snapshot(input)
  shape(insertion, ['at', 'identity'])
  const at = position(insertion.at, before.source.length), candidate = identity(insertion.identity)
  const instanceId = fresh(factory, new Set(before.anchors.map(anchor => anchor.instanceId)))
  const key = fresh(factory, new Set(before.anchors.map(anchor => anchor.key)))
  const original = '```' + SYNCED_BLOCK_FENCE_INFO + '\n' + serializeSyncedBlockPayload({ version: 1, groupId: candidate.groupId }) + '\n```'
  const prefix = at > 0 && before.source[at - 1] !== '\n' && before.source[at - 1] !== '\r' ? '\n\n' : ''
  const suffix = at < before.source.length && before.source[at] !== '\r' && before.source[at] !== '\n' ? '\n\n' : ''
  const inserted = applySyncedSourceChanges(before, [{ from: at, to: at, insert: prefix + original + suffix }])
  const from = at + prefix.length, to = from + original.length
  const anchor: SyncedSourceReferenceAnchor = { key, sessionKey: before.sessionKey, instanceId, groupId: candidate.groupId,
    from, to, original, immutableRanges: protection(inserted.source, from, to).immutableRanges,
    newRefSource: { kind: 'internal', instanceId, identity: candidate } }
  return snapshot({ ...inserted, anchors: [...inserted.anchors, anchor].sort((a, b) => a.from - b.from) })
}
