import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import test from 'node:test'
import { restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { assertSyncedLogicalDeletionRecords } from '../src/main/database/synced-logical-deletion-read'
import { createDonor, hostCursorSql, legacy } from './helpers/synced-backup-v3-deleted-host-fixture'
import { withKnowledge } from './helpers/synced-exchange-knowledge-fixture'

test('an orphan host cursor without a matching logical tombstone cannot enter a V3 recovery boundary', () => withKnowledge(async fixture => {
  const db = fixture.B.db, unknownHost = randomUUID()
  db.prepare('INSERT INTO synced_host_history_state(document_id,cursor,position) VALUES(?,?,0)').run(unknownHost, randomUUID())
  assert.ok(db.prepare(hostCursorSql).get(unknownHost))
  assert.equal(db.transaction(() => assertSyncedLogicalDeletionRecords(db).has('doc:' + unknownHost))(), false)
  const backup = await createDonor(fixture.folder)
  db.close()
  const original = await readFile(fixture.B.file)
  const identity = await lstat(fixture.B.file, { bigint: true })
  await assert.rejects(restoreControlledBackupV3({ userDataRoot: fixture.B.root, backupDirectory: backup,
    stopProcesses: async () => [] }, legacy), /原 current 的 B\/R 未由现有格式完整表达/)
  assert.deepEqual(await readFile(fixture.B.file), original)
  assert.equal((await lstat(fixture.B.file, { bigint: true })).ino, identity.ino)
}))
