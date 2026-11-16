import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { copyFile, lstat, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { applyPreparedJointRestore4, prepareJointRestoreIntent4, readJointRestoreCurrent4,
  readJointRestoreFence4, readJointRestoreIntent4 } from '../src/main/database/restore-joint-journal4'
import { assertRestoreInventory, readRestoreJson, restoreExists } from '../src/main/database/restore-safety-files'
import { assertOriginals, withControlledRestore } from './helpers/controlled-restore-fixture'
import { child, observed, prepare } from './helpers/restore-joint-physical4-fixture'

for (const [phase, exitCode, terminal] of [
  ['prepared', 71, 'aborted-before-move'], ['old-moved', 72, 'rolled-back'],
  ['candidate-moved', 74, 'rolled-back'], ['committed', 75, 'installed']
] as const) {
  test('joint cold resume after ' + phase, () => withControlledRestore(async f => {
    const { root, operationId, p, old, candidate } = await prepare(f, false, false)
    await assert.rejects(child(root, operationId, phase), { code: exitCode })
    assert.equal((await observed(child(root, operationId, 'recover'))).status, terminal)
    assert.equal(await restoreExists(p.journal), false)
    assert.equal((await readJointRestoreFence4(p.fence)).fence.phase, terminal === 'installed' ? 'installed' : 'rolledback')
    if (terminal === 'installed') await assertRestoreInventory(p.storage, candidate)
    else assertOriginals(p.database, old!)
    assert.equal((await observed(child(root, operationId, 'recover'))).status, terminal)
    assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  }))
}

test('joint recovery uses old and candidate fds even when their bytes are identical and blocks a foreign occupant', () => withControlledRestore(async f => {
  const { root, operationId, p, current, candidate } = await prepare(f, false, true)
  assert.equal(current.inventory[0].sha256, candidate[0].sha256)
  await assert.rejects(child(root, operationId, 'candidate-moved'), { code: 74 })
  const { fence } = await readJointRestoreFence4(p.fence), intent = await readJointRestoreIntent4(root, fence)
  assert.notDeepEqual(intent.currentIdentities[0], intent.candidateIdentity)
  const heldCandidate = join(p.recovery, 'actual-candidate-held-for-test')
  await rename(p.database, heldCandidate)
  await copyFile(heldCandidate, p.database, constants.COPYFILE_EXCL)
  await assert.rejects(child(root, operationId, 'recover'), /原字节或 fd 身份不同/)
  assert.equal(await restoreExists(join(p.original, 'knowbook.db')), true)
  const foreign = join(p.recovery, 'same-bytes-foreign')
  await rename(p.database, foreign)
  await rename(heldCandidate, p.database)
  await assert.rejects(child(root, operationId, 'rollback-mid'), { code: 76 })
  assert.equal(await restoreExists(join(p.original, 'knowbook.db')), false)
  await assert.rejects(child(root, operationId, 'terminal'), { code: 77 })
  const result = await readRestoreJson(p.result)
  assert.equal((await observed(child(root, operationId, 'recover'))).status, 'rolled-back')
  assert.deepEqual(await readRestoreJson(p.result), result)
  assert.deepEqual(await readJointRestoreCurrent4(root), current)
}))

test('joint restore removes exactly its own alias after an actual hardlink interruption', () => withControlledRestore(async f => {
  const { root, operationId, p, old, oldAsset, incoming, bytes } = await prepare(f, true, false)
  const prior = await lstat(oldAsset, { bigint: true })
  await assert.rejects(child(root, operationId, 'asset-linked'), { code: 73 })
  assert.deepEqual(await readFile(incoming), bytes)
  assert.equal((await observed(child(root, operationId, 'recover'))).status, 'rolled-back')
  assert.equal(await restoreExists(incoming), false)
  assert.equal((await lstat(oldAsset, { bigint: true })).ino, prior.ino)
  assert.deepEqual(await readFile(oldAsset), bytes)
  assertOriginals(p.database, old!)
}))

test('joint hot catch reads durable commit marker after its write throws', () => withControlledRestore(async f => {
  const { root, operationId, p, candidate } = await prepare(f, false, false)
  assert.equal((await observed(child(root, operationId, 'commit-error'))).status, 'installed')
  assert.equal(await restoreExists(p.journal), false)
  await assertRestoreInventory(p.storage, candidate)
}))

test('joint apply rejects a byte-identical live replacement before moving any SQL', () => withControlledRestore(async f => {
  const { root, operationId, p, current, input } = await prepare(f, false, false)
  const intent = await prepareJointRestoreIntent4({ profileRoot: root, operationId, current, parentFenceHash: null,
    installationProofHash: input.installationProofHash, assetTransferId: input.assetTransferId, assetManifestHash: input.assetManifestHash })
  const original = join(p.recovery, 'stopped-live-original')
  await rename(p.database, original)
  await copyFile(original, p.database, constants.COPYFILE_EXCL)
  await assert.rejects(applyPreparedJointRestore4(root, intent, { async assertPrepared() {}, async assertInstalled() {} }), /旧 SQL 身份变化/)
  assert.equal(await restoreExists(p.fence), false)
  assert.equal(await restoreExists(p.journal), false)
  assert.equal(await restoreExists(join(p.original, 'knowbook.db')), false)
  await assertRestoreInventory(p.storage, current.inventory)
}))
