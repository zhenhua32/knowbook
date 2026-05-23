import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackupResult } from '@shared/contracts'
import { renderMarkdownFrontmatter, serializeBlocksToMarkdown } from '@shared/markdown'
import type { ExportDocument, ExportStandaloneDatabase, KnowbookStore } from '../database/store'

const STANDALONE_DATABASE_BACKUP_KIND = 'standalone-database'
const STANDALONE_DATABASE_BACKUP_ROOT = '__knowbook/databases'

export class MarkdownBackupService {
  constructor(
    private readonly store: KnowbookStore,
    private readonly backupRoot: string
  ) {}

  exportAll(): BackupResult {
    const documents = this.store.getExportDocuments()
    const standaloneDatabases = this.store.getExportStandaloneDatabases()
    for (const document of documents) {
      this.writeDocument(document)
    }
    for (const database of standaloneDatabases) {
      this.writeStandaloneDatabase(database)
    }

    const at = new Date().toISOString()
    this.store.saveSetting('backup.lastRunAt', at)

    return {
      exported: documents.length,
      root: this.backupRoot,
      at
    }
  }

  private writeDocument(document: ExportDocument): void {
    const filePath = join(this.backupRoot, ...document.path.split('/')) + '.md'
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, this.renderMarkdown(document), 'utf8')
  }

  private writeStandaloneDatabase(database: ExportStandaloneDatabase): void {
    const filePath = join(this.backupRoot, ...STANDALONE_DATABASE_BACKUP_ROOT.split('/'), `${database.id}.md`)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, this.renderStandaloneDatabase(database), 'utf8')
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
}