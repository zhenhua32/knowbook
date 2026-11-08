import type { SyncedGroupWire, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { syncedCanonicalEdits } from '../../shared/syncedBlockValidation'
import { collectBlockTransferNamespaceEdits } from '../../shared/documentBlockTransferLinks'
import { markdownEngine } from '../../shared/markdownEngine'
import { captureSyncedCreateSourceFacts, UnsupportedSyncedHostCreate } from './synced-host-create-plan'
import type { DetachTextEdit } from './synced-host-detach-plan'

type Facts = ReturnType<typeof captureSyncedCreateSourceFacts>
type Definition = Facts['definitions'][number]
type Names = { reference: Map<string, string>; note: Map<string, string> }
function unproved(): never { throw new UnsupportedSyncedHostCreate('semantic-binding') }

export function planDetachDefinitionNamespace(host: readonly SyncedStableBlockDraft[], wire: SyncedGroupWire,
  hostFacts = captureSyncedCreateSourceFacts(host), sourceFacts = captureSyncedCreateSourceFacts(syncedCanonicalEdits(wire.blocks))) {
  const names: Names = { reference: new Map(), note: new Map() }
  const collisions = [...sourceFacts.effective].filter(([key]) => hostFacts.effective.has(key))
  if (!collisions.length) return { names, edits: [] as DetachTextEdit[] }
  const occupied = [...host, ...wire.blocks].map(block => block.content).join('\n').toLowerCase()
  const reserved = new Set([...hostFacts.effective.keys(), ...sourceFacts.effective.keys()])
  let index = 0
  for (const [, definition] of collisions.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    let name: string, key: string
    do {
      name = `knowbook-detach-${++index}`
      key = definition.kind + ':' + parserLabel(definition.kind, name)
    } while (reserved.has(key) || occupied.includes(name))
    names[definition.kind].set(definition.label, name)
    reserved.add(key)
  }
  const blocks = syncedCanonicalEdits(wire.blocks)
  let ranges: ReturnType<typeof collectBlockTransferNamespaceEdits>
  try { ranges = collectBlockTransferNamespaceEdits(blocks, names) }
  catch { return unproved() }
  const edits = ranges.map(({ blockIndex, start, end, replacement }) => {
    const block = blocks[blockIndex]
    if (!block || start < 0 || end < start || end > block.content.length) return unproved()
    return { blockId: block.id, from: start, to: end, before: block.content.slice(start, end), after: replacement }
  }).filter(edit => edit.before !== edit.after)
  if (!edits.length) return unproved()
  return { names, edits }
}

function parserLabel(kind: Definition['kind'], value: string) {
  return kind === 'reference' ? markdownEngine.utils.normalizeReference(value) : value
}

export function detachedDefinitionLabel(names: Names, kind: Definition['kind'], label: string) {
  const replacement = names[kind].get(label)
  return replacement === undefined ? label : parserLabel(kind, replacement)
}

/** The exact consumer order also proves repeated uses. Missing note tokens
 * remain distinct even if their label later exists in the other scope. */
export function detachConsumerTrace(facts: Facts, names?: Names): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const visit = (value: unknown, output: string[]) => {
    if (!value || typeof value !== 'object') return
    const token = value as { type?: unknown; label?: unknown; inlineNote?: { tokens?: unknown[] }; children?: unknown[] }
    if (typeof token.label === 'string') {
      const kind = token.type === 'link_open' || token.type === 'image' ? 'reference' : token.type === 'footnote_ref' ? 'note' : null
      if (kind) output.push(`${String(token.type)}:${names ? detachedDefinitionLabel(names, kind, token.label) : token.label}`)
      else if (token.type === 'footnote_missing') output.push('footnote_missing:' + token.label)
    }
    for (const child of token.inlineNote?.tokens ?? []) visit(child, output)
    for (const child of token.children ?? []) visit(child, output)
  }
  for (const unit of facts.units) {
    const sequence = result.get(unit.blockId) ?? []
    visit(unit.semantic, sequence)
    if (sequence.length) result.set(unit.blockId, sequence)
  }
  return result
}
