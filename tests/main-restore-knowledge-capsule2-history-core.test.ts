import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readRawCapsule2ObserverOwned } from '../src/main/database/restore-knowledge-capsule2-observer-read'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { coverageOperationId, coverageReceiptKey } from '../src/main/database/restore-knowledge-coverage-model'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { actualHistorySyntax, insertCoverageSyntax, ordinaryExposure } from './helpers/coverage-raw-sql-fixture'
import { structureFixture } from './helpers/coverage-structure-fixture'
import { withObserver2Copy, writeObserver2Unrelated501 } from './helpers/capsule2-observer-fixture'

// PREPARED/UNRUN. Main creates group/history/B/R/ordinary document. NEW C rows
// remain untrusted structure, not an accepted producer or authenticated root.
test('total historical2 keeps real Main B R retained ACK journals pins and later history with an unrelated ordinary501 document', () => withV3Fixture(async f => {
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const edit = editCreatedGroup(f.db, f.groupId), syntax = actualHistorySyntax(f.db, '2051-01-02T03:04:05.006Z')
  editCreatedGroup(f.db, f.groupId)
  writeObserver2Unrelated501(f); insertCoverageSyntax(f.db, syntax)
  await withObserver2Copy(f.db, f.file, db => {
    const before = db.prepare('SELECT total_changes() AS n').get()
    assert.throws(() => db.transaction(() => assertRawSyncedHistoricalEvidenceOwned(db))())
    const value = db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()
    assert.ok(value.legacyFacts.some(fact => fact.family === 'recovery-boundary'))
    assert.ok(value.legacyFacts.some(fact => fact.family === 'recovery-epoch'))
    assert.ok(value.legacyFacts.some(fact => fact.family === 'backup-v3'))
    assert.ok(value.observer.ordinaryAttempts > 0, 'Actual Main backup produced its nonzero-member exposure')
    assert.ok(value.originalReferences.some(ref => ref.table === 'synced_operations' && ref.key[0] === edit.operationId))
    assert.ok(value.originalReferences.some(ref => ref.table === 'synced_host_history'))
    assert.ok(value.originalReferences.some(ref => ref.table === 'synced_group_pins'))
    assert.equal(value.coverageSyntaxFacts.length, 4); assert.equal(value.observer.coverage.supports.length, 6)
    assert.equal(value.certified, false); assert.equal(value.acceptedCoverage, false); assert.equal(value.permit, false)
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before)
  })
}))

test('observer2 refuses a reserved C id with actual members even when its channel looks ordinary', () => withV3Fixture(async f => {
  const syntax = structureFixture(); insertCoverageSyntax(f.db, syntax, { omit: 'anchor' })
  const id = coverageOperationId(syntax.coverage.operationId)
  ordinaryExposure(f.db, f.groupId, 'ordinary future channel', id)
  await withObserver2Copy(f.db, f.file, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ObserverOwned(db))(), /member|曝光/)
    assert.ok(db.prepare('SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=?').get(id))
  })
}))

test('observer2 refuses an otherwise complete C tuple with the wrong immutable eight-column anchor expectation', () => withV3Fixture(async f => {
  const syntax = structureFixture(); insertCoverageSyntax(f.db, syntax, { anchor: { target_fingerprint: 'f'.repeat(64) } })
  await withObserver2Copy(f.db, f.file, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ObserverOwned(db))(), /anchor|tuple/)
    assert.equal((db.prepare('SELECT target_fingerprint FROM synced_exposure_attempts WHERE id=?').get(coverageOperationId(syntax.coverage.operationId)) as { target_fingerprint: string }).target_fingerprint, 'f'.repeat(64))
  })
}))

test('observer2 treats UUID nonzero-member new-channel exposure as ordinary and refuses a UUID zero-member attempt', () => withV3Fixture(async f => {
  // Existing exact SQL guard fixture, not a fabricated ACK/proof or Main C producer.
  const id = ordinaryExposure(f.db, f.groupId, 'recovery-knowledge-coverage-v1')
  insertCoverageSyntax(f.db)
  await withObserver2Copy(f.db, f.file, db => {
    const value = db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()
    assert.equal(value.observer.ordinaryAttempts, 1)
    assert.ok(value.legacyFacts.some(fact => fact.family === 'member-exposure' && fact.locator.key[0] === id))
  })
  const orphan = randomUUID()
  f.db.prepare("INSERT INTO synced_exposure_attempts VALUES(?,?,?,?,?,'possible',?,NULL)")
    .run(orphan, '1'.repeat(64), 'recovery-knowledge-coverage-v99', '2'.repeat(64), '3'.repeat(64), '2051-02-02T03:04:05.006Z')
  await withObserver2Copy(f.db, f.file, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ObserverOwned(db))())
    assert.ok(db.prepare('SELECT 1 FROM synced_exposure_attempts WHERE id=?').get(orphan))
  })
}))

test('total historical2 rejects missing C receipt and preserves all remaining real Main and new syntax rows', () => withV3Fixture(async f => {
  const syntax = actualHistorySyntax(f.db, '2051-03-02T03:04:05.006Z'); insertCoverageSyntax(f.db, syntax)
  const key = coverageReceiptKey(syntax.receipt.operationId)
  f.db.prepare('DELETE FROM app_settings WHERE key=?').run(key)
  await withObserver2Copy(f.db, f.file, db => {
    const before = db.prepare('SELECT key,value,updated_at FROM app_settings ORDER BY key').all()
    assert.throws(() => db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))(), /闭集|孤C/)
    assert.deepEqual(db.prepare('SELECT key,value,updated_at FROM app_settings ORDER BY key').all(), before)
  })
}))

test('total historical2 refuses unknown reserved metadata and marker families instead of classifying them as ordinary policy data', () => withV3Fixture(async f => {
  insertCoverageSyntax(f.db)
  f.db.prepare('INSERT INTO app_settings VALUES(?,?,?)').run('synced.future.v99.' + randomUUID(), '{}', '2051-04-02T03:04:05.006Z')
  await withObserver2Copy(f.db, f.file, db => assert.throws(() => db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()))
  const id = 'synced:remote-exposure-observation:v99:' + randomUUID()
  f.db.prepare('INSERT INTO synced_operations VALUES(?,?,?,?)').run(id, 'f'.repeat(64), '{}', '2051-04-02T03:04:05.006Z')
  await withObserver2Copy(f.db, f.file, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ObserverOwned(db))(), /未知reserved/)
    assert.ok(db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(id))
  })
}))
