import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readJointRestoreFence4, readJointRestoreIntent4 } from '../src/main/database/restore-joint-journal4'
import { readRestoreKnowledgeInstallProof } from '../src/main/database/restore-knowledge-install-proof'
import { assertV3SettledPrivateSyncOriginals } from '../src/main/database/restore-knowledge-settled-private-sync'
import { restoreExists, restoreInventory, restorePaths } from '../src/main/database/restore-safety-files'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { deletionChoicePreviewKey } from '../src/main/database/synced-exchange-deletion-choice-read'
import { previewSyncedExchangeDeletions, resolveSyncedExchangeDeletions } from '../src/main/sync/synced-exchange'
import { choose, component, docConflict, ready, runtime, withDeletionChoices } from './helpers/synced-deletion-choice-fixture'

test('controlled V3 preserves an authentic WebDAV deletion preview and refuses its original choices after restore', () => withDeletionChoices(async fixture => {
  const conflict = docConflict(fixture), preview = ready(await fixture.preview())
  const choices = [choose(component(preview, conflict.key), 'keep-delete')]
  const profile = fixture.B.root, storage = join(profile, 'storage')
  const previewPath = join(storage, 'synced-exchange-deletion-previews-v1', preview.previewId, 'preview.json')
  const original = await readFile(previewPath), originalStat = await lstat(previewPath, { bigint: true })
  const indexKey = deletionChoicePreviewKey(preview.previewId), indexRead = 'SELECT value,updated_at FROM app_settings WHERE key=?'
  const index = fixture.B.db.prepare(indexRead).get(indexKey)
  assert.ok(index)
  const backupDirectory = join(fixture.folder, 'preview-v3'), donorRoot = join(fixture.folder, 'donor')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const id = donor.createDocument(null)
    donor.updateDocument(id, { title: 'Independent preview restore', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  fixture.B.db.close()
  const before = await restoreInventory(storage)
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  const restore = () => restoreControlledBackupV3({ userDataRoot: profile, backupDirectory, stopProcesses: async () => [] }, legacy)

  const corrupt = Buffer.from(original)
  corrupt[0] ^= 1
  await writeFile(previewPath, corrupt)
  try {
    await assert.rejects(restore(), /原预览字节/)
    assert.deepEqual(await readFile(previewPath), corrupt)
    assert.deepEqual(await restoreInventory(storage), before)
    assert.equal(await restoreExists(join(profile, 'database-restore-fence.json')), false)
  } finally { await writeFile(previewPath, original) }

  const installed = await restore()
  assert.equal(installed.status, 'installed')
  const { fence } = await readJointRestoreFence4(restorePaths(profile, installed.operationId).fence)
  const intent = await readJointRestoreIntent4(profile, fence)
  const proof = await readRestoreKnowledgeInstallProof(profile, installed.operationId, intent.installationProofHash)
  assert.equal(proof.version, 3)
  await assertV3SettledPrivateSyncOriginals(profile, installed.operationId, intent.currentInventory, proof.privateSync)
  await rename(backupDirectory, backupDirectory + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(profile, legacy.recoverLegacy), true)
  assert.deepEqual(await readFile(previewPath), original)
  assert.equal((await lstat(previewPath, { bigint: true })).ino, originalStat.ino)

  const reopened = KnowbookStore.openCanonicalRuntime(fixture.B.file)
  try {
    const db = reopened.getUnsafeDatabaseHandle()
    assert.deepEqual(db.prepare(indexRead).get(indexKey), index)
    const historical = { previewId: preview.previewId, userDataRoot: profile, target: fixture.targetConfig }
    await assert.rejects(previewSyncedExchangeDeletions(db, historical, runtime), /删除预览属于其它scope\/epoch/)
    const request = { ...fixture.input(randomUUID(), fixture.B), previewId: preview.previewId, decisions: choices }
    await assert.rejects(resolveSyncedExchangeDeletions(db, request, runtime), /历史exchange state属于另一workspace\/recovery世代/)
    assert.ok(reopened.getDocumentDetail(conflict.id))
    assert.ok(reopened.getDocumentIndex().some(doc => doc.title === 'Independent preview restore'))
  } finally { reopened.destroy() }
}))
