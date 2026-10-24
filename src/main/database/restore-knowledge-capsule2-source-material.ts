import Database from 'better-sqlite3'
import { basename } from 'node:path'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readOwnedRawCapsuleOriginal, reopenPreparedRawCapsuleOriginal,
  assertOwnedRawCapsuleScratchReady, assertOwnedRawCapsuleScratchContent } from './restore-knowledge-capsule-files'
import { readCapsule2AssetArchive, readCapsule2ArchiveSourceOriginal, readCapsule2ArchiveSourceInputs,
  type PreparedCapsule2AssetArchive } from './restore-knowledge-capsule2-asset-archive'
import { readRawCapsule2SourceKnowledgeOwned } from './restore-knowledge-payload-raw-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'

export interface PreparedCapsule2SourceMaterial { readonly kind: 'prepared-capsule2-source-material' }
type SourcePacket = Awaited<ReturnType<typeof material>>
const materials = new WeakMap<PreparedCapsule2SourceMaterial, { archive: PreparedCapsule2AssetArchive; expectedHash: string }>()
const bad = (message: string): never => { throw new Error('capsule2完整来源材料无效：' + message + '；准备材料不授完整认证、accepted覆盖或安装权。') }

/** Always reconstruct SQL from the actual archive owner's immutable original.
 * Old scratch is not input. The complete fixed source pipeline runs in one
 * readonly/query-only/FKON transaction; no source DTO/ref/selector is accepted. */
async function material(archive: PreparedCapsule2AssetArchive) {
  const { original, value: before } = await readCapsule2ArchiveSourceInputs(archive), info = readOwnedRawCapsuleOriginal(original)
  const fresh = await reopenPreparedRawCapsuleOriginal({ profileRoot: info.profileRoot, operationId: basename(info.recoveryDirectory),
    capsuleId: basename(info.capsuleDirectory), expectedInventory: info.originalInventory })
  const actual = readOwnedRawCapsuleOriginal(fresh)
  await assertOwnedRawCapsuleScratchReady(fresh)
  const db = new Database(restoreSqliteFilename(actual.databasePath), { readonly: true, fileMustExist: true })
  let captured: ReturnType<typeof readRawCapsule2SourceKnowledgeOwned>
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    captured = db.transaction(() => readRawCapsule2SourceKnowledgeOwned(db))()
  } finally { db.close(); await assertOwnedRawCapsuleScratchContent(fresh) }
  const { source, knowledge } = captured, references = source.assets, manifest = before.manifest
  if (source.sourceContent.schemaVersion !== manifest.schemaVersion || references.sourceContentHash !== manifest.sourceContentHash
    || references.workspaceHistoryObservationHash !== manifest.workspaceHistoryObservationHash || references.observationHash !== manifest.assetReferencesObservationHash
    || capsuleJson(info.originalInventory) !== capsuleJson(manifest.sourceInventory)) return bad('原SQL、完整来源与归档绑定不一致')
  const after = await readCapsule2AssetArchive(archive)
  if (after.manifestHash !== before.manifestHash) return bad('读取期间归档身份变化')
  const body = { kind: 'capsule2-complete-source-material' as const, version: 2 as const, forReader: CAPSULE2_READER,
    sourceInventory: info.originalInventory, capsuleId: basename(info.capsuleDirectory), operationId: basename(info.recoveryDirectory),
    source, knowledge, assetArchive: before.manifest, assetArchiveHash: before.manifestHash,
    priorCoverageRequirements: source.total.observer.coverage.requirements,
    certified: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const,
    unresolved: ['qualified-prior-root-resolution','streaming-source-adapter','complete-private-capsule2-certifier-and-installer'] as const }
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整来源包超有限材料预算，不截断')
  return freezeCapsuleValue({ ...body, materialHash: capsuleBytesHash('knowbook.capsule2.complete-source-material.v2\0' + encoded) })
}
export async function extractCapsule2SourceMaterial(archive: PreparedCapsule2AssetArchive): Promise<PreparedCapsule2SourceMaterial> {
  return (await captureCapsule2SourceMaterial(archive)).material
}
/** Only a genuine archive can start this complete SQL capture. The initial
 * value belongs to the same capture that mints the new material handle. */
export async function captureCapsule2SourceMaterial(archive: PreparedCapsule2AssetArchive) {
  const value = await material(archive), handle: PreparedCapsule2SourceMaterial = Object.freeze({ kind: 'prepared-capsule2-source-material' })
  materials.set(handle, { archive, expectedHash: value.materialHash })
  return Object.freeze({ material: handle, value })
}
/** This is private original data for the future full certifier and installer.
 * Requerying all SQL and archive bytes precedes every use; no global cache. */
export async function readCapsule2SourceMaterial(handle: PreparedCapsule2SourceMaterial): Promise<SourcePacket> {
  const entry = materials.get(handle)
  if (!entry) return bad('不是实际Main完整来源私有句柄')
  const value = await material(entry.archive)
  if (value.materialHash !== entry.expectedHash) return bad('完整来源包或哈希变化')
  return value
}

/** Main-internal durable owner seam. Authenticate the real material registry
 * and rebuild its complete source before revealing its actual original owner.
 * This does not resolve original native/imported domains or grant admission. */
export async function readCapsule2SourceSealInput(handle: PreparedCapsule2SourceMaterial) {
  const entry = materials.get(handle)
  if (!entry) return bad('不是实际Main完整来源私有句柄')
  const value = await readCapsule2SourceMaterial(handle)
  const original = await readCapsule2ArchiveSourceOriginal(entry.archive)
  return Object.freeze({ value, original })
}
export async function diagnoseCapsule2SourceMaterial(handle: PreparedCapsule2SourceMaterial) {
  const value = await readCapsule2SourceMaterial(handle)
  return freezeCapsuleValue({ kind: 'capsule2-source-material-diagnostic' as const, materialHash: value.materialHash,
    schemaVersion: value.source.sourceContent.schemaVersion, tables: value.source.sourceContent.tables.length,
    rows: value.source.sourceContent.tables.reduce((count, table) => count + table.rows.length, 0),
    assetFiles: value.assetArchive.tree.files.length, references: value.assetArchive.referenceCount,
    knowledgeGroups: value.knowledge.groups.length, knowledgeOccupancy: value.knowledge.occupancy.length,
    requiredRoots: value.priorCoverageRequirements.entries.length, certified: false as const, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const })
}
