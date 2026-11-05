import type { DocumentBlockDraft } from './contracts'
import type { SyncedHostWorkingBefore, SyncedStableBlockDraft } from './synced-blocks'
import type { EditorRecoveryRecord } from './editor-recovery-drafts'
import { editorRecoveryInvalid, validateEditorRecoveryRecord, validateEditorRecoveryWorking } from './editor-recovery-drafts'
import { canonicalSyncedPortableJson as encode } from './syncedBlockPortable'
import { serializeMarkdownHostSource } from './markdownSource'
import { parseStrictJson } from './strictJson'

export interface RecoveryOrdinarySourceDraft {
  source: string; initialSource: string; initialBlocks: DocumentBlockDraft[]
  anchors: Array<{ block: DocumentBlockDraft; from: number; to: number; original: string }>
}
export interface RecoveryHostSourceDraft {
  source: string; opening: SyncedHostWorkingBefore; ordinary: RecoveryOrdinarySourceDraft; initialOrdinary: RecoveryOrdinarySourceDraft
  references: { sessionKey: string; sourceDocumentId: string; source: string; anchors: [] }
  initialReferences: RecoveryHostSourceDraft['references']
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
export function sameOrdinaryRecoveryPhysicalHost(left: { title: string; summary: string; blocks: DocumentBlockDraft[] }, right: { title: string; summary: string; blocks: DocumentBlockDraft[] }): boolean {
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

/** First closed cold Source domain: an ordinary host at the original unchanged
 * persisted opening, with no accepted business ACK or reference capabilities.
 * Full current anchors are restored from this old original; no parse/serialize
 * of current C, fresh baseline, final forest validation or text normalization.
 * ACK floors and canonical/reference witnesses use their separate adapters. */
export function readOrdinaryHostRecoverySource(value: unknown): {
  record: EditorRecoveryRecord; opening: RecoveryHostSourceDraft; accepted: RecoveryHostSourceDraft; current: RecoveryHostSourceDraft
} {
  const record = validateEditorRecoveryRecord(value), owner = record.base.owner, base = record.base.persistedWorking, sources = record.draft.sources
  if (owner.kind !== 'host' || base.kind !== 'host' || record.draft.working.kind !== 'host' || base.blocks.some(block => block.type === 'synced-block')
    || record.draft.working.blocks.some(block => block.type === 'synced-block') || sources.length !== 1 || record.draft.pending.length
    || record.draft.composing || record.draft.importing) return editorRecoveryInvalid('ordinary original Source domain differs')
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
    || !sameOrdinaryRecoveryPhysicalHost(authoredWorking, base) || authoredWorking.blocks.some(block => typeof block.id !== 'string' || !block.id.length)) {
    return editorRecoveryInvalid('authored Source opening differs from the sealed actual SQL B')
  }
  const opening: SyncedHostWorkingBefore = { documentId: owner.documentId, expectedPersistedUpdatedAt: owner.updatedAt,
    workingBefore: { title: authoredWorking.title, summary: authoredWorking.summary, blocks: authoredWorking.blocks as SyncedStableBlockDraft[] } }
  const encoded = serializeMarkdownHostSource(opening.workingBefore.blocks), starts = [0]
  for (const match of encoded.markdown.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length)
  const original: RecoveryOrdinarySourceDraft = { source: encoded.markdown, initialSource: encoded.markdown, initialBlocks: authoredWorking.blocks,
    anchors: encoded.ranges.map(span => {
      const from = starts[span.startLine] ?? encoded.markdown.length
      let to = starts[span.endLine] ?? encoded.markdown.length
      if (encoded.markdown[to - 1] === '\n') to--
      if (encoded.markdown[to - 1] === '\r') to--
      to = Math.max(from, to)
      const block = authoredWorking.blocks[span.index]
      if (!block) return editorRecoveryInvalid('original Source serializer omitted a block')
      return { block, from, to, original: encoded.markdown.slice(from, to) }
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
  const readDraft = (input: unknown, raw: string): RecoveryHostSourceDraft => {
    const draft = fields(input, ['source', 'opening', 'ordinary', 'references', 'initialOrdinary', 'initialReferences'])
    if (draft.source !== raw || !same(draft.opening, opening) || !same(draft.initialOrdinary, original)) return editorRecoveryInvalid('Source original persisted W differs')
    const initialReferences = fields(draft.initialReferences, ['sessionKey', 'sourceDocumentId', 'source', 'anchors'])
    if (typeof initialReferences.sessionKey !== 'string' || !initialReferences.sessionKey.length || initialReferences.sourceDocumentId !== owner.documentId
      || initialReferences.source !== encoded.markdown || !Array.isArray(initialReferences.anchors) || initialReferences.anchors.length) return editorRecoveryInvalid('ordinary Source has no reference authority')
    const references = fields(draft.references, ['sessionKey', 'sourceDocumentId', 'source', 'anchors'])
    if (references.sessionKey !== initialReferences.sessionKey || references.sourceDocumentId !== owner.documentId || references.source !== raw
      || !Array.isArray(references.anchors) || references.anchors.length) return editorRecoveryInvalid('ordinary Source reference lineage differs')
    return { source: raw, opening, ordinary: readOrdinary(draft.ordinary, raw), initialOrdinary: original,
      references: { sessionKey: references.sessionKey as string, sourceDocumentId: owner.documentId, source: raw, anchors: [] },
      initialReferences: { sessionKey: initialReferences.sessionKey, sourceDocumentId: owner.documentId, source: encoded.markdown, anchors: [] } }
  }
  if (source.openingSource !== encoded.markdown || source.acceptedSource !== encoded.markdown) return editorRecoveryInvalid('Source accepted floor needs its actual original ACK')
  const opened = readDraft(packet.opening, encoded.markdown), accepted = readDraft(packet.accepted, encoded.markdown), current = readDraft(packet.current, source.source)
  if (!same(opened, accepted) || !same(opened.ordinary, original)) return editorRecoveryInvalid('Source opening/accepted floor changed without an original ACK')
  const provenance = fields(packet.provenance, ['kind', 'opening', 'initialOrdinary', 'initialReferences'])
  if (provenance.kind !== 'actual-host-source-opening' || !same(provenance.opening, opening) || !same(provenance.initialOrdinary, original)
    || !same(provenance.initialReferences, opened.initialReferences)) return editorRecoveryInvalid('original Source provenance is unavailable')
  if (!sameOrdinaryRecoveryPhysicalHost(record.draft.working, base)) return editorRecoveryInvalid('ordinary Source owning W changed since its actual SQL opening')
  return { record, opening: opened, accepted, current }
}
