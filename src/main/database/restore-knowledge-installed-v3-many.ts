import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { validateCoverageRootReference, type CoverageRootReference } from './restore-knowledge-coverage-model'
import { assertCapsule2AssetDirectory, readCapsule2AssetCopy, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { CAPSULE_V3_ASSET_MAX_FILE_BYTES } from './restore-knowledge-capsule2-assets-model'
import type { Capsule2ManagedTreeData } from './restore-knowledge-capsule2-managed-assets-files'
import { readArchivedTransferFacts4, readPinnedTransferManifestText4 } from './restore-asset-transfer4'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'

type Alias = Capsule2ManagedTreeData['aliases'][number]
type TransferLocator = { operationId: string; transferId: string; manifestHash: string }
type TransferFile = TransferLocator & { bytes: number; sha256: string }
export type InstalledV3Origin = { snapshotId: string; inventoryHash: string; archiveHash: string }
type InstalledAlias = { alias: Alias; backupV3: InstalledV3Origin; role: 'source' | 'current'; transfer: TransferLocator; identity: { dev: string; ino: string } }
export interface InstalledV3Many {
  readonly root: CoverageRootReference
  readonly qualifiedDescriptorHash: string
  readonly installationProofHash: string
  readonly aliases: readonly InstalledAlias[]
  readonly transfers: readonly TransferFile[]
}
export const CAPSULE_INSTALLED_TRANSFERS_DIRECTORY = 'installed-transfers'
const maxTransferFile = 64 * 1024 * 1024
const bad = (message: string): never => { throw new Error('多份已安装 V3 附件连续性无效：' + message) }
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const aliasPath = (hash: string, name: string) => syncedPortableAssetBackupPath(buildSyncedPortableAssetUri({ hash, name })).slice('__knowbook/assets/'.length)
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const transferKey = (file: TransferLocator) => file.operationId + '-' + file.transferId
const transferName = (file: TransferLocator) => transferKey(file) + '.json'

function locator(value: Record<string, unknown>): TransferLocator {
  return { operationId: durableSqlDagUuid(value.operationId), transferId: durableSqlDagUuid(value.transferId), manifestHash: durableSqlDagHash(value.manifestHash) }
}

function readAlias(value: unknown): InstalledAlias {
  const row = capsuleRecord(value, ['alias','backupV3','role','transfer','identity'])
  const raw = capsuleRecord(row.alias, ['relativePath','hash','name','bytes']), hash = durableSqlDagHash(raw.hash)
  const backup = capsuleRecord(row.backupV3, ['snapshotId','inventoryHash','archiveHash'])
  const identity = capsuleRecord(row.identity, ['dev','ino'])
  if (typeof raw.name !== 'string' || raw.relativePath !== aliasPath(hash, raw.name)
    || typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes <= ATTACHMENT_MAX_FILE_BYTES || raw.bytes > CAPSULE_V3_ASSET_MAX_FILE_BYTES
    || row.role !== 'source' && row.role !== 'current'
    || typeof identity.dev !== 'string' || !/^(?:0|-?[1-9][0-9]{0,19})$/.test(identity.dev)
    || typeof identity.ino !== 'string' || !/^[1-9][0-9]{0,19}$/.test(identity.ino)) return bad('逐别名原路径、角色、字节或实际 fd 身份无效')
  return { alias: { relativePath: raw.relativePath as string, hash, name: raw.name, bytes: raw.bytes },
    backupV3: { snapshotId: durableSqlDagUuid(backup.snapshotId), inventoryHash: durableSqlDagHash(backup.inventoryHash),
      archiveHash: durableSqlDagHash(backup.archiveHash) }, role: row.role,
    transfer: locator(capsuleRecord(row.transfer, ['operationId','transferId','manifestHash'])),
    identity: { dev: identity.dev, ino: identity.ino } }
}

export function validateInstalledV3Many(value: unknown, tree: Capsule2ManagedTreeData): InstalledV3Many {
  const row = capsuleRecord(value, ['root','qualifiedDescriptorHash','installationProofHash','aliases','transfers'])
  const root = validateCoverageRootReference(row.root)
  if (root.namespace.kind !== 'native' || !Array.isArray(row.aliases) || row.aliases.length > tree.aliases.length
    || !Array.isArray(row.transfers) || row.transfers.length > row.aliases.length) return bad('缺原生父根或完整逐别名/transfer 集合')
  const aliases = row.aliases.map(readAlias)
  if (!same(aliases.map(entry => entry.alias), tree.aliases.filter(alias => alias.bytes > ATTACHMENT_MAX_FILE_BYTES))
    || new Set(aliases.map(entry => capsuleJson(entry.backupV3))).size < 2) return bad('别名需准确覆盖至少两份 V3 来源')
  const transfers = row.transfers.map(value => {
    const file = capsuleRecord(value, ['operationId','transferId','manifestHash','bytes','sha256'])
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > maxTransferFile)
      return bad('transfer 原文件超准确限额')
    const location = locator(file), sha256 = durableSqlDagHash(file.sha256)
    if (sha256 !== location.manifestHash) return bad('规范 transfer 原字节 SHA 不等于安装清单 pin')
    return { ...location, bytes: file.bytes, sha256 }
  })
  if (transfers.some((entry, index) => index > 0 && transferKey(transfers[index - 1]) >= transferKey(entry))
    || transfers.reduce((total, file) => total + file.bytes, 0) > maxTransferFile) return bad('transfer 集合重复或超预算')
  const byKey = new Map(transfers.map(file => [transferKey(file), file]))
  const used = new Set<string>()
  for (const entry of aliases) {
    if (entry.role === 'source' && entry.transfer.operationId !== root.operationId)
      return bad('本次 V3 源别名必须使用本次安装 transfer')
    const key = transferKey(entry.transfer), file = byKey.get(key)
    if (!file || file.manifestHash !== entry.transfer.manifestHash) return bad('逐别名缺精确 transfer 文件')
    used.add(key)
  }
  if (used.size !== transfers.length) return bad('出现未被实际别名引用的 transfer 文件')
  return freezeCapsuleValue({ root, qualifiedDescriptorHash: durableSqlDagHash(row.qualifiedDescriptorHash),
    installationProofHash: durableSqlDagHash(row.installationProofHash), aliases, transfers })
}

export function installedV3TransferFiles(proof: InstalledV3Many, assetsDirectory: string) {
  return proof.transfers.map(file => ({ path: assetsDirectory + '/' + CAPSULE_INSTALLED_TRANSFERS_DIRECTORY + '/' + transferName(file),
    bytes: file.bytes, sha256: file.sha256 }))
}

/** The selected transfer locator only enters through the same live alias
 * capture. Copy its exact canonical facts once, after deduplicating by locator. */
export async function writeInstalledV3ManyFiles(profileRoot: string, output: string,
  pins: Pick<InstalledV3Many, 'root' | 'qualifiedDescriptorHash' | 'installationProofHash'>,
  aliases: readonly InstalledAlias[], tree: Capsule2ManagedTreeData) {
  const directory = join(output, CAPSULE_INSTALLED_TRANSFERS_DIRECTORY)
  const byKey = new Map(aliases.map(entry => [transferKey(entry.transfer), entry.transfer]))
  await restoreDirectory(directory, profileRoot, true)
  const transfers: TransferFile[] = []
  let total = 0
  for (const [key, transfer] of [...byKey].sort(([left], [right]) => order(left, right))) {
    const bytes = Buffer.from(await readPinnedTransferManifestText4(profileRoot, transfer))
    if ((total += bytes.length) > maxTransferFile) return bad('transfer 封存超过总预算')
    const file = { ...transfer, bytes: bytes.length, sha256: capsuleBytesHash(bytes) }
    await writeCapsule2AssetCopy(join(directory, key + '.json'), bytes, profileRoot)
    transfers.push(file)
  }
  await syncRestoreDirectory(directory)
  const proof = validateInstalledV3Many({ ...pins, aliases, transfers }, tree)
  await assertInstalledV3ManyFiles(proof, output, profileRoot)
  return proof
}

export async function assertInstalledV3ManyFiles(proof: InstalledV3Many, output: string, profileRoot: string) {
  const directory = join(output, CAPSULE_INSTALLED_TRANSFERS_DIRECTORY)
  const closure = async () => {
    await assertCapsule2AssetDirectory(directory, profileRoot)
    if (!same((await readdir(directory)).sort(order), proof.transfers.map(transferName))) return bad('transfer 原件目录闭集改变')
  }
  const byTransfer = new Map<string, InstalledAlias[]>()
  for (const alias of proof.aliases) {
    const key = transferKey(alias.transfer), group = byTransfer.get(key) ?? []
    group.push(alias); byTransfer.set(key, group)
  }
  await closure()
  for (const file of proof.transfers) {
    const bytes = await readCapsule2AssetCopy(join(directory, transferName(file)), profileRoot, file.bytes, file.sha256, maxTransferFile)
    const text = bytes.toString('utf8')
    if (!Buffer.from(text).equals(bytes)) return bad('transfer 原件不是准确的 UTF-8 字节')
    const facts = new Map(readArchivedTransferFacts4(text, file).map(entry => [aliasPath(entry.hash, entry.logicalName), entry]))
    for (const { alias, identity } of byTransfer.get(transferKey(file)) ?? []) {
      const fact = facts.get(alias.relativePath)
      if (!fact || fact.bytes !== alias.bytes || !same(fact.identity, identity)) return bad('逐别名与封存 transfer 的名称、字节或 fd 事实不同')
    }
  }
  await closure()
}
