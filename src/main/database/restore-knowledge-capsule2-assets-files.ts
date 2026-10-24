import Database from 'better-sqlite3'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readManagedAssetSource } from '../managed-asset-source'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { readRawCapsule2AssetReferencesOwned } from './restore-knowledge-capsule2-assets-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue, type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { assertOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchReady, assertOwnedRawCapsuleScratchContent, readOwnedRawCapsuleOriginal,
  type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { assertRestorePath, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { parseCapsule2KnownAssetManifest } from './restore-knowledge-capsule2-assets-model'

// Finite preparation limits, matching existing V3 file/count budgets. This is
// not a streaming1TiB certifier or a change to public wire/source SQL limits.
const maxFiles = 5_000, maxBytes = 500 * 1024 * 1024
type Alias = { uri: string; relativePath: string; hash: string; name: string; bytes: number }
export interface Capsule2KnownAssetManifest {
  readonly kind: 'capsule2-known-managed-asset-originals'; readonly version: 1
  readonly state: 'known-markdown-files-only'; readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
  readonly capsuleId: string; readonly schemaVersion: 26 | 27; readonly sourceInventory: readonly DurableSqlCapsuleFile[]
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string; readonly assetReferencesObservationHash: string
  readonly aliases: readonly Alias[]; readonly files: readonly { hash: string; bytes: number }[]
}
/** Private prepared data identity only, never a certifier/Root/installation permit. */
export interface PreparedCapsule2KnownAssetOriginals { readonly kind: 'prepared-capsule2-known-asset-originals' }
export interface PreparedCapsule2KnownAssetInfo {
  readonly directory: string; readonly manifest: Capsule2KnownAssetManifest; readonly manifestHash: string
}
type Saved = PreparedCapsule2KnownAssetInfo & { original: OwnedRawCapsuleOriginal; root: string; manifestBytes: Buffer }
const prepared = new WeakMap<PreparedCapsule2KnownAssetOriginals, Saved>(), used = new WeakSet<OwnedRawCapsuleOriginal>()
const bad = (message: string): never => { throw new Error('capsule2已知资产原件无效：' + message + '；不改SQL或旧原件，不授认证/安装权，失败新目录保留。') }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function independent(info: Stats): boolean { return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 }
function same(a: Stats, b: Stats, path = false): boolean {
  return (a.dev === b.dev || path && process.platform === 'win32' && a.dev === 0)
    && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink
}
async function directory(path: string, root: string): Promise<void> {
  await assertRestorePath(path, root)
  if (!(await lstat(path)).isDirectory() || !samePath(await realpath(path), resolve(path))) return bad('目录不是准确Main自有路径')
}
async function writeNew(path: string, bytes: Buffer, root: string): Promise<void> {
  await assertRestorePath(path, root)
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    if (!independent(await fd.stat())) return bad('新副本不是独立普通文件')
    let offset = 0
    while (offset < bytes.length) { const { bytesWritten } = await fd.write(bytes, offset, bytes.length - offset, null); if (!bytesWritten) return bad('新副本写入未推进'); offset += bytesWritten }
    await fd.sync()
    const after = await fd.stat()
    await assertRestorePath(path, root)
    if (!independent(after) || after.size !== bytes.length || !same(await lstat(path), after, true)) return bad('新副本写入身份变化')
  } finally { await fd.close() }
}
async function readBounded(path: string, root: string, bytes: number, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) return bad('完整文件超准备预算')
  await assertRestorePath(path, root)
  const info = await lstat(path)
  if (!independent(info) || info.size !== bytes) return bad('归档不是准确独立文件')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat()
    if (!independent(before) || !same(info, before, true)) return bad('归档打开时身份变化')
    const buffer = Buffer.alloc(bytes + 1); let length = 0
    while (length < buffer.length) { const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead }
    const after = await fd.stat()
    await assertRestorePath(path, root)
    if (length !== bytes || !same(before, after) || !same(await lstat(path), after, true)) return bad('归档有界读取时变化')
    const result = buffer.subarray(0, length)
    return result
  } finally { await fd.close() }
}
async function readExact(path: string, root: string, bytes: number, expectedHash: string, limit: number): Promise<Buffer> {
  const result = await readBounded(path, root, bytes, limit)
  if (capsuleBytesHash(result) !== expectedHash) return bad('归档原字节hash不符')
  return result
}
/** Untrusted manifest bytes only. Its owner must parse and check the pinned
 * domain hash before using any field, and separately validate actual SQL. */
export async function readCapsule2AssetManifest(path: string, root: string, maximumBytes = CAPSULE2_RAW_MAX_JSON_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('清单读取预算无效')
  await assertRestorePath(path, root)
  const info = await lstat(path)
  const bytes = await readBounded(path, root, info.size, maximumBytes)
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}
async function verify(value: Saved): Promise<PreparedCapsule2KnownAssetInfo> {
  await assertOwnedRawCapsuleOriginal(value.original)
  await directory(value.directory, value.root)
  const entries = (await readdir(value.directory)).sort(compare)
  if (capsuleJson(entries) !== capsuleJson(['files', 'manifest.json'])) return bad('归档目录含缺失/未知文件')
  const filesDirectory = join(value.directory, 'files'); await directory(filesDirectory, value.root)
  const expected = value.manifest.files.map(file => file.hash).sort(compare)
  if (capsuleJson((await readdir(filesDirectory)).sort(compare)) !== capsuleJson(expected)) return bad('完整资产文件闭集不符')
  const bytes = await readExact(join(value.directory, 'manifest.json'), value.root, value.manifestBytes.length,
    capsuleBytesHash(value.manifestBytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  // Current-process registry holds the actual constructed complete manifest.
  // An untrusted manifest is never parsed as a locator, root or authority.
  if (!bytes.equals(value.manifestBytes)) return bad('完整manifest原字节不符')
  for (const file of value.manifest.files) await readExact(join(filesDirectory, file.hash), value.root, file.bytes, file.hash, ATTACHMENT_MAX_FILE_BYTES)
  await assertOwnedRawCapsuleOriginal(value.original)
  return freezeCapsuleValue({ directory: value.directory, manifest: value.manifest, manifestHash: value.manifestHash })
}

/** Derives all known destinations from the same actual owned SQL snapshot.
 * No caller root, file list, URI, selected scopes, hash or proof is accepted.
 * Source aliases may be legitimate Main hardlinks; persisted copies must be
 * independent wx files. Any failure preserves the partial directory and this
 * handle cannot retry over it. A fresh owned capture is required instead. */
export async function prepareCapsule2KnownAssetOriginals(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2KnownAssetOriginals> {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已准备或失败，不能重入/覆盖')
  used.add(original)
  await assertOwnedRawCapsuleScratchReady(original)
  const db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
  let observation: ReturnType<typeof readRawCapsule2AssetReferencesOwned>, schemaVersion: 26 | 27
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    observation = db.transaction(() => readRawCapsule2AssetReferencesOwned(db))()
    schemaVersion = db.pragma('user_version', { simple: true }) as 26 | 27
  } finally { db.close() }
  await assertOwnedRawCapsuleScratchContent(original)
  const capsuleId = basename(info.capsuleDirectory)
  if (!isSyncedUuid(capsuleId)) return bad('Main原件capsule定位无效')
  const base = join(info.recoveryDirectory, 'knowledge-asset-originals-v2'), output = join(base, capsuleId)
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true)
  const filesDirectory = join(output, 'files'); await restoreDirectory(filesDirectory, info.profileRoot, true)
  const assetsRoot = join(info.profileRoot, 'storage', 'assets')
  const readAlias = async (uri: string) => {
    // The shared byte reader validates below its root; this owning adapter
    // must also authenticate every ancestor back to the actual profile.
    await directory(assetsRoot, info.profileRoot)
    let aliasPath: string | undefined, localUri = uri
    if (/^file:/i.test(uri)) {
      if (uri.length > 8192) return bad('原file URI超过原附件长度边界')
      const parsed = new URL(uri)
      if (parsed.protocol !== 'file:' || parsed.hostname && parsed.hostname !== 'localhost') return bad('原file URI不是本地附件')
      aliasPath = resolve(fileURLToPath(parsed))
      // A native Windows 8.3 spelling is not a junction. Check every original
      // ancestor before realpath, then bind the physical file to this owner's
      // canonical assets root before the shared bounded byte reader opens it.
      await assertRestorePath(aliasPath)
      const physical = await realpath(aliasPath)
      await assertRestorePath(physical, assetsRoot)
      localUri = pathToFileURL(physical).href
    }
    const source = await readManagedAssetSource(assetsRoot, localUri)
    if (aliasPath) {
      await assertRestorePath(aliasPath)
      if (!samePath(await realpath(aliasPath), source.path)) return bad('原file URI在读取期间改变实际映射')
      await assertRestorePath(source.path, assetsRoot)
    }
    await directory(assetsRoot, info.profileRoot)
    return { ...source, uri }
  }
  const uris = [...new Set(observation.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(compare)
  const aliases: Alias[] = [], files = new Map<string, number>(); let total = 0, aliasBytes = 2, sourceBytes = 0
  for (const uri of uris) {
    // The source root comes only from the authenticated Main-owned SQL original.
    // Missing/foreign/unsupported references fail explicitly; never fake empty.
    if (aliases.length >= maxFiles) return bad('完整alias集合超过有限文件准备预算')
    const source = await readAlias(uri)
    sourceBytes += source.bytes.length
    if (sourceBytes > maxBytes) return bad('逐alias实际读取超过有限字节准备预算')
    const alias = { uri, relativePath: relative(assetsRoot, source.path).split(sep).join('/'), hash: source.hash, name: source.name, bytes: source.bytes.length }
    if (!files.has(source.hash)) {
      total += source.bytes.length
      if (files.size >= maxFiles || total > maxBytes) return bad('完整已知资产超过原V3文件/字节准备预算')
      await writeNew(join(filesDirectory, source.hash), source.bytes, info.profileRoot); files.set(source.hash, source.bytes.length)
    } else if (files.get(source.hash) !== source.bytes.length) return bad('同hash实际bytes长度不一致')
    aliasBytes += Buffer.byteLength(capsuleJson(alias)) + (aliases.length ? 1 : 0)
    if (aliasBytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整alias集合超准备预算，不截断')
    aliases.push(alias)
  }
  await syncRestoreDirectory(filesDirectory)
  // Recheck every original name independently, including same-hash aliases.
  for (const alias of aliases) {
    const source = await readAlias(alias.uri)
    if (source.hash !== alias.hash || source.bytes.length !== alias.bytes || source.name !== alias.name
      || relative(assetsRoot, source.path).split(sep).join('/') !== alias.relativePath) return bad('manifest前原alias映射变化')
  }
  await assertOwnedRawCapsuleOriginal(original)
  const manifest: Capsule2KnownAssetManifest = freezeCapsuleValue({ kind: 'capsule2-known-managed-asset-originals', version: 1,
    state: 'known-markdown-files-only', certified: false, semanticValidationComplete: false, permit: false, capsuleId, schemaVersion,
    sourceInventory: info.originalInventory, sourceContentHash: observation.sourceContentHash,
    workspaceHistoryObservationHash: observation.workspaceHistoryObservationHash, assetReferencesObservationHash: observation.observationHash,
    aliases, files: [...files].sort(([a], [b]) => compare(a, b)).map(([hash, bytes]) => ({ hash, bytes })) })
  const encoded = capsuleJson(manifest), manifestBytes = Buffer.from(encoded + '\n')
  if (manifestBytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整manifest超准备预算，不截断')
  await writeNew(join(output, 'manifest.json'), manifestBytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, root: info.profileRoot, directory: output, manifest, manifestBytes,
    manifestHash: capsuleBytesHash('knowbook.capsule2.known-managed-asset-originals.v1\0' + encoded) }
  await verify(saved)
  const handle: PreparedCapsule2KnownAssetOriginals = Object.freeze({ kind: 'prepared-capsule2-known-asset-originals' })
  prepared.set(handle, saved)
  return handle
}
/** Fresh complete original/artifact reads on every use. Survives deletion of
 * live managed source files; only saved independent copies supply these bytes.
 * Cross-process trusted-root reopen and complete policy/certifier/installer
 * are deliberately still required, not supplied by this prepared-data handle. */
export async function readPreparedCapsule2KnownAssetOriginals(handle: PreparedCapsule2KnownAssetOriginals): Promise<PreparedCapsule2KnownAssetInfo> {
  const value = prepared.get(handle)
  if (!value) return bad('不是实际Main准备的数据句柄')
  return verify(value)
}

/** Restart of prepared data only. The expected hash comes from the owning
 * root; it is not SQL certification, file provenance or an installation permit.
 * All Markdown holders are reread from fresh owned SQL, never from old scratch,
 * a caller list or live managed files which may already have disappeared. */
export async function reopenCapsule2KnownAssetOriginals(original: OwnedRawCapsuleOriginal, expectedManifestHash: string): Promise<PreparedCapsule2KnownAssetOriginals> {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已准备/重开或失败，不能重入')
  used.add(original)
  await assertOwnedRawCapsuleScratchReady(original)
  const capsuleId = basename(info.capsuleDirectory), output = join(info.recoveryDirectory, 'knowledge-asset-originals-v2', capsuleId)
  await directory(output, info.profileRoot)
  const text = await readCapsule2AssetManifest(join(output, 'manifest.json'), info.profileRoot)
  const manifest = parseCapsule2KnownAssetManifest(text, capsuleId, expectedManifestHash)
  const db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
    const observation = db.transaction(() => readRawCapsule2AssetReferencesOwned(db))()
    const uris = [...new Set(observation.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(compare)
    if (manifest.schemaVersion !== db.pragma('user_version', { simple: true })
      || capsuleJson(manifest.sourceInventory) !== capsuleJson(info.originalInventory)
      || manifest.sourceContentHash !== observation.sourceContentHash || manifest.workspaceHistoryObservationHash !== observation.workspaceHistoryObservationHash
      || manifest.assetReferencesObservationHash !== observation.observationHash || capsuleJson(manifest.aliases.map(alias => alias.uri)) !== capsuleJson(uris))
      return bad('持久known manifest不等于完整实际原SQL来源/全部引用')
  } finally { db.close() }
  await assertOwnedRawCapsuleScratchContent(original)
  const value: Saved = { original, root: info.profileRoot, directory: output, manifest, manifestBytes: Buffer.from(text), manifestHash: expectedManifestHash }
  await verify(value)
  const handle: PreparedCapsule2KnownAssetOriginals = Object.freeze({ kind: 'prepared-capsule2-known-asset-originals' })
  prepared.set(handle, value)
  return handle
}

// Filesystem data operations only. These do not mint an original, prepared
// handle, certificate or permit; each owning adapter authenticates its root.
export { directory as assertCapsule2AssetDirectory, writeNew as writeCapsule2AssetCopy, readExact as readCapsule2AssetCopy }
