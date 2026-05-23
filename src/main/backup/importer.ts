import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type {
  BackupRestoreResult,
  CreateDocumentDatabaseColumnInput,
  DocumentBlockDraft,
  DocumentDatabaseColumn,
  DocumentDatabaseFieldValue
} from '@shared/contracts'
import { parseMarkdownBackupDocument } from '@shared/markdown'
import { KnowbookStore } from '../database/store'

type RestoreSourceDocument = {
  sourceFilePath: string
  sourceDocumentId: string | null
  documentPath: string
  restoreScopePath: string
  title: string
  summary: string
  documentDatabaseColumns: DocumentDatabaseColumn[]
  documentDatabaseFieldValues: Record<string, DocumentDatabaseFieldValue>
  blocks: DocumentBlockDraft[]
}

const DOCUMENT_DATABASE_COLUMN_TYPES = new Set(['text', 'select', 'multi-select', 'date', 'checkbox'])

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
    const documentDatabaseColumnIdMap = this.ensureDocumentDatabaseColumns(sourceDocuments)

    for (const source of sourceDocuments) {
      const result = this.restoreDocument(source, documentDatabaseColumnIdMap)
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
    const documentDatabaseColumns = this.parseSourceDocumentDatabaseColumns(parsed.frontmatter.documentDatabaseColumns)

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
      documentDatabaseColumns,
      documentDatabaseFieldValues: this.parseSourceDocumentDatabaseFieldValues(
        parsed.frontmatter.documentDatabaseFieldValues,
        documentDatabaseColumns
      ),
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

  private restoreDocument(
    source: RestoreSourceDocument,
    documentDatabaseColumnIdMap: Map<string, string>
  ): {
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
    this.restoreDocumentDatabaseFieldValues(documentId, source, documentDatabaseColumnIdMap)

    return {
      mode,
      documentId,
      placeholdersCreated: ensuredParent.placeholdersCreated
    }
  }

  private parseSourceDocumentDatabaseColumns(rawColumns: string | undefined): DocumentDatabaseColumn[] {
    if (!rawColumns) {
      return []
    }

    try {
      const parsed = JSON.parse(rawColumns) as unknown
      if (!Array.isArray(parsed)) {
        return []
      }

      return parsed.flatMap((value): DocumentDatabaseColumn[] => {
        if (!value || typeof value !== 'object') {
          return []
        }

        const candidate = value as Record<string, unknown>
        const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : null
        const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : null
        const type = typeof candidate.type === 'string' && DOCUMENT_DATABASE_COLUMN_TYPES.has(candidate.type)
          ? candidate.type as CreateDocumentDatabaseColumnInput['type']
          : null

        if (!id || !name || !type) {
          return []
        }

        const options = Array.isArray(candidate.options)
          ? [...new Set(candidate.options.filter((option): option is string => typeof option === 'string').map((option) => option.trim()).filter(Boolean))]
          : []
        const sortOrder = typeof candidate.sortOrder === 'number' && Number.isFinite(candidate.sortOrder)
          ? candidate.sortOrder
          : 0

        return [{
          id,
          name,
          type,
          options,
          sortOrder
        }]
      })
    } catch {
      return []
    }
  }

  private parseSourceDocumentDatabaseFieldValues(
    rawFieldValues: string | undefined,
    columns: DocumentDatabaseColumn[]
  ): Record<string, DocumentDatabaseFieldValue> {
    if (!rawFieldValues) {
      return {}
    }

    const columnById = new Map(columns.map((column) => [column.id, column]))

    try {
      const parsed = JSON.parse(rawFieldValues) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {}
      }

      const values: Record<string, DocumentDatabaseFieldValue> = {}
      for (const [columnId, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
        const column = columnById.get(columnId)
        if (!column) {
          continue
        }

        const normalized = this.normalizeSourceDocumentDatabaseFieldValue(column, rawValue)
        if (normalized !== undefined) {
          values[columnId] = normalized
        }
      }

      return values
    } catch {
      return {}
    }
  }

  private normalizeSourceDocumentDatabaseFieldValue(
    column: DocumentDatabaseColumn,
    rawValue: unknown
  ): DocumentDatabaseFieldValue | undefined {
    if (rawValue === null) {
      return null
    }

    switch (column.type) {
      case 'checkbox':
        return typeof rawValue === 'boolean' ? rawValue : undefined
      case 'multi-select': {
        if (!Array.isArray(rawValue)) {
          return undefined
        }
        return [...new Set(rawValue.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))]
      }
      case 'text':
      case 'select':
      case 'date':
        return typeof rawValue === 'string' ? rawValue : undefined
      default:
        return undefined
    }
  }

  private ensureDocumentDatabaseColumns(sourceDocuments: RestoreSourceDocument[]): Map<string, string> {
    const sourceColumns = this.collectSourceDocumentDatabaseColumns(sourceDocuments)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    const targetColumns = this.store.getDocumentDatabaseColumns()
    const targetById = new Map(targetColumns.map((column) => [column.id, column]))
    const targetByNameAndType = new Map(targetColumns.map((column) => [this.getDocumentDatabaseColumnLookupKey(column.name, column.type), column]))
    const columnIdMap = new Map<string, string>()

    for (const sourceColumn of sourceColumns) {
      let targetColumn = targetById.get(sourceColumn.id)
      if (targetColumn && targetColumn.type !== sourceColumn.type) {
        targetColumn = undefined
      }

      if (!targetColumn) {
        targetColumn = targetByNameAndType.get(this.getDocumentDatabaseColumnLookupKey(sourceColumn.name, sourceColumn.type))
      }

      if (!targetColumn) {
        targetColumn = this.store.createDocumentDatabaseColumn({
          name: sourceColumn.name,
          type: sourceColumn.type,
          options: [...sourceColumn.options]
        })
      } else {
        if (targetColumn.id === sourceColumn.id && targetColumn.name !== sourceColumn.name) {
          this.store.renameDocumentDatabaseColumn({
            columnId: targetColumn.id,
            name: sourceColumn.name
          })
          targetColumn = {
            ...targetColumn,
            name: sourceColumn.name
          }
        }

        if ((sourceColumn.type === 'select' || sourceColumn.type === 'multi-select')) {
          const currentOptions = [...targetColumn.options]
          const mergedOptions = [...new Set([...currentOptions, ...sourceColumn.options])]
          if (mergedOptions.length !== currentOptions.length || mergedOptions.some((option, index) => option !== currentOptions[index])) {
            this.store.updateDocumentDatabaseColumnOptions({
              columnId: targetColumn.id,
              options: mergedOptions
            })
            targetColumn = {
              ...targetColumn,
              options: mergedOptions
            }
          }
        }
      }

      targetById.set(targetColumn.id, targetColumn)
      targetByNameAndType.set(this.getDocumentDatabaseColumnLookupKey(targetColumn.name, targetColumn.type), targetColumn)
      columnIdMap.set(sourceColumn.id, targetColumn.id)
    }

    return columnIdMap
  }

  private collectSourceDocumentDatabaseColumns(sourceDocuments: RestoreSourceDocument[]): DocumentDatabaseColumn[] {
    const columnsById = new Map<string, DocumentDatabaseColumn>()

    for (const source of sourceDocuments) {
      for (const column of source.documentDatabaseColumns) {
        const existing = columnsById.get(column.id)
        if (!existing) {
          columnsById.set(column.id, {
            ...column,
            options: [...column.options]
          })
          continue
        }

        columnsById.set(column.id, {
          ...existing,
          options: [...new Set([...existing.options, ...column.options])],
          sortOrder: Math.min(existing.sortOrder, column.sortOrder)
        })
      }
    }

    return [...columnsById.values()]
  }

  private getDocumentDatabaseColumnLookupKey(name: string, type: DocumentDatabaseColumn['type']): string {
    return `${name.trim().toLowerCase()}::${type}`
  }

  private restoreDocumentDatabaseFieldValues(
    documentId: string,
    source: RestoreSourceDocument,
    columnIdMap: Map<string, string>
  ): void {
    const restoredTargetColumnIds = new Set<string>()

    for (const [sourceColumnId, value] of Object.entries(source.documentDatabaseFieldValues)) {
      const targetColumnId = columnIdMap.get(sourceColumnId)
      if (!targetColumnId) {
        continue
      }

      this.store.updateDocumentDatabaseValue({
        documentId,
        columnId: targetColumnId,
        value
      })
      restoredTargetColumnIds.add(targetColumnId)
    }

    for (const sourceColumn of source.documentDatabaseColumns) {
      const targetColumnId = columnIdMap.get(sourceColumn.id)
      if (!targetColumnId || restoredTargetColumnIds.has(targetColumnId)) {
        continue
      }

      this.store.updateDocumentDatabaseValue({
        documentId,
        columnId: targetColumnId,
        value: null
      })
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