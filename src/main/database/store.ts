import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type {
  AiConfig,
  AskAiInput,
  BlockReferenceResult,
  CreateDatabaseEntityInput,
  CreateDatabaseInput,
  CreateDatabaseSavedViewInput,
  CreateDocumentDatabaseColumnInput,
  DatabaseEntity,
  DatabaseSavedView,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  DeleteDatabaseEntityInput,
  DeleteDatabaseEntitiesInput,
  DetailedHomeData,
  DocumentDatabase,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  DocumentDatabaseFieldValue,
  DocumentBlockDraft,
  DocumentCatalogEntry,
  DocumentCatalogPage,
  DocumentCatalogPageInput,
  DocumentChild,
  DocumentDetail,
  DocumentIndexEntry,
  DocumentSuggestion,
  DocumentTreeNode,
  HomeData,
  HomeDataPayload,
  LinkedDocument,
  MoveDocumentDatabaseColumnInput,
  PreviewDocumentBlockAiEditInput,
  RecentDocument,
  RenameDocumentDatabaseColumnInput,
  UpdateAiConfigInput,
  UpdateDatabaseSavedViewInput,
  UpdateDatabaseMetadataInput,
  UpdateDatabaseEntityInput,
  UpdateDatabaseEntitiesInput,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput,
  UpdateDocumentResult,
  WorkspaceEventRecord,
  WorkspaceEventType,
  WorkspaceSummary,
  GlobalSearchResult,
  SearchSemanticNotesInput,
  SemanticSearchResult
} from '@shared/contracts'
import { appSchema } from './schema'

export const DEFAULT_DOCUMENT_SUMMARY = 'New knowledge node ready for editing.'
const DEFAULT_DOCUMENT_DATABASE_ID_SETTING_KEY = 'database.defaultId'
const DEFAULT_DOCUMENT_DATABASE_NAME = 'Default'
const DEFAULT_DOCUMENT_DATABASE_DESCRIPTION = 'Default database'
const CURRENT_DATABASE_SCHEMA_VERSION = 3
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

type SqliteDatabase = InstanceType<typeof Database>

interface CountRow {
  count: number
}

interface DocumentRow {
  id: string
  title: string
  path: string
  updated_at: string
  block_count: number
}

interface DocumentCatalogRow {
  id: string
  title: string
  path: string
  summary: string
  parent_id: string | null
  parent_title: string | null
  updated_at: string
  block_count: number
  link_count: number
  child_count: number
}

interface HomeDocumentCatalogRow extends DocumentCatalogRow {
  sort_order: number
}

interface DocumentCatalogFieldRow {
  entity_id: string | null
  document_id: string | null
  column_id: string
  value_text: string | null
}

interface DocumentDatabaseColumnRow {
  id: string
  database_id?: string | null
  name: string
  type: string
  options_json: string
  sort_order: number
}

interface DocumentDatabaseValueRow {
  document_id: string
  column_id: string
  value_text: string | null
}

interface DatabaseSavedViewRow {
  id: string
  database_id: string
  name: string
  filter_query: string
  filter_scope: string
  sort_mode: string
  view_mode: string
  created_at: string
  updated_at: string
}

interface DatabaseEntityRow {
  id: string
  database_id: string
  document_id: string | null
  created_at: string
  updated_at: string
}

interface DatabaseEntityFieldValueRow {
  entity_id: string
  column_id: string
  value_text: string | null
  column_name: string
  column_type: DocumentDatabaseColumnType
  options_json: string
  sort_order: number
}

interface DocumentDetailRow {
  id: string
  title: string
  path: string
  summary: string
  updated_at: string
}

interface ParentDocumentRow {
  id: string
  path: string
}

interface DocumentPathRow {
  id: string
  path: string
  title: string
  parent_id: string | null
}

interface EditableDocumentRow extends DocumentPathRow {
  summary: string
}

interface ExportDocumentRow {
  id: string
  title: string
  path: string
  summary: string
  updated_at: string
}

interface ExportBlockRow {
  id: string
  type: string
  content: string
  checked: number
  depth: number
  tags_json?: string | null
  parent_block_id: string | null
  sort_order: number
  language: string | null
  highlight: string | null
}

interface ExportDocumentBlockRow extends ExportBlockRow {
  document_id: string
}

interface BlockTreeRow {
  id: string
  document_id: string
  type: string
  depth: number
  parent_block_id: string | null
}

interface BlockTableInfoRow {
  name: string
}

interface LinkedDocumentRow {
  id: string
  title: string
  path: string
  label: string
  context_snippet?: string
}

interface PluginWorkspaceBlockRow extends ExportBlockRow {
  document_id: string
}

interface PluginWorkspaceLinkedDocumentRow extends LinkedDocumentRow {
  owner_document_id: string
}

interface PluginWorkspaceChildRow extends DocumentChildRow {
  owner_document_id: string
}

interface DocumentChildRow {
  id: string
  title: string
  path: string
}

interface DocumentLookupRow {
  id: string
  title: string
  path: string
}

interface BlockReferenceRow {
  document_id: string
  content: string
}

interface WorkspaceEventRow {
  id: string
  type: WorkspaceEventType
  title: string
  description: string
  document_id: string | null
  created_at: string
}

interface SemanticSearchDocumentRow {
  id: string
  title: string
  path: string
  summary: string
}

interface SemanticSearchBlockRow {
  document_id: string
  type: string
  content: string
  sort_order: number
}

export interface SemanticSearchCandidate {
  documentId: string
  title: string
  path: string
  summary: string
  snippet: string
  content: string
  contentHash: string
}

export interface ExportDocument {
  id: string
  title: string
  path: string
  summary: string
  updatedAt: string
  documentDatabaseColumns: DocumentDatabaseColumn[]
  documentDatabaseFieldValues: Record<string, DocumentDatabaseFieldValue>
  blocks: Array<{
    id: string
    type: string
    content: string
    checked: boolean
    depth: number
    tags?: string[]
    parentBlockId: string | null
    sortOrder: number
    language?: string
    highlight?: string
  }>
}

export interface ExportStandaloneDatabaseEntity {
  id: string
  documentId: string | null
  documentPath: string | null
  createdAt: string
  updatedAt: string
  fieldValues: Record<string, DocumentDatabaseFieldValue>
}

export interface ExportStandaloneDatabase {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  columns: DocumentDatabaseColumn[]
  savedViews: DatabaseSavedView[]
  entities: ExportStandaloneDatabaseEntity[]
}

export class KnowbookStore {
  private readonly db: SqliteDatabase
  private deferredLinkResyncDepth = 0
  private deferredFullLinkResyncRequested = false

  constructor(private readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    const databaseAlreadyExists = existsSync(databasePath)
    this.db = new Database(databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    const schemaVersion = this.db.pragma('user_version', { simple: true }) as number
    if (schemaVersion > CURRENT_DATABASE_SCHEMA_VERSION) {
      this.db.close()
      throw new Error(
        `Database schema version ${schemaVersion} is newer than supported version ${CURRENT_DATABASE_SCHEMA_VERSION}.`
      )
    }
    if (databaseAlreadyExists && schemaVersion < CURRENT_DATABASE_SCHEMA_VERSION) {
      this.createMigrationSafetyCopy(schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION)
    }
    this.db.exec(appSchema)
    this.migrateDatabase(schemaVersion)
  }

  private migrateDatabase(schemaVersion: number): void {
    if (schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION) {
      this.seed()
      return
    }

    this.runInTransaction(() => {
      if (schemaVersion < 1) {
        this.migrateToSchemaVersion1()
        this.db.pragma('user_version = 1')
      }
      if (schemaVersion < 2) {
        this.migrateToSchemaVersion2()
        this.db.pragma('user_version = 2')
      }
      if (schemaVersion < 3) {
        this.migrateToSchemaVersion3()
        this.db.pragma('user_version = 3')
      }
    })
  }

  private createMigrationSafetyCopy(fromVersion: number, toVersion: number): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const destinationPath = `${this.databasePath}.pre-migration-v${fromVersion}-to-v${toVersion}-${timestamp}-${randomUUID()}.db`
    this.db.prepare('VACUUM INTO ?').run(destinationPath)
  }

  private migrateToSchemaVersion1(): void {
    this.ensureBlockCheckedColumn()
    this.ensureBlockDepthColumn()
    this.ensureBlockTagsColumn()
    this.ensureBlockLanguageColumn()
    this.ensureBlockHighlightColumn()
    this.ensureBlockParentRelationships()
    this.ensureDocumentSortOrderColumn()
    this.ensureDatabaseEntities()
    this.ensureDatabaseEntityConstraints()
    this.ensureHomeProjectionIndexes()
    this.seed()
    this.resyncLinksForAllDocuments()
  }

  private migrateToSchemaVersion2(): void {
    this.db.exec(`
      DELETE FROM document_search;
      INSERT INTO document_search(document_id, title, path, summary)
      SELECT id, title, path, summary FROM documents;

      DELETE FROM block_search;
      INSERT INTO block_search(block_id, document_id, content)
      SELECT id, document_id, content FROM blocks;

      CREATE INDEX IF NOT EXISTS idx_documents_updated_at
        ON documents(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_blocks_document_sort
        ON blocks(document_id, sort_order);
    `)
  }

  private migrateToSchemaVersion3(): void {
    const columns = this.db.prepare('PRAGMA table_info(documents)').all() as BlockTableInfoRow[]
    const columnNames = new Set(columns.map((column) => column.name))
    if (!columnNames.has('block_count')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN block_count INTEGER NOT NULL DEFAULT 0')
    }
    if (!columnNames.has('link_count')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN link_count INTEGER NOT NULL DEFAULT 0')
    }
    if (!columnNames.has('child_count')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN child_count INTEGER NOT NULL DEFAULT 0')
    }

    this.db.exec(`
      UPDATE documents
      SET
        block_count = (SELECT COUNT(*) FROM blocks WHERE blocks.document_id = documents.id),
        link_count = (SELECT COUNT(*) FROM links WHERE links.source_document_id = documents.id),
        child_count = (SELECT COUNT(*) FROM documents AS children WHERE children.parent_id = documents.id);

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_block_insert
      AFTER INSERT ON blocks BEGIN
        UPDATE documents SET block_count = block_count + 1 WHERE id = new.document_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_block_delete
      AFTER DELETE ON blocks BEGIN
        UPDATE documents SET block_count = MAX(0, block_count - 1) WHERE id = old.document_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_block_move
      AFTER UPDATE OF document_id ON blocks
      WHEN old.document_id != new.document_id BEGIN
        UPDATE documents SET block_count = MAX(0, block_count - 1) WHERE id = old.document_id;
        UPDATE documents SET block_count = block_count + 1 WHERE id = new.document_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_link_insert
      AFTER INSERT ON links BEGIN
        UPDATE documents SET link_count = link_count + 1 WHERE id = new.source_document_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_link_delete
      AFTER DELETE ON links BEGIN
        UPDATE documents SET link_count = MAX(0, link_count - 1) WHERE id = old.source_document_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_link_move
      AFTER UPDATE OF source_document_id ON links
      WHEN old.source_document_id != new.source_document_id BEGIN
        UPDATE documents SET link_count = MAX(0, link_count - 1) WHERE id = old.source_document_id;
        UPDATE documents SET link_count = link_count + 1 WHERE id = new.source_document_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_child_insert
      AFTER INSERT ON documents
      WHEN new.parent_id IS NOT NULL BEGIN
        UPDATE documents SET child_count = child_count + 1 WHERE id = new.parent_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_child_delete
      AFTER DELETE ON documents
      WHEN old.parent_id IS NOT NULL BEGIN
        UPDATE documents SET child_count = MAX(0, child_count - 1) WHERE id = old.parent_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_stats_child_move
      AFTER UPDATE OF parent_id ON documents
      WHEN old.parent_id IS NOT new.parent_id BEGIN
        UPDATE documents SET child_count = MAX(0, child_count - 1) WHERE id = old.parent_id;
        UPDATE documents SET child_count = child_count + 1 WHERE id = new.parent_id;
      END;
    `)
  }

  getHomeData(backupRoot: string): DetailedHomeData {
    const defaultDatabaseId = this.getDefaultDocumentDatabaseId()
    const databaseColumns = this.getDocumentDatabaseColumns(defaultDatabaseId)
    const documentRows = this.getHomeDocumentCatalogRows()
    const recentDocuments = this.getRecentDocuments(documentRows)
    return {
      summary: this.getSummary(backupRoot, documentRows),
      recentDocuments,
      recentEvents: this.getRecentWorkspaceEvents(),
      documentCatalog: this.buildDocumentCatalog(databaseColumns, defaultDatabaseId, documentRows),
      databaseColumns,
      aiConfig: this.getAiConfig(),
      documentTree: this.buildDocumentTree(documentRows),
      initialDocumentId: recentDocuments[0]?.id ?? documentRows[0]?.id ?? null
    }
  }

  getHomeDataPayload(backupRoot: string): HomeDataPayload {
    const recentDocuments = this.getRecentDocuments()
    return {
      summary: this.getSummary(backupRoot),
      recentDocuments,
      recentEvents: this.getRecentWorkspaceEvents(),
      documentCatalog: this.getDocumentIndex(),
      databaseColumns: this.getDocumentDatabaseColumns(),
      aiConfig: this.getAiConfig(),
      initialDocumentId: recentDocuments[0]?.id ?? null
    }
  }

  getDocumentIndex(): DocumentIndexEntry[] {
    return this.db.prepare(`
      SELECT id, title, path, parent_id, updated_at
      FROM documents
      ORDER BY path ASC
    `).all().map((row) => {
      const document = row as Pick<HomeDocumentCatalogRow, 'id' | 'title' | 'path' | 'parent_id' | 'updated_at'>
      return {
        id: document.id,
        title: document.title,
        path: document.path,
        parentId: document.parent_id,
        updatedAt: document.updated_at
      }
    })
  }

  getDocumentCatalog(databaseId: string = this.getDefaultDocumentDatabaseId()): DocumentCatalogEntry[] {
    const databaseColumns = this.getDocumentDatabaseColumns(databaseId)
    return this.buildDocumentCatalog(databaseColumns, databaseId, this.getHomeDocumentCatalogRows())
  }

  getDocumentCatalogPage(input: DocumentCatalogPageInput): DocumentCatalogPage {
    const databaseId = input.databaseId ?? this.getDefaultDocumentDatabaseId()
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.trunc(input.offset)) : 0
    const limit = Number.isFinite(input.limit)
      ? Math.min(1_000, Math.max(1, Math.trunc(input.limit)))
      : 1_000
    const documentCount = (this.db.prepare('SELECT COUNT(*) AS count FROM documents').get() as CountRow).count
    const entityCount = (this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM database_entities
      WHERE document_id IS NULL AND database_id = ?
    `).get(databaseId) as CountRow).count
    const total = documentCount + entityCount
    const documentOffset = Math.min(offset, documentCount)
    const documentLimit = Math.min(limit, Math.max(0, documentCount - documentOffset))
    const documentRows = documentLimit > 0
      ? this.db.prepare(`
          SELECT
            documents.id,
            documents.title,
            documents.path,
            documents.summary,
            documents.parent_id,
            parents.title AS parent_title,
            documents.updated_at,
            documents.block_count,
            documents.link_count,
            documents.child_count
          FROM documents
          LEFT JOIN documents AS parents ON parents.id = documents.parent_id
          ORDER BY documents.path ASC
          LIMIT ? OFFSET ?
        `).all(documentLimit, documentOffset) as DocumentCatalogRow[]
      : []
    const remainingLimit = limit - documentRows.length
    const entityOffset = Math.max(0, offset - documentCount)
    const entityRows = remainingLimit > 0
      ? this.getDocumentCatalogEntityRows(databaseId, remainingLimit, entityOffset)
      : []
    const databaseColumns = this.getDocumentDatabaseColumns(databaseId)
    const entries = this.buildDocumentCatalogEntries(
      databaseColumns,
      databaseId,
      documentRows,
      entityRows,
      true
    )
    const loadedThrough = Math.min(total, offset + entries.length)

    return {
      entries,
      total,
      nextOffset: loadedThrough < total ? loadedThrough : null
    }
  }

  getIncrementalDocumentUpdate(
    documentId: string,
    backupRoot: string
  ): Extract<UpdateDocumentResult, { requiresFullRefresh: false }> {
    const document = this.getDocumentDetail(documentId)
    if (!document) {
      throw new Error('Document not found')
    }

    const row = this.db.prepare(`
      SELECT
        documents.id,
        documents.title,
        documents.path,
        documents.summary,
        documents.parent_id,
        parents.title AS parent_title,
        documents.updated_at,
        documents.block_count,
        documents.link_count,
        documents.child_count
      FROM documents
      LEFT JOIN documents AS parents ON parents.id = documents.parent_id
      WHERE documents.id = ?
    `).get(documentId) as DocumentCatalogRow | undefined

    if (!row) {
      throw new Error('Document not found')
    }

    const defaultDatabaseId = this.getDefaultDocumentDatabaseId()
    const databaseColumns = this.getDocumentDatabaseColumns(defaultDatabaseId)
    const columnById = new Map(databaseColumns.map((column) => [column.id, column]))
    const fieldRows = this.db.prepare(`
      SELECT values_table.column_id, values_table.value_text
      FROM document_database_values AS values_table
      INNER JOIN document_database_columns AS columns_table ON columns_table.id = values_table.column_id
      WHERE values_table.document_id = ?
        AND values_table.entity_id IS NULL
        AND columns_table.database_id = ?
      ORDER BY values_table.column_id ASC
    `).all(documentId, defaultDatabaseId) as Array<{
      column_id: string
      value_text: string | null
    }>
    const fieldValues: Record<string, DocumentDatabaseFieldValue> = {}

    for (const fieldRow of fieldRows) {
      const column = columnById.get(fieldRow.column_id)
      if (column) {
        fieldValues[fieldRow.column_id] = this.parseDocumentDatabaseFieldValue(column, fieldRow.value_text)
      }
    }

    return {
      requiresFullRefresh: false,
      document,
      catalogEntry: {
        id: row.id,
        title: row.title,
        path: row.path,
        summary: row.summary,
        parentId: row.parent_id,
        parentTitle: row.parent_title,
        updatedAt: row.updated_at,
        blockCount: row.block_count,
        linkCount: row.link_count,
        childCount: row.child_count,
        fieldValues
      },
      summary: this.getSummary(backupRoot),
      recentDocuments: this.getRecentDocuments(),
      recentEvents: this.getRecentWorkspaceEvents()
    }
  }

  getDocumentDetail(documentId: string): DocumentDetail | null {
    const document = this.db.prepare(`
      SELECT id, title, path, summary, updated_at
      FROM documents
      WHERE id = ?
    `).get(documentId) as DocumentDetailRow | undefined

    if (!document) {
      return null
    }

    const blocks = this.db.prepare(`
      SELECT id, type, content, checked, depth, tags_json, parent_block_id, sort_order, language, highlight
      FROM blocks
      WHERE document_id = ?
      ORDER BY sort_order ASC
    `).all(documentId) as ExportBlockRow[]

    const outgoingLinks = this.db.prepare(`
      SELECT target.id, target.title, target.path, links.label
      FROM links
      INNER JOIN documents AS target ON target.id = links.target_document_id
      WHERE links.source_document_id = ?
      ORDER BY target.path ASC
    `).all(documentId) as LinkedDocumentRow[]

    const backlinks = this.db.prepare(`
      SELECT source.id, source.title, source.path, links.label,
        SUBSTR(b.content, 1, 200) AS context_snippet
      FROM links
      INNER JOIN documents AS source ON source.id = links.source_document_id
      LEFT JOIN blocks AS b ON b.document_id = links.source_document_id
        AND b.content LIKE '%' || links.label || '%'
      WHERE links.target_document_id = ?
      GROUP BY source.id
      ORDER BY source.path ASC
    `).all(documentId) as LinkedDocumentRow[]

    const children = this.db.prepare(`
      SELECT id, title, path
      FROM documents
      WHERE parent_id = ?
      ORDER BY path ASC
    `).all(documentId) as DocumentChildRow[]

    return {
      id: document.id,
      title: document.title,
      path: document.path,
      summary: document.summary,
      updatedAt: document.updated_at,
      blocks: blocks.map((block) => ({
        id: block.id,
        type: block.type,
        content: block.content,
        checked: Boolean(block.checked),
        depth: Math.max(0, block.depth ?? 0),
        tags: this.parseBlockTags(block.tags_json),
        parentBlockId: block.parent_block_id ?? null,
        sortOrder: block.sort_order,
        language: block.language ?? undefined,
        highlight: block.highlight ?? undefined
      })),
      children: children.map((child): DocumentChild => ({
        id: child.id,
        title: child.title,
        path: child.path
      })),
      outgoingLinks: outgoingLinks.map((link): LinkedDocument => ({
        id: link.id,
        title: link.title,
        path: link.path,
        label: link.label
      })),
      backlinks: backlinks.map((link): LinkedDocument => ({
        id: link.id,
        title: link.title,
        path: link.path,
        label: link.label,
        contextSnippet: link.context_snippet ?? undefined
      }))
    }
  }

  getBlockReference(documentPath: string, blockId: string): BlockReferenceResult | null {
    const row = this.db.prepare(`
      SELECT
        b.id, b.type, b.content, b.checked, b.depth, b.tags_json,
        b.parent_block_id, b.sort_order, b.language, b.highlight,
        d.id AS doc_id, d.title AS doc_title, d.path AS doc_path
      FROM blocks b
      INNER JOIN documents d ON d.id = b.document_id
      WHERE d.path = ? AND b.id = ?
    `).get(documentPath, blockId) as {
      id: string
      type: string
      content: string
      checked: number
      depth: number
      tags_json: string
      parent_block_id: string | null
      sort_order: number
      language: string | null
      highlight: string | null
      doc_id: string
      doc_title: string
      doc_path: string
    } | undefined

    if (!row) {
      return null
    }

    return {
      block: {
        id: row.id,
        type: row.type,
        content: row.content,
        checked: Boolean(row.checked),
        depth: Math.max(0, row.depth ?? 0),
        tags: this.parseBlockTags(row.tags_json),
        parentBlockId: row.parent_block_id ?? null,
        sortOrder: row.sort_order,
        language: row.language ?? undefined,
        highlight: row.highlight ?? undefined
      },
      documentId: row.doc_id,
      documentPath: row.doc_path,
      documentTitle: row.doc_title
    }
  }

  getDocumentSnapshot(documentId: string): { id: string; title: string; path: string; parentId: string | null } | null {
    const row = this.db.prepare(`
      SELECT id, title, path, parent_id
      FROM documents
      WHERE id = ?
    `).get(documentId) as DocumentPathRow | undefined

    if (!row) {
      return null
    }

    return {
      id: row.id,
      title: row.title,
      path: row.path,
      parentId: row.parent_id ?? null
    }
  }

  getDocumentSnapshotByPath(path: string): { id: string; title: string; path: string; parentId: string | null } | null {
    const row = this.db.prepare(`
      SELECT id, title, path, parent_id
      FROM documents
      WHERE path = ?
    `).get(path) as DocumentPathRow | undefined

    if (!row) {
      return null
    }

    return {
      id: row.id,
      title: row.title,
      path: row.path,
      parentId: row.parent_id ?? null
    }
  }

  getAllDocumentSnapshots(): Array<{ id: string; title: string; path: string; parentId: string | null }> {
    const rows = this.db.prepare(`
      SELECT id, title, path, parent_id
      FROM documents
      ORDER BY path ASC
    `).all() as DocumentPathRow[]

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      parentId: row.parent_id ?? null
    }))
  }

  createDocument(parentId: string | null): string {
    const now = new Date().toISOString()
    const parent = parentId
      ? (this.db.prepare('SELECT id, path FROM documents WHERE id = ?').get(parentId) as ParentDocumentRow | undefined)
      : undefined
    if (parentId && !parent) {
      throw new Error('Parent document not found')
    }

    const title = this.generateSiblingTitle(parentId, 'Untitled')
    const id = randomUUID()
    const slug = `doc-${id.slice(0, 8)}`

    const maxSortOrderRow = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order FROM documents WHERE parent_id IS ?').get(parentId) as { max_sort_order: number }
    const sortOrder = (maxSortOrderRow.max_sort_order ?? -1) + 1

    const path = parent ? `${parent.path}/${title}` : title
    const insertDocument = this.db.prepare(`
      INSERT INTO documents (id, title, slug, parent_id, path, summary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertBlock = this.db.prepare(`
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, checked, depth, tags_json, language, highlight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const transaction = this.db.transaction(() => {
      insertDocument.run(id, title, slug, parent?.id ?? null, path, DEFAULT_DOCUMENT_SUMMARY, sortOrder, now, now)
      insertBlock.run(randomUUID(), id, null, 0, 'heading-1', title, 0, 0, '[]', null, null, now, now)
      insertBlock.run(randomUUID(), id, null, 1, 'paragraph', 'Start writing here.', 0, 0, '[]', null, null, now, now)
      this.resyncLinksForReferenceChanges([title, path])
    })

    transaction()
    return id
  }

  updateDocument(documentId: string, input: UpdateDocumentInput): string[] {
    const now = new Date().toISOString()
    const document = this.db.prepare(`
      SELECT id, title, path, parent_id, summary
      FROM documents
      WHERE id = ?
    `).get(documentId) as EditableDocumentRow | undefined

    if (!document) {
      throw new Error('Document not found')
    }

    const parentPath = document.parent_id
      ? (this.db.prepare('SELECT path FROM documents WHERE id = ?').get(document.parent_id) as { path: string } | undefined)?.path
      : null

    const requestedTitle = this.normalizeDocumentTitle(input.title)
    const normalizedTitle = this.generateSiblingTitle(document.parent_id, requestedTitle, document.id)
    const normalizedSummary = input.summary.trim()
    const normalizedBlocks = this.normalizeBlocks(input.blocks)
    const persistedBlocks = this.buildPersistedBlocks(normalizedBlocks).map((block, index) => ({
      ...block,
      sortOrder: index,
      tagsJson: JSON.stringify(this.normalizeBlockTags(block.tags))
    }))
    const existingBlocks = this.db.prepare(`
      SELECT id, type, content, checked, depth, tags_json, parent_block_id, sort_order, language, highlight
      FROM blocks
      WHERE document_id = ?
    `).all(documentId) as ExportBlockRow[]
    const existingBlockById = new Map(existingBlocks.map((block) => [block.id, block]))
    const persistedBlockIds = new Set(persistedBlocks.map((block) => block.id))
    const oldPath = document.path
    const newPath = parentPath ? `${parentPath}/${normalizedTitle}` : normalizedTitle
    const pathChangedDocuments = newPath !== oldPath
      ? this.getDocumentPathSubtree(oldPath)
      : []
    const changedReferenceTokens = new Set<string>()
    if (newPath !== oldPath) {
      for (const token of this.getPathRewriteReferenceTokens(pathChangedDocuments, oldPath, newPath)) {
        changedReferenceTokens.add(token)
      }
      changedReferenceTokens.add(document.title)
      changedReferenceTokens.add(normalizedTitle)
    }

    const changedPersistedBlocks = persistedBlocks.filter((block) => {
      const existing = existingBlockById.get(block.id)
      return !existing
        || existing.parent_block_id !== block.parentBlockId
        || existing.sort_order !== block.sortOrder
        || existing.type !== block.type
        || existing.content !== block.content
        || existing.checked !== (block.checked ? 1 : 0)
        || existing.depth !== block.depth
        || (existing.tags_json ?? '[]') !== block.tagsJson
        || existing.language !== (block.language ?? null)
        || existing.highlight !== (block.highlight ?? null)
    })
    const deletedExistingBlocks = existingBlocks.filter((block) => !persistedBlockIds.has(block.id))
    const metadataChanged = normalizedTitle !== document.title
      || newPath !== oldPath
      || normalizedSummary !== document.summary
    const blocksChanged = changedPersistedBlocks.length > 0 || deletedExistingBlocks.length > 0
    const blockReferencesChanged = deletedExistingBlocks.length > 0 || changedPersistedBlocks.some((block) => {
      const existing = existingBlockById.get(block.id)
      return !existing || existing.content !== block.content
    })

    if (!metadataChanged && !blocksChanged) {
      return [documentId]
    }

    const updateDocumentMetadataStatement = this.db.prepare(`
      UPDATE documents
      SET title = ?, path = ?, summary = ?, updated_at = ?
      WHERE id = ?
    `)
    const touchDocumentStatement = this.db.prepare(`
      UPDATE documents
      SET updated_at = ?
      WHERE id = ?
    `)
    const updateDescendantsStatement = this.db.prepare(`
      UPDATE documents
      SET path = ? || substr(path, ?)
      WHERE path LIKE ? ESCAPE '\\'
    `)
    const deleteBlockStatement = this.db.prepare('DELETE FROM blocks WHERE id = ? AND document_id = ?')
    const insertBlockStatement = this.db.prepare(`
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, checked, depth, tags_json, language, highlight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const updateBlockStatement = this.db.prepare(`
      UPDATE blocks
      SET parent_block_id = ?, sort_order = ?, type = ?, content = ?, checked = ?, depth = ?,
        tags_json = ?, language = ?, highlight = ?, updated_at = ?
      WHERE id = ? AND document_id = ?
    `)

    const transaction = this.db.transaction(() => {
      if (metadataChanged) {
        updateDocumentMetadataStatement.run(normalizedTitle, newPath, normalizedSummary, now, documentId)
      } else {
        touchDocumentStatement.run(now, documentId)
      }

      if (newPath !== oldPath) {
        const oldPrefix = `${oldPath}/`
        updateDescendantsStatement.run(`${newPath}/`, oldPrefix.length + 1, `${this.escapeLikePattern(oldPath)}/%`)
      }

      for (const block of changedPersistedBlocks) {
        const existing = existingBlockById.get(block.id)
        const checked = block.checked ? 1 : 0
        const language = block.language ?? null
        const highlight = block.highlight ?? null

        if (existing) {
          updateBlockStatement.run(
            block.parentBlockId,
            block.sortOrder,
            block.type,
            block.content,
            checked,
            block.depth,
            block.tagsJson,
            language,
            highlight,
            now,
            block.id,
            documentId
          )
        } else {
          insertBlockStatement.run(
            block.id,
            documentId,
            block.parentBlockId,
            block.sortOrder,
            block.type,
            block.content,
            checked,
            block.depth,
            block.tagsJson,
            language,
            highlight,
            now,
            now
          )
        }
      }

      for (const existing of deletedExistingBlocks) {
        deleteBlockStatement.run(existing.id, documentId)
      }

      this.resyncLinksForReferenceChanges(
        changedReferenceTokens,
        blockReferencesChanged ? [documentId] : []
      )
    })

    transaction()
    return newPath !== oldPath ? this.getDocumentIdsInPathSubtree(newPath) : [documentId]
  }

  updateDocumentSummary(documentId: string, summary: string): void {
    const normalizedSummary = summary.trim()
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE documents
      SET summary = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizedSummary, now, documentId)
    if (result.changes === 0) {
      throw new Error('Document not found')
    }
  }

  deleteDocument(documentId: string): string[] {
    const now = new Date().toISOString()
    const document = this.db.prepare(`
      SELECT id, path, title, parent_id
      FROM documents
      WHERE id = ?
    `).get(documentId) as DocumentPathRow | undefined

    if (!document) {
      throw new Error('Document not found')
    }

    const parentPath = document.parent_id
      ? (this.db.prepare('SELECT path FROM documents WHERE id = ?').get(document.parent_id) as { path: string } | undefined)?.path
      : null

    const oldPrefix = `${document.path}/`
    const newPrefix = parentPath ? `${parentPath}/` : ''

    const directChildren = this.db.prepare(`
      SELECT id, title
      FROM documents
      WHERE parent_id = ?
    `).all(document.id) as Array<{ id: string; title: string }>
    for (const child of directChildren) {
      if (this.documentTitleExists(document.parent_id, child.title, child.id)) {
        throw new Error(`Cannot delete document because sibling title already exists: ${child.title}`)
      }
    }

    const reparentChildrenStatement = this.db.prepare(`
      UPDATE documents
      SET parent_id = ?, updated_at = ?
      WHERE parent_id = ?
    `)
    const rewriteDescendantPathStatement = this.db.prepare(`
      UPDATE documents
      SET path = ? || substr(path, ?), updated_at = ?
      WHERE path LIKE ? ESCAPE '\\'
    `)
    const deleteDocumentStatement = this.db.prepare('DELETE FROM documents WHERE id = ?')
    const affectedDescendants = this.db.prepare(`
      SELECT id, path
      FROM documents
      WHERE path LIKE ? ESCAPE '\\'
      ORDER BY path ASC
    `).all(`${this.escapeLikePattern(oldPrefix)}%`) as Array<{ id: string; path: string }>
    const changedReferenceTokens = new Set<string>([document.title, document.path])
    for (const descendant of affectedDescendants) {
      changedReferenceTokens.add(descendant.path)
      changedReferenceTokens.add(`${newPrefix}${descendant.path.slice(oldPrefix.length)}`)
    }

    const transaction = this.db.transaction(() => {
      reparentChildrenStatement.run(document.parent_id, now, document.id)
      rewriteDescendantPathStatement.run(newPrefix, oldPrefix.length + 1, now, `${this.escapeLikePattern(oldPrefix)}%`)
      deleteDocumentStatement.run(document.id)
      this.resyncLinksForReferenceChanges(changedReferenceTokens)
    })

    transaction()
    return affectedDescendants.map((row) => row.id)
  }

  moveDocument(documentId: string, newParentId: string | null): string[] {
    const now = new Date().toISOString()
    const document = this.db.prepare(`
      SELECT id, path, title, parent_id
      FROM documents
      WHERE id = ?
    `).get(documentId) as DocumentPathRow | undefined

    if (!document) {
      throw new Error('Document not found')
    }

    if (newParentId === document.id) {
      throw new Error('Document cannot be moved under itself')
    }

    const targetParent = newParentId
      ? (this.db.prepare('SELECT id, path FROM documents WHERE id = ?').get(newParentId) as ParentDocumentRow | undefined)
      : undefined

    if (newParentId && !targetParent) {
      throw new Error('Target parent not found')
    }

    if (targetParent && (targetParent.path === document.path || targetParent.path.startsWith(`${document.path}/`))) {
      throw new Error('Document cannot be moved into its own subtree')
    }

    if (this.documentTitleExists(targetParent?.id ?? null, document.title, document.id)) {
      throw new Error('Target parent already contains a document with this title')
    }

    const newPath = targetParent ? `${targetParent.path}/${document.title}` : document.title
    if (document.parent_id === (targetParent?.id ?? null) && newPath === document.path) {
      return [document.id]
    }

    const oldPrefix = `${document.path}/`
    const newPrefix = `${newPath}/`
    const pathChangedDocuments = this.getDocumentPathSubtree(document.path)
    const changedReferenceTokens = this.getPathRewriteReferenceTokens(
      pathChangedDocuments,
      document.path,
      newPath
    )

    const maxSortOrderRow = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order FROM documents WHERE parent_id IS ?').get(newParentId) as { max_sort_order: number }
    const newSortOrder = (maxSortOrderRow.max_sort_order ?? -1) + 1

    const updateDocumentStatement = this.db.prepare(`
      UPDATE documents
      SET parent_id = ?, path = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `)
    const updateDescendantsStatement = this.db.prepare(`
      UPDATE documents
      SET path = ? || substr(path, ?), updated_at = ?
      WHERE path LIKE ? ESCAPE '\\'
    `)

    const transaction = this.db.transaction(() => {
      updateDocumentStatement.run(targetParent?.id ?? null, newPath, newSortOrder, now, document.id)
      updateDescendantsStatement.run(newPrefix, oldPrefix.length + 1, now, `${this.escapeLikePattern(oldPrefix)}%`)
      this.resyncLinksForReferenceChanges(changedReferenceTokens)
    })

    transaction()
    return this.getDocumentIdsInPathSubtree(newPath)
  }

  updateAiConfig(input: UpdateAiConfigInput): void {
    const transaction = this.db.transaction(() => {
      this.saveSetting('ai.enabled', input.enabled ? 'true' : 'false')
      this.saveSetting('ai.baseUrl', input.baseUrl.trim() || 'https://api.openai.com/v1')
      this.saveSetting('ai.model', input.model.trim() || 'gpt-4.1-mini')
      this.saveSetting('ai.autoSummaryOnSave', input.autoSummaryOnSave ? 'true' : 'false')
      this.saveSetting('ai.relatedNotesEnabled', input.relatedNotesEnabled ? 'true' : 'false')
      if (input.clearApiKey) {
        this.deleteSetting('ai.apiKey')
      } else if (typeof input.apiKey === 'string' && input.apiKey.trim().length > 0) {
        this.saveSetting('ai.apiKey', input.apiKey.trim())
      }
    })

    transaction()
  }

  updateDocumentBlockTags(documentId: string, updates: Array<{ blockId: string, tags: string[] }>): void {
    if (updates.length === 0) {
      return
    }

    const now = new Date().toISOString()
    const updateBlockStatement = this.db.prepare(`
      UPDATE blocks
      SET tags_json = ?, updated_at = ?
      WHERE id = ? AND document_id = ?
    `)
    const updateDocumentStatement = this.db.prepare(`
      UPDATE documents
      SET updated_at = ?
      WHERE id = ?
    `)

    const transaction = this.db.transaction(() => {
      for (const update of updates) {
        updateBlockStatement.run(JSON.stringify(this.normalizeBlockTags(update.tags)), now, update.blockId, documentId)
      }
      updateDocumentStatement.run(now, documentId)
    })

    transaction()
  }

  updateDocumentBlockHighlights(documentId: string, updates: Array<{ blockId: string, highlight: string | null }>): void {
    if (updates.length === 0) {
      return
    }

    const now = new Date().toISOString()
    const updateBlockStatement = this.db.prepare(`
      UPDATE blocks
      SET highlight = ?, updated_at = ?
      WHERE id = ? AND document_id = ?
    `)
    const updateDocumentStatement = this.db.prepare(`
      UPDATE documents
      SET updated_at = ?
      WHERE id = ?
    `)

    const transaction = this.db.transaction(() => {
      for (const update of updates) {
        updateBlockStatement.run(update.highlight, now, update.blockId, documentId)
      }
      updateDocumentStatement.run(now, documentId)
    })

    transaction()
  }

  createDocumentDatabaseColumn(input: CreateDocumentDatabaseColumnInput): DocumentDatabaseColumn {
    const databaseId = input.databaseId?.trim() || this.getDefaultDocumentDatabaseId()
    const name = input.name.trim()
    if (!name) {
      throw new Error('Column name is required.')
    }

    const databaseExists = this.db.prepare('SELECT id FROM databases WHERE id = ?').get(databaseId) as { id: string } | undefined
    if (!databaseExists) {
      throw new Error('Database not found.')
    }

    const type = this.normalizeDocumentDatabaseColumnType(input.type)
    const options = this.normalizeDocumentDatabaseColumnOptions(type, input.options ?? [])
    const now = new Date().toISOString()
    const maxSortOrderRow = this.db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
      FROM document_database_columns
      WHERE database_id = ?
    `).get(databaseId) as { max_sort_order: number }
    const sortOrder = (maxSortOrderRow.max_sort_order ?? -1) + 1
    const column: DocumentDatabaseColumn = {
      id: randomUUID(),
      name,
      type,
      options,
      sortOrder
    }

    this.db.prepare(`
      INSERT INTO document_database_columns (id, database_id, name, type, options_json, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(column.id, databaseId, column.name, column.type, JSON.stringify(column.options), column.sortOrder, now, now)

    return column
  }

  renameDocumentDatabaseColumn(input: RenameDocumentDatabaseColumnInput): void {
    const name = input.name.trim()
    if (!name) {
      throw new Error('Column name is required.')
    }

    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE document_database_columns
      SET name = ?, updated_at = ?
      WHERE id = ?
    `).run(name, now, input.columnId)

    if (result.changes === 0) {
      throw new Error('Database column not found.')
    }
  }

  moveDocumentDatabaseColumn(input: MoveDocumentDatabaseColumnInput): void {
    const currentRow = this.db.prepare(`
      SELECT id, database_id, name, type, options_json, sort_order
      FROM document_database_columns
      WHERE id = ?
    `).get(input.columnId) as DocumentDatabaseColumnRow | undefined

    if (!currentRow) {
      throw new Error('Database column not found.')
    }

    const rows = this.db.prepare(`
      SELECT id, database_id, name, type, options_json, sort_order
      FROM document_database_columns
      WHERE database_id = ?
      ORDER BY sort_order ASC, name ASC
    `).all(currentRow.database_id) as DocumentDatabaseColumnRow[]

    const currentIndex = rows.findIndex((row) => row.id === input.columnId)
    if (currentIndex === -1) {
      throw new Error('Database column not found.')
    }

    const targetIndex = input.direction === 'left' ? currentIndex - 1 : currentIndex + 1
    if (targetIndex < 0 || targetIndex >= rows.length) {
      return
    }

    const current = rows[currentIndex]
    const target = rows[targetIndex]
    const updateSortOrder = this.db.prepare(`
      UPDATE document_database_columns
      SET sort_order = ?, updated_at = ?
      WHERE id = ?
    `)

    const transaction = this.db.transaction(() => {
      const now = new Date().toISOString()
      updateSortOrder.run(target.sort_order, now, current.id)
      updateSortOrder.run(current.sort_order, now, target.id)
    })

    transaction()
  }

  updateDocumentDatabaseColumnOptions(input: UpdateDocumentDatabaseColumnOptionsInput): void {
    const columnRow = this.db.prepare(`
      SELECT id, name, type, options_json, sort_order
      FROM document_database_columns
      WHERE id = ?
    `).get(input.columnId) as DocumentDatabaseColumnRow | undefined

    if (!columnRow) {
      throw new Error('Database column not found.')
    }

    const columnType = this.normalizeDocumentDatabaseColumnType(columnRow.type)
    const options = this.normalizeDocumentDatabaseColumnOptions(columnType, input.options)
    const now = new Date().toISOString()

    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE document_database_columns
        SET options_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(options), now, input.columnId)

      if (columnType === 'select') {
        this.pruneSelectDocumentDatabaseValues(input.columnId, options, now)
      }

      if (columnType === 'multi-select') {
        this.pruneMultiSelectDocumentDatabaseValues(input.columnId, options, now)
      }
    })

    transaction()
  }

  deleteDocumentDatabaseColumn(columnId: string): void {
    const result = this.db.prepare(`
      DELETE FROM document_database_columns
      WHERE id = ?
    `).run(columnId)

    if (result.changes === 0) {
      throw new Error('Database column not found.')
    }
  }

  updateDocumentDatabaseValue(input: UpdateDocumentDatabaseValueInput): void {
    const defaultDatabaseId = this.getDefaultDocumentDatabaseId()
    const documentExists = this.db.prepare('SELECT id FROM documents WHERE id = ?').get(input.documentId) as { id: string } | undefined
    if (!documentExists) {
      throw new Error('Document not found.')
    }

    const columnRow = this.db.prepare(`
      SELECT id, database_id, name, type, options_json, sort_order
      FROM document_database_columns
      WHERE id = ? AND database_id = ?
    `).get(input.columnId, defaultDatabaseId) as DocumentDatabaseColumnRow | undefined

    if (!columnRow) {
      throw new Error('Database column not found.')
    }

    const column = this.mapDocumentDatabaseColumnRow(columnRow)
    const serializedValue = this.serializeDocumentDatabaseFieldValue(column, input.value)

    if (serializedValue === null) {
      this.db.prepare(`
        DELETE FROM document_database_values
        WHERE document_id = ? AND column_id = ?
      `).run(input.documentId, input.columnId)
      return
    }

    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO document_database_values (document_id, column_id, value_text, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(document_id, column_id)
      DO UPDATE SET value_text = excluded.value_text, updated_at = excluded.updated_at
    `).run(input.documentId, input.columnId, serializedValue, now)
  }

  buildAiPrompt(
    input: AskAiInput,
    relatedNotes: Array<{ title: string; path: string; summary: string; content: string }> = []
  ): string {
    const detail = this.getDocumentDetail(input.documentId)
    if (!detail) {
      throw new Error('Document not found')
    }

    const content = detail.blocks.map((block) => `- [${block.type}] ${block.content}`).join('\n')
    const relatedContext = relatedNotes.length > 0
      ? [
          'Related workspace context:',
          ...relatedNotes.map((note, index) => [
            `Context ${index + 1}: ${note.title}`,
            `Path: ${note.path}`,
            `Summary: ${note.summary || '(empty)'}`,
            note.content
          ].join('\n'))
        ]
      : ['Related workspace context: none']

    return [
      `Document title: ${detail.title}`,
      `Document path: ${detail.path}`,
      `Summary: ${detail.summary}`,
      'Blocks:',
      content,
      '',
      ...relatedContext,
      '',
      `User request: ${input.prompt}`,
      'Answer in concise Chinese with actionable suggestions. Use related workspace context when it is relevant, and mention note paths when you rely on them.'
    ].join('\n')
  }

  buildDocumentBlockAiEditPrompt(
    input: PreviewDocumentBlockAiEditInput,
    resolvedInstruction: string
  ): string {
    const selectedBlocks = input.selectedBlocks
      .map((block) => ({
        ...block,
        type: block.type.trim() || 'paragraph',
        content: block.content
      }))
      .filter((block) => block.type === 'divider' || block.content.trim().length > 0)

    if (selectedBlocks.length === 0) {
      throw new Error('Selected blocks not found')
    }

    const selectedContent = selectedBlocks
      .map((block, index) => [`Block ${index + 1}:`, `[${block.type}]`, block.content].join(' '))
      .join('\n')

    const modeSpecificRules = input.mode === 'table'
      ? [
          'Return exactly one Markdown table as plain text.',
          'Do not wrap the table in code fences.',
          'Do not insert blank lines between table rows.'
        ]
      : [
          'Return only the replacement note content.',
          'Do not add explanations, prefaces, or surrounding quotes.',
          'You may use multiple paragraphs or supported markdown block shortcuts when helpful.'
        ]

    return [
      'You edit selected note blocks for a local-first knowledge management app.',
      `Document title: ${input.documentTitle}`,
      `Document path: ${input.documentPath}`,
      `Document summary: ${input.documentSummary}`,
      `Selected block count: ${selectedBlocks.length}`,
      'Selected blocks:',
      selectedContent,
      '',
      `Requested transformation: ${resolvedInstruction}`,
      '',
      'Output rules:',
      '- Keep the response in the same language as the source unless the instruction explicitly asks otherwise.',
      '- Do not mention the app, the prompt, or that you are an AI.',
      '- Preserve factual meaning unless the instruction explicitly asks for a transformation.',
      ...modeSpecificRules.map((rule) => `- ${rule}`),
      '',
      'Return the replacement content only.'
    ].join('\n')
  }

  getAiApiKey(): string | null {
    return this.readSetting('ai.apiKey')
  }

  getSemanticSearchCandidates(
    input: Pick<SearchSemanticNotesInput, 'excludeDocumentId'> & Partial<Pick<SearchSemanticNotesInput, 'query'>> = {}
  ): SemanticSearchCandidate[] {
    const normalizedQuery = input.query?.trim() ?? ''
    const ftsMatchQuery = this.buildFtsPhraseQuery(normalizedQuery)
    const likeQuery = `%${this.escapeLikePattern(normalizedQuery)}%`
    const documents = !normalizedQuery
      ? input.excludeDocumentId
        ? this.db.prepare(`
        SELECT id, title, path, summary
        FROM documents
        WHERE id != ?
        ORDER BY path ASC
      `).all(input.excludeDocumentId) as SemanticSearchDocumentRow[]
        : this.db.prepare(`
        SELECT id, title, path, summary
        FROM documents
        ORDER BY path ASC
      `).all() as SemanticSearchDocumentRow[]
      : ftsMatchQuery
        ? this.db.prepare(`
        WITH matched_documents AS (
          SELECT document_id
          FROM document_search
          WHERE document_search MATCH ?
          LIMIT 500
        ), matched_blocks AS (
          SELECT document_id
          FROM block_search
          WHERE block_search MATCH ?
          LIMIT 500
        ), matched AS (
          SELECT document_id FROM matched_documents
          UNION
          SELECT document_id FROM matched_blocks
        )
        SELECT d.id, d.title, d.path, d.summary
        FROM documents AS d
        INNER JOIN matched AS m ON m.document_id = d.id
        WHERE (? IS NULL OR d.id != ?)
        ORDER BY d.path ASC
        LIMIT 500
      `).all(
          ftsMatchQuery,
          ftsMatchQuery,
          input.excludeDocumentId ?? null,
          input.excludeDocumentId ?? null
        ) as SemanticSearchDocumentRow[]
        : this.db.prepare(`
        WITH matched_documents AS (
          SELECT document_id
          FROM document_search
          WHERE title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
          LIMIT 500
        ), matched_blocks AS (
          SELECT document_id
          FROM block_search
          WHERE content LIKE ? ESCAPE '\\'
          LIMIT 500
        ), matched AS (
          SELECT document_id FROM matched_documents
          UNION
          SELECT document_id FROM matched_blocks
        )
        SELECT d.id, d.title, d.path, d.summary
        FROM documents AS d
        INNER JOIN matched AS m ON m.document_id = d.id
        WHERE (? IS NULL OR d.id != ?)
        ORDER BY d.path ASC
        LIMIT 500
      `).all(
          likeQuery,
          likeQuery,
          likeQuery,
          likeQuery,
          input.excludeDocumentId ?? null,
          input.excludeDocumentId ?? null
        ) as SemanticSearchDocumentRow[]

    if (documents.length === 0) {
      return []
    }

    const documentIds = documents.map((document) => document.id)
    const placeholders = documentIds.map(() => '?').join(', ')
    const blockRows = this.db.prepare(`
      SELECT document_id, type, content, sort_order
      FROM blocks
      WHERE document_id IN (${placeholders})
      ORDER BY document_id ASC, sort_order ASC
    `).all(...documentIds) as SemanticSearchBlockRow[]

    const blocksByDocumentId = new Map<string, SemanticSearchBlockRow[]>()
    blockRows.forEach((block) => {
      const current = blocksByDocumentId.get(block.document_id)
      if (current) {
        current.push(block)
        return
      }
      blocksByDocumentId.set(block.document_id, [block])
    })

    return documents.map((document) => {
      const blocks = blocksByDocumentId.get(document.id) ?? []
      const blockContent = blocks
        .map((block) => `- [${block.type}] ${block.content}`)
        .join('\n')
      const content = [
        `Title: ${document.title}`,
        `Path: ${document.path}`,
        `Summary: ${document.summary || '(empty)'}`,
        'Blocks:',
        blockContent || '- [empty] (no blocks yet)'
      ].join('\n')
      const snippet = blocks
        .map((block) => block.content.trim())
        .find((value) => value.length > 0)
        ?? document.summary.trim()
        ?? document.path

      return {
        documentId: document.id,
        title: document.title,
        path: document.path,
        summary: document.summary,
        snippet,
        content,
        contentHash: createHash('sha256').update(content).digest('hex')
      }
    })
  }

  private getDocumentIdsInPathSubtree(rootPath: string): string[] {
    const rows = this.db.prepare(`
      SELECT id
      FROM documents
      WHERE path = ? OR path LIKE ? ESCAPE '\\'
      ORDER BY path ASC
    `).all(rootPath, `${this.escapeLikePattern(rootPath)}/%`) as Array<{ id: string }>

    return rows.map((row) => row.id)
  }

  getDocumentSuggestions(query: string, excludeDocumentId: string | null = null): DocumentSuggestion[] {
    const normalizedQuery = query.trim()
    const ftsMatchQuery = this.buildFtsPhraseQuery(normalizedQuery)
    const likeQuery = `%${this.escapeLikePattern(normalizedQuery)}%`
    const prefixQuery = `${this.escapeLikePattern(normalizedQuery)}%`

    if (!normalizedQuery) {
      return this.db.prepare(`
        SELECT id, title, path
        FROM documents
        WHERE (? IS NULL OR id != ?)
        ORDER BY LENGTH(path) ASC, path ASC
        LIMIT 8
      `).all(excludeDocumentId, excludeDocumentId) as DocumentSuggestion[]
    }

    if (ftsMatchQuery) {
      return this.db.prepare(`
        SELECT d.id, d.title, d.path
        FROM document_search AS ds
        INNER JOIN documents AS d ON d.id = ds.document_id
        WHERE document_search MATCH ?
          AND (? IS NULL OR d.id != ?)
        ORDER BY
          CASE
            WHEN d.title = ? THEN 0
            WHEN d.path = ? THEN 1
            WHEN d.title LIKE ? ESCAPE '\\' THEN 2
            ELSE 3
          END,
          LENGTH(d.path) ASC,
          d.path ASC
        LIMIT 8
      `).all(
        ftsMatchQuery,
        excludeDocumentId,
        excludeDocumentId,
        normalizedQuery,
        normalizedQuery,
        prefixQuery
      ) as DocumentSuggestion[]
    }

    return this.db.prepare(`
      SELECT d.id, d.title, d.path
      FROM document_search AS ds
      INNER JOIN documents AS d ON d.id = ds.document_id
      WHERE (ds.title LIKE ? ESCAPE '\\' OR ds.path LIKE ? ESCAPE '\\')
        AND (? IS NULL OR d.id != ?)
      ORDER BY
        CASE
          WHEN d.title = ? THEN 0
          WHEN d.path = ? THEN 1
          WHEN d.title LIKE ? ESCAPE '\\' THEN 2
          ELSE 3
        END,
        LENGTH(d.path) ASC,
        d.path ASC
      LIMIT 8
    `).all(
      likeQuery,
      likeQuery,
      excludeDocumentId,
      excludeDocumentId,
      normalizedQuery,
      normalizedQuery,
      prefixQuery
    ) as DocumentSuggestion[]
  }

  searchDocuments(query: string): GlobalSearchResult[] {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) {
      return []
    }
    const ftsMatchQuery = this.buildFtsPhraseQuery(normalizedQuery)
    const likeQuery = `%${this.escapeLikePattern(normalizedQuery)}%`
    const prefixQuery = `${this.escapeLikePattern(normalizedQuery)}%`

    const docMatches = ftsMatchQuery
      ? this.db.prepare(`
        SELECT d.id, d.title, d.path, d.summary
        FROM document_search AS ds
        INNER JOIN documents AS d ON d.id = ds.document_id
        WHERE document_search MATCH ?
        ORDER BY
          CASE WHEN d.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
          LENGTH(d.path) ASC
        LIMIT 5
      `).all(ftsMatchQuery, prefixQuery) as Array<{
        id: string; title: string; path: string; summary: string
      }>
      : this.db.prepare(`
        SELECT d.id, d.title, d.path, d.summary
        FROM document_search AS ds
        INNER JOIN documents AS d ON d.id = ds.document_id
        WHERE ds.title LIKE ? ESCAPE '\\' OR ds.summary LIKE ? ESCAPE '\\'
        ORDER BY
          CASE WHEN ds.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
          LENGTH(d.path) ASC
        LIMIT 5
      `).all(likeQuery, likeQuery, likeQuery) as Array<{
        id: string; title: string; path: string; summary: string
      }>

    const blockMatches = ftsMatchQuery
      ? this.db.prepare(`
        SELECT b.id AS block_id, b.type AS block_type, b.content AS block_content,
               d.id AS document_id, d.title AS document_title, d.path AS document_path
        FROM block_search AS bs
        INNER JOIN blocks AS b ON b.id = bs.block_id
        INNER JOIN documents AS d ON d.id = b.document_id
        WHERE block_search MATCH ?
        ORDER BY LENGTH(b.content) ASC
        LIMIT 20
      `).all(ftsMatchQuery) as Array<{
        block_id: string; block_type: string; block_content: string;
        document_id: string; document_title: string; document_path: string
      }>
      : this.db.prepare(`
        SELECT b.id AS block_id, b.type AS block_type, b.content AS block_content,
               d.id AS document_id, d.title AS document_title, d.path AS document_path
        FROM block_search AS bs
        INNER JOIN blocks AS b ON b.id = bs.block_id
        INNER JOIN documents AS d ON d.id = b.document_id
        WHERE bs.content LIKE ? ESCAPE '\\'
        ORDER BY LENGTH(b.content) ASC
        LIMIT 20
      `).all(likeQuery) as Array<{
      block_id: string; block_type: string; block_content: string;
      document_id: string; document_title: string; document_path: string
    }>

    const docResults: GlobalSearchResult[] = docMatches.map((doc) => ({
      documentId: doc.id,
      documentTitle: doc.title,
      documentPath: doc.path,
      matchType: 'title' as const,
      snippet: doc.summary.slice(0, 120)
    }))

    const seenDocs = new Set(docResults.map((r) => r.documentId))
    const blockResults: GlobalSearchResult[] = []
    for (const row of blockMatches) {
      const idx = row.block_content.toLowerCase().indexOf(normalizedQuery.toLowerCase())
      const start = Math.max(0, idx - 40)
      const snippet = (start > 0 ? '…' : '') + row.block_content.slice(start, start + 120) + (row.block_content.length > start + 120 ? '…' : '')
      blockResults.push({
        documentId: row.document_id,
        documentTitle: row.document_title,
        documentPath: row.document_path,
        matchType: 'block' as const,
        snippet,
        blockId: row.block_id,
        blockType: row.block_type
      })
      seenDocs.add(row.document_id)
    }

    return [...docResults, ...blockResults].slice(0, 30)
  }

  getExportDocuments(): ExportDocument[] {
    const defaultDatabaseId = this.getDefaultDocumentDatabaseId()
    const documentDatabaseColumns = this.getDocumentDatabaseColumns(defaultDatabaseId)
    const columnById = new Map(documentDatabaseColumns.map((column) => [column.id, column]))
    const documents = this.db.prepare(`
      SELECT id, title, path, summary, updated_at
      FROM documents
      ORDER BY path ASC
    `).all() as ExportDocumentRow[]

    const documentDatabaseValueRows = this.db.prepare(`
      SELECT document_id, column_id, value_text
      FROM document_database_values
      WHERE entity_id IS NULL
      ORDER BY document_id ASC, column_id ASC
    `).all() as Array<{
      document_id: string | null
      column_id: string
      value_text: string | null
    }>
    const fieldValuesByDocumentId = new Map<string, Record<string, DocumentDatabaseFieldValue>>()

    for (const row of documentDatabaseValueRows) {
      if (!row.document_id) {
        continue
      }

      const column = columnById.get(row.column_id)
      if (!column) {
        continue
      }

      const fieldValues = fieldValuesByDocumentId.get(row.document_id) ?? {}
      fieldValues[row.column_id] = this.parseDocumentDatabaseFieldValue(column, row.value_text)
      fieldValuesByDocumentId.set(row.document_id, fieldValues)
    }

    const blockRows = this.db.prepare(`
      SELECT id, document_id, type, content, checked, depth, tags_json, parent_block_id, sort_order, language, highlight
      FROM blocks
      ORDER BY document_id ASC, sort_order ASC
    `).all() as ExportDocumentBlockRow[]
    const blocksByDocumentId = new Map<string, ExportDocumentBlockRow[]>()
    for (const block of blockRows) {
      const blocks = blocksByDocumentId.get(block.document_id) ?? []
      blocks.push(block)
      blocksByDocumentId.set(block.document_id, blocks)
    }

    return documents.map((document) => ({
      id: document.id,
      title: document.title,
      path: document.path,
      summary: document.summary,
      updatedAt: document.updated_at,
      documentDatabaseColumns: documentDatabaseColumns.map((column) => ({ ...column, options: [...column.options] })),
      documentDatabaseFieldValues: { ...(fieldValuesByDocumentId.get(document.id) ?? {}) },
      blocks: (blocksByDocumentId.get(document.id) ?? []).map((block) => ({
        id: block.id,
        type: block.type,
        content: block.content,
        checked: Boolean(block.checked),
        depth: Math.max(0, block.depth ?? 0),
        tags: this.parseBlockTags(block.tags_json),
        parentBlockId: block.parent_block_id ?? null,
        sortOrder: block.sort_order,
        language: block.language ?? undefined,
        highlight: block.highlight ?? undefined
      }))
    }))
  }

  getExportStandaloneDatabases(): ExportStandaloneDatabase[] {
    const defaultDatabaseId = this.getDefaultDocumentDatabaseId()
    const documentPathById = new Map(
      this.getAllDocumentSnapshots().map((document) => [document.id, document.path])
    )

    return this.getDatabases()
      .filter((database) => database.id !== defaultDatabaseId)
      .map((database) => ({
        ...database,
        columns: this.getDocumentDatabaseColumns(database.id).map((column) => ({
          ...column,
          options: [...column.options]
        })),
        savedViews: this.getDatabaseSavedViews(database.id).map((view) => ({ ...view })),
        entities: this.getDatabaseEntities(database.id).map((entity) => ({
          id: entity.id,
          documentId: entity.documentId,
          documentPath: entity.documentId ? documentPathById.get(entity.documentId) ?? null : null,
          createdAt: entity.createdAt,
          updatedAt: entity.updatedAt,
          fieldValues: Object.fromEntries(
            Object.entries(entity.fieldValues).map(([columnId, value]) => [columnId, Array.isArray(value) ? [...value] : value])
          ) as Record<string, DocumentDatabaseFieldValue>
        }))
      }))
  }

  getBackupRevision(): string {
    const revision = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM documents) AS document_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM documents) AS document_updated_at,
        (SELECT COUNT(*) FROM blocks) AS block_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM blocks) AS block_updated_at,
        (SELECT COUNT(*) FROM databases) AS database_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM databases) AS database_updated_at,
        (SELECT COUNT(*) FROM document_database_columns) AS column_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM document_database_columns) AS column_updated_at,
        (SELECT COUNT(*) FROM database_saved_views) AS view_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM database_saved_views) AS view_updated_at,
        (SELECT COUNT(*) FROM database_entities) AS entity_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM database_entities) AS entity_updated_at,
        (SELECT COUNT(*) FROM database_entity_values) AS entity_value_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM database_entity_values) AS entity_value_updated_at,
        (SELECT COUNT(*) FROM document_database_values) AS document_value_count,
        (SELECT COALESCE(MAX(updated_at), '') FROM document_database_values) AS document_value_updated_at
    `).get() as Record<string, string | number>
    return JSON.stringify(revision)
  }

  saveSetting(key: string, value: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now)
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  }

  getSettingPublic(key: string): string | null {
    return this.readSetting(key)
  }

  getSettingsByPrefix(prefix: string): Record<string, string> {
    const rows = this.db.prepare(`
      SELECT key, value
      FROM app_settings
      WHERE substr(key, 1, ?) = ?
    `).all(prefix.length, prefix) as Array<{ key: string; value: string }>

    return Object.fromEntries(rows.map((row) => [row.key, row.value]))
  }

  getPluginWorkspaceDocuments(): DocumentDetail[] {
    const documents = this.db.prepare(`
      SELECT id, title, path, summary, updated_at
      FROM documents
      ORDER BY sort_order ASC, created_at ASC
    `).all() as DocumentDetailRow[]
    if (documents.length === 0) {
      return []
    }

    const detailsById = new Map<string, DocumentDetail>()
    for (const document of documents) {
      detailsById.set(document.id, {
        id: document.id,
        title: document.title,
        path: document.path,
        summary: document.summary,
        updatedAt: document.updated_at,
        blocks: [],
        children: [],
        outgoingLinks: [],
        backlinks: []
      })
    }

    const blockContentsByDocumentId = new Map<string, string[]>()
    const blocks = this.db.prepare(`
      SELECT document_id, id, type, content, checked, depth, tags_json,
        parent_block_id, sort_order, language, highlight
      FROM blocks
      ORDER BY document_id ASC, sort_order ASC
    `).all() as PluginWorkspaceBlockRow[]
    for (const block of blocks) {
      detailsById.get(block.document_id)?.blocks.push({
        id: block.id,
        type: block.type,
        content: block.content,
        checked: Boolean(block.checked),
        depth: Math.max(0, block.depth ?? 0),
        tags: this.parseBlockTags(block.tags_json),
        parentBlockId: block.parent_block_id ?? null,
        sortOrder: block.sort_order,
        language: block.language ?? undefined,
        highlight: block.highlight ?? undefined
      })

      const contents = blockContentsByDocumentId.get(block.document_id)
      if (contents) {
        contents.push(block.content)
      } else {
        blockContentsByDocumentId.set(block.document_id, [block.content])
      }
    }

    const outgoingLinks = this.db.prepare(`
      SELECT links.source_document_id AS owner_document_id,
        target.id, target.title, target.path, links.label
      FROM links
      INNER JOIN documents AS target ON target.id = links.target_document_id
      ORDER BY links.source_document_id ASC, target.path ASC
    `).all() as PluginWorkspaceLinkedDocumentRow[]
    for (const link of outgoingLinks) {
      detailsById.get(link.owner_document_id)?.outgoingLinks.push({
        id: link.id,
        title: link.title,
        path: link.path,
        label: link.label
      })
    }

    const backlinks = this.db.prepare(`
      SELECT links.target_document_id AS owner_document_id,
        source.id, source.title, source.path, links.label,
        links.source_document_id AS context_source_document_id
      FROM links
      INNER JOIN documents AS source ON source.id = links.source_document_id
      ORDER BY links.target_document_id ASC, source.path ASC
    `).all() as Array<PluginWorkspaceLinkedDocumentRow & { context_source_document_id: string }>
    for (const link of backlinks) {
      const sourceContents = blockContentsByDocumentId.get(link.context_source_document_id)
      const contextContent = sourceContents?.find((content) => content.includes(link.label))
      detailsById.get(link.owner_document_id)?.backlinks.push({
        id: link.id,
        title: link.title,
        path: link.path,
        label: link.label,
        contextSnippet: contextContent !== undefined ? contextContent.slice(0, 200) : undefined
      })
    }

    const children = this.db.prepare(`
      SELECT parent_id AS owner_document_id, id, title, path
      FROM documents
      WHERE parent_id IS NOT NULL
      ORDER BY parent_id ASC, path ASC
    `).all() as PluginWorkspaceChildRow[]
    for (const child of children) {
      detailsById.get(child.owner_document_id)?.children.push({
        id: child.id,
        title: child.title,
        path: child.path
      })
    }

    return documents.map((document) => detailsById.get(document.id)!)
  }

  findDocumentIdsByDatabaseValue(columnId: string, value: DocumentDatabaseFieldValue): string[] {
    const defaultDatabaseId = this.getDefaultDocumentDatabaseId()
    const columnRow = this.db.prepare(`
      SELECT id, database_id, name, type, options_json, sort_order
      FROM document_database_columns
      WHERE id = ? AND database_id = ?
    `).get(columnId, defaultDatabaseId) as DocumentDatabaseColumnRow | undefined

    if (!columnRow) {
      throw new Error('Database column not found.')
    }

    const column = this.mapDocumentDatabaseColumnRow(columnRow)
    const serializedValue = this.serializeDocumentDatabaseFieldValue(column, value)
    if (serializedValue === null) {
      return []
    }

    const rows = this.db.prepare(`
      SELECT document_id
      FROM document_database_values
      WHERE entity_id IS NULL AND column_id = ? AND value_text = ? AND document_id IS NOT NULL
      ORDER BY document_id ASC
    `).all(columnId, serializedValue) as Array<{ document_id: string | null }>

    return rows
      .map((row) => row.document_id)
      .filter((documentId): documentId is string => Boolean(documentId))
  }

  getAiConfigPublic(): AiConfig {
    return this.getAiConfig()
  }

  recordWorkspaceEvent(input: {
    type: WorkspaceEventType
    title: string
    description: string
    documentId?: string | null
    createdAt?: string
  }): void {
    const now = input.createdAt ?? new Date().toISOString()
    this.db.prepare(`
      INSERT INTO workspace_events (id, type, title, description, document_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.type,
      input.title.trim(),
      input.description.trim(),
      input.documentId ?? null,
      now
    )

    this.db.prepare(`
      DELETE FROM workspace_events
      WHERE id NOT IN (
        SELECT id
        FROM workspace_events
        ORDER BY created_at DESC
        LIMIT 40
      )
    `).run()
  }

  destroy(): void {
    this.db.close()
  }

  getDatabasePath(): string {
    return this.databasePath
  }

  getDocumentCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM documents').get() as CountRow).count
  }

  async backupDatabase(destinationPath: string): Promise<void> {
    mkdirSync(dirname(destinationPath), { recursive: true })
    await this.db.backup(destinationPath)
  }

  private getSummary(
    backupRoot: string,
    documentRows?: DocumentCatalogRow[]
  ): WorkspaceSummary {
    const counts = documentRows
      ? {
          documents: documentRows.length,
          blocks: documentRows.reduce((total, document) => total + document.block_count, 0),
          links: documentRows.reduce((total, document) => total + document.link_count, 0)
        }
      : this.db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM documents) AS documents,
            (SELECT COUNT(*) FROM blocks) AS blocks,
            (SELECT COUNT(*) FROM links) AS links
        `).get() as Pick<WorkspaceSummary, 'documents' | 'blocks' | 'links'>
    const lastBackupAt = this.readSetting('backup.lastRunAt')

    return {
      databasePath: this.databasePath,
      backupRoot,
      documents: counts.documents,
      blocks: counts.blocks,
      links: counts.links,
      lastBackupAt
    }
  }

  private getRecentDocuments(documentRows?: HomeDocumentCatalogRow[]): RecentDocument[] {
    if (documentRows) {
      return [...documentRows]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, 5)
        .map((row) => ({
          id: row.id,
          title: row.title,
          path: row.path,
          updatedAt: row.updated_at,
          blockCount: row.block_count
        }))
    }

    const rows = this.db.prepare(`
      WITH recent_documents AS (
        SELECT id, title, path, updated_at, block_count
        FROM documents
        ORDER BY updated_at DESC
        LIMIT 5
      )
      SELECT
        recent_documents.id,
        recent_documents.title,
        recent_documents.path,
        recent_documents.updated_at,
        recent_documents.block_count
      FROM recent_documents
      ORDER BY recent_documents.updated_at DESC
    `).all() as DocumentRow[]

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      updatedAt: row.updated_at,
      blockCount: row.block_count
    }))
  }

  private getRecentWorkspaceEvents(limit = 8): WorkspaceEventRecord[] {
    const rows = this.db.prepare(`
      SELECT id, type, title, description, document_id, created_at
      FROM workspace_events
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as WorkspaceEventRow[]

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      description: row.description,
      documentId: row.document_id ?? null,
      createdAt: row.created_at
    }))
  }

  private getHomeDocumentCatalogRows(): HomeDocumentCatalogRow[] {
    return this.db.prepare(`
      SELECT
        documents.id,
        documents.title,
        documents.path,
        documents.summary,
        documents.parent_id,
        parents.title AS parent_title,
        documents.updated_at,
        documents.sort_order,
        documents.block_count,
        documents.link_count,
        documents.child_count
      FROM documents
      LEFT JOIN documents AS parents ON parents.id = documents.parent_id
      ORDER BY documents.path ASC
    `).all() as HomeDocumentCatalogRow[]
  }

  private buildDocumentCatalog(
    databaseColumns: DocumentDatabaseColumn[],
    defaultDatabaseId: string,
    documentRows: DocumentCatalogRow[]
  ): DocumentCatalogEntry[] {
    return this.buildDocumentCatalogEntries(
      databaseColumns,
      defaultDatabaseId,
      documentRows,
      this.getDocumentCatalogEntityRows(defaultDatabaseId),
      false
    )
  }

  private getDocumentCatalogEntityRows(
    databaseId: string,
    limit?: number,
    offset = 0
  ): DocumentCatalogRow[] {
    const statement = this.db.prepare(`
      SELECT
        de.id,
        d.name AS title,
        d.name AS path,
        d.description AS summary,
        NULL AS parent_id,
        NULL AS parent_title,
        de.updated_at,
        0 AS block_count,
        0 AS link_count,
        0 AS child_count
      FROM database_entities de
      JOIN databases d ON d.id = de.database_id
      WHERE de.document_id IS NULL AND de.database_id = ?
      ORDER BY de.updated_at DESC
      ${limit === undefined ? '' : 'LIMIT ? OFFSET ?'}
    `)
    return (limit === undefined ? statement.all(databaseId) : statement.all(databaseId, limit, offset)) as DocumentCatalogRow[]
  }

  private buildDocumentCatalogEntries(
    databaseColumns: DocumentDatabaseColumn[],
    databaseId: string,
    documentRows: DocumentCatalogRow[],
    entityRows: DocumentCatalogRow[],
    limitFieldValuesToRows: boolean
  ): DocumentCatalogEntry[] {
    const allRows = [...documentRows, ...entityRows]
    const columnById = new Map(databaseColumns.map((column) => [column.id, column]))
    const fieldRows = limitFieldValuesToRows
      ? this.getDocumentCatalogFieldRowsForTargets(
          databaseId,
          documentRows.map((row) => row.id),
          entityRows.map((row) => row.id)
        )
      : this.db.prepare(`
          SELECT
            NULL AS entity_id,
            values_table.document_id,
            values_table.column_id,
            values_table.value_text
          FROM document_database_values AS values_table
          INNER JOIN document_database_columns AS columns_table ON columns_table.id = values_table.column_id
          WHERE values_table.entity_id IS NULL
            AND columns_table.database_id = ?

          UNION ALL

          SELECT
            values_table.entity_id,
            NULL AS document_id,
            values_table.column_id,
            values_table.value_text
          FROM database_entity_values AS values_table
          INNER JOIN database_entities AS entities_table ON entities_table.id = values_table.entity_id
          INNER JOIN document_database_columns AS columns_table ON columns_table.id = values_table.column_id
          WHERE entities_table.database_id = ?
            AND columns_table.database_id = ?

          ORDER BY entity_id ASC, document_id ASC, column_id ASC
        `).all(databaseId, databaseId, databaseId) as DocumentCatalogFieldRow[]
    const fieldValuesByDocumentId = new Map<string, Record<string, DocumentDatabaseFieldValue>>()
    const allRowIds = new Set(allRows.map((row) => row.id))

    for (const row of fieldRows) {
      const targetId = row.entity_id ?? row.document_id
      if (!targetId || !allRowIds.has(targetId)) continue
      const column = columnById.get(row.column_id)
      if (!column) {
        continue
      }

      const fieldValues = fieldValuesByDocumentId.get(targetId) ?? {}
      fieldValues[row.column_id] = this.parseDocumentDatabaseFieldValue(column, row.value_text)
      fieldValuesByDocumentId.set(targetId, fieldValues)
    }

    return allRows.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      summary: row.summary,
      parentId: row.parent_id,
      parentTitle: row.parent_title,
      updatedAt: row.updated_at,
      blockCount: row.block_count,
      linkCount: row.link_count,
      childCount: row.child_count,
      fieldValues: fieldValuesByDocumentId.get(row.id) ?? {}
    }))
  }

  private getDocumentCatalogFieldRowsForTargets(
    databaseId: string,
    documentIds: string[],
    entityIds: string[]
  ): DocumentCatalogFieldRow[] {
    const documentRows = documentIds.length > 0
      ? this.db.prepare(`
          SELECT
            NULL AS entity_id,
            values_table.document_id,
            values_table.column_id,
            values_table.value_text
          FROM document_database_values AS values_table
          INNER JOIN document_database_columns AS columns_table ON columns_table.id = values_table.column_id
          WHERE values_table.entity_id IS NULL
            AND columns_table.database_id = ?
            AND values_table.document_id IN (${documentIds.map(() => '?').join(', ')})
          ORDER BY values_table.document_id ASC, values_table.column_id ASC
        `).all(databaseId, ...documentIds) as DocumentCatalogFieldRow[]
      : []
    const entityRows = entityIds.length > 0
      ? this.db.prepare(`
          SELECT
            values_table.entity_id,
            NULL AS document_id,
            values_table.column_id,
            values_table.value_text
          FROM database_entity_values AS values_table
          INNER JOIN database_entities AS entities_table ON entities_table.id = values_table.entity_id
          INNER JOIN document_database_columns AS columns_table ON columns_table.id = values_table.column_id
          WHERE entities_table.database_id = ?
            AND columns_table.database_id = ?
            AND values_table.entity_id IN (${entityIds.map(() => '?').join(', ')})
          ORDER BY values_table.entity_id ASC, values_table.column_id ASC
        `).all(databaseId, databaseId, ...entityIds) as DocumentCatalogFieldRow[]
      : []

    return [...documentRows, ...entityRows]
  }

  getDocumentDatabaseColumns(databaseId: string = this.getDefaultDocumentDatabaseId()): DocumentDatabaseColumn[] {
    const rows = this.db.prepare(`
      SELECT id, database_id, name, type, options_json, sort_order
      FROM document_database_columns
      WHERE database_id = ?
      ORDER BY sort_order ASC, name ASC
    `).all(databaseId) as DocumentDatabaseColumnRow[]

    return rows.map((row) => this.mapDocumentDatabaseColumnRow(row))
  }

  private buildDocumentTree(rows: HomeDocumentCatalogRow[]): DocumentTreeNode[] {
    interface TreeBuilderEntry {
      node: DocumentTreeNode
      parentId: string | null
      sortOrder: number
    }

    const nodeMap = new Map<string, TreeBuilderEntry>()
    const roots: DocumentTreeNode[] = []

    for (const row of rows) {
      nodeMap.set(row.id, {
        node: {
          id: row.id,
          title: row.title,
          path: row.path,
          updatedAt: row.updated_at,
          children: []
        },
        parentId: row.parent_id,
        sortOrder: row.sort_order
      })
    }

    for (const entry of nodeMap.values()) {
      if (!entry.parentId) {
        roots.push(entry.node)
        continue
      }

      const parent = nodeMap.get(entry.parentId)
      if (parent) {
        parent.node.children.push(entry.node)
      } else {
        roots.push(entry.node)
      }
    }

    const pendingSiblingGroups: DocumentTreeNode[][] = [roots]
    while (pendingSiblingGroups.length > 0) {
      const siblings = pendingSiblingGroups.pop()
      if (!siblings) continue
      siblings.sort((left, right) => (
        (nodeMap.get(left.id)?.sortOrder ?? 0) - (nodeMap.get(right.id)?.sortOrder ?? 0)
      ))
      for (const node of siblings) {
        if (node.children.length > 0) {
          pendingSiblingGroups.push(node.children)
        }
      }
    }

    return roots
  }

  private normalizeDocumentTitle(title: string): string {
    const normalized = title.trim() || 'Untitled'
    if (/[/\\\x00-\x1F]/.test(normalized) || normalized === '.' || normalized === '..') {
      throw new Error('Document title cannot contain path separators, control characters, or dot segments')
    }

    return normalized
  }

  runInTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation)()
  }

  runInBulkDocumentMutation<T>(operation: () => T): T {
    return this.runInTransaction(() => {
      this.deferredLinkResyncDepth += 1
      try {
        const result = operation()
        this.deferredLinkResyncDepth -= 1
        if (this.deferredLinkResyncDepth === 0 && this.deferredFullLinkResyncRequested) {
          this.deferredFullLinkResyncRequested = false
          this.resyncLinksForAllDocuments()
        }
        return result
      } catch (error) {
        this.deferredLinkResyncDepth -= 1
        if (this.deferredLinkResyncDepth === 0) {
          this.deferredFullLinkResyncRequested = false
        }
        throw error
      }
    })
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`)
  }

  private buildFtsPhraseQuery(query: string): string | null {
    const trimmed = query.trim()
    if (trimmed.length < 3) {
      return null
    }
    return `"${trimmed.replace(/"/g, '""')}"`
  }

  private generateSiblingTitle(parentId: string | null, baseTitle: string, excludeDocumentId?: string): string {
    let candidate = baseTitle
    let index = 1

    while (this.documentTitleExists(parentId, candidate, excludeDocumentId)) {
      candidate = `${baseTitle} ${index}`
      index += 1
    }

    return candidate
  }

  private mapDocumentDatabaseColumnRow(row: DocumentDatabaseColumnRow): DocumentDatabaseColumn {
    const type = this.normalizeDocumentDatabaseColumnType(row.type)
    return {
      id: row.id,
      name: row.name,
      type,
      options: this.normalizeDocumentDatabaseColumnOptions(type, this.parseDocumentDatabaseColumnOptions(row.options_json)),
      sortOrder: row.sort_order
    }
  }

  private getDatabaseSavedView(viewId: string): DatabaseSavedView {
    const row = this.db.prepare(`
      SELECT id, database_id, name, filter_query, filter_scope, sort_mode, view_mode, created_at, updated_at
      FROM database_saved_views
      WHERE id = ?
    `).get(viewId) as DatabaseSavedViewRow | undefined

    if (!row) {
      throw new Error('Saved view not found.')
    }

    return this.mapDatabaseSavedViewRow(row)
  }

  private mapDatabaseSavedViewRow(row: DatabaseSavedViewRow): DatabaseSavedView {
    return {
      id: row.id,
      databaseId: row.database_id,
      name: row.name,
      filterQuery: row.filter_query,
      filterScope: row.filter_scope,
      sortMode: this.normalizeDatabaseSavedViewSortMode(row.sort_mode),
      viewMode: this.normalizeDatabaseSavedViewLayoutMode(row.view_mode),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private assertDatabaseExists(databaseId: string): void {
    const normalizedDatabaseId = databaseId.trim()
    const row = normalizedDatabaseId
      ? this.db.prepare('SELECT id FROM databases WHERE id = ?').get(normalizedDatabaseId) as { id: string } | undefined
      : undefined

    if (!row) {
      throw new Error('Database not found.')
    }
  }

  private assertDatabaseSavedViewNameAvailable(databaseId: string, name: string, excludeViewId?: string): void {
    const existing = excludeViewId
      ? this.db.prepare(`
          SELECT id
          FROM database_saved_views
          WHERE database_id = ?
            AND name = ? COLLATE NOCASE
            AND id != ?
        `).get(databaseId, name, excludeViewId) as { id: string } | undefined
      : this.db.prepare(`
          SELECT id
          FROM database_saved_views
          WHERE database_id = ?
            AND name = ? COLLATE NOCASE
        `).get(databaseId, name) as { id: string } | undefined

    if (existing) {
      throw new Error('A saved view with this name already exists in this database.')
    }
  }

  private normalizeDatabaseSavedViewName(name: string): string {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Saved view name is required.')
    }

    return trimmedName
  }

  private normalizeDatabaseSavedViewSortMode(sortMode: string): DatabaseSavedViewSortMode {
    switch (sortMode) {
      case 'updated-desc':
      case 'updated-asc':
      case 'created-desc':
      case 'created-asc':
        return sortMode
      default:
        throw new Error(`Unsupported saved view sort mode: ${sortMode}`)
    }
  }

  private normalizeDatabaseSavedViewLayoutMode(viewMode: string): DatabaseSavedViewLayoutMode {
    switch (viewMode) {
      case 'cards':
      case 'table':
        return viewMode
      default:
        throw new Error(`Unsupported saved view layout mode: ${viewMode}`)
    }
  }

  private normalizeDocumentDatabaseColumnType(type: string): DocumentDatabaseColumnType {
    switch (type) {
      case 'text':
      case 'select':
      case 'multi-select':
      case 'date':
      case 'checkbox':
        return type
      default:
        throw new Error(`Unsupported database column type: ${type}`)
    }
  }

  private parseDocumentDatabaseColumnOptions(optionsJson: string): string[] {
    try {
      const parsed = JSON.parse(optionsJson) as unknown
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
    } catch {
      return []
    }
  }

  private normalizeDocumentDatabaseColumnOptions(type: DocumentDatabaseColumnType, options: string[]): string[] {
    const normalizedOptions = [...new Set(options.map((option) => option.trim()).filter(Boolean))]

    if ((type === 'select' || type === 'multi-select') && normalizedOptions.length === 0) {
      throw new Error(`${type === 'select' ? 'Select' : 'Multi-select'} columns require at least one option.`)
    }

    return normalizedOptions
  }

  private pruneSelectDocumentDatabaseValues(columnId: string, options: string[], now: string): void {
    const placeholders = options.map(() => '?').join(', ')

    this.db.prepare(`
      DELETE FROM document_database_values
      WHERE column_id = ?
        AND value_text IS NOT NULL
        AND value_text NOT IN (${placeholders})
    `).run(columnId, ...options)
  }

  private pruneMultiSelectDocumentDatabaseValues(columnId: string, options: string[], now: string): void {
    const rows = this.db.prepare(`
      SELECT document_id, column_id, value_text
      FROM document_database_values
      WHERE column_id = ? AND value_text IS NOT NULL
    `).all(columnId) as DocumentDatabaseValueRow[]

    const deleteValue = this.db.prepare(`
      DELETE FROM document_database_values
      WHERE document_id = ? AND column_id = ?
    `)
    const updateValue = this.db.prepare(`
      UPDATE document_database_values
      SET value_text = ?, updated_at = ?
      WHERE document_id = ? AND column_id = ?
    `)

    for (const row of rows) {
      let parsedValue: unknown
      try {
        parsedValue = row.value_text ? JSON.parse(row.value_text) : []
      } catch {
        parsedValue = []
      }

      const normalizedValues = Array.isArray(parsedValue)
        ? parsedValue.filter((value): value is string => typeof value === 'string' && options.includes(value))
        : []

      if (normalizedValues.length === 0) {
        deleteValue.run(row.document_id, row.column_id)
        continue
      }

      const nextValueText = JSON.stringify([...new Set(normalizedValues)])
      if (nextValueText !== row.value_text) {
        updateValue.run(nextValueText, now, row.document_id, row.column_id)
      }
    }
  }

  private parseDocumentDatabaseFieldValue(column: DocumentDatabaseColumn, valueText: string | null): DocumentDatabaseFieldValue {
    if (valueText === null) {
      return null
    }

    switch (column.type) {
      case 'checkbox':
        return valueText === 'true'
      case 'multi-select':
        try {
          const parsed = JSON.parse(valueText) as unknown
          return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
        } catch {
          return []
        }
      case 'text':
      case 'select':
      case 'date':
      default:
        return valueText
    }
  }

  private serializeDocumentDatabaseFieldValue(column: DocumentDatabaseColumn, value: DocumentDatabaseFieldValue): string | null {
    if (value === null || value === undefined) {
      return null
    }

    switch (column.type) {
      case 'text': {
        if (typeof value !== 'string') {
          throw new Error(`Value for ${column.name} must be a string.`)
        }

        const nextValue = value.trim()
        return nextValue.length > 0 ? nextValue : null
      }
      case 'select': {
        if (typeof value !== 'string') {
          throw new Error(`Value for ${column.name} must be a string.`)
        }

        const nextValue = value.trim()
        if (!nextValue) {
          return null
        }

        if (!column.options.includes(nextValue)) {
          throw new Error(`"${nextValue}" is not a valid option for ${column.name}.`)
        }

        return nextValue
      }
      case 'multi-select': {
        if (!Array.isArray(value)) {
          throw new Error(`Value for ${column.name} must be a list of options.`)
        }

        const normalizedValues = [...new Set(value.map((item) => item.trim()).filter(Boolean))]
        if (normalizedValues.length === 0) {
          return null
        }

        const invalidOption = normalizedValues.find((option) => !column.options.includes(option))
        if (invalidOption) {
          throw new Error(`"${invalidOption}" is not a valid option for ${column.name}.`)
        }

        return JSON.stringify(normalizedValues)
      }
      case 'date': {
        if (typeof value !== 'string') {
          throw new Error(`Value for ${column.name} must be a date string (YYYY-MM-DD).`)
        }

        const nextValue = value.trim()
        if (!nextValue) {
          return null
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(nextValue)) {
          throw new Error('Date values must use YYYY-MM-DD format.')
        }

        return nextValue
      }
      case 'checkbox': {
        if (typeof value !== 'boolean') {
          throw new Error(`Value for ${column.name} must be a boolean.`)
        }
        return value ? 'true' : 'false'
      }
      default:
        return null
    }
  }

  private normalizeBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
    const normalized = blocks.map((block) => {
      const type = block.type.trim() || 'paragraph'
      const normalizedLanguage = type === 'code' && typeof block.language === 'string' && block.language.trim()
        ? block.language.trim()
        : undefined
      return {
        id: block.id,
        type,
        content: block.content,
        checked: type === 'todo' ? Boolean(block.checked) : false,
        depth: this.normalizeNestableDepth(type, block.depth ?? 0),
        parentBlockId: block.parentBlockId ?? null,
        tags: this.normalizeBlockTags(block.tags),
        language: normalizedLanguage,
        highlight: this.normalizeBlockHighlight(block.highlight)
      }
    })

    if (normalized.length > 0) {
      return normalized
    }

    return [
      {
        type: 'paragraph',
        content: 'Start writing here.',
        checked: false,
        depth: 0,
        tags: [],
        highlight: undefined
      }
    ]
  }

  private normalizeBlockHighlight(highlight: string | undefined): string | undefined {
    if (typeof highlight !== 'string') {
      return undefined
    }

    const normalized = highlight.trim().toLowerCase()
    if (!normalized) {
      return undefined
    }

    return ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'].includes(normalized)
      ? normalized
      : undefined
  }

  private normalizeBlockTags(tags: string[] | undefined): string[] {
    if (!Array.isArray(tags) || tags.length === 0) {
      return []
    }

    const uniqueTags = new Set<string>()
    for (const rawTag of tags) {
      const tag = rawTag.trim()
      if (tag) {
        uniqueTags.add(tag)
      }
    }

    return [...uniqueTags]
  }

  private parseBlockTags(tagsJson: string | null | undefined): string[] | undefined {
    if (!tagsJson) {
      return undefined
    }

    try {
      const parsed = JSON.parse(tagsJson) as unknown
      const normalized = this.normalizeBlockTags(Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [])
      return normalized.length > 0 ? normalized : undefined
    } catch {
      return undefined
    }
  }

  private normalizeNestableDepth(type: string, depth: number): number {
    return ['todo', 'bulleted-list', 'numbered-list'].includes(type) ? Math.max(0, Math.min(6, Math.trunc(depth))) : 0
  }

  private resolveBlockRelationship(
    type: string,
    requestedDepth: number,
    requestedParentBlockId: string | null,
    blockId: string,
    resolvedDepthById: Map<string, number>,
    depthStack: Array<string | null>
  ): { depth: number; parentBlockId: string | null } {
    const trimmedParentBlockId = requestedParentBlockId?.trim() ? requestedParentBlockId : null
    const explicitParentDepth = trimmedParentBlockId && trimmedParentBlockId !== blockId
      ? resolvedDepthById.get(trimmedParentBlockId)
      : undefined

    if (explicitParentDepth !== undefined) {
      const explicitDepth = this.normalizeNestableDepth(type, explicitParentDepth + 1)
      if (explicitDepth > explicitParentDepth) {
        return {
          depth: explicitDepth,
          parentBlockId: trimmedParentBlockId
        }
      }
    }

    let fallbackDepth = this.normalizeNestableDepth(type, requestedDepth)
    while (fallbackDepth > 0 && !depthStack[fallbackDepth - 1]) {
      fallbackDepth -= 1
    }

    return {
      depth: fallbackDepth,
      parentBlockId: fallbackDepth > 0 ? depthStack[fallbackDepth - 1] ?? null : null
    }
  }

  private buildPersistedBlocks(blocks: DocumentBlockDraft[]): Array<
    DocumentBlockDraft & {
      id: string
      parentBlockId: string | null
    }
  > {
    const resolvedDepthById = new Map<string, number>()
    const depthStack: Array<string | null> = []

    return blocks.map((block) => {
      const id = block.id?.trim() ? block.id : randomUUID()
      const { depth, parentBlockId } = this.resolveBlockRelationship(
        block.type,
        block.depth,
        block.parentBlockId ?? null,
        id,
        resolvedDepthById,
        depthStack
      )

      depthStack.length = depth + 1
      depthStack[depth] = id
      resolvedDepthById.set(id, depth)

      return {
        ...block,
        id,
        depth,
        parentBlockId
      }
    })
  }

  private resyncLinksForAllDocuments(): void {
    this.resyncLinks()
  }

  private resyncLinksForReferenceChanges(
    referenceTokens: Iterable<string>,
    additionalSourceDocumentIds: Iterable<string> = []
  ): void {
    if (this.deferredLinkResyncDepth > 0) {
      this.deferredFullLinkResyncRequested = true
      return
    }

    const normalizedReferenceTokens = new Set(
      [...referenceTokens]
        .map((token) => token.trim())
        .filter(Boolean)
    )
    const sourceDocumentIds = new Set(additionalSourceDocumentIds)

    if (normalizedReferenceTokens.size > 0) {
      // Trigram FTS only matches needles of 3+ characters; shorter tokens
      // fall back to the full scan below so no reference is missed.
      const indexedTokens = [...normalizedReferenceTokens].filter((token) => token.length >= 3)
      const fallbackTokens = [...normalizedReferenceTokens].filter((token) => token.length < 3)

      let candidateBlocks: BlockReferenceRow[]
      if (indexedTokens.length > 0) {
        const matchExpression = indexedTokens
          .map((token) => `"${token.replace(/"/g, '""')}"`)
          .join(' OR ')
        candidateBlocks = this.db.prepare(`
          SELECT document_id, content
          FROM block_search
          WHERE block_search MATCH ?
        `).all(matchExpression) as BlockReferenceRow[]
        if (fallbackTokens.length > 0) {
          candidateBlocks = candidateBlocks.concat(this.db.prepare(`
            SELECT document_id, content
            FROM blocks
            WHERE instr(content, '[[') > 0
          `).all() as BlockReferenceRow[])
        }
      } else {
        candidateBlocks = this.db.prepare(`
          SELECT document_id, content
          FROM blocks
          WHERE instr(content, '[[') > 0
        `).all() as BlockReferenceRow[]
      }

      for (const block of candidateBlocks) {
        if (this.extractLinkTargets(block.content).some((token) => normalizedReferenceTokens.has(token))) {
          sourceDocumentIds.add(block.document_id)
        }
      }
    }

    this.resyncLinks(sourceDocumentIds)
  }

  private getDocumentPathSubtree(rootPath: string): Array<{ id: string; path: string }> {
    return this.db.prepare(`
      SELECT id, path
      FROM documents
      WHERE path = ? OR path LIKE ? ESCAPE '\\'
      ORDER BY path ASC
    `).all(rootPath, `${this.escapeLikePattern(rootPath)}/%`) as Array<{ id: string; path: string }>
  }

  private getPathRewriteReferenceTokens(
    documents: Array<{ id: string; path: string }>,
    oldRootPath: string,
    newRootPath: string
  ): Set<string> {
    const tokens = new Set<string>()
    for (const document of documents) {
      tokens.add(document.path)
      tokens.add(document.path === oldRootPath
        ? newRootPath
        : `${newRootPath}${document.path.slice(oldRootPath.length)}`)
    }
    return tokens
  }

  private resyncLinks(sourceDocumentIds?: Iterable<string>): void {
    const selectedSourceDocumentIds = sourceDocumentIds
      ? [...new Set(sourceDocumentIds)]
      : null
    if (selectedSourceDocumentIds && selectedSourceDocumentIds.length === 0) {
      return
    }

    let blocks: BlockReferenceRow[]
    if (selectedSourceDocumentIds) {
      const selectBlocks = this.db.prepare(`
        SELECT document_id, content
        FROM blocks
        WHERE document_id = ?
        ORDER BY sort_order ASC
      `)
      blocks = selectedSourceDocumentIds.flatMap(
        (documentId) => selectBlocks.all(documentId) as BlockReferenceRow[]
      )
    } else {
      blocks = this.db.prepare(`
        SELECT document_id, content
        FROM blocks
        ORDER BY document_id ASC, sort_order ASC
      `).all() as BlockReferenceRow[]
    }

    const referenceTokens = new Set<string>()
    for (const block of blocks) {
      for (const token of this.extractLinkTargets(block.content)) {
        referenceTokens.add(token)
      }
    }

    const targetByToken = new Map<string, DocumentLookupRow | null>()
    if (selectedSourceDocumentIds) {
      const findDocumentByPath = this.db.prepare(`
        SELECT id, title, path
        FROM documents
        WHERE path = ?
        LIMIT 1
      `)
      const findDocumentsByTitle = this.db.prepare(`
        SELECT id, title, path
        FROM documents
        WHERE title = ?
        ORDER BY path ASC
        LIMIT 2
      `)
      for (const token of referenceTokens) {
        const pathMatch = findDocumentByPath.get(token) as DocumentLookupRow | undefined
        if (pathMatch) {
          targetByToken.set(token, pathMatch)
          continue
        }
        const titleMatches = findDocumentsByTitle.all(token) as DocumentLookupRow[]
        targetByToken.set(token, titleMatches.length === 1 ? titleMatches[0] : null)
      }
    } else {
      const documents = this.db.prepare(`
        SELECT id, title, path
        FROM documents
      `).all() as DocumentLookupRow[]
      const pathMap = new Map<string, DocumentLookupRow>()
      const titleMap = new Map<string, DocumentLookupRow | null>()
      for (const document of documents) {
        pathMap.set(document.path, document)
        const existing = titleMap.get(document.title)
        titleMap.set(document.title, existing === undefined ? document : null)
      }
      for (const token of referenceTokens) {
        targetByToken.set(token, pathMap.get(token) ?? titleMap.get(token) ?? null)
      }
    }

    const deleteSourceLinks = this.db.prepare('DELETE FROM links WHERE source_document_id = ?')
    const deleteAllLinks = this.db.prepare('DELETE FROM links')
    const insertLink = this.db.prepare(`
      INSERT INTO links (id, source_document_id, target_document_id, label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const transaction = this.db.transaction(() => {
      if (selectedSourceDocumentIds) {
        for (const documentId of selectedSourceDocumentIds) {
          deleteSourceLinks.run(documentId)
        }
      } else {
        deleteAllLinks.run()
      }

      const seen = new Set<string>()
      const createdAt = new Date().toISOString()
      for (const block of blocks) {
        for (const token of this.extractLinkTargets(block.content)) {
          const target = targetByToken.get(token)
          if (!target) {
            continue
          }

          const linkKey = `${block.document_id}:${target.id}:${token}`
          if (seen.has(linkKey)) {
            continue
          }

          seen.add(linkKey)
          insertLink.run(randomUUID(), block.document_id, target.id, token, createdAt)
        }
      }
    })

    transaction()
  }

  private extractLinkTargets(content: string): string[] {
    const matches = content.matchAll(/\[\[([^\]]+)\]\]/g)
    const targets = new Set<string>()
    for (const match of matches) {
      const token = match[1]?.trim()
      if (token) {
        targets.add(token)
      }
    }
    return [...targets]
  }

  private documentTitleExists(parentId: string | null, title: string, excludeDocumentId?: string): boolean {
    if (parentId) {
      const row = this.db.prepare(`
        SELECT id
        FROM documents
        WHERE parent_id = ? AND title = ? COLLATE NOCASE AND (? IS NULL OR id != ?)
        LIMIT 1
      `).get(parentId, title, excludeDocumentId ?? null, excludeDocumentId ?? null) as { id: string } | undefined

      return Boolean(row)
    }

    const row = this.db.prepare(`
      SELECT id
      FROM documents
      WHERE parent_id IS NULL AND title = ? COLLATE NOCASE AND (? IS NULL OR id != ?)
      LIMIT 1
    `).get(title, excludeDocumentId ?? null, excludeDocumentId ?? null) as { id: string } | undefined

    return Boolean(row)
  }

  private getAiConfig(): AiConfig {
    const baseUrl = this.readSetting('ai.baseUrl') ?? 'https://api.openai.com/v1'
    return {
      enabled: this.readSetting('ai.enabled') !== 'false',
      baseUrl,
      model: this.readSetting('ai.model') ?? 'gpt-4.1-mini',
       autoSummaryOnSave: this.readSetting('ai.autoSummaryOnSave') === 'true',
       relatedNotesEnabled: this.readSetting('ai.relatedNotesEnabled') !== 'false',
       hasApiKey: Boolean(this.readSetting('ai.apiKey'))
    }
  }

  private ensureBlockLanguageColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(blocks)').all() as BlockTableInfoRow[]
    if (!columns.some((column) => column.name === 'language')) {
      this.db.exec('ALTER TABLE blocks ADD COLUMN language TEXT')
    }
  }

  private ensureBlockTagsColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(blocks)').all() as BlockTableInfoRow[]
    if (!columns.some((column) => column.name === 'tags_json')) {
      this.db.exec(`ALTER TABLE blocks ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`)
    }
  }

  private ensureBlockHighlightColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(blocks)').all() as BlockTableInfoRow[]
    if (!columns.some((column) => column.name === 'highlight')) {
      this.db.exec('ALTER TABLE blocks ADD COLUMN highlight TEXT')
    }
  }

  private ensureBlockCheckedColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(blocks)').all() as BlockTableInfoRow[]
    if (!columns.some((column) => column.name === 'checked')) {
      this.db.exec('ALTER TABLE blocks ADD COLUMN checked INTEGER NOT NULL DEFAULT 0')
    }
  }

  private ensureBlockDepthColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(blocks)').all() as BlockTableInfoRow[]
    if (!columns.some((column) => column.name === 'depth')) {
      this.db.exec('ALTER TABLE blocks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0')
    }
  }

  private ensureBlockParentRelationships(): void {
    const rows = this.db.prepare(`
      SELECT id, document_id, type, depth, parent_block_id
      FROM blocks
      ORDER BY document_id ASC, sort_order ASC
    `).all() as BlockTreeRow[]

    const updateBlock = this.db.prepare(`
      UPDATE blocks
      SET parent_block_id = ?, depth = ?
      WHERE id = ?
    `)

    const transaction = this.db.transaction(() => {
      let currentDocumentId: string | null = null
      let resolvedDepthById = new Map<string, number>()
      let depthStack: Array<string | null> = []

      for (const row of rows) {
        if (row.document_id !== currentDocumentId) {
          currentDocumentId = row.document_id
          resolvedDepthById = new Map<string, number>()
          depthStack = []
        }

        const { depth, parentBlockId } = this.resolveBlockRelationship(
          row.type,
          row.depth ?? 0,
          row.parent_block_id ?? null,
          row.id,
          resolvedDepthById,
          depthStack
        )

        depthStack.length = depth + 1
        depthStack[depth] = row.id
        resolvedDepthById.set(row.id, depth)

        if ((row.parent_block_id ?? null) !== parentBlockId || row.depth !== depth) {
          updateBlock.run(parentBlockId, depth, row.id)
        }
      }
    })

    transaction()
  }

   private ensureDocumentSortOrderColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(documents)').all() as BlockTableInfoRow[]
    if (!columns.some((column) => column.name === 'sort_order')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')

      const documents = this.db.prepare('SELECT id, parent_id, path FROM documents ORDER BY parent_id, path').all() as Array<{
        id: string
        parent_id: string | null
        path: string
      }>

      let currentParentId: string | null | undefined = undefined
      let sortOrder = 0

      const updateStmt = this.db.prepare('UPDATE documents SET sort_order = ? WHERE id = ?')

      for (const doc of documents) {
        if (doc.parent_id !== currentParentId) {
          currentParentId = doc.parent_id
          sortOrder = 0
        }
        updateStmt.run(sortOrder, doc.id)
        sortOrder++
      }
    }

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_documents_parent_sort_order ON documents(parent_id, sort_order)')
  }

  private ensureDatabaseEntities(): void {
    // Check if database_id column exists in document_database_columns
    const columns = this.db.prepare('PRAGMA table_info(document_database_columns)').all() as BlockTableInfoRow[]
    if (!columns.some((column) => column.name === 'database_id')) {
      // Add database_id column
      this.db.exec(
        'ALTER TABLE document_database_columns ADD COLUMN database_id TEXT REFERENCES databases(id) ON DELETE CASCADE'
      )
    }

    const defaultDatabaseId = this.getDefaultDocumentDatabaseId()
    this.db.prepare(`
      UPDATE document_database_columns SET database_id = ? WHERE database_id IS NULL
    `).run(defaultDatabaseId)
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_document_database_columns_database_id ON document_database_columns(database_id)'
    )

    // Check if entity_id column exists in document_database_values
    const valueColumns = this.db
      .prepare('PRAGMA table_info(document_database_values)')
      .all() as BlockTableInfoRow[]
    if (!valueColumns.some((column) => column.name === 'entity_id')) {
      // Add entity_id column
      this.db.exec(
        'ALTER TABLE document_database_values ADD COLUMN entity_id TEXT REFERENCES database_entities(id) ON DELETE CASCADE'
      )
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS database_entity_values (
        entity_id TEXT NOT NULL REFERENCES database_entities(id) ON DELETE CASCADE,
        column_id TEXT NOT NULL REFERENCES document_database_columns(id) ON DELETE CASCADE,
        value_text TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, column_id)
      )
    `)

    this.db.exec(`
      INSERT INTO database_entity_values (entity_id, column_id, value_text, updated_at)
      SELECT entity_id, column_id, value_text, updated_at
      FROM document_database_values
      WHERE entity_id IS NOT NULL
      ON CONFLICT(entity_id, column_id) DO UPDATE SET
        value_text = excluded.value_text,
        updated_at = excluded.updated_at
    `)
    this.db.exec('DELETE FROM document_database_values WHERE entity_id IS NOT NULL')
  }

  private ensureDatabaseEntityConstraints(): void {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_document_database_columns_database_id_insert
      BEFORE INSERT ON document_database_columns
      FOR EACH ROW
      WHEN NEW.database_id IS NULL OR trim(NEW.database_id) = ''
      BEGIN
        SELECT RAISE(ABORT, 'Database id is required.');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_document_database_columns_database_id_update
      BEFORE UPDATE OF database_id ON document_database_columns
      FOR EACH ROW
      WHEN NEW.database_id IS NULL OR trim(NEW.database_id) = ''
      BEGIN
        SELECT RAISE(ABORT, 'Database id is required.');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_database_entities_document_unique_insert
      BEFORE INSERT ON database_entities
      FOR EACH ROW
      WHEN NEW.document_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM database_entities
        WHERE database_id = NEW.database_id AND document_id = NEW.document_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'A database entity already exists for this document in this database.');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_database_entities_document_unique_update
      BEFORE UPDATE OF database_id, document_id ON database_entities
      FOR EACH ROW
      WHEN NEW.document_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM database_entities
        WHERE database_id = NEW.database_id
          AND document_id = NEW.document_id
          AND id != OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'A database entity already exists for this document in this database.');
      END;
    `)
  }

  private ensureHomeProjectionIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_updated_at
        ON documents(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_database_entities_database_updated
        ON database_entities(database_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_document_database_columns_database_sort
        ON document_database_columns(database_id, sort_order, name);
      CREATE INDEX IF NOT EXISTS idx_document_database_values_column_id
        ON document_database_values(column_id);
    `)
  }

  private readSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  private getDefaultDocumentDatabaseId(): string {
    const storedId = this.readSetting(DEFAULT_DOCUMENT_DATABASE_ID_SETTING_KEY)
    if (storedId) {
      const existing = this.db.prepare('SELECT id FROM databases WHERE id = ?').get(storedId) as { id: string } | undefined
      if (existing) {
        return existing.id
      }
    }

    const columnDatabase = this.db.prepare(`
      SELECT database_id
      FROM document_database_columns
      WHERE database_id IS NOT NULL AND database_id != ''
      ORDER BY sort_order ASC
      LIMIT 1
    `).get() as { database_id: string } | undefined

    const namedDefault = this.db.prepare(`
      SELECT id
      FROM databases
      WHERE name = ? AND description = ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(DEFAULT_DOCUMENT_DATABASE_NAME, DEFAULT_DOCUMENT_DATABASE_DESCRIPTION) as { id: string } | undefined

    const defaultDatabaseId = columnDatabase?.database_id ?? namedDefault?.id ?? this.createDefaultDocumentDatabase()
    this.saveSetting(DEFAULT_DOCUMENT_DATABASE_ID_SETTING_KEY, defaultDatabaseId)
    return defaultDatabaseId
  }

  private createDefaultDocumentDatabase(): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO databases (id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, DEFAULT_DOCUMENT_DATABASE_NAME, DEFAULT_DOCUMENT_DATABASE_DESCRIPTION, now, now)
    return id
  }

  getDatabases(): Array<{ id: string; name: string; description: string; createdAt: string; updatedAt: string }> {
    const rows = this.db.prepare(`
      SELECT id, name, description, created_at, updated_at
      FROM databases
      ORDER BY name ASC
    `).all() as Array<{ id: string; name: string; description: string; created_at: string; updated_at: string }>

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  getDatabaseSavedViews(databaseId: string): DatabaseSavedView[] {
    const normalizedDatabaseId = databaseId.trim()
    if (!normalizedDatabaseId) {
      return []
    }

    this.assertDatabaseExists(normalizedDatabaseId)

    const rows = this.db.prepare(`
      SELECT id, database_id, name, filter_query, filter_scope, sort_mode, view_mode, created_at, updated_at
      FROM database_saved_views
      WHERE database_id = ?
      ORDER BY updated_at DESC, name COLLATE NOCASE ASC
    `).all(normalizedDatabaseId) as DatabaseSavedViewRow[]

    return rows.map((row) => this.mapDatabaseSavedViewRow(row))
  }

  createDatabaseSavedView(input: CreateDatabaseSavedViewInput): DatabaseSavedView {
    const databaseId = input.databaseId.trim()
    this.assertDatabaseExists(databaseId)

    const name = this.normalizeDatabaseSavedViewName(input.name)
    this.assertDatabaseSavedViewNameAvailable(databaseId, name)

    const id = randomUUID()
    const now = new Date().toISOString()
    const filterQuery = input.filterQuery ?? ''
    const filterScope = input.filterScope?.trim() ?? ''
    const sortMode = this.normalizeDatabaseSavedViewSortMode(input.sortMode ?? 'updated-desc')
    const viewMode = this.normalizeDatabaseSavedViewLayoutMode(input.viewMode ?? 'cards')

    this.db.prepare(`
      INSERT INTO database_saved_views (id, database_id, name, filter_query, filter_scope, sort_mode, view_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, databaseId, name, filterQuery, filterScope, sortMode, viewMode, now, now)

    return this.getDatabaseSavedView(id)
  }

  updateDatabaseSavedView(input: UpdateDatabaseSavedViewInput): DatabaseSavedView {
    const currentRow = this.db.prepare(`
      SELECT id, database_id, name, filter_query, filter_scope, sort_mode, view_mode, created_at, updated_at
      FROM database_saved_views
      WHERE id = ?
    `).get(input.viewId) as DatabaseSavedViewRow | undefined

    if (!currentRow) {
      throw new Error('Saved view not found.')
    }

    const name = input.name !== undefined
      ? this.normalizeDatabaseSavedViewName(input.name)
      : currentRow.name

    this.assertDatabaseSavedViewNameAvailable(currentRow.database_id, name, currentRow.id)

    const filterQuery = input.filterQuery !== undefined ? input.filterQuery : currentRow.filter_query
    const filterScope = input.filterScope !== undefined ? input.filterScope.trim() : currentRow.filter_scope
    const sortMode = input.sortMode !== undefined
      ? this.normalizeDatabaseSavedViewSortMode(input.sortMode)
      : this.normalizeDatabaseSavedViewSortMode(currentRow.sort_mode)
    const viewMode = input.viewMode !== undefined
      ? this.normalizeDatabaseSavedViewLayoutMode(input.viewMode)
      : this.normalizeDatabaseSavedViewLayoutMode(currentRow.view_mode)
    const now = new Date().toISOString()

    this.db.prepare(`
      UPDATE database_saved_views
      SET name = ?, filter_query = ?, filter_scope = ?, sort_mode = ?, view_mode = ?, updated_at = ?
      WHERE id = ?
    `).run(name, filterQuery, filterScope, sortMode, viewMode, now, currentRow.id)

    return this.getDatabaseSavedView(currentRow.id)
  }

  deleteDatabaseSavedView(viewId: string): void {
    const result = this.db.prepare(`
      DELETE FROM database_saved_views
      WHERE id = ?
    `).run(viewId)

    if (result.changes === 0) {
      throw new Error('Saved view not found.')
    }
  }

  createDatabase(input: CreateDatabaseInput): DocumentDatabase {
    const trimmedName = input.name.trim()
    if (!trimmedName) {
      throw new Error('Database name is required.')
    }

    const id = randomUUID()
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO databases (id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, trimmedName, (input.description ?? '').trim(), now, now)

    return {
      id,
      name: trimmedName,
      description: (input.description ?? '').trim(),
      createdAt: now,
      updatedAt: now
    }
  }

  updateDatabaseMetadata(input: UpdateDatabaseMetadataInput): void {
    const name = input.name.trim()
    if (!name) {
      throw new Error('Database name is required.')
    }

    const description = input.description.trim()
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE databases
      SET name = ?, description = ?, updated_at = ?
      WHERE id = ?
    `).run(name, description, now, input.databaseId)

    if (result.changes === 0) {
      throw new Error('Database not found.')
    }
  }

  deleteDatabase(databaseId: string): void {
    const normalizedDatabaseId = databaseId.trim()
    if (!normalizedDatabaseId) {
      throw new Error('Database not found.')
    }

    if (normalizedDatabaseId === this.getDefaultDocumentDatabaseId()) {
      throw new Error('Default document database cannot be deleted.')
    }

    const result = this.db.prepare(`
      DELETE FROM databases
      WHERE id = ?
    `).run(normalizedDatabaseId)

    if (result.changes === 0) {
      throw new Error('Database not found.')
    }
  }

  createDatabaseEntity(input: CreateDatabaseEntityInput): DatabaseEntity {
    const { databaseId, documentId = null, fieldValues = {} } = input
    const entityId = randomUUID()
    const now = new Date().toISOString()

    const dbExists = this.db.prepare('SELECT id FROM databases WHERE id = ?').get(databaseId)
    if (!dbExists) {
      throw new Error('Database not found.')
    }

    if (documentId) {
      const docExists = this.db.prepare('SELECT id FROM documents WHERE id = ?').get(documentId)
      if (!docExists) {
        throw new Error('Document not found.')
      }
    }

    if (documentId) {
      const existing = this.db.prepare(
        'SELECT id FROM database_entities WHERE database_id = ? AND document_id = ?'
      ).get(databaseId, documentId)
      if (existing) {
        throw new Error('A database entity already exists for this document in this database.')
      }
    }

    const preparedValues: Array<{ columnId: string; valueText: string }> = []
    for (const [columnId, value] of Object.entries(fieldValues)) {
      const columnRow = this.db.prepare(`
        SELECT id, database_id, name, type, options_json, sort_order
        FROM document_database_columns
        WHERE id = ? AND database_id = ?
      `).get(columnId, databaseId) as DocumentDatabaseColumnRow | undefined

      if (!columnRow) {
        throw new Error('Database column not found.')
      }

      const valueText = this.serializeDocumentDatabaseFieldValue(this.mapDocumentDatabaseColumnRow(columnRow), value)
      if (valueText !== null) {
        preparedValues.push({ columnId, valueText })
      }
    }

    const insertEntity = this.db.prepare(`
      INSERT INTO database_entities (id, database_id, document_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    const insertValue = this.db.prepare(
      'INSERT INTO database_entity_values (entity_id, column_id, value_text, updated_at) VALUES (?, ?, ?, ?)'
    )

    this.db.transaction(() => {
      insertEntity.run(entityId, databaseId, documentId, now, now)
      for (const preparedValue of preparedValues) {
        insertValue.run(entityId, preparedValue.columnId, preparedValue.valueText, now)
      }
    })()

    return this.getDatabaseEntity(entityId)
  }
  
  private getDatabaseEntity(entityId: string): DatabaseEntity {
    const row = this.db.prepare(`
      SELECT id, database_id, document_id, created_at, updated_at
      FROM database_entities
      WHERE id = ?
    `).get(entityId) as DatabaseEntityRow | undefined
    
    if (!row) {
      throw new Error('Database entity not found.')
    }
    
    const fieldRows = this.db.prepare(`
      SELECT
        values_table.entity_id,
        values_table.column_id,
        values_table.value_text,
        columns.name AS column_name,
        columns.type AS column_type,
        columns.options_json,
        columns.sort_order
      FROM database_entity_values AS values_table
      INNER JOIN document_database_columns AS columns ON columns.id = values_table.column_id
      WHERE values_table.entity_id = ?
    `).all(entityId) as DatabaseEntityFieldValueRow[]

    return this.mapDatabaseEntityRows([row], fieldRows)[0]!
  }
  
  updateDatabaseEntity(input: UpdateDatabaseEntityInput): void {
    const { entityId, fieldValues, documentId } = input

    const entity = this.db.prepare('SELECT * FROM database_entities WHERE id = ?').get(entityId) as
      | { id: string; database_id: string; document_id: string | null }
      | undefined
    
    if (!entity) {
      throw new Error('Database entity not found.')
    }
    
    const now = new Date().toISOString()
    
    if (documentId !== undefined) {
      if (documentId) {
        const docExists = this.db.prepare('SELECT id FROM documents WHERE id = ?').get(documentId)
        if (!docExists) {
          throw new Error('Document not found.')
        }
        
        // 验证在该数据库中是否唯一
        const existing = this.db.prepare(
          'SELECT id FROM database_entities WHERE database_id = ? AND document_id = ? AND id != ?'
        ).get(entity.database_id, documentId, entityId)
        if (existing) {
          throw new Error('A database entity already exists for this document in this database.')
        }
      }
    }

    const preparedValues: Array<{ columnId: string; valueText: string | null }> = []
    if (fieldValues) {
      for (const [columnId, value] of Object.entries(fieldValues)) {
        const columnRow = this.db.prepare(`
          SELECT id, database_id, name, type, options_json, sort_order
          FROM document_database_columns
          WHERE id = ? AND database_id = ?
        `).get(columnId, entity.database_id) as DocumentDatabaseColumnRow | undefined

        if (!columnRow) {
          throw new Error('Database column not found.')
        }

        const valueText = this.serializeDocumentDatabaseFieldValue(this.mapDocumentDatabaseColumnRow(columnRow), value)
        preparedValues.push({ columnId, valueText })
      }
    }

    const updateEntity = this.db.prepare('UPDATE database_entities SET document_id = ?, updated_at = ? WHERE id = ?')
    const touchEntity = this.db.prepare('UPDATE database_entities SET updated_at = ? WHERE id = ?')
    const deleteValue = this.db.prepare('DELETE FROM database_entity_values WHERE entity_id = ? AND column_id = ?')
    const insertValue = this.db.prepare(`
      INSERT INTO database_entity_values (entity_id, column_id, value_text, updated_at)
      VALUES (?, ?, ?, ?)
    `)

    this.db.transaction(() => {
      if (documentId !== undefined) {
        updateEntity.run(documentId, now, entityId)
      } else if (fieldValues) {
        touchEntity.run(now, entityId)
      }

      for (const preparedValue of preparedValues) {
        deleteValue.run(entityId, preparedValue.columnId)
        if (preparedValue.valueText !== null) {
          insertValue.run(entityId, preparedValue.columnId, preparedValue.valueText, now)
        }
      }
    })()
  }

  updateDatabaseEntities(input: UpdateDatabaseEntitiesInput): void {
    this.runInTransaction(() => {
      for (const update of input.updates) {
        this.updateDatabaseEntity(update)
      }
    })
  }
  
  deleteDatabaseEntity(entityId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM database_entity_values WHERE entity_id = ?').run(entityId)
      this.db.prepare('DELETE FROM database_entities WHERE id = ?').run(entityId)
    })()
  }

  deleteDatabaseEntities(input: DeleteDatabaseEntitiesInput): void {
    const entityIds = [...new Set(input.entityIds)]

    this.runInTransaction(() => {
      for (const entityId of entityIds) {
        const entity = this.db.prepare('SELECT id FROM database_entities WHERE id = ?').get(entityId)
        if (!entity) {
          throw new Error('Database entity not found.')
        }
      }

      for (const entityId of entityIds) {
        this.deleteDatabaseEntity(entityId)
      }
    })
  }
  
  getDatabaseEntities(databaseId: string): DatabaseEntity[] {
    const rows = this.db.prepare(
      'SELECT id, database_id, document_id, created_at, updated_at FROM database_entities WHERE database_id = ? ORDER BY updated_at DESC'
    ).all(databaseId) as DatabaseEntityRow[]
    const fieldRows = this.db.prepare(`
      SELECT
        values_table.entity_id,
        values_table.column_id,
        values_table.value_text,
        columns.name AS column_name,
        columns.type AS column_type,
        columns.options_json,
        columns.sort_order
      FROM database_entity_values AS values_table
      INNER JOIN database_entities AS entities ON entities.id = values_table.entity_id
      INNER JOIN document_database_columns AS columns ON columns.id = values_table.column_id
      WHERE entities.database_id = ?
    `).all(databaseId) as DatabaseEntityFieldValueRow[]

    return this.mapDatabaseEntityRows(rows, fieldRows)
  }

  private mapDatabaseEntityRows(
    rows: DatabaseEntityRow[],
    fieldRows: DatabaseEntityFieldValueRow[]
  ): DatabaseEntity[] {
    const fieldValuesByEntityId = new Map<string, Record<string, DocumentDatabaseFieldValue>>()

    for (const fieldRow of fieldRows) {
      const fieldValues = fieldValuesByEntityId.get(fieldRow.entity_id) ?? {}
      const column: DocumentDatabaseColumn = {
        id: fieldRow.column_id,
        name: fieldRow.column_name,
        type: fieldRow.column_type,
        options: JSON.parse(fieldRow.options_json || '[]'),
        sortOrder: fieldRow.sort_order
      }
      fieldValues[fieldRow.column_id] = this.parseDocumentDatabaseFieldValue(column, fieldRow.value_text)
      fieldValuesByEntityId.set(fieldRow.entity_id, fieldValues)
    }

    return rows.map((row) => ({
      id: row.id,
      databaseId: row.database_id,
      documentId: row.document_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      fieldValues: fieldValuesByEntityId.get(row.id) ?? {}
    }))
  }

  private seed(): void {
    const documentCount = (this.db.prepare('SELECT COUNT(*) AS count FROM documents').get() as CountRow).count
    if (documentCount > 0) {
      return
    }

    const homeId = randomUUID()
    const productId = randomUUID()
    const roadmapId = randomUUID()

    const insertDocument = this.db.prepare(`
      INSERT INTO documents (id, title, slug, parent_id, path, summary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertBlock = this.db.prepare(`
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, checked, depth, tags_json, language, highlight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertLink = this.db.prepare(`
      INSERT INTO links (id, source_document_id, target_document_id, label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const seedTransaction = this.db.transaction(() => {
      const now = new Date().toISOString()
      insertDocument.run(homeId, 'Home', 'home', null, 'Home', 'Workspace bootstrap document.', 0, now, now)
      insertDocument.run(productId, 'Product', 'product', homeId, 'Home/Product', 'Product discovery and planning.', 0, now, now)
      insertDocument.run(roadmapId, 'Roadmap', 'roadmap', productId, 'Home/Product/Roadmap', 'Implementation milestones for the desktop client.', 0, now, now)

      insertBlock.run(randomUUID(), homeId, null, 0, 'heading-1', 'KnowBook bootstrap workspace', 0, 0, '[]', null, null, now, now)
      insertBlock.run(randomUUID(), homeId, null, 1, 'paragraph', 'Electron, React, TypeScript, and SQLite are wired together in the first implementation slice.', 0, 0, '[]', null, null, now, now)
      insertBlock.run(randomUUID(), productId, null, 0, 'heading-1', 'Product principles', 0, 0, '[]', null, null, now, now)
      insertBlock.run(randomUUID(), productId, null, 1, 'todo', 'Prioritize local-first data ownership and keep [[Roadmap]] aligned with implementation milestones.', 0, 0, '[]', null, null, now, now)
      insertBlock.run(randomUUID(), roadmapId, null, 0, 'heading-1', 'Phase 1', 0, 0, '[]', null, null, now, now)
      insertBlock.run(randomUUID(), roadmapId, null, 1, 'paragraph', 'Ship the Electron shell, bootstrap SQLite schema, and generate nested markdown backups.', 0, 0, '[]', null, null, now, now)

      this.saveSetting('ai.enabled', 'true')
      this.saveSetting('ai.baseUrl', 'https://api.openai.com/v1')
      this.saveSetting('ai.model', 'gpt-4.1-mini')
      this.saveSetting('ai.autoSummaryOnSave', 'false')
    })

    seedTransaction()
  }
}
