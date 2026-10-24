import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue, validateDurableSqlCapsuleInventory,
  type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { CAPSULE2_READER, CAPSULE2_RAW_MAX_JSON_BYTES, type Capsule2Encoding } from './restore-knowledge-capsule2-raw-model'
import { durableSqlDagUuid } from './restore-knowledge-dag-model'

/** Durable complete local source input, not accepted historical coverage.
 * Original reference domains remain unresolved until a qualified owner reads
 * every required root. This format cannot mint a certificate or installer. */
export interface Capsule2SourceManifest {
  readonly kind: 'restore-durable-sql-capsule'; readonly version: 2; readonly readerVersion: typeof CAPSULE2_READER
  readonly material: 'complete-sql-and-managed-originals'; readonly state: 'sealed-local-source-inputs'
  readonly referenceAuthority: 'unresolved-original-references'
  readonly operationId: string; readonly capsuleId: string; readonly schemaVersion: 26 | 27; readonly encoding: Capsule2Encoding
  readonly workspaceScope: string; readonly recoveryEpoch: string; readonly files: readonly DurableSqlCapsuleFile[]
  readonly schemaHash: string; readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string
  readonly assetReferencesObservationHash: string; readonly sourceKnowledgeHash: string; readonly sourceMaterialHash: string
  readonly assetArchiveHash: string; readonly sourcePolicyHash: string; readonly priorRequirementsHash: string; readonly requiredRoots: number
  readonly certified: false; readonly semanticValidationComplete: false; readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
}
const keys = ['kind','version','readerVersion','material','state','referenceAuthority','operationId','capsuleId','schemaVersion','encoding',
  'workspaceScope','recoveryEpoch','files','schemaHash','sourceContentHash','workspaceHistoryObservationHash','assetReferencesObservationHash',
  'sourceKnowledgeHash','sourceMaterialHash','assetArchiveHash','sourcePolicyHash','priorRequirementsHash','requiredRoots',
  'certified','semanticValidationComplete','acceptedCoverage','effective','permit']
export const capsule2SourceSealInvalid = (message: string): never => { throw new Error('capsule2完整来源封存无效：' + message + '；不授来源域解释、完整认证、accepted/effective或安装权，失败新目录保留。') }
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : capsule2SourceSealInvalid('原hash无效')
const scope = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value) ? value : capsule2SourceSealInvalid('原scope/epoch无效')
export const capsule2SourceManifestHash = (value: Capsule2SourceManifest): string => capsuleBytesHash('knowbook.capsule2.source-manifest.v2\0' + capsuleJson(value))
export function parseCapsule2SourceManifest(text: string, operationId: string, capsuleId: string, expectedHash: unknown): Capsule2SourceManifest {
  const value = parseStrictJson(text, { maxBytes: CAPSULE2_RAW_MAX_JSON_BYTES, maxDepth: 12 }), row = capsuleRecord(value, keys)
  if (text !== capsuleJson(value) + '\n' || capsuleBytesHash('knowbook.capsule2.source-manifest.v2\0' + capsuleJson(value)) !== hash(expectedHash))
    return capsule2SourceSealInvalid('规范原字节或预期hash不符')
  if (row.kind !== 'restore-durable-sql-capsule' || row.version !== 2 || row.readerVersion !== CAPSULE2_READER
    || row.material !== 'complete-sql-and-managed-originals' || row.state !== 'sealed-local-source-inputs'
    || row.referenceAuthority !== 'unresolved-original-references' || row.operationId !== operationId || row.capsuleId !== capsuleId
    || row.schemaVersion !== 26 && row.schemaVersion !== 27
    || row.encoding !== 'UTF-8' && row.encoding !== 'UTF-16le' && row.encoding !== 'UTF-16be') return capsule2SourceSealInvalid('格式/身份/原schema编码无效')
  for (const key of ['certified','semanticValidationComplete','acceptedCoverage','effective','permit']) if (row[key] !== false) return capsule2SourceSealInvalid('权限标志升级')
  if (typeof row.requiredRoots !== 'number' || !Number.isSafeInteger(row.requiredRoots) || row.requiredRoots < 0) return capsule2SourceSealInvalid('完整要求计数无效')
  return freezeCapsuleValue({ kind: 'restore-durable-sql-capsule', version: 2, readerVersion: CAPSULE2_READER,
    material: 'complete-sql-and-managed-originals', state: 'sealed-local-source-inputs', referenceAuthority: 'unresolved-original-references',
    operationId: durableSqlDagUuid(row.operationId), capsuleId: durableSqlDagUuid(row.capsuleId), schemaVersion: row.schemaVersion,
    encoding: row.encoding, workspaceScope: scope(row.workspaceScope), recoveryEpoch: scope(row.recoveryEpoch), files: validateDurableSqlCapsuleInventory(row.files),
    schemaHash: hash(row.schemaHash), sourceContentHash: hash(row.sourceContentHash), workspaceHistoryObservationHash: hash(row.workspaceHistoryObservationHash),
    assetReferencesObservationHash: hash(row.assetReferencesObservationHash), sourceKnowledgeHash: hash(row.sourceKnowledgeHash), sourceMaterialHash: hash(row.sourceMaterialHash),
    assetArchiveHash: hash(row.assetArchiveHash), sourcePolicyHash: hash(row.sourcePolicyHash), priorRequirementsHash: hash(row.priorRequirementsHash), requiredRoots: row.requiredRoots,
    certified: false, semanticValidationComplete: false, acceptedCoverage: false, effective: false, permit: false })
}
