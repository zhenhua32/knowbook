import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { captureDurableSqlDag, readCertifiedDurableSqlDag, extractRootKnowledgeMaterial,
  type CertifiedDurableSqlDag } from '../../src/main/database/restore-knowledge-dag-read'
import { createV3Fixture, type V3Fixture } from './synced-backup-v3-fixture'
import { captureKnowledgeOriginal, type CapturedKnowledgeOriginal } from './restore-knowledge-payload-fixture'

/** Integration-only helper: true Main-created groups, fixed real original
 * capture/certifier/DAG/K APIs. No draft/fact loader or permission injection. */
export async function prepareSyncWitnessPair(f: V3Fixture) {
  const operationId = randomUUID(), foreign = createV3Fixture(join(f.root, 'sync-witness-foreign'))
  try {
    const source = await captureKnowledgeOriginal(f.userDataRoot, dirname(foreign.file), operationId)
    const current = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file), operationId)
    assert.notEqual(source.ref.capsuleId, current.ref.capsuleId)
    assert.notEqual(source.seal.manifest.workspaceScope, current.seal.manifest.workspaceScope)
    const dag = await captureDurableSqlDag({ profileRoot: current.profileRoot, operationId, dagId: randomUUID(), source: source.capsule, current: current.capsule, parents: [] })
    const root = (await readCertifiedDurableSqlDag(dag)).root
    return { profileRoot: current.profileRoot, operationId, recoveryDirectory: join(current.profileRoot, 'backups', 'database-restore', operationId),
      source, current, captures: [source, current] as CapturedKnowledgeOriginal[], dag, root }
  } finally { foreign.close() }
}
export type SyncWitnessPair = Awaited<ReturnType<typeof prepareSyncWitnessPair>>
export async function captureSyncWitnessHead(pair: SyncWitnessPair, parents: readonly CertifiedDurableSqlDag[]) {
  return captureDurableSqlDag({ profileRoot: pair.profileRoot, operationId: pair.operationId, dagId: randomUUID(),
    source: pair.source.capsule, current: pair.current.capsule, parents })
}
export const extractSyncWitnessMaterial = (pair: SyncWitnessPair, dag = pair.dag) => extractRootKnowledgeMaterial(dag)
export const syncWitnessFailure = /同步witness|DAG|capsule|原件|manifest|分片|闭集|句柄|ENOENT|no such file/i
export async function flipSameSizeTail(path: string) {
  const original = await readFile(path)
  assert.ok(original.length > 0)
  const bad = Buffer.from(original); bad[bad.length - 1] ^= 1
  await writeFile(path, bad)
  assert.equal((await lstat(path)).size, original.length)
  return { original, bad }
}
export async function syncWitnessArtifactBytes(pair: SyncWitnessPair) {
  const result: Array<{ path: string; bytes: Buffer }> = []
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'scratch') continue
      const path = join(directory, entry.name)
      assert.equal(entry.isSymbolicLink(), false)
      if (entry.isDirectory()) await walk(path)
      else { assert.ok(entry.isFile()); result.push({ path: relative(pair.recoveryDirectory, path), bytes: await readFile(path) }) }
    }
  }
  for (const capture of pair.captures) { await walk(capture.info.capsuleDirectory); await walk(capture.info.sealedDirectory) }
  await walk(join(pair.recoveryDirectory, 'knowledge-dags'))
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
/** Only an explicitly named descendant of this fixture's canonical profile;
 * validate resolved absolute identity before any recursive test cleanup. */
export async function removeSyncWitnessDirectory(directory: string, profileRoot: string) {
  const absolute = resolve(directory), child = relative(resolve(profileRoot), absolute)
  assert.ok(isAbsolute(directory) && child && child !== '..' && !child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(child))
  const actual = resolve(await realpath(absolute)), same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  assert.equal(same(actual, absolute), true)
  const info = await lstat(absolute); assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true)
  await rm(absolute, { recursive: true })
}
