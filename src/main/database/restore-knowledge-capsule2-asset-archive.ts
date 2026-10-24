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
import { assertCapsule2AssetDirectory as directory, readCapsule2AssetManifest,
  writeCapsule2AssetCopy as writeNew, readCapsule2AssetCopy as readExact } from './restore-knowledge-capsule2-assets-files'

/** The physical Main-managed tree and the SQL's actual reference literals are
 * separate source facts. Missing, foreign and future reference targets never
 * cause automatic file/network access or disappear from the original SQL. */
export interface Capsule2AssetArchiveManifest {
  readonly kind: 'capsule2-complete-asset-archive'; readonly version: 1
  readonly material: 'main-managed-tree-and-original-reference-literals'
  readonly referencePolicy: 'retain-literals-without-reference-file-access'
  readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
  readonly capsuleId: string; readonly schemaVersion: 26 | 27; readonly sourceInventory: readonly DurableSqlCapsuleFile[]
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string; readonly assetReferencesObservationHash: string
  readonly referenceCount: number; readonly referenceUris: readonly string[]; readonly tree: Capsule2ManagedTreeData
}
export interface PreparedCapsule2AssetArchive { readonly kind: 'prepared-capsule2-complete-asset-archive' }
export interface Capsule2AssetArchiveInfo { readonly directory: string; readonly manifest: Capsule2AssetArchiveManifest; readonly manifestHash: string }
type Saved = Capsule2AssetArchiveInfo & { original: OwnedRawCapsuleOriginal; root: string; bytes: Buffer }
const archives = new WeakMap<PreparedCapsule2AssetArchive, Saved>(), used = new WeakSet<OwnedRawCapsuleOriginal>()
const domain = 'knowbook.capsule2.complete-asset-archive.v1'
const bad = (message: string): never => { throw new Error('capsule2完整附件归档无效：' + message + '；原引用保留，不授外部文件读取、认证或安装权。') }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : bad('原hash无效')
const manifestHash = (value: Capsule2AssetArchiveManifest) => capsuleBytesHash(domain + '\0' + capsuleJson(value))

function parse(text: string, capsuleId: string, expectedHash: string): Capsule2AssetArchiveManifest {
  const parsed = parseStrictJson(text, { maxBytes: CAPSULE2_RAW_MAX_JSON_BYTES, maxDepth: 12 })
  const row = capsuleRecord(parsed, ['kind','version','material','referencePolicy','certified','semanticValidationComplete','permit',
    'capsuleId','schemaVersion','sourceInventory','sourceContentHash','workspaceHistoryObservationHash','assetReferencesObservationHash','referenceCount','referenceUris','tree'])
  if (text !== capsuleJson(parsed) + '\n' || capsuleBytesHash(domain + '\0' + capsuleJson(parsed)) !== hash(expectedHash)) return bad('规范原字节或预期hash不符')
  if (row.kind !== 'capsule2-complete-asset-archive' || row.version !== 1 || row.material !== 'main-managed-tree-and-original-reference-literals'
    || row.referencePolicy !== 'retain-literals-without-reference-file-access' || row.certified !== false || row.semanticValidationComplete !== false
    || row.permit !== false || row.capsuleId !== capsuleId || row.schemaVersion !== 26 && row.schemaVersion !== 27) return bad('格式、身份或权限标志无效')
  if (typeof row.referenceCount !== 'number' || !Number.isSafeInteger(row.referenceCount) || row.referenceCount < 0
    || !Array.isArray(row.referenceUris) || row.referenceUris.length > row.referenceCount) return bad('完整引用计数不闭合')
  const uris = row.referenceUris.map(value => capsuleText(value, CAPSULE2_RAW_MAX_JSON_BYTES))
  if (row.referenceCount > 0 && uris.length === 0) return bad('非空引用被降为空集合')
  for (let index = 1; index < uris.length; index++) if (uris[index - 1] >= uris[index]) return bad('原引用未排序或重复')
  const schemaVersion: 26 | 27 = row.schemaVersion
  return freezeCapsuleValue({ kind: 'capsule2-complete-asset-archive', version: 1,
    material: 'main-managed-tree-and-original-reference-literals', referencePolicy: 'retain-literals-without-reference-file-access',
    certified: false, semanticValidationComplete: false, permit: false, capsuleId, schemaVersion,
    sourceInventory: validateDurableSqlCapsuleInventory(row.sourceInventory), sourceContentHash: hash(row.sourceContentHash),
    workspaceHistoryObservationHash: hash(row.workspaceHistoryObservationHash), assetReferencesObservationHash: hash(row.assetReferencesObservationHash),
    referenceCount: row.referenceCount, referenceUris: uris, tree: validateCapsule2ManagedTree(row.tree) })
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
export async function prepareCapsule2AssetArchive(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2AssetArchive> {
  const info = start(original), observed = await source(original), capsuleId = basename(info.capsuleDirectory)
  const base = join(info.recoveryDirectory, 'knowledge-complete-assets-v2'), output = join(base, capsuleId), files = join(output, 'files')
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true); await restoreDirectory(files, info.profileRoot, true)
  const tree = await captureCapsule2ManagedTreeData(join(info.profileRoot, 'storage', 'assets'), info.profileRoot, files)
  const manifest: Capsule2AssetArchiveManifest = freezeCapsuleValue({ kind: 'capsule2-complete-asset-archive', version: 1,
    material: 'main-managed-tree-and-original-reference-literals', referencePolicy: 'retain-literals-without-reference-file-access',
    certified: false, semanticValidationComplete: false, permit: false, capsuleId, sourceInventory: info.originalInventory, ...observed, tree })
  const bytes = Buffer.from(capsuleJson(manifest) + '\n')
  if (bytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整manifest超预算，不截断')
  await assertOwnedRawCapsuleOriginal(original)
  await writeNew(join(output, 'manifest.json'), bytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, bytes, manifestHash: manifestHash(manifest) }
  await verify(saved)
  return register(saved)
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
