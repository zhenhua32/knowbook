import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import type { BackupResult } from '@shared/contracts'
import { renderMarkdownFrontmatter, serializeBlocksToMarkdown } from '@shared/markdown'
import type { ExportDocument, ExportStandaloneDatabase, KnowbookStore } from '../database/store'

const STANDALONE_DATABASE_BACKUP_KIND = 'standalone-database'
const STANDALONE_DATABASE_MANIFEST_BACKUP_KIND = 'standalone-database-manifest'
const STANDALONE_DATABASE_BACKUP_ROOT = '__knowbook/databases'
const STANDALONE_DATABASE_MANIFEST_FILE_NAME = 'index.md'

export class MarkdownBackupService {
  constructor(
    private readonly store: KnowbookStore,
    private readonly backupRoot: string
  ) {}

  exportAll(): BackupResult {
    const documents = this.store.getExportDocuments()
    const standaloneDatabases = this.store.getExportStandaloneDatabases()
    const backupParent = dirname(this.backupRoot)
    mkdirSync(backupParent, { recursive: true })
    const stagingRoot = mkdtempSync(join(backupParent, '.knowbook-markdown-'))

    try {
      for (const document of documents) {
        this.writeDocument(stagingRoot, document)
      }
      for (const database of standaloneDatabases) {
        this.writeStandaloneDatabase(stagingRoot, database)
      }
      this.writeStandaloneDatabaseManifest(stagingRoot, standaloneDatabases)
      this.replaceBackupSnapshot(stagingRoot)
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true })
      throw error
    }

    const at = new Date().toISOString()
    this.store.saveSetting('backup.lastRunAt', at)

    return {
      exported: documents.length,
      root: this.backupRoot,
      at
    }
  }

  private writeDocument(root: string, document: ExportDocument): void {
    const segments = document.path.split('/').map((segment) => this.toSafePathSegment(segment))
    const filePath = join(root, ...segments) + '.md'
    this.assertPathInsideRoot(filePath, root)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, this.renderMarkdown(document), 'utf8')
  }

  private writeStandaloneDatabase(root: string, database: ExportStandaloneDatabase): void {
    const filePath = join(root, ...STANDALONE_DATABASE_BACKUP_ROOT.split('/'), `${this.toSafePathSegment(database.id)}.md`)
    this.assertPathInsideRoot(filePath, root)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, this.renderStandaloneDatabase(database), 'utf8')
  }

  private writeStandaloneDatabaseManifest(root: string, databases: ExportStandaloneDatabase[]): void {
    const filePath = join(root, ...STANDALONE_DATABASE_BACKUP_ROOT.split('/'), STANDALONE_DATABASE_MANIFEST_FILE_NAME)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, this.renderStandaloneDatabaseManifest(databases), 'utf8')
  }

  private replaceBackupSnapshot(stagingRoot: string): void {
    const previousRoot = `${this.backupRoot}.previous-${randomUUID()}`
    const hadPreviousSnapshot = existsSync(this.backupRoot)

    if (hadPreviousSnapshot) {
      renameSync(this.backupRoot, previousRoot)
    }

    try {
      renameSync(stagingRoot, this.backupRoot)
    } catch (error) {
      if (hadPreviousSnapshot && !existsSync(this.backupRoot)) {
        renameSync(previousRoot, this.backupRoot)
      }
      throw error
    }

    if (hadPreviousSnapshot) {
      rmSync(previousRoot, { recursive: true, force: true })
    }
  }

  private assertPathInsideRoot(filePath: string, root: string): void {
    const normalizedRoot = resolve(root)
    const normalizedFilePath = resolve(filePath)
    if (normalizedFilePath !== normalizedRoot && !normalizedFilePath.startsWith(`${normalizedRoot}${sep}`)) {
      throw new Error('Backup path resolved outside the backup root.')
    }
  }

  private toSafePathSegment(segment: string): string {
    const isReservedWindowsName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
    const needsEncoding = segment.length === 0
      || segment.length > 100
      || segment === '.'
      || segment === '..'
      || /[<>:"/\\|?*\x00-\x1F]/.test(segment)
      || /[. ]$/.test(segment)
      || isReservedWindowsName

    if (!needsEncoding) {
      return segment
    }

    const readable = segment
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 80) || 'Untitled'
    const digest = createHash('sha256').update(segment).digest('hex').slice(0, 10)
    return `${readable}--${digest}`
  }

  private renderMarkdown(document: ExportDocument): string {
    const frontmatter = renderMarkdownFrontmatter({
      id: document.id,
      title: document.title,
      path: document.path,
      updatedAt: document.updatedAt,
      summary: document.summary,
      documentDatabaseColumns: JSON.stringify(document.documentDatabaseColumns),
      documentDatabaseFieldValues: JSON.stringify(document.documentDatabaseFieldValues)
    })

    const body = serializeBlocksToMarkdown(document.blocks, {
      fallbackCodeLanguage: 'txt',
      includeBlockMetadata: true
    })

    return `${frontmatter}${body}\n`
  }

  private renderStandaloneDatabase(database: ExportStandaloneDatabase): string {
    return `${renderMarkdownFrontmatter({
      kind: STANDALONE_DATABASE_BACKUP_KIND,
      databaseId: database.id,
      databaseName: database.name,
      databaseDescription: database.description,
      createdAt: database.createdAt,
      updatedAt: database.updatedAt,
      databaseColumns: JSON.stringify(database.columns),
      databaseSavedViews: JSON.stringify(database.savedViews),
      databaseEntities: JSON.stringify(database.entities)
    })}\n`
  }

  private renderStandaloneDatabaseManifest(databases: ExportStandaloneDatabase[]): string {
    return `${renderMarkdownFrontmatter({
      kind: STANDALONE_DATABASE_MANIFEST_BACKUP_KIND,
      databaseIds: JSON.stringify(databases.map((database) => database.id))
    })}\n`
  }
}
