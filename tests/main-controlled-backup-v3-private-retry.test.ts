import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readJointRestoreFence4, readJointRestoreIntent4 } from '../src/main/database/restore-joint-journal4'
import { prepareDurableSqlCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { readRestoreKnowledgeInstallProof } from '../src/main/database/restore-knowledge-install-proof'
import { assertV3SettledPrivateSyncOriginals, readV3SettledPrivateSyncOriginals } from '../src/main/database/restore-knowledge-settled-private-sync'
import { copyRestoreInventory, restoreExists, restoreInventory, restorePaths } from '../src/main/database/restore-safety-files'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { exchangeJobHeadKey, exchangeJobPhaseKey, exchangeJobPrefix, parseExchangeStored, validateExchangeJob, validateExchangeJobPhase }
  from '../src/main/sync/synced-exchange-model'
import { completed, hostEdit, remoteActual, withExchange } from './helpers/synced-exchange-fixture'

for (const preparedOnly of [true, false]) test(preparedOnly
  ? 'controlled V3 preserves all spools of a settled exchange with an unexposed prepared retry ancestor'
  : 'controlled V3 refuses a true 412 remote-uncertain ancestor after its retry settles', () => withExchange(async f => {
  completed(await f.exchange(f.A), 'noop')
  completed(await f.exchange(f.B), 'noop')
  hostEdit(f.A.db, f.islands[0], 'A original retry edit')
  hostEdit(f.B.db, f.islands[1], 'B actual competing edit')
  const id = randomUUID(), before = remoteActual(f)
  const head = f.A.db.prepare('SELECT 1 FROM app_settings WHERE key=?')
  const gate = f.gate(request => request.path.endsWith('/manifest.json') && (preparedOnly
    ? request.method === 'GET' && Boolean(head.get(exchangeJobHeadKey(id)))
    : request.method === 'PUT' && request.ifMatch === before.etag))
  const attempting = f.exchange(f.A, id)
  try {
    await gate.wait(attempting)
    completed(await f.exchange(f.B), 'applied')
    assert.notEqual(remoteActual(f).hash, before.hash)
  } finally { gate.release() }
  completed(await attempting, 'applied')
  const prefix = exchangeJobPrefix(id), rawJobs = f.A.db.prepare('SELECT value FROM app_settings WHERE substr(key,1,?)=?').pluck().all(prefix.length, prefix)
  const jobs = rawJobs.map(row => validateExchangeJob(parseExchangeStored(String(row)))).sort((a, b) => a.attemptIndex - b.attemptIndex)
  assert.equal(jobs.length, 2)
  const [ancestor, child] = jobs
  assert.equal(ancestor.parentAttemptId, null)
  assert.equal(child.parentAttemptId, ancestor.attemptId)
  const phasePrefix = exchangeJobPhaseKey(id, ancestor.attemptId, 0).slice(0, -1)
  const phaseRows = f.A.db.prepare('SELECT value FROM app_settings WHERE substr(key,1,?)=? ORDER BY key').pluck().all(phasePrefix.length, phasePrefix)
  const phases = phaseRows.map(row => validateExchangeJobPhase(parseExchangeStored(String(row))).phase)
  assert.deepEqual(phases, preparedOnly ? ['prepared'] : ['prepared', 'possible', 'remote-uncertain'])

  const profileRoot = f.A.root, storage = join(profileRoot, 'storage')
  const attemptDirectory = join(storage, 'synced-exchanges-v1', id), both = [ancestor.attemptId, child.attemptId].sort()
  assert.deepEqual((await readdir(attemptDirectory)).sort(), both)
  const donorRoot = join(f.folder, 'donor'), backupDirectory = join(f.folder, 'retry-incoming')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const doc = donor.createDocument(null)
    donor.updateDocument(doc, { title: 'Independent retry restore document', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  f.A.db.close()
  const originalInventory = await restoreInventory(storage)
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const restore = () => restoreControlledBackupV3({ userDataRoot: profileRoot, backupDirectory, stopProcesses: async () => [] }, legacy)
  if (!preparedOnly) {
    await assert.rejects(restore(), /原交换重试祖先缺仅 prepared/)
    assert.deepEqual(await restoreInventory(storage), originalInventory)
    assert.deepEqual((await readdir(attemptDirectory)).sort(), both)
    assert.equal(await restoreExists(join(profileRoot, 'database-restore-fence.json')), false)
    return
  }
  const scratch = restorePaths(profileRoot, randomUUID())
  await mkdir(scratch.recovery, { recursive: true })
  await copyRestoreInventory(storage, scratch.safety, originalInventory, profileRoot)
  const original = await prepareDurableSqlCapsuleOriginal({ profileRoot, recoveryDirectory: scratch.recovery, sealedDirectory: scratch.safety,
    capsuleId: randomUUID(), label: 'prepared retry ancestry observation' })
  const observation = await readV3SettledPrivateSyncOriginals(original)
  assert.equal(observation.version, 2)
  assert.deepEqual(observation.exchanges.find(item => item.operationId === id)?.preparedAncestors?.map(item => item.attemptId), [ancestor.attemptId])
  const oldReady = join(attemptDirectory, ancestor.attemptId, 'ready.json'), held = join(f.folder, 'retired-retry-ready.json')
  await rename(oldReady, held)
  try { await assert.rejects(readV3SettledPrivateSyncOriginals(original), /固定同步原目录闭集不同/) }
  finally { await rename(held, oldReady) }
  const installed = await restore()
  assert.equal(installed.status, 'installed')
  const { fence } = await readJointRestoreFence4(restorePaths(profileRoot, installed.operationId).fence), intent = await readJointRestoreIntent4(profileRoot, fence)
  const proof = await readRestoreKnowledgeInstallProof(profileRoot, installed.operationId, intent.installationProofHash)
  assert.equal(proof.version, 3)
  await assertV3SettledPrivateSyncOriginals(profileRoot, installed.operationId, intent.currentInventory, proof.privateSync)
  assert.deepEqual((await readdir(attemptDirectory)).sort(), both)
  assert.equal(await recoverControlledDatabaseRestore(profileRoot, legacy.recoverLegacy), true)
  const store = KnowbookStore.openCanonicalRuntime(f.A.file)
  try {
    assert.ok(store.getDocumentDetail(f.islands[0])?.blocks.some(block => block.content === 'A original retry edit'))
    assert.ok(store.getDocumentDetail(f.islands[1])?.blocks.some(block => block.content === 'B actual competing edit'))
    assert.ok(store.getDocumentIndex().some(document => document.title === 'Independent retry restore document'))
  } finally { store.destroy() }
}))
