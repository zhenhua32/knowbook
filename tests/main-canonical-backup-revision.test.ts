import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readCanonicalBackupRevision } from '../src/main/database/canonical-backup-revision'
import { readConfirmedSyncedBackupV3PublicationOwned } from '../src/main/database/synced-backup-v3-publication-read'
import { withV3Fixture, randomUUID, snapshot } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'

test('complete runtime backup revision sees true canonical-only edits and CAS while its own actual V3 publication does not self-invalidate', () => withV3Fixture(f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file)
  try {
    const db = store.getUnsafeDatabaseHandle(), first = store.getBackupRevision()
    const ordinaryBefore = db.prepare('SELECT id,updated_at FROM documents ORDER BY id').all()
    const saved = editCreatedGroup(db, f.groupId)
    assert.equal(saved.status, 'saved')
    assert.deepEqual(db.prepare('SELECT id,updated_at FROM documents ORDER BY id').all(), ordinaryBefore, 'Only the canonical body/CAS/history changed')
    const second = store.getBackupRevision()
    assert.notEqual(second, first)
    assert.equal(second, readCanonicalBackupRevision(f.connect()), 'Independent native SQL snapshot reads the same complete revision')
    const snapshotId = randomUUID()
    writeSyncedBackupV3(db, {userDataRoot:f.userDataRoot,destination:f.destination,snapshotId})
    assert.equal(store.getBackupRevision(), second, 'Actual exposure/confirmed claim metadata does not start another identical backup')
    const hash = store.readConfirmedCanonicalBackup(snapshotId, f.destination)
    assert.match(hash, /^[a-f0-9]{64}$/)
    assert.throws(() => store.readConfirmedCanonicalBackup(snapshotId, f.destination + '-other'), /exact confirmed/)
    assert.throws(() => store.readConfirmedCanonicalBackup(randomUUID(), f.destination), /exact confirmed/)
    const connection = f.connect()
    assert.equal(connection.transaction(() => readConfirmedSyncedBackupV3PublicationOwned(connection, snapshotId, f.destination))(), hash)
    assert.equal(snapshot(db, f.groupId).revision, saved.snapshot.revision)
  } finally { store.destroy() }
}))
