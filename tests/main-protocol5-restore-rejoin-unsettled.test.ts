import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { KnowbookStore } from '../src/main/database/store'
import { runProtocol5WebDav } from '../src/main/sync/protocol5-service'
import { prepareProtocol5RestoreRejoin } from '../src/main/sync/protocol5-restore-rejoin-read'
import { INITIAL_PUBLICATION_RECEIPT_KIND } from '../src/main/database/synced-initial-publication-receipt'
import { exchangeStateKey, exchangeTargetFingerprint } from '../src/main/sync/synced-exchange-model'
import { runtime } from './helpers/synced-exchange-fixture'
import { withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('an original publication without its accepted remote version cannot authorize WebDAV rejoin after restoring V3', () => withIncomingFixture(async fixture => {
  const { A, targetConfig, server } = fixture
  const donorRoot = join(fixture.folder, 'published-only-donor'), archive = join(fixture.folder, 'before-exchange')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try { writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: archive, snapshotId: randomUUID() }) }
  finally { donor.destroy() }
  A.db.close()
  const publisher = KnowbookStore.openCanonicalRuntime(A.file)
  try {
    await runProtocol5WebDav(publisher, A.root, targetConfig, runtime)
    assert.equal(publisher.getSettingPublic(exchangeStateKey(exchangeTargetFingerprint(targetConfig))), null)
    // Retain the original attempt, group members and spool with the shape of a publication made before accepted ETags were saved.
    assert.equal(publisher.getUnsafeDatabaseHandle().prepare("DELETE FROM synced_operations WHERE json_extract(result_json,'$.kind')=?")
      .run(INITIAL_PUBLICATION_RECEIPT_KIND).changes, 1)
  } finally { publisher.destroy() }
  const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
  await restoreControlledBackupV3({ userDataRoot: A.root, backupDirectory: archive, stopProcesses: async () => [] }, legacy)
  assert.equal(await recoverControlledDatabaseRestore(A.root, legacy.recoverLegacy), true)
  const reopened = KnowbookStore.openCanonicalRuntime(A.file)
  try {
    const requests = server.requests.length
    await assert.rejects(prepareProtocol5RestoreRejoin(reopened.getUnsafeDatabaseHandle(), A.root, targetConfig, runtime), /缺原已结算的交换状态/)
    assert.equal(server.requests.length, requests)
  } finally { reopened.destroy() }
}))
