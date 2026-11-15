import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeSyncedBackupV3 } from '../../src/main/backup/v3-export'
import { KnowbookStore } from '../../src/main/database/store'

export const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('Unexpected legacy recovery') } }
export const hostCursorSql = 'SELECT _rowid_ AS rowid, cursor, position FROM synced_host_history_state WHERE document_id=?'

export async function createDonor(folder: string) {
  const backup = join(folder, 'v3-backup'), donorRoot = join(folder, 'donor')
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const id = donor.createDocument(null)
    donor.updateDocument(id, { title: 'Independent recovery source', summary: '', blocks: [] })
    writeSyncedBackupV3(donor.getUnsafeDatabaseHandle(), { userDataRoot: donorRoot, destination: backup, snapshotId: randomUUID() })
  } finally { donor.destroy() }
  return backup
}
