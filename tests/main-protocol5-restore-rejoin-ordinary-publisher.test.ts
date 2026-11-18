import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { assertRawSyncedExchangeHistoricalMetadataOwned } from '../src/main/database/synced-exchange-history-metadata-read'
import { confirmProtocol5RestoreRejoin, prepareProtocol5RestoreRejoin } from '../src/main/sync/protocol5-restore-rejoin-read'
import { runProtocol5WebDav } from '../src/main/sync/protocol5-service'
import { exchangeStateKey, exchangeTargetFingerprint } from '../src/main/sync/synced-exchange-model'
import { hash, hostEdit, runtime } from './helpers/synced-exchange-fixture'
import { seedLocalDocument, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('ordinary WebDAV publication remains an exact seed across V3 restore and same-target rejoin', () => withIncomingFixture(async fixture => {
  const { B, targetConfig, server } = fixture, documentId = randomUUID()
  seedLocalDocument(B.db, documentId)
  B.db.close()
  const donorRoot = join(fixture.folder, 'd'), backupDirectory = join(fixture.folder, 'backup')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    donor.createDocument(null)
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
  } finally { donor.destroy() }

  const manifestPath = '/Incoming/manifest.json'
  const publisher = KnowbookStore.openCanonicalRuntime(B.file)
  let beforeRestore: Buffer
  try {
    await runProtocol5WebDav(publisher, B.root, targetConfig, runtime)
    hostEdit(publisher.getUnsafeDatabaseHandle(), documentId, 'Document-only publisher before restore')
    await runProtocol5WebDav(publisher, B.root, targetConfig, runtime)
    beforeRestore = Buffer.from(server.files.get(manifestPath)!)
  } finally { publisher.destroy() }

  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const installed = await restoreControlledBackupV3({ userDataRoot: B.root, backupDirectory, stopProcesses: async () => [] }, legacy)
  assert.equal(await recoverControlledDatabaseRestore(B.root, legacy.recoverLegacy), true)
  const reopened = KnowbookStore.openCanonicalRuntime(B.file)
  try {
    const db = reopened.getUnsafeDatabaseHandle()
    const preview = await prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime)
    assert.equal(preview.originalManifestHash, hash(beforeRestore))
    assert.equal(preview.operationId, installed.operationId)
    await confirmProtocol5RestoreRejoin(db, B.root, targetConfig, runtime, preview.owner)
    assert.deepEqual(server.files.get(manifestPath), beforeRestore)
    assert.ok((await runProtocol5WebDav(reopened, B.root, targetConfig, runtime)).uploaded > 0)
    const state = JSON.parse(reopened.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig)))!)
    assert.equal(state.recoveryEpoch, preview.installedRecoveryEpoch)
    const facts = db.transaction(() => assertRawSyncedExchangeHistoricalMetadataOwned(db))()
    const ordinary = facts.find(fact => fact.family === 'ordinary-publication')
    assert.ok(ordinary)
    assert.ok(facts.find(fact => fact.family === 'exchange-rejoin')?.supports.some(support => support.rowHash === ordinary.locator.rowHash))
  } finally { reopened.destroy() }
}))
