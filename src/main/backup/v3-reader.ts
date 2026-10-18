import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { parseBackupV3Files, type BackupV3File } from './v3-format'

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

/** Bounded read-only file capture shared by producer verification and inspection. */
export function readBackupV3Files(root: string): BackupV3File[] {
  if (typeof root !== 'string' || !isAbsolute(root)) invalid('an absolute archive directory is required')
  root = resolve(root)
  safeAncestors(root)
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) invalid('archive root is not a real directory')
  const files: BackupV3File[] = []
  let entries = 0, contentFiles = 0, contentBytes = 0, assetFiles = 0, assetBytes = 0
  function walk(directory: string, prefix: string, depth: number): void {
    if (depth > limits.depth) invalid('directory depth exceeds the existing limit')
    const names = readdirSync(directory).sort()
    for (const name of names) {
      if (++entries > limits.entries) invalid('entry count exceeds the existing limit')
      if (!name || name === '.' || name === '..' || /[\\\x00-\x1f\x7f]/.test(name)) invalid('unsafe archive filename')
      const path = join(directory, name), relativePath = prefix + name
      safeAncestors(path)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) invalid('archive contains a symbolic link')
      if (info.isDirectory()) { walk(path, relativePath + '/', depth + 1); continue }
      if (!info.isFile()) invalid('archive contains a non-regular file')
      if (!Number.isSafeInteger(info.size) || info.size < 0) invalid('invalid archive file size')
      const asset = relativePath.startsWith('__knowbook/assets/')
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
        if (!before.isFile() || deviceChanged || before.ino !== info.ino || before.size !== info.size) invalid('archive file changed during capture')
        const bytes = Buffer.alloc(before.size)
        let offset = 0
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, null)
          if (!count) invalid('archive file became shorter while reading')
          offset += count
        }
        const excess = readSync(fd, Buffer.alloc(1), 0, 1, null), after = fstatSync(fd)
        if (excess !== 0 || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs) invalid('archive file changed while reading')
        files.push({ relativePath, bytes })
      } finally { closeSync(fd) }
    }
  }
  walk(root, '', 0)
  return files
}

/** Strict read-only inspection. It never opens a database or stages assets. */
export function readBackupV3Archive(root: string): ReturnType<typeof parseBackupV3Files> {
  return parseBackupV3Files(readBackupV3Files(root))
}
