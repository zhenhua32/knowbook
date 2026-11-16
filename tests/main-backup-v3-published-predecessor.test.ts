import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, lstatSync, mkdirSync, realpathSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { MarkdownBackupService, writeBackupSnapshot, type BackupV3DatabaseExportJob } from '../src/main/backup/exporter'
import { readBackupV3PublishedPredecessor } from '../src/main/backup/v3-publication-lineage'
import { openBackupV3RestoreSource, readBackupV3RestoreSource } from '../src/main/backup/v3-reader'
import { KnowbookStore } from '../src/main/database/store'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { fileInventory, withV3Fixture } from './helpers/synced-backup-v3-fixture'

type Edge = Awaited<ReturnType<typeof readBackupV3PublishedPredecessor>>

function physicalIdentity(path: string) {
  const entry = lstatSync(path, { bigint: true })
  assert.ok((entry.isFile() || entry.isDirectory()) && !entry.isSymbolicLink() && entry.ino)
  return { dev: String(entry.dev), ino: String(entry.ino) }
}

async function readCold(database: string, backupRoot: string): Promise<Edge> {
  const script = `
    import { readBackupV3PublishedPredecessor } from './src/main/backup/v3-publication-lineage.ts'
    import { openBackupV3RestoreSource } from './src/main/backup/v3-reader.ts'
    import { KnowbookStore } from './src/main/database/store.ts'
    const [database, backupRoot] = process.argv.slice(1)
    const store = KnowbookStore.openCanonicalRuntime(database)
    try {
      const edge = await readBackupV3PublishedPredecessor(store, openBackupV3RestoreSource(backupRoot))
      process.stdout.write(JSON.stringify({ pid: process.pid, edge }))
    } finally { store.destroy() }
  `
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, database, backupRoot], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, timeout: 30_000
    })
  const report = JSON.parse(stdout) as { pid: number; edge: Edge }
  assert.ok(Number.isSafeInteger(report.pid) && report.pid > 0)
  assert.notEqual(report.pid, process.pid)
  return report.edge
}

test('a cold Main only trusts the direct predecessor of the original current V3 publication', () => withV3Fixture(async f => {
  const profile = realpathSync(f.userDataRoot), backupRoot = join(profile, 'backups', 'markdown')
  const jobs: BackupV3DatabaseExportJob[] = []
  const store = KnowbookStore.openCanonicalRuntime(f.file)
  const publish = (abort = false, beforeWorker?: Promise<void>) => new MarkdownBackupService(store, backupRoot, undefined, async job => {
    if (!('kind' in job) || job.kind !== 'synced-v3') throw new Error('Expected the production V3 raw-DB worker job')
    jobs.push(job)
    if (beforeWorker) await beforeWorker
    const exported = writeBackupSnapshot(job)
    if (abort) throw new Error('Abort after the real worker confirmation, before Main promotion')
    return exported
  })
  const read = (root = backupRoot) => readBackupV3PublishedPredecessor(store, openBackupV3RestoreSource(root))
  const edition = (job: BackupV3DatabaseExportJob, root: string) => {
    const capture = readBackupV3RestoreSource(openBackupV3RestoreSource(root))
    const { snapshotId, catalogId } = capture.archive.manifest
    const claim = store.readConfirmedCanonicalBackupPublication(job.snapshotId, job.destination)
    assert.equal(snapshotId, job.snapshotId)
    assert.equal(claim.archiveHash, capture.inventoryHash)
    return { snapshotId, catalogId, destination: job.destination, ...claim }
  }

  let edge: NonNullable<Edge>, archived: string, firstDirectory: ReturnType<typeof physicalIdentity>, firstFiles: ReturnType<typeof fileInventory>
  try {
    const service = publish()
    await service.exportAll(true)
    const first = jobs[0]
    firstDirectory = physicalIdentity(backupRoot)
    firstFiles = fileInventory(backupRoot)
    assert.equal(service.listVersions().find(version => version.current)?.id, first.snapshotId)
    assert.equal(await read(), null, 'The first actual publication has no predecessor')

    const occupiedSlot = join(`${backupRoot}-history`, first.snapshotId)
    mkdirSync(occupiedSlot)
    editCreatedGroup(f.db, f.groupId)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const secondWork = publish(false, gate).exportAll(true)
    const abortedWork = assert.rejects(publish(true).exportAll(true), /previous version and attempt evidence are retained/)
    const countWhileBlocked = jobs.length
    release()
    await Promise.all([secondWork, abortedWork])
    assert.equal(countWhileBlocked, 2, 'Another instance cannot start a worker while the current publish holds the lease')
    const second = jobs[1], versions = service.listVersions()
    const history = versions.find(version => !version.current && version.format === 'synced-v3')
    assert.ok(history)
    assert.notEqual(history.id, first.snapshotId, 'An occupied history slot forces a different physical archived ID')
    assert.equal(service.resolveVersion(first.snapshotId), occupiedSlot)
    assert.equal(versions.find(version => version.current)?.id, second.snapshotId)
    archived = service.resolveVersion(history.id)
    assert.deepEqual(physicalIdentity(archived), firstDirectory)
    assert.deepEqual(fileInventory(archived), firstFiles)

    const actual = await read()
    assert.ok(actual)
    edge = actual
    assert.equal(edge.archivedId, history.id)
    assert.match(edge.headHash, /^[a-f0-9]{64}$/)
    const { treeHash: currentTree, ...current } = edge.current
    const { treeHash: predecessorTree, ...predecessor } = edge.predecessor
    assert.match(currentTree, /^[a-f0-9]{64}$/)
    assert.match(predecessorTree, /^[a-f0-9]{64}$/)
    assert.notEqual(currentTree, predecessorTree)
    assert.deepEqual(current, edition(second, backupRoot))
    assert.deepEqual(predecessor, edition(first, archived))
    assert.equal(current.catalogId, predecessor.catalogId)
    assert.equal(current.workspaceScope, predecessor.workspaceScope)
    assert.equal(current.recoveryEpoch, predecessor.recoveryEpoch)
    assert.notEqual(current.archiveHash, predecessor.archiveHash)
    assert.equal(await read(archived), null, 'A history version cannot be used as the official current archive')

    const unpromoted = jobs[2]
    const attempt = edition(unpromoted, unpromoted.destination)
    assert.equal(attempt.catalogId, current.catalogId)
    assert.equal(attempt.workspaceScope, current.workspaceScope)
    assert.equal(attempt.recoveryEpoch, current.recoveryEpoch)
    assert.equal(service.listVersions().some(version => version.id === unpromoted.snapshotId), false)
    assert.equal(service.listVersions().find(version => version.current)?.id, second.snapshotId)
    assert.equal(await read(unpromoted.destination), null, 'A real confirmed worker claim does not grant promotion')
    assert.deepEqual(await read(), edge)

    const index = join(backupRoot, '__knowbook', 'databases', 'index.md')
    const originalIndex = join(profile, 'current-index-original'), copiedIndex = join(profile, 'current-index-copy')
    const currentDirectory = physicalIdentity(backupRoot), currentIndex = physicalIdentity(index)
    copyFileSync(index, copiedIndex)
    renameSync(index, originalIndex)
    renameSync(copiedIndex, index)
    assert.deepEqual(physicalIdentity(backupRoot), currentDirectory)
    assert.notDeepEqual(physicalIdentity(index), currentIndex)
    assert.equal(edition(second, backupRoot).archiveHash, current.archiveHash)
    assert.equal(await read(), null, 'Equal current bytes under the original root cannot hide a replaced file')
    renameSync(index, copiedIndex)
    renameSync(originalIndex, index)
    assert.deepEqual(await read(), edge)
  } finally { store.destroy() }

  f.close()
  assert.deepEqual(await readCold(f.file, backupRoot), edge)

  const original = join(profile, 'archived-original'), replacement = join(profile, 'archived-copy')
  cpSync(archived, replacement, { recursive: true, errorOnExist: true, force: false })
  renameSync(archived, original)
  renameSync(replacement, archived)
  assert.deepEqual(physicalIdentity(original), firstDirectory)
  assert.notDeepEqual(physicalIdentity(archived), firstDirectory)
  assert.deepEqual(fileInventory(archived), firstFiles)
  assert.equal(await readCold(f.file, backupRoot), null, 'A cold reader rejects an equal-byte replacement at the actual history slot')
}))
