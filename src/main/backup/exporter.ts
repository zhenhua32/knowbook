import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { KnowbookStore } from '../database/store'
import type { ExportDocument, ExportStandaloneDatabase } from '../database/store'

const STANDALONE_DATABASE_BACKUP_KIND = 'standalone-database'
const STANDALONE_DATABASE_MANIFEST_BACKUP_KIND = 'standalone-database-manifest'
const STANDALONE_DATABASE_BACKUP_ROOT = '__knowbook/databases'
const STANDALONE_DATABASE_MANIFEST_FILE_NAME = 'index.md'
const INTERNAL_BACKUP_ROOT_SEGMENT = '__knowbook'
const ESCAPED_DOCUMENT_ROOT_PREFIX = '__knowbook-document-'
const ASSET_BACKUP_ROOT = '__knowbook/assets'
const FILE_URL_PATTERN = /file:\/\/\/[^\s<>"')\\\]}]+/g
const ABANDONED_STAGING_PREFIX = '.knowbook-markdown-'
const ABANDONED_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface BackupExportJobBase {
  backupRoot: string
  assetRoot?: string
}

export interface BackupDataExportJob extends BackupExportJobBase {
  documents: ExportDocument[]
  standaloneDatabases: ExportStandaloneDatabase[]
}

export interface BackupDatabaseExportJob extends BackupExportJobBase {
  databasePath: string
}

export type BackupExportJob = BackupDataExportJob | BackupDatabaseExportJob
export type BackupExportRunner = (job: BackupExportJob) => Promise<number | void>

export function writeBackupSnapshot(job: BackupExportJob): number {
  if ('databasePath' in job) {
    const store = new KnowbookStore(job.databasePath)
    try {
      const snapshot = store.runInTransaction(() => ({
        documents: store.getExportDocuments(),
        standaloneDatabases: store.getExportStandaloneDatabases()
      }))
      new MarkdownBackupWriter(job.backupRoot, job.assetRoot).writeAll(
        snapshot.documents,
        snapshot.standaloneDatabases
      )
      return snapshot.documents.length
    } finally {
      store.destroy()
    }
  }

  new MarkdownBackupWriter(job.backupRoot, job.assetRoot).writeAll(job.documents, job.standaloneDatabases)
  return job.documents.length
}

async function writeBackupSnapshotInline(job: BackupExportJob): Promise<number> {
  return writeBackupSnapshot(job)
}

export class MarkdownBackupService {
  private inFlightExport: Promise<BackupResult> | null = null
  private lastCompletedResult: BackupResult | null = null
  private lastCompletedRevision: string | null = null

  constructor(
    private readonly store: KnowbookStore,
    private readonly backupRoot: string,
    private readonly assetRoot?: string,
    private readonly runExport: BackupExportRunner = writeBackupSnapshotInline
  ) {}

  exportAll(force = false): Promise<BackupResult> {
    if (this.inFlightExport) {
      return this.inFlightExport
    }

    const getBackupRevision = (this.store as KnowbookStore & { getBackupRevision?: () => string }).getBackupRevision
    const revision = getBackupRevision?.call(this.store) ?? null
    if (!force && revision && revision === this.lastCompletedRevision && this.lastCompletedResult) {
      return Promise.resolve(this.lastCompletedResult)
    }

    const getDatabasePath = (this.store as KnowbookStore & { getDatabasePath?: () => string }).getDatabasePath
    const databasePath = getDatabasePath?.call(this.store)
    let job: BackupExportJob
    let fallbackExported: number
    if (databasePath) {
      job = {
        databasePath,
        backupRoot: this.backupRoot,
        assetRoot: this.assetRoot
      }
      fallbackExported = this.store.getDocumentCount()
    } else {
      const documents = this.store.getExportDocuments()
      job = {
        documents,
        standaloneDatabases: this.store.getExportStandaloneDatabases(),
        backupRoot: this.backupRoot,
        assetRoot: this.assetRoot
      }
      fallbackExported = documents.length
    }
    const exportPromise = this.performExport(job, fallbackExported).then((result) => {
      this.lastCompletedRevision = revision
      this.lastCompletedResult = result
      return result
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

  private async performExport(job: BackupExportJob, fallbackExported: number): Promise<BackupResult> {
    const exported = await this.runExport(job)
    const at = new Date().toISOString()
    this.store.saveSetting('backup.lastRunAt', at)

    return {
      exported: exported ?? fallbackExported,
      root: this.backupRoot,
      at
    }
  }
}

class MarkdownBackupWriter {
  private readonly ensuredDirectories = new Set<string>()
  private readonly copiedAssets = new Set<string>()

  constructor(
    private readonly backupRoot: string,
    private readonly assetRoot?: string
  ) {}

  writeAll(documents: ExportDocument[], standaloneDatabases: ExportStandaloneDatabase[]): void {
    const backupParent = dirname(this.backupRoot)
    mkdirSync(backupParent, { recursive: true })
    this.cleanupAbandonedStagingRoots(backupParent)
    const stagingRoot = mkdtempSync(join(backupParent, ABANDONED_STAGING_PREFIX))
    this.ensuredDirectories.add(stagingRoot)

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

  private cleanupAbandonedStagingRoots(backupParent: string): void {
    let entries: Array<{ isDirectory: () => boolean; name: string }>
    try {
      entries = readdirSync(backupParent, { withFileTypes: true })
    } catch {
      return
    }

    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(ABANDONED_STAGING_PREFIX)) {
        continue
      }

      const candidatePath = join(backupParent, entry.name)
      try {
        if (now - statSync(candidatePath).mtimeMs < ABANDONED_STAGING_MAX_AGE_MS) {
          continue
        }
        rmSync(candidatePath, { recursive: true, force: true })
      } catch (error) {
        console.warn(`Failed to clean up abandoned backup staging directory at ${candidatePath}.`, error)
      }
    }
  }

  private writeDocument(root: string, document: ExportDocument): void {
    const segments = document.path
      .split('/')
      .map((segment, index) => this.toSafeDocumentPathSegment(segment, index))
    const filePath = join(root, ...segments) + '.md'
    this.assertPathInsideRoot(filePath, root)
    this.ensureDirectory(dirname(filePath))
    writeFileSync(
      filePath,
      this.rewriteManagedAssetReferences(root, filePath, this.renderMarkdown(document)),
      'utf8'
    )
  }

  private writeStandaloneDatabase(root: string, database: ExportStandaloneDatabase): void {
    const filePath = join(root, ...STANDALONE_DATABASE_BACKUP_ROOT.split('/'), `${this.toSafePathSegment(database.id)}.md`)
    this.assertPathInsideRoot(filePath, root)
    this.ensureDirectory(dirname(filePath))
    writeFileSync(
      filePath,
      this.rewriteManagedAssetReferences(root, filePath, this.renderStandaloneDatabase(database)),
      'utf8'
    )
  }

  private writeStandaloneDatabaseManifest(root: string, databases: ExportStandaloneDatabase[]): void {
    const filePath = join(root, ...STANDALONE_DATABASE_BACKUP_ROOT.split('/'), STANDALONE_DATABASE_MANIFEST_FILE_NAME)
    this.ensureDirectory(dirname(filePath))
    writeFileSync(filePath, this.renderStandaloneDatabaseManifest(databases), 'utf8')
  }

  private ensureDirectory(directoryPath: string): void {
    if (this.ensuredDirectories.has(directoryPath)) {
      return
    }
    mkdirSync(directoryPath, { recursive: true })
    this.ensuredDirectories.add(directoryPath)
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
      try {
        rmSync(previousRoot, { recursive: true, force: true })
      } catch (error) {
        console.warn(`Failed to remove the previous backup snapshot at ${previousRoot}. The new snapshot was published successfully.`, error)
      }
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
        console.warn(`Skipping managed backup asset that no longer exists: ${assetUrl}`)
        return assetUrl
      }

      const realAssetRoot = realpathSync(normalizedAssetRoot)
      const sourcePath = realpathSync(candidatePath)
      if (!this.isPathInsideRoot(sourcePath, realAssetRoot)) {
        throw new Error(`Managed backup asset resolves outside the asset root: ${assetUrl}`)
      }

      const assetRelativePath = relative(normalizedAssetRoot, candidatePath)
      const snapshotAssetPath = join(snapshotRoot, ...ASSET_BACKUP_ROOT.split('/'), assetRelativePath)
      this.assertPathInsideRoot(snapshotAssetPath, snapshotRoot)
      if (!this.copiedAssets.has(snapshotAssetPath)) {
        this.ensureDirectory(dirname(snapshotAssetPath))
        copyFileSync(sourcePath, snapshotAssetPath)
        this.copiedAssets.add(snapshotAssetPath)
      }

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
      || segment.length > 60
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
      .slice(0, 40) || 'Untitled'
    const digest = createHash('sha256').update(segment).digest('hex').slice(0, 10)
    return `${readable}--${digest}`
  }

  private toSafeDocumentPathSegment(segment: string, index: number): string {
    if (
      index === 0
      && (segment === INTERNAL_BACKUP_ROOT_SEGMENT || segment.startsWith(ESCAPED_DOCUMENT_ROOT_PREFIX))
    ) {
      const digest = createHash('sha256').update(segment).digest('hex').slice(0, 16)
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
