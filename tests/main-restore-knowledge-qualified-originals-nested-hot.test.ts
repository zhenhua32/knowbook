import assert from 'node:assert/strict'
import test from 'node:test'
import { readCompleteOriginalPackage } from '../src/main/database/restore-knowledge-qualified-originals'
import { withNestedOriginalScenario } from './helpers/qualified-originals-nested-scenario'

test('qualified C1/C2 hot readers reconstruct their whole independent closure after every earlier source retires', () => withNestedOriginalScenario(async ({ second, stage }) => {
  assert.deepEqual((await readCompleteOriginalPackage(second.bundle)).original, second.value)
  stage('retired-source-hot-read')
}))
