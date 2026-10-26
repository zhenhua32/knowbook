import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { importMixedOriginBundleOriginal } from '../src/main/database/restore-knowledge-mixed-origin-bundle-files'
import { readRootKnowledgePlanLocation3 } from '../src/main/database/restore-knowledge-root3-read'
import { readRootRestoreIdentityPlan3 } from '../src/main/database/restore-knowledge-identity3-read'
import { readRootRestoreReferencePlan3 } from '../src/main/database/restore-knowledge-reference3-read'
import { reopenRootRestoreCurrentCopy3, readRootRestoreCurrentCopy3 } from '../src/main/database/restore-knowledge-stage3-current-copy'
import { prepareRootRestorePhysicalStage3, readRootRestorePhysicalStage3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { readOriginCatalogFile, copyOriginCatalogFile } from '../src/main/database/restore-knowledge-origin-bundle-files'
import { restoreDirectory } from '../src/main/database/restore-safety-files'
import { validateDurableSqlCapsuleInventory, type DurableSqlCapsuleFile } from '../src/main/database/restore-knowledge-capsule-model'
import { withStage3Fixture } from './helpers/stage3-fixture'
import { withV3Fixture, allTables, randomUUID } from './helpers/synced-backup-v3-fixture'

async function transportFile(from: string, fromRoot: string, to: string, toRoot: string) {
  const original = await readOriginCatalogFile(from, fromRoot)
  await copyOriginCatalogFile(from, fromRoot, to, toRoot,
    { path: 'test-cold-transport', bytes: original.bytes, sha256: original.sha256 })
}
async function transportTree(from: string, fromRoot: string, to: string, toRoot: string,
  smallFiles: readonly string[], inventory: readonly DurableSqlCapsuleFile[], checks: boolean) {
  await restoreDirectory(dirname(to), toRoot)
  await restoreDirectory(to, toRoot, true)
  await restoreDirectory(join(to, 'database'), toRoot, true)
  if (checks) await restoreDirectory(join(to, 'checks'), toRoot, true)
  for (const name of smallFiles) await transportFile(join(from, name), fromRoot, join(to, name), toRoot)
  for (const file of inventory) if (file.present)
    await transportFile(join(from, 'database', file.name), fromRoot, join(to, 'database', file.name), toRoot)
}
async function retire(root: string, path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return false
  const canonical = await realpath(root), from = await realpath(path), local = relative(canonical, from)
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local))
  assert.equal(info.isDirectory(), true); assert.equal(info.isSymbolicLink(), false)
  const to = from + '-retired-' + randomUUID()
  assert.equal(dirname(to), dirname(from)); assert.ok(!relative(canonical, to).startsWith('..'))
  await rename(from, to)
  return true
}

test('independent cold physical stage reopens the same reference and current copy in a new profile without earlier operation or verification paths',
  { timeout: 120_000 }, () => withStage3Fixture(f => withV3Fixture(async cold => {
    const physical = await prepareRootRestorePhysicalStage3(f.prepared.plan)
    assert.equal(physical.value.tables.length, 12)
    assert.ok(physical.value.lifecycleAdded.length > 0)
    assert.equal(physical.value.currentStageComplete, false)
    assert.equal(physical.value.historyCutComplete, false)
    assert.equal(physical.value.installPermit, false)
    const intent = JSON.parse(await readFile(join(physical.directory, 'intent.json'), 'utf8')) as {
      copyId: string; copyManifestHash: string
    }
    const copied = await reopenRootRestoreCurrentCopy3(f.prepared.plan,
      { copyId: intent.copyId, expectedManifestHash: intent.copyManifestHash })
    const stageManifest = JSON.parse(await readFile(join(physical.directory, 'manifest.json'), 'utf8')) as {
      sealedInventory: unknown
    }
    const stageInventory = validateDurableSqlCapsuleInventory(stageManifest.sealedInventory)
    const beforeCold = allTables(cold.db)
    assert.notEqual(cold.userDataRoot, f.receiver.userDataRoot)
    assert.notEqual(cold.userDataRoot, f.source.userDataRoot)
    const oldLocation = await readRootKnowledgePlanLocation3(f.saved.knowledgePlan), operationId = randomUUID()
    const imported = await importMixedOriginBundleOriginal(cold.userDataRoot, operationId, f.saved.originalPackage.directory)
    assert.notEqual(operationId, oldLocation.operationId)
    const operation = join(cold.userDataRoot, 'backups', 'database-restore', operationId)
    for (const [collection, kernel] of [['restore-identity-plans-v3', f.base], ['restore-reference-plans-v3', f.prepared]] as const) {
      const to = join(operation, collection, kernel.planId)
      await restoreDirectory(dirname(to), cold.userDataRoot); await restoreDirectory(to, cold.userDataRoot, true)
      await transportFile(join(kernel.directory, 'manifest.json'), f.receiver.userDataRoot, join(to, 'manifest.json'), cold.userDataRoot)
      assert.deepEqual(await readFile(join(to, 'manifest.json')), await readFile(join(kernel.directory, 'manifest.json')))
    }
    const copyTarget = join(operation, 'restore-current-copies-v3', copied.copyId)
    await transportTree(copied.directory, f.receiver.userDataRoot, copyTarget, cold.userDataRoot,
      ['manifest.json'], copied.value.originalInventory, false)
    const stageTarget = join(operation, 'restore-physical-stages-v3', physical.stageId)
    // Old mutable checks are deliberately absent. The new process creates its
    // own exclusive native probes from the two independent sealed originals.
    await transportTree(physical.directory, f.receiver.userDataRoot, stageTarget, cold.userDataRoot,
      ['intent.json', 'manifest.json'], stageInventory, true)
    assert.equal(await retire(f.source.userDataRoot, join(f.source.userDataRoot, 'backups')), true)
    assert.equal(await retire(f.receiver.userDataRoot, join(f.receiver.userDataRoot, 'backups')), true)
    await retire(f.source.userDataRoot, join(f.source.userDataRoot, 'original-input-verification'))
    assert.equal(await retire(f.receiver.userDataRoot, join(f.receiver.userDataRoot, 'original-input-verification')), true)
    await assert.rejects(readRootRestoreIdentityPlan3(f.base.plan))
    await assert.rejects(readRootRestoreReferencePlan3(f.prepared.plan))
    await assert.rejects(readRootRestoreCurrentCopy3(copied.copy))
    await assert.rejects(readRootRestorePhysicalStage3(physical.stage))
    const expectedPath = join(cold.userDataRoot, 'expected-physical-stage-' + randomUUID() + '.json')
    await writeFile(expectedPath, JSON.stringify({ identity: f.base.value, reference: f.prepared.value,
      copy: copied.value, stage: physical.value }), { flag: 'wx' })
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', resolve('tests/helpers/stage3-process.cjs'), JSON.stringify({
        locator: { profileRoot: imported.profileRoot, operationId, mountId: imported.mountId, expectedDescriptorHash: imported.original.descriptorHash },
        identityLocator: { planId: f.base.planId, expectedManifestHash: f.base.manifestHash },
        referenceLocator: { planId: f.prepared.planId, expectedManifestHash: f.prepared.manifestHash },
        copyLocator: { copyId: copied.copyId, expectedManifestHash: copied.manifestHash },
        stageLocator: { stageId: physical.stageId, expectedManifestHash: physical.manifestHash }, expectedPath
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    const actual = JSON.parse(stdout)
    assert.notEqual(actual.pid, process.pid)
    assert.equal(actual.stageManifestHash, physical.manifestHash)
    assert.equal(actual.physicalObservationHash, physical.value.physicalObservationHash)
    assert.equal(actual.copyManifestHash, copied.manifestHash)
    assert.equal(actual.baseIdentityAllocationHash, f.base.value.allocationHash)
    assert.equal(actual.derivedReferenceAllocationHash, f.prepared.value.allocation.derivedReferenceAllocationHash)
    assert.equal(actual.tables, 12); assert.ok(actual.lifecycleAdded > 0)
    assert.deepEqual(actual.tamperRejected, ['identity-kernel', 'reference-kernel', 'copy-db', 'stage-db', 'mounted-current-db'])
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    assert.deepEqual(allTables(cold.db), beforeCold)
  })))
