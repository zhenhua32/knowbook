import assert from 'node:assert/strict'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { readSyncedExchangeDenialEvidenceById } from '../src/main/database/synced-exchange-receipt'
import { exchangeJobKey, exchangeJobPhaseKey, validateExchangeJobWithPlan } from '../src/main/sync/synced-exchange-model'
import { SyncedPublicationError } from '../src/main/sync/synced-publication-model'
import { withDeletionChoices, groupConflict, ready, component, choose, completed, randomUUID,
  encode, flip, hostEdit, type Fixture } from './helpers/synced-deletion-choice-fixture'

async function keepDelete(f: Fixture) {
  const conflict = groupConflict(f), preview = ready(await f.preview()), operationId = randomUUID()
  completed(await f.resolve(preview, [choose(component(preview, conflict.key), 'keep-delete')], operationId), 'applied')
  return operationId
}

function evidence(db: Database.Database, operationId: string) {
  const value = readSyncedExchangeDenialEvidenceById(db, operationId)
  assert.ok(value, 'The real completed keep-delete has its exact original SQL receipt')
  const { receipt, job } = value
  assert.ok(receipt.version === 7 && job?.version === 7, 'Both facts come from the actual version7 Main writer')
  assert.ok(receipt.provenance.deletions.length > 0 && job.deletions.length > 0, 'The real decision installed an actual deletion proof')
  return { receipt, job }
}

function invalid(error: unknown) {
  assert.ok(error instanceof SyncedPublicationError, 'Changed original SQL is rejected by the strict Main reader')
  assert.equal(error.code, 'invalid')
  return true
}

function setting(db: Database.Database, key: string) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined
  assert.ok(row, 'The negative starts from an actual immutable Main job or phase')
  return row.value
}

test('denial evidence rechecks changed phase source and proof SQL after a valid read in the same owned transaction', () => withDeletionChoices(async f => {
  const operationId = await keepDelete(f)
  f.B.db.transaction(() => {
    const original = evidence(f.B.db, operationId), phaseKey = exchangeJobPhaseKey(operationId, original.job.attemptId, 0)
    const sourceKey = exchangeJobKey(operationId, original.job.attemptId), proofId = original.receipt.provenance.deletions[0].anchorId
    const phase = JSON.parse(setting(f.B.db, phaseKey)), source = JSON.parse(setting(f.B.db, sourceKey))
    const marker = f.B.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(proofId) as { result_json: string }
    const proof = JSON.parse(marker.result_json)
    const faults = [
      () => {
        phase.jobHash = flip(phase.jobHash)
        assert.equal(f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(phase), phaseKey).changes, 1)
      },
      () => {
        source.decisionSource.remoteSource.closureHash = flip(source.decisionSource.remoteSource.closureHash)
        assert.equal(f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(source), sourceKey).changes, 1)
      },
      () => {
        proof.source.closureHash = flip(proof.source.closureHash)
        assert.equal(f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(proof), proofId).changes, 1)
      }
    ]
    for (const fault of faults) {
      f.B.db.exec('SAVEPOINT denial_evidence_fault')
      try {
        fault()
        assert.throws(() => evidence(f.B.db, operationId), invalid)
      } finally {
        f.B.db.exec('ROLLBACK TO denial_evidence_fault')
        f.B.db.exec('RELEASE denial_evidence_fault')
      }
      assert.deepEqual(evidence(f.B.db, operationId), original, 'The exact restored SQL is independently authenticated again')
    }
  })()
}))

test('denial evidence remains the original historical ACK across transactions connections and a later epoch but rejects newly changed raw bytes', () => withDeletionChoices(async f => {
  const operationId = await keepDelete(f), original = f.B.db.transaction(() => evidence(f.B.db, operationId))()
  hostEdit(f.B.db, f.islands[1], 'A real later Main edit leaves the earlier deletion ACK historical')
  const epoch = randomUUID()
  f.B.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(epoch)
  assert.notEqual(epoch, original.receipt.result.recoveryEpoch)
  assert.deepEqual(f.B.db.transaction(() => evidence(f.B.db, operationId))(), original)
  const other = f.connect(f.B)
  assert.deepEqual(other.transaction(() => evidence(other, operationId))(), original, 'The second real connection reads the same original receipt and job')
  const key = exchangeJobKey(operationId, original.job.attemptId), changed = JSON.parse(setting(other, key))
  changed.descriptor.planHash = flip(changed.descriptor.planHash)
  assert.equal(other.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(changed), key).changes, 1)
  assert.throws(() => other.transaction(() => evidence(other, operationId))(), invalid)
  assert.throws(() => f.B.db.transaction(() => evidence(f.B.db, operationId))(), invalid,
    'The original connection cannot reuse a valid result from an earlier transaction after another connection changes SQL')
}))

test('denial evidence and pure codec results cannot turn mutated input or returned jobs into authority for another invocation', () => withDeletionChoices(async f => {
  const operationId = await keepDelete(f), original = f.B.db.transaction(() => evidence(f.B.db, operationId))()
  const key = exchangeJobKey(operationId, original.job.attemptId), rawBytes = setting(f.B.db, key), input = JSON.parse(rawBytes)
  const checked = validateExchangeJobWithPlan(input)
  assert.ok(checked.job.version === 7 && checked.deletionPlan)
  input.descriptor.planHash = flip(input.descriptor.planHash)
  assert.throws(() => validateExchangeJobWithPlan(input), invalid, 'A prior successful call cannot validate the same input object after mutation')
  checked.job.descriptor.planHash = flip(checked.job.descriptor.planHash)
  assert.throws(() => validateExchangeJobWithPlan(checked.job), invalid, 'The returned job is data, not a proof accepted by the next codec call')
  const returned = f.B.db.transaction(() => evidence(f.B.db, operationId))()
  returned.job.decisionSourceHash = flip(returned.job.decisionSourceHash)
  returned.receipt.provenance.decisionSourceHash = flip(returned.receipt.provenance.decisionSourceHash)
  assert.equal(setting(f.B.db, key), rawBytes)
  const fresh = f.B.db.transaction(() => evidence(f.B.db, operationId))()
  assert.deepEqual(fresh, original)
  assert.notEqual(fresh.job, returned.job)
  assert.notEqual(fresh.receipt, returned.receipt)
}))
