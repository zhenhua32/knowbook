import { lstatSync, realpathSync, type BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { readRestoreText, restoreDirectory, syncRestoreDirectory, writeRestoreJson } from '../database/restore-safety-files'
import { parseRestoreJson, restoreHash } from '../database/restore-safety-model'
import type { KnowbookStore } from '../database/store'
import { captureBackupV3PublicationFiles, readBackupV3RestorePublicationSource, type BackupV3RestoreSource } from './v3-reader'

const kind = 'knowbook-v3-publication-head'
const hashPattern = /^[0-9a-f]{64}$/
type Claim = ReturnType<KnowbookStore['readConfirmedCanonicalBackupPublication']>
type Edition = Claim & { snapshotId: string; catalogId: string; destination: string; treeHash: string }
type Parent = { archivedId: string; predecessor: Edition }
type Head = { kind: typeof kind; version: 1; profile: string; current: Edition; parent: Parent | null }
type Files = ReturnType<typeof captureBackupV3PublicationFiles>

function privateDirectory(profile: string): string {
  return join(profile, 'backups', '.knowbook-v3-publications')
}

function validateEdition(value: unknown, profile: string): Edition {
  assertSyncedShape(value, ['snapshotId', 'catalogId', 'destination', 'treeHash', 'archiveHash', 'workspaceScope', 'recoveryEpoch', 'claimHash'])
  const { snapshotId, catalogId, destination, treeHash, archiveHash, workspaceScope, recoveryEpoch, claimHash } = value
  if (!isSyncedUuid(snapshotId) || typeof catalogId !== 'string' || !catalogId.trim() || !isSyncedUuid(workspaceScope) || !isSyncedUuid(recoveryEpoch)
    || typeof destination !== 'string' || basename(destination) !== 'snapshot' || dirname(dirname(destination)) !== join(profile, 'backups')
    || !/^\.knowbook-synced-v3-[A-Za-z0-9]{6}$/.test(basename(dirname(destination)))
    || typeof treeHash !== 'string' || !hashPattern.test(treeHash) || typeof archiveHash !== 'string' || !hashPattern.test(archiveHash)
    || typeof claimHash !== 'string' || !hashPattern.test(claimHash)) throw new Error('Invalid V3 publication edition')
  return { snapshotId, catalogId, destination, treeHash, archiveHash, workspaceScope, recoveryEpoch, claimHash }
}

function successive(current: Edition, predecessor: Edition): boolean {
  return current.snapshotId !== predecessor.snapshotId && current.catalogId === predecessor.catalogId
    && current.workspaceScope === predecessor.workspaceScope && current.recoveryEpoch === predecessor.recoveryEpoch
}

function validateHead(value: unknown, profile: string): Head {
  assertSyncedShape(value, ['kind', 'version', 'profile', 'current', 'parent'])
  if (value.kind !== kind || value.version !== 1 || value.profile !== profile) throw new Error('Invalid V3 publication head')
  const current = validateEdition(value.current, profile)
  if (value.parent === null) return { kind, version: 1, profile, current, parent: null }
  assertSyncedShape(value.parent, ['archivedId', 'predecessor'])
  const predecessor = validateEdition(value.parent.predecessor, profile), archivedId = value.parent.archivedId
  if (!isSyncedUuid(archivedId) || !successive(current, predecessor)) throw new Error('Invalid V3 publication predecessor')
  return { kind, version: 1, profile, current, parent: { archivedId, predecessor } }
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino
}

async function captureHead(profile: string) {
  const directory = privateDirectory(profile), path = join(directory, 'head.json')
  const root = lstatSync(directory, { bigint: true })
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Invalid V3 publication directory')
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)) throw new Error('Invalid V3 publication head file')
  const assertCurrent = () => {
    const now = lstatSync(directory, { bigint: true }), file = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    if (!now.isDirectory() || now.isSymbolicLink() || !sameIdentity(root, now) || realpathSync(directory) !== directory
      || (before ? !file?.isFile() || file.isSymbolicLink() || file.nlink !== 1n || !sameIdentity(before, file)
        || before.size !== file.size || before.mtimeNs !== file.mtimeNs || before.ctimeNs !== file.ctimeNs : file !== undefined)) {
      throw new Error('V3 publication head changed')
    }
  }
  const data = before ? parseRestoreJson(await readRestoreText(path)) : null
  assertCurrent()
  return { path, head: before ? validateHead(data, profile) : null, assertCurrent }
}

function matches(edition: Edition, files: Files): boolean {
  return files.inventoryHash === edition.archiveHash && files.treeHash === edition.treeHash
}

function claimStillMatches(store: KnowbookStore, edition: Edition): boolean {
  const actual = store.readConfirmedCanonicalBackupPublication(edition.snapshotId, edition.destination)
  return actual.archiveHash === edition.archiveHash && actual.workspaceScope === edition.workspaceScope
    && actual.recoveryEpoch === edition.recoveryEpoch && actual.claimHash === edition.claimHash
}

function captureEdition(path: string, edition: Edition): Files {
  const files = captureBackupV3PublicationFiles(path)
  if (!matches(edition, files)) throw new Error('V3 publication archive was replaced')
  return files
}

/** Only the canonical profile export owns this record. The returned callback runs
 * after the real directory promotion while the export still holds its lease. */
export async function prepareBackupV3Publication(store: KnowbookStore, profile: string, backupRoot: string,
  manifest: { snapshotId: string; catalogId: string }, destination: string, claim: Claim, staging: Files) {
  if (backupRoot !== join(profile, 'backups', 'markdown')) return null
  const { snapshotId, catalogId } = manifest
  const current = validateEdition({ snapshotId, catalogId, destination, ...claim, treeHash: staging.treeHash }, profile)
  if (!matches(current, staging)) throw new Error('V3 staging files differ from the confirmed publication')
  const directory = privateDirectory(profile), history = `${backupRoot}-history`
  await restoreDirectory(directory, profile)
  const previous = await captureHead(profile)
  let candidate: { edition: Edition; files: Files } | null = null
  const prior = previous.head?.current
  if (prior && successive(current, prior)) {
    try {
      const priorFiles = captureEdition(backupRoot, prior)
      if (claimStillMatches(store, prior)) candidate = { edition: prior, files: priorFiles }
      priorFiles.assertCurrent()
    } catch { candidate = null } // Legacy rotations, incomplete promotions and replacements start a fresh chain.
  }

  return async (archivedId: string | null) => {
    const installed = staging.atRenamedRoot(backupRoot)
    let archived: Files | null = null
    let parent: Parent | null = null
    if (candidate && archivedId) {
      try {
        archived = candidate.files.atRenamedRoot(join(history, archivedId))
        parent = { archivedId, predecessor: candidate.edition }
      } catch { /* Retention or a concurrent replacement may have removed the original. */ }
    }
    const head: Head = { kind, version: 1, profile, current, parent }
    await syncRestoreDirectory(history)
    await syncRestoreDirectory(dirname(backupRoot))
    await writeRestoreJson(previous.path, head, profile, false, () => {
      if (!claimStillMatches(store, current) || parent && !claimStillMatches(store, parent.predecessor)) {
        throw new Error('V3 publication SQL claim changed')
      }
      installed.assertCurrent()
      archived?.assertCurrent()
      previous.assertCurrent()
    })
  }
}

/** Proves the last direct promotion from the original Main-owned files and SQL.
 * The edge carries publication identity only. Restore checks its own prior install. */
export async function readBackupV3PublishedPredecessor(store: KnowbookStore, selected: BackupV3RestoreSource) {
  const profile = store.getCanonicalBackupSource()?.userDataRoot
  if (!profile) return null
  const source = readBackupV3RestorePublicationSource(selected), backupRoot = join(profile, 'backups', 'markdown')
  if (source.root !== backupRoot) return null
  try {
    const record = await captureHead(profile), head = record.head
    if (!head?.parent || source.snapshotId !== head.current.snapshotId || source.catalogId !== head.current.catalogId
      || !matches(head.current, source)) return null
    const { current, parent: { archivedId, predecessor } } = head
    const archived = captureEdition(join(`${backupRoot}-history`, archivedId), predecessor)
    if (!claimStillMatches(store, current) || !claimStillMatches(store, predecessor)) return null
    source.assertCurrent()
    archived.assertCurrent()
    record.assertCurrent()
    return { current, predecessor, archivedId, headHash: restoreHash(head) }
  } catch { return null }
}
