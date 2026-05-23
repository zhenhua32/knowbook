import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { KnowbookStore } from '../src/main/database/store.ts'
import type { DocumentCatalogEntry, DocumentDetail } from '../src/shared/contracts.ts'

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

test('MarkdownRestoreService restores exported markdown into a fresh store', () => {
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

    const exportedCount = sourceStore.getExportDocuments().length
    new MarkdownBackupService(sourceStore, backupRoot).exportAll()

    const restoreResult = new MarkdownRestoreService(targetStore).restoreFromDirectory(backupRoot)
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
  } finally {
    sourceStore.destroy()
    targetStore.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('MarkdownRestoreService resolves path conflicts and deletes stale documents inside the restore scope', () => {
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

    new MarkdownBackupService(store, backupRoot).exportAll()

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

    const restoreResult = new MarkdownRestoreService(store).restoreFromDirectory(backupRoot)

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