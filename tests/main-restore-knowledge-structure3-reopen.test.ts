import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { importMixedOriginBundleOriginal } from '../src/main/database/restore-knowledge-mixed-origin-bundle-files'
import { readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { readCompleteOriginalPackage } from '../src/main/database/restore-knowledge-qualified-originals'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreStructureReferencePlan3, readRootRestoreStructureReferencePlan3 } from '../src/main/database/restore-knowledge-structure3-read'
import { graph3Rows } from '../src/main/database/restore-knowledge-graph3-data'
import { withContent3Fixture } from './helpers/content3-fixture'
import { allTables } from './helpers/synced-backup-v3-fixture'

test('structure candidates independently reconstruct every mapped original row after earlier originals and verification profiles retire', () => withContent3Fixture(async f => {
  const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
  const structure = await prepareRootRestoreStructureReferencePlan3(identity.plan)
  const expected = structure.value
  const mappedHost = identity.value.assignments.find(item => item.kind === 'document' && item.sourceId === f.source.hostId && item.physical)!
  assert.notEqual(mappedHost.targetId, f.source.hostId)
  assert.equal(graph3Rows({ tables: expected.tables, encoding: f.sourcePacket.source.sourceContent.encoding }, 'synced_instances')
    .some(row => row.value.host_document_id === mappedHost.targetId), true)
  assert.equal(expected.tables.length, 12)
  assert.equal(expected.referenceRewriteComplete, false)
  assert.equal(expected.permit, false)
  const oldLocation = await readRootKnowledgePlanLocation3(f.saved.knowledgePlan)
  const operationId = randomUUID()
  const imported = await importMixedOriginBundleOriginal(f.receiver.userDataRoot, operationId, f.saved.originalPackage.directory)
  const copiedIdentityDirectory = join(f.receiver.userDataRoot, 'backups', 'database-restore', operationId, 'restore-identity-plans-v3', identity.planId)
  await mkdir(copiedIdentityDirectory, { recursive: true })
  await copyFile(join(identity.directory, 'manifest.json'), join(copiedIdentityDirectory, 'manifest.json'))

  const oldOperation = join(f.receiver.userDataRoot, 'backups', 'database-restore', oldLocation.operationId)
  for (const [root, path] of [[f.source.userDataRoot, join(f.source.userDataRoot, 'backups')],
    [f.receiver.userDataRoot, oldOperation],
    [f.receiver.userDataRoot, join(f.receiver.userDataRoot, 'original-input-verification')]] as const) {
    const local = relative(root, path), actual = await lstat(path)
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
    assert.equal(actual.isSymbolicLink(), false)
    assert.equal(actual.isDirectory(), true)
    await rename(path, path + '-retired-' + randomUUID())
  }
  await assert.rejects(readCompleteOriginalPackage(f.saved.bundle))
  await assert.rejects(readRootRestoreIdentityPlan3(identity.plan))
  await assert.rejects(readRootRestoreStructureReferencePlan3(structure.plan))
  const beforeSource = allTables(f.source.db), beforeReceiver = allTables(f.receiver.db)
  const expectedPath = join(f.receiver.userDataRoot, 'expected-structure-' + randomUUID() + '.json')
  const expectedIdentityPath = join(f.receiver.userDataRoot, 'expected-identity-' + randomUUID() + '.json')
  await writeFile(expectedPath, JSON.stringify(expected), { flag: 'wx' })
  await writeFile(expectedIdentityPath, JSON.stringify(identity.value), { flag: 'wx' })
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', resolve('tests/helpers/structure3-process.cjs'), JSON.stringify({
      locator: { profileRoot: imported.profileRoot, operationId, mountId: imported.mountId, expectedDescriptorHash: imported.original.descriptorHash },
      identityLocator: { planId: identity.planId, expectedManifestHash: identity.manifestHash }, expectedPath, expectedIdentityPath
    })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
  const actual = JSON.parse(stdout)
  assert.notEqual(actual.pid, process.pid)
  assert.equal(actual.nodes, 1)
  assert.equal(actual.identityHash, identity.value.allocationHash)
  assert.equal(actual.structureHash, expected.structureReferenceHash)
  assert.deepEqual(allTables(f.source.db), beforeSource)
  assert.deepEqual(allTables(f.receiver.db), beforeReceiver)
}, source => {
  source.db.prepare('INSERT INTO backup_restore_identities(lineage,kind,source_database_id,source_id,state,target_id) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), 'document', '', randomUUID(), 'live', source.hostId)
}))
