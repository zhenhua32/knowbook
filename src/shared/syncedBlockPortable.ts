import type { SyncedCanonicalWire, SyncedGroupWire, SyncedLinkBinding, SyncedStableBlockDraft } from './synced-blocks'
import { collectMarkdownDestinations, escapeMarkdownDestination, type MarkdownDestination } from './markdownLinks'
import { parseFragment } from 'parse5'
import { canBlockNestUnder } from './blockTypes'
import {
  SYNCED_GROUP_MAX_BYTES, SYNCED_MAX_BLOCKS, SYNCED_MAX_DEPTH, SYNCED_PROJECTED_MAX_BYTES, SyncedValidationError,
  assertSyncedShape, parseSyncedBlockPayload, syncedPlainRecord, validateSyncedBindings, validateSyncedGroupWire, validateSyncedHostForest
} from './syncedBlockValidation'

export const SYNCED_ASSET_BUDGET_HASH = '0'.repeat(64)
const hashPattern = /^[a-f0-9]{64}$/
const assetPrefix = 'knowbook-asset://'
const encoder = new TextEncoder()

export interface SyncedPortableAsset { hash: string; name: string; encodedName: string }
export interface SyncedPortableBudget { blocks: number; bytes: number }
export interface SyncedPortableHostRecord {
  kind: 'document'
  id: string
  parentId: string | null
  sortOrder: number
  createdAt: string
  content: { title: string; summary: string; blocks: SyncedStableBlockDraft[] }
}

function invalidAsset(): never { throw new SyncedValidationError('binding', '同步块附件地址无效或不是规范拼写。') }
function overBudget(): never { throw new SyncedValidationError('budget', '同步块或宿主展开内容超过大小或块数限制。') }

/** The closed set of names produced by the existing AttachmentStore filename
 * builder. This validates only a name, never a filesystem path or file bytes. */
function safeName(name: unknown): name is string {
  // The existing builder bounds the clean name first, then prefixes reserved
  // Windows device names. Only that exact result can have 121 code units.
  const bounded = typeof name === 'string' && (name.length <= 120
    || name.length === 121 && /^_(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))
  return typeof name === 'string' && name.length > 0 && bounded && name === name.trim()
    && !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) && !/[. ]$/.test(name) && name !== '.' && name !== '..'
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
}

/** Canonical means the project's existing encodeURIComponent builder, including
 * its literal !'()* characters; it does not introduce a new RFC3986 spelling. */
export function buildSyncedPortableAssetUri(asset: { hash: string; name: string }): string {
  if (!asset || !hashPattern.test(asset.hash) || !safeName(asset.name)) return invalidAsset()
  try { return `${assetPrefix}${asset.hash}/${encodeURIComponent(asset.name)}` } catch { return invalidAsset() }
}

export function parseSyncedPortableAssetUri(uri: string): SyncedPortableAsset {
  if (typeof uri !== 'string') return invalidAsset()
  // Do not let URL normalization hide credentials, ports, dot segments, a
  // trailing slash, uppercase hashes, query/fragment or alternate encodings.
  const match = /^knowbook-asset:\/\/([a-f0-9]{64})\/([^/?#]+)$/.exec(uri)
  if (!match) return invalidAsset()
  let name: string
  try { name = decodeURIComponent(match[2]) } catch { return invalidAsset() }
  const asset = { hash: match[1], name, encodedName: match[2] }
  if (buildSyncedPortableAssetUri(asset) !== uri) return invalidAsset()
  return asset
}

export function syncedPortableAssetBackupPath(uri: string): string {
  const asset = parseSyncedPortableAssetUri(uri)
  return `__knowbook/assets/attachments/${asset.hash.slice(0, 2)}/${asset.hash}/${asset.name}`
}

/** A syntactic budget projection only. A matching path is NOT proof that the
 * file belongs to this workspace, exists, is safe or has this content hash. */
export function syncedManagedAssetBudgetUri(uri: string): string {
  let parsed: URL
  try { parsed = new URL(uri) } catch { return invalidAsset() }
  if (parsed.protocol !== 'file:' || parsed.hostname && parsed.hostname !== 'localhost'
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return invalidAsset()
  const match = /\/attachments\/([a-f0-9]{2})\/([a-f0-9]{64})\/([^/]+)$/.exec(parsed.pathname)
  if (!match || match[1] !== match[2].slice(0, 2)) return invalidAsset()
  let name: string
  try { name = decodeURIComponent(match[3]) } catch { return invalidAsset() }
  return buildSyncedPortableAssetUri({ hash: SYNCED_ASSET_BUDGET_HASH, name })
}

export function canonicalSyncedPortableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item)
}

type ContentEdit = { from: number; to: number; text: string }
type RewrittenText = { text: string; edits: ContentEdit[] }
export type SyncedAssetMapper = (uri: string) => string

function assetUrl(uri: string) { return /^(?:file:|knowbook-asset:)/i.test(uri) }
const portableParseScheme = 'file:///_______' // Exactly 15 UTF-16 units, like knowbook-asset:.
const portableSourceScheme = new RegExp([...assetPrefix.slice(0, -2)].map(char => {
  const codes = [...new Set([char.charCodeAt(0), char.toUpperCase().charCodeAt(0)])]
  // HTML attribute entities have the same logical URL semantics as the public
  // HTML parser. Capture the scheme too, so malformed URLs cannot hide behind
  // numeric entity spellings; this is not a scan for arbitrary config strings.
  return `(?:${char}|${codes.map(code => `&#0*${code};?|&#x0*${code.toString(16)};?`).join('|')}${char === ':' ? '|&colon;' : ''})`
}).join(''), 'gi')

/** Source capture for portable records only; this grants no render permission.
 * The normal HTML grammar intentionally excludes the portable URI scheme. An
 * equal-length local parsing alias lets that same grammar locate destinations
 * without changing original UTF-16 ranges or its code/literal exclusions. */
export function collectSyncedMarkdownAssetDestinations(source: string): MarkdownDestination[] {
  const schemes = new Map<number, { scheme: string; alias: string }>()
  const parseSource = source.replace(portableSourceScheme, (scheme: string, from: number) => {
    const alias = 'file:///' + '_'.repeat(scheme.length - 8)
    schemes.set(from, { scheme, alias })
    return alias
  })
  return collectMarkdownDestinations(parseSource).flatMap(destination => {
    // The alias must not grant a previously plain portable-looking word the
    // file: linkifier's bare-autolink semantics. Real file: autolinks retain
    // their original capture and are materialized by replacement below.
    if (destination.kind === 'autolink' && destination.syntax === 'bare' && schemes.has(destination.start)) return []
    let url = destination.url
    if (destination.syntax === 'html' && url.startsWith(portableParseScheme)) {
      // Decode actual HTML attribute entities, but never URL-normalize away
      // dot segments, aliases or whitespace before the strict URI check.
      const raw = source.slice(destination.start, destination.end)
      const element = parseFragment(`<a href="${raw.replace(/"/g, '&quot;')}"></a>`).childNodes[0]
      const original = element && 'attrs' in element ? element.attrs.find(attr => attr.name === 'href')?.value : undefined
      if (original && /^\s*knowbook-asset:/i.test(original)) {
        parseSyncedPortableAssetUri(original)
        url = original
      } else if (original !== undefined) url = original.trim()
      else return invalidAsset()
    } else {
      const scheme = schemes.get(destination.start)
      if (scheme !== undefined) {
        if (!url.startsWith(scheme.alias)) return invalidAsset()
        url = scheme.scheme + url.slice(scheme.alias.length)
        parseSyncedPortableAssetUri(url)
      }
    }
    return assetUrl(url) ? [{ ...destination, url }] : []
  })
}
function replacement(source: string, destination: MarkdownDestination, uri: string): ContentEdit {
  if (destination.syntax === 'wiki') return { from: destination.start, to: destination.end, text: escapeMarkdownDestination(uri, 'wiki') }
  if (destination.syntax === 'html') return { from: destination.start, to: destination.end, text: escapeMarkdownDestination(uri, 'html') }
  if (destination.kind === 'autolink') {
    const label = source.slice(destination.start, destination.end).replace(/[\\\[\]]/g, '\\$&')
    const brackets = destination.syntax === 'bare' ? 0 : 1
    return { from: destination.start - brackets, to: destination.end + brackets, text: `[${label}](<${uri}>)` }
  }
  const angled = source[destination.start - 1] === '<' && source[destination.end] === '>'
  return { from: destination.start, to: destination.end, text: angled ? uri : `<${uri}>` }
}

type AssetOutputValidator = (source: string, next: string) => void
function validatePortableOutput(_source: string, next: string): void { parseSyncedPortableAssetUri(next) }
/** Syntactic conversion only: neither workspace-root nor real file/byte authority. */
function validateLocalizedOutput(source: string, next: string): void {
  const asset = parseSyncedPortableAssetUri(source)
  let parsed: URL
  try { parsed = new URL(next) } catch { return invalidAsset() }
  if (parsed.protocol !== 'file:' || parsed.hostname || parsed.username || parsed.password || parsed.port
    || parsed.search || parsed.hash || parsed.href !== next) return invalidAsset()
  const match = /\/attachments\/([a-f0-9]{2})\/([a-f0-9]{64})\/([^/]+)$/.exec(parsed.pathname)
  if (!match || match[1] !== asset.hash.slice(0, 2) || match[2] !== asset.hash) return invalidAsset()
  let decodedName: string
  try { decodedName = decodeURIComponent(match[3]) } catch { return invalidAsset() }
  // Match Main pathToFileURL plus its explicit escaping; portable-name encoding differs.
  const encodedName = encodeURI(asset.name).replace(/[!'()*~#]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  if (decodedName !== asset.name || match[3] !== encodedName) return invalidAsset()
}
function localizingMapper(map: SyncedAssetMapper): SyncedAssetMapper {
  return source => { parseSyncedPortableAssetUri(source); return map(source) }
}
function rewriteText(source: string, map: SyncedAssetMapper, validateOutput: AssetOutputValidator = validatePortableOutput): RewrittenText {
  const edits: ContentEdit[] = []
  for (const destination of collectSyncedMarkdownAssetDestinations(source)) {
    const next = map(destination.url)
    validateOutput(destination.url, next)
    if (next === destination.url) continue
    const edit = replacement(source, destination, next), previous = edits.at(-1)
    if (previous && edit.from < previous.to) {
      if (previous.from === edit.from && previous.to === edit.to && previous.text === edit.text) continue
      throw new SyncedValidationError('binding', '附件来源范围重叠，未改写正文。')
    }
    edits.push(edit)
  }
  let text = source
  for (const edit of [...edits].reverse()) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to)
  return { text, edits }
}

const markdownTypes = new Set(['paragraph', 'html', 'quote', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list', 'table', 'callout', 'toggle'])
const opaqueTypes = new Set(['code', 'code-block', 'math', 'frontmatter', 'divider', 'columns', 'column', 'database-view', 'synced-block'])
function rewriteBlock<T extends SyncedStableBlockDraft>(block: T, map: SyncedAssetMapper, validateOutput: AssetOutputValidator = validatePortableOutput): { block: T; edits: ContentEdit[] } {
  if (opaqueTypes.has(block.type)) return { block: { ...block }, edits: [] }
  if (!markdownTypes.has(block.type) && !/^heading-[1-6]$/.test(block.type)) {
    throw new SyncedValidationError('forest', '未知内容块没有附件投影规则。')
  }
  const content = rewriteText(block.content, map, validateOutput)
  // Current finite MarkdownBlockFormat fields are enums, scalars or literal
  // code info. None is an asset-bearing field; never recursively walk strings.
  return { block: { ...block, content: content.text }, edits: content.edits }
}

function rewriteBinding(binding: SyncedLinkBinding, content: string, edits: ContentEdit[]): SyncedLinkBinding {
  let from = binding.from, to = binding.to
  for (const edit of edits) {
    const delta = edit.text.length - (edit.to - edit.from)
    if (edit.to <= binding.from) { from += delta; to += delta }
    else if (edit.from >= binding.to) continue
    else if (binding.from <= edit.from && edit.to <= binding.to) to += delta
    else throw new SyncedValidationError('binding', '附件改写穿过链接绑定边界，未改写正文。')
  }
  return { ...binding, from, to, raw: content.slice(from, to), target: { ...binding.target } }
}

/** Only real parsed block Markdown destinations are visited. Origin, source IDs,
 * DB config/query/value, code/math/YAML and arbitrary format strings are opaque.
 * The caller must separately verify actual file bytes before using real hashes. */
function rewrittenGroup(input: SyncedGroupWire, map: SyncedAssetMapper, validateOutput: AssetOutputValidator): SyncedGroupWire {
  const group = validateSyncedGroupWire(input)
  const rewritten = group.blocks.map(block => rewriteBlock(block, map, validateOutput)), byId = new Map(rewritten.map(item => [item.block.id, item]))
  const blocks: SyncedCanonicalWire[] = rewritten.map(item => item.block)
  const bindings = group.bindings.map(binding => {
    const item = byId.get(binding.blockId)!
    return rewriteBinding(binding, item.block.content, item.edits)
  })
  validateSyncedBindings(bindings, blocks)
  return { ...group, blocks, bindings }
}

export function rewriteSyncedGroupAssets(input: SyncedGroupWire, map: SyncedAssetMapper): SyncedGroupWire {
  return rewrittenGroup(input, map, validatePortableOutput)
}
/** Pure portable-to-managed conversion. Main must separately prove root, aliases and actual bytes. */
export function localizeSyncedPortableGroupAssets(input: SyncedGroupWire, map: SyncedAssetMapper): SyncedGroupWire {
  return rewrittenGroup(input, localizingMapper(map), validateLocalizedOutput)
}

function portable(uri: string): string { parseSyncedPortableAssetUri(uri); return uri }
function placeholder(uri: string): string {
  if (/^file:/i.test(uri)) return syncedManagedAssetBudgetUri(uri)
  const asset = parseSyncedPortableAssetUri(uri)
  return buildSyncedPortableAssetUri({ ...asset, hash: SYNCED_ASSET_BUDGET_HASH })
}
function groupCount(input: unknown) {
  if (syncedPlainRecord(input) && Array.isArray(input.blocks) && input.blocks.length > SYNCED_MAX_BLOCKS) overBudget()
}

export function measureSyncedPortableGroup(input: SyncedGroupWire): SyncedPortableBudget {
  groupCount(input)
  const group = rewriteSyncedGroupAssets(input, portable), bytes = encoder.encode(canonicalSyncedPortableJson(group)).byteLength
  if (bytes > SYNCED_GROUP_MAX_BYTES) overBudget()
  return { blocks: group.blocks.length, bytes }
}

/** Returns measurements only, never a publishable record with fabricated hashes. */
export function projectSyncedGroupBudget(input: SyncedGroupWire): SyncedPortableBudget {
  groupCount(input)
  return measureSyncedPortableGroup(rewriteSyncedGroupAssets(input, placeholder))
}

function rewrittenHost(host: SyncedPortableHostRecord, map: SyncedAssetMapper, validateOutput: AssetOutputValidator = validatePortableOutput): SyncedPortableHostRecord {
  assertSyncedShape(host, ['kind', 'id', 'parentId', 'sortOrder', 'createdAt', 'content'])
  assertSyncedShape(host.content, ['title', 'summary', 'blocks'])
  if (!host || host.kind !== 'document' || typeof host.id !== 'string' || !host.id.trim()
    || host.parentId !== null && (typeof host.parentId !== 'string' || !host.parentId.trim()) || !Number.isSafeInteger(host.sortOrder)
    || typeof host.createdAt !== 'string' || !Number.isFinite(Date.parse(host.createdAt))
    || !host.content || typeof host.content.title !== 'string' || typeof host.content.summary !== 'string' || !Array.isArray(host.content.blocks)) {
    throw new SyncedValidationError('forest', '宿主附件预算输入无效。')
  }
  if (host.content.blocks.length > SYNCED_MAX_BLOCKS) overBudget()
  const blocks = validateSyncedHostForest(host.content.blocks).map(block => rewriteBlock(block, map, validateOutput).block)
  return { kind: 'document', id: host.id, parentId: host.parentId, sortOrder: host.sortOrder, createdAt: host.createdAt,
    content: { title: host.content.title, summary: rewriteText(host.content.summary, map, validateOutput).text, blocks } }
}

function measureHost(host: SyncedPortableHostRecord, groups: ReadonlyMap<string, SyncedGroupWire>): SyncedPortableBudget {
  const checked = new Map<string, SyncedGroupWire>()
  const parentTypes = new Map(host.content.blocks.map(block => [block.id, block.type]))
  let count = 0, bytes = encoder.encode(canonicalSyncedPortableJson({ ...host, content: { ...host.content, blocks: [] } })).byteLength
  if (bytes > SYNCED_PROJECTED_MAX_BYTES) overBudget()
  const add = (block: SyncedStableBlockDraft) => {
    if (++count > SYNCED_MAX_BLOCKS) overBudget()
    bytes += encoder.encode(canonicalSyncedPortableJson(block)).byteLength + (count > 1 ? 1 : 0)
    if (bytes > SYNCED_PROJECTED_MAX_BYTES) overBudget()
  }
  for (const block of host.content.blocks) {
    if (block.type !== 'synced-block') { add(block); continue }
    const { groupId } = parseSyncedBlockPayload(block.content)
    let group = checked.get(groupId)
    if (!group) {
      const source = groups.get(groupId)
      if (!source || source.id !== groupId) throw new SyncedValidationError('binding', '缺少准确同步块快照，无法计算宿主预算。')
      measureSyncedPortableGroup(source)
      group = validateSyncedGroupWire(source); checked.set(groupId, group)
    }
    if (count + group.blocks.length > SYNCED_MAX_BLOCKS) overBudget()
    if (block.parentBlockId !== null) {
      const parentType = parentTypes.get(block.parentBlockId)
      if (!parentType || group.blocks.some(child => child.depth === 0 && !canBlockNestUnder(parentType, child.type)))
        throw new SyncedValidationError('forest', '同步块根类型不能展开到宿主父块中。')
    }
    for (const { createdAt: _createdAt, ...child } of group.blocks) {
      const depth = block.depth + child.depth
      if (depth > SYNCED_MAX_DEPTH) throw new SyncedValidationError('depth', '宿主展开同步块超过六层。')
      add({ ...child, depth, parentBlockId: child.parentBlockId ?? block.parentBlockId })
    }
  }
  // This is an equivalent wire measurement, NOT a persistable/materialized
  // forest. Repeated child IDs remain scoped occurrences and are counted each
  // time; canonical IDs/parent IDs retain their exact byte lengths, createdAt
  // is omitted like a document edit row. This is not the byte size of a later
  // public materialization that allocates fresh per-occurrence UUIDs. No owner,
  // identity, bindings or source content is changed by this measurement.
  return { blocks: count, bytes }
}

export function measureSyncedPortableHost(host: SyncedPortableHostRecord, groups: ReadonlyMap<string, SyncedGroupWire>): SyncedPortableBudget {
  return measureHost(rewrittenHost(host, portable), groups)
}

export function projectSyncedHostBudget(host: SyncedPortableHostRecord, groups: ReadonlyMap<string, SyncedGroupWire>): SyncedPortableBudget {
  const required = new Map<string, SyncedGroupWire>()
  const projected = rewrittenHost(host, placeholder)
  for (const block of projected.content.blocks) if (block.type === 'synced-block') {
    const { groupId } = parseSyncedBlockPayload(block.content)
    if (required.has(groupId)) continue
    const group = groups.get(groupId)
    if (!group || group.id !== groupId) throw new SyncedValidationError('binding', '缺少准确同步块快照，无法计算宿主预算。')
    groupCount(group)
    required.set(groupId, rewriteSyncedGroupAssets(group, placeholder))
  }
  return measureHost(projected, required)
}

/** The same typed asset visitor used by real Main snapshot publication and its strict reader. */
export function rewriteSyncedPortableHostAssets(host: SyncedPortableHostRecord, map: SyncedAssetMapper): SyncedPortableHostRecord {
  return rewrittenHost(host, map)
}
/** Pure portable-to-managed conversion using the same typed visitor, without file or persistence authority. */
export function localizeSyncedPortableHostAssets(host: SyncedPortableHostRecord, map: SyncedAssetMapper): SyncedPortableHostRecord {
  return rewrittenHost(host, localizingMapper(map), validateLocalizedOutput)
}
