import type Database from 'better-sqlite3'
import type { KnowbookStore } from '../database/store'
import { canonicalJson, recordKey, validateRecord, SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncRecord, type SyncRow, type SyncDatabases, type SyncDocument } from './model'

/** A complete remote move cannot be applied until its old owner has an
 * explicit releasing version. This carries identity, never user text matching. */
export class SyncBlockOwnershipError extends Error {
  constructor(readonly dependencyDocumentId: string, readonly dependency: 'release' | 'receive' | 'publish-duplicate' | 'publish-loss' = 'release',
    readonly relatedDocumentIds: readonly string[] = [dependencyDocumentId]) {
    super(dependency === 'release' ? '同步批次缺少原文档释放块 ID 的版本，请先处理相关文档冲突后重试。'
      : dependency === 'receive' ? '同步批次缺少目标文档接收块 ID 的版本，请先处理相关文档冲突后重试。'
        : dependency === 'publish-duplicate' ? '同步发布会让两个文档持有同一块 ID，请一起处理移动双方的冲突后重试。'
          : '同步发布会丢失归属冲突中的块 ID，请一起处理移动双方的冲突后重试。')
    this.name = 'SyncBlockOwnershipError'
  }
}

type SyncBlockTransferPlan = { id: string; fromId: string; fromPath: string; toId: string }

/** Read-only preflight is also used before remote manifest publication. */
export function preflightSyncBlockTransfers(db: Database.Database, records: SyncRecord[], deferredDocuments: SyncDocument[] = []): SyncBlockTransferPlan[] {
  const documentIds = new Set(records.filter(record => record.kind === 'document').map(record => record.id))
  const deletedIds = new Set(records.filter(record => record.kind === 'deleted').map(record => record.id))
  const keys = new Set<string>(), incomingOwners = new Map<string, string>()
  for (const record of records) {
    validateRecord(record, recordKey(record))
    const key = recordKey(record)
    if (keys.has(key)) throw new Error('同步批次包含重复文档，未修改本地数据。')
    keys.add(key)
    if (record.kind !== 'document') continue
    for (const block of record.content.blocks) {
      if (incomingOwners.has(block.id!)) throw new Error('同步批次包含重复块 ID，未修改本地数据。')
      incomingOwners.set(block.id!, record.id)
    }
  }
  const transfers: SyncBlockTransferPlan[] = []
  const existingOwner = db.prepare('SELECT block.document_id AS id, document.path FROM blocks AS block JOIN documents AS document ON document.id = block.document_id WHERE block.id = ?')
  for (const [id, toId] of incomingOwners) {
    const old = existingOwner.get(id) as { id: string; path: string } | undefined
    if (!old || old.id === toId) continue
    if (!deletedIds.has(old.id) && !documentIds.has(old.id)) throw new SyncBlockOwnershipError(old.id)
    transfers.push({ id, fromId: old.id, fromPath: old.path, toId })
  }
  // A receiving target can be held back by its own conflict. Do not delete the
  // source projection before the complete paired target version is accepted.
  const pendingOwners = new Map<string, string>()
  for (const document of deferredDocuments) {
    validateRecord(document, recordKey(document))
    for (const block of document.content.blocks) pendingOwners.set(block.id!, document.id)
  }
  const participating = [...new Set([...documentIds, ...deletedIds])]
  if (pendingOwners.size && participating.length) {
    const oldBlocks = db.prepare('SELECT id, document_id FROM blocks WHERE document_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(participating)) as Array<{ id: string; document_id: string }>
    for (const block of oldBlocks) {
      const pending = pendingOwners.get(block.id)
      if (pending && pending !== block.document_id && !incomingOwners.has(block.id) && !documentIds.has(pending)) {
        throw new SyncBlockOwnershipError(pending, 'receive')
      }
    }
  }
  return transfers
}

/** Validate the final remote projection, including versions withheld by conflicts.
 * Applying only incoming versions cannot detect a partially published local move. */
export function preflightSyncPublishedBlockOwnership(local: Iterable<SyncRecord>, remote: Iterable<SyncRecord>, published: Iterable<SyncRecord>, writtenIds: ReadonlySet<string>): void {
  const owners = (records: Iterable<SyncRecord>, final: boolean): Map<string, string> => {
    const result = new Map<string, string>()
    for (const record of records) {
      validateRecord(record, recordKey(record))
      if (record.kind !== 'document') continue
      for (const block of record.content.blocks) {
        const owner = result.get(block.id!)
        if (owner && owner !== record.id) {
          if (!final) throw new Error('同步文档版本包含重复块 ID，未发布清单。')
          const dependency = !writtenIds.has(owner) ? owner : record.id
          throw new SyncBlockOwnershipError(dependency, 'publish-duplicate', [owner, record.id])
        }
        result.set(block.id!, record.id)
      }
    }
    return result
  }
  const localOwners = owners(local, false), remoteOwners = owners(remote, false), finalOwners = owners(published, true)
  for (const [id, localOwner] of localOwners) {
    const remoteOwner = remoteOwners.get(id)
    if (remoteOwner && remoteOwner !== localOwner && !finalOwners.has(id)) {
      // Ordinary intentional block deletion remains valid. Owner disagreement
      // means this ID is in a move whose opposite conflict is still retained.
      const dependency = !writtenIds.has(localOwner) ? localOwner : remoteOwner
      throw new SyncBlockOwnershipError(dependency, 'publish-loss', [localOwner, remoteOwner])
    }
  }
}

/** Only knowledge data is exported. Credentials, plugins and machine settings never enter the protocol. */
export class SyncRepository {
  constructor(private readonly db: Database.Database, private readonly store: KnowbookStore, private readonly catalogId: () => string) {}

  snapshot(): Map<string, SyncRecord> {
    const records = new Map<string, SyncRecord>()
    const documents = this.db.prepare('SELECT id, parent_id, sort_order, created_at FROM documents ORDER BY id').all() as Array<{
      id: string; parent_id: string | null; sort_order: number; created_at: string
    }>
    for (const row of documents) records.set(`doc:${row.id}`, {
      kind: 'document', id: row.id, parentId: row.parent_id, sortOrder: row.sort_order,
      createdAt: row.created_at, content: this.store.documentRecovery.readContent(row.id)
    })
    const catalogId = this.catalogId()
    const tables = Object.fromEntries(SYNC_TABLES.map(table => [table,
      (this.db.prepare(`SELECT ${SYNC_TABLE_COLUMNS[table].join(',')} FROM ${table}`).all() as SyncRow[])
        .map(row => {
          if (table === 'databases' && row.id === catalogId) {
            row.id = 'catalog'
            // Each installation creates this implicit database independently.
            row.created_at = '1970-01-01T00:00:00.000Z'
          }
          if (row.database_id === catalogId) row.database_id = 'catalog'
          return row
        }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en'))
    ])) as SyncDatabases['tables']
    records.set('databases', { kind: 'databases', id: 'databases', tables })
    return records
  }

  /** Caller commits sync cursors in this same SQLite transaction. */
  apply(records: SyncRecord[]): void {
    const now = new Date().toISOString()
    const documents = records.filter((record): record is SyncDocument => record.kind === 'document')
    const documentIds = new Set(documents.map(record => record.id))
    const deletedIds = new Set(records.filter(record => record.kind === 'deleted').map(record => record.id))
    const transfers = preflightSyncBlockTransfers(this.db, records)
    const deleted = records.filter(record => record.kind === 'deleted' && this.store.getDocumentSnapshot(record.id))
    // Archive every row before a transfer or cascade changes its original data.
    for (const record of deleted) this.store.documentRecovery.archive(record.id)
    // Stage all IDs before parent links so directory order and simultaneous moves are safe.
    for (const record of documents) {
      if (this.store.getDocumentSnapshot(record.id)) this.store.documentRecovery.checkpoint(record.id, 'restore')
      else this.db.prepare(`INSERT INTO documents (id, title, slug, parent_id, path, summary, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, '', ?, ?, ?)`).run(record.id, record.content.title, `doc-${record.id}`, record.content.title, record.sortOrder, record.createdAt, now)
    }
    // Clear both old-owner projections before any target can index a moved ID.
    // The bulk mutation rebuilds all projections only after every owner is final.
    const clearSources = this.db.prepare('DELETE FROM markdown_link_sources WHERE source_document_id = ?')
    for (const id of new Set([...documentIds, ...deletedIds])) clearSources.run(id)
    const route = this.db.prepare('INSERT OR IGNORE INTO document_block_routes (document_path, block_id) VALUES (?, ?)')
    const transfer = this.db.prepare('UPDATE blocks SET document_id = ? WHERE id = ? AND document_id = ?')
    for (const move of transfers) {
      // Protocol v1 does not export historical routes. Preserve the old path
      // observed on this device; never invent routes for an unseen history.
      route.run(move.fromPath, move.id)
      if (transfer.run(move.toId, move.id, move.fromId).changes !== 1) throw new Error('同步块归属已变化，未修改本地数据。')
    }
    // A deleted source can now cascade only its remaining blocks.
    for (const record of deleted) this.db.prepare('DELETE FROM documents WHERE id = ?').run(record.id)
    const metadata = this.db.prepare('SELECT id, title, parent_id, path, updated_at FROM documents ORDER BY id').all() as Array<{
      id: string; title: string; parent_id: string | null; path: string; updated_at: string
    }>
    const before = new Map(metadata.map(row => [row.id, { ...row }]))
    const byId = new Map(metadata.map(row => [row.id, row]))
    for (const record of documents) {
      const row = byId.get(record.id)!
      row.title = record.content.title.trim()
      row.parent_id = record.parentId && byId.has(record.parentId) ? record.parentId : null
    }
    // Concurrent moves may create a cycle even when both individual edits were valid.
    for (const row of metadata) {
      const seen = new Set([row.id])
      let parent = row.parent_id
      while (parent) {
        if (seen.has(parent)) { row.parent_id = null; break }
        seen.add(parent)
        parent = byId.get(parent)?.parent_id ?? null
      }
    }
    const siblingNames = new Set<string>()
    for (const row of metadata) {
      const base = row.title
      let suffix = 1
      while (siblingNames.has(`${row.parent_id}\0${row.title}`)) row.title = `${base} (${suffix++})`
      siblingNames.add(`${row.parent_id}\0${row.title}`)
    }
    const paths = new Map<string, string>()
    const pathFor = (id: string): string => {
      const cached = paths.get(id)
      if (cached !== undefined) return cached
      const chain: typeof metadata = []
      let next: string | null = id
      while (next && !paths.has(next)) { const row: typeof metadata[number] = byId.get(next)!; chain.push(row); next = row.parent_id }
      for (const row of chain.reverse()) paths.set(row.id, row.parent_id ? `${paths.get(row.parent_id)}/${row.title}` : row.title)
      return paths.get(id)!
    }
    const transferredIds = JSON.stringify(transfers.map(move => move.id))
    const rememberPath = this.db.prepare(`INSERT OR IGNORE INTO document_block_routes (document_path, block_id)
      SELECT ?, id FROM blocks WHERE document_id = ? AND id NOT IN (SELECT value FROM json_each(?))`)
    for (const row of metadata) {
      const old = before.get(row.id)!, path = pathFor(row.id)
      if (old.parent_id === row.parent_id && old.title === row.title && old.path === path) continue
      // Preserve only pairs this receiver actually observed before the batch.
      // Incoming transferred IDs never existed at the target's old path; their
      // actual previous-owner route was recorded before changing ownership.
      if (old.path !== path) rememberPath.run(old.path, row.id, transferredIds)
      if (old.title !== row.title && !documentIds.has(row.id)) this.store.documentRecovery.checkpoint(row.id, 'restore')
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(old.updated_at) + 1)).toISOString()
      this.db.prepare('UPDATE documents SET parent_id = ?, title = ?, path = ?, updated_at = ? WHERE id = ?')
        .run(row.parent_id, row.title, path, updatedAt, row.id)
    }
    for (const record of documents) {
      const current = this.db.prepare('SELECT updated_at FROM documents WHERE id = ?').get(record.id) as { updated_at: string }
      this.store.updateDocument(record.id, { ...record.content, title: byId.get(record.id)!.title }, { skipCheckpoint: true, skipLinkMaintenance: true })
      // A remote write must invalidate an editor's optimistic timestamp even within the same millisecond.
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString()
      this.db.prepare('UPDATE documents SET sort_order = ?, updated_at = ? WHERE id = ?').run(record.sortOrder, updatedAt, record.id)
      this.store.documentRecovery.forgetTrash(record.id)
    }
    const databaseRecord = records.find((record): record is SyncDatabases => record.kind === 'databases')
    if (databaseRecord) this.applyDatabases(databaseRecord, now)
  }

  private applyDatabases(record: SyncDatabases, now: string): void {
    const catalogId = this.catalogId()
    const catalog = this.db.prepare('SELECT created_at FROM databases WHERE id = ?').get(catalogId) as { created_at: string }
    if (record.tables.databases.filter(row => row.id === 'catalog').length !== 1) throw new Error('同步数据缺少默认文档数据库。')
    // Reject missing references rather than silently discarding table values.
    for (const table of ['database_entities', 'document_database_values'] as const) {
      for (const row of record.tables[table]) {
        if (row.document_id && !this.store.getDocumentSnapshot(String(row.document_id))) {
          throw new Error('数据库引用的文档尚未同步，请先处理文档冲突后重试。')
        }
      }
    }
    for (const table of [...SYNC_TABLES].reverse()) this.db.prepare(`DELETE FROM ${table}`).run()
    for (const table of SYNC_TABLES) {
      const columns = [...SYNC_TABLE_COLUMNS[table], 'updated_at']
      const insert = this.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      for (const source of record.tables[table]) {
        const row = { ...source, updated_at: now } as SyncRow
        if (table === 'databases' && row.id === 'catalog') { row.id = catalogId; row.created_at = catalog.created_at }
        if (row.database_id === 'catalog') row.database_id = catalogId
        insert.run(...columns.map(column => row[column]))
      }
    }
  }
}
