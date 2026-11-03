import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { readRawCapsule2ObserverOwned } from '../src/main/database/restore-knowledge-capsule2-observer-read'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { SYNCED_METADATA_BASELINE2_PREFIX, SYNCED_METADATA_CAPTURE2_PIN } from '../src/main/database/synced-metadata-capture-record2'
import { withV3Fixture, allTables, randomUUID } from './helpers/synced-backup-v3-fixture'

const totalChanges = (db: Database.Database) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
function observePrepare<T>(db: Database.Database, run: () => T) {
  const descriptor = Object.getOwnPropertyDescriptor(db, 'prepare'), prepare = db.prepare, sql: string[] = []
  Object.defineProperty(db, 'prepare', { configurable: true, writable: true,
    value: function (this: Database.Database, query: string, ...rest: unknown[]) {
      sql.push(query.replace(/\s+/g, ' ').trim())
      return Reflect.apply(prepare, this, [query, ...rest])
    } })
  try { return { value: run(), sql } }
  finally {
    if (descriptor) Object.defineProperty(db, 'prepare', descriptor)
    else delete (db as unknown as Record<string, unknown>).prepare
  }
}

test('capsule historical same-read reaches the metadata2 family after its real readonly observer accepts an unknown-version point or reverse orphan pin and rejects both without writes', () => withV3Fixture(f => {
  // Only the actual Main/session producer creates the positive source point.
  const store = KnowbookStore.openCanonicalRuntime(f.file), sender = Object.freeze({ frame: 'capsule family original' })
  try {
    const opened = store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw new Error('The original instance must open')
    assert.equal(store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'captureBaseline', input: { groupId: f.groupId } }).status, 'ready')
  } finally { store.destroy() }
  const point = f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE substr(client_operation_id,1,?)=? ORDER BY client_operation_id LIMIT 1')
    .get(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX) as { client_operation_id: string; request_hash: string; result_json: string; created_at: string } | undefined
  assert.ok(point, 'The malformed version fixture starts from a complete actual Main-produced payload')
  const badKey = SYNCED_METADATA_BASELINE2_PREFIX + 'v99:' + randomUUID(), orphanKey = SYNCED_METADATA_BASELINE2_PREFIX + 'a'.repeat(64)
  assert.equal(f.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(orphanKey), undefined)
  const cases = [
    { name: 'unknown dot-prefix version', error: /Metadata2 captured original invalid: actual record row\/bytes\/hash differ/,
      corrupt: () => { f.db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
        .run(badKey, point.request_hash, point.result_json, point.created_at) },
      restore: () => { f.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(badKey) } },
    { name: 'reverse orphan pin', error: /Metadata2 captured original invalid: unknown\/orphan reserved capture pin/,
      corrupt: () => { f.db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)')
        .run(f.groupId, SYNCED_METADATA_CAPTURE2_PIN, orphanKey, point.created_at) },
      restore: () => { f.db.prepare('DELETE FROM synced_group_pins WHERE group_id=? AND kind=? AND pin_id=?')
        .run(f.groupId, SYNCED_METADATA_CAPTURE2_PIN, orphanKey) } }
  ]
  for (const scenario of cases) {
    scenario.corrupt()
    let readonly: Database.Database | undefined
    try {
      const before = allTables(f.db), writerChanges = totalChanges(f.db)
      readonly = new Database(f.file, { readonly: true, fileMustExist: true })
      readonly.pragma('foreign_keys=ON'); readonly.pragma('query_only=ON')
      const reader = readonly, readerChanges = totalChanges(reader)
      // This is the damaged fixture, not a clean precondition taken beforehand.
      // A generic schema/physical/observer rejection cannot satisfy this test.
      const observation = reader.transaction(() => readRawCapsule2ObserverOwned(reader))()
      assert.equal(observation.certified, false); assert.equal(observation.permit, false)
      assert.equal(totalChanges(reader), readerChanges); assert.equal(totalChanges(f.db), writerChanges)
      assert.deepEqual(allTables(f.db), before)
      const actual = observePrepare(reader, () => {
        assert.throws(() => reader.transaction(() => readRawCapsule2HistoricalEvidenceOwned(reader))(), scenario.error, scenario.name)
      })
      assert.equal(actual.sql.filter(sql => sql.includes('AS __metadata2_reserved FROM synced_operations')).length, 1,
        'The actual historical call must reach the candidate fixed same-read factory before its precise family rejection')
      assert.equal(actual.sql.some(sql => /\bFROM synced_operations WHERE lower\(client_operation_id\) LIKE/.test(sql)), false)
      assert.equal(totalChanges(reader), readerChanges); assert.equal(totalChanges(f.db), writerChanges)
      assert.deepEqual(allTables(f.db), before, 'No schema/business/sourcepoint/pin row is changed by either actual readonly reader')
    } finally { readonly?.close(); scenario.restore() }
  }
}))
