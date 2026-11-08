import type Database from 'better-sqlite3'
import { parseSyncedCanonicalBlockAddress, type SyncedCanonicalBlockNavigationResult } from '../../shared/synced-canonical-block-address'
import { readRawSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { assertCanonicalSearchSnapshotOwned, canonicalSearchOccurrencesSql, occurrenceFromCanonicalSearchRow,
  validateCanonicalSearchPageOwned, type CanonicalSearchOccurrenceRow } from './workspace-search-occurrences'

/** This read resolves only the explicit canonical address. An ordinary path
 * or an old block route cannot participate in the lookup. */
export function resolveSyncedCanonicalBlockAddress(db: Database.Database, input: unknown): SyncedCanonicalBlockNavigationResult {
  const address = parseSyncedCanonicalBlockAddress(input)
  if (!address) return { status: 'invalid-address' }
  return db.transaction((): SyncedCanonicalBlockNavigationResult => {
    assertCanonicalSearchSnapshotOwned(db)
    const rows = db.prepare(`SELECT * FROM (${canonicalSearchOccurrencesSql}) WHERE group_id=? AND block_id=? LIMIT 2`)
      .all(address.groupId, address.blockId) as CanonicalSearchOccurrenceRow[]
    if (rows.length) {
      const first = rows[0]
      if (first.creation_id !== address.creationId || first.group_created_at !== address.groupCreatedAt
        || first.canonical_created_at !== address.blockCreatedAt) return { status: 'target-mismatch' }
      validateCanonicalSearchPageOwned(db, rows)
      return rows.length === 1 ? { status: 'ready', occurrence: occurrenceFromCanonicalSearchRow(first) } : { status: 'ambiguous-instance' }
    }

    // A real orphan has no occurrence row but still owns its canonical blocks.
    const group = readRawSyncedGroupSnapshotsOwned(db, [address.groupId]).get(address.groupId)
    if (!group) return { status: 'missing-target' }
    if (group.creationId !== address.creationId || group.createdAt !== address.groupCreatedAt) return { status: 'target-mismatch' }
    const block = group.blocks.find(item => item.id === address.blockId)
    if (!block) return { status: 'missing-target' }
    if (block.createdAt !== address.blockCreatedAt) return { status: 'target-mismatch' }
    if (group.instances.length) throw new Error('已登记的同步正文块缺少同一次读取中的实际实例。')
    return { status: 'no-instance' }
  })()
}
