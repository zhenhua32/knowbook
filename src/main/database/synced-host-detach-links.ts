import type Database from 'better-sqlite3'
import type { SyncedBindingKey, SyncedGroupWire, SyncedLinkTarget } from '../../shared/synced-blocks'
import { canonicalSyncedPortableJson as encode } from '../../shared/syncedBlockPortable'
import { markdownEngine } from '../../shared/markdownEngine'
import { collectDocumentMarkdownLinks } from '../../shared/markdownLinkMaintenance'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference } from '../../shared/markdownWiki'
import { syncedCanonicalEdits } from '../../shared/syncedBlockValidation'
import { readRawBlockIdentity, resolveRawLiveBlockOwner } from './block-identities-raw-read'
import { renderNavigation3Destination, type Navigation3Destination, type Navigation3FinalTarget } from './restore-knowledge-navigation3-rewrite-cells'
import { captureSyncedCreateBindings } from './synced-block-links'
import { captureSyncedCreateSourceFacts, createPhysicalKey, UnsupportedSyncedHostCreate } from './synced-host-create-plan'
import { createDetachRangeProjection, projectDetachedHost, type DetachBlockId, type DetachTextEdit } from './synced-host-detach-plan'
import { detachConsumerTrace, detachedDefinitionLabel, planDetachDefinitionNamespace } from './synced-host-detach-namespace'
import type { HostContent } from './synced-host-document-read'
import { readSyncedBindingSources } from './synced-stored-binding-read'
import { planDetachedHeadingProofs, type DetachHeadingProof, type DetachLiveHeading } from './synced-host-detach-heading'
import { MarkdownLinkIndex } from './markdown-link-index'
import { renderDetachedUnresolvedDestination, type DetachUnresolvedTarget } from './synced-host-detach-unresolved'
import { planDetachedCanonicalTarget, type DetachCanonicalCopyTarget } from './synced-host-detach-canonical'

type Facts = ReturnType<typeof captureSyncedCreateSourceFacts>
type DocumentTarget = { documentId: string; path: string; createdAt: string }
type LiveCopyTarget = { target: Extract<SyncedLinkTarget, { kind: 'document' | 'block' | 'heading' }>;
  documentCreatedAt: string; blockCreatedAt: string | null; heading?: DetachHeadingProof; canonical?: never }
type CopyTarget = LiveCopyTarget | DetachCanonicalCopyTarget
  | { target: DetachUnresolvedTarget; documentCreatedAt: null; blockCreatedAt: null; heading?: never; canonical?: never }

export interface DetachCopiedLink {
  source: SyncedBindingKey
  destination: SyncedBindingKey
  url: string
  resolved: CopyTarget
}

export interface DetachSourceProjection {
  edits: DetachTextEdit[]
  links: DetachCopiedLink[]
  namespaceEdits?: DetachTextEdit[]
}

function unproved(): never { throw new UnsupportedSyncedHostCreate('semantic-binding') }

function documentTarget(db: Database.Database, documentId: string): DocumentTarget {
  const row = db.prepare('SELECT id AS documentId,path,created_at AS createdAt FROM documents WHERE id=?').get(documentId) as DocumentTarget | undefined
  if (!row || !Number.isFinite(Date.parse(row.createdAt))) return unproved()
  return row
}

function destinationTarget(db: Database.Database, stored: SyncedLinkTarget, host: DocumentTarget, sourceGroupId: string, instanceId: string,
  allocation: ReadonlyMap<string, string>, freshBirths: ReadonlyMap<string, string>,
  heading: DetachLiveHeading | undefined): { render: Navigation3FinalTarget; proof: LiveCopyTarget } {
  if (stored.kind === 'unresolved-url' || stored.state !== 'live') return unproved()
  if (stored.kind === 'heading') {
    const document = documentTarget(db, stored.documentId)
    if (!heading || heading.documentCreatedAt !== document.createdAt) return unproved()
    return { render: { kind: 'heading', documentId: document.documentId, documentPath: document.path, slug: stored.slug }, proof: { ...heading, target: stored } }
  }
  if (stored.kind === 'document') {
    const document = documentTarget(db, stored.id)
    return { render: { kind: 'document', documentId: document.documentId, documentPath: document.path },
      proof: { target: stored, documentCreatedAt: document.createdAt, blockCreatedAt: null } }
  }
  const copiedId = allocation.get(stored.id)
  if (stored.id === instanceId) return unproved()
  const oldIdentity = readRawBlockIdentity(db, stored.id), oldOwner = resolveRawLiveBlockOwner(db, stored.id)
  if (!oldIdentity?.createdAt || !oldOwner) return unproved()
  if (copiedId ? oldOwner.kind !== 'group' || oldOwner.id !== sourceGroupId : oldOwner.kind !== 'document') return unproved()
  const document = copiedId ? host : documentTarget(db, oldOwner.id)
  const id = copiedId ?? stored.id, birth = copiedId ? freshBirths.get(copiedId) : oldIdentity.createdAt
  if (!birth) return unproved()
  return { render: { kind: 'block', documentId: document.documentId, documentPath: document.path, blockId: id },
    proof: { target: { kind: 'block', id, documentId: document.documentId, state: 'live' }, documentCreatedAt: document.createdAt, blockCreatedAt: birth } }
}

function definitionsMatch(working: Facts, canonical: Facts, final: Facts, copies: ReadonlyMap<string, string>,
  project: (blockId: string, from: number, to: number) => { from: number; to: number }, namespace: ReturnType<typeof planDetachDefinitionNamespace>): void {
  const insertions = new Map(namespace.edits.filter(edit => edit.from === edit.to).map(edit => [encode([edit.blockId, edit.from]), edit.after.length]))
  const relocate = (item: Facts['definitions'][number]) => {
    const { from, to } = project(item.blockId, item.from, item.to)
    // A shortcut selector inserted at the end of a definition is part of it.
    return { ...item, from, to: to + (insertions.get(encode([item.blockId, item.to])) ?? 0),
      label: detachedDefinitionLabel(namespace.names, item.kind, item.label), blockId: copies.get(item.blockId) ?? unproved() }
  }
  const signatures = (items: readonly Facts['definitions'][number][]) => items.map(item => encode(item)).sort()
  if (encode(signatures([...working.definitions, ...canonical.definitions.map(relocate)])) !== encode(signatures(final.definitions))) return unproved()
  const effective = new Map(working.effective)
  for (const definition of canonical.effective.values()) {
    const moved = relocate(definition), label = moved.kind + ':' + moved.label
    if (effective.has(label)) return unproved()
    effective.set(label, moved)
  }
  if (effective.size !== final.effective.size || [...effective].some(([label, item]) => encode(item) !== encode(final.effective.get(label) ?? null))) return unproved()
  const expected = detachConsumerTrace(working)
  for (const [id, trace] of detachConsumerTrace(canonical, namespace.names)) expected.set(copies.get(id) ?? unproved(), trace)
  const actual = detachConsumerTrace(final)
  if (actual.size !== expected.size || [...expected].some(([id, trace]) => encode(trace) !== encode(actual.get(id) ?? null))) return unproved()
}

/** The copied text is authoritative only after both complete physical scopes
 * agree with the original typed targets and the ordinary host parser. */
export function planDetachedHostSources(db: Database.Database, host: DocumentTarget, instanceId: string, working: HostContent,
  wire: SyncedGroupWire, allocation: readonly DetachBlockId[], freshBirths: ReadonlyMap<string, string>): {
    after: HostContent; projection: DetachSourceProjection
  } {
  if (!db.inTransaction || encode(documentTarget(db, host.documentId)) !== encode(host)) return unproved()
  const copies = new Map(allocation.map(({ from, to }) => [from, to]))
  const copyIds = new Set(copies.values())
  const workingFacts = captureSyncedCreateSourceFacts(working.blocks)
  const canonicalFacts = captureSyncedCreateSourceFacts(syncedCanonicalEdits(wire.blocks))
  const namespace = planDetachDefinitionNamespace(working.blocks, wire, workingFacts, canonicalFacts)
  const nativeLinks = new Map(collectDocumentMarkdownLinks([...wire.blocks]).map(link => {
    const block = wire.blocks[link.blockIndex]
    return [createPhysicalKey({ blockId: block.id, from: link.start, to: link.end, raw: block.content.slice(link.start, link.end),
      syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }), link] as const
  }))
  const edits: DetachTextEdit[] = []
  const headings = planDetachedHeadingProofs(db, wire, host.documentId)
  let wikiIndex: MarkdownLinkIndex | undefined
  const claims = new Map(readSyncedBindingSources(db, wire.origin, wire.blocks, wire.bindings).map(source => {
    const key = createPhysicalKey(source.key), native = nativeLinks.get(key)
    if (!native || native.url !== source.url || native.kind === 'image') return unproved()
    const link: Navigation3Destination = { key: source.key, url: source.url,
      grammar: { kind: native.kind, syntax: native.kind === 'wiki' ? 'wiki' : native.syntax ?? null } }
    let rendered: { url: string; replacement: string }
    let proof: CopyTarget
    if (source.target.kind === 'unresolved-url') {
      rendered = renderDetachedUnresolvedDestination(link, wire.origin.pathAtCreation, host.path, source.target) ?? unproved()
      if (source.key.syntax === 'wiki') {
        wikiIndex ??= new MarkdownLinkIndex(db)
        if (wikiIndex.resolveWiki(source.url, wire.origin.pathAtCreation)?.exists
          || wikiIndex.resolveWiki(rendered.url, host.path)?.exists) return unproved()
      }
      proof = { target: source.target, documentCreatedAt: null, blockCreatedAt: null }
    } else if (source.target.kind === 'block' && source.target.documentId === null && !copies.has(source.target.id)) {
      const canonical = planDetachedCanonicalTarget(db, wire.id, source.target, link)
      rendered = canonical.rendered
      proof = canonical.proof
    } else {
      const target = destinationTarget(db, source.target, host, wire.id, instanceId, copies, freshBirths, headings.get(key))
      const result = renderNavigation3Destination(link, host, target.render)
      if ('reason' in result) return unproved()
      rendered = result
      proof = target.proof
    }
    if (rendered.replacement !== source.key.raw) {
      edits.push({ blockId: source.key.blockId, from: source.key.from, to: source.key.to, before: source.key.raw, after: rendered.replacement })
    }
    return [key, { source, rendered, target: proof }] as const
  }))
  const allEdits = [...edits, ...namespace.edits], editsByBlock = new Map<string, DetachTextEdit[]>()
  for (const edit of allEdits) {
    const blockEdits = editsByBlock.get(edit.blockId) ?? []
    blockEdits.push(edit)
    editsByBlock.set(edit.blockId, blockEdits)
  }
  const after = projectDetachedHost(working, instanceId, wire, allocation, allEdits)
  const projectors = new Map([...editsByBlock].map(([id, blockEdits]) => [id, createDetachRangeProjection(blockEdits)]))
  const project = (id: string, from: number, to: number) => {
    const projector = projectors.get(id)
    return projector ? projector(from, to) : { from, to }
  }
  const finalFacts = captureSyncedCreateSourceFacts(after.blocks)
  definitionsMatch(workingFacts, canonicalFacts, finalFacts, copies, project, namespace)
  if (encode(workingFacts.units) !== encode(finalFacts.units.filter(unit => !copyIds.has(unit.blockId)))) return unproved()
  const origin = { version: 1 as const, documentId: host.documentId, pathAtCreation: host.path, firstInstanceId: instanceId }
  const finalBindings = new Map(captureSyncedCreateBindings(db, origin, after.blocks).map(link => [createPhysicalKey(link.key), link]))
  const retained = [...finalBindings.values()].filter(link => !copyIds.has(link.key.blockId))
  const previous = captureSyncedCreateBindings(db, origin, working.blocks)
  if (previous.some(link => link.target.kind === 'block' && link.target.id === instanceId) || encode(previous) !== encode(retained)) return unproved()
  const actualCopies = new Map(finalFacts.links.filter(link => copyIds.has(link.key.blockId)).map(link => [createPhysicalKey(link.key), link]))
  if (actualCopies.size !== canonicalFacts.links.length) return unproved()
  const claimedKeys = new Set<string>()
  const links: DetachCopiedLink[] = []
  for (const { key: source, image, url } of canonicalFacts.links) {
    const claimKey = createPhysicalKey(source), claim = claims.get(claimKey)
    if (!claim) {
      const local = parseLocalMarkdownUrl(url)
      if (!image && (source.syntax === 'wiki' || resolveMarkdownDocumentPath(wire.origin.pathAtCreation, url))) return unproved()
      // The physical owner can safely keep network URLs and workspace asset URIs.
      // A relative filesystem destination needs its own admitted source fact.
      if (local && !local.path.startsWith('/') && (image || local.path)) return unproved()
    } else claimedKeys.add(claimKey)
    const position = project(source.blockId, source.from, source.to)
    const destination = { ...source, ...position, blockId: copies.get(source.blockId) ?? unproved(), raw: claim?.rendered.replacement ?? source.raw }
    const key = createPhysicalKey(destination), actual = actualCopies.get(key)
    const renderedUrl = claim?.rendered.url ?? url
    const finalUrl = claim && source.syntax === 'markdown' ? markdownEngine.normalizeLink(renderedUrl) : renderedUrl
    if (!actual || actual.image !== image || actual.url !== finalUrl) return unproved()
    actualCopies.delete(key)
    if (!claim) continue
    const resolved = finalBindings.get(key)
    if (claim.target.canonical && source.syntax === 'markdown') {
      if (resolved) return unproved()
    } else {
      // The legacy Wiki binding scan still sees the explicit address as an
      // unresolved lexical route. Ordinary navigation uses the explicit address.
      const expected = claim.target.canonical ? { kind: 'unresolved-url', path: parseWikiReference(finalUrl).target, fragment: null } : claim.target.target
      if (!resolved || resolved.url !== finalUrl || encode(resolved.target) !== encode(expected)) return unproved()
      if (claim.target.canonical) {
        wikiIndex ??= new MarkdownLinkIndex(db)
        if (wikiIndex.resolveWiki(finalUrl, host.path)?.exists) return unproved()
      }
    }
    links.push({ source, destination, url: finalUrl, resolved: claim.target })
  }
  if (actualCopies.size || claimedKeys.size !== claims.size) return unproved()
  return { after, projection: { edits, links, ...(namespace.edits.length ? { namespaceEdits: namespace.edits } : {}) } }
}
