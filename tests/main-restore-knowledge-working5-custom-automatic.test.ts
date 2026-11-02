import assert from 'node:assert/strict'
import test from 'node:test'
import { withConflicts, diverge, ready, component, mergeDecision, randomUUID } from './helpers/synced-exchange-conflict-fixture'
import { seedIndependentWorking5, divergeIndependentWorking5, capturePendingWorkingFamily5, assertIndependentWorking5 } from './helpers/working5-family-source-fixture'

test('one genuine job2 captures its custom group and unrelated noncustom automatic document through one Working5 index',
  { concurrency: false }, () => withConflicts(async f => {
    const automatic = await seedIndependentWorking5(f, f.islands[2]), groupId = await diverge(f)
    await divergeIndependentWorking5(f, automatic)
    const preview = ready(await f.preview()), decision = mergeDecision(component(preview, 'group:' + groupId), () => ({ choice: 'custom', text: 'Actual custom group beside noncustom automatic W' }))
    const operationId = randomUUID(), saved = await capturePendingWorkingFamily5(f, operationId, 2, () => f.resolve(preview, [decision], operationId))
    assertIndependentWorking5(saved, automatic, 2)
    assert.ok(saved.records.some(item => item.recordKey === 'group:' + groupId))
    assert.ok(saved.job.request.method === 'resolveSyncedExchangeConflicts')
    assert.equal(saved.working.files.length, new Set(saved.working.files.map(file => file.sha256)).size)
  }, { assets: true, notes: true }))
