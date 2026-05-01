import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type {
  AiConfig,
  AskAiInput,
  CreateDocumentDatabaseColumnInput,
  DocumentDatabaseColumn,
  DocumentDatabaseColumnType,
  DocumentDatabaseFieldValue,
  DocumentBlockDraft,
  DocumentCatalogEntry,
  DocumentChild,
  DocumentDetail,
  DocumentSuggestion,
  DocumentTreeNode,
  HomeData,
  LinkedDocument,
  MoveDocumentDatabaseColumnInput,
  RecentDocument,
  RenameDocumentDatabaseColumnInput,
  UpdateDocumentDatabaseColumnOptionsInput,
  UpdateAiConfigInput,
  UpdateDocumentDatabaseValueInput,
  UpdateDocumentInput,
  WorkspaceEventRecord,
  WorkspaceEventType,
  WorkspaceGraphEdge,
  WorkspaceGraphNode,
  WorkspaceSummary,
  GlobalSearchResult
  ,
  SearchSemanticNotesInput,
  SemanticSearchResult
} from '@shared/contracts'
import { appSchema } from './schema'

export const DEFAULT_DOCUMENT_SUMMARY = 'New knowledge node ready for editing.'

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

interface DocumentDatabaseColumnRow {
  id: string
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

interface DocumentTreeRow {
  id: string
  title: string
  path: string
  parent_id: string | null
  updated_at: string
}

interface GraphLinkRow {
  source_document_id: string
  target_document_id: string
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

interface DocumentEmbeddingRow {
  content_hash: string
  embedding_json: string
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
  }>
}

export class KnowbookStore {
  private readonly db: SqliteDatabase

  constructor(private readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new Database(databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(appSchema)
    this.ensureBlockCheckedColumn()
    this.ensureBlockDepthColumn()
    this.ensureBlockTagsColumn()
    this.ensureBlockLanguageColumn()
    this.ensureBlockHighlightColumn()
    this.ensureBlockParentRelationships()
    this.seed()
    this.resyncLinksForAllDocuments()
  }

  getHomeData(backupRoot: string): HomeData {
    const recentDocuments = this.getRecentDocuments()
    const recentEvents = this.getRecentWorkspaceEvents()
    const documentTree = this.getDocumentTree()
    const graph = this.getWorkspaceGraph()
    const databaseColumns = this.getDocumentDatabaseColumns()

    return {
      summary: this.getSummary(backupRoot),
      recentDocuments,
      recentEvents,
      documentCatalog: this.getDocumentCatalog(databaseColumns),
      databaseColumns,
      aiConfig: this.getAiConfig(),
      documentTree,
      graph,
      initialDocumentId: recentDocuments[0]?.id ?? documentTree[0]?.id ?? null
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

  createDocument(parentId: string | null): string {
    const now = new Date().toISOString()
    const title = this.generateSiblingTitle(parentId, 'Untitled')
    const id = randomUUID()
    const slug = `doc-${id.slice(0, 8)}`
    const parent = parentId
      ? (this.db.prepare('SELECT id, path FROM documents WHERE id = ?').get(parentId) as ParentDocumentRow | undefined)
      : undefined

    const path = parent ? `${parent.path}/${title}` : title
    const insertDocument = this.db.prepare(`
      INSERT INTO documents (id, title, slug, parent_id, path, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertBlock = this.db.prepare(`
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, checked, depth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const transaction = this.db.transaction(() => {
      insertDocument.run(id, title, slug, parent?.id ?? null, path, DEFAULT_DOCUMENT_SUMMARY, now, now)
      insertBlock.run(randomUUID(), id, null, 0, 'heading-1', title, 0, 0, now, now)
      insertBlock.run(randomUUID(), id, null, 1, 'paragraph', 'Start writing here.', 0, 0, now, now)
    })

    transaction()
    this.resyncLinksForAllDocuments()
    return id
  }

  updateDocument(documentId: string, input: UpdateDocumentInput): string[] {
    const now = new Date().toISOString()
    const document = this.db.prepare(`
      SELECT id, path, parent_id
      FROM documents
      WHERE id = ?
    `).get(documentId) as DocumentPathRow | undefined

    if (!document) {
      throw new Error('Document not found')
    }

    const parentPath = document.parent_id
      ? (this.db.prepare('SELECT path FROM documents WHERE id = ?').get(document.parent_id) as { path: string } | undefined)?.path
      : null

    const normalizedTitle = input.title.trim() || 'Untitled'
    const normalizedSummary = input.summary.trim()
    const normalizedBlocks = this.normalizeBlocks(input.blocks)
    const oldPath = document.path
    const newPath = parentPath ? `${parentPath}/${normalizedTitle}` : normalizedTitle

    const updateDocumentStatement = this.db.prepare(`
      UPDATE documents
      SET title = ?, path = ?, summary = ?, updated_at = ?
      WHERE id = ?
    `)
    const updateDescendantsStatement = this.db.prepare(`
      UPDATE documents
      SET path = REPLACE(path, ?, ?)
      WHERE path LIKE ?
    `)
    const deleteBlocksStatement = this.db.prepare('DELETE FROM blocks WHERE document_id = ?')
    const insertBlockStatement = this.db.prepare(`
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, checked, depth, tags_json, language, highlight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const transaction = this.db.transaction(() => {
      updateDocumentStatement.run(normalizedTitle, newPath, normalizedSummary, now, documentId)

      if (newPath !== oldPath) {
        updateDescendantsStatement.run(`${oldPath}/`, `${newPath}/`, `${oldPath}/%`)
      }

      deleteBlocksStatement.run(documentId)
      this.buildPersistedBlocks(normalizedBlocks).forEach((block, index) => {
        insertBlockStatement.run(
          block.id,
          documentId,
          block.parentBlockId,
          index,
          block.type,
          block.content,
          block.checked ? 1 : 0,
          block.depth,
          JSON.stringify(this.normalizeBlockTags(block.tags)),
          block.language ?? null,
          block.highlight ?? null,
          now,
          now
        )
      })
    })

    transaction()
    this.resyncLinksForAllDocuments()
    return newPath !== oldPath ? this.getDocumentIdsInPathSubtree(newPath) : [documentId]
  }

  updateDocumentSummary(documentId: string, summary: string): void {
    const normalizedSummary = summary.trim()
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE documents
      SET summary = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizedSummary, now, documentId)
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

    const reparentChildrenStatement = this.db.prepare(`
      UPDATE documents
      SET parent_id = ?, updated_at = ?
      WHERE parent_id = ?
    `)
    const rewriteDescendantPathStatement = this.db.prepare(`
      UPDATE documents
      SET path = REPLACE(path, ?, ?), updated_at = ?
      WHERE path LIKE ?
    `)
    const deleteDocumentStatement = this.db.prepare('DELETE FROM documents WHERE id = ?')
    const affectedDescendantIds = this.db.prepare(`
      SELECT id
      FROM documents
      WHERE path LIKE ?
      ORDER BY path ASC
    `).all(`${oldPrefix}%`) as Array<{ id: string }>

    const transaction = this.db.transaction(() => {
      reparentChildrenStatement.run(document.parent_id, now, document.id)
      rewriteDescendantPathStatement.run(oldPrefix, newPrefix, now, `${oldPrefix}%`)
      deleteDocumentStatement.run(document.id)
    })

    transaction()
    this.resyncLinksForAllDocuments()
    return affectedDescendantIds.map((row) => row.id)
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

    const newPath = targetParent ? `${targetParent.path}/${document.title}` : document.title
    if (document.parent_id === (targetParent?.id ?? null) && newPath === document.path) {
      return [document.id]
    }

    const oldPrefix = `${document.path}/`
    const newPrefix = `${newPath}/`

    const updateDocumentStatement = this.db.prepare(`
      UPDATE documents
      SET parent_id = ?, path = ?, updated_at = ?
      WHERE id = ?
    `)
    const updateDescendantsStatement = this.db.prepare(`
      UPDATE documents
      SET path = REPLACE(path, ?, ?), updated_at = ?
      WHERE path LIKE ?
    `)

    const transaction = this.db.transaction(() => {
      updateDocumentStatement.run(targetParent?.id ?? null, newPath, now, document.id)
      updateDescendantsStatement.run(oldPrefix, newPrefix, now, `${oldPrefix}%`)
    })

    transaction()
    this.resyncLinksForAllDocuments()
    return this.getDocumentIdsInPathSubtree(newPath)
  }

  updateAiConfig(input: UpdateAiConfigInput): void {
    this.saveSetting('ai.enabled', input.enabled ? 'true' : 'false')
    this.saveSetting('ai.baseUrl', input.baseUrl.trim() || 'https://api.openai.com/v1')
    this.saveSetting('ai.model', input.model.trim() || 'gpt-4.1-mini')
    this.saveSetting('ai.embeddingModel', input.embeddingModel.trim() || 'text-embedding-3-small')
    this.saveSetting('ai.autoSummaryOnSave', input.autoSummaryOnSave ? 'true' : 'false')
    if (typeof input.apiKey === 'string' && input.apiKey.trim().length > 0) {
      this.saveSetting('ai.apiKey', input.apiKey.trim())
    }
  }

  createDocumentDatabaseColumn(input: CreateDocumentDatabaseColumnInput): DocumentDatabaseColumn {
    const name = input.name.trim()
    if (!name) {
      throw new Error('Column name is required.')
    }

    const type = this.normalizeDocumentDatabaseColumnType(input.type)
    const options = this.normalizeDocumentDatabaseColumnOptions(type, input.options ?? [])
    const now = new Date().toISOString()
    const maxSortOrderRow = this.db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
      FROM document_database_columns
    `).get() as { max_sort_order: number }
    const sortOrder = (maxSortOrderRow.max_sort_order ?? -1) + 1
    const column: DocumentDatabaseColumn = {
      id: randomUUID(),
      name,
      type,
      options,
      sortOrder
    }

    this.db.prepare(`
      INSERT INTO document_database_columns (id, name, type, options_json, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(column.id, column.name, column.type, JSON.stringify(column.options), column.sortOrder, now, now)

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
    const rows = this.db.prepare(`
      SELECT id, name, type, options_json, sort_order
      FROM document_database_columns
      ORDER BY sort_order ASC, name ASC
    `).all() as DocumentDatabaseColumnRow[]

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
    const documentExists = this.db.prepare('SELECT id FROM documents WHERE id = ?').get(input.documentId) as { id: string } | undefined
    if (!documentExists) {
      throw new Error('Document not found.')
    }

    const columnRow = this.db.prepare(`
      SELECT id, name, type, options_json, sort_order
      FROM document_database_columns
      WHERE id = ?
    `).get(input.columnId) as DocumentDatabaseColumnRow | undefined

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

  getAiApiKey(): string | null {
    return this.readSetting('ai.apiKey')
  }

  getSemanticSearchCandidates(input: Pick<SearchSemanticNotesInput, 'excludeDocumentId'> = {}): SemanticSearchCandidate[] {
    const documents = input.excludeDocumentId
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

  getCachedDocumentEmbedding(documentId: string, model: string, contentHash: string): number[] | null {
    const row = this.db.prepare(`
      SELECT content_hash, embedding_json
      FROM document_embeddings
      WHERE document_id = ? AND model = ?
    `).get(documentId, model) as DocumentEmbeddingRow | undefined

    if (!row || row.content_hash !== contentHash) {
      return null
    }

    try {
      const embedding = JSON.parse(row.embedding_json) as unknown
      if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== 'number')) {
        return null
      }
      return embedding
    } catch {
      return null
    }
  }

  saveDocumentEmbedding(documentId: string, model: string, contentHash: string, embedding: number[]): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO document_embeddings (document_id, model, content_hash, embedding_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(document_id, model)
      DO UPDATE SET content_hash = excluded.content_hash, embedding_json = excluded.embedding_json, updated_at = excluded.updated_at
    `).run(documentId, model, contentHash, JSON.stringify(embedding), now)
  }

  deleteDocumentEmbeddings(documentId: string, model?: string): void {
    if (model) {
      this.db.prepare(`
        DELETE FROM document_embeddings
        WHERE document_id = ? AND model = ?
      `).run(documentId, model)
      return
    }

    this.db.prepare(`
      DELETE FROM document_embeddings
      WHERE document_id = ?
    `).run(documentId)
  }

  deleteEmbeddingsByModel(model: string): void {
    this.db.prepare(`
      DELETE FROM document_embeddings
      WHERE model = ?
    `).run(model)
  }

  private getDocumentIdsInPathSubtree(rootPath: string): string[] {
    const rows = this.db.prepare(`
      SELECT id
      FROM documents
      WHERE path = ? OR path LIKE ?
      ORDER BY path ASC
    `).all(rootPath, `${rootPath}/%`) as Array<{ id: string }>

    return rows.map((row) => row.id)
  }

  getDocumentSuggestions(query: string, excludeDocumentId: string | null = null): DocumentSuggestion[] {
    const normalizedQuery = query.trim()
    const likeQuery = `%${normalizedQuery}%`

    if (excludeDocumentId) {
      return this.db.prepare(`
        SELECT id, title, path
        FROM documents
        WHERE id != ?
          AND (? = '' OR title LIKE ? OR path LIKE ?)
        ORDER BY
          CASE
            WHEN title = ? THEN 0
            WHEN path = ? THEN 1
            WHEN title LIKE ? THEN 2
            ELSE 3
          END,
          LENGTH(path) ASC,
          path ASC
        LIMIT 8
      `).all(
        excludeDocumentId,
        normalizedQuery,
        likeQuery,
        likeQuery,
        normalizedQuery,
        normalizedQuery,
        `${normalizedQuery}%`
      ) as DocumentSuggestion[]
    }

    return this.db.prepare(`
      SELECT id, title, path
      FROM documents
      WHERE (? = '' OR title LIKE ? OR path LIKE ?)
      ORDER BY
        CASE
          WHEN title = ? THEN 0
          WHEN path = ? THEN 1
          WHEN title LIKE ? THEN 2
          ELSE 3
        END,
        LENGTH(path) ASC,
        path ASC
      LIMIT 8
    `).all(
      normalizedQuery,
      likeQuery,
      likeQuery,
      normalizedQuery,
      normalizedQuery,
      `${normalizedQuery}%`
    ) as DocumentSuggestion[]
  }

  searchDocuments(query: string): GlobalSearchResult[] {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) {
      return []
    }
    const likeQuery = `%${normalizedQuery}%`

    const docMatches = this.db.prepare(`
      SELECT id, title, path, summary
      FROM documents
      WHERE title LIKE ? OR summary LIKE ?
      ORDER BY
        CASE WHEN title LIKE ? THEN 0 ELSE 1 END,
        LENGTH(path) ASC
      LIMIT 5
    `).all(likeQuery, likeQuery, `%${normalizedQuery}%`) as Array<{
      id: string; title: string; path: string; summary: string
    }>

    const blockMatches = this.db.prepare(`
      SELECT b.id AS block_id, b.type AS block_type, b.content AS block_content,
             d.id AS document_id, d.title AS document_title, d.path AS document_path
      FROM blocks AS b
      INNER JOIN documents AS d ON d.id = b.document_id
      WHERE b.content LIKE ?
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
    const documents = this.db.prepare(`
      SELECT id, title, path, summary, updated_at
      FROM documents
      ORDER BY path ASC
    `).all() as ExportDocumentRow[]

    const blocksStatement = this.db.prepare(`
      SELECT id, type, content, checked, depth, tags_json, parent_block_id, sort_order, language, highlight
      FROM blocks
      WHERE document_id = ?
      ORDER BY sort_order ASC
    `)

    return documents.map((document) => ({
      id: document.id,
      title: document.title,
      path: document.path,
      summary: document.summary,
      updatedAt: document.updated_at,
      blocks: (blocksStatement.all(document.id) as ExportBlockRow[]).map((block) => ({
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

  saveSetting(key: string, value: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now)
  }

  getSettingPublic(key: string): string | null {
    return this.readSetting(key)
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

  private getSummary(backupRoot: string): WorkspaceSummary {
    const documents = (this.db.prepare('SELECT COUNT(*) AS count FROM documents').get() as CountRow).count
    const blocks = (this.db.prepare('SELECT COUNT(*) AS count FROM blocks').get() as CountRow).count
    const links = (this.db.prepare('SELECT COUNT(*) AS count FROM links').get() as CountRow).count
    const lastBackupAt = this.readSetting('backup.lastRunAt')

    return {
      databasePath: this.databasePath,
      backupRoot,
      documents,
      blocks,
      links,
      lastBackupAt
    }
  }

  private getRecentDocuments(): RecentDocument[] {
    const rows = this.db.prepare(`
      SELECT documents.id, documents.title, documents.path, documents.updated_at, COUNT(blocks.id) AS block_count
      FROM documents
      LEFT JOIN blocks ON blocks.document_id = documents.id
      GROUP BY documents.id
      ORDER BY documents.updated_at DESC
      LIMIT 5
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

  private getDocumentCatalog(databaseColumns: DocumentDatabaseColumn[]): DocumentCatalogEntry[] {
    const rows = this.db.prepare(`
      SELECT
        documents.id,
        documents.title,
        documents.path,
        documents.summary,
        documents.parent_id,
        parents.title AS parent_title,
        documents.updated_at,
        (SELECT COUNT(*) FROM blocks WHERE blocks.document_id = documents.id) AS block_count,
        (SELECT COUNT(*) FROM links WHERE links.source_document_id = documents.id) AS link_count,
        (SELECT COUNT(*) FROM documents AS children WHERE children.parent_id = documents.id) AS child_count
      FROM documents
      LEFT JOIN documents AS parents ON parents.id = documents.parent_id
      ORDER BY documents.path ASC
    `).all() as DocumentCatalogRow[]

    const columnById = new Map(databaseColumns.map((column) => [column.id, column]))
    const fieldRows = this.db.prepare(`
      SELECT document_id, column_id, value_text
      FROM document_database_values
      ORDER BY document_id ASC, column_id ASC
    `).all() as DocumentDatabaseValueRow[]
    const fieldValuesByDocumentId = new Map<string, Record<string, DocumentDatabaseFieldValue>>()

    for (const row of fieldRows) {
      const column = columnById.get(row.column_id)
      if (!column) {
        continue
      }

      const fieldValues = fieldValuesByDocumentId.get(row.document_id) ?? {}
      fieldValues[row.column_id] = this.parseDocumentDatabaseFieldValue(column, row.value_text)
      fieldValuesByDocumentId.set(row.document_id, fieldValues)
    }

    return rows.map((row) => ({
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

  private getDocumentDatabaseColumns(): DocumentDatabaseColumn[] {
    const rows = this.db.prepare(`
      SELECT id, name, type, options_json, sort_order
      FROM document_database_columns
      ORDER BY sort_order ASC, name ASC
    `).all() as DocumentDatabaseColumnRow[]

    return rows.map((row) => this.mapDocumentDatabaseColumnRow(row))
  }

  private getDocumentTree(): DocumentTreeNode[] {
    interface TreeBuilderNode extends DocumentTreeNode {
      parentId: string | null
    }

    const rows = this.db.prepare(`
      SELECT id, title, path, parent_id, updated_at
      FROM documents
      ORDER BY path ASC
    `).all() as DocumentTreeRow[]

    const nodeMap = new Map<string, TreeBuilderNode>()
    const roots: TreeBuilderNode[] = []

    for (const row of rows) {
      nodeMap.set(row.id, {
        id: row.id,
        title: row.title,
        path: row.path,
        updatedAt: row.updated_at,
        parentId: row.parent_id,
        children: []
      })
    }

    for (const node of nodeMap.values()) {
      if (!node.parentId) {
        roots.push(node)
        continue
      }

      const parent = nodeMap.get(node.parentId)
      if (parent) {
        parent.children.push(node)
      } else {
        roots.push(node)
      }
    }

    const normalize = (nodes: TreeBuilderNode[]): DocumentTreeNode[] => {
      nodes.sort((left, right) => left.path.localeCompare(right.path))
      return nodes.map((node) => ({
        id: node.id,
        title: node.title,
        path: node.path,
        updatedAt: node.updatedAt,
        children: normalize(node.children as TreeBuilderNode[])
      }))
    }

    return normalize(roots)
  }

  private getWorkspaceGraph(): { nodes: WorkspaceGraphNode[]; edges: WorkspaceGraphEdge[] } {
    const rows = this.db.prepare(`
      SELECT id, title, path, parent_id, updated_at
      FROM documents
      ORDER BY path ASC
    `).all() as DocumentTreeRow[]

    const nodes: WorkspaceGraphNode[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      path: row.path,
      depth: Math.max(0, row.path.split('/').length - 1)
    }))

    const treeEdges: WorkspaceGraphEdge[] = rows
      .filter((row) => Boolean(row.parent_id))
      .map((row) => ({
        sourceId: row.parent_id as string,
        targetId: row.id,
        kind: 'tree' as const
      }))

    const linkRows = this.db.prepare(`
      SELECT source_document_id, target_document_id
      FROM links
      ORDER BY source_document_id ASC, target_document_id ASC
    `).all() as GraphLinkRow[]

    const linkEdges: WorkspaceGraphEdge[] = linkRows.map((row) => ({
      sourceId: row.source_document_id,
      targetId: row.target_document_id,
      kind: 'link'
    }))

    return {
      nodes,
      edges: [...treeEdges, ...linkEdges]
    }
  }

  private generateSiblingTitle(parentId: string | null, baseTitle: string): string {
    let candidate = baseTitle
    let index = 1

    while (this.documentTitleExists(parentId, candidate)) {
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
    switch (column.type) {
      case 'text': {
        if (typeof value !== 'string') {
          return null
        }

        return value.trim().length > 0 ? value : null
      }
      case 'select': {
        if (typeof value !== 'string') {
          return null
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
          return null
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
          return null
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
      case 'checkbox':
        return value === true ? 'true' : 'false'
      default:
        return null
    }
  }

  private normalizeBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
    const normalized = blocks
      .map((block) => {
        const type = block.type.trim() || 'paragraph'
        return {
          id: block.id,
          type,
          content: block.content,
          checked: type === 'todo' ? Boolean(block.checked) : false,
          depth: this.normalizeNestableDepth(type, block.depth ?? 0),
          parentBlockId: block.parentBlockId ?? null,
          tags: this.normalizeBlockTags(block.tags)
        }
      })
      .filter((block) => block.type === 'divider' || block.content.trim().length > 0)

    if (normalized.length > 0) {
      return normalized
    }

    return [
      {
        type: 'paragraph',
        content: 'Start writing here.',
        checked: false,
        depth: 0,
        tags: []
      }
    ]
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
    const documents = this.db.prepare(`
      SELECT id, title, path
      FROM documents
    `).all() as DocumentLookupRow[]
    const blocks = this.db.prepare(`
      SELECT document_id, content
      FROM blocks
      ORDER BY document_id ASC, sort_order ASC
    `).all() as BlockReferenceRow[]

    const pathMap = new Map<string, DocumentLookupRow>()
    const titleMap = new Map<string, DocumentLookupRow | null>()
    for (const document of documents) {
      pathMap.set(document.path, document)
      const existing = titleMap.get(document.title)
      if (existing === undefined) {
        titleMap.set(document.title, document)
      } else {
        titleMap.set(document.title, null)
      }
    }

    const deleteLinks = this.db.prepare('DELETE FROM links')
    const insertLink = this.db.prepare(`
      INSERT INTO links (id, source_document_id, target_document_id, label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const transaction = this.db.transaction(() => {
      deleteLinks.run()

      const seen = new Set<string>()
      for (const block of blocks) {
        for (const token of this.extractLinkTargets(block.content)) {
          const target = this.resolveDocumentReference(token, pathMap, titleMap)
          if (!target) {
            continue
          }

          const linkKey = `${block.document_id}:${target.id}:${token}`
          if (seen.has(linkKey)) {
            continue
          }

          seen.add(linkKey)
          insertLink.run(randomUUID(), block.document_id, target.id, token, new Date().toISOString())
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

  private resolveDocumentReference(
    token: string,
    pathMap: Map<string, DocumentLookupRow>,
    titleMap: Map<string, DocumentLookupRow | null>
  ): DocumentLookupRow | null {
    const byPath = pathMap.get(token)
    if (byPath) {
      return byPath
    }

    const byTitle = titleMap.get(token)
    return byTitle ?? null
  }

  private documentTitleExists(parentId: string | null, title: string): boolean {
    if (parentId) {
      const row = this.db.prepare(`
        SELECT id
        FROM documents
        WHERE parent_id = ? AND title = ?
        LIMIT 1
      `).get(parentId, title) as { id: string } | undefined

      return Boolean(row)
    }

    const row = this.db.prepare(`
      SELECT id
      FROM documents
      WHERE parent_id IS NULL AND title = ?
      LIMIT 1
    `).get(title) as { id: string } | undefined

    return Boolean(row)
  }

  private getAiConfig(): AiConfig {
    return {
      enabled: this.readSetting('ai.enabled') !== 'false',
      baseUrl: this.readSetting('ai.baseUrl') ?? 'https://api.openai.com/v1',
      model: this.readSetting('ai.model') ?? 'gpt-4.1-mini',
      embeddingModel: this.readSetting('ai.embeddingModel') ?? 'text-embedding-3-small',
      autoSummaryOnSave: this.readSetting('ai.autoSummaryOnSave') === 'true',
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

  private readSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  private seed(): void {
    const documentCount = (this.db.prepare('SELECT COUNT(*) AS count FROM documents').get() as CountRow).count
    if (documentCount > 0) {
      return
    }

    const now = new Date().toISOString()
    const homeId = randomUUID()
    const productId = randomUUID()
    const roadmapId = randomUUID()

    const insertDocument = this.db.prepare(`
      INSERT INTO documents (id, title, slug, parent_id, path, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertBlock = this.db.prepare(`
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, checked, depth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertLink = this.db.prepare(`
      INSERT INTO links (id, source_document_id, target_document_id, label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const seedTransaction = this.db.transaction(() => {
      insertDocument.run(homeId, 'Home', 'home', null, 'Home', 'Workspace bootstrap document.', now, now)
      insertDocument.run(productId, 'Product', 'product', homeId, 'Home/Product', 'Product discovery and planning.', now, now)
      insertDocument.run(roadmapId, 'Roadmap', 'roadmap', productId, 'Home/Product/Roadmap', 'Implementation milestones for the desktop client.', now, now)

      insertBlock.run(randomUUID(), homeId, null, 0, 'heading-1', 'KnowBook bootstrap workspace', 0, 0, now, now)
      insertBlock.run(randomUUID(), homeId, null, 1, 'paragraph', 'Electron, React, TypeScript, and SQLite are wired together in the first implementation slice.', 0, 0, now, now)
      insertBlock.run(randomUUID(), productId, null, 0, 'heading-1', 'Product principles', 0, 0, now, now)
      insertBlock.run(randomUUID(), productId, null, 1, 'todo', 'Prioritize local-first data ownership and keep [[Roadmap]] aligned with implementation milestones.', 0, 0, now, now)
      insertBlock.run(randomUUID(), roadmapId, null, 0, 'heading-1', 'Phase 1', 0, 0, now, now)
      insertBlock.run(randomUUID(), roadmapId, null, 1, 'paragraph', 'Ship the Electron shell, bootstrap SQLite schema, and generate nested markdown backups.', 0, 0, now, now)

      this.saveSetting('ai.enabled', 'true')
      this.saveSetting('ai.baseUrl', 'https://api.openai.com/v1')
      this.saveSetting('ai.model', 'gpt-4.1-mini')
      this.saveSetting('ai.embeddingModel', 'text-embedding-3-small')
      this.saveSetting('ai.autoSummaryOnSave', 'false')
    })

    seedTransaction()
  }
}