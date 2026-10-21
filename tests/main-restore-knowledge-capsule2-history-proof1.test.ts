import assert from 'node:assert/strict'
import test from 'node:test'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { withDeletionPrimer, completed, encode, hash } from './helpers/synced-exchange-tombstone-primer-fixture'
import { insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'
import { withObserver2Copy } from './helpers/capsule2-observer-fixture'

// PREPARED/UNRUN. Real multi-peer Main proof1/receipt4/job4 event, not DTO proof.
test('total historical2 preserves genuine permanent proof1 receipt4 job phases and identity supports when new C syntax is present', () => withDeletionPrimer(async f => {
  f.remoteFinal(records => {
    const before = records.get('group:' + f.groupId); assert.ok(before?.kind === 'synced-group')
    records.set('group:' + f.groupId, { kind: 'synced-group-deleted', id: f.groupId, creationId: before.creationId,
      previousHash: hash(encode(before)), deletedAt: new Date().toISOString() })
  })
  completed(await f.exchange(), 'applied'); insertCoverageSyntax(f.B.db)
  await withObserver2Copy(f.B.db, f.B.file, db => {
    const value = db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()
    assert.equal(value.observer.logicalDenials, 1)
    assert.ok(value.legacyFacts.some(fact => fact.family === 'logical-deletion-proof' && fact.version === 1))
    assert.ok(value.legacyFacts.some(fact => fact.family === 'exchange-receipt' && fact.version === 4))
    assert.ok(value.legacyFacts.some(fact => fact.family === 'exchange-job' && fact.version === 4))
    assert.ok(value.legacyFacts.some(fact => fact.family === 'exchange-job-phase'))
    assert.equal(value.coverageSyntaxFacts.length, 4); assert.equal(value.certified, false)
  })
}))
