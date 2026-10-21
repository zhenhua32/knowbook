import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createV3Fixture, type V3Fixture } from './synced-backup-v3-fixture'
import { captureKnowledgeOriginal } from './restore-knowledge-payload-fixture'
import { captureFirstRequiredSqlDag, readCertifiedRequiredSqlDag } from '../../src/main/database/restore-knowledge-required-dag-read'

export async function actualRequiredDagPair(f: V3Fixture) {
  const operationId = randomUUID(), foreign = createV3Fixture(join(f.root, 'required-foreign'))
  try {
    const source = await captureKnowledgeOriginal(f.userDataRoot, dirname(foreign.file), operationId)
    const current = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file), operationId)
    assert.notEqual(source.seal.manifest.workspaceScope, current.seal.manifest.workspaceScope)
    assert.ok(source.seal.manifest.evidenceIndex.entries > 0 && current.seal.manifest.evidenceIndex.entries > 0, 'Both actual Main create ACK histories are nonempty')
    const input = { profileRoot: current.profileRoot, operationId, dagId: randomUUID(), source: source.capsule, current: current.capsule }
    const dag = await captureFirstRequiredSqlDag(input), value = await readCertifiedRequiredSqlDag(dag)
    return { input, source, current, dag, value, file: join(current.profileRoot, 'backups', 'database-restore', operationId, 'knowledge-required-dags', input.dagId, 'root.json') }
  } finally { foreign.close() }
}
export async function removeRequiredDagFixtureDirectory(directory: string, profileRoot: string) {
  const absolute = resolve(directory), actual = await realpath(absolute), child = relative(resolve(profileRoot), absolute)
  const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  assert.ok(isAbsolute(directory) && child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
  assert.ok(same(resolve(actual), absolute)); assert.equal((await lstat(absolute)).isSymbolicLink(), false)
  assert.equal((await lstat(absolute)).isDirectory(), true)
  await rm(absolute, { recursive: true })
}
