import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { BackupRestoreResult, DocumentBlockDraft } from '@shared/contracts'
import { parseMarkdownBackupDocument } from '@shared/markdown'
import { KnowbookStore } from '../database/store'

type RestoreSourceDocument = {
  sourceFilePath: string
  sourceDocumentId: string | null
  documentPath: string
  title: string
  summary: string
  blocks: DocumentBlockDraft[]
}

export class MarkdownRestoreService {
  constructor(private readonly store: KnowbookStore) {}

  restoreFromDirectory(root: string): BackupRestoreResult {
    const markdownFiles = this.collectMarkdownFiles(root)
    const sourceDocuments = markdownFiles
      .map((filePath) => this.parseSourceDocument(root, filePath))
      .sort((left, right) => {
        const depthDifference = this.getDocumentPathDepth(left.documentPath) - this.getDocumentPathDepth(right.documentPath)
        return depthDifference !== 0
          ? depthDifference
          : left.documentPath.localeCompare(right.documentPath)
      })

    let created = 0
    let updated = 0
    let placeholdersCreated = 0

    for (const source of sourceDocuments) {
      const result = this.restoreDocument(source)
      placeholdersCreated += result.placeholdersCreated
      if (result.mode === 'created') {
        created += 1
      } else {
        updated += 1
      }
    }

    return {
      restored: sourceDocuments.length,
      created,
      updated,
      placeholdersCreated,
      root,
      at: new Date().toISOString()
    }
  }

  private collectMarkdownFiles(root: string): string[] {
    const stat = statSync(root, { throwIfNoEntry: false })
    if (!stat || !stat.isDirectory()) {
      throw new Error('Restore directory not found')
    }

    const files: string[] = []
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name)
        if (entry.isDirectory()) {
          visit(fullPath)
          continue
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          files.push(fullPath)
        }
      }
    }

    visit(root)
    return files
  }

  private parseSourceDocument(root: string, filePath: string): RestoreSourceDocument {
    const relativePath = relative(root, filePath)
      .replace(/\\/g, '/')
      .replace(/\.md$/i, '')
    const markdown = readFileSync(filePath, 'utf8')
    const parsed = parseMarkdownBackupDocument(markdown)
    const normalizedDocumentPath = this.normalizeDocumentPath(parsed.frontmatter.path || relativePath)

    if (!normalizedDocumentPath) {
      throw new Error(`Cannot restore document without a valid path: ${filePath}`)
    }

    const pathSegments = normalizedDocumentPath.split('/')
    const title = pathSegments[pathSegments.length - 1] ?? 'Untitled'

    return {
      sourceFilePath: filePath,
      sourceDocumentId: parsed.frontmatter.id?.trim() || null,
      documentPath: normalizedDocumentPath,
      title,
      summary: parsed.frontmatter.summary ?? '',
      blocks: parsed.blocks.map((block) => ({
        id: block.id,
        type: block.type,
        content: block.content,
        checked: Boolean(block.checked),
        depth: block.depth ?? 0,
        parentBlockId: block.parentBlockId ?? null,
        tags: block.tags,
        language: block.language ?? undefined,
        highlight: block.highlight
      }))
    }
  }

  private normalizeDocumentPath(documentPath: string): string {
    return documentPath
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join('/')
  }

  private getDocumentPathDepth(documentPath: string): number {
    return documentPath.split('/').filter(Boolean).length
  }

  private restoreDocument(source: RestoreSourceDocument): { mode: 'created' | 'updated'; placeholdersCreated: number } {
    const segments = source.documentPath.split('/').filter(Boolean)
    const parentPath = segments.slice(0, -1).join('/')
    const ensuredParent = this.ensureDocumentPath(parentPath)
    const existingById = source.sourceDocumentId ? this.store.getDocumentSnapshot(source.sourceDocumentId) : null
    const existingByPath = this.store.getDocumentSnapshotByPath(source.documentPath)
    const existing = existingById ?? existingByPath

    let documentId: string
    let mode: 'created' | 'updated'

    if (existing) {
      if (existing.parentId !== ensuredParent.documentId) {
        this.store.moveDocument(existing.id, ensuredParent.documentId)
      }
      documentId = existing.id
      mode = 'updated'
    } else {
      documentId = this.store.createDocument(ensuredParent.documentId)
      mode = 'created'
    }

    this.store.updateDocument(documentId, {
      title: source.title,
      summary: source.summary,
      blocks: source.blocks
    })

    return {
      mode,
      placeholdersCreated: ensuredParent.placeholdersCreated
    }
  }

  private ensureDocumentPath(documentPath: string): { documentId: string | null; placeholdersCreated: number } {
    const normalizedPath = this.normalizeDocumentPath(documentPath)
    if (!normalizedPath) {
      return {
        documentId: null,
        placeholdersCreated: 0
      }
    }

    const segments = normalizedPath.split('/')
    let currentPath = ''
    let parentId: string | null = null
    let placeholdersCreated = 0

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let snapshot = this.store.getDocumentSnapshotByPath(currentPath)

      if (!snapshot) {
        const createdId = this.store.createDocument(parentId)
        this.store.updateDocument(createdId, {
          title: segment,
          summary: '',
          blocks: [{ type: 'heading-1', content: segment, checked: false, depth: 0 }]
        })
        snapshot = this.store.getDocumentSnapshot(createdId)
        placeholdersCreated += 1
      }

      if (!snapshot) {
        throw new Error(`Failed to create placeholder document for path: ${currentPath}`)
      }

      parentId = snapshot.id
    }

    return {
      documentId: parentId,
      placeholdersCreated
    }
  }
}