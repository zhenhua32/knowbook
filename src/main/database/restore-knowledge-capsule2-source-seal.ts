import { readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { canonicalRestoreRoot, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { durableSqlDagUuid } from './restore-knowledge-dag-model'
import { readOwnedRawCapsuleOriginal, assertOwnedRawCapsuleOriginal, reopenPreparedRawCapsuleOriginal,
  type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { assertCapsule2AssetDirectory as directory, readCapsule2AssetManifest, readCapsule2AssetCopy as readExact,
  writeCapsule2AssetCopy as writeNew } from './restore-knowledge-capsule2-assets-files'
import { reopenCapsule2AssetArchive, readCapsule2ArchiveSourceOriginal, prepareCapsule2AssetArchiveWithProvenance3, prepareCapsule2AssetArchiveWithContextProvenance3, prepareCapsule2AssetArchiveWithSettledContextProvenance4, prepareCapsule2AssetArchiveWithWorkingProvenance5,
  type PreparedCapsule2AssetArchive } from './restore-knowledge-capsule2-asset-archive'
import { captureCapsule2SourceMaterial, captureCapsule2SourceMaterialWithWorking5, readCapsule2SourceMaterial, readCapsule2SourceInputsWithWorking5, tryAssertCapsule2SourceWorking5OriginalBytes5, readCapsule2SourceSealInput,
  assertCapsule2SourceOriginalBytes, readCapsule2SourceBaseProjection4, readCapsule2SourceWorkingOriginals5, type PreparedCapsule2SourceMaterial } from './restore-knowledge-capsule2-source-material'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_READER } from './restore-knowledge-capsule2-raw-model'
import { capsule2SourceManifestHash, parseCapsule2SourceManifest, capsule2SourceSealInvalid as bad,
  type Capsule2SourceManifest } from './restore-knowledge-capsule2-source-seal-model'

export interface SealedCapsule2Source { readonly kind: 'sealed-capsule2-source-original' }
export interface SealedCapsule2SourceInfo { readonly manifest: Capsule2SourceManifest; readonly manifestHash: string; readonly directory: string }
type Packet = Awaited<ReturnType<typeof readCapsule2SourceMaterial>>
type Saved = SealedCapsule2SourceInfo & { material: PreparedCapsule2SourceMaterial; original: OwnedRawCapsuleOriginal; root: string; bytes: Buffer }
const sealed = new WeakMap<SealedCapsule2Source, Saved>(), used = new WeakSet<PreparedCapsule2SourceMaterial>()
function manifestFor(value: Packet): Capsule2SourceManifest {
  const source = value.source
  return freezeCapsuleValue({ kind: 'restore-durable-sql-capsule', version: 2, readerVersion: CAPSULE2_READER,
    material: 'complete-sql-and-managed-originals', state: 'sealed-local-source-inputs', referenceAuthority: 'unresolved-original-references',
    operationId: value.operationId, capsuleId: value.capsuleId, schemaVersion: source.sourceContent.schemaVersion, encoding: source.sourceContent.encoding,
    workspaceScope: source.sourceContent.workspaceScope, recoveryEpoch: source.sourceContent.recoveryEpoch, files: value.sourceInventory,
    schemaHash: source.sourceContent.schemaHash, sourceContentHash: source.policy.sourceContentHash,
    workspaceHistoryObservationHash: source.history.observationHash, assetReferencesObservationHash: source.assets.observationHash,
    sourceKnowledgeHash: value.knowledge.observationHash, sourceMaterialHash: value.materialHash, assetArchiveHash: value.assetArchiveHash,
    sourcePolicyHash: source.policy.observationHash,
    priorRequirementsHash: capsuleBytesHash('knowbook.capsule2.source-seal-prior-requirements.v1\0' + capsuleJson(value.priorCoverageRequirements)),
    requiredRoots: value.priorCoverageRequirements.entries.length, certified: false, semanticValidationComplete: false,
    acceptedCoverage: false, effective: false, permit: false })
}
async function verify(entry: Saved) {
  const closure = async () => {
    await directory(entry.directory, entry.root)
    if (capsuleJson(await readdir(entry.directory)) !== capsuleJson(['manifest.json'])) return bad('来源清单目录闭集变化')
  }
  const manifestPath = join(entry.directory, 'manifest.json')
  await assertOwnedRawCapsuleOriginal(entry.original); await closure()
  await readExact(manifestPath, entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  const value = await readCapsule2SourceMaterial(entry.material)
  if (capsuleJson(manifestFor(value)) !== capsuleJson(entry.manifest)) return bad('完整实际SQL/K/政策/附件/原要求与来源清单不一致')
  await closure(); await readExact(manifestPath, entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  await assertOwnedRawCapsuleOriginal(entry.original)
  return { value, info: freezeCapsuleValue({ directory: entry.directory, manifest: entry.manifest, manifestHash: entry.manifestHash }) }
}
function register(entry: Saved): SealedCapsule2Source {
  const handle: SealedCapsule2Source = Object.freeze({ kind: 'sealed-capsule2-source-original' })
  sealed.set(handle, entry); return handle
}
/** One genuine complete source material only. No caller manifest, path list,
 * expected counts, scope, origin interpretation or certificate is accepted. */
export async function sealCapsule2Source(material: PreparedCapsule2SourceMaterial): Promise<SealedCapsule2Source> {
  const input = await readCapsule2SourceSealInput(material)
  if (used.has(material)) return bad('同一材料已开始或失败，不覆盖重试')
  used.add(material)
  const original = input.original, info = readOwnedRawCapsuleOriginal(original), manifest = manifestFor(input.value)
  const base = join(info.recoveryDirectory, 'knowledge-source-capsules-v2'), output = join(base, manifest.capsuleId)
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true)
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整来源manifest超预算，不截断')
  await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const entry: Saved = { original, material, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: capsule2SourceManifestHash(manifest) }
  await verify(entry); return register(entry)
}
export async function reopenSealedCapsule2Source(input: Parameters<typeof captureReopenedSealedCapsule2Source>[0]): Promise<SealedCapsule2Source> {
  return (await captureReopenedSealedCapsule2Source(input)).source
}
/** Cold reopen only: the real SQL capture is bracketed by the same complete
 * original/manifest checks as verify. No old handle or supplied packet enters. */
export async function captureReopenedSealedCapsule2Source(input: { profileRoot: string; operationId: string; capsuleId: string; expectedManifestHash: string }) {
  const { working: _working, ...captured } = await captureReopenedSealedCapsule2SourceWithWorking5(input)
  return Object.freeze(captured)
}
/** Fixed cold seam for consumers of the same complete original observation. */
export async function captureReopenedSealedCapsule2SourceWithWorking5(input: { profileRoot: string; operationId: string; capsuleId: string; expectedManifestHash: string }) {
  const row = capsuleRecord(input, ['profileRoot','operationId','capsuleId','expectedManifestHash'])
  if (typeof row.profileRoot !== 'string' || !isAbsolute(row.profileRoot) || row.profileRoot.includes('\0')
    || (process.platform === 'win32' ? resolve(row.profileRoot).toLowerCase() !== row.profileRoot.toLowerCase() : resolve(row.profileRoot) !== row.profileRoot)) return bad('profile不是准确绝对路径')
  const root = await canonicalRestoreRoot(row.profileRoot), operationId = durableSqlDagUuid(row.operationId), capsuleId = durableSqlDagUuid(row.capsuleId)
  const output = join(root, 'backups', 'database-restore', operationId, 'knowledge-source-capsules-v2', capsuleId)
  await directory(output, root)
  const text = await readCapsule2AssetManifest(join(output, 'manifest.json'), root)
  const manifest = parseCapsule2SourceManifest(text, operationId, capsuleId, row.expectedManifestHash)
  const original = await reopenPreparedRawCapsuleOriginal({ profileRoot: root, operationId, capsuleId, expectedInventory: manifest.files })
  const archive = await reopenCapsule2AssetArchive(original, manifest.assetArchiveHash), bytes = Buffer.from(text)
  const closure = async () => {
    await directory(output, root)
    if (capsuleJson(await readdir(output)) !== capsuleJson(['manifest.json'])) return bad('来源清单目录闭集变化')
  }
  const path = join(output, 'manifest.json')
  await assertOwnedRawCapsuleOriginal(original); await closure()
  await readExact(path, root, bytes.length, capsuleBytesHash(bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  const { material, value, working } = await captureCapsule2SourceMaterialWithWorking5(archive)
  if (capsuleJson(manifestFor(value)) !== capsuleJson(manifest)) return bad('完整实际SQL/K/政策/附件/原要求与来源清单不一致')
  await closure(); await readExact(path, root, bytes.length, capsuleBytesHash(bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  await assertOwnedRawCapsuleOriginal(original)
  const entry: Saved = { original, material, root, directory: output, manifest, manifestHash: capsule2SourceManifestHash(manifest), bytes }
  return Object.freeze({ source: register(entry), value, working, profileRoot: root,
    info: freezeCapsuleValue({ directory: output, manifest, manifestHash: entry.manifestHash }) })
}
export async function readSealedCapsule2Source(handle: SealedCapsule2Source): Promise<SealedCapsule2SourceInfo> {
  const entry = sealed.get(handle)
  if (!entry) return bad('不是Main实际封存的私有来源句柄')
  return (await verify(entry)).info
}
/** Full Main-private source, never renderer diagnostics or accepted K. */
export async function readSealedCapsule2SourceMaterial(handle: SealedCapsule2Source): Promise<Packet> {
  const entry = sealed.get(handle)
  if (!entry) return bad('不是Main实际封存的私有来源句柄')
  return (await verify(entry)).value
}
/** Main-only certification seam: both values come from the same complete
 * original verification, never from independently supplied DTOs or counts. */
export async function readSealedCapsule2SourceInputs(handle: SealedCapsule2Source) {
  const entry = sealed.get(handle)
  if (!entry) return bad('不是Main实际封存的私有来源句柄')
  return { ...await verify(entry), profileRoot: entry.root }
}
export async function diagnoseSealedCapsule2Source(handle: SealedCapsule2Source) {
  const info = await readSealedCapsule2Source(handle)
  return freezeCapsuleValue({ kind: 'sealed-capsule2-source-summary' as const, manifestHash: info.manifestHash,
    schemaVersion: info.manifest.schemaVersion, requiredRoots: info.manifest.requiredRoots,
    certified: false as const, semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const })
}

/** Complete immutable bytes only. It cannot return an old SQL packet or mint
 * a certificate. All ordinary source reads above retain their full SQL verify. */
export async function assertSealedCapsule2SourceOriginalBytes(handle: SealedCapsule2Source): Promise<void> {
  const entry = sealed.get(handle)
  if (!entry) return bad('不是Main实际封存的私有来源句柄')
  await assertOwnedRawCapsuleOriginal(entry.original)
  await directory(entry.directory, entry.root)
  if (capsuleJson(await readdir(entry.directory)) !== capsuleJson(['manifest.json'])) return bad('来源清单目录闭集变化')
  await readExact(join(entry.directory, 'manifest.json'), entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  await assertCapsule2SourceOriginalBytes(entry.material)
  await directory(entry.directory, entry.root)
  if (capsuleJson(await readdir(entry.directory)) !== capsuleJson(['manifest.json'])) return bad('来源清单目录闭集变化')
  await readExact(join(entry.directory, 'manifest.json'), entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  await assertOwnedRawCapsuleOriginal(entry.original)
}

/** One new complete capture from a genuine archive, immediately sealed to its
 * exact immutable bytes. No existing source/DTO can select an old snapshot.
 * Ordinary later reads retain verify's complete actual SQL reconstruction. */
export async function captureSealedCapsule2SourceFromArchive(archive: PreparedCapsule2AssetArchive) {
  const { material, value } = await captureCapsule2SourceMaterial(archive)
  const original = await readCapsule2ArchiveSourceOriginal(archive), info = readOwnedRawCapsuleOriginal(original)
  if (used.has(material)) return bad('同一材料已开始或失败')
  used.add(material)
  const manifest = manifestFor(value), base = join(info.recoveryDirectory, 'knowledge-source-capsules-v2'), output = join(base, manifest.capsuleId)
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true)
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整来源manifest超预算，不截断')
  await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const entry: Saved = { original, material, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: capsule2SourceManifestHash(manifest) }
  const source = register(entry)
  await assertSealedCapsule2SourceOriginalBytes(source)
  return Object.freeze({ source, value, profileRoot: info.profileRoot,
    info: freezeCapsuleValue({ directory: output, manifest, manifestHash: entry.manifestHash }) })
}

/** Explicit base-observer URI ownership producer. The unchanged source seal
 * hashes the actual nested archive v2, including strict partial coverage.
 * Future supplemental/context capture requires a distinct archive version. */
export async function captureSealedCapsule2SourceWithAssetProvenance3(original: OwnedRawCapsuleOriginal) {
  return captureSealedCapsule2SourceFromArchive(await prepareCapsule2AssetArchiveWithProvenance3(original))
}

/** Explicit v3 context/supplement producer. Base-only archive2 remains an
 * independent released contract, including every partial coverage flag. */
export async function captureSealedCapsule2SourceWithContextProvenance3(original: OwnedRawCapsuleOriginal) {
  return captureSealedCapsule2SourceFromArchive(await prepareCapsule2AssetArchiveWithContextProvenance3(original))
}

/** Explicit archive4 producer; published context3 capture keeps its original
 * selectors, observer and proof meanings. No caller skip/projection DTO. */
export async function captureSealedCapsule2SourceWithSettledContextProvenance4(original: OwnedRawCapsuleOriginal) {
  return captureSealedCapsule2SourceFromArchive(await prepareCapsule2AssetArchiveWithSettledContextProvenance4(original))
}

/** Full private base read follows only this genuine source's registry chain.
 * Serialized source/archive/pointer DTOs never grant this capability. */
export async function readSealedCapsule2SourceBaseProjection4(handle: SealedCapsule2Source) {
  const entry = sealed.get(handle)
  if (!entry) return bad('不是实际Main sealed source owner')
  await assertSealedCapsule2SourceOriginalBytes(handle)
  const base = await readCapsule2SourceBaseProjection4(entry.material)
  await assertSealedCapsule2SourceOriginalBytes(handle)
  return base
}

/** Explicit all-merge Working5 source. Released custom-only v3/v4 factories
 * keep their selectors, observer/hash domains and persisted bytes. */
export async function captureSealedCapsule2SourceWithWorkingProvenance5(original:OwnedRawCapsuleOriginal){
 return captureSealedCapsule2SourceFromArchive(await prepareCapsule2AssetArchiveWithWorkingProvenance5(original))
}
/** Native transport sees the real registered Working5 text/members only.
 * Non5 returns undefined after the same original/manifest byte bracket. */
export async function readSealedCapsule2SourceWorkingOriginals5(handle:SealedCapsule2Source){
 const entry=sealed.get(handle);if(!entry)return bad('不是genuine sealed source owner')
 await assertSealedCapsule2SourceOriginalBytes(handle)
 const working=await readCapsule2SourceWorkingOriginals5(entry.material)
 await assertSealedCapsule2SourceOriginalBytes(handle)
 return working
}

async function verifyWithWorking5(entry: Saved) {
  const closure = async () => {
    await directory(entry.directory, entry.root)
    if (capsuleJson(await readdir(entry.directory)) !== capsuleJson(['manifest.json'])) return bad('来源清单目录闭集变化')
  }
  const manifestPath = join(entry.directory, 'manifest.json')
  await assertOwnedRawCapsuleOriginal(entry.original); await closure()
  await readExact(manifestPath, entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  const captured = await readCapsule2SourceInputsWithWorking5(entry.material), value = captured.value
  if (capsuleJson(manifestFor(value)) !== capsuleJson(entry.manifest)) return bad('完整实际SQL/K/政策/附件/原要求与来源清单不一致')
  await closure(); await readExact(manifestPath, entry.root, entry.bytes.length, capsuleBytesHash(entry.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  await assertOwnedRawCapsuleOriginal(entry.original)
  return { working: captured.working, value, info: freezeCapsuleValue({ directory: entry.directory, manifest: entry.manifest, manifestHash: entry.manifestHash }) }
}
/** Main-only same-invocation source/K/Working originals. Registry dispatch,
 * both source-manifest reads and both original-byte tails precede the return. */
export async function readSealedCapsule2SourceInputsWithWorking5(handle: SealedCapsule2Source) {
  const entry = sealed.get(handle)
  if (!entry) return bad('不是Main实际封存的私有来源句柄')
  return { ...await verifyWithWorking5(entry), profileRoot: entry.root }
}

/** The private archive5 identity and all sealed source/SQL/base/Working bytes
 * are checked now. False retains the released older-family full-read route. */
export async function tryAssertSealedCapsule2Working5OriginalBytes5(handle: SealedCapsule2Source): Promise<boolean> {
  const saved = sealed.get(handle)
  if (!saved) return bad('不是genuine sealed source owner')
  if (!await tryAssertCapsule2SourceWorking5OriginalBytes5(saved.material)) return false
  await assertSealedCapsule2SourceOriginalBytes(handle)
  return true
}

export async function captureSealedCapsule2SourceFromArchiveWithWorking5(archive: PreparedCapsule2AssetArchive) {
  const { material, value, working } = await captureCapsule2SourceMaterialWithWorking5(archive)
  if (value.assetArchive.version !== 5 || !working) return bad('显式Working5 capture需要genuine archive5完整原件')
  const original = await readCapsule2ArchiveSourceOriginal(archive), info = readOwnedRawCapsuleOriginal(original)
  if (used.has(material)) return bad('同一材料已开始或失败')
  used.add(material)
  const manifest = manifestFor(value), base = join(info.recoveryDirectory, 'knowledge-source-capsules-v2'), output = join(base, manifest.capsuleId)
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true)
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整来源manifest超预算，不截断')
  await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const entry: Saved = { original, material, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: capsule2SourceManifestHash(manifest) }
  const source = register(entry)
  await assertSealedCapsule2SourceOriginalBytes(source)
  return Object.freeze({ source, value, working, profileRoot: info.profileRoot,
    info: freezeCapsuleValue({ directory: output, manifest, manifestHash: entry.manifestHash }) })
}
export async function captureSealedCapsule2SourceWithWorkingOriginals5(original: OwnedRawCapsuleOriginal) {
  return captureSealedCapsule2SourceFromArchiveWithWorking5(await prepareCapsule2AssetArchiveWithWorkingProvenance5(original))
}
