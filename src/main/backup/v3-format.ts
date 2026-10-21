/** Cold, data-only complete V3 archive codec. It grants no Main/IO/restore authority. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { DatabaseSavedView, DocumentDatabaseColumn } from '../../shared/contracts'
import type { ExportDocument, ExportStandaloneDatabase } from '../database/store'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { parseStrictJson } from '../../shared/strictJson'
import { KNOWBOOK_BACKUP_MARKER, extractMarkdownFrontmatter } from '../../shared/markdownFrontmatter'
import { parseBackupV3Blocks, serializeBackupV3Blocks } from '../../shared/markdownBackupV3'
import { collectMarkdownDestinations, escapeMarkdownDestination, relativeMarkdownPath, type MarkdownDestination } from '../../shared/markdownLinks'
import { collectSyncedMarkdownAssetDestinations, parseSyncedPortableAssetUri, buildSyncedPortableAssetUri,
  syncedPortableAssetBackupPath, canonicalSyncedPortableJson, measureSyncedPortableGroup, rewriteSyncedGroupAssets } from '../../shared/syncedBlockPortable'
import { validateSyncedWorkspaceGraph, type SyncedValidatedGraph } from '../../shared/syncedBlockGraph'
import { isSyncedUuid, parseSyncedBlockPayload, validateSyncedGroupWire, validateSyncedHostForest,
  SYNCED_MAX_BLOCKS, SYNCED_PROJECTED_MAX_BYTES } from '../../shared/syncedBlockValidation'
import { collectSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import { DATABASE_SYSTEM_FIELD_IDS } from '../../shared/database-workspace'
import { collectDatabaseViewConfigFieldIds, parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { validateFieldValues, strictSavedViewConfig, backupScope, type MissingReferences, type DeletionPolicy } from './v2-format'

export interface BackupV3File { relativePath: string; bytes: Uint8Array }
export interface BackupV3AssetFile extends BackupV3File { hash: string; name: string }
export interface BackupV3Group { wire: SyncedGroupWire; sourceRevision: string }
export interface ArchiveV3Snapshot {
  documents: ExportDocument[]; catalog: ExportStandaloneDatabase; standaloneDatabases: ExportStandaloneDatabase[]
  groups: BackupV3Group[]; assets: BackupV3AssetFile[]
}
export interface BackupV3SyncedGroup { id: string; creationId: string; sourceRevision: string; recordHash: string }
export interface BackupV3SyncedInstance { id: string; ownerDocumentId: string; groupId: string; sourceGroupRevision: string; sourceGroupHash: string }
export interface BackupV3MissingReferences { documentIds: string[]; blockIds: string[]; instanceIds: string[] }
export interface BackupV3DeletionPolicy extends DeletionPolicy { syncedGroups: { mode: 'source-owned-unreferenced' } }
export interface BackupV3Manifest {
  snapshotId: string; catalogId: string; databaseIds: string[]; documentIds: string[]; missing: MissingReferences
  deletion: BackupV3DeletionPolicy; syncedGroups: BackupV3SyncedGroup[]; syncedInstances: BackupV3SyncedInstance[]
  syncedMissingReferences: BackupV3MissingReferences
}
export interface ArchiveV3 extends ArchiveV3Snapshot { manifest: BackupV3Manifest }

const MIB = 1024 * 1024, maxContent = 5 * MIB, maxContentTotal = 100 * MIB, maxAsset = 50 * MIB, maxAssetTotal = 500 * MIB
const indexPath = '__knowbook/databases/index.md', catalogPath = '__knowbook/databases/catalog.md'
const indexKind = 'standalone-database-manifest', catalogKind = 'document-catalog-database', databaseKind = 'standalone-database'
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const json = canonicalSyncedPortableJson, hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function invalid(message: string): never { throw new Error('Invalid V3 complete backup: ' + message) }
function text(value: unknown): string { return typeof value === 'string' ? value : invalid('expected string') }
function rawId(value: unknown): string { const result = text(value); return result.trim() ? result : invalid('missing raw identity') }
function uuid(value: unknown): string { return isSyncedUuid(value) ? value : invalid('invalid UUID') }
function digest(value: unknown): string { const result = text(value); return /^[a-f0-9]{64}$/.test(result) ? result : invalid('invalid SHA256') }
function date(value: unknown): string { const result = text(value); return result && Number.isFinite(Date.parse(result)) ? result : invalid('invalid timestamp') }
function order(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid('invalid order') }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : invalid('expected array') }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('expected plain object')
  const result = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) return invalid('unknown or missing property')
  return result
}
/** Descriptor-first: no getter, toJSON, symbol or custom prototype is invoked. */
function data(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return
  // DTO wrappers do not reduce the per-file JSON depth32 budget below.
  if (!value || typeof value !== 'object' || depth > 64 || ancestors.has(value)) return invalid('non-JSON/cyclic/deep data')
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype || Buffer.isBuffer(value)) return
  const array = Array.isArray(value)
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('custom data prototype')
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (array && keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string')) return invalid('array extras or symbol')
  ancestors.add(value)
  for (const key of keys) {
    if (array && key === 'length') continue
    const descriptor = descriptors[key as string]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || array && !/^(0|[1-9][0-9]*)$/.test(key as string)) return invalid('accessor/hidden data')
    // Export snapshots may have explicitly absent optional TS members; only those are omitted.
    if (descriptor.value === undefined) {
      if (array || !['language', 'tags', 'highlight', 'listStart', 'markdownFormat'].includes(key as string)) return invalid('undefined data')
    } else data(descriptor.value, depth + 1, ancestors)
  }
  ancestors.delete(value)
}
function parse(value: string): unknown { return parseStrictJson(value, { maxBytes: maxContent, maxDepth: 32 }) }
function same(actual: unknown, expected: unknown, why: string): void { if (json(actual) !== json(expected)) invalid(why) }
function uniqueIds(values: unknown, read = rawId): string[] {
  const ids = list(values).map(read)
  if (new Set(ids).size !== ids.length) return invalid('duplicate identity')
  return ids
}
function sorted<T>(values: T[]): T[] { return values.sort((a, b) => compare(json(a), json(b))) }
function path(value: unknown): string {
  const result = text(value)
  if (!result || result.startsWith('/') || result.includes('\\') || result.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) return invalid('unsafe logical path')
  return result
}
function filePath(value: unknown): string {
  const result = path(value), parts = result.split('/')
  if (parts.length > 32 || parts.some(part => /[<>:"|?*\x7f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) return invalid('unsafe archive path')
  return result
}
function groupPath(id: string): string { return '__knowbook/synced/group-' + hash(id) + '.json' }
function databasePath(id: string): string { return '__knowbook/databases/database-' + hash(id) + '.md' }
function envelope(fields: Record<string, string>, body = ''): string {
  return '---\n' + Object.entries(fields).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n') + '\n---\n' + KNOWBOOK_BACKUP_MARKER + '\n\n' + body + (body && !body.endsWith('\n') ? '\n' : '')
}
function header(markdown: string): { fields: Record<string, string>; body: string } {
  const decoded = extractMarkdownFrontmatter(markdown)
  if (!decoded || !decoded.body.startsWith(KNOWBOOK_BACKUP_MARKER + '\n') && decoded.body !== KNOWBOOK_BACKUP_MARKER) return invalid('V3 header/backup marker missing')
  const fields: Record<string, string> = Object.create(null)
  for (const line of decoded.raw.split(/\r?\n/).slice(1, -1)) {
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)
    if (!match || Object.hasOwn(fields, match[1])) return invalid('duplicate/invalid header field')
    fields[match[1]] = text(parse(match[2]))
  }
  if (fields.backupFormatVersion !== '3') return invalid('not V3')
  uuid(fields.backupSnapshotId)
  return { fields, body: decoded.body.slice(KNOWBOOK_BACKUP_MARKER.length).replace(/^\n(?:\n)?/, '') }
}
function columns(value: unknown): DocumentDatabaseColumn[] {
  const result = list(value).map(value => {
    const item = object(value, ['id', 'name', 'type', 'options', 'sortOrder']), type = text(item.type), name = text(item.name)
    if (!['text', 'select', 'multi-select', 'checkbox', 'date'].includes(type) || !name.trim()) return invalid('invalid column')
    return { id: rawId(item.id), name, type: type as DocumentDatabaseColumn['type'], options: uniqueIds(item.options, text), sortOrder: order(item.sortOrder) }
  })
  if (new Set(result.map(item => item.id)).size !== result.length) invalid('duplicate column')
  return result
}
function definition(value: unknown): ExportStandaloneDatabase {
  const item = object(value, ['id', 'name', 'description', 'createdAt', 'updatedAt', 'columns', 'savedViews', 'entities'])
  const id = rawId(item.id), sourceColumns = columns(item.columns)
  const savedViews = list(item.savedViews).map(value => {
    const view = object(value, ['id', 'databaseId', 'name', 'filterQuery', 'filterScope', 'sortMode', 'viewMode', 'config', 'configVersion', 'sortOrder', 'createdAt', 'updatedAt'])
    if (view.databaseId !== id || view.configVersion !== 1 || !['updated-desc', 'updated-asc', 'created-desc', 'created-asc'].includes(text(view.sortMode)) || !['cards', 'table', 'board'].includes(text(view.viewMode))) invalid('invalid saved view')
    return { id: rawId(view.id), databaseId: id, name: rawId(view.name), filterQuery: text(view.filterQuery), filterScope: text(view.filterScope), sortMode: view.sortMode,
      viewMode: view.viewMode, config: strictSavedViewConfig(json(view.config), 1, { filterQuery: text(view.filterQuery), filterScope: text(view.filterScope), sortMode: text(view.sortMode), viewMode: text(view.viewMode) }), configVersion: 1, sortOrder: order(view.sortOrder), createdAt: date(view.createdAt), updatedAt: date(view.updatedAt) } as DatabaseSavedView
  })
  if (new Set(savedViews.map(view => view.id)).size !== savedViews.length || new Set(savedViews.map(view => { const nul = view.name.indexOf('\0'); return json([(nul < 0 ? view.name : view.name.slice(0, nul)).replace(/[A-Z]/g, letter => letter.toLowerCase()), Buffer.byteLength(view.name, 'utf8')]) })).size !== savedViews.length) invalid('duplicate saved view')
  const entities = list(item.entities).map(value => {
    const entity = object(value, ['id', 'title', 'documentId', 'documentPath', 'createdAt', 'updatedAt', 'fieldValues'])
    if ((entity.documentId === null) !== (entity.documentPath === null)) invalid('incomplete entity document binding')
    return { id: rawId(entity.id), title: rawId(entity.title), documentId: entity.documentId === null ? null : rawId(entity.documentId), documentPath: entity.documentPath === null ? null : path(entity.documentPath),
      createdAt: date(entity.createdAt), updatedAt: date(entity.updatedAt), fieldValues: validateFieldValues(entity.fieldValues, sourceColumns) }
  })
  if (new Set(entities.map(entity => entity.id)).size !== entities.length) invalid('duplicate entity')
  const linkedDocuments = entities.filter(entity => entity.documentId !== null).map(entity => entity.documentId)
  if (new Set(linkedDocuments).size !== linkedDocuments.length) invalid('duplicate same-database entity document')
  return { id, name: rawId(item.name), description: text(item.description), createdAt: date(item.createdAt), updatedAt: date(item.updatedAt), columns: sourceColumns, savedViews, entities }
}
function definitionHeader(source: ExportStandaloneDatabase, snapshotId: string, kind: string): Record<string, string> {
  return { kind, backupFormatVersion: '3', backupSnapshotId: snapshotId, databaseId: source.id, databaseName: source.name, databaseDescription: source.description, createdAt: source.createdAt,
    updatedAt: source.updatedAt, databaseColumns: json(source.columns), databaseSavedViews: json(source.savedViews), databaseEntities: json(source.entities) }
}
function readDefinition(fields: Record<string, string>): ExportStandaloneDatabase {
  object(fields, ['kind', 'backupFormatVersion', 'backupSnapshotId', 'databaseId', 'databaseName', 'databaseDescription', 'createdAt', 'updatedAt', 'databaseColumns', 'databaseSavedViews', 'databaseEntities'])
  return definition({ id: fields.databaseId, name: fields.databaseName, description: fields.databaseDescription, createdAt: fields.createdAt, updatedAt: fields.updatedAt,
    columns: parse(fields.databaseColumns), savedViews: parse(fields.databaseSavedViews), entities: parse(fields.databaseEntities) })
}
function coreBlocks(blocks: ExportDocument['blocks']): SyncedStableBlockDraft[] {
  return validateSyncedHostForest(blocks.map(raw => {
    object(raw, ['id', 'type', 'content', 'checked', 'depth', 'parentBlockId', 'sortOrder'], ['language', 'listStart', 'markdownFormat', 'tags', 'highlight'])
    if (!Number.isSafeInteger(raw.sortOrder)) invalid('invalid source block order')
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key !== 'sortOrder' && value !== undefined))
  }))
}
function document(value: unknown): ExportDocument {
  const item = object(value, ['id', 'title', 'path', 'summary', 'updatedAt', 'documentDatabaseColumns', 'documentDatabaseFieldValues', 'blocks'])
  const title = text(item.title), logicalPath = path(item.path), sourceColumns = columns(item.documentDatabaseColumns)
  if (!title || title !== title.trim() || title.length > 500 || logicalPath.split('/').at(-1) !== title) invalid('document title/path mismatch')
  return { id: rawId(item.id), title, path: logicalPath, summary: text(item.summary), updatedAt: date(item.updatedAt), documentDatabaseColumns: sourceColumns,
    documentDatabaseFieldValues: validateFieldValues(item.documentDatabaseFieldValues, sourceColumns), blocks: coreBlocks(list(item.blocks) as ExportDocument['blocks']).map((block, sortOrder) => ({ ...block, sortOrder })) }
}
const markdownTypes = new Set(['paragraph', 'html', 'quote', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list', 'table', 'callout', 'toggle'])
function markdownBlock(block: SyncedStableBlockDraft): boolean { return markdownTypes.has(block.type) || /^heading-[1-6]$/.test(block.type) }
function editText(source: string, destinations: MarkdownDestination[], map: (uri: string) => string): string {
  const edits: Array<{ from: number; to: number; value: string }> = []
  for (const destination of destinations) {
    const next = map(destination.url)
    if (next === destination.url) continue
    let from = destination.start, to = destination.end, value = escapeMarkdownDestination(next, destination.syntax)
    if (destination.kind === 'autolink') {
      const label = source.slice(from, to).replace(/[\\\[\]]/g, '\\$&'), margin = destination.syntax === 'bare' ? 0 : 1
      from -= margin; to += margin; value = '[' + label + '](<' + next + '>)'
    } else if (destination.syntax !== 'html' && destination.syntax !== 'wiki' && source[from - 1] === '<' && source[to] === '>') value = next
    const previous = edits.at(-1)
    if (previous && from < previous.to) {
      if (from === previous.from && to === previous.to && value === previous.value) continue
      return invalid('overlapping asset source ranges')
    }
    edits.push({ from, to, value })
  }
  let output = source
  for (const edit of edits.reverse()) output = output.slice(0, edit.from) + edit.value + output.slice(edit.to)
  return output
}
function mapDocumentAssets(doc: ExportDocument, rewrite: (value: string) => string): ExportDocument {
  return { ...doc, summary: rewrite(doc.summary), blocks: doc.blocks.map(block => markdownBlock(block) ? { ...block, content: rewrite(block.content) } : block) }
}
function assetUri(relativePath: string): string {
  const match = /^__knowbook\/assets\/attachments\/([a-f0-9]{2})\/([a-f0-9]{64})\/([^/]+)$/.exec(relativePath)
  if (!match || match[1] !== match[2].slice(0, 2)) return invalid('invalid asset path')
  return buildSyncedPortableAssetUri({ hash: match[2], name: match[3] })
}
function relativeAsset(file: string, uri: string): string { return relativeMarkdownPath(file, syncedPortableAssetBackupPath(uri)) }
function portableToRelative(source: string, file: string): string {
  return editText(source, collectSyncedMarkdownAssetDestinations(source), uri => { parseSyncedPortableAssetUri(uri); return relativeAsset(file, uri) })
}
function relativeToPortable(source: string, file: string): string {
  if (collectSyncedMarkdownAssetDestinations(source).length) invalid('ordinary V3 Markdown contains local/portable asset URI')
  return editText(source, collectMarkdownDestinations(source), uri => {
    if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('//') || !uri) return uri
    let decoded: string
    try { decoded = decodeURIComponent(uri) } catch { return invalid('invalid asset URL encoding') }
    const resolved = posix.normalize(posix.join(posix.dirname(file), decoded))
    if (!resolved.startsWith('__knowbook/assets/')) return uri
    const portable = assetUri(resolved)
    if (uri !== relativeAsset(file, portable)) return invalid('noncanonical relative asset URL')
    return portable
  })
}
function normalizedGroup(value: unknown): BackupV3Group {
  const item = object(value, ['wire', 'sourceRevision']), wire = validateSyncedGroupWire(item.wire)
  const parsed = collectSyncedBindingOccurrences(wire.origin, wire.blocks)
  const key = (value: { blockId: string; from: number; to: number; raw: string; syntax: string }) => json([value.blockId, value.from, value.to, value.raw, value.syntax])
  const expected = new Set(parsed.map(key))
  if (expected.size !== parsed.length || expected.size !== wire.bindings.length || wire.bindings.some(binding => !expected.delete(key(binding))) || expected.size) invalid('group binding physical Key closure')
  measureSyncedPortableGroup(wire)
  return { wire, sourceRevision: uuid(item.sourceRevision) }
}
function missingCatalog(snapshot: ArchiveV3Snapshot): MissingReferences {
  const sources = [snapshot.catalog, ...snapshot.standaloneDatabases], byId = new Map(sources.map(source => [source.id, source]))
  const views = new Map<string, string>(), fields = new Map<string, string>(), systemFields = new Set<string>(Object.values(DATABASE_SYSTEM_FIELD_IDS))
  for (const source of sources) {
    for (const view of source.savedViews) { if (views.has(view.id)) invalid('duplicate global view'); views.set(view.id, source.id) }
    for (const column of source.columns) { if (fields.has(column.id)) invalid('duplicate global column'); fields.set(column.id, source.id) }
  }
  const missing: MissingReferences = { databaseIds: [], views: [], fields: [] }
  const inspect = (databaseId: string, ids: Iterable<string>) => {
    for (const fieldId of ids) {
      if (systemFields.has(fieldId)) continue
      const owner = fields.get(fieldId)
      if (owner && owner !== databaseId) invalid('field belongs to a different database')
      if (!owner) missing.fields.push({ databaseId, fieldId })
    }
  }
  for (const source of sources) for (const view of source.savedViews) {
    inspect(source.id, collectDatabaseViewConfigFieldIds(view.config))
    if (view.filterScope && !['all', 'title', 'path', 'summary'].includes(view.filterScope)) inspect(source.id, [view.filterScope])
  }
  const blocks = [...snapshot.documents.flatMap(doc => doc.blocks), ...snapshot.groups.flatMap(group => group.wire.blocks)]
  for (const block of blocks) if (block.type === 'database-view') {
    const payload = parseDatabaseViewPayload(block.content)
    if (!byId.has(payload.databaseId)) missing.databaseIds.push(payload.databaseId)
    if (payload.viewId !== null) {
      const owner = views.get(payload.viewId)
      if (owner && owner !== payload.databaseId) invalid('view belongs to a different database')
      if (!owner) missing.views.push({ databaseId: payload.databaseId, viewId: payload.viewId })
    }
    inspect(payload.databaseId, collectDatabaseViewConfigFieldIds(payload.config))
  }
  missing.databaseIds = [...new Set(missing.databaseIds)].sort(compare)
  missing.views = sorted([...new Map(missing.views.map(item => [json(item), item])).values()])
  missing.fields = sorted([...new Map(missing.fields.map(item => [json(item), item])).values()])
  return missing
}
function missingSynced(snapshot: ArchiveV3Snapshot, graph: SyncedValidatedGraph): BackupV3MissingReferences {
  const documents = new Set(snapshot.documents.map(doc => doc.id)), instanceIds = new Set(snapshot.documents.flatMap(doc => doc.blocks.filter(block => block.type === 'synced-block').map(block => block.id)))
  const missing = { documentIds: new Set<string>(), blockIds: new Set<string>(), instanceIds: new Set<string>() }
  const doc = (id: string) => { if (!documents.has(id)) missing.documentIds.add(id) }
  for (const { wire } of snapshot.groups) {
    doc(wire.origin.documentId)
    if (!instanceIds.has(wire.origin.firstInstanceId)) missing.instanceIds.add(wire.origin.firstInstanceId)
    for (const binding of wire.bindings) {
      const target = binding.target
      if (target.kind === 'document') doc(target.id)
      else if (target.kind === 'heading') doc(target.documentId)
      else if (target.kind === 'block') {
        if (!graph.owners.has(target.id)) missing.blockIds.add(target.id)
        if (target.documentId !== null) doc(target.documentId)
      }
    }
  }
  // Block and instance reservations share a global identity domain. If an
  // Origin's firstInstance is physically an ordinary/canonical child, it is not missing.
  for (const id of missing.instanceIds) if (graph.owners.has(id)) missing.instanceIds.delete(id)
  return { documentIds: [...missing.documentIds].sort(compare), blockIds: [...missing.blockIds].sort(compare), instanceIds: [...missing.instanceIds].sort(compare) }
}
function validateSnapshot(value: ArchiveV3Snapshot): { snapshot: ArchiveV3Snapshot; graph: SyncedValidatedGraph } {
  data(value); object(value, ['documents', 'catalog', 'standaloneDatabases', 'groups', 'assets'])
  const snapshot: ArchiveV3Snapshot = { documents: list(value.documents).map(document), catalog: definition(value.catalog), standaloneDatabases: list(value.standaloneDatabases).map(definition),
    groups: list(value.groups).map(normalizedGroup), assets: list(value.assets).map(value => {
      const asset = object(value, ['relativePath', 'bytes', 'hash', 'name']), portable = buildSyncedPortableAssetUri({ hash: digest(asset.hash), name: text(asset.name) })
      if (!(asset.bytes instanceof Uint8Array) || asset.bytes.byteLength > maxAsset || hash(asset.bytes) !== asset.hash || asset.relativePath !== syncedPortableAssetBackupPath(portable)) invalid('asset alias bytes/hash/path mismatch')
      return { relativePath: filePath(asset.relativePath), bytes: new Uint8Array(asset.bytes as Uint8Array), hash: text(asset.hash), name: text(asset.name) }
    }) }
  const sources = [snapshot.catalog, ...snapshot.standaloneDatabases], docs = new Map(snapshot.documents.map(doc => [doc.id, doc.path]))
  if (docs.size !== snapshot.documents.length || new Set(snapshot.documents.map(doc => doc.path)).size !== docs.size || new Set(sources.map(source => source.id)).size !== sources.length) invalid('duplicate document/database')
  if (new Set(sources.flatMap(source => source.entities.map(entity => entity.id))).size !== sources.reduce((n, source) => n + source.entities.length, 0)) invalid('duplicate global entity')
  for (const doc of snapshot.documents) same(doc.documentDatabaseColumns, snapshot.catalog.columns, 'catalog column projection differs')
  for (const source of sources) for (const entity of source.entities) if (entity.documentId !== null && docs.get(entity.documentId) !== entity.documentPath) invalid('missing entity document')
  const paths = new Set(snapshot.documents.map(doc => doc.path))
  for (const doc of snapshot.documents) {
    const parent = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : null
    if (parent && !paths.has(parent)) invalid('missing document parent')
  }
  const graph = validateSyncedWorkspaceGraph(snapshot.documents.map(doc => ({ documentId: doc.id, blocks: coreBlocks(doc.blocks) })), snapshot.groups.map(group => group.wire))
  const actualAssets = new Map(snapshot.assets.map(asset => [asset.relativePath, asset])), expectedAssets = new Set<string>()
  if (actualAssets.size !== snapshot.assets.length || snapshot.assets.length > 5000 || snapshot.assets.reduce((n, asset) => n + asset.bytes.byteLength, 0) > maxAssetTotal) invalid('asset set/budget')
  const capture = (uri: string): string => { const expected = syncedPortableAssetBackupPath(uri); if (!actualAssets.has(expected)) invalid('missing actual asset alias'); expectedAssets.add(expected); return uri }
  const inspect = (source: string): string => { for (const link of collectSyncedMarkdownAssetDestinations(source)) capture(link.url); return source }
  snapshot.documents.forEach(doc => mapDocumentAssets(doc, inspect))
  snapshot.groups.forEach(group => rewriteSyncedGroupAssets(group.wire, capture))
  if (expectedAssets.size !== actualAssets.size) invalid('unreferenced asset file')
  missingCatalog(snapshot)
  return { snapshot, graph }
}
function groupIndex(snapshot: ArchiveV3Snapshot): BackupV3SyncedGroup[] {
  return sorted(snapshot.groups.map(({ wire, sourceRevision }) => ({ id: wire.id, creationId: wire.creationId, sourceRevision, recordHash: hash(json(wire)) })))
}
function instances(snapshot: ArchiveV3Snapshot, groups: BackupV3SyncedGroup[]): BackupV3SyncedInstance[] {
  const byId = new Map(groups.map(group => [group.id, group]))
  return snapshot.documents.flatMap(doc => doc.blocks.filter(block => block.type === 'synced-block').map(block => {
    const groupId = parseSyncedBlockPayload(block.content).groupId, group = byId.get(groupId)
    if (!group) return invalid('missing instance group')
    return { id: block.id, ownerDocumentId: doc.id, groupId, sourceGroupRevision: group.sourceRevision, sourceGroupHash: group.recordHash }
  })).sort((a, b) => compare(a.ownerDocumentId, b.ownerDocumentId) || compare(a.id, b.id))
}
function safeSegment(segment: string, first: boolean): string {
  if (first && (segment.toLowerCase() === '__knowbook' || segment.toLowerCase().startsWith('__knowbook-document-'))) return '__knowbook-document-' + hash(segment).slice(0, 16)
  if (segment.length <= 60 && !/[<>:"/\\|?*\x00-\x1f]/.test(segment) && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)) return segment
  return (segment.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 40) || 'Untitled') + '--' + hash(segment).slice(0, 10)
}
function documentFiles(documents: ExportDocument[]): Map<string, string> {
  const files = new Map<string, string>(), occupied = new Set<string>()
  for (const doc of [...documents].sort((a, b) => compare(a.path, b.path))) {
    let candidate = doc.path.split('/').map((segment, index) => safeSegment(segment, index === 0)).join('/') + '.md'
    if (occupied.has(candidate.toLowerCase())) candidate = candidate.slice(0, -3) + '--' + hash(doc.id) + '.md'
    if (occupied.has(candidate.toLowerCase())) invalid('document filename collision')
    filePath(candidate); occupied.add(candidate.toLowerCase()); files.set(doc.id, candidate)
  }
  return files
}
function docHeader(doc: ExportDocument, snapshotId: string, catalogId: string): Record<string, string> {
  return { id: doc.id, title: doc.title, path: doc.path, updatedAt: doc.updatedAt, summary: doc.summary,
    documentDatabaseColumns: json(doc.documentDatabaseColumns), documentDatabaseFieldValues: json(doc.documentDatabaseFieldValues), documentDatabaseId: catalogId,
    backupFormatVersion: '3', backupSnapshotId: snapshotId }
}
function archiveProjectionBudget(snapshot: ArchiveV3Snapshot, documentBytes: Map<string, number>): void {
  const groups = new Map(snapshot.groups.map(group => [group.wire.id, group.wire]))
  for (const doc of snapshot.documents) {
    let bytes = documentBytes.get(doc.id) ?? invalid('document envelope size missing'), count = 0
    for (const block of doc.blocks) {
      if (block.type !== 'synced-block') { if (++count > SYNCED_MAX_BLOCKS) invalid('expanded host block budget'); continue }
      const group = groups.get(parseSyncedBlockPayload(block.content).groupId) ?? invalid('missing group')
      for (const { createdAt: _createdAt, ...child } of group.blocks) {
        if (++count > SYNCED_MAX_BLOCKS) invalid('expanded host block budget')
        bytes += encoder.encode(json({ ...child, depth: block.depth + child.depth, parentBlockId: child.parentBlockId ?? block.parentBlockId })).byteLength + 1
        if (bytes > SYNCED_PROJECTED_MAX_BYTES) invalid('V3 archive per-occurrence projection budget')
      }
    }
    if (bytes > SYNCED_PROJECTED_MAX_BYTES) invalid('V3 archive projection budget')
  }
}
function policy(documents: ExportDocument[], files: Map<string, string>): BackupV3DeletionPolicy {
  return { documents: documents.length ? { mode: 'scopes', paths: [...new Set(documents.map(doc => backupScope(doc.path, files.get(doc.id)!.slice(0, -3))))].sort(compare) } : { mode: 'none' },
    customDatabases: { mode: 'complete' }, catalog: { mode: 'source-owned' }, syncedGroups: { mode: 'source-owned-unreferenced' } }
}
function manifest(snapshot: ArchiveV3Snapshot, graph: SyncedValidatedGraph, snapshotId: string, files: Map<string, string>): BackupV3Manifest {
  const groups = groupIndex(snapshot)
  return { snapshotId: uuid(snapshotId), catalogId: snapshot.catalog.id, databaseIds: snapshot.standaloneDatabases.map(source => source.id).sort(compare), documentIds: snapshot.documents.map(doc => doc.id).sort(compare),
    missing: missingCatalog(snapshot), deletion: policy(snapshot.documents, files), syncedGroups: groups, syncedInstances: instances(snapshot, groups), syncedMissingReferences: missingSynced(snapshot, graph) }
}
export function buildBackupV3Files(value: ArchiveV3Snapshot, snapshotId: string): BackupV3File[] {
  const { snapshot, graph } = validateSnapshot(value), files = documentFiles(snapshot.documents), declaration = manifest(snapshot, graph, snapshotId, files), output: BackupV3File[] = []
  const add = (relativePath: string, content: string) => output.push({ relativePath, bytes: encoder.encode(content) })
  add(indexPath, envelope({ kind: indexKind, backupFormatVersion: '3', backupSnapshotId: declaration.snapshotId, catalogDatabaseId: declaration.catalogId,
    databaseIds: json(declaration.databaseIds), documentIds: json(declaration.documentIds), databaseMissingReferences: json(declaration.missing), restoreDeletionPolicy: json(declaration.deletion),
    syncedGroups: json(declaration.syncedGroups), syncedInstances: json(declaration.syncedInstances), syncedMissingReferences: json(declaration.syncedMissingReferences) }))
  add(catalogPath, envelope(definitionHeader(snapshot.catalog, snapshotId, catalogKind)))
  snapshot.standaloneDatabases.forEach(source => add(databasePath(source.id), envelope(definitionHeader(source, snapshotId, databaseKind))))
  for (const doc of snapshot.documents) {
    const relativePath = files.get(doc.id)!, archived = mapDocumentAssets(doc, source => portableToRelative(source, relativePath))
    add(relativePath, envelope(docHeader(archived, snapshotId, snapshot.catalog.id), serializeBackupV3Blocks(coreBlocks(archived.blocks))))
  }
  snapshot.groups.forEach(group => add(groupPath(group.wire.id), json(group.wire)))
  output.push(...snapshot.assets.map(asset => ({ relativePath: asset.relativePath, bytes: new Uint8Array(asset.bytes) })))
  // The actual bytes are the consumer contract, including Markdown round-trip,
  // exact aliases and every archive budget. This is not an IO/restore permit.
  const read = parseBackupV3Files(output)
  const canonicalDocuments = (docs: ExportDocument[]) => docs.map(doc => ({ ...doc, blocks: doc.blocks.map((block, sortOrder) => ({ ...block, sortOrder })) })).sort((a, b) => compare(a.id, b.id))
  same(canonicalDocuments(read.documents), canonicalDocuments(snapshot.documents), 'Markdown serialization changed authored document facts')
  same(read.groups, sorted([...snapshot.groups]), 'group serialization changed portable facts')
  return output.sort((a, b) => compare(a.relativePath, b.relativePath))
}
export function parseBackupV3Files(value: BackupV3File[]): ArchiveV3 {
  data(value)
  const files = list(value).map(raw => {
    const file = object(raw, ['relativePath', 'bytes'])
    if (!(file.bytes instanceof Uint8Array)) return invalid('file bytes are not Uint8Array')
    return { relativePath: filePath(file.relativePath), bytes: new Uint8Array(file.bytes) }
  })
  const byPath = new Map(files.map(file => [file.relativePath, file])), folded = new Set(files.map(file => file.relativePath.toLowerCase()))
  const directories = new Set(files.flatMap(file => file.relativePath.split('/').slice(0, -1).map((_part, index) => file.relativePath.split('/').slice(0, index + 1).join('/'))))
  if (byPath.size !== files.length || folded.size !== files.length || files.length + directories.size > 20000) invalid('duplicate paths/entry budget')
  const foldedDirectories = new Map<string, string>()
  for (const directory of directories) {
    const key = directory.toLowerCase(), previous = foldedDirectories.get(key)
    if (previous !== undefined && previous !== directory) invalid('ambiguous directory case')
    foldedDirectories.set(key, directory)
  }
  for (const file of files) if (foldedDirectories.has(file.relativePath.toLowerCase())) invalid('file/directory collision')
  const contents = files.filter(file => !file.relativePath.startsWith('__knowbook/assets/'))
  if (contents.length > 5000 || contents.some(file => file.bytes.byteLength > maxContent) || contents.reduce((n, file) => n + file.bytes.byteLength, 0) > maxContentTotal) invalid('content file budget')
  const read = (relativePath: string): string => { const file = byPath.get(relativePath); if (!file) return invalid('required file missing: ' + relativePath); return decoder.decode(file.bytes) }
  const index = header(read(indexPath))
  object(index.fields, ['kind', 'backupFormatVersion', 'backupSnapshotId', 'catalogDatabaseId', 'databaseIds', 'documentIds', 'databaseMissingReferences', 'restoreDeletionPolicy', 'syncedGroups', 'syncedInstances', 'syncedMissingReferences'])
  if (index.fields.kind !== indexKind || index.body.trim()) invalid('index kind/body')
  const snapshotId = uuid(index.fields.backupSnapshotId), catalogHeader = header(read(catalogPath))
  if (catalogHeader.fields.kind !== catalogKind || catalogHeader.fields.backupSnapshotId !== snapshotId || catalogHeader.body.trim()) invalid('catalog kind/body/snapshot')
  const catalog = readDefinition(catalogHeader.fields), databases: ExportStandaloneDatabase[] = [], documents: ExportDocument[] = [], groups: BackupV3Group[] = []
  const expected = new Set([indexPath, catalogPath]), documentPaths = new Map<string, string>(), documentBytes = new Map<string, number>()
  const rawGroups = list(parse(index.fields.syncedGroups)).map(value => {
    const item = object(value, ['id', 'creationId', 'sourceRevision', 'recordHash'])
    return { id: uuid(item.id), creationId: uuid(item.creationId), sourceRevision: uuid(item.sourceRevision), recordHash: digest(item.recordHash) }
  })
  for (const entry of rawGroups) {
    const relativePath = groupPath(entry.id), source = read(relativePath), wire = validateSyncedGroupWire(parse(source)), normalized = normalizedGroup({ wire, sourceRevision: entry.sourceRevision })
    if (wire.id !== entry.id || wire.creationId !== entry.creationId || json(wire) !== source || hash(source) !== entry.recordHash) invalid('group canonical bytes/index mismatch')
    expected.add(relativePath); groups.push(normalized)
  }
  for (const file of contents) {
    if (expected.has(file.relativePath)) continue
    if (!file.relativePath.endsWith('.md')) invalid('unknown content file')
    const content = header(decoder.decode(file.bytes)), fields = content.fields
    if (fields.backupSnapshotId !== snapshotId) invalid('mixed snapshot')
    if (fields.kind !== undefined) {
      if (fields.kind !== databaseKind || content.body.trim()) invalid('unknown definition kind/body')
      const source = readDefinition(fields)
      if (file.relativePath !== databasePath(source.id)) invalid('database definition path')
      databases.push(source)
    } else {
      if (file.relativePath.startsWith('__knowbook/')) invalid('document in reserved path')
      object(fields, ['id', 'title', 'path', 'updatedAt', 'summary', 'documentDatabaseColumns', 'documentDatabaseFieldValues', 'documentDatabaseId', 'backupFormatVersion', 'backupSnapshotId'])
      if (fields.documentDatabaseId !== catalog.id) invalid('document catalog owner')
      const blocks = parseBackupV3Blocks(content.body).map((block, sortOrder) => ({ ...block, sortOrder }))
      const archived = document({ id: fields.id, title: fields.title, path: fields.path, updatedAt: fields.updatedAt, summary: fields.summary,
        documentDatabaseColumns: parse(fields.documentDatabaseColumns), documentDatabaseFieldValues: parse(fields.documentDatabaseFieldValues), blocks })
      documents.push(mapDocumentAssets(archived, source => relativeToPortable(source, file.relativePath)))
      documentPaths.set(archived.id, file.relativePath); documentBytes.set(archived.id, file.bytes.byteLength)
    }
    expected.add(file.relativePath)
  }
  const assets = files.filter(file => file.relativePath.startsWith('__knowbook/assets/')).map(file => {
    const asset = parseSyncedPortableAssetUri(assetUri(file.relativePath)); expected.add(file.relativePath)
    return { ...file, hash: asset.hash, name: asset.name }
  })
  if (expected.size !== files.length) invalid('extra/missing file')
  const { snapshot, graph } = validateSnapshot({ documents, catalog, standaloneDatabases: databases, groups, assets })
  const declaration = manifest(snapshot, graph, snapshotId, documentPaths)
  same(index.fields.catalogDatabaseId, declaration.catalogId, 'catalog index')
  same(parse(index.fields.databaseIds), declaration.databaseIds, 'database exact set')
  same(parse(index.fields.documentIds), declaration.documentIds, 'document exact set')
  same(parse(index.fields.databaseMissingReferences), declaration.missing, 'database missing declarations')
  same(parse(index.fields.restoreDeletionPolicy), declaration.deletion, 'deletion scope')
  same(rawGroups, declaration.syncedGroups, 'group exact set/order')
  same(parse(index.fields.syncedInstances), declaration.syncedInstances, 'instance identity/hash/revision closure')
  same(parse(index.fields.syncedMissingReferences), declaration.syncedMissingReferences, 'typed missing identity closure')
  archiveProjectionBudget(snapshot, documentBytes)
  return { ...snapshot, groups: sorted(snapshot.groups), manifest: declaration }
}
