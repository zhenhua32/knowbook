import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { buildSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES, durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'
import { syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { assertOriginalFrameDirectory, writeOriginalFrameDirectory, type OriginalFrameCopy } from './restore-knowledge-original-frame-files'
import { referenceContextObjectPath } from './restore-knowledge-reference-context-model'
import { assertRootRestoreSqlAssetStageBytes5, readRootRestoreSqlAssetClosureCopySource5, type RootRestoreSqlAssetStage5 } from './restore-knowledge-sql-asset-stage5'
import { restoreDirectory } from './restore-safety-files'

export interface RootRestoreAssetAliasStage5 { readonly kind: 'main-root-restore-asset-alias-stage5' }
type Source = Awaited<ReturnType<typeof readRootRestoreSqlAssetClosureCopySource5>>
type Locator = { stageId: string; expectedManifestHash: string }
type Saved = Locator & { combined: RootRestoreSqlAssetStage5 }
type Alias = { path: string; hash: string; bytes: number; logicalName: string; occurrences: number }
const owners = new WeakMap<RootRestoreAssetAliasStage5, Saved>()
const fail = (reason: string): never => { throw new Error('恢复附件别名暂存失败：' + reason) }
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const collection = (location: Source['location']) => join(location.profileRoot, 'backups', 'database-restore', location.operationId,
  'restore-final-asset-alias-stages-v5')

function derive(source: Source, stageId: string) {
  const byPath = new Map<string, { alias: Alias; file: OriginalFrameCopy }>(), portablePaths = new Map<string, string[]>()
  const audit = source.audit
  if (source.matched.length !== audit.matched) return fail('审计与已验原件数不同')
  let totalBytes = 0
  for (const { entry, file } of source.matched) {
    const { hash, bytes, logicalName } = entry.proof
    buildSyncedPortableAssetUri({ hash, name: logicalName })
    if (file.sha256 !== hash || file.bytes !== bytes || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > ATTACHMENT_MAX_FILE_BYTES)
      return fail('原范围未绑定确切文件字节')
    const path = 'attachments/' + hash.slice(0, 2) + '/' + hash + '/' + logicalName
    const existing = byPath.get(path)
    if (existing) {
      if (existing.alias.hash !== hash || existing.alias.bytes !== bytes || existing.alias.logicalName !== logicalName) return fail('同目标别名的原件不同')
      existing.alias.occurrences++
      continue
    }
    totalBytes += bytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return fail('完整别名文件超过原字节预算')
    byPath.set(path, { alias: { path, hash, bytes, logicalName, occurrences: 1 }, file: { ...file, frame: [], path } })
    const key = path.normalize('NFC').toLowerCase(), spellings = portablePaths.get(key) ?? []
    spellings.push(path); portablePaths.set(key, spellings)
  }
  if (!byPath.size) return fail('没有可逐原范围证明的别名')
  const ordered = [...byPath.values()].sort((left, right) => compare(left.alias.path, right.alias.path))
  const aliasPathConflicts = [...portablePaths.values()].filter(paths => paths.length > 1).map(paths => paths.sort(compare))
    .sort((left, right) => compare(left[0], right[0]))
  const value = { kind: 'root-restore-asset-alias-stage5' as const, version: 1 as const, stageId,
    combinedStageId: source.combinedStageId, combinedManifestHash: source.combinedManifestHash,
    assetClosureObservationHash: audit.observationHash, physicalObservationHash: audit.physicalObservationHash,
    aliases: ordered.map(entry => entry.alias), totalBytes,
    remaining: { blockedOccurrences: audit.blocked, scopes: audit.remainder, aliasPathConflicts },
    finalAssetClosureComplete: false as const, installPermit: false as const }
  assertMerge3JsonBudget(value)
  const text = capsuleJson(value) + '\n'
  return { value: freezeCapsuleValue(value), text, manifestHash: capsuleBytesHash(text), files: ordered.map(entry => entry.file),
    directory: join(collection(source.location), stageId), location: source.location }
}

function mint(saved: Saved, actual: ReturnType<typeof derive>) {
  const owner: RootRestoreAssetAliasStage5 = Object.freeze({ kind: 'main-root-restore-asset-alias-stage5' })
  owners.set(owner, saved)
  return Object.freeze({ owner, stageId: saved.stageId, value: actual.value, directory: actual.directory, manifestHash: actual.manifestHash })
}

async function verify(saved: Saved) {
  const source = await readRootRestoreSqlAssetClosureCopySource5(saved.combined)
  const actual = derive(source, saved.stageId)
  if (actual.manifestHash !== saved.expectedManifestHash) return fail('实际原件和别名不等于持久清单')
  await assertOriginalFrameDirectory(actual.directory, actual.text, actual.files)
  await assertRootRestoreSqlAssetStageBytes5(saved.combined)
  await assertOriginalFrameDirectory(actual.directory, actual.text, actual.files)
  return { ...actual, source }
}

async function prepare(combined: RootRestoreSqlAssetStage5) {
  const stageId = randomUUID(), source = await readRootRestoreSqlAssetClosureCopySource5(combined)
  const actual = { ...derive(source, stageId), source }
  const base = collection(actual.location), root = actual.location.profileRoot
  await restoreDirectory(base, root)
  await writeOriginalFrameDirectory({ profileRoot: root, directory: actual.directory, descriptorText: actual.text, files: actual.files })
  await syncOriginCatalogAncestors(base, root)
  await assertRootRestoreSqlAssetStageBytes5(combined)
  await assertOriginalFrameDirectory(actual.directory, actual.text, actual.files)
  return { saved: { combined, stageId, expectedManifestHash: actual.manifestHash }, actual }
}

/** One independent file for each confirmed logical alias, including aliases
 * that share a SHA. Uncovered audit entries remain visible and cannot stage. */
export async function prepareRootRestoreAssetAliasStage5(combined: RootRestoreSqlAssetStage5) {
  const { saved, actual } = await prepare(combined)
  return mint(saved, actual)
}

async function reopen(combined: RootRestoreSqlAssetStage5, locator: Locator) {
  const row = capsuleRecord(locator, ['stageId', 'expectedManifestHash'])
  const stageId = durableSqlDagUuid(row.stageId), expectedManifestHash = durableSqlDagHash(row.expectedManifestHash)
  const saved = { combined, stageId, expectedManifestHash }, actual = await verify(saved)
  return { saved, actual }
}

export async function reopenRootRestoreAssetAliasStage5(combined: RootRestoreSqlAssetStage5, locator: Locator) {
  const { saved, actual } = await reopen(combined, locator)
  return mint(saved, actual)
}

/** Fixed R4 read. Each source path is the freshly verified independent alias
 * object. The receiving writer must still pin the exact bytes during its copy. */
export async function readRootRestoreAssetAliasStageCopies5(owner: RootRestoreAssetAliasStage5) {
  const saved = owners.get(owner)
  if (!saved) return fail('不是实际附件别名 owner')
  const actual = await verify(saved)
  return freezeCapsuleValue({ stageId: saved.stageId, manifestHash: actual.manifestHash,
    location: { profileRoot: actual.location.profileRoot, operationId: actual.location.operationId },
    assetClosureObservationHash: actual.value.assetClosureObservationHash, remaining: actual.value.remaining,
    installPermit: false as const, files: actual.value.aliases.map(({ hash, bytes, logicalName, path }) => ({ hash, bytes, logicalName, path,
      sourceRoot: actual.directory, sourcePath: join(actual.directory, referenceContextObjectPath([], path)) })) })
}

/** The SQL rewrite needs the exact matched occurrences behind these files,
 * including their original role and address. Do not reconstruct them by SHA. */
export async function readRootRestoreAssetAliasSqlSource5(owner: RootRestoreAssetAliasStage5) {
  const saved = owners.get(owner)
  if (!saved) return fail('不是实际附件别名 owner')
  return sqlSource(saved, await verify(saved))
}

function sqlSource(saved: Saved, actual: Awaited<ReturnType<typeof verify>>) {
  return Object.freeze({ source: actual.source, aliases: actual.value.aliases, remaining: actual.value.remaining,
    stageId: saved.stageId, manifestHash: actual.manifestHash,
    async assertOriginalBytes() {
      await assertRootRestoreSqlAssetStageBytes5(saved.combined)
      await assertOriginalFrameDirectory(actual.directory, actual.text, actual.files)
    } })
}

/** Keep this invocation's authenticated input with the alias it produced.
 * Downstream writers still check the original and persisted bytes at their tails. */
export async function prepareRootRestoreAssetAliasWithSqlSource5(combined: RootRestoreSqlAssetStage5) {
  const { saved, actual } = await prepare(combined)
  return { aliases: mint(saved, actual), input: sqlSource(saved, actual) }
}

export async function reopenRootRestoreAssetAliasWithSqlSource5(combined: RootRestoreSqlAssetStage5, locator: Locator) {
  const { saved, actual } = await reopen(combined, locator)
  return { aliases: mint(saved, actual), input: sqlSource(saved, actual) }
}
