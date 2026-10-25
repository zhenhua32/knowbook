import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { readRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { capsuleJson } from '../../src/main/database/restore-knowledge-capsule-model'
import type { withNestedOriginalScenario } from './qualified-originals-nested-scenario'
import { deriveRoot3KnowledgeConstraints } from '../../src/main/database/restore-knowledge-root3-model'
import { readRoot3OriginalReferenceResolutions } from '../../src/main/database/restore-knowledge-root3-contexts'

export async function assertRoot3NestedKnowledge(t: TestContext,
  second: Parameters<Parameters<typeof withNestedOriginalScenario>[0]>[0]['second'],
  actual: Awaited<ReturnType<typeof readRootKnowledgeConservationPlan3>>) {
  const value = actual.constraints
  const actualResolutions = await readRoot3OriginalReferenceResolutions(second.originalPackage)
  assert.deepEqual(deriveRoot3KnowledgeConstraints(second.value, [...actualResolutions].reverse()), value,
    'The actual complete mapping is interpreted by full original domain and root, independent of mapping array order')
  const rootMappings = actualResolutions.filter(resolution => resolution.domain.length === 0)
  assert.equal(rootMappings.length, 2)
  const altered = [
    ['root3 missing actual context mapping', actualResolutions.slice(1)],
    ['root3 extra actual context mapping', [...actualResolutions, { ...actualResolutions[0] }]],
    ['root3 wrong original root context mapping', actualResolutions.map(resolution => resolution === rootMappings[0]
      ? { ...resolution, originalReference: rootMappings[1].originalReference } : resolution)],
    ['root3 native fallback cannot replace an imported context', actualResolutions.map(resolution => resolution === rootMappings[0]
      ? { ...resolution, mountedReference: { ...resolution.mountedReference, namespace: { kind: 'native' as const } } } : resolution)]
  ] as const
  for (const [name, mappings] of altered) await t.test(name, () => assert.throws(() => deriveRoot3KnowledgeConstraints(second.value, mappings), /规划无效/))
  assert.equal(value.nodes.length, 4); assert.equal(value.payloads.length, 8)
  assert.equal(new Set(value.payloads.map(payload => payload.key)).size, 8)
  assert.equal(new Set(value.nodes.map(node => capsuleJson(node.domain))).size, 4)
  assert.equal(value.priorCoverage.length, 3); assert.equal(value.coverageAcceptanceRequired, 3)
  assert.equal(value.facts.coverageAnchors.length, 3); assert.equal(value.facts.coverageMaterial.length, 12)
  const byOriginalCapsule = new Map<string, typeof value.payloads[number][]>()
  for (const payload of value.payloads) {
    const key = capsuleJson(payload.witness.capsule), group = byOriginalCapsule.get(key) ?? []
    group.push(payload); byOriginalCapsule.set(key, group)
  }
  const repeated = [...byOriginalCapsule.values()].filter(values => values.length > 1)
  assert.ok(repeated.length > 0)
  for (const values of repeated) {
    assert.equal(new Set(values.map(payload => payload.key)).size, values.length)
    assert.equal(new Set(values.map(payload => capsuleJson(payload.witness.domain))).size, values.length)
    for (const payload of values.slice(1)) assert.deepEqual(payload.input.knowledge, values[0].input.knowledge)
  }
  for (const prior of value.priorCoverage) {
    const original = value.nodes.find(node => capsuleJson(node.domain) === capsuleJson(prior.resolvedDomain))
    assert.ok(original); assert.deepEqual(original.root, prior.originalRoot)
    assert.equal(original.originalInputsHash, prior.originalInputsHash)
    assert.equal(prior.acceptedCoverage, false)
    assert.equal(prior.requirement.root.namespace.kind, 'native')
    assert.equal(prior.resolvedDomain.at(-1)!.namespace.kind, 'imported-bundle')
    assert.equal(prior.requirement.root.operationId, prior.originalRoot.operationId)
    assert.equal(prior.requirement.root.rootHash, prior.originalRoot.rootHash)
  }
  assert.equal(actual.semanticValidationComplete, false); assert.equal(actual.acceptedCoverage, false)
}
