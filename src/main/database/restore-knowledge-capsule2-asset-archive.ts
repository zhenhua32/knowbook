import Database from 'better-sqlite3'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseStrictJson } from '../../shared/strictJson'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { assertOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchReady, assertOwnedRawCapsuleScratchContent,
  readOwnedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { capsuleBytesHash, capsuleJson, capsuleRecord, capsuleText, freezeCapsuleValue,
  validateDurableSqlCapsuleInventory, type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { readRawCapsule2AssetReferencesOwned } from './restore-knowledge-capsule2-assets-read'
import { captureCapsule2ManagedTreeData, type Capsule2ManagedTreeData } from './restore-knowledge-capsule2-managed-assets-files'
import { validateCapsule2ManagedTree } from './restore-knowledge-capsule2-assets-model'
import { captureCapsule2AssetReferenceProvenanceOwned3, validateCapsule2AssetReferenceProvenance1,
  type Capsule2AssetReferenceProvenance1 } from './restore-knowledge-capsule2-asset-provenance'
import { assertCapsule2AssetDirectory as directory, readCapsule2AssetManifest,
  writeCapsule2AssetCopy as writeNew, readCapsule2AssetCopy as readExact } from './restore-knowledge-capsule2-assets-files'

/** The physical Main-managed tree and the SQL's actual reference literals are
 * separate source facts. Missing, foreign and future reference targets never
 * cause automatic file/network access or disappear from the original SQL. */
interface Capsule2AssetArchiveBase {
  readonly kind: 'capsule2-complete-asset-archive'
  readonly material: 'main-managed-tree-and-original-reference-literals'
  readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
  readonly capsuleId: string; readonly schemaVersion: 26 | 27; readonly sourceInventory: readonly DurableSqlCapsuleFile[]
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string; readonly assetReferencesObservationHash: string
  readonly referenceCount: number; readonly referenceUris: readonly string[]; readonly tree: Capsule2ManagedTreeData
}
export interface Capsule2AssetReferenceCoverage2 {
  readonly kind: 'base-asset-observation-capture-only'; readonly version: 1; readonly baseObserverVersion: 3
  readonly assetReferencesObservationHash: string; readonly baseTypedScopesCaptured: true
  readonly supplementalCustomMergeScopesCaptured: false; readonly allAssetScopesCaptured: false
  readonly semanticSelectionPermission: false; readonly finalAssetClosureComplete: false
  readonly acceptedCoverage: false; readonly effective: false; readonly installPermit: false
}
export type Capsule2AssetArchiveManifest = Capsule2AssetArchiveBase & (
  { readonly version: 1; readonly referencePolicy: 'retain-literals-without-reference-file-access' }
  | { readonly version: 2; readonly referencePolicy: 'capture-owned-aliases-retain-unresolved-literals';
    readonly referenceProvenance: Capsule2AssetReferenceProvenance1; readonly coverage: Capsule2AssetReferenceCoverage2 })
export interface PreparedCapsule2AssetArchive { readonly kind: 'prepared-capsule2-complete-asset-archive' }
export interface Capsule2AssetArchiveInfo { readonly directory: string; readonly manifest: Capsule2AssetArchiveManifest; readonly manifestHash: string }
type Saved = Capsule2AssetArchiveInfo & { original: OwnedRawCapsuleOriginal; root: string; bytes: Buffer }
const archives = new WeakMap<PreparedCapsule2AssetArchive, Saved>(), used = new WeakSet<OwnedRawCapsuleOriginal>()
const domain = 'knowbook.capsule2.complete-asset-archive.v1'
const bad = (message: string): never => { throw new Error('capsule2完整附件归档无效：' + message + '；原引用保留，不授外部文件读取、认证或安装权。') }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : bad('原hash无效')
const archiveDomain = (version: 1 | 2) => version === 1 ? domain : 'knowbook.capsule2.complete-asset-archive.v2'
const manifestHash = (value: Capsule2AssetArchiveManifest) => capsuleBytesHash(archiveDomain(value.version) + '\0' + capsuleJson(value))
function baseCoverage(assetReferencesObservationHash: string): Capsule2AssetReferenceCoverage2 {
  return freezeCapsuleValue({ kind: 'base-asset-observation-capture-only', version: 1, baseObserverVersion: 3,
    assetReferencesObservationHash, baseTypedScopesCaptured: true, supplementalCustomMergeScopesCaptured: false,
    allAssetScopesCaptured: false, semanticSelectionPermission: false, finalAssetClosureComplete: false,
    acceptedCoverage: false, effective: false, installPermit: false })
}

function parse(text: string, capsuleId: string, expectedHash: string): Capsule2AssetArchiveManifest {
  const parsed = parseStrictJson(text, { maxBytes: CAPSULE2_RAW_MAX_JSON_BYTES, maxDepth: 12 })
  const version = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).version : null
  if (version !== 1 && version !== 2) return bad('未知archive版本，不降级或补造权属')
  const row = capsuleRecord(parsed, ['kind','version','material','referencePolicy','certified','semanticValidationComplete','permit',
    'capsuleId','schemaVersion','sourceInventory','sourceContentHash','workspaceHistoryObservationHash','assetReferencesObservationHash','referenceCount','referenceUris','tree',
    ...(version === 2 ? ['referenceProvenance','coverage'] : [])])
  if (text !== capsuleJson(parsed) + '\n' || capsuleBytesHash(archiveDomain(version) + '\0' + capsuleJson(parsed)) !== hash(expectedHash)) return bad('规范原字节或预期hash不符')
  if (row.kind !== 'capsule2-complete-asset-archive' || row.material !== 'main-managed-tree-and-original-reference-literals'
    || row.referencePolicy !== (version === 1 ? 'retain-literals-without-reference-file-access' : 'capture-owned-aliases-retain-unresolved-literals')
    || row.certified !== false || row.semanticValidationComplete !== false
    || row.permit !== false || row.capsuleId !== capsuleId || row.schemaVersion !== 26 && row.schemaVersion !== 27) return bad('格式、身份或权限标志无效')
  if (typeof row.referenceCount !== 'number' || !Number.isSafeInteger(row.referenceCount) || row.referenceCount < 0
    || !Array.isArray(row.referenceUris) || row.referenceUris.length > row.referenceCount) return bad('完整引用计数不闭合')
  const uris = row.referenceUris.map(value => capsuleText(value, CAPSULE2_RAW_MAX_JSON_BYTES))
  if (row.referenceCount > 0 && uris.length === 0) return bad('非空引用被降为空集合')
  for (let index = 1; index < uris.length; index++) if (uris[index - 1] >= uris[index]) return bad('原引用未排序或重复')
  const schemaVersion: 26 | 27 = row.schemaVersion
  const base = { kind: 'capsule2-complete-asset-archive' as const, material: 'main-managed-tree-and-original-reference-literals' as const,
    certified: false as const, semanticValidationComplete: false as const, permit: false as const, capsuleId, schemaVersion,
    sourceInventory: validateDurableSqlCapsuleInventory(row.sourceInventory), sourceContentHash: hash(row.sourceContentHash),
    workspaceHistoryObservationHash: hash(row.workspaceHistoryObservationHash), assetReferencesObservationHash: hash(row.assetReferencesObservationHash),
    referenceCount: row.referenceCount, referenceUris: uris, tree: validateCapsule2ManagedTree(row.tree) }
  if (version === 1) return freezeCapsuleValue({ ...base, version: 1, referencePolicy: 'retain-literals-without-reference-file-access' })
  const coverage = baseCoverage(base.assetReferencesObservationHash)
  if (capsuleJson(row.coverage) !== capsuleJson(coverage)) return bad('部分覆盖策略不可被caller DTO升级或改变观察域')
  return freezeCapsuleValue({ ...base, version: 2, referencePolicy: 'capture-owned-aliases-retain-unresolved-literals', coverage,
    referenceProvenance: validateCapsule2AssetReferenceProvenance1(row.referenceProvenance, base, base.tree) })
}

async function source(original: OwnedRawCapsuleOriginal) {
  const info = readOwnedRawCapsuleOriginal(original)
  await assertOwnedRawCapsuleScratchReady(original)
  const db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    const value = db.transaction(() => readRawCapsule2AssetReferencesOwned(db))()
    return { schemaVersion: db.pragma('user_version', { simple: true }) as 26 | 27,
      sourceContentHash: value.sourceContentHash, workspaceHistoryObservationHash: value.workspaceHistoryObservationHash,
      assetReferencesObservationHash: value.observationHash, referenceCount: value.scopes.reduce((count, scope) => count + scope.destinations.length, 0),
      referenceUris: [...new Set(value.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(compare) }
  } finally { db.close(); await assertOwnedRawCapsuleScratchContent(original) }
}
async function verify(value: Saved): Promise<Capsule2AssetArchiveInfo> {
  await assertOwnedRawCapsuleOriginal(value.original)
  const files = join(value.directory, 'files'), expectedNames = value.manifest.tree.files.map(file => file.hash).sort(compare)
  const closure = async () => {
    await directory(value.directory, value.root); await directory(files, value.root)
    if (capsuleJson((await readdir(value.directory)).sort(compare)) !== capsuleJson(['files','manifest.json'])
      || capsuleJson((await readdir(files)).sort(compare)) !== capsuleJson(expectedNames)) return bad('完整归档闭集变化')
  }
  await closure()
  await readExact(join(value.directory, 'manifest.json'), value.root, value.bytes.length, capsuleBytesHash(value.bytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  for (const file of value.manifest.tree.files) await readExact(join(files, file.hash), value.root, file.bytes, file.hash, ATTACHMENT_MAX_FILE_BYTES)
  await closure(); await assertOwnedRawCapsuleOriginal(value.original)
  return freezeCapsuleValue({ directory: value.directory, manifest: value.manifest, manifestHash: value.manifestHash })
}
function start(original: OwnedRawCapsuleOriginal) {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已开始或失败，不能重入')
  used.add(original)
  return info
}
function register(value: Saved): PreparedCapsule2AssetArchive {
  const handle: PreparedCapsule2AssetArchive = Object.freeze({ kind: 'prepared-capsule2-complete-asset-archive' })
  archives.set(handle, value)
  return handle
}
async function prepareArchive(original: OwnedRawCapsuleOriginal, version: 1 | 2): Promise<PreparedCapsule2AssetArchive> {
  const info = start(original), observed = await source(original), capsuleId = basename(info.capsuleDirectory)
  const base = join(info.recoveryDirectory, 'knowledge-complete-assets-v2'), output = join(base, capsuleId), files = join(output, 'files')
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true); await restoreDirectory(files, info.profileRoot, true)
  const tree = await captureCapsule2ManagedTreeData(join(info.profileRoot, 'storage', 'assets'), info.profileRoot, files)
  const common = { kind: 'capsule2-complete-asset-archive' as const, material: 'main-managed-tree-and-original-reference-literals' as const,
    certified: false as const, semanticValidationComplete: false as const, permit: false as const, capsuleId,
    sourceInventory: info.originalInventory, ...observed, tree }
  const manifest: Capsule2AssetArchiveManifest = version === 1
    ? freezeCapsuleValue({ ...common, version: 1, referencePolicy: 'retain-literals-without-reference-file-access' })
    : freezeCapsuleValue({ ...common, version: 2, referencePolicy: 'capture-owned-aliases-retain-unresolved-literals',
      coverage: baseCoverage(observed.assetReferencesObservationHash),
      referenceProvenance: await captureCapsule2AssetReferenceProvenanceOwned3(original, observed, tree) })
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整manifest超预算，不截断')
  await assertOwnedRawCapsuleOriginal(original)
  await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: manifestHash(manifest) }
  await verify(saved)
  return register(saved)
}
/** Legacy capture stays archive v1, without inferred file URI authority. */
export async function prepareCapsule2AssetArchive(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2AssetArchive> {
  return prepareArchive(original, 1)
}
/** Explicit Main producer; only the genuine original chooses the profile,
 * base typed observation and captured tree. No caller proofs/paths/URI list. */
export async function prepareCapsule2AssetArchiveWithProvenance3(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2AssetArchive> {
  return prepareArchive(original, 2)
}
export async function reopenCapsule2AssetArchive(original: OwnedRawCapsuleOriginal, expectedManifestHash: string): Promise<PreparedCapsule2AssetArchive> {
  const info = start(original), capsuleId = basename(info.capsuleDirectory), output = join(info.recoveryDirectory, 'knowledge-complete-assets-v2', capsuleId)
  await directory(output, info.profileRoot)
  const text = await readCapsule2AssetManifest(join(output, 'manifest.json'), info.profileRoot), manifest = parse(text, capsuleId, expectedManifestHash)
  const observed = await source(original)
  if (capsuleJson(manifest.sourceInventory) !== capsuleJson(info.originalInventory)) return bad('原SQL清单不符')
  for (const key of ['schemaVersion','sourceContentHash','workspaceHistoryObservationHash','assetReferencesObservationHash','referenceCount','referenceUris'] as const)
    if (capsuleJson(manifest[key]) !== capsuleJson(observed[key])) return bad('完整实际SQL来源或原引用变化')
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, bytes: Buffer.from(text), manifestHash: expectedManifestHash }
  await verify(saved)
  return register(saved)
}
export async function readCapsule2AssetArchive(handle: PreparedCapsule2AssetArchive): Promise<Capsule2AssetArchiveInfo> {
  const value = archives.get(handle)
  if (!value) return bad('不是Main实际准备的私有句柄')
  return verify(value)
}

/** Fixed Main source seam. A serialized archive/ref or caller inventory cannot
 * obtain an original; the complete archive and its immutable SQL are reread. */
export async function readCapsule2ArchiveSourceOriginal(handle: PreparedCapsule2AssetArchive): Promise<OwnedRawCapsuleOriginal> {
  const value = archives.get(handle)
  if (!value) return bad('不是Main实际准备的私有句柄')
  await verify(value)
  return value.original
}

/** Pure original manifest codec; parsing never creates an archive/source handle. */
export const parseCapsule2CompleteAssetArchiveManifest = parse

/** One complete fresh archive read supplies both facts to the fixed SQL owner.
 * The private registry binds the original; no caller pair or inventory can
 * choose it. Every original, manifest and blob check remains in verify. */
export async function readCapsule2ArchiveSourceInputs(handle: PreparedCapsule2AssetArchive) {
  const value = archives.get(handle)
  if (!value) return bad('不是Main实际准备的私有句柄')
  return Object.freeze({ original: value.original, value: await verify(value) })
}
