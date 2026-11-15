import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readJointRestoreFence4, readJointRestoreIntent4 } from '../src/main/database/restore-joint-journal4'
import { readRestoreKnowledgeInstallProof } from '../src/main/database/restore-knowledge-install-proof'
import { assertV3SettledPrivateSyncOriginals } from '../src/main/database/restore-knowledge-settled-private-sync'
import { restoreExists, restoreInventory, restorePaths } from '../src/main/database/restore-safety-files'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { accepted, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('controlled V3 preserves empty staging parents left by real WebDAV initial asset receive', () => withIncomingFixture(async fixture => {
  await fixture.publish()
  const incomingId = randomUUID(), result = accepted(await fixture.receive(incomingId))
  assert.ok(result.counts.assets > 0)
  const profile = fixture.B.root, storage = join(profile, 'storage'), incoming = join(storage, 'synced-incoming-v1'), operation = join(incoming, incomingId)
  assert.deepEqual(await readdir(incoming), [incomingId])
  assert.deepEqual(await readdir(operation), [])
  const originalParent = await lstat(operation, { bigint: true })
  const backupDirectory = join(fixture.folder, 'incoming-v3'), donorRoot = join(fixture.folder, 'donor')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const id = donor.createDocument(null)
    donor.updateDocument(id, { title: 'Independent receiving restore', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  fixture.B.db.close()
  const before = await restoreInventory(storage)
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const restore = () => restoreControlledBackupV3({ userDataRoot: profile, backupDirectory, stopProcesses: async () => [] }, legacy)
  const attempt = join(operation, randomUUID()), pending = join(attempt, 'pending-body')
  const content = Buffer.from('Unsettled stage evidence')
  await mkdir(attempt)
  await writeFile(pending, content, { flag: 'wx' })
  await assert.rejects(restore(), /初次接收仍有私有暂存原件/)
  assert.deepEqual(await readFile(pending), content)
  assert.deepEqual(await restoreInventory(storage), before)
  assert.equal(await restoreExists(join(profile, 'database-restore-fence.json')), false)
  assert.equal(await restoreExists(join(profile, 'database-restore-pending.json')), false)
  await rename(attempt, join(fixture.folder, 'held-negative-stage'))
  const installed = await restore()
  assert.equal(installed.status, 'installed')
  const { fence } = await readJointRestoreFence4(restorePaths(profile, installed.operationId).fence), intent = await readJointRestoreIntent4(profile, fence)
  const proof = await readRestoreKnowledgeInstallProof(profile, installed.operationId, intent.installationProofHash)
  assert.equal(proof.version, 3)
  await assertV3SettledPrivateSyncOriginals(profile, installed.operationId, intent.currentInventory, proof.privateSync)
  await rename(backupDirectory, backupDirectory + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(profile, legacy.recoverLegacy), true)
  assert.deepEqual(await readdir(incoming), [incomingId])
  assert.deepEqual(await readdir(operation), [])
  const preserved = await lstat(operation, { bigint: true })
  assert.equal(preserved.ino, originalParent.ino)
  const reopened = KnowbookStore.openCanonicalRuntime(fixture.B.file)
  try {
    assert.ok(reopened.getDocumentDetail(fixture.host))
    assert.ok(reopened.getDocumentIndex().some(doc => doc.title === 'Independent receiving restore'))
  } finally { reopened.destroy() }
}, { assets: true }))
