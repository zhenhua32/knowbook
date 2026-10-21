import assert from 'node:assert/strict'
import test from 'node:test'
import { readRawPriorKnowledgeCoverageOwned } from '../src/main/database/restore-knowledge-coverage-raw-read'
import { coverageOperationId, coverageReceiptKey, coverageSettingKey, serializeSyncedKnowledgeCoverage,
  syncedKnowledgeCoverageHash } from '../src/main/database/restore-knowledge-coverage-model'
import { readHistoricalRowLocator } from '../src/main/database/synced-history-evidence-support'
import { withPayloadStore } from './helpers/restore-knowledge-payload-fixture'
import { withDatabase } from './helpers/synced-content-fixture'
import { structureFixture } from './helpers/coverage-structure-fixture'
import { insertCoverageSyntax, readCoverage, sqlDefinitions } from './helpers/coverage-raw-sql-fixture'

test('coverage raw SQL requires its actual owned transaction and reads empty requirements without writes or accepted authority', () => withPayloadStore(async f => {
  assert.throws(() => readRawPriorKnowledgeCoverageOwned(f.db), /事务/)
  const definitions = sqlDefinitions(f.db), before = f.db.prepare('SELECT total_changes() AS count').get()
  f.db.pragma('query_only=ON')
  const actual = readCoverage(f.db)
  f.db.pragma('query_only=OFF')
  assert.deepEqual(actual, { kind: 'restore-knowledge-unresolved-required-roots', version: 1, schemaVersion: 27, entries: [] })
  assert.ok(Object.isFrozen(actual) && Object.isFrozen(actual.entries))
  assert.equal(Reflect.set(actual, 'accepted', true), false)
  assert.deepEqual(sqlDefinitions(f.db), definitions)
  assert.deepEqual(f.db.prepare('SELECT total_changes() AS count').get(), before)
}))

test('coverage raw SQL binds complete untrusted new syntax rows to frozen unresolved roots and full original row hashes', () => withPayloadStore(async f => {
  const { fixture } = insertCoverageSyntax(f.db), before = f.db.prepare('SELECT total_changes() AS count').get()
  const actual = readCoverage(f.db), entry = actual.entries[0]
  assert.equal(actual.entries.length, 1)
  assert.equal(entry.coverageHash, syncedKnowledgeCoverageHash(fixture.coverage))
  assert.deepEqual(entry.root, fixture.coverage.root)
  assert.notDeepEqual(fixture.coverage.source.capsule, fixture.coverage.current.capsule)
  assert.equal(entry.supports.boundary, null, 'An ordinary declaration remains unresolved and does not manufacture B or an empty audit')
  f.db.transaction(() => {
    for (const support of [entry.supports.coverage, entry.supports.link, entry.supports.receipt, entry.supports.anchor])
      assert.deepEqual(support, readHistoricalRowLocator(f.db, support.table, support.key))
  })()
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.root.namespace) && Object.isFrozen(entry.supports.anchor.key))
  assert.equal(Reflect.set(entry.root, 'rootHash', '0'.repeat(64)), false)
  assert.deepEqual(readCoverage(f.db), actual)
  assert.deepEqual(f.db.prepare('SELECT total_changes() AS count').get(), before)
  f.db.prepare('UPDATE app_settings SET updated_at=? WHERE key=?').run('2042-03-04T05:06:07.009Z', coverageSettingKey(fixture.coverage.operationId))
  assert.throws(() => readCoverage(f.db), /时点|闭合/)
}))

test('coverage raw SQL refuses every reverse orphan among the four new families', async () => {
  for (const omit of ['coverage', 'link', 'receipt', 'anchor'] as const) await withPayloadStore(async f => {
    insertCoverageSyntax(f.db, structureFixture(), { omit })
    assert.throws(() => readCoverage(f.db), /反向闭集|孤/)
  })
})

test('coverage raw SQL scans complete receipt and marker namespaces and refuses unknown versions or wrong operation hash', async () => {
  const rows = [
    { table: 'app_settings', key: 'synced.restore.coverage.v9.unknown' },
    { table: 'app_settings', key: 'database.restore.receipt.v3.unknown' },
    { table: 'synced_operations', key: 'synced:restore-knowledge-coverage:v9:unknown' }
  ] as const
  for (const row of rows) await withPayloadStore(async f => {
    if (row.table === 'app_settings') f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(row.key, '{}', '2042-03-04T05:06:07.008Z')
    else f.db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
      .run(row.key, '1'.repeat(64), '{}', '2042-03-04T05:06:07.008Z')
    assert.throws(() => readCoverage(f.db), /未知/)
  })
  await withPayloadStore(async f => {
    const { fixture } = insertCoverageSyntax(f.db)
    f.db.prepare('UPDATE synced_operations SET request_hash=? WHERE client_operation_id=?').run('0'.repeat(64), coverageOperationId(fixture.coverage.operationId))
    assert.throws(() => readCoverage(f.db), /hash|闭合/)
  })
})

test('coverage raw SQL catches a BLOB reserved key instead of skipping it as unrelated metadata', () => withPayloadStore(async f => {
  f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
    .run(Buffer.from('synced.restore.coverage.v9.typed-key'), '{}', '2042-03-04T05:06:07.008Z')
  assert.throws(() => readCoverage(f.db), /storage|TEXT/)
}))

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const)
  test('coverage raw SQL reads actual ' + encoding + ' syntax and rejects malformed original TEXT bytes', () => withPayloadStore(async f => {
    const { fixture } = insertCoverageSyntax(f.db)
    assert.equal(readCoverage(f.db).entries.length, 1)
    const invalid = encoding === 'UTF-8' ? '80' : encoding === 'UTF-16le' ? '00D8' : 'D800'
    // A bound BLOB is cast through UTF-8 by SQLite before storage in UTF-16.
    // Keep the malformed database-encoding bytes with the original literal path.
    const key = coverageReceiptKey(fixture.coverage.operationId)
    f.db.prepare("UPDATE app_settings SET value=CAST(X'" + invalid + "' AS TEXT) WHERE key=?").run(key)
    const raw = () => f.db.prepare('SELECT typeof(value) AS storage,hex(CAST(value AS BLOB)) AS bytes FROM app_settings WHERE key=?').get(key)
    assert.deepEqual(raw(), { storage: 'text', bytes: invalid.toUpperCase() })
    assert.throws(() => readCoverage(f.db), /编码|TEXT|回编码/)
    assert.deepEqual(raw(), { storage: 'text', bytes: invalid.toUpperCase() }, 'Refusal preserves the actual malformed SQL evidence')
  }, encoding))

test('coverage raw SQL keeps schema26 pins and groups without querying or installing schema27 tables', () => withDatabase(db => {
  db.pragma('user_version=26')
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='synced_group_pins'").get(), 'Pins already belong to original schema26')
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='synced_exposure_attempts'").get(), undefined)
  const definitions = sqlDefinitions(db)
  assert.deepEqual(readCoverage(db), { kind: 'restore-knowledge-unresolved-required-roots', version: 1, schemaVersion: 26, entries: [] })
  db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('database.restore.receipt.v2.unknown', '{}', '2042-03-04T05:06:07.008Z')
  assert.throws(() => readCoverage(db), /coverage|结构|版本|字段/)
  assert.deepEqual(sqlDefinitions(db), definitions)
}))

test('coverage raw SQL rejects canonical C bytes that no longer match linked original receipt and marker', () => withPayloadStore(async f => {
  const { fixture } = insertCoverageSyntax(f.db)
  const changed = { ...fixture.coverage, planHash: 'f'.repeat(64) }
  f.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(serializeSyncedKnowledgeCoverage(changed), coverageSettingKey(changed.operationId))
  assert.throws(() => readCoverage(f.db), /原像互证|闭合/)
}))
