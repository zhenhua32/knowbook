import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareRestoreAssetTransfer4 } from '../../src/main/database/restore-asset-transfer4'
import { jointRestorePaths4, readJointRestoreCurrent4 } from '../../src/main/database/restore-joint-journal4'
import { copyRestoreInventory, restoreInventory, writeRestoreJson } from '../../src/main/database/restore-safety-files'
import { digest, randomUUID, type withControlledRestore } from './controlled-restore-fixture'

const worker = fileURLToPath(new URL('./restore-joint-physical4-crash.mjs', import.meta.url))
export const child = (root: string, operationId: string, mode: string) => promisify(execFile)(process.execPath,
  ['--import', 'tsx', worker, root, operationId, mode], { windowsHide: true, timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
export const observed = async (run: ReturnType<typeof child>) => JSON.parse((await run).stdout) as { status: string }
type Fixture = Parameters<Parameters<typeof withControlledRestore>[0]>[0]

export async function prepare(f: Fixture, withAssets: boolean, sameBytes: boolean) {
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
