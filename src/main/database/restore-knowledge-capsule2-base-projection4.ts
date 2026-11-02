// Main-private capture before archive/context selection. DTOs do not grant IO,
// spool skipping, semantic selection, accepted coverage or installation.
import Database from 'better-sqlite3'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseStrictJson } from '../../shared/strictJson'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { assertOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchReady, assertOwnedRawCapsuleScratchContent,
  readOwnedRawCapsuleOriginal, reopenPreparedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { capsuleBytesHash, capsuleJson, capsuleRecord, capsuleText, freezeCapsuleValue,
  validateDurableSqlCapsuleInventory, type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { readRawCapsule2AssetReferenceSourceOwned } from './restore-knowledge-capsule2-assets-read'
import { captureCapsule2ManagedTreeData, type Capsule2ManagedTreeData } from './restore-knowledge-capsule2-managed-assets-files'
import { validateCapsule2ManagedTree } from './restore-knowledge-capsule2-assets-model'
import { captureCapsule2AssetReferenceProvenanceOwned3, validateCapsule2AssetReferenceProvenance1,
  type Capsule2AssetReferenceProvenance1 } from './restore-knowledge-capsule2-asset-provenance'
import { assertCapsule2AssetDirectory as directory, readCapsule2AssetManifest,
  writeCapsule2AssetCopy as writeNew, readCapsule2AssetCopy as readExact } from './restore-knowledge-capsule2-assets-files'
import { deriveCapsule2SettledPortableEvidence3 } from './restore-knowledge-assets3-settled-portable-derive'

export interface Capsule2BaseProjectionManifest4 {
  readonly kind: 'capsule2-captured-base-projection'; readonly version: 1
  readonly capsuleId: string; readonly schemaVersion: 26 | 27; readonly sourceInventory: readonly DurableSqlCapsuleFile[]
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string; readonly assetReferencesObservationHash: string
  readonly referenceCount: number; readonly referenceUris: readonly string[]; readonly tree: Capsule2ManagedTreeData
  readonly referenceProvenance: Capsule2AssetReferenceProvenance1; readonly baseMaterialHash: string
  readonly rawOriginalRewritten: false; readonly semanticSelectionPermission: false; readonly installPermit: false
}
export interface Capsule2BaseProjectionCommitment4 extends Capsule2BaseProjectionManifest4 {
  readonly baseManifestHash: string
  readonly baseManifestFile: { readonly bytes: number; readonly sha256: string }
}
/** Compact archive pointer only. Complete facts live once in the separately
 * authenticated base original; a pointer DTO cannot mint or read that file. */
export interface Capsule2BaseProjectionPointer4 {
  readonly version: 1; readonly baseManifestHash: string; readonly baseMaterialHash: string
  readonly baseManifestFile: { readonly bytes: number; readonly sha256: string }
}
export interface PreparedCapsule2BaseProjection4 { readonly kind: 'main-capsule2-base-projection4' }
type Source = ReturnType<typeof readRawCapsule2AssetReferenceSourceOwned>
type Saved = { original: OwnedRawCapsuleOriginal; root: string; directory: string; commitment: Capsule2BaseProjectionCommitment4; bytes: Buffer }
const owners = new WeakMap<PreparedCapsule2BaseProjection4, Saved>(), used = new WeakSet<OwnedRawCapsuleOriginal>()
const bad = (reason: string): never => { throw new Error('capsule2 base projection4无效：' + reason + '；不授spool跳过、资产读写或安装权。') }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : bad('缺准确hash')
const digest = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const manifestKeys = ['kind','version','capsuleId','schemaVersion','sourceInventory','sourceContentHash','workspaceHistoryObservationHash',
  'assetReferencesObservationHash','referenceCount','referenceUris','tree','referenceProvenance','baseMaterialHash',
  'rawOriginalRewritten','semanticSelectionPermission','installPermit'] as const
function materialHash(value: Pick<Capsule2BaseProjectionManifest4, 'sourceContentHash' | 'workspaceHistoryObservationHash' | 'assetReferencesObservationHash' | 'tree' | 'referenceProvenance'>) {
  return digest('knowbook.capsule2.base-projection-material4.v1', { sourceContentHash: value.sourceContentHash,
    workspaceHistoryObservationHash: value.workspaceHistoryObservationHash, assetReferencesObservationHash: value.assetReferencesObservationHash,
    tree: value.tree, referenceProvenance: value.referenceProvenance })
}
function manifestHash(value: Capsule2BaseProjectionManifest4) { return digest('knowbook.capsule2.base-projection-manifest4.v1', value) }
function commit(manifest: Capsule2BaseProjectionManifest4): Capsule2BaseProjectionCommitment4 {
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整base manifest超原准备预算，不截断')
  return freezeCapsuleValue({ ...manifest, baseManifestHash: manifestHash(manifest),
    baseManifestFile: { bytes: bytes.length, sha256: capsuleBytesHash(bytes) } })
}
function validateManifest(value: unknown): Capsule2BaseProjectionManifest4 {
  const row = capsuleRecord(value, manifestKeys)
  if (row.kind !== 'capsule2-captured-base-projection' || row.version !== 1 || row.schemaVersion !== 26 && row.schemaVersion !== 27
    || row.rawOriginalRewritten !== false || row.semanticSelectionPermission !== false || row.installPermit !== false) return bad('未知格式或许可提升')
  const capsuleId = capsuleText(row.capsuleId, 36)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(capsuleId)) return bad('capsule身份无效')
  if (!Number.isSafeInteger(row.referenceCount) || typeof row.referenceCount !== 'number' || row.referenceCount < 0 || !Array.isArray(row.referenceUris)) return bad('引用计数/集合无效')
  const referenceUris = row.referenceUris.map(uri => capsuleText(uri, CAPSULE2_RAW_MAX_JSON_BYTES))
  if (referenceUris.length > row.referenceCount || row.referenceCount > 0 && !referenceUris.length
    || referenceUris.some((uri, index) => index > 0 && referenceUris[index - 1] >= uri)) return bad('原URI集合未严格闭合')
  const tree = validateCapsule2ManagedTree(row.tree), binding = { sourceContentHash: hash(row.sourceContentHash),
    workspaceHistoryObservationHash: hash(row.workspaceHistoryObservationHash), assetReferencesObservationHash: hash(row.assetReferencesObservationHash), referenceUris }
  const referenceProvenance = validateCapsule2AssetReferenceProvenance1(row.referenceProvenance, binding, tree)
  const manifest: Capsule2BaseProjectionManifest4 = { kind: 'capsule2-captured-base-projection', version: 1, capsuleId, schemaVersion: row.schemaVersion,
    sourceInventory: validateDurableSqlCapsuleInventory(row.sourceInventory), ...binding, referenceCount: row.referenceCount, tree,
    referenceProvenance, baseMaterialHash: hash(row.baseMaterialHash), rawOriginalRewritten: false, semanticSelectionPermission: false, installPermit: false }
  if (manifest.baseMaterialHash !== materialHash(manifest)) return bad('base材料hash不属于完整原scope/tree/proof')
  return freezeCapsuleValue(manifest)
}
/** Strict pure codec only. It never opens a locator or mints a Main owner. */
export function validateCapsule2BaseProjectionCommitment4(value: unknown): Capsule2BaseProjectionCommitment4 {
  const row = capsuleRecord(value, [...manifestKeys, 'baseManifestHash', 'baseManifestFile'])
  const { baseManifestHash: expectedHash, baseManifestFile, ...rawManifest } = row
  const actual = commit(validateManifest(rawManifest)), file = capsuleRecord(baseManifestFile, ['bytes', 'sha256'])
  if (hash(expectedHash) !== actual.baseManifestHash || file.bytes !== actual.baseManifestFile.bytes || hash(file.sha256) !== actual.baseManifestFile.sha256)
    return bad('base commitment/file原字节摘要不符')
  return actual
}
export function describeCapsule2BaseProjectionPointer4(value: Capsule2BaseProjectionCommitment4): Capsule2BaseProjectionPointer4 {
  return freezeCapsuleValue({ version: 1, baseManifestHash: value.baseManifestHash, baseMaterialHash: value.baseMaterialHash,
    baseManifestFile: value.baseManifestFile })
}
/** Shape only. Genuine owner reads must join both raw-file and domain hashes
 * to the actual base original before granting any use of its complete facts. */
export function validateCapsule2BaseProjectionPointer4(value: unknown): Capsule2BaseProjectionPointer4 {
  const row = capsuleRecord(value, ['version','baseManifestHash','baseMaterialHash','baseManifestFile'])
  const file = capsuleRecord(row.baseManifestFile, ['bytes','sha256'])
  if (row.version !== 1 || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('compact base pointer版本或原文件预算无效')
  return freezeCapsuleValue({ version: 1, baseManifestHash: hash(row.baseManifestHash), baseMaterialHash: hash(row.baseMaterialHash),
    baseManifestFile: { bytes: file.bytes, sha256: hash(file.sha256) } })
}
function parseManifest(text: string, capsuleId: string, expectedHash: string) {
  const manifest = validateManifest(parseStrictJson(text, { maxBytes: CAPSULE2_RAW_MAX_JSON_BYTES, maxDepth: 12 }))
  if (manifest.capsuleId !== capsuleId || text !== capsuleJson(manifest) + '\n' || manifestHash(manifest) !== hash(expectedHash)) return bad('封存base manifest身份、规范字节或hash不同')
  return commit(manifest)
}
async function readSource(original: OwnedRawCapsuleOriginal): Promise<Source> {
  const info = readOwnedRawCapsuleOriginal(original)
  await assertOwnedRawCapsuleOriginal(original)
  const fresh = await reopenPreparedRawCapsuleOriginal({ profileRoot: info.profileRoot, operationId: basename(info.recoveryDirectory),
    capsuleId: basename(info.capsuleDirectory), expectedInventory: info.originalInventory })
  const actual = readOwnedRawCapsuleOriginal(fresh)
  await assertOwnedRawCapsuleScratchReady(fresh)
  const db = new Database(restoreSqliteFilename(actual.databasePath), { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    return db.transaction(() => readRawCapsule2AssetReferenceSourceOwned(db))()
  } finally { db.close(); await assertOwnedRawCapsuleScratchContent(fresh); await assertOwnedRawCapsuleOriginal(original) }
}
async function verifyBytes(saved: Saved): Promise<void> {
  await assertOwnedRawCapsuleOriginal(saved.original)
  const files = join(saved.directory, 'files'), expected = saved.commitment.tree.files.map(file => file.hash).sort(compare)
  const closure = async () => {
    await directory(saved.directory, saved.root); await directory(files, saved.root)
    const names = (await readdir(saved.directory)).sort(compare)
    // Contexts and final archive manifest belong to the surrounding archive4
    // owner, which checks their exact bytes/closure independently. This owner
    // authenticates its own two fixed artifacts before and after every read.
    if (!names.includes('base-provenance.json') || !names.includes('files')
      || names.some(name => !['base-provenance.json', 'files', 'contexts', 'manifest.json'].includes(name))
      || capsuleJson((await readdir(files)).sort(compare)) !== capsuleJson(expected)) return bad('base原件目录闭集变化')
  }
  await closure()
  await readExact(join(saved.directory, 'base-provenance.json'), saved.root, saved.bytes.length, capsuleBytesHash(saved.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  for (const file of saved.commitment.tree.files) await readExact(join(files, file.hash), saved.root, file.bytes, file.hash, ATTACHMENT_MAX_FILE_BYTES)
  await closure(); await assertOwnedRawCapsuleOriginal(saved.original)
}
async function rebuild(saved: Saved) {
  await verifyBytes(saved)
  const source = await readSource(saved.original), manifest = saved.commitment, info = readOwnedRawCapsuleOriginal(saved.original), assets = source.assets
  const referenceUris = [...new Set(assets.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(compare)
  if (source.sourceContent.schemaVersion !== manifest.schemaVersion || assets.sourceContentHash !== manifest.sourceContentHash
    || assets.workspaceHistoryObservationHash !== manifest.workspaceHistoryObservationHash || assets.observationHash !== manifest.assetReferencesObservationHash
    || capsuleJson(info.originalInventory) !== capsuleJson(manifest.sourceInventory) || capsuleJson(referenceUris) !== capsuleJson(manifest.referenceUris)
    || assets.scopes.reduce((count, scope) => count + scope.destinations.length, 0) !== manifest.referenceCount) return bad('base proof不属于同次完整真实SQL/typed scope')
  validateCapsule2AssetReferenceProvenance1(manifest.referenceProvenance, { sourceContentHash: assets.sourceContentHash,
    workspaceHistoryObservationHash: assets.workspaceHistoryObservationHash, assetReferencesObservationHash: assets.observationHash, referenceUris }, manifest.tree)
  const settledEvidence = deriveCapsule2SettledPortableEvidence3({ source,
    referenceCapture: { version: 2, sourceContentHash: manifest.sourceContentHash, workspaceHistoryObservationHash: manifest.workspaceHistoryObservationHash,
      assetReferencesObservationHash: manifest.assetReferencesObservationHash, referenceUris, tree: manifest.tree, referenceProvenance: manifest.referenceProvenance },
    binding: { baseProjectionManifestHash: manifest.baseManifestHash, baseProjectionMaterialHash: manifest.baseMaterialHash } },
    { preferProjectedCandidate: true })
  await verifyBytes(saved)
  return Object.freeze({ commitment: manifest, source, sourceContent: source.sourceContent, baseAssets: assets,
    tree: manifest.tree, baseProof: manifest.referenceProvenance, referenceUris, settledEvidence })
}
function mint(saved: Saved): PreparedCapsule2BaseProjection4 {
  const owner: PreparedCapsule2BaseProjection4 = Object.freeze({ kind: 'main-capsule2-base-projection4' })
  owners.set(owner, saved); return owner
}
/** The only live capture factory: its fixed profile/root/output come entirely
 * from the genuine Original registry before any caller properties are read. */
export async function prepareCapsule2BaseProjection4(original: OwnedRawCapsuleOriginal) {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已开始或失败，不覆盖重试')
  used.add(original)
  const source = await readSource(original), assets = source.assets, capsuleId = basename(info.capsuleDirectory)
  const base = join(info.recoveryDirectory, 'knowledge-complete-assets-v2'), output = join(base, capsuleId), files = join(output, 'files')
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true); await restoreDirectory(files, info.profileRoot, true)
  const tree = await captureCapsule2ManagedTreeData(join(info.profileRoot, 'storage', 'assets'), info.profileRoot, files)
  const referenceUris = [...new Set(assets.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(compare)
  const binding = { sourceContentHash: assets.sourceContentHash, workspaceHistoryObservationHash: assets.workspaceHistoryObservationHash,
    assetReferencesObservationHash: assets.observationHash, referenceUris }
  const referenceProvenance = await captureCapsule2AssetReferenceProvenanceOwned3(original, binding, tree)
  const material = { ...binding, tree, referenceProvenance }
  const manifest: Capsule2BaseProjectionManifest4 = freezeCapsuleValue({ kind: 'capsule2-captured-base-projection', version: 1, capsuleId,
    schemaVersion: source.sourceContent.schemaVersion, sourceInventory: info.originalInventory, ...material,
    referenceCount: assets.scopes.reduce((count, scope) => count + scope.destinations.length, 0), baseMaterialHash: materialHash(material),
    rawOriginalRewritten: false, semanticSelectionPermission: false, installPermit: false })
  const commitment = commit(manifest), bytes = Buffer.from(capsuleJson(manifest) + '\n')
  await writeNew(join(output, 'base-provenance.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, commitment, bytes }
  await rebuild(saved)
  return Object.freeze({ owner: mint(saved), commitment })
}
/** Cold reopen only: fixed sealed paths, raw SQL and copies; no live assets or
 * source spool probes. The surrounding archive pins the exact commitment. */
export async function reopenCapsule2BaseProjection4(original: OwnedRawCapsuleOriginal, expectedBaseManifestHash: string,
  expectedPointer?: Capsule2BaseProjectionPointer4): Promise<PreparedCapsule2BaseProjection4> {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已开始或失败，不重复重开')
  used.add(original)
  const output = join(info.recoveryDirectory, 'knowledge-complete-assets-v2', basename(info.capsuleDirectory))
  await directory(output, info.profileRoot)
  const text = await readCapsule2AssetManifest(join(output, 'base-provenance.json'), info.profileRoot)
  const commitment = parseManifest(text, basename(info.capsuleDirectory), expectedBaseManifestHash)
  if (expectedPointer && capsuleJson(describeCapsule2BaseProjectionPointer4(commitment)) !== capsuleJson(validateCapsule2BaseProjectionPointer4(expectedPointer)))
    return bad('实际base文件raw SHA/bytes、domain hash或material hash不属于固定archive pointer')
  const saved: Saved = { original, root: info.profileRoot, directory: output, commitment, bytes: Buffer.from(text) }
  await rebuild(saved); return mint(saved)
}
export async function readCapsule2BaseProjection4(owner: PreparedCapsule2BaseProjection4) {
  const saved = owners.get(owner)
  if (!saved) return bad('不是genuine Original派生的base owner')
  return rebuild(saved)
}
/** Identity-only composition seam. A matching path/hash/DTO cannot replace the
 * exact Original used to mint this owner; read() does all byte revalidation. */
export function assertCapsule2BaseProjectionOriginal4(owner: PreparedCapsule2BaseProjection4, original: OwnedRawCapsuleOriginal): void {
  const saved = owners.get(owner)
  if (!saved || saved.original !== original) return bad('owner不属于精确genuine Original')
}
export async function assertCapsule2BaseProjectionOriginalBytes4(owner: PreparedCapsule2BaseProjection4): Promise<void> {
  const saved = owners.get(owner)
  if (!saved) return bad('不是genuine Original派生的base owner')
  await verifyBytes(saved)
}

/** Working5 consumes only same-read original base facts. Published Base4
 * reads keep their exact custom observer output, policy and hash semantics. */
async function rebuildOriginalInput5(saved: Saved) {
  await verifyBytes(saved)
  const source = await readSource(saved.original), manifest = saved.commitment, info = readOwnedRawCapsuleOriginal(saved.original), assets = source.assets
  const referenceUris = [...new Set(assets.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(compare)
  if (source.sourceContent.schemaVersion !== manifest.schemaVersion || assets.sourceContentHash !== manifest.sourceContentHash
    || assets.workspaceHistoryObservationHash !== manifest.workspaceHistoryObservationHash || assets.observationHash !== manifest.assetReferencesObservationHash
    || capsuleJson(info.originalInventory) !== capsuleJson(manifest.sourceInventory) || capsuleJson(referenceUris) !== capsuleJson(manifest.referenceUris)
    || assets.scopes.reduce((count, scope) => count + scope.destinations.length, 0) !== manifest.referenceCount) return bad('base proof不属于同次完整真实SQL/typed scope')
  validateCapsule2AssetReferenceProvenance1(manifest.referenceProvenance, { sourceContentHash: assets.sourceContentHash,
    workspaceHistoryObservationHash: assets.workspaceHistoryObservationHash, assetReferencesObservationHash: assets.observationHash, referenceUris }, manifest.tree)
  await verifyBytes(saved)
  return Object.freeze({commitment:manifest,source,sourceContent:source.sourceContent,baseAssets:assets,tree:manifest.tree,baseProof:manifest.referenceProvenance,referenceUris})
}
export async function prepareCapsule2BaseProjectionForWorking5(original: OwnedRawCapsuleOriginal) {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已开始或失败，不覆盖重试')
  used.add(original)
  const source = await readSource(original), assets = source.assets, capsuleId = basename(info.capsuleDirectory)
  const base = join(info.recoveryDirectory, 'knowledge-complete-assets-v2'), output = join(base, capsuleId), files = join(output, 'files')
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true); await restoreDirectory(files, info.profileRoot, true)
  const tree = await captureCapsule2ManagedTreeData(join(info.profileRoot, 'storage', 'assets'), info.profileRoot, files)
  const referenceUris = [...new Set(assets.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(compare)
  const binding = { sourceContentHash: assets.sourceContentHash, workspaceHistoryObservationHash: assets.workspaceHistoryObservationHash,
    assetReferencesObservationHash: assets.observationHash, referenceUris }
  const referenceProvenance = await captureCapsule2AssetReferenceProvenanceOwned3(original, binding, tree)
  const material = { ...binding, tree, referenceProvenance }
  const manifest: Capsule2BaseProjectionManifest4 = freezeCapsuleValue({ kind: 'capsule2-captured-base-projection', version: 1, capsuleId,
    schemaVersion: source.sourceContent.schemaVersion, sourceInventory: info.originalInventory, ...material,
    referenceCount: assets.scopes.reduce((count, scope) => count + scope.destinations.length, 0), baseMaterialHash: materialHash(material),
    rawOriginalRewritten: false, semanticSelectionPermission: false, installPermit: false })
  const commitment = commit(manifest), bytes = Buffer.from(capsuleJson(manifest) + '\n')
  await writeNew(join(output, 'base-provenance.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, commitment, bytes }
  await rebuildOriginalInput5(saved)
  return Object.freeze({ owner: mint(saved), commitment })
}
export async function reopenCapsule2BaseProjectionForWorking5(original: OwnedRawCapsuleOriginal, expectedBaseManifestHash: string,
  expectedPointer?: Capsule2BaseProjectionPointer4): Promise<PreparedCapsule2BaseProjection4> {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已开始或失败，不重复重开')
  used.add(original)
  const output = join(info.recoveryDirectory, 'knowledge-complete-assets-v2', basename(info.capsuleDirectory))
  await directory(output, info.profileRoot)
  const text = await readCapsule2AssetManifest(join(output, 'base-provenance.json'), info.profileRoot)
  const commitment = parseManifest(text, basename(info.capsuleDirectory), expectedBaseManifestHash)
  if (expectedPointer && capsuleJson(describeCapsule2BaseProjectionPointer4(commitment)) !== capsuleJson(validateCapsule2BaseProjectionPointer4(expectedPointer)))
    return bad('实际base文件raw SHA/bytes、domain hash或material hash不属于固定archive pointer')
  const saved: Saved = { original, root: info.profileRoot, directory: output, commitment, bytes: Buffer.from(text) }
  await rebuildOriginalInput5(saved); return mint(saved)
}
export async function readCapsule2BaseProjectionOriginalInput5(owner:PreparedCapsule2BaseProjection4){
 const saved=owners.get(owner);if(!saved)return bad('不是genuine Original/base owner');return rebuildOriginalInput5(saved)
}
