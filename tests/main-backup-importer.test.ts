import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { KnowbookStore } from '../src/main/database/store.ts'
import type { DocumentCatalogEntry, DocumentDetail } from '../src/shared/contracts.ts'
import { parseMarkdownBackupDocument } from '../src/shared/markdown.ts'

function byPath(entries: DocumentCatalogEntry[], path: string): DocumentCatalogEntry {
  const found = entries.find((entry) => entry.path === path)
  assert.ok(found, `expected catalog entry at path: ${path}`)
  return found
}

function byBlockId(detail: DocumentDetail, blockId: string) {
  const found = detail.blocks.find((block) => block.id === blockId)
  assert.ok(found, `expected block id to exist: ${blockId}`)
  return found
}

test('KnowbookStore creates a consistent pre-restore database safety copy', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-safety-backup-test-'))
  const sourceStore = new KnowbookStore(join(tempRoot, 'source.sqlite'))
  let copiedStore: KnowbookStore | null = null

  try {
    const sourceCount = sourceStore.getAllDocumentSnapshots().length
    const destinationPath = join(tempRoot, 'safety', 'before-restore.sqlite')
    await sourceStore.backupDatabase(destinationPath)

    copiedStore = new KnowbookStore(destinationPath)
    assert.equal(copiedStore.getAllDocumentSnapshots().length, sourceCount)
  } finally {
    copiedStore?.destroy()
    sourceStore.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService restores exported markdown into a fresh store', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const sourceStore = new KnowbookStore(join(tempRoot, 'source.sqlite'))
  const targetStore = new KnowbookStore(join(tempRoot, 'target.sqlite'))

  try {
    const sourceCatalog = sourceStore.getHomeData(backupRoot).documentCatalog
    const product = byPath(sourceCatalog, 'Home/Product')
    const roadmap = byPath(sourceCatalog, 'Home/Product/Roadmap')

    const statusColumn = sourceStore.createDocumentDatabaseColumn({
      name: 'Status',
      type: 'select',
      options: ['Todo', 'Doing', 'Done']
    })
    const tagsColumn = sourceStore.createDocumentDatabaseColumn({
      name: 'Tags',
      type: 'multi-select',
      options: ['AI', 'Infra', 'Docs']
    })
    const ownerColumn = sourceStore.createDocumentDatabaseColumn({
      name: 'Owner',
      type: 'text'
    })
    const doneColumn = sourceStore.createDocumentDatabaseColumn({
      name: 'Done',
      type: 'checkbox'
    })

    sourceStore.updateDocument(roadmap.id, {
      title: 'Roadmap',
      summary: 'Restored roadmap summary',
      blocks: [
        { id: 'roadmap-root', type: 'heading-1', content: 'Roadmap', checked: false, depth: 0 },
        { id: 'roadmap-task', type: 'todo', content: 'Ship restore flow', checked: true, depth: 0, tags: ['restore'], highlight: 'green' }
      ]
    })

    const specsId = sourceStore.createDocument(product.id)
    sourceStore.updateDocument(specsId, {
      title: 'Specs',
      summary: 'Specs summary',
      blocks: [
        { id: 'spec-root', type: 'heading-1', content: 'Specs', checked: false, depth: 0 },
        { id: 'spec-task', type: 'todo', content: 'Preserve block ids', checked: false, depth: 0, tags: ['alpha'], highlight: 'blue' },
        { id: 'spec-child', type: 'bulleted-list', content: 'Nested child', checked: false, depth: 0, parentBlockId: 'spec-task' },
        { id: 'spec-code', type: 'code', content: 'SELECT 1', checked: false, depth: 0, language: 'sql' }
      ]
    })

    const checklistId = sourceStore.createDocument(specsId)
    sourceStore.updateDocument(checklistId, {
      title: 'Checklist',
      summary: 'Checklist summary',
      blocks: [
        { id: 'check-root', type: 'heading-1', content: 'Checklist', checked: false, depth: 0 },
        { id: 'check-ref', type: 'paragraph', content: 'Reference [[Home/Product/Specs#spec-task]]', checked: false, depth: 0 }
      ]
    })

    sourceStore.updateDocumentDatabaseValue({
      documentId: roadmap.id,
      columnId: statusColumn.id,
      value: 'Doing'
    })
    sourceStore.updateDocumentDatabaseValue({
      documentId: roadmap.id,
      columnId: tagsColumn.id,
      value: ['AI', 'Infra']
    })
    sourceStore.updateDocumentDatabaseValue({
      documentId: roadmap.id,
      columnId: doneColumn.id,
      value: true
    })
    sourceStore.updateDocumentDatabaseValue({
      documentId: specsId,
      columnId: ownerColumn.id,
      value: 'Alice'
    })
    sourceStore.updateDocumentDatabaseValue({
      documentId: specsId,
      columnId: statusColumn.id,
      value: 'Todo'
    })

    const projectsDatabase = sourceStore.createDatabase({
      name: 'Projects',
      description: 'Standalone project tracker'
    })
    const stageColumn = sourceStore.createDocumentDatabaseColumn({
      databaseId: projectsDatabase.id,
      name: 'Stage',
      type: 'select',
      options: ['Idea', 'Doing', 'Done']
    })
    const priorityColumn = sourceStore.createDocumentDatabaseColumn({
      databaseId: projectsDatabase.id,
      name: 'Priority',
      type: 'multi-select',
      options: ['P0', 'P1', 'P2']
    })
    sourceStore.createDatabaseSavedView({
      databaseId: projectsDatabase.id,
      name: 'Open Work',
      filterQuery: 'Doing',
      filterScope: '',
      sortMode: 'updated-desc',
      viewMode: 'table'
    })
    sourceStore.createDatabaseEntity({
      databaseId: projectsDatabase.id,
      documentId: specsId,
      fieldValues: {
        [stageColumn.id]: 'Doing',
        [priorityColumn.id]: ['P0', 'P1']
      }
    })
    sourceStore.createDatabaseEntity({
      databaseId: projectsDatabase.id,
      fieldValues: {
        [stageColumn.id]: 'Idea'
      }
    })

    const exportedCount = sourceStore.getExportDocuments().length
    await new MarkdownBackupService(sourceStore, backupRoot).exportAll()

    const restoreService = new MarkdownRestoreService(targetStore)
    const snapshotsBeforePreview = targetStore.getAllDocumentSnapshots()
    const restorePreview = await restoreService.previewFromDirectory(backupRoot)
    assert.equal(restorePreview.restored, exportedCount)
    assert.equal(restorePreview.created + restorePreview.updated, exportedCount)
    assert.equal(restorePreview.deleted, 0)
    assert.equal(restorePreview.standaloneDatabases, sourceStore.getExportStandaloneDatabases().length)
    assert.equal(restorePreview.standaloneDatabasesCreated, sourceStore.getExportStandaloneDatabases().length)
    assert.deepEqual(targetStore.getAllDocumentSnapshots(), snapshotsBeforePreview)

    const restoreResult = await restoreService.restoreFromDirectory(backupRoot)
    assert.equal(restoreResult.restored, exportedCount)
    assert.equal(restoreResult.created + restoreResult.updated, exportedCount)
    assert.equal(restoreResult.deleted, 0)
    assert.equal(restoreResult.conflictsResolved, 0)
    assert.equal(restoreResult.placeholdersCreated, 0)
    assert.equal(restoreResult.created >= 2, true)

    const targetCatalog = targetStore.getHomeData(backupRoot).documentCatalog
    const restoredRoadmap = byPath(targetCatalog, 'Home/Product/Roadmap')
    const restoredSpecs = byPath(targetCatalog, 'Home/Product/Specs')
    const restoredChecklist = byPath(targetCatalog, 'Home/Product/Specs/Checklist')

    const roadmapDetail = targetStore.getDocumentDetail(restoredRoadmap.id)
    const specsDetail = targetStore.getDocumentDetail(restoredSpecs.id)
    const checklistDetail = targetStore.getDocumentDetail(restoredChecklist.id)

    assert.ok(roadmapDetail)
    assert.ok(specsDetail)
    assert.ok(checklistDetail)

    const targetHome = targetStore.getHomeData(backupRoot)
    const restoredStatusColumn = targetHome.databaseColumns.find((column) => column.name === 'Status')
    const restoredTagsColumn = targetHome.databaseColumns.find((column) => column.name === 'Tags')
    const restoredOwnerColumn = targetHome.databaseColumns.find((column) => column.name === 'Owner')
    const restoredDoneColumn = targetHome.databaseColumns.find((column) => column.name === 'Done')

    assert.ok(restoredStatusColumn)
    assert.ok(restoredTagsColumn)
    assert.ok(restoredOwnerColumn)
    assert.ok(restoredDoneColumn)
    assert.deepEqual(restoredStatusColumn.options, ['Todo', 'Doing', 'Done'])
    assert.deepEqual(restoredTagsColumn.options, ['AI', 'Infra', 'Docs'])

    const roadmapCatalog = byPath(targetHome.documentCatalog, 'Home/Product/Roadmap')
    const specsCatalog = byPath(targetHome.documentCatalog, 'Home/Product/Specs')
    assert.equal(roadmapCatalog.fieldValues[restoredStatusColumn.id], 'Doing')
    assert.deepEqual(roadmapCatalog.fieldValues[restoredTagsColumn.id], ['AI', 'Infra'])
    assert.equal(roadmapCatalog.fieldValues[restoredDoneColumn.id], true)
    assert.equal(specsCatalog.fieldValues[restoredOwnerColumn.id], 'Alice')
    assert.equal(specsCatalog.fieldValues[restoredStatusColumn.id], 'Todo')

    assert.equal(roadmapDetail.summary, 'Restored roadmap summary')
    assert.deepEqual(byBlockId(roadmapDetail, 'roadmap-task').tags, ['restore'])
    assert.equal(byBlockId(roadmapDetail, 'roadmap-task').highlight, 'green')

    assert.equal(specsDetail.summary, 'Specs summary')
    assert.equal(byBlockId(specsDetail, 'spec-task').highlight, 'blue')
    assert.deepEqual(byBlockId(specsDetail, 'spec-task').tags, ['alpha'])
    assert.equal(byBlockId(specsDetail, 'spec-child').parentBlockId, 'spec-task')
    assert.equal(byBlockId(specsDetail, 'spec-child').depth, 1)
    assert.equal(byBlockId(specsDetail, 'spec-code').language, 'sql')
    assert.ok(targetStore.getBlockReference('Home/Product/Specs', 'spec-task'))

    assert.equal(checklistDetail.summary, 'Checklist summary')
    assert.equal(checklistDetail.blocks.some((block) => block.id === 'check-ref'), true)

    const restoredProjectsDatabase = targetStore.getDatabases().find((database) => database.name === 'Projects')
    assert.ok(restoredProjectsDatabase)
    assert.equal(restoredProjectsDatabase.description, 'Standalone project tracker')

    const restoredProjectsColumns = targetStore.getDocumentDatabaseColumns(restoredProjectsDatabase.id)
    const restoredStageColumn = restoredProjectsColumns.find((column) => column.name === 'Stage')
    const restoredPriorityColumn = restoredProjectsColumns.find((column) => column.name === 'Priority')
    assert.ok(restoredStageColumn)
    assert.ok(restoredPriorityColumn)
    assert.deepEqual(restoredStageColumn.options, ['Idea', 'Doing', 'Done'])
    assert.deepEqual(restoredPriorityColumn.options, ['P0', 'P1', 'P2'])

    const restoredProjectsViews = targetStore.getDatabaseSavedViews(restoredProjectsDatabase.id)
    assert.equal(restoredProjectsViews.length, 1)
    assert.equal(restoredProjectsViews[0]?.name, 'Open Work')
    assert.equal(restoredProjectsViews[0]?.filterQuery, 'Doing')
    assert.equal(restoredProjectsViews[0]?.viewMode, 'table')

    const restoredProjectsEntities = targetStore.getDatabaseEntities(restoredProjectsDatabase.id)
    assert.equal(restoredProjectsEntities.length, 2)

    const linkedProjectEntity = restoredProjectsEntities.find((entity) => entity.documentId === restoredSpecs.id)
    const unlinkedProjectEntity = restoredProjectsEntities.find((entity) => entity.documentId === null)
    assert.ok(linkedProjectEntity)
    assert.ok(unlinkedProjectEntity)
    assert.equal(linkedProjectEntity.fieldValues[restoredStageColumn.id], 'Doing')
    assert.deepEqual(linkedProjectEntity.fieldValues[restoredPriorityColumn.id], ['P0', 'P1'])
    assert.equal(unlinkedProjectEntity.fieldValues[restoredStageColumn.id], 'Idea')
  } finally {
    sourceStore.destroy()
    targetStore.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService resolves path conflicts and deletes stale documents inside the restore scope', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-conflict-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    const initialCatalog = store.getHomeData(backupRoot).documentCatalog
    const product = byPath(initialCatalog, 'Home/Product')
    const specsId = store.createDocument(product.id)
    const notesId = store.createDocument(product.id)

    store.updateDocument(specsId, {
      title: 'Specs',
      summary: 'Specs backup summary',
      blocks: [
        { id: 'spec-root', type: 'heading-1', content: 'Specs', checked: false, depth: 0 },
        { id: 'spec-task', type: 'todo', content: 'Canonical backup node', checked: false, depth: 0 }
      ]
    })

    store.updateDocument(notesId, {
      title: 'Notes',
      summary: 'Notes backup summary',
      blocks: [
        { id: 'notes-root', type: 'heading-1', content: 'Notes', checked: false, depth: 0 },
        { id: 'notes-body', type: 'paragraph', content: 'Original notes content', checked: false, depth: 0 }
      ]
    })

    await new MarkdownBackupService(store, backupRoot).exportAll()

    const staleId = store.createDocument(product.id)
    store.updateDocument(staleId, {
      title: 'Obsolete',
      summary: 'Should be deleted by restore sync',
      blocks: [{ id: 'obsolete-root', type: 'heading-1', content: 'Obsolete', checked: false, depth: 0 }]
    })

    store.updateDocument(specsId, {
      title: 'Specs Archive',
      summary: 'Locally moved away',
      blocks: [
        { id: 'spec-root', type: 'heading-1', content: 'Specs Archive', checked: false, depth: 0 },
        { id: 'spec-task', type: 'todo', content: 'Locally moved away', checked: false, depth: 0 }
      ]
    })

    store.updateDocument(notesId, {
      title: 'Specs',
      summary: 'Temporarily occupying the canonical path',
      blocks: [
        { id: 'notes-root', type: 'heading-1', content: 'Specs', checked: false, depth: 0 },
        { id: 'notes-body', type: 'paragraph', content: 'Occupying canonical path', checked: false, depth: 0 }
      ]
    })

    const restoreResult = await new MarkdownRestoreService(store).restoreFromDirectory(backupRoot)

    assert.equal(restoreResult.deleted, 1)
    assert.equal(restoreResult.conflictsResolved, 1)

    const refreshedCatalog = store.getHomeData(backupRoot).documentCatalog
    const restoredSpecs = refreshedCatalog.find((entry) => entry.id === specsId)
    const restoredNotes = refreshedCatalog.find((entry) => entry.id === notesId)
    const staleDocument = refreshedCatalog.find((entry) => entry.id === staleId)

    assert.ok(restoredSpecs)
    assert.ok(restoredNotes)
    assert.equal(restoredSpecs.path, 'Home/Product/Specs')
    assert.equal(restoredNotes.path, 'Home/Product/Notes')
    assert.equal(staleDocument, undefined)

    const specsDetail = store.getDocumentDetail(specsId)
    const notesDetail = store.getDocumentDetail(notesId)
    assert.ok(specsDetail)
    assert.ok(notesDetail)
    assert.equal(specsDetail.summary, 'Specs backup summary')
    assert.equal(notesDetail.summary, 'Notes backup summary')
    assert.equal(byBlockId(specsDetail, 'spec-task').content, 'Canonical backup node')
    assert.equal(byBlockId(notesDetail, 'notes-body').content, 'Original notes content')
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService imports ordinary markdown without deleting existing documents', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-ordinary-markdown-test-'))
  const importRoot = join(tempRoot, 'markdown')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    const originalDocumentIds = new Set(
      store.getHomeData(importRoot).documentCatalog.map((document) => document.id)
    )
    writeFileSync(join(tempRoot, 'README.md'), '# Imported README\n\nImported without backup metadata.\n', 'utf8')

    const result = await new MarkdownRestoreService(store).restoreFromDirectory(tempRoot)
    const refreshedCatalog = store.getHomeData(importRoot).documentCatalog

    assert.equal(result.restored, 1)
    assert.equal(result.deleted, 0)
    assert.equal(refreshedCatalog.some((document) => document.path === 'README'), true)
    for (const documentId of originalDocumentIds) {
      assert.equal(refreshedCatalog.some((document) => document.id === documentId), true)
    }
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService deletes stale standalone databases when backup manifest is present', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-standalone-db-sync-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    const sourceDatabase = store.createDatabase({
      name: 'Projects',
      description: 'Canonical backup database'
    })
    const sourceStageColumn = store.createDocumentDatabaseColumn({
      databaseId: sourceDatabase.id,
      name: 'Stage',
      type: 'select',
      options: ['Idea', 'Doing', 'Done']
    })
    store.createDatabaseSavedView({
      databaseId: sourceDatabase.id,
      name: 'Open projects',
      filterQuery: 'Doing',
      filterScope: '',
      sortMode: 'updated-desc',
      viewMode: 'cards'
    })
    store.createDatabaseEntity({
      databaseId: sourceDatabase.id,
      fieldValues: {
        [sourceStageColumn.id]: 'Idea'
      }
    })

    await new MarkdownBackupService(store, backupRoot).exportAll()

    const staleDatabase = store.createDatabase({
      name: 'Archive',
      description: 'Should be deleted during restore sync'
    })
    const staleOwnerColumn = store.createDocumentDatabaseColumn({
      databaseId: staleDatabase.id,
      name: 'Owner',
      type: 'text'
    })
    store.createDatabaseSavedView({
      databaseId: staleDatabase.id,
      name: 'Archive view'
    })
    store.createDatabaseEntity({
      databaseId: staleDatabase.id,
      fieldValues: {
        [staleOwnerColumn.id]: 'Alice'
      }
    })

    await new MarkdownRestoreService(store).restoreFromDirectory(backupRoot)

    const refreshedDatabases = store.getDatabases()
    assert.equal(refreshedDatabases.some((database) => database.id === sourceDatabase.id), true)
    assert.equal(refreshedDatabases.some((database) => database.id === staleDatabase.id), false)
    assert.equal(store.getDatabaseSavedViews(sourceDatabase.id).length, 1)
    assert.equal(store.getDatabaseEntities(sourceDatabase.id).length, 1)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService keeps standalone databases when restoring a legacy backup without manifest', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-legacy-backup-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const sourceStore = new KnowbookStore(join(tempRoot, 'source.sqlite'))
  const targetStore = new KnowbookStore(join(tempRoot, 'target.sqlite'))

  try {
    await new MarkdownBackupService(sourceStore, backupRoot).exportAll()
    rmSync(join(backupRoot, '__knowbook'), { recursive: true, force: true })

    const staleDatabase = targetStore.createDatabase({
      name: 'Archive',
      description: 'Legacy backups should not wipe this database'
    })

    await new MarkdownRestoreService(targetStore).restoreFromDirectory(backupRoot)

    assert.equal(targetStore.getDatabases().some((database) => database.id === staleDatabase.id), true)
  } finally {
    sourceStore.destroy()
    targetStore.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService rolls back all changes when a restore step fails', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-transaction-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const sourceStore = new KnowbookStore(join(tempRoot, 'source.sqlite'))
  const targetStore = new KnowbookStore(join(tempRoot, 'target.sqlite'))

  try {
    await new MarkdownBackupService(sourceStore, backupRoot).exportAll()
    const before = targetStore.getHomeData(backupRoot).documentCatalog
    const originalUpdateDocument = targetStore.updateDocument.bind(targetStore)
    let updateCount = 0
    targetStore.updateDocument = ((...args: Parameters<KnowbookStore['updateDocument']>) => {
      const result = originalUpdateDocument(...args)
      updateCount += 1
      if (updateCount === 2) {
        throw new Error('Injected restore failure')
      }
      return result
    }) as KnowbookStore['updateDocument']

    await assert.rejects(
      new MarkdownRestoreService(targetStore).restoreFromDirectory(backupRoot),
      /Injected restore failure/
    )
    assert.equal(updateCount, 2)
    assert.deepEqual(targetStore.getHomeData(backupRoot).documentCatalog, before)
  } finally {
    sourceStore.destroy()
    targetStore.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService restores portable assets into the active managed asset root', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-assets-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const sourceAssetRoot = join(tempRoot, 'source-assets')
  const targetAssetRoot = join(tempRoot, 'target-assets')
  const sourceAssetPath = join(sourceAssetRoot, 'web-clips', 'ab', 'asset.png')
  const targetAssetPath = join(targetAssetRoot, 'web-clips', 'ab', 'asset.png')
  const sourceStore = new KnowbookStore(join(tempRoot, 'source.sqlite'))
  const targetStore = new KnowbookStore(join(tempRoot, 'target.sqlite'))

  try {
    mkdirSync(join(sourceAssetRoot, 'web-clips', 'ab'), { recursive: true })
    writeFileSync(sourceAssetPath, Buffer.from('restored-image'))
    const sourceAssetUrl = pathToFileURL(sourceAssetPath).toString()
    const roadmap = byPath(sourceStore.getHomeData(backupRoot).documentCatalog, 'Home/Product/Roadmap')
    sourceStore.updateDocument(roadmap.id, {
      title: 'Roadmap',
      summary: 'Contains a portable asset',
      blocks: [{
        id: 'asset-image',
        type: 'paragraph',
        content: `![Clipped image](${sourceAssetUrl})`,
        checked: false,
        depth: 0
      }]
    })
    const assetDatabase = sourceStore.createDatabase({
      name: 'Asset references',
      description: 'Portable standalone asset fields'
    })
    const assetColumn = sourceStore.createDocumentDatabaseColumn({
      databaseId: assetDatabase.id,
      name: 'Asset',
      type: 'text'
    })
    sourceStore.createDatabaseEntity({
      databaseId: assetDatabase.id,
      fieldValues: {
        [assetColumn.id]: sourceAssetUrl
      }
    })

    await new MarkdownBackupService(sourceStore, backupRoot, sourceAssetRoot).exportAll()
    rmSync(sourceAssetRoot, { recursive: true, force: true })

    const restoreService = new MarkdownRestoreService(targetStore, targetAssetRoot)
    await restoreService.previewFromDirectory(backupRoot)
    assert.equal(existsSync(targetAssetPath), false)

    await restoreService.restoreFromDirectory(backupRoot)
    const restoredRoadmap = byPath(targetStore.getHomeData(backupRoot).documentCatalog, 'Home/Product/Roadmap')
    const restoredDetail = targetStore.getDocumentDetail(restoredRoadmap.id)
    assert.ok(restoredDetail)
    assert.equal(existsSync(targetAssetPath), true)
    assert.equal(readFileSync(targetAssetPath, 'utf8'), 'restored-image')
    assert.equal(
      restoredDetail.blocks.some((block) => block.content.includes(pathToFileURL(targetAssetPath).toString())),
      true
    )
    assert.equal(restoredDetail.blocks.some((block) => block.content.includes(sourceAssetUrl)), false)
    const restoredAssetDatabase = targetStore.getDatabases().find((database) => database.name === 'Asset references')
    assert.ok(restoredAssetDatabase)
    const restoredAssetColumn = targetStore.getDocumentDatabaseColumns(restoredAssetDatabase.id)
      .find((column) => column.name === 'Asset')
    assert.ok(restoredAssetColumn)
    assert.equal(
      targetStore.getDatabaseEntities(restoredAssetDatabase.id)[0]?.fieldValues[restoredAssetColumn.id],
      pathToFileURL(targetAssetPath).toString()
    )
  } finally {
    sourceStore.destroy()
    targetStore.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService restores overwritten assets when the database transaction fails', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-asset-rollback-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const backupAssetPath = join(backupRoot, '__knowbook', 'assets', 'web-clips', 'ab', 'asset.png')
  const backupNewAssetPath = join(backupRoot, '__knowbook', 'assets', 'web-clips', 'ab', 'new.png')
  const targetAssetRoot = join(tempRoot, 'target-assets')
  const targetAssetPath = join(targetAssetRoot, 'web-clips', 'ab', 'asset.png')
  const targetNewAssetPath = join(targetAssetRoot, 'web-clips', 'ab', 'new.png')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    mkdirSync(join(backupRoot, '__knowbook', 'assets', 'web-clips', 'ab'), { recursive: true })
    mkdirSync(join(targetAssetRoot, 'web-clips', 'ab'), { recursive: true })
    writeFileSync(backupAssetPath, 'replacement-image', 'utf8')
    writeFileSync(backupNewAssetPath, 'new-image', 'utf8')
    writeFileSync(targetAssetPath, 'original-image', 'utf8')
    writeFileSync(
      join(backupRoot, 'Asset.md'),
      [
        '# Asset',
        '',
        '![Asset](./__knowbook/assets/web-clips/ab/asset.png)',
        '![New](./__knowbook/assets/web-clips/ab/new.png)',
        ''
      ].join('\n'),
      'utf8'
    )
    const initialSnapshots = store.getAllDocumentSnapshots()
    const originalUpdateDocument = store.updateDocument.bind(store)
    store.updateDocument = ((...args: Parameters<KnowbookStore['updateDocument']>) => {
      originalUpdateDocument(...args)
      throw new Error('Injected database failure after asset publication')
    }) as KnowbookStore['updateDocument']

    await assert.rejects(
      new MarkdownRestoreService(store, targetAssetRoot).restoreFromDirectory(backupRoot),
      /Injected database failure after asset publication/
    )

    assert.equal(readFileSync(targetAssetPath, 'utf8'), 'original-image')
    assert.equal(existsSync(targetNewAssetPath), false)
    assert.deepEqual(store.getAllDocumentSnapshots(), initialSnapshots)
    assert.equal(
      readdirSync(tempRoot).some((entry) => entry.startsWith('.target-assets-restore-')),
      false
    )
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService rolls back partially published assets before database mutation', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-asset-publish-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const backupAssetRoot = join(backupRoot, '__knowbook', 'assets', 'web-clips', 'ab')
  const targetAssetRoot = join(tempRoot, 'target-assets')
  const targetAssetDirectory = join(targetAssetRoot, 'web-clips', 'ab')
  const firstTargetAssetPath = join(targetAssetDirectory, 'first.png')
  const blockedTargetAssetPath = join(targetAssetDirectory, 'blocked.png')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    mkdirSync(backupAssetRoot, { recursive: true })
    mkdirSync(blockedTargetAssetPath, { recursive: true })
    writeFileSync(join(backupAssetRoot, 'first.png'), 'replacement-first', 'utf8')
    writeFileSync(join(backupAssetRoot, 'blocked.png'), 'replacement-blocked', 'utf8')
    writeFileSync(firstTargetAssetPath, 'original-first', 'utf8')
    writeFileSync(join(blockedTargetAssetPath, 'keep.txt'), 'keep-directory', 'utf8')
    writeFileSync(
      join(backupRoot, 'Assets.md'),
      [
        '# Assets',
        '',
        '![First](./__knowbook/assets/web-clips/ab/first.png)',
        '![Blocked](./__knowbook/assets/web-clips/ab/blocked.png)',
        ''
      ].join('\n'),
      'utf8'
    )
    const initialSnapshots = store.getAllDocumentSnapshots()

    await assert.rejects(
      new MarkdownRestoreService(store, targetAssetRoot).restoreFromDirectory(backupRoot),
      /Managed asset destination must be a regular file/
    )

    assert.equal(readFileSync(firstTargetAssetPath, 'utf8'), 'original-first')
    assert.equal(readFileSync(join(blockedTargetAssetPath, 'keep.txt'), 'utf8'), 'keep-directory')
    assert.deepEqual(store.getAllDocumentSnapshots(), initialSnapshots)
    assert.equal(
      readdirSync(tempRoot).some((entry) => entry.startsWith('.target-assets-restore-')),
      false
    )
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService rejects oversized and excessively deep restore inputs', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-limits-test-'))
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    const oversizedRoot = join(tempRoot, 'oversized')
    mkdirSync(oversizedRoot, { recursive: true })
    writeFileSync(join(oversizedRoot, 'large.md'), '# Large\n' + 'x'.repeat(64), 'utf8')
    await assert.rejects(
      new MarkdownRestoreService(store, undefined, {
        maxMarkdownFileBytes: 32
      }).previewFromDirectory(oversizedRoot),
      /Markdown file exceeds/
    )

    const deepRoot = join(tempRoot, 'deep')
    mkdirSync(join(deepRoot, 'nested'), { recursive: true })
    writeFileSync(join(deepRoot, 'nested', 'note.md'), '# Nested\n', 'utf8')
    await assert.rejects(
      new MarkdownRestoreService(store, undefined, {
        maxDepth: 0
      }).previewFromDirectory(deepRoot),
      /maximum depth/
    )
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService validates referenced asset limits during preview without copying files', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-asset-limits-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const backupAssetRoot = join(backupRoot, '__knowbook', 'assets')
  const targetAssetRoot = join(tempRoot, 'target-assets')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    mkdirSync(backupAssetRoot, { recursive: true })
    writeFileSync(join(backupAssetRoot, 'large.bin'), Buffer.alloc(32, 1))
    writeFileSync(
      join(backupRoot, 'note.md'),
      '# Asset\n\n![Asset](./__knowbook/assets/large.bin)\n',
      'utf8'
    )

    await assert.rejects(
      new MarkdownRestoreService(store, targetAssetRoot, {
        maxAssetFileBytes: 16
      }).previewFromDirectory(backupRoot),
      /Backup asset exceeds/
    )
    assert.equal(existsSync(targetAssetRoot), false)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService sends all Markdown sources through one parser batch', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-parser-batch-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))
  const batchSizes: number[] = []

  try {
    mkdirSync(backupRoot, { recursive: true })
    writeFileSync(join(backupRoot, 'Alpha.md'), '# Alpha\n\nFirst note.\n', 'utf8')
    writeFileSync(join(backupRoot, 'Beta.md'), '# Beta\n\nSecond note.\n', 'utf8')

    const restoreService = new MarkdownRestoreService(
      store,
      undefined,
      {},
      async (markdownSources) => {
        batchSizes.push(markdownSources.length)
        return markdownSources.map((markdown) => parseMarkdownBackupDocument(markdown))
      }
    )

    const preview = await restoreService.previewFromDirectory(backupRoot)
    assert.equal(preview.restored, 2)
    assert.deepEqual(batchSizes, [2])
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService reads document snapshots once while building a preview', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-preview-snapshot-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))
  const originalGetAllDocumentSnapshots = store.getAllDocumentSnapshots.bind(store)
  let snapshotReads = 0

  try {
    mkdirSync(backupRoot, { recursive: true })
    writeFileSync(join(backupRoot, 'Preview.md'), '# Preview\n\nRead once.\n', 'utf8')
    store.getAllDocumentSnapshots = () => {
      snapshotReads += 1
      return originalGetAllDocumentSnapshots()
    }

    const preview = await new MarkdownRestoreService(store).previewFromDirectory(backupRoot)

    assert.equal(preview.restored, 1)
    assert.equal(snapshotReads, 1)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService rejects incomplete parser batches without mutating documents', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-parser-result-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    const initialSnapshots = store.getAllDocumentSnapshots()
    mkdirSync(backupRoot, { recursive: true })
    writeFileSync(join(backupRoot, 'Incomplete.md'), '# Incomplete\n\nDo not restore.\n', 'utf8')
    const restoreService = new MarkdownRestoreService(
      store,
      undefined,
      {},
      async () => []
    )

    await assert.rejects(
      restoreService.restoreFromDirectory(backupRoot),
      /parser returned an incomplete result/
    )
    assert.deepEqual(store.getAllDocumentSnapshots(), initialSnapshots)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService rejects concurrent restores and unlocks after completion', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-concurrency-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))
  let parserCalls = 0
  let notifyParserStarted!: () => void
  let releaseFirstParser!: () => void
  const parserStarted = new Promise<void>((resolve) => {
    notifyParserStarted = resolve
  })
  const firstParserGate = new Promise<void>((resolve) => {
    releaseFirstParser = resolve
  })

  try {
    mkdirSync(backupRoot, { recursive: true })
    writeFileSync(join(backupRoot, 'Concurrent.md'), '# Concurrent\n\nRestore once.\n', 'utf8')

    const restoreService = new MarkdownRestoreService(
      store,
      undefined,
      {},
      async (markdownSources) => {
        parserCalls += 1
        if (parserCalls === 1) {
          notifyParserStarted()
          await firstParserGate
        }
        return markdownSources.map((markdown) => parseMarkdownBackupDocument(markdown))
      }
    )

    const firstRestore = restoreService.restoreFromDirectory(backupRoot)
    await parserStarted
    await assert.rejects(
      restoreService.restoreFromDirectory(backupRoot),
      /restore operation is already in progress/
    )

    releaseFirstParser()
    await firstRestore
    await restoreService.restoreFromDirectory(backupRoot)
    assert.equal(parserCalls, 2)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService aborts instead of wiping local views when a backup database entry is corrupt', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-corrupt-db-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    const sourceDatabase = store.createDatabase({ name: 'Projects', description: 'Canonical' })
    const stageColumn = store.createDocumentDatabaseColumn({
      databaseId: sourceDatabase.id,
      name: 'Stage',
      type: 'select',
      options: ['Idea', 'Doing']
    })
    const savedView = store.createDatabaseSavedView({
      databaseId: sourceDatabase.id,
      name: 'Open projects',
      filterQuery: 'Doing',
      filterScope: '',
      sortMode: 'updated-desc',
      viewMode: 'cards'
    })
    const entity = store.createDatabaseEntity({
      databaseId: sourceDatabase.id,
      fieldValues: { [stageColumn.id]: 'Idea' }
    })

    await new MarkdownBackupService(store, backupRoot).exportAll()

    const standaloneDatabaseFile = join(backupRoot, '__knowbook', 'databases', `${sourceDatabase.id}.md`)
    const corruptContent = readFileSync(standaloneDatabaseFile, 'utf8').replace(
      /^databaseSavedViews: .*$/m,
      'databaseSavedViews: [{broken json'
    )
    writeFileSync(standaloneDatabaseFile, corruptContent, 'utf8')

    await assert.rejects(
      new MarkdownRestoreService(store).restoreFromDirectory(backupRoot),
      /corrupted.*databaseSavedViews/s
    )

    assert.equal(store.getDatabaseSavedViews(sourceDatabase.id).length, 1)
    assert.equal(store.getDatabaseSavedViews(sourceDatabase.id)[0]?.id, savedView.id)
    assert.equal(store.getDatabaseEntities(sourceDatabase.id).length, 1)
    assert.equal(store.getDatabaseEntities(sourceDatabase.id)[0]?.id, entity.id)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService aborts instead of deleting databases when the backup manifest is corrupt', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-corrupt-manifest-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 'workspace.sqlite'))

  try {
    store.createDatabase({ name: 'Projects', description: 'Canonical' })
    await new MarkdownBackupService(store, backupRoot).exportAll()

    const staleDatabase = store.createDatabase({ name: 'Archive', description: 'Must survive a failed restore' })

    const manifestFile = join(backupRoot, '__knowbook', 'databases', 'index.md')
    const corruptManifest = readFileSync(manifestFile, 'utf8').replace(
      /^databaseIds: .*$/m,
      'databaseIds: [not-valid-json'
    )
    writeFileSync(manifestFile, corruptManifest, 'utf8')

    await assert.rejects(
      new MarkdownRestoreService(store).restoreFromDirectory(backupRoot),
      /corrupted.*databaseIds/s
    )

    assert.equal(store.getDatabases().some((database) => database.id === staleDatabase.id), true)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
