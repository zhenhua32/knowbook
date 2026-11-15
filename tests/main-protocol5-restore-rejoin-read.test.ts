import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { restoreInventory, restorePaths } from '../src/main/database/restore-safety-files'
import { KnowbookStore } from '../src/main/database/store'
import { SYNC_RECEIVER_PROFILE_KEY } from '../src/main/sync/receiver-bootstrap'
import { protocol5RouteKey, runProtocol5WebDav } from '../src/main/sync/protocol5-service'
import { confirmProtocol5RestoreRejoin, prepareProtocol5RestoreRejoin } from '../src/main/sync/protocol5-restore-rejoin-read'
import { exchangeRejoinFile, exchangeRejoinPrefix } from '../src/main/database/synced-exchange-rejoin-model'
import { assertRawSyncedExchangeHistoricalMetadataOwned } from '../src/main/database/synced-exchange-history-metadata-read'
import { exchangeStateKey, exchangeTargetFingerprint } from '../src/main/sync/synced-exchange-model'
import { completed, exchangeSyncedSnapshot, hash, hostEdit, runtime } from './helpers/synced-exchange-fixture'
import { withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('restore rejoin preparation reconstructs authenticated B and the real advanced WebDAV head without local or remote writes', () => withIncomingFixture(async fixture => {
  const { A, B, targetConfig, server } = fixture
  const realStore = (file: string) => KnowbookStore.openCanonicalRuntime(file)
  A.db.close()
  const source = realStore(A.file)
  try { await runProtocol5WebDav(source, A.root, targetConfig, runtime, false) } finally { source.destroy() }
  A.db = fixture.connect(A)
  B.db.close()
  const receiver = realStore(B.file)
  try {
    receiver.saveSetting(SYNC_RECEIVER_PROFILE_KEY, 'true')
    await runProtocol5WebDav(receiver, B.root, targetConfig, runtime, false)
    await runProtocol5WebDav(receiver, B.root, targetConfig, runtime, false)
  } finally { receiver.destroy() }
  B.db = fixture.connect(B)
  hostEdit(B.db, fixture.target, 'Accepted receiver parent before controlled backup restore')
  B.db.close()
  const beforeRestore = realStore(B.file)
  let oldHead: Buffer, oldState: { recoveryEpoch: string; baseline: Array<{ key: string; remoteHash: string; acceptedOperationId: string }> }
  const manifest = '/Incoming/manifest.json'
  try {
    await runProtocol5WebDav(beforeRestore, B.root, targetConfig, runtime, false)
    oldHead = Buffer.from(server.files.get(manifest)!)
    oldState = JSON.parse(beforeRestore.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig)))!)
  } finally { beforeRestore.destroy() }
  assert.ok(oldState.baseline.length > 2)
  assert.ok(JSON.parse(oldHead.toString()).history)

  const donorRoot = join(fixture.folder, 'donor'), backupDirectory = join(fixture.folder, 'restore-donor')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const id = donor.createDocument(null)
    donor.updateDocument(id, { title: 'Additional V3 source', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const result = await restoreControlledBackupV3({ userDataRoot: B.root, backupDirectory, stopProcesses: async () => [] }, legacy)
  await rename(backupDirectory, backupDirectory + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(B.root, legacy.recoverLegacy), true)
  const reopened = realStore(B.file)
  let installedBridgeKey: string
  try {
    await assert.rejects(runProtocol5WebDav(reopened, B.root, targetConfig, runtime, false), /旧的同步块任务已暂停/)
    const db = reopened.getUnsafeDatabaseHandle(), path = restorePaths(B.root, result.operationId)
    const originalRoute = reopened.getSettingPublic(protocol5RouteKey(targetConfig))
    assert.ok(originalRoute)
    const alternateDb = fixture.connect(B)
    try { await assert.rejects(prepareProtocol5RestoreRejoin(alternateDb, B.root, targetConfig, runtime), /缺实际已安装工作区的冷启动和连接证明/) }
    finally { alternateDb.close() }
    const sameHead = await prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime)
    assert.equal(sameHead.manifestHash, hash(oldHead))
    assert.equal(sameHead.etag, sameHead.originalEtag)

    await fixture.track(exchangeSyncedSnapshot(A.db, fixture.input(randomUUID(), A), runtime))
    hostEdit(A.db, fixture.other, 'Genuine independently advanced remote after receiver restore')
    completed(await fixture.track(exchangeSyncedSnapshot(A.db, fixture.input(randomUUID(), A), runtime)), 'applied')
    const newHead = Buffer.from(server.files.get(manifest)!)
    assert.notDeepEqual(newHead, oldHead)
    const requests = server.requests.length, files = new Map(server.files), changes = db.prepare('SELECT total_changes()').pluck().get()
    const inventory = await restoreInventory(path.storage), beforeFence = await readFile(path.fence), recovery = await readdir(path.recovery)
    const observed = await prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime)
    assert.equal(observed.executionAuthorized, false)
    assert.equal(observed.operationId, result.operationId)
    assert.equal(observed.originalRecoveryEpoch, oldState.recoveryEpoch)
    assert.equal(observed.installedRecoveryEpoch, reopened.getEditorRecoveryWorkspace().recoveryEpoch)
    assert.notEqual(observed.originalRecoveryEpoch, observed.installedRecoveryEpoch)
    assert.equal(observed.originalManifestHash, hash(oldHead))
    assert.equal(observed.manifestHash, hash(newHead))
    assert.notEqual(observed.etag, observed.originalEtag)
    assert.deepEqual(observed.baseline.map(({ key, hash, acceptedOperationId }) => ({ key, remoteHash: hash, acceptedOperationId })),
      oldState.baseline.map(({ key, remoteHash, acceptedOperationId }) => ({ key, remoteHash, acceptedOperationId })))
    const lostB = oldState.baseline.find(row => row.key === 'doc:' + fixture.other)!
    assert.notEqual(JSON.parse(newHead.toString()).entries[lostB.key], lostB.remoteHash)
    const missingPath = '/Incoming/objects/' + lostB.remoteHash + '.json', lost = server.files.get(missingPath)!
    assert.ok(lost)
    server.files.delete(missingPath)
    try { await assert.rejects(prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime), /缺准确原 B 对象/) }
    finally { server.files.set(missingPath, lost) }
    await assert.rejects(prepareProtocol5RestoreRejoin(db, B.root, { ...targetConfig, directory: 'unrelated' }, runtime), /缺原已结算/)
    assert.ok(server.requests.slice(requests).length > 0)
    assert.ok(server.requests.slice(requests).every(entry => ['GET', 'HEAD', 'PROPFIND'].includes(entry.method)))
    assert.deepEqual(server.files, files)
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(), changes)
    assert.deepEqual(await restoreInventory(path.storage), inventory)
    assert.deepEqual(await readFile(path.fence), beforeFence)
    assert.deepEqual(await readdir(path.recovery), recovery)

    // Changing an otherwise valid route's exact row is different from a
    // mere epoch check. This fixture restores the original value after proving rejection.
    const sql = db.prepare('UPDATE app_settings SET value=? WHERE key=?'), route = protocol5RouteKey(targetConfig)
    sql.run(originalRoute + ' ', route)
    const writes = server.requests.length
    try { await assert.rejects(prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime), /与精确安装原件不同/) }
    finally { sql.run(originalRoute, route) }
    assert.equal(server.requests.length, writes)

    await assert.rejects(confirmProtocol5RestoreRejoin(db, B.root, targetConfig, runtime, { kind: 'protocol5-restore-rejoin-preview' }), /缺真实确认/)
    await assert.rejects(confirmProtocol5RestoreRejoin(db, B.root, targetConfig, runtime, sameHead.owner), /原恢复续接预案已变化/)
    const beforeConfirmOperations = db.prepare('SELECT count(*) FROM synced_operations').pluck().get()
    const beforeConfirmRemote = new Map(server.files)
    const bridge = await confirmProtocol5RestoreRejoin(db, B.root, targetConfig, runtime, observed.owner)
    assert.equal(bridge.operationId, result.operationId)
    assert.deepEqual(server.files, beforeConfirmRemote)
    assert.equal(db.prepare('SELECT count(*) FROM synced_operations').pluck().get(), beforeConfirmOperations)
    const keys = db.prepare('SELECT key FROM app_settings WHERE substr(key,1,?)=?').pluck().all(exchangeRejoinPrefix.length, exchangeRejoinPrefix)
    assert.equal(keys.length, 1)
    installedBridgeKey = String(keys[0])
    assert.equal(JSON.parse(reopened.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig)))!).recoveryEpoch, oldState.recoveryEpoch)
    const bridgeFile = exchangeRejoinFile(path.root, result.operationId, bridge.bridgeHash)
    await rename(bridgeFile, bridgeFile + '-held')
    try {
      await assert.rejects(exchangeSyncedSnapshot(db, fixture.input(randomUUID(), B), runtime), /恢复续接原记录损坏/)
      const raw = JSON.parse(reopened.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig)))!)
      assert.equal(raw.recoveryEpoch, oldState.recoveryEpoch)
    } finally { await rename(bridgeFile + '-held', bridgeFile) }
    const synced = await runProtocol5WebDav(reopened, B.root, targetConfig, runtime, false)
    assert.ok(synced.downloaded > 0)
    assert.equal(JSON.parse(reopened.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig)))!).recoveryEpoch, observed.installedRecoveryEpoch)
    assert.equal(reopened.getDocumentDetail(fixture.other)?.blocks[0]?.content, 'Genuine independently advanced remote after receiver restore')
    const facts = db.transaction(() => assertRawSyncedExchangeHistoricalMetadataOwned(db))()
    assert.ok(facts.some(fact => fact.family === 'exchange-rejoin' && fact.locator.key[0] === installedBridgeKey))
  } finally { reopened.destroy() }
  assert.equal(await recoverControlledDatabaseRestore(B.root, legacy.recoverLegacy), true)
  const cold = realStore(B.file)
  try {
    assert.ok(cold.getSettingPublic(installedBridgeKey))
    await runProtocol5WebDav(cold, B.root, targetConfig, runtime, false)
  } finally { cold.destroy() }

}))
