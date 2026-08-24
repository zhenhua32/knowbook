import assert from 'node:assert/strict'
import test from 'node:test'
import { DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace.ts'
import type {
  DatabaseEntity,
  DocumentCatalogEntry,
  DocumentDatabase,
  DocumentDatabaseColumn
} from '../src/shared/contracts.ts'
import {
  adaptCatalogFields,
  adaptCatalogRecords,
  adaptCustomFields,
  adaptCustomRecords,
  adaptDatabaseSources
} from '../src/renderer/src/features/database/model/databaseAdapters.ts'

const labels = {
  title: '标题',
  path: '路径',
  parent: '父级',
  linkedDocument: '关联文档',
  blockCount: '块数',
  linkCount: '链接数',
  childCount: '子文档数',
  createdAt: '创建时间',
  updatedAt: '更新时间'
}

const propertyColumns: DocumentDatabaseColumn[] = [
  { id: 'status', name: '状态', type: 'select', options: ['待办', '完成'], sortOrder: 1 },
  { id: 'owner', name: '负责人', type: 'text', options: [], sortOrder: 0 }
]

test('database source adapter keeps the document catalog first and exposes capabilities', () => {
  const databases: DocumentDatabase[] = [
    { id: 'projects', kind: 'custom', name: '项目', description: '', createdAt: '2', updatedAt: '2' },
    { id: 'catalog', kind: 'document-catalog', name: 'Default', description: 'Default database', createdAt: '1', updatedAt: '1' }
  ]

  const sources = adaptDatabaseSources(databases)
  assert.deepEqual(sources.map((source) => source.id), ['catalog', 'projects'])
  assert.equal(sources[0]?.canDelete, false)
  assert.equal(sources[0]?.canCreateDetachedRecord, false)
  assert.equal(sources[1]?.canDelete, true)
  assert.equal(sources[1]?.canCreateDetachedRecord, true)
})

test('field adapters combine stable system fields with ordered property fields', () => {
  const catalogFields = adaptCatalogFields(propertyColumns, labels)
  const customFields = adaptCustomFields(propertyColumns, labels)

  assert.equal(catalogFields[0]?.id, DATABASE_SYSTEM_FIELD_IDS.title)
  assert.equal(catalogFields[0]?.role, 'title')
  assert.equal(catalogFields.find((field) => field.id === DATABASE_SYSTEM_FIELD_IDS.path)?.editable, false)
  assert.deepEqual(catalogFields.filter((field) => field.role === 'property').map((field) => field.id), ['owner', 'status'])
  assert.equal(customFields.find((field) => field.id === DATABASE_SYSTEM_FIELD_IDS.document)?.editable, true)
})

test('catalog record adapter exposes document metadata through reserved field ids', () => {
  const documents: DocumentCatalogEntry[] = [{
    id: 'doc-1',
    title: 'Roadmap',
    path: 'Product/Roadmap',
    parentId: 'product',
    parentTitle: 'Product',
    summary: 'Milestones',
    blockCount: 4,
    linkCount: 2,
    childCount: 0,
    updatedAt: '2026-08-24T00:00:00.000Z',
    fieldValues: { status: '待办' }
  }]

  const [record] = adaptCatalogRecords('catalog', documents)
  assert.equal(record?.title, 'Roadmap')
  assert.equal(record?.documentId, 'doc-1')
  assert.equal(record?.fieldValues[DATABASE_SYSTEM_FIELD_IDS.path], 'Product/Roadmap')
  assert.equal(record?.fieldValues[DATABASE_SYSTEM_FIELD_IDS.blockCount], 4)
  assert.equal(record?.fieldValues.status, '待办')
})

test('custom record adapter keeps the entity title and resolves the linked document path', () => {
  const entities: DatabaseEntity[] = [{
    id: 'record-1',
    databaseId: 'projects',
    title: 'Desktop release',
    documentId: 'doc-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    fieldValues: { owner: 'Tina' }
  }]
  const documents: DocumentCatalogEntry[] = [{
    id: 'doc-1',
    title: 'Release notes',
    path: 'Product/Release notes',
    parentId: null,
    parentTitle: null,
    summary: '',
    blockCount: 1,
    linkCount: 0,
    childCount: 0,
    updatedAt: '2026-08-24T00:00:00.000Z',
    fieldValues: {}
  }]

  const [record] = adaptCustomRecords('projects', entities, documents)
  assert.equal(record?.title, 'Desktop release')
  assert.equal(record?.fieldValues[DATABASE_SYSTEM_FIELD_IDS.document], 'Product/Release notes')
  assert.equal(record?.fieldValues.owner, 'Tina')
})
