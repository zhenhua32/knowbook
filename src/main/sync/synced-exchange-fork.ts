import type { SyncedCanonicalWire, SyncedGroupWire, SyncedLinkBinding, SyncedLinkTarget, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../../shared/syncedBlockPortable'
import { parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, parseSyncedBlockPayload, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { expandSyncedGraphDocument, validateSyncedWorkspaceGraph } from '../../shared/syncedBlockGraph'
import { collectMarkdownSourceLinks, escapeMarkdownDestination, parseLocalMarkdownUrl, relativeMarkdownPath, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets, type MarkdownHeadingTarget } from '../../shared/markdownLinkMaintenance'
import { parseWikiReference, resolveWikiDocument } from '../../shared/markdownWiki'
import { mapDatabaseViewReferences, parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { captureSyncedCreateSourceFacts, UnsupportedSyncedHostCreate } from '../database/synced-host-create-plan'
import { collectSyncedBindingOccurrences } from '../database/synced-block-links'
import { assertExchangeData } from './synced-exchange-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson, SyncedPublicationError } from './synced-publication-model'
import { syncedProtocol5RecordKey, validateSyncedProtocol5Snapshot, type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from './synced-protocol5-model'
import type { SyncDatabases, SyncRow } from './model'
import type { SyncedBothAllocation, SyncedBothCopySource, SyncedBothDescribeInput, SyncedBothDescription, SyncedBothForkInput,
  SyncedBothForkResult, SyncedBothGroupSource, SyncedBothLinkProjection, SyncedBothOwnerSourceLinks, SyncedBothSourceKey,
  SyncedBothSourceLink, SyncedExchangeBothBlockedReason, SyncedExchangeBothForkSummary } from './synced-exchange-both-types'

type Entry = SyncedProtocol5Snapshot['records'][number]
type Records = Map<string, Entry>
type Host = SyncedPortableHostRecord
type Block = SyncedStableBlockDraft | SyncedCanonicalWire
type ComponentInput = SyncedBothDescribeInput
type CopyDoc = SyncedBothAllocation['documents'][number]
type ForkGroup = SyncedBothAllocation['groups'][number]
type Parsed = { key: SyncedBothSourceKey; url: string; image: boolean; syntax?: 'html' | 'bare' | 'wiki' }
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(publicationCompare)
const hash = (value: unknown): string => publicationHash(publicationJson(value))
const same = (left: unknown, right: unknown): boolean => publicationJson(left) === publicationJson(right)
const sourceKey = (key: SyncedBothSourceKey): string => publicationJson([key.field, key.blockId, key.from, key.to, key.raw, key.syntax])
const blockKey = (owner: string, id: string): string => publicationJson([owner, id])
const instanceKey = (documentId: string, instanceId: string, destination: string): string => publicationJson([documentId, instanceId, destination])
class Blocked extends Error { constructor(readonly reason: SyncedExchangeBothBlockedReason) { super(reason) } }
function block(reason: SyncedExchangeBothBlockedReason = 'semantic-binding'): never { throw new Blocked(reason) }
function unique<T>(values: readonly T[], key: (value: T) => string, message: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const value of values) { const identity = key(value); if (result.has(identity)) return publicationInvalid(message); result.set(identity, value) }
  return result
}
function readSnapshot(value: SyncedProtocol5Snapshot): SyncedProtocol5Snapshot {
  return validateSyncedProtocol5Snapshot(value.manifest, value.records.map(({ key, record }) => ({ key, record })))
}
function entries(value: SyncedProtocol5Snapshot): Records { return new Map(readSnapshot(value).records.map(row => [row.key, row])) }
function host(entry: Entry | undefined): Host | null { return entry?.record.kind === 'document' ? entry.record : null }
function group(entry: Entry | undefined): SyncedGroupWire | null { return entry?.record.kind === 'synced-group' ? entry.record : null }
function isLive(record: SyncedProtocol5Record): record is Host | SyncedGroupWire | SyncDatabases {
  return record.kind !== 'deleted' && record.kind !== 'synced-group-deleted'
}
function makeSnapshot(records: Records, workspaceId: string): SyncedProtocol5Snapshot {
  const rows = [...records.values()].sort((a, b) => publicationCompare(a.key, b.key)), groupHashes = new Map(rows.flatMap(row => row.record.kind === 'synced-group' ? [[row.record.id, row.hash] as const] : []))
  const instances = rows.flatMap(({ record }) => record.kind === 'document' ? record.content.blocks.flatMap(child => {
    if (child.type !== 'synced-block') return []
    const groupId = parseSyncedBlockPayload(child.content).groupId, groupHash = groupHashes.get(groupId)
    if (!groupHash) return block('dependency')
    return [{ documentId: record.id, instanceId: child.id, groupId, groupHash }]
  }) : []).sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId,
    entries: Object.fromEntries(rows.map(row => [row.key, row.hash])), syncedInstances: instances }, rows.map(({ key, record }) => ({ key, record })))
}
function setRecord(records: Records, record: SyncedProtocol5Record): void { const key = syncedProtocol5RecordKey(record); records.set(key, { key, hash: hash(record), record }) }
function paths(records: Records): Map<string, string> {
  const docs = new Map([...records.values()].flatMap(row => row.record.kind === 'document' ? [[row.record.id, row.record] as const] : [])), result = new Map<string, string>(), siblingNames = new Set<string>(), pathNames = new Set<string>()
  for (const doc of docs.values()) {
    if (!doc.content.title || doc.content.title !== doc.content.title.trim() || doc.content.title.length > 500 || /[/\\\x00-\x1f]/.test(doc.content.title) || ['.', '..'].includes(doc.content.title)) return block('path')
    const sibling = publicationJson([doc.parentId, doc.content.title.replace(/[A-Z]/g, char => char.toLowerCase())])
    if (siblingNames.has(sibling)) return block('path'); siblingNames.add(sibling)
  }
  for (const doc of docs.values()) {
    const chain: string[] = [], seen = new Set<string>(); let id: string | null = doc.id
    while (id !== null && !result.has(id)) { if (seen.has(id) || !docs.has(id)) return block('path'); seen.add(id); chain.push(id); id = docs.get(id)!.parentId }
    let current = id === null ? '' : result.get(id)!
    for (let index = chain.length - 1; index >= 0; index--) { const item = docs.get(chain[index])!; current = current ? current + '/' + item.content.title : item.content.title
      if (pathNames.has(current)) return block('path'); pathNames.add(current); result.set(item.id, current) }
  }
  return result
}
function tuple(value: SyncedGroupWire): string { return publicationJson([value.id, value.creationId, value.createdAt, value.origin]) }
function syntaxBlock(value: Block): SyncedStableBlockDraft {
  if ('createdAt' in value) { const { createdAt: _createdAt, ...draft } = value; return draft }
  return value
}
function parsedOwner(record: Host | SyncedGroupWire, path: string): Parsed[] {
  const blocks = record.kind === 'document' ? record.content.blocks : record.blocks.map(syntaxBlock)
  // This stricter source capture rejects unmappable cross-block/native spans instead of dropping them.
  const source = captureSyncedCreateSourceFacts(blocks)
  const actual = collectDocumentMarkdownLinks(blocks)
  const styles = new Map(actual.map(item => [publicationJson([item.blockId, item.start, item.end, item.kind === 'wiki' ? 'wiki' : 'markdown']), 'syntax' in item ? item.syntax : undefined]))
  const result: Parsed[] = source.links.map(item => ({ key: { field: 'block', ...item.key }, url: item.url, image: item.image,
    syntax: styles.get(publicationJson([item.key.blockId, item.key.from, item.key.to, item.key.syntax])) }))
  if (record.kind === 'document') for (const link of collectMarkdownSourceLinks(record.content.summary)) result.push({
    key: { field: 'summary', blockId: null, from: link.start, to: link.end, raw: record.content.summary.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' },
    url: link.url, image: link.kind === 'image', syntax: 'syntax' in link ? link.syntax : undefined })
  return result.filter(item => item.image || item.key.syntax === 'wiki' || resolveMarkdownDocumentPath(path, item.url) !== null)
}
function checkTarget(target: SyncedLinkTarget): void {
  if (!target || typeof target !== 'object') return publicationInvalid('both typed target不是闭集对象。')
  const identity = (value: unknown): void => { if (!isSyncedBlockId(value)) return publicationInvalid('both typed target稳定ID无效。') }
  const state = (): void => { if (!('state' in target) || target.state !== 'live' && target.state !== 'missing') return publicationInvalid('both target状态无效。') }
  if (target.kind === 'document') { assertSyncedShape(target, ['kind', 'id', 'state']); identity(target.id); state() }
  else if (target.kind === 'block') { assertSyncedShape(target, ['kind', 'id', 'documentId', 'state']); identity(target.id); if (target.documentId !== null) identity(target.documentId); state() }
  else if (target.kind === 'heading') { assertSyncedShape(target, ['kind', 'documentId', 'slug', 'state']); identity(target.documentId); if (typeof target.slug !== 'string') return publicationInvalid('both heading slug无效。'); state() }
  else if (target.kind === 'unresolved-url') { assertSyncedShape(target, ['kind', 'path', 'fragment']); if (typeof target.path !== 'string' || target.fragment !== null && typeof target.fragment !== 'string') return publicationInvalid('both unresolved target无效。') }
  else return publicationInvalid('both typed target种类无效。')
}
function checkKey(key: SyncedBothSourceKey): void {
  assertSyncedShape(key, ['field', 'blockId', 'from', 'to', 'raw', 'syntax'])
  if (key.field !== 'block' && key.field !== 'summary' || (key.field === 'summary' ? key.blockId !== null : !isSyncedBlockId(key.blockId))) {
    return publicationInvalid('both source location身份无效。')
  }
  if (!Number.isSafeInteger(key.from) || !Number.isSafeInteger(key.to) || key.from < 0 || key.to < key.from || typeof key.raw !== 'string'
    || key.syntax !== 'markdown' && key.syntax !== 'wiki') return publicationInvalid('both source Key范围/语法无效。')
}
function sources(input: ComponentInput, local: Records): Map<string, { source: SyncedBothOwnerSourceLinks; parsed: Parsed[] }> {
  assertExchangeData(input.sourceLinks)
  if (!Array.isArray(input.sourceLinks)) return publicationInvalid('both sources不是数组。')
  const result = new Map<string, { source: SyncedBothOwnerSourceLinks; parsed: Parsed[] }>(), localPaths = paths(local)
  for (const source of input.sourceLinks) {
    assertSyncedShape(source, ['ownerKey', 'recordHash', 'path', 'complete', 'links', 'images'])
    if (typeof source.complete !== 'boolean' || !Array.isArray(source.links) || !Array.isArray(source.images)) return publicationInvalid('both source闭集/complete无效。')
    if (result.has(source.ownerKey)) return publicationInvalid('both source owner重复。')
    const entry = local.get(source.ownerKey)
    if (!entry || entry.hash !== source.recordHash || entry.record.kind !== 'document' && entry.record.kind !== 'synced-group') return publicationInvalid('both source未准确关联原L owner/hash。')
    if (!source.complete) { result.set(source.ownerKey, { source, parsed: [] }); continue }
    const path = entry.record.kind === 'document' ? localPaths.get(entry.record.id)! : entry.record.origin.pathAtCreation
    if (entry.record.kind === 'document' ? source.path !== path : source.path !== null) return publicationInvalid('both source path不属于原L解析上下文。')
    const parsed = parsedOwner(entry.record, path), actualLinks = parsed.filter(item => !item.image), actualImages = parsed.filter(item => item.image)
    const expectedLinks = unique(actualLinks, item => sourceKey(item.key), 'both实际source links重复。')
    const supplied = unique(source.links, item => sourceKey(item.key), 'both source links重复。')
    if (supplied.size !== expectedLinks.size) return publicationInvalid('both source未完整覆盖真实navigation目的地。')
    for (const item of source.links) {
      assertSyncedShape(item, ['key', 'url', 'target']); checkKey(item.key); checkTarget(item.target)
      const actual = expectedLinks.get(sourceKey(item.key))
      if (!actual || actual.url !== item.url) return publicationInvalid('both source完整Key/URL与真实parser不符。')
    }
    // Managed portable image spelling is independently checked by the full portable codec;
    // its URL never changes in a fork. Non-managed image ranges must be exact here.
    const suppliedImages = unique(source.images, item => sourceKey(item.key), 'both source images重复。'), expectedImages = new Map(actualImages.map(item => [sourceKey(item.key), item]))
    for (const actual of actualImages) if (!/^knowbook-asset:/i.test(actual.url)) {
      const item = suppliedImages.get(sourceKey(actual.key)); if (!item || item.url !== actual.url) return publicationInvalid('both image来源范围不完整。')
    }
    for (const item of source.images) {
      assertSyncedShape(item, ['key', 'url']); checkKey(item.key)
      const content = item.key.field === 'summary' && entry.record.kind === 'document' ? entry.record.content.summary
        : (entry.record.kind === 'document' ? entry.record.content.blocks : entry.record.blocks).find(child => child.id === item.key.blockId)?.content
      if (content === undefined || content.slice(item.key.from, item.key.to) !== item.key.raw) return publicationInvalid('both image来源不在原physical范围。')
      if (!/^knowbook-asset:/i.test(item.url) && expectedImages.get(sourceKey(item.key))?.url !== item.url) return publicationInvalid('both image来源不是实际image。')
      if (/^knowbook-asset:/i.test(item.url)) parseSyncedPortableAssetUri(item.url)
    }
    if (entry.record.kind === 'synced-group') {
      const bindings = unique(entry.record.bindings, binding => sourceKey({ field: 'block', ...binding }), 'both canonical source binding重复。')
      if (bindings.size !== supplied.size) return publicationInvalid('both canonical source缺binding闭包。')
      for (const item of source.links) { const binding = bindings.get(sourceKey(item.key)); if (!binding || !same(binding.target, item.target)) return publicationInvalid('both canonical typed target不是原wire来源。') }
    }
    result.set(source.ownerKey, { source, parsed })
  }
  return result
}
function requireSource(source: ReturnType<typeof sources>, ownerKey: string): { source: SyncedBothOwnerSourceLinks; parsed: Parsed[] } {
  const result = source.get(ownerKey); if (!result?.source.complete) return block(); return result
}
function description(input: ComponentInput): Extract<SyncedBothDescription, { status: 'eligible' }> {
  const local = entries(input.local), remote = entries(input.remote), original = entries(input.selectedOriginal), part = new Set(input.component.keys)
  if (part.size !== input.component.keys.length || new Set(input.conflictedKeys).size !== input.conflictedKeys.length || input.conflictedKeys.some(key => !part.has(key))) return publicationInvalid('both原component/conflicted keys不闭合。')
  const source = sources(input, local), requiredDocs = new Set<string>(), requiredGroups = new Set<string>()
  for (const key of part) {
    const l = local.get(key), r = remote.get(key), selected = original.get(key)
    if (!selected || !isLive(selected.record) || l && !isLive(l.record) || r && !isLive(r.record)) return block('tombstone')
    if (l && r && l.record.kind !== r.record.kind || l && l.record.kind !== selected.record.kind || r && r.record.kind !== selected.record.kind) return block('incarnation')
    if (l?.record.kind === 'synced-group' && r?.record.kind === 'synced-group' && tuple(l.record) !== tuple(r.record)) return block('incarnation')
    if (input.conflictedKeys.includes(key)) {
      if (!l || !r) return publicationInvalid('both真双改来源缺L/R。')
      if (selected.hash !== r.hash) return publicationInvalid('both真冲突原ID支必须是准确R。')
      if (l.record.kind === 'document') requiredDocs.add(l.record.id)
      else if (l.record.kind === 'synced-group') requiredGroups.add(l.record.id)
      else return block('catalog')
    }
  }
  if (!requiredDocs.size && !requiredGroups.size) return block('dependency')
  // Preserve local visibility of every copied host; do not force copies of unchanged Origin/target docs.
  const docRequirements = new Map<string, { docs: string[]; groups: string[] }>()
  for (const { record } of local.values()) if (record.kind === 'document' && part.has('doc:' + record.id)) {
    const deps = { docs: [] as string[], groups: [] as string[] }
    if (record.parentId !== null && !host(original.get('doc:' + record.parentId))) {
      if (!part.has('doc:' + record.parentId) || !host(local.get('doc:' + record.parentId))) return block('path')
      deps.docs.push(record.parentId)
    }
    for (const child of record.content.blocks) if (child.type === 'synced-block') {
      const groupId = parseSyncedBlockPayload(child.content).groupId, l = local.get('group:' + groupId), chosen = original.get('group:' + groupId)
      if (!l || !chosen || !group(l) || !group(chosen)) return block('dependency')
      if (l.hash !== chosen.hash) { if (!part.has('group:' + groupId)) return block('dependency'); deps.groups.push(groupId) }
    }
    docRequirements.set(record.id, { docs: sorted(deps.docs), groups: sorted(deps.groups) })
  }
  const pendingDocs = [...requiredDocs]
  for (let offset = 0; offset < pendingDocs.length; offset++) { const id = pendingDocs[offset]
    const deps = docRequirements.get(id); if (!deps) return block('dependency')
    for (const parent of deps.docs) if (!requiredDocs.has(parent)) { requiredDocs.add(parent); pendingDocs.push(parent) }
    for (const groupId of deps.groups) requiredGroups.add(groupId)
  }
  const copyDocuments: SyncedBothCopySource[] = []
  for (const { key, record, hash: sourceHash } of local.values()) if (record.kind === 'document' && part.has(key)) {
    if (requiredDocs.has(record.id)) requireSource(source, key)
    else if (!source.get(key)?.source.complete) continue
    const deps = docRequirements.get(record.id)!
    copyDocuments.push({ sourceDocumentId: record.id, sourceHash, required: requiredDocs.has(record.id), requiredCopyDocumentIds: deps.docs, requiredGroupIds: deps.groups })
  }
  const groups: SyncedBothGroupSource[] = [], offeredCopyIds = new Set(copyDocuments.map(doc => doc.sourceDocumentId)), offeredGroupIds = new Set(requiredGroups)
  for (const doc of copyDocuments) for (const id of doc.requiredGroupIds) offeredGroupIds.add(id)
  const localOccurrences = new Map<string, Array<{ doc: Host; child: SyncedStableBlockDraft }>>()
  for (const { record: doc } of local.values()) if (doc.kind === 'document') for (const child of doc.content.blocks) if (child.type === 'synced-block') {
    const id = parseSyncedBlockPayload(child.content).groupId, list = localOccurrences.get(id) ?? []; list.push({ doc, child }); localOccurrences.set(id, list)
  }
  for (const { key, record, hash: sourceHash } of local.values()) if (record.kind === 'synced-group' && part.has(key) && (requiredGroups.has(record.id)
    || offeredGroupIds.has(record.id))) {
    requireSource(source, key)
    const hosts: SyncedBothGroupSource['hosts'] = []
    for (const { doc, child } of localOccurrences.get(record.id) ?? []) {
      if (!part.has('doc:' + doc.id)) return block('dependency')
      if (offeredCopyIds.has(doc.id)) hosts.push({ sourceDocumentId: doc.id, sourceInstanceId: child.id, destination: 'copied', required: requiredDocs.has(doc.id) })
      const selectedDoc = host(original.get('doc:' + doc.id)), occurrence = selectedDoc?.content.blocks.find(item => item.id === child.id)
      if (!requiredDocs.has(doc.id) && selectedDoc && occurrence?.type === 'synced-block' && parseSyncedBlockPayload(occurrence.content).groupId === record.id
        && occurrence.depth === child.depth && occurrence.parentBlockId === child.parentBlockId) hosts.push({ sourceDocumentId: doc.id, sourceInstanceId: child.id, destination: 'existing', required: false })
    }
    groups.push({ sourceGroupId: record.id, sourceHash, required: requiredGroups.has(record.id), hosts: hosts.sort((a, b) => publicationCompare(instanceKey(a.sourceDocumentId, a.sourceInstanceId, a.destination), instanceKey(b.sourceDocumentId, b.sourceInstanceId, b.destination))) })
  }
  return { status: 'eligible', copyDocuments: copyDocuments.sort((a, b) => publicationCompare(a.sourceDocumentId, b.sourceDocumentId)), groups: groups.sort((a, b) => publicationCompare(a.sourceGroupId, b.sourceGroupId)) }
}
export function describeSyncedBothComponent(input: SyncedBothDescribeInput): SyncedBothDescription {
  try { return description(input) } catch (cause) {
    if (cause instanceof Blocked) return { status: 'blocked', reason: cause.reason, keys: sorted(input.component.keys) }
    if (cause instanceof UnsupportedSyncedHostCreate) return { status: 'blocked', reason: 'semantic-binding', keys: sorted(input.component.keys) }
    throw cause
  }
}

function catalogClone(local: Records, original: Records, copied: ReadonlySet<string>, allocation: SyncedBothAllocation,
  copiedBlocks: readonly Block[]): { record: SyncDatabases; entities: SyncedExchangeBothForkSummary['entities'] } {
  const left = local.get('databases')?.record, selected = original.get('databases')?.record
  if (left?.kind !== 'databases' || selected?.kind !== 'databases') return block('catalog')
  const result = structuredClone(selected), tables = left.tables, target = result.tables, entityMap = unique(allocation.entities, row => row.sourceEntityId, 'both entity allocation重复。')
  const entities = tables.database_entities.filter(row => typeof row.document_id === 'string' && copied.has(row.document_id)), sourceEntities = new Map(entities.map(row => [row.id, row]))
  const selectedEntityIds = new Set(entities.map(row => row.id)), documentMap = new Map(allocation.documents.filter(row => copied.has(row.sourceDocumentId)).map(row => [row.sourceDocumentId, row.documentId]))
  const byId = (rows: SyncRow[]) => new Map(rows.filter(row => typeof row.id === 'string').map(row => [row.id as string, row]))
  const localDatabases = byId(tables.databases), selectedDatabases = byId(target.databases), localColumns = byId(tables.document_database_columns), selectedColumns = byId(target.document_database_columns)
  const localViews = byId(tables.database_saved_views), selectedViews = byId(target.database_saved_views)
  function database(id: unknown): void { if (typeof id !== 'string' || !localDatabases.has(id) || !same(localDatabases.get(id), selectedDatabases.get(id))) return block('catalog') }
  function column(id: unknown, databaseId?: string): void {
    if (typeof id !== 'string') return block('catalog')
    if (id.startsWith('__')) return
    const row = localColumns.get(id)
    if (!row || databaseId !== undefined && row.database_id !== databaseId || !same(row, selectedColumns.get(id))) return block('catalog')
    database(row.database_id)
  }
  for (const child of copiedBlocks) if (child.type === 'database-view') {
    const payload = parseDatabaseViewPayload(child.content)
    mapDatabaseViewReferences(payload, { databaseId: id => { database(id); return id },
      viewId: (databaseId, id) => { const row = localViews.get(id); if (!row || row.database_id !== databaseId || !same(row, selectedViews.get(id))) return block('catalog'); return id },
      fieldId: (databaseId, id) => { column(id, databaseId); return id } })
  }
  const summary: SyncedExchangeBothForkSummary['entities'] = []
  for (const row of entities) {
    if (typeof row.id !== 'string' || typeof row.document_id !== 'string') return block('catalog')
    database(row.database_id)
    const mapped = entityMap.get(row.id), documentId = documentMap.get(row.document_id)
    if (!mapped || !documentId) return publicationInvalid('both复制真实membership缺固定entity/doc allocation。')
    if (target.database_entities.some(item => item.id === mapped.entityId)) return block('catalog')
    target.database_entities.push({ ...row, id: mapped.entityId, document_id: documentId, created_at: mapped.createdAt })
    summary.push({ sourceEntityId: row.id, entityId: mapped.entityId, documentId })
  }
  for (const row of tables.database_entity_values) if (selectedEntityIds.has(row.entity_id)) {
    const sourceEntity = sourceEntities.get(row.entity_id)!
    column(row.column_id, typeof sourceEntity.database_id === 'string' ? sourceEntity.database_id : undefined)
    const mapped = typeof row.entity_id === 'string' ? entityMap.get(row.entity_id) : undefined
    if (!mapped) return publicationInvalid('both entity values缺固定来源映射。')
    target.database_entity_values.push({ ...row, entity_id: mapped.entityId })
  }
  for (const row of tables.document_database_values) {
    const copiedDocument = typeof row.document_id === 'string' && copied.has(row.document_id)
    const copiedEntity = row.entity_id !== null && selectedEntityIds.has(row.entity_id)
    if (!copiedDocument && !copiedEntity) continue
    if (row.document_id !== null && !copiedDocument || row.entity_id !== null && !copiedEntity) return block('catalog')
    column(row.column_id)
    target.document_database_values.push({ ...row,
      document_id: row.document_id === null ? null : documentMap.get(row.document_id as string)!,
      entity_id: row.entity_id === null ? null : entityMap.get(row.entity_id as string)!.entityId })
  }
  // The wire catalog validator is the authority for its original row keys, ASCII NOCASE,
  // nullable/FK constraints and all original limits. Do not normalize authored values.
  for (const rows of Object.values(target)) rows.sort((a, b) => publicationCompare(publicationJson(a), publicationJson(b)))
  return { record: result, entities: summary.sort((a, b) => publicationCompare(a.sourceEntityId, b.sourceEntityId)) }
}

type HeadingFact = MarkdownHeadingTarget & { identity: string }
type HeadingIndex = Map<string, { slug: Map<string, HeadingFact>; identity: Map<string, HeadingFact>; text: Map<string, HeadingFact> }>
function indexHeadings(values: Map<string, HeadingFact[]>): HeadingIndex {
  return new Map([...values].map(([id, headings]) => {
    const slug = new Map<string, HeadingFact>(), identity = new Map<string, HeadingFact>(), text = new Map<string, HeadingFact>()
    for (const item of headings) { if (!slug.has(item.slug)) slug.set(item.slug, item); identity.set(item.identity, item)
      const key = item.text.normalize('NFC').toLowerCase(); if (!text.has(key)) text.set(key, item) }
    return [id, { slug, identity, text }] as const
  }))
}
function headingNamespaces(records: Records): Map<string, HeadingFact[]> {
  const docs = [...records.values()].flatMap(row => row.record.kind === 'document' ? [row.record] : [])
  const groups = [...records.values()].flatMap(row => row.record.kind === 'synced-group' ? [row.record] : [])
  const graph = validateSyncedWorkspaceGraph(docs.map(doc => ({ documentId: doc.id, blocks: doc.content.blocks })), groups), result = new Map<string, HeadingFact[]>()
  const groupMap = new Map(graph.groups.map(item => [item.id, item])), graphDocuments = new Map(graph.documents.map(item => [item.documentId, item]))
  for (const doc of docs) {
    const identity = (instanceId: string | null, blockId: string): string => publicationJson([instanceId, blockId])
    const referenced = new Set(doc.content.blocks.flatMap(child => child.type === 'synced-block' ? [parseSyncedBlockPayload(child.content).groupId] : []))
    // The complete graph was validated once above. A per-host iterator view avoids
    // rebuilding every unrelated group index for each document.
    const view = { ...graph, documents: [graphDocuments.get(doc.id)!], groups: [...referenced].map(id => groupMap.get(id)!) }
    const expanded = [...expandSyncedGraphDocument(view, doc.id)].map(item => ({ ...syntaxBlock(item.block),
      id: identity(item.instanceId, item.block.id), depth: item.depth,
      parentBlockId: item.parent === null ? null : identity(item.parent.instanceId, item.parent.blockId) }))
    result.set(doc.id, getMarkdownHeadingTargets(expanded, doc.content.title).map(item => ({ ...item, identity: item.key })))
  }
  return result
}
interface Lookup {
  records: Records; paths: Map<string, string>; docs: Map<string, Host>; byPath: Map<string, Host>; byAsciiPath: Map<string, Host>; byTitle: Map<string, Host[]>; owners: Map<string, string>; headings?: HeadingIndex
}
const ascii = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase())
function lookup(records: Records): Lookup {
  const pathMap = paths(records), docs = new Map<string, Host>(), byPath = new Map<string, Host>(), byAsciiPath = new Map<string, Host>(), byTitle = new Map<string, Host[]>(), owners = new Map<string, string>()
  for (const { key, record } of records.values()) {
    if (record.kind === 'document') { docs.set(record.id, record); byPath.set(pathMap.get(record.id)!, record); byAsciiPath.set(ascii(pathMap.get(record.id)!), record)
      const title = ascii(record.content.title), list = byTitle.get(title) ?? []; list.push(record); byTitle.set(title, list) }
    const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
    for (const child of blocks) { if (owners.has(child.id)) return block('owner-source'); owners.set(child.id, key) }
  }
  return { records, paths: pathMap, docs, byPath, byAsciiPath, byTitle, owners }
}
function lookupDocument(context: Lookup, url: string, sourcePath: string, wiki: boolean): { id: string; fragment: string } | null {
  const pathMap = context.paths
  const byPath = (path: string): { id: string; path: string } | undefined => {
    const exact = context.byPath.get(path)
    if (exact) return { id: exact.id, path }
    if (!wiki) return undefined
    const found = context.byAsciiPath.get(ascii(path))
    return found ? { id: found.id, path: pathMap.get(found.id)! } : undefined
  }
  if (wiki) {
    const reference = parseWikiReference(url)
    if (!reference.path && reference.hasFragment) {
      const id = context.byPath.get(sourcePath)?.id
      return id ? { id, fragment: reference.fragment } : null
    }
    const found = resolveWikiDocument(url, sourcePath, { byPath, byTitle: title => (context.byTitle.get(ascii(title)) ?? []).map(doc => ({ id: doc.id, path: pathMap.get(doc.id)! })) })
    return found ? { id: found.document.id, fragment: found.reference.fragment } : null
  }
  const resolved = resolveMarkdownDocumentPath(sourcePath, url), found = resolved ? byPath(resolved.path) : undefined
  return found && resolved ? { id: found.id, fragment: resolved.fragment } : null
}
function urlResolves(context: Lookup, url: string, sourcePath: string, wiki: boolean): boolean {
  if (wiki) { const reference = parseWikiReference(url); if (!reference.hasFragment && context.owners.has(reference.target)) return true }
  const found = lookupDocument(context, url, sourcePath, wiki)
  if (!found) return false
  if (!found.fragment) return true
  if (found.fragment.startsWith('^') || /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(found.fragment)) return context.owners.has(found.fragment.replace(/^\^/, ''))
  context.headings ??= indexHeadings(headingNamespaces(context.records))
  const headings = context.headings.get(found.id)
  return Boolean(headings?.slug.has(found.fragment) || wiki && headings?.text.has(found.fragment.normalize('NFC').toLowerCase()))
}
// An existing destination keeps the selected original host's ordinary bytes.
// Its source is that actual retained branch, never the separate L source ticket.
function retainedHostViews(records: Records) {
  const docs = [...records.values()].flatMap(row => row.record.kind === 'document' ? [row.record] : [])
  const groups = [...records.values()].flatMap(row => row.record.kind === 'synced-group' ? [row.record] : [])
  const graph = validateSyncedWorkspaceGraph(docs.map(doc => ({ documentId: doc.id, blocks: doc.content.blocks })), groups)
  const byDoc = new Map(docs.map(doc => [doc.id, doc])), graphDocs = new Map(graph.documents.map(doc => [doc.documentId, doc]))
  const byGroup = new Map(graph.groups.map(item => [item.id, item])), wires = new Map(groups.map(item => [item.id, item]))
  const bindingMaps = new Map(groups.map(item => [item.id, new Map(item.bindings.map(binding => [sourceKey({ field: 'block', ...binding }), binding.target]))]))
  return (documentId: string) => {
    const doc = byDoc.get(documentId); if (!doc) return block('dependency')
    const referenced = new Set(doc.content.blocks.flatMap(child => child.type === 'synced-block' ? [parseSyncedBlockPayload(child.content).groupId] : []))
    const view = { ...graph, documents: [graphDocs.get(documentId)!], groups: [...referenced].map(id => byGroup.get(id)!) }
    const metadata = new Map<string, { block: Block; groupId: string | null }>(), leaves = new Map(doc.content.blocks.map(child => [child.id, child]))
    const blocks = [...expandSyncedGraphDocument(view, documentId)].map(item => {
      const id = publicationJson([item.instanceId, item.block.id])
      const leaf = item.instanceId === null ? null : leaves.get(item.instanceId)
      const groupId = leaf?.type === 'synced-block' ? parseSyncedBlockPayload(leaf.content).groupId : null
      metadata.set(id, { block: item.block, groupId })
      return { ...syntaxBlock(item.block), id, depth: item.depth,
        parentBlockId: item.parent === null ? null : publicationJson([item.parent.instanceId, item.parent.blockId]) }
    })
    function binding(key: { blockId: string; from: number; to: number; raw: string; syntax: 'wiki' | 'markdown' }): SyncedLinkTarget | null {
      const owner = metadata.get(key.blockId); if (!owner) return block()
      if (owner.groupId === null) return null
      if (!wires.has(owner.groupId)) return block('dependency')
      const target = bindingMaps.get(owner.groupId)?.get(sourceKey({ field: 'block', ...key, blockId: owner.block.id }))
      if (!target) return block()
      return target
    }
    return { doc, blocks, binding }
  }
}
function retainedNavigation(context: Lookup, url: string, sourcePath: string, wiki: boolean): unknown {
  if (wiki) { const reference = parseWikiReference(url)
    if (!reference.hasFragment && context.owners.has(reference.target)) return { kind: 'block', id: reference.target }
  }
  const found = lookupDocument(context, url, sourcePath, wiki)
  if (!found) return { kind: 'unresolved', url }
  if (!found.fragment) return { kind: 'document', documentId: found.id }
  if (found.fragment.startsWith('^') || /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(found.fragment)) {
    const id = found.fragment.replace(/^\^/, '')
    return context.owners.has(id) ? { kind: 'block', id } : { kind: 'unresolved', url }
  }
  context.headings ??= indexHeadings(headingNamespaces(context.records))
  const namespace = context.headings.get(found.id), heading = namespace?.slug.get(found.fragment)
    ?? (wiki ? namespace?.text.get(found.fragment.normalize('NFC').toLowerCase()) : undefined)
  return heading ? { kind: 'heading', documentId: found.id, blockId: heading.blockId, identity: heading.identity } : { kind: 'unresolved', url }
}
function assertRetainedHostSemantics(before: Records, after: Records, documentIds: ReadonlySet<string>,
  mapPhysical: (documentId: string, id: string) => string): void {
  if (!documentIds.size) return
  const oldViews = retainedHostViews(before), nextViews = retainedHostViews(after), oldLookup = lookup(before), nextLookup = lookup(after)
  const sourceDocumentIds = new Set(documentIds)
  // Only a namespace changed by the selected existing occurrence adds external
  // sources. A new copied path is not a new global ordinary-create policy.
  for (const { record } of before.values()) if (record.kind === 'document' && !sourceDocumentIds.has(record.id)) {
    const path = oldLookup.paths.get(record.id)!
    const touches = (url: string, wiki: boolean): boolean => {
      const target = lookupDocument(oldLookup, url, path, wiki)
      return target !== null && documentIds.has(target.id)
    }
    let affected = collectMarkdownSourceLinks(record.content.summary).some(link => link.kind !== 'image' && touches(link.url, link.kind === 'wiki'))
    if (!affected && record.content.blocks.some(child => child.type !== 'synced-block' && /[\[<]|file:/i.test(child.content))) {
      const view = oldViews(record.id), blocks = new Map(view.blocks.map(child => [child.id, child]))
      for (const link of collectDocumentMarkdownLinks(view.blocks)) {
        if (link.kind === 'image' || link.kind !== 'wiki' && resolveMarkdownDocumentPath(path, link.url) === null) continue
        if (touches(link.url, link.kind === 'wiki')) { affected = true; break }
        if (link.blockId === undefined) return block()
        const content = blocks.get(link.blockId)?.content; if (content === undefined) return block()
        const target = view.binding({ blockId: link.blockId, from: link.start, to: link.end, raw: content.slice(link.start, link.end), syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' })
        if (target?.kind === 'heading' && documentIds.has(target.documentId) || target?.kind === 'document' && documentIds.has(target.id)) { affected = true; break }
      }
    }
    if (affected) sourceDocumentIds.add(record.id)
  }
  const mappedNavigation = (value: unknown): unknown => {
    const target = value as { kind: string; documentId?: string; blockId?: string | null; identity?: string }
    if (target.kind !== 'heading' || target.blockId === null) return value
    const id = mapPhysical(target.documentId!, target.blockId!)
    return { ...target, blockId: id, identity: id + target.identity!.slice(target.blockId!.length) }
  }
  for (const documentId of sourceDocumentIds) {
    const old = oldViews(documentId), next = nextViews(documentId)
    const ordinary = old.doc.content.blocks.filter(child => child.type !== 'synced-block')
    if (!same(ordinary, next.doc.content.blocks.filter(child => child.type !== 'synced-block')) || old.doc.content.summary !== next.doc.content.summary) return block()
    const oldPath = oldLookup.paths.get(documentId)!, nextPath = nextLookup.paths.get(documentId)!
    function navigation(url: string, syntax: 'wiki' | 'markdown'): void {
      if (syntax !== 'wiki' && resolveMarkdownDocumentPath(oldPath, url) === null) return
      if (!same(mappedNavigation(retainedNavigation(oldLookup, url, oldPath, syntax === 'wiki')), retainedNavigation(nextLookup, url, nextPath, syntax === 'wiki'))) return block()
    }
    for (const link of collectMarkdownSourceLinks(old.doc.content.summary)) if (link.kind !== 'image') navigation(link.url, link.kind === 'wiki' ? 'wiki' : 'markdown')
    if (!ordinary.some(child => /[\[<]|file:/i.test(child.content))) continue
    const previous = captureSyncedCreateSourceFacts(old.blocks), actual = captureSyncedCreateSourceFacts(next.blocks)
    const oldBlocks = new Map(old.blocks.map(child => [child.id, child])), newBlocks = new Map(next.blocks.map(child => [child.id, child]))
    const oldUnitsByBlock = new Map<string, typeof previous.units>(), newUnitsByBlock = new Map<string, typeof actual.units>(), linksByBlock = new Map<string, typeof previous.links>()
    for (const unit of previous.units) { const list = oldUnitsByBlock.get(unit.blockId) ?? []; list.push(unit); oldUnitsByBlock.set(unit.blockId, list) }
    for (const unit of actual.units) { const list = newUnitsByBlock.get(unit.blockId) ?? []; list.push(unit); newUnitsByBlock.set(unit.blockId, list) }
    for (const link of previous.links) { const list = linksByBlock.get(link.key.blockId) ?? []; list.push(link); linksByBlock.set(link.key.blockId, list) }
    const ordinaryIds = new Set(ordinary.map(child => publicationJson([null, child.id])))
    if (!same(previous.units.filter(unit => ordinaryIds.has(unit.blockId)), actual.units.filter(unit => ordinaryIds.has(unit.blockId)))) return block()
    // The same literal use may inherit a different canonical definition. Require
    // the effective physical definition and its reachable definition closure,
    // not a URL lookup or the other branch's source-range array.
    const pending = [...ordinaryIds].flatMap(id => [...(previous.uses.get(id) ?? [])]), visited = new Set<string>()
    for (const id of ordinaryIds) if (!same(sorted(previous.uses.get(id) ?? []), sorted(actual.uses.get(id) ?? []))) return block()
    while (pending.length) {
      const key = pending.pop()!; if (visited.has(key)) continue; visited.add(key)
      const definition = previous.effective.get(key), observed = actual.effective.get(key)
      if (!definition || !observed || observed.blockId !== mapPhysical(documentId, definition.blockId)
        || definition.from !== observed.from || definition.to !== observed.to || definition.kind !== observed.kind || definition.label !== observed.label) return block()
      const left = oldBlocks.get(definition.blockId), right = newBlocks.get(observed.blockId)
      if (!left || !right || left.content.slice(definition.from, definition.to) !== right.content.slice(observed.from, observed.to)) return block()
      const oldUnits = (oldUnitsByBlock.get(definition.blockId) ?? []).filter(unit => unit.to > definition.from && unit.from < definition.to)
      const newUnits = (newUnitsByBlock.get(observed.blockId) ?? []).filter(unit => unit.to > observed.from && unit.from < observed.to)
      if (!same(oldUnits.map(unit => ({ ...unit, blockId: observed.blockId })), newUnits)) return block()
      const oldUses = previous.uses.get(definition.blockId) ?? new Set<string>(), newUses = actual.uses.get(observed.blockId) ?? new Set<string>()
      if (!same(sorted(oldUses), sorted(newUses))) return block()
      pending.push(...oldUses)
      const links = (linksByBlock.get(definition.blockId) ?? []).filter(link => link.key.from >= definition.from && link.key.to <= definition.to)
      for (const link of links) {
        const target = old.binding(link.key), observedTarget = next.binding({ ...link.key, blockId: observed.blockId })
        if (!same(target, observedTarget)) return block()
        if (!link.image && target === null) navigation(link.url, link.key.syntax)
      }
    }
    for (const link of previous.links) if (!link.image && ordinaryIds.has(link.key.blockId)) navigation(link.url, link.key.syntax)
  }
}
function rawUrl(target: SyncedLinkTarget, old: SyncedBothSourceLink, context: { oldPath: string; newPath: string; graph: Lookup }): string {
  const wiki = old.key.syntax === 'wiki', reference = wiki ? parseWikiReference(old.url) : null, local = wiki ? null : parseLocalMarkdownUrl(old.url)
  const tail = wiki ? reference!.alias === null ? '' : old.url.slice(old.url.indexOf('|')) : local?.suffix.split('#', 1)[0] ?? ''
  let path: string, fragment: string | null = null
  if (target.kind === 'document' || target.kind === 'heading') {
    const id = target.kind === 'document' ? target.id : target.documentId, known = context.graph.paths.get(id)
    if (!known) {
      const original = wiki ? null : resolveMarkdownDocumentPath(context.oldPath, old.url)
      if (!original) { if (context.oldPath === context.newPath) return old.url; return block() }
      path = original.path
    } else path = known
    if (target.kind === 'heading') fragment = target.slug
  } else if (target.kind === 'block') {
    const ownerKey = context.graph.owners.get(target.id)
    if (ownerKey?.startsWith('doc:')) path = context.graph.paths.get(ownerKey.slice(4))!
    else if (ownerKey?.startsWith('group:')) path = ''
    else {
      const original = !wiki ? resolveMarkdownDocumentPath(context.oldPath, old.url) : null
      if (!original) { if (context.oldPath === context.newPath) return old.url; return block() }
      path = original.path
    }
    fragment = '^' + target.id
  } else {
    path = target.path; fragment = target.fragment
    // An unresolved source remains unresolved in the final graph; a new path may not activate it.
    const probe = wiki ? path + (fragment ? '#' + fragment : '') : '/' + path.split('/').map(encodeURIComponent).join('/') + '.md' + (fragment ? '#' + encodeURIComponent(fragment) : '')
    if (urlResolves(context.graph, probe, context.newPath, wiki)) return block()
  }
  if (wiki) {
    const value = path + (fragment !== null ? '#' + fragment : '') + tail
    const resolved = lookupDocument(context.graph, value, context.newPath, true)
    if ((target.kind === 'document' || target.kind === 'heading') && context.graph.paths.has(target.kind === 'document' ? target.id : target.documentId)
      && resolved?.id !== (target.kind === 'document' ? target.id : target.documentId)) return block()
    return value
  }
  return (path ? '/' + path.split('/').map(encodeURIComponent).join('/') + '.md' : '') + tail + (fragment !== null ? '#' + encodeURIComponent(fragment) : '')
}

interface Edit { from: number; to: number; text: string }
function editKey(key: SyncedBothSourceKey, edits: readonly Edit[], content: string, blockId: string | null): SyncedBothSourceKey {
  let from = key.from, to = key.to
  for (const edit of edits) {
    const delta = edit.text.length - (edit.to - edit.from)
    if (edit.to <= key.from) { from += delta; to += delta }
    else if (edit.from >= key.to) continue
    else if (key.from === edit.from && key.to === edit.to) to += delta
    else return block()
  }
  return { ...key, blockId, from, to, raw: content.slice(from, to) }
}
function time(value: string): void { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return publicationInvalid('both固定birth日期无效。') }
function uuid(value: string): void { if (!isSyncedUuid(value)) return publicationInvalid('both新身份必须是Main固定UUID。') }
function plan(input: SyncedBothForkInput): Extract<SyncedBothForkResult, { status: 'planned' }> {
  const described = description(input), local = entries(input.local), remote = entries(input.remote), original = entries(input.selectedOriginal)
  const finalLocal = entries(input.retainedLocal), finalRemote = entries(input.retainedRemote), part = new Set(input.component.keys)
  const source = sources(input, local), localPaths = paths(local), allocation = input.allocation, decision = input.decision
  assertExchangeData(allocation); assertExchangeData(decision)
  assertSyncedShape(allocation, ['kind', 'version', 'previewId', 'allocatedAt', 'documents', 'groups', 'blocks', 'instances', 'entities', 'missing'])
  assertSyncedShape(decision, ['componentId', 'copyDocumentIds', 'groups'])
  if (allocation.kind !== 'synced-exchange-both-allocation' || allocation.version !== 1 || decision.componentId !== input.component.componentId) return publicationInvalid('both allocation/decision不属于原component。')
  time(allocation.allocatedAt); uuid(allocation.previewId)
  const requestedDocs = unique(decision.copyDocumentIds, id => id, 'both doc selector重复。'), requestedGroups = unique(decision.groups, item => item.groupId, 'both group selector重复。')
  const offeredDocs = new Map(described.copyDocuments.map(row => [row.sourceDocumentId, row])), offeredGroups = new Map(described.groups.map(row => [row.sourceGroupId, row]))
  const requiredGroups = new Set(described.groups.filter(row => row.required).map(row => row.sourceGroupId))
  for (const row of described.copyDocuments) if (row.required && !requestedDocs.has(row.sourceDocumentId)) return publicationInvalid('both遗漏真实强制doc copy。')
  for (const id of requestedDocs.keys()) {
    const offered = offeredDocs.get(id); if (!offered) return publicationInvalid('both选择未展示copy document。')
    for (const parent of offered.requiredCopyDocumentIds) if (!requestedDocs.has(parent)) return publicationInvalid('both遗漏已展示parent copy closure。')
    for (const groupId of offered.requiredGroupIds) requiredGroups.add(groupId)
  }
  if (!same(sorted(requestedGroups.keys()), sorted(requiredGroups))) return publicationInvalid('both group selectors未准确覆盖所选local-visible closure。')
  const docAlloc = unique(allocation.documents, row => row.sourceDocumentId, 'both固定document map重复。'), groupAlloc = unique(allocation.groups, row => row.sourceGroupId, 'both固定group map重复。')
  const blockAlloc = unique(allocation.blocks, row => blockKey(row.sourceOwnerKey, row.sourceBlockId), 'both固定physical block map重复。')
  const instanceAlloc = unique(allocation.instances, row => instanceKey(row.sourceDocumentId, row.sourceInstanceId, row.destination), 'both固定instance map重复。')
  const missingAlloc = unique(allocation.missing, row => row.sourceId, 'both固定missing map重复。')
  const copiedDocs = new Map<string, CopyDoc>(), forkGroups = new Map<string, ForkGroup>(), selectedInstances: SyncedBothAllocation['instances'] = [], selectedKeys = new Set<string>()
  for (const id of requestedDocs.keys()) { const row = docAlloc.get(id); if (!row) return publicationInvalid('both所选doc缺固定allocation。'); copiedDocs.set(id, row) }
  for (const groupId of requestedGroups.keys()) {
    const offered = offeredGroups.get(groupId), row = groupAlloc.get(groupId); if (!offered || !row) return publicationInvalid('both所选group缺原预览/allocation。')
    forkGroups.set(groupId, row)
    const chosen = requestedGroups.get(groupId)!, hosts = unique(chosen.hosts, item => instanceKey(item.sourceDocumentId, item.sourceInstanceId, item.destination), 'both host selectors重复。')
    const allowed = new Map(offered.hosts.map(item => [instanceKey(item.sourceDocumentId, item.sourceInstanceId, item.destination), item]))
    for (const [key, selector] of hosts) {
      if (!allowed.has(key) || selector.destination === 'copied' && !copiedDocs.has(selector.sourceDocumentId)) return publicationInvalid('both host未展示或缺所选copy destination。')
      const candidate = instanceAlloc.get(key)
      if (!candidate || candidate.groupId !== row.groupId) return publicationInvalid('both所选host缺准确固定new instance/group。')
      selectedInstances.push(candidate); selectedKeys.add(key)
    }
    for (const [documentId] of copiedDocs) {
      const doc = host(local.get('doc:' + documentId))!
      for (const child of doc.content.blocks) if (child.type === 'synced-block' && parseSyncedBlockPayload(child.content).groupId === groupId
        && !hosts.has(instanceKey(documentId, child.id, 'copied'))) return publicationInvalid('both遗漏copied doc中必需fork occurrence。')
    }
  }
  // Every leaf in a copied host gets a new physical ID, including unchanged shared groups.
  for (const [documentId, copy] of copiedDocs) {
    const doc = host(local.get('doc:' + documentId)); if (!doc) return publicationInvalid('both copy source不是原host。')
    const expectedParent = doc.parentId === null ? null : copiedDocs.get(doc.parentId)?.documentId ?? doc.parentId
    if (copy.parentId !== expectedParent) return publicationInvalid('both固定copy parent不是准确原parent/map。')
    for (const child of doc.content.blocks) if (child.type === 'synced-block') {
      const sourceGroupId = parseSyncedBlockPayload(child.content).groupId, expectedGroupId = forkGroups.get(sourceGroupId)?.groupId ?? sourceGroupId
      const key = instanceKey(documentId, child.id, 'copied'), candidate = instanceAlloc.get(key)
      if (!candidate || candidate.documentId !== copy.documentId || candidate.groupId !== expectedGroupId) return publicationInvalid('both copied leaf缺固定完整instance map。')
      if (!selectedKeys.has(key)) { selectedInstances.push(candidate); selectedKeys.add(key) }
    }
  }
  const chosenInstanceKeys = new Set<string>(), freshIds = new Set<string>(), sourceIds = new Set<string>(), physicalMapping = new Map<string, string>()
  const sourceOwners = new Map<string, string>()
  for (const side of [local, remote, original, finalLocal, finalRemote]) for (const { key, record } of side.values()) {
    if ('id' in record) sourceIds.add(record.id)
    if (record.kind === 'synced-group') { sourceIds.add(record.creationId); sourceIds.add(record.origin.firstInstanceId); sourceIds.add(record.origin.documentId)
      for (const binding of record.bindings) { const target = binding.target
        if (target.kind === 'document' || target.kind === 'block') sourceIds.add(target.id)
        else if (target.kind === 'heading') sourceIds.add(target.documentId) } }
    const blocks = record.kind === 'document' ? record.content.blocks : record.kind === 'synced-group' ? record.blocks : []
    for (const child of blocks) { sourceIds.add(child.id); if (side === local) sourceOwners.set(child.id, key) }
    if (record.kind === 'databases') for (const rows of Object.values(record.tables)) for (const row of rows) if (typeof row.id === 'string') sourceIds.add(row.id)
  }
  for (const owner of input.sourceLinks) for (const link of owner.links) {
    if (link.target.kind === 'document' || link.target.kind === 'block') sourceIds.add(link.target.id)
    else if (link.target.kind === 'heading') sourceIds.add(link.target.documentId)
  }
  function fresh(id: string): void { uuid(id); if (freshIds.has(id) || sourceIds.has(id)) return block('owner-source'); freshIds.add(id) }
  const recordKeys = new Set<string>(), blocksUsed = new Map<string, SyncedBothAllocation['blocks'][number]>()
  for (const copy of copiedDocs.values()) { fresh(copy.documentId); time(copy.createdAt); recordKeys.add('doc:' + copy.documentId) }
  for (const fork of forkGroups.values()) { fresh(fork.groupId); fresh(fork.creationId); time(fork.createdAt); recordKeys.add('group:' + fork.groupId) }
  for (const [sourceId, copy] of copiedDocs) for (const child of host(local.get('doc:' + sourceId))!.content.blocks) if (child.type !== 'synced-block') {
    const row = blockAlloc.get(blockKey('doc:' + sourceId, child.id))
    if (!row || row.ownerKey !== 'doc:' + copy.documentId) return publicationInvalid('both ordinary child缺准确owner allocation。')
    fresh(row.blockId); time(row.createdAt); blocksUsed.set(blockKey('doc:' + sourceId, child.id), row); physicalMapping.set(child.id, row.blockId)
  }
  for (const [sourceId, fork] of forkGroups) for (const child of group(local.get('group:' + sourceId))!.blocks) {
    const row = blockAlloc.get(blockKey('group:' + sourceId, child.id))
    if (!row || row.ownerKey !== 'group:' + fork.groupId) return publicationInvalid('both canonical child缺准确owner allocation。')
    fresh(row.blockId); time(row.createdAt); blocksUsed.set(blockKey('group:' + sourceId, child.id), row); physicalMapping.set(child.id, row.blockId)
  }
  const instancesBySource = new Map<string, SyncedBothAllocation['instances']>()
  for (const row of selectedInstances) {
    const key = instanceKey(row.sourceDocumentId, row.sourceInstanceId, row.destination)
    if (chosenInstanceKeys.has(key)) return publicationInvalid('both selected instance map重复。'); chosenInstanceKeys.add(key)
    fresh(row.instanceId); time(row.createdAt)
    if (row.destination === 'existing' && row.documentId !== row.sourceDocumentId || row.destination === 'copied' && row.documentId !== copiedDocs.get(row.sourceDocumentId)?.documentId) return publicationInvalid('both instance目标宿主与原决定不符。')
    const list = instancesBySource.get(row.sourceInstanceId) ?? []; list.push(row); instancesBySource.set(row.sourceInstanceId, list)
  }
  for (const [sourceId, list] of instancesBySource) {
    const copied = list.filter(row => row.destination === 'copied')
    if (copied.length > 1 || copied.length === 0 && list.length > 1) return block()
    physicalMapping.set(sourceId, (copied[0] ?? list[0]).instanceId)
  }
  for (const fork of forkGroups.values()) {
    uuid(fork.firstInstanceId)
    const sourceGroup = group(local.get('group:' + fork.sourceGroupId))!
    const actual = selectedInstances.filter(row => row.sourceInstanceId === sourceGroup.origin.firstInstanceId && row.groupId === fork.groupId)
    if (actual.length) { if (!actual.some(row => row.instanceId === fork.firstInstanceId)) return publicationInvalid('both firstInstanceId不是原first occurrence的真实map。') }
    else { fresh(fork.firstInstanceId) }
  }
  const linkedTargetIds = new Set(input.sourceLinks.flatMap(owner => owner.links.flatMap(link => link.target.kind === 'block' ? [link.target.id] : [])))
  for (const row of missingAlloc.values()) {
    if (!linkedTargetIds.has(row.sourceId)) continue
    if (sourceOwners.has(row.sourceId)) return publicationInvalid('both missing map不能冒用原live physical身份。')
    const originReference = [...forkGroups.values()].some(fork => fork.firstInstanceId === row.id && group(local.get('group:' + fork.sourceGroupId))!.origin.firstInstanceId === row.sourceId)
    if (!originReference) fresh(row.id)
    physicalMapping.set(row.sourceId, row.id)
  }
  const usedOwners: Array<{ sourceKey: string; destinationKey: string }> = []
  const skeletons = new Map<string, Host | SyncedGroupWire>()
  for (const key of part) {
    const selected = original.get(key); if (!selected) return block('dependency')
    finalLocal.set(key, selected); finalRemote.set(key, selected); recordKeys.add(key)
  }
  const retainedBeforeLocal = new Map(finalLocal), retainedBeforeRemote = new Map(finalRemote)
  for (const [sourceId, copy] of copiedDocs) {
    const originalDoc = host(local.get('doc:' + sourceId))!, blocks = originalDoc.content.blocks.map(child => {
      const mappedParent = child.parentBlockId === null ? null : physicalMapping.get(child.parentBlockId)
      if (child.parentBlockId !== null && !mappedParent) return publicationInvalid('both copied parent child map缺失。')
      if (child.type === 'synced-block') {
        const row = instanceAlloc.get(instanceKey(sourceId, child.id, 'copied'))!
        return { ...child, id: row.instanceId, parentBlockId: mappedParent ?? null, content: publicationJson({ version: 1, groupId: row.groupId }) }
      }
      return { ...child, id: blocksUsed.get(blockKey('doc:' + sourceId, child.id))!.blockId, parentBlockId: mappedParent ?? null }
    })
    const record: Host = { ...originalDoc, id: copy.documentId, createdAt: copy.createdAt, parentId: copy.parentId,
      content: { title: copy.title, summary: originalDoc.content.summary, blocks } }
    skeletons.set('doc:' + copy.documentId, record); usedOwners.push({ sourceKey: 'doc:' + sourceId, destinationKey: 'doc:' + copy.documentId })
    setRecord(finalLocal, record); setRecord(finalRemote, record)
  }
  for (const [sourceId, fork] of forkGroups) {
    const old = group(local.get('group:' + sourceId))!, copiedOrigin = copiedDocs.get(old.origin.documentId)
    const record: SyncedGroupWire = { ...old, id: fork.groupId, creationId: fork.creationId, createdAt: fork.createdAt,
      origin: { ...old.origin, documentId: copiedOrigin?.documentId ?? old.origin.documentId,
        pathAtCreation: copiedOrigin?.path ?? old.origin.pathAtCreation, firstInstanceId: fork.firstInstanceId },
      blocks: old.blocks.map(child => { const mapped = blocksUsed.get(blockKey('group:' + sourceId, child.id))!
        return { ...child, id: mapped.blockId, createdAt: mapped.createdAt, parentBlockId: child.parentBlockId === null ? null : physicalMapping.get(child.parentBlockId)! } }), bindings: [] }
    skeletons.set('group:' + fork.groupId, record); usedOwners.push({ sourceKey: 'group:' + sourceId, destinationKey: 'group:' + fork.groupId })
    // Preserve a temporary syntactically complete binding set while building heading namespaces.
    record.bindings = old.bindings.map(binding => ({ ...binding, blockId: physicalMapping.get(binding.blockId)!, target: { ...binding.target } }))
    setRecord(finalLocal, record); setRecord(finalRemote, record)
  }
  for (const row of selectedInstances) if (row.destination === 'existing') {
    const originalHost = host(finalLocal.get('doc:' + row.documentId)); if (!originalHost) return block('dependency')
    const found = originalHost.content.blocks.find(child => child.id === row.sourceInstanceId)
    if (found?.type !== 'synced-block' || !forkGroups.has(parseSyncedBlockPayload(found.content).groupId)) return block('dependency')
    const record: Host = { ...originalHost, content: { ...originalHost.content, blocks: originalHost.content.blocks.map(child => child.id === row.sourceInstanceId
      ? { ...child, id: row.instanceId, content: publicationJson({ version: 1, groupId: row.groupId }) } : child) } }
    setRecord(finalLocal, record); setRecord(finalRemote, record); recordKeys.add('doc:' + row.documentId)
  }
  const usedEntityIds = new Set<string>()
  const sourceCatalog = local.get('databases')?.record
  if (sourceCatalog?.kind === 'databases') for (const row of sourceCatalog.tables.database_entities) if (typeof row.document_id === 'string' && copiedDocs.has(row.document_id) && typeof row.id === 'string') usedEntityIds.add(row.id)
  for (const row of allocation.entities) if (usedEntityIds.has(row.sourceEntityId)) { fresh(row.entityId); time(row.createdAt) }
  const catalog = catalogClone(local, original, new Set(copiedDocs.keys()), allocation, [...skeletons.values()].flatMap(record => record.kind === 'document' ? record.content.blocks : record.blocks))
  if (hash(catalog.record) !== original.get('databases')?.hash) {
    if (!part.has('databases')) return block('dependency')
    setRecord(finalLocal, catalog.record); setRecord(finalRemote, catalog.record); recordKeys.add('databases')
  }
  const graph = lookup(finalLocal), remoteGraph = lookup(finalRemote)
  for (const copy of copiedDocs.values()) if (graph.paths.get(copy.documentId) !== copy.path || remoteGraph.paths.get(copy.documentId) !== copy.path) return block('path')
  const sourceHeadings = indexHeadings(headingNamespaces(local)), nextHeadings = indexHeadings(headingNamespaces(finalLocal)), mappedHeadingChecks: Array<{ target: Extract<SyncedLinkTarget, { kind: 'heading' }>; identity: string }> = []
  const missingHeadingChecks: Array<{ documentId: string; slug: string }> = []
  const existingRewrites = new Set(selectedInstances.filter(row => row.destination === 'existing').map(row => row.sourceDocumentId))
  const sourceHostBlocks = new Map([...local.values()].flatMap(({ record }) => record.kind === 'document' ? [[record.id, new Map(record.content.blocks.map(child => [child.id, child]))] as const] : []))
  function mappedHeadingIdentity(item: HeadingFact, documentId: string, copied: boolean): string {
    if (item.blockId === null) return item.identity
    let tuple: unknown
    try { tuple = JSON.parse(item.blockId) } catch { return block() }
    if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[0] !== null && typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string') return block()
    let mappedInstance = tuple[0], mappedBlock = tuple[1]
    if (tuple[0] === null) mappedBlock = copied ? blockAlloc.get(blockKey('doc:' + documentId, tuple[1]))?.blockId ?? tuple[1] : tuple[1]
    else {
      const key = instanceKey(documentId, tuple[0], copied ? 'copied' : 'existing'), selected = selectedKeys.has(key) ? instanceAlloc.get(key) : undefined
      if (selected) {
        mappedInstance = selected.instanceId
        const sourceLeaf = sourceHostBlocks.get(documentId)?.get(tuple[0])
        if (sourceLeaf?.type !== 'synced-block') return block()
        const sourceGroupId = parseSyncedBlockPayload(sourceLeaf.content).groupId, fork = forkGroups.get(sourceGroupId)
        if (fork && selected.groupId === fork.groupId) mappedBlock = blockAlloc.get(blockKey('group:' + sourceGroupId, tuple[1]))?.blockId ?? tuple[1]
      }
    }
    return publicationJson([mappedInstance, mappedBlock]) + item.identity.slice(item.blockId.length)
  }
  function mapTarget(value: SyncedLinkTarget): SyncedLinkTarget {
    if (value.kind === 'document') return { ...value, id: copiedDocs.get(value.id)?.documentId ?? value.id }
    if (value.kind === 'block') {
      const id = physicalMapping.get(value.id) ?? value.id, owner = graph.owners.get(id)
      return { ...value, id, documentId: owner?.startsWith('doc:') ? owner.slice(4) : owner?.startsWith('group:') ? null : value.documentId === null ? null : copiedDocs.get(value.documentId)?.documentId ?? value.documentId }
    }
    if (value.kind === 'unresolved-url') return { ...value }
    const copy = copiedDocs.get(value.documentId), destinationDocumentId = copy?.documentId ?? value.documentId
    if (!copy && !existingRewrites.has(value.documentId)) return { ...value }
    const originalHeading = sourceHeadings.get(value.documentId)?.slug.get(value.slug)
    if (!originalHeading) {
      if (nextHeadings.get(destinationDocumentId)?.slug.has(value.slug)) return block()
      missingHeadingChecks.push({ documentId: destinationDocumentId, slug: value.slug })
      return { ...value, documentId: destinationDocumentId }
    }
    const identity = mappedHeadingIdentity(originalHeading, value.documentId, Boolean(copy)), found = nextHeadings.get(destinationDocumentId)?.identity.get(identity)
    if (!found) return block()
    const target = { ...value, documentId: destinationDocumentId, slug: found.slug }
    mappedHeadingChecks.push({ target, identity }); return target
  }
  const projections: SyncedBothLinkProjection[] = [], requiredSourceKeys: Array<{ ownerKey: string; key: SyncedBothSourceKey }> = []
  for (const owner of usedOwners) {
    const inputSource = requireSource(source, owner.sourceKey), originalRecord = local.get(owner.sourceKey)!.record
    if (originalRecord.kind !== 'document' && originalRecord.kind !== 'synced-group') return publicationInvalid('both consumed source不是live owner。')
    const skeleton = skeletons.get(owner.destinationKey)!, oldPath = originalRecord.kind === 'document' ? localPaths.get(originalRecord.id)! : originalRecord.origin.pathAtCreation
    const newPath = skeleton.kind === 'document' ? graph.paths.get(skeleton.id)! : skeleton.origin.pathAtCreation
    const byField = new Map<string, Edit[]>(), targets = new Map<string, SyncedLinkTarget>(), parsedIndex = new Map(inputSource.parsed.map(item => [sourceKey(item.key), item]))
    for (const link of inputSource.source.links) {
      const parsed = parsedIndex.get(sourceKey(link.key))
      if (!parsed) return publicationInvalid('both consumed source Key缺实际parser。')
      const target = mapTarget(link.target), next = rawUrl(target, link, { oldPath, newPath, graph })
      targets.set(sourceKey(link.key), target); requiredSourceKeys.push({ ownerKey: owner.sourceKey, key: { ...link.key } })
      if (next === link.url) continue
      const field = publicationJson([link.key.field, link.key.blockId]), edits = byField.get(field) ?? []
      const raw = link.key.syntax === 'wiki' ? link.key.raw.includes('\\|') ? next.replace(/\|/g, '\\|') : next : escapeMarkdownDestination(next, parsed.syntax)
      edits.push({ from: link.key.from, to: link.key.to, text: raw }); byField.set(field, edits)
    }
    for (const image of inputSource.source.images) {
      requiredSourceKeys.push({ ownerKey: owner.sourceKey, key: { ...image.key } })
      if (/^knowbook-asset:/i.test(image.url)) { parseSyncedPortableAssetUri(image.url); continue }
      // No asset IO or fictitious path authority: keep an unchanged base, or prove a
      // normal relative destination can be rebased to the identical virtual target.
      const parsed = parseLocalMarkdownUrl(image.url)
      if (!parsed || !parsed.path || parsed.path.startsWith('/') || oldPath.split('/').slice(0, -1).join('/') === newPath.split('/').slice(0, -1).join('/')) continue
      const resolved = resolveMarkdownDocumentPath(oldPath, image.url)
      if (resolved) return block() // Images are not document navigation bindings.
      const parts = oldPath.split('/').slice(0, -1)
      for (const part of parsed.path.split('/')) { if (part === '..') { if (!parts.length) return block(); parts.pop() } else if (part && part !== '.') parts.push(part) }
      if (!parts.length) return block()
      const next = relativeMarkdownPath(newPath + '.md', parts.join('/')) + parsed.suffix
      const actual = parsedIndex.get(sourceKey(image.key))
      if (!actual) return block()
      const field = publicationJson([image.key.field, image.key.blockId]), edits = byField.get(field) ?? []
      edits.push({ from: image.key.from, to: image.key.to, text: image.key.syntax === 'wiki' ? next : escapeMarkdownDestination(next, actual.syntax) }); byField.set(field, edits)
    }
    function rewrite(content: string, field: 'block' | 'summary', oldBlockId: string | null): string {
      const edits = byField.get(publicationJson([field, oldBlockId])) ?? []
      edits.sort((a, b) => a.from - b.from || a.to - b.to)
      for (let i = 0; i < edits.length; i++) if (edits[i].from < 0 || edits[i].to < edits[i].from || edits[i].to > content.length || i > 0 && edits[i].from < edits[i - 1].to) return block()
      let result = content
      for (const edit of [...edits].reverse()) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to)
      return result
    }
    const originalBlocks = originalRecord.kind === 'document' ? originalRecord.content.blocks : originalRecord.blocks, originalBlocksById = new Map(originalBlocks.map(child => [child.id, child]))
    const copiedBlocks = skeleton.kind === 'document' ? skeleton.content.blocks : skeleton.blocks
    const blocks = copiedBlocks.map((child, index) => ({ ...child, content: child.type === 'synced-block' ? child.content : rewrite(originalBlocks[index].content, 'block', originalBlocks[index].id) }))
    let transformed: Host | SyncedGroupWire = skeleton.kind === 'document'
      ? { ...skeleton, content: { ...skeleton.content, blocks, summary: rewrite(originalRecord.kind === 'document' ? originalRecord.content.summary : '', 'summary', null) } }
      : { ...skeleton, blocks: blocks as SyncedCanonicalWire[] }
    const actual = parsedOwner(transformed, newPath), destinations = unique(actual.filter(item => !item.image), item => sourceKey(item.key), 'both目的parser范围重复。')
    const destinationBlocksById = new Map((transformed.kind === 'document' ? transformed.content.blocks : transformed.blocks).map(child => [child.id, child]))
    const bindings: SyncedLinkBinding[] = [], seen = new Set<string>()
    for (const link of inputSource.source.links) {
      const oldContent = link.key.field === 'summary' && originalRecord.kind === 'document' ? originalRecord.content.summary : originalBlocksById.get(link.key.blockId!)!.content
      const destinationId = link.key.field === 'summary' ? null : physicalMapping.get(link.key.blockId!)!
      const destinationContent = link.key.field === 'summary' && transformed.kind === 'document' ? transformed.content.summary
        : destinationBlocksById.get(destinationId!)!.content
      const destination = editKey(link.key, byField.get(publicationJson([link.key.field, link.key.blockId])) ?? [], destinationContent, destinationId)
      if (oldContent.slice(link.key.from, link.key.to) !== link.key.raw) return publicationInvalid('both source raw偏离原physical。')
      const found = destinations.get(sourceKey(destination)), target = targets.get(sourceKey(link.key))!
      if (!found || seen.has(sourceKey(destination))) return block(); seen.add(sourceKey(destination))
      // Re-evaluate the exact generated spelling; this is a check on our own edit,
      // never permission to hydrate an old target from today's URL.
      if (found.url !== rawUrl(target, link, { oldPath, newPath, graph })) return block()
      projections.push({ sourceOwnerKey: owner.sourceKey, source: { ...link.key }, destinationOwnerKey: owner.destinationKey, destination, target })
      if (transformed.kind === 'synced-group') { if (destination.field !== 'block' || destination.blockId === null) return block(); const { field: _field, ...range } = destination; bindings.push({ ...range, blockId: destination.blockId, target }) }
    }
    if (seen.size !== destinations.size) return block()
    if (transformed.kind === 'synced-group') {
      transformed = { ...transformed, bindings }
      const actualKeys = new Set(collectSyncedBindingOccurrences(transformed.origin, transformed.blocks).map(item => sourceKey({ field: 'block', ...item })))
      if (actualKeys.size !== bindings.length || bindings.some(binding => !actualKeys.has(sourceKey({ field: 'block', ...binding })))) return block()
    }
    setRecord(finalLocal, transformed); setRecord(finalRemote, transformed)
  }
  // A URL edit inside a heading can itself alter that namespace. Reject a cycle or
  // changed occurrence rather than accepting the preliminary slug as authority.
  const actualHeadings = indexHeadings(headingNamespaces(finalLocal))
  for (const check of mappedHeadingChecks) if (actualHeadings.get(check.target.documentId)?.identity.get(check.identity)?.slug !== check.target.slug) return block()
  for (const check of missingHeadingChecks) if (actualHeadings.get(check.documentId)?.slug.has(check.slug)) return block()
  const originalHosts = new Map([...original.values()].flatMap(({ record }) => record.kind === 'document' ? [[record.id, new Map(record.content.blocks.map(child => [child.id, child]))] as const] : []))
  const existingByKey = new Map(selectedInstances.filter(row => row.destination === 'existing').map(row => [instanceKey(row.sourceDocumentId, row.sourceInstanceId, 'existing'), row]))
  const originalChildren = new Map([...original.values()].flatMap(({ key, record }) => record.kind === 'synced-group' ? [[key, new Map(record.blocks.map(child => [child.id, child]))] as const] : []))
  const localChildren = new Map([...local.values()].flatMap(({ key, record }) => record.kind === 'synced-group' ? [[key, new Map(record.blocks.map(child => [child.id, child]))] as const] : []))
  function retainedPhysical(documentId: string, identity: string): string {
    let parsed: unknown
    try { parsed = JSON.parse(identity) } catch { return block() }
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== null && typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return block()
    if (parsed[0] === null) return identity
    const selected = existingByKey.get(instanceKey(documentId, parsed[0], 'existing')); if (!selected) return identity
    const leaf = originalHosts.get(documentId)?.get(parsed[0]); if (leaf?.type !== 'synced-block') return block()
    const groupId = parseSyncedBlockPayload(leaf.content).groupId, key = 'group:' + groupId
    const previous = originalChildren.get(key)?.get(parsed[1]), sourceChild = localChildren.get(key)?.get(parsed[1]), mapped = blockAlloc.get(blockKey(key, parsed[1]))
    if (!previous || !sourceChild || previous.createdAt !== sourceChild.createdAt || !mapped || mapped.ownerKey !== 'group:' + selected.groupId) return block()
    return publicationJson([selected.instanceId, mapped.blockId])
  }
  assertRetainedHostSemantics(retainedBeforeLocal, finalLocal, existingRewrites, retainedPhysical)
  assertRetainedHostSemantics(retainedBeforeRemote, finalRemote, existingRewrites, retainedPhysical)
  let localFinal: SyncedProtocol5Snapshot, nextRemote: SyncedProtocol5Snapshot
  try { localFinal = makeSnapshot(finalLocal, input.local.manifest.workspaceId); nextRemote = makeSnapshot(finalRemote, input.remote.manifest.workspaceId) }
  catch (cause) { if (cause instanceof SyncedPublicationError && cause.code === 'invalid' || cause instanceof SyncedValidationError) return block(cause instanceof SyncedValidationError && cause.code === 'budget' ? 'budget' : 'dependency'); throw cause }
  const summary: SyncedExchangeBothForkSummary = { componentId: input.component.componentId, allocationHash: hash(allocation),
    documents: [...copiedDocs.values()].map(row => ({ sourceDocumentId: row.sourceDocumentId, documentId: row.documentId, title: row.title, parentId: row.parentId, path: row.path })).sort((a, b) => publicationCompare(a.sourceDocumentId, b.sourceDocumentId)),
    groups: [...forkGroups.values()].map(row => ({ sourceGroupId: row.sourceGroupId, groupId: row.groupId, creationId: row.creationId })).sort((a, b) => publicationCompare(a.sourceGroupId, b.sourceGroupId)),
    instances: selectedInstances.map(row => ({ sourceDocumentId: row.sourceDocumentId, sourceInstanceId: row.sourceInstanceId, destination: row.destination, documentId: row.documentId, instanceId: row.instanceId, groupId: row.groupId }))
      .sort((a, b) => publicationCompare(instanceKey(a.sourceDocumentId, a.sourceInstanceId, a.destination), instanceKey(b.sourceDocumentId, b.sourceInstanceId, b.destination))), entities: catalog.entities }
  projections.sort((a, b) => publicationCompare(publicationJson([a.sourceOwnerKey, a.source, a.destinationOwnerKey, a.destination]), publicationJson([b.sourceOwnerKey, b.source, b.destinationOwnerKey, b.destination])))
  const requirements = unique(requiredSourceKeys, row => publicationJson([row.ownerKey, row.key]), 'both原source Key重复消费。')
  const required = [...requirements.values()].sort((a, b) => publicationCompare(publicationJson([a.ownerKey, a.key]), publicationJson([b.ownerKey, b.key])))
  return { status: 'planned', localFinal, nextRemote, projections, requiredSourceKeys: required,
    fork: { componentId: input.component.componentId, allocationHash: summary.allocationHash,
      sources: sorted(part).flatMap(key => { const row = local.get(key); return row ? [{ key, hash: row.hash }] : [] }),
      results: sorted(recordKeys).map(key => { const left = finalLocal.get(key), right = finalRemote.get(key); if (!left || !right || left.hash !== right.hash) return block('dependency'); return { key, hash: left.hash } }),
      projectionsHash: hash(projections), summary } }
}
export function planSyncedBothFork(input: SyncedBothForkInput): SyncedBothForkResult {
  try { return plan(input) } catch (cause) {
    if (cause instanceof Blocked) return { status: 'blocked', reason: cause.reason, keys: sorted(input.component.keys) }
    if (cause instanceof UnsupportedSyncedHostCreate) return { status: 'blocked', reason: 'semantic-binding', keys: sorted(input.component.keys) }
    throw cause
  }
}


