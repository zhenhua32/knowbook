import type { SyncedLinkBinding, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { expandSyncedGraphDocument, validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { parseSyncedBlockPayload, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference, resolveWikiDocument, wikiDocumentPaths } from '../../shared/markdownWiki'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict, graph3Key, graph3Rows, type Graph3Inputs } from './restore-knowledge-graph3-data'
import { captureSyncedCreateSourceFacts } from './synced-host-create-plan'

type SourceLocation = { table: 'blocks' | 'synced_group_blocks' | 'documents'; sourceRowId: string; column: 'content' | 'summary';
  blockId: string | null; groupId: string | null; instanceId: string | null;
  blockIdentity: IdentityReference | null; instanceIdentity: IdentityReference | null }
type IdentityReference = { id: string; birth: string; assignmentKey: string | null; targetId: string; ownerKind: 'document' | 'group' | null; ownerId: string | null }
type Heading = ReturnType<typeof getMarkdownHeadingTargets>[number] & { location: SourceLocation | null }
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

/** Fixed source-side rewrite inputs, before final paths/current retention exist.
 * Actual physical births authorize ordinary navigation observations only.
 * A canonical destination keeps its captured historical binding; resolving its
 * spelling in today's host would replace its provenance. */
function deriveSideNavigationRewriteInputs3(data: Graph3Inputs, side: 'source' | 'current') {
  const source = data.inputs[side].source, physical = source.physical, raw = source.sourceContent
  const rowIndex = (name: string, column: string) => {
    const rows = new Map<string, ReturnType<typeof graph3Rows>[number]>()
    for (const row of graph3Rows(raw, name)) {
      const id = text(row.value[column])
      if (rows.has(id)) return graph3Conflict('navigation-duplicate-original-identity', { name, id })
      rows.set(id, row)
    }
    return rows
  }
  const documentRows = rowIndex('documents', 'id'), blockRows = rowIndex('blocks', 'id'), canonicalRows = rowIndex('synced_group_blocks', 'id')
  const documents = new Map(physical.documents.map(document => [document.documentId, document]))
  const assignments = new Map<string, typeof data.value.assignments>()
  for (const assignment of data.value.assignments) {
    const key = graph3Key(assignment.kind, assignment.sourceId), rows = assignments.get(key) ?? []
    rows.push(assignment); assignments.set(key, rows)
  }
  function identity(kind: 'document' | 'block', id: string): IdentityReference {
    const row = (kind === 'document' ? documentRows : blockRows.has(id) ? blockRows : canonicalRows).get(id)
    if (!row) return graph3Conflict('navigation-missing-physical-row', { kind, id })
    const birth = text(row.value.created_at), ownerKind = kind === 'document' ? null : blockRows.has(id) ? 'document' : 'group'
    const ownerId = ownerKind === null ? null : text(row.value[ownerKind === 'document' ? 'document_id' : 'group_id'])
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
  const routeIndex = new Map<string, Route[]>()
  for (const row of graph3Rows(raw, 'document_block_routes')) {
    const path = text(row.value.document_path), blockId = text(row.value.block_id), key = graph3Key(path, blockId)
    const routes = routeIndex.get(key) ?? []
    routes.push({ table: 'document_block_routes', sourceRowId: row.original.sourceRowId, path, blockId }); routeIndex.set(key, routes)
  }
  function blockAt(path: string, fragment: string, localDocumentId?: string): Extract<Target, { kind: 'block' }> | null {
    const id = fragmentId(fragment), block = blockRows.get(id)
    if (!block) return null // Never turn a global canonical/retained UUID into a host route.
    const documentId = text(block.value.document_id), owner = documents.get(documentId)
    if (!owner) return graph3Conflict('navigation-block-owner-outside-source', id)
    const routes = routeIndex.get(graph3Key(path, id)) ?? []
    if (routes.length > 1) return graph3Conflict('navigation-duplicate-exact-route', { path, id })
    if (localDocumentId !== undefined && owner.documentId !== localDocumentId && !routes.length) return null
    if (owner.path !== path && !routes.length) return null
    return { kind: 'block', document: docRef(documentId), block: identity('block', id), route: routes[0] ?? null }
  }
  function bareWikiBlock(documentId: string, path: string, token: string): Extract<Target, { kind: 'block' }> | null {
    // A bare token is an opaque exact ID, not a caret fragment. Only the
    // historical route branch uses getBlockReference's caret normalization.
    const row = blockRows.get(token)
    if (row?.value.document_id === documentId) return { kind: 'block', document: docRef(documentId), block: identity('block', token), route: null }
    return routeIndex.has(graph3Key(path, fragmentId(token))) ? blockAt(path, token) : null
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
    bytes: group.blocks.reduce((bytes, block) => bytes + Buffer.byteLength(capsuleJson(block.content))
      + Buffer.byteLength(capsuleJson(block.id)) + 30, 0) }]))
  let minimumBytes = 0
  for (const document of physical.documents) {
    let count = 0
    for (const block of document.blocks) {
      const group = block.type === 'synced-block' ? groupMinimum.get(parseSyncedBlockPayload(block.content).groupId) : undefined
      if (block.type === 'synced-block' && !group) return graph3Conflict('navigation-missing-expanded-group', block.id)
      count += group?.count ?? 1
      minimumBytes += group?.bytes ?? Buffer.byteLength(capsuleJson(block.content)) + Buffer.byteLength(capsuleJson(block.id)) + 30
      if (!Number.isSafeInteger(count) || count > SYNCED_MAX_BLOCKS) return graph3Conflict('navigation-expanded-host-block-budget', document.documentId)
      if (!Number.isSafeInteger(minimumBytes) || minimumBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-navigation-input-budget', null)
    }
  }
  let projectedBytes = 0
  const charge = (bytes: number) => {
    projectedBytes += bytes
    if (!Number.isSafeInteger(projectedBytes) || projectedBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-navigation-input-budget', null)
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
    const blocks: SyncedStableBlockDraft[] = [], entries: Array<{ occurrenceKey: string; block: SyncedStableBlockDraft; location: SourceLocation }> = []
    let blockBytes = 0
    for (const item of expandSyncedGraphDocument(view, document.documentId)) {
      const groupId = item.instanceId === null ? null : instanceGroups.get(item.instanceId) ?? graph3Conflict('navigation-missing-instance', item.instanceId)
      const row = (groupId === null ? blockRows : canonicalRows).get(item.block.id)
      if (!row) return graph3Conflict('navigation-missing-expanded-row', item.block.id)
      const blockIdentity = identity('block', item.block.id)
      const id = graph3Key(item.instanceId, item.block.id)
      locations.set(id, { table: groupId === null ? 'blocks' : 'synced_group_blocks', sourceRowId: row.original.sourceRowId,
        column: 'content', blockId: item.block.id, groupId, instanceId: item.instanceId,
        blockIdentity, instanceIdentity: item.instanceId === null ? null : identity('block', item.instanceId) })
      const { createdAt: _birth, ...syntax } = { ...item.block, createdAt: null }
      const block = { ...syntax, id, depth: item.depth, parentBlockId: item.parent === null ? null : graph3Key(item.parent.instanceId, item.parent.blockId) }
      const entry = { occurrenceKey: id, block, location: locations.get(id)! }, bytes = Buffer.byteLength(capsuleJson(entry))
      charge(bytes); blockBytes += bytes; entries.push(entry); blocks.push(block)
    }
    return { blocks, locations, entries, blockBytes }
  }
  const views = new Map(physical.documents.map(document => [document.documentId, expanded(document)]))
  const headingNamespaces = physical.documents.map(document => {
    const view = views.get(document.documentId)!
    const namespace = { document: docRef(document.documentId), headings: getMarkdownHeadingTargets(view.blocks, document.title)
      .map(heading => ({ ...heading, location: heading.blockId === null ? null : view.locations.get(heading.blockId)! })) }
    charge(Buffer.byteLength(capsuleJson(namespace)))
    return namespace
  })
  const headingIndex = new Map(headingNamespaces.map(namespace => {
    const slug = new Map<string, Heading>(), normalizedText = new Map<string, Heading>()
    for (const heading of namespace.headings) {
      // The shared Wiki resolver chooses the first exact slug, then the first
      // NFC/case-normalized text. Preserve that order without per-link scans.
      if (!slug.has(heading.slug)) slug.set(heading.slug, heading)
      const key = heading.text.normalize('NFC').toLowerCase()
      if (!normalizedText.has(key)) normalizedText.set(key, heading)
    }
    return [namespace.document.id, { slug, normalizedText }] as const
  }))
  function targetFor(document: typeof physical.documents[number], url: string, wiki: boolean): Target {
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
      const headings = headingIndex.get(destination.documentId)!
      const heading = headings.slug.get(fragment) ?? (wiki ? headings.normalizedText.get(fragment.normalize('NFC').toLowerCase()) : undefined)
      return heading ? { kind: 'heading', document: docRef(destination.documentId), headingKey: heading.key, slug: heading.slug, location: heading.location }
        : unresolved('missing-heading', path, fragment)
    } catch (cause) {
      if (cause instanceof AmbiguousLookup) return unresolved(cause.reason, cause.path, reference?.fragment ?? resolved?.fragment ?? null, cause.candidates)
      throw cause
    }
  }
  function scope(document: typeof physical.documents[number], field: 'body' | 'summary') {
    const scopeId = graph3Key(field, document.documentId), view = views.get(document.documentId)!
    const summaryId = graph3Key('summary', document.documentId)
    const blocks: SyncedStableBlockDraft[] = field === 'body' ? view.blocks : [{ id: summaryId, parentBlockId: null,
      type: 'paragraph', content: document.summary, checked: false, depth: 0 }]
    const locations = field === 'body' ? view.locations : new Map<string, SourceLocation>([[summaryId, { table: 'documents',
      sourceRowId: documentRows.get(document.documentId)!.original.sourceRowId, column: 'summary', blockId: null, groupId: null, instanceId: null,
      blockIdentity: null, instanceIdentity: null }]])
    const facts = captureSyncedCreateSourceFacts(blocks)
    // Match grammar by the exact physical range, never by URL. The strict facts
    // reader proves all ranges; the public parser supplies HTML escaping roles.
    const rawOffsets = blocks.map(block => {
      const positions: number[] = []
      for (let i = 0; i < block.content.length; i++) { positions.push(i); if (block.content[i] === '\r' && block.content[i + 1] === '\n') i++ }
      positions.push(block.content.length); return positions
    })
    const grammar = new Map(collectDocumentMarkdownLinks(blocks.map(block => ({ ...block, content: block.content.replace(/\r\n?/g, '\n') }))).map(link => [
      graph3Key(link.blockId, rawOffsets[link.blockIndex][link.start], rawOffsets[link.blockIndex][link.end]), link
    ]))
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
      } else target = targetFor(document, link.url, link.key.syntax === 'wiki')
      return { key: link.key, url: link.url, image: link.image, grammar: { kind: role.kind, syntax: role.kind === 'wiki' ? 'wiki' : role.syntax ?? null }, location, target }
    })
    const result = { scopeId, field, document: docRef(document.documentId), path: document.path, title: document.title,
      blocks: field === 'body' ? view.entries : blocks.map(block => ({ occurrenceKey: block.id, block, location: locations.get(block.id)! })), destinations,
      definitions: facts.definitions, effectiveDefinitions: [...facts.effective].map(([key, definition]) => ({ key, definition })),
      uses: [...facts.uses].map(([blockId, definitions]) => ({ blockId, definitions: [...definitions] })), units: facts.units }
    charge(Buffer.byteLength(capsuleJson(result)) - (field === 'body' ? view.blockBytes : 0))
    return result
  }
  const scopes = physical.documents.flatMap(document => [scope(document, 'body'), scope(document, 'summary')])
  const currentPayloads = side === 'current' ? data.inputs.knowledge.constraints.payloads.filter(payload => !payload.witness.domain.length && payload.witness.side === 'current') : []
  if (side === 'current' && currentPayloads.length !== 1) return graph3Conflict('navigation-current-payload-closure', null)
  const body = { kind: 'complete-root-restore-navigation-rewrite-inputs' as const, version: 3 as const,
    scope: side === 'source' ? 'root-source-document-body-and-summary' as const : 'root-current-document-body-and-summary' as const, root: data.inputs.knowledge.constraints.root,
    sourceWitness: side === 'source' ? data.value.sourceWitness : currentPayloads[0].witness,
    sourcePayload: side === 'source' ? data.value.sourcePayload : currentPayloads[0].key,
    conservationHash: data.inputs.knowledge.conservationHash, identityAllocationHash: data.value.allocationHash,
    sourceMaterialHash: data.inputs.source.materialHash, currentMaterialHash: data.inputs.current.materialHash,
    scopes, headingNamespaces, ordinaryNavigationCaptured: true as const, templateNavigationCaptured: false as const,
    canonicalBindingsAreHistoricalHints: true as const,
    finalConstraints: ['retain-qualified-target-identities', 'preserve-unresolved-and-ambiguous', 'consume-effective-definition-occurrences',
      'retain-instance-heading-occurrences', 'reparse-complete-final-forests-and-summary-separately'] as const,
    finalLayoutApplied: false as const, referenceRewriteComplete: false as const, semanticValidationComplete: false as const,
    sourcePolicyReplayed: false as const, sourceHistoryReplayed: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('complete-navigation-input-budget', null)
  return freezeCapsuleValue({ ...body, navigationInputHash: capsuleBytesHash((side === 'source'
    ? 'knowbook.restore.navigation3.inputs.v1\0' : 'knowbook.restore.navigation3.current-inputs.v1\0') + encoded) })
}

/** The original source DTO/hash preimage is unchanged. */
export function deriveRootRestoreNavigationRewriteInputs3(data: Graph3Inputs) { return deriveSideNavigationRewriteInputs3(data, 'source') }
/** Actual current originals, no source/current DTO swap or invented assignment. */
export function deriveRootRestoreCurrentNavigationRewriteInputs3(data: Graph3Inputs) { return deriveSideNavigationRewriteInputs3(data, 'current') }
