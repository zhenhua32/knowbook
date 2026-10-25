import assert from 'node:assert/strict'
import { prepareRootKnowledgeConservationPlan3, readRootKnowledgeConservationPlan3, type RootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { root3Fact } from '../../src/main/database/restore-knowledge-root3-model'
import { readSyncedPublicationCapture, type SyncedPublicationCapture } from '../../src/main/database/synced-publication'
import { withRoot3MixedFixture, allTables } from './root3-plan-fixture'

export async function runRoot3MixedCase(readers: readonly [1|2,1|2]) {
  return withRoot3MixedFixture(readers, async f => {
  const { knowledgePlan: plan, knowledgeValue: value } = f.saved, full = value.constraints
  assert.equal(value.originalInputClosureAuthenticated, true)
  assert.equal(value.semanticValidationComplete, false); assert.equal(value.acceptedCoverage, false); assert.equal(value.permit, false)
  assert.equal(full.nodes.length, 1); assert.equal(full.payloads.length, 2); assert.equal(full.priorCoverage.length, 0)
  assert.equal(new Set(full.payloads.map(payload => payload.key)).size, 2)
  for (const payload of full.payloads) {
    const original = f.expectedInputs.find(input => input.binding.capsule.capsuleId === payload.witness.capsule.capsuleId)!
    assert.ok(original); assert.deepEqual(payload.input.knowledge, original.knowledge)
    assert.deepEqual(payload.witness.domain, [])
    assert.equal(payload.witness.capsule.readerVersion, payload.input.knowledge.readerVersion)
  }
  const expectedFamilies = new Set(full.payloads.flatMap(payload => Object.entries(payload.input.knowledge.projection)
    .filter(([key, value]) => key !== 'unresolved' && Array.isArray(value)).map(([key]) => key)))
  for (const family of ['coverageAnchors', 'coverageMaterial', 'legacyRestoreReceipts']) expectedFamilies.add(family)
  assert.deepEqual(Object.keys(full.facts).sort(), [...expectedFamilies].sort())
  for (const [family, refs] of Object.entries(full.facts)) {
    const expected = full.payloads.flatMap(payload => {
      const projection = payload.input.knowledge.projection
      const rows = Reflect.get(projection, family) as readonly unknown[] | undefined
      return (rows ?? []).map((value, index) => ({ key: payload.key, value, index }))
    })
    assert.equal(refs.length, expected.length, family)
    refs.forEach((ref, index) => {
      assert.equal(ref.payload, expected[index].key); assert.equal(ref.index, expected[index].index)
      assert.strictEqual(root3Fact(full, ref), expected[index].value)
    })
  }
  assert.ok(full.groups.length > 0); assert.ok(full.mapping.length > 0)
  assert.ok(full.groups.every(group => !group.activeObservationIsInstallationPermission))
  assert.ok(full.groups.every(group => group.requiresQualifiedIncarnationMapping))
  assert.ok(full.mapping.every(mapping => mapping.requiresQualifiedMapping))
  for (const mapping of full.mapping) for (const variant of mapping.variants) assert.ok(variant.facts.every(ref => ref.payload === variant.payload))
  assert.equal('planHash' in full, false, 'A conservation hash is not the full installed coverage planHash')
  assert.equal(readSyncedPublicationCapture(plan as unknown as SyncedPublicationCapture), null)
  await assert.rejects(readRootKnowledgeConservationPlan3(JSON.parse(JSON.stringify(value)) as RootKnowledgeConservationPlan3), /句柄/)
  assert.equal(Reflect.set(full.payloads, 'length', 0), false)
  if (readers[0] === 1 && readers[1] === 1) assert.deepEqual((await prepareRootKnowledgeConservationPlan3(f.saved.bundle)).value, value)
  assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  })
}
