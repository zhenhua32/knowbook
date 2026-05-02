import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import type { DocumentCatalogEntry, DocumentDetail, UpdateDocumentInput } from '../src/shared/contracts.ts'

function withStore(run: (store: KnowbookStore, backupRoot: string) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-store-test-'))
  const databasePath = join(tempRoot, 'knowbook.sqlite')
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(databasePath)

  try {
    run(store, backupRoot)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function byPath(entries: DocumentCatalogEntry[], path: string): DocumentCatalogEntry {
  const found = entries.find((entry) => entry.path === path)
  assert.ok(found, `expected catalog entry at path: ${path}`)
  return found
}

function byDocumentId(detail: DocumentDetail, blockId: string) {
  const found = detail.blocks.find((block) => block.id === blockId)
  assert.ok(found, `expected block id to exist: ${blockId}`)
  return found
}

test('KnowbookStore seeds baseline data and creates sibling documents with unique titles', () => {
  withStore((store, backupRoot) => {
    const initialCatalog = store.getHomeData(backupRoot).documentCatalog
    const product = byPath(initialCatalog, 'Home/Product')

    const firstId = store.createDocument(product.id)
    const secondId = store.createDocument(product.id)

    const catalog = store.getHomeData(backupRoot).documentCatalog
    const first = catalog.find((entry) => entry.id === firstId)
    const second = catalog.find((entry) => entry.id === secondId)

    assert.equal(first?.path, 'Home/Product/Untitled')
    assert.equal(second?.path, 'Home/Product/Untitled 1')
  })
})

test('updateDocument rewrites descendant paths and normalizes parentBlockId relationships', () => {
  withStore((store, backupRoot) => {
    const initialCatalog = store.getHomeData(backupRoot).documentCatalog
    const product = byPath(initialCatalog, 'Home/Product')

    const parentId = store.createDocument(product.id)
    const childId = store.createDocument(parentId)

    const input: UpdateDocumentInput = {
      title: 'Specs',
      summary: 'Implementation details',
      blocks: [
        { id: 'root-block', type: 'heading-1', content: 'Specs', checked: false, depth: 0 },
        {
          id: 'child-block',
          type: 'bulleted-list',
          content: 'Milestone',
          checked: false,
          depth: 0,
          parentBlockId: 'root-block',
          tags: ['phase-1', 'phase-1', '']
        }
      ]
    }

    const affected = store.updateDocument(parentId, input)
    assert.equal(new Set(affected).has(parentId), true)
    assert.equal(new Set(affected).has(childId), true)

    const parentSnapshot = store.getDocumentSnapshot(parentId)
    const childSnapshot = store.getDocumentSnapshot(childId)
    assert.equal(parentSnapshot?.path, 'Home/Product/Specs')
    assert.equal(childSnapshot?.path, 'Home/Product/Specs/Untitled')

    const parentDetail = store.getDocumentDetail(parentId)
    assert.ok(parentDetail)
    const childBlock = byDocumentId(parentDetail, 'child-block')
    assert.equal(childBlock.depth, 1)
    assert.equal(childBlock.parentBlockId, 'root-block')
    assert.deepEqual(childBlock.tags, ['phase-1'])
  })
})

test('moveDocument blocks invalid subtree moves and supports moving to root', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const product = byPath(catalog, 'Home/Product')
    const roadmap = byPath(catalog, 'Home/Product/Roadmap')

    assert.throws(() => store.moveDocument(product.id, roadmap.id), /own subtree/)

    const affected = store.moveDocument(roadmap.id, null)
    assert.equal(affected.includes(roadmap.id), true)

    const roadmapSnapshot = store.getDocumentSnapshot(roadmap.id)
    assert.equal(roadmapSnapshot?.path, 'Roadmap')
    assert.equal(roadmapSnapshot?.parentId, null)
  })
})

test('document database values are validated and pruned when options change', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const home = byPath(catalog, 'Home')

    const statusColumn = store.createDocumentDatabaseColumn({
      name: 'Status',
      type: 'select',
      options: ['Todo', 'Done']
    })

    assert.throws(() => {
      store.updateDocumentDatabaseValue({
        documentId: home.id,
        columnId: statusColumn.id,
        value: 'Invalid'
      })
    }, /not a valid option/)

    store.updateDocumentDatabaseValue({
      documentId: home.id,
      columnId: statusColumn.id,
      value: 'Todo'
    })

    store.updateDocumentDatabaseColumnOptions({
      columnId: statusColumn.id,
      options: ['Done']
    })

    const tagsColumn = store.createDocumentDatabaseColumn({
      name: 'Tags',
      type: 'multi-select',
      options: ['AI', 'UX']
    })

    store.updateDocumentDatabaseValue({
      documentId: home.id,
      columnId: tagsColumn.id,
      value: ['AI', 'UX']
    })

    store.updateDocumentDatabaseColumnOptions({
      columnId: tagsColumn.id,
      options: ['AI']
    })

    const latestHome = store
      .getHomeData(backupRoot)
      .documentCatalog
      .find((entry) => entry.id === home.id)

    assert.ok(latestHome)
    assert.equal(latestHome.fieldValues[statusColumn.id], undefined)
    assert.deepEqual(latestHome.fieldValues[tagsColumn.id], ['AI'])
  })
})

test('embedding cache supports save/get/delete lifecycle', () => {
  withStore((store, backupRoot) => {
    const home = byPath(store.getHomeData(backupRoot).documentCatalog, 'Home')

    store.saveDocumentEmbedding(home.id, 'text-embedding-3-small', 'hash-1', [0.1, 0.2, 0.3])

    assert.deepEqual(
      store.getCachedDocumentEmbedding(home.id, 'text-embedding-3-small', 'hash-1'),
      [0.1, 0.2, 0.3]
    )
    assert.equal(store.getCachedDocumentEmbedding(home.id, 'text-embedding-3-small', 'hash-2'), null)

    store.deleteDocumentEmbeddings(home.id, 'text-embedding-3-small')
    assert.equal(store.getCachedDocumentEmbedding(home.id, 'text-embedding-3-small', 'hash-1'), null)
  })
})

test('links are re-synced after target title change', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const product = byPath(catalog, 'Home/Product')
    const roadmap = byPath(catalog, 'Home/Product/Roadmap')

    const productBefore = store.getDocumentDetail(product.id)
    assert.ok(productBefore)
    assert.equal(productBefore.outgoingLinks.some((item) => item.id === roadmap.id), true)

    store.updateDocument(roadmap.id, {
      title: 'Execution Plan',
      summary: 'Renamed roadmap',
      blocks: [
        { type: 'heading-1', content: 'Execution Plan', checked: false, depth: 0 }
      ]
    })

    const productAfter = store.getDocumentDetail(product.id)
    assert.ok(productAfter)
    assert.equal(productAfter.outgoingLinks.some((item) => item.id === roadmap.id), false)
  })
})

test('document suggestions and global search return expected ranked matches', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const home = byPath(catalog, 'Home')

    const draftId = store.createDocument(home.id)
    store.updateDocument(draftId, {
      title: 'Alpha Note',
      summary: 'Contains keyword zeta',
      blocks: [
        { type: 'paragraph', content: 'zeta appears in block body', checked: false, depth: 0 }
      ]
    })

    const suggestions = store.getDocumentSuggestions('Alpha')
    assert.equal(suggestions.some((item) => item.id === draftId), true)

    const excludedSuggestions = store.getDocumentSuggestions('Alpha', draftId)
    assert.equal(excludedSuggestions.some((item) => item.id === draftId), false)

    const searchResults = store.searchDocuments('zeta')
    assert.equal(searchResults.length > 0, true)
    assert.equal(searchResults.some((item) => item.documentId === draftId && item.matchType === 'title'), true)
    assert.equal(searchResults.some((item) => item.documentId === draftId && item.matchType === 'block'), true)
  })
})

test('buildAiPrompt includes document context and optional related notes', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const home = byPath(catalog, 'Home')

    const prompt = store.buildAiPrompt(
      {
        documentId: home.id,
        prompt: 'Summarize key points'
      },
      [
        {
          title: 'Reference',
          path: 'Home/Reference',
          summary: 'Reference summary',
          content: 'Reference content body'
        }
      ]
    )

    assert.equal(prompt.includes('Document title: Home'), true)
    assert.equal(prompt.includes('Related workspace context:'), true)
    assert.equal(prompt.includes('Context 1: Reference'), true)
    assert.equal(prompt.includes('User request: Summarize key points'), true)
    assert.equal(prompt.includes('Answer in concise Chinese'), true)
  })
})

test('database field serialization handles text/date/checkbox nullability and validation', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const home = byPath(catalog, 'Home')

    const textColumn = store.createDocumentDatabaseColumn({ name: 'Notes', type: 'text' })
    const dateColumn = store.createDocumentDatabaseColumn({ name: 'Due', type: 'date' })
    const checkboxColumn = store.createDocumentDatabaseColumn({ name: 'Done', type: 'checkbox' })

    store.updateDocumentDatabaseValue({ documentId: home.id, columnId: textColumn.id, value: '  ' })
    store.updateDocumentDatabaseValue({ documentId: home.id, columnId: checkboxColumn.id, value: false })
    store.updateDocumentDatabaseValue({ documentId: home.id, columnId: dateColumn.id, value: '2026-05-02' })

    assert.throws(() => {
      store.updateDocumentDatabaseValue({ documentId: home.id, columnId: dateColumn.id, value: '05/02/2026' })
    }, /YYYY-MM-DD/)

    const updatedHome = store.getHomeData(backupRoot).documentCatalog.find((entry) => entry.id === home.id)
    assert.ok(updatedHome)
    assert.equal(updatedHome.fieldValues[textColumn.id], undefined)
    assert.equal(updatedHome.fieldValues[checkboxColumn.id], false)
    assert.equal(updatedHome.fieldValues[dateColumn.id], '2026-05-02')
  })
})
