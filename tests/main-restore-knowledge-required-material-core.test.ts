import assert from 'node:assert/strict'
import test from 'node:test'
import { captureDurableSqlDag, extractRootKnowledgeMaterial, assertRootKnowledgeArtifactsFreshNow,
  type RootKnowledgeMaterial } from '../src/main/database/restore-knowledge-dag-read'
import { extractCertifiedDurableSqlCapsuleKnowledge } from '../src/main/database/restore-knowledge-capsule-read'
import { unionCertifiedCapsuleKnowledge } from '../src/main/database/restore-knowledge-payload-read'
import { extractRequiredRootKnowledgeMaterial, readRequiredRootKnowledgeMaterial, assertRequiredRootKnowledgeArtifactsFreshNow,
  type CertifiedRequiredSqlDag, type RequiredRootKnowledgeMaterial } from '../src/main/database/restore-knowledge-required-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { knowledgeReadScratchCount } from './helpers/restore-knowledge-payload-fixture'

test('required-v2 private material extracts both real different-scope nonempty SQL payloads and binds qualified root origins and the full set', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), material = await extractRequiredRootKnowledgeMaterial(pair.dag)
  const value = await readRequiredRootKnowledgeMaterial(material)
  assert.equal(value.root.readerVersion, 'knowbook-required-sql-knowledge-dag-v2')
  assert.equal(value.capsuleBindings.length, 2); assert.equal(value.union.payloads.length, 2)
  assert.notEqual(value.union.payloads[0].workspaceScope, value.union.payloads[1].workspaceScope)
  assert.ok(value.union.payloads.every(payload => payload.groups.length > 0 && payload.hostJournals.length > 0), 'Both actual Main histories remain typed data; no empty/exact shortcut')
  for (const item of value.capsuleBindings) {
    assert.equal(item.capsule.namespace.kind, 'native', 'This is physical storage location, not a foreign original-domain claim')
    assert.equal(item.origin.kind, 'no-prior-coverage-references')
    assert.equal(item.binding.rawRequirementsHash, item.origin.rawRequirementsHash)
    assert.deepEqual(item.capsule, item.binding.capsule)
    assert.deepEqual(item.binding.requiredRoots, [])
  }
  assert.equal(value.acceptedCoverage, false); assert.equal(value.emptyKnowledgeProven, false)
  assert.ok(Object.isFrozen(value.capsuleBindings) && Object.isFrozen(value.capsuleBindings[0].origin))
  assert.equal(Reflect.set(value.capsuleBindings[0].binding, 'interpretationHash', '0'.repeat(64)), false)
  const scratches = await knowledgeReadScratchCount(pair.input.profileRoot, pair.input.operationId)
  assert.equal(assertRequiredRootKnowledgeArtifactsFreshNow(material), undefined)
  assert.equal(await knowledgeReadScratchCount(pair.input.profileRoot, pair.input.operationId), scratches, 'No synchronous SQL/reopen/scratch creation')
  assert.deepEqual(await readRequiredRootKnowledgeMaterial(material), value)
}))

test('required-v2 material and witness reject fake serialized subset-union and genuine prepared-v1 material identities', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), material = await extractRequiredRootKnowledgeMaterial(pair.dag), value = await readRequiredRootKnowledgeMaterial(material)
  const subset = await unionCertifiedCapsuleKnowledge([await extractCertifiedDurableSqlCapsuleKnowledge(pair.source.capsule)])
  const oldDag = await captureDurableSqlDag({ ...pair.input, parents: [] }), oldMaterial = await extractRootKnowledgeMaterial(oldDag)
  for (const candidate of [{ kind: 'required-root-bound-knowledge-material' }, JSON.parse(JSON.stringify(material)), JSON.parse(JSON.stringify(value)), subset, oldMaterial]) {
    assert.throws(() => assertRequiredRootKnowledgeArtifactsFreshNow(candidate as RequiredRootKnowledgeMaterial), /句柄/)
    await assert.rejects(readRequiredRootKnowledgeMaterial(candidate as RequiredRootKnowledgeMaterial), /句柄/)
  }
  for (const candidate of [subset, [pair.source.capsule], JSON.parse(JSON.stringify(pair.dag)), oldDag])
    await assert.rejects(extractRequiredRootKnowledgeMaterial(candidate as unknown as CertifiedRequiredSqlDag), /句柄/)
  assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material as unknown as RootKnowledgeMaterial), /句柄/)
  assert.equal(assertRequiredRootKnowledgeArtifactsFreshNow(material), undefined)
}))
