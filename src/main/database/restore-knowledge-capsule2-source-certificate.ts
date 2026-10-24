import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalRequiredSqlDagRoot } from './restore-knowledge-required-dag-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagUuid } from './restore-knowledge-dag-model'
import { assertCapsule2AssetDirectory, readCapsule2AssetManifest, readCapsule2AssetCopy, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { readSealedCapsule2SourceInputs, reopenSealedCapsule2Source, type SealedCapsule2Source } from './restore-knowledge-capsule2-source-seal'
import { CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'
import { CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES, capsule2NoPriorSourceCertificateHash, parseCapsule2NoPriorSourceCertificate,
  sourceCertificateInvalid as bad, type Capsule2NoPriorSourceCertificate } from './restore-knowledge-capsule2-source-certificate-model'

export interface CertifiedCapsule2NoPriorSource { readonly kind: 'certified-capsule2-no-prior-source' }
type Inputs = Awaited<ReturnType<typeof readSealedCapsule2SourceInputs>>
type Info = { certificate: Capsule2NoPriorSourceCertificate; certificateHash: string; directory: string }
type Saved = Info & { source: SealedCapsule2Source; root: string; bytes: Buffer }
const certified = new WeakMap<CertifiedCapsule2NoPriorSource, Saved>(), started = new WeakSet<SealedCapsule2Source>()
export type Capsule2SourceCertification =
  | { readonly status: 'certified-without-prior-coverage'; readonly source: CertifiedCapsule2NoPriorSource }
  | { readonly status: 'requires-qualified-prior-coverage'; readonly requiredRoots: number }
function certificateFor(input: Inputs): Capsule2NoPriorSourceCertificate {
  const { value, info } = input
  if (value.priorCoverageRequirements.entries.length || value.knowledge.coverageAnchors.length || value.knowledge.coverageMaterial.length
    || info.manifest.requiredRoots !== 0) return bad('实际完整prior-C未解决，不能降为无引用来源')
  return freezeCapsuleValue({ kind: 'restore-capsule2-no-prior-source-certificate', version: 1, readerVersion: CAPSULE2_READER,
    scope: 'complete-original-source-without-prior-coverage', operationId: value.operationId, capsuleId: value.capsuleId,
    schemaVersion: info.manifest.schemaVersion, sourceManifestHash: info.manifestHash, sourceMaterialHash: value.materialHash,
    sourceKnowledgeHash: value.knowledge.observationHash, requiredRoots: 0, originalReferenceDomain: 'unassigned',
    certified: true, semanticValidationComplete: true, acceptedCoverage: false, effective: false, permit: false, policyReplayAllowed: false })
}
async function verify(entry: Saved) {
  const closure = async () => {
    await assertCapsule2AssetDirectory(entry.directory, entry.root)
    if (capsuleJson(await readdir(entry.directory)) !== capsuleJson(['certificate.json'])) return bad('来源证书目录闭集变化')
  }
  const path = join(entry.directory, 'certificate.json')
  await closure(); await readCapsule2AssetCopy(path, entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
  const input = await readSealedCapsule2SourceInputs(entry.source)
  if (capsuleJson(certificateFor(input)) !== capsuleJson(entry.certificate)) return bad('证书与完整实际来源不符')
  await closure(); await readCapsule2AssetCopy(path, entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
  return { info: freezeCapsuleValue({ certificate: entry.certificate, certificateHash: entry.certificateHash, directory: entry.directory }), value: input.value }
}
function mint(entry: Saved): CertifiedCapsule2NoPriorSource {
  const handle: CertifiedCapsule2NoPriorSource = Object.freeze({ kind: 'certified-capsule2-no-prior-source' })
  certified.set(handle, entry); return handle
}
/** Genuine complete sealed source only. Prior-C remains an explicit unresolved
 * result, never an empty proof, v1 fallback, caller origin or Root3 attestation. */
export async function certifyCapsule2Source(source: SealedCapsule2Source): Promise<Capsule2SourceCertification> {
  const input = await readSealedCapsule2SourceInputs(source), requiredRoots = input.value.priorCoverageRequirements.entries.length
  if (requiredRoots) return Object.freeze({ status: 'requires-qualified-prior-coverage', requiredRoots })
  if (started.has(source)) return bad('同一来源已开始，失败不覆盖重试')
  started.add(source)
  const certificate = certificateFor(input), operation = dirname(dirname(input.info.directory)), root = input.profileRoot
  const base = join(operation, 'knowledge-source-certificates-v2'), directory = join(base, certificate.capsuleId)
  await restoreDirectory(base, root); await restoreDirectory(directory, root, true)
  const bytes = Buffer.from(capsuleJson(certificate) + '\n')
  if (bytes.length > CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES) return bad('完整证书超预算，不截断')
  await writeCapsule2AssetCopy(join(directory, 'certificate.json'), bytes, root)
  await syncRestoreDirectory(directory); await syncRestoreDirectory(base); await syncRestoreDirectory(operation)
  const entry: Saved = { source, root, directory, bytes, certificate, certificateHash: capsule2NoPriorSourceCertificateHash(certificate) }
  await verify(entry); return Object.freeze({ status: 'certified-without-prior-coverage', source: mint(entry) })
}
export async function reopenCertifiedCapsule2Source(input: { profileRoot: string; operationId: string; capsuleId: string; expectedCertificateHash: string }): Promise<CertifiedCapsule2NoPriorSource> {
  const row = capsuleRecord(input, ['profileRoot','operationId','capsuleId','expectedCertificateHash']), root = await canonicalRequiredSqlDagRoot(row.profileRoot)
  const operationId = durableSqlDagUuid(row.operationId), capsuleId = durableSqlDagUuid(row.capsuleId)
  const directory = join(root, 'backups', 'database-restore', operationId, 'knowledge-source-certificates-v2', capsuleId)
  const text = await readCapsule2AssetManifest(join(directory, 'certificate.json'), root, CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
  const certificate = parseCapsule2NoPriorSourceCertificate(text, operationId, capsuleId, row.expectedCertificateHash)
  const source = await reopenSealedCapsule2Source({ profileRoot: root, operationId, capsuleId, expectedManifestHash: certificate.sourceManifestHash })
  const entry: Saved = { source, root, directory, certificate, certificateHash: capsule2NoPriorSourceCertificateHash(certificate), bytes: Buffer.from(text) }
  await verify(entry); return mint(entry)
}
export async function readCertifiedCapsule2Source(handle: CertifiedCapsule2NoPriorSource): Promise<Info> {
  const entry = certified.get(handle)
  if (!entry) return bad('不是Main认证的私有来源句柄')
  return (await verify(entry)).info
}
export async function readCertifiedCapsule2SourceMaterial(handle: CertifiedCapsule2NoPriorSource) {
  const entry = certified.get(handle)
  if (!entry) return bad('不是Main认证的私有来源句柄')
  return (await verify(entry)).value
}
/** Fixed Main reader dispatch uses this registry, never caller kind/getters.
 * A matched reader must fully reauthenticate its original before returning. */
export async function tryReadCertifiedCapsule2SourceInputs(handle: unknown) {
  const entry = certified.get(handle as CertifiedCapsule2NoPriorSource)
  return entry ? { ...await verify(entry), profileRoot: entry.root } : undefined
}
