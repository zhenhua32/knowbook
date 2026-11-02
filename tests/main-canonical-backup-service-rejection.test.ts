import assert from 'node:assert/strict'
import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService, writeBackupSnapshot, type BackupV3DatabaseExportJob } from '../src/main/backup/exporter'
import { withV3Fixture, fileInventory } from './helpers/synced-backup-v3-fixture'

test('service rejects real post-producer extras and a real worker crash without replacing the prior version or deleting confirmed/possible attempt evidence', () => withV3Fixture(async f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file), backupRoot = join(realpathSync(f.root), 'service-backup')
  let corrupt: BackupV3DatabaseExportJob | undefined, crashed: BackupV3DatabaseExportJob | undefined
  try {
    const original = new MarkdownBackupService(store, backupRoot)
    await original.exportAll()
    const before = fileInventory(backupRoot), previousVersion = original.listVersions()[0], at = store.getSettingPublic('backup.lastRunAt')
    const damaged = new MarkdownBackupService(store, backupRoot, undefined, async job => {
      if (!('kind' in job) || job.kind !== 'synced-v3') throw new Error('Expected actual raw-db V3')
      corrupt = job
      const count = writeBackupSnapshot(job) // Real complete producer and confirmed durable claim.
      writeFileSync(join(job.destination, '__knowbook', 'snapshot.json'), '{"id":"caller extras cannot authorize V3"}')
      return count
    })
    await assert.rejects(damaged.exportAll(true), /previous version and attempt evidence are retained/)
    assert.ok(corrupt)
    assert.equal(existsSync(join(corrupt.destination, '__knowbook', 'snapshot.json')), true)
    assert.equal((f.db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(corrupt.snapshotId) as { state: string }).state, 'confirmed')
    assert.deepEqual(fileInventory(backupRoot), before)
    assert.equal(store.getSettingPublic('backup.lastRunAt'), at)

    const failing = new MarkdownBackupService(store, backupRoot, undefined, async job => {
      if (!('kind' in job) || job.kind !== 'synced-v3') throw new Error('Expected actual raw-db V3')
      crashed = job
      const child = new Worker(new URL('./helpers/synced-backup-v3-crash-worker.mjs', import.meta.url), { workerData: job, execArgv: [] })
      let stopped = false
      try {
        const phase = await new Promise<{ kind: string; destination: string; snapshotId: string }>((done, reject) => {
          child.once('message', value => value?.kind === 'v3-before-first-external-directory' ? done(value) : reject(new Error('Unexpected real worker phase')))
          child.once('error', reject); child.once('exit', code => reject(new Error('Worker exited before actual durable possible: ' + code)))
        })
        assert.equal(phase.destination, resolve(job.destination)); assert.equal(phase.snapshotId, job.snapshotId)
        const state = f.connect().prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(job.snapshotId) as { state: string }
        assert.equal(state.state, 'possible', 'An independent SQLite reader sees the real committed claim, not a fake ACK')
        assert.equal(await child.terminate(), 1); stopped = true
        throw new Error('Controlled termination of the actual export worker after durable possible')
      } finally { if (!stopped) await child.terminate() }
    })
    await assert.rejects(failing.exportAll(true), /previous version and attempt evidence are retained/)
    assert.ok(crashed)
    assert.equal(existsSync(dirname(crashed.destination)), true, 'The service preserves the original attempt parent even before any payload file')
    assert.equal((f.db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(crashed.snapshotId) as { state: string }).state, 'possible')
    assert.deepEqual(fileInventory(backupRoot), before)
    assert.equal(original.listVersions().length, 1, 'Failed staging attempts are not exposed as successful versions')
    assert.equal(original.listVersions()[0].id, previousVersion.id)
    assert.ok(readdirSync(dirname(backupRoot)).filter(name => name.startsWith('.knowbook-synced-v3-')).length >= 2)
    assert.equal(store.getSettingPublic('backup.lastRunAt'), at)
  } finally { store.destroy() }
}))
