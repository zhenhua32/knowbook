import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../../shared/syncedBlockPortable'
import { backupV3InventoryHash, isBackupV3AssetPath, parseCapturedBackupV3Inventory, validateBackupV3ArchiveFilePath,
  type BackupV3File, type BackupV3FileDigest } from '../backup/v3-format'
import { copyBackupV3RestoreAsset, copyBackupV3RestoreContent, readBackupV3RestoreSource, type BackupV3RestoreSource } from '../backup/v3-reader'
import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { CAPSULE_V3_ASSET_MAX_FILE_BYTES, validateCapsuleV3ManagedTree } from './restore-knowledge-capsule2-assets-model'
import type { Capsule2ManagedTreeData } from './restore-knowledge-capsule2-managed-assets-files'
import { assertOriginCatalogDirectory, readOriginCatalogFile } from './restore-knowledge-origin-bundle-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'

export { CAPSULE_V3_ASSET_MAX_FILE_BYTES, validateCapsuleV3ManagedTree }
export { validateCapsuleV3PortableAssetProvenance } from './restore-knowledge-capsule2-asset-provenance'
export const CAPSULE_V3_CONTENT_DIRECTORY = 'v3-content'
const assetPrefix = '__knowbook/assets/'
const maxContentFile = 5 * 1024 * 1024, maxContentBytes = 100 * 1024 * 1024
const maxAssetsBytes = 500 * 1024 * 1024, maxFilesPerKind = 5_000, maxEntries = 20_000
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const bad = (reason: string): never => { throw new Error('V3恢复归档原件无效：' + reason) }

export interface CapsuleV3ArchiveProof {
  readonly snapshotId: string
  readonly inventoryHash: string
  readonly files: readonly BackupV3FileDigest[]
}

function splitProof(proof: CapsuleV3ArchiveProof) {
  const content: BackupV3FileDigest[] = [], assets: BackupV3FileDigest[] = []
  for (const file of proof.files) (isBackupV3AssetPath(file.relativePath) ? assets : content).push(file)
  return { content, assets }
}

export function validateCapsuleV3ArchiveProof(value: unknown): CapsuleV3ArchiveProof {
  const row = capsuleRecord(value, ['snapshotId', 'inventoryHash', 'files'])
  if (!isSyncedUuid(row.snapshotId) || typeof row.inventoryHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.inventoryHash)
    || !Array.isArray(row.files) || row.files.length > maxFilesPerKind * 2) return bad('V3库存形状或身份不符')
  const paths = new Map<string, { path: string; directory: boolean }>()
  let previous = '', assetCount = 0, assetBytes = 0, contentCount = 0, contentBytes = 0
  const add = (path: string, directory: boolean): void => {
    const key = path.toLowerCase(), prior = paths.get(key)
    if (prior && (!directory || !prior.directory || prior.path !== path)) return bad('V3库存路径重复或冲突')
    paths.set(key, { path, directory })
    if (paths.size > maxEntries) return bad('V3库存超过目录项上限')
  }
  const files = row.files.map((value): BackupV3FileDigest => {
    const file = capsuleRecord(value, ['relativePath', 'hash', 'bytes'])
    const relativePath = validateBackupV3ArchiveFilePath(file.relativePath), asset = isBackupV3AssetPath(relativePath)
    if (relativePath <= previous || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash)
      || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0)
      return bad('V3库存排序或文件摘要不符')
    previous = relativePath
    if (asset) {
      if (file.bytes > CAPSULE_V3_ASSET_MAX_FILE_BYTES || ++assetCount > maxFilesPerKind || (assetBytes += file.bytes) > maxAssetsBytes)
        return bad('V3资产超原库存上限')
    } else if (file.bytes > maxContentFile || ++contentCount > maxFilesPerKind || (contentBytes += file.bytes) > maxContentBytes) {
      return bad('V3内容超原库存上限')
    }
    const parts = relativePath.split('/')
    for (let depth = 1; depth < parts.length; depth++) add(parts.slice(0, depth).join('/'), true)
    add(relativePath, false)
    return { relativePath, hash: file.hash, bytes: file.bytes }
  })
  if (backupV3InventoryHash(files) !== row.inventoryHash) return bad('V3库存摘要不闭合')
  return freezeCapsuleValue({ snapshotId: row.snapshotId, inventoryHash: row.inventoryHash, files })
}

/** The managed shape is a deterministic portable projection of the V3
 * inventory, with one private physical blob for any number of valid aliases. */
export function capsuleV3PortableManagedTree(proof: CapsuleV3ArchiveProof): Capsule2ManagedTreeData {
  const { assets } = splitProof(proof), directories = new Set(['']), files = new Map<string, number>()
  const aliases = assets.map(asset => {
    const relativePath = asset.relativePath.slice(assetPrefix.length), parts = relativePath.split('/'), name = parts[3]
    const uri = buildSyncedPortableAssetUri({ hash: asset.hash, name })
    if (syncedPortableAssetBackupPath(uri) !== asset.relativePath) return bad('V3 alias、hash及原路径不闭合')
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'))
    const previous = files.get(asset.hash)
    if (previous !== undefined && previous !== asset.bytes) return bad('同hash的V3 alias长度不同')
    files.set(asset.hash, asset.bytes)
    return { relativePath, hash: asset.hash, bytes: asset.bytes, name }
  })
  return validateCapsuleV3ManagedTree({ rootPresent: true, directories: [...directories].sort(compare), aliases,
    files: [...files].sort(([a], [b]) => compare(a, b)).map(([hash, bytes]) => ({ hash, bytes })) })
}

function contentDirectories(root: string, files: readonly BackupV3FileDigest[]) {
  const children = new Map<string, Set<string>>([[root, new Set()]])
  for (const file of files) {
    const parts = file.relativePath.split('/')
    let parent = root
    for (const name of parts.slice(0, -1)) {
      children.get(parent)!.add(name)
      parent = join(parent, name)
      if (!children.has(parent)) children.set(parent, new Set())
    }
    children.get(parent)!.add(parts[parts.length - 1])
  }
  return children
}

export async function copyCapsuleV3ArchiveOriginals(owner: BackupV3RestoreSource, directory: string, root: string) {
  const verified = readBackupV3RestoreSource(owner), contentRoot = join(directory, CAPSULE_V3_CONTENT_DIRECTORY), blobs = join(directory, 'files')
  const proof = validateCapsuleV3ArchiveProof({ snapshotId: verified.archive.manifest.snapshotId, inventoryHash: verified.inventoryHash,
    files: [...verified.files].sort((a, b) => compare(a.relativePath, b.relativePath)) })
  const tree = capsuleV3PortableManagedTree(proof), { content, assets } = splitProof(proof)
  const directories = [...contentDirectories(contentRoot, content).keys()]
  for (const path of directories) await restoreDirectory(path, root, true)
  for (const file of content) await copyBackupV3RestoreContent(owner, file.relativePath, join(contentRoot, ...file.relativePath.split('/')))
  const copied = new Set<string>()
  for (const file of assets) {
    if (copied.has(file.hash)) continue
    await copyBackupV3RestoreAsset(owner, file.relativePath, join(blobs, file.hash))
    copied.add(file.hash)
  }
  for (const path of directories.reverse()) await syncRestoreDirectory(path)
  await syncRestoreDirectory(blobs)
  return { proof, tree, archive: verified.archive }
}

/** Bound attachment checks use the existing fixed-size streaming leaf. Only
 * V3 text/group originals are collected, inside the exact V3 content budget. */
export async function readCapsuleV3ArchiveOriginals(proof: CapsuleV3ArchiveProof, tree: Capsule2ManagedTreeData,
  directory: string, root: string, parseContent: boolean) {
  const original = validateCapsuleV3ArchiveProof(proof), physicalTree = capsuleV3PortableManagedTree(original)
  if (capsuleJson(tree) !== capsuleJson(physicalTree)) return bad('V3实际原件树不属于库存')
  const contentRoot = join(directory, CAPSULE_V3_CONTENT_DIRECTORY), blobs = join(directory, 'files'), { content, assets } = splitProof(original)
  const directories = contentDirectories(contentRoot, content)
  const identities = new Map<string, string>()
  const closure = async () => {
    for (const [path, names] of directories) {
      const stat = await assertOriginCatalogDirectory(path, root), identity = [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':')
      if (identities.has(path) && identities.get(path) !== identity
        || capsuleJson((await readdir(path)).sort(compare)) !== capsuleJson([...names].sort(compare))) return bad('V3内容原件目录闭集变化')
      identities.set(path, identity)
    }
  }
  await closure()
  const originals: BackupV3File[] = []
  for (const file of content) {
    const path = join(contentRoot, ...file.relativePath.split('/'))
    if (parseContent) {
      const bytes = await readCapsule2AssetCopy(path, root, file.bytes, file.hash, maxContentFile)
      originals.push({ relativePath: file.relativePath, bytes })
    } else await readOriginCatalogFile(path, root, { path: file.relativePath, bytes: file.bytes, sha256: file.hash })
  }
  for (const file of physicalTree.files) await readOriginCatalogFile(join(blobs, file.hash), root, { path: file.hash, bytes: file.bytes, sha256: file.hash })
  await closure()
  if (!parseContent) return
  const archive = parseCapturedBackupV3Inventory(originals, assets)
  if (archive.manifest.snapshotId !== original.snapshotId) return bad('实际V3原件和声明snapshot不同')
  return archive
}
