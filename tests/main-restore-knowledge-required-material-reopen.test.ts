import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extractRequiredRootKnowledgeMaterial, assertRequiredRootKnowledgeArtifactsFreshNow } from '../src/main/database/restore-knowledge-required-dag-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { knowledgeArtifactBytes } from './helpers/restore-knowledge-payload-fixture'
import { actualRequiredDagPair, removeRequiredDagFixtureDirectory } from './helpers/required-sql-dag-fixture'
import type { RequiredRootMaterialChildResult } from './helpers/required-root-material-reopen-process'

const execute = promisify(execFile), worker = fileURLToPath(new URL('./helpers/required-root-material-reopen-process.ts', import.meta.url))
test('a real new process reopens required-v2 SQL and extracts its own complete material before witnessing after old private inputs are removed', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), oldMaterial = await extractRequiredRootKnowledgeMaterial(pair.dag), node = await readFile(pair.file)
  const source = await knowledgeArtifactBytes(pair.source), current = await knowledgeArtifactBytes(pair.current)
  for (const original of [pair.source, pair.current]) {
    await removeRequiredDagFixtureDirectory(original.info.scratchDirectory, pair.input.profileRoot)
    await removeRequiredDagFixtureDirectory(original.info.sealedDirectory, pair.input.profileRoot)
  }
  assert.throws(() => assertRequiredRootKnowledgeArtifactsFreshNow(oldMaterial), /ENOENT|no such file|原件|同步witness/)
  const result = await execute(process.execPath, ['--import', 'tsx', worker, JSON.stringify({ profileRoot: pair.input.profileRoot,
    operationId: pair.value.root.operationId, dagId: pair.value.root.dagId, expectedRootHash: pair.value.root.rootHash })],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 1024 * 1024 })
  const child = JSON.parse(result.stdout) as RequiredRootMaterialChildResult
  assert.notEqual(child.pid, process.pid); assert.equal(child.witnessReturnedVoid, true); assert.equal(child.capsules, 2)
  assert.ok(child.groups > 0); assert.equal(child.acceptedCoverage, false)
  assert.deepEqual(await readFile(pair.file), node)
  assert.deepEqual(await knowledgeArtifactBytes(pair.source), source); assert.deepEqual(await knowledgeArtifactBytes(pair.current), current)
}))
