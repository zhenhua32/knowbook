import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3RestoreSource, openBackupV3RestoreSource } from '../src/main/backup/v3-reader'
import { readJointRestoreFence4, readJointRestoreIntent4 } from '../src/main/database/restore-joint-journal4'
import { canonicalRestoreRoot, restorePaths, restoreInventory } from '../src/main/database/restore-safety-files'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'

test('controlled V3 replays the same committed ACK without the source or another confirmation, epoch or work tree', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'v3-ack-'))
  try {
    const donorRoot = join(folder, 'donor'), receiverRoot = join(folder, 'receiver'), backupDirectory = join(folder, 'backup')
    await mkdir(donorRoot)
    await mkdir(receiverRoot)
    const userDataRoot = await canonicalRestoreRoot(receiverRoot), requestId = randomUUID(), paths = restorePaths(userDataRoot, requestId)
    const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
    const donorId = donor.createDocument(null)
    try {
      donor.updateDocument(donorId, { title: 'Source for an idempotent restore', summary: '', blocks: [] })
      writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backupDirectory, snapshotId: randomUUID() })
    } finally { donor.destroy() }
    const receiver = KnowbookStore.createEmptySyncedReceiver(paths.database)
    receiver.destroy()
    const archive = readBackupV3RestoreSource(openBackupV3RestoreSource(backupDirectory)), expectedInventoryHash = archive.inventoryHash
    const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
    let stopped = 0, confirmed = 0
    const input = { userDataRoot, backupDirectory, expectedInventoryHash, requestId, stopProcesses: async () => { stopped++; return [7331] } }
    const installed = await restoreControlledBackupV3(input, legacy, async preview => {
      confirmed++
      assert.equal(preview.operationId, requestId)
      return true
    })
    assert.ok(installed)
    assert.equal(installed.status, 'installed')
    assert.equal(installed.operationId, requestId)
    const { fence } = await readJointRestoreFence4(paths.fence), intent = await readJointRestoreIntent4(userDataRoot, fence)
    assert.equal(intent.version, 4)
    assert.deepEqual(intent.request.sourceArchive, { snapshotId: archive.archive.manifest.snapshotId, inventoryHash: expectedInventoryHash })

    await rename(backupDirectory, backupDirectory + '-retired')
    assert.equal(await recoverControlledDatabaseRestore(userDataRoot, legacy.recoverLegacy), true)
    // Normal local writes after installation must survive both replay and cold receipt verification.
    const current = KnowbookStore.openCanonicalRuntime(paths.database)
    const localId = current.createDocument(null)
    current.updateDocument(localId, { title: 'Current post-restore edit', summary: '', blocks: [] })
    current.destroy()
    const readEpoch = () => {
      const db = new Database(paths.database, { readonly: true, fileMustExist: true })
      try { return db.prepare('SELECT recovery_epoch FROM synced_workspace_state WHERE singleton=1').pluck().get() }
      finally { db.close() }
    }
    const beforeEpoch = readEpoch(), beforeInventory = await restoreInventory(paths.storage)
    const beforeFence = await readFile(paths.fence), beforeResult = await readFile(paths.result)
    const beforeDirectories = (await readdir(dirname(paths.recovery))).sort()
    assert.equal(typeof beforeEpoch, 'string')
    const unexpectedConfirmation = async () => { throw new Error('A replay cannot confirm again') }
    assert.deepEqual(await restoreControlledBackupV3(input, legacy, unexpectedConfirmation), installed)
    assert.equal(stopped, 1)
    assert.equal(confirmed, 1)
    const wrongHash = expectedInventoryHash.replace(/^./, digit => digit === '0' ? '1' : '0')
    await assert.rejects(restoreControlledBackupV3({ ...input, expectedInventoryHash: wrongHash }, legacy), /备份路径或库存指纹不同/)
    await assert.rejects(restoreControlledBackupV3({ ...input, backupDirectory: backupDirectory + '-retired' }, legacy), /备份路径或库存指纹不同/)
    await writeFile(paths.result, Buffer.concat([beforeResult, Buffer.from(' ')]))
    try { await assert.rejects(restoreControlledBackupV3(input, legacy), /恢复记录不是原canonical JSON/) }
    finally { await writeFile(paths.result, beforeResult) }
    assert.deepEqual(await restoreInventory(paths.storage), beforeInventory)
    assert.deepEqual(await readFile(paths.fence), beforeFence)
    assert.deepEqual((await readdir(dirname(paths.recovery))).sort(), beforeDirectories)
    assert.equal(readEpoch(), beforeEpoch)
  } finally {
    assert.equal(dirname(await realpath(folder)), await realpath(tmpdir()))
    await rm(folder, { recursive: true, force: true })
  }
})
