import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { readDatabaseSnapshot } from '../e2e-tests/helpers/database-snapshot'

async function fixture(run: (store: KnowbookStore, root: string) => Promise<void>) {
  const parent = realpathSync(tmpdir())
  const root = realpathSync(mkdtempSync(join(parent, 'knowbook-sql-snapshot-')))
  mkdirSync(join(root, 'storage'))
  const store = new KnowbookStore(join(root, 'storage', 'knowbook.db'))
  try { await run(store, root) } finally {
    store.destroy()
    assert.ok(root.startsWith(parent + sep) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink())
    rmSync(root, { recursive: true, force: true })
  }
}

test('independent Electron SQL reader preserves the actual schema and all toolbar persistence tables', () => fixture(async (store, root) => {
  const database = store.createDatabase({ name: 'Snapshot source' })
  const field = store.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
  store.createDatabaseEntity({ databaseId: database.id, title: 'Committed record', fieldValues: { [field.id]: '中文 "quoted"\nnotes' } })
  const view = store.createDatabaseSavedView({ databaseId: database.id, name: 'Committed view' })
  const sql = store.getUnsafeDatabaseHandle(), before = sql.prepare('SELECT total_changes() AS changes').get()
  const snapshot = await readDatabaseSnapshot(root)
  assert.deepEqual(snapshot.schema, sql.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all())
  const tables = ['documents', 'blocks', 'links', 'databases', 'document_database_columns', 'database_entities',
    'database_entity_values', 'document_database_values', 'database_saved_views']
  assert.deepEqual(Object.keys(snapshot.tables), tables)
  for (const table of tables) assert.deepEqual(snapshot.tables[table], sql.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all())
  assert.ok(snapshot.tables.database_saved_views.some(row => row.id === view.id))
  assert.deepEqual(sql.prepare('SELECT total_changes() AS changes').get(), before)
}))

test('independent Electron SQL reader excludes a pending Main write and observes its committed value', () => fixture(async (store, root) => {
  const database = store.createDatabase({ name: 'Pending source' })
  const view = store.createDatabaseSavedView({ databaseId: database.id, name: 'Before commit' })
  const sql = store.getUnsafeDatabaseHandle(), before = await readDatabaseSnapshot(root)
  sql.exec('BEGIN IMMEDIATE')
  try {
    sql.prepare('UPDATE database_saved_views SET name = ? WHERE id = ?').run('After commit', view.id)
    assert.deepEqual(await readDatabaseSnapshot(root), before)
    sql.exec('COMMIT')
  } finally { if (sql.inTransaction) sql.exec('ROLLBACK') }
  const after = await readDatabaseSnapshot(root)
  assert.equal(after.tables.database_saved_views.find(row => row.id === view.id)?.name, 'After commit')
  assert.deepEqual(after.schema, before.schema)
  assert.deepEqual(after.tables.documents, before.tables.documents)
}))

test('independent Electron SQL reader rejects a missing database without creating one', () => fixture(async (_store, root) => {
  const missingRoot = join(root, 'missing-user-data')
  mkdirSync(missingRoot)
  await assert.rejects(readDatabaseSnapshot(missingRoot), /Cannot open database|does not exist|unable to open/i)
  assert.equal(existsSync(join(missingRoot, 'storage')), false)
}))
