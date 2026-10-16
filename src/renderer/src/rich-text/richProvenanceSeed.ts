import type { Node as PMNode } from 'prosemirror-model'
import type { MarkdownEnvironment, MarkdownNode, MarkdownToken } from '@shared/markdownEngine'
import { createMarkdownLinkProvenanceContext, type MarkdownInlineLinkProvenance, type MarkdownInlineWithLinkProvenance } from '@shared/markdownLinkProvenance'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'
import type { SyncedBindingKey, SyncedCanonicalEdit, SyncedOriginV1 } from '@shared/synced-blocks'
import { validateSyncedCanonicalEdit, validateSyncedOrigin } from '@shared/syncedBlockValidation'
import { draftBlocksToRichDoc, richBlockEntries, type RichProvenanceSeedPort } from './model'
import { richLinkOccurrence } from './linkProvenance'

export interface RichProvenanceSeedLink {
  readonly token: string
  readonly ownerBlockId: string
  readonly sourceKey: Readonly<SyncedBindingKey>
  readonly via: 'direct' | 'reference'
  readonly role: 'current-direct' | 'definition-use-copy'
  /** Absolute positions in the returned PM doc, not Markdown source ranges. */
  readonly pmSpans: readonly Readonly<{ from: number; to: number }>[]
}
export interface RichProvenanceSeedBlock {
  readonly blockId: string
  readonly node: PMNode
  readonly pos: number
  readonly kind: 'rich' | 'atom'
  readonly keys: readonly Readonly<SyncedBindingKey>[]
}
export interface RichProvenanceSeed {
  readonly generation: string
  readonly doc: PMNode
  readonly blocks: readonly SyncedCanonicalEdit[]
  readonly origin: Readonly<SyncedOriginV1>
  readonly links: readonly RichProvenanceSeedLink[]
  /** An atom occurrence is identified by this generation and its actual pos.
   * Structural column nodes have no inline mark and normally own no keys. */
  readonly blockRecords: readonly RichProvenanceSeedBlock[]
  readonly sourceInventory: readonly Readonly<SyncedBindingKey>[]
}
export interface SeedRichProvenanceInput {
  blocks: readonly SyncedCanonicalEdit[]
  origin: SyncedOriginV1
  externalReferences?: MarkdownEnvironment['references']
  createToken?: () => string
}
const identity = (key: SyncedBindingKey) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
function invalid(): never { throw new Error('富文本来源与实际同步正文不一致，请保留草稿后重新打开编辑器。') }

/** A mount/rebase seed only. It does not interpret typed targets, run on each
 * keypress, install a writer, or authorize a controller mutation. */
export function seedRichProvenance(input: SeedRichProvenanceInput): RichProvenanceSeed {
  const blocks = validateSyncedCanonicalEdit(input.blocks), origin = Object.freeze(validateSyncedOrigin(input.origin))
  const context = createMarkdownLinkProvenanceContext(blocks)
  const sourceInventory: Readonly<SyncedBindingKey>[] = []
  const physical = new Map<string, Readonly<SyncedBindingKey>>(), byBlock = new Map<string, Readonly<SyncedBindingKey>[]>()
  for (const destination of context.sourceDestinations) {
    if (destination.kind === 'image' || destination.kind !== 'wiki' && !resolveMarkdownDocumentPath(origin.pathAtCreation, destination.url)) continue
    const { blockIndex, blockId, from, to, raw, syntax } = destination.key
    if (!blockId || blocks[blockIndex]?.id !== blockId) invalid()
    const key = Object.freeze({ blockId, from, to, raw, syntax }), id = identity(key)
    if (physical.has(id)) invalid()
    physical.set(id, key); sourceInventory.push(key)
    const keys = byBlock.get(blockId) ?? []; keys.push(key); byBlock.set(blockId, keys)
  }
  const generation = crypto.randomUUID(), used = new Set<string>([generation])
  const fresh = () => {
    const token = input.createToken ? input.createToken() : crypto.randomUUID()
    if (typeof token !== 'string' || !token.trim() || used.has(token)) invalid()
    used.add(token); return token
  }
  type Candidate = { owner: number; sourceKey: Readonly<SyncedBindingKey>; via: 'direct' | 'reference'; spans: Array<{ from: number; to: number }> }
  const candidates = new Map<string, Candidate>(), consumed = new WeakSet<MarkdownToken>()
  const parsed = new Map<number, MarkdownInlineWithLinkProvenance & { sourceOnly?: boolean }>()
  const local = (token: MarkdownToken) => resolveMarkdownDocumentPath(origin.pathAtCreation, String(token.attrGet('href') ?? '')) !== null
  const proofKey = (proof: MarkdownInlineLinkProvenance | undefined): Readonly<SyncedBindingKey> | undefined => {
    const destination = proof?.destination
    return destination?.blockId ? physical.get(identity({ ...destination, blockId: destination.blockId })) : undefined
  }
  const port: RichProvenanceSeedPort = {
    parseInline(index, block, references) {
      if (block.id !== blocks[index]?.id || block.content !== blocks[index].content || block.type !== blocks[index].type) invalid()
      const cached = parsed.get(index)
      if (cached) return cached
      const result = context.parseInline(index, references), direct = new Set<string>()
      let sourceOnly = false
      const visit = (nodes: MarkdownNode[]) => {
        for (const { token, children } of nodes) {
          if (token.type === 'link_open' && local(token)) {
            const proof = result.provenance.get(token), key = proofKey(proof)
            if (!proof?.use || !key) sourceOnly = true
            else if (proof.via === 'direct') direct.add(identity(key))
          }
          if (token.type !== 'image') visit(children)
        }
      }
      visit(result.nodes)
      // A raw definition/Wiki/unrendered destination cannot disappear just
      // because this block happened to pass the ordinary rich syntax probe.
      if ((byBlock.get(block.id!) ?? []).some(key => !direct.has(identity(key)))) sourceOnly = true
      const value = { ...result, ...(sourceOnly ? { sourceOnly: true } : {}) }; parsed.set(index, value); return value
    },
    link(index, token, proof) {
      if (!local(token)) return { kind: 'external' }
      const sourceKey = proofKey(proof)
      if (!proof?.use || !sourceKey) return { kind: 'source-only' }
      if (consumed.has(token)) invalid()
      consumed.add(token)
      const occurrence = fresh()
      candidates.set(occurrence, { owner: index, sourceKey, via: proof.via, spans: [] })
      return { kind: 'tracked', token: occurrence }
    },
    piece(index, token, from, to) {
      const candidate = candidates.get(token)
      if (!candidate || candidate.owner !== index || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) invalid()
      candidate.spans.push({ from, to })
    }
  }
  const doc = draftBlocksToRichDoc(blocks, input.externalReferences, port), entries = richBlockEntries(doc)
  if (entries.length !== blocks.length) invalid()
  const blockRecords: RichProvenanceSeedBlock[] = entries.map(({ node, pos, index }) => {
    const block = blocks[index]
    if (node.attrs.block?.id !== block.id || node.attrs.block.content !== block.content) invalid()
    return Object.freeze({ blockId: block.id, node, pos, kind: node.type.name === 'text_block' ? 'rich' : 'atom',
      keys: Object.freeze([...(byBlock.get(block.id) ?? [])]) })
  })
  const links: RichProvenanceSeedLink[] = []
  const liveTokens = blockRecords.map(record => new Set(record.node.content.content.flatMap(child => child.marks
    .filter(mark => mark.type.name === 'link').map(richLinkOccurrence))))
  const continued = new Set<string>()
  for (const [token, candidate] of candidates) {
    const record = blockRecords[candidate.owner]
    if (record.kind !== 'rich') continue // A later unsupported child discarded this whole tentative rich conversion.
    if (!liveTokens[candidate.owner].has(token) || !candidate.spans.length || candidate.spans.some(span => span.to > record.node.content.size)) invalid()
    if (candidate.via === 'direct') { if (record.blockId !== candidate.sourceKey.blockId) invalid(); continued.add(identity(candidate.sourceKey)) }
    links.push(Object.freeze({ token, ownerBlockId: record.blockId, sourceKey: candidate.sourceKey, via: candidate.via,
      role: candidate.via === 'reference' ? 'definition-use-copy' : 'current-direct',
      pmSpans: Object.freeze(candidate.spans.map(span => Object.freeze({ from: record.pos + 1 + span.from, to: record.pos + 1 + span.to }))) }))
  }
  for (const record of blockRecords) if (record.kind === 'rich' && record.keys.some(key => !continued.has(identity(key)))) invalid()
  for (const block of blocks) { if (block.tags) Object.freeze(block.tags); if (block.markdownFormat) Object.freeze(block.markdownFormat); Object.freeze(block) }
  return Object.freeze({ generation, doc, blocks: Object.freeze(blocks), origin, links: Object.freeze(links),
    blockRecords: Object.freeze(blockRecords), sourceInventory: Object.freeze(sourceInventory) })
}
