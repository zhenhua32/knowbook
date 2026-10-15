import { createHash } from 'node:crypto'
import type { DatabaseSavedView, DocumentDatabaseColumn, DocumentDatabaseFieldValue } from '@shared/contracts'
import { DATABASE_SYSTEM_FIELD_IDS, createLegacyDatabaseViewConfig } from '@shared/database-workspace'
import { parseStrictJson } from '@shared/strictJson'
import { collectDatabaseViewConfigFieldIds, isDatabaseViewReferenceId, mapDatabaseViewConfigFieldIds, parseDatabaseViewPayload, validateDatabaseViewConfig, validateDatabaseViewBlock } from '@shared/databaseViewBlock'
import { canBlockNestUnder } from '@shared/blockTypes'
import { validColumnStructure } from '@shared/columnStructure'
import { extractMarkdownFrontmatter, KNOWBOOK_BACKUP_MARKER } from '@shared/markdownFrontmatter'
import { markdownEngine, markdownTokenTree, type MarkdownNode } from '@shared/markdownEngine'
import { nativeMarkdownContainer } from '@shared/markdownContainers'
import type { ParsedMarkdownDocument } from '@shared/markdown'
import type { ExportDocument, ExportStandaloneDatabase, ExportStandaloneDatabaseEntity, ExportWorkspaceSnapshot } from '../database/store'

export const BACKUP_V2 = '2'
export const MANIFEST_PATH = '__knowbook/databases/index.md'
export const CATALOG_PATH = '__knowbook/databases/catalog.md'
export const MANIFEST_KIND = 'standalone-database-manifest'
export const CATALOG_KIND = 'document-catalog-database'
export const DATABASE_KIND = 'standalone-database'
const systemFields = new Set<string>(Object.values(DATABASE_SYSTEM_FIELD_IDS))
const limits = { maxBytes: 5 * 1024 * 1024, maxDepth: 32 }
export const backupJson = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
export const databaseFile = (id: string): string => `__knowbook/databases/database-${createHash('sha256').update(id).digest('hex')}.md`
export const isSystemField = (id: string): boolean => systemFields.has(id)
export const failBackup = (message: string): never => { throw new Error(`Invalid complete backup: ${message}`) }
export function object(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failBackup('expected an object')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(result, key))) return failBackup('missing or unknown property')
  return result
}
export function string(value: unknown, id = false): string {
  if (typeof value !== 'string' || id && (!value || value !== value.trim() || value.length > 2048)) return failBackup('invalid string identity')
  return value
}
function identity(value: unknown): string { if (!isDatabaseViewReferenceId(value)) return failBackup('invalid reference identity'); return value }
function blockIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) return failBackup('invalid persisted block identity')
  return value
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return failBackup('invalid order')
  return value as number
}
function date(value: unknown): string {
  const result = string(value)
  if (!result || !Number.isFinite(Date.parse(result))) return failBackup('invalid timestamp')
  return result
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) return failBackup('expected array'); return value }
export function ids(value: unknown): string[] {
  const result = array(value).map(value => string(value, true))
  if (new Set(result).size !== result.length) return failBackup('duplicate identity')
  return result
}
export function parseBackupJson(value: string): unknown { return parseStrictJson(value, limits) }
export function backupScope(path: string, relativePath: string): string {
  const paths = path.split('/'), files = relativePath.split('/')
  const trailing = paths.slice(-files.length).join('/')
  return trailing === relativePath ? paths.slice(0, paths.length - files.length).join('/') : ''
}
export function strictPath(value: unknown): string {
  const path = string(value, true)
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\x00-\x1f]/.test(segment))) return failBackup('invalid document path')
  return path
}
export type MissingReferences = { databaseIds: string[]; views: Array<{ databaseId: string; viewId: string }>; fields: Array<{ databaseId: string; fieldId: string }> }
export type DeletionPolicy = { documents: { mode: 'none' } | { mode: 'scopes'; paths: string[] }; customDatabases: { mode: 'complete' }; catalog: { mode: 'source-owned' } }
export type ManifestV2 = { snapshotId: string; catalogId: string; databaseIds: string[]; documentIds: string[]; missing: MissingReferences; deletion: DeletionPolicy }
export type V2Document = ExportDocument & { sourceFilePath: string; relativePath: string }
export type ArchiveV2 = { manifest: ManifestV2; catalog: ExportStandaloneDatabase; databases: ExportStandaloneDatabase[]; documents: V2Document[] }
export type BackupInput = { filePath: string; relativePath: string; markdown: string }

/** Read raw header lines before the legacy frontmatter Record can discard duplicates. */
export function readV2Header(markdown: string): Record<string, string> | null {
  const header = extractMarkdownFrontmatter(markdown)
  if (!header) return null
  const lines = header.raw.replace(/^\uFEFF/, '').split(/\r?\n/).slice(1, -1)
  const candidate = lines.some(line => /^backupFormatVersion\s*:/.test(line))
  if (!candidate) return null
  if (!header.body.startsWith(KNOWBOOK_BACKUP_MARKER) || !/^(?:\r?\n|$)/.test(header.body.slice(KNOWBOOK_BACKUP_MARKER.length))) return null
  const result: Record<string, string> = Object.create(null)
  for (const line of lines) {
    if (!line.trim()) continue
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)
    if (!match || Object.hasOwn(result, match[1])) return failBackup('duplicate or invalid frontmatter key')
    result[match[1]] = string(parseBackupJson(match[2]))
  }
  if (result.backupFormatVersion !== BACKUP_V2) return failBackup('unsupported backupFormatVersion')
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(result.backupSnapshotId ?? '')) return failBackup('invalid snapshot identity')
  return result
}

function columns(value: unknown): DocumentDatabaseColumn[] {
  const result = array(value).map(value => {
    const item = object(value, ['id', 'name', 'type', 'options', 'sortOrder'])
    const type = string(item.type)
    if (!['text', 'select', 'multi-select', 'checkbox', 'date'].includes(type)) return failBackup('invalid column type')
    return { id: identity(item.id), name: string(item.name, true), type: type as DocumentDatabaseColumn['type'], options: ids(item.options), sortOrder: integer(item.sortOrder) }
  })
  if (new Set(result.map(item => item.id)).size !== result.length) return failBackup('duplicate column')
  return result
}
export function validateFieldValues(input: unknown, columns: DocumentDatabaseColumn[]): Record<string, DocumentDatabaseFieldValue> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return failBackup('invalid field values')
  const byId = new Map(columns.map(column => [column.id, column]))
  const result: Record<string, DocumentDatabaseFieldValue> = Object.create(null)
  for (const [id, value] of Object.entries(input)) {
    const column = byId.get(id)
    if (!column) return failBackup('field value has an unknown column')
    if (value !== null && (column.type === 'checkbox' ? typeof value !== 'boolean' : column.type === 'multi-select'
      ? !Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length
      : typeof value !== 'string')) return failBackup('invalid typed field value')
    if ((column.type === 'select' && typeof value === 'string' && value && !column.options.includes(value))
      || column.type === 'multi-select' && Array.isArray(value) && value.some(item => !column.options.includes(item))) return failBackup('unknown select option')
    result[id] = value as DocumentDatabaseFieldValue
  }
  return result
}
export function strictSavedViewConfig(raw: string, version: number, legacy: { filterQuery: string; filterScope: string; sortMode: string; viewMode: string }) {
  if (version !== 1) return failBackup('unknown saved view config version')
  if (!['updated-desc', 'updated-asc', 'created-desc', 'created-asc'].includes(legacy.sortMode) || !['cards', 'table', 'board'].includes(legacy.viewMode)) return failBackup('invalid legacy saved view metadata')
  const value = parseBackupJson(raw)
  // Only the exact schema migration sentinel is a legacy missing config.
  return validateDatabaseViewConfig(value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length
    ? createLegacyDatabaseViewConfig({ ...legacy, sortMode: legacy.sortMode as DatabaseSavedView['sortMode'], viewMode: legacy.viewMode as DatabaseSavedView['viewMode'] }) : value)
}
function definition(header: Record<string, string>): ExportStandaloneDatabase {
  object(header, ['kind', 'backupFormatVersion', 'backupSnapshotId', 'databaseId', 'databaseName', 'databaseDescription', 'createdAt', 'updatedAt', 'databaseColumns', 'databaseSavedViews', 'databaseEntities'])
  const id = identity(header.databaseId), sourceColumns = columns(parseBackupJson(header.databaseColumns))
  const views = array(parseBackupJson(header.databaseSavedViews)).map(value => {
    const item = object(value, ['id', 'databaseId', 'name', 'filterQuery', 'filterScope', 'sortMode', 'viewMode', 'config', 'configVersion', 'sortOrder', 'createdAt', 'updatedAt'])
    if (item.databaseId !== id || item.configVersion !== 1 || !['updated-desc', 'updated-asc', 'created-desc', 'created-asc'].includes(String(item.sortMode))
      || !['cards', 'table', 'board'].includes(String(item.viewMode))) return failBackup('invalid saved view owner or version')
    return { id: identity(item.id), databaseId: id, name: string(item.name, true), filterQuery: string(item.filterQuery), filterScope: string(item.filterScope),
      sortMode: item.sortMode, viewMode: item.viewMode, config: validateDatabaseViewConfig(item.config), configVersion: 1,
      sortOrder: integer(item.sortOrder), createdAt: date(item.createdAt), updatedAt: date(item.updatedAt) } as DatabaseSavedView
  })
  if (new Set(views.map(view => view.id)).size !== views.length || new Set(views.map(view => view.name.toLowerCase())).size !== views.length) return failBackup('duplicate saved view')
  const entities = array(parseBackupJson(header.databaseEntities)).map(value => {
    const item = object(value, ['id', 'title', 'documentId', 'documentPath', 'createdAt', 'updatedAt', 'fieldValues'])
    if ((item.documentId === null) !== (item.documentPath === null)) return failBackup('invalid entity document binding')
    return { id: identity(item.id), title: string(item.title, true), documentId: item.documentId === null ? null : identity(item.documentId),
      documentPath: item.documentPath === null ? null : strictPath(item.documentPath), createdAt: date(item.createdAt), updatedAt: date(item.updatedAt),
      fieldValues: validateFieldValues(item.fieldValues, sourceColumns) } as ExportStandaloneDatabaseEntity
  })
  if (new Set(entities.map(entity => entity.id)).size !== entities.length) return failBackup('duplicate entity')
  return { id, name: string(header.databaseName, true), description: string(header.databaseDescription), createdAt: date(header.createdAt), updatedAt: date(header.updatedAt), columns: sourceColumns, savedViews: views, entities }
}

export function missingReferences(snapshot: Pick<ExportWorkspaceSnapshot, 'catalog' | 'standaloneDatabases' | 'documents'>): MissingReferences {
  const sources = new Map([snapshot.catalog, ...snapshot.standaloneDatabases].map(source => [source.id, source]))
  const views = new Map<string, string>(), fields = new Map<string, string>()
  for (const source of sources.values()) {
    for (const view of source.savedViews) { if (views.has(view.id)) return failBackup('duplicate view identity'); views.set(view.id, source.id) }
    for (const field of source.columns) { if (fields.has(field.id)) return failBackup('duplicate column identity'); fields.set(field.id, source.id) }
  }
  const missing: MissingReferences = { databaseIds: [], views: [], fields: [] }
  const inspectFields = (databaseId: string, fieldIds: Iterable<string>) => {
    for (const fieldId of fieldIds) {
      if (isSystemField(fieldId)) continue
      const owner = fields.get(fieldId)
      if (owner && owner !== databaseId) return failBackup('field belongs to another source')
      if (!owner) missing.fields.push({ databaseId, fieldId })
    }
  }
  for (const source of sources.values()) for (const view of source.savedViews) {
    inspectFields(source.id, collectDatabaseViewConfigFieldIds(validateDatabaseViewConfig(view.config)))
    if (view.filterScope && !['all', 'title', 'path', 'summary'].includes(view.filterScope)) inspectFields(source.id, [view.filterScope])
  }
  for (const document of snapshot.documents) for (const block of document.blocks) if (block.type === 'database-view') {
    const payload = parseDatabaseViewPayload(block.content)
    if (!sources.has(payload.databaseId)) missing.databaseIds.push(payload.databaseId)
    if (payload.viewId !== null) {
      const owner = views.get(payload.viewId)
      if (owner && owner !== payload.databaseId) return failBackup('view belongs to another source')
      if (!owner) missing.views.push({ databaseId: payload.databaseId, viewId: payload.viewId })
    }
    inspectFields(payload.databaseId, collectDatabaseViewConfigFieldIds(payload.config))
  }
  missing.databaseIds = [...new Set(missing.databaseIds)].sort()
  missing.views = [...new Map(missing.views.map(item => [backupJson(item), item])).values()].sort((a, b) => backupJson(a).localeCompare(backupJson(b)))
  missing.fields = [...new Map(missing.fields.map(item => [backupJson(item), item])).values()].sort((a, b) => backupJson(a).localeCompare(backupJson(b)))
  return missing
}

/** Historical block IDs are opaque. Validate their authored values before the
 * ordinary Markdown reader trims or drops invalid metadata, without inspecting
 * literal comments inside code, quotes or complex list bodies. */
function validateV2BlockMetadata(markdown: string): void {
  const header = extractMarkdownFrontmatter(markdown)!
  const body = header.body.slice(KNOWBOOK_BACKUP_MARKER.length).replace(/^\r?\n/, '')
  const inspect = (nodes: MarkdownNode[]): void => {
    for (const node of nodes) {
      if (node.token.type === 'knowbook_metadata') {
        const match = /^<!-- knowbook:block (\{.*\}) -->$/.exec(node.token.content)
        if (!match) return failBackup('invalid block metadata')
        const value = parseBackupJson(match[1])
        if (!value || typeof value !== 'object' || Array.isArray(value)) return failBackup('invalid block metadata')
        const item = value as Record<string, unknown>
        if (Object.hasOwn(item, 'id')) blockIdentity(item.id)
        if (Object.hasOwn(item, 'parentBlockId') && item.parentBlockId !== null) blockIdentity(item.parentBlockId)
      } else if (nativeMarkdownContainer(node.token)) inspect(node.children)
    }
  }
  inspect(markdownTokenTree(markdownEngine.parse(body, {})))
}

export function parseArchiveV2(inputs: BackupInput[], parsed: ParsedMarkdownDocument[]): ArchiveV2 | null {
  const headers = inputs.map(input => readV2Header(input.markdown))
  if (!headers.some(Boolean)) {
    if (inputs.some((input, index) => parsed[index].isKnowbookBackup && Object.hasOwn(parsed[index].frontmatter, 'backupFormatVersion')
      || [MANIFEST_PATH, CATALOG_PATH].includes(input.relativePath + '.md')
        && (parsed[index].frontmatter.backupFormatVersion !== undefined || parsed[index].frontmatter.kind === CATALOG_KIND))) return failBackup('V2 envelope or version is missing')
    return null
  }
  if (headers.some(header => !header)) return failBackup('mixed or incomplete V2 archive')
  const manifestIndex = inputs.findIndex(input => input.relativePath + '.md' === MANIFEST_PATH)
  const catalogIndex = inputs.findIndex(input => input.relativePath + '.md' === CATALOG_PATH)
  if (manifestIndex < 0 || catalogIndex < 0) return failBackup('manifest or catalog file missing')
  const header = headers[manifestIndex]!
  object(header, ['kind', 'backupFormatVersion', 'backupSnapshotId', 'catalogDatabaseId', 'databaseIds', 'documentIds', 'databaseMissingReferences', 'restoreDeletionPolicy'])
  if (header.kind !== MANIFEST_KIND || headers[catalogIndex]!.kind !== CATALOG_KIND) return failBackup('invalid reserved kind')
  const policy = object(parseBackupJson(header.restoreDeletionPolicy), ['documents', 'customDatabases', 'catalog'])
  const documentsPolicy = object(policy.documents, ['mode', 'paths'], ['mode'])
  if (documentsPolicy.mode !== 'none' && documentsPolicy.mode !== 'scopes' || documentsPolicy.mode === 'none' && Object.hasOwn(documentsPolicy, 'paths')) return failBackup('invalid document deletion policy')
  const deletion: DeletionPolicy = { documents: documentsPolicy.mode === 'none' ? { mode: 'none' }
    : { mode: 'scopes', paths: array(documentsPolicy.paths).map(path => path === '' ? '' : strictPath(path)) }, customDatabases: { mode: 'complete' }, catalog: { mode: 'source-owned' } }
  if (backupJson(policy.customDatabases) !== '{"mode":"complete"}' || backupJson(policy.catalog) !== '{"mode":"source-owned"}') return failBackup('invalid database deletion policy')
  const rawMissing = object(parseBackupJson(header.databaseMissingReferences), ['databaseIds', 'views', 'fields'])
  const missing: MissingReferences = { databaseIds: ids(rawMissing.databaseIds), views: array(rawMissing.views).map(value => {
    const item = object(value, ['databaseId', 'viewId']); return { databaseId: string(item.databaseId, true), viewId: string(item.viewId, true) }
  }), fields: array(rawMissing.fields).map(value => { const item = object(value, ['databaseId', 'fieldId']); return { databaseId: string(item.databaseId, true), fieldId: string(item.fieldId, true) } }) }
  const manifest: ManifestV2 = { snapshotId: header.backupSnapshotId, catalogId: string(header.catalogDatabaseId, true), databaseIds: ids(parseBackupJson(header.databaseIds)), documentIds: ids(parseBackupJson(header.documentIds)), missing, deletion }
  const catalog = definition(headers[catalogIndex]!), databases: ExportStandaloneDatabase[] = [], documents: V2Document[] = []
  inputs.forEach((input, index) => {
    const value = headers[index]!
    if (value.backupSnapshotId !== manifest.snapshotId) return failBackup('mixed snapshot identities')
    if (index === manifestIndex) { if (parsed[index].blocks.length) return failBackup('manifest contains body blocks'); return }
    if (value.kind) {
      if (index !== catalogIndex) {
        if (value.kind !== DATABASE_KIND) return failBackup('duplicate or unknown definition kind')
        const source = definition(value)
        if (input.relativePath + '.md' !== databaseFile(source.id)) return failBackup('invalid database definition path')
        databases.push(source)
      }
      if (parsed[index].blocks.length) return failBackup('definition contains body blocks')
    } else {
      object(value, ['id', 'title', 'path', 'updatedAt', 'summary', 'documentDatabaseColumns', 'documentDatabaseFieldValues', 'backupFormatVersion', 'backupSnapshotId', 'documentDatabaseId'])
      validateV2BlockMetadata(input.markdown)
      if (value.documentDatabaseId !== catalog.id || backupJson(columns(parseBackupJson(value.documentDatabaseColumns))) !== backupJson(catalog.columns)) return failBackup('conflicting catalog column projection')
      const blocks = parsed[index].blocks.map(block => ({ ...block, depth: block.depth ?? 0, checked: Boolean(block.checked), parentBlockId: block.parentBlockId ?? null })) as ExportDocument['blocks']
      if (value.title !== value.path.split('/').at(-1)) return failBackup('document title does not match its path')
      documents.push({ id: identity(value.id), title: string(value.title, true), path: strictPath(value.path), summary: string(value.summary), updatedAt: date(value.updatedAt),
        documentDatabaseColumns: catalog.columns, documentDatabaseFieldValues: validateFieldValues(parseBackupJson(value.documentDatabaseFieldValues), catalog.columns), blocks,
        sourceFilePath: input.filePath, relativePath: input.relativePath })
    }
  })
  if (catalog.id !== manifest.catalogId || databases.some(source => source.id === catalog.id)
    || backupJson(databases.map(source => source.id).sort()) !== backupJson([...manifest.databaseIds].sort())
    || backupJson(documents.map(source => source.id).sort()) !== backupJson([...manifest.documentIds].sort())
    || new Set(documents.map(source => source.path)).size !== documents.length) return failBackup('incomplete or duplicate definition set')
  const sourceIds = [catalog, ...databases].flatMap(source => source.entities.map(entity => entity.id))
  if (new Set(sourceIds).size !== sourceIds.length) return failBackup('duplicate entity identity')
  const byDocument = new Map(documents.map(document => [document.id, document.path]))
  for (const source of [catalog, ...databases]) for (const entity of source.entities) if (entity.documentId && byDocument.get(entity.documentId) !== entity.documentPath) return failBackup('missing linked document')
  const scopes = [...new Set(documents.map(document => backupScope(document.path, document.relativePath)))].sort()
  if (!documents.length ? deletion.documents.mode !== 'none' : deletion.documents.mode !== 'scopes'
    || backupJson([...deletion.documents.paths].sort()) !== backupJson(scopes)) return failBackup('invalid document deletion scope')
  const archive = { manifest, catalog, databases, documents }
  validateDocuments(documents)
  if (backupJson(missingReferences({ catalog, standaloneDatabases: databases, documents })) !== backupJson(missing)) return failBackup('missing reference declarations do not match')
  return archive
}

/** Reuse exactly the import validator before publishing an in-memory snapshot. */
export function validateExportSnapshot(snapshot: ExportWorkspaceSnapshot): void {
  const sources = [snapshot.catalog, ...snapshot.standaloneDatabases]
  for (const source of sources) definition({ kind: source === snapshot.catalog ? CATALOG_KIND : DATABASE_KIND, backupFormatVersion: BACKUP_V2,
    backupSnapshotId: '00000000-0000-4000-8000-000000000000', databaseId: source.id, databaseName: source.name, databaseDescription: source.description,
    createdAt: source.createdAt, updatedAt: source.updatedAt, databaseColumns: backupJson(source.columns), databaseSavedViews: backupJson(source.savedViews), databaseEntities: backupJson(source.entities) })
  if (new Set(sources.map(source => source.id)).size !== sources.length) return failBackup('duplicate database identity')
  const documents = new Map(snapshot.documents.map(document => [document.id, document.path]))
  if (documents.size !== snapshot.documents.length) return failBackup('duplicate document identity')
  validateDocuments(snapshot.documents)
  for (const document of snapshot.documents) validateFieldValues(document.documentDatabaseFieldValues, snapshot.catalog.columns)
  for (const source of sources) for (const entity of source.entities) if (entity.documentId && documents.get(entity.documentId) !== entity.documentPath) return failBackup('missing linked document')
  missingReferences(snapshot)
}

function validateDocuments(documents: ExportDocument[]): void {
  const ids = new Set<string>()
  for (const document of documents) {
    const ancestors: ExportDocument['blocks'] = []
    if (!validColumnStructure(document.blocks, { checkParentIds: true })) return failBackup('invalid column forest')
    for (const block of document.blocks) {
      blockIdentity(block.id)
      if (block.parentBlockId != null) blockIdentity(block.parentBlockId)
      if (ids.has(block.id) || !Number.isInteger(block.depth) || block.depth < 0 || block.depth > 6) return failBackup('duplicate block identity or invalid depth')
      ids.add(block.id)
      const parent = ancestors[block.depth - 1]
      if (block.depth ? !parent || block.parentBlockId !== parent.id || !canBlockNestUnder(parent.type, block.type) : block.parentBlockId != null) return failBackup('invalid block ownership')
      if (block.type === 'database-view') validateDatabaseViewBlock(block)
      ancestors.length = block.depth + 1; ancestors[block.depth] = block
    }
  }
}

export function mapLegacyScope(scope: string, mapper: (id: string) => string): string {
  return !scope || ['all', 'title', 'path', 'summary'].includes(scope) ? scope : mapper(scope)
}
export { mapDatabaseViewConfigFieldIds }
