import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { prepareSyncWitnessPair, extractSyncWitnessMaterial, flipSameSizeTail, syncWitnessFailure } from './helpers/sync-witness-fixture'

for (const name of ['knowbook.db-wal', 'knowbook.db-shm'] as const)
  test('synchronous witness rereads the genuine archived ' + name + ' bytes rather than applying mutable scratch sidecar rules', () => withV3Fixture(async f => {
    f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('witness.real-wal-write', 'actual SQL row before raw capture', '2041-01-01T00:00:00.000Z')
    const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair), row = pair.current.inventory.find(row => row.name === name)!
    assert.equal(row.present, true); assert.ok(row.bytes > 0, 'The sidecar comes from a live real SQLite Store')
    const path = join(pair.current.info.originalDirectory, name), { bad } = await flipSameSizeTail(path)
    assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure)
    assert.deepEqual(await readFile(path), bad)
  }))
