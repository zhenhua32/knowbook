import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { KnowbookStore } from '../../src/main/database/store'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../../src/main/database/restore-safety'
import { restoreExists, restoreInventory, restorePaths } from '../../src/main/database/restore-safety-files'
import { exchangeSyncedSnapshot } from '../../src/main/sync/synced-exchange'
import { disposePreparedSyncedPublication, prepareInitialSyncedPublication, publishInitialSyncedPublication, receiveInitialSyncedSnapshot }
  from '../../src/main/sync/synced-publication'
import { exchangeJobPrefix, parseExchangeStored, validateExchangeJob } from '../../src/main/sync/synced-exchange-model'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../../src/shared/webdav-sync'
import { normalizeWebDavConfig } from '../../src/main/sync/webdav-client'
import { createPublicationHttpServer } from './synced-publication-http-fixture'
import { applySyncedHostCommand, applySyncedHostFinal, createRequest, created, freshBlock, request } from './synced-publication-fixture'
import { writeSyncedBackupV3 } from '../../src/main/backup/v3-export'
import { readJointRestoreFence4, readJointRestoreIntent4 } from '../../src/main/database/restore-joint-journal4'
import { readRestoreKnowledgeInstallProof, readRestoreKnowledgePriorInstall } from '../../src/main/database/restore-knowledge-install-proof'
import { assertV3SettledPrivateSyncOriginals } from '../../src/main/database/restore-knowledge-settled-private-sync'
import { completed } from './synced-exchange-fixture'
import { withV3Fixture } from './synced-backup-v3-fixture'

export function runControlledV3SettledPrivateSync(retained: boolean) {
  return withV3Fixture(async ({ root }) => {
  const profile = join(root, 'receiver'), database = join(profile, 'storage', 'knowbook.db')
  await mkdir(profile)
  const local = KnowbookStore.createEmptySyncedReceiver(database)
  const remoteRoot = join(root, 'peer')
  await mkdir(remoteRoot)
  const peer = KnowbookStore.createEmptySyncedReceiver(join(remoteRoot, 'storage', 'knowbook.db'))
  const server = await createPublicationHttpServer()
  const target = normalizeWebDavConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, enabled: true, url: server.url, username: 'test',
    directory: 'SettledRestore', allowInsecureHttp: true })
  const runtime = { password: 'app-secret' }, a = local.getUnsafeDatabaseHandle(), b = peer.getUnsafeDatabaseHandle()
  let documentId: string
  try {
    documentId = local.createDocument(null)
    const id = documentId, left = freshBlock(randomUUID(), 'Common first block'), right = freshBlock(randomUUID(), 'Common second block')
    const group = freshBlock(randomUUID(), 'Actual synced group content')
    local.updateDocument(id, { title: 'Settled editor host', summary: 'Common merge summary', blocks: [left, right, group] })
    created(applySyncedHostCommand(a, createRequest(a, { documentId: id, selectedRootIds: [group.id] })))
    const initial = await prepareInitialSyncedPublication(a, { attemptId: randomUUID(), userDataRoot: profile, target })
    assert.equal(initial.status, 'prepared')
    try { assert.equal((await publishInitialSyncedPublication(a, initial.prepared, runtime)).status, 'confirmed') }
    finally { disposePreparedSyncedPublication(initial.prepared) }
    assert.equal((await receiveInitialSyncedSnapshot(b, { operationId: randomUUID(), userDataRoot: remoteRoot, target }, runtime)).status, 'applied')
    const exchange = (db: typeof a, userDataRoot: string, operationId = randomUUID()) =>
      exchangeSyncedSnapshot(db, { operationId, userDataRoot, target }, runtime)
    completed(await exchange(a, profile), 'noop')
    completed(await exchange(b, remoteRoot), 'noop')
    assert.equal(applySyncedHostFinal(b, request(b, [id], sides => {
      const block = sides[0].blocks.find(item => item.id === right.id)
      assert.ok(block); block.content = 'Settled remote-side edit'
    })).status, 'applied')
    completed(await exchange(b, remoteRoot), 'applied')
    assert.equal(applySyncedHostFinal(a, request(a, [id], sides => {
      const block = sides[0].blocks.find(item => item.id === left.id)
      assert.ok(block); block.content = 'Settled local-side edit'
    })).status, 'applied')
    const operationId = randomUUID()
    completed(await exchange(a, profile, operationId), 'applied')
    const prefix = exchangeJobPrefix(operationId)
    const jobs = a.prepare('SELECT value FROM app_settings WHERE substr(key,1,?)=?').pluck().all(prefix.length, prefix)
    assert.equal(jobs.length, 1)
    const job = validateExchangeJob(parseExchangeStored(String(jobs[0])))
    assert.ok(job.version !== 1 && job.merges?.some(merge => merge.key === 'doc:' + id))
    const final = local.getDocumentDetail(id)
    assert.ok(final)
    assert.ok(final.blocks.some(block => block.content === 'Settled local-side edit'))
    assert.ok(final.blocks.some(block => block.content === 'Settled remote-side edit'))
  } finally {
    local.destroy(); peer.destroy()
    server.assertNoHookErrors()
    await server.close()
  }

  const donorRoot = join(root, 'donor'), backupDirectory = join(root, 'actual-incoming-backup')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const doc = donor.createDocument(null)
    donor.updateDocument(doc, { title: 'Independent incoming original', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const storage = join(profile, 'storage'), before = await restoreInventory(storage)
  const roots = (await readdir(storage)).filter(name => name.startsWith('synced-')).sort()
  assert.deepEqual(roots, ['synced-exchanges-v1', 'synced-publications-v1'])
  const unsupported = join(storage, 'synced-unrecognized-original')
  await mkdir(unsupported)
  await assert.rejects(restoreControlledBackupV3({ userDataRoot: profile, backupDirectory, stopProcesses: async () => [] }, legacy), /未知同步私有目录/)
  assert.deepEqual(await restoreInventory(storage), before)
  assert.equal(await restoreExists(join(profile, 'database-restore-fence.json')), false)
  assert.equal(await restoreExists(join(profile, 'database-restore-pending.json')), false)
  await rename(unsupported, join(root, 'retired-negative-fixture'))
  if (!retained) for (const name of roots) await rename(join(storage, name), join(root, name))
  const result = await restoreControlledBackupV3({ userDataRoot: profile, backupDirectory, stopProcesses: async () => [] }, legacy)
  assert.equal(result.status, 'installed')
  const path = restorePaths(profile, result.operationId)
  const { fence } = await readJointRestoreFence4(path.fence), intent = await readJointRestoreIntent4(profile, fence)
  const proof = await readRestoreKnowledgeInstallProof(profile, result.operationId, intent.installationProofHash)
  assert.equal(proof.version, 3)
  assert.deepEqual(intent.currentInventory, before)
  await assertV3SettledPrivateSyncOriginals(profile, result.operationId, intent.currentInventory, proof.privateSync)
  if (!retained) {
    const publication = 'synced-publications-v1'
    await rename(join(root, publication), join(storage, publication))
    try { await assert.rejects(assertV3SettledPrivateSyncOriginals(profile, result.operationId, intent.currentInventory, proof.privateSync), /已封存观察不同/) }
    finally { await rename(join(storage, publication), join(root, publication)) }
  }
  await rename(backupDirectory, backupDirectory + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(profile, legacy.recoverLegacy), true)
  await readRestoreKnowledgePriorInstall(profile, proof.coverage.root, proof.coverage)
  const installed = KnowbookStore.openCanonicalRuntime(database)
  try {
    const doc = installed.getDocumentDetail(documentId)
    assert.ok(doc?.blocks.some(block => block.content === 'Settled local-side edit'))
    assert.ok(doc?.blocks.some(block => block.content === 'Settled remote-side edit'))
    assert.ok(installed.getDocumentIndex().some(doc => doc.title === 'Independent incoming original'))
  } finally { installed.destroy() }
  assert.deepEqual((await readdir(storage)).filter(name => name.startsWith('synced-')).sort(), retained ? roots : [])
})
}
