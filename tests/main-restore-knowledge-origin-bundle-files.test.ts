import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { captureFirstRequiredSqlDag, extractRequiredRootKnowledgeMaterial } from '../src/main/database/restore-knowledge-required-dag-read'
import { exportPreparedOriginBundle, importPreparedOriginBundle, readPreparedOriginBundle, reopenPreparedOriginBundle } from '../src/main/database/restore-knowledge-origin-bundle-read'
import { originBundleExpectedFiles } from '../src/main/database/restore-knowledge-origin-bundle-model'
import { captureKnowledgeOriginal } from './helpers/restore-knowledge-payload-fixture'
import { createV3Fixture, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { actualRequiredDagPair } from './helpers/required-sql-dag-fixture'

test('actual first bundle keeps same-hash distinct capsule locators and reopens its immutable original without rewriting old verification data', () => withV3Fixture(async f => {
  const operationId = randomUUID(), source = await captureKnowledgeOriginal(f.userDataRoot, dirname(f.file), operationId)
  const current = await captureKnowledgeOriginal(source.profileRoot, source.info.originalDirectory, operationId)
  assert.equal(source.ref.manifestHash, current.ref.manifestHash); assert.notEqual(source.ref.capsuleId, current.ref.capsuleId)
  const dag = await captureFirstRequiredSqlDag({ profileRoot: source.profileRoot, operationId, dagId: randomUUID(), source: source.capsule, current: current.capsule })
  const exported = await exportPreparedOriginBundle(await extractRequiredRootKnowledgeMaterial(dag), { operationId: randomUUID(), bundleId: randomUUID() })
  const receiver = createV3Fixture(join(f.root, 'origin-bundle-reopen'))
  try {
    const imported = await importPreparedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory }), value = await readPreparedOriginBundle(imported)
    assert.equal(value.capsules.length, 2); assert.equal(value.capsules[0].manifestHash, value.capsules[1].manifestHash); assert.notEqual(value.capsules[0].capsuleId, value.capsules[1].capsuleId)
    const paths = ['descriptor.json', ...originBundleExpectedFiles(exported.descriptor).map(file => file.path)]
    const before = await Promise.all(paths.map(path => readFile(join(value.originalDirectory, ...path.split('/')))))
    const reopened = await reopenPreparedOriginBundle({ profileRoot: value.profileRoot, operationId: value.operationId, mountId: value.mountId, expectedDescriptorHash: value.descriptorHash })
    assert.notEqual(imported, reopened); assert.deepEqual(await readPreparedOriginBundle(reopened), value)
    assert.deepEqual(await Promise.all(paths.map(path => readFile(join(value.originalDirectory, ...path.split('/'))))), before)
    await assert.rejects(reopenPreparedOriginBundle({ profileRoot: value.profileRoot, operationId: value.operationId, mountId: value.mountId, expectedDescriptorHash: '0'.repeat(64) }), /hash/)
  } finally { receiver.close() }
}))

test('complete catalog import rejects an extra empty rollback journal and never repairs the source artifact', () => withV3Fixture(async f => {
  const pair = await actualRequiredDagPair(f), exported = await exportPreparedOriginBundle(await extractRequiredRootKnowledgeMaterial(pair.dag), { operationId: randomUUID(), bundleId: randomUUID() })
  const db = originBundleExpectedFiles(exported.descriptor).find(file => file.path.endsWith('/original/knowbook.db'))!
  const journal = join(exported.directory, ...db.path.split('/')) + '-journal'; await writeFile(journal, Buffer.alloc(0))
  const receiver = createV3Fixture(join(f.root, 'origin-bundle-invalid'))
  try {
    await assert.rejects(importPreparedOriginBundle({ profileRoot: receiver.userDataRoot, operationId: randomUUID(), sourceDirectory: exported.directory }), /额外|journal/)
    assert.equal((await readFile(journal)).length, 0)
  } finally { receiver.close() }
}))
