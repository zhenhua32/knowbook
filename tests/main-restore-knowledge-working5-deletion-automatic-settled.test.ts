import assert from 'node:assert/strict'
import test from 'node:test'
import { withDeletionChoices, docConflict, ready, component, choose, randomUUID, receipt7 } from './helpers/synced-deletion-choice-fixture'
import { seedIndependentWorking5, divergeIndependentWorking5, capturePendingWorkingFamily5, assertIndependentWorking5 } from './helpers/working5-family-source-fixture'

test('settled and spool-retired: a genuine job7 keep-delete decision seals unrelated automatic W without promoting it to deletion authority',
  { concurrency: false }, () => withDeletionChoices(async f => {
    const automatic = await seedIndependentWorking5(f, f.islands[2]), conflict = docConflict(f)
    await divergeIndependentWorking5(f, automatic)
    const preview = ready(await f.preview()), decision = choose(component(preview, conflict.key), 'keep-delete')
    const operationId = randomUUID(), saved = await capturePendingWorkingFamily5(f, operationId, 7, () => f.resolve(preview, [decision], operationId), 'settled')
    assert.equal(saved.job.version, 7); if (saved.job.version !== 7) throw new Error('Real Main deletion-choice job7 required')
    assert.ok(saved.job.decisionSourceHash); assertIndependentWorking5(saved, automatic, 7)
    receipt7(f, operationId)
    assert.equal(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(conflict.id), undefined)
    assert.equal(saved.working.manifest.installPermit, false)
  }, { assets: true }))
