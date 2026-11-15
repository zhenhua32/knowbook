import { constants } from 'node:fs'
import { lstat, mkdtemp, open, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../../shared/syncedBlockPortable'
import { localAttachmentFileUrl } from '../attachments'
import { prepareRestoreAssetTransfer4, type RestoreAssetTransferSource4 } from '../database/restore-asset-transfer4'
import { assertRestorePath, canonicalRestoreRoot, restorePaths } from '../database/restore-safety-files'
import { assertBackupV3RestoreSourceCurrent, copyBackupV3RestoreAsset, readBackupV3RestoreSource, type BackupV3RestoreSource } from './v3-reader'

const archiveAssetPrefix = '__knowbook/assets/'

/** Bridge the exact original V3 aliases into the controlled restore transfer.
 * The transfer's independent payloads are its durable inputs after this returns. */
export async function prepareBackupV3RestoreAssetStage(owner: BackupV3RestoreSource, profileRoot: string, operationId: string) {
  const { inventoryHash, assets } = readBackupV3RestoreSource(owner)
  const root = await canonicalRestoreRoot(profileRoot), operation = restorePaths(root, operationId).recovery
  await assertRestorePath(operation, root)
  const operationInfo = await lstat(operation, { bigint: true })
  if (!operationInfo.isDirectory() || operationInfo.ino === 0n) throw new Error('V3 restore asset stage requires an existing controlled restore operation directory.')
  const aliases = new Map<string, string>(), staged: RestoreAssetTransferSource4[] = []
  const assertOperation = async () => {
    await assertRestorePath(operation, root)
    const actual = await lstat(operation, { bigint: true })
    if (!actual.isDirectory() || actual.dev !== operationInfo.dev || actual.ino !== operationInfo.ino)
      throw new Error('V3 restore asset operation directory changed.')
  }
  const resolveAssetUri = (portableUri: string): string => {
    const local = aliases.get(portableUri)
    if (!local) throw new Error('The asset is missing from the verified V3 restore inventory.')
    return local
  }
  assertBackupV3RestoreSourceCurrent(owner)
  if (!assets.length) return Object.freeze({ inventoryHash, operationId, transfer: null, resolveAssetUri })

  const directory = await mkdtemp(join(operation, 'v3-verified-assets-'))
  await assertRestorePath(directory, operation)
  const originalDirectory = await lstat(directory, { bigint: true })
  if (!originalDirectory.isDirectory() || originalDirectory.ino === 0n) throw new Error('V3 restore asset stage has no stable directory identity.')
  const assertDirectory = async () => {
    await assertOperation()
    await assertRestorePath(directory, operation)
    const actual = await lstat(directory, { bigint: true })
    if (!actual.isDirectory() || actual.dev !== originalDirectory.dev || actual.ino !== originalDirectory.ino)
      throw new Error('V3 restore asset staging directory changed.')
  }
  const created: Array<{ path: string; dev: bigint; ino: bigint }> = []
  const cleanup = async () => {
    await assertDirectory()
    for (const file of created) {
      await assertRestorePath(file.path, directory)
      const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const actual = await handle.stat({ bigint: true }), path = await lstat(file.path, { bigint: true })
        const sameDevice = path.dev === actual.dev
          || process.platform === 'win32' && (path.dev === 0n || path.dev === BigInt.asUintN(32, actual.dev))
        if (!actual.isFile() || !path.isFile() || path.isSymbolicLink() || actual.dev !== file.dev || actual.ino !== file.ino
          || !sameDevice || path.ino !== actual.ino) throw new Error('V3 restore asset staging file changed before cleanup.')
      } finally { await handle.close() }
      await unlink(file.path)
    }
    await rmdir(directory)
  }
  const prepare = async () => {
    for (const { relativePath, hash, bytes } of assets) {
      const logicalName = relativePath.slice(relativePath.lastIndexOf('/') + 1)
      const uri = buildSyncedPortableAssetUri({ hash, name: logicalName }), verifiedPath = syncedPortableAssetBackupPath(uri)
      if (verifiedPath !== relativePath || aliases.has(uri)) throw new Error('The verified V3 restore asset path does not match its exact hash and name.')
      const sourcePath = join(directory, staged.length + '.bin')
      await assertDirectory()
      const copied = await copyBackupV3RestoreAsset(owner, relativePath, sourcePath)
      created.push({ path: sourcePath, dev: copied.dev, ino: copied.ino })
      staged.push({ sourceRoot: directory, sourcePath, logicalName, hash, bytes })
      aliases.set(uri, localAttachmentFileUrl(join(root, 'storage', 'assets', ...verifiedPath.slice(archiveAssetPrefix.length).split('/'))))
    }
    await assertDirectory()
    const { transferId, manifestHash } = await prepareRestoreAssetTransfer4(root, operationId, staged)
    assertBackupV3RestoreSourceCurrent(owner)
    return Object.freeze({ inventoryHash, operationId, transfer: Object.freeze({ transferId, manifestHash }), resolveAssetUri })
  }
  const result = await prepare().catch(async error => {
    try { await cleanup() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'V3 restore asset staging and private cleanup failed.') }
    throw error
  })
  await cleanup()
  return result
}
