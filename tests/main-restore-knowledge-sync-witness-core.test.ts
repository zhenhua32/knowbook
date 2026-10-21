import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { captureDurableSqlDag, readRootKnowledgeMaterial, assertRootKnowledgeArtifactsFreshNow,
  type RootKnowledgeMaterial } from '../src/main/database/restore-knowledge-dag-read'
import { unionCertifiedCapsuleKnowledge } from '../src/main/database/restore-knowledge-payload-read'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { readSyncedPublicationCapture, type SyncedPublicationCapture } from '../src/main/database/synced-publication'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureKnowledgeOriginal, extractKnowledge, knowledgeReadScratchCount } from './helpers/restore-knowledge-payload-fixture'
import { prepareSyncWitnessPair, captureSyncWitnessHead, extractSyncWitnessMaterial, syncWitnessArtifactBytes, flipSameSizeTail, syncWitnessFailure } from './helpers/sync-witness-fixture'

test('synchronous prepared witness checks the complete real shared diamond and both equal-hash distinct original locators without granting permission', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), duplicate = await captureKnowledgeOriginal(pair.profileRoot, pair.source.info.originalDirectory, pair.operationId)
  assert.equal(duplicate.ref.manifestHash, pair.source.ref.manifestHash); assert.notEqual(duplicate.ref.capsuleId, pair.source.ref.capsuleId)
  pair.captures.push(duplicate)
  const left = await captureSyncWitnessHead(pair, [pair.dag])
  const right = await captureDurableSqlDag({ profileRoot: pair.profileRoot, operationId: pair.operationId, dagId: randomUUID(),
    source: duplicate.capsule, current: pair.current.capsule, parents: [pair.dag] })
  const head = await captureSyncWitnessHead(pair, [left, right]), material = await extractSyncWitnessMaterial(pair, head), data = await readRootKnowledgeMaterial(material)
  assert.equal(data.capsules.length, 3); assert.deepEqual(data.capsules.map(capsuleJson).sort(), pair.captures.map(item => capsuleJson(item.ref)).sort())
  const before = await syncWitnessArtifactBytes(pair), reads = await knowledgeReadScratchCount(pair.profileRoot, pair.operationId)
  const total = f.db.prepare('SELECT total_changes() AS value').get()
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined, 'The witness is synchronous void, not a Promise or permit')
  assert.equal(data.preparedEvidence, true)
  assert.equal(readSyncedPublicationCapture(material as unknown as SyncedPublicationCapture), null)
  assert.deepEqual(f.db.prepare('SELECT total_changes() AS value').get(), total)
  assert.equal(await knowledgeReadScratchCount(pair.profileRoot, pair.operationId), reads, 'A witness does not reopen SQL or create a scratch')
  assert.deepEqual(await syncWitnessArtifactBytes(pair), before)
  const path = join(duplicate.info.originalDirectory, 'knowbook.db'), { bad } = await flipSameSizeTail(path)
  assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure, 'Equal hashes never discard the second physical locator')
  assert.deepEqual(await readFile(path), bad)
}))

test('synchronous witness refuses fabricated, JSON data and genuine subset union identities before they can stand for a whole root', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair), data = await readRootKnowledgeMaterial(material)
  const subset = await unionCertifiedCapsuleKnowledge([(await extractKnowledge(pair.source)).handle])
  const before = await syncWitnessArtifactBytes(pair)
  for (const value of [Object.freeze({ kind: 'root-bound-knowledge-material' }), JSON.parse(JSON.stringify(material)), JSON.parse(JSON.stringify(data)), subset])
    assert.throws(() => assertRootKnowledgeArtifactsFreshNow(value as RootKnowledgeMaterial), /句柄/)
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined)
  assert.deepEqual(await syncWitnessArtifactBytes(pair), before)
}))

test('an independent same-byte inode replacement before a synchronous witness remains valid when each real read has stable standalone identity', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair)
  const path = join(pair.current.info.originalDirectory, 'knowbook.db'), replacement = join(pair.recoveryDirectory, 'same-byte-replacement-' + randomUUID() + '.db')
  const before = await syncWitnessArtifactBytes(pair), old = await lstat(path, { bigint: true })
  await copyFile(path, replacement, constants.COPYFILE_EXCL)
  const independent = await lstat(replacement, { bigint: true })
  assert.equal(independent.nlink, 1n); assert.notEqual(independent.ino, old.ino, 'Both real files coexist before replacement')
  await rename(replacement, path)
  assert.equal((await lstat(path, { bigint: true })).ino, independent.ino)
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined, 'Content authority never pins one old machine inode across calls')
  assert.deepEqual(await syncWitnessArtifactBytes(pair), before)
}))
