import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { parseMarkdownBackupDocument } from '../src/shared/markdown.ts'

test('MarkdownBackupService exports nested markdown files and persists backup timestamp', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-backup-test-'))
  const backupRoot = join(tempRoot, 'backup')

  const savedSettings: Array<{ key: string; value: string }> = []
  const store = {
    getExportDocuments: () => [
      {
        id: 'doc-1',
        title: 'Root',
        path: 'Root',
        summary: 'Root summary',
        updatedAt: '2026-05-02T00:00:00.000Z',
        documentDatabaseColumns: [],
        documentDatabaseFieldValues: {},
        blocks: [
          { id: 'b1', type: 'heading-1', content: 'Root', checked: false, depth: 0, parentBlockId: null, sortOrder: 0 },
          { id: 'b2', type: 'code', content: 'SELECT 1', checked: false, depth: 0, parentBlockId: null, sortOrder: 1 }
        ]
      },
      {
        id: 'doc-2',
        title: 'Child',
        path: 'Root/Child',
        summary: 'Child summary',
        updatedAt: '2026-05-02T00:00:00.000Z',
        documentDatabaseColumns: [],
        documentDatabaseFieldValues: {},
        blocks: [
          { id: 'b3', type: 'bulleted-list', content: 'Item', checked: false, depth: 0, parentBlockId: null, sortOrder: 0 },
          { id: 'b4', type: 'bulleted-list', content: 'Nested', checked: false, depth: 0, parentBlockId: 'b3', sortOrder: 1 }
        ]
      }
    ],
    getExportStandaloneDatabases: () => [
      {
        id: 'db-standalone',
        name: 'Projects',
        description: 'Standalone project tracker',
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z',
        columns: [
          {
            id: 'col-stage',
            name: 'Stage',
            type: 'select',
            options: ['Idea', 'Shipped'],
            sortOrder: 0
          }
        ],
        savedViews: [
          {
            id: 'view-open',
            databaseId: 'db-standalone',
            name: 'Open',
            filterQuery: '',
            filterScope: '',
            sortMode: 'updated-desc',
            viewMode: 'cards',
            createdAt: '2026-05-02T00:00:00.000Z',
            updatedAt: '2026-05-02T00:00:00.000Z'
          }
        ],
        entities: [
          {
            id: 'entity-1',
            documentId: null,
            documentPath: null,
            createdAt: '2026-05-02T00:00:00.000Z',
            updatedAt: '2026-05-02T00:00:00.000Z',
            fieldValues: {
              'col-stage': 'Idea'
            }
          }
        ]
      }
    ],
    saveSetting: (key: string, value: string) => {
      savedSettings.push({ key, value })
    }
  }

  try {
    const service = new MarkdownBackupService(store as never, backupRoot)
    const result = await service.exportAll()

    assert.equal(result.exported, 2)
    assert.equal(result.root, backupRoot)
    assert.equal(savedSettings.length, 1)
    assert.equal(savedSettings[0]?.key, 'backup.lastRunAt')
    assert.equal(/^\d{4}-\d{2}-\d{2}T/.test(savedSettings[0]?.value ?? ''), true)

    const rootFile = join(backupRoot, 'Root.md')
    const childFile = join(backupRoot, 'Root', 'Child.md')
    const standaloneDatabaseManifestFile = join(backupRoot, '__knowbook', 'databases', 'index.md')
    const standaloneDatabaseFile = join(backupRoot, '__knowbook', 'databases', 'db-standalone.md')

    assert.equal(statSync(rootFile).isFile(), true)
    assert.equal(statSync(childFile).isFile(), true)
    assert.equal(statSync(standaloneDatabaseManifestFile).isFile(), true)
    assert.equal(statSync(standaloneDatabaseFile).isFile(), true)

    const rootContent = readFileSync(rootFile, 'utf8')
    const childContent = readFileSync(childFile, 'utf8')
    const standaloneDatabaseManifestContent = readFileSync(standaloneDatabaseManifestFile, 'utf8')
    const standaloneDatabaseContent = readFileSync(standaloneDatabaseFile, 'utf8')
    const parsedRoot = parseMarkdownBackupDocument(rootContent)
    const parsedChild = parseMarkdownBackupDocument(childContent)
    const parsedStandaloneDatabaseManifest = parseMarkdownBackupDocument(standaloneDatabaseManifestContent)
    const parsedStandaloneDatabase = parseMarkdownBackupDocument(standaloneDatabaseContent)

    assert.deepEqual(parsedRoot.frontmatter, {
      id: 'doc-1',
      title: 'Root',
      path: 'Root',
      updatedAt: '2026-05-02T00:00:00.000Z',
      summary: 'Root summary',
      documentDatabaseColumns: '[]',
      documentDatabaseFieldValues: '{}'
    })
    assert.equal(rootContent.includes('```txt\nSELECT 1\n```'), true)
    assert.equal(parsedRoot.blocks[0]?.id, 'b1')
    assert.equal(parsedRoot.blocks[1]?.id, 'b2')
    assert.equal(parsedRoot.blocks[1]?.language, 'txt')

    assert.equal(childContent.includes('- Item'), true)
    assert.equal(parsedChild.frontmatter.documentDatabaseColumns, '[]')
    assert.equal(parsedChild.frontmatter.documentDatabaseFieldValues, '{}')
    assert.deepEqual(parsedChild.blocks.map((block) => ({
      id: block.id,
      type: block.type,
      content: block.content,
      depth: block.depth,
      parentBlockId: block.parentBlockId
    })), [
      {
        id: 'b3',
        type: 'bulleted-list',
        content: 'Item',
        depth: 0,
        parentBlockId: null
      },
      {
        id: 'b4',
        type: 'bulleted-list',
        content: 'Nested',
        depth: 1,
        parentBlockId: 'b3'
      }
    ])

    assert.equal(parsedStandaloneDatabaseManifest.frontmatter.kind, 'standalone-database-manifest')
    assert.equal(parsedStandaloneDatabaseManifest.frontmatter.databaseIds, '["db-standalone"]')
    assert.deepEqual(parsedStandaloneDatabaseManifest.blocks, [])

    assert.equal(parsedStandaloneDatabase.frontmatter.kind, 'standalone-database')
    assert.equal(parsedStandaloneDatabase.frontmatter.databaseId, 'db-standalone')
    assert.equal(parsedStandaloneDatabase.frontmatter.databaseName, 'Projects')
    assert.equal(parsedStandaloneDatabase.frontmatter.databaseDescription, 'Standalone project tracker')
    assert.deepEqual(JSON.parse(parsedStandaloneDatabase.frontmatter.databaseColumns), [
      {
        id: 'col-stage',
        name: 'Stage',
        type: 'select',
        options: ['Idea', 'Shipped'],
        sortOrder: 0
      }
    ])
    assert.deepEqual(JSON.parse(parsedStandaloneDatabase.frontmatter.databaseSavedViews), [
      {
        id: 'view-open',
        databaseId: 'db-standalone',
        name: 'Open',
        filterQuery: '',
        filterScope: '',
        sortMode: 'updated-desc',
        viewMode: 'cards',
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }
    ])
    assert.deepEqual(JSON.parse(parsedStandaloneDatabase.frontmatter.databaseEntities), [
      {
        id: 'entity-1',
        documentId: null,
        documentPath: null,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z',
        fieldValues: {
          'col-stage': 'Idea'
        }
      }
    ])
    assert.deepEqual(parsedStandaloneDatabase.blocks, [])
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownBackupService replaces stale files and keeps unsafe document paths inside the backup root', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-backup-snapshot-test-'))
  const backupRoot = join(tempRoot, 'backup')
  let documents = [{
    id: 'unsafe-doc',
    title: '..',
    path: '../../outside',
    summary: '',
    updatedAt: '2026-05-02T00:00:00.000Z',
    documentDatabaseColumns: [],
    documentDatabaseFieldValues: {},
    blocks: [{ id: 'b1', type: 'paragraph', content: 'safe', checked: false, depth: 0, parentBlockId: null, sortOrder: 0 }]
  }]
  const store = {
    getExportDocuments: () => documents,
    getExportStandaloneDatabases: () => [],
    saveSetting: () => undefined
  }

  try {
    const service = new MarkdownBackupService(store as never, backupRoot)
    await service.exportAll()
    assert.equal(existsSync(join(tempRoot, 'outside.md')), false)

    const staleFile = join(backupRoot, 'stale.md')
    writeFileSync(staleFile, 'stale', 'utf8')
    documents = []
    await service.exportAll()
    assert.equal(existsSync(staleFile), false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownBackupService keeps documents in the reserved metadata namespace', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-backup-reserved-path-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = {
    getExportDocuments: () => [{
      id: 'reserved-document',
      title: 'index',
      path: '__knowbook/databases/index',
      summary: 'Must not be overwritten by the database manifest.',
      updatedAt: '2026-05-02T00:00:00.000Z',
      documentDatabaseColumns: [],
      documentDatabaseFieldValues: {},
      blocks: [{
        id: 'reserved-block',
        type: 'paragraph',
        content: 'Reserved document body',
        checked: false,
        depth: 0,
        parentBlockId: null,
        sortOrder: 0
      }]
    }],
    getExportStandaloneDatabases: () => [],
    saveSetting: () => undefined
  }

  try {
    await new MarkdownBackupService(store as never, backupRoot).exportAll()

    const manifestPath = join(backupRoot, '__knowbook', 'databases', 'index.md')
    const escapedRoot = readdirSync(backupRoot).find((entry) => entry.startsWith('__knowbook-document-'))
    assert.ok(escapedRoot)
    const documentPath = join(backupRoot, escapedRoot, 'databases', 'index.md')

    const manifest = parseMarkdownBackupDocument(readFileSync(manifestPath, 'utf8'))
    const document = parseMarkdownBackupDocument(readFileSync(documentPath, 'utf8'))
    assert.equal(manifest.frontmatter.kind, 'standalone-database-manifest')
    assert.equal(document.frontmatter.id, 'reserved-document')
    assert.equal(document.frontmatter.path, '__knowbook/databases/index')
    assert.equal(document.blocks[0]?.content, 'Reserved document body')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownBackupService copies managed assets and writes portable references', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-backup-assets-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const assetRoot = join(tempRoot, 'storage', 'assets')
  const sourceAssetPath = join(assetRoot, 'web-clips', 'ab', 'asset.png')
  mkdirSync(join(assetRoot, 'web-clips', 'ab'), { recursive: true })
  writeFileSync(sourceAssetPath, Buffer.from('portable-image'))
  const sourceAssetUrl = pathToFileURL(sourceAssetPath).toString()
  const store = {
    getExportDocuments: () => [{
      id: 'clip-document',
      title: 'Clip',
      path: 'Home/Clip',
      summary: '',
      updatedAt: '2026-05-02T00:00:00.000Z',
      documentDatabaseColumns: [],
      documentDatabaseFieldValues: {
        cover: sourceAssetUrl
      },
      blocks: [{
        id: 'clip-image',
        type: 'paragraph',
        content: `![Clipped image](${sourceAssetUrl})`,
        checked: false,
        depth: 0,
        parentBlockId: null,
        sortOrder: 0
      }]
    }],
    getExportStandaloneDatabases: () => [],
    saveSetting: () => undefined
  }

  try {
    await new MarkdownBackupService(store as never, backupRoot, assetRoot).exportAll()

    const snapshotAssetPath = join(backupRoot, '__knowbook', 'assets', 'web-clips', 'ab', 'asset.png')
    const documentMarkdown = readFileSync(join(backupRoot, 'Home', 'Clip.md'), 'utf8')
    assert.equal(readFileSync(snapshotAssetPath, 'utf8'), 'portable-image')
    assert.equal(documentMarkdown.includes(sourceAssetUrl), false)
    assert.equal(documentMarkdown.includes('../__knowbook/assets/web-clips/ab/asset.png'), true)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownBackupService keeps dangling managed asset references but still rejects symlink escapes', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-backup-missing-asset-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const assetRoot = join(tempRoot, 'storage', 'assets')
  const missingAssetUrl = pathToFileURL(join(assetRoot, 'web-clips', 'missing.png')).toString()
  const store = {
    getExportDocuments: () => [{
      id: 'missing-asset-document',
      title: 'Missing asset',
      path: 'Missing asset',
      summary: '',
      updatedAt: '2026-05-02T00:00:00.000Z',
      documentDatabaseColumns: [],
      documentDatabaseFieldValues: {},
      blocks: [{
        id: 'missing-image',
        type: 'paragraph',
        content: `![Missing](${missingAssetUrl})`,
        checked: false,
        depth: 0,
        parentBlockId: null,
        sortOrder: 0
      }]
    }],
    getExportStandaloneDatabases: () => [],
    saveSetting: () => undefined
  }

  try {
    await new MarkdownBackupService(store as never, backupRoot, assetRoot).exportAll()
    const exported = readFileSync(join(backupRoot, 'Missing asset.md'), 'utf8')
    assert.equal(
      exported.includes(missingAssetUrl),
      true,
      'a dangling reference must not fail the export; the original URL stays in place'
    )

    // A link that resolves outside the managed asset root is still a hard failure.
    mkdirSync(join(assetRoot, 'web-clips'), { recursive: true })
    const escapeTarget = join(tempRoot, 'outside')
    mkdirSync(escapeTarget, { recursive: true })
    writeFileSync(join(escapeTarget, 'secret.png'), 'escaped', 'utf8')
    const escapedFileThroughLink = join(assetRoot, 'web-clips', 'escape-dir', 'secret.png')
    let linkCreated = true
    try {
      symlinkSync(escapeTarget, join(assetRoot, 'web-clips', 'escape-dir'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      linkCreated = false
    }

    if (linkCreated) {
      const escapedStore = {
        getExportDocuments: () => [{
          id: 'escape-document',
          title: 'Escape',
          path: 'Escape',
          summary: '',
          updatedAt: '2026-05-02T00:00:00.000Z',
          documentDatabaseColumns: [],
          documentDatabaseFieldValues: {},
          blocks: [{
            id: 'escape-image',
            type: 'paragraph',
            content: `![Escape](${pathToFileURL(escapedFileThroughLink).toString()})`,
            checked: false,
            depth: 0,
            parentBlockId: null,
            sortOrder: 0
          }]
        }],
        getExportStandaloneDatabases: () => [],
        saveSetting: () => undefined
      }
      await assert.rejects(
        new MarkdownBackupService(escapedStore as never, join(tempRoot, 'backup2'), assetRoot).exportAll(),
        /resolves outside the asset root/
      )
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownBackupService coalesces overlapping exports and allows a fresh export after completion', async () => {
  let documentReads = 0
  let databaseReads = 0
  let runnerCalls = 0
  let settingWrites = 0
  let releaseFirstExport: (() => void) | undefined
  const firstExportGate = new Promise<void>((resolve) => {
    releaseFirstExport = resolve
  })
  const store = {
    getExportDocuments: () => {
      documentReads += 1
      return []
    },
    getExportStandaloneDatabases: () => {
      databaseReads += 1
      return []
    },
    saveSetting: () => {
      settingWrites += 1
    }
  }
  const service = new MarkdownBackupService(
    store as never,
    'virtual-backup-root',
    undefined,
    async () => {
      runnerCalls += 1
      if (runnerCalls === 1) {
        await firstExportGate
      }
    }
  )

  const first = service.exportAll()
  const overlapping = service.exportAll()
  assert.strictEqual(overlapping, first)
  assert.equal(documentReads, 1)
  assert.equal(databaseReads, 1)
  assert.equal(runnerCalls, 1)

  releaseFirstExport?.()
  await Promise.all([first, overlapping])
  await service.waitForIdle()
  assert.equal(settingWrites, 1)

  await service.exportAll()
  assert.equal(documentReads, 2)
  assert.equal(databaseReads, 2)
  assert.equal(runnerCalls, 2)
  assert.equal(settingWrites, 2)
})

test('MarkdownBackupService skips unchanged scheduled snapshots and allows a forced export', async () => {
  let documentReads = 0
  let runnerCalls = 0
  let revision = 'revision-1'
  const store = {
    getBackupRevision: () => revision,
    getExportDocuments: () => {
      documentReads += 1
      return []
    },
    getExportStandaloneDatabases: () => [],
    saveSetting: () => undefined
  }
  const service = new MarkdownBackupService(
    store as never,
    'virtual-backup-root',
    undefined,
    async () => {
      runnerCalls += 1
    }
  )

  await service.exportAll()
  await service.exportAll()
  assert.equal(documentReads, 1)
  assert.equal(runnerCalls, 1)

  revision = 'revision-2'
  await service.exportAll()
  await service.exportAll(true)
  assert.equal(documentReads, 3)
  assert.equal(runnerCalls, 3)
})

test('MarkdownBackupService delegates database-backed snapshot reads to the export runner', async () => {
  let documentReads = 0
  let databaseReads = 0
  const receivedJobs: unknown[] = []
  const store = {
    getBackupRevision: () => 'revision-1',
    getDatabasePath: () => 'workspace.sqlite',
    getDocumentCount: () => 12,
    getExportDocuments: () => {
      documentReads += 1
      return []
    },
    getExportStandaloneDatabases: () => {
      databaseReads += 1
      return []
    },
    saveSetting: () => undefined
  }
  const service = new MarkdownBackupService(
    store as never,
    'virtual-backup-root',
    undefined,
    async (job) => {
      receivedJobs.push(job)
      return 12
    }
  )

  const result = await service.exportAll()

  assert.equal(result.exported, 12)
  assert.equal(documentReads, 0)
  assert.equal(databaseReads, 0)
  assert.deepEqual(receivedJobs, [{
    databasePath: 'workspace.sqlite',
    backupRoot: 'virtual-backup-root',
    assetRoot: undefined
  }])
})

test('export survives dangling managed asset references by keeping the original URL', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-backup-dangling-asset-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const assetRoot = join(tempRoot, 'assets')

  try {
    mkdirSync(assetRoot, { recursive: true })
    const missingAssetUrl = pathToFileURL(join(assetRoot, 'web-clips', 'gone.png')).toString()
    const store = {
      getExportDocuments: () => [
        {
          id: 'doc-1',
          title: 'Root',
          path: 'Root',
          summary: '',
          updatedAt: '2026-05-02T00:00:00.000Z',
          documentDatabaseColumns: [],
          documentDatabaseFieldValues: {},
          blocks: [
            {
              id: 'b1',
              type: 'paragraph',
              content: `![missing](${missingAssetUrl})`,
              checked: false,
              depth: 0,
              parentBlockId: null,
              sortOrder: 0
            }
          ]
        }
      ],
      getExportStandaloneDatabases: () => [],
      saveSetting: () => undefined
    }

    await new MarkdownBackupService(store as never, backupRoot, assetRoot).exportAll()

    const exported = readFileSync(join(backupRoot, 'Root.md'), 'utf8')
    assert.equal(
      exported.includes(missingAssetUrl),
      true,
      'the unresolvable reference must be left untouched instead of failing the export'
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('export sanitizes long titles into short segments and cleans abandoned staging roots', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-backup-path-hygiene-test-'))
  const backupParent = join(tempRoot, 'backups')
  const backupRoot = join(backupParent, 'markdown')
  const abandonedStaging = join(backupParent, '.knowbook-markdown-abandoned')
  const freshStaging = join(backupParent, '.knowbook-markdown-fresh')
  const longTitle = 'X'.repeat(200) + '-' + 'Y'.repeat(200)

  try {
    mkdirSync(abandonedStaging, { recursive: true })
    mkdirSync(freshStaging, { recursive: true })
    utimesSync(abandonedStaging, new Date(Date.now() - 48 * 3600_000), new Date(Date.now() - 48 * 3600_000))

    const store = {
      getExportDocuments: () => [
        {
          id: 'doc-long',
          title: longTitle,
          path: `Root/${longTitle}`,
          summary: '',
          updatedAt: '2026-05-02T00:00:00.000Z',
          documentDatabaseColumns: [],
          documentDatabaseFieldValues: {},
          blocks: []
        }
      ],
      getExportStandaloneDatabases: () => [],
      saveSetting: () => undefined
    }

    await new MarkdownBackupService(store as never, backupRoot).exportAll()

    const exportedFiles: string[] = []
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          visit(full)
        } else {
          exportedFiles.push(full)
        }
      }
    }
    visit(backupRoot)

    assert.equal(exportedFiles.length > 0, true)
    for (const file of exportedFiles) {
      const relativeSegments = relative(backupRoot, file).split(/[\\/]/)
      for (const segment of relativeSegments) {
        assert.equal(
          segment.length <= 60,
          true,
          `segments must stay short for Windows MAX_PATH safety, got ${segment.length}: ${segment}`
        )
      }
    }

    assert.equal(existsSync(abandonedStaging), false, 'stale staging directories must be swept on the next export')
    assert.equal(existsSync(freshStaging), true, 'recent staging directories must be preserved')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
