import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readCertifiedCapsuleKnowledge, type CertifiedCapsuleKnowledge } from '../src/main/database/restore-knowledge-capsule-read'
import { unionCertifiedCapsuleKnowledge, readCertifiedKnowledgeUnion } from '../src/main/database/restore-knowledge-payload-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { captureKnowledgeOriginal, extractKnowledge, knowledgeArtifactBytes } from './helpers/restore-knowledge-payload-fixture'

// Ignored candidate: true Main writers and SQL certifier, not yet executed.
test('K retains one real immutable tuple across never, committed possible and later confirmed exposure with a new content CAS', () => withV3Fixture(async f => {
  const source = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file))
  const possibleId = randomUUID()
  f.db.exec("CREATE TRIGGER payload_fixture_confirm BEFORE UPDATE OF state ON synced_exposure_attempts WHEN NEW.state='confirmed' BEGIN SELECT RAISE(ABORT,'payload fixture stops confirmation'); END")
  try { assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: possibleId })) }
  finally { f.db.exec('DROP TRIGGER payload_fixture_confirm') }
  assert.deepEqual(f.db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(possibleId), { state: 'possible' })
  const possible = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file))
  const edit = editCreatedGroup(f.db, f.groupId), confirmedId = randomUUID()
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: join(f.root, 'payload-confirmed'), snapshotId: confirmedId })
  const current = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file))
  const originals = [source, possible, current], before = await Promise.all(originals.map(knowledgeArtifactBytes))
  const extracted = await Promise.all(originals.map(extractKnowledge))
  const [old, pending, next] = extracted.map(item => item.payload)
  const groups = [old, pending, next].map(payload => {
    const group = payload.groups.find(group => group.tuple.groupId === f.groupId)
    assert.ok(group); return group
  })
  assert.equal(new Set(groups.map(group => group.comparisonKey)).size, 1)
  assert.deepEqual(groups.map(group => group.lifecycle?.exposure), ['never', 'possible', 'confirmed'])
  assert.notEqual(groups[0].guards.revision, groups[2].guards.revision)
  assert.ok(next.historicalMaterial.some(item => item.fact.family === 'group-ack' && item.fact.locator.key[0] === edit.operationId))
  const union = await readCertifiedKnowledgeUnion(await unionCertifiedCapsuleKnowledge(extracted.map(item => item.handle)))
  const history = union.exposureKnowledge.filter(item => item.comparisonKey === groups[0].comparisonKey)
  assert.deepEqual(history.map(item => item.attemptLowerBound).sort(), ['confirmed', 'none-recorded', 'possible'])
  assert.ok(union.exposures.some(item => item.value.attempt.id === possibleId && item.value.attempt.state === 'possible'))
  assert.ok(union.exposures.some(item => item.value.attempt.id === confirmedId && item.value.attempt.state === 'confirmed'))
  assert.equal(union.status, 'evidence-only')
  assert.ok(Object.isFrozen(next) && Object.isFrozen(next.groups) && Object.isFrozen(next.originals[0].rows[0].cells))
  assert.equal(Reflect.set(next.groups[0].guards, 'revision', randomUUID()), false)
  const clone = JSON.parse(JSON.stringify(next)) as CertifiedCapsuleKnowledge
  await assert.rejects(readCertifiedCapsuleKnowledge(clone), /句柄/)
  assert.deepEqual(await readCertifiedCapsuleKnowledge(extracted[2].handle), next)
  assert.deepEqual(await Promise.all(originals.map(knowledgeArtifactBytes)), before)
}))
