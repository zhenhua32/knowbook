import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import type { ExportStandaloneDatabaseEntity } from '../src/main/database/store'
import type { DatabaseSavedView } from '../src/shared/contracts'
import { withV3Fixture, sha256, randomUUID, fileInventory, allTables } from './helpers/synced-backup-v3-fixture'

/** Mutate only one actual producer header; never synthesize a success archive/receipt. */
function changeHeader(file: string, key: string, change: (json: string) => string): void {
  const source = readFileSync(file, 'utf8'), expression = new RegExp('^' + key + ': ([^\\r\\n]+)$', 'm')
  let hits = 0
  const next = source.replace(expression, (_line, raw: string) => {
    const value: unknown = JSON.parse(raw)
    assert.equal(typeof value, 'string', 'The real generated header is a JSON string scalar')
    hits++
    return key + ': ' + JSON.stringify(change(value as string))
  })
  assert.equal(hits, 1, 'Only one actual own catalog header is mutated')
  writeFileSync(file, next)
}

test('V3 actual SQLite catalog exports distinct non-ASCII NOCASE names and different-byte-length NUL names without Unicode folding', () => withV3Fixture(f => {
  const names = ['É', 'é', 'a\0x', 'A\0é']
  const created = names.map(name => f.store.createDatabaseSavedView({ databaseId: f.customId, name }))
  const raw = f.db.prepare('SELECT id,name FROM database_saved_views WHERE database_id=?').all(f.customId) as Array<{ id: string; name: string }>
  for (let index = 0; index < names.length; index++) assert.equal(raw.find(row => row.id === created[index].id)?.name, names[index],
    'The original SQLite UNIQUE constraint admitted the exact authored name bytes')
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination), custom = archive.standaloneDatabases.find(source => source.id === f.customId)
  assert.ok(custom, 'The actual custom catalog definition is read back from the complete real archive')
  for (let index = 0; index < names.length; index++) assert.equal(custom.savedViews.find(view => view.id === created[index].id)?.name, names[index],
    'V3 preserves the exact legal non-ASCII/NUL name rather than folding or trimming it')
}))

test('V3 strict directory reader rejects two distinct catalog entities bound to the same database and document', () => withV3Fixture(f => {
  const first = f.store.createDatabaseEntity({ databaseId: f.customId, documentId: f.hostId, title: 'First actual linked entity' })
  const second = f.store.createDatabaseEntity({ databaseId: f.customId, documentId: f.targetId, title: 'Second actual linked entity' })
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const original = readBackupV3Archive(f.destination), custom = original.standaloneDatabases.find(source => source.id === f.customId)
  assert.ok(custom, 'Both source entities come from the actual Store producer and a successful strict read')
  const before = allTables(f.db), file = join(f.destination, '__knowbook', 'databases', 'database-' + sha256(f.customId) + '.md')
  changeHeader(file, 'databaseEntities', value => {
    const entities = JSON.parse(value) as ExportStandaloneDatabaseEntity[]
    const left = entities.find(entity => entity.id === first.id), right = entities.find(entity => entity.id === second.id)
    assert.ok(left && right && left.documentId !== null && left.documentPath !== null, 'The real producer contains two independently linked entities')
    right.documentId = left.documentId; right.documentPath = left.documentPath
    return JSON.stringify(entities)
  })
  const bytes = fileInventory(f.destination)
  assert.throws(() => readBackupV3Archive(f.destination), /entity|document|catalog|constraint|duplicate/i,
    'Distinct entity IDs do not bypass the real non-NULL (database_id,document_id) uniqueness semantics')
  assert.deepEqual(allTables(f.db), before, 'A bad archive cannot mutate the source SQL database')
  assert.deepEqual(fileInventory(f.destination), bytes, 'Strict rejection does not repair or rewrite any archive file')
}))

test('V3 strict directory reader rejects equal-byte-length NUL NOCASE names just as the actual SQLite source does', () => withV3Fixture(f => {
  const first = f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'a\0x' })
  const second = f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'Different legal view' })
  assert.throws(() => f.store.createDatabaseSavedView({ databaseId: f.customId, name: 'A\0y' }), /name|view|taken|exists/i,
    'The original source path independently refuses the same SQLite NOCASE key')
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  readBackupV3Archive(f.destination)
  const before = allTables(f.db), file = join(f.destination, '__knowbook', 'databases', 'database-' + sha256(f.customId) + '.md')
  changeHeader(file, 'databaseSavedViews', value => {
    const views = JSON.parse(value) as DatabaseSavedView[]
    const left = views.find(view => view.id === first.id), right = views.find(view => view.id === second.id)
    assert.ok(left && right, 'Only actual producer view rows are changed in the negative archive')
    assert.equal(left.name, 'a\0x')
    right.name = 'A\0y'
    return JSON.stringify(views)
  })
  const bytes = fileInventory(f.destination)
  assert.throws(() => readBackupV3Archive(f.destination), /view|name|unique|duplicate|NOCASE/i,
    'ASCII case folds up to NUL and equal UTF-8 byte length form the same source UNIQUE key')
  assert.deepEqual(allTables(f.db), before)
  assert.deepEqual(fileInventory(f.destination), bytes)
}))

// Appended import keeps the three frozen v1 consumers byte-identical above.
import { existsSync } from 'node:fs'

test('V3 actual source preserves an opaque entity identity and its value through complete Main write and strict read', () => withV3Fixture(f => {
  const entityId = ' entity:真实 raw\0 ', title = 'Opaque source entity', value = 'raw entity value \0 中文', now = new Date().toISOString()
  // Legal source catalog seed only. The group, exposure claim and archive are all produced by their real writers.
  f.db.prepare('INSERT INTO database_entities(id,database_id,title,document_id,created_at,updated_at) VALUES(?,?,?,NULL,?,?)')
    .run(entityId, f.customId, title, now, now)
  f.db.prepare('INSERT INTO database_entity_values(entity_id,column_id,value_text,updated_at) VALUES(?,?,?,?)')
    .run(entityId, f.customColumn.id, value, now)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [], 'The exact opaque source identity is accepted by the original real schema')
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination), custom = archive.standaloneDatabases.find(source => source.id === f.customId)
  assert.ok(custom, 'The complete actual source database is present')
  const entity = custom.entities.find(row => row.id === entityId)
  assert.ok(entity, 'The leading/trailing spaces, colon, Unicode and NUL identity survives without a typed-reference regex gate')
  assert.equal(entity.id, entityId)
  assert.equal(entity.title, title)
  assert.equal(entity.createdAt, now)
  assert.equal(entity.updatedAt, now)
  assert.equal(entity.fieldValues[f.customColumn.id], value)
}))

test('V3 strict reader rejects a BOM added to the actual canonical group bytes while the original index remains unchanged', () => withV3Fixture(f => {
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  readBackupV3Archive(f.destination)
  const group = join(f.destination, '__knowbook', 'synced', 'group-' + sha256(f.groupId) + '.json')
  const index = join(f.destination, '__knowbook', 'databases', 'index.md'), indexBefore = readFileSync(index), before = allTables(f.db)
  const canonical = readFileSync(group)
  writeFileSync(group, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]))
  const mutated = fileInventory(f.destination)
  assert.throws(() => readBackupV3Archive(f.destination), /BOM|canonical|hash|UTF|JSON|group/i,
    'TextDecoder BOM handling cannot make unindexed raw bytes authenticate as the original canonical file')
  assert.deepEqual(readFileSync(index), indexBefore, 'The negative fixture does not bless the added bytes with a replacement index')
  assert.deepEqual(allTables(f.db), before)
  assert.deepEqual(fileInventory(f.destination), mutated)
}))

test('V3 real source file-directory case collision is rejected by full preflight before any possible exposure or destination', () => withV3Fixture(f => {
  const save = (id: string, title: string): void => { f.store.updateDocument(id, { title, summary: 'Actual legal source hierarchy', blocks: [
    { id: randomUUID(), type: 'paragraph', content: 'Real ordinary source body', checked: false, depth: 0, parentBlockId: null }
  ] }) }
  const fileOwner = f.store.createDocument(null); save(fileOwner, 'Foo')
  const directoryOwner = f.store.createDocument(null); save(directoryOwner, 'foo.md')
  const child = f.store.createDocument(directoryOwner); save(child, 'Child')
  const paths = f.db.prepare('SELECT id,path FROM documents WHERE id IN (?,?,?) ORDER BY path').all(fileOwner, directoryOwner, child) as Array<{ id: string; path: string }>
  assert.deepEqual(paths.map(row => row.path), ['Foo', 'foo.md', 'foo.md/Child'], 'The source has three real legal materialized paths')
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [], 'The Main source is valid before its archive path projection')
  const before = f.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all(), snapshotId = randomUUID()
  assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId }),
    'Foo.md file versus foo.md/Child.md directory is rejected consistently before cross-platform output')
  assert.equal(existsSync(f.destination), false, 'A rejected full file-set candidate never creates the external destination')
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all(), before,
    'Preflight rejection does not falsely publish any actual group member')
  assert.equal(f.db.prepare('SELECT value FROM app_settings WHERE key=?').get('synced.backup.v3.' + snapshotId), undefined)
}))
