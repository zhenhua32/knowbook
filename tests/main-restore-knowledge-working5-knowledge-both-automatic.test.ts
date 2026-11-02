import assert from 'node:assert/strict'
import test from 'node:test'
import { withKnowledge, divergeGroup, readyBoth, bothComponent, selectBoth, randomUUID, unchangedDenial } from './helpers/synced-exchange-knowledge-fixture'
import { seedIndependentWorking5, divergeIndependentWorking5, capturePendingWorkingFamily5, assertIndependentWorking5 } from './helpers/working5-family-source-fixture'

test('a genuine knowledge job6 both fork also seals unrelated automatic W with the exact physical and knowledge sources',
  { concurrency: false }, () => withKnowledge(async f => {
    const automatic = await seedIndependentWorking5(f, f.islands[2]), conflict = await divergeGroup(f)
    await divergeIndependentWorking5(f, automatic)
    const preview = readyBoth(await f.previewBoth()), decision = selectBoth(bothComponent(preview, conflict.key), { copies: [], hosts: 'existing' })
    const operationId = randomUUID(), saved = await capturePendingWorkingFamily5(f, operationId, 6, () => f.resolveBoth(preview, [decision], operationId))
    assert.equal(saved.job.version, 6); if (saved.job.version !== 6) throw new Error('Real Main knowledge both job6 required')
    assert.ok(saved.job.forks.length > 0); assert.ok(saved.job.knowledgeSource.deleted.some(item => item.key === f.denialKey))
    assertIndependentWorking5(saved, automatic, 6); unchangedDenial(f)
  }, { assets: true }))
