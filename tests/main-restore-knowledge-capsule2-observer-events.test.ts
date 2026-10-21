import assert from 'node:assert/strict'
import test from 'node:test'
import { readRawCapsule2ObserverOwned } from '../src/main/database/restore-knowledge-capsule2-observer-read'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { assertSyncedRemoteObservationRecords } from '../src/main/database/synced-remote-observation-read'
import { requireObserved, restoreCreated, stableKey } from './helpers/synced-remote-observation-fixture'
import { insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'
import { withObserver2Copy, withFullStoreObservationFixture as withObservationFixture } from './helpers/capsule2-observer-fixture'

// PREPARED/UNRUN. Remote observation is produced by the actual Main HTTP fixture.
// Only NEW C syntax is inserted explicitly: no accepted C producer exists here.
test('observer2 keeps a real active confirmed observation and its exact member alongside untrusted C syntax while v1 still refuses C', () => withObservationFixture(async f => {
  await f.publish(); const actual = requireObserved(await f.observe(f.open()))
  assert.equal(actual.groups[0].outcome, 'active-confirmed')
  insertCoverageSyntax(f.db)
  await withObserver2Copy(f.db, f.file, db => {
    const before = db.prepare('SELECT total_changes() AS n').get()
    assert.throws(() => db.transaction(() => assertSyncedRemoteObservationRecords(db))())
    const value = db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()
    assert.equal(value.observer.remoteMarkers, 1); assert.equal(value.observer.pairedCoverageAnchors, 1)
    assert.ok(value.legacyFacts.some(fact => fact.family === 'remote-observation'))
    assert.equal(value.coverageSyntaxFacts.length, 4); assert.equal(value.certified, false)
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before)
  })
}))

test('observer2 keeps a true retired-disabled observation and rejects loss of its original marker even when a complete C tuple remains', () => withObservationFixture(async f => {
  restoreCreated(f.db, f.createAck, 'undo'); await f.publish()
  const actual = requireObserved(await f.observe(f.open())); assert.equal(actual.groups[0].outcome, 'retired-disabled')
  const key = stableKey(f.createAck.createdLifecycle.groupId, f.createAck.createdLifecycle.creationId)
  insertCoverageSyntax(f.db)
  await withObserver2Copy(f.db, f.file, db => {
    const value = db.transaction(() => readRawCapsule2ObserverOwned(db))()
    assert.equal(value.remoteMarkers, 1); assert.equal(value.members, 0); assert.equal(value.pairedCoverageAnchors, 1)
    assert.equal(value.certified, false)
  })
  assert.equal(f.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(key).changes, 1)
  await withObserver2Copy(f.db, f.file, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ObserverOwned(db))(), /marker|观察|首证/)
    assert.ok(db.prepare('SELECT 1 FROM synced_exposure_attempts WHERE id=?').get(key))
  })
}))
