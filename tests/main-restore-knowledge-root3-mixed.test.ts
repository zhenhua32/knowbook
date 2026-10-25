import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareRootKnowledgeConservationPlan3, readRootKnowledgeConservationPlan3 } from '../src/main/database/restore-knowledge-root3-read'
import { runRoot3MixedCase } from './helpers/root3-mixed-plan-assertions'

test('complete Root3 conservation plan keeps both actual 1/1 readers and every typed original fact', () => runRoot3MixedCase([1,1]))
test('complete Root3 owner rejects fake and accessor handles without executing caller properties', async () => {
  let calls = 0
  const fake = Object.defineProperty({}, 'kind', { get() { calls++; throw Error('caller getter'); } })
  await assert.rejects(prepareRootKnowledgeConservationPlan3(fake as never), /句柄/)
  await assert.rejects(readRootKnowledgeConservationPlan3(fake as never), /句柄/)
  assert.equal(calls, 0)
})
