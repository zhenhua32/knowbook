import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCertifiedRequiredSqlDag, reopenFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-required-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { knowledgeArtifactBytes } from './helpers/restore-knowledge-payload-fixture'
import { actualRequiredDagPair, removeRequiredDagFixtureDirectory } from './helpers/required-sql-dag-fixture'
import type { RequiredSqlDagChildResult } from './helpers/required-sql-dag-reopen-process'

const execute = promisify(execFile), worker = fileURLToPath(new URL('./helpers/required-sql-dag-reopen-process.ts', import.meta.url))
test('required DAG v2 real child reopens both complete SQL originals after old scratch and sealed inputs are removed without rewriting the root', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), before = await readFile(pair.file)
  const sourceBytes = await knowledgeArtifactBytes(pair.source), currentBytes = await knowledgeArtifactBytes(pair.current)
  for (const original of [pair.source, pair.current]) {
    await removeRequiredDagFixtureDirectory(original.info.scratchDirectory, pair.current.profileRoot)
    await removeRequiredDagFixtureDirectory(original.info.sealedDirectory, pair.current.profileRoot)
  }
  const response = await execute(process.execPath, ['--import', 'tsx', worker, JSON.stringify({ profileRoot: pair.input.profileRoot,
    operationId: pair.value.root.operationId, dagId: pair.value.root.dagId, expectedRootHash: pair.value.root.rootHash })],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 1024 * 1024 })
  const child = JSON.parse(response.stdout) as RequiredSqlDagChildResult
  assert.notEqual(child.pid, process.pid); assert.equal(child.prepared, true); assert.equal(child.accepted, false)
  assert.equal(child.capsules, 2); assert.equal(child.nodes, 1)
  assert.deepEqual(await readFile(pair.file), before)
  assert.deepEqual(await knowledgeArtifactBytes(pair.source), sourceBytes); assert.deepEqual(await knowledgeArtifactBytes(pair.current), currentBytes)
  for (const original of [pair.source, pair.current]) await assert.rejects(lstat(original.info.scratchDirectory), { code: 'ENOENT' })
}))

test('required DAG v2 refuses late original corruption and leaves all bad evidence in place', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), original = join(pair.current.info.originalDirectory, 'knowbook.db')
  const bad = Buffer.from(await readFile(original)); bad[bad.length - 1] ^= 1
  await writeFile(original, bad)
  await assert.rejects(readCertifiedRequiredSqlDag(pair.dag), /原件|capsule|清单|bytes/)
  await assert.rejects(reopenFirstRequiredSqlDag({ profileRoot: pair.input.profileRoot, operationId: pair.value.root.operationId,
    dagId: pair.value.root.dagId, expectedRootHash: pair.value.root.rootHash }), /原件|capsule|清单|bytes/)
  assert.deepEqual(await readFile(original), bad)
}))
