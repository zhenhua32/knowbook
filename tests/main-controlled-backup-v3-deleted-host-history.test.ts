import assert from 'node:assert/strict'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { copyRestoreInventory, restoreInventory } from '../src/main/database/restore-safety-files'
import { KnowbookStore } from '../src/main/database/store'
import { assertSyncedLogicalDeletionRecords } from '../src/main/database/synced-logical-deletion-read'
import { assertSyncedRecoveryBoundaryRecords } from '../src/main/database/synced-recovery-boundary-read'
import { withKnowledge } from './helpers/synced-exchange-knowledge-fixture'
import { createDonor, hostCursorSql, legacy } from './helpers/synced-backup-v3-deleted-host-fixture'

test('V3 recovery retains the exact deleted host row and tombstone while cutting the workspace epoch and cursor', () => withKnowledge(async fixture => {
  const before = fixture.B.db.prepare(hostCursorSql)
    .get(fixture.host) as { rowid: number; cursor: string; position: number }
  assert.ok(before)
  const workspace = 'SELECT workspace_scope, recovery_epoch FROM synced_workspace_state WHERE singleton=1'
  const beforeWorkspace = fixture.B.db.prepare(workspace).get() as { workspace_scope: string; recovery_epoch: string }
  const oldDeletion = fixture.B.db.transaction(() => assertSyncedLogicalDeletionRecords(fixture.B.db).get(fixture.denialKey))()
  assert.ok(oldDeletion)
  const backupDirectory = await createDonor(fixture.folder)
  fixture.B.db.close()
  const installed = await restoreControlledBackupV3({ userDataRoot: fixture.B.root, backupDirectory, stopProcesses: async () => [] }, legacy)
  assert.equal(installed.status, 'installed')
  const original = join(installed.recoveryDirectory, 'original'), originalCopy = join(fixture.folder, 'pre-install-sql-oracle')
  await copyRestoreInventory(original, originalCopy, await restoreInventory(original), fixture.folder)
  const originalDb = new Database(join(originalCopy, 'knowbook.db'), { readonly: true, fileMustExist: true })
  try {
    originalDb.pragma('query_only=ON'); originalDb.pragma('foreign_keys=ON')
    originalDb.transaction(() => {
      assert.deepEqual(originalDb.prepare(workspace).get(), beforeWorkspace)
      assert.deepEqual(originalDb.prepare(hostCursorSql).get(fixture.host), before)
      assert.deepEqual(assertSyncedLogicalDeletionRecords(originalDb).get(fixture.denialKey), oldDeletion)
    })()
  } finally { originalDb.close() }
  await rename(backupDirectory, backupDirectory + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(fixture.B.root, legacy.recoverLegacy), true)
  const store = KnowbookStore.openCanonicalRuntime(fixture.B.file)
  try {
    assert.equal(store.getDocumentDetail(fixture.host), null)
    const db = store.getUnsafeDatabaseHandle()
    db.transaction(() => {
      const after = db.prepare(hostCursorSql).get(fixture.host) as typeof before
      assert.equal(after.rowid, before.rowid)
      assert.equal(after.position, 0)
      assert.notEqual(after.cursor, before.cursor)
      assert.deepEqual(assertSyncedLogicalDeletionRecords(db).get(fixture.denialKey), oldDeletion)
      const cut = assertSyncedRecoveryBoundaryRecords(db).boundaries.get(installed.operationId)
      const afterWorkspace = db.prepare(workspace).get() as typeof beforeWorkspace
      assert.equal(afterWorkspace.workspace_scope, beforeWorkspace.workspace_scope)
      assert.notEqual(afterWorkspace.recovery_epoch, beforeWorkspace.recovery_epoch)
      assert.equal(cut?.beforeEpoch, beforeWorkspace.recovery_epoch)
      assert.equal(cut?.afterEpoch, afterWorkspace.recovery_epoch)
      assert.deepEqual(cut?.hosts.find(row => row.documentId === fixture.host), { documentId: fixture.host,
        beforeCursor: before.cursor, beforePosition: before.position, afterCursor: after.cursor })
      assert.ok(!cut?.documents.some(row => row.documentId === fixture.host))
    })()
  } finally { store.destroy() }
}))

