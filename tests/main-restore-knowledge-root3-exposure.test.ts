import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { root3Fact } from '../src/main/database/restore-knowledge-root3-model'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureKnowledgeOriginal } from './helpers/restore-knowledge-payload-fixture'
import { root3PlanFromActualCapsules } from './helpers/root3-plan-fixture'

test('complete Root3 plan conserves actual committed possible exposure without converting any observation into installation permission', () => withV3Fixture(async f => {
  const source = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)), attemptId = randomUUID()
  f.db.exec("CREATE TRIGGER root3_fixture_confirm BEFORE UPDATE OF state ON synced_exposure_attempts WHEN NEW.state='confirmed' BEGIN SELECT RAISE(ABORT,'root3 fixture stops confirmation'); END")
  try { assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: attemptId })) }
  finally { f.db.exec('DROP TRIGGER root3_fixture_confirm') }
  assert.deepEqual(f.db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(attemptId), { state: 'possible' })
  const current = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file))
  const { value } = await root3PlanFromActualCapsules(f.userDataRoot, source, current.capsule), plan = value.constraints
  const before = plan.payloads.find(payload => payload.witness.side === 'source')!.input.knowledge.projection
  const after = plan.payloads.find(payload => payload.witness.side === 'current')!.input.knowledge.projection
  const oldGroup = before.groups.find(group => group.tuple.groupId === f.groupId)!
  assert.equal(oldGroup.lifecycle?.exposure, 'never')
  assert.equal(after.groups.find(group => group.tuple.groupId === f.groupId)!.lifecycle?.exposure, 'possible')
  const constraint = plan.groups.find(group => group.comparisonKey === oldGroup.comparisonKey)!
  assert.equal(constraint.disposition, 'preserve-exposure'); assert.equal(constraint.activeObservationIsInstallationPermission, false)
  assert.ok(constraint.exposures.some(ref => root3Fact(plan, ref) === after.exposures.find(exposure => exposure.attempt.id === attemptId)))
  assert.equal(value.effective, false); assert.equal(value.permit, false)
}))
