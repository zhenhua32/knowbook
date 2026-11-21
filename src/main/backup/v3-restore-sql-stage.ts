import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { DocumentDatabaseFieldValue } from '../../shared/contracts'
import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { inspectSyncedWorkspaceGraphStream } from '../../shared/syncedBlockGraph'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { assertOwnedRawCapsuleOriginal, prepareDurableSqlCapsuleOriginal, type OwnedRawCapsuleOriginal } from '../database/restore-knowledge-capsule-files'
import { iterateRawActiveSyncedGroupSnapshotsOwned, readRawSyncedWorkspaceScopeOwned } from '../database/synced-blocks-raw-read'
import { readStrictHostDocument } from '../database/synced-host-document-read'
import { assertSyncedLogicalDeletionRecords } from '../database/synced-logical-deletion-read'
import { assertRawSyncedPublicationSqlStructureOwned, readRawValidatedSyncedPersistentPublicationSnapshotOwned } from '../database/synced-publication-sql-read'
import { installSyncedRestoreContent } from '../database/synced-restore-write'
import { assertSyncedStoredBindings } from '../database/synced-stored-binding-read'
import { canonicalRestoreRoot, restoreDirectory, restorePaths, syncRestoreDirectory, syncRestoreFile } from '../database/restore-safety-files'
import { KnowbookStore } from '../database/store'
import { SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncDatabases, type SyncRow, type SyncTable } from '../sync/model'
import { publicationCompare, publicationJson, validateInitialRecord, validatePublicationCatalogRow, type InitialPublicationRecord } from '../sync/synced-publication-model'
import type { ArchiveV3, BackupV3ContentSource, ScopedBackupV3Archive } from './v3-format'
import { assertBackupV3RestoreSourceCurrent, readScopedBackupV3RestoreSource, type BackupV3RestoreSource } from './v3-reader'

type Archive = Omit<ArchiveV3, 'assets'> | ScopedBackupV3Archive
type RestoreDocument = Extract<InitialPublicationRecord, { kind: 'document' }>
export interface BackupV3RestoreSqlStage {
  readonly database: string
  readonly directory: string
  readonly inventoryHash: string
  readonly snapshotId: string
}
const sqlStages = new WeakMap<BackupV3RestoreSqlStage, { source: BackupV3RestoreSource; original: OwnedRawCapsuleOriginal }>()

function sqlValue(value: DocumentDatabaseFieldValue): string | null {
  return value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)
}

function stageDocuments(archive: Archive, at: string) {
  const scoped = 'readDocument' in archive ? archive : undefined
  const memory = 'readDocument' in archive ? undefined : new Map(archive.documents.map(doc => [doc.id, doc] as const))
  const locations = scoped?.documentLocations ?? Array.from(archive.documents, ({ id, path }) => ({ id, path }))
  const documentPaths = new Map(locations.map(doc => [doc.id, doc.path]))
  const byPath = new Map(locations.map(doc => [doc.path, doc.id]))
  if (locations.length !== documentPaths.size || locations.length !== byPath.size)
    throw new Error('The verified V3 document identities or paths are repeated.')
  const siblingOrder = new Map<string | null, number>()
  const positions = new Map([...locations].sort((a, b) => publicationCompare(a.path, b.path)).map(doc => {
    const slash = doc.path.lastIndexOf('/'), parentId = slash < 0 ? null : byPath.get(doc.path.slice(0, slash))
    if (parentId === undefined) throw new Error('The verified V3 document parent is missing.')
    const sortOrder = siblingOrder.get(parentId) ?? 0
    siblingOrder.set(parentId, sortOrder + 1)
    return [doc.id, { parentId, sortOrder }] as const
  }))
  const record = (id: string): RestoreDocument => {
    const doc = scoped ? scoped.readDocument(id) : memory!.get(id), position = positions.get(id)
    if (!doc || !position || doc.id !== id || doc.path !== documentPaths.get(id)) throw new Error('The verified V3 document is missing.')
    return { kind: 'document', id, ...position, createdAt: at,
      content: { title: doc.title, summary: doc.summary, blocks: doc.blocks.map(({ sortOrder: _sort, ...block }) => block) } }
  }
  const byId = [...locations].sort((a, b) => publicationCompare(a.id, b.id))
  const parentFirst = [...locations].sort((a, b) => a.path.split('/').length - b.path.split('/').length || publicationCompare(a.id, b.id))
  const readInOrder = (order: typeof locations) => ({ *[Symbol.iterator]() { for (const { id } of order) yield record(id) } })
  return { documents: readInOrder(byId), parentFirstDocuments: readInOrder(parentFirst), documentPaths, record }
}

function* catalogProjection(archive: BackupV3ContentSource, at: string): IterableIterator<[SyncTable, SyncRow]> {
  function* definitions() { yield archive.catalog; yield* archive.standaloneDatabases }
  for (const item of definitions()) {
    yield ['databases', { id: item.id, name: item.name, description: item.description, created_at: item.createdAt }]
    for (const column of item.columns) yield ['document_database_columns', { id: column.id, database_id: item.id,
      name: column.name, type: column.type, options_json: JSON.stringify(column.options), sort_order: column.sortOrder, created_at: at }]
    for (const view of item.savedViews) yield ['database_saved_views', { id: view.id, database_id: item.id,
      name: view.name, filter_query: view.filterQuery, filter_scope: view.filterScope, sort_mode: view.sortMode, view_mode: view.viewMode,
      config_json: publicationJson(view.config), config_version: view.configVersion, sort_order: view.sortOrder, created_at: view.createdAt }]
    for (const entity of item.entities) {
      yield ['database_entities', { id: entity.id, database_id: item.id, title: entity.title, document_id: entity.documentId, created_at: entity.createdAt }]
      for (const [id, value] of Object.entries(entity.fieldValues))
        yield ['database_entity_values', { entity_id: entity.id, column_id: id, value_text: sqlValue(value) }]
    }
  }
  for (const doc of archive.documents) for (const [id, value] of Object.entries(doc.documentDatabaseFieldValues))
    yield ['document_database_values', { document_id: doc.id, column_id: id, value_text: sqlValue(value), entity_id: null }]
}

const catalogRowLimit = 200_000 // The original sync object validator's per-table limit.

/** Keep the original write order, including v3 row-id witnesses. Big endian
 * UTF-16 BLOB order is the same order as publicationCompare's JS code units. */
function withOrderedCatalogRows<T>(archive: BackupV3ContentSource, at: string, read: (rows: (table: SyncTable) => Iterable<SyncRow>) => T) {
  const db = new Database(':memory:')
  try {
    db.pragma('temp_store=FILE')
    if (db.pragma('temp_store', { simple: true }) !== 1) throw new Error('The private V3 catalog sort could not open file storage.')
    db.pragma('temp.cache_size=-2048')
    db.exec(`CREATE TEMP TABLE v3_catalog (
      table_name TEXT NOT NULL, sort_key BLOB NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY(table_name,sort_key,ordinal)
    ) WITHOUT ROWID`)
    const insert = db.prepare('INSERT INTO temp.v3_catalog VALUES(?,?,?)')
    db.transaction(() => {
      const counts = new Map<SyncTable, number>()
      for (const [table, row] of catalogProjection(archive, at)) {
        const ordinal = counts.get(table) ?? 0
        if (ordinal >= catalogRowLimit) throw new Error('The private V3 SQL catalog exceeds the per-table row limit.')
        insert.run(table, Buffer.from(publicationJson(row), 'utf16le').swap16(), ordinal)
        counts.set(table, ordinal + 1)
      }
    })()
    const select = db.prepare('SELECT sort_key FROM temp.v3_catalog WHERE table_name=? ORDER BY sort_key,ordinal').pluck()
    return read(function* (table) {
      for (const bytes of select.iterate(table) as Iterable<Buffer>) yield JSON.parse(bytes.swap16().toString('utf16le')) as SyncRow
    })
  } finally { db.close() }
}

function archiveReservations(archive: Archive): string[] {
  const { blockIds, instanceIds } = archive.manifest.syncedMissingReferences
  return [...new Set([...blockIds, ...instanceIds])].sort(publicationCompare)
}

/** Independently verify the portable archive against the actual SQLite
 * business projection in its current read transaction. */
export function assertBackupV3RestoreSqlArchiveProjection(db: Database.Database, archive: Archive): void {
  assertRawSyncedPublicationSqlStructureOwned(db)
  readRawSyncedWorkspaceScopeOwned(db)
  if (!isSyncedUuid(db.prepare('SELECT recovery_epoch FROM synced_workspace_state WHERE singleton=1').pluck().get()))
    throw new Error('The private V3 SQL recovery identity is invalid.')
  const catalogId = db.prepare("SELECT value FROM app_settings WHERE key='database.defaultId'").pluck().get()
  if (catalogId !== archive.catalog.id) throw new Error('The private V3 SQL catalog identity differs from its source.')
  const at = new Date(archive.catalog.createdAt).toISOString()
  const { documentPaths, record: expectedDocument } = stageDocuments(archive, at)
  const different = (): never => { throw new Error('The private V3 SQL readback differs from its source records.') }
  assertArchiveCatalog(db, archive, at, different)
  if (assertSyncedLogicalDeletionRecords(db).size) return different()
  const selectSavedView = db.prepare('SELECT database_id FROM database_saved_views WHERE id=?').pluck()
  const assertCatalogBlocks = (blocks: readonly SyncedStableBlockDraft[]) => {
    for (const block of blocks) if (block.type === 'database-view') {
      const config = parseDatabaseViewPayload(block.content)
      if (catalogId !== 'catalog' && config.databaseId === 'catalog') return different()
      const viewDatabase = config.viewId === null ? undefined : selectSavedView.get(config.viewId)
      if (viewDatabase !== undefined && viewDatabase !== config.databaseId) return different()
    }
  }
  const paths = db.prepare('SELECT id,path FROM documents').all() as Array<{ id: string; path: string }>
  if (paths.length !== documentPaths.size || paths.some(doc => documentPaths.get(doc.id) !== doc.path))
    throw new Error('The private V3 SQL document paths differ from their source.')
  const normalize = (record: RestoreDocument) => publicationJson({ ...record,
    content: { ...record.content, blocks: record.content.blocks.map(block => ({ ...block, tags: block.tags ?? [] })) } })
  function* documents() {
    for (const { id } of paths) {
      const host = readStrictHostDocument(db, id) ?? different()
      const actual = validateInitialRecord({ kind: 'document', id, parentId: host.parentId, sortOrder: host.sortOrder,
        createdAt: host.createdAt, content: host.content }, 'doc:' + id)
      if (actual.kind !== 'document' || normalize(actual) !== normalize(expectedDocument(id))) return different()
      assertCatalogBlocks(actual.content.blocks)
      yield { documentId: id, blocks: actual.content.blocks }
    }
  }
  const memoryGroups = 'readGroup' in archive ? undefined : new Map(archive.groups.map(group => [group.wire.id, group]))
  const groupIds = new Set(memoryGroups?.keys() ?? archive.manifest.syncedGroups.map(group => group.id))
  if (!('readGroup' in archive) && groupIds.size !== archive.groups.length) return different()
  if (db.prepare('SELECT count(*) FROM synced_groups').pluck().get() !== groupIds.size) return different()
  let instanceCount = 0
  function* groups() {
    for (const group of iterateRawActiveSyncedGroupSnapshotsOwned(db)) {
      const expected = 'readGroup' in archive ? archive.readGroup(group.groupId) : memoryGroups!.get(group.groupId)
      const actual = { kind: 'synced-group' as const, id: group.groupId, creationId: group.creationId, createdAt: group.createdAt,
        origin: group.origin, bindings: group.bindings, blocks: group.blocks }
      if (!groupIds.delete(group.groupId) || !expected || publicationJson(actual) !== publicationJson(expected.wire)) return different()
      assertSyncedStoredBindings(db, group.origin, group.blocks, group.bindings)
      assertCatalogBlocks(group.blocks)
      instanceCount += group.instances.length
      yield actual
    }
    if (groupIds.size) return different()
  }
  const topology = inspectSyncedWorkspaceGraphStream(documents(), groups())
  const liveOwners = db.prepare("SELECT id,last_owner_kind,last_owner_id,created_at FROM block_identities WHERE state='live'")
  for (const row of liveOwners.iterate() as Iterable<{ id: string; last_owner_kind: string; last_owner_id: string; created_at: string | null }>) {
    const owner = topology.owners.get(row.id)
    if (!owner || owner.kind !== row.last_owner_kind || owner.id !== row.last_owner_id || row.created_at === null) return different()
    topology.owners.delete(row.id)
  }
  let actualInstances = 0
  for (const occurrences of topology.occurrences.values()) actualInstances += occurrences.length
  if (topology.owners.size || actualInstances !== instanceCount || db.prepare('SELECT count(*) FROM synced_instances').pluck().get() !== instanceCount)
    return different()
  const reserved = db.prepare("SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE state<>'live' ORDER BY id").all()
  const expectedReserved = archiveReservations(archive).map(id => ({ id, last_owner_kind: 'reserved', last_owner_id: 'backup-v3:' + archive.manifest.snapshotId,
    state: 'retained', created_at: null }))
  if (publicationJson(reserved) !== publicationJson(expectedReserved)
    || db.prepare('SELECT 1 FROM blocks WHERE created_at<>? LIMIT 1').get(at)) {
    throw new Error('The private V3 SQL block identities differ from their source.')
  }
  const extra = db.prepare(`SELECT 1 FROM document_templates UNION ALL SELECT 1 FROM document_trash
    UNION ALL SELECT 1 FROM document_history UNION ALL SELECT 1 FROM document_block_moves
    UNION ALL SELECT 1 FROM synced_operations UNION ALL SELECT 1 FROM synced_group_history
    UNION ALL SELECT 1 FROM synced_host_history UNION ALL SELECT 1 FROM synced_group_pins LIMIT 1`).get()
  if (extra) throw new Error('The private V3 SQL source contains unrelated history or template content.')
}

const catalogPrimaryKeys: Record<SyncTable, readonly string[]> = {
  databases: ['id'], document_database_columns: ['id'], database_saved_views: ['id'], database_entities: ['id'],
  database_entity_values: ['entity_id', 'column_id'], document_database_values: ['document_id', 'column_id']
}

function assertArchiveCatalog(db: Database.Database, archive: Archive, at: string, different: () => never) {
  const tables = new Map(SYNC_TABLES.map(table => {
    const keys = catalogPrimaryKeys[table], columns = SYNC_TABLE_COLUMNS[table]
    const read = db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE ${keys.map(key => `${key} IS ?`).join(' AND ')}`)
    const count = Number(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get())
    return [table, { keys, read, count, seen: new Set<string>() }] as const
  }))
  for (const [table, value] of catalogProjection(archive, at)) {
    const { keys, read, count, seen } = tables.get(table)!
    const lookup = keys.map(key => value[key]), identity = publicationJson(lookup)
    if (count > catalogRowLimit || seen.has(identity)) return different()
    const actual = read.get(...lookup)
    if (!actual || publicationJson(validatePublicationCatalogRow(table, actual)) !== publicationJson(value)) return different()
    seen.add(identity)
  }
  if ([...tables.values()].some(table => table.count !== table.seen.size)
    || archive.catalog.id !== 'catalog' && db.prepare("SELECT 1 FROM databases WHERE id='catalog'").get()
    || db.prepare(`SELECT 1 FROM database_saved_views GROUP BY database_id,name COLLATE NOCASE,length(CAST(name AS BLOB))
      HAVING count(*)>1 LIMIT 1`).get()
    || db.prepare(`SELECT 1 FROM database_entities WHERE document_id IS NOT NULL GROUP BY database_id,document_id
      HAVING count(*)>1 LIMIT 1`).get()
    || db.prepare(`SELECT 1 FROM database_entity_values v
      JOIN database_entities e ON e.id=v.entity_id JOIN document_database_columns c ON c.id=v.column_id
      WHERE c.database_id IS NOT e.database_id LIMIT 1`).get()) return different()
}

/** Materialize a verified V3 archive in private SQLite. Its portable asset
 * addresses stay valid independently of the source archive's location. */
export async function prepareBackupV3RestoreSqlStage(owner: BackupV3RestoreSource, profileRoot: string, operationId: string): Promise<BackupV3RestoreSqlStage> {
  const { archive, inventoryHash } = readScopedBackupV3RestoreSource(owner)
  const root = await canonicalRestoreRoot(profileRoot), operation = restorePaths(root, operationId).recovery
  const directory = join(operation, 'v3-sql-' + randomUUID())
  await restoreDirectory(directory, root, true)
  const sealedDirectory = join(directory, 'storage'), database = join(sealedDirectory, 'knowbook.db')
  const store = KnowbookStore.createEmptySyncedReceiver(database)
  try {
    const db = store.getUnsafeDatabaseHandle()
    db.transaction(() => {
      const before = readRawValidatedSyncedPersistentPublicationSnapshotOwned(db)
      const catalog = before.records.find((record): record is SyncDatabases => record.kind === 'databases')!
      if (before.records.length !== 1 || catalog.tables.databases.length !== 1
        || Object.entries(catalog.tables).some(([name, rows]) => name !== 'databases' && rows.length)) {
        throw new Error('V3 restore did not create an independent empty stage.')
      }
      // V3 has an original catalog birth but no ordinary document/block births.
      // Use a stable projection timestamp for those synthetic fields.
      const at = new Date(archive.catalog.createdAt).toISOString(), mapped = stageDocuments(archive, at)
      const { id: catalogId, createdAt: catalogBirth } = archive.catalog
      if (db.prepare('UPDATE databases SET id=?,created_at=?,updated_at=? WHERE id=?').run(catalogId, catalogBirth, at, before.catalogId).changes !== 1
        || db.prepare("UPDATE app_settings SET value=?,updated_at=? WHERE key='database.defaultId' AND value=?")
          .run(catalogId, at, before.catalogId).changes !== 1) throw new Error('The independent V3 catalog identity could not be assigned.')
      const reservedIds = archiveReservations(archive)
      const reservationSourceKey = 'backup-v3:' + archive.manifest.snapshotId
      const groups = { *[Symbol.iterator]() { for (const id of archive.manifest.syncedGroups.map(group => group.id).sort(publicationCompare)) {
        const group = archive.readGroup(id)
        if (!group) throw new Error('The verified V3 group is missing.')
        yield group.wire
      } } }
      withOrderedCatalogRows(archive, at, catalogRows => installSyncedRestoreContent(db, { ...mapped, groups, catalogRows, reservedIds,
        reservationSourceKey, targetCatalogId: catalogId }, at))
      assertBackupV3RestoreSqlArchiveProjection(db, archive)
      assertBackupV3RestoreSourceCurrent(owner)
    }).immediate()
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    store.destroy()
  }
  await syncRestoreFile(database)
  await syncRestoreDirectory(sealedDirectory)
  await syncRestoreDirectory(directory)
  await syncRestoreDirectory(operation)
  const original = await prepareDurableSqlCapsuleOriginal({ profileRoot: root, recoveryDirectory: operation,
    sealedDirectory, capsuleId: randomUUID(), label: 'verified V3 backup SQL source' })
  assertBackupV3RestoreSourceCurrent(owner)
  const stage = Object.freeze({ database, directory, inventoryHash, snapshotId: archive.manifest.snapshotId })
  sqlStages.set(stage, { source: owner, original })
  return stage
}

/** Join the actual V3 owner to its own independent SQLite original. */
export async function assertBackupV3RestoreSqlStageOriginal(stage: BackupV3RestoreSqlStage, owner: BackupV3RestoreSource): Promise<OwnedRawCapsuleOriginal> {
  const entry = sqlStages.get(stage)
  if (!entry || entry.source !== owner) throw new Error('The V3 SQL stage does not belong to this archive owner.')
  await assertOwnedRawCapsuleOriginal(entry.original)
  assertBackupV3RestoreSourceCurrent(owner)
  return entry.original
}
