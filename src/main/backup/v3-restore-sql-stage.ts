import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { DocumentDatabaseFieldValue } from '../../shared/contracts'
import { assertOwnedRawCapsuleOriginal, prepareDurableSqlCapsuleOriginal, type OwnedRawCapsuleOriginal } from '../database/restore-knowledge-capsule-files'
import { readRawValidatedSyncedPersistentPublicationSnapshotOwned } from '../database/synced-publication-sql-read'
import { installSyncedRestoreRecords } from '../database/synced-restore-write'
import { canonicalRestoreRoot, restoreDirectory, restorePaths, syncRestoreDirectory, syncRestoreFile } from '../database/restore-safety-files'
import { KnowbookStore } from '../database/store'
import { SYNC_TABLES, type SyncDatabases } from '../sync/model'
import { publicationCompare, publicationJson, publicationRecordKey, type InitialPublicationRecord } from '../sync/synced-publication-model'
import { assertBackupV3RestoreSourceCurrent, readBackupV3RestoreSource, type BackupV3RestoreSource } from './v3-reader'

type Archive = ReturnType<typeof readBackupV3RestoreSource>['archive']
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

function stageRecords(archive: Archive, at: string) {
  const definitions = [archive.catalog, ...archive.standaloneDatabases]

  const documentPaths = new Map(archive.documents.map(doc => [doc.id, doc.path]))
  const byPath = new Map(archive.documents.map(doc => [doc.path, doc.id]))
  const siblingOrder = new Map<string | null, number>()
  const documents = [...archive.documents].sort((a, b) => publicationCompare(a.path, b.path)).map(doc => {
    const slash = doc.path.lastIndexOf('/'), parentId = slash < 0 ? null : byPath.get(doc.path.slice(0, slash))
    if (parentId === undefined) throw new Error('The verified V3 document parent is missing.')
    const sortOrder = siblingOrder.get(parentId) ?? 0
    siblingOrder.set(parentId, sortOrder + 1)
    return { kind: 'document' as const, id: doc.id, parentId, sortOrder, createdAt: at,
      content: { title: doc.title, summary: doc.summary, blocks: doc.blocks.map(({ sortOrder: _sort, ...block }) => block) } }
  })
  const groups = archive.groups.map(({ wire }) => wire)
  const catalog: SyncDatabases = { kind: 'databases', id: 'databases', tables: {
    databases: definitions.map(item => ({ id: item.id, name: item.name, description: item.description, created_at: item.createdAt })),
    document_database_columns: definitions.flatMap(item => item.columns.map(column => ({ id: column.id, database_id: item.id,
      name: column.name, type: column.type, options_json: JSON.stringify(column.options), sort_order: column.sortOrder, created_at: at }))),
    database_saved_views: definitions.flatMap(item => item.savedViews.map(view => ({ id: view.id, database_id: item.id,
      name: view.name, filter_query: view.filterQuery, filter_scope: view.filterScope, sort_mode: view.sortMode, view_mode: view.viewMode,
      config_json: publicationJson(view.config), config_version: view.configVersion, sort_order: view.sortOrder, created_at: view.createdAt }))),
    database_entities: definitions.flatMap(item => item.entities.map(entity => ({ id: entity.id, database_id: item.id,
      title: entity.title, document_id: entity.documentId, created_at: entity.createdAt }))),
    database_entity_values: definitions.flatMap(item => item.entities.flatMap(entity => Object.entries(entity.fieldValues).map(([id, value]) =>
      ({ entity_id: entity.id, column_id: id, value_text: sqlValue(value) })))),
    document_database_values: archive.documents.flatMap(doc => Object.entries(doc.documentDatabaseFieldValues).map(([id, value]) =>
      ({ document_id: doc.id, column_id: id, value_text: sqlValue(value), entity_id: null })))
  } }
  for (const table of SYNC_TABLES) catalog.tables[table].sort((a, b) => publicationCompare(publicationJson(a), publicationJson(b)))
  const records: InitialPublicationRecord[] = [catalog, ...documents, ...groups]
  records.sort((a, b) => publicationCompare(publicationRecordKey(a), publicationRecordKey(b)))
  return { records, documentPaths }
}

function archiveReservations(archive: Archive): string[] {
  const { blockIds, instanceIds } = archive.manifest.syncedMissingReferences
  return [...new Set([...blockIds, ...instanceIds])].sort(publicationCompare)
}

/** Independently verify the portable archive against the actual SQLite
 * business projection in its current read transaction. */
export function assertBackupV3RestoreSqlArchiveProjection(db: Database.Database, archive: Archive): void {
  const actual = readRawValidatedSyncedPersistentPublicationSnapshotOwned(db)
  if (actual.catalogId !== archive.catalog.id) throw new Error('The private V3 SQL catalog identity differs from its source.')
  const at = new Date(archive.catalog.createdAt).toISOString()
  const expected = stageRecords(archive, at)
  const normalize = (records: InitialPublicationRecord[]) => publicationJson(records.map(record => record.kind === 'document'
    ? { ...record, content: { ...record.content, blocks: record.content.blocks.map(block => ({ ...block, tags: block.tags ?? [] })) } }
    : record))
  if (normalize(actual.records) !== normalize(expected.records) || actual.deletions?.length) {
    throw new Error('The private V3 SQL readback differs from its source records.')
  }
  const paths = db.prepare('SELECT id,path FROM documents').all() as Array<{ id: string; path: string }>
  if (paths.length !== expected.documentPaths.size || paths.some(doc => expected.documentPaths.get(doc.id) !== doc.path)) {
    throw new Error('The private V3 SQL document paths differ from their source.')
  }
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

/** Materialize a verified V3 archive in private SQLite. Its portable asset
 * addresses stay valid independently of the source archive's location. */
export async function prepareBackupV3RestoreSqlStage(owner: BackupV3RestoreSource, profileRoot: string, operationId: string): Promise<BackupV3RestoreSqlStage> {
  const { archive, inventoryHash } = readBackupV3RestoreSource(owner)
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
      const at = new Date(archive.catalog.createdAt).toISOString(), mapped = stageRecords(archive, at)
      const { id: catalogId, createdAt: catalogBirth } = archive.catalog
      if (db.prepare('UPDATE databases SET id=?,created_at=?,updated_at=? WHERE id=?').run(catalogId, catalogBirth, at, before.catalogId).changes !== 1
        || db.prepare("UPDATE app_settings SET value=?,updated_at=? WHERE key='database.defaultId' AND value=?")
          .run(catalogId, at, before.catalogId).changes !== 1) throw new Error('The independent V3 catalog identity could not be assigned.')
      const reservedIds = archiveReservations(archive)
      const reservationSourceKey = 'backup-v3:' + archive.manifest.snapshotId
      installSyncedRestoreRecords(db, { ...mapped, reservedIds, reservationSourceKey, targetCatalogId: catalogId }, at)
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
