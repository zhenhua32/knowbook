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

    const exportedCount = sourceStore.getExportDocuments().length
    new MarkdownBackupService(sourceStore, backupRoot).exportAll()

    const restoreResult = new MarkdownRestoreService(targetStore).restoreFromDirectory(backupRoot)
    assert.equal(restoreResult.restored, exportedCount)
    assert.equal(restoreResult.created + restoreResult.updated, exportedCount)
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