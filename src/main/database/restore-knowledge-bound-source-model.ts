import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'
import { COVERAGE_MAX_REQUIREMENT_ROWS } from './restore-knowledge-coverage-model'
import { durableSqlDagHash, durableSqlDagUuid, DURABLE_SQL_DAG_MAX_PARENTS } from './restore-knowledge-dag-model'

/** A durable input binding, deliberately separate from both the no-prior
 * semantic source certificate and an accepted Root3. It records the exact
 * complete source plus its explicitly sealed original-reference context.
 * A pure parse/hash cannot mint the Main IO owner's private input handle. */
export interface Capsule2BoundSourceManifest {
  readonly kind: 'capsule2-bound-reference-inputs'; readonly version: 1
  readonly readerVersion: typeof CAPSULE2_READER
  readonly scope: 'complete-source-and-referenced-original-inputs'
  readonly operationId: string; readonly capsuleId: string
  readonly sourceManifestHash: string; readonly sourceMaterialHash: string; readonly sourceKnowledgeHash: string
  readonly rawRequirementsHash: string
  readonly contextId: string; readonly contextHash: string
  readonly requiredCoverageEntries: number; readonly referencedRoots: number; readonly resolvedRootsHash: string
  readonly originalReferenceDomain: 'explicit-complete-original-context'
  readonly originalInputsComplete: true
  readonly certified: false; readonly semanticValidationComplete: false
  readonly acceptedCoverage: false; readonly effective: false; readonly permit: false; readonly policyReplayAllowed: false
}
export const BOUND_SOURCE_MANIFEST_MAX_BYTES = 8192
export function boundSourceInvalid(message: string): never {
  throw new Error('完整来源原件绑定无效：' + message + '；引用原件输入不等于accepted Root3或安装许可。')
}
function count(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
    ? value : boundSourceInvalid('完整prior-C计数无效或超预算')
}
export function validateCapsule2BoundSourceManifest(value: unknown): Capsule2BoundSourceManifest {
  const row = capsuleRecord(value, ['kind','version','readerVersion','scope','operationId','capsuleId','sourceManifestHash',
    'sourceMaterialHash','sourceKnowledgeHash','rawRequirementsHash','contextId','contextHash','requiredCoverageEntries',
    'referencedRoots','resolvedRootsHash','originalReferenceDomain','originalInputsComplete','certified','semanticValidationComplete',
    'acceptedCoverage','effective','permit','policyReplayAllowed'])
  if (row.kind !== 'capsule2-bound-reference-inputs' || row.version !== 1 || row.readerVersion !== CAPSULE2_READER
    || row.scope !== 'complete-source-and-referenced-original-inputs' || row.originalReferenceDomain !== 'explicit-complete-original-context'
    || row.originalInputsComplete !== true || row.certified !== false || row.semanticValidationComplete !== false
    || row.acceptedCoverage !== false || row.effective !== false || row.permit !== false || row.policyReplayAllowed !== false)
    return boundSourceInvalid('未知来源绑定格式或越权标记')
  const result: Capsule2BoundSourceManifest = { kind: row.kind, version: 1, readerVersion: CAPSULE2_READER, scope: row.scope,
    operationId: durableSqlDagUuid(row.operationId), capsuleId: durableSqlDagUuid(row.capsuleId),
    sourceManifestHash: durableSqlDagHash(row.sourceManifestHash), sourceMaterialHash: durableSqlDagHash(row.sourceMaterialHash),
    sourceKnowledgeHash: durableSqlDagHash(row.sourceKnowledgeHash), rawRequirementsHash: durableSqlDagHash(row.rawRequirementsHash),
    contextId: durableSqlDagUuid(row.contextId), contextHash: durableSqlDagHash(row.contextHash),
    requiredCoverageEntries: count(row.requiredCoverageEntries, COVERAGE_MAX_REQUIREMENT_ROWS),
    referencedRoots: count(row.referencedRoots, DURABLE_SQL_DAG_MAX_PARENTS), resolvedRootsHash: durableSqlDagHash(row.resolvedRootsHash),
    originalReferenceDomain: 'explicit-complete-original-context', originalInputsComplete: true,
    certified: false, semanticValidationComplete: false, acceptedCoverage: false, effective: false, permit: false, policyReplayAllowed: false }
  if (result.referencedRoots > result.requiredCoverageEntries || Buffer.byteLength(capsuleJson(result)) + 1 > BOUND_SOURCE_MANIFEST_MAX_BYTES)
    return boundSourceInvalid('要求与父根计数不闭合或完整绑定超预算')
  return freezeCapsuleValue(result)
}
export const capsule2BoundSourceHash = (value: Capsule2BoundSourceManifest): string =>
  capsuleBytesHash('knowbook.capsule2.bound-reference-inputs.v1\0' + capsuleJson(validateCapsule2BoundSourceManifest(value)))
export function parseCapsule2BoundSourceManifest(text: string, operationId: string, capsuleId: string, expectedHash: string): Capsule2BoundSourceManifest {
  const value = validateCapsule2BoundSourceManifest(parseStrictJson(text, { maxBytes: BOUND_SOURCE_MANIFEST_MAX_BYTES, maxDepth: 8 }))
  if (text !== capsuleJson(value) + '\n' || value.operationId !== durableSqlDagUuid(operationId)
    || value.capsuleId !== durableSqlDagUuid(capsuleId) || capsule2BoundSourceHash(value) !== durableSqlDagHash(expectedHash))
    return boundSourceInvalid('原绑定字节、locator或预期hash不相等')
  return value
}
