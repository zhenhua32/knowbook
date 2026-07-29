import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { parseMarkdownBackupDocument } from '../src/shared/markdown.ts'

test('MarkdownBackupService exports nested markdown files and persists backup timestamp', () => {
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
    const result = service.exportAll()

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

test('MarkdownBackupService replaces stale files and keeps unsafe document paths inside the backup root', () => {
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
    service.exportAll()
    assert.equal(existsSync(join(tempRoot, 'outside.md')), false)

    const staleFile = join(backupRoot, 'stale.md')
    writeFileSync(staleFile, 'stale', 'utf8')
    documents = []
    service.exportAll()
    assert.equal(existsSync(staleFile), false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownBackupService keeps documents in the reserved metadata namespace', () => {
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
    new MarkdownBackupService(store as never, backupRoot).exportAll()

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

test('MarkdownBackupService copies managed assets and writes portable references', () => {
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
    new MarkdownBackupService(store as never, backupRoot, assetRoot).exportAll()

    const snapshotAssetPath = join(backupRoot, '__knowbook', 'assets', 'web-clips', 'ab', 'asset.png')
    const documentMarkdown = readFileSync(join(backupRoot, 'Home', 'Clip.md'), 'utf8')
    assert.equal(readFileSync(snapshotAssetPath, 'utf8'), 'portable-image')
    assert.equal(documentMarkdown.includes(sourceAssetUrl), false)
    assert.equal(documentMarkdown.includes('../__knowbook/assets/web-clips/ab/asset.png'), true)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownBackupService fails instead of publishing an incomplete managed asset snapshot', () => {
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
    assert.throws(
      () => new MarkdownBackupService(store as never, backupRoot, assetRoot).exportAll(),
      /Managed backup asset not found/
    )
    assert.equal(existsSync(backupRoot), false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
