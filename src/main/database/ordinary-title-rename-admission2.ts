import type Database from 'better-sqlite3'
import type { DocumentRenameAdmissionInput, DocumentRenameAdmissionResult } from '../../shared/document-rename-admission'
import { assertSyncedShape, isSyncedBlockId, SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { assertCanonicalSearchSnapshotOwned } from './workspace-search-occurrences'
import { assertSyncedStoredBindings } from './synced-stored-binding-read'
import { resolveRawLiveBlockOwner } from './block-identities-raw-read'

export class OrdinaryRenameRequiresTitle2 extends Error {
  readonly code = 'ordinary-rename-requires-fenced-title2'
  constructor() {
    super('This rename affects actual captured canonical targets and requires the fenced title writer; the complete draft is retained.')
    this.name = 'OrdinaryRenameRequiresTitle2'
  }
}

/** Actual SQL snapshot only. A false hint cannot bypass the ordinary writer's
 * fresh same-transaction call. No caller group list, URI map or cached rows. */
export function readDocumentRenameAdmissionOwned2(db: Database.Database, value: unknown): DocumentRenameAdmissionResult {
  if (!db.open || !db.inTransaction) throw new Error('Document rename admission requires its actual owned SQL snapshot')
  assertSyncedShape(value, ['documentId', 'expectedUpdatedAt'], ['headingSlugs'])
  if (!isSyncedBlockId(value.documentId) || typeof value.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(value.expectedUpdatedAt)))
    throw new Error('Invalid document rename admission address')
  if (value.headingSlugs !== undefined && (!Array.isArray(value.headingSlugs) || value.headingSlugs.length > SYNCED_MAX_BLOCKS
    || value.headingSlugs.some(slug => typeof slug !== 'string') || new Set(value.headingSlugs).size !== value.headingSlugs.length))
    throw new Error('Invalid section heading admission fragments')
  const input = value as unknown as DocumentRenameAdmissionInput
  const headings = input.headingSlugs === undefined ? null : new Set(input.headingSlugs)
  const document = db.prepare('SELECT id,created_at,updated_at FROM documents WHERE id=?').get(input.documentId) as
    { id: string; created_at: string; updated_at: string } | undefined
  if (!document) return { status: 'missing' }
  if (document.updated_at !== input.expectedUpdatedAt) return { status: 'stale' }
  if (!Number.isFinite(Date.parse(document.created_at))) throw new Error('Actual rename target birth is invalid')
  const result = (requiresFencedTitle2: boolean): DocumentRenameAdmissionResult => ({ status: 'ready', documentId: document.id,
    documentCreatedAt: document.created_at, updatedAt: document.updated_at, requiresFencedTitle2, writePermit: false })
  if (headings?.size === 0) return result(false)
  const groupIds = (db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
  if (!groupIds.length) return result(false)
  assertCanonicalSearchSnapshotOwned(db)
  const affected = new Set<string>()
  if (!headings) {
    const rows = db.prepare('SELECT id,parent_id FROM documents ORDER BY id').all() as Array<{ id: string; parent_id: string | null }>
    const children = new Map<string, string[]>()
    for (const row of rows) if (row.parent_id !== null) {
      const list = children.get(row.parent_id) ?? []; list.push(row.id); children.set(row.parent_id, list)
    }
    const queue = [document.id]
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]
      if (affected.has(id)) throw new Error('Actual rename descendant graph is cyclic')
      affected.add(id); queue.push(...children.get(id) ?? [])
    }
  }
  let required = false
  for (let start = 0; start < groupIds.length; start += SYNCED_MAX_BLOCKS) {
    for (const item of getSyncedGroupSnapshots(db, { groupIds: groupIds.slice(start, start + SYNCED_MAX_BLOCKS) }).items) {
      if (item.status !== 'ready') continue // Same current-group domain as the title2 native workspace reader.
      const group = item.snapshot
      assertSyncedStoredBindings(db, group.origin, group.blocks, group.bindings)
      for (const { target } of group.bindings) {
        if (headings) required ||= target.kind === 'heading' && target.documentId === document.id && headings.has(target.slug)
        else if (target.kind === 'document') required ||= affected.has(target.id)
        else if (target.kind === 'heading') required ||= affected.has(target.documentId)
        else if (target.kind === 'block') {
          const owner = resolveRawLiveBlockOwner(db, target.id)
          required ||= owner?.kind === 'document' && affected.has(owner.id)
        }
      }
    }
  }
  return result(required)
}
