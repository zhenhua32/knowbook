import type { Node as PMNode } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from 'prosemirror-transform'
import { markdownEngine, markdownTokenTree, type MarkdownEnvironment, type MarkdownToken } from '@shared/markdownEngine'
import { serializeMarkdownWithBlockRanges } from '@shared/markdown'
import { collectDocumentMarkdownLinks } from '@shared/markdownLinkMaintenance'
import { capturedMarkdownSourceLinks } from '@shared/markdownSourceLinks'
import { resolveMarkdownDocumentPath } from '@shared/markdownLinks'
import { assertNativeContainerParse } from '@shared/markdownContainers'
import { NATIVE_LITERAL_MARKER } from '@shared/markdownNativeText'
import type { SyncedBindingKey, SyncedCanonicalEdit, SyncedOriginV1 } from '@shared/synced-blocks'
import { validateSyncedCanonicalEdit, validateSyncedOrigin } from '@shared/syncedBlockValidation'

/** Opaque syntax facts only. Main still checks the complete AST and targets. */
export interface RichActualKeyCache { readonly revision: number }
export interface RichActualKeysEvidence {
  readonly mode: 'full' | 'incremental'
  readonly reason: string
  readonly dirtyBlockIds: readonly string[]
  readonly parsedBlockIds: readonly string[]
}
export interface RichActualKeysInput {
  doc: PMNode
  blocks: readonly SyncedCanonicalEdit[]
  origin: Readonly<SyncedOriginV1>
}
export interface RichActualKeysBatch {
  before: PMNode
  transactions: readonly Transaction[]
  after: PMNode
  blocks: readonly SyncedCanonicalEdit[]
  origin: Readonly<SyncedOriginV1>
}
export interface RichActualKeysResult {
  readonly cache: RichActualKeyCache
  readonly keys: readonly Readonly<SyncedBindingKey>[]
  readonly evidence: RichActualKeysEvidence
}
type Entry = { node: PMNode; pos: number }
type ParsedDestination = Readonly<SyncedBindingKey & { url: string; image: boolean }>
type Data = { doc: PMNode; blocks: readonly SyncedCanonicalEdit[]; origin: Readonly<SyncedOriginV1>;
  keys: readonly Readonly<SyncedBindingKey>[]; byBlock: ReadonlyMap<string, readonly Readonly<SyncedBindingKey>[]>;
  certificates: ReadonlySet<string>; entries: ReadonlyMap<string, Entry>; grammar: readonly unknown[] }
const caches = new WeakMap<RichActualKeyCache, Data>()
let revision = 0
const keyId = (key: Readonly<SyncedBindingKey>) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const inlineTypes = new Set(['text', 'code_inline', 'link_open', 'link_close', 'strong_open', 'strong_close',
  'em_open', 'em_close', 's_open', 's_close', 'mark_open', 'mark_close'])
const simpleSource = (source: string) => !!source && !/[\r\n\uFEFF\0<]/.test(source) && !source.includes(NATIVE_LITERAL_MARKER)
const paragraph = (block: SyncedCanonicalEdit) => block.type === 'paragraph' && block.depth === 0 && block.parentBlockId === null && simpleSource(block.content)
const inlineAllowed = (token: MarkdownToken) => inlineTypes.has(token.type) && !token.meta?.html && !token.meta?.unsupportedHtml
  // Unconsumed delimiter-looking text is deliberately not certified. This is
  // a fallback gate, not another recognizer for links or balanced markup.
  && (token.type !== 'text' || !/[\\[\]`*_~=<>]/.test(token.content))
const local = (origin: Readonly<SyncedOriginV1>, url: string) => resolveMarkdownDocumentPath(origin.pathAtCreation, url) !== null

function metadata(block: SyncedCanonicalEdit): unknown {
  const { content: _content, ...rest } = block
  return rest
}
function snapshot(blocks: readonly SyncedCanonicalEdit[]): readonly SyncedCanonicalEdit[] {
  const result = validateSyncedCanonicalEdit(blocks)
  for (const block of result) {
    if (block.tags) Object.freeze(block.tags)
    if (block.markdownFormat) Object.freeze(block.markdownFormat)
    Object.freeze(block)
  }
  return Object.freeze(result)
}
function entries(doc: PMNode): Map<string, Entry> {
  const result = new Map<string, Entry>()
  doc.descendants((node, pos) => {
    if (!node.isBlock) return false
    const id = node.attrs.block?.id
    if (typeof id === 'string') result.set(id, { node, pos })
    return node.type.name === 'columns_block' || node.type.name === 'column_block'
  })
  return result
}
/** Only grammar configuration, never source/URL matching. Capture own option
 * values and the installed rule functions, including alternate chains. */
function grammar(): readonly unknown[] {
  const values: unknown[] = [markdownEngine.parse, markdownEngine.parseInline, markdownEngine.block.parse,
    markdownEngine.inline.parse, markdownEngine.core.process, markdownEngine.normalizeLink, markdownEngine.validateLink]
  for (const [name, value] of Object.entries(markdownEngine.options)) values.push(name, value)
  for (const ruler of [markdownEngine.core.ruler, markdownEngine.block.ruler, markdownEngine.inline.ruler, markdownEngine.inline.ruler2]) {
    for (const rule of ruler.__rules__) values.push(rule.name, rule.enabled, rule.fn, ...(rule.alt ?? []), null)
  }
  // The configured shared engine has no runtime parser plugin API, but public
  // linkify set/add changes must invalidate an existing syntax certificate.
  const linkify = markdownEngine.linkify as unknown as { __opts__?: Record<string, unknown>; __schemas__?: Record<string, unknown> }
  for (const [name, value] of Object.entries(linkify.__opts__ ?? {})) values.push(name, value)
  for (const [name, value] of Object.entries(linkify.__schemas__ ?? {})) {
    values.push(name)
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) values.push(key, item)
    else values.push(value)
    values.push(null)
  }
  return values
}
const sameGrammar = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((value, index) => value === right[index])
function fullKeys(blocks: readonly SyncedCanonicalEdit[], origin: Readonly<SyncedOriginV1>): readonly Readonly<SyncedBindingKey>[] {
  return Object.freeze(collectDocumentMarkdownLinks([...blocks]).flatMap(link => {
    if (link.kind === 'image' || link.kind !== 'wiki' && !local(origin, link.url)) return []
    const block = blocks[link.blockIndex]
    return [Object.freeze({ blockId: block.id, from: link.start, to: link.end,
      raw: block.content.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' as const : 'markdown' as const })]
  }))
}
function indexKeys(keys: readonly Readonly<SyncedBindingKey>[]): Map<string, readonly Readonly<SyncedBindingKey>[]> {
  const grouped = new Map<string, Readonly<SyncedBindingKey>[]>()
  for (const key of keys) { const values = grouped.get(key.blockId) ?? []; values.push(key); grouped.set(key.blockId, values) }
  return new Map([...grouped].map(([id, values]) => [id, Object.freeze(values)]))
}
function isolated(source: string): readonly ParsedDestination[] | null {
  if (!simpleSource(source)) return null
  const env: MarkdownEnvironment = { captureSourceLinks: true }
  const tokens = markdownEngine.parse(source, env)
  if (tokens.length !== 3 || tokens[0].type !== 'paragraph_open' || tokens[1].type !== 'inline' || tokens[2].type !== 'paragraph_close'
    || tokens[0].level !== 0 || tokens[0].map?.[0] !== 0 || tokens[0].map?.[1] !== 1
    || !tokens[1].children?.every(inlineAllowed) || Object.keys(env.references ?? {}).length || env.footnotes) return null
  // Placeholder blockId is replaced only after this actual block parse succeeds.
  return capturedMarkdownSourceLinks(env).map(link => Object.freeze({ blockId: '', from: link.start, to: link.end,
    raw: source.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' as const : 'markdown' as const,
    url: link.url, image: link.kind === 'image' }))
}

/** Cold/fallback only. A second complete actual parse builds boundary facts;
 * the existing complete collector above remains the semantic oracle. */
function certify(blocks: readonly SyncedCanonicalEdit[], doc: PMNode,
  byBlock: ReadonlyMap<string, readonly Readonly<SyncedBindingKey>[]>, origin: Readonly<SyncedOriginV1>): ReadonlySet<string> {
  const result = new Set<string>()
  if (!blocks.some(paragraph)) return result
  try {
    const serialized = serializeMarkdownWithBlockRanges([...blocks]), source = serialized.markdown
    // These contexts intentionally stay on the full path in this first slice.
    if (/[\r\uFEFF\0<]/.test(source) || source.includes(NATIVE_LITERAL_MARKER)) return result
    const env: MarkdownEnvironment = {}, tokens = markdownEngine.parse(source, env)
    assertNativeContainerParse(env)
    if (Object.keys(env.references ?? {}).length || env.footnotes
      || tokens.some(token => token.type.startsWith('footnote'))) return result
    const roots = markdownTokenTree(tokens), lines = source.split('\n'), actualEntries = entries(doc)
    const coverage = new Uint32Array(lines.length)
    for (const root of roots) if (root.token.map) for (let line = Math.max(0, root.token.map[0]); line < Math.min(lines.length, root.token.map[1]); line++) coverage[line]++
    const paragraphs = new Map(roots.filter(root => root.token.type === 'paragraph_open').map(root => [root.token.map?.[0], root]))
    for (const range of serialized.ranges) {
      const block = blocks[range.index], entry = actualEntries.get(block.id), root = paragraphs.get(range.startLine)
      if (!paragraph(block) || entry?.node.type.name !== 'text_block' || range.endLine !== range.startLine + 1
        || lines[range.startLine] !== block.content || !root || root.token.level !== 0 || root.token.map?.[1] !== range.endLine
        || root.children.length !== 1 || root.children[0].token.type !== 'inline'
        || !root.children[0].children.every(child => inlineAllowed(child.token))) continue
      if (range.startLine > 0 && lines[range.startLine - 1] !== '' || range.endLine < lines.length && lines[range.endLine] !== '') continue
      if (coverage[range.startLine] !== 1) continue
      const parsed = isolated(block.content)
      if (!parsed) continue
      const actual = parsed.filter(link => !link.image && local(origin, link.url)).map(link => keyId({ ...link, blockId: block.id }))
      const complete = (byBlock.get(block.id) ?? []).map(keyId)
      const known = new Set(complete)
      if (actual.length === complete.length && new Set(actual).size === actual.length && actual.every(key => known.has(key))) result.add(block.id)
    }
  } catch { /* Missing a certificate never changes complete collector semantics. */ }
  return result
}
function result(data: Data, mode: RichActualKeysEvidence['mode'], reason: string, dirty: readonly string[], parsed: readonly string[]): RichActualKeysResult {
  const cache = Object.freeze({ revision: ++revision }); caches.set(cache, data)
  return Object.freeze({ cache, keys: data.keys, evidence: Object.freeze({ mode, reason,
    dirtyBlockIds: Object.freeze([...dirty]), parsedBlockIds: Object.freeze([...parsed]) }) })
}
function complete(input: RichActualKeysInput, reason: string, dirty: readonly string[] = []): RichActualKeysResult {
  const blocks = snapshot(input.blocks), origin = Object.freeze(validateSyncedOrigin(input.origin)), keys = fullKeys(blocks, origin), byBlock = indexKeys(keys)
  return result({ doc: input.doc, blocks, origin, keys, byBlock, entries: entries(input.doc),
    certificates: certify(blocks, input.doc, byBlock, origin), grammar: grammar() }, 'full', reason, dirty, blocks.map(block => block.id))
}
export function createRichActualKeyCache(input: RichActualKeysInput): RichActualKeysResult { return complete(input, 'cold') }

function dirtyBlocks(saved: Data, batch: RichActualKeysBatch): { ids: Set<string>; valid: boolean } {
  const ids = new Set<string>()
  let doc = batch.before
  for (const tr of batch.transactions) {
    if (tr.before !== doc || tr.docs.length !== tr.steps.length || tr.mapping.maps.length !== tr.steps.length) return { ids, valid: false }
    for (let index = 0; index < tr.steps.length; index++) {
      const step = tr.steps[index], before = tr.docs[index], after = tr.docs[index + 1] ?? tr.doc
      if (before !== doc || !(step instanceof AddMarkStep || step instanceof RemoveMarkStep || step instanceof ReplaceStep)) return { ids, valid: false }
      if (step instanceof ReplaceStep && (step.slice.openStart || step.slice.openEnd || !step.slice.content.content.every(node => node.isInline))) return { ids, valid: false }
      const from = before.resolve(step.from), to = before.resolve(step.to)
      if (from.depth !== 1 || from.parent !== to.parent || from.parent.type.name !== 'text_block') return { ids, valid: false }
      const id = from.parent.attrs.block?.id
      if (typeof id !== 'string' || !saved.certificates.has(id)) return { ids, valid: false }
      const nextFrom = after.resolve(step.from), nextTo = after.resolve(step instanceof ReplaceStep ? step.from + step.slice.size : step.to)
      if (nextFrom.depth !== 1 || nextFrom.parent !== nextTo.parent || nextFrom.parent.type.name !== 'text_block'
        || nextFrom.parent.attrs.block?.id !== id) return { ids, valid: false }
      const applied = step.apply(before)
      if (!applied.doc || !applied.doc.eq(after)) return { ids, valid: false }
      ids.add(id); doc = after
    }
    if (doc !== tr.doc) return { ids, valid: false }
  }
  return { ids, valid: doc === batch.after }
}

/** A successful fast result still contains the complete actual inventory.
 * The caller must compare every emission against it, then Main rechecks all. */
export function prepareRichActualKeys(cache: RichActualKeyCache, batch: RichActualKeysBatch): RichActualKeysResult {
  const saved = caches.get(cache), input = { doc: batch.after, blocks: batch.blocks, origin: batch.origin }
  if (!saved || saved.doc !== batch.before) return complete(input, 'stale-cache')
  if (!same(saved.origin, batch.origin)) return complete(input, 'origin')
  if (!sameGrammar(saved.grammar, grammar())) return complete(input, 'grammar')
  let dirty: ReturnType<typeof dirtyBlocks>
  try { dirty = dirtyBlocks(saved, batch) } catch { return complete(input, 'step-context') }
  const ids = [...dirty.ids]
  if (!dirty.valid) return complete(input, 'step-context', ids)
  const blocks = snapshot(batch.blocks), nextEntries = entries(batch.after)
  if (blocks.length !== saved.blocks.length || nextEntries.size !== saved.entries.size) return complete(input, 'topology', ids)
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], old = saved.blocks[index], entry = nextEntries.get(block.id), previous = saved.entries.get(block.id)
    if (!old || !same(metadata(block), metadata(old)) || !entry || !previous || entry.node.type !== previous.node.type) return complete(input, 'topology', ids)
    if (!dirty.ids.has(block.id) && (block.content !== old.content || entry.node !== previous.node)) return complete(input, 'unchanged-context', ids)
    if (dirty.ids.has(block.id) && (!paragraph(block) || !saved.certificates.has(block.id))) return complete(input, 'source-context', ids)
  }
  const byBlock = new Map(saved.byBlock), parsed: string[] = []
  for (const id of ids) {
    const block = blocks.find(block => block.id === id)!, old = saved.blocks.find(block => block.id === id)!
    if (block.content === old.content) continue // Syntax is unchanged; link intent is still checked separately by the caller.
    let destinations: ReturnType<typeof isolated>
    try { destinations = isolated(block.content) } catch { return complete(input, 'local-parse', ids) }
    if (!destinations) return complete(input, 'local-parse', ids)
    const keys = destinations.filter(link => !link.image && local(saved.origin, link.url)).map(link => Object.freeze({
      blockId: id, from: link.from, to: link.to, raw: link.raw, syntax: link.syntax }))
    if (new Set(keys.map(keyId)).size !== keys.length || keys.some(key => !Number.isSafeInteger(key.from) || !Number.isSafeInteger(key.to) || key.from < 0 || key.to < key.from
      || key.to > block.content.length || block.content.slice(key.from, key.to) !== key.raw)) return complete(input, 'local-range', ids)
    byBlock.set(id, Object.freeze(keys)); parsed.push(id)
  }
  const keys = Object.freeze(blocks.flatMap(block => [...(byBlock.get(block.id) ?? [])]))
  return result({ ...saved, doc: batch.after, blocks, keys, byBlock, entries: nextEntries }, 'incremental', 'isolated-root-paragraph', ids, parsed)
}
