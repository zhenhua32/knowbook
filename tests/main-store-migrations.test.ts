import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

test('KnowbookStore migrates a legacy database once and records its schema version', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-migration-test-'))
  const databasePath = join(tempRoot, 'legacy.sqlite')
  const legacyDatabase = new Database(databasePath)

  try {
    legacyDatabase.exec(`
      CREATE TABLE document_database_columns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE document_database_values (
        document_id TEXT,
        column_id TEXT NOT NULL,
        value_text TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (document_id, column_id)
      );
    `)
  } finally {
    legacyDatabase.close()
  }

  const migratedStore = new KnowbookStore(databasePath)
  migratedStore.destroy()
  assert.equal(
    readdirSync(tempRoot).some((entry) => entry.startsWith('legacy.sqlite.pre-migration-v0-to-v11-')),
    true
  )

  const migratedDatabase = new Database(databasePath)
  try {
    assert.equal(migratedDatabase.pragma('user_version', { simple: true }), 11)
    const columnNames = (migratedDatabase.pragma('table_info(document_database_columns)') as Array<{ name: string }>)
      .map((column) => column.name)
    const valueColumnNames = (migratedDatabase.pragma('table_info(document_database_values)') as Array<{ name: string }>)
      .map((column) => column.name)
    const documentColumnNames = (migratedDatabase.pragma('table_info(documents)') as Array<{ name: string }>)
      .map((column) => column.name)
    const savedViewColumnNames = (migratedDatabase.pragma('table_info(database_saved_views)') as Array<{ name: string }>)
      .map((column) => column.name)
    const entityColumnNames = (migratedDatabase.pragma('table_info(database_entities)') as Array<{ name: string }>)
      .map((column) => column.name)
    const triggerNames = (migratedDatabase.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
    `).all() as Array<{ name: string }>).map((trigger) => trigger.name)

    assert.equal(columnNames.includes('database_id'), true)
    assert.equal(valueColumnNames.includes('entity_id'), true)
    assert.equal(documentColumnNames.includes('block_count'), true)
    assert.equal(documentColumnNames.includes('link_count'), true)
    assert.equal(documentColumnNames.includes('child_count'), true)
    assert.equal(savedViewColumnNames.includes('config_json'), true)
    assert.equal(savedViewColumnNames.includes('config_version'), true)
    assert.equal(savedViewColumnNames.includes('sort_order'), true)
    assert.equal(entityColumnNames.includes('title'), true)
    assert.equal(triggerNames.includes('trg_document_database_columns_database_id_insert'), true)
    assert.equal(triggerNames.includes('trg_database_entities_document_unique_insert'), true)
    assert.equal(triggerNames.includes('trg_document_search_insert'), true)
    assert.equal(triggerNames.includes('trg_block_search_update'), true)
    assert.equal(triggerNames.includes('trg_document_stats_block_insert'), true)
    assert.equal(triggerNames.includes('trg_document_stats_link_delete'), true)
    assert.equal(triggerNames.includes('trg_document_stats_child_move'), true)

    const defaultDatabaseId = (migratedDatabase.prepare(`
      SELECT id FROM databases ORDER BY created_at ASC LIMIT 1
    `).get() as { id: string }).id
    const documentId = (migratedDatabase.prepare(`
      SELECT id FROM documents ORDER BY created_at ASC LIMIT 1
    `).get() as { id: string }).id
    const now = new Date().toISOString()

    assert.throws(() => {
      migratedDatabase.prepare(`
        INSERT INTO document_database_columns (
          id, database_id, name, type, options_json, sort_order, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, '[]', 0, ?, ?)
      `).run('invalid-column', 'Invalid', 'text', now, now)
    }, /Database id is required/)

    migratedDatabase.prepare(`
      INSERT INTO database_entities (id, database_id, document_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('first-entity', defaultDatabaseId, documentId, now, now)
    assert.throws(() => {
      migratedDatabase.prepare(`
        INSERT INTO database_entities (id, database_id, document_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('duplicate-entity', defaultDatabaseId, documentId, now, now)
    }, /already exists for this document/)
  } finally {
    migratedDatabase.close()
  }

  const reopenedStore = new KnowbookStore(databasePath)
  reopenedStore.destroy()
  rmSync(tempRoot, { recursive: true, force: true })
})

test('KnowbookStore v10 migration extends legacy system plugin requests without changing them', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-v10-system-plugin-migration-test-'))
  const databasePath = join(tempRoot, 'v9.sqlite')
  const sourceStore = new KnowbookStore(databasePath)
  const request = sourceStore.pluginPlatform.createSystemPluginInstallRequest({
    pluginId: 'legacy.system',
    name: 'Legacy System',
    version: '1.0.0',
    publisher: 'Example Publisher',
    artifactSha256: 'a'.repeat(64),
    systemPermissions: ['system.full-access'],
    reason: 'Preserve this pending request across the v10 migration.',
    requestedBy: 'assistant'
  })
  sourceStore.destroy()

  const legacyDatabase = new Database(databasePath)
  try {
    for (const column of [
      'staged_artifact_path',
      'computed_artifact_sha256',
      'manifest_snapshot_json',
      'dependency_plan_json',
      'confirmation_version',
      'installation_id',
      'error_json'
    ]) {
      legacyDatabase.exec(`ALTER TABLE system_plugin_install_requests DROP COLUMN ${column}`)
    }
    legacyDatabase.pragma('user_version = 9')
  } finally {
    legacyDatabase.close()
  }

  const migratedStore = new KnowbookStore(databasePath)
  try {
    const migrated = migratedStore.pluginPlatform.getSystemPluginInstallRequest(request.id)
    assert.equal(migrated?.status, 'awaiting-confirmation')
    assert.equal(migrated?.pluginId, 'legacy.system')
    assert.equal(migrated?.stagedArtifactPath, null)
    assert.equal(migrated?.computedArtifactSha256, null)
    assert.equal(migrated?.manifestSnapshot, null)
    assert.equal(migrated?.dependencyPlan, null)
    assert.equal(migrated?.confirmationVersion, null)
    assert.equal(migrated?.installationId, null)
    assert.equal(migrated?.error, null)
  } finally {
    migratedStore.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('KnowbookStore v4 migration backfills full view config and readable record titles', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-v4-migration-test-'))
  const databasePath = join(tempRoot, 'v3.sqlite')
  const sourceStore = new KnowbookStore(databasePath)
  const database = sourceStore.createDatabase({ name: 'Projects' })
  const document = sourceStore.getAllDocumentSnapshots()[0]!
  const view = sourceStore.createDatabaseSavedView({
    databaseId: database.id,
    name: 'Recently updated',
    filterQuery: 'roadmap',
    sortMode: 'created-asc',
    viewMode: 'table'
  })
  const entity = sourceStore.createDatabaseEntity({
    databaseId: database.id,
    documentId: document.id
  })
  sourceStore.destroy()

  const legacyDatabase = new Database(databasePath)
  try {
    legacyDatabase.exec(`
      DROP INDEX IF EXISTS idx_database_saved_views_database_sort;
      DROP INDEX IF EXISTS idx_database_entities_database_title;
      ALTER TABLE database_saved_views DROP COLUMN config_json;
      ALTER TABLE database_saved_views DROP COLUMN config_version;
      ALTER TABLE database_saved_views DROP COLUMN sort_order;
      ALTER TABLE database_entities DROP COLUMN title;
      PRAGMA user_version = 3;
    `)
  } finally {
    legacyDatabase.close()
  }

  const migratedStore = new KnowbookStore(databasePath)
  try {
    const migratedView = migratedStore.getDatabaseSavedViews(database.id).find((candidate) => candidate.id === view.id)
    const migratedEntity = migratedStore.getDatabaseEntities(database.id).find((candidate) => candidate.id === entity.id)

    assert.equal(migratedView?.config.version, 1)
    assert.equal(migratedView?.config.layout, 'table')
    assert.equal(migratedView?.config.query, 'roadmap')
    assert.deepEqual(migratedView?.config.sorts, [{ fieldId: '__created_at__', direction: 'asc' }])
    assert.equal(migratedEntity?.title, document.title)
    assert.equal(
      readdirSync(tempRoot).some((entry) => entry.startsWith('v3.sqlite.pre-migration-v3-to-v11-')),
      true
    )
  } finally {
    migratedStore.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
