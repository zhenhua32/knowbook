import type { DocumentBlockDraft } from './contracts'
import type { SyncedHostWorkingBefore, SyncedStableBlockDraft } from './synced-blocks'
import type { EditorRecoveryRecord } from './editor-recovery-drafts'
import { editorRecoveryInvalid, validateEditorRecoveryRecord, validateEditorRecoveryWorking } from './editor-recovery-drafts'
import { canonicalSyncedPortableJson as encode } from './syncedBlockPortable'
import { serializeMarkdownHostSource } from './markdownSource'
import { parseSyncedBlockPayload } from './syncedBlockValidation'
import { parseStrictJson } from './strictJson'

export interface RecoveryOrdinarySourceDraft {
  source: string; initialSource: string; initialBlocks: DocumentBlockDraft[]
  anchors: Array<{ block: DocumentBlockDraft; from: number; to: number; original: string }>
}
export interface RecoveryHostSourceDraft {
  source: string; opening: SyncedHostWorkingBefore; ordinary: RecoveryOrdinarySourceDraft; initialOrdinary: RecoveryOrdinarySourceDraft
  references: RecoveryHostSourceReferences
  initialReferences: RecoveryHostSourceDraft['references']
}
interface RecoveryHostSourceReferences {
  sessionKey: string; sourceDocumentId: string; source: string; anchors: RecoveryHostSourceReference[]
}
interface RecoveryHostSourceReference {
  key: string; sessionKey: string; instanceId: string; groupId: string; from: number; to: number; original: string
  immutableRanges: readonly Readonly<{ from: number; to: number }>[]; newRefSource: null
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return editorRecoveryInvalid('plain Source packet required')
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(descriptors, name))
    || keys.some(key => typeof key !== 'string' || !names.includes(key) || !descriptors[key].enumerable || !('value' in descriptors[key]))) return editorRecoveryInvalid('closed Source packet differs')
  return value as Record<string, unknown>
}
const same = (a: unknown, b: unknown) => encode(a) === encode(b)
/** Compare only an actual SQL-derived/current host projection. Empty SQL tags
 * have one physical value even when public hydration omits the optional field.
 * This never changes an authored packet, anchor, source, request or side hash. */
export function sameRecoveryPhysicalHost(left: { title: string; summary: string; blocks: DocumentBlockDraft[] }, right: { title: string; summary: string; blocks: DocumentBlockDraft[] }): boolean {
  const physical = (value: typeof left) => {
    // Public hydration can retain optional own undefined fields. Apply the
    // ordinary IPC JSON omission rule to a separate comparison-only copy, then
    // require the real closed block codec before comparing SQL defaults.
    const json = encode({ kind: 'host', title: value.title, summary: value.summary, blocks: value.blocks })
    const checked = validateEditorRecoveryWorking(parseStrictJson(json, { maxBytes: Math.max(1, new TextEncoder().encode(json).byteLength), maxDepth: 48 }))
    if (checked.kind !== 'host') return editorRecoveryInvalid('actual physical host required')
    return { title: checked.title, summary: checked.summary,
      blocks: checked.blocks.map(block => ({ ...block, tags: block.tags ?? [], parentBlockId: block.parentBlockId ?? null })) }
  }
  try { return same(physical(left), physical(right)) } catch { return false }
}
function anchorPosition(value: unknown, length: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= length ? value : editorRecoveryInvalid('Source anchor outside exact UTF16 buffer')
}

/** Shared coordinates for the raw protected fence. Horizontal indentation after
 * each newline remains editable, including an initially empty indent. */
export function hostSourceProtection(source: string, from: number, to: number) {
  const gaps: Array<{ from: number; to: number }> = [], immutableRanges: Array<{ from: number; to: number }> = []
  let cursor = from
  for (let index = from; index < to;) {
    const char = source[index++]
    if (char !== '\r' && char !== '\n') continue
    if (char === '\r' && source[index] === '\n') index++
    const start = index
    while (index < to && (source[index] === ' ' || source[index] === '\t')) index++
    gaps.push({ from: start, to: index })
    if (cursor < start) immutableRanges.push(Object.freeze({ from: cursor, to: start }))
    cursor = index
  }
  if (cursor < to) immutableRanges.push(Object.freeze({ from: cursor, to }))
  return { gaps, immutableRanges: Object.freeze(immutableRanges) }
}

/** Recover the original unchanged persisted opening and its unapplied buffer.
 * Any protected reference must descend from an actual Main-pinned instance. */
export function readHostRecoverySource(value: unknown): {
  record: EditorRecoveryRecord; opening: RecoveryHostSourceDraft; accepted: RecoveryHostSourceDraft; current: RecoveryHostSourceDraft
} {
  const record = validateEditorRecoveryRecord(value), owner = record.base.owner, base = record.base.persistedWorking, sources = record.draft.sources
  if (owner.kind !== 'host' || base.kind !== 'host' || record.draft.working.kind !== 'host' || sources.length !== 1 || record.draft.pending.length
    || record.draft.composing || record.draft.importing) return editorRecoveryInvalid('original host Source domain differs')
  const source = sources[0]
  if (source.kind === 'canonical' || source.composing || source.importing || source.applying || typeof source.replayJson !== 'string') return editorRecoveryInvalid('original Source replay is unfinished or missing')
  const packet = fields(parseStrictJson(source.replayJson, { maxBytes: Math.max(1, new TextEncoder().encode(source.replayJson).byteLength), maxDepth: 48 }),
    ['kind', 'version', 'opening', 'accepted', 'current', 'provenance'])
  if (packet.kind !== 'knowbook-source-replay-data' || packet.version !== 1) return editorRecoveryInvalid('Source replay domain differs')
  if (!base.blocks.every(block => typeof block.id === 'string' && block.id.length)) return editorRecoveryInvalid('original Source block identities missing')
  const rawOpeningDraft = fields(packet.opening, ['source', 'opening', 'ordinary', 'references', 'initialOrdinary', 'initialReferences'])
  const rawOpening = fields(rawOpeningDraft.opening, ['documentId', 'expectedPersistedUpdatedAt', 'workingBefore'])
  const authored = fields(rawOpening.workingBefore, ['title', 'summary', 'blocks'])
  const authoredWorking = validateEditorRecoveryWorking({ kind: 'host', ...authored })
  if (authoredWorking.kind !== 'host' || rawOpening.documentId !== owner.documentId || rawOpening.expectedPersistedUpdatedAt !== owner.updatedAt
    || !sameRecoveryPhysicalHost(authoredWorking, base) || authoredWorking.blocks.some(block => typeof block.id !== 'string' || !block.id.length)) {
    return editorRecoveryInvalid('authored Source opening differs from the sealed actual SQL B')
  }
  const opening: SyncedHostWorkingBefore = { documentId: owner.documentId, expectedPersistedUpdatedAt: owner.updatedAt,
    workingBefore: { title: authoredWorking.title, summary: authoredWorking.summary, blocks: authoredWorking.blocks as SyncedStableBlockDraft[] } }
  const encoded = serializeMarkdownHostSource(opening.workingBefore.blocks), starts = [0]
  const pins = new Map(record.base.hostSourcePins?.groups.flatMap(group => group.instances.map(instance => [instance.instanceId, group.groupId] as const)))
  const originalReferences = encoded.references.map(({ index, from, to }) => {
    const block = opening.workingBefore.blocks[index], groupId = parseSyncedBlockPayload(block.content).groupId
    if (block.type !== 'synced-block' || pins.get(block.id) !== groupId) return editorRecoveryInvalid('original Source reference has no sealed Main pin')
    return { instanceId: block.id, groupId, from, to }
  })
  if (originalReferences.length !== pins.size) return editorRecoveryInvalid('original Source pins do not cover the same references')
  for (const match of encoded.markdown.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length)
  const original: RecoveryOrdinarySourceDraft = { source: encoded.markdown, initialSource: encoded.markdown, initialBlocks: authoredWorking.blocks,
    anchors: encoded.ranges.flatMap(span => {
      const from = starts[span.startLine] ?? encoded.markdown.length
      let to = starts[span.endLine] ?? encoded.markdown.length
      if (encoded.markdown[to - 1] === '\n') to--
      if (encoded.markdown[to - 1] === '\r') to--
      to = Math.max(from, to)
      const block = authoredWorking.blocks[span.index]
      if (!block) return editorRecoveryInvalid('original Source serializer omitted a block')
      return block.type === 'synced-block' ? [] : [{ block, from, to, original: encoded.markdown.slice(from, to) }]
    }) }
  const originalById = new Map(original.anchors.map(anchor => [anchor.block.id!, anchor]))
  const readOrdinary = (input: unknown, raw: string): RecoveryOrdinarySourceDraft => {
    const row = fields(input, ['source', 'initialSource', 'initialBlocks', 'anchors'])
    if (row.source !== raw || row.initialSource !== encoded.markdown || !same(row.initialBlocks, authoredWorking.blocks) || !Array.isArray(row.anchors)) return editorRecoveryInvalid('Source initial blocks/raw opening changed')
    const seen = new Set<string>(); let previousEnd = 0
    const anchors = row.anchors.map(inputAnchor => {
      const anchor = fields(inputAnchor, ['block', 'from', 'to', 'original']), block = anchor.block as DocumentBlockDraft
      const old = block && typeof block === 'object' && typeof block.id === 'string' && originalById.get(block.id)
      const from = anchorPosition(anchor.from, raw.length), to = anchorPosition(anchor.to, raw.length)
      if (!old || !same(block, old.block) || anchor.original !== old.original || seen.has(old.block.id!) || from > to || from < previousEnd) return editorRecoveryInvalid('Source anchor does not descend from the sealed opening')
      seen.add(old.block.id!); previousEnd = to
      return { block: old.block, from, to, original: old.original }
    })
    return { source: raw, initialSource: encoded.markdown, initialBlocks: authoredWorking.blocks, anchors }
  }
  const readReferences = (input: unknown, raw: string): RecoveryHostSourceReferences => {
    const row = fields(input, ['sessionKey', 'sourceDocumentId', 'source', 'anchors'])
    if (typeof row.sessionKey !== 'string' || !row.sessionKey.trim() || row.sourceDocumentId !== owner.documentId
      || row.source !== raw || !Array.isArray(row.anchors)) return editorRecoveryInvalid('host Source reference session differs')
    const sessionKey = row.sessionKey, keys = new Set<string>(), instances = new Set<string>()
    let previousEnd = 0
    const anchors = row.anchors.map(inputAnchor => {
      const anchor = fields(inputAnchor, ['key', 'sessionKey', 'instanceId', 'groupId', 'from', 'to', 'original', 'immutableRanges', 'newRefSource'])
      const from = anchorPosition(anchor.from, raw.length), to = anchorPosition(anchor.to, raw.length)
      if (typeof anchor.key !== 'string' || !anchor.key.trim() || keys.has(anchor.key) || anchor.sessionKey !== sessionKey
        || typeof anchor.instanceId !== 'string' || instances.has(anchor.instanceId) || typeof anchor.groupId !== 'string'
        || pins.get(anchor.instanceId) !== anchor.groupId || anchor.newRefSource !== null || from >= to || from < previousEnd
        || anchor.original !== raw.slice(from, to)) return editorRecoveryInvalid('cold Source reference does not belong to the pinned opening')
      const { immutableRanges } = hostSourceProtection(raw, from, to)
      if (!same(immutableRanges, anchor.immutableRanges)) return editorRecoveryInvalid('cold Source protected ranges changed')
      keys.add(anchor.key); instances.add(anchor.instanceId); previousEnd = to
      return { key: anchor.key, sessionKey, instanceId: anchor.instanceId, groupId: anchor.groupId, from, to,
        original: raw.slice(from, to), immutableRanges, newRefSource: null }
    })
    return { sessionKey, sourceDocumentId: owner.documentId, source: raw, anchors }
  }
  const initialReferences = readReferences(rawOpeningDraft.initialReferences, encoded.markdown)
  if (!same(initialReferences.anchors.map(({ instanceId, groupId, from, to }) => ({ instanceId, groupId, from, to })), originalReferences)) {
    return editorRecoveryInvalid('initial Source reference identities and serializer ranges differ')
  }
  const byKey = new Map(initialReferences.anchors.map(anchor => [anchor.key, anchor]))
  const protectedBytes = (anchor: RecoveryHostSourceReference, raw: string) => anchor.immutableRanges.map(({ from, to }) => raw.slice(from, to))
  const readDraft = (input: unknown, raw: string): RecoveryHostSourceDraft => {
    const draft = fields(input, ['source', 'opening', 'ordinary', 'references', 'initialOrdinary', 'initialReferences'])
    if (draft.source !== raw || !same(draft.opening, opening) || !same(draft.initialOrdinary, original)
      || !same(draft.initialReferences, initialReferences)) return editorRecoveryInvalid('Source original persisted W differs')
    const references = readReferences(draft.references, raw)
    if (references.sessionKey !== initialReferences.sessionKey || references.anchors.some(anchor => {
      const before = byKey.get(anchor.key)
      return !before || before.instanceId !== anchor.instanceId || before.groupId !== anchor.groupId
        || !same(protectedBytes(before, encoded.markdown), protectedBytes(anchor, raw))
    })) return editorRecoveryInvalid('cold Source protected reference lineage differs')
    return { source: raw, opening, ordinary: readOrdinary(draft.ordinary, raw), initialOrdinary: original, references, initialReferences }
  }
  if (source.openingSource !== encoded.markdown || source.acceptedSource !== encoded.markdown) return editorRecoveryInvalid('Source accepted floor needs its actual original ACK')
  const opened = readDraft(packet.opening, encoded.markdown), accepted = readDraft(packet.accepted, encoded.markdown), current = readDraft(packet.current, source.source)
  if (!same(opened, accepted) || !same(opened.ordinary, original) || !same(opened.references, initialReferences)) return editorRecoveryInvalid('Source opening/accepted floor changed without an original ACK')
  const provenance = fields(packet.provenance, ['kind', 'opening', 'initialOrdinary', 'initialReferences'])
  if (provenance.kind !== 'actual-host-source-opening' || !same(provenance.opening, opening) || !same(provenance.initialOrdinary, original)
    || !same(provenance.initialReferences, opened.initialReferences)) return editorRecoveryInvalid('original Source provenance is unavailable')
  if (!sameRecoveryPhysicalHost(record.draft.working, base)) return editorRecoveryInvalid('host Source owning W changed since its actual SQL opening')
  return { record, opening: opened, accepted, current }
}
