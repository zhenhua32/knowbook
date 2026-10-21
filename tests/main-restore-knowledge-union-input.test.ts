import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname } from 'node:path'
import { DURABLE_SQL_DAG_MAX_CAPSULES } from '../src/main/database/restore-knowledge-dag-model'
import { unionCertifiedCapsuleKnowledge } from '../src/main/database/restore-knowledge-payload-read'
import type { CertifiedCapsuleKnowledge } from '../src/main/database/restore-knowledge-capsule-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureKnowledgeOriginal, extractKnowledge } from './helpers/restore-knowledge-payload-fixture'

/** Explicit expected-red contract for candidate-v3: array extras and finite
 * length are not yet rejected there. Root must implement closed-array admission
 * before running this real test; no skip/timeout/workers/retry changes apply. */
test('union rejects extra string/symbol/accessor fields and dense-input violations before they can select authority', () => withV3Fixture(async f => {
  const real = (await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))).handle
  let accessorCalls = 0
  const extra = [real], symbol = [real], hidden = [real], extraAccessor = [real], indexAccessor = [real]
  Object.defineProperty(extra, 'allow', { value: true, enumerable: true })
  Object.defineProperty(symbol, Symbol('caller-permit'), { value: true })
  Object.defineProperty(hidden, 'raw', { value: true })
  Object.defineProperty(extraAccessor, 'facts', { get() { accessorCalls++; return [real] } })
  Object.defineProperty(indexAccessor, '0', { get() { accessorCalls++; return real } })
  const hole = [real, real]; delete hole[1]
  const inputs = [extra, symbol, hidden, extraAccessor, indexAccessor, hole]
  const results = await Promise.allSettled(inputs.map(input => unionCertifiedCapsuleKnowledge(input)))
  assert.equal(accessorCalls, 0, 'Descriptor validation must not execute caller code')
  for (const [index, result] of results.entries()) assert.equal(result.status, 'rejected', 'Closed array case ' + index + ' must reject')
  await assert.rejects(unionCertifiedCapsuleKnowledge([JSON.parse(JSON.stringify(real))] as CertifiedCapsuleKnowledge[]), /句柄/)
}))

test('union has a finite whole-original bound before inspecting oversized input entries', () => withV3Fixture(async f => {
  const real = (await extractKnowledge(await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file)))).handle
  const oversized = new Array<CertifiedCapsuleKnowledge>(DURABLE_SQL_DAG_MAX_CAPSULES + 1).fill(real)
  let called = false
  // Poison the first descriptor so the expected-red test cannot perform 1,025
  // disk inventories if the finite bound is absent. The rejection must identify
  // the whole-input budget before inspecting individual entry descriptors.
  Object.defineProperty(oversized, '0', { get() { called = true; return real } })
  await assert.rejects(unionCertifiedCapsuleKnowledge(oversized), /预算|超限|数量|长度/)
  assert.equal(called, false)
}))
