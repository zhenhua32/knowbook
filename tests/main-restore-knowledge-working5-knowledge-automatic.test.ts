import assert from 'node:assert/strict'
import test from 'node:test'
import { withKnowledge, divergeGroup, ready, component, mergeDecision, randomUUID, unchangedDenial } from './helpers/synced-exchange-knowledge-fixture'
import { seedIndependentWorking5, divergeIndependentWorking5, capturePendingWorkingFamily5, assertIndependentWorking5 } from './helpers/working5-family-source-fixture'

test('one genuine knowledge job5 authenticates custom and noncustom whole W beside unchanged original absence authority',
  { concurrency: false }, () => withKnowledge(async f => {
    const automatic = await seedIndependentWorking5(f, f.islands[2]), conflict = await divergeGroup(f)
    await divergeIndependentWorking5(f, automatic)
    const preview = ready(await f.preview()), decision = mergeDecision(component(preview, conflict.key), () => ({ choice: 'custom', text: 'Actual knowledge custom group beside automatic W' }))
    const operationId = randomUUID(), saved = await capturePendingWorkingFamily5(f, operationId, 5, () => f.resolve(preview, [decision], operationId))
    assert.equal(saved.job.version, 5); if (saved.job.version !== 5) throw new Error('Real Main knowledge job5 required')
    assert.ok(saved.job.knowledgeSource.deleted.some(item => item.key === f.denialKey))
    assert.ok(saved.records.some(item => item.recordKey === conflict.key)); assertIndependentWorking5(saved, automatic, 5)
    unchangedDenial(f)
  }, { assets: true }))
