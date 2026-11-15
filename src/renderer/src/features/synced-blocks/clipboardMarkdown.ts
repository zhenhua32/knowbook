import type { DocumentBlockDraft } from '@shared/contracts'
import { collectBlockTransferNamespaceEdits } from '@shared/documentBlockTransferLinks'
import { serializeBlocksToMarkdown, serializeMarkdownWithBlockRanges } from '@shared/markdown'
import { markdownEngine, type MarkdownEnvironment, type MarkdownToken } from '@shared/markdownEngine'
import { collectDocumentMarkdownLinks } from '@shared/markdownLinkMaintenance'
import { escapeMarkdownDestination, parseLocalMarkdownUrl } from '@shared/markdownLinks'
import { parseWikiReference } from '@shared/markdownWiki'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '@shared/synced-blocks'
import { expandSyncedGraphDocument, validateSyncedWorkspaceGraph } from '@shared/syncedBlockGraph'
import { syncedCanonicalEdits } from '@shared/syncedBlockValidation'

type Edit = { blockIndex: number; start: number; end: number; replacement: string }
type Labels = { reference: Map<string, string>; note: Map<string, string> }
type Definitions = { reference: Record<string, { href: string; title: string }>; note: string[]; consumers: string[] }
const unsupported = () => new Error('The clipboard cannot preserve the selected Markdown references or notes.')
const capturedConsumer = (kind: string, label: string, suffix: unknown[]) => JSON.stringify([kind, label, ...suffix])

function applyEdits<T extends DocumentBlockDraft>(blocks: readonly T[], edits: readonly Edit[]): T[] {
  const grouped = new Map<number, Edit[]>()
  for (const edit of edits) {
    const group = grouped.get(edit.blockIndex) ?? []
    group.push(edit); grouped.set(edit.blockIndex, group)
  }
  return blocks.map((block, index) => {
    const changes = grouped.get(index)
    if (!changes) return block
    let content = block.content, boundary = content.length
    for (const { start, end, replacement } of changes.sort((a, b) => b.start - a.start || b.end - a.end)) {
      if (start < 0 || end < start || end > boundary) throw unsupported()
      content = content.slice(0, start) + replacement + content.slice(end)
      boundary = start
    }
    return { ...block, content }
  })
}

/** Use the real parser's physical destination spans. Literal examples and
 * other documents' destinations never acquire a copied identity. */
export function rewriteClipboardLocalBlockLinks<T extends DocumentBlockDraft>(blocks: readonly T[], ids: ReadonlyMap<string, string>,
  selection: ReadonlySet<string> = new Set(blocks.flatMap(block => block.id ? [block.id] : []))): T[] {
  const edits: Edit[] = []
  for (const link of collectDocumentMarkdownLinks([...blocks])) {
    if (!link.blockId || !selection.has(link.blockId)) continue
    if (link.kind === 'wiki') {
      const parsed = parseWikiReference(link.url)
      if (parsed.path || !parsed.hasFragment || !parsed.fragment.startsWith('^')) continue
      const fresh = ids.get(parsed.fragment.slice(1)), raw = blocks[link.blockIndex].content.slice(link.start, link.end)
      const hash = raw.indexOf('#'), end = raw.indexOf('|'), target = raw.slice(hash + 1, end < 0 ? raw.length : end)
      const offset = target.indexOf(parsed.fragment)
      if (!fresh || hash < 0 || offset < 0 || target.trim() !== parsed.fragment) continue
      const start = link.start + hash + 1 + offset
      edits.push({ blockIndex: link.blockIndex, start, end: start + parsed.fragment.length, replacement: '^' + fresh })
    } else if (link.kind !== 'image' && link.kind !== 'autolink' && link.url.startsWith('#')) {
      const local = parseLocalMarkdownUrl(link.url)
      const fresh = local?.fragment.startsWith('^') ? ids.get(local.fragment.slice(1)) : undefined
      if (fresh) edits.push({ blockIndex: link.blockIndex, start: link.start, end: link.end,
        replacement: escapeMarkdownDestination('#^' + fresh, link.syntax) })
    }
  }
  return applyEdits(blocks, edits)
}

function definitions(markdown: string, includesRange?: (start: number, end: number) => boolean): Definitions {
  const environment: MarkdownEnvironment = {}
  const tokens = markdownEngine.parse(markdown, environment), consumers: string[] = []
  const notes = environment.footnotes as { refs?: Record<string, number>; list?: Array<{ tokens?: MarkdownToken[] }> } | undefined
  const visit = (token: MarkdownToken): void => {
    const label = token.meta?.label
    if (typeof label === 'string') {
      if (token.type === 'link_open' || token.type === 'image') consumers.push(capturedConsumer('reference', label, [token.attrGet('href') ?? token.attrGet('src'), token.attrGet('title')]))
      if (token.type === 'footnote_ref' || token.type === 'footnote_missing') consumers.push(capturedConsumer(token.type, label, []))
    } else if (token.type === 'footnote_ref' && typeof token.meta?.id === 'number') {
      for (const child of notes?.list?.[token.meta.id]?.tokens ?? []) visit(child)
    }
    for (const child of token.children ?? []) visit(child)
  }
  for (const token of tokens) if (!includesRange || token.map && includesRange(token.map[0], token.map[1])) visit(token)
  return { reference: environment.references ?? {}, note: Object.keys(notes?.refs ?? {}).map(key => key.slice(1)), consumers: consumers.sort() }
}

const serialize = (blocks: DocumentBlockDraft[]) => serializeBlocksToMarkdown(blocks, { fallbackCodeLanguage: 'txt' })
const orderedEntries = (reference: Definitions['reference']) => Object.entries(reference).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)

/** A selected ordinary consumer may depend on a definition beyond the selected
 * roots. Compare its original parser result before writing an independent copy. */
export function assertClipboardIndependentlySerializable(complete: DocumentBlockDraft[], selection: DocumentBlockDraft[], start: number, end: number) {
  if (complete.length === selection.length) return
  const { markdown, ranges } = serializeMarkdownWithBlockRanges(complete, { fallbackCodeLanguage: 'txt' })
  const selectedLines = new Set<number>()
  for (const range of ranges) if (range.index >= start && range.index <= end) {
    for (let line = range.startLine; line < range.endLine; line++) selectedLines.add(line)
  }
  const original = definitions(markdown, first => selectedLines.has(first))
  const chosen = definitions(serialize(selection))
  if (JSON.stringify(original.consumers) !== JSON.stringify(chosen.consumers)) throw unsupported()
  for (const [label, value] of orderedEntries(chosen.reference)) {
    if (JSON.stringify(original.reference[label]) !== JSON.stringify(value)) throw unsupported()
  }
}


/** A public Markdown projection is independent per occurrence. The compact
 * internal clipboard keeps the original shared groups and their link bindings. */
export function renderPublicSyncedClipboard(documentId: string, blocks: SyncedStableBlockDraft[], wires: SyncedGroupWire[]): string {
  const graph = validateSyncedWorkspaceGraph([{ documentId, blocks }], wires)
  const original = definitions(serialize(blocks)), expectedRef = new Map(orderedEntries(original.reference)), expectedNotes = [...original.note]
  const expectedConsumers = [...original.consumers]
  const byOccurrence = new Map<string, ReturnType<typeof syncedCanonicalEdits>>()
  const reserved = new Set([...expectedRef.keys(), ...expectedNotes])
  const groups = new Map(wires.map(wire => [wire.id, wire]))
  const groupDefinitions = new Map(wires.map(wire => [wire.id, definitions(serialize(syncedCanonicalEdits(wire.blocks)))]))
  for (const owners of [blocks, ...wires.map(wire => wire.blocks)]) for (const { content } of owners) {
    for (const match of content.matchAll(/knowbook-copy-[0-9]+/gi)) reserved.add(match[0].toLowerCase())
  }
  let ordinal = 0
  const nextName = () => {
    let name: string
    do { name = 'knowbook-copy-' + ++ordinal } while (reserved.has(name) || reserved.has(name.toUpperCase()))
    reserved.add(name); return name
  }
  for (const [groupId, occurrences] of graph.occurrences) {
    const body = syncedCanonicalEdits(groups.get(groupId)!.blocks), facts = groupDefinitions.get(groupId)!
    for (const occurrence of occurrences) {
      const names: Labels = { reference: new Map(), note: new Map() }
      for (const label of Object.keys(facts.reference)) names.reference.set(label, nextName())
      for (const label of facts.note) names.note.set(label, nextName())
      const namespaced = applyEdits(body, collectBlockTransferNamespaceEdits(body, names)), checked = definitions(serialize(namespaced))
      for (const [label, target] of orderedEntries(facts.reference)) {
        const fresh = markdownEngine.utils.normalizeReference(names.reference.get(label)!)
        if (JSON.stringify(checked.reference[fresh]) !== JSON.stringify(target)) throw unsupported()
        expectedRef.set(fresh, target)
      }
      const renamedNotes = facts.note.map(label => names.note.get(label)!).sort()
      if (JSON.stringify([...checked.note].sort()) !== JSON.stringify(renamedNotes)) throw unsupported()
      expectedNotes.push(...renamedNotes)
      const consumers = facts.consumers.map(item => {
        const [kind, label, ...rest] = JSON.parse(item) as string[]
        const next = kind === 'reference' ? markdownEngine.utils.normalizeReference(names.reference.get(label)!) : names.note.get(label) ?? label
        return JSON.stringify([kind, next, ...rest])
      }).sort()
      if (JSON.stringify(checked.consumers) !== JSON.stringify(consumers)) throw unsupported()
      expectedConsumers.push(...consumers)
      byOccurrence.set(occurrence.instanceId, namespaced)
    }
  }
  const scopeBlock = new Map<string, DocumentBlockDraft>([...byOccurrence].flatMap(([instance, body]) => body.map(block => [JSON.stringify([instance, block.id]), block])))
  const id = (instanceId: string | null, blockId: string) => JSON.stringify([instanceId, blockId])
  const expanded = Array.from(expandSyncedGraphDocument(graph, documentId), ({ block, depth, parent, instanceId }) => ({
    ...(instanceId ? scopeBlock.get(id(instanceId, block.id))! : block), id: id(instanceId, block.id), depth,
    parentBlockId: parent ? id(parent.instanceId, parent.blockId) : null
  }))
  const markdown = serialize(expanded), actual = definitions(markdown)
  const signatures = (reference: Definitions['reference'], note: string[], consumers: string[]) => JSON.stringify([orderedEntries(reference), note.sort(), consumers.sort()])
  if (signatures(actual.reference, actual.note, actual.consumers) !== signatures(Object.fromEntries(expectedRef), expectedNotes, expectedConsumers)) throw unsupported()
  return markdown
}
