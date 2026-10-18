import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { getSyncedCreateRestoreContext } from '../src/main/database/synced-host-final'
import { withV3Fixture, randomUUID } from './helpers/synced-backup-v3-fixture'

test('V3 actual worker crash after committed possible and before the first external directory never restores never and a fresh snapshot can be exported', () => withV3Fixture(async f => {
  const snapshotId = randomUUID()
  const child = new Worker(new URL('./helpers/synced-backup-v3-crash-worker.mjs', import.meta.url), {
    workerData: { kind: 'synced-v3', databasePath: f.file, userDataRoot: f.userDataRoot, destination: f.destination, snapshotId }, execArgv: []
  })
  let terminated = false
  try {
    const phase = await new Promise<{ kind: string; destination: string; snapshotId: string }>((resolvePhase, reject) => {
      child.once('message', value => value?.kind === 'v3-before-first-external-directory'
        ? resolvePhase(value) : reject(new Error('The real export worker did not reach its exact crash boundary: ' + JSON.stringify(value))))
      child.once('error', reject)
      child.once('exit', code => reject(new Error('The worker exited before its actual filesystem boundary: ' + code)))
    })
    assert.equal(phase.destination, resolve(f.destination))
    assert.equal(phase.snapshotId, snapshotId)
    const second = f.connect()
    const rows = second.prepare(`SELECT a.* FROM synced_exposure_attempts a JOIN synced_group_exposure_members m
      ON m.attempt_id=a.id WHERE m.group_id=?`).all(f.groupId) as Array<{ id: string; state: string }>
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'possible', 'The independently opened SQLite connection sees the committed possible before any external directory')
    assert.equal(existsSync(f.destination), false)
    assert.equal(getSyncedCreateRestoreContext(f.db, { historyToken: f.created.historyToken, direction: 'undo' }).status, 'unavailable')
    const exit = await child.terminate(); terminated = true
    assert.equal(exit, 1, 'The actual worker was terminated while waiting at the precise IO boundary')
    assert.equal(existsSync(f.destination), false)
    assert.deepEqual(second.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(rows[0].id), rows[0])
    const destination = join(f.root, 'fresh-after-crash'), freshId = randomUUID()
    writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination, snapshotId: freshId })
    assert.equal(readBackupV3Archive(destination).manifest.snapshotId, freshId)
    assert.deepEqual(second.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(rows[0].id), rows[0],
      'A fresh export preserves the earlier possible attempt rather than laundering the old crash fact')
  } finally { if (!terminated) await child.terminate() }
}))
