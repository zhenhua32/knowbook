import assert from 'node:assert/strict'
import test from 'node:test'
import type { HomeData, UpdateDocumentResult } from '../src/shared/contracts.ts'
import { applyIncrementalDocumentUpdate } from '../src/renderer/src/utils/homeDataDocumentUpdate.ts'
import {
  decodeDocumentCatalogEntry,
  decodeDocumentIndexEntry,
  encodeDocumentCatalogEntry,
  encodeDocumentIndexEntry
} from '../src/shared/document-catalog-payload.ts'
import { buildDocumentTreeFromCatalog } from '../src/shared/document-tree.ts'

test('document catalog IPC tuples round-trip entries and compact empty fields', () => {
  const entry = {
    id: 'document', title: 'Document', path: 'Root/Document', summary: 'Summary',
    parentId: 'root', parentTitle: 'Root', updatedAt: 'now', blockCount: 3,
    linkCount: 2, childCount: 1, fieldValues: {}
  }
  const encoded = encodeDocumentCatalogEntry(entry)

  assert.equal(encoded.length, 11)
  assert.equal(encoded[10], null)
  assert.deepEqual(decodeDocumentCatalogEntry(encoded), entry)
})

test('document index IPC tuples keep only fields required for startup navigation', () => {
  const entry = {
    id: 'document',
    title: 'Document',
    path: 'Root/Document',
    parentId: 'root',
    updatedAt: 'now'
  }
  const encoded = encodeDocumentIndexEntry(entry)

  assert.equal(encoded.length, 5)
  assert.deepEqual(decodeDocumentIndexEntry(encoded), entry)
})

test('buildDocumentTreeFromCatalog derives the hierarchy without a duplicate IPC tree payload', () => {
  const catalog = [
    {
      id: 'root', title: 'Root', path: 'Root', summary: '', parentId: null, parentTitle: null,
      updatedAt: 'now', blockCount: 1, linkCount: 0, childCount: 1, fieldValues: {}
    },
    {
      id: 'child', title: 'Child', path: 'Root/Child', summary: '', parentId: 'root', parentTitle: 'Root',
      updatedAt: 'now', blockCount: 1, linkCount: 0, childCount: 0, fieldValues: {}
    }
  ]

  assert.deepEqual(buildDocumentTreeFromCatalog(catalog), [{
    id: 'root', title: 'Root', path: 'Root', updatedAt: 'now', children: [{
      id: 'child', title: 'Child', path: 'Root/Child', updatedAt: 'now', children: []
    }]
  }])
})

test('applyIncrementalDocumentUpdate replaces only the saved document projection', () => {
  const homeData = {
    appearanceTheme: 'light',
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
        parentId: null,
        updatedAt: 'before'
      },
      {
        id: 'child',
        title: 'Child',
        path: 'Parent/Child',
        parentId: 'parent',
        updatedAt: 'before'
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
      id: 'child',
      title: 'Child',
      path: 'Parent/Child',
      summary: 'Updated',
      parentId: 'parent',
      parentTitle: 'Parent',
      updatedAt: 'after',
      blockCount: 3,
      linkCount: 0,
      childCount: 0,
      fieldValues: {}
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

  assert.equal(result.documentTree[0]?.children[0]?.updatedAt, 'after')
  assert.equal(result.summary.blocks, 4)
  assert.deepEqual(result.recentDocuments, update.recentDocuments)
  assert.deepEqual(result.recentEvents, update.recentEvents)
  assert.strictEqual(result.databaseColumns, homeData.databaseColumns)
  assert.strictEqual(result.plugins, homeData.plugins)
  assert.equal(homeData.documentCatalog[1]?.updatedAt, 'before')
})
