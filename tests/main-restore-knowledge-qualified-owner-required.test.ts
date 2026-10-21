import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { knowledgePayloadHash } from '../src/main/database/restore-knowledge-payload-model'
import { extractRequiredRootKnowledgeMaterial, readRequiredRootKnowledgeMaterial, captureOwnedRequiredKnowledgeSource, readOwnedRequiredKnowledgeSource, type OwnedRequiredKnowledgeSource } from '../src/main/database/restore-knowledge-required-dag-read'
import { captureOwnedFirstImportedKnowledgeSource, readOwnedFirstImportedKnowledgeSource, type PreparedOriginBundle, type OwnedFirstImportedKnowledgeSource } from '../src/main/database/restore-knowledge-origin-bundle-read'
import { requiredDagCapsuleLocator } from '../src/main/database/restore-knowledge-required-dag-model'
import { prepareFirstImportedQualifiedKnowledge, readPreparedFirstImportedQualifiedKnowledge, type PreparedFirstImportedQualifiedKnowledge } from '../src/main/database/restore-knowledge-qualified-first-bundle-read'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { knowledgeArtifactBytes, knowledgeReadScratchCount } from './helpers/restore-knowledge-payload-fixture'

test('real required whole source joins every private input locator to its complete SQL projection and hot reads create no new SQL scratch', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), material = await extractRequiredRootKnowledgeMaterial(pair.dag)
  const old = await readRequiredRootKnowledgeMaterial(material), artifacts = [await knowledgeArtifactBytes(pair.source), await knowledgeArtifactBytes(pair.current)]
  const count = await knowledgeReadScratchCount(pair.current.profileRoot, pair.input.operationId)
  const captured = await captureOwnedRequiredKnowledgeSource(material), value = await readOwnedRequiredKnowledgeSource(captured.source)
  assert.deepEqual(captured.value, value); assert.equal(value.inputs.length, 2)
  assert.equal(await knowledgeReadScratchCount(pair.current.profileRoot, pair.input.operationId), count + 2, 'The fixed capture actually extracts both real SQL originals')
  for (const input of value.inputs) {
    const binding = old.capsuleBindings.find(item => requiredDagCapsuleLocator(item.binding) === input.locator)!
    const projection = old.union.payloads.find(item => item.capsule.operationId === input.capsule.operationId && item.capsule.capsuleId === input.capsule.capsuleId)!
    assert.ok(binding && projection); assert.deepEqual(input.binding, binding.binding); assert.deepEqual(input.origin, binding.origin)
    assert.deepEqual(input.projection, projection); assert.equal(input.projectionHash, knowledgePayloadHash(projection))
    assert.deepEqual(input.capsule, binding.capsule); assert.equal(input.role, input.locator === requiredDagCapsuleLocator(old.node.source) ? 'source' : 'current')
    assert.ok(projection.groups.length > 0 && projection.historicalMaterial.length > 0)
  }
  assert.equal(new Set(value.inputs.map(input => input.projection.workspaceScope)).size, 2)
  const afterCapture = await knowledgeReadScratchCount(pair.current.profileRoot, pair.input.operationId)
  assert.deepEqual(await readOwnedRequiredKnowledgeSource(captured.source), value)
  assert.equal(await knowledgeReadScratchCount(pair.current.profileRoot, pair.input.operationId), afterCapture)
  assert.equal(value.nodeText, capsuleJson(old.node)); assert.equal(value.sourceMaterialHash, old.materialHash)
  assert.deepEqual([await knowledgeArtifactBytes(pair.source), await knowledgeArtifactBytes(pair.current)], artifacts)
}))

test('all qualified opaque seams reject copied brands, caller projection arrays and diagnostic-shaped values before owner work', async () => {
  const fakeRequired = { kind: 'required-root-bound-knowledge-material' } as const, fakeBundle = { kind: 'prepared-origin-bundle' } as const
  await assert.rejects(captureOwnedRequiredKnowledgeSource(fakeRequired), /私有句柄/)
  for (const fake of [fakeBundle, JSON.parse(JSON.stringify(fakeBundle)), [], { payloads: [], root: {}, domainId: 'caller' }]) {
    await assert.rejects(captureOwnedFirstImportedKnowledgeSource(fake as PreparedOriginBundle), /私有句柄/)
    await assert.rejects(prepareFirstImportedQualifiedKnowledge(fake as PreparedOriginBundle), /私有句柄/)
  }
  await assert.rejects(readOwnedRequiredKnowledgeSource({ kind: 'owned-required-whole-knowledge-source' } as OwnedRequiredKnowledgeSource), /私有句柄/)
  await assert.rejects(readOwnedFirstImportedKnowledgeSource({ kind: 'owned-first-imported-whole-knowledge-source' } as OwnedFirstImportedKnowledgeSource), /私有句柄/)
  await assert.rejects(readPreparedFirstImportedQualifiedKnowledge({ kind: 'prepared-first-imported-qualified-knowledge' } as PreparedFirstImportedQualifiedKnowledge), /私有句柄/)
})
