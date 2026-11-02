import assert from 'node:assert/strict'
import test from 'node:test'
import { withBoth, overlappingGroup, readyBoth, bothComponent, selectBoth, randomUUID } from './helpers/synced-exchange-both-fixture'
import { seedIndependentWorking5, divergeIndependentWorking5, capturePendingWorkingFamily5, assertIndependentWorking5, assertBothWorkingPhaseFamily5 } from './helpers/working5-family-source-fixture'

test('settled and spool-retired: a genuine job3 both fork retains its unrelated automatic whole W and exact production inputs in source5',
  { concurrency: false }, () => withBoth(async f => {
    const automatic = await seedIndependentWorking5(f, f.islands[2]), groupId = await overlappingGroup(f)
    await divergeIndependentWorking5(f, automatic)
    const preview = readyBoth(await f.previewBoth()), decision = selectBoth(bothComponent(preview, 'group:' + groupId))
    const operationId = randomUUID(), saved = await capturePendingWorkingFamily5(f, operationId, 3, () => f.resolveBoth(preview, [decision], operationId), 'settled')
    assert.equal(saved.job.version, 3); if (saved.job.version !== 3) throw new Error('Real Main both job3 required')
    assert.ok(saved.job.forks && saved.job.forks.length > 0); assertIndependentWorking5(saved, automatic, 3)
    assert.equal(saved.working.manifest.captures.some(item => item.jobSettingKey === saved.row.key), false)
    assertBothWorkingPhaseFamily5(saved)
  }, { assets: true, notes: true }))
