import assert from 'node:assert/strict'
import test from 'node:test'
import type { HomeData, UpdateDocumentResult } from '../src/shared/contracts.ts'
import { applyIncrementalDocumentUpdate } from '../src/renderer/src/utils/homeDataDocumentUpdate.ts'

test('applyIncrementalDocumentUpdate replaces only the saved document projection', () => {
  const homeData = {
    summary: {
      databasePath: 'workspace.sqlite',
      backupRoot: 'backup',
      documents: 2,
      blocks: 2,
      links: 0,
      lastBackupAt: null
    },
    recentDocuments: [],
    recentEvents: [],
    documentCatalog: [
      {
        id: 'parent',
        title: 'Parent',
        path: 'Parent',
        summary: '',
        parentId: null,
        parentTitle: null,
        updatedAt: 'before',
        blockCount: 1,
        linkCount: 0,
        childCount: 1,
        fieldValues: {}
      },
      {
        id: 'child',
        title: 'Child',
        path: 'Parent/Child',
        summary: '',
        parentId: 'parent',
        parentTitle: 'Parent',
        updatedAt: 'before',
        blockCount: 1,
        linkCount: 0,
        childCount: 0,
        fieldValues: {}
      }
    ],
    databaseColumns: [],
    aiConfig: {
      enabled: false,
      baseUrl: '',
      model: '',
      autoSummaryOnSave: false,
      relatedNotesEnabled: false,
      hasApiKey: false
    },
    documentTree: [{
      id: 'parent',
      title: 'Parent',
      path: 'Parent',
      updatedAt: 'before',
      children: [{
        id: 'child',
        title: 'Child',
        path: 'Parent/Child',
        updatedAt: 'before',
        children: []
      }]
    }],
    initialDocumentId: 'parent',
    plugins: []
  } satisfies HomeData
  const update = {
    requiresFullRefresh: false,
    document: {
      id: 'child',
      title: 'Child',
      path: 'Parent/Child',
      summary: 'Updated',
      updatedAt: 'after',
      blocks: [],
      children: [],
      outgoingLinks: [],
      backlinks: []
    },
    catalogEntry: {
      ...homeData.documentCatalog[1],
      summary: 'Updated',
      updatedAt: 'after',
      blockCount: 3
    },
    summary: {
      ...homeData.summary,
      blocks: 4
    },
    recentDocuments: [{
      id: 'child',
      title: 'Child',
      path: 'Parent/Child',
      updatedAt: 'after',
      blockCount: 3
    }],
    recentEvents: [{
      id: 'event',
      type: 'document.updated',
      title: 'Document saved',
      description: 'Saved changes.',
      documentId: 'child',
      createdAt: 'after'
    }]
  } satisfies Extract<UpdateDocumentResult, { requiresFullRefresh: false }>

  const result = applyIncrementalDocumentUpdate(homeData, update)

  assert.equal(result.documentCatalog[1]?.summary, 'Updated')
  assert.equal(result.documentCatalog[1]?.blockCount, 3)
  assert.equal(result.documentTree[0]?.children[0]?.updatedAt, 'after')
  assert.equal(result.summary.blocks, 4)
  assert.deepEqual(result.recentDocuments, update.recentDocuments)
  assert.deepEqual(result.recentEvents, update.recentEvents)
  assert.strictEqual(result.databaseColumns, homeData.databaseColumns)
  assert.strictEqual(result.plugins, homeData.plugins)
  assert.equal(homeData.documentCatalog[1]?.updatedAt, 'before')
})
