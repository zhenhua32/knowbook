import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { prepareSyncWitnessPair, extractSyncWitnessMaterial, syncWitnessArtifactBytes, flipSameSizeTail, syncWitnessFailure } from './helpers/sync-witness-fixture'

test('synchronous witness hashes the final byte of a real multi-megabyte SQL original beyond many 64KiB chunks', () => withV3Fixture(async f => {
  f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('witness.ordinary-large-value', 'ordinary SQL padding '.repeat(160000), '2041-01-01T00:00:00.000Z')
  const checkpoint = f.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
  assert.equal(checkpoint[0].busy, 0, 'Actual SQLite frames are checkpointed into the real database')
  const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair), path = join(pair.current.info.originalDirectory, 'knowbook.db')
  const row = pair.current.inventory.find(row => row.name === 'knowbook.db')!
  assert.ok(row.bytes > 2 * 1024 * 1024 && row.bytes > 32 * 64 * 1024, 'This is a small real multi-megabyte DB, not a fabricated budget maximum')
  assert.equal(assertRootKnowledgeArtifactsFreshNow(material), undefined)
  const { bad } = await flipSameSizeTail(path)
  assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure)
  assert.deepEqual(await readFile(path), bad)
}))

test('a new-origin synchronous witness also checks the independent sealed input even when capsule originals and indexes are unchanged', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), material = await extractSyncWitnessMaterial(pair), before = await syncWitnessArtifactBytes(pair)
  const path = join(pair.source.info.sealedDirectory, 'knowbook.db'), { bad } = await flipSameSizeTail(path)
  assert.notEqual(pair.source.info.sealedDirectory, pair.source.info.originalDirectory)
  assert.throws(() => assertRootKnowledgeArtifactsFreshNow(material), syncWitnessFailure)
  assert.deepEqual(await readFile(path), bad)
  const after = await syncWitnessArtifactBytes(pair), changed = after.filter(row => !row.bytes.equals(before.find(old => old.path === row.path)!.bytes))
  assert.equal(changed.length, 1); assert.equal(join(pair.recoveryDirectory, changed[0].path), path, 'Only the sealed-only bad bytes changed')
}))
