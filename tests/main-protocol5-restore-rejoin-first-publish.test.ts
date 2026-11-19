import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { readInitialPublicationReceipt } from '../src/main/database/synced-initial-publication-receipt'
import { assertSyncedRecoveryBoundaryRecords } from '../src/main/database/synced-recovery-boundary-read'
import { confirmProtocol5RestoreRejoin, prepareProtocol5RestoreRejoin } from '../src/main/sync/protocol5-restore-rejoin-read'
import { runProtocol5WebDav } from '../src/main/sync/protocol5-service'
import { exchangeStateKey, exchangeTargetFingerprint } from '../src/main/sync/synced-exchange-model'
import { hash, readonlyRequests, runtime, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('V3 restores a newly published empty profile before any exchange and resumes the same WebDAV history', () => withIncomingFixture(async f => {
  const { targetConfig, server } = f, A = f.newPristine('first-publication')
  const headPath = '/Incoming/manifest.json', stateKey = exchangeStateKey(exchangeTargetFingerprint(targetConfig))
  const countExchanges = "SELECT COUNT(*) FROM synced_operations WHERE json_extract(result_json,'$.kind')='synced-exchange-operation'"
  A.db.close()
  const publisher = KnowbookStore.openCanonicalRuntime(A.file, false)
  let original: Buffer, attemptId: string
  try {
    await runProtocol5WebDav(publisher, A.root, targetConfig, runtime)
    original = Buffer.from(server.files.get(headPath)!)
    const db = publisher.getUnsafeDatabaseHandle()
    attemptId = db.prepare('SELECT client_operation_id FROM synced_operations').pluck().get() as string
    const { receipt } = db.transaction(() => readInitialPublicationReceipt(db, attemptId))()!
    assert.equal(receipt.manifestHash, hash(original))
    assert.equal(receipt.manifestEtag, '"' + hash(original) + '"')
    assert.equal(db.prepare('SELECT count(*) FROM synced_groups').pluck().get(), 0)
    assert.equal(publisher.getSettingPublic(stateKey), null)
  } finally { publisher.destroy() }

  const donorRoot = join(f.folder, 'donor'), backup = join(f.folder, 'restore')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const doc = donor.createDocument(null)
    donor.updateDocument(doc, { title: 'Restored after first publication', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backup, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const installed = await restoreControlledBackupV3({ userDataRoot: A.root, backupDirectory: backup, stopProcesses: async () => [] }, legacy)
  assert.equal(await recoverControlledDatabaseRestore(A.root, legacy.recoverLegacy), true)
  const reopened = KnowbookStore.openCanonicalRuntime(A.file, false)
  try {
    const db = reopened.getUnsafeDatabaseHandle()
    const cut = db.transaction(() => assertSyncedRecoveryBoundaryRecords(db))().boundaries.get(installed.operationId)!
    assert.equal(cut.groups.length + cut.hosts.length + cut.instances.length, 0)
    assert.deepEqual(cut.retainedOperations.map(entry => entry.operationId), [attemptId])
    const requestCount = server.requests.length
    const preview = await prepareProtocol5RestoreRejoin(db, A.root, targetConfig, runtime)
    assert.equal(preview.originalManifestHash, hash(original))
    assert.equal(preview.originalEtag, preview.etag)
    await confirmProtocol5RestoreRejoin(db, A.root, targetConfig, runtime, preview.owner)
    readonlyRequests(server.requests.slice(requestCount))
    assert.deepEqual(server.files.get(headPath), original)
    assert.equal(db.prepare(countExchanges).pluck().get(), 0)
    assert.equal(reopened.getSettingPublic(stateKey), null)
    assert.ok((await runProtocol5WebDav(reopened, A.root, targetConfig, runtime)).uploaded > 0)
    assert.equal(db.prepare(countExchanges).pluck().get(), 1)
    assert.notDeepEqual(server.files.get(headPath), original)
    const next = await runProtocol5WebDav(reopened, A.root, targetConfig, runtime)
    assert.equal(next.uploaded + next.downloaded, 0)
  } finally { reopened.destroy() }
}))
