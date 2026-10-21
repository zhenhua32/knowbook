import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { advanceSyncedRecoveryEpoch } from '../src/main/database/synced-recovery-boundary'
import { recoveryBoundaryKey, recoveryEpochMarkerId } from '../src/main/database/synced-recovery-boundary-model'
import { readHistoricalRowLocator } from '../src/main/database/synced-history-evidence-support'
import { withV3Fixture, allTables } from './helpers/synced-backup-v3-fixture'
import { tupleFor } from './helpers/coverage-structure-fixture'
import { actualHistorySyntax, insertCoverageSyntax, readCoverage } from './helpers/coverage-raw-sql-fixture'

test('coverage raw SQL cross-checks real Main B/R and keeps old cut facts after a genuine later epoch and CAS allocation', async () => withV3Fixture(f => {
  const syntax = actualHistorySyntax(f.db, '2045-01-02T03:04:05.006Z'), first = syntax.coverage.cut
  const current = f.db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: string; recovery_epoch: string }
  const next = { operationId: randomUUID(), expectedWorkspaceScope: current.workspace_scope, expectedRecoveryEpoch: current.recovery_epoch,
    workspaceScope: current.workspace_scope, recoveryEpoch: randomUUID(), documentBoundary: '2046-01-02T03:04:05.006Z', acceptedAt: '2046-01-02T03:04:05.006Z' }
  assert.ok(f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, next)).immediate())
  insertCoverageSyntax(f.db, syntax)
  const before = allTables(f.db), actual = readCoverage(f.db).entries[0]
  assert.deepEqual(actual.cut, first)
  assert.notEqual(actual.cut.afterEpoch, next.recoveryEpoch, 'Historical requirements do not compare their old epoch to today')
  f.db.transaction(() => {
    assert.deepEqual(actual.supports.boundary, readHistoricalRowLocator(f.db, 'app_settings', [recoveryBoundaryKey(first.operationId)]))
    assert.deepEqual(actual.supports.epoch, readHistoricalRowLocator(f.db, 'synced_operations', [recoveryEpochMarkerId(first.operationId)]))
  })()
  assert.deepEqual(allTables(f.db), before)
}))

test('coverage raw SQL refuses a history declaration with no actual mandatory B/R even when every new tuple hash agrees', async () => withV3Fixture(f => {
  const real = actualHistorySyntax(f.db, '2045-02-03T04:05:06.007Z')
  f.db.prepare('DELETE FROM app_settings WHERE key=?').run(recoveryBoundaryKey(real.coverage.operationId))
  insertCoverageSyntax(f.db, real)
  assert.throws(() => readCoverage(f.db), /反向闭集|孤|真实B|boundary/)
}))

test('coverage raw SQL checks real B/R scope epoch time and hash instead of trusting a self-consistent new syntax tuple', async () => withV3Fixture(f => {
  const real = actualHistorySyntax(f.db, '2045-03-04T05:06:07.008Z')
  assert.equal(real.coverage.cut.kind, 'synced-recovery-epoch-cut')
  if (real.coverage.cut.kind !== 'synced-recovery-epoch-cut') throw new Error('Actual Main fixture has nonempty history')
  const changed = tupleFor({ ...real.coverage, cut: { ...real.coverage.cut, boundaryHash: 'f'.repeat(64) } })
  insertCoverageSyntax(f.db, changed)
  assert.throws(() => readCoverage(f.db), /真实B|B原分配/)
}))

test('coverage raw SQL cannot relabel a real same-operation B/R as an ordinary empty declaration', async () => withV3Fixture(f => {
  const real = actualHistorySyntax(f.db, '2045-04-05T06:07:08.009Z'), cut = real.coverage.cut
  const changed = tupleFor({ ...real.coverage, cut: { kind: 'ordinary-empty-epoch-cut', version: 1, operationId: cut.operationId,
    beforeWorkspaceScope: real.coverage.target.workspaceScope, afterWorkspaceScope: real.coverage.target.workspaceScope,
    beforeEpoch: cut.beforeEpoch, afterEpoch: cut.afterEpoch, documentBoundary: cut.documentBoundary, acceptedAt: cut.acceptedAt } })
  insertCoverageSyntax(f.db, changed)
  assert.throws(() => readCoverage(f.db), /ordinary cut不能隐藏/)
}))
