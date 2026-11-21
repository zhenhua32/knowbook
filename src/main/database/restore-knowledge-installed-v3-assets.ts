import { join } from 'node:path'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../../shared/syncedBlockPortable'
import { tryReadInstalledRestoreAsset4 } from './restore-asset-transfer4'
import { capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readOwnedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { CAPSULE_V3_ASSET_MAX_FILE_BYTES } from './restore-knowledge-capsule2-assets-model'
import { captureCapsule2ManagedTreeWithInstalledAssets, type Capsule2ManagedTreeData } from './restore-knowledge-capsule2-managed-assets-files'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { assertJointRestoreInstalledResult4, readJointRestoreFence4, readJointRestoreIntent4 } from './restore-joint-journal4'
import { readRestoreKnowledgeInstallProof, readRestoreKnowledgePriorInstall, readVerifiedPriorInstallAssetTransfer,
  verifyRestoreKnowledgeInstalledDatabase } from './restore-knowledge-install-proof'
import { captureReopenedQualifiedOriginalContent5 } from './restore-knowledge-qualified-originals'
import { withReferenceOriginalRows5 } from './restore-knowledge-reference-original-rows5'
import { mixedOriginCapsulePath } from './restore-knowledge-mixed-origin-bundle-model'
import { copyOriginCatalogFile } from './restore-knowledge-origin-bundle-files'
import { referenceContextObjectPath } from './restore-knowledge-reference-context-model'
import { validateCoverageRootReference, type CoverageRootReference, type RawCoverageRequirement } from './restore-knowledge-coverage-model'
import { assertRestorePath, readRestoreText, restoreExists, restorePaths } from './restore-safety-files'
import { createHash } from 'node:crypto'
import type { Capsule2AssetArchiveManifest } from './restore-knowledge-capsule2-asset-archive'
import { writeInstalledV3ManyFiles } from './restore-knowledge-installed-v3-many'

type Alias = Capsule2ManagedTreeData['aliases'][number]
export interface InstalledV3AssetArchiveProof {
  readonly root: CoverageRootReference
  readonly qualifiedDescriptorHash: string
  readonly installationProofHash: string
  readonly transferId: string
  readonly transferManifestHash: string
  readonly backupV3: { readonly snapshotId: string; readonly inventoryHash: string; readonly archiveHash: string }
  readonly aliases: readonly Alias[]
}
const bad = (message: string): never => { throw new Error('已安装 V3 附件连续性无效：' + message) }
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const assetPath = (hash: string, name: string) => syncedPortableAssetBackupPath(buildSyncedPortableAssetUri({ hash, name })).slice('__knowbook/assets/'.length)

/** A current archive7 has already been verified against its own ancestor by
 * the qualified reader before it is used as the immediate parent. */
export function installedV3AliasOrigins(source: { assetArchive: Capsule2AssetArchiveManifest; assetArchiveHash: string },
  current: { assetArchive: Capsule2AssetArchiveManifest }) {
  const archive = source.assetArchive, previous = current.assetArchive
  if (archive.version !== 6) return bad('同次安装的源原件不是 V3')
  const incoming = { snapshotId: archive.backupV3.snapshotId, inventoryHash: archive.backupV3.inventoryHash, archiveHash: source.assetArchiveHash }
  const origins = new Map<string, { alias: Alias; backupV3: InstalledV3AssetArchiveProof['backupV3']; role: 'source' | 'current' }>()
  if (previous.version === 7 || previous.version === 8) for (const alias of previous.installedV3.aliases) {
    origins.set(alias.relativePath, { alias, backupV3: previous.installedV3.backupV3, role: 'current' })
  }
  if (previous.version === 9 || previous.version === 10) for (const { alias, backupV3 } of previous.installedV3Many.aliases) {
    origins.set(alias.relativePath, { alias, backupV3, role: 'current' })
  }
  for (const alias of archive.tree.aliases) if (alias.bytes > ATTACHMENT_MAX_FILE_BYTES) {
    origins.set(alias.relativePath, { alias, backupV3: incoming, role: 'source' })
  }
  return origins
}

export function validateInstalledV3AssetArchiveProof(value: unknown, tree: Capsule2ManagedTreeData): InstalledV3AssetArchiveProof {
  const row = capsuleRecord(value, ['root','qualifiedDescriptorHash','installationProofHash','transferId','transferManifestHash','backupV3','aliases'])
  const root = validateCoverageRootReference(row.root)
  const backup = capsuleRecord(row.backupV3, ['snapshotId','inventoryHash','archiveHash'])
  if (root.namespace.kind !== 'native' || !Array.isArray(row.aliases) || !row.aliases.length || row.aliases.length > tree.aliases.length)
    return bad('必须绑定原生安装根和准确的大附件全集')
  const aliases = row.aliases.map(value => {
    const alias = capsuleRecord(value, ['relativePath','hash','name','bytes']), hash = durableSqlDagHash(alias.hash)
    if (typeof alias.name !== 'string' || alias.relativePath !== assetPath(hash, alias.name) || typeof alias.bytes !== 'number'
      || !Number.isSafeInteger(alias.bytes) || alias.bytes <= ATTACHMENT_MAX_FILE_BYTES || alias.bytes > CAPSULE_V3_ASSET_MAX_FILE_BYTES)
      return bad('大附件的 hash、路径或长度不同')
    return { relativePath: alias.relativePath as string, hash, name: alias.name, bytes: alias.bytes }
  })
  if (!same(aliases, tree.aliases.filter(file => file.bytes > ATTACHMENT_MAX_FILE_BYTES))) return bad('大附件必须逐路径与当前归档树严格闭合')
  return freezeCapsuleValue({ root, qualifiedDescriptorHash: durableSqlDagHash(row.qualifiedDescriptorHash),
    installationProofHash: durableSqlDagHash(row.installationProofHash), transferId: durableSqlDagUuid(row.transferId),
    transferManifestHash: durableSqlDagHash(row.transferManifestHash),
    backupV3: { snapshotId: durableSqlDagUuid(backup.snapshotId), inventoryHash: durableSqlDagHash(backup.inventoryHash),
      archiveHash: durableSqlDagHash(backup.archiveHash) }, aliases })
}

export interface InstalledV3AssetContinuity { readonly kind: 'installed-v3-asset-continuity' }
const installed = new WeakMap<InstalledV3AssetContinuity, Awaited<ReturnType<typeof readInstalled>>>()

async function readInstalled(profileRoot: string, operationId: string) {
  const p = restorePaths(profileRoot, operationId)
  await assertRestorePath(p.fence, profileRoot)
  if (await restoreExists(p.journal)) return bad('恢复尚未完成')
  const read = (path: string) => readRestoreText(path).then(text => createHash('sha256').update(text).digest('hex'))
  const activeHash = await read(p.fence)
  let fencePath = p.fence
  let { fence, hash: fenceHash } = await readJointRestoreFence4(fencePath)
  const seen = new Set<string>()
  while (fence.phase === 'rolledback') {
    if (seen.has(fence.operationId) || fence.parentFenceHash === null) return bad('回退链没有准确的已安装父 fence')
    seen.add(fence.operationId)
    await readJointRestoreIntent4(profileRoot, fence)
    fencePath = restorePaths(profileRoot, fence.operationId).parent
    const parent = await readJointRestoreFence4(fencePath)
    if (parent.hash !== fence.parentFenceHash) return bad('回退链父 fence 已变化')
    fence = parent.fence
    fenceHash = parent.hash
  }
  if (fence.phase !== 'installed' || fence.operationId !== operationId) return bad('当前没有对应的已安装联合恢复 fence')
  const intent = await readJointRestoreIntent4(profileRoot, fence)
  await assertJointRestoreInstalledResult4(intent)
  const proof = await readRestoreKnowledgeInstallProof(profileRoot, operationId, intent.installationProofHash)
  const { requirements } = await verifyRestoreKnowledgeInstalledDatabase(profileRoot, operationId, intent.installationProofHash, 'steady')
  const { aliases, bases, files, directory } = await withReferenceOriginalRows5((_rows, _physical, blocks, bodies) =>
    captureReopenedQualifiedOriginalContent5({ profileRoot, operationId, mountId: proof.mountId,
      expectedDescriptorHash: proof.descriptorHash }, blocks, [bodies('source'), bodies('current')]), async reopened => {
    if (!same(reopened.value.root, proof.coverage.root) || reopened.value.materialHash !== proof.rootMaterialHash
      || !requirements.entries.some(entry => same(entry, proof.coverage)) || await read(p.fence) !== activeHash
      || (await readJointRestoreFence4(fencePath)).hash !== fenceHash)
      return bad('实际 SQLite、安装凭据、qualified 原件或 fence 不是同次安装')
    const aliases = installedV3AliasOrigins(reopened.pair.source, reopened.pair.current)
    const bases = {
      source: mixedOriginCapsulePath(reopened.value.node.source, 'knowledge-complete-assets-v2'),
      current: mixedOriginCapsulePath(reopened.value.node.current, 'knowledge-complete-assets-v2')
    }
    const files = new Map(reopened.originalPackage.files.filter(file => !file.frame.length).map(file => [file.path, file]))
    return { aliases, bases, files, directory: reopened.originalPackage.directory }
  })
  const transfer = { operationId, transferId: intent.assetTransferId, manifestHash: intent.assetManifestHash }
  const history = requirements.entries.filter(entry => entry.operationId !== operationId)
    .sort((left, right) => right.acceptedAt.localeCompare(left.acceptedAt) || left.operationId.localeCompare(right.operationId))
  const verifiedTransfers = new Map<string, Promise<typeof transfer>>()
  const readPriorTransfer = (entry: typeof history[number]) => {
    const existing = verifiedTransfers.get(entry.operationId)
    if (existing) return existing
    const read = readRestoreKnowledgePriorInstall(profileRoot, entry.root, entry).then(readVerifiedPriorInstallAssetTransfer)
    verifiedTransfers.set(entry.operationId, read)
    return read
  }
  return { p, assertFence: async () => {
    if (await read(p.fence) !== activeHash || (await readJointRestoreFence4(fencePath)).hash !== fenceHash || await restoreExists(p.journal))
      return bad('核验时已安装 fence 变化')
  }, transfer, history, readPriorTransfer, requirement: proof.coverage, aliases, files, bases, directory,
    pins: { root: proof.coverage.root, qualifiedDescriptorHash: proof.descriptorHash, installationProofHash: intent.installationProofHash,
      transferId: intent.assetTransferId, transferManifestHash: intent.assetManifestHash } }
}

/** Mint only from the active installed fence and its own actual SQLite
 * receipt, transfer commitment and reopened qualified V3 byte originals. */
export async function captureInstalledV3AssetContinuity(profileRoot: string, operationId: string): Promise<InstalledV3AssetContinuity> {
  const value = await readInstalled(profileRoot, operationId)
  const owner: InstalledV3AssetContinuity = Object.freeze({ kind: 'installed-v3-asset-continuity' })
  installed.set(owner, value)
  return owner
}

export function readInstalledV3AssetContinuity(owner: InstalledV3AssetContinuity, profileRoot: string) {
  const value = installed.get(owner)
  if (!value || value.p.root !== profileRoot) return bad('不是此 profile 的实际已安装附件 owner')
  const captured = new Map<string, { alias: Alias; backupV3: InstalledV3AssetArchiveProof['backupV3']; role: 'source' | 'current';
    transfer: typeof value.transfer; identity: { dev: string; ino: string } }>()
  const proof = (tree: Capsule2ManagedTreeData) => {
    const aliases = tree.aliases.filter(file => file.bytes > ATTACHMENT_MAX_FILE_BYTES)
    const backupV3 = aliases.length ? value.aliases.get(aliases[0].relativePath)?.backupV3 : undefined
    if (!backupV3 || aliases.some(alias => !same(value.aliases.get(alias.relativePath)?.backupV3, backupV3)))
      return bad('不同 V3 原件的混合大附件需要独立的逐别名证明')
    return validateInstalledV3AssetArchiveProof({ ...value.pins, backupV3, aliases }, tree)
  }
  return Object.freeze({
    requirement: value.requirement,
    async readAlias(relativePath: string, output?: string) {
      const origin = value.aliases.get(relativePath)
      if (!origin) return
      const { alias, role, backupV3 } = origin
      const checkLive = (transfer: typeof value.transfer) => tryReadInstalledRestoreAsset4(profileRoot, transfer.operationId, transfer.transferId, transfer.manifestHash,
        { hash: alias.hash, logicalName: alias.name, bytes: alias.bytes })
      let transfer = value.transfer, identity = await checkLive(transfer)
      if (!identity && role === 'current') {
        for (const entry of value.history) {
          transfer = await value.readPriorTransfer(entry)
          identity = await checkLive(transfer)
          if (identity) break
        }
      }
      if (!identity) return bad('安装附件没有精确原 transfer 项')
      if (output) {
        const file = value.files.get(value.bases[role] + '/files/' + alias.hash)
        if (!file || file.bytes !== alias.bytes || file.sha256 !== alias.hash) return bad('缺同次 qualified 附件独立原件')
        await copyOriginCatalogFile(join(value.directory, ...referenceContextObjectPath([], file.path).split('/')),
          value.directory, join(output, alias.hash), profileRoot, { path: file.path, bytes: file.bytes, sha256: file.sha256 })
        if (!same(await checkLive(transfer), identity)) return bad('复制时已安装附件身份变化')
      }
      await value.assertFence()
      const entry = { alias, role, backupV3, transfer, identity }, previous = captured.get(relativePath)
      if (previous && !same(previous, entry)) return bad('同次捕获的逐别名来源变化')
      captured.set(relativePath, entry)
      return { alias, identity }
    },
    proof,
    async proofForArchive(tree: Capsule2ManagedTreeData, output: string) {
      const aliases = tree.aliases.filter(alias => alias.bytes > ATTACHMENT_MAX_FILE_BYTES).map(alias => {
        const entry = captured.get(alias.relativePath)
        if (!entry || !same(entry.alias, alias)) return bad('大附件未在本次捕获实际核验')
        return entry
      })
      if (new Set(aliases.map(entry => capsuleJson(entry.backupV3))).size < 2)
        return { version: 7 as const, installedV3: proof(tree) }
      const { root, qualifiedDescriptorHash, installationProofHash } = value.pins
      await value.assertFence()
      const installedV3Many = await writeInstalledV3ManyFiles(profileRoot, output,
        { root, qualifiedDescriptorHash, installationProofHash }, aliases, tree)
      await value.assertFence()
      return { version: 9 as const, installedV3Many }
    }
  })
}

/** One native base-tree capture. The caller supplies the prior entry obtained
 * from its own sealed SQL read, not a permission to inspect Working spools. */
export async function captureInstalledV3NativeBase(original: OwnedRawCapsuleOriginal, readInstalled: () => Promise<InstalledV3AssetContinuity>,
  output: string, entries: readonly RawCoverageRequirement[]) {
  const { profileRoot } = readOwnedRawCapsuleOriginal(original)
  let continuity: ReturnType<typeof readInstalledV3AssetContinuity> | undefined
  const identities = new Map<string, { dev: string; ino: string }>()
  const tree = await captureCapsule2ManagedTreeWithInstalledAssets(join(profileRoot, 'storage', 'assets'), profileRoot, join(output, 'files'),
    async (path, destination) => {
      continuity ??= readInstalledV3AssetContinuity(await readInstalled(), profileRoot)
      if (!entries.some(entry => same(entry, continuity?.requirement))) return bad('大附件权限不是本次封存 current 的原 SQL 覆盖')
      const captured = await continuity.readAlias(path, destination)
      if (!captured) return undefined
      const previous = identities.get(path)
      if (previous && !same(previous, captured.identity)) return bad('原安装附件 FD 变化')
      identities.set(path, captured.identity)
      return captured.alias
    })
  return { tree, identities, proof: continuity && await continuity.proofForArchive(tree, output) }
}
