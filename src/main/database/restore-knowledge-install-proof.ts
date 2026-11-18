import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagList, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { coverageSettingKey, parseSyncedKnowledgeCoverage, rawPriorCoverageRequirementsHash, validateRawPriorCoverageRequirements,
  type CoverageRootReference, type RawCoverageRequirement } from './restore-knowledge-coverage-model'
import { readRawPriorKnowledgeCoverageOwned } from './restore-knowledge-coverage-raw-read'
import { validateV3RestoreSourceTombstoneEvidence } from '../backup/v3-restore-source-tombstone-model'
import { RESTORE_FENCE, assertRestorePath, copyRestoreInventory, readRestoreJson, readRestoreText, restoreInventory, restorePaths, writeRestoreJson }
  from './restore-safety-files'
import { parseRestoreJson, restoreHash, restoreJson, validateRestoreFence, validateRestoreIntent } from './restore-safety-model'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { assertRootRestoreStage3DatabaseReadonly3, discardRootRestoreStage3Probe3 } from './restore-knowledge-stage3-physical'
import { assertOriginCatalogDirectory } from './restore-knowledge-origin-bundle-files'
import { assertJointRestoreInstalledResult4, jointRestorePaths4, readJointRestoreFence4, readJointRestoreIntent4,
  type JointRestoreIntent4 } from './restore-joint-journal4'
import { captureReopenedRootKnowledgeConservationPlan3 } from './restore-knowledge-root3-read'
import { readRootRestoreReferenceFromQualified5 } from './restore-knowledge-reference3-read'
import { validateV3SettledPrivateSyncLocator, type V3SettledPrivateSyncLocator } from './restore-knowledge-settled-private-sync'
import { readV3SourceGroupRetirementsOwned, v3SourceGroupRetirementHash, type V3SourceGroupRetirement } from './v3-source-group-retirement'

interface RestoreKnowledgeInstallProofV1 {
  readonly kind: 'controlled-restore-knowledge-install-proof'
  readonly version: 1
  readonly operationId: string
  readonly mountId: string
  readonly descriptorHash: string
  readonly coverage: RawCoverageRequirement
  readonly planHash: string
  readonly rootMaterialHash: string
}
type Locator = { readonly planId: string; readonly expectedManifestHash: string }
type RestoreKnowledgeInstallProofV2 = Omit<RestoreKnowledgeInstallProofV1, 'version'> & {
  readonly version: 2
  readonly requirementsHash: string
  readonly identity: Locator
  readonly reference: Locator
  readonly sourceArchive: { readonly snapshotId: string; readonly inventoryHash: string }
}
type RestoreKnowledgeInstallProofV3 = Omit<RestoreKnowledgeInstallProofV2, 'version'> & {
  readonly version: 3
  readonly privateSync: V3SettledPrivateSyncLocator
}
type RestoreKnowledgeInstallProofV4 = Omit<RestoreKnowledgeInstallProofV2, 'version'> & {
  readonly version: 4
  readonly privateSync?: V3SettledPrivateSyncLocator
  readonly retirements: readonly { readonly groupId: string; readonly sourceGroupId: string; readonly sourceCreationId: string;
    readonly recordHash: string; readonly remoteEvidenceHash: string }[]
}
type RestoreKnowledgeInstallProof = RestoreKnowledgeInstallProofV1 | RestoreKnowledgeInstallProofV2 | RestoreKnowledgeInstallProofV3 | RestoreKnowledgeInstallProofV4
const restoreJsonLimit = 1024 * 1024

function fail(reason: string): never {
  throw new Error('恢复安装凭据核验失败：' + reason)
}

function validateProof(value: unknown): RestoreKnowledgeInstallProof {
  const version = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  const keys = ['kind', 'version', 'operationId', 'mountId', 'descriptorHash', 'coverage', 'planHash', 'rootMaterialHash']
  const planKeys = [...keys, 'requirementsHash', 'identity', 'reference', 'sourceArchive']
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) return fail('未知安装凭据格式')
  const privateSync = version === 3 || version === 4 && Object.hasOwn(value as object, 'privateSync')
  const row = capsuleRecord(value, version === 1 ? keys : [...planKeys, ...(privateSync ? ['privateSync'] : []), ...(version === 4 ? ['retirements'] : [])])
  if (row.kind !== 'controlled-restore-knowledge-install-proof') return fail('未知安装凭据类型')
  const operationId = durableSqlDagUuid(row.operationId)
  const { entries: [coverage] } = validateRawPriorCoverageRequirements({ kind: 'restore-knowledge-unresolved-required-roots',
    version: 1, schemaVersion: 27, entries: [row.coverage] })
  if (coverage.operationId !== operationId) return fail('安装操作与原 SQLite 覆盖记录不符')
  const common = { kind: row.kind, operationId, mountId: durableSqlDagUuid(row.mountId),
    descriptorHash: durableSqlDagHash(row.descriptorHash), coverage, planHash: durableSqlDagHash(row.planHash),
    rootMaterialHash: durableSqlDagHash(row.rootMaterialHash) } as const
  const locator = (value: unknown) => {
    const item = capsuleRecord(value, ['planId', 'expectedManifestHash'])
    return { planId: durableSqlDagUuid(item.planId), expectedManifestHash: durableSqlDagHash(item.expectedManifestHash) }
  }
  if (version === 1) return freezeCapsuleValue({ ...common, version: 1 as const })
  const archive = capsuleRecord(row.sourceArchive, ['snapshotId', 'inventoryHash'])
  const planned = { ...common, requirementsHash: durableSqlDagHash(row.requirementsHash),
    identity: locator(row.identity), reference: locator(row.reference), sourceArchive: {
      snapshotId: durableSqlDagUuid(archive.snapshotId), inventoryHash: durableSqlDagHash(archive.inventoryHash) } }
  if (version === 4) {
    const retirements = durableSqlDagList(row.retirements, restoreJsonLimit).map(value => {
      const item = capsuleRecord(value, ['groupId', 'sourceGroupId', 'sourceCreationId', 'recordHash', 'remoteEvidenceHash'])
      return { groupId: durableSqlDagUuid(item.groupId), sourceGroupId: durableSqlDagUuid(item.sourceGroupId),
        sourceCreationId: durableSqlDagUuid(item.sourceCreationId), recordHash: durableSqlDagHash(item.recordHash),
        remoteEvidenceHash: durableSqlDagHash(item.remoteEvidenceHash) }
    })
    if (!retirements.length || retirements.some(({ groupId }, index) => index > 0 && retirements[index - 1].groupId >= groupId))
      return fail('退场凭据必须按组标识严格排序且无重复')
    return freezeCapsuleValue({ ...planned, version: 4 as const, retirements,
      ...(privateSync ? { privateSync: validateV3SettledPrivateSyncLocator(row.privateSync) } : {}) })
  }
  return freezeCapsuleValue(version === 3 ? { ...planned, version: 3 as const, privateSync: validateV3SettledPrivateSyncLocator(row.privateSync) }
    : { ...planned, version: 2 as const })
}

function proofPath(profileRoot: string, operationId: string): string {
  return join(restorePaths(profileRoot, operationId).recovery, 'knowledge-install-proof.json')
}

async function assertRetirementEvidence(profileRoot: string, proof: RestoreKnowledgeInstallProofV4) {
  const recovery = restorePaths(profileRoot, proof.operationId).recovery
  let head: { headHash: string; etag: string } | undefined
  for (const { groupId, sourceGroupId, sourceCreationId, remoteEvidenceHash } of proof.retirements) {
    const path = join(recovery, `v3-source-tombstone-${groupId}.json`)
    await assertRestorePath(path, profileRoot)
    const text = await readRestoreText(path, remoteEvidenceHash).catch(cause => {
      throw new Error('恢复安装凭据核验失败：实际封存的 WebDAV 退场原件变化', { cause })
    })
    const observation = validateV3RestoreSourceTombstoneEvidence(parseRestoreJson(text), { sourceGroupId, sourceCreationId })
    if (head && (head.headHash !== observation.headHash || head.etag !== observation.etag)) return fail('退场集合中的 WebDAV 原件来自不同远端版本')
    head = observation
  }
}

/** Write the exact SQL and qualified-original pins before the outer moving
 * journal. The caller separately owns candidate admission and the commit. */
export async function writeRestoreKnowledgeInstallProof(profileRoot: string,
  input: Omit<RestoreKnowledgeInstallProofV1, 'kind' | 'version'> | Omit<RestoreKnowledgeInstallProofV2, 'kind' | 'version'>
    | Omit<RestoreKnowledgeInstallProofV3, 'kind' | 'version'> | Omit<RestoreKnowledgeInstallProofV4, 'kind' | 'version'>) {
  const version = 'retirements' in input ? 4 : 'privateSync' in input ? 3 : 'requirementsHash' in input ? 2 : 1
  const proof = validateProof({ kind: 'controlled-restore-knowledge-install-proof', version, ...input })
  if (Buffer.byteLength(restoreJson(proof)) > restoreJsonLimit) return fail('安装凭据超出原件预算')
  if (proof.version === 4) await assertRetirementEvidence(profileRoot, proof)
  await writeRestoreJson(proofPath(profileRoot, proof.operationId), proof, profileRoot, true)
  return restoreHash(proof)
}

export async function readRestoreKnowledgeInstallProof(profileRoot: string, operationId: string, expectedHash: string) {
  const path = proofPath(profileRoot, operationId)
  await assertRestorePath(path, profileRoot)
  const proof = validateProof(await readRestoreJson(path))
  if (proof.operationId !== operationId || restoreHash(proof) !== durableSqlDagHash(expectedHash))
    return fail('实际凭据与恢复意图不符')
  if (proof.version === 4) await assertRetirementEvidence(profileRoot, proof)
  return proof
}

function assertRetirementRecords(records: readonly V3SourceGroupRetirement[], proof: RestoreKnowledgeInstallProofV4) {
  const byGroup = new Map(records.map(record => [record.group.id, record]))
  if (byGroup.size !== proof.retirements.length || byGroup.size !== records.length) return fail('实际 SQLite 退场集合与正式安装凭据不符')
  for (const item of proof.retirements) {
    const record = byGroup.get(item.groupId)
    if (!record || record.operationId !== proof.operationId || record.successorSnapshotId !== proof.sourceArchive.snapshotId
      || record.sourceGroupId !== item.sourceGroupId || record.sourceCreationId !== item.sourceCreationId
      || record.remoteEvidenceHash !== item.remoteEvidenceHash || v3SourceGroupRetirementHash(record) !== item.recordHash)
      return fail('实际 SQLite 退场记录与正式安装凭据不符')
  }
}

/** Check the actual SQLite supports. Committing also requires the exact
 * recovery epoch and document CAS allocated by the verified candidate. */
export function assertRestoreKnowledgeInstalledSql(db: Database.Database, proof: RestoreKnowledgeInstallProof, phase: 'committing' | 'steady') {
  return verifyInstalledSqlOwned(db, proof, phase).coverage
}

function verifyInstalledSqlOwned(db: Database.Database, proof: RestoreKnowledgeInstallProof, phase: 'committing' | 'steady') {
  const requirements = readRawPriorKnowledgeCoverageOwned(db)
  const entry = requirements.entries.find(item => item.operationId === proof.operationId)
  if (!entry || restoreJson(entry) !== restoreJson(proof.coverage)) return fail('实际 SQLite 收据、覆盖或历史支持变化')
  if (proof.version === 1 ? requirements.entries.length !== 1 : rawPriorCoverageRequirementsHash(requirements) !== proof.requirementsHash)
    return fail('实际 SQLite 覆盖全集与安装凭据不同')
  const text = db.prepare('SELECT value FROM main.app_settings WHERE key=?').pluck().get(coverageSettingKey(proof.operationId))
  if (typeof text !== 'string') return fail('SQLite 缺少覆盖正文')
  const coverage = parseSyncedKnowledgeCoverage(text)
  if (coverage.planHash !== proof.planHash || coverage.rootMaterialHash !== proof.rootMaterialHash)
    return fail('实际 SQLite 恢复计划或原件材料不同')
  const current = db.prepare('SELECT workspace_scope,recovery_epoch FROM main.synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: string; recovery_epoch: string } | undefined
  if (!current || current.workspace_scope !== coverage.target.workspaceScope || current.recovery_epoch !== coverage.target.recoveryEpoch
    || phase === 'committing' && db.prepare('SELECT 1 FROM main.documents WHERE updated_at IS NOT ? LIMIT 1').get(coverage.target.documentBoundary))
    return fail('实际 SQLite 工作区或安装版本不同')
  const retirements = readV3SourceGroupRetirementsOwned(db)
  const own = [...retirements.values()].filter(record => record.operationId === proof.operationId)
  if (proof.version === 4) assertRetirementRecords(own, proof)
  else if (own.length) return fail('退场记录没有本次正式安装凭据')
  return { coverage, requirements, retirements }
}

/** The installed path is never opened by receipt verification. A private
 * copy of all three SQLite files can read WAL without modifying the originals. */
export async function verifyRestoreKnowledgeInstalledDatabase(profileRoot: string, operationId: string, expectedProofHash: string,
  phase: 'committing' | 'steady') {
  const proof = await readRestoreKnowledgeInstallProof(profileRoot, operationId, expectedProofHash)
  const paths = restorePaths(profileRoot, operationId)
  const { coverage, requirements, retirements } = await readExactInstalledSql(profileRoot, operationId, proof, phase,
    paths.storage, await restoreInventory(paths.storage))
  if (phase === 'steady') await assertPriorV3SourceRetirements(profileRoot, operationId, retirements.values())
  return { coverage, requirements }
}

export async function assertPriorV3SourceRetirements(profileRoot: string, operationId: string,
  retirements: Iterable<V3SourceGroupRetirement>) {
  const byOperation = new Map<string, V3SourceGroupRetirement[]>()
  for (const record of retirements) {
    if (record.operationId === operationId) continue
    const records = byOperation.get(record.operationId) ?? []
    records.push(record)
    byOperation.set(record.operationId, records)
  }
  for (const [priorId, records] of byOperation) {
    const intent = await readInstalledAncestor(profileRoot, priorId)
    const prior = await readRestoreKnowledgeInstallProof(profileRoot, priorId, intent.installationProofHash)
    if (prior.version !== 4) return fail('原祖先退场缺正式安装凭据')
    assertRetirementRecords(records, prior)
  }
}

async function readExactInstalledSql(profileRoot: string, operationId: string, proof: RestoreKnowledgeInstallProof,
  phase: 'committing' | 'steady', directory: string, inventory: Awaited<ReturnType<typeof restoreInventory>>) {
  const { coverage, requirements, retirements } = await readExactInstalledSqlWith(profileRoot, operationId, proof, phase, directory, inventory, () => undefined)
  return { coverage, requirements, retirements }
}

/** Read additional original installed SQL facts from the detached, closed
 * candidate and its exact installation proof. The callback owns no writer. */
export async function readCommittedRestoreCandidateSql<T>(intent: JointRestoreIntent4, read: (db: Database.Database) => T) {
  await assertJointRestoreInstalledResult4(intent)
  const { profileRoot, operationId, candidateInventory, installationProofHash } = intent
  const proof = await readRestoreKnowledgeInstallProof(profileRoot, operationId, installationProofHash)
  const directory = jointRestorePaths4(profileRoot, operationId).candidateOriginal
  return (await readExactInstalledSqlWith(profileRoot, operationId, proof, 'committing', directory, candidateInventory, read)).original
}

async function readExactInstalledSqlWith<T>(profileRoot: string, operationId: string, proof: RestoreKnowledgeInstallProof,
  phase: 'committing' | 'steady', directory: string, inventory: Awaited<ReturnType<typeof restoreInventory>>, read: (db: Database.Database) => T) {
  const paths = restorePaths(profileRoot, operationId)
  if (!inventory[0].present) return fail('缺已安装 SQLite 主库')
  const scratch = join(paths.recovery, 'installed-read-' + randomUUID())
  await copyRestoreInventory(directory, scratch, inventory, profileRoot)
  const identity = await assertOriginCatalogDirectory(scratch, profileRoot)
  try {
    const db = new Database(restoreSqliteFilename(join(scratch, 'knowbook.db')), { readonly: true, fileMustExist: true })
    let result
    try {
      db.pragma('query_only=ON')
      db.pragma('foreign_keys=ON')
      result = db.transaction(() => {
        if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length)
          return fail('已安装 SQLite 的实际完整性检查失败')
        const verified = verifyInstalledSqlOwned(db, proof, phase)
        return { ...verified, original: read(db) }
      })()
    } finally { db.close() }
    await assertRootRestoreStage3DatabaseReadonly3(scratch, profileRoot, inventory)
    if (restoreJson(await restoreInventory(directory)) !== restoreJson(inventory)) return fail('核验期间已安装 SQLite 原件变化')
    return result
  } finally {
    await discardRootRestoreStage3Probe3(scratch, profileRoot, identity)
  }
}

export interface RestoreKnowledgePriorInstall { readonly kind: 'verified-restore-knowledge-prior-install' }
type Prior = {
  profileRoot: string
  intent: JointRestoreIntent4
  proof: Exclude<RestoreKnowledgeInstallProof, RestoreKnowledgeInstallProofV1>
  coverage: Awaited<ReturnType<typeof readExactInstalledSql>>['coverage']
  original: Awaited<ReturnType<typeof captureReopenedRootKnowledgeConservationPlan3>>
}
const priorInstalls = new WeakMap<RestoreKnowledgePriorInstall, Prior>()

export function readVerifiedRestoreKnowledgePriorInstall(handle: RestoreKnowledgePriorInstall) {
  const item = priorInstalls.get(handle)
  if (!item) return fail('历史安装证明需要真实 Main owner')
  return Object.freeze({ profileRoot: item.profileRoot, bundle: item.original.bundle, coverage: item.coverage,
    requirement: item.proof.coverage, rootMaterialHash: item.proof.rootMaterialHash, descriptorHash: item.proof.descriptorHash,
    sourceArchive: item.proof.sourceArchive,
    async assertOriginalProof() {
      const intent = await readInstalledAncestor(item.profileRoot, item.proof.operationId)
      if (restoreHash(intent) !== restoreHash(item.intent)) return fail('已安装历史 intent 变化')
      await readRestoreKnowledgeInstallProof(item.profileRoot, intent.operationId, intent.installationProofHash)
      const candidate = jointRestorePaths4(item.profileRoot, intent.operationId).candidateOriginal
      if (restoreJson(await restoreInventory(candidate)) !== restoreJson(intent.candidateInventory)) return fail('历史已安装 SQL 原件变化')
    },
    readReferenceInputs() {
      return readRootRestoreReferenceFromQualified5({ profileRoot: item.profileRoot, operationId: item.proof.operationId,
        mountId: item.proof.mountId, expectedDescriptorHash: item.proof.descriptorHash }, item.proof.identity, item.proof.reference)
    } })
}

/** Return the exact transfer owned by an independently re-opened installed C.
 * A matching caller-generated root or proof DTO cannot select it. */
export function readVerifiedPriorInstallAssetTransfer(handle: RestoreKnowledgePriorInstall) {
  const item = priorInstalls.get(handle)
  if (!item) return fail('历史附件转移需要实际已安装 owner')
  return Object.freeze({ operationId: item.intent.operationId, transferId: item.intent.assetTransferId,
    manifestHash: item.intent.assetManifestHash })
}

async function readInstalledAncestor(profileRoot: string, operationId: string): Promise<JointRestoreIntent4> {
  let fencePath = join(profileRoot, RESTORE_FENCE), expectedHash: string | null = null
  const seen = new Set<string>()
  for (;;) {
    await assertRestorePath(fencePath, profileRoot)
    const text = await readRestoreText(fencePath), value = JSON.parse(text)
    const actualHash = createHash('sha256').update(text).digest('hex')
    if (expectedHash !== null && actualHash !== expectedHash) return fail('历史恢复 fence 字节变化')
    if (value?.kind === 'controlled-joint-restore-fence') {
      const { fence, hash } = await readJointRestoreFence4(fencePath)
      if (hash !== actualHash || seen.has(fence.operationId) || fence.phase === 'prepared') return fail('历史联合 fence 变化或未完成')
      const intent = await readJointRestoreIntent4(profileRoot, fence)
      if (fence.operationId === operationId && fence.phase === 'installed') {
        await assertJointRestoreInstalledResult4(intent)
        return intent
      }
      seen.add(fence.operationId)
      expectedHash = intent.parentFenceHash
      fencePath = restorePaths(profileRoot, fence.operationId).parent
    } else {
      const fence = validateRestoreFence(value)
      if (seen.has(fence.operationId) || fence.phase === 'prepared') return fail('历史普通 fence 循环或未完成')
      const paths = restorePaths(profileRoot, fence.operationId)
      await assertRestorePath(paths.intent, profileRoot)
      const intent = validateRestoreIntent(await readRestoreJson(paths.intent))
      if (intent.profileRoot !== profileRoot || intent.databasePath !== paths.database || intent.operationId !== fence.operationId
        || restoreHash(intent) !== fence.intentHash || intent.parentFenceHash !== fence.parentFenceHash)
        return fail('历史普通 fence 与 intent 不同')
      seen.add(fence.operationId)
      expectedHash = intent.parentFenceHash
      fencePath = paths.parent
    }
    if (expectedHash === null) return fail('原 SQL 引用未出现在已安装恢复链')
  }
}

/** A prior C is accepted only from the exact archived installed candidate,
 * its externally linked installed fence and the original native root. */
export async function readRestoreKnowledgePriorInstall(profileRoot: string, reference: CoverageRootReference,
  expectedCoverage: RawCoverageRequirement): Promise<RestoreKnowledgePriorInstall> {
  if (reference.namespace.kind !== 'native' || restoreJson(reference) !== restoreJson(expectedCoverage.root))
    return fail('原 SQL 覆盖引用不是准确的 native 恢复根')
  const intent = await readInstalledAncestor(profileRoot, reference.operationId)
  const proof = await readRestoreKnowledgeInstallProof(profileRoot, intent.operationId, intent.installationProofHash)
  if (proof.version === 1 || restoreJson(proof.coverage) !== restoreJson(expectedCoverage))
    return fail('原 SQL 覆盖与已安装历史回执不一致或缺计划 locator')
  const candidate = jointRestorePaths4(profileRoot, intent.operationId).candidateOriginal
  const [{ coverage }, original] = await Promise.all([
    readExactInstalledSql(profileRoot, intent.operationId, proof, 'committing', candidate, intent.candidateInventory),
    captureReopenedRootKnowledgeConservationPlan3({ profileRoot, operationId: proof.operationId, mountId: proof.mountId,
      expectedDescriptorHash: proof.descriptorHash })
  ])
  if (restoreJson(original.value.root) !== restoreJson(reference) || original.value.materialHash !== proof.rootMaterialHash
    || restoreJson(original.value.node.source) !== restoreJson(coverage.source) || restoreJson(original.value.node.current) !== restoreJson(coverage.current))
    return fail('历史实际原件与已安装 C 的双侧绑定不一致')
  const handle: RestoreKnowledgePriorInstall = Object.freeze({ kind: 'verified-restore-knowledge-prior-install' })
  priorInstalls.set(handle, { profileRoot, intent, proof, coverage, original })
  return handle
}

