import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { captureFirstRequiredSqlDag, extractRequiredRootKnowledgeMaterial, captureOwnedRequiredKnowledgeSource, readOwnedRequiredKnowledgeSource } from '../src/main/database/restore-knowledge-required-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureKnowledgeOriginal } from './helpers/restore-knowledge-payload-fixture'

test('real equal-manifest independent capsule locators remain two whole-source originals and either changed original rejects without repair', () => withV3Fixture(async f => {
  const operationId = randomUUID(), a = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file), operationId)
  const b = await captureKnowledgeOriginal(a.profileRoot, a.info.originalDirectory, operationId)
  assert.equal(a.ref.manifestHash, b.ref.manifestHash); assert.notEqual(a.ref.capsuleId, b.ref.capsuleId)
  const dag = await captureFirstRequiredSqlDag({ profileRoot: a.profileRoot, operationId, dagId: randomUUID(), source: a.capsule, current: b.capsule })
  const captured = await captureOwnedRequiredKnowledgeSource(await extractRequiredRootKnowledgeMaterial(dag)), value = await readOwnedRequiredKnowledgeSource(captured.source)
  assert.equal(value.inputs.length, 2); assert.equal(new Set(value.inputs.map(input => input.locator)).size, 2)
  assert.equal(new Set(value.inputs.map(input => input.projection.capsule.capsuleId)).size, 2)
  const file = join(b.info.originalDirectory, 'knowbook.db'), bad = Buffer.from(await readFile(file)); bad[bad.length - 1] ^= 1; await writeFile(file, bad)
  await assert.rejects(readOwnedRequiredKnowledgeSource(captured.source), /原件|capsule|bytes|hash/); assert.deepEqual(await readFile(file), bad)
}))
