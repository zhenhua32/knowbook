import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type {
  AiConfig,
  AskAiInput,
  DocumentBlockDraft,
  DocumentChild,
  DocumentDetail,
  DocumentTreeNode,
  HomeData,
  LinkedDocument,
  RecentDocument,
  UpdateAiConfigInput,
  UpdateDocumentInput,
  WorkspaceSummary
} from '@shared/contracts'
import { appSchema } from './schema'

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

interface DocumentTreeRow {
  id: string
  title: string
  path: string
  parent_id: string | null
  updated_at: string
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
  type: string
  content: string
  sort_order: number
}

interface LinkedDocumentRow {
  id: string
  title: string
  path: string
  label: string
}

interface DocumentChildRow {
  id: string
  title: string
  path: string
}

export interface ExportDocument {
  id: string
  title: string
  path: string
  summary: string
  updatedAt: string
  blocks: Array<{
    type: string
    content: string
    sortOrder: number
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
    this.seed()
  }

  getHomeData(backupRoot: string): HomeData {
    const recentDocuments = this.getRecentDocuments()
    const documentTree = this.getDocumentTree()

    return {
      summary: this.getSummary(backupRoot),
      recentDocuments,
      aiConfig: this.getAiConfig(),
      documentTree,
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
      SELECT type, content, sort_order
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
      SELECT source.id, source.title, source.path, links.label
      FROM links
      INNER JOIN documents AS source ON source.id = links.source_document_id
      WHERE links.target_document_id = ?
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
        type: block.type,
        content: block.content,
        sortOrder: block.sort_order
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
        label: link.label
      }))
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
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const transaction = this.db.transaction(() => {
      insertDocument.run(id, title, slug, parent?.id ?? null, path, 'New knowledge node ready for editing.', now, now)
      insertBlock.run(randomUUID(), id, null, 0, 'heading-1', title, now, now)
      insertBlock.run(randomUUID(), id, null, 1, 'paragraph', 'Start writing here.', now, now)
    })

    transaction()
    return id
  }

  updateDocument(documentId: string, input: UpdateDocumentInput): void {
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
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const transaction = this.db.transaction(() => {
      updateDocumentStatement.run(normalizedTitle, newPath, normalizedSummary, now, documentId)

      if (newPath !== oldPath) {
        updateDescendantsStatement.run(`${oldPath}/`, `${newPath}/`, `${oldPath}/%`)
      }

      deleteBlocksStatement.run(documentId)
      normalizedBlocks.forEach((block, index) => {
        insertBlockStatement.run(randomUUID(), documentId, null, index, block.type, block.content, now, now)
      })
    })

    transaction()
  }

  deleteDocument(documentId: string): void {
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

    const transaction = this.db.transaction(() => {
      reparentChildrenStatement.run(document.parent_id, now, document.id)
      rewriteDescendantPathStatement.run(oldPrefix, newPrefix, now, `${oldPrefix}%`)
      deleteDocumentStatement.run(document.id)
    })

    transaction()
  }

  moveDocument(documentId: string, newParentId: string | null): void {
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
      return
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
  }

  updateAiConfig(input: UpdateAiConfigInput): void {
    this.saveSetting('ai.enabled', input.enabled ? 'true' : 'false')
    this.saveSetting('ai.baseUrl', input.baseUrl.trim() || 'https://api.openai.com/v1')
    this.saveSetting('ai.model', input.model.trim() || 'gpt-4.1-mini')
    if (typeof input.apiKey === 'string' && input.apiKey.trim().length > 0) {
      this.saveSetting('ai.apiKey', input.apiKey.trim())
    }
  }

  buildAiPrompt(input: AskAiInput): string {
    const detail = this.getDocumentDetail(input.documentId)
    if (!detail) {
      throw new Error('Document not found')
    }

    const content = detail.blocks.map((block) => `- [${block.type}] ${block.content}`).join('\n')

    return [
      `Document title: ${detail.title}`,
      `Document path: ${detail.path}`,
      `Summary: ${detail.summary}`,
      'Blocks:',
      content,
      '',
      `User request: ${input.prompt}`,
      'Answer in concise Chinese with actionable suggestions.'
    ].join('\n')
  }

  getAiApiKey(): string | null {
    return this.readSetting('ai.apiKey')
  }

  getExportDocuments(): ExportDocument[] {
    const documents = this.db.prepare(`
      SELECT id, title, path, summary, updated_at
      FROM documents
      ORDER BY path ASC
    `).all() as ExportDocumentRow[]

    const blocksStatement = this.db.prepare(`
      SELECT type, content, sort_order
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
        type: block.type,
        content: block.content,
        sortOrder: block.sort_order
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

  private generateSiblingTitle(parentId: string | null, baseTitle: string): string {
    let candidate = baseTitle
    let index = 1

    while (this.documentTitleExists(parentId, candidate)) {
      candidate = `${baseTitle} ${index}`
      index += 1
    }

    return candidate
  }

  private normalizeBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
    const normalized = blocks
      .map((block) => ({
        type: block.type.trim() || 'paragraph',
        content: block.content
      }))
      .filter((block) => block.content.trim().length > 0)

    if (normalized.length > 0) {
      return normalized
    }

    return [
      {
        type: 'paragraph',
        content: 'Start writing here.'
      }
    ]
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
      hasApiKey: Boolean(this.readSetting('ai.apiKey'))
    }
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
      INSERT INTO blocks (id, document_id, parent_block_id, sort_order, type, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertLink = this.db.prepare(`
      INSERT INTO links (id, source_document_id, target_document_id, label, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const seedTransaction = this.db.transaction(() => {
      insertDocument.run(homeId, 'Home', 'home', null, 'Home', 'Workspace bootstrap document.', now, now)
      insertDocument.run(productId, 'Product', 'product', homeId, 'Home/Product', 'Product discovery and planning.', now, now)
      insertDocument.run(roadmapId, 'Roadmap', 'roadmap', productId, 'Home/Product/Roadmap', 'Implementation milestones for the desktop client.', now, now)

      insertBlock.run(randomUUID(), homeId, null, 0, 'heading-1', 'KnowBook bootstrap workspace', now, now)
      insertBlock.run(randomUUID(), homeId, null, 1, 'paragraph', 'Electron, React, TypeScript, and SQLite are wired together in the first implementation slice.', now, now)
      insertBlock.run(randomUUID(), productId, null, 0, 'heading-1', 'Product principles', now, now)
      insertBlock.run(randomUUID(), productId, null, 1, 'todo', 'Prioritize local-first data ownership and scheduled markdown exports.', now, now)
      insertBlock.run(randomUUID(), roadmapId, null, 0, 'heading-1', 'Phase 1', now, now)
      insertBlock.run(randomUUID(), roadmapId, null, 1, 'paragraph', 'Ship the Electron shell, bootstrap SQLite schema, and generate nested markdown backups.', now, now)

      insertLink.run(randomUUID(), productId, roadmapId, 'drives', now)

      this.saveSetting('ai.enabled', 'true')
      this.saveSetting('ai.baseUrl', 'https://api.openai.com/v1')
      this.saveSetting('ai.model', 'gpt-4.1-mini')
    })

    seedTransaction()
  }
}