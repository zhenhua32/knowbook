import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  BackupRestorePreview,
  BackupRestoreResult,
  DatabaseEntity,
  DatabaseSavedViewLayoutMode,
  DatabaseSavedViewSortMode,
  CreateDocumentDatabaseColumnInput,
  DocumentBlockDraft,
  DocumentDatabaseColumn,
  DocumentDatabaseFieldValue
} from '@shared/contracts'
import { parseMarkdownBackupDocument } from '@shared/markdown'
import { KnowbookStore } from '../database/store'

type RestoreSourceDocument = {
  kind: 'document'
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

type RestoreSourceStandaloneDatabaseSavedView = {
  id: string
  name: string
  filterQuery: string
  filterScope: string
  sortMode: DatabaseSavedViewSortMode
  viewMode: DatabaseSavedViewLayoutMode
}

type RestoreSourceStandaloneDatabaseEntity = {
  id: string
  documentPath: string | null
  fieldValues: Record<string, DocumentDatabaseFieldValue>
}

type RestoreSourceStandaloneDatabase = {
  kind: 'standalone-database'
  sourceFilePath: string
  sourceDatabaseId: string
  name: string
  description: string
  columns: DocumentDatabaseColumn[]
  savedViews: RestoreSourceStandaloneDatabaseSavedView[]
  entities: RestoreSourceStandaloneDatabaseEntity[]
}

type RestoreSourceStandaloneDatabaseManifest = {
  kind: 'standalone-database-manifest'
  sourceFilePath: string
  sourceDatabaseIds: string[]
}

type RestoreSourceFile = RestoreSourceDocument | RestoreSourceStandaloneDatabase | RestoreSourceStandaloneDatabaseManifest

type PreparedRestoreSources = {
  sourceDocuments: RestoreSourceDocument[]
  sourceStandaloneDatabases: RestoreSourceStandaloneDatabase[]
  sourceStandaloneDatabaseManifest: RestoreSourceStandaloneDatabaseManifest | undefined
  assets: RestoreAssetCopy[]
}

type DocumentSnapshot = ReturnType<KnowbookStore['getAllDocumentSnapshots']>[number]

type RestoreAssetCopy = {
  sourcePath: string
  destinationPath: string
}

type StagedRestoreAsset = RestoreAssetCopy & {
  stagedPath: string
  backupPath: string
}

type StagedRestoreAssets = {
  root: string
  assets: StagedRestoreAsset[]
}

type PublishedRestoreAsset = {
  destinationPath: string
  backupPath: string | null
  published: boolean
}

export type ParsedBackupDocument = ReturnType<typeof parseMarkdownBackupDocument>

export type RestoreMarkdownParseRunner = (
  markdownSources: string[]
) => Promise<ParsedBackupDocument[]>

export type MarkdownRestoreLimits = {
  maxEntries: number
  maxDepth: number
  maxMarkdownFiles: number
  maxMarkdownFileBytes: number
  maxMarkdownTotalBytes: number
  maxAssetFiles: number
  maxAssetFileBytes: number
  maxAssetTotalBytes: number
}

type RestoreReadBudget = {
  assetPaths: Set<string>
  assetBytes: number
}

const DOCUMENT_DATABASE_COLUMN_TYPES = new Set(['text', 'select', 'multi-select', 'date', 'checkbox'])
const DATABASE_SAVED_VIEW_SORT_MODES = new Set(['updated-desc', 'updated-asc', 'created-desc', 'created-asc'])
const DATABASE_SAVED_VIEW_LAYOUT_MODES = new Set(['cards', 'table'])
const STANDALONE_DATABASE_BACKUP_KIND = 'standalone-database'
const STANDALONE_DATABASE_MANIFEST_BACKUP_KIND = 'standalone-database-manifest'
const STANDALONE_DATABASE_MANIFEST_RELATIVE_PATH = '__knowbook/databases/index.md'
const ASSET_BACKUP_ROOT = '__knowbook/assets'
const PORTABLE_ASSET_REFERENCE_PATTERN = /(?:\.\.\/|\.\/)+[A-Za-z0-9._~%/-]+/g
const DEFAULT_DOCUMENT_DATABASE_NAME = 'Default'
const DEFAULT_DOCUMENT_DATABASE_DESCRIPTION = 'Default database'
const DEFAULT_RESTORE_LIMITS: MarkdownRestoreLimits = {
  maxEntries: 20_000,
  maxDepth: 32,
  maxMarkdownFiles: 5_000,
  maxMarkdownFileBytes: 5 * 1024 * 1024,
  maxMarkdownTotalBytes: 100 * 1024 * 1024,
  maxAssetFiles: 5_000,
  maxAssetFileBytes: 50 * 1024 * 1024,
  maxAssetTotalBytes: 500 * 1024 * 1024
}

const parseRestoreMarkdownInProcess: RestoreMarkdownParseRunner = async (markdownSources) => (
  markdownSources.map((markdown) => parseMarkdownBackupDocument(markdown))
)

export class MarkdownRestoreService {
  private readonly limits: MarkdownRestoreLimits
  private activeRestore: Promise<BackupRestoreResult> | null = null

  constructor(
    private readonly store: KnowbookStore,
    private readonly assetRoot?: string,
    limits: Partial<MarkdownRestoreLimits> = {},
    private readonly parseMarkdownSources: RestoreMarkdownParseRunner = parseRestoreMarkdownInProcess
  ) {
    this.limits = {
      ...DEFAULT_RESTORE_LIMITS,
      ...limits
    }
  }

  async previewFromDirectory(root: string): Promise<BackupRestorePreview> {
    const {
      sourceDocuments,
      sourceStandaloneDatabases,
      sourceStandaloneDatabaseManifest
    } = await this.prepareRestoreSources(root, false)
    const snapshots = this.store.getAllDocumentSnapshots()
    const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
    const snapshotsByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]))
    const restoredDocumentIds = new Set<string>()
    let created = 0
    let updated = 0

    for (const source of sourceDocuments) {
      const existingById = source.sourceDocumentId ? snapshotsById.get(source.sourceDocumentId) : null
      const existing = existingById ?? snapshotsByPath.get(source.documentPath)
      if (existing) {
        updated += 1
        restoredDocumentIds.add(existing.id)
      } else {
        created += 1
      }
    }

    const standaloneDatabaseChanges = this.previewStandaloneDatabaseChanges(
      sourceStandaloneDatabases,
      Boolean(sourceStandaloneDatabaseManifest)
    )

    return {
      root,
      restored: sourceDocuments.length,
      created,
      updated,
      deleted: sourceStandaloneDatabaseManifest
        ? this.findMissingDocuments(sourceDocuments, restoredDocumentIds, snapshots).length
        : 0,
      conflictsResolved: this.countResolvableConflicts(sourceDocuments, snapshots),
      placeholdersCreated: this.countMissingParentPlaceholders(sourceDocuments, snapshots),
      standaloneDatabases: sourceStandaloneDatabases.length,
      standaloneDatabasesCreated: standaloneDatabaseChanges.created,
      standaloneDatabasesUpdated: standaloneDatabaseChanges.updated,
      standaloneDatabasesDeleted: standaloneDatabaseChanges.deleted
    }
  }

  async restoreFromDirectory(root: string): Promise<BackupRestoreResult> {
    if (this.activeRestore) {
      throw new Error('A restore operation is already in progress.')
    }

    const operation = this.performRestoreFromDirectory(root)
    this.activeRestore = operation
    try {
      return await operation
    } finally {
      if (this.activeRestore === operation) {
        this.activeRestore = null
      }
    }
  }

  private async performRestoreFromDirectory(root: string): Promise<BackupRestoreResult> {
    const {
      sourceDocuments,
      sourceStandaloneDatabases,
      sourceStandaloneDatabaseManifest,
      assets
    } = await this.prepareRestoreSources(root, true)

    const stagedAssets = await this.stageRestoreAssets(assets)
    const publishedAssets: PublishedRestoreAsset[] = []
    let preserveStagingForRecovery = false

    try {
      if (stagedAssets) {
        await this.publishRestoreAssets(stagedAssets, publishedAssets)
      }

      return this.store.runInBulkDocumentMutation(() => {
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

        if (sourceStandaloneDatabaseManifest) {
          deleted = this.deleteMissingDocuments(sourceDocuments, restoredDocumentIds)
        }
        this.restoreStandaloneDatabases(sourceStandaloneDatabases, Boolean(sourceStandaloneDatabaseManifest))

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
      })
    } catch (error) {
      try {
        await this.rollbackPublishedRestoreAssets(publishedAssets)
      } catch (rollbackError) {
        preserveStagingForRecovery = true
        throw new Error(
          `Restore failed and managed assets could not be rolled back. Recovery files remain at ${stagedAssets?.root ?? 'the restore staging directory'}.`,
          { cause: new AggregateError([error, rollbackError]) }
        )
      }

      throw error
    } finally {
      if (stagedAssets && !preserveStagingForRecovery) {
        await this.cleanupRestoreAssetStage(stagedAssets.root)
      }
    }
  }

  private async prepareRestoreSources(root: string, collectAssets: boolean): Promise<PreparedRestoreSources> {
    const markdownFiles = await this.collectMarkdownFiles(root)
    const budget: RestoreReadBudget = {
      assetPaths: new Set(),
      assetBytes: 0
    }
    const assetsByDestination = new Map<string, RestoreAssetCopy>()
    const sourceInputs: Array<{
      filePath: string
      relativePath: string
      markdown: string
    }> = []
    for (const filePath of markdownFiles) {
      const relativePath = relative(root, filePath)
        .replace(/\\/g, '/')
        .replace(/\.md$/i, '')
      const sourceMarkdown = await readFile(filePath, 'utf8')
      const markdown = await this.restorePortableAssetReferences(
        root,
        filePath,
        sourceMarkdown,
        collectAssets,
        budget,
        assetsByDestination
      )
      sourceInputs.push({ filePath, relativePath, markdown })
    }

    const parsedDocuments = await this.parseMarkdownSources(
      sourceInputs.map((source) => source.markdown)
    )
    if (parsedDocuments.length !== sourceInputs.length) {
      throw new Error('Restore Markdown parser returned an incomplete result.')
    }
    const sourceFiles = sourceInputs.map((source, index) => this.buildRestoreSourceFile(
      source.filePath,
      source.relativePath,
      parsedDocuments[index] as ParsedBackupDocument
    ))
    const sourceDocuments = sourceFiles
      .filter((source): source is RestoreSourceDocument => source.kind === 'document')
      .sort((left, right) => {
        const depthDifference = this.getDocumentPathDepth(left.documentPath) - this.getDocumentPathDepth(right.documentPath)
        return depthDifference !== 0
          ? depthDifference
          : left.documentPath.localeCompare(right.documentPath)
      })
    const discoveredStandaloneDatabases = sourceFiles
      .filter((source): source is RestoreSourceStandaloneDatabase => source.kind === 'standalone-database')
    const sourceStandaloneDatabaseManifest = sourceFiles.find(
      (source): source is RestoreSourceStandaloneDatabaseManifest => (
        source.kind === 'standalone-database-manifest'
        && this.isAuthoritativeBackupManifest(root, source.sourceFilePath)
      )
    )

    const manifestDatabaseIds = sourceStandaloneDatabaseManifest
      ? new Set(sourceStandaloneDatabaseManifest.sourceDatabaseIds)
      : null
    const sourceStandaloneDatabases = manifestDatabaseIds
      ? discoveredStandaloneDatabases.filter((source) => manifestDatabaseIds.has(source.sourceDatabaseId))
      : discoveredStandaloneDatabases

    return {
      sourceDocuments,
      sourceStandaloneDatabases,
      sourceStandaloneDatabaseManifest,
      assets: [...assetsByDestination.values()]
    }
  }

  private async collectMarkdownFiles(root: string): Promise<string[]> {
    const rootStat = await lstat(root).catch(() => null)
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Restore directory not found')
    }

    const realRoot = await realpath(root)
    const files: string[] = []
    let entryCount = 0
    let markdownBytes = 0
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > this.limits.maxDepth) {
        throw new Error(`Restore directory exceeds the maximum depth of ${this.limits.maxDepth}.`)
      }

      for (const entry of await readdir(directory, { withFileTypes: true })) {
        entryCount += 1
        if (entryCount > this.limits.maxEntries) {
          throw new Error(`Restore directory exceeds the ${this.limits.maxEntries}-entry limit.`)
        }

        const fullPath = join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          throw new Error(`Restore directory cannot contain symbolic links: ${fullPath}`)
        }
        if (entry.isDirectory()) {
          const realDirectory = await realpath(fullPath)
          if (!this.isPathInsideRoot(realDirectory, realRoot)) {
            throw new Error(`Restore directory resolves outside the selected root: ${fullPath}`)
          }
          await visit(fullPath, depth + 1)
          continue
        }

        if (!entry.isFile()) {
          throw new Error(`Restore directory contains an unsupported file type: ${fullPath}`)
        }
        if (!entry.name.toLowerCase().endsWith('.md')) {
          continue
        }

        const fileStat = await stat(fullPath)
        if (fileStat.size > this.limits.maxMarkdownFileBytes) {
          throw new Error(`Restore Markdown file exceeds the ${this.limits.maxMarkdownFileBytes}-byte limit: ${fullPath}`)
        }
        markdownBytes += fileStat.size
        if (markdownBytes > this.limits.maxMarkdownTotalBytes) {
          throw new Error(`Restore Markdown files exceed the ${this.limits.maxMarkdownTotalBytes}-byte total limit.`)
        }
        files.push(fullPath)
        if (files.length > this.limits.maxMarkdownFiles) {
          throw new Error(`Restore directory exceeds the ${this.limits.maxMarkdownFiles}-Markdown-file limit.`)
        }
      }
    }

    await visit(root, 0)
    return files
  }

  private buildRestoreSourceFile(
    filePath: string,
    relativePath: string,
    parsed: ParsedBackupDocument
  ): RestoreSourceFile {
    if (parsed.frontmatter.kind === STANDALONE_DATABASE_BACKUP_KIND) {
      return this.parseSourceStandaloneDatabase(filePath, parsed)
    }

    if (parsed.frontmatter.kind === STANDALONE_DATABASE_MANIFEST_BACKUP_KIND) {
      return this.parseSourceStandaloneDatabaseManifest(filePath, parsed)
    }

    return this.parseSourceDocument(filePath, parsed, relativePath)
  }

  private parseSourceDocument(
    filePath: string,
    parsed: ReturnType<typeof parseMarkdownBackupDocument>,
    relativePath: string
  ): RestoreSourceDocument {
    const normalizedRelativePath = this.normalizeDocumentPath(relativePath)
    const normalizedDocumentPath = this.normalizeDocumentPath(parsed.frontmatter.path || normalizedRelativePath)
    const documentDatabaseColumns = this.parseSourceDocumentDatabaseColumns(parsed.frontmatter.documentDatabaseColumns)

    if (!normalizedDocumentPath) {
      throw new Error(`Cannot restore document without a valid path: ${filePath}`)
    }

    const pathSegments = normalizedDocumentPath.split('/')
    const title = pathSegments[pathSegments.length - 1] ?? 'Untitled'

    return {
      kind: 'document',
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

  private parseSourceStandaloneDatabase(
    filePath: string,
    parsed: ReturnType<typeof parseMarkdownBackupDocument>
  ): RestoreSourceStandaloneDatabase {
    const sourceDatabaseId = parsed.frontmatter.databaseId?.trim()
    const name = parsed.frontmatter.databaseName?.trim()

    if (!sourceDatabaseId) {
      throw new Error(`Cannot restore standalone database without an id: ${filePath}`)
    }

    if (!name) {
      throw new Error(`Cannot restore standalone database without a name: ${filePath}`)
    }

    const columns = this.parseSourceDocumentDatabaseColumns(parsed.frontmatter.databaseColumns)

    return {
      kind: 'standalone-database',
      sourceFilePath: filePath,
      sourceDatabaseId,
      name,
      description: parsed.frontmatter.databaseDescription ?? '',
      columns,
      savedViews: this.parseSourceStandaloneDatabaseSavedViews(parsed.frontmatter.databaseSavedViews),
      entities: this.parseSourceStandaloneDatabaseEntities(parsed.frontmatter.databaseEntities, columns)
    }
  }

  private parseSourceStandaloneDatabaseManifest(
    filePath: string,
    parsed: ReturnType<typeof parseMarkdownBackupDocument>
  ): RestoreSourceStandaloneDatabaseManifest {
    return {
      kind: 'standalone-database-manifest',
      sourceFilePath: filePath,
      sourceDatabaseIds: this.parseSourceStandaloneDatabaseIds(parsed.frontmatter.databaseIds)
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

  private async restorePortableAssetReferences(
    root: string,
    markdownFilePath: string,
    markdown: string,
    collectAssets: boolean,
    budget: RestoreReadBudget,
    assetsByDestination: Map<string, RestoreAssetCopy>
  ): Promise<string> {
    if (!this.assetRoot) {
      return markdown
    }

    const snapshotAssetRoot = resolve(root, ...ASSET_BACKUP_ROOT.split('/'))
    const normalizedAssetRoot = resolve(this.assetRoot)
    const replacements = new Map<string, string>()
    const portableReferences = [...new Set(markdown.match(PORTABLE_ASSET_REFERENCE_PATTERN) ?? [])]

    for (const portableReference of portableReferences) {
      const sourceAssetPath = resolve(dirname(markdownFilePath), portableReference)
      if (!this.isPathInsideRoot(sourceAssetPath, snapshotAssetRoot)) {
        continue
      }

      const sourceEntryStat = await lstat(sourceAssetPath).catch(() => null)
      if (!sourceEntryStat?.isFile() || sourceEntryStat.isSymbolicLink()) {
        throw new Error(`Backup asset not found: ${portableReference}`)
      }

      const realSnapshotAssetRoot = await realpath(snapshotAssetRoot)
      const realSourceAssetPath = await realpath(sourceAssetPath)
      if (!this.isPathInsideRoot(realSourceAssetPath, realSnapshotAssetRoot)) {
        throw new Error(`Backup asset resolves outside the backup asset root: ${portableReference}`)
      }
      const sourceStat = await stat(realSourceAssetPath)
      if (sourceStat.size > this.limits.maxAssetFileBytes) {
        throw new Error(`Backup asset exceeds the ${this.limits.maxAssetFileBytes}-byte limit: ${portableReference}`)
      }
      if (!budget.assetPaths.has(realSourceAssetPath)) {
        budget.assetPaths.add(realSourceAssetPath)
        budget.assetBytes += sourceStat.size
        if (budget.assetPaths.size > this.limits.maxAssetFiles) {
          throw new Error(`Backup assets exceed the ${this.limits.maxAssetFiles}-file limit.`)
        }
        if (budget.assetBytes > this.limits.maxAssetTotalBytes) {
          throw new Error(`Backup assets exceed the ${this.limits.maxAssetTotalBytes}-byte total limit.`)
        }
      }

      const assetRelativePath = relative(snapshotAssetRoot, sourceAssetPath)
      const destinationPath = resolve(normalizedAssetRoot, assetRelativePath)
      if (!this.isPathInsideRoot(destinationPath, normalizedAssetRoot)) {
        throw new Error(`Backup asset resolved outside the managed asset root: ${portableReference}`)
      }

      if (collectAssets) {
        assetsByDestination.set(destinationPath, {
          sourcePath: realSourceAssetPath,
          destinationPath
        })
      }
      replacements.set(portableReference, pathToFileURL(destinationPath).toString())
    }

    return markdown.replace(
      PORTABLE_ASSET_REFERENCE_PATTERN,
      (portableReference) => replacements.get(portableReference) ?? portableReference
    )
  }

  private async stageRestoreAssets(assets: RestoreAssetCopy[]): Promise<StagedRestoreAssets | null> {
    if (assets.length === 0 || !this.assetRoot) {
      return null
    }

    const normalizedAssetRoot = resolve(this.assetRoot)
    const assetRootParent = dirname(normalizedAssetRoot)
    await mkdir(assetRootParent, { recursive: true })
    const stageRoot = await mkdtemp(join(assetRootParent, `.${basename(normalizedAssetRoot)}-restore-`))

    try {
      const stagedAssets: StagedRestoreAsset[] = []
      for (const [index, asset] of assets.entries()) {
        const stagedPath = join(stageRoot, 'new', String(index))
        const backupPath = join(stageRoot, 'previous', String(index))
        await mkdir(dirname(stagedPath), { recursive: true })
        await copyFile(asset.sourcePath, stagedPath)
        stagedAssets.push({
          ...asset,
          stagedPath,
          backupPath
        })
      }

      return {
        root: stageRoot,
        assets: stagedAssets
      }
    } catch (error) {
      await this.cleanupRestoreAssetStage(stageRoot)
      throw error
    }
  }

  private async publishRestoreAssets(
    stagedAssets: StagedRestoreAssets,
    publishedAssets: PublishedRestoreAsset[]
  ): Promise<void> {
    if (!this.assetRoot) {
      throw new Error('Managed asset root is unavailable while publishing restored assets.')
    }

    const normalizedAssetRoot = resolve(this.assetRoot)
    await mkdir(normalizedAssetRoot, { recursive: true })
    const assetRootStat = await lstat(normalizedAssetRoot)
    if (!assetRootStat.isDirectory() || assetRootStat.isSymbolicLink()) {
      throw new Error(`Managed asset root must be a directory without symbolic links: ${normalizedAssetRoot}`)
    }

    for (const asset of stagedAssets.assets) {
      await this.assertSafeAssetDestination(asset.destinationPath, normalizedAssetRoot)
      await mkdir(dirname(asset.destinationPath), { recursive: true })
      const destinationStat = await this.lstatIfExists(asset.destinationPath)
      if (destinationStat && (!destinationStat.isFile() || destinationStat.isSymbolicLink())) {
        throw new Error(`Managed asset destination must be a regular file: ${asset.destinationPath}`)
      }

      const publishedAsset: PublishedRestoreAsset = {
        destinationPath: asset.destinationPath,
        backupPath: null,
        published: false
      }
      publishedAssets.push(publishedAsset)

      if (destinationStat) {
        await mkdir(dirname(asset.backupPath), { recursive: true })
        await rename(asset.destinationPath, asset.backupPath)
        publishedAsset.backupPath = asset.backupPath
      }
      await rename(asset.stagedPath, asset.destinationPath)
      publishedAsset.published = true
    }
  }

  private async rollbackPublishedRestoreAssets(publishedAssets: PublishedRestoreAsset[]): Promise<void> {
    const rollbackErrors: unknown[] = []

    for (const asset of [...publishedAssets].reverse()) {
      try {
        if (asset.published) {
          await rm(asset.destinationPath, { force: true })
        }
        if (asset.backupPath) {
          await mkdir(dirname(asset.destinationPath), { recursive: true })
          await rename(asset.backupPath, asset.destinationPath)
        }
      } catch (error) {
        rollbackErrors.push(error)
      }
    }
    publishedAssets.length = 0

    if (rollbackErrors.length > 0) {
      throw new AggregateError(rollbackErrors, 'One or more managed assets could not be rolled back.')
    }
  }

  private async assertSafeAssetDestination(destinationPath: string, normalizedAssetRoot: string): Promise<void> {
    if (!this.isPathInsideRoot(destinationPath, normalizedAssetRoot)) {
      throw new Error(`Managed asset destination resolved outside the asset root: ${destinationPath}`)
    }

    let currentPath = dirname(destinationPath)
    while (currentPath !== normalizedAssetRoot) {
      const currentStat = await this.lstatIfExists(currentPath)
      if (currentStat) {
        if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
          throw new Error(`Managed asset destination contains an unsafe path component: ${currentPath}`)
        }
      }

      const parentPath = dirname(currentPath)
      if (parentPath === currentPath || !this.isPathInsideRoot(parentPath, normalizedAssetRoot)) {
        throw new Error(`Managed asset destination resolved outside the asset root: ${destinationPath}`)
      }
      currentPath = parentPath
    }
  }

  private async lstatIfExists(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
    try {
      return await lstat(filePath)
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return null
      }
      throw error
    }
  }

  private async cleanupRestoreAssetStage(stageRoot: string): Promise<void> {
    try {
      await rm(stageRoot, { recursive: true, force: true })
    } catch (error) {
      console.warn(`Failed to remove restore asset staging directory at ${stageRoot}.`, error)
    }
  }

  private isPathInsideRoot(filePath: string, root: string): boolean {
    const normalizedRoot = resolve(root)
    const normalizedFilePath = resolve(filePath)
    return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}${sep}`)
  }

  private isAuthoritativeBackupManifest(root: string, filePath: string): boolean {
    return relative(root, filePath).replace(/\\/g, '/').toLowerCase()
      === STANDALONE_DATABASE_MANIFEST_RELATIVE_PATH
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
      return this.parseSourceDatabaseFieldValues(JSON.parse(rawFieldValues) as unknown, columns)
    } catch {
      return {}
    }
  }

  private parseSourceDatabaseFieldValues(
    rawFieldValues: unknown,
    columns: DocumentDatabaseColumn[]
  ): Record<string, DocumentDatabaseFieldValue> {
    if (!rawFieldValues || typeof rawFieldValues !== 'object' || Array.isArray(rawFieldValues)) {
      return {}
    }

    const columnById = new Map(columns.map((column) => [column.id, column]))
    const values: Record<string, DocumentDatabaseFieldValue> = {}

    for (const [columnId, rawValue] of Object.entries(rawFieldValues as Record<string, unknown>)) {
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
    return this.ensureDatabaseColumns(this.collectSourceDocumentDatabaseColumns(sourceDocuments))
  }

  private ensureDatabaseColumns(sourceColumns: DocumentDatabaseColumn[], databaseId?: string): Map<string, string> {
    const normalizedSourceColumns = [...sourceColumns]
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    const targetColumns = this.store.getDocumentDatabaseColumns(databaseId)
    const targetById = new Map(targetColumns.map((column) => [column.id, column]))
    const targetByNameAndType = new Map(targetColumns.map((column) => [this.getDocumentDatabaseColumnLookupKey(column.name, column.type), column]))
    const columnIdMap = new Map<string, string>()

    for (const sourceColumn of normalizedSourceColumns) {
      let targetColumn = targetById.get(sourceColumn.id)
      if (targetColumn && targetColumn.type !== sourceColumn.type) {
        targetColumn = undefined
      }

      if (!targetColumn) {
        targetColumn = targetByNameAndType.get(this.getDocumentDatabaseColumnLookupKey(sourceColumn.name, sourceColumn.type))
      }

      if (!targetColumn) {
        targetColumn = this.store.createDocumentDatabaseColumn({
          databaseId,
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

  private restoreStandaloneDatabases(
    sourceDatabases: RestoreSourceStandaloneDatabase[],
    shouldDeleteMissingDatabases: boolean
  ): void {
    const existingDatabases = this.store.getDatabases()
    const existingById = new Map(existingDatabases.map((database) => [database.id, database]))
    const existingByName = new Map(
      existingDatabases
        .filter((database) => !this.isDefaultDocumentDatabase(database.name, database.description))
        .map((database) => [this.getDatabaseLookupKey(database.name), database])
    )
    const restoredDatabaseIds = new Set<string>()

    for (const source of sourceDatabases) {
      let targetDatabase = existingById.get(source.sourceDatabaseId)
      if (!targetDatabase) {
        targetDatabase = existingByName.get(this.getDatabaseLookupKey(source.name))
      }

      if (!targetDatabase) {
        targetDatabase = this.store.createDatabase({
          name: source.name,
          description: source.description
        })
      } else if (targetDatabase.name !== source.name || targetDatabase.description !== source.description) {
        this.store.updateDatabaseMetadata({
          databaseId: targetDatabase.id,
          name: source.name,
          description: source.description
        })
        targetDatabase = {
          ...targetDatabase,
          name: source.name,
          description: source.description
        }
      }

      existingById.set(source.sourceDatabaseId, targetDatabase)
      existingByName.set(this.getDatabaseLookupKey(targetDatabase.name), targetDatabase)
      restoredDatabaseIds.add(targetDatabase.id)

      const columnIdMap = this.ensureDatabaseColumns(source.columns, targetDatabase.id)
      this.restoreStandaloneDatabaseSavedViews(targetDatabase.id, source.savedViews)
      this.restoreStandaloneDatabaseEntities(targetDatabase.id, source.columns, source.entities, columnIdMap)
    }

    if (!shouldDeleteMissingDatabases) {
      return
    }

    for (const existingDatabase of existingDatabases) {
      if (this.isDefaultDocumentDatabase(existingDatabase.name, existingDatabase.description)) {
        continue
      }

      if (!restoredDatabaseIds.has(existingDatabase.id)) {
        this.store.deleteDatabase(existingDatabase.id)
      }
    }
  }

  private restoreStandaloneDatabaseSavedViews(
    databaseId: string,
    sourceViews: RestoreSourceStandaloneDatabaseSavedView[]
  ): void {
    const existingViews = this.store.getDatabaseSavedViews(databaseId)
    const existingById = new Map(existingViews.map((view) => [view.id, view]))
    const existingByName = new Map(existingViews.map((view) => [this.getDatabaseSavedViewLookupKey(view.name), view]))
    const restoredViewIds = new Set<string>()

    for (const sourceView of sourceViews) {
      let targetView = existingById.get(sourceView.id)
      if (!targetView) {
        targetView = existingByName.get(this.getDatabaseSavedViewLookupKey(sourceView.name))
      }

      if (!targetView) {
        targetView = this.store.createDatabaseSavedView({
          databaseId,
          name: sourceView.name,
          filterQuery: sourceView.filterQuery,
          filterScope: sourceView.filterScope,
          sortMode: sourceView.sortMode,
          viewMode: sourceView.viewMode
        })
      } else {
        targetView = this.store.updateDatabaseSavedView({
          viewId: targetView.id,
          name: sourceView.name,
          filterQuery: sourceView.filterQuery,
          filterScope: sourceView.filterScope,
          sortMode: sourceView.sortMode,
          viewMode: sourceView.viewMode
        })
      }

      restoredViewIds.add(targetView.id)
    }

    for (const existingView of existingViews) {
      if (!restoredViewIds.has(existingView.id)) {
        this.store.deleteDatabaseSavedView(existingView.id)
      }
    }
  }

  private restoreStandaloneDatabaseEntities(
    databaseId: string,
    sourceColumns: DocumentDatabaseColumn[],
    sourceEntities: RestoreSourceStandaloneDatabaseEntity[],
    columnIdMap: Map<string, string>
  ): void {
    const existingEntities = this.store.getDatabaseEntities(databaseId)
    const existingById = new Map(existingEntities.map((entity) => [entity.id, entity]))
    const existingByDocumentId = new Map(
      existingEntities
        .filter((entity) => Boolean(entity.documentId))
        .map((entity) => [entity.documentId as string, entity])
    )
    const existingBySignature = new Map<string, DatabaseEntity[]>()
    const restoredEntityIds = new Set<string>()

    for (const entity of existingEntities) {
      if (entity.documentId) {
        continue
      }

      const signature = this.getDatabaseEntitySignature(entity.fieldValues)
      const matches = existingBySignature.get(signature) ?? []
      matches.push(entity)
      existingBySignature.set(signature, matches)
    }

    for (const sourceEntity of sourceEntities) {
      const targetFieldValues = this.buildTargetDatabaseEntityFieldValues(sourceColumns, sourceEntity.fieldValues, columnIdMap)
      const signatureFieldValues = this.mapSourceDatabaseFieldValuesToTarget(sourceEntity.fieldValues, columnIdMap)
      const resolvedDocumentId = sourceEntity.documentPath
        ? this.store.getDocumentSnapshotByPath(sourceEntity.documentPath)?.id ?? null
        : null

      let targetEntity = existingById.get(sourceEntity.id)
      if (targetEntity && restoredEntityIds.has(targetEntity.id)) {
        targetEntity = undefined
      }

      if (!targetEntity && resolvedDocumentId) {
        const entityByDocumentId = existingByDocumentId.get(resolvedDocumentId)
        if (entityByDocumentId && !restoredEntityIds.has(entityByDocumentId.id)) {
          targetEntity = entityByDocumentId
        }
      }

      if (!targetEntity && !sourceEntity.documentPath) {
        targetEntity = this.takeMatchingDatabaseEntityBySignature(
          existingBySignature,
          this.getDatabaseEntitySignature(signatureFieldValues),
          restoredEntityIds
        )
      }

      if (!targetEntity) {
        const createdEntity = this.store.createDatabaseEntity({
          databaseId,
          documentId: resolvedDocumentId ?? undefined,
          fieldValues: targetFieldValues
        })
        restoredEntityIds.add(createdEntity.id)
        continue
      }

      this.store.updateDatabaseEntity({
        entityId: targetEntity.id,
        documentId: resolvedDocumentId,
        fieldValues: targetFieldValues
      })
      restoredEntityIds.add(targetEntity.id)
    }

    for (const existingEntity of existingEntities) {
      if (!restoredEntityIds.has(existingEntity.id)) {
        this.store.deleteDatabaseEntity(existingEntity.id)
      }
    }
  }

  private buildTargetDatabaseEntityFieldValues(
    sourceColumns: DocumentDatabaseColumn[],
    sourceFieldValues: Record<string, DocumentDatabaseFieldValue>,
    columnIdMap: Map<string, string>
  ): Record<string, DocumentDatabaseFieldValue> {
    const targetFieldValues: Record<string, DocumentDatabaseFieldValue> = {}

    for (const sourceColumn of sourceColumns) {
      const targetColumnId = columnIdMap.get(sourceColumn.id)
      if (!targetColumnId) {
        continue
      }

      targetFieldValues[targetColumnId] = Object.prototype.hasOwnProperty.call(sourceFieldValues, sourceColumn.id)
        ? sourceFieldValues[sourceColumn.id] ?? null
        : null
    }

    return targetFieldValues
  }

  private mapSourceDatabaseFieldValuesToTarget(
    sourceFieldValues: Record<string, DocumentDatabaseFieldValue>,
    columnIdMap: Map<string, string>
  ): Record<string, DocumentDatabaseFieldValue> {
    const mappedFieldValues: Record<string, DocumentDatabaseFieldValue> = {}

    for (const [sourceColumnId, value] of Object.entries(sourceFieldValues)) {
      const targetColumnId = columnIdMap.get(sourceColumnId)
      if (!targetColumnId) {
        continue
      }

      mappedFieldValues[targetColumnId] = value
    }

    return mappedFieldValues
  }

  private takeMatchingDatabaseEntityBySignature(
    entitiesBySignature: Map<string, DatabaseEntity[]>,
    signature: string,
    restoredEntityIds: Set<string>
  ): DatabaseEntity | undefined {
    const entities = entitiesBySignature.get(signature)
    if (!entities) {
      return undefined
    }

    while (entities.length > 0) {
      const candidate = entities.shift()
      if (candidate && !restoredEntityIds.has(candidate.id)) {
        return candidate
      }
    }

    return undefined
  }

  private getDatabaseEntitySignature(fieldValues: Record<string, DocumentDatabaseFieldValue>): string {
    return JSON.stringify(
      Object.entries(fieldValues)
        .sort(([leftColumnId], [rightColumnId]) => leftColumnId.localeCompare(rightColumnId))
    )
  }

  private getDatabaseLookupKey(name: string): string {
    return name.trim().toLowerCase()
  }

  private getDatabaseSavedViewLookupKey(name: string): string {
    return name.trim().toLowerCase()
  }

  private isDefaultDocumentDatabase(name: string, description: string): boolean {
    return name === DEFAULT_DOCUMENT_DATABASE_NAME && description === DEFAULT_DOCUMENT_DATABASE_DESCRIPTION
  }

  private parseSourceStandaloneDatabaseSavedViews(
    rawViews: string | undefined
  ): RestoreSourceStandaloneDatabaseSavedView[] {
    if (!rawViews) {
      return []
    }

    try {
      const parsed = JSON.parse(rawViews) as unknown
      if (!Array.isArray(parsed)) {
        return []
      }

      return parsed.flatMap((value): RestoreSourceStandaloneDatabaseSavedView[] => {
        if (!value || typeof value !== 'object') {
          return []
        }

        const candidate = value as Record<string, unknown>
        const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : null
        const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : null

        if (!id || !name) {
          return []
        }

        return [{
          id,
          name,
          filterQuery: typeof candidate.filterQuery === 'string' ? candidate.filterQuery : '',
          filterScope: typeof candidate.filterScope === 'string' ? candidate.filterScope.trim() : '',
          sortMode: typeof candidate.sortMode === 'string' && DATABASE_SAVED_VIEW_SORT_MODES.has(candidate.sortMode)
            ? candidate.sortMode as DatabaseSavedViewSortMode
            : 'updated-desc',
          viewMode: typeof candidate.viewMode === 'string' && DATABASE_SAVED_VIEW_LAYOUT_MODES.has(candidate.viewMode)
            ? candidate.viewMode as DatabaseSavedViewLayoutMode
            : 'cards'
        }]
      })
    } catch {
      return []
    }
  }

  private parseSourceStandaloneDatabaseEntities(
    rawEntities: string | undefined,
    columns: DocumentDatabaseColumn[]
  ): RestoreSourceStandaloneDatabaseEntity[] {
    if (!rawEntities) {
      return []
    }

    try {
      const parsed = JSON.parse(rawEntities) as unknown
      if (!Array.isArray(parsed)) {
        return []
      }

      return parsed.flatMap((value): RestoreSourceStandaloneDatabaseEntity[] => {
        if (!value || typeof value !== 'object') {
          return []
        }

        const candidate = value as Record<string, unknown>
        const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : null
        if (!id) {
          return []
        }

        const normalizedDocumentPath = typeof candidate.documentPath === 'string'
          ? this.normalizeDocumentPath(candidate.documentPath)
          : ''

        return [{
          id,
          documentPath: normalizedDocumentPath || null,
          fieldValues: this.parseSourceDatabaseFieldValues(candidate.fieldValues, columns)
        }]
      })
    } catch {
      return []
    }
  }

  private parseSourceStandaloneDatabaseIds(rawDatabaseIds: string | undefined): string[] {
    if (!rawDatabaseIds) {
      return []
    }

    try {
      const parsed = JSON.parse(rawDatabaseIds) as unknown
      if (!Array.isArray(parsed)) {
        return []
      }

      return [...new Set(parsed.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))]
    } catch {
      return []
    }
  }

  private countResolvableConflicts(
    sourceDocuments: RestoreSourceDocument[],
    snapshots: DocumentSnapshot[] = this.store.getAllDocumentSnapshots()
  ): number {
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

  private countMissingParentPlaceholders(
    sourceDocuments: RestoreSourceDocument[],
    snapshots: DocumentSnapshot[] = this.store.getAllDocumentSnapshots()
  ): number {
    const availablePaths = new Set(snapshots.map((snapshot) => snapshot.path))
    const sourcePaths = new Set(sourceDocuments.map((source) => source.documentPath))
    const placeholderPaths = new Set<string>()

    for (const source of sourceDocuments) {
      const segments = source.documentPath.split('/').filter(Boolean)
      for (let index = 1; index < segments.length; index += 1) {
        const parentPath = segments.slice(0, index).join('/')
        if (!availablePaths.has(parentPath) && !sourcePaths.has(parentPath)) {
          placeholderPaths.add(parentPath)
          availablePaths.add(parentPath)
        }
      }
    }

    return placeholderPaths.size
  }

  private previewStandaloneDatabaseChanges(
    sourceDatabases: RestoreSourceStandaloneDatabase[],
    shouldDeleteMissingDatabases: boolean
  ): { created: number; updated: number; deleted: number } {
    const existingDatabases = this.store.getDatabases()
    const existingById = new Map(existingDatabases.map((database) => [database.id, database]))
    const existingByName = new Map(
      existingDatabases
        .filter((database) => !this.isDefaultDocumentDatabase(database.name, database.description))
        .map((database) => [this.getDatabaseLookupKey(database.name), database])
    )
    const matchedDatabaseIds = new Set<string>()
    let created = 0
    let updated = 0

    for (const source of sourceDatabases) {
      const existing = existingById.get(source.sourceDatabaseId)
        ?? existingByName.get(this.getDatabaseLookupKey(source.name))
      if (existing) {
        updated += 1
        matchedDatabaseIds.add(existing.id)
      } else {
        created += 1
      }
    }

    const deleted = shouldDeleteMissingDatabases
      ? existingDatabases.filter((database) => (
          !this.isDefaultDocumentDatabase(database.name, database.description)
          && !matchedDatabaseIds.has(database.id)
        )).length
      : 0

    return { created, updated, deleted }
  }

  private deleteMissingDocuments(sourceDocuments: RestoreSourceDocument[], restoredDocumentIds: Set<string>): number {
    const deletable = this.findMissingDocuments(sourceDocuments, restoredDocumentIds)

    for (const snapshot of deletable) {
      this.store.deleteDocument(snapshot.id)
    }

    return deletable.length
  }

  private findMissingDocuments(
    sourceDocuments: RestoreSourceDocument[],
    restoredDocumentIds: Set<string>,
    snapshots: DocumentSnapshot[] = this.store.getAllDocumentSnapshots()
  ): DocumentSnapshot[] {
    const sourcePaths = new Set(sourceDocuments.map((source) => source.documentPath))
    const scopePaths = [...new Set(sourceDocuments.map((source) => source.restoreScopePath))]
    return snapshots
      .filter((snapshot) => !restoredDocumentIds.has(snapshot.id))
      .filter((snapshot) => this.isWithinRestoreScope(snapshot.path, scopePaths, sourcePaths))
      .sort((left, right) => {
        const depthDifference = this.getDocumentPathDepth(right.path) - this.getDocumentPathDepth(left.path)
        return depthDifference !== 0 ? depthDifference : left.path.localeCompare(right.path)
      })
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
