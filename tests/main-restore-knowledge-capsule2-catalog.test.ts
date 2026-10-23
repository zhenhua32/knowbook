import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import test from 'node:test'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2PhysicalGraphOwned } from '../src/main/database/restore-knowledge-capsule2-physical-raw-read'
import { validateRecord } from '../src/main/sync/model'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { decodedCapsule2Table, withCapsule2RawCopy, writeMixedOrdinary501 } from './helpers/capsule2-raw-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

async function unchanged(f: V3Fixture, inspect: (db: Database.Database) => void) {
  const group = snapshot(f.db, f.groupId)
  const ack = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const before = readRawCapsule2ContentOwned(db)
    inspect(db)
    assert.deepEqual(readRawCapsule2ContentOwned(db), before)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual(snapshot(f.db, f.groupId), group)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId), ack)
}

test('capsule2 catalog preserves real ordinary-sync NULL-key occurrences, noncanonical JSON and opaque stored values alongside ordinary501 and a Main group', () => withV3Fixture(async f => {
  const record = f.store.getSyncRecords().get('databases')
  assert.ok(record && record.kind === 'databases')
  record.tables.document_database_columns.find(row => row.id === f.catalogColumn.id)!.options_json = ' [ "duplicate", "duplicate" ] '
  record.tables.database_saved_views.find(row => row.id === f.view.id)!.config_json = '{"opaque":"first","opaque":"literal catalog and knowbook-asset:// source text"}'
  record.tables.document_database_values.push(
    { document_id: null, column_id: f.catalogColumn.id, value_text: 'first exact occurrence', entity_id: null },
    { document_id: null, column_id: f.catalogColumn.id, value_text: null, entity_id: null },
    { document_id: null, column_id: f.customColumn.id, value_text: 'legacy entity storage', entity_id: f.entity.id }
  )
  validateRecord(record, 'databases')
  f.store.applySyncRecords([record])
  writeMixedOrdinary501(f)
  await unchanged(f, db => {
    const physical = readRawCapsule2PhysicalGraphOwned(db), raw = readRawCapsule2ContentOwned(db)
    assert.equal(physical.certified, false); assert.equal(physical.semanticValidationComplete, false)
    const values = decodedCapsule2Table(raw, 'document_database_values')
    assert.equal(values.filter(row => row.document_id === null && row.column_id === f.catalogColumn.id).length, 2)
    assert.ok(values.some(row => row.entity_id === f.entity.id && row.value_text === 'legacy entity storage'))
    assert.equal(decodedCapsule2Table(raw, 'document_database_columns').find(row => row.id === f.catalogColumn.id)?.options_json, ' [ "duplicate", "duplicate" ] ')
    assert.equal(decodedCapsule2Table(raw, 'database_saved_views').find(row => row.id === f.view.id)?.config_json, '{"opaque":"first","opaque":"literal catalog and knowbook-asset:// source text"}')
  })
}))

test('capsule2 catalog accepts actual SQLite opaque identities and a custom catalog spelling without mapping the real default source', () => withV3Fixture(async f => {
  const databaseId = 'catalog', entityId = ' entity:原值\0 ', now = new Date().toISOString()
  // Legal original SQL seeds, not a publication DTO or a forged group/ACK.
  f.db.prepare('INSERT INTO databases(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)').run(databaseId, 'Original custom catalog', '', now, now)
  f.db.prepare('INSERT INTO database_entities(id,database_id,title,document_id,created_at,updated_at) VALUES(?,?,?,NULL,?,?)')
    .run(entityId, f.customId, 'Opaque source entity', now, now)
  f.db.prepare('INSERT INTO database_entity_values(entity_id,column_id,value_text,updated_at) VALUES(?,?,?,?)')
    .run(entityId, f.customColumn.id, 'Source bytes \0 中文', now)
  await unchanged(f, db => {
    readRawCapsule2PhysicalGraphOwned(db)
    assert.equal((db.prepare("SELECT value FROM app_settings WHERE key='database.defaultId'").get() as { value: string }).value, f.catalogId)
    const raw = readRawCapsule2ContentOwned(db)
    assert.ok(decodedCapsule2Table(raw, 'databases').some(row => row.id === databaseId))
    assert.ok(decodedCapsule2Table(raw, 'database_entities').some(row => row.id === entityId))
    assert.ok(decodedCapsule2Table(raw, 'database_entity_values').some(row => row.entity_id === entityId && row.value_text === 'Source bytes \0 中文'))
  })
}))

test('capsule2 catalog preserves real Store view orders outside the wire safe-integer range and SQLite NUL NOCASE-distinct names', () => withV3Fixture(async f => {
  const first = f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'a\0x', sortOrder: 1e20 })
  const second = f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'A\0long', sortOrder: Number.MAX_SAFE_INTEGER + 1 })
  await unchanged(f, db => {
    readRawCapsule2PhysicalGraphOwned(db)
    const rows = decodedCapsule2Table(readRawCapsule2ContentOwned(db), 'database_saved_views')
    assert.equal(rows.find(row => row.id === first.id)?.sort_order, 1e20)
    assert.equal(rows.find(row => row.id === second.id)?.sort_order, BigInt(Number.MAX_SAFE_INTEGER + 1))
    assert.deepEqual([first, second].map(view => rows.find(row => row.id === view.id)?.name), ['a\0x', 'A\0long'])
  })
}))

function atom(f: V3Fixture, place: 'host' | 'canonical', databaseId: string, viewId: string) {
  const content = serializeDatabaseViewPayload({ version: 1, databaseId, viewId, config: createDefaultDatabaseViewConfig() })
  if (place === 'host') f.store.updateDocument(f.targetId, { title: 'Source atom host', summary: '', blocks: [
    { id: f.targetBodyId, type: 'database-view', content, checked: false, depth: 0, parentBlockId: null }
  ] })
  else {
    const group = snapshot(f.db, f.groupId)
    editCreatedGroup(f.db, f.groupId, group.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, type: 'database-view', content })))
  }
}

test('capsule2 catalog retains genuinely missing authored database/view targets in both ordinary and canonical physical atoms', () => withV3Fixture(async f => {
  for (const place of ['host', 'canonical'] as const) atom(f, place, randomUUID(), randomUUID())
  await unchanged(f, db => {
    const physical = readRawCapsule2PhysicalGraphOwned(db)
    assert.equal(physical.documents.find(row => row.documentId === f.targetId)?.blocks[0].type, 'database-view')
    assert.equal(physical.groups.find(row => row.groupId === f.groupId)?.snapshot?.blocks[0].type, 'database-view')
  })
}))

for (const place of ['host', 'canonical'] as const) {
  test(`capsule2 catalog rejects a ${place} physical atom whose existing saved view has another actual database owner`, () => withV3Fixture(async f => {
    atom(f, place, f.customId, f.view.id)
    f.db.prepare('UPDATE database_saved_views SET database_id=? WHERE id=?').run(f.catalogId, f.view.id)
    await unchanged(f, db => assert.throws(() => readRawCapsule2PhysicalGraphOwned(db), /catalog.*视图.*来源/))
  }))
}

for (const storage of ['entity', 'legacy-document'] as const) {
  test(`capsule2 catalog rejects ${storage} values crossing the actual column and entity database owners`, () => withV3Fixture(async f => {
    if (storage === 'entity') f.db.prepare('UPDATE database_entity_values SET column_id=? WHERE entity_id=?').run(f.catalogColumn.id, f.entity.id)
    else f.db.prepare('INSERT INTO document_database_values(document_id,column_id,value_text,updated_at,entity_id) VALUES(NULL,?,?,?,?)')
      .run(f.catalogColumn.id, 'wrong owner', new Date().toISOString(), f.entity.id)
    assert.deepEqual(f.db.pragma('foreign_key_check'), [])
    await unchanged(f, db => assert.throws(() => readRawCapsule2PhysicalGraphOwned(db), /catalog.*实体值.*来源/))
  }))
}

test('capsule2 catalog rejects duplicate SQLite NOCASE view names after an original uniqueness index is missing', () => withV3Fixture(async f => {
  f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'a\0x' })
  const other = f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'Different original name' })
  f.db.exec('DROP INDEX idx_database_saved_views_database_name')
  f.db.prepare('UPDATE database_saved_views SET name=? WHERE id=?').run('A\0y', other.id)
  await unchanged(f, db => assert.throws(() => readRawCapsule2PhysicalGraphOwned(db), /catalog.*视图.*重复/))
}))

const invalidRows: Array<[string, (f: V3Fixture) => void]> = [
  ['missing default', f => { f.db.prepare("DELETE FROM app_settings WHERE key='database.defaultId'").run() }],
  ['wrong default', f => { f.db.prepare("UPDATE app_settings SET value='absent-source' WHERE key='database.defaultId'").run() }],
  ['unknown field type', f => { f.db.prepare("UPDATE document_database_columns SET type='unknown' WHERE id=?").run(f.customColumn.id) }],
  ['nonarray options', f => { f.db.prepare("UPDATE document_database_columns SET options_json='{}' WHERE id=?").run(f.customColumn.id) }],
  ['nonstring option', f => { f.db.prepare("UPDATE document_database_columns SET options_json='[42]' WHERE id=?").run(f.customColumn.id) }],
  ['invalid options JSON', f => { f.db.prepare("UPDATE document_database_columns SET options_json='[' WHERE id=?").run(f.customColumn.id) }],
  ['unknown view version', f => { f.db.prepare('UPDATE database_saved_views SET config_version=2 WHERE id=?').run(f.view.id) }],
  ['nonobject view config', f => { f.db.prepare("UPDATE database_saved_views SET config_json='[]' WHERE id=?").run(f.view.id) }],
  ['invalid view JSON', f => { f.db.prepare("UPDATE database_saved_views SET config_json='{' WHERE id=?").run(f.view.id) }],
  ['fractional view order', f => { f.db.prepare('UPDATE database_saved_views SET sort_order=1.5 WHERE id=?').run(f.view.id) }],
  ['blob value', f => { f.db.prepare('UPDATE database_entity_values SET value_text=? WHERE entity_id=?').run(Buffer.from('not TEXT'), f.entity.id) }],
  ['invalid update time', f => { f.db.prepare("UPDATE database_entities SET updated_at='not a date' WHERE id=?").run(f.entity.id) }]
]
for (const [label, corrupt] of invalidRows) {
  test(`capsule2 catalog refuses ${label} without repairing original source rows`, () => withV3Fixture(async f => {
    corrupt(f)
    await unchanged(f, db => assert.throws(() => readRawCapsule2PhysicalGraphOwned(db), /catalog/))
  }))
}
