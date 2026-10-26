// Closed data format for an explicitly non-executable stage; it mints no owner.
import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagHash, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES } from './restore-knowledge-capsule2-raw-model'

export const STAGE3_MARKER_PREFIX = 'synced.recovery.history.stage3.v1.'
export const STAGE3_MARKER_FAMILY = 'synced.recovery.history.stage3.'
export const STAGE3_MARKER_MAX_JSON_BYTES = 16 * 1024

/** Exact original-current recovery-family footprint, excluding the NEW stage
 * key only after that key has independently matched this Main-owned intent.
 * The limits here are this existing source family inside the certified raw
 * source, not a new budget applied to every table in a normal workspace. */
export interface Stage3OriginalRecoveryFamily {
  readonly rows: number
  readonly valueBytes: number
  readonly sha256: string
}
export interface RootRestoreStage3Marker {
  readonly kind: 'root-restore-non-executable-stage'
  readonly version: 1
  readonly scope: 'physical-candidate-only'
  readonly stageId: string
  readonly preparedAt: string
  readonly copyId: string
  readonly copyManifestHash: string
  /** Hash of the pre-write stage intent. That intent must not include this
   * marker's hash, the final database hash, or the final manifest hash. */
  readonly stageIntentHash: string
  readonly referencePlanId: string
  readonly referenceManifestHash: string
  readonly baseIdentityAllocationHash: string
  readonly derivedReferenceAllocationHash: string
  readonly checkedCanonicalCandidateHash: string
  readonly sourceMaterialHash: string
  readonly currentMaterialHash: string
  readonly conservationHash: string
  readonly originalDescriptorHash: string
  readonly currentOriginalInventoryHash: string
  readonly originalRecoveryFamily: Stage3OriginalRecoveryFamily
  readonly historyCutComplete: false
  readonly acceptedCoverage: false
  readonly effective: false
  readonly permit: false
}

const markerKeys = ['kind', 'version', 'scope', 'stageId', 'preparedAt', 'copyId', 'copyManifestHash', 'stageIntentHash',
  'referencePlanId', 'referenceManifestHash', 'baseIdentityAllocationHash', 'derivedReferenceAllocationHash',
  'checkedCanonicalCandidateHash', 'sourceMaterialHash', 'currentMaterialHash', 'conservationHash', 'originalDescriptorHash',
  'currentOriginalInventoryHash', 'originalRecoveryFamily', 'historyCutComplete', 'acceptedCoverage', 'effective', 'permit'] as const
const hashKeys = ['copyManifestHash', 'stageIntentHash', 'referenceManifestHash', 'baseIdentityAllocationHash',
  'derivedReferenceAllocationHash', 'checkedCanonicalCandidateHash', 'sourceMaterialHash', 'currentMaterialHash',
  'conservationHash', 'originalDescriptorHash', 'currentOriginalInventoryHash'] as const
export function stage3MarkerInvalid(message: string): never {
  throw new Error('非执行恢复stage标记无效：' + message + '；不授原件、历史执行或安装权限。')
}
export function validateStage3OriginalRecoveryFamily(input: unknown): Stage3OriginalRecoveryFamily {
  const row = capsuleRecord(input, ['rows', 'valueBytes', 'sha256'])
  if (typeof row.rows !== 'number' || !Number.isSafeInteger(row.rows) || row.rows < 0 || row.rows > CAPSULE2_RAW_MAX_ROWS
    || typeof row.valueBytes !== 'number' || !Number.isSafeInteger(row.valueBytes) || row.valueBytes < 0 || row.valueBytes > CAPSULE2_RAW_MAX_VALUE_BYTES)
    return stage3MarkerInvalid('原recovery family计量超准确来源格式预算')
  if ((row.rows === 0) !== (row.valueBytes === 0)) return stage3MarkerInvalid('空family行数与原字节计量不符')
  return Object.freeze({ rows: row.rows, valueBytes: row.valueBytes, sha256: durableSqlDagHash(row.sha256) })
}

/** Pure format validation. Supplying matching strings cannot create a genuine
 * reference, copy, stage owner, or permission. The fixed Main stage producer
 * must construct this value from its freshly verified private chain. */
export function validateRootRestoreStage3Marker(input: unknown): RootRestoreStage3Marker {
  const row = capsuleRecord(input, markerKeys)
  if (row.kind !== 'root-restore-non-executable-stage' || row.version !== 1 || row.scope !== 'physical-candidate-only'
    || row.historyCutComplete !== false || row.acceptedCoverage !== false || row.effective !== false || row.permit !== false)
    return stage3MarkerInvalid('未知stage版本/scope或虚假完成许可')
  for (const key of ['stageId', 'copyId', 'referencePlanId'] as const) durableSqlDagUuid(row[key])
  for (const key of hashKeys) durableSqlDagHash(row[key])
  if (typeof row.preparedAt !== 'string' || row.preparedAt.length > 32 || !Number.isFinite(Date.parse(row.preparedAt))
    || new Date(row.preparedAt).toISOString() !== row.preparedAt) return stage3MarkerInvalid('时点不是固定canonical ISO')
  const originalRecoveryFamily = validateStage3OriginalRecoveryFamily(row.originalRecoveryFamily)
  const value = { ...row, originalRecoveryFamily } as unknown as RootRestoreStage3Marker
  if (Buffer.byteLength(capsuleJson(value), 'utf8') > STAGE3_MARKER_MAX_JSON_BYTES) return stage3MarkerInvalid('小marker超预算')
  return freezeCapsuleValue(value)
}
export function stage3MarkerKey(stageId: string): string { return STAGE3_MARKER_PREFIX + durableSqlDagUuid(stageId) }
export function stage3MarkerJson(input: RootRestoreStage3Marker): string {
  return capsuleJson(validateRootRestoreStage3Marker(input))
}
export function stage3MarkerHash(input: RootRestoreStage3Marker): string {
  return capsuleBytesHash('knowbook.restore.stage3.non-executable-marker.v1\0' + stage3MarkerJson(input))
}
export function parseStage3MarkerJson(text: string): RootRestoreStage3Marker {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > STAGE3_MARKER_MAX_JSON_BYTES) return stage3MarkerInvalid('marker原TEXT超预算')
  const value = validateRootRestoreStage3Marker(parseStrictJson(text, { maxBytes: STAGE3_MARKER_MAX_JSON_BYTES, maxDepth: 8 }))
  if (text !== capsuleJson(value)) return stage3MarkerInvalid('marker不是准确canonical原字节')
  return value
}
