import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exportPreparedOriginBundle, importPreparedOriginBundle, readPreparedOriginBundle,
  type PreparedOriginBundle } from '../src/main/database/restore-knowledge-origin-bundle-read'
import { originBundleExpectedFiles } from '../src/main/database/restore-knowledge-origin-bundle-model'
import { extractRequiredRootKnowledgeMaterial } from '../src/main/database/restore-knowledge-required-dag-read'
import { parseRequiredSqlDagNode } from '../src/main/database/restore-knowledge-required-dag-model'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { createV3Fixture, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { knowledgeArtifactBytes } from './helpers/restore-knowledge-payload-fixture'

test('real first required material exports and imports across two profiles with nonempty different-scope knowledge and its original interpretation domain', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), material = await extractRequiredRootKnowledgeMaterial(pair.dag)
  const before = [await knowledgeArtifactBytes(pair.source), await knowledgeArtifactBytes(pair.current)], node = await readFile(pair.file)
  const exported = await exportPreparedOriginBundle(material, { operationId: randomUUID(), bundleId: randomUUID() })
  const receiver = createV3Fixture(join(f.root, 'origin-bundle-receiver'))
  try {
    // A local native collision is unrelated data, not a fake ACK/proof. The
    // importer must use its own verified catalog instead of this local path.
    const original = parseRequiredSqlDagNode(exported.descriptor.nodeText).source.capsule
    const trap = join(receiver.userDataRoot, 'backups', 'database-restore', original.operationId, 'knowledge-capsules', original.capsuleId)
    await mkdir(trap, { recursive: true }); await writeFile(join(trap, 'manifest.json'), 'local native path is not an origin resolver')
    const handle = await importPreparedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
    const value = await readPreparedOriginBundle(handle)
    assert.equal(value.descriptorHash, exported.descriptorHash); assert.equal(value.root.namespace.kind, 'imported-bundle')
    assert.equal(value.originalRoot.namespace.kind, 'native'); assert.deepEqual(value.originalRoot, exported.descriptor.root)
    assert.equal(value.originalNodeText, exported.descriptor.nodeText); assert.equal(value.capsules.length, 2); assert.ok(value.groups > 0)
    assert.equal(value.acceptedCoverage, false); assert.equal(value.effectivePermit, false); assert.equal(value.fullNonemptyAncestorSupport, false)
    assert.ok(value.capsules.every(ref => ref.namespace.kind === 'imported-bundle' && ref.namespace.mountId === value.mountId))
    assert.equal(value.interpretation.databaseFilesHashes.length, 2); assert.ok(value.interpretation.requiredRootReferences.every(roots => roots.length === 0))
    assert.ok(Object.isFrozen(value.root.namespace)); assert.equal(Reflect.set(value.root.namespace, 'mountId', randomUUID()), false)
    for (const fake of [{ kind: 'prepared-origin-bundle' }, JSON.parse(JSON.stringify(handle)), value])
      await assert.rejects(readPreparedOriginBundle(fake as PreparedOriginBundle), /私有句柄/)
    await assert.rejects(importPreparedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory,
      capsuleMap: new Map() } as Parameters<typeof importPreparedOriginBundle>[0]), /闭集/)
    assert.deepEqual([await knowledgeArtifactBytes(pair.source), await knowledgeArtifactBytes(pair.current)], before)
    assert.deepEqual(await readFile(pair.file), node)
  } finally { receiver.close() }
}))

test('two actual imports preserve same UUIDs as independent mounts and late bytes in one mount cannot borrow the other mount or local native artifacts', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), exported = await exportPreparedOriginBundle(await extractRequiredRootKnowledgeMaterial(pair.dag), { operationId: randomUUID(), bundleId: randomUUID() })
  const receiver = createV3Fixture(join(f.root, 'origin-bundle-two-mounts'))
  try {
    const input = { profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory }
    const first = await importPreparedOriginBundle(input), second = await importPreparedOriginBundle(input)
    const a = await readPreparedOriginBundle(first), b = await readPreparedOriginBundle(second)
    assert.notEqual(a.mountId, b.mountId); assert.equal(a.descriptorHash, b.descriptorHash)
    assert.equal(a.root.operationId, b.root.operationId); assert.equal(a.root.dagId, b.root.dagId); assert.notDeepEqual(a.root.namespace, b.root.namespace)
    const db = originBundleExpectedFiles(exported.descriptor).find(file => file.path.endsWith('/original/knowbook.db'))!
    const pathA = join(a.originalDirectory, ...db.path.split('/')), pathB = join(b.originalDirectory, ...db.path.split('/'))
    const original = await readFile(pathB), bad = Buffer.from(await readFile(pathA)); bad[bad.length - 1] ^= 1; await writeFile(pathA, bad)
    await assert.rejects(readPreparedOriginBundle(first), /bytes|hash/)
    assert.equal((await readPreparedOriginBundle(second)).mountId, b.mountId)
    assert.deepEqual(await readFile(pathA), bad); assert.deepEqual(await readFile(pathB), original)
  } finally { receiver.close() }
}))
