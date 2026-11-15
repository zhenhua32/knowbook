import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareRestoreAssetTransfer4 } from '../src/main/database/restore-asset-transfer4'
import { applyPreparedJointRestore4, jointRestorePaths4, prepareJointRestoreIntent4, readJointRestoreCurrent4,
  readJointRestoreFence4, readJointRestoreIntent4 } from '../src/main/database/restore-joint-journal4'
import { assertRestoreInventory, copyRestoreInventory, readRestoreJson, restoreExists, restoreInventory,
  writeRestoreJson } from '../src/main/database/restore-safety-files'
import { assertOriginals, digest, randomUUID, withControlledRestore } from './helpers/controlled-restore-fixture'

const worker = fileURLToPath(new URL('./helpers/restore-joint-physical4-crash.mjs', import.meta.url))
const child = (root: string, operationId: string, mode: string) => promisify(execFile)(process.execPath,
  ['--import', 'tsx', worker, root, operationId, mode], { windowsHide: true, timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
const observed = async (run: ReturnType<typeof child>) => JSON.parse((await run).stdout) as { status: string }
type Fixture = Parameters<Parameters<typeof withControlledRestore>[0]>[0]

async function prepare(f: Fixture, withAssets: boolean, sameBytes: boolean) {
  if (sameBytes) f.close()
  const old = sameBytes ? null : f.sealCurrent(), root = await realpath(f.profile), operationId = randomUUID()
  const p = jointRestorePaths4(root, operationId)
  await mkdir(p.recovery, { recursive: true })
  await mkdir(p.original)
  const current = await readJointRestoreCurrent4(root)
  await copyRestoreInventory(p.storage, p.safety, current.inventory, root)
  await mkdir(p.candidateOriginal)
  await copyFile(sameBytes ? p.database : f.backup, join(p.candidateOriginal, 'knowbook.db'), constants.COPYFILE_EXCL)
  const candidate = await restoreInventory(p.candidateOriginal)
  await copyFile(join(p.candidateOriginal, 'knowbook.db'), p.stage, constants.COPYFILE_EXCL)
  const origin = join(p.recovery, 'test-asset-originals'), bytes = Buffer.from('actual asset data'), hash = digest(bytes)
  await mkdir(origin)
  const target = (name: string) => join(p.storage, 'assets', 'attachments', hash.slice(0, 2), hash, name)
  const oldAsset = target('retained.bin'), incoming = target('incoming.bin')
  const assets = []
  if (withAssets) {
    await mkdir(dirname(oldAsset), { recursive: true })
    await writeFile(oldAsset, bytes, { flag: 'wx' })
    for (const logicalName of ['retained.bin', 'incoming.bin']) {
      const sourcePath = join(origin, logicalName)
      await writeFile(sourcePath, bytes, { flag: 'wx' })
      assets.push({ sourceRoot: origin, sourcePath, logicalName, bytes: bytes.length, hash })
    }
  }
  const transfer = await prepareRestoreAssetTransfer4(root, operationId, assets), installationProofHash = digest('actual test plan pin')
  const input = { installationProofHash, assetTransferId: transfer.transferId, assetManifestHash: transfer.manifestHash,
    expectedDocumentId: sameBytes ? f.currentId : f.id, expectedTitle: sameBytes ? 'Current ordinary document' : 'Ordinary source backup' }
  await writeRestoreJson(join(p.recovery, 'physical-test-input.json'), input, root, true)
  return { root, operationId, p, old, current, candidate, oldAsset, incoming, bytes, input }
}

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
