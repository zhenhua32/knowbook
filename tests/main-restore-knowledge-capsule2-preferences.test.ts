import assert from 'node:assert/strict'
import test from 'node:test'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { readRawCapsule2AssetReferencesOwned } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { assertRawCapsule2PreferencesOwned } from '../src/main/database/restore-knowledge-capsule2-preferences-read'

function seed(f: V3Fixture) {
  f.store.saveSetting(' custom:\0 preference ', '{ opaque original TEXT')
  f.store.saveSetting('', 'Actual empty key')
  f.store.recordWorkspaceEvent({ type: 'document.updated', title: '', description: '', createdAt: 'legacy literal time', details: { schemaVersion: 1, documentTitle: 'Retained event' } })
}
async function observe(f: V3Fixture, rejected = false) {
  const original = { settings: f.db.prepare('SELECT * FROM app_settings ORDER BY key').all(), activity: f.db.prepare('SELECT * FROM workspace_events ORDER BY id').all() }
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const before = readRawCapsule2ContentOwned(db)
    if (rejected) assert.throws(() => readRawCapsule2WorkspaceHistoryOwned(db), /preference|activity|设置|事件|原字段|TEXT|身份/)
    else {
      const value = readRawCapsule2WorkspaceHistoryOwned(db)
      assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
    }
    assert.deepEqual(readRawCapsule2ContentOwned(db), before)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
  assert.deepEqual({ settings: f.db.prepare('SELECT * FROM app_settings ORDER BY key').all(), activity: f.db.prepare('SELECT * FROM workspace_events ORDER BY id').all() }, original)
}

test('capsule2 preferences preserve actual Store empty and literal keys, opaque values, empty activity text and supplied literal times', () => withV3Fixture(async f => {
  seed(f)
  assert.equal(f.store.getSettingPublic(''), 'Actual empty key')
  assert.equal(f.store.getSettingPublic(' custom:\0 preference '), '{ opaque original TEXT')
  const event = f.store.getHomeData(f.root).recentEvents.find(row => row.createdAt === 'legacy literal time')
  assert.ok(event); assert.equal(event.title, ''); assert.equal(event.description, '')
  await observe(f)
}))

test('capsule2 activity preserves legacy malformed and future details TEXT accepted by the actual recent-activity reader', () => withV3Fixture(async f => {
  seed(f)
  for (const raw of ['{', '{"schemaVersion":999,"future":{"literal":"file:///opaque/activity"}}']) {
    f.db.prepare('UPDATE workspace_events SET details_json=?').run(raw)
    assert.ok(f.store.getHomeData(f.root).recentEvents.length)
    await observe(f)
  }
}))

test('capsule2 preferences and activity never turn their opaque JSON text or display strings into Markdown asset holders', () => withV3Fixture(async f => {
  seed(f)
  const uri = 'file:///never/opaque-preference.png', raw = `![opaque](<${uri}>)`
  f.store.saveSetting('custom.asset-looking-text', raw)
  f.store.recordWorkspaceEvent({ type: 'document.updated', title: raw, description: raw, createdAt: 'literal opaque activity time' })
  f.db.prepare('UPDATE workspace_events SET details_json=?').run(JSON.stringify({ schemaVersion: 1, path: raw }))
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const value = readRawCapsule2AssetReferencesOwned(db)
    assert.equal(value.scopes.some(scope => scope.destinations.some(item => item.uri === uri)), false)
  })())
}))

const faults: Array<[string, (f: V3Fixture) => void]> = [
  ['non-TEXT setting key', f => { f.db.prepare("UPDATE app_settings SET key=CAST(key AS BLOB) WHERE key=''").run() }],
  ['non-TEXT setting value', f => { f.db.prepare("UPDATE app_settings SET value=CAST(value AS BLOB) WHERE key=''").run() }],
  ['non-TEXT setting update time', f => { f.db.prepare("UPDATE app_settings SET updated_at=CAST(updated_at AS BLOB) WHERE key=''").run() }],
  ['NULL setting primary identity', f => { f.db.prepare("UPDATE app_settings SET key=NULL WHERE key=''").run() }],
  ['NULL activity primary identity', f => { f.db.prepare("UPDATE workspace_events SET id=NULL WHERE created_at='legacy literal time'").run() }],
  ['non-TEXT activity type', f => { f.db.prepare("UPDATE workspace_events SET type=CAST(type AS BLOB)").run() }],
  ['non-TEXT activity title', f => { f.db.prepare("UPDATE workspace_events SET title=CAST(title AS BLOB)").run() }],
  ['non-TEXT activity description', f => { f.db.prepare("UPDATE workspace_events SET description=CAST(description AS BLOB)").run() }],
  ['non-TEXT activity creation time', f => { f.db.prepare("UPDATE workspace_events SET created_at=CAST(created_at AS BLOB)").run() }],
  ['non-TEXT activity details', f => { f.db.prepare("UPDATE workspace_events SET details_json=CAST('{}' AS BLOB)").run() }]
]
for (const [name, mutate] of faults) test('capsule2 preferences/activity refuse ' + name + ' without repairing source', () => withV3Fixture(async f => {
  seed(f); mutate(f); await observe(f, true)
}))

test('capsule2 activity visits every retained historical row beyond the Store40/recent8 view instead of pruning or sampling', () => withV3Fixture(async f => {
  seed(f)
  f.db.exec(`WITH RECURSIVE retained(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM retained WHERE n<1001)
    INSERT INTO workspace_events(id,type,title,description,document_id,created_at,details_json)
    SELECT 'retained-policy-'||n,'legacy.custom.event','','',NULL,'retained literal time','{' FROM retained`)
  assert.equal(f.store.getHomeData(f.root).recentEvents.length, 8)
  await observe(f)
  f.db.prepare("UPDATE workspace_events SET description=CAST(description AS BLOB) WHERE id='retained-policy-1001'").run()
  await observe(f, true)
}))

test('capsule2 activity keeps historical details when real document deletion clears only the live document FK', () => withV3Fixture(async f => {
  const documentId = f.store.createDocument(null)
  f.store.recordWorkspaceEvent({ type: 'document.updated', title: 'Actual retained pointer', description: '', documentId,
    createdAt: 'retained before actual deletion', details: { schemaVersion: 1, documentTitle: 'Original historical document', path: 'literal old path' } })
  f.store.deleteDocument(documentId)
  const row = f.db.prepare("SELECT document_id,details_json FROM workspace_events WHERE created_at='retained before actual deletion'").get() as { document_id: string | null; details_json: string }
  assert.equal(row.document_id, null); assert.equal(JSON.parse(row.details_json).path, 'literal old path')
  await observe(f)
}))

test('capsule2 opaque ordinary preferences cannot downgrade an unknown reserved sync metadata family to ordinary data', () => withV3Fixture(async f => {
  f.store.saveSetting('sync.webdav.protocol5.future-family.v1.untrusted', '{}')
  await withCapsule2RawCopy(f, db => assert.throws(() => db.transaction(() => readRawCapsule2WorkspaceHistoryOwned(db))(), /未知|metadata|family|元数据/))
}))

test('capsule2 preferences/activity require the actual readonly query-only FK transaction even for opaque data', () => withV3Fixture(async f => {
  seed(f)
  assert.throws(() => f.db.transaction(() => assertRawCapsule2PreferencesOwned(f.db))(), /readonly/)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => assertRawCapsule2PreferencesOwned(db), /来源事务/)
    db.pragma('query_only=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2PreferencesOwned(db))(), /query-only/)
    db.pragma('query_only=ON'); db.pragma('foreign_keys=OFF')
    assert.throws(() => db.transaction(() => assertRawCapsule2PreferencesOwned(db))(), /FKON/)
    db.pragma('foreign_keys=ON')
    db.transaction(() => assertRawCapsule2PreferencesOwned(db))()
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })
}))
