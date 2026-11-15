import { canonicalRecoveryHasUnsettledWork } from './editor-recovery-canonical'
import { editorRecoveryInvalid, validateEditorRecoveryRecord } from './editor-recovery-drafts'
import { serializeMarkdownWithBlockRanges } from './markdown'
import { parseStrictJson } from './strictJson'
import { canonicalSyncedPortableJson as encode } from './syncedBlockPortable'
import { assertSyncedShape, validateSyncedCanonicalEdit } from './syncedBlockValidation'
import type { SyncedCanonicalEdit } from './synced-blocks'

type CanonicalDraft = {
  source: string
  initialSource: string
  initialBlocks: SyncedCanonicalEdit[]
  anchors: Array<{ block: SyncedCanonicalEdit; from: number; to: number; original: string }>
}

function initialDraft(blocks: SyncedCanonicalEdit[]): CanonicalDraft {
  const { markdown: source, ranges } = serializeMarkdownWithBlockRanges(blocks.map(block => ({
    ...block, content: block.content.replace(/\r\n?/g, '\n')
  })))
  const lines = [0]
  for (const match of source.matchAll(/\n/g)) lines.push(match.index + 1)
  const anchors = ranges.map(({ startLine, endLine }, index) => {
    const from = lines[startLine] ?? source.length
    let to = lines[endLine] ?? source.length
    if (to > from && source[to - 1] === '\n') to--
    return { block: blocks[index], from, to, original: source.slice(from, to) }
  })
  return { source, initialSource: source, initialBlocks: blocks, anchors }
}

/** Restore the actual unapplied buffer over the original shared body. The
 * draft carries text and anchors only. Apply still uses the live group writer. */
export function readCanonicalRecoverySource(value: unknown) {
  const record = validateEditorRecoveryRecord(value)
  const { draft, base } = record
  const working = draft.working, persisted = base.persistedWorking, source = draft.sources[0]
  if (base.owner.kind !== 'group' || working.kind !== 'group' || persisted.kind !== 'group'
    || working.incoming !== null || persisted.incoming !== null || draft.pending.length || draft.composing || draft.importing
    || encode(working.blocks) !== encode(persisted.blocks) || canonicalRecoveryHasUnsettledWork(record)
    || draft.sources.length !== 1 || source.kind !== 'canonical' || source.applying || source.composing || source.importing
    || typeof source.replayJson !== 'string') return editorRecoveryInvalid('shared Source requires its original unchanged opening')

  const accepted = initialDraft(validateSyncedCanonicalEdit(persisted.blocks))
  if (source.openingSource !== accepted.source || source.acceptedSource !== accepted.source) {
    return editorRecoveryInvalid('shared Source accepted floor differs from its original opening')
  }
  const packet = parseStrictJson(source.replayJson, { maxBytes: new TextEncoder().encode(source.replayJson).byteLength, maxDepth: 48 })
  assertSyncedShape(packet, ['kind', 'version', 'opening', 'accepted', 'current', 'provenance'])
  if (packet.kind !== 'knowbook-source-replay-data' || packet.version !== 1 || packet.provenance !== null
    || encode(packet.opening) !== encode(accepted) || encode(packet.accepted) !== encode(accepted)) {
    return editorRecoveryInvalid('shared Source replay opening differs')
  }

  const current = packet.current
  assertSyncedShape(current, ['source', 'initialSource', 'initialBlocks', 'anchors'])
  if (current.source !== source.source || current.initialSource !== accepted.source
    || encode(current.initialBlocks) !== encode(accepted.initialBlocks) || !Array.isArray(current.anchors)) {
    return editorRecoveryInvalid('shared Source replay draft differs')
  }
  const originals = new Map(accepted.anchors.map((anchor, index) => [anchor.block.id, { ...anchor, index }]))
  let previousIndex = -1, previousStart = 0
  const anchors = current.anchors.map(value => {
    assertSyncedShape(value, ['block', 'from', 'to', 'original'])
    const block = value.block
    const original = block && typeof block === 'object' && 'id' in block && typeof block.id === 'string' ? originals.get(block.id) : undefined
    const { from, to } = value
    if (!original || encode(block) !== encode(original.block) || value.original !== original.original
      || typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || original.index <= previousIndex || from < previousStart || from > to || to > source.source.length) {
      return editorRecoveryInvalid('shared Source anchor differs from its original block')
    }
    previousIndex = original.index
    previousStart = from
    return { block: original.block, from, to, original: original.original }
  })
  return { record, draft: { ...accepted, source: source.source, anchors }, accepted, opening: accepted, selection: source.selection }
}
