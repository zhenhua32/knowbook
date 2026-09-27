import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BackupVersion } from '../../shared/document-recovery'

const metadataFile = '__knowbook/snapshot.json'
const versionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RECENT_COUNT = 10
const DAILY_DAYS = 30

export function writeSnapshotMetadata(root: string, documentCount: number): void {
  mkdirSync(join(root, '__knowbook'), { recursive: true })
  writeFileSync(join(root, metadataFile), JSON.stringify({ id: randomUUID(), createdAt: new Date().toISOString(), documentCount }), 'utf8')
}

function readVersion(root: string, id: string, current: boolean): BackupVersion {
  let createdAt = statSync(root).mtime.toISOString(), documentCount: number | null = null
  try {
    const metadata = JSON.parse(readFileSync(join(root, metadataFile), 'utf8'))
    if (current && typeof metadata.id === 'string' && versionIdPattern.test(metadata.id)) id = metadata.id
    if (typeof metadata.createdAt === 'string' && Number.isFinite(Date.parse(metadata.createdAt))) createdAt = metadata.createdAt
    if (Number.isInteger(metadata.documentCount) && metadata.documentCount >= 0) documentCount = metadata.documentCount
  } catch { /* Pre-versioning snapshots are still recoverable. */ }
  return { id, createdAt, documentCount, current }
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
