import type Database from 'better-sqlite3'
import type { KnowbookStore } from '../database/store'
import { canonicalJson, SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncRecord, type SyncRow, type SyncDatabases, type SyncDocument } from './model'

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
    const deleted = records.filter(record => record.kind === 'deleted' && this.store.getDocumentSnapshot(record.id))
    // Archive every row before cascading deletes can change another row's parent or properties.
    for (const record of deleted) this.store.documentRecovery.archive(record.id)
    for (const record of deleted) this.db.prepare('DELETE FROM documents WHERE id = ?').run(record.id)
    // Stage all IDs before parent links so directory order and simultaneous moves are safe.
    for (const record of documents) {
      if (this.store.getDocumentSnapshot(record.id)) this.store.documentRecovery.checkpoint(record.id, 'restore')
      else this.db.prepare(`INSERT INTO documents (id, title, slug, parent_id, path, summary, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, '', ?, ?, ?)`).run(record.id, record.content.title, `doc-${record.id}`, record.content.title, record.sortOrder, record.createdAt, now)
    }
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
    for (const row of metadata) {
      const old = before.get(row.id)!, path = pathFor(row.id)
      if (old.parent_id === row.parent_id && old.title === row.title && old.path === path) continue
      if (old.title !== row.title && !documentIds.has(row.id)) this.store.documentRecovery.checkpoint(row.id, 'restore')
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(old.updated_at) + 1)).toISOString()
      this.db.prepare('UPDATE documents SET parent_id = ?, title = ?, path = ?, updated_at = ? WHERE id = ?')
        .run(row.parent_id, row.title, path, updatedAt, row.id)
    }
    for (const record of documents) {
      const current = this.db.prepare('SELECT updated_at FROM documents WHERE id = ?').get(record.id) as { updated_at: string }
      this.store.updateDocument(record.id, { ...record.content, title: byId.get(record.id)!.title })
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
