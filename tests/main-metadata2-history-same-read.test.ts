import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { assertSyncedMetadataCaptureFamilyOwned2, readSyncedHistoricalOperationsWithMetadata2Owned2,
  SYNCED_METADATA_BASELINE2_PREFIX, SYNCED_METADATA_CAPTURE2_PIN } from '../src/main/database/synced-metadata-capture-record2'
import { readHistoricalOperations } from '../src/main/database/synced-history-evidence-support'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { withV3Fixture, allTables, randomUUID, type V3Fixture } from './helpers/synced-backup-v3-fixture'

type OperationRow = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
const valueHash = (value: unknown) => publicationHash(publicationJson(value))
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
const fullOperations = (sql: string[]) => sql.filter(query => /\bFROM synced_operations$/.test(query))
const filteredOperations = (sql: string[]) => sql.filter(query => /\bFROM synced_operations WHERE lower\(client_operation_id\) LIKE/.test(query))
const reversePins = (sql: string[]) => sql.filter(query => /\bFROM synced_group_pins WHERE lower\(kind\) LIKE/.test(query))
const sameReadOperations = (sql: string[]) => sql.filter(query => query.includes('AS __metadata2_reserved FROM synced_operations'))

function captureActualPoint(f: V3Fixture) {
  const store = KnowbookStore.openCanonicalRuntime(f.file), sender = Object.freeze({ frame: 'actual same-read metadata2 point' })
  try {
    const opened = store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw new Error('The real original instance must open')
    const captured = store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
    assert.equal(captured.status, 'ready')
  } finally { store.destroy() }
  const row = f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE substr(client_operation_id,1,?)=?')
    .get(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX) as OperationRow | undefined
  assert.ok(row, 'A real Main/session producer, rather than direct SQL, creates the positive point')
  return row
}

test('same-read metadata2 history factory preserves actual row values and hashes while removing the separate family operations scan in both history consumers', () => withV3Fixture(f => {
  const db = f.db
  for (const hasPoint of [false, true]) {
    if (hasPoint) captureActualPoint(f)
    const before = allTables(db), started = totalChanges(db)
    // This remains the actual old public sequence, not an invented rows oracle.
    const original = observePrepare(db, () => db.transaction(() => {
      assertSyncedMetadataCaptureFamilyOwned2(db)
      return readHistoricalOperations(db)
    })())
    const joint = observePrepare(db, () => db.transaction(() => readSyncedHistoricalOperationsWithMetadata2Owned2(db))())
    assert.deepEqual(joint.value, original.value)
    assert.equal(valueHash(joint.value), valueHash(original.value))
    for (const row of joint.value) assert.deepEqual(Object.keys(row).sort(), ['client_operation_id', 'created_at', 'request_hash', 'result_json'])
    assert.equal(fullOperations(original.sql).length, 1); assert.equal(filteredOperations(original.sql).length, 1)
    assert.equal(fullOperations(joint.sql).length, 1); assert.equal(filteredOperations(joint.sql).length, 0)
    assert.equal(sameReadOperations(joint.sql).length, 1)
    assert.equal(reversePins(original.sql).length, 1); assert.equal(reversePins(joint.sql).length, 1)
    if (hasPoint) {
      assert.ok(joint.sql.some(query => /\bFROM synced_operations WHERE client_operation_id=\?/.test(query)),
        'The independent actualRecord row readback remains, rather than trusting the selected row DTO')
      assert.ok(joint.sql.some(query => /\bFROM synced_group_pins WHERE kind=\? AND pin_id=\?/.test(query)),
        'The independent original record pin readback remains')
    }
    assert.equal(totalChanges(db), started); assert.deepEqual(allTables(db), before)
    const readonly = new Database(f.file, { readonly: true, fileMustExist: true })
    try {
      readonly.pragma('foreign_keys=ON'); readonly.pragma('query_only=ON')
      const historical = readonly.transaction(() => assertRawSyncedHistoricalEvidenceOwned(readonly))()
      const capsule = readonly.transaction(() => readRawCapsule2HistoricalEvidenceOwned(readonly))()
      const observedHistory = observePrepare(readonly, () => readonly.transaction(() => assertRawSyncedHistoricalEvidenceOwned(readonly))())
      const observedCapsule = observePrepare(readonly, () => readonly.transaction(() => readRawCapsule2HistoricalEvidenceOwned(readonly))())
      assert.deepEqual(observedHistory.value, historical); assert.equal(valueHash(observedHistory.value), valueHash(historical))
      assert.deepEqual(observedCapsule.value, capsule); assert.equal(valueHash(observedCapsule.value), valueHash(capsule))
      // The fixed primary read and the unchanged exchange metadata original
      // read each scan actual operations; its independent proof must remain.
      assert.equal(fullOperations(observedHistory.sql).length, 2); assert.equal(filteredOperations(observedHistory.sql).length, 0)
      assert.equal(sameReadOperations(observedHistory.sql).length, 1)
      assert.ok(fullOperations(observedCapsule.sql).length >= 1); assert.equal(filteredOperations(observedCapsule.sql).length, 0)
      assert.equal(sameReadOperations(observedCapsule.sql).length, 1)
      // Each call above is fresh. Repetition verifies DTO/hash stability; it is
      // not a claim to possess a saved parent-commit whole-output golden.
    } finally { readonly.close() }
    assert.equal(totalChanges(db), started); assert.deepEqual(allTables(db), before)
  }
}))

test('same-read metadata2 factory keeps reserved-case/version/orphan and original SQL TEXT rejection while the standalone assertion retains its narrower self-read semantics', () => withV3Fixture(f => {
  const db = f.db, point = captureActualPoint(f), stamp = new Date().toISOString()
  const insert = (key: string) => db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
    .run(key, point.request_hash, point.result_json, point.created_at)
  const remove = (key: string) => db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(key)
  const rejected = (change: () => void, restore: () => void) => {
    change()
    try {
      const before = allTables(db), started = totalChanges(db)
      assert.throws(() => db.transaction(() => assertSyncedMetadataCaptureFamilyOwned2(db))(), /metadata|capture|record|reserved|原TEXT|原件/i)
      assert.throws(() => db.transaction(() => readSyncedHistoricalOperationsWithMetadata2Owned2(db))(), /metadata|capture|record|reserved|原TEXT|原件/i)
      assert.throws(() => db.transaction(() => assertRawSyncedHistoricalEvidenceOwned(db))(), /metadata|capture|record|reserved|原TEXT|原件|事实/i)
      assert.equal(totalChanges(db), started); assert.deepEqual(allTables(db), before)
    } finally { restore() }
  }
  for (const key of [point.client_operation_id.toUpperCase(), 'synced.metadata2.read-baseline:v99:' + randomUUID(), 'synced:metadata2:future:' + randomUUID()]) {
    rejected(() => { insert(key) }, () => { remove(key) })
  }
  for (const kind of [SYNCED_METADATA_CAPTURE2_PIN, SYNCED_METADATA_CAPTURE2_PIN.toUpperCase()]) {
    const key = SYNCED_METADATA_BASELINE2_PREFIX + 'a'.repeat(64); assert.notEqual(key, point.client_operation_id)
    rejected(() => { db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(f.groupId, kind, key, stamp) },
      () => { db.prepare('DELETE FROM synced_group_pins WHERE group_id=? AND kind=? AND pin_id=?').run(f.groupId, kind, key) })
  }
  for (const expression of ['CAST(request_hash AS BLOB)', "CAST(X'80' AS TEXT)"]) {
    rejected(() => { db.prepare('UPDATE synced_operations SET request_hash=' + expression + ' WHERE client_operation_id=?').run(point.client_operation_id) },
      () => { db.prepare('UPDATE synced_operations SET request_hash=? WHERE client_operation_id=?').run(point.request_hash, point.client_operation_id) })
  }
  // An invalid non-family original is rejected by the full operations reader,
  // while the old standalone family API must continue to inspect only its own
  // actual reserved rows. It does not acquire an all-operations contract.
  const ordinary = db.prepare('SELECT request_hash FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId) as { request_hash: string }
  db.prepare('UPDATE synced_operations SET request_hash=CAST(request_hash AS BLOB) WHERE client_operation_id=?').run(f.created.operationId)
  try {
    const before = allTables(db), started = totalChanges(db)
    assert.doesNotThrow(() => db.transaction(() => assertSyncedMetadataCaptureFamilyOwned2(db))())
    assert.throws(() => db.transaction(() => readHistoricalOperations(db))(), /原TEXT/)
    assert.throws(() => db.transaction(() => readSyncedHistoricalOperationsWithMetadata2Owned2(db))(), /原TEXT/)
    assert.equal(totalChanges(db), started); assert.deepEqual(allTables(db), before)
  } finally { db.prepare('UPDATE synced_operations SET request_hash=? WHERE client_operation_id=?').run(ordinary.request_hash, f.created.operationId) }
}))
