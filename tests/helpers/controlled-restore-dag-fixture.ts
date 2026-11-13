import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal } from '../../src/main/database/restore-knowledge-capsule-files'
import { certifyDurableSqlCapsuleOriginal, readCertifiedDurableSqlCapsule } from '../../src/main/database/restore-knowledge-capsule-read'
import { restoreInventory } from '../../src/main/database/restore-safety-files'
import { captureDurableSqlDag, type CertifiedDurableSqlDag, type ReopenCertifiedDurableSqlDagInput } from '../../src/main/database/restore-knowledge-dag-read'
import { durableSqlDagLocator, validateDurableSqlDagNode,
  type DurableSqlCapsuleReference, type DurableSqlDagNode, type DurableSqlDagReference } from '../../src/main/database/restore-knowledge-dag-model'
import { createV3Fixture, type V3Fixture } from './synced-backup-v3-fixture'
// This static type edge also includes the real child entry in the test compiler;
// no tsconfig change or test-only runtime import is needed.
import type { DagReopenProcessResult } from './durable-sql-dag-reopen-process'

const execute = promisify(execFile)
const worker = fileURLToPath(new URL('./durable-sql-dag-reopen-process.ts', import.meta.url))
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const ordered = (refs: readonly DurableSqlDagReference[]) => [...refs].sort((a, b) => compare(durableSqlDagLocator(a), durableSqlDagLocator(b)))

export async function captureDirectory(profileRoot: string, operationId: string, sourceDirectory: string) {
  const recoveryDirectory = join(profileRoot, 'backups', 'database-restore', operationId)
  await mkdir(recoveryDirectory, { recursive: true })
  const sealedDirectory = join(recoveryDirectory, 'sealed-' + randomUUID()), capsuleId = randomUUID()
  await mkdir(sealedDirectory)
  const from = await realpath(sourceDirectory), inventory = await restoreInventory(from)
  // Source is genuinely independent and may be outside this Main profile. This
  // copies real fixed three-file originals, exactly as maintenance does.
  for (const file of inventory) if (file.present)
    await copyFile(join(from, file.name), join(sealedDirectory, file.name), constants.COPYFILE_EXCL)
  assert.deepEqual(await restoreInventory(sealedDirectory), inventory)
  assert.deepEqual(await restoreInventory(from), inventory)
  const original = await prepareDurableSqlCapsuleOriginal({ profileRoot, recoveryDirectory, sealedDirectory,
    capsuleId, label: 'real DAG original' })
  const capsule = await certifyDurableSqlCapsuleOriginal(original), seal = await readCertifiedDurableSqlCapsule(capsule)
  const info = readOwnedRawCapsuleOriginal(original)
  const ref: DurableSqlCapsuleReference = { kind: 'durable-sql-capsule-ref', version: 1, operationId, capsuleId, manifestHash: seal.manifestHash }
  return { capsule, seal, info, ref }
}
export async function setupPair(f: V3Fixture) {
  const started = performance.now()
  const profileRoot = await realpath(f.userDataRoot), operationId = randomUUID()
  const foreign = createV3Fixture(join(f.root, 'independent-DAG-source'))
  try {
    const ready = performance.now() - started
    // The two databases, sealed inputs, capsule IDs and scratch directories are
    // independent. Both captures still perform every original inventory,
    // identity, fsync and SQL certification check. Settle both before closing
    // either fixture, including when one fails.
    const elapsed: number[] = []
    const captures = await Promise.allSettled([dirname(foreign.file), dirname(f.file)].map(async (directory, index) => {
      const captured = await captureDirectory(profileRoot, operationId, directory)
      elapsed[index] = performance.now() - started
      return captured
    }))
    console.error(`[dag-pair-fixture] ${JSON.stringify({ readyMs: ready, sourceMs: elapsed[0] ?? null, currentMs: elapsed[1] ?? null, settledMs: performance.now() - started })}`)
    const failures = captures.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Both genuine independent capsule captures must finish before cleanup')
    const [left, right] = captures
    assert.equal(left.status, 'fulfilled'); assert.equal(right.status, 'fulfilled')
    const source = left.value, current = right.value
    assert.notEqual(source.seal.manifest.workspaceScope, current.seal.manifest.workspaceScope)
    assert.notEqual(foreign.groupId, f.groupId)
    assert.ok(source.seal.facts.some(fact => fact.family === 'host-create-ack'))
    assert.ok(current.seal.facts.some(fact => fact.family === 'host-create-ack'))
    assert.notDeepEqual(source.seal.facts, current.seal.facts, 'Different source/current facts come from actual independent Main writers')
    return { profileRoot, operationId, recoveryDirectory: join(profileRoot, 'backups', 'database-restore', operationId), source, current }
  } finally { foreign.close() }
}
type Pair = Awaited<ReturnType<typeof setupPair>>
export const node = (f: Pair, parents: readonly DurableSqlDagReference[] = []): DurableSqlDagNode => validateDurableSqlDagNode({
  kind: 'restore-durable-sql-dag-node', version: 1, readerVersion: 'knowbook-durable-sql-dag-v1', material: 'durable-sql-only',
  source: f.source.ref, current: f.current.ref, parents: ordered(parents) })
export async function capture(f: Pair, parents: readonly CertifiedDurableSqlDag[] = []) {
  return captureDurableSqlDag({ profileRoot: f.profileRoot, operationId: f.operationId, dagId: randomUUID(),
    source: f.source.capsule, current: f.current.capsule, parents })
}
export const input = (f: Pair, ref: DurableSqlDagReference): ReopenCertifiedDurableSqlDagInput => ({ profileRoot: f.profileRoot,
  operationId: ref.operationId, dagId: ref.dagId, expectedRootHash: ref.rootHash })
export async function child(f: Pair, ref: DurableSqlDagReference): Promise<DagReopenProcessResult> {
  const result = await execute(process.execPath, ['--import', 'tsx', worker, JSON.stringify(input(f, ref))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout) as DagReopenProcessResult
}
export async function immutableBytes(f: Pair) {
  const output: Array<{ path: string; bytes: Buffer }> = []
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const path = join(directory, entry.name)
      if (entry.name === 'scratch') continue
      assert.equal(entry.isSymbolicLink(), false)
      if (entry.isDirectory()) await walk(path)
      else { assert.ok(entry.isFile()); output.push({ path: relative(f.recoveryDirectory, path), bytes: await readFile(path) }) }
    }
  }
  await walk(f.source.info.capsuleDirectory); await walk(f.current.info.capsuleDirectory)
  await walk(join(f.recoveryDirectory, 'knowledge-dags'))
  return output
}
