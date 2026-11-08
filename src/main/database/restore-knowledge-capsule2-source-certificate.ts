import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalRequiredSqlDagRoot } from './restore-knowledge-required-dag-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagUuid } from './restore-knowledge-dag-model'
import { assertCapsule2AssetDirectory, readCapsule2AssetManifest, readCapsule2AssetCopy, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { readSealedCapsule2SourceInputs, readSealedCapsule2SourceInputsWithWorking5, tryAssertSealedCapsule2Working5OriginalBytes5, readSealedCapsule2SourceWorkingOriginals5, assertSealedCapsule2SourceOriginalBytes, captureReopenedSealedCapsule2SourceWithWorking5, type SealedCapsule2Source } from './restore-knowledge-capsule2-source-seal'
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
export async function reopenCertifiedCapsule2Source(input: Parameters<typeof captureReopenedCertifiedCapsule2Source>[0]): Promise<CertifiedCapsule2NoPriorSource> {
  return (await captureReopenedCertifiedCapsule2Source(input)).source
}
/** A fresh fixed-path source factory supplies the complete captured SQL packet.
 * Certificate bytes and closure bracket that actual factory; callers cannot
 * provide a source handle, cached packet, selector or verification callback. */
export async function captureReopenedCertifiedCapsule2Source(input: { profileRoot: string; operationId: string; capsuleId: string; expectedCertificateHash: string }) {
  const { working: _working, ...captured } = await captureReopenedCertifiedCapsule2SourceWithWorking5(input)
  return Object.freeze(captured)
}
/** The actual cold certification and its Working5 result are one observation. */
export async function captureReopenedCertifiedCapsule2SourceWithWorking5(input: { profileRoot: string; operationId: string; capsuleId: string; expectedCertificateHash: string }) {
  const row = capsuleRecord(input, ['profileRoot','operationId','capsuleId','expectedCertificateHash']), root = await canonicalRequiredSqlDagRoot(row.profileRoot)
  const operationId = durableSqlDagUuid(row.operationId), capsuleId = durableSqlDagUuid(row.capsuleId)
  const directory = join(root, 'backups', 'database-restore', operationId, 'knowledge-source-certificates-v2', capsuleId)
  const closure = async () => {
    await assertCapsule2AssetDirectory(directory, root)
    if (capsuleJson(await readdir(directory)) !== capsuleJson(['certificate.json'])) return bad('来源证书目录闭集变化')
  }
  await closure()
  const text = await readCapsule2AssetManifest(join(directory, 'certificate.json'), root, CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
  const certificate = parseCapsule2NoPriorSourceCertificate(text, operationId, capsuleId, row.expectedCertificateHash)
  const bytes = Buffer.from(text), path = join(directory, 'certificate.json')
  await readCapsule2AssetCopy(path, root, bytes.length, capsuleBytesHash(bytes), CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
  const captured = await captureReopenedSealedCapsule2SourceWithWorking5({ profileRoot: root, operationId, capsuleId, expectedManifestHash: certificate.sourceManifestHash })
  if (capsuleJson(certificateFor(captured)) !== capsuleJson(certificate)) return bad('证书与完整实际来源不符')
  await closure(); await readCapsule2AssetCopy(path, root, bytes.length, capsuleBytesHash(bytes), CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
  const entry: Saved = { source: captured.source, root, directory, certificate, certificateHash: capsule2NoPriorSourceCertificateHash(certificate), bytes }
  return Object.freeze({ source: mint(entry), value: captured.value, working: captured.working, profileRoot: root,
    info: freezeCapsuleValue({ certificate, certificateHash: entry.certificateHash, directory }) })
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

/** Main-only source5 runtime seam. A genuine certificate supplies its private
 * sealed source; no manifest, path, version tag or working-text DTO is accepted.
 * Certificate bytes and closure bracket the source's own complete byte checks.
 * Older archive versions return null after the sealed reader's absent result. */
export async function readCertifiedCapsule2SourceWorkingOriginals5(handle: CertifiedCapsule2NoPriorSource) {
  const entry = certified.get(handle)
  if (!entry) return bad('不是Main认证的私有来源句柄')
  // Both mint paths already join certificateFor(full genuine source) to this
  // exact private source identity. This leaf returns no source/K authority.
  // Recheck every pinned byte around its fresh Working read instead of running
  // the complete source/K observer twice more; ordinary readers keep verify().
  const certificateDirectory = async () => {
    await assertCapsule2AssetDirectory(entry.directory, entry.root)
    if (capsuleJson(await readdir(entry.directory)) !== capsuleJson(['certificate.json'])) return bad('来源证书目录闭集变化')
  }
  const certificateBytes = async () => {
    await certificateDirectory()
    const bytes = await readCapsule2AssetCopy(join(entry.directory, 'certificate.json'), entry.root,
      entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
    if (!bytes.equals(entry.bytes)) return bad('来源证书原字节变化')
    const certificate = parseCapsule2NoPriorSourceCertificate(bytes.toString('utf8'), entry.certificate.operationId,
      entry.certificate.capsuleId, entry.certificateHash)
    if (capsuleJson(certificate) !== capsuleJson(entry.certificate)) return bad('来源证书原metadata不符')
    await certificateDirectory()
  }
  await certificateBytes()
  await assertSealedCapsule2SourceOriginalBytes(entry.source)
  const working = await readSealedCapsule2SourceWorkingOriginals5(entry.source)
  await assertSealedCapsule2SourceOriginalBytes(entry.source)
  await certificateBytes()
  return working ?? null
}

async function verifyWithWorking5(entry: Saved) {
  const closure = async () => {
    await assertCapsule2AssetDirectory(entry.directory, entry.root)
    if (capsuleJson(await readdir(entry.directory)) !== capsuleJson(['certificate.json'])) return bad('来源证书目录闭集变化')
  }
  const path = join(entry.directory, 'certificate.json')
  await closure(); await readCapsule2AssetCopy(path, entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
  const input = await readSealedCapsule2SourceInputsWithWorking5(entry.source)
  if (capsuleJson(certificateFor(input)) !== capsuleJson(entry.certificate)) return bad('证书与完整实际来源不符')
  await closure(); await readCapsule2AssetCopy(path, entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
  return { info: freezeCapsuleValue({ certificate: entry.certificate, certificateHash: entry.certificateHash, directory: entry.directory }), value: input.value, working: input.working }
}
/** Registry-only joint dispatch. A full certificate/source verification
 * supplies Working originals from that same actual SQL/archive read. */
export async function tryReadCertifiedCapsule2SourceInputsWithWorking5(handle: unknown) {
  const entry = certified.get(handle as CertifiedCapsule2NoPriorSource)
  return entry ? { ...await verifyWithWorking5(entry), profileRoot: entry.root } : undefined
}

/** Complete certificate/source byte tail only; this does not observe SQL/K,
 * return Working data, or mint a semantic source/certificate capability. */
export async function assertCertifiedCapsule2SourceOriginalBytes5(handle: CertifiedCapsule2NoPriorSource) {
  const entry = certified.get(handle)
  if (!entry) return bad('不是Main认证的私有来源句柄')
  // Both mint paths already join certificateFor(full genuine source) to this
  // exact private source identity. This leaf returns no source/K authority.
  // Recheck every pinned byte around its fresh Working read instead of running
  // the complete source/K observer twice more; ordinary readers keep verify().
  const certificateDirectory = async () => {
    await assertCapsule2AssetDirectory(entry.directory, entry.root)
    if (capsuleJson(await readdir(entry.directory)) !== capsuleJson(['certificate.json'])) return bad('来源证书目录闭集变化')
  }
  const certificateBytes = async () => {
    await certificateDirectory()
    const bytes = await readCapsule2AssetCopy(join(entry.directory, 'certificate.json'), entry.root,
      entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_SOURCE_CERTIFICATE_MAX_BYTES)
    if (!bytes.equals(entry.bytes)) return bad('来源证书原字节变化')
    const certificate = parseCapsule2NoPriorSourceCertificate(bytes.toString('utf8'), entry.certificate.operationId,
      entry.certificate.capsuleId, entry.certificateHash)
    if (capsuleJson(certificate) !== capsuleJson(entry.certificate)) return bad('来源证书原metadata不符')
    await certificateDirectory()
  }
  await certificateBytes()
  await assertSealedCapsule2SourceOriginalBytes(entry.source)
  await assertSealedCapsule2SourceOriginalBytes(entry.source)
  await assertSealedCapsule2SourceOriginalBytes(entry.source)
  await certificateBytes()
}

/** Fixed Main same-call transport tail. Only a genuine certified archive5
 * source can take this complete byte-closure route. It never mints an owner
 * or accepts a caller version flag, earlier packet, map or skip callback. */
export async function tryAssertCertifiedCapsule2Working5OriginalBytes5(handle: unknown): Promise<boolean> {
  const saved = certified.get(handle as CertifiedCapsule2NoPriorSource)
  if (!saved) return false
  if (!await tryAssertSealedCapsule2Working5OriginalBytes5(saved.source)) return false
  await assertCertifiedCapsule2SourceOriginalBytes5(handle as CertifiedCapsule2NoPriorSource)
  return true
}
