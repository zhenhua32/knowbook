import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { knowledgePayloadHash } from '../src/main/database/restore-knowledge-payload-model'
import { extractRequiredRootKnowledgeMaterial, readRequiredRootKnowledgeMaterial } from '../src/main/database/restore-knowledge-required-dag-read'
import { exportPreparedOriginBundle, importPreparedOriginBundle, readPreparedOriginBundle } from '../src/main/database/restore-knowledge-origin-bundle-read'
import { originBundleExpectedFiles } from '../src/main/database/restore-knowledge-origin-bundle-model'
import { requiredDagCapsuleLocator } from '../src/main/database/restore-knowledge-required-dag-model'
import { prepareFirstImportedQualifiedKnowledge, readPreparedFirstImportedQualifiedKnowledge } from '../src/main/database/restore-knowledge-qualified-first-bundle-read'
import { qualifiedKnowledgePayload2Hash } from '../src/main/database/restore-knowledge-qualified-payload-model'
import { qualifiedKnowledgeUnion2Hash } from '../src/main/database/restore-knowledge-qualified-union-model'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { createV3Fixture, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { knowledgeArtifactBytes } from './helpers/restore-knowledge-payload-fixture'

test('one actual imported first bundle builds full qualified material from its exact two projections while preserving native history and receiver collision bytes', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), oldMaterial = await extractRequiredRootKnowledgeMaterial(pair.dag), old = await readRequiredRootKnowledgeMaterial(oldMaterial)
  const exported = await exportPreparedOriginBundle(oldMaterial, { operationId: randomUUID(), bundleId: randomUUID() })
  const originalBytes = [await knowledgeArtifactBytes(pair.source), await knowledgeArtifactBytes(pair.current)], originalNode = await readFile(pair.file)
  const receiver = createV3Fixture(join(f.root, 'qualified-whole-receiver'))
  try {
    const ref = old.node.source.capsule, trap = join(receiver.userDataRoot, 'backups', 'database-restore', ref.operationId, 'knowledge-capsules', ref.capsuleId)
    await mkdir(trap, { recursive: true }); await writeFile(join(trap, 'manifest.json'), 'unrelated receiver native original')
    const bundle = await importPreparedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
    const mounted = await readPreparedOriginBundle(bundle), paths = ['descriptor.json', ...originBundleExpectedFiles(exported.descriptor).map(file => file.path)]
    const catalog = () => Promise.all(paths.map(async path => ({ path, bytes: await readFile(join(mounted.originalDirectory, ...path.split('/'))) })))
    const before = await catalog(), handle = await prepareFirstImportedQualifiedKnowledge(bundle), value = await readPreparedFirstImportedQualifiedKnowledge(handle)
    assert.equal(value.descriptorHash, mounted.descriptorHash); assert.deepEqual(value.root, mounted.root)
    assert.deepEqual(value.originalRoot, exported.descriptor.root); assert.equal(value.originalNodeText, exported.descriptor.nodeText)
    assert.equal(value.scope, 'one-actual-first-bundle-whole-private-map'); assert.equal(value.inputBindings.length, 2); assert.equal(value.union.payloads.length, 2)
    assert.equal(value.sourceMaterialHash, old.materialHash); assert.ok(value.union.groups.length > 0)
    for (const input of value.inputBindings) {
      const original = old.capsuleBindings.find(record => requiredDagCapsuleLocator(record.binding) === input.locator)!
      const envelope = value.union.payloads.find(item => item.capsule.operationId === input.capsule.operationId && item.capsule.capsuleId === input.capsule.capsuleId)!
      const projection = old.union.payloads.find(item => item.capsule.operationId === input.capsule.operationId && item.capsule.capsuleId === input.capsule.capsuleId)!
      assert.ok(original && envelope && projection); assert.deepEqual(input.originalCapsule, original.capsule)
      assert.deepEqual(envelope.originalBinding, original.binding); assert.deepEqual(envelope.originalOrigin, original.origin)
      assert.deepEqual(envelope.projection, projection, 'Every original row, typed support and nested historical body remains exact')
      assert.equal(envelope.projectionHash, knowledgePayloadHash(projection)); assert.equal(input.payloadHash, qualifiedKnowledgePayload2Hash(envelope))
      assert.equal(envelope.originalBinding.capsule.namespace.kind, 'native'); assert.equal(envelope.capsule.readerVersion, 'knowbook-durable-sql-v1')
      assert.deepEqual(envelope.capsule.namespace, { kind: 'imported-bundle', mountId: mounted.mountId, bundleDescriptorHash: mounted.descriptorHash })
    }
    for (const group of value.union.groups) for (const variant of group.variants) assert.deepEqual(variant.origin.capsule.namespace, value.root.namespace)
    for (const ambiguity of value.union.mappingAmbiguities) for (const field of ambiguity.fields) for (const alternative of field.alternatives)
      assert.ok(alternative.capsules.every(ref => capsuleJson(ref.namespace) === capsuleJson(value.root.namespace)))
    assert.equal(value.unionHash, qualifiedKnowledgeUnion2Hash(value.union.payloads))
    for (const object of [value, value.union, ...value.union.payloads]) {
      assert.equal(object.certified, false); assert.equal(object.acceptedCoverage, false); assert.equal(object.effective, false); assert.equal(object.permit, false)
    }
    assert.equal(value.fullRootInputSetProven, false); assert.equal(value.union.fullRootInputSetProven, false)
    assert.equal(value.emptyKnowledgeProven, false); assert.equal(value.fullNonemptyAncestorSupport, false)
    assert.deepEqual(await catalog(), before); assert.equal(await readFile(join(trap, 'manifest.json'), 'utf8'), 'unrelated receiver native original')
    assert.deepEqual([await knowledgeArtifactBytes(pair.source), await knowledgeArtifactBytes(pair.current)], originalBytes); assert.deepEqual(await readFile(pair.file), originalNode)
    assert.ok(Object.isFrozen(value.union.payloads[0].projection)); assert.equal(Reflect.set(value.root.namespace, 'mountId', randomUUID()), false)
  } finally { receiver.close() }
}))
