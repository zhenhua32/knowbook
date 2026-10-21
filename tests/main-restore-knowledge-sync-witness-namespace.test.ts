import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-dag-read'
import { readDurableSqlDagNodeFile } from '../src/main/database/restore-knowledge-dag-files'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { prepareSyncWitnessPair, extractSyncWitnessMaterial, syncWitnessArtifactBytes, syncWitnessFailure } from './helpers/sync-witness-fixture'

test('synchronous witness refuses a missing actual original database and never recreates it', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair), path = join(pair.current.info.originalDirectory, 'knowbook.db')
  await unlink(path)
  const before = await syncWitnessArtifactBytes(pair)
  assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.deepEqual(await syncWitnessArtifactBytes(pair), before)
}))

test('synchronous witness enforces capsule, original, index and DAG closed namespaces including an empty rollback journal', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair), node = await readDurableSqlDagNodeFile(pair.profileRoot, pair.root)
  const probes = [
    { path: join(pair.source.info.capsuleDirectory, 'pending.json'), bytes: Buffer.from('{}') },
    { path: join(pair.source.info.originalDirectory, 'knowbook.db-journal'), bytes: Buffer.alloc(0) },
    { path: join(pair.source.seal.shardsDirectory, 'unknown.json'), bytes: Buffer.from('{}') },
    { path: join(dirname(node.path), 'pending.json'), bytes: Buffer.from('{}') }
  ]
  for (const probe of probes) {
    await writeFile(probe.path, probe.bytes, { flag: 'wx' })
    assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure)
    assert.deepEqual(await readFile(probe.path), probe.bytes, 'The witness preserved the exact bad file, including zero-byte journals')
    // Test-owned probe cleanup between separate namespace checks; production
    // never repairs/removes any of these files.
    await unlink(probe.path)
    assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined)
  }
}))
