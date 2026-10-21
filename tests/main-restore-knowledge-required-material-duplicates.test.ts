import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { captureFirstRequiredSqlDag, extractRequiredRootKnowledgeMaterial, readRequiredRootKnowledgeMaterial,
  assertRequiredRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-required-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureKnowledgeOriginal } from './helpers/restore-knowledge-payload-fixture'

test('required-v2 whole material and synchronous witness keep equal-hash independent capsule locators instead of deduplicating their real bytes', () => withV3Fixture(async f => {
  const operationId = randomUUID(), source = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file), operationId)
  const current = await captureKnowledgeOriginal(source.profileRoot, source.info.originalDirectory, operationId)
  assert.equal(source.ref.manifestHash, current.ref.manifestHash); assert.notEqual(source.ref.capsuleId, current.ref.capsuleId)
  const dag = await captureFirstRequiredSqlDag({ profileRoot: source.profileRoot, operationId, dagId: randomUUID(), source: source.capsule, current: current.capsule })
  const material = await extractRequiredRootKnowledgeMaterial(dag), value = await readRequiredRootKnowledgeMaterial(material)
  assert.equal(value.capsuleBindings.length, 2); assert.equal(value.union.payloads.length, 2)
  assert.equal(new Set(value.capsuleBindings.map(record => record.capsule.capsuleId)).size, 2)
  assert.equal(assertRequiredRootKnowledgeArtifactsFreshNow(material), undefined)
  const file = join(current.info.originalDirectory, 'knowbook.db'), bad = Buffer.from(await readFile(file)); bad[bad.length - 1] ^= 1
  await writeFile(file, bad)
  assert.throws(() => assertRequiredRootKnowledgeArtifactsFreshNow(material), /同步witness|原件|capsule|bytes/)
  assert.deepEqual(await readFile(file), bad)
}))
