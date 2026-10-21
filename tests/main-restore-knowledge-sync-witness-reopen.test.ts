import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { prepareSyncWitnessPair, extractSyncWitnessMaterial, removeSyncWitnessDirectory, syncWitnessFailure } from './helpers/sync-witness-fixture'
// Static compiler edge for the real child; no runtime import executes it here.
import type { SyncWitnessReopenResult } from './helpers/sync-witness-reopen-process'

const execute = promisify(execFile), worker = fileURLToPath(new URL('./helpers/sync-witness-reopen-process.ts', import.meta.url))
test('a new process really reopens durable SQL and extracts a new root before synchronous witnessing after all old scratch and sealed inputs are removed', () => withV3Fixture(async f => {
  const pair = await prepareSyncWitnessPair(f), oldMaterial = await extractSyncWitnessMaterial(pair), reads = join(pair.recoveryDirectory, 'knowledge-capsule-reads')
  assert.ok((await readdir(reads)).length > 0, 'Actual old K extraction created disposable scratch copies')
  for (const capture of pair.captures) {
    assert.equal(capture.info.scratchDirectory, join(capture.info.capsuleDirectory, 'scratch'))
    await removeSyncWitnessDirectory(capture.info.scratchDirectory, pair.profileRoot)
    await removeSyncWitnessDirectory(capture.info.sealedDirectory, pair.profileRoot)
  }
  await removeSyncWitnessDirectory(reads, pair.profileRoot)
  assert.throws(() => assertRootKnowledgeArtifactsFreshNow(oldMaterial), syncWitnessFailure, 'The old new-origin owner still requires its own removed inputs')
  const result = await execute(process.execPath, ['--import', 'tsx', worker, JSON.stringify({ profileRoot: pair.profileRoot,
    operationId: pair.root.operationId, dagId: pair.root.dagId, expectedRootHash: pair.root.rootHash })], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 1024 * 1024 })
  const child = JSON.parse(result.stdout) as SyncWitnessReopenResult
  assert.notEqual(child.pid, process.pid); assert.equal(child.witnessReturnedVoid, true); assert.equal(child.nodes, 1); assert.equal(child.capsules, 2)
  assert.equal((await readdir(reads)).length, 4, 'Two real DAG SQL reopens plus two fixed K extractions created genuine new-owner scratches')
  for (const capture of pair.captures) {
    await assert.rejects(lstat(capture.info.scratchDirectory), { code: 'ENOENT' })
    await assert.rejects(lstat(capture.info.sealedDirectory), { code: 'ENOENT' })
  }
}))
