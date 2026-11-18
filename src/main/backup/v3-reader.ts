import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { BACKUP_V3_MAX_ASSET_BYTES, backupV3FileDigest, backupV3InventoryHash, isBackupV3AssetPath, parseCapturedBackupV3Files, parseCapturedBackupV3Inventory,
  type BackupV3File, type BackupV3FileDigest } from './v3-format'

// JSON group files share the existing Markdown content count and byte budgets.
const limits = { entries: 20_000, depth: 32, contentFiles: 5_000,
  contentFileBytes: 5 * 1024 * 1024, contentBytes: 100 * 1024 * 1024,
  assetFiles: 5_000, assetFileBytes: BACKUP_V3_MAX_ASSET_BYTES, assetBytes: 500 * 1024 * 1024 }

function invalid(message: string): never { throw new Error(`Invalid V3 backup: ${message}`) }
function safeAncestors(path: string): void {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) invalid('archive path contains a symbolic link')
  }
}
function independentFile(info: BigIntStats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.ino !== 0n
}
function samePathFileIdentity(path: BigIntStats, fd: BigIntStats): boolean {
  const device = path.dev === fd.dev || process.platform === 'win32' && (path.dev === 0n || path.dev === BigInt.asUintN(32, fd.dev))
  return independentFile(path) && independentFile(fd) && fd.dev !== 0n && device && path.ino === fd.ino
}
function samePathFile(path: BigIntStats, fd: BigIntStats): boolean {
  return samePathFileIdentity(path, fd) && path.size === fd.size && path.mtimeNs === fd.mtimeNs && path.ctimeNs === fd.ctimeNs
}
function sameDirectory(before: BigIntStats, after: BigIntStats): boolean {
  return before.isDirectory() && after.isDirectory() && !before.isSymbolicLink() && !after.isSymbolicLink()
    && before.ino !== 0n && before.dev === after.dev && before.ino === after.ino
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

function readArchiveChunk(fd: number, buffer: Uint8Array, offset: number, size: number): number {
  const count = readSync(fd, buffer, offset, size, null)
  if (!count) invalid('archive file became shorter while reading')
  return count
}

type CapturedFile = { path: string; stat: BigIntStats }
type CapturedDirectory = CapturedFile & { names: string[] }
type ArchiveOriginals = { root: string; originals: Map<string, CapturedFile>; directories: Map<string, CapturedDirectory> }
type ArchiveCapture<File> = ArchiveOriginals & { files: File[] }

function assertOriginalDirectory(directory: CapturedDirectory): void {
  safeAncestors(directory.path)
  if (!sameDirectory(directory.stat, lstatSync(directory.path, { bigint: true }))
    || realpathSync(directory.path) !== directory.path
    || JSON.stringify(readdirSync(directory.path).sort()) !== JSON.stringify(directory.names)) invalid('archive directory inventory changed during capture')
}

function assertArchiveOriginalPaths({ directories, originals }: ArchiveOriginals): void {
  for (const directory of directories.values()) assertOriginalDirectory(directory)
  for (const file of originals.values()) {
    safeAncestors(file.path)
    if (!samePathFile(lstatSync(file.path, { bigint: true }), file.stat)) invalid('archive file identity changed before returning the complete closure')
  }
}

/** Bounded read-only capture shared by byte inspection and streamed digests. */
function captureArchiveFiles<File>(root: string, capture: (fd: number, size: number, relativePath: string) => File): ArchiveCapture<File> {
  if (typeof root !== 'string' || !isAbsolute(root)) invalid('an absolute archive directory is required')
  root = resolve(root)
  safeAncestors(root)
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) invalid('archive root is not a real directory')
  const files: File[] = []
  const originals = new Map<string, CapturedFile>(), directories = new Map<string, CapturedDirectory>()
  let entries = 0, contentFiles = 0, contentBytes = 0, assetFiles = 0, assetBytes = 0
  function walk(directory: string, prefix: string, depth: number): void {
    if (depth > limits.depth) invalid('directory depth exceeds the existing limit')
    const directoryStat = lstatSync(directory, { bigint: true })
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.ino === 0n) invalid('archive directory identity is unavailable')
    const names = readdirSync(directory).sort()
    directories.set(directory, { path: directory, stat: directoryStat, names })
    for (const name of names) {
      if (++entries > limits.entries) invalid('entry count exceeds the existing limit')
      if (!name || name === '.' || name === '..' || /[\\\x00-\x1f\x7f]/.test(name)) invalid('unsafe archive filename')
      const path = join(directory, name), relativePath = prefix + name
      safeAncestors(path)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) invalid('archive contains a symbolic link')
      if (info.isDirectory()) { walk(path, relativePath + '/', depth + 1); continue }
      if (!info.isFile()) invalid('archive contains a non-regular file')
      const original = lstatSync(path, { bigint: true })
      if (info.nlink !== 1 || !independentFile(original)) invalid('archive file is not an independent standalone file (hardlink)')
      if (!Number.isSafeInteger(info.size) || info.size < 0) invalid('invalid archive file size')
      const asset = isBackupV3AssetPath(relativePath)
      if (asset) {
        if (++assetFiles > limits.assetFiles || info.size > limits.assetFileBytes
          || (assetBytes += info.size) > limits.assetBytes) invalid('asset budget exceeds the existing limit')
      } else if (++contentFiles > limits.contentFiles || info.size > limits.contentFileBytes
        || (contentBytes += info.size) > limits.contentBytes) invalid('content budget exceeds the existing limit')
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const before = fstatSync(fd)
        // Windows path stat may omit the device number (0), while fd stat
        // reports it. Keep every supplied identity field and the fd checks.
        const deviceChanged = !(process.platform === 'win32' && info.dev === 0) && before.dev !== info.dev
        if (!before.isFile() || before.nlink !== 1 || deviceChanged || before.ino !== info.ino || before.size !== info.size) invalid('archive file changed during capture')
        const file = capture(fd, before.size, relativePath)
        const excess = readSync(fd, Buffer.alloc(1), 0, 1, null), after = fstatSync(fd)
        if (excess !== 0 || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs) invalid('archive file changed while reading')
        const exact = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true })
        safeAncestors(path)
        if (!samePathFile(original, exact) || !samePathFile(current, exact)) invalid('archive file identity changed while reading')
        files.push(file)
        originals.set(relativePath, { path, stat: exact })
      } finally { closeSync(fd) }
    }
  }
  walk(root, '', 0)
  // A stable fd alone cannot certify the path or the whole directory capture:
  // earlier files and already-enumerated directories may change while later
  // files are read. Recheck every captured identity without rereading payloads.
  const captured = { root, files, originals, directories }
  assertArchiveOriginalPaths(captured)
  return captured
}

export function readBackupV3Files(root: string): BackupV3File[] {
  return captureArchiveFiles(root, readFileBytes).files
}

function readFileBytes(fd: number, size: number, relativePath: string): BackupV3File {
  const bytes = new Uint8Array(size)
  for (let offset = 0; offset < size;) offset += readArchiveChunk(fd, bytes, offset, size - offset)
  return { relativePath, bytes }
}

function readFileDigest(fd: number, size: number, relativePath: string, buffer: Uint8Array): BackupV3FileDigest {
  const digest = createHash('sha256')
  for (let remaining = size; remaining > 0;) {
    const count = readArchiveChunk(fd, buffer, 0, Math.min(remaining, buffer.length))
    digest.update(buffer.subarray(0, count))
    remaining -= count
  }
  return { relativePath, hash: digest.digest('hex'), bytes: size }
}

const allocateDigestBuffer = () => new Uint8Array(1024 * 1024)

function captureArchiveDigests(root: string): ArchiveCapture<BackupV3FileDigest> {
  const buffer = allocateDigestBuffer()
  return captureArchiveFiles(root, (fd, size, relativePath) => readFileDigest(fd, size, relativePath, buffer))
}

/** Reauthenticate a confirmed archive without retaining its payloads in memory. */
export function readBackupV3FileDigests(root: string): BackupV3FileDigest[] {
  return captureArchiveDigests(root).files
}

interface PublicationFiles {
  readonly inventoryHash: string
  readonly treeHash: string
  assertCurrent(): void
  atRenamedRoot(path: string): PublicationFiles
}

function movedArchiveOriginals(original: ArchiveOriginals, root: string): ArchiveOriginals {
  if (!isAbsolute(root)) invalid('an absolute archive directory is required')
  const before = original.directories.get(original.root)!.stat, moved = lstatSync(root, { bigint: true })
  // Renaming may change the root directory timestamps. All descendants still
  // have to match the identities, timestamps and directory entries we read.
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== before.dev || moved.ino !== before.ino) {
    invalid('renamed archive root does not match the captured directory')
  }
  const directories = new Map<string, CapturedDirectory>()
  for (const directory of original.directories.values()) {
    const path = join(root, relative(original.root, directory.path))
    directories.set(path, { ...directory, path, stat: path === root ? moved : directory.stat })
  }
  const originals = new Map<string, CapturedFile>()
  for (const [name, file] of original.originals) {
    originals.set(name, { path: join(root, relative(original.root, file.path)), stat: file.stat })
  }
  const capture = { root, directories, originals }
  assertArchiveOriginalPaths(capture)
  return capture
}

function publicationFiles(capture: ArchiveOriginals, inventoryHash: string): PublicationFiles {
  const { root, originals, directories } = capture
  const hash = createHash('sha256').update('knowbook.backup-v3.publication-tree.v1\0')
  for (const directory of directories.values()) {
    const name = relative(root, directory.path).split(sep).join('/')
    hash.update(JSON.stringify(['directory', name, directory.stat.dev.toString(), directory.stat.ino.toString()]) + '\n')
  }
  for (const [name, { stat }] of originals) {
    hash.update(JSON.stringify(['file', name, stat.dev.toString(), stat.ino.toString()]) + '\n')
  }
  const treeHash = hash.digest('hex')
  return Object.freeze({ inventoryHash, treeHash, assertCurrent: () => assertArchiveOriginalPaths(capture),
    atRenamedRoot: (path: string) => publicationFiles(movedArchiveOriginals(capture, path), inventoryHash) })
}

/** Bind streamed file bytes and the captured physical archive tree for publication. */
export function captureBackupV3PublicationFiles(root: string) {
  const captured = captureArchiveDigests(root)
  return publicationFiles(captured, backupV3InventoryHash(captured.files))
}

function captureVerifiedArchive(root: string) {
  const buffer = allocateDigestBuffer(), contents: BackupV3File[] = [], assets: BackupV3FileDigest[] = []
  const capture = captureArchiveFiles<BackupV3File | BackupV3FileDigest>(root, (fd, size, path) =>
    isBackupV3AssetPath(path) ? readFileDigest(fd, size, path, buffer) : readFileBytes(fd, size, path))
  for (const entry of capture.files) {
    if ('hash' in entry) assets.push(entry)
    else contents.push(entry)
  }
  const archive = parseCapturedBackupV3Inventory(contents, assets)
  return { root: capture.root, originals: capture.originals, directories: capture.directories,
    archive, files: [...contents.map(backupV3FileDigest), ...assets], assets }
}

/** Whole-archive verification for publication, without materializing asset payloads. */
export function verifyBackupV3Archive(root: string) {
  const { archive, files } = captureVerifiedArchive(root)
  return { manifest: archive.manifest, files }
}

/** Parse the archive and obtain its publication witness from one capture. */
export function verifyBackupV3ArchiveForPublication(root: string) {
  const captured = captureVerifiedArchive(root)
  return { manifest: captured.archive.manifest, files: captured.files,
    ...publicationFiles(captured, backupV3InventoryHash(captured.files)) }
}

/** Strict read-only inspection. It never opens a database or stages assets. */
export function readBackupV3Archive(root: string): ReturnType<typeof parseCapturedBackupV3Files> {
  return parseCapturedBackupV3Files(readBackupV3Files(root))
}

export interface BackupV3RestoreSource { readonly kind: 'verified-v3-restore-source' }
type RestoreSource = ReturnType<typeof captureVerifiedArchive> & { inventoryHash: string; digestByPath: Map<string, BackupV3FileDigest> }
const restoreSources = new WeakMap<BackupV3RestoreSource, RestoreSource>()

/** Pin the archive parsed during this capture and the physical identity of each
 * original. No descriptors or asset payloads are retained across calls. */
export function openBackupV3RestoreSource(root: string): BackupV3RestoreSource {
  const capture = captureVerifiedArchive(root), owner = Object.freeze({ kind: 'verified-v3-restore-source' as const })
  restoreSources.set(owner, { ...capture, inventoryHash: backupV3InventoryHash(capture.files),
    digestByPath: new Map(capture.files.map(file => [file.relativePath, file])) })
  return owner
}

function restoreSource(owner: BackupV3RestoreSource): RestoreSource {
  return restoreSources.get(owner) ?? invalid('an actual verified V3 restore source is required')
}

/** The caller can plan from these values but cannot mutate the captured source. */
export function readBackupV3RestoreSource(owner: BackupV3RestoreSource) {
  const { root, archive, files, assets, inventoryHash } = restoreSource(owner)
  return structuredClone({ root, archive, files, assets, inventoryHash })
}

export function readBackupV3RestoreIndex(owner: BackupV3RestoreSource) {
  const { archive, inventoryHash } = restoreSource(owner)
  return { manifest: structuredClone(archive.manifest), inventoryHash }
}

export function readBackupV3RestoreAssets(owner: BackupV3RestoreSource) {
  const { assets, inventoryHash } = restoreSource(owner)
  return { assets: structuredClone(assets), inventoryHash }
}

/** Reuse the owner's actual sealed capture for publication identity and path checks. */
export function readBackupV3RestorePublicationSource(owner: BackupV3RestoreSource) {
  const original = restoreSource(owner), { snapshotId, catalogId, previousPublication } = original.archive.manifest
  return Object.freeze({ root: original.root, snapshotId, catalogId,
    previousPublication: previousPublication ? Object.freeze({ ...previousPublication }) : null,
    ...publicationFiles(original, original.inventoryHash) })
}

/** Recheck this owner's entire inventory and physical originals before using a
 * preview for installation, even when replacement files contain equal bytes. */
export function assertBackupV3RestoreSourceCurrent(owner: BackupV3RestoreSource): void {
  const original = restoreSource(owner), current = captureArchiveDigests(original.root)
  if (backupV3InventoryHash(current.files) !== original.inventoryHash || current.directories.size !== original.directories.size
    || [...original.directories].some(([path, directory]) => {
      const actual = current.directories.get(path)
      return !actual || !sameDirectory(directory.stat, actual.stat) || JSON.stringify(directory.names) !== JSON.stringify(actual.names)
    }) || [...original.originals].some(([path, file]) => {
      const actual = current.originals.get(path)
      return !actual || !samePathFile(file.stat, actual.stat)
    })) invalid('original V3 restore archive changed')
}

function assertOriginalFilePath(original: RestoreSource, file: CapturedFile): void {
  for (let path = dirname(file.path); ; path = dirname(path)) {
    const directory = original.directories.get(path)
    if (!directory) invalid('file is outside its captured archive')
    assertOriginalDirectory(directory)
    if (path === original.root) break
  }
  safeAncestors(file.path)
  if (!samePathFile(lstatSync(file.path, { bigint: true }), file.stat)) invalid('original V3 asset changed or content file changed')
}

/** Copy a verified asset into an existing private staging directory owned by
 * the caller. Never overwrite an alias or remove a replacement on failure. */
export async function copyBackupV3RestoreAsset(owner: BackupV3RestoreSource, relativePath: string, destination: string) {
  if (!isBackupV3AssetPath(relativePath)) return invalid('asset is not in the verified V3 restore inventory')
  return copyBackupV3RestoreOriginal(owner, relativePath, destination)
}

export async function copyBackupV3RestoreContent(owner: BackupV3RestoreSource, relativePath: string, destination: string) {
  if (isBackupV3AssetPath(relativePath)) return invalid('file is not in the verified V3 content inventory')
  return copyBackupV3RestoreOriginal(owner, relativePath, destination)
}

async function copyBackupV3RestoreOriginal(owner: BackupV3RestoreSource, relativePath: string, destination: string) {
  const original = restoreSource(owner), asset = original.digestByPath.get(relativePath), file = original.originals.get(relativePath)
  if (!asset || !file) return invalid('file is not in the verified V3 restore inventory')
  const stage = dirname(destination), fromArchive = relative(original.root, destination)
  if (!isAbsolute(destination) || resolve(destination) !== destination
    || fromArchive !== '..' && !fromArchive.startsWith('..' + sep) && !isAbsolute(fromArchive)) return invalid('V3 asset destination is not outside the source archive')
  safeAncestors(stage)
  const parent = lstatSync(stage, { bigint: true })
  const assertStage = () => {
    safeAncestors(stage)
    const current = lstatSync(stage, { bigint: true })
    if (!current.isDirectory() || current.ino === 0n || current.ino !== parent.ino || current.dev !== parent.dev || realpathSync(stage) !== stage)
      return invalid('V3 asset staging directory changed')
  }
  assertStage()
  assertOriginalFilePath(original, file)
  const source = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let created: BigIntStats | undefined
  try {
    if (!samePathFile(file.stat, await source.stat({ bigint: true }))) return invalid('original V3 asset changed before copy')
    assertStage()
    const target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      created = await target.stat({ bigint: true })
      if (!independentFile(created) || !created.dev || !samePathFileIdentity(await lstat(destination, { bigint: true }), created))
        return invalid('V3 asset staging output is not the created file')
      const buffer = allocateDigestBuffer(), digest = createHash('sha256')
      let offset = 0
      while (offset < asset.bytes) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, asset.bytes - offset), offset)
        if (!bytesRead) return invalid('original V3 asset ended early')
        digest.update(buffer.subarray(0, bytesRead))
        let written = 0
        while (written < bytesRead) {
          const { bytesWritten } = await target.write(buffer, written, bytesRead - written, offset + written)
          if (!bytesWritten) return invalid('V3 asset staging write did not advance')
          written += bytesWritten
        }
        offset += bytesRead
      }
      if ((await source.read(buffer, 0, 1, offset)).bytesRead || digest.digest('hex') !== asset.hash
        || !samePathFile(file.stat, await source.stat({ bigint: true }))) return invalid('original V3 asset bytes changed during copy')
      await target.sync()
      const staged = await target.stat({ bigint: true })
      if (created.dev !== staged.dev || created.ino !== staged.ino || staged.size !== BigInt(asset.bytes)
        || !samePathFile(await lstat(destination, { bigint: true }), staged)) return invalid('V3 asset staging output changed')
      assertStage()
      assertOriginalFilePath(original, file)
      return Object.freeze({ dev: staged.dev, ino: staged.ino })
    } finally { await target.close() }
  } catch (error) {
    if (created) {
      try {
        assertStage()
        const present = await lstat(destination, { bigint: true }).catch(cause => {
          if (cause?.code === 'ENOENT') return null
          throw cause
        })
        if (present && samePathFileIdentity(present, created)) await unlink(destination)
      } catch (cleanup) { throw new AggregateError([error, cleanup], 'V3 asset copy and private cleanup failed') }
    }
    throw error
  } finally { await source.close() }
}
