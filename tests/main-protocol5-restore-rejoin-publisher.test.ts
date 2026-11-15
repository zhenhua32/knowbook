import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { runProtocol5WebDav } from '../src/main/sync/protocol5-service'
import { confirmProtocol5RestoreRejoin, prepareProtocol5RestoreRejoin } from '../src/main/sync/protocol5-restore-rejoin-read'
import { assertRawSyncedExchangeHistoricalMetadataOwned } from '../src/main/database/synced-exchange-history-metadata-read'
import { exchangeStateKey, exchangeTargetFingerprint } from '../src/main/sync/synced-exchange-model'
import { hash, hostEdit, runtime } from './helpers/synced-exchange-fixture'
import { withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('the original WebDAV publisher can rejoin after a real settled exchange and V3 restore', () => withIncomingFixture(async fixture => {
  const { A, targetConfig, server } = fixture
  const realStore = (file: string) => KnowbookStore.openCanonicalRuntime(file)
  const donorRoot = join(fixture.folder, 'donor'), backupDirectory = join(fixture.folder, 'restore-donor')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const id = donor.createDocument(null)
    donor.updateDocument(id, { title: 'Additional independent publisher restore', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  const manifestPath = '/Incoming/manifest.json'
  A.db.close()
  const publisher = realStore(A.file)
  let knownHead: Buffer, initial: string
  try {
    await runProtocol5WebDav(publisher, A.root, targetConfig, runtime, false)
    assert.equal(publisher.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig))), null)
    initial = hash(server.files.get(manifestPath)!)
    await runProtocol5WebDav(publisher, A.root, targetConfig, runtime, false)
    const db = publisher.getUnsafeDatabaseHandle()
    hostEdit(db, fixture.target, 'New actual publisher content before restore')
    await runProtocol5WebDav(publisher, A.root, targetConfig, runtime, false)
    knownHead = Buffer.from(server.files.get(manifestPath)!)
    assert.notEqual(hash(knownHead), initial)
    assert.equal(JSON.parse(publisher.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig)))!).source.kind, 'confirmed-publication')
  } finally { publisher.destroy() }
  const privateRoot = join(A.root, 'storage', 'synced-publications-v1')
  assert.ok((await readdir(privateRoot)).length)
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const installed = await restoreControlledBackupV3({ userDataRoot: A.root, backupDirectory, stopProcesses: async () => [] }, legacy)
  assert.equal(await recoverControlledDatabaseRestore(A.root, legacy.recoverLegacy), true)
  const reopened = realStore(A.file)
  try {
    const db = reopened.getUnsafeDatabaseHandle(), rootPath = '/Incoming/objects/manifest-' + initial + '.json', originalSeed = server.files.get(rootPath)!
    assert.ok(originalSeed, 'The genuine first publication is anchored as a predecessor')
    await assert.rejects(runProtocol5WebDav(reopened, A.root, targetConfig, runtime, false), /旧的同步块任务已暂停/)
    const retired = join(fixture.folder, 'retired-confirmed-spool')
    await rename(privateRoot, retired)
    try { await assert.rejects(prepareProtocol5RestoreRejoin(db, A.root, targetConfig, runtime), /私有完整原bytes/) }
    finally { await rename(retired, privateRoot) }
    server.files.delete(rootPath)
    try { await assert.rejects(prepareProtocol5RestoreRejoin(db, A.root, targetConfig, runtime), /历史前驱原字节/) }
    finally { server.files.set(rootPath, originalSeed) }
    const preview = await prepareProtocol5RestoreRejoin(db, A.root, targetConfig, runtime)
    assert.equal(preview.originalManifestHash, hash(knownHead))
    assert.equal(preview.operationId, installed.operationId)
    await confirmProtocol5RestoreRejoin(db, A.root, targetConfig, runtime, preview.owner)
    assert.deepEqual(server.files.get(manifestPath), knownHead)
    const outcome = await runProtocol5WebDav(reopened, A.root, targetConfig, runtime, false)
    assert.ok(outcome.uploaded > 0, 'The original WebDAV writer publishes the restored local document with a protected CAS')
    const state = JSON.parse(reopened.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig)))!)
    assert.equal(state.recoveryEpoch, preview.installedRecoveryEpoch)
    const facts = db.transaction(() => assertRawSyncedExchangeHistoricalMetadataOwned(db))()
    assert.ok(facts.some(fact => fact.family === 'exchange-rejoin' && fact.version === 2
      && fact.supports.some(support => support.table === 'synced_group_exposure_members')))
  } finally { reopened.destroy() }
}))

