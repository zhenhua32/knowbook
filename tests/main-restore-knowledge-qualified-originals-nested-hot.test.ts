import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { hashBoundedCapsuleJson } from '../src/main/database/restore-knowledge-capsule-json-hash'
import { readCompleteOriginalPackage } from '../src/main/database/restore-knowledge-qualified-originals'
import { withNestedOriginalScenario } from './helpers/qualified-originals-nested-scenario'

test('qualified C1/C2 hot readers reconstruct their whole independent closure after every earlier source retires', () => withNestedOriginalScenario(async ({ second, stage }) => {
  const { original } = await readCompleteOriginalPackage(second.bundle)
  assert.deepEqual(original, second.value)
  const { materialHash, ...body } = original
  const prefix = 'knowbook.complete-original-inputs.v1\0', originalJson = capsuleJson(body)
  assert.equal(materialHash, capsuleBytesHash(prefix + originalJson))
  const budget = Buffer.byteLength(originalJson)
  assert.equal(hashBoundedCapsuleJson(body, budget, prefix), materialHash)
  assert.equal(hashBoundedCapsuleJson(body, budget - 1, prefix), null)
  stage('retired-source-hot-read')
}))
