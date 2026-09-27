import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { DocumentBlockDraft, UpdateDocumentInput } from '../../shared/contracts'
import { decodeMarkdownFormat } from '../../shared/markdownFormat'
import { DOCUMENT_HISTORY_INTERVAL_MS, DOCUMENT_HISTORY_LIMIT, type DocumentRecoveryEntry, type DocumentRecoveryPreview } from '../../shared/document-recovery'

interface SavedDocument {
  id: string; title: string; slug: string; parent_id: string | null; path: string
  summary: string; sort_order: number; created_at: string; updated_at: string
}
interface SavedValue { column_id: string; value_text: string | null }
export interface TrashedDocument {
  document: SavedDocument
  content: UpdateDocumentInput
  values: SavedValue[]
  entities: Array<{ id: string; database_id: string; title: string; created_at: string; values: SavedValue[] }>
}

/** Recovery records intentionally outlive documents and never enter search indexes. */
export class DocumentRecoveryRepository {
  constructor(private readonly db: Database.Database) {}

  readContent(documentId: string): UpdateDocumentInput {
    const document = this.db.prepare('SELECT title, summary FROM documents WHERE id = ?').get(documentId) as
      { title: string; summary: string } | undefined
    if (!document) throw new Error('Document not found')
    const rows = this.db.prepare('SELECT * FROM blocks WHERE document_id = ? ORDER BY sort_order').all(documentId) as Array<{
      id: string; type: string; content: string; checked: number; depth: number; parent_block_id: string | null
      tags_json: string; language: string | null; highlight: string | null; list_start: number | null; markdown_format_json: string | null
    }>
    const blocks: DocumentBlockDraft[] = rows.map((block) => ({
      id: block.id, type: block.type, content: block.content, checked: Boolean(block.checked), depth: block.depth,
      parentBlockId: block.parent_block_id, tags: JSON.parse(block.tags_json),
      ...(block.language ? { language: block.language } : {}),
      ...(block.highlight ? { highlight: block.highlight } : {}),
      ...(block.list_start !== null ? { listStart: block.list_start } : {}),
      ...(block.markdown_format_json ? { markdownFormat: decodeMarkdownFormat(block.type, block.markdown_format_json) } : {})
    }))
    return { ...document, blocks }
  }

  checkpoint(documentId: string, reason: DocumentRecoveryEntry['reason'] = 'edit'): void {
    const latest = this.db.prepare('SELECT id, created_at FROM document_history WHERE document_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(documentId) as { id: string; created_at: string } | undefined
    if (reason === 'edit' && latest && Date.now() - Date.parse(latest.created_at) < DOCUMENT_HISTORY_INTERVAL_MS) return
    const content = this.readContent(documentId)
    const json = JSON.stringify(content)
    if (reason === 'edit' && latest && (this.db.prepare('SELECT content_json FROM document_history WHERE id = ?')
      .get(latest.id) as { content_json: string }).content_json === json) return
    const { path } = this.db.prepare('SELECT path FROM documents WHERE id = ?').get(documentId) as { path: string }
    this.db.prepare('INSERT INTO document_history VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), documentId, content.title, path, new Date().toISOString(), reason, json)
    this.db.prepare(`DELETE FROM document_history WHERE document_id = ? AND id NOT IN
      (SELECT id FROM document_history WHERE document_id = ? ORDER BY rowid DESC LIMIT ?)`)
      .run(documentId, documentId, DOCUMENT_HISTORY_LIMIT)
  }

  listHistory(documentId: string): DocumentRecoveryEntry[] {
    return this.db.prepare(`SELECT id, document_id AS documentId, title, path, created_at AS createdAt, reason
      FROM document_history WHERE document_id = ? ORDER BY rowid DESC`).all(documentId) as DocumentRecoveryEntry[]
  }

  getHistory(documentId: string, id: string): DocumentRecoveryPreview {
    const row = this.db.prepare(`SELECT id, document_id AS documentId, title, path, created_at AS createdAt, reason,
      content_json FROM document_history WHERE document_id = ? AND id = ?`).get(documentId, id) as
      (DocumentRecoveryEntry & { content_json: string }) | undefined
    if (!row) throw new Error('Document history version not found')
    const { content_json, ...entry } = row
    return { ...entry, content: JSON.parse(content_json) }
  }

  archive(documentId: string): void {
    const document = this.db.prepare(`SELECT id, title, slug, parent_id, path, summary, sort_order, created_at, updated_at
      FROM documents WHERE id = ?`).get(documentId) as SavedDocument | undefined
    if (!document) throw new Error('Document not found')
    const entities = this.db.prepare('SELECT id, database_id, title, created_at FROM database_entities WHERE document_id = ?')
      .all(documentId) as TrashedDocument['entities']
    const snapshot: TrashedDocument = {
      document, content: this.readContent(documentId),
      values: this.db.prepare('SELECT column_id, value_text FROM document_database_values WHERE document_id = ?').all(documentId) as SavedValue[],
      entities: entities.map((entity) => ({ ...entity, values: this.db.prepare(
        'SELECT column_id, value_text FROM database_entity_values WHERE entity_id = ?').all(entity.id) as SavedValue[] }))
    }
    this.checkpoint(documentId, 'delete')
    this.db.prepare('INSERT OR REPLACE INTO document_trash VALUES (?, ?, ?, ?, ?)')
      .run(documentId, document.title, document.path, new Date().toISOString(), JSON.stringify(snapshot))
  }

  listTrash(): DocumentRecoveryEntry[] {
    return this.db.prepare(`SELECT id, id AS documentId, title, path, deleted_at AS createdAt, 'delete' AS reason
      FROM document_trash ORDER BY deleted_at DESC, rowid DESC`).all() as DocumentRecoveryEntry[]
  }

  getTrash(id: string): TrashedDocument {
    const row = this.db.prepare('SELECT snapshot_json FROM document_trash WHERE id = ?').get(id) as { snapshot_json: string } | undefined
    if (!row) throw new Error('Trashed document not found')
    return JSON.parse(row.snapshot_json) as TrashedDocument
  }

  forgetTrash(id: string): void { this.db.prepare('DELETE FROM document_trash WHERE id = ?').run(id) }

  purge(id: string): void {
    this.db.transaction(() => {
      this.getTrash(id)
      this.forgetTrash(id)
      // A Markdown import may already have recreated the same document ID.
      if (!this.db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id)) {
        this.db.prepare('DELETE FROM document_history WHERE document_id = ?').run(id)
      }
    })()
  }
}
