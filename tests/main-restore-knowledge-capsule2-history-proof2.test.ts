import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { exchangeJobPhaseKey } from '../src/main/sync/synced-exchange-model'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { withDeletionChoices, groupConflict, ready, component, choose, completed, receipt7 } from './helpers/synced-deletion-choice-fixture'
import { insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'
import { withObserver2Copy } from './helpers/capsule2-observer-fixture'

// PREPARED/UNRUN. Own file preserves the existing multi-peer fixture budget.
test('total historical2 retains genuine proof2 receipt7 job7 and refuses loss of its mandatory phase despite a complete C tuple', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), preview = ready(await f.preview()), operationId = randomUUID()
  completed(await f.resolve(preview, [choose(component(preview, conflict.key), 'keep-delete')], operationId), 'applied')
  const original = receipt7(f, operationId), phase = exchangeJobPhaseKey(operationId, original.receipt.provenance.attemptId, 0)
  insertCoverageSyntax(f.B.db)
  await withObserver2Copy(f.B.db, f.B.file, db => {
    const value = db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()
    assert.ok(value.legacyFacts.some(fact => fact.family === 'logical-deletion-proof' && fact.version === 2))
    assert.ok(value.legacyFacts.some(fact => fact.family === 'exchange-receipt' && fact.version === 7))
    assert.ok(value.legacyFacts.some(fact => fact.family === 'exchange-job' && fact.version === 7))
    assert.ok(value.originalReferences.some(ref => ref.table === 'app_settings' && ref.key[0] === phase))
    assert.equal(value.certified, false)
  })
  assert.equal(f.B.db.prepare('DELETE FROM app_settings WHERE key=?').run(phase).changes, 1)
  await withObserver2Copy(f.B.db, f.B.file, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))(), /phase|阶段|prepared|来源|job|回执|receipt/)
    assert.equal(db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(phase), undefined)
  })
}))
