import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { constants } from 'node:fs'
import { copyFile, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { copyRestoreInventory, restoreDirectory, restorePaths, syncRestoreDirectory, syncRestoreFile } from '../database/restore-safety-files'
import { prepareDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal, reopenPreparedRawCapsuleOriginal, type OwnedRawCapsuleOriginal }
  from '../database/restore-knowledge-capsule-files'
import { prepareCapsule2AssetArchiveFromVerifiedV3, prepareCapsule2AssetArchiveWithInstalledV3 } from '../database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchive, captureSealedCapsule2SourceWithAssetProvenance3, captureSealedCapsule2SourceWithWorkingProvenance5 }
  from '../database/restore-knowledge-capsule2-source-seal'
import { certifyCapsule2Source } from '../database/restore-knowledge-capsule2-source-certificate'
import { captureBoundOriginalInputsFromReferences } from '../database/restore-knowledge-reference-context'
import { requiredReferenceRoots } from '../database/restore-knowledge-reference-context-model'
import { withPreparedRootKnowledgeInputs5, type captureRootKnowledgeConservationPlanFromCertifiedSources3 } from '../database/restore-knowledge-root3-read'
import { withPreparedRootRestoreIdentityInputs5, type prepareRootRestoreIdentityPlan3, type PreparedRootIdentityInputs5 } from '../database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3, withPreparedRootRestoreReferenceInputs5, type Reference3Value } from '../database/restore-knowledge-reference3-read'
import type { Reference3Choices } from '../database/restore-knowledge-reference3-model'
import { restoreSqliteFilename } from '../database/restore-safety-sqlite-path'
import { prepareRootRestoreSqlAssetStage5 } from '../database/restore-knowledge-sql-asset-stage5'
import { prepareRootRestoreFinalAssetSql5 } from '../database/restore-knowledge-derived-stage4'
import { prepareRootRestoreCoverageSql } from '../database/restore-knowledge-stage3-history-sql'
import { withPreparedRestoreHistoryScope3 } from '../database/restore-knowledge-stage3-physical'
import { prepareRootRestoreAssetTransfer4 } from '../database/restore-asset-transfer4'
import { assertRestoreKnowledgeInstalledSql, writeRestoreKnowledgeInstallProof, readRestoreKnowledgeInstallProof, readVerifiedRestoreKnowledgePriorInstall,
  type RestoreKnowledgePriorInstall }
  from '../database/restore-knowledge-install-proof'
import type { RawPriorCoverageRequirements } from '../database/restore-knowledge-coverage-model'
import type { InstalledV3AssetContinuity } from '../database/restore-knowledge-installed-v3-assets'
import { readV3SettledPrivateSyncOriginals } from '../database/restore-knowledge-settled-private-sync'
import { assertBackupV3RestoreSourceCurrent, readBackupV3RestoreSource, type BackupV3RestoreSource } from './v3-reader'
import { prepareBackupV3RestoreSqlStage } from './v3-restore-sql-stage'

interface BackupV3RestorePreparation {
  profileRoot: string
  operationId: string
  source: BackupV3RestoreSource
  parents?: (requirements: RawPriorCoverageRequirements) => Promise<readonly RestoreKnowledgePriorInstall[]>
  installedAssets?: () => Promise<InstalledV3AssetContinuity>
  choices?: Reference3Choices
}

async function prepareCurrentOriginal({ profileRoot, operationId }: BackupV3RestorePreparation) {
  const paths = restorePaths(profileRoot, operationId)
  return prepareDurableSqlCapsuleOriginal({ profileRoot, recoveryDirectory: paths.recovery,
    sealedDirectory: paths.safety, capsuleId: randomUUID(), label: 'current SQL before V3 restore' })
}

/** Prepare the native restore plan from a verified V3 source and the exact
 * current SQL inventory already sealed by the exclusive maintenance owner. */
export async function prepareBackupV3RestorePlan(input: BackupV3RestorePreparation) {
  const result = await withPlanIdentityFromCurrent(input, await prepareCurrentOriginal(input), async (plan, scope) =>
    Object.freeze({ ...plan, reference: await prepareRootRestoreReferencePlan3(plan.identity.plan, input.choices, scope) }))
  assertBackupV3RestoreSourceCurrent(input.source)
  return result
}
type V3PlanIdentity = {
  v3Sql: Awaited<ReturnType<typeof prepareBackupV3RestoreSqlStage>>
  root: Awaited<ReturnType<typeof captureRootKnowledgeConservationPlanFromCertifiedSources3>>
  identity: Awaited<ReturnType<typeof prepareRootRestoreIdentityPlan3>>
  prior: readonly RestoreKnowledgePriorInstall[]
}
async function withPlanIdentityFromCurrent<T>(input: BackupV3RestorePreparation, currentOriginal: OwnedRawCapsuleOriginal,
  run: (plan: V3PlanIdentity, scope: PreparedRootIdentityInputs5) => Promise<T>) {
  const { profileRoot, operationId, source, parents, installedAssets } = input
  const v3Sql = await prepareBackupV3RestoreSqlStage(source, profileRoot, operationId)
  const archive = await prepareCapsule2AssetArchiveFromVerifiedV3(v3Sql, source)
  const incoming = await captureSealedCapsule2SourceFromArchive(archive)
  const currentInfo = readOwnedRawCapsuleOriginal(currentOriginal), currentCapsuleId = basename(currentInfo.capsuleDirectory)
  const probe = await reopenPreparedRawCapsuleOriginal({ profileRoot, operationId, capsuleId: currentCapsuleId,
    expectedInventory: currentInfo.originalInventory })
  const currentDb = new Database(restoreSqliteFilename(readOwnedRawCapsuleOriginal(probe).databasePath), { readonly: true, fileMustExist: true })
  let hasWorkingJobs: boolean
  try {
    // Read only the sealed scratch. Any private exchange job still uses the
    // full Working5 observer, including malformed family members.
    hasWorkingJobs = Boolean(currentDb.prepare("SELECT 1 FROM app_settings WHERE lower(CAST(key AS TEXT)) GLOB 'sync.webdav.protocol5.exchange-job.*' LIMIT 1").get())
  } finally { currentDb.close() }
  const current = hasWorkingJobs
    ? await captureSealedCapsule2SourceWithWorkingProvenance5(currentOriginal, installedAssets)
    : installedAssets
      ? await captureSealedCapsule2SourceFromArchive(await prepareCapsule2AssetArchiveWithInstalledV3(currentOriginal, installedAssets))
      : await captureSealedCapsule2SourceWithAssetProvenance3(currentOriginal)
  const incomingCertificate = await certifyCapsule2Source(incoming.source)
  if (incomingCertificate.status !== 'certified-without-prior-coverage') throw new Error('The V3 source unexpectedly carries prior coverage.')
  const currentCertificate = await certifyCapsule2Source(current.source)
  const requirements = current.value.priorCoverageRequirements
  const prior = requirements.entries.length ? await parents?.(requirements) ?? [] : []
  const originals = new Map(prior.map(handle => {
    const actual = readVerifiedRestoreKnowledgePriorInstall(handle)
    return [actual.requirement.operationId, actual.bundle] as const
  }))
  const references = requiredReferenceRoots(requirements)
  const currentInput = currentCertificate.status === 'certified-without-prior-coverage'
    ? currentCertificate.source
    : (await captureBoundOriginalInputsFromReferences({ source: current.source, parents: references.map(reference => {
      const original = originals.get(reference.operationId)
      if (!original) throw new Error('The sealed current source is missing a verified installed original.')
      return original
    }) })).source
  return withPreparedRootKnowledgeInputs5({
    profileRoot, operationId, dagId: randomUUID(), source: incomingCertificate.source, current: currentInput
  }, (root, scope) => withPreparedRootRestoreIdentityInputs5(root.knowledgePlan, scope, { repeatV3: prior },
    (identity, identityScope) => run({ v3Sql, root, identity, prior }, identityScope)))
}

function previewResolvedReference({ candidate }: Reference3Value) {
  const { conflicts } = candidate
  if (conflicts.length) {
    const paths = conflicts.flatMap(({ code, detail }) => code === 'duplicate-document-path' && detail && typeof detail === 'object'
      && 'path' in detail && typeof detail.path === 'string' ? [detail.path] : [])
    if (paths.length) {
      const shown = paths.slice(0, 5).map(path => path.length > 140 ? path.slice(0, 139) + '…' : path)
      const remaining = paths.length > shown.length ? `，另有 ${paths.length - shown.length} 条重复路径` : ''
      throw new Error(`V3 备份与当前工作区存在重复页面路径。${shown.map(path => `「${path}」`).join('、')}${remaining}。`)
    }
    throw new Error('V3 restore requires a resolved reference plan.')
  }
  const disposition = (tableName: 'documents' | 'synced_groups') => {
    const rows = candidate.tables.find(table => table.name === tableName)!.rows
    let incoming = 0, retained = 0, replaced = 0
    for (const row of rows) {
      if (row.sourceRef.side === 'current') retained++
      else if (row.replaces) replaced++
      else incoming++
    }
    return Object.freeze({ incoming, retained, replaced })
  }
  return Object.freeze({ documents: disposition('documents'), groups: disposition('synced_groups'),
    conflicts: conflicts.length })
}

/** Build the exact candidate and its independently readable original, plus
 * a durable transfer and SQL proof. No live files are moved by preparation. */
export async function prepareBackupV3RestoreCandidate(input: BackupV3RestorePreparation) {
  const { profileRoot, operationId, source } = input, paths = restorePaths(profileRoot, operationId)
  const currentOriginal = await prepareCurrentOriginal(input)
  const privateSync = await readV3SettledPrivateSyncOriginals(currentOriginal)
  const { root, identity, reference, preview, coverage, installed, transfer } = await withPreparedRestoreHistoryScope3(async historyScope => {
    const { root, identity, reference, prior, preview, final } = await withPlanIdentityFromCurrent(input, currentOriginal, (plan, identityScope) =>
      withPreparedRootRestoreReferenceInputs5(plan.identity.plan, input.choices, identityScope, async (reference, stageScope) => {
        assertBackupV3RestoreSourceCurrent(source)
        const preview = previewResolvedReference(reference.value)
        const combined = await prepareRootRestoreSqlAssetStage5(reference.plan, stageScope)
        const final = await prepareRootRestoreFinalAssetSql5(reference.plan, combined.stage, historyScope, stageScope)
        return { ...plan, reference, preview, final }
      }))
    const coverage = await prepareRootRestoreCoverageSql(reference.plan, final.derived.stage, prior, historyScope)
    const installed = coverage.value.coverage
    if (!installed) throw new Error('The V3 candidate is missing its original coverage readback.')
    const transfer = await prepareRootRestoreAssetTransfer4(final.aliases.owner, historyScope)
    return { root, identity, reference, preview, coverage, installed, transfer }
  })
  const copy = join(paths.recovery, 'coverage-install-read')
  await copyRestoreInventory(join(coverage.directory, 'database'), copy, [...coverage.value.inventory], profileRoot)
  const placeholder = await open(paths.stage, 'wx')
  await placeholder.close()
  const file = new Database(restoreSqliteFilename(join(copy, 'knowbook.db')), { readonly: true, fileMustExist: true })
  try {
    // The SQLite backup API emits a new, complete single-file database, even
    // when the verified source retained WAL/SHM in its private inventory.
    await file.backup(paths.stage)
  } finally { file.close() }
  const { archive, inventoryHash } = readBackupV3RestoreSource(source)
  const proofHash = await writeRestoreKnowledgeInstallProof(profileRoot, {
    operationId, mountId: root.mountId, descriptorHash: root.descriptorHash, coverage: installed,
    planHash: coverage.value.planHash, rootMaterialHash: root.value.materialHash, requirementsHash: coverage.requirementsHash,
    identity: { planId: identity.planId, expectedManifestHash: identity.manifestHash },
    reference: { planId: reference.planId, expectedManifestHash: reference.manifestHash },
    sourceArchive: { snapshotId: archive.manifest.snapshotId, inventoryHash },
    privateSync: { capsuleId: basename(readOwnedRawCapsuleOriginal(currentOriginal).capsuleDirectory), observationHash: privateSync.observationHash }
  })
  const proof = await readRestoreKnowledgeInstallProof(profileRoot, operationId, proofHash)
  const checkPath = join(copy, 'candidate-check.db')
  await copyFile(paths.stage, checkPath, constants.COPYFILE_EXCL)
  const check = new Database(restoreSqliteFilename(checkPath), { readonly: true, fileMustExist: true })
  try {
    check.pragma('query_only=ON')
    check.pragma('foreign_keys=ON')
    check.transaction(() => assertRestoreKnowledgeInstalledSql(check, proof, 'committing'))()
  } finally { check.close() }
  await syncRestoreFile(paths.stage)
  const archived = join(paths.recovery, 'joint-candidate-original')
  await restoreDirectory(archived, profileRoot, true)
  const archivedDatabase = join(archived, 'knowbook.db')
  await copyFile(paths.stage, archivedDatabase, constants.COPYFILE_EXCL)
  await syncRestoreFile(archivedDatabase)
  await syncRestoreDirectory(archived)
  await syncRestoreDirectory(paths.recovery)
  assertBackupV3RestoreSourceCurrent(source)
  return Object.freeze({ proofHash, transferId: transfer.transferId, assetManifestHash: transfer.manifestHash, preview })
}
