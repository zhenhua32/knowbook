import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { assertRawSyncedExchangeHistoricalMetadataOwned } from '../src/main/database/synced-exchange-history-metadata-read'
import { exchangeRejoinFile } from '../src/main/database/synced-exchange-rejoin-model'
import { confirmProtocol5RestoreRejoin, prepareProtocol5RestoreRejoin } from '../src/main/sync/protocol5-restore-rejoin-read'
import { runProtocol5WebDav } from '../src/main/sync/protocol5-service'
import { exchangeSyncedSnapshot } from '../src/main/sync/synced-exchange'
import { exchangeStateKey, exchangeTargetFingerprint } from '../src/main/sync/synced-exchange-model'
import { hash, readonlyRequests, runtime, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('V3 restores and rejoins a first receive before any exchange receipt exists', () => withIncomingFixture(async f => {
  const { B, targetConfig, server } = f, A = f.newPristine('first-source')
  const headPath = '/Incoming/manifest.json'
  A.db.close()
  B.db.close()
  const sender = KnowbookStore.openCanonicalRuntime(A.file, false)
  const receiver = KnowbookStore.openCanonicalRuntime(B.file, false)
  const stateKey = exchangeStateKey(exchangeTargetFingerprint(targetConfig))
  const countExchanges = "SELECT COUNT(*) FROM synced_operations WHERE json_extract(result_json,'$.kind')='synced-exchange-operation'"
  let originalHead: Buffer, advancedHead: Buffer, remoteId: string
  try {
    await runProtocol5WebDav(sender, A.root, targetConfig, runtime)
    originalHead = Buffer.from(server.files.get(headPath)!)
    await runProtocol5WebDav(receiver, B.root, targetConfig, runtime)
    const db = receiver.getUnsafeDatabaseHandle()
    assert.equal(db.prepare('SELECT COUNT(*) FROM synced_operations').pluck().get(), 1)
    assert.equal(receiver.getSettingPublic(stateKey), null)
    remoteId = sender.createDocument(null)
    sender.updateDocument(remoteId, { title: 'Remote document after first receive', summary: '', blocks: [] })
    assert.ok((await runProtocol5WebDav(sender, A.root, targetConfig, runtime)).uploaded > 0)
    advancedHead = Buffer.from(server.files.get(headPath)!)
  } finally { sender.destroy(); receiver.destroy() }

  const donorRoot = join(f.folder, 'donor'), backup = join(f.folder, 'archive')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const doc = donor.createDocument(null)
    donor.updateDocument(doc, { title: 'Local document restored by V3', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backup, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const installed = await restoreControlledBackupV3({ userDataRoot: B.root, backupDirectory: backup, stopProcesses: async () => [] }, legacy)
  assert.equal(await recoverControlledDatabaseRestore(B.root, legacy.recoverLegacy), true)
  let reopened = KnowbookStore.openCanonicalRuntime(B.file, false)
  try {
    let db = reopened.getUnsafeDatabaseHandle()
    assert.equal(db.prepare(countExchanges).pluck().get(), 0)
    await assert.rejects(runProtocol5WebDav(reopened, B.root, targetConfig, runtime), /旧的同步块任务已暂停/)
    const requestCount = server.requests.length
    const preview = await prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime)
    assert.equal(preview.originalManifestHash, hash(originalHead))
    assert.equal(preview.originalEtag, '"' + hash(originalHead) + '"')
    assert.equal(preview.manifestHash, hash(advancedHead))
    const bridge = await confirmProtocol5RestoreRejoin(db, B.root, targetConfig, runtime, preview.owner)
    readonlyRequests(server.requests.slice(requestCount))
    assert.deepEqual(server.files.get(headPath), advancedHead)
    assert.equal(db.prepare(countExchanges).pluck().get(), 0)
    assert.equal(reopened.getSettingPublic(stateKey), null)
    const facts = db.transaction(() => assertRawSyncedExchangeHistoricalMetadataOwned(db))()
    const receipt = facts.find(fact => fact.family === 'initial-baseline')
    assert.ok(receipt)
    assert.ok(facts.find(fact => fact.family === 'initial-rejoin')?.supports.some(support => support.rowHash === receipt.locator.rowHash))

    reopened.destroy()
    reopened = KnowbookStore.openCanonicalRuntime(B.file, false)
    db = reopened.getUnsafeDatabaseHandle()
    const proof = exchangeRejoinFile(B.root, installed.operationId, bridge.bridgeHash)
    await rename(proof, proof + '-held')
    try {
      await assert.rejects(exchangeSyncedSnapshot(db, f.input(randomUUID(), B), runtime), /恢复续接原记录损坏/)
      assert.equal(db.prepare(countExchanges).pluck().get(), 0)
    } finally { await rename(proof + '-held', proof) }
    const outcome = await runProtocol5WebDav(reopened, B.root, targetConfig, runtime)
    assert.ok(outcome.uploaded > 0 && outcome.downloaded > 0)
    assert.equal(db.prepare(countExchanges).pluck().get(), 1)
    assert.equal(reopened.getDocumentDetail(remoteId)?.title, 'Remote document after first receive')
    assert.ok(reopened.getDocumentIndex().some(doc => doc.title === 'Local document restored by V3'))
    const settled = await runProtocol5WebDav(reopened, B.root, targetConfig, runtime)
    assert.equal(settled.uploaded + settled.downloaded, 0)
  } finally { reopened.destroy() }
}))
