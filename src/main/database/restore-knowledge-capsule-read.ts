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
  readDurableSqlCapsuleSeal, sealDurableSqlCapsule, type OwnedRawCapsuleOriginal,
  type DurableSqlCapsuleSeal } from './restore-knowledge-capsule-files'
import { capsuleInvalid, freezeCapsuleValue, type DurableSqlCapsuleDraft } from './restore-knowledge-capsule-model'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

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
    const draft: DurableSqlCapsuleDraft | { schemaVersion: number } = current.transaction(() => {
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
    })()
    db.close(); db = undefined
    await assertOwnedRawCapsuleOriginal(original)
    if (!('facts' in draft)) return Object.freeze({ status: 'unsupported-schema', schemaVersion: draft.schemaVersion })
    const seal = await sealDurableSqlCapsule(original, draft)
    const observed = await readDurableSqlCapsuleSeal(original)
    if (observed.manifestHash !== seal.manifestHash) return capsuleInvalid('认证后原manifest被替换')
    await assertOwnedRawCapsuleOriginal(original)
    const handle: CertifiedDurableSqlCapsule = Object.freeze({ kind: 'certified-durable-sql-capsule' })
    certified.set(handle, { original, manifestHash: seal.manifestHash })
    return Object.freeze({ status: 'certified', capsule: handle })
  } finally { db?.close(); certifying.delete(original) }
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
