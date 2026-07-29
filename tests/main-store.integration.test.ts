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

test('updateDocument prevents path injection and resolves sibling title collisions', () => {
  withStore((store, backupRoot) => {
    const product = byPath(store.getHomeData(backupRoot).documentCatalog, 'Home/Product')
    const firstId = store.createDocument(product.id)
    const secondId = store.createDocument(product.id)
    const blocks = [{ type: 'paragraph' as const, content: 'content', checked: false, depth: 0 }]

    store.updateDocument(firstId, { title: 'Specs', summary: '', blocks })
    store.updateDocument(secondId, { title: 'specs', summary: '', blocks })

    assert.equal(store.getDocumentSnapshot(firstId)?.path, 'Home/Product/Specs')
    assert.equal(store.getDocumentSnapshot(secondId)?.path, 'Home/Product/specs 1')
    assert.throws(
      () => store.updateDocument(secondId, { title: '../../outside', summary: '', blocks }),
      /cannot contain path separators/
    )
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

test('document path rewrites only replace the leading subtree prefix', () => {
  withStore((store, backupRoot) => {
    const rootId = store.createDocument(null)
    const middleId = store.createDocument(rootId)
    const repeatedRootId = store.createDocument(middleId)
    const leafId = store.createDocument(repeatedRootId)
    const targetId = store.createDocument(null)
    const blocks = [{ type: 'paragraph' as const, content: 'content', checked: false, depth: 0 }]

    store.updateDocument(rootId, { title: 'Alpha', summary: '', blocks })
    store.updateDocument(middleId, { title: 'Middle', summary: '', blocks })
    store.updateDocument(repeatedRootId, { title: 'Alpha', summary: '', blocks })
    store.updateDocument(leafId, { title: 'Leaf', summary: '', blocks })
    store.updateDocument(targetId, { title: 'Target', summary: '', blocks })

    store.updateDocument(rootId, { title: 'Renamed', summary: '', blocks })
    assert.equal(store.getDocumentSnapshot(leafId)?.path, 'Renamed/Middle/Alpha/Leaf')

    store.updateDocument(rootId, { title: 'Alpha', summary: '', blocks })
    store.moveDocument(rootId, targetId)
    assert.equal(store.getDocumentSnapshot(leafId)?.path, 'Target/Alpha/Middle/Alpha/Leaf')

    store.moveDocument(rootId, null)
    store.deleteDocument(rootId)
    assert.equal(store.getDocumentSnapshot(leafId)?.path, 'Middle/Alpha/Leaf')
    assert.equal(store.getDocumentSnapshot(middleId)?.parentId, null)
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

test('document database columns and standalone entities stay isolated per database', () => {
  withStore((store, backupRoot) => {
    const initialHome = store.getHomeData(backupRoot)
    const defaultCatalogCount = initialHome.documentCatalog.length
    const defaultDatabaseColumnsBefore = initialHome.databaseColumns

    const projectsDatabase = store.createDatabase({
      name: 'Projects',
      description: 'Project tracking'
    })

    const defaultColumn = store.createDocumentDatabaseColumn({ name: 'Status', type: 'text' })
    const projectsColumn = store.createDocumentDatabaseColumn({
      databaseId: projectsDatabase.id,
      name: 'Owner',
      type: 'text'
    })

    const projectEntity = store.createDatabaseEntity({
      databaseId: projectsDatabase.id,
      fieldValues: { [projectsColumn.id]: 'Alice' }
    })

    const refreshedHome = store.getHomeData(backupRoot)
    const projectColumns = store.getDocumentDatabaseColumns(projectsDatabase.id)

    assert.equal(refreshedHome.databaseColumns.some((column) => column.id === defaultColumn.id), true)
    assert.equal(refreshedHome.databaseColumns.some((column) => column.id === projectsColumn.id), false)
    assert.equal(projectColumns.some((column) => column.id === projectsColumn.id), true)
    assert.equal(projectColumns.some((column) => column.id === defaultColumn.id), false)
    assert.equal(refreshedHome.documentCatalog.length, defaultCatalogCount)
    assert.equal(refreshedHome.databaseColumns.length, defaultDatabaseColumnsBefore.length + 1)
    assert.equal(projectEntity.documentId, null)
    assert.equal(projectEntity.fieldValues[projectsColumn.id], 'Alice')
    assert.equal(store.getDatabaseEntities(projectsDatabase.id)[0]?.fieldValues[projectsColumn.id], 'Alice')
  })
})

test('database entity writes are atomic when a field is invalid', () => {
  withStore((store) => {
    const database = store.createDatabase({ name: 'Atomic entities' })
    const column = store.createDocumentDatabaseColumn({
      databaseId: database.id,
      name: 'Owner',
      type: 'text'
    })
    const entity = store.createDatabaseEntity({
      databaseId: database.id,
      fieldValues: { [column.id]: 'Before' }
    })

    assert.throws(() => {
      store.createDatabaseEntity({
        databaseId: database.id,
        fieldValues: { [column.id]: 'Valid', missing: 'Invalid' }
      })
    }, /Database column not found/)
    assert.equal(store.getDatabaseEntities(database.id).length, 1)

    assert.throws(() => {
      store.updateDatabaseEntity({
        entityId: entity.id,
        fieldValues: { [column.id]: 'After', missing: 'Invalid' }
      })
    }, /Database column not found/)
    assert.equal(store.getDatabaseEntities(database.id)[0]?.fieldValues[column.id], 'Before')
  })
})

test('standalone database saved views persist and update list controls', () => {
  withStore((store) => {
    const projectsDatabase = store.createDatabase({
      name: 'Projects',
      description: 'Project tracking'
    })

    const createdView = store.createDatabaseSavedView({
      databaseId: projectsDatabase.id,
      name: 'Beta table',
      filterQuery: 'beta',
      filterScope: '__document__',
      sortMode: 'created-asc',
      viewMode: 'table'
    })

    assert.equal(store.getDatabaseSavedViews(projectsDatabase.id).length, 1)
    assert.equal(createdView.filterQuery, 'beta')
    assert.equal(createdView.filterScope, '__document__')
    assert.equal(createdView.sortMode, 'created-asc')
    assert.equal(createdView.viewMode, 'table')

    assert.throws(() => {
      store.createDatabaseSavedView({
        databaseId: projectsDatabase.id,
        name: 'beta table'
      })
    }, /already exists/)

    const updatedView = store.updateDatabaseSavedView({
      viewId: createdView.id,
      filterQuery: 'alpha',
      filterScope: '',
      sortMode: 'updated-desc',
      viewMode: 'cards'
    })

    assert.equal(updatedView.name, 'Beta table')
    assert.equal(updatedView.filterQuery, 'alpha')
    assert.equal(updatedView.filterScope, '')
    assert.equal(updatedView.sortMode, 'updated-desc')
    assert.equal(updatedView.viewMode, 'cards')

    store.deleteDatabaseSavedView(createdView.id)
    assert.deepEqual(store.getDatabaseSavedViews(projectsDatabase.id), [])
  })
})

test('deleteDatabase removes standalone database data but refuses the default database', () => {
  withStore((store) => {
    const defaultDatabase = store.getDatabases().find((database) => database.name === 'Default')
    assert.ok(defaultDatabase)

    const projectsDatabase = store.createDatabase({
      name: 'Projects',
      description: 'Project tracking'
    })
    const ownerColumn = store.createDocumentDatabaseColumn({
      databaseId: projectsDatabase.id,
      name: 'Owner',
      type: 'text'
    })

    store.createDatabaseSavedView({
      databaseId: projectsDatabase.id,
      name: 'Active projects'
    })
    store.createDatabaseEntity({
      databaseId: projectsDatabase.id,
      fieldValues: {
        [ownerColumn.id]: 'Alice'
      }
    })

    store.deleteDatabase(projectsDatabase.id)

    assert.equal(store.getDatabases().some((database) => database.id === projectsDatabase.id), false)
    assert.equal(store.getDatabaseEntities(projectsDatabase.id).length, 0)
    assert.throws(() => {
      store.getDatabaseSavedViews(projectsDatabase.id)
    }, /Database not found/)
    assert.throws(() => {
      store.deleteDatabase(defaultDatabase.id)
    }, /cannot be deleted/)
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

test('content-only document updates rebuild links only for the edited source document', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const home = byPath(catalog, 'Home')
    const product = byPath(catalog, 'Home/Product')
    const roadmap = byPath(catalog, 'Home/Product/Roadmap')
    const otherSourceId = store.createDocument(home.id)

    store.updateDocument(otherSourceId, {
      title: 'Other Source',
      summary: '',
      blocks: [
        { type: 'paragraph', content: 'Keep this unrelated link: [[Roadmap]]', checked: false, depth: 0 }
      ]
    })

    const database = (store as unknown as { db: { exec: (sql: string) => void } }).db
    database.exec(`
      CREATE TRIGGER reject_unrelated_link_delete
      BEFORE DELETE ON links
      WHEN OLD.source_document_id <> '${product.id}'
      BEGIN
        SELECT RAISE(ABORT, 'unrelated link deleted');
      END;
    `)

    store.updateDocument(product.id, {
      title: product.title,
      summary: 'Content-only update',
      blocks: [
        { type: 'paragraph', content: 'The edited source now links to [[Home]].', checked: false, depth: 0 }
      ]
    })

    const updatedProduct = store.getDocumentDetail(product.id)
    const otherSource = store.getDocumentDetail(otherSourceId)
    assert.ok(updatedProduct)
    assert.ok(otherSource)
    assert.equal(updatedProduct.outgoingLinks.some((item) => item.id === home.id), true)
    assert.equal(updatedProduct.outgoingLinks.some((item) => item.id === roadmap.id), false)
    assert.equal(otherSource.outgoingLinks.some((item) => item.id === roadmap.id), true)
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

test('ai config persists defaults, api key, and auto-summary flag', () => {
  withStore((store) => {
    store.updateAiConfig({
      enabled: false,
      baseUrl: 'https://example.ai/v1',
      model: 'gpt-4.1-mini',
      autoSummaryOnSave: true,
      relatedNotesEnabled: true,
      apiKey: 'secret-key'
    })

    const config = store.getAiConfigPublic()
    assert.equal(config.enabled, false)
    assert.equal(config.baseUrl, 'https://example.ai/v1')
    assert.equal(config.autoSummaryOnSave, true)
    assert.equal(config.hasApiKey, true)

    store.updateAiConfig({
      enabled: false,
      baseUrl: 'https://example.ai/v1',
      model: 'gpt-4.1-mini',
      autoSummaryOnSave: true,
      relatedNotesEnabled: false,
      clearApiKey: true
    })
    assert.equal(store.getAiConfigPublic().hasApiKey, false)
  })
})

test('semantic search candidates support exclusion', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const home = byPath(catalog, 'Home')

    const candidates = store.getSemanticSearchCandidates({ excludeDocumentId: home.id })
    assert.equal(candidates.some((item) => item.documentId === home.id), false)
    assert.equal(candidates.length > 0, true)
  })
})

test('workspace event stream keeps recent items and preserves latest order', () => {
  withStore((store, backupRoot) => {
    for (let i = 0; i < 50; i += 1) {
      const second = String(i).padStart(2, '0')
      store.recordWorkspaceEvent({
        type: 'plugin.loaded',
        title: ` event ${i} `,
        description: ` description ${i} `,
        createdAt: `2026-05-02T00:00:${second}.000Z`
      })
    }

    const recentEvents = store.getHomeData(backupRoot).recentEvents
    assert.equal(recentEvents.length, 8)
    assert.equal(recentEvents[0]?.title, 'event 49')
    assert.equal(recentEvents[0]?.description, 'description 49')
    assert.equal(recentEvents[7]?.title, 'event 42')
  })
})

test('deleteDocument reparents descendants and rewrites paths', () => {
  withStore((store, backupRoot) => {
    const catalog = store.getHomeData(backupRoot).documentCatalog
    const home = byPath(catalog, 'Home')

    const parentId = store.createDocument(home.id)
    const childId = store.createDocument(parentId)

    store.updateDocument(parentId, {
      title: 'ToDelete',
      summary: '',
      blocks: [{ type: 'paragraph', content: 'p', checked: false, depth: 0 }]
    })
    store.updateDocument(childId, {
      title: 'Leaf',
      summary: '',
      blocks: [{ type: 'paragraph', content: 'c', checked: false, depth: 0 }]
    })

    const affected = store.deleteDocument(parentId)
    assert.equal(affected.includes(childId), true)

    const child = store.getDocumentSnapshot(childId)
    assert.ok(child)
    assert.equal(child.parentId, home.id)
    assert.equal(child.path, 'Home/Leaf')
  })
})

test('updateDocumentBlockTags and updateDocumentBlockHighlights persist to document detail', () => {
  withStore((store, backupRoot) => {
    const home = byPath(store.getHomeData(backupRoot).documentCatalog, 'Home')
    const detail = store.getDocumentDetail(home.id)
    assert.ok(detail)

    const target = detail.blocks.find((block) => block.type === 'paragraph')
    assert.ok(target)

    store.updateDocumentBlockTags(home.id, [{ blockId: target.id, tags: ['a', 'a', 'b'] }])
    store.updateDocumentBlockHighlights(home.id, [{ blockId: target.id, highlight: 'yellow' }])

    const updated = store.getDocumentDetail(home.id)
    assert.ok(updated)
    const updatedBlock = updated.blocks.find((block) => block.id === target.id)
    assert.ok(updatedBlock)
    assert.deepEqual(updatedBlock.tags, ['a', 'b'])
    assert.equal(updatedBlock.highlight, 'yellow')
  })
})

test('updateDocument persists manual block highlight from document input', () => {
  withStore((store, backupRoot) => {
    const home = byPath(store.getHomeData(backupRoot).documentCatalog, 'Home')
    const detail = store.getDocumentDetail(home.id)
    assert.ok(detail)

    const blocks = detail.blocks.map((block, index) =>
      index === 0
        ? { ...block, highlight: 'blue' }
        : block
    )

    store.updateDocument(home.id, {
      title: detail.title,
      summary: detail.summary,
      blocks
    })

    const updated = store.getDocumentDetail(home.id)
    assert.ok(updated)
    assert.equal(updated.blocks[0]?.highlight, 'blue')
  })
})

test('store throws expected errors for missing entities', () => {
  withStore((store) => {
    assert.throws(() => store.createDocument('missing-parent'), /Parent document not found/)
    assert.throws(() => store.deleteDocument('missing-id'), /Document not found/)
    assert.throws(() => store.moveDocument('missing-id', null), /Document not found/)
    assert.throws(() => store.updateDocumentSummary('missing-id', 'summary'), /Document not found/)
    assert.throws(() => store.buildAiPrompt({ documentId: 'missing-id', prompt: 'x' }), /Document not found/)
  })
})

test('public snapshots, summaries, and settings round-trip through the store', () => {
  withStore((store, backupRoot) => {
    const home = byPath(store.getHomeData(backupRoot).documentCatalog, 'Home')

    assert.equal(store.getDocumentSnapshotByPath('Home')?.id, home.id)
    assert.equal(store.getAllDocumentSnapshots().some((snapshot) => snapshot.id === home.id), true)

    store.updateDocumentSummary(home.id, '  concise summary  ')
    assert.equal(store.getDocumentDetail(home.id)?.summary, 'concise summary')

    store.saveSetting('test.setting', 'first')
    store.saveSetting('test.setting', 'second')
    assert.equal(store.getSettingPublic('test.setting'), 'second')
    store.deleteSetting('test.setting')
    assert.equal(store.getSettingPublic('test.setting'), null)
  })
})

test('database metadata, columns, lookups, and entity lifecycle cover successful mutations', () => {
  withStore((store, backupRoot) => {
    const home = byPath(store.getHomeData(backupRoot).documentCatalog, 'Home')
    const standalone = store.createDatabase({ name: '  Projects  ', description: ' initial ' })
    store.updateDatabaseMetadata({
      databaseId: standalone.id,
      name: ' Work ',
      description: ' Active projects '
    })

    const updatedDatabase = store.getDatabases().find((database) => database.id === standalone.id)
    assert.equal(updatedDatabase?.name, 'Work')
    assert.equal(updatedDatabase?.description, 'Active projects')

    const first = store.createDocumentDatabaseColumn({ name: 'First', type: 'text' })
    const second = store.createDocumentDatabaseColumn({ name: 'Second', type: 'select', options: ['Open', 'Done'] })
    store.renameDocumentDatabaseColumn({ columnId: second.id, name: ' Status ' })
    store.moveDocumentDatabaseColumn({ columnId: second.id, direction: 'left' })

    const reordered = store.getDocumentDatabaseColumns()
    assert.equal(reordered.find((column) => column.id === second.id)?.name, 'Status')
    assert.equal(reordered.findIndex((column) => column.id === second.id) < reordered.findIndex((column) => column.id === first.id), true)

    store.updateDocumentDatabaseValue({ documentId: home.id, columnId: second.id, value: 'Open' })
    assert.deepEqual(store.findDocumentIdsByDatabaseValue(second.id, 'Open'), [home.id])
    assert.deepEqual(store.findDocumentIdsByDatabaseValue(second.id, null), [])

    const owner = store.createDocumentDatabaseColumn({
      databaseId: standalone.id,
      name: 'Owner',
      type: 'text'
    })
    const entity = store.createDatabaseEntity({
      databaseId: standalone.id,
      fieldValues: { [owner.id]: 'Alice' }
    })
    store.updateDatabaseEntity({
      entityId: entity.id,
      fieldValues: { [owner.id]: ' Bob ' }
    })

    const updatedEntity = store.getDatabaseEntities(standalone.id)[0]
    assert.equal(updatedEntity?.fieldValues[owner.id], 'Bob')

    store.deleteDatabaseEntity(entity.id)
    assert.deepEqual(store.getDatabaseEntities(standalone.id), [])

    store.deleteDocumentDatabaseColumn(first.id)
    assert.equal(store.getDocumentDatabaseColumns().some((column) => column.id === first.id), false)
  })
})

test('block AI edit prompts validate selection and enforce table-only output rules', () => {
  withStore((store) => {
    assert.throws(() => store.buildDocumentBlockAiEditPrompt({
      documentId: 'doc',
      documentTitle: 'Title',
      documentPath: 'Title',
      documentSummary: '',
      selectedBlocks: [{ type: 'paragraph', content: '  ', checked: false, depth: 0 }],
      mode: 'rewrite'
    }, 'Rewrite'), /Selected blocks not found/)

    const prompt = store.buildDocumentBlockAiEditPrompt({
      documentId: 'doc',
      documentTitle: 'Title',
      documentPath: 'Home/Title',
      documentSummary: 'Summary',
      selectedBlocks: [
        { type: ' paragraph ', content: 'Alpha', checked: false, depth: 0 },
        { type: 'divider', content: '', checked: false, depth: 0 }
      ],
      mode: 'table'
    }, 'Convert to a table')

    assert.equal(prompt.includes('Selected block count: 2'), true)
    assert.equal(prompt.includes('Return exactly one Markdown table as plain text.'), true)
    assert.equal(prompt.includes('Do not wrap the table in code fences.'), true)
  })
})
