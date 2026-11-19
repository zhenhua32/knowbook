import Database from 'better-sqlite3'
import type { SyncedLinkBinding, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { expandSyncedGraphDocument, validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { parseSyncedBlockPayload, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { markdownOriginalOffsetLookup } from '../../shared/markdownNativeText'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference, resolveWikiDocument, wikiDocumentPaths } from '../../shared/markdownWiki'
import { freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { capsuleJsonStringBytes, hashBoundedCapsuleJson } from './restore-knowledge-capsule-json-hash'
import { CAPSULE2_RAW_MAX_JSON_BYTES, type Capsule2RawContent, type Capsule2RawSqlRow } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Key, graph3Value, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { withStoredRestoreScopes } from './restore-knowledge-stored-scopes'
import { captureSyncedCreateSourceFacts } from './synced-host-create-plan'

type SourceLocation = { table: 'blocks' | 'synced_group_blocks' | 'documents'; sourceRowId: string; column: 'content' | 'summary';
  blockId: string | null; groupId: string | null; instanceId: string | null;
  blockIdentity: IdentityReference | null; instanceIdentity: IdentityReference | null }
type IdentityReference = { id: string; birth: string; assignmentKey: string | null; targetId: string; ownerKind: 'document' | 'group' | null; ownerId: string | null }
type Heading = ReturnType<typeof getMarkdownHeadingTargets>[number] & { location: SourceLocation | null }
type Side = 'source' | 'current'
type NavigationGraphInputs = Pick<Graph3Inputs, 'inputs' | 'value'>
type Route = { table: 'document_block_routes'; sourceRowId: string; path: string; blockId: string }
type Target =
  | { kind: 'document'; document: IdentityReference }
  | { kind: 'block'; document: IdentityReference; block: IdentityReference; route: Route | null }
  | { kind: 'heading'; document: IdentityReference; headingKey: string; slug: string; location: SourceLocation | null }
  | { kind: 'captured-binding'; groupId: string; tuple: Graph3Inputs['inputs']['source']['knowledge']['groups'][number]['tuple'];
      groupSource: Graph3Inputs['inputs']['source']['knowledge']['groups'][number]['source']; binding: SyncedLinkBinding; hintsOnly: true }
  | { kind: 'unresolved'; reason: string; path: string | null; fragment: string | null; candidates: IdentityReference[]; preserveUnresolved: true }
  | { kind: 'opaque'; reason: 'image-or-external-or-asset' }
const ascii = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase())
const text = (value: unknown): string => typeof value === 'string' ? value : graph3Conflict('navigation-original-text', typeof value)
const fragmentId = (fragment: string) => fragment.startsWith('^') ? fragment.slice(1) : fragment
const blockFragment = (fragment: string, wiki: boolean) => fragment.startsWith('^') || wiki && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(fragment)
const unresolved = (reason: string, path: string | null, fragment: string | null, candidates: IdentityReference[] = []): Target =>
  ({ kind: 'unresolved', reason, path, fragment, candidates, preserveUnresolved: true })
class AmbiguousLookup extends Error {
  constructor(readonly reason: string, readonly path: string, readonly candidates: IdentityReference[]) { super(reason) }
}

function originalTable(raw: Capsule2RawContent, name: string) {
  return raw.tables.find(table => table.name === name) ?? graph3Conflict('missing-source-table', name)
}

function originalValue(raw: Capsule2RawContent, row: Capsule2RawSqlRow, column: number) {
  return column < 0 ? undefined : graph3Value(row.cells[column], raw.encoding)
}

function indexOriginalIdentities(raw: Capsule2RawContent, name: 'documents' | 'blocks' | 'synced_group_blocks') {
  const table = originalTable(raw, name)
  const idColumn = table.columns.indexOf('id'), birthColumn = table.columns.indexOf('created_at')
  const ownerColumn = table.columns.indexOf(name === 'blocks' ? 'document_id' : 'group_id')
  const rows = new Map<string, Capsule2RawSqlRow>()
  for (const row of table.rows) {
    const id = text(originalValue(raw, row, idColumn))
    if (rows.has(id)) return graph3Conflict('navigation-duplicate-original-identity', { name, id })
    rows.set(id, row)
  }
  return { rows, birthColumn, ownerColumn }
}

function indexOriginalRoutes(db: Database.Database, raw: Capsule2RawContent) {
  const table = originalTable(raw, 'document_block_routes')
  const pathColumn = table.columns.indexOf('document_path'), blockColumn = table.columns.indexOf('block_id')
  db.pragma('temp_store=FILE')
  if (db.pragma('temp_store', { simple: true }) !== 1) return graph3Conflict('navigation-original-route-index-unavailable', null)
  db.exec(`CREATE TEMP TABLE original_routes (
    ordinal INTEGER PRIMARY KEY, path BLOB NOT NULL, block_id BLOB NOT NULL, original_rowid TEXT NOT NULL);
    CREATE INDEX temp.original_route_key ON original_routes(path,block_id,ordinal);`)
  db.pragma('temp.cache_size=-2048')
  // Preserve the previous JS spelling comparison, including case, NUL and
  // every UTF-16 code unit. A SQLite TEXT collation is not a source identity.
  const routeKey = (value: string) => Buffer.from(value, 'utf16le')
  const insert = db.prepare('INSERT INTO original_routes(path,block_id,original_rowid) VALUES (?,?,?)')
  db.transaction(() => {
    for (const row of table.rows)
      insert.run(routeKey(text(originalValue(raw, row, pathColumn))), routeKey(text(originalValue(raw, row, blockColumn))), row.sourceRowId)
  })()
  const read = db.prepare('SELECT original_rowid FROM original_routes WHERE path=? AND block_id=? ORDER BY ordinal LIMIT 2').pluck()
  return {
    has: (path: string, id: string) => read.get(routeKey(path), routeKey(id)) !== undefined,
    find: (path: string, id: string) => read.all(routeKey(path), routeKey(id)) as string[]
  }
}

/** Fixed source-side rewrite inputs, before final paths/current retention exist.
 * Actual physical births authorize ordinary navigation observations only.
 * A canonical destination keeps its captured historical binding; resolving its
 * spelling in today's host would replace its provenance. */
function prepareSideNavigation(data: NavigationGraphInputs, side: Side, routeDb: Database.Database) {
  const source = data.inputs[side].source, physical = source.physical, raw = source.sourceContent
  const documentRows = indexOriginalIdentities(raw, 'documents'), blockRows = indexOriginalIdentities(raw, 'blocks')
  const canonicalRows = indexOriginalIdentities(raw, 'synced_group_blocks')
  const documents = new Map(physical.documents.map(document => [document.documentId, document]))
  const assignments = new Map<string, typeof data.value.assignments>()
  for (const assignment of data.value.assignments) {
    const key = graph3Key(assignment.kind, assignment.sourceId), rows = assignments.get(key) ?? []
    rows.push(assignment); assignments.set(key, rows)
  }
  function identity(kind: 'document' | 'block', id: string): IdentityReference {
    const index = kind === 'document' ? documentRows : blockRows.rows.has(id) ? blockRows : canonicalRows
    const row = index.rows.get(id)
    if (!row) return graph3Conflict('navigation-missing-physical-row', { kind, id })
    const birth = text(originalValue(raw, row, index.birthColumn)), ownerKind = kind === 'document' ? null : index === blockRows ? 'document' : 'group'
    const ownerId = ownerKind === null ? null : text(originalValue(raw, row, index.ownerColumn))
    // Current is already in the destination namespace. This is an actual
    // physical observation, not a fabricated source allocation or write grant.
    if (side === 'current') return { id, birth, assignmentKey: null, targetId: id, ownerKind, ownerId }
    const slots = (assignments.get(graph3Key(kind, id)) ?? []).filter(item => item.physical && !item.ambiguous
      && item.birth === birth && item.ownerKind === ownerKind && item.ownerId === ownerId)
    if (slots.length !== 1) return graph3Conflict('navigation-physical-allocation', { kind, id, birth, ownerKind, ownerId })
    return { id, birth, assignmentKey: slots[0].key, targetId: slots[0].targetId, ownerKind, ownerId }
  }
  const documentRefs = new Map(physical.documents.map(document => [document.documentId, identity('document', document.documentId)]))
  const docRef = (id: string) => documentRefs.get(id) ?? graph3Conflict('navigation-missing-document', id)
  const byPath = new Map<string, typeof physical.documents>(), byAsciiPath = new Map<string, typeof physical.documents>(), byTitle = new Map<string, typeof physical.documents>()
  for (const document of physical.documents) {
    for (const [index, key] of [[byPath, document.path], [byAsciiPath, ascii(document.path)], [byTitle, ascii(document.title)]] as const) {
      const list = index.get(key) ?? []; list.push(document); index.set(key, list)
    }
  }
  function lookupPath(path: string, wiki: boolean) {
    const candidates = byPath.get(path) ?? (wiki ? byAsciiPath.get(ascii(path)) : undefined) ?? []
    if (candidates.length > 1) throw new AmbiguousLookup('ambiguous-path', path, candidates.map(item => docRef(item.documentId)))
    return candidates[0]
  }
  const routeIndex = indexOriginalRoutes(routeDb, raw)
  function blockAt(path: string, fragment: string, localDocumentId?: string): Extract<Target, { kind: 'block' }> | null {
    const id = fragmentId(fragment), block = blockRows.rows.get(id)
    if (!block) return null // Never turn a global canonical/retained UUID into a host route.
    const documentId = text(originalValue(raw, block, blockRows.ownerColumn)), owner = documents.get(documentId)
    if (!owner) return graph3Conflict('navigation-block-owner-outside-source', id)
    const [sourceRowId, duplicate] = routeIndex.find(path, id)
    if (duplicate !== undefined) return graph3Conflict('navigation-duplicate-exact-route', { path, id })
    if (localDocumentId !== undefined && owner.documentId !== localDocumentId && sourceRowId === undefined) return null
    if (owner.path !== path && sourceRowId === undefined) return null
    const route: Route | null = sourceRowId === undefined ? null : { table: 'document_block_routes', sourceRowId, path, blockId: id }
    return { kind: 'block', document: docRef(documentId), block: identity('block', id), route }
  }
  function bareWikiBlock(documentId: string, path: string, token: string): Extract<Target, { kind: 'block' }> | null {
    // A bare token is an opaque exact ID, not a caret fragment. Only the
    // historical route branch uses getBlockReference's caret normalization.
    const row = blockRows.rows.get(token)
    if (row && originalValue(raw, row, blockRows.ownerColumn) === documentId)
      return { kind: 'block', document: docRef(documentId), block: identity('block', token), route: null }
    return routeIndex.has(path, fragmentId(token)) ? blockAt(path, token) : null
  }
  const snapshots = physical.groups.flatMap(group => group.snapshot ? [group.snapshot] : [])
  const groupKnowledge = new Map(data.inputs[side].knowledge.groups.map(group => [group.tuple.groupId, group]))
  const snapshotsById = new Map(snapshots.map(group => [group.groupId, group]))
  const bindingIndexes = new Map(snapshots.map(group => [group.groupId, new Map(group.bindings.map(binding => [
    graph3Key(binding.blockId, binding.from, binding.to, binding.raw, binding.syntax), binding
  ]))]))
  // Apply existing finite limits before allocating occurrence × canonical
  // objects. This lower bound counts fields that must appear in every emitted
  // wrapper; it cannot reject an output that would fit the final JSON budget.
  const groupMinimum = new Map(snapshots.map(group => [group.groupId, { count: group.blocks.length,
    bytes: group.blocks.reduce((bytes, block) => bytes + capsuleJsonStringBytes(block.content, CAPSULE2_RAW_MAX_JSON_BYTES)
      + capsuleJsonStringBytes(block.id, CAPSULE2_RAW_MAX_JSON_BYTES) + 30, 0) }]))
  let minimumBytes = 0
  for (const document of physical.documents) {
    let count = 0
    for (const block of document.blocks) {
      const group = block.type === 'synced-block' ? groupMinimum.get(parseSyncedBlockPayload(block.content).groupId) : undefined
      if (block.type === 'synced-block' && !group) return graph3Conflict('navigation-missing-expanded-group', block.id)
      count += group?.count ?? 1
      minimumBytes += group?.bytes ?? capsuleJsonStringBytes(block.content, CAPSULE2_RAW_MAX_JSON_BYTES)
        + capsuleJsonStringBytes(block.id, CAPSULE2_RAW_MAX_JSON_BYTES) + 30
      if (!Number.isSafeInteger(count) || count > SYNCED_MAX_BLOCKS) return graph3Conflict('navigation-expanded-host-block-budget', document.documentId)
      if (!Number.isSafeInteger(minimumBytes) || minimumBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-navigation-input-budget', null)
    }
  }
  const graph = validateSyncedWorkspaceGraph(physical.documents.map(({ documentId, blocks }) => ({ documentId, blocks })),
    snapshots.map(group => ({ kind: 'synced-group', id: group.groupId, creationId: group.creationId, createdAt: group.createdAt,
      origin: group.origin, bindings: group.bindings, blocks: group.blocks })))
  const graphDocuments = new Map(graph.documents.map(document => [document.documentId, document]))
  const graphGroups = new Map(graph.groups.map(group => [group.id, group]))
  const instancesByDocument = new Map<string, typeof physical.instances>()
  for (const instance of physical.instances) {
    const instances = instancesByDocument.get(instance.host_document_id) ?? []
    instances.push(instance); instancesByDocument.set(instance.host_document_id, instances)
  }
  function expanded(document: typeof physical.documents[number]) {
    const instances = instancesByDocument.get(document.documentId) ?? []
    const referenced = new Set(instances.map(instance => instance.group_id))
    const view = { ...graph, documents: [graphDocuments.get(document.documentId)!], groups: [...referenced].map(id => graphGroups.get(id)!) }
    const instanceGroups = new Map(instances.map(instance => [instance.instance_id, instance.group_id]))
    const locations = new Map<string, SourceLocation>()
    const blocks: SyncedStableBlockDraft[] = []
    for (const item of expandSyncedGraphDocument(view, document.documentId)) {
      const groupId = item.instanceId === null ? null : instanceGroups.get(item.instanceId) ?? graph3Conflict('navigation-missing-instance', item.instanceId)
      const row = (groupId === null ? blockRows : canonicalRows).rows.get(item.block.id)
      if (!row) return graph3Conflict('navigation-missing-expanded-row', item.block.id)
      const blockIdentity = identity('block', item.block.id)
      const id = graph3Key(item.instanceId, item.block.id)
      locations.set(id, { table: groupId === null ? 'blocks' : 'synced_group_blocks', sourceRowId: row.sourceRowId,
        column: 'content', blockId: item.block.id, groupId, instanceId: item.instanceId,
        blockIdentity, instanceIdentity: item.instanceId === null ? null : identity('block', item.instanceId) })
      const { createdAt: _birth, ...syntax } = { ...item.block, createdAt: null }
      const block = { ...syntax, id, depth: item.depth, parentBlockId: item.parent === null ? null : graph3Key(item.parent.instanceId, item.parent.blockId) }
      blocks.push(block)
    }
    return { blocks, locations }
  }
  function headingNamespace(document: typeof physical.documents[number]) {
    const view = expanded(document)
    return { document: docRef(document.documentId), headings: getMarkdownHeadingTargets(view.blocks, document.title)
      .map(heading => ({ ...heading, location: heading.blockId === null ? null : view.locations.get(heading.blockId)! })) }
  }
  type FindHeading = (id: string, fragment: string, wiki: boolean) => Heading | undefined
  function targetFor(document: typeof physical.documents[number], url: string, wiki: boolean, findHeading: FindHeading): Target {
    const reference = wiki ? parseWikiReference(url) : null, local = wiki ? null : parseLocalMarkdownUrl(url)
    const resolved = wiki ? null : resolveMarkdownDocumentPath(document.path, url)
    if (!wiki && !resolved) return local && /\.md$/i.test(local.path) ? unresolved('invalid-local-path', local.path, local.fragment)
      : { kind: 'opaque', reason: 'image-or-external-or-asset' }
    try {
      let destination: typeof document | undefined, fragment: string, path: string
      if (wiki) {
        const found = !reference!.path && reference!.hasFragment ? { document, reference: reference! }
          : resolveWikiDocument(url, document.path, {
            byPath: path => { const item = lookupPath(path, true); return item ? { ...item, id: item.documentId } : undefined },
            byTitle: title => {
              const candidates = byTitle.get(ascii(title)) ?? []
              if (candidates.length > 1) throw new AmbiguousLookup('ambiguous-title', title, candidates.map(item => docRef(item.documentId)))
              return candidates.map(item => ({ ...item, id: item.documentId }))
            }
          })
        if (!found) {
          if (!reference!.hasFragment) { const block = bareWikiBlock(document.documentId, document.path, reference!.target); if (block) return block }
          let routeReference = reference!
          const hash = routeReference.target.lastIndexOf('#')
          if (hash >= 0 && /[#|]/.test(routeReference.target.slice(0, hash))) routeReference = { ...routeReference,
            path: routeReference.target.slice(0, hash), fragment: routeReference.target.slice(hash + 1), hasFragment: true }
          if (routeReference.fragment) for (const path of wikiDocumentPaths(routeReference.path, document.path)) {
            const block = blockAt(path, routeReference.fragment); if (block) return block
          }
          return unresolved('missing-document', wikiDocumentPaths(routeReference.path, document.path)[0] ?? routeReference.path, routeReference.fragment)
        }
        destination = documents.get(found.document.documentId); fragment = found.reference.fragment; path = found.document.path
      } else {
        path = resolved!.path; fragment = resolved!.fragment
        // getBlockReference checks an exact route before path navigation.
        if (fragment) { const block = blockAt(path, fragment, !local!.path ? document.documentId : undefined); if (block) return block }
        destination = !local!.path ? document : lookupPath(path, false)
      }
      if (!destination) return unresolved('missing-document', path, fragment)
      if (!fragment) return { kind: 'document', document: docRef(destination.documentId) }
      const block = blockAt(destination.path, fragment, destination.documentId)
      if (block) return block
      if (blockFragment(fragment, wiki)) return unresolved('missing-block', path, fragment)
      const heading = findHeading(destination.documentId, fragment, wiki)
      return heading ? { kind: 'heading', document: docRef(destination.documentId), headingKey: heading.key, slug: heading.slug, location: heading.location }
        : unresolved('missing-heading', path, fragment)
    } catch (cause) {
      if (cause instanceof AmbiguousLookup) return unresolved(cause.reason, cause.path, reference?.fragment ?? resolved?.fragment ?? null, cause.candidates)
      throw cause
    }
  }
  function scope(document: typeof physical.documents[number], field: 'body' | 'summary', findHeading: FindHeading) {
    const scopeId = graph3Key(field, document.documentId), view = field === 'body' ? expanded(document) : null
    const summaryId = graph3Key('summary', document.documentId)
    const blocks: SyncedStableBlockDraft[] = view?.blocks ?? [{ id: summaryId, parentBlockId: null,
      type: 'paragraph', content: document.summary, checked: false, depth: 0 }]
    const locations = view?.locations ?? new Map<string, SourceLocation>([[summaryId, { table: 'documents',
      sourceRowId: documentRows.rows.get(document.documentId)!.sourceRowId, column: 'summary', blockId: null, groupId: null, instanceId: null,
      blockIdentity: null, instanceIdentity: null }]])
    const facts = captureSyncedCreateSourceFacts(blocks)
    // Match grammar by the exact physical range, never by URL. The strict facts
    // reader proves all ranges; the public parser supplies HTML escaping roles.
    const originalOffset = markdownOriginalOffsetLookup(blocks)
    const normalized = blocks.map(block => block.content.includes('\r') ? { ...block, content: block.content.replace(/\r\n?/g, '\n') } : block)
    const grammar = new Map(collectDocumentMarkdownLinks(normalized).map(link => {
      const from = originalOffset(link.blockIndex, link.start), to = originalOffset(link.blockIndex, link.end)
      if (from === null || to === null) return graph3Conflict('navigation-range-grammar-mismatch', scopeId)
      return [graph3Key(link.blockId, from, to), link] as const
    }))
    if (grammar.size !== facts.links.length) return graph3Conflict('navigation-incomplete-grammar', scopeId)
    const destinations = facts.links.map(link => {
      const location = locations.get(link.key.blockId)!, role = grammar.get(graph3Key(link.key.blockId, link.key.from, link.key.to))
      if (!role || role.url !== link.url) return graph3Conflict('navigation-range-grammar-mismatch', { scopeId, key: link.key })
      let target: Target
      if (link.image) target = { kind: 'opaque', reason: 'image-or-external-or-asset' }
      else if (location.groupId !== null) {
        const snapshot = snapshotsById.get(location.groupId)!, knowledge = groupKnowledge.get(location.groupId)
        if (snapshot && link.key.syntax !== 'wiki' && !resolveMarkdownDocumentPath(snapshot.origin.pathAtCreation, link.url))
          return { key: link.key, url: link.url, image: link.image,
            grammar: { kind: role.kind, syntax: role.kind === 'wiki' ? 'wiki' : role.syntax ?? null }, location,
            target: { kind: 'opaque', reason: 'image-or-external-or-asset' } as Target }
        const binding = bindingIndexes.get(location.groupId)?.get(graph3Key(location.blockId, link.key.from, link.key.to, link.key.raw, link.key.syntax))
        if (!knowledge || !snapshot || !binding) return graph3Conflict('navigation-missing-original-captured-binding', { scopeId, key: link.key })
        target = { kind: 'captured-binding', groupId: location.groupId, tuple: knowledge.tuple, groupSource: knowledge.source, binding, hintsOnly: true }
      } else target = targetFor(document, link.url, link.key.syntax === 'wiki', findHeading)
      return { key: link.key, url: link.url, image: link.image, grammar: { kind: role.kind, syntax: role.kind === 'wiki' ? 'wiki' : role.syntax ?? null }, location, target }
    })
    return { scopeId, field, document: docRef(document.documentId), path: document.path, title: document.title,
      blocks: blocks.map(block => ({ occurrenceKey: block.id, block, location: locations.get(block.id)! })), destinations,
      definitions: facts.definitions, effectiveDefinitions: [...facts.effective].map(([key, definition]) => ({ key, definition })),
      uses: [...facts.uses].map(([blockId, definitions]) => ({ blockId, definitions: [...definitions] })), units: facts.units }
  }
  const currentPayloads = side === 'current' ? data.inputs.knowledge.constraints.payloads.filter(payload => !payload.witness.domain.length && payload.witness.side === 'current') : []
  if (side === 'current' && currentPayloads.length !== 1) return graph3Conflict('navigation-current-payload-closure', null)
  const body = { kind: 'complete-root-restore-navigation-rewrite-inputs' as const, version: 3 as const,
    scope: side === 'source' ? 'root-source-document-body-and-summary' as const : 'root-current-document-body-and-summary' as const, root: data.inputs.knowledge.constraints.root,
    sourceWitness: side === 'source' ? data.value.sourceWitness : currentPayloads[0].witness,
    sourcePayload: side === 'source' ? data.value.sourcePayload : currentPayloads[0].key,
    conservationHash: data.inputs.knowledge.conservationHash, identityAllocationHash: data.value.allocationHash,
    sourceMaterialHash: data.inputs.source.materialHash, currentMaterialHash: data.inputs.current.materialHash,
    ordinaryNavigationCaptured: true as const, templateNavigationCaptured: false as const,
    canonicalBindingsAreHistoricalHints: true as const,
    finalConstraints: ['retain-qualified-target-identities', 'preserve-unresolved-and-ambiguous', 'consume-effective-definition-occurrences',
      'retain-instance-heading-occurrences', 'reparse-complete-final-forests-and-summary-separately'] as const,
    finalLayoutApplied: false as const, referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    sourcePolicyReplayed: false as const, sourceHistoryReplayed: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  return { body, documents: physical.documents, headingNamespace, scope }
}

type NavigationProjection = ReturnType<typeof prepareSideNavigation>
type OriginalScope = ReturnType<NavigationProjection['scope']>
type HeadingNamespace = ReturnType<NavigationProjection['headingNamespace']>
type Navigation3Inputs = NavigationProjection['body'] & {
  readonly scopes: readonly OriginalScope[]; readonly headingNamespaces: readonly HeadingNamespace[]; readonly navigationInputHash: string
}
export type StoredNavigation3Inputs = Omit<Navigation3Inputs, 'scopes' | 'headingNamespaces'> & {
  readonly scopeCount: number
  /** Canonical hashing only. Data readers must use the cursor methods below. */
  readonly hashInput: Navigation3Inputs
  scopes(): IterableIterator<OriginalScope>
  readScope(scopeId: string): OriginalScope | undefined
  headingNamespaces(): IterableIterator<HeadingNamespace>
  headingNamespace(documentId: string): HeadingNamespace | undefined
}

/** Keep expanded forests out of memory between documents. The first pass
 * seals heading namespaces. The second resolves links one scope at a time. */
export function withStoredRootRestoreNavigationInputs3<T>(data: NavigationGraphInputs, side: Side, read: (input: StoredNavigation3Inputs) => T): T {
  const routes = new Database(':memory:')
  try {
    const projection = prepareSideNavigation(data, side, routes)
    return withStoredRestoreScopes<HeadingNamespace, void, T>(append => {
      for (const document of projection.documents) append(document.documentId, projection.headingNamespace(document))
    }, (_, headings) => withStoredRestoreScopes<OriginalScope, void, T>(append => {
      let cached: { id: string; slug: Map<string, Heading>; normalizedText: Map<string, Heading> } | undefined
      const findHeading = (id: string, fragment: string, wiki: boolean) => {
        if (cached?.id !== id) {
          const namespace = headings.byId(id) ?? graph3Conflict('navigation-heading-namespace-missing', id)
          const slug = new Map<string, Heading>(), normalizedText = new Map<string, Heading>()
          // Lookup prefers the first exact slug, followed by the first normalized Wiki heading.
          for (const heading of namespace.headings) {
            if (!slug.has(heading.slug)) slug.set(heading.slug, heading)
            const key = heading.text.normalize('NFC').toLowerCase()
            if (!normalizedText.has(key)) normalizedText.set(key, heading)
          }
          cached = { id, slug, normalizedText }
        }
        return cached.slug.get(fragment) ?? (wiki ? cached.normalizedText.get(fragment.normalize('NFC').toLowerCase()) : undefined)
      }
      for (const document of projection.documents) for (const field of ['body', 'summary'] as const) {
        const scope = projection.scope(document, field, findHeading)
        append(scope.scopeId, scope)
      }
    }, (_, scopes) => {
      const metadata = freezeCapsuleValue(projection.body)
      const body = { ...metadata, scopes: scopes.hashInput, headingNamespaces: headings.hashInput }
      const navigationInputHash = hashBoundedCapsuleJson(body, CAPSULE2_RAW_MAX_JSON_BYTES, side === 'source'
        ? 'knowbook.restore.navigation3.inputs.v1\0' : 'knowbook.restore.navigation3.current-inputs.v1\0')
      if (!navigationInputHash) return graph3Conflict('complete-navigation-input-budget', null)
      const hashInput = Object.freeze({ ...body, navigationInputHash })
      return read(Object.freeze({ ...metadata, navigationInputHash, scopeCount: scopes.count, hashInput,
        scopes: () => scopes.iterate(), readScope: (id: string) => scopes.byId(id),
        headingNamespaces: () => headings.iterate(), headingNamespace: (id: string) => headings.byId(id) }))
    }))
  } finally { routes.close() }
}

function deriveSideNavigationRewriteInputs3(data: NavigationGraphInputs, side: Side) {
  return withStoredRootRestoreNavigationInputs3(data, side, ({ hashInput, scopes, headingNamespaces }) =>
    freezeCapsuleValue({ ...hashInput, scopes: [...scopes()], headingNamespaces: [...headingNamespaces()] }))
}

/** The original source DTO/hash preimage is unchanged. */
export function deriveRootRestoreNavigationRewriteInputs3(data: NavigationGraphInputs) { return deriveSideNavigationRewriteInputs3(data, 'source') }
/** Actual current originals, no source/current DTO swap or invented assignment. */
export function deriveRootRestoreCurrentNavigationRewriteInputs3(data: NavigationGraphInputs) { return deriveSideNavigationRewriteInputs3(data, 'current') }
