import assert from 'node:assert/strict'
import test from 'node:test'
import { readCompleteOriginalPackage } from '../src/main/database/restore-knowledge-qualified-originals'
import { allTables, withMixedBundleFixture } from './helpers/mixed-origin-bundle-fixture'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { addOriginalReferenceSyntax, nextQualifiedBundle } from './helpers/qualified-originals-fixture'

test('qualified original inputs resolve the full actual native C1 reference set without asserting accepted coverage or borrowing foreign UUIDs', () => withMixedBundleFixture([1, 1], async f => {
  const current = await captureMixedSource(f.source, 2)
  addOriginalReferenceSyntax(f.source, f.value.originalRoot)
  const saved = await nextQualifiedBundle(f.source, [{ bundle: f.handle, original: f.value.originalRoot }], current), value = saved.value
  assert.equal(value.depth, 2); assert.equal(value.nodes, 2); assert.equal(value.capsules, 4)
  assert.equal(value.node.parents.length, 1); assert.equal(value.parents.length, 1)
  assert.equal(value.inputs[0].origin.kind, 'bound-original-bundle')
  const projection = value.inputs[0].knowledge.projection
  assert.ok('coverageMaterial' in projection); assert.equal(projection.coverageMaterial.length, 4)
  assert.equal(value.parents[0].original.materialHash, f.value.sourceMaterialHash)
  assert.equal(value.acceptedCoverage, false); assert.equal(value.effective, false); assert.equal(value.permit, false)
  const before = allTables(f.source.db)
  assert.deepEqual((await readCompleteOriginalPackage(saved.bundle)).original, value)
  assert.deepEqual(allTables(f.source.db), before); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
}))
