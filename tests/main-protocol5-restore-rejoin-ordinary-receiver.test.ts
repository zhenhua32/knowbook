import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { assertSyncedRecoveryBoundaryRecords } from '../src/main/database/synced-recovery-boundary-read'
import { confirmProtocol5RestoreRejoin, prepareProtocol5RestoreRejoin } from '../src/main/sync/protocol5-restore-rejoin-read'
import { runProtocol5WebDav } from '../src/main/sync/protocol5-service'
import { runtime, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('V3 retains settled ordinary receiver operations with no structural history and rejoins after opening the installed database', () => withIncomingFixture(async f => {
  const { B, targetConfig, server } = f, A = f.newPristine('empty-publisher')
  const backupDirectory = join(f.folder, 'archive')
  A.db.close()
  B.db.close()
  const publisher = KnowbookStore.openCanonicalRuntime(A.file, false), receiver = KnowbookStore.openCanonicalRuntime(B.file, false)
  try {
    await runProtocol5WebDav(publisher, A.root, targetConfig, runtime)
    assert.equal((await runProtocol5WebDav(receiver, B.root, targetConfig, runtime)).downloaded, 0)
    const noop = await runProtocol5WebDav(receiver, B.root, targetConfig, runtime)
    assert.equal(noop.uploaded + noop.downloaded, 0)
    const db = receiver.getUnsafeDatabaseHandle()
    for (const table of ['synced_groups', 'synced_instances', 'synced_host_history_state', 'synced_host_history_documents'])
      assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0)
    assert.equal(db.prepare('SELECT COUNT(*) FROM synced_operations').pluck().get(), 2)
  } finally { publisher.destroy(); receiver.destroy() }

  const donorRoot = join(f.folder, 'donor')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    donor.createDocument(null)
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
  } finally { donor.destroy() }

  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const installed = await restoreControlledBackupV3({ userDataRoot: B.root, backupDirectory, stopProcesses: async () => [] }, legacy)
  assert.equal(await recoverControlledDatabaseRestore(B.root, legacy.recoverLegacy), true)
  const reopened = KnowbookStore.openCanonicalRuntime(B.file, false)
  try {
    const db = reopened.getUnsafeDatabaseHandle()
    const boundary = db.transaction(() => assertSyncedRecoveryBoundaryRecords(db))().boundaries.get(installed.operationId)
    assert.ok(boundary)
    assert.equal(boundary.groups.length + boundary.hosts.length + boundary.instances.length, 0)
    assert.equal(boundary.retainedOperations.length, 2)
    const path = '/Incoming/manifest.json', remoteBeforeRejoin = Buffer.from(server.files.get(path)!)
    const preview = await prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime)
    await confirmProtocol5RestoreRejoin(db, B.root, targetConfig, runtime, preview.owner)
    assert.deepEqual(server.files.get(path), remoteBeforeRejoin)
    assert.ok((await runProtocol5WebDav(reopened, B.root, targetConfig, runtime)).uploaded > 0)
    assert.equal(db.prepare('SELECT COUNT(*) FROM documents').pluck().get(), 1)
  } finally { reopened.destroy() }
}))
