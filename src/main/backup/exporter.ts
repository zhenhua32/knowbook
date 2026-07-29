import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BackupResult } from '@shared/contracts'
import { renderMarkdownFrontmatter, serializeBlocksToMarkdown } from '@shared/markdown'
import type { ExportDocument, ExportStandaloneDatabase, KnowbookStore } from '../database/store'

const STANDALONE_DATABASE_BACKUP_KIND = 'standalone-database'
const STANDALONE_DATABASE_MANIFEST_BACKUP_KIND = 'standalone-database-manifest'
const STANDALONE_DATABASE_BACKUP_ROOT = '__knowbook/databases'
const STANDALONE_DATABASE_MANIFEST_FILE_NAME = 'index.md'
const INTERNAL_BACKUP_ROOT_SEGMENT = '__knowbook'
const ESCAPED_DOCUMENT_ROOT_PREFIX = '__knowbook-document-'
const ASSET_BACKUP_ROOT = '__knowbook/assets'
const FILE_URL_PATTERN = /file:\/\/\/[^\s<>"')\\\]}]+/g

export interface BackupExportJob {
  documents: ExportDocument[]
  standaloneDatabases: ExportStandaloneDatabase[]
  backupRoot: string
  assetRoot?: string
}

export type BackupExportRunner = (job: BackupExportJob) => Promise<void>

export function writeBackupSnapshot(job: BackupExportJob): void {
  new MarkdownBackupWriter(job.backupRoot, job.assetRoot).writeAll(job.documents, job.standaloneDatabases)
}

async function writeBackupSnapshotInline(job: BackupExportJob): Promise<void> {
  writeBackupSnapshot(job)
}

export class MarkdownBackupService {
  private inFlightExport: Promise<BackupResult> | null = null

  constructor(
    private readonly store: KnowbookStore,
    private readonly backupRoot: string,
    private readonly assetRoot?: string,
    private readonly runExport: BackupExportRunner = writeBackupSnapshotInline
  ) {}

  exportAll(): Promise<BackupResult> {
    if (this.inFlightExport) {
      return this.inFlightExport
    }

    const documents = this.store.getExportDocuments()
    const standaloneDatabases = this.store.getExportStandaloneDatabases()
    const exportPromise = this.performExport({
      documents,
      standaloneDatabases,
      backupRoot: this.backupRoot,
      assetRoot: this.assetRoot
    })
    this.inFlightExport = exportPromise
    exportPromise.then(
      () => {
        if (this.inFlightExport === exportPromise) {
          this.inFlightExport = null
        }
      },
      () => {
        if (this.inFlightExport === exportPromise) {
          this.inFlightExport = null
        }
      }
    )
    return exportPromise
  }

  async waitForIdle(): Promise<void> {
    await this.inFlightExport
  }

  private async performExport(job: BackupExportJob): Promise<BackupResult> {
    await this.runExport(job)
    const at = new Date().toISOString()
    this.store.saveSetting('backup.lastRunAt', at)

    return {
      exported: job.documents.length,
      root: this.backupRoot,
      at
    }
  }
}

class MarkdownBackupWriter {
  constructor(
    private readonly backupRoot: string,
    private readonly assetRoot?: string
  ) {}

  writeAll(documents: ExportDocument[], standaloneDatabases: ExportStandaloneDatabase[]): void {
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
  }

  private writeDocument(root: string, document: ExportDocument): void {
    const segments = document.path
      .split('/')
      .map((segment, index) => this.toSafeDocumentPathSegment(segment, index))
    const filePath = join(root, ...segments) + '.md'
    this.assertPathInsideRoot(filePath, root)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(
      filePath,
      this.rewriteManagedAssetReferences(root, filePath, this.renderMarkdown(document)),
      'utf8'
    )
  }

  private writeStandaloneDatabase(root: string, database: ExportStandaloneDatabase): void {
    const filePath = join(root, ...STANDALONE_DATABASE_BACKUP_ROOT.split('/'), `${this.toSafePathSegment(database.id)}.md`)
    this.assertPathInsideRoot(filePath, root)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(
      filePath,
      this.rewriteManagedAssetReferences(root, filePath, this.renderStandaloneDatabase(database)),
      'utf8'
    )
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

  private rewriteManagedAssetReferences(snapshotRoot: string, markdownFilePath: string, markdown: string): string {
    if (!this.assetRoot) {
      return markdown
    }

    const normalizedAssetRoot = resolve(this.assetRoot)
    return markdown.replace(FILE_URL_PATTERN, (assetUrl) => {
      let candidatePath: string
      try {
        candidatePath = resolve(fileURLToPath(assetUrl))
      } catch {
        return assetUrl
      }

      if (!this.isPathInsideRoot(candidatePath, normalizedAssetRoot)) {
        return assetUrl
      }

      const sourceStat = statSync(candidatePath, { throwIfNoEntry: false })
      if (!sourceStat?.isFile()) {
        throw new Error(`Managed backup asset not found: ${assetUrl}`)
      }

      const realAssetRoot = realpathSync(normalizedAssetRoot)
      const sourcePath = realpathSync(candidatePath)
      if (!this.isPathInsideRoot(sourcePath, realAssetRoot)) {
        throw new Error(`Managed backup asset resolves outside the asset root: ${assetUrl}`)
      }

      const assetRelativePath = relative(normalizedAssetRoot, candidatePath)
      const snapshotAssetPath = join(snapshotRoot, ...ASSET_BACKUP_ROOT.split('/'), assetRelativePath)
      this.assertPathInsideRoot(snapshotAssetPath, snapshotRoot)
      mkdirSync(dirname(snapshotAssetPath), { recursive: true })
      copyFileSync(sourcePath, snapshotAssetPath)

      const portableReference = relative(dirname(markdownFilePath), snapshotAssetPath).replace(/\\/g, '/')
      return portableReference.startsWith('.') ? portableReference : `./${portableReference}`
    })
  }

  private isPathInsideRoot(filePath: string, root: string): boolean {
    const normalizedRoot = resolve(root)
    const normalizedFilePath = resolve(filePath)
    return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}${sep}`)
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

  private toSafeDocumentPathSegment(segment: string, index: number): string {
    if (
      index === 0
      && (segment === INTERNAL_BACKUP_ROOT_SEGMENT || segment.startsWith(ESCAPED_DOCUMENT_ROOT_PREFIX))
    ) {
      const digest = createHash('sha256').update(segment).digest('hex')
      return `${ESCAPED_DOCUMENT_ROOT_PREFIX}${digest}`
    }

    return this.toSafePathSegment(segment)
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
