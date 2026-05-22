import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { BackupRestoreResult, DocumentBlockDraft } from '@shared/contracts'
import { parseMarkdownBackupDocument } from '@shared/markdown'
import { KnowbookStore } from '../database/store'

type RestoreSourceDocument = {
  sourceFilePath: string
  sourceDocumentId: string | null
  documentPath: string
  restoreScopePath: string
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
    let deleted = 0
    const conflictsResolved = this.countResolvableConflicts(sourceDocuments)
    let placeholdersCreated = 0
    const restoredDocumentIds = new Set<string>()

    for (const source of sourceDocuments) {
      const result = this.restoreDocument(source)
      placeholdersCreated += result.placeholdersCreated
      restoredDocumentIds.add(result.documentId)
      if (result.mode === 'created') {
        created += 1
      } else {
        updated += 1
      }
    }

    deleted = this.deleteMissingDocuments(sourceDocuments, restoredDocumentIds)

    return {
      restored: sourceDocuments.length,
      created,
      updated,
      deleted,
      conflictsResolved,
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
    const normalizedRelativePath = this.normalizeDocumentPath(relativePath)
    const markdown = readFileSync(filePath, 'utf8')
    const parsed = parseMarkdownBackupDocument(markdown)
    const normalizedDocumentPath = this.normalizeDocumentPath(parsed.frontmatter.path || normalizedRelativePath)

    if (!normalizedDocumentPath) {
      throw new Error(`Cannot restore document without a valid path: ${filePath}`)
    }

    const pathSegments = normalizedDocumentPath.split('/')
    const title = pathSegments[pathSegments.length - 1] ?? 'Untitled'

    return {
      sourceFilePath: filePath,
      sourceDocumentId: parsed.frontmatter.id?.trim() || null,
      documentPath: normalizedDocumentPath,
      restoreScopePath: this.deriveRestoreScopePath(normalizedDocumentPath, normalizedRelativePath),
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

  private deriveRestoreScopePath(documentPath: string, relativeDocumentPath: string): string {
    const documentSegments = documentPath.split('/').filter(Boolean)
    const relativeSegments = relativeDocumentPath.split('/').filter(Boolean)

    if (relativeSegments.length === 0 || relativeSegments.length > documentSegments.length) {
      return ''
    }

    const suffixMatches = relativeSegments.every((segment, index) => {
      const documentSegment = documentSegments[documentSegments.length - relativeSegments.length + index]
      return documentSegment === segment
    })

    if (!suffixMatches) {
      return ''
    }

    return documentSegments.slice(0, documentSegments.length - relativeSegments.length).join('/')
  }

  private restoreDocument(source: RestoreSourceDocument): {
    mode: 'created' | 'updated'
    documentId: string
    placeholdersCreated: number
  } {
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
      documentId,
      placeholdersCreated: ensuredParent.placeholdersCreated
    }
  }

  private countResolvableConflicts(sourceDocuments: RestoreSourceDocument[]): number {
    const snapshots = this.store.getAllDocumentSnapshots()
    const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
    const snapshotsByPath = new Map<string, Array<{ id: string; title: string; path: string; parentId: string | null }>>()

    for (const snapshot of snapshots) {
      const entries = snapshotsByPath.get(snapshot.path) ?? []
      entries.push(snapshot)
      snapshotsByPath.set(snapshot.path, entries)
    }

    let conflicts = 0

    for (const source of sourceDocuments) {
      if (!source.sourceDocumentId) {
        continue
      }

      const existingById = snapshotsById.get(source.sourceDocumentId)
      if (!existingById) {
        continue
      }

      const occupants = snapshotsByPath.get(source.documentPath) ?? []
      if (occupants.some((occupant) => occupant.id !== existingById.id)) {
        conflicts += 1
      }
    }

    return conflicts
  }

  private deleteMissingDocuments(sourceDocuments: RestoreSourceDocument[], restoredDocumentIds: Set<string>): number {
    const sourcePaths = new Set(sourceDocuments.map((source) => source.documentPath))
    const scopePaths = [...new Set(sourceDocuments.map((source) => source.restoreScopePath))]
    const deletable = this.store
      .getAllDocumentSnapshots()
      .filter((snapshot) => !restoredDocumentIds.has(snapshot.id))
      .filter((snapshot) => this.isWithinRestoreScope(snapshot.path, scopePaths, sourcePaths))
      .sort((left, right) => {
        const depthDifference = this.getDocumentPathDepth(right.path) - this.getDocumentPathDepth(left.path)
        return depthDifference !== 0 ? depthDifference : left.path.localeCompare(right.path)
      })

    for (const snapshot of deletable) {
      this.store.deleteDocument(snapshot.id)
    }

    return deletable.length
  }

  private isWithinRestoreScope(documentPath: string, scopePaths: string[], sourcePaths: Set<string>): boolean {
    for (const scopePath of scopePaths) {
      if (!scopePath) {
        return true
      }

      if (documentPath === scopePath) {
        return sourcePaths.has(scopePath)
      }

      if (documentPath.startsWith(`${scopePath}/`)) {
        return true
      }
    }

    return false
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