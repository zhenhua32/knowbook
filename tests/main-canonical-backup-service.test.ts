import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService, writeBackupSnapshot, type BackupV3DatabaseExportJob } from '../src/main/backup/exporter'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { withV3Fixture, addV3Assets, fileInventory } from './helpers/synced-backup-v3-fixture'

test('normal complete Main backup service dispatches actual raw-db V3, cold verifies and versions it without extras or self-triggered churn', () => withV3Fixture(async f => {
  await addV3Assets(f)
  let store: KnowbookStore | null = KnowbookStore.openCanonicalRuntime(f.file)
  const backupRoot = join(realpathSync(f.root), 'service-backup'), jobs: BackupV3DatabaseExportJob[] = []
  try {
    const service = new MarkdownBackupService(store, backupRoot, undefined, async job => {
      assert.ok('kind' in job && job.kind === 'synced-v3', 'The service selects the actual canonical raw database route')
      if (!('kind' in job) || job.kind !== 'synced-v3') throw new Error('Expected the real V3 worker job')
      assert.equal(existsSync(job.destination), false, 'The real producer receives a new absent child, not the existing mkdtemp parent')
      assert.equal(realpathSync(job.databasePath), realpathSync(f.file))
      jobs.push(structuredClone(job))
      return writeBackupSnapshot(job)
    })
    const first = await service.exportAll(), archive = readBackupV3Archive(backupRoot), firstFiles = fileInventory(backupRoot)
    assert.equal(first.exported, archive.documents.length)
    assert.equal(archive.manifest.snapshotId, jobs[0].snapshotId)
    assert.ok(archive.groups.some(item => item.wire.id === f.groupId))
    assert.equal(archive.assets.length, 2, 'Both real same-hash logical asset names survive the actual service')
    assert.equal(existsSync(join(backupRoot, '__knowbook', 'snapshot.json')), false, 'No legacy version sidecar can enter the closed V3 archive')
    const firstVersion = service.listVersions()[0]
    assert.deepEqual({ id: firstVersion.id, count: firstVersion.documentCount, current: firstVersion.current, format: firstVersion.format, restorable: firstVersion.restorable },
      { id: archive.manifest.snapshotId, count: archive.documents.length, current: true, format: 'synced-v3', restorable: false })
    assert.equal(service.resolveVersion(firstVersion.id), backupRoot)
    assert.deepEqual(await service.exportAll(), first)
    assert.equal(jobs.length, 1, 'Its own real possible/confirmed exposure and lastRun setting cannot schedule another identical backup')

    editCreatedGroup(f.db, f.groupId)
    await service.exportAll()
    assert.equal(jobs.length, 2, 'A real canonical edit changes the full backup revision')
    assert.equal(service.listVersions().length, 2)
    const oldRoot = service.resolveVersion(firstVersion.id)
    assert.notEqual(oldRoot, backupRoot)
    assert.equal(readBackupV3Archive(oldRoot).manifest.snapshotId, firstVersion.id)
    assert.deepEqual(fileInventory(oldRoot), firstFiles)
    const currentId = readBackupV3Archive(backupRoot).manifest.snapshotId
    store.destroy(); store = KnowbookStore.openCanonicalRuntime(f.file)
    const restarted = new MarkdownBackupService(store, backupRoot)
    assert.equal(restarted.listVersions().length, 2)
    assert.equal(restarted.listVersions().find(item => item.current)!.id, currentId)
    assert.equal(readBackupV3Archive(restarted.resolveVersion(firstVersion.id)).manifest.snapshotId, firstVersion.id)
  } finally { store?.destroy() }
}))
