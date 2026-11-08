import type Database from 'better-sqlite3'
import type { DocumentBlockDraft } from '../../shared/contracts'
import { editorRecoveryInvalid, type EditorRecoveryHostSourcePins } from '../../shared/editor-recovery-drafts'
import { parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { readRawSyncedGroupSnapshotsOwned } from '../database/synced-blocks-raw-read'
import { assertSyncedRecoveryBoundaryRecords } from '../database/synced-recovery-boundary-read'

/** Read in the same Main-owned snapshot as the complete persisted host.
 * Only original persisted references enter the local dependency fence. */
export function captureHostSourcePinsOwned(db: Database.Database, documentId: string,
  blocks: readonly DocumentBlockDraft[]): EditorRecoveryHostSourcePins | undefined {
  if (!db.inTransaction) return editorRecoveryInvalid('host Source pins require an actual Main snapshot')
  const references = new Map<string, string>()
  for (const block of blocks) if (block.type === 'synced-block') {
    if (!block.id || references.has(block.id)) return editorRecoveryInvalid('host Source original reference identity differs')
    references.set(block.id, parseSyncedBlockPayload(block.content).groupId)
  }
  if (!references.size) return undefined
  assertSyncedRecoveryBoundaryRecords(db)
  const registered = db.prepare(`SELECT i.instance_id,i.group_id,b.created_at FROM synced_instances i
    LEFT JOIN blocks b ON b.id=i.instance_id WHERE i.host_document_id=? ORDER BY i.instance_id`)
    .all(documentId) as Array<{ instance_id: string; group_id: string; created_at: string | null }>
  if (registered.length !== references.size || registered.some(row => !row.created_at || references.get(row.instance_id) !== row.group_id)) {
    return editorRecoveryInvalid('host Source original physical reference closure differs')
  }
  const groups = new Map<string, typeof registered>()
  for (const row of registered) {
    const instances = groups.get(row.group_id) ?? []
    instances.push(row)
    groups.set(row.group_id, instances)
  }
  const groupIds = [...groups.keys()].sort(), snapshots = readRawSyncedGroupSnapshotsOwned(db, groupIds)
  return { groups: groupIds.map(groupId => {
    const snapshot = snapshots.get(groupId)
    if (!snapshot) return editorRecoveryInvalid('host Source original active group missing')
    const byInstanceId = new Map(snapshot.instances.map(instance => [instance.instanceId, instance]))
    const instances = groups.get(groupId)!.map(row => {
      const instance = byInstanceId.get(row.instance_id)
      if (!instance || instance.hostDocumentId !== documentId || !row.created_at) return editorRecoveryInvalid('host Source original instance missing')
      return { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion,
        parentBlockId: instance.parentBlockId, depth: instance.depth, parentType: instance.parentType, createdAt: row.created_at }
    })
    return { groupId, creationId: snapshot.creationId, createdAt: snapshot.createdAt, revision: snapshot.revision,
      topologyRevision: snapshot.topologyRevision, historyCursor: snapshot.history.cursor, instances }
  }) }
}
