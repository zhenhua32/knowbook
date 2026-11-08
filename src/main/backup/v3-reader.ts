import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { backupV3FileDigest, isBackupV3AssetPath, parseCapturedBackupV3Files, parseCapturedBackupV3Inventory,
  type BackupV3File, type BackupV3FileDigest } from './v3-format'

// JSON group files share the existing Markdown content count and byte budgets.
const limits = { entries: 20_000, depth: 32, contentFiles: 5_000,
  contentFileBytes: 5 * 1024 * 1024, contentBytes: 100 * 1024 * 1024,
  assetFiles: 5_000, assetFileBytes: 50 * 1024 * 1024, assetBytes: 500 * 1024 * 1024 }

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
function samePathFile(path: BigIntStats, fd: BigIntStats): boolean {
  const device = path.dev === fd.dev || process.platform === 'win32' && (path.dev === 0n || path.dev === BigInt.asUintN(32, fd.dev))
  return independentFile(path) && independentFile(fd) && fd.dev !== 0n && device && path.ino === fd.ino
    && path.size === fd.size && path.mtimeNs === fd.mtimeNs && path.ctimeNs === fd.ctimeNs
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

/** Bounded read-only capture shared by byte inspection and streamed digests. */
function captureArchiveFiles<File>(root: string, capture: (fd: number, size: number, relativePath: string) => File): File[] {
  if (typeof root !== 'string' || !isAbsolute(root)) invalid('an absolute archive directory is required')
  root = resolve(root)
  safeAncestors(root)
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) invalid('archive root is not a real directory')
  const files: File[] = []
  const capturedFiles: Array<{ path: string; stat: BigIntStats }> = []
  const directories: Array<{ path: string; stat: BigIntStats; names: string[] }> = []
  let entries = 0, contentFiles = 0, contentBytes = 0, assetFiles = 0, assetBytes = 0
  function walk(directory: string, prefix: string, depth: number): void {
    if (depth > limits.depth) invalid('directory depth exceeds the existing limit')
    const directoryStat = lstatSync(directory, { bigint: true })
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.ino === 0n) invalid('archive directory identity is unavailable')
    const names = readdirSync(directory).sort()
    directories.push({ path: directory, stat: directoryStat, names })
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
        capturedFiles.push({ path, stat: exact })
      } finally { closeSync(fd) }
    }
  }
  walk(root, '', 0)
  // A stable fd alone cannot certify the path or the whole directory capture:
  // earlier files and already-enumerated directories may change while later
  // files are read. Recheck every captured identity without rereading payloads.
  for (const directory of directories) {
    safeAncestors(directory.path)
    if (!sameDirectory(directory.stat, lstatSync(directory.path, { bigint: true }))
      || realpathSync(directory.path) !== directory.path
      || JSON.stringify(readdirSync(directory.path).sort()) !== JSON.stringify(directory.names)) invalid('archive directory inventory changed during capture')
  }
  for (const file of capturedFiles) {
    safeAncestors(file.path)
    if (!samePathFile(lstatSync(file.path, { bigint: true }), file.stat)) invalid('archive file identity changed before returning the complete closure')
  }
  return files
}

export function readBackupV3Files(root: string): BackupV3File[] {
  return captureArchiveFiles(root, readFileBytes)
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

/** Reauthenticate a confirmed archive without retaining its payloads in memory. */
export function readBackupV3FileDigests(root: string): BackupV3FileDigest[] {
  const buffer = allocateDigestBuffer()
  return captureArchiveFiles(root, (fd, size, relativePath) => readFileDigest(fd, size, relativePath, buffer))
}

/** Whole-archive verification for publication, without materializing asset payloads. */
export function verifyBackupV3Archive(root: string) {
  const buffer = allocateDigestBuffer(), contents: BackupV3File[] = [], assets: BackupV3FileDigest[] = []
  const entries = captureArchiveFiles<BackupV3File | BackupV3FileDigest>(root, (fd, size, path) =>
    isBackupV3AssetPath(path) ? readFileDigest(fd, size, path, buffer) : readFileBytes(fd, size, path))
  for (const entry of entries) {
    if ('hash' in entry) assets.push(entry)
    else contents.push(entry)
  }
  const archive = parseCapturedBackupV3Inventory(contents, assets)
  return { manifest: archive.manifest, files: [...contents.map(backupV3FileDigest), ...assets] }
}

/** Strict read-only inspection. It never opens a database or stages assets. */
export function readBackupV3Archive(root: string): ReturnType<typeof parseCapturedBackupV3Files> {
  return parseCapturedBackupV3Files(readBackupV3Files(root))
}
