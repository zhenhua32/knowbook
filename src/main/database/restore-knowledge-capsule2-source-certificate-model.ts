import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagUuid } from './restore-knowledge-dag-model'
import { CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'

export const CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES = 8192
/** Certification of the complete source with zero original prior-C references.
 * It assigns no original native/imported domain and grants no restore install. */
export interface Capsule2NoPriorSourceCertificate {
  readonly kind: 'restore-capsule2-no-prior-source-certificate'; readonly version: 1
  readonly readerVersion: typeof CAPSULE2_READER; readonly scope: 'complete-original-source-without-prior-coverage'
  readonly operationId: string; readonly capsuleId: string; readonly schemaVersion: 26 | 27
  readonly sourceManifestHash: string; readonly sourceMaterialHash: string; readonly sourceKnowledgeHash: string
  readonly requiredRoots: 0; readonly originalReferenceDomain: 'unassigned'
  readonly certified: true; readonly semanticValidationComplete: true
  readonly acceptedCoverage: false; readonly effective: false; readonly permit: false; readonly policyReplayAllowed: false
}
const keys = ['kind','version','readerVersion','scope','operationId','capsuleId','schemaVersion','sourceManifestHash','sourceMaterialHash',
  'sourceKnowledgeHash','requiredRoots','originalReferenceDomain','certified','semanticValidationComplete','acceptedCoverage','effective','permit','policyReplayAllowed']
export const sourceCertificateInvalid = (message: string): never => { throw new Error('capsule2无prior-C来源认证无效：' + message + '；不授accepted/effective、来源域解释或安装权。') }
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : sourceCertificateInvalid('hash无效')
export const capsule2NoPriorSourceCertificateHash = (value: Capsule2NoPriorSourceCertificate): string =>
  capsuleBytesHash('knowbook.capsule2.no-prior-source-certificate.v1\0' + capsuleJson(value))
export function parseCapsule2NoPriorSourceCertificate(text: string, operationId: string, capsuleId: string, expectedHash: unknown): Capsule2NoPriorSourceCertificate {
  const value = parseStrictJson(text, { maxBytes: CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES, maxDepth: 8 }), row = capsuleRecord(value, keys)
  if (text !== capsuleJson(value) + '\n' || capsuleBytesHash('knowbook.capsule2.no-prior-source-certificate.v1\0' + capsuleJson(value)) !== digest(expectedHash))
    return sourceCertificateInvalid('规范原字节或预期hash不符')
  if (row.kind !== 'restore-capsule2-no-prior-source-certificate' || row.version !== 1 || row.readerVersion !== CAPSULE2_READER
    || row.scope !== 'complete-original-source-without-prior-coverage' || row.operationId !== operationId || row.capsuleId !== capsuleId
    || row.schemaVersion !== 26 && row.schemaVersion !== 27 || row.requiredRoots !== 0 || row.originalReferenceDomain !== 'unassigned'
    || row.certified !== true || row.semanticValidationComplete !== true || row.acceptedCoverage !== false || row.effective !== false
    || row.permit !== false || row.policyReplayAllowed !== false) return sourceCertificateInvalid('格式/身份/认证范围或权限标志不符')
  return freezeCapsuleValue({ kind: row.kind, version: 1, readerVersion: CAPSULE2_READER, scope: row.scope,
    operationId: durableSqlDagUuid(row.operationId), capsuleId: durableSqlDagUuid(row.capsuleId), schemaVersion: row.schemaVersion,
    sourceManifestHash: digest(row.sourceManifestHash), sourceMaterialHash: digest(row.sourceMaterialHash), sourceKnowledgeHash: digest(row.sourceKnowledgeHash),
    requiredRoots: 0, originalReferenceDomain: 'unassigned', certified: true, semanticValidationComplete: true,
    acceptedCoverage: false, effective: false, permit: false, policyReplayAllowed: false })
}
