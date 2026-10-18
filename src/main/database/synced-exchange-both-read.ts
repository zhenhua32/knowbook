import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { bothPreviewKey, validateBothPreviewIndex, type BothPreviewIndex } from '../sync/synced-exchange-both-model'
import { parseExchangeStored, type ExchangeRequest } from '../sync/synced-exchange-model'
import type { SyncedBothAllocation, SyncedExchangeBothPublishedBlock } from '../sync/synced-exchange-both-types'
import { publicationCompare, publicationInvalid, publicationJson, SyncedPublicationError } from '../sync/synced-publication-model'

function owned(db: Database.Database): void {
  if (!db.open || db.readonly) throw new SyncedPublicationError('unavailable', 'both需要原writable connection。')
  if (!db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('both denial/read需要owned/FK事务。')
}
export function readSyncedBothPreviewIndex(db: Database.Database, previewId: string, request: ExchangeRequest): BothPreviewIndex | null {
  owned(db)
  const row = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(bothPreviewKey(previewId)) as { value: string; updated_at: string } | undefined
  if (!row) return null
  const result = validateBothPreviewIndex(parseExchangeStored(row.value))
  if (result.previewId !== previewId || result.databasePath !== request.databasePath || result.targetFingerprint !== request.targetFingerprint
    || result.createdAt !== row.updated_at || row.value !== publicationJson(result)) return publicationInvalid('both原preview索引损坏/目标混用。')
  return result
}

/** Denial only. IDs come from Main's authenticated immutable map; this never recognizes a local row as an owned partial installation. */
export function readSyncedBothIdentityCollisions(db: Database.Database, allocation: SyncedBothAllocation,
  occupiedDocumentIds: readonly string[]): SyncedExchangeBothPublishedBlock['collisions'] {
  owned(db)
  const collisions: SyncedExchangeBothPublishedBlock['collisions'] = []
  const add = (kind: SyncedExchangeBothPublishedBlock['collisions'][number]['kind'], id: string) => collisions.push({ kind, id })
  const documents = new Set(occupiedDocumentIds)
  for (const row of db.prepare('SELECT id FROM documents').all() as Array<{ id: string }>) documents.add(row.id)
  for (const row of allocation.documents) if (documents.has(row.documentId)) add('document', row.documentId)
  const groups = new Set<string>(), creations = new Set<string>()
  for (const row of db.prepare('SELECT id,creation_id FROM synced_groups').all() as Array<{ id: string; creation_id: string }>) { groups.add(row.id); creations.add(row.creation_id) }
  for (const row of db.prepare('SELECT group_id,creation_id FROM synced_group_lifecycle').all() as Array<{ group_id: string; creation_id: string }>) { groups.add(row.group_id); creations.add(row.creation_id) }
  for (const row of allocation.groups) {
    if (groups.has(row.groupId)) add('group', row.groupId)
    if (creations.has(row.creationId)) add('group', row.creationId)
  }
  const physicalIds = [...allocation.blocks.map(row => row.blockId), ...allocation.instances.map(row => row.instanceId), ...allocation.missing.map(row => row.id)]
  const instanceIds = new Set(allocation.instances.map(row => row.instanceId)), physical = new Set<string>()
  if (physicalIds.length) {
    const values = publicationJson(physicalIds)
    for (const row of db.prepare('SELECT id FROM block_identities WHERE id IN(SELECT value FROM json_each(?)) UNION SELECT id FROM blocks WHERE id IN(SELECT value FROM json_each(?)) UNION SELECT id FROM synced_group_blocks WHERE id IN(SELECT value FROM json_each(?))').all(values, values, values) as Array<{ id: string }>) physical.add(row.id)
    for (const id of physical) add(instanceIds.has(id) ? 'instance' : 'block', id)
  }
  const entities = allocation.entities.map(row => row.entityId)
  if (entities.length) for (const row of db.prepare('SELECT id FROM database_entities WHERE id IN(SELECT value FROM json_each(?))').all(publicationJson(entities)) as Array<{ id: string }>) add('entity', row.id)
  // A fresh candidate is not allowed to reuse a known identity from a different role either.
  const minted = new Map<string, SyncedExchangeBothPublishedBlock['collisions'][number]['kind']>([
    ...allocation.documents.map(row => [row.documentId, 'document'] as const), ...allocation.groups.flatMap(row => [[row.groupId, 'group'] as const, [row.creationId, 'group'] as const]),
    ...allocation.blocks.map(row => [row.blockId, 'block'] as const), ...allocation.instances.map(row => [row.instanceId, 'instance'] as const),
    ...allocation.entities.map(row => [row.entityId, 'entity'] as const), ...allocation.missing.map(row => [row.id, 'block'] as const)
  ])
  if (minted.size) {
    const ids = publicationJson([...minted.keys()])
    const occupied = db.prepare(`SELECT id FROM documents WHERE id IN(SELECT value FROM json_each(?))
      UNION SELECT id FROM synced_groups WHERE id IN(SELECT value FROM json_each(?))
      UNION SELECT creation_id AS id FROM synced_group_lifecycle WHERE creation_id IN(SELECT value FROM json_each(?))
      UNION SELECT id FROM block_identities WHERE id IN(SELECT value FROM json_each(?))
      UNION SELECT id FROM database_entities WHERE id IN(SELECT value FROM json_each(?))`).all(ids, ids, ids, ids, ids) as Array<{ id: string }>
    for (const row of occupied) add(minted.get(row.id)!, row.id)
    for (const id of occupiedDocumentIds) if (minted.has(id)) add(minted.get(id)!, id)
  }
  // Stable creation IDs are not a license to adopt another incarnation or malformed private marker.
  if (allocation.groups.some(row => !isSyncedUuid(row.groupId) || !isSyncedUuid(row.creationId))) return publicationInvalid('both固定group map损坏。')
  return [...new Map(collisions.map(row => [publicationJson([row.kind, row.id]), row])).values()]
    .sort((left, right) => publicationCompare(publicationJson([left.kind, left.id]), publicationJson([right.kind, right.id])))
}
