import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { importMixedOriginBundleOriginal } from '../src/main/database/restore-knowledge-mixed-origin-bundle-files'
import { captureMixedRootKnowledgeConservationPlan3, readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreProvenanceSources3, readRootRestoreProvenanceSources3 } from '../src/main/database/restore-knowledge-provenance3-read'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { withV3Fixture, allTables, randomUUID } from './helpers/synced-backup-v3-fixture'

test('independent cold provenance readers recover exact create births and unresolved document origins from copied originals alone', () =>
  withV3Fixture(source => withV3Fixture(async receiver => {
    const left = await captureMixedSource(source, 2), right = await captureMixedSource(source, 2)
    const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
      operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
    const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
    const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot,
      operationId: randomUUID(), sourceDirectory: exported.directory })
    const identity = await prepareRootRestoreIdentityPlan3(saved.knowledgePlan)
    const { source: provenance, value } = await prepareRootRestoreProvenanceSources3(identity.plan)
    const own = value.origins.find(origin => origin.origin.firstInstanceId === source.instanceId)!
    assert.equal(own.firstInstance.status, 'proved-birth')
    assert.equal(own.document.status, 'unresolved')
    assert.equal(own.document.knownBirth, null)
    const oldLocation = await readRootKnowledgePlanLocation3(saved.knowledgePlan), operationId = randomUUID()
    const imported = await importMixedOriginBundleOriginal(receiver.userDataRoot, operationId, saved.originalPackage.directory)
    const copiedIdentity = join(receiver.userDataRoot, 'backups', 'database-restore', operationId, 'restore-identity-plans-v3', identity.planId)
    await mkdir(copiedIdentity, { recursive: true })
    await copyFile(join(identity.directory, 'manifest.json'), join(copiedIdentity, 'manifest.json'))
    for (const [root, path] of [[source.userDataRoot, join(source.userDataRoot, 'backups')],
      [receiver.userDataRoot, join(receiver.userDataRoot, 'backups', 'database-restore', oldLocation.operationId)],
      [receiver.userDataRoot, join(receiver.userDataRoot, 'original-input-verification')]] as const) {
      const local = relative(root, path), info = await lstat(path)
      assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
      assert.equal(info.isSymbolicLink(), false); assert.equal(info.isDirectory(), true)
      await rename(path, path + '-retired-' + randomUUID())
    }
    await assert.rejects(readRootRestoreProvenanceSources3(provenance))
    const beforeSource = allTables(source.db), beforeReceiver = allTables(receiver.db)
    const expectedPath = join(receiver.userDataRoot, 'expected-provenance-' + randomUUID() + '.json')
    await writeFile(expectedPath, JSON.stringify(value), { flag: 'wx' })
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/provenance3-process.cjs'), JSON.stringify({
        locator: { profileRoot: imported.profileRoot, operationId, mountId: imported.mountId, expectedDescriptorHash: imported.original.descriptorHash },
        identityLocator: { planId: identity.planId, expectedManifestHash: identity.manifestHash }, expectedPath
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    const actual = JSON.parse(stdout)
    assert.notEqual(actual.pid, process.pid)
    assert.equal(actual.provenanceSourceHash, value.provenanceSourceHash)
    assert.deepEqual(allTables(source.db), beforeSource); assert.deepEqual(allTables(receiver.db), beforeReceiver)
  })))
