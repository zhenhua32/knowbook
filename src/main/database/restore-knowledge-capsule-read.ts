import { relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import type Sqlite from 'better-sqlite3'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { inspectOrdinaryRestoreConnection, inspectRawRestoreConnection } from './restore-safety-read'
import { auditRestoreKnowledgeConnection, readRestoreKnowledgeCapture } from './restore-safety-knowledge'
import { readRawInitialIncomingWorkspaceOwned } from './synced-initial-incoming-raw-read'
import { assertRawSyncedHistoricalEvidenceOwned } from './synced-operation-history-read'
import { readHistoricalRowLocator } from './synced-history-evidence-support'
import { readRawRestoreSqlInventoryOwned } from './restore-knowledge-sql-inventory'
import { assertOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchReady, readOwnedRawCapsuleOriginal,
  readDurableSqlCapsuleSeal, completeDurableSqlCapsuleSeal, reopenDurableSqlCapsuleOriginal, type ReopenDurableSqlCapsuleOriginalInput, type OwnedRawCapsuleOriginal,
  type DurableSqlCapsuleSeal } from './restore-knowledge-capsule-files'
import { capsuleInvalid, freezeCapsuleValue, type DurableSqlCapsuleDraft } from './restore-knowledge-capsule-model'
import { readRawCapsuleKnowledgePayloadOwned } from './restore-knowledge-payload-raw-read'
import { knowledgePayloadHash, type CapsuleKnowledgePayload, type KnowledgeCapsuleRef } from './restore-knowledge-payload-model'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')


/** Exact former certifier transaction body, shared by certification and fixed
 * payload extraction. No caller callback/mode or effective reader is involved. */
function readDurableSqlCapsuleDraftOwned(current: Sqlite.Database): DurableSqlCapsuleDraft | { schemaVersion: number } {
  if (!current.open || !current.inTransaction) return capsuleInvalid('完整原SQL draft读取要求真实owned事务')
  const version = current.pragma('user_version', { simple: true })
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > 27)
    return capsuleInvalid('不支持的原schema版本；不会推定empty')
  if (version < 26) return { schemaVersion: version }
  // Inventory first authenticates typed SQL bytes and closes the namespace.
  const inventory = readRawRestoreSqlInventoryOwned(current)
  const inspection = inspectRawRestoreConnection(current)
  const history = assertRawSyncedHistoricalEvidenceOwned(current)
  const locators = new Map<string, string>()
  for (const fact of history.facts) for (const locator of [fact.locator, ...fact.supports]) {
    const key = publicationJson([locator.table, locator.key]), prior = locators.get(key)
    if (prior && prior !== locator.rowHash) return capsuleInvalid('同一原SQL支持出现矛盾hash')
    if (!prior) {
      const actual = readHistoricalRowLocator(current, locator.table, locator.key)
      if (actual.rowHash !== locator.rowHash) return capsuleInvalid('事实定位不等于准确原SQL完整行')
      locators.set(key, actual.rowHash)
    }
  }
  // Ordinary SQL is not publication wire. Only the existing owned audit and
  // ordinary inspector can prove its empty synced knowledge. In particular,
  // valid ordinary titles/templates need not meet a network wire budget or
  // carry identities that their real Store writer never reserved.
  const noSyncPhysical = !current.prepare('SELECT 1 FROM synced_groups LIMIT 1').get()
    && !current.prepare("SELECT 1 FROM blocks WHERE type='synced-block' LIMIT 1").get()
    && !current.prepare("SELECT 1 FROM block_identities WHERE last_owner_kind='group' LIMIT 1").get()
  const ordinaryAudit = noSyncPhysical ? readRestoreKnowledgeCapture(auditRestoreKnowledgeConnection(current)) : null
  if (ordinaryAudit?.status === 'empty') {
    const ordinary = inspectOrdinaryRestoreConnection(current)
    if (history.facts.length || history.operations || history.metadata) return capsuleInvalid('原ordinary空知识与已认证同步历史矛盾')
    const historicalTables = new Set(['block_identities', 'document_block_routes', 'backup_restore_identities',
      'document_history', 'document_trash', 'document_block_moves', 'document_templates'])
    return {
      schemaVersion: ordinary.schemaVersion, workspaceScope: ordinary.workspaceScope, recoveryEpoch: ordinary.recoveryEpoch,
      schemaHash: inventory.schemaHash,
      workspaceHash: publicationHash(publicationJson({ domain: 'knowbook.durable-sql.ordinary-workspace.v1',
        sqlInventory: inventory.inventoryHash, workspaceScope: ordinary.workspaceScope, recoveryEpoch: ordinary.recoveryEpoch })),
      historyIdentityHash: publicationHash(publicationJson({ domain: 'knowbook.durable-sql.ordinary-history.v1',
        tables: inventory.tables.filter(table => historicalTables.has(table.name)) })),
      facts: history.facts
    }
  }
  const workspace = readRawInitialIncomingWorkspaceOwned(current)
  return {
    schemaVersion: inspection.schemaVersion, workspaceScope: inspection.workspaceScope, recoveryEpoch: inspection.recoveryEpoch,
    schemaHash: inventory.schemaHash,
    workspaceHash: publicationHash(publicationJson({ domain: 'knowbook.durable-sql.workspace.v1',
      snapshot: workspace.snapshot.localFingerprint, sqlInventory: inventory.inventoryHash })),
    // Retain the actual original literal identity/history preimage.
    historyIdentityHash: publicationHash(publicationJson({ snapshot: workspace.snapshot.localFingerprint,
      rawIdentities: workspace.rawIdentities, historyRows: workspace.historyRows })),
    facts: history.facts
  }
}

/** Process-local identity only. Neither the JSON manifest nor a diagnostic DTO
 * can be supplied in place of the original Main-owned certification. */
export interface CertifiedDurableSqlCapsule { readonly kind: 'certified-durable-sql-capsule' }
const certified = new WeakMap<CertifiedDurableSqlCapsule, { original: OwnedRawCapsuleOriginal; manifestHash: string }>()
const certifying = new WeakSet<OwnedRawCapsuleOriginal>()

export type DurableSqlCapsuleCertification =
  | { readonly status: 'certified'; readonly capsule: CertifiedDurableSqlCapsule }
  | { readonly status: 'unsupported-schema'; readonly schemaVersion: number }

/** All semantic reads occur in one actual read-only scratch transaction. No
 * caller snapshot, K, current CAS equality, network execution or removable spool
 * enters this durable SQL certification. Source/current are independent. */
export async function certifyDurableSqlCapsuleOriginal(original: OwnedRawCapsuleOriginal): Promise<CertifiedDurableSqlCapsule> {
  const result = await certifyDurableSqlCapsuleIfSupported(original)
  return result.status === 'certified' ? result.capsule : capsuleInvalid('尚无该schema的完整SQL历史adapter；不授认证或迁移权')
}

/** The existing legacy ordinary restore keeps its own unchanged admission.
 * This explicit unsupported result cannot stand for certified empty knowledge. */
export async function certifyDurableSqlCapsuleIfSupported(original: OwnedRawCapsuleOriginal): Promise<DurableSqlCapsuleCertification> {
  // Authenticate registry identity before placing it in a WeakSet.
  const info = readOwnedRawCapsuleOriginal(original)
  if (certifying.has(original)) return capsuleInvalid('原件已在认证中')
  certifying.add(original)
  let db: Sqlite.Database | undefined
  try {
    await assertOwnedRawCapsuleScratchReady(original)
    db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    const current = db
    const draft = current.transaction(() => readDurableSqlCapsuleDraftOwned(current))()
    db.close(); db = undefined
    await assertOwnedRawCapsuleOriginal(original)
    if (!('facts' in draft)) return Object.freeze({ status: 'unsupported-schema', schemaVersion: draft.schemaVersion })
    const seal = await completeDurableSqlCapsuleSeal(original, draft)
    const observed = await readDurableSqlCapsuleSeal(original)
    if (observed.manifestHash !== seal.manifestHash) return capsuleInvalid('认证后原manifest被替换')
    await assertOwnedRawCapsuleOriginal(original)
    const handle: CertifiedDurableSqlCapsule = Object.freeze({ kind: 'certified-durable-sql-capsule' })
    certified.set(handle, { original, manifestHash: seal.manifestHash })
    return Object.freeze({ status: 'certified', capsule: handle })
  } finally { db?.close(); certifying.delete(original) }
}

/** Independent process restart entry. A trusted owning root provides only the
 * persisted locator/hash; all SQL, originals, support locators and complete
 * manifest/fact hashes are reread before this process can mint a certificate. */
export async function reopenCertifiedDurableSqlCapsule(input: ReopenDurableSqlCapsuleOriginalInput): Promise<CertifiedDurableSqlCapsule> {
  return certifyDurableSqlCapsuleOriginal(await reopenDurableSqlCapsuleOriginal(input))
}

/** Fresh original inventory and complete artifact readback on every use. This
 * evidence is deliberately not an installer, publication, or old inverse permit. */
export async function readCertifiedDurableSqlCapsule(handle: CertifiedDurableSqlCapsule): Promise<DurableSqlCapsuleSeal> {
  const entry = certified.get(handle)
  if (!entry) return capsuleInvalid('不是Main认证的原SQL capsule句柄')
  const observed = await readDurableSqlCapsuleSeal(entry.original)
  if (observed.manifestHash !== entry.manifestHash) return capsuleInvalid('认证原manifest身份变化')
  return observed
}

export async function diagnoseCertifiedDurableSqlCapsule(handle: CertifiedDurableSqlCapsule) {
  const seal = await readCertifiedDurableSqlCapsule(handle)
  return freezeCapsuleValue({ kind: 'durable-sql-capsule-diagnostic' as const, material: seal.manifest.material,
    schemaVersion: seal.manifest.schemaVersion, manifestHash: seal.manifestHash, facts: seal.manifest.evidenceIndex.entries,
    certifiedForInstallation: false as const })
}

/** Complete payload process identity. A JSON/ref/index diagnostic cannot be
 * substituted for a real original which passed this fixed SQL extractor. */
export interface CertifiedCapsuleKnowledge { readonly kind: 'certified-capsule-knowledge' }
const knowledgePayloads = new WeakMap<CertifiedCapsuleKnowledge, { capsule: CertifiedDurableSqlCapsule; payload: CapsuleKnowledgePayload; payloadHash: string }>()

export async function extractCertifiedDurableSqlCapsuleKnowledge(handle: CertifiedDurableSqlCapsule): Promise<CertifiedCapsuleKnowledge> {
  const entry = certified.get(handle)
  if (!entry) return capsuleInvalid('K提取不是Main真实认证capsule句柄')
  const seal = await readCertifiedDurableSqlCapsule(handle), parentInfo = readOwnedRawCapsuleOriginal(entry.original)
  const parts = relative(parentInfo.profileRoot, seal.manifestPath).split(sep)
  if (parts.length !== 6 || parts[0] !== 'backups' || parts[1] !== 'database-restore'
    || parts[3] !== 'knowledge-capsules' || parts[5] !== 'manifest.json') return capsuleInvalid('K提取原件不在私有固定profile路径')
  const reference: KnowledgeCapsuleRef = Object.freeze({ kind: 'durable-sql-capsule-ref', version: 1,
    operationId: parts[2], capsuleId: parts[4], manifestHash: entry.manifestHash })
  // Reopen makes an exclusive new independent scratch; the original and any
  // previous disposable scratch are never opened with SQLite.
  const fresh = await reopenDurableSqlCapsuleOriginal({ profileRoot: parentInfo.profileRoot, operationId: parts[2],
    capsuleId: parts[4], expectedManifestHash: entry.manifestHash })
  const info = readOwnedRawCapsuleOriginal(fresh)
  let db: Sqlite.Database | undefined
  try {
    await assertOwnedRawCapsuleScratchReady(fresh)
    db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    const current = db
    const captured = current.transaction(() => {
      const draft = readDurableSqlCapsuleDraftOwned(current)
      if (!('facts' in draft)) return capsuleInvalid('K提取尚无该schema完整adapter')
      return { draft, payload: readRawCapsuleKnowledgePayloadOwned(current, reference, draft) }
    })()
    db.close(); db = undefined
    const completed = await completeDurableSqlCapsuleSeal(fresh, captured.draft)
    if (completed.manifestHash !== entry.manifestHash) return capsuleInvalid('K完整SQL draft重建不等于认证manifest')
    // Late original/artifact reads are mandatory. No caller expected hash or
    // sparse fact index can stand in for the reconstructed SQL payload above.
    await assertOwnedRawCapsuleOriginal(fresh)
    const final = await readCertifiedDurableSqlCapsule(handle)
    if (final.manifestHash !== completed.manifestHash) return capsuleInvalid('K提取期间原manifest身份变化')
    const result: CertifiedCapsuleKnowledge = Object.freeze({ kind: 'certified-capsule-knowledge' })
    knowledgePayloads.set(result, { capsule: handle, payload: captured.payload, payloadHash: knowledgePayloadHash(captured.payload) })
    return result
  } finally { db?.close() }
}

export async function readCertifiedCapsuleKnowledge(handle: CertifiedCapsuleKnowledge): Promise<CapsuleKnowledgePayload> {
  const entry = knowledgePayloads.get(handle)
  if (!entry) return capsuleInvalid('不是Main提取的完整K payload句柄')
  await readCertifiedDurableSqlCapsule(entry.capsule)
  if (entry.payloadHash !== knowledgePayloadHash(entry.payload)) return capsuleInvalid('K私有payload身份变化')
  return entry.payload
}

/** Safe ordinary diagnostic: never returns archived history/body/settings. The
 * full payload reader above is Main-internal for the private DAG/union owner. */
export async function diagnoseCertifiedCapsuleKnowledge(handle: CertifiedCapsuleKnowledge) {
  const payload = await readCertifiedCapsuleKnowledge(handle), entry = knowledgePayloads.get(handle)!
  return freezeCapsuleValue({ kind: 'durable-sql-knowledge-payload-summary' as const, version: 1 as const,
    capsule: payload.capsule, payloadHash: entry.payloadHash, schemaVersion: payload.schemaVersion,
    groups: payload.groups.length, denials: payload.denials.length, exposures: payload.exposures.length,
    observations: payload.observations.length, occupancy: payload.occupancy.length, acceptedCoverage: false as const })
}

import { readDurableSqlCapsuleSealNow } from './restore-knowledge-capsule-files'

/** Private certified identity -> fixed synchronous artifact witness. Not SQL
 * recertification, accepted coverage or live/publication/install permission. */
export function readCertifiedDurableSqlCapsuleNow(handle: CertifiedDurableSqlCapsule): DurableSqlCapsuleSeal {
  const entry = certified.get(handle)
  if (!entry) return capsuleInvalid('同步witness不是Main真实SQL认证capsule句柄')
  const seal = readDurableSqlCapsuleSealNow(entry.original)
  if (seal.manifestHash !== entry.manifestHash) return capsuleInvalid('同步witness原manifest身份变化')
  return seal
}

import { readRawPriorKnowledgeCoverageOwned } from './restore-knowledge-coverage-raw-read'
import { rawPriorCoverageRequirementsHash, type RawPriorCoverageRequirements } from './restore-knowledge-coverage-model'
import type { DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'

/** Actual raw SQL facts only. No namespace interpretation, accepted relation,
 * empty-knowledge proof or current/effective transaction authority. */
export interface CertifiedCapsulePriorCoverage { readonly kind: 'certified-capsule-prior-coverage' }
export interface UnresolvedCertifiedCapsulePriorCoverage {
  readonly kind: 'unresolved-certified-capsule-prior-coverage'; readonly version: 1
  readonly capsule: { readonly operationId: string; readonly capsuleId: string; readonly manifestHash: string
    readonly readerVersion: 'knowbook-durable-sql-v1' }
  readonly originalFiles: readonly DurableSqlCapsuleFile[]
  readonly requirements: RawPriorCoverageRequirements; readonly rawRequirementsHash: string
  readonly namespaceResolved: false; readonly emptyKnowledgeProven: false; readonly acceptedCoverage: false
}
const priorCoverageCaptures = new WeakMap<CertifiedCapsulePriorCoverage, {
  capsule: CertifiedDurableSqlCapsule; value: UnresolvedCertifiedCapsulePriorCoverage
}>()
/** Fixed Main owner: full draft and requirements are captured in one genuine
 * independent scratch SQL snapshot. A caller cannot provide a map or subset. */
export async function captureCertifiedCapsulePriorCoverage(handle: CertifiedDurableSqlCapsule): Promise<CertifiedCapsulePriorCoverage> {
  const entry = certified.get(handle)
  if (!entry) return capsuleInvalid('prior coverage不是Main实际SQL认证capsule句柄')
  const seal = await readCertifiedDurableSqlCapsule(handle)
  if (seal.manifest.version !== 1 || seal.manifest.readerVersion !== 'knowbook-durable-sql-v1' || seal.manifest.material !== 'durable-sql-only')
    return capsuleInvalid('prior coverage v1拒绝未知capsule格式；不能将新证据重新标为v1')
  const originalInfo = readOwnedRawCapsuleOriginal(entry.original)
  const parts = relative(originalInfo.profileRoot, seal.manifestPath).split(sep)
  if (parts.length !== 6 || parts[0] !== 'backups' || parts[1] !== 'database-restore'
    || parts[3] !== 'knowledge-capsules' || parts[5] !== 'manifest.json') return capsuleInvalid('prior coverage不在真实Main固定原件目录')
  const fresh = await reopenDurableSqlCapsuleOriginal({ profileRoot: originalInfo.profileRoot, operationId: parts[2],
    capsuleId: parts[4], expectedManifestHash: entry.manifestHash })
  const info = readOwnedRawCapsuleOriginal(fresh)
  let db: Sqlite.Database | undefined
  try {
    await assertOwnedRawCapsuleScratchReady(fresh)
    db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    const current = db
    const captured = current.transaction(() => {
      const draft = readDurableSqlCapsuleDraftOwned(current)
      if (!('facts' in draft)) return capsuleInvalid('prior coverage缺该schema完整原SQL adapter')
      return { draft, requirements: readRawPriorKnowledgeCoverageOwned(current) }
    })()
    db.close(); db = undefined
    const completed = await completeDurableSqlCapsuleSeal(fresh, captured.draft)
    if (completed.manifestHash !== entry.manifestHash) return capsuleInvalid('prior coverage完整SQL重建不等于原manifest')
    await assertOwnedRawCapsuleOriginal(fresh)
    const final = await readCertifiedDurableSqlCapsule(handle)
    if (final.manifestHash !== completed.manifestHash) return capsuleInvalid('prior coverage提取期间真实原件变化')
    const value: UnresolvedCertifiedCapsulePriorCoverage = freezeCapsuleValue({ kind: 'unresolved-certified-capsule-prior-coverage', version: 1,
      capsule: { operationId: parts[2], capsuleId: parts[4], manifestHash: final.manifestHash, readerVersion: 'knowbook-durable-sql-v1' },
      originalFiles: final.manifest.files, requirements: captured.requirements,
      rawRequirementsHash: rawPriorCoverageRequirementsHash(captured.requirements),
      namespaceResolved: false, emptyKnowledgeProven: false, acceptedCoverage: false })
    const result: CertifiedCapsulePriorCoverage = Object.freeze({ kind: 'certified-capsule-prior-coverage' })
    priorCoverageCaptures.set(result, { capsule: handle, value })
    return result
  } finally { db?.close() }
}
export async function readCertifiedCapsulePriorCoverage(handle: CertifiedCapsulePriorCoverage): Promise<UnresolvedCertifiedCapsulePriorCoverage> {
  const entry = priorCoverageCaptures.get(handle)
  if (!entry) return capsuleInvalid('不是Main真实owned SQL prior coverage提取句柄')
  const seal = await readCertifiedDurableSqlCapsule(entry.capsule)
  if (seal.manifestHash !== entry.value.capsule.manifestHash
    || rawPriorCoverageRequirementsHash(entry.value.requirements) !== entry.value.rawRequirementsHash)
    return capsuleInvalid('prior coverage真实原件或私有要求集变化')
  return entry.value
}

/** Fixed first-generation input capture. Both raw prior requirements and K
 * come from one real independent SQL snapshot; no caller facts or selectors
 * are accepted. Nonempty prior-C remains unresolved and cannot mint this pair. */
export async function captureCertifiedCapsuleNoPriorSourceInputs(handle: CertifiedDurableSqlCapsule) {
  const entry = certified.get(handle)
  if (!entry) return capsuleInvalid('不是Main实际SQL认证的v1来源句柄')
  const seal = await readCertifiedDurableSqlCapsule(handle)
  if (seal.manifest.version !== 1 || seal.manifest.readerVersion !== 'knowbook-durable-sql-v1' || seal.manifest.material !== 'durable-sql-only')
    return capsuleInvalid('paired v1来源拒绝未知capsule格式，不降级')
  const parent = readOwnedRawCapsuleOriginal(entry.original), parts = relative(parent.profileRoot, seal.manifestPath).split(sep)
  if (parts.length !== 6 || parts[0] !== 'backups' || parts[1] !== 'database-restore'
    || parts[3] !== 'knowledge-capsules' || parts[5] !== 'manifest.json') return capsuleInvalid('paired v1来源不在真实Main固定目录')
  const reference: KnowledgeCapsuleRef = Object.freeze({ kind: 'durable-sql-capsule-ref', version: 1,
    operationId: parts[2], capsuleId: parts[4], manifestHash: entry.manifestHash })
  const fresh = await reopenDurableSqlCapsuleOriginal({ profileRoot: parent.profileRoot, operationId: parts[2],
    capsuleId: parts[4], expectedManifestHash: entry.manifestHash })
  const info = readOwnedRawCapsuleOriginal(fresh)
  let db: Sqlite.Database | undefined
  try {
    await assertOwnedRawCapsuleScratchReady(fresh)
    db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    const current = db
    const captured = current.transaction(() => {
      const draft = readDurableSqlCapsuleDraftOwned(current)
      if (!('facts' in draft)) return capsuleInvalid('paired v1来源缺该schema完整原SQL adapter')
      const requirements = readRawPriorKnowledgeCoverageOwned(current)
      if (requirements.entries.length) return capsuleInvalid('真实v1 prior-C未解决，不能降empty')
      return { draft, requirements, projection: readRawCapsuleKnowledgePayloadOwned(current, reference, draft) }
    })()
    db.close(); db = undefined
    const completed = await completeDurableSqlCapsuleSeal(fresh, captured.draft)
    if (completed.manifestHash !== entry.manifestHash) return capsuleInvalid('paired v1完整SQL draft不等于认证manifest')
    await assertOwnedRawCapsuleOriginal(fresh)
    const final = await readCertifiedDurableSqlCapsule(handle)
    if (final.manifestHash !== completed.manifestHash) return capsuleInvalid('paired v1捕获期间真实原件变化')
    const value: UnresolvedCertifiedCapsulePriorCoverage = freezeCapsuleValue({ kind: 'unresolved-certified-capsule-prior-coverage', version: 1,
      capsule: { operationId: parts[2], capsuleId: parts[4], manifestHash: final.manifestHash, readerVersion: 'knowbook-durable-sql-v1' },
      originalFiles: final.manifest.files, requirements: captured.requirements,
      rawRequirementsHash: rawPriorCoverageRequirementsHash(captured.requirements),
      namespaceResolved: false, emptyKnowledgeProven: false, acceptedCoverage: false })
    knowledgePayloadHash(captured.projection)
    return freezeCapsuleValue({ seal: final, value, projection: captured.projection })
  } finally { db?.close() }
}

/** Cold capture only: original draft, complete raw prior-C and K come from the
 * same real readonly transaction. No existing handle or caller packet enters.
 * Ordinary later readers above retain their complete original validation. */
export async function captureReopenedCertifiedCapsuleNoPriorSourceInputs(input: ReopenDurableSqlCapsuleOriginalInput) {
  const original = await reopenDurableSqlCapsuleOriginal(input), info = readOwnedRawCapsuleOriginal(original)
  const before = await readDurableSqlCapsuleSeal(original)
  if (before.manifest.version !== 1 || before.manifest.readerVersion !== 'knowbook-durable-sql-v1' || before.manifest.material !== 'durable-sql-only')
    return capsuleInvalid('cold paired v1来源拒绝未知格式')
  const parts = relative(info.profileRoot, before.manifestPath).split(sep)
  if (parts.length !== 6 || parts[0] !== 'backups' || parts[1] !== 'database-restore'
    || parts[3] !== 'knowledge-capsules' || parts[5] !== 'manifest.json') return capsuleInvalid('cold paired v1来源不在固定Main目录')
  const reference: KnowledgeCapsuleRef = Object.freeze({ kind: 'durable-sql-capsule-ref', version: 1,
    operationId: parts[2], capsuleId: parts[4], manifestHash: before.manifestHash })
  if (certifying.has(original)) return capsuleInvalid('原件已在认证中')
  certifying.add(original)
  let db: Sqlite.Database | undefined
  try {
    await assertOwnedRawCapsuleScratchReady(original)
    db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    const current = db
    const captured = current.transaction(() => {
      const draft = readDurableSqlCapsuleDraftOwned(current)
      if (!('facts' in draft)) return capsuleInvalid('cold paired v1来源缺完整原SQL adapter')
      const requirements = readRawPriorKnowledgeCoverageOwned(current)
      if (requirements.entries.length) return capsuleInvalid('真实v1 prior-C未解决，不能降empty')
      return { draft, requirements, projection: readRawCapsuleKnowledgePayloadOwned(current, reference, draft) }
    })()
    db.close(); db = undefined
    const completed = await completeDurableSqlCapsuleSeal(original, captured.draft)
    if (completed.manifestHash !== before.manifestHash) return capsuleInvalid('cold paired完整SQL draft不等于原manifest')
    await assertOwnedRawCapsuleOriginal(original)
    const final = await readDurableSqlCapsuleSeal(original)
    if (final.manifestHash !== completed.manifestHash) return capsuleInvalid('cold paired来源读取期间原件变化')
    await assertOwnedRawCapsuleOriginal(original)
    const value: UnresolvedCertifiedCapsulePriorCoverage = freezeCapsuleValue({ kind: 'unresolved-certified-capsule-prior-coverage', version: 1,
      capsule: { operationId: parts[2], capsuleId: parts[4], manifestHash: final.manifestHash, readerVersion: 'knowbook-durable-sql-v1' },
      originalFiles: final.manifest.files, requirements: captured.requirements,
      rawRequirementsHash: rawPriorCoverageRequirementsHash(captured.requirements),
      namespaceResolved: false, emptyKnowledgeProven: false, acceptedCoverage: false })
    knowledgePayloadHash(captured.projection)
    const source: CertifiedDurableSqlCapsule = Object.freeze({ kind: 'certified-durable-sql-capsule' })
    certified.set(source, { original, manifestHash: final.manifestHash })
    return freezeCapsuleValue({ source, seal: final, value, projection: captured.projection })
  } finally { db?.close(); certifying.delete(original) }
}
