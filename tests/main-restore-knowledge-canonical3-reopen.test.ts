import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { importMixedOriginBundleOriginal } from '../src/main/database/restore-knowledge-mixed-origin-bundle-files'
import { readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { prepareRootRestoreIdentityPlan3, readRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3, readRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { allTables, randomUUID } from './helpers/synced-backup-v3-fixture'
import { withCanonical3Fixture } from './helpers/canonical3-fixture'

test('independent cold canonical reference reopens both durable kernels and reconstructs exact candidate cells from copied source and current originals', () =>
  withCanonical3Fixture(async f => {
    const identity = await prepareRootRestoreIdentityPlan3(f.saved.knowledgePlan)
    const prepared = await prepareRootRestoreReferencePlan3(identity.plan,
      { originPolicy: 'isolate-incoming', anonymousValues: 'source' }), expected = prepared.value
    assert.equal(expected.allocation.baseIdentityAllocationHash, identity.value.allocationHash)
    assert.notEqual(expected.allocation.derivedReferenceAllocationHash, identity.value.allocationHash)
    assert.equal(expected.candidate.tables.length, 12)
    assert.ok(expected.candidate.canonicalEdits.length > 0)
    assert.ok(expected.candidate.activeGroupWires.length > 0)
    assert.equal(expected.allocation.referenceRewriteComplete, false)
    assert.equal(expected.allocation.permit, false)
    assert.equal(expected.candidate.materialization.actualStageLedgerWritten, false)
    assert.equal(expected.candidate.materialization.actualLifecycleRowsReady, false)
    assert.equal(expected.candidate.referenceRewriteComplete, false)
    assert.equal(expected.candidate.permit, false)

    const oldLocation = await readRootKnowledgePlanLocation3(f.saved.knowledgePlan), operationId = randomUUID()
    const imported = await importMixedOriginBundleOriginal(f.receiver.userDataRoot, operationId, f.saved.originalPackage.directory)
    assert.notEqual(operationId, oldLocation.operationId)
    // Both kernels keep their exact original bytes. The independently opened
    // bundle supplies the new operation location, never a caller allocation.
    for (const [collection, captured] of [['restore-identity-plans-v3', identity],
      ['restore-reference-plans-v3', prepared]] as const) {
      const copied = join(f.receiver.userDataRoot, 'backups', 'database-restore', operationId, collection, captured.planId)
      await mkdir(copied, { recursive: true })
      const from = join(captured.directory, 'manifest.json'), to = join(copied, 'manifest.json')
      const bytes = await readFile(from)
      await copyFile(from, to)
      assert.deepEqual(await readFile(to), bytes)
    }
    // Retire the early source backups and all parent's old-operation and
    // verification paths. The child receives only its new imported mount.
    for (const [root, path] of [[f.source.userDataRoot, join(f.source.userDataRoot, 'backups')],
      [f.receiver.userDataRoot, join(f.receiver.userDataRoot, 'backups', 'database-restore', oldLocation.operationId)],
      [f.receiver.userDataRoot, join(f.receiver.userDataRoot, 'original-input-verification')]] as const) {
      const rootPath = await realpath(root), from = await realpath(path), local = relative(rootPath, from), info = await lstat(path)
      assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
      assert.equal(info.isSymbolicLink(), false)
      assert.equal(info.isDirectory(), true)
      const to = from + '-retired-' + randomUUID()
      assert.equal(dirname(to), dirname(from))
      assert.ok(!relative(rootPath, to).startsWith('..'))
      await rename(from, to)
    }
    await assert.rejects(readRootRestoreIdentityPlan3(identity.plan))
    await assert.rejects(readRootRestoreReferencePlan3(prepared.plan))
    const expectedPath = join(f.receiver.userDataRoot, 'expected-canonical-reference-' + randomUUID() + '.json')
    await writeFile(expectedPath, JSON.stringify(expected), { flag: 'wx' })
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/canonical3-process.cjs'), JSON.stringify({
        locator: { profileRoot: imported.profileRoot, operationId, mountId: imported.mountId, expectedDescriptorHash: imported.original.descriptorHash },
        identityLocator: { planId: identity.planId, expectedManifestHash: identity.manifestHash },
        referenceLocator: { planId: prepared.planId, expectedManifestHash: prepared.manifestHash }, expectedPath
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    const actual = JSON.parse(stdout)
    assert.notEqual(actual.pid, process.pid)
    assert.equal(actual.tables, 12)
    assert.equal(actual.canonicalEdits, expected.candidate.canonicalEdits.length)
    assert.equal(actual.activeGroupWires, expected.candidate.activeGroupWires.length)
    assert.equal(actual.baseIdentityAllocationHash, identity.value.allocationHash)
    assert.equal(actual.derivedReferenceAllocationHash, expected.allocation.derivedReferenceAllocationHash)
    assert.equal(actual.canonicalCandidateHash, expected.candidate.canonicalCandidateHash)
    assert.equal(actual.checkedCanonicalCandidateHash, expected.candidate.checkedCanonicalCandidateHash)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }))
