import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { extractRequiredRootKnowledgeMaterial } from '../src/main/database/restore-knowledge-required-dag-read'
import { exportPreparedOriginBundle, importPreparedOriginBundle, readPreparedOriginBundle } from '../src/main/database/restore-knowledge-origin-bundle-read'
import { originBundleExpectedFiles } from '../src/main/database/restore-knowledge-origin-bundle-model'
import { parseRequiredSqlDagNode } from '../src/main/database/restore-knowledge-required-dag-model'
import { prepareFirstImportedQualifiedKnowledge, readPreparedFirstImportedQualifiedKnowledge } from '../src/main/database/restore-knowledge-qualified-first-bundle-read'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'
import { createV3Fixture, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('real verification original tamper invalidates its qualified owner even when the immutable mounted catalog stays unchanged', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), exported = await exportPreparedOriginBundle(await extractRequiredRootKnowledgeMaterial(pair.dag), { operationId: randomUUID(), bundleId: randomUUID() })
  const receiver = createV3Fixture(join(f.root, 'qualified-verification-receiver'))
  try {
    const bundle = await importPreparedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory })
    const mounted = await readPreparedOriginBundle(bundle), handle = await prepareFirstImportedQualifiedKnowledge(bundle)
    const collection = join(dirname(mounted.originalDirectory), 'verification-profiles'), profiles = await readdir(collection)
    assert.equal(profiles.length, 1, 'Only this import owns the verification material used here')
    const original = parseRequiredSqlDagNode(exported.descriptor.nodeText).current.capsule
    const file = join(collection, profiles[0], 'backups', 'database-restore', original.operationId, 'knowledge-capsules', original.capsuleId, 'original', 'knowbook.db')
    const catalogFile = originBundleExpectedFiles(exported.descriptor).find(item => item.path.endsWith('/' + original.capsuleId + '/original/knowbook.db'))!
    const catalogPath = join(mounted.originalDirectory, ...catalogFile.path.split('/')), before = await readFile(catalogPath)
    const bad = Buffer.from(await readFile(file)); bad[bad.length - 1] ^= 1; await writeFile(file, bad)
    await assert.rejects(readPreparedFirstImportedQualifiedKnowledge(handle), /bytes|hash|原件|capsule/)
    assert.deepEqual(await readFile(file), bad); assert.deepEqual(await readFile(catalogPath), before)
  } finally { receiver.close() }
}))
