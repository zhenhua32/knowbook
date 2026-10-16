import type Database from 'better-sqlite3'
import type { SyncedCanonicalWire, SyncedGroupSnapshot, SyncedLinkBinding, SyncedLinkTarget, SyncedOriginV1 } from '../../shared/synced-blocks'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { findWikiHeading, parseWikiReference, resolveWikiDocument, wikiDocumentPaths } from '../../shared/markdownWiki'
import { isSyncedUuid, SyncedValidationError, validateSyncedBindings, validateSyncedCanonicalWire, validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { BlockIdentityRepository } from './block-identities'
import { decodeMarkdownFormat } from '../../shared/markdownFormat'

type Occurrence = Omit<SyncedLinkBinding, 'target'> & { url: string }
type DocumentRow = { id: string; path: string; title: string }
function fail(message: string): never { throw new SyncedValidationError('binding', message) }
const key = (value: Omit<SyncedLinkBinding, 'target'>) => JSON.stringify([value.blockId, value.from, value.to, value.raw, value.syntax])

/** Definitions are captured at their actual destination, never at each use.
 * The whole forest parser decides which references are active. */
function occurrences(origin: SyncedOriginV1, blocks: readonly SyncedCanonicalWire[]): Occurrence[] {
  const result: Occurrence[] = []
  for (const link of collectDocumentMarkdownLinks([...blocks])) {
    if (link.kind === 'image') continue
    if (!link.blockId || link.end < link.start) fail('实际链接无法映射到 canonical 块范围。')
    const wiki = link.kind === 'wiki'
    if (!wiki && !resolveMarkdownDocumentPath(origin.pathAtCreation, link.url)) continue
    if (link.end === link.start) fail('空链接目的地尚无可保护的绑定范围，当前内部写入保留草稿。')
    const block = blocks[link.blockIndex]
    result.push({ blockId: link.blockId, from: link.start, to: link.end,
      raw: block.content.slice(link.start, link.end), syntax: wiki ? 'wiki' : 'markdown', url: link.url })
  }
  return result
}

function checkStoredTarget(db: Database.Database, target: SyncedLinkTarget, plannedGroupId?: string): void {
  if (target.kind !== 'block') return
  // Captured target state/owner hints can outlive a rename, deletion or move.
  // Only the stable ID is authoritative. Never replace it from the old URL.
  const identities = new BlockIdentityRepository(db)
  const identity = identities.get(target.id)
  const owner = identities.resolveLiveOwner(target.id)
  if (!identity) {
    if (plannedGroupId && target.documentId === null && target.state === 'live'
      && db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(plannedGroupId)) return
    fail('已知块目标缺少保留身份；不能按名称重新绑定。')
  }
  if (plannedGroupId && (identity.owner.kind !== 'group' || identity.owner.id !== plannedGroupId)) {
    fail('候选 canonical 目标身份仍由其它归属保留。')
  }
  if (owner?.kind === 'group' && !db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(owner.id)) {
    fail('已知 canonical 目标缺少真实同步组。')
  }
}

/** Validate a trusted journal/persisted side without reinterpreting its targets
 * against today's paths. Historical state hints are not executable resolution. */
export function assertSyncedStoredBindings(db: Database.Database, origin: SyncedOriginV1,
  blocks: readonly SyncedCanonicalWire[], bindings: readonly SyncedLinkBinding[], plannedGroupId?: string): void {
  const checkedOrigin = validateSyncedOrigin(origin), checkedBlocks = validateSyncedCanonicalWire(blocks)
  const checked = validateSyncedBindings(bindings, checkedBlocks), parsed = occurrences(checkedOrigin, checkedBlocks)
  const actual = new Map(parsed.map(item => [key(item), item]))
  const candidateIds = new Set(checkedBlocks.map(block => block.id))
  if (actual.size !== parsed.length || checked.length !== actual.size) fail('链接绑定未准确覆盖实际 Markdown 目的地。')
  const seen = new Set<string>()
  for (const binding of checked) {
    const identity = key(binding)
    if (!actual.has(identity) || seen.has(identity)) fail('链接绑定范围与实际语法不一致。')
    seen.add(identity)
    checkStoredTarget(db, binding.target, plannedGroupId && binding.target.kind === 'block' && candidateIds.has(binding.target.id) ? plannedGroupId : undefined)
  }
}

function targetFor(db: Database.Database, origin: SyncedOriginV1, occurrence: Occurrence,
  candidate?: { groupId: string; ids: ReadonlySet<string> }): SyncedLinkTarget {
  const wiki = occurrence.syntax === 'wiki'
  const byPath = db.prepare('SELECT id,path,title FROM documents WHERE path=?')
  const byId = db.prepare('SELECT id,path,title FROM documents WHERE id=?')
  const pathLookup = (path: string) => byPath.get(path) as DocumentRow | undefined
    ?? (wiki ? db.prepare('SELECT id,path,title FROM documents WHERE path=? COLLATE NOCASE').get(path) as DocumentRow | undefined : undefined)
  const reference = wiki ? parseWikiReference(occurrence.url) : null
  const local = wiki ? null : parseLocalMarkdownUrl(occurrence.url)!
  const bare = wiki ? !reference!.path : !local!.path
  const resolvedWiki = wiki && !bare ? resolveWikiDocument(occurrence.url, origin.pathAtCreation, {
    byPath: pathLookup,
    byTitle: title => db.prepare('SELECT id,path,title FROM documents WHERE title=? COLLATE NOCASE ORDER BY id').all(title) as DocumentRow[]
  }) : null
  const resolved = wiki ? null : resolveMarkdownDocumentPath(origin.pathAtCreation, occurrence.url)!
  const path = bare ? origin.pathAtCreation : wiki
    ? resolvedWiki?.document.path ?? wikiDocumentPaths(reference!.path, origin.pathAtCreation)[0] ?? reference!.path : resolved!.path
  const fragment = resolvedWiki?.reference.fragment ?? (wiki ? reference!.fragment : resolved!.fragment)
  // A bare fragment always belongs to the immutable origin document, even if
  // another document has since occupied its former path.
  const document = bare ? byId.get(origin.documentId) as DocumentRow | undefined
    : resolvedWiki?.document ?? pathLookup(path)
  const unresolved = (): SyncedLinkTarget => ({ kind: 'unresolved-url', path, fragment: fragment || null })
  if (wiki && !document && !reference!.hasFragment) {
    const identities = new BlockIdentityRepository(db), identity = identities.get(reference!.target)
    if (identity) {
      const owner = identities.resolveLiveOwner(identity.id)
      const route = Boolean(db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?')
        .get(origin.pathAtCreation, identity.id))
      if (owner?.kind === 'document' && owner.id === origin.documentId
        || !owner && identity.owner.kind === 'document' && identity.owner.id === origin.documentId || route) {
        return { kind: 'block', id: identity.id,
          documentId: owner?.kind === 'document' ? owner.id : owner ? null
            : identity.owner.kind === 'document' ? identity.owner.id : null, state: owner ? 'live' : 'missing' }
      }
    }
  }
  if (!fragment) return bare ? { kind: 'document', id: origin.documentId, state: document ? 'live' : 'missing' }
    : document ? { kind: 'document', id: document.id, state: 'live' } : unresolved()
  const blockId = fragment.startsWith('^') ? fragment.slice(1) : fragment
  if (bare && (fragment.startsWith('^') || isSyncedUuid(fragment)) && candidate?.ids.has(blockId)) {
    // Main has already checked candidate ownership/creation metadata. Resolve
    // self/cross references against that final graph, without a fake ledger row.
    const target: SyncedLinkTarget = { kind: 'block', id: blockId, documentId: null, state: 'live' }
    checkStoredTarget(db, target, candidate.groupId)
    return target
  }
  const identities = new BlockIdentityRepository(db), identity = identities.get(blockId)
  if (identity) {
    const owner = identities.resolveLiveOwner(blockId)
    const route = Boolean(db.prepare('SELECT 1 FROM document_block_routes WHERE document_path=? AND block_id=?').get(path, blockId))
    const matches = owner?.kind === 'document' && owner.id === document?.id
      || !owner && identity.owner.kind === 'document' && identity.owner.id === document?.id
      || bare && fragment.startsWith('^') && owner?.kind === 'group' || route
    if (matches) return { kind: 'block', id: blockId,
      documentId: owner?.kind === 'document' ? owner.id : owner ? null
        : identity.owner.kind === 'document' ? identity.owner.id : null, state: owner ? 'live' : 'missing' }
  }
  if (fragment.startsWith('^') || isSyncedUuid(fragment)) return unresolved()
  if (!document) return bare ? { kind: 'heading', documentId: origin.documentId, slug: fragment, state: 'missing' } : unresolved()
  const rows = db.prepare(`SELECT id,type,content,checked,depth,parent_block_id,language,list_start,markdown_format_json
    FROM blocks WHERE document_id=? ORDER BY sort_order`).all(document.id) as Array<{
      id: string; type: string; content: string; checked: number; depth: number; parent_block_id: string | null
      language: string | null; list_start: number | null; markdown_format_json: string | null
    }>
  // Heading namespace projection is a separate production integration. Do not
  // misreport a canonical heading as absent by parsing reference JSON as text.
  if (rows.some(row => row.type === 'synced-block')) fail('该宿主的标题目标需要完整同步块投影，当前内部写入保留草稿。')
  const blocks = rows.map(row => ({ id: row.id, type: row.type, content: row.content, checked: row.checked === 1,
    depth: row.depth, parentBlockId: row.parent_block_id, language: row.language ?? undefined,
    listStart: row.list_start ?? undefined, markdownFormat: decodeMarkdownFormat(row.type, row.markdown_format_json) }))
  const headings = getMarkdownHeadingTargets(blocks, document.title)
  const heading = wiki ? findWikiHeading(fragment, headings) : headings.find(item => item.slug === fragment)
  return { kind: 'heading', documentId: document.id, slug: heading?.slug ?? fragment, state: heading ? 'live' : 'missing' }
}

/** For a newly planned group only; Main owns resolution and later reservations. */
export function captureSyncedGroupBindings(db: Database.Database, origin: SyncedOriginV1,
  blocks: readonly SyncedCanonicalWire[]): SyncedLinkBinding[] {
  const checkedOrigin = validateSyncedOrigin(origin), checkedBlocks = validateSyncedCanonicalWire(blocks)
  return occurrences(checkedOrigin, checkedBlocks).map(occurrence => {
    const { url: _url, ...range } = occurrence
    return { ...range, target: targetFor(db, checkedOrigin, occurrence) }
  })
}

type Change = { prefix: number; oldEnd: number; newEnd: number; delta: number }
function changedSpan(before: string, after: string): Change {
  let prefix = 0, suffix = 0
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++
  while (suffix < Math.min(before.length, after.length) - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  return { prefix, oldEnd: before.length - suffix, newEnd: after.length - suffix, delta: after.length - before.length }
}

/** Conservative old/new-only fallback. No URL map can prove split/join/copy
 * provenance; ambiguous edits are refused until a real editor trace is wired. */
export function maintainSyncedGroupBindings(db: Database.Database, before: SyncedGroupSnapshot,
  blocks: readonly SyncedCanonicalWire[]): SyncedLinkBinding[] {
  assertSyncedStoredBindings(db, before.origin, before.blocks, before.bindings)
  const checked = validateSyncedCanonicalWire(blocks), oldBlocks = new Map(before.blocks.map(block => [block.id, block]))
  const newBlocks = new Map(checked.map(block => [block.id, block])), oldParsed = occurrences(before.origin, before.blocks)
  const candidateScope = { groupId: before.groupId, ids: new Set(newBlocks.keys()) }
  const newParsed = occurrences(before.origin, checked), newRanges = new Map(newParsed.map(item => [key(item), item]))
  const oldRanges = new Map(oldParsed.map(item => [key(item), item])), mapped = new Map<string, SyncedLinkBinding>()
  const oldUrls = new Set(oldParsed.map(item => item.url))
  const changes = new Map<string, Change>()
  for (const block of checked) {
    const previous = oldBlocks.get(block.id)
    if (previous) changes.set(block.id, changedSpan(previous.content, block.content))
  }
  for (const binding of before.bindings) {
    const block = newBlocks.get(binding.blockId), change = changes.get(binding.blockId)
    if (!block || !change) continue
    let from: number, to: number
    if (binding.to <= change.prefix) { from = binding.from; to = binding.to }
    else if (binding.from >= change.oldEnd) { from = binding.from + change.delta; to = binding.to + change.delta }
    else continue
    const candidate = { ...binding, from, to, raw: block.content.slice(from, to) }, found = newRanges.get(key(candidate))
    if (found && found.url === oldRanges.get(key(binding))!.url) mapped.set(key(candidate), candidate)
  }
  const additions = newParsed.filter(item => !mapped.has(key(item)))
  if (mapped.size !== before.bindings.length && additions.length) fail('链接范围无法证明延续；不能从相同 URL 推断拆分、合并或替换来源。')
  for (const occurrence of additions) {
    if (oldUrls.has(occurrence.url)) fail('重复目的地需要明确的复制来源，不能按 URL 选择旧目标。')
    const change = changes.get(occurrence.blockId)
    if (change && (occurrence.from < change.prefix || occurrence.to > change.newEnd)) {
      fail('新生效的链接不在实际新文字范围内，不能自动认领原有文字。')
    }
    const { url: _url, ...range } = occurrence
    mapped.set(key(occurrence), { ...range, target: targetFor(db, before.origin, occurrence, candidateScope) })
  }
  const bindings = newParsed.map(item => mapped.get(key(item))!)
  assertSyncedStoredBindings(db, before.origin, checked, bindings, before.groupId)
  return bindings
}
