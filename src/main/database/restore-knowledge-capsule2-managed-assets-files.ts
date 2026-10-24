import { lstat, opendir, readdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { readManagedAssetSource } from '../managed-asset-source'
import { assertRestorePath, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue, type DurableSqlCapsuleFile } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { assertOwnedRawCapsuleOriginal, readOwnedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { prepareCapsule2KnownAssetOriginals, readPreparedCapsule2KnownAssetOriginals,
  reopenCapsule2KnownAssetOriginals, readCapsule2AssetManifest,
  assertCapsule2AssetDirectory as directory, writeCapsule2AssetCopy as writeNew, readCapsule2AssetCopy as readExact,
  type Capsule2KnownAssetManifest, type PreparedCapsule2KnownAssetOriginals } from './restore-knowledge-capsule2-assets-files'
import { parseCapsule2ManagedAssetManifest } from './restore-knowledge-capsule2-assets-model'

const maxFiles = 5_000, maxBytes = 500 * 1024 * 1024, maxEntries = 20_000
const bad = (message: string): never => { throw new Error('capsule2管理附件原件无效：' + message + '；不改SQL/实时附件，不授认证或安装权，失败新目录保留。') }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
type Alias = { relativePath: string; hash: string; name: string; bytes: number }
type Layout = { rootPresent: boolean; directories: string[]; paths: string[] }
export interface Capsule2ManagedAssetManifest {
  readonly kind: 'capsule2-managed-asset-originals'; readonly version: 1; readonly state: 'all-managed-files-only'
  readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
  readonly capsuleId: string; readonly schemaVersion: 26 | 27; readonly sourceInventory: readonly DurableSqlCapsuleFile[]
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string; readonly assetReferencesObservationHash: string
  readonly knownAssetManifestHash: string; readonly knownAliases: Capsule2KnownAssetManifest['aliases']
  readonly rootPresent: boolean; readonly directories: readonly string[]; readonly aliases: readonly Alias[]
  readonly files: readonly { hash: string; bytes: number }[]
}
/** Main-private prepared data, including opaque-policy/unreferenced managed files.
 * Neither the complete file set nor a cloned manifest is certification authority. */
export interface PreparedCapsule2ManagedAssetOriginals { readonly kind: 'prepared-capsule2-managed-asset-originals' }
export interface PreparedCapsule2ManagedAssetInfo {
  readonly directory: string; readonly manifest: Capsule2ManagedAssetManifest; readonly manifestHash: string
}
type Saved = PreparedCapsule2ManagedAssetInfo & {
  original: OwnedRawCapsuleOriginal; known: PreparedCapsule2KnownAssetOriginals; root: string; manifestBytes: Buffer
}
const prepared = new WeakMap<PreparedCapsule2ManagedAssetOriginals, Saved>(), used = new WeakSet<OwnedRawCapsuleOriginal>()

/** Stream directory entries with an explicit complete-set budget, never a
 * recursive readdir materialization, substring search through opaque JSON,
 * caller path list or guessed filename. Empty directories are retained too. */
async function layout(root: string, profile: string): Promise<Layout> {
  await assertRestorePath(root, profile)
  const present = await lstat(root).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (!present) return { rootPresent: false, directories: [], paths: [] }
  const directories: string[] = [], paths: string[] = [], queue = ['']; let count = 1
  for (let index = 0; index < queue.length; index++) {
    const child = queue[index], path = join(root, child), parts = child ? child.split('/') : []
    await directory(path, profile); directories.push(child)
    for await (const entry of await opendir(path)) {
      if (++count > maxEntries) return bad('完整目录项超有限准备预算，不能截断')
      const next = child ? child + '/' + entry.name : entry.name
      if (entry.isSymbolicLink()) return bad('实时管理目录含symlink/junction')
      if (parts.length < 3) {
        const valid = parts.length === 0 ? entry.name === 'attachments'
          : parts.length === 1 ? /^[a-f0-9]{2}$/.test(entry.name)
            : /^[a-f0-9]{64}$/.test(entry.name) && entry.name.slice(0, 2) === parts[1]
        if (!valid || !entry.isDirectory()) return bad('实时管理目录存在未知布局或非目录项')
        queue.push(next)
      } else {
        if (!entry.isFile() || paths.length >= maxFiles) return bad('完整管理文件超预算或含非普通文件')
        await assertRestorePath(join(root, next), root); paths.push(next)
      }
    }
    await directory(path, profile)
  }
  return { rootPresent: true, directories: directories.sort(compare), paths: paths.sort(compare) }
}

async function verify(value: Saved): Promise<PreparedCapsule2ManagedAssetInfo> {
  await assertOwnedRawCapsuleOriginal(value.original)
  const known = await readPreparedCapsule2KnownAssetOriginals(value.known)
  if (known.manifestHash !== value.manifest.knownAssetManifestHash) return bad('实际已知原件身份变化')
  await directory(value.directory, value.root)
  if (capsuleJson((await readdir(value.directory)).sort(compare)) !== capsuleJson(['files', 'manifest.json'])) return bad('归档目录闭集变化')
  const files = join(value.directory, 'files'); await directory(files, value.root)
  if (capsuleJson((await readdir(files)).sort(compare)) !== capsuleJson(value.manifest.files.map(file => file.hash).sort(compare))) return bad('归档文件闭集变化')
  const bytes = await readExact(join(value.directory, 'manifest.json'), value.root, value.manifestBytes.length,
    capsuleBytesHash(value.manifestBytes), CAPSULE2_RAW_MAX_JSON_BYTES)
  if (!bytes.equals(value.manifestBytes)) return bad('完整manifest原字节变化')
  for (const file of value.manifest.files) await readExact(join(files, file.hash), value.root, file.bytes, file.hash, ATTACHMENT_MAX_FILE_BYTES)
  await readPreparedCapsule2KnownAssetOriginals(value.known)
  await assertOwnedRawCapsuleOriginal(value.original)
  return freezeCapsuleValue({ directory: value.directory, manifest: value.manifest, manifestHash: value.manifestHash })
}

/** All managed files under the actual Main root, including files held only by
 * opaque settings/plugin state and unreferenced imports. Known literal URIs
 * come from the existing actual SQL snapshot and remain unchanged. Never read
 * arbitrary policy paths, execute a plugin or infer grant/install authority.
 * Finite preparation budgets remain explicit, not a streaming1TiB certificate. */
export async function prepareCapsule2ManagedAssetOriginals(original: OwnedRawCapsuleOriginal): Promise<PreparedCapsule2ManagedAssetOriginals> {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已准备或失败，不能重入/覆盖')
  used.add(original)
  const known = await prepareCapsule2KnownAssetOriginals(original), knownInfo = await readPreparedCapsule2KnownAssetOriginals(known)
  const capsuleId = basename(info.capsuleDirectory), base = join(info.recoveryDirectory, 'knowledge-managed-assets-v2'), output = join(base, capsuleId)
  await restoreDirectory(base, info.profileRoot); await restoreDirectory(output, info.profileRoot, true)
  const filesDirectory = join(output, 'files'); await restoreDirectory(filesDirectory, info.profileRoot, true)
  const root = join(info.profileRoot, 'storage', 'assets'), initial = await layout(root, info.profileRoot)
  const aliases: Alias[] = [], files = new Map<string, number>(); let sourceBytes = 0, uniqueBytes = 0
  const read = async (path: string) => {
    await directory(root, info.profileRoot)
    await assertRestorePath(join(root, path), root)
    const result = await readManagedAssetSource(root, pathToFileURL(join(root, path)).href)
    await assertRestorePath(join(root, path), root); await directory(root, info.profileRoot)
    if (relative(root, result.path).split(sep).join('/') !== path) return bad('实际管理文件映射变化')
    return result
  }
  for (const path of initial.paths) {
    const source = await read(path)
    sourceBytes += source.bytes.length
    if (sourceBytes > maxBytes) return bad('完整alias字节集合超有限准备预算')
    aliases.push({ relativePath: path, hash: source.hash, name: source.name, bytes: source.bytes.length })
    if (!files.has(source.hash)) {
      uniqueBytes += source.bytes.length
      if (uniqueBytes > maxBytes) return bad('完整blob集合超有限准备预算')
      await writeNew(join(filesDirectory, source.hash), source.bytes, info.profileRoot); files.set(source.hash, source.bytes.length)
    } else if (files.get(source.hash) !== source.bytes.length) return bad('同hash实际长度不同')
  }
  const byPath = new Map(aliases.map(alias => [alias.relativePath, alias]))
  for (const alias of knownInfo.manifest.aliases) {
    const actual = byPath.get(alias.relativePath)
    if (!actual || actual.hash !== alias.hash || actual.name !== alias.name || actual.bytes !== alias.bytes) return bad('已知SQL alias不在完整管理原件内')
  }
  await syncRestoreDirectory(filesDirectory)
  for (const alias of aliases) {
    const source = await read(alias.relativePath)
    if (source.hash !== alias.hash || source.name !== alias.name || source.bytes.length !== alias.bytes) return bad('manifest前管理alias变化')
  }
  if (capsuleJson(await layout(root, info.profileRoot)) !== capsuleJson(initial)) return bad('完整实时目录闭集在读取期间变化')
  await readPreparedCapsule2KnownAssetOriginals(known)
  const parent = knownInfo.manifest
  const manifest: Capsule2ManagedAssetManifest = freezeCapsuleValue({ kind: 'capsule2-managed-asset-originals', version: 1, state: 'all-managed-files-only',
    certified: false, semanticValidationComplete: false, permit: false, capsuleId, schemaVersion: parent.schemaVersion, sourceInventory: parent.sourceInventory,
    sourceContentHash: parent.sourceContentHash, workspaceHistoryObservationHash: parent.workspaceHistoryObservationHash,
    assetReferencesObservationHash: parent.assetReferencesObservationHash, knownAssetManifestHash: knownInfo.manifestHash, knownAliases: parent.aliases,
    rootPresent: initial.rootPresent, directories: initial.directories, aliases,
    files: [...files].sort(([a], [b]) => compare(a, b)).map(([hash, bytes]) => ({ hash, bytes })) })
  const encoded = capsuleJson(manifest), manifestBytes = Buffer.from(encoded + '\n')
  if (manifestBytes.length > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整manifest超准备预算，不截断')
  await writeNew(join(output, 'manifest.json'), manifestBytes, info.profileRoot)
  await syncRestoreDirectory(output); await syncRestoreDirectory(base); await syncRestoreDirectory(info.recoveryDirectory)
  const saved: Saved = { original, known, root: info.profileRoot, directory: output, manifest, manifestBytes,
    manifestHash: capsuleBytesHash('knowbook.capsule2.managed-asset-originals.v1\0' + encoded) }
  await verify(saved)
  const handle: PreparedCapsule2ManagedAssetOriginals = Object.freeze({ kind: 'prepared-capsule2-managed-asset-originals' })
  prepared.set(handle, saved)
  return handle
}

/** The current private owner rereads the immutable original and both complete
 * saved artifacts; live sources may have disappeared. Trusted cross-process
 * reopening, nonmanaged files and complete certifier/installer remain required. */
export async function readPreparedCapsule2ManagedAssetOriginals(handle: PreparedCapsule2ManagedAssetOriginals): Promise<PreparedCapsule2ManagedAssetInfo> {
  const value = prepared.get(handle)
  if (!value) return bad('不是实际Main准备的管理文件句柄')
  return verify(value)
}

/** Hash-pinned prepared data restart, not an accepted Root/certificate. A real
 * owning root supplies the commitment. Rebuild both private registries only
 * after actual original SQL and all independent archived blobs are reread. */
export async function reopenCapsule2ManagedAssetOriginals(original: OwnedRawCapsuleOriginal, expectedManifestHash: string): Promise<PreparedCapsule2ManagedAssetOriginals> {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return bad('同一原件已准备/重开或失败，不能重入')
  used.add(original)
  const capsuleId = basename(info.capsuleDirectory), output = join(info.recoveryDirectory, 'knowledge-managed-assets-v2', capsuleId)
  await directory(output, info.profileRoot)
  const text = await readCapsule2AssetManifest(join(output, 'manifest.json'), info.profileRoot)
  const manifest = parseCapsule2ManagedAssetManifest(text, capsuleId, expectedManifestHash)
  const known = await reopenCapsule2KnownAssetOriginals(original, manifest.knownAssetManifestHash)
  const parent = await readPreparedCapsule2KnownAssetOriginals(known)
  if (capsuleJson(manifest.sourceInventory) !== capsuleJson(parent.manifest.sourceInventory)
    || manifest.schemaVersion !== parent.manifest.schemaVersion || manifest.sourceContentHash !== parent.manifest.sourceContentHash
    || manifest.workspaceHistoryObservationHash !== parent.manifest.workspaceHistoryObservationHash
    || manifest.assetReferencesObservationHash !== parent.manifest.assetReferencesObservationHash
    || capsuleJson(manifest.knownAliases) !== capsuleJson(parent.manifest.aliases)) return bad('完整管理manifest不等于重验后的known实际来源')
  const value: Saved = { original, known, root: info.profileRoot, directory: output, manifest, manifestBytes: Buffer.from(text), manifestHash: expectedManifestHash }
  await verify(value)
  const handle: PreparedCapsule2ManagedAssetOriginals = Object.freeze({ kind: 'prepared-capsule2-managed-asset-originals' })
  prepared.set(handle, value)
  return handle
}
