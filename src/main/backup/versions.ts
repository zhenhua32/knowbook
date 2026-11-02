import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BackupVersion } from '../../shared/document-recovery'
import { extractMarkdownFrontmatter, KNOWBOOK_BACKUP_MARKER } from '../../shared/markdownFrontmatter'
import { parseStrictJson } from '../../shared/strictJson'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'

const metadataFile = '__knowbook/snapshot.json'
const versionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RECENT_COUNT = 10
const DAILY_DAYS = 30

export function writeSnapshotMetadata(root: string, documentCount: number, snapshotId: string = randomUUID()): void {
  mkdirSync(join(root, '__knowbook'), { recursive: true })
  writeFileSync(join(root, metadataFile), JSON.stringify({ id: snapshotId, createdAt: new Date().toISOString(), documentCount }), 'utf8')
}

function readVersion(root: string, id: string, current: boolean): BackupVersion {
  let createdAt = statSync(root).mtime.toISOString(), documentCount: number | null = null
  const v3 = readV3VersionHeader(root)
  if (v3) return { id: current ? v3.id : id, createdAt, documentCount: v3.documentCount, current, format: 'synced-v3', restorable: false }
  try {
    const metadata = JSON.parse(readFileSync(join(root, metadataFile), 'utf8'))
    if (current && typeof metadata.id === 'string' && versionIdPattern.test(metadata.id)) id = metadata.id
    if (typeof metadata.createdAt === 'string' && Number.isFinite(Date.parse(metadata.createdAt))) createdAt = metadata.createdAt
    if (Number.isInteger(metadata.documentCount) && metadata.documentCount >= 0) documentCount = metadata.documentCount
  } catch { /* Pre-versioning snapshots are still recoverable. */ }
  return { id, createdAt, documentCount, current }
}

/** Lightweight display classification only, never a restore/parse capability.
 * V3's closed index cannot accept the legacy snapshot.json sidecar. */
function readV3VersionHeader(root: string): { id: string; documentCount: number } | null {
  let declaredV3 = false
  try {
  const folders = [join(root, '__knowbook'), join(root, '__knowbook', 'databases')]
  const path = join(folders[1], 'index.md'), info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return null
  for (const folder of folders) { const entry = lstatSync(folder); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Backup index parent is not a managed directory') }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 5 * 1024 * 1024) throw new Error('Backup index is not a bounded independent file')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let source: string
  try {
    const first = fstatSync(fd)
    if (!first.isFile() || first.ino !== info.ino || !Number.isSafeInteger(first.size) || first.size < 0 || first.size > 5 * 1024 * 1024
      || first.size !== info.size || first.nlink !== 1) throw new Error('Backup index changed before reading')
    const bytes = Buffer.alloc(first.size)
    let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) throw new Error('Backup index became shorter'); offset += count }
    const after = fstatSync(fd), named = lstatSync(path)
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || after.ino !== first.ino || after.size !== first.size || after.mtimeMs !== first.mtimeMs || after.ctimeMs !== first.ctimeMs
      || named.isSymbolicLink() || named.ino !== after.ino || named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) throw new Error('Backup index changed during reading')
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } finally { closeSync(fd) }
  const header = extractMarkdownFrontmatter(source)
  if (!header) return null
  const version = header.raw.split(/\r?\n/).find(line => /^backupFormatVersion:/.test(line))
  if (!version) return null
  declaredV3 = parseStrictJson(version.slice(version.indexOf(':') + 1).trim(), { maxBytes: 64, maxDepth: 2 }) === '3'
  if (!declaredV3) return null // Preserve all existing V2/legacy metadata semantics.
  const fields: Record<string, string> = Object.create(null)
  for (const line of header.raw.split(/\r?\n/).slice(1, -1)) {
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)
    if (!match) return null
    const value = parseStrictJson(match[2], { maxBytes: 5 * 1024 * 1024, maxDepth: 32 })
    if (Object.hasOwn(fields, match[1]) || typeof value !== 'string') throw new Error('Backup index header fields differ')
    fields[match[1]] = value
  }
  if (fields.backupFormatVersion !== '3') return null
  if (fields.kind !== 'standalone-database-manifest' || !isSyncedUuid(fields.backupSnapshotId)
    || !header.body.startsWith(KNOWBOOK_BACKUP_MARKER) || header.body.slice(KNOWBOOK_BACKUP_MARKER.length).trim()) throw new Error('V3 backup version index is invalid')
  const documents = parseStrictJson(fields.documentIds ?? '', { maxBytes: 5 * 1024 * 1024, maxDepth: 32 })
  if (!Array.isArray(documents) || documents.some(value => typeof value !== 'string' || !value.trim()) || new Set(documents).size !== documents.length) throw new Error('V3 backup document declarations differ')
  return { id: fields.backupSnapshotId, documentCount: documents.length }
  } catch (error) {
    if (declaredV3) throw error
    return null // Legacy version listing never depended on a strict index parse.
  }
}

function safeDirectory(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  // A normal profile may have symlinked ancestors (e.g. /var on macOS).
  // Reject links at the managed snapshot boundary, not OS-owned ancestors.
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink())
}

export function listBackupVersions(backupRoot: string): BackupVersion[] {
  const historyRoot = `${backupRoot}-history`
  const versions: BackupVersion[] = []
  if (safeDirectory(backupRoot)) versions.push(readVersion(backupRoot, 'current', true))
  if (safeDirectory(historyRoot)) for (const entry of readdirSync(historyRoot, { withFileTypes: true })) {
    if (!versionIdPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const path = join(historyRoot, entry.name)
    if (safeDirectory(path)) versions.push(readVersion(path, entry.name, false))
  }
  return versions.sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

export function resolveBackupVersion(backupRoot: string, id: string): string {
  if (typeof id !== 'string' || (id !== 'current' && !versionIdPattern.test(id))) throw new Error('Invalid backup version')
  const version = listBackupVersions(backupRoot).find((version) => version.id === id)
  if (!version) throw new Error('Backup version no longer exists')
  return version.current ? backupRoot : join(`${backupRoot}-history`, id)
}

export function retainedBackupIds(versions: BackupVersion[], now = Date.now()): Set<string> {
  const ordered = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const retained = new Set(ordered.slice(0, RECENT_COUNT).map((version) => version.id))
  const days = new Set<string>()
  const earliest = now - DAILY_DAYS * 24 * 60 * 60 * 1000
  for (const version of ordered) {
    const time = Date.parse(version.createdAt), day = new Date(time).toISOString().slice(0, 10)
    if (time >= earliest && time <= now && !days.has(day)) { retained.add(version.id); days.add(day) }
  }
  return retained
}

/** Publish atomically, retaining the previous complete snapshot before pruning. */
export function publishBackupSnapshot(backupRoot: string, stagingRoot: string): void {
  const historyRoot = `${backupRoot}-history`
  mkdirSync(historyRoot, { recursive: true })
  if (!safeDirectory(historyRoot)) throw new Error('Backup history directory is not a managed directory')
  const hadPrevious = existsSync(backupRoot)
  const previousId = hadPrevious ? readVersion(backupRoot, 'current', true).id : 'current'
  const archiveId = versionIdPattern.test(previousId) && !existsSync(join(historyRoot, previousId)) ? previousId : randomUUID()
  const previousRoot = join(historyRoot, archiveId)
  if (hadPrevious) {
    if (!safeDirectory(backupRoot)) throw new Error('Backup directory is not a managed directory')
    renameSync(backupRoot, previousRoot)
  }
  try { renameSync(stagingRoot, backupRoot) }
  catch (error) {
    if (hadPrevious && !existsSync(backupRoot)) renameSync(previousRoot, backupRoot)
    throw error
  }
  // Cleanup failure must not invalidate an otherwise successful backup.
  try {
    const versions = listBackupVersions(backupRoot)
    const retained = retainedBackupIds(versions)
    for (const version of versions) if (!version.current && !retained.has(version.id)) {
      const path = resolveBackupVersion(backupRoot, version.id)
      rmSync(path, { recursive: true })
    }
  } catch (error) { console.warn('Backup published, but old backup versions could not be pruned.', error) }
}
