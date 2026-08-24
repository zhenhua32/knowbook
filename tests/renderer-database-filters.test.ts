import assert from 'node:assert/strict'
import test from 'node:test'
import type { DatabaseField, DatabaseRecord } from '../src/shared/contracts.ts'
import { applyDatabaseView, groupDatabaseRecords } from '../src/renderer/src/features/database/model/databaseFilters.ts'

const fields: DatabaseField[] = [
  { id: '__title__', name: 'Title', type: 'text', role: 'title', options: [], editable: true, hideable: false, deletable: false, sortOrder: 0 },
  { id: 'status', name: 'Status', type: 'select', role: 'property', options: ['Todo', 'Doing'], editable: true, hideable: true, deletable: true, sortOrder: 1 },
  { id: 'tags', name: 'Tags', type: 'multi-select', role: 'property', options: ['UI', 'Core'], editable: true, hideable: true, deletable: true, sortOrder: 2 },
  { id: '__updated_at__', name: 'Updated', type: 'date', role: 'system', options: [], editable: false, hideable: true, deletable: false, sortOrder: 3 }
]

const records: DatabaseRecord[] = [
  { id: 'a', databaseId: 'db', title: 'Ship workspace', documentId: null, createdAt: '2026-01-01', updatedAt: '2026-03-01', fieldValues: { status: 'Doing', tags: ['UI'], __updated_at__: '2026-03-01' } },
  { id: 'b', databaseId: 'db', title: 'Write docs', documentId: null, createdAt: '2026-01-02', updatedAt: '2026-02-01', fieldValues: { status: 'Todo', tags: ['Core', 'UI'], __updated_at__: '2026-02-01' } },
  { id: 'c', databaseId: 'db', title: 'Loose idea', documentId: null, createdAt: '2026-01-03', updatedAt: '2026-01-01', fieldValues: { status: null, tags: null, __updated_at__: '2026-01-01' } }
]

test('database view applies query, AND filters, and multi-field sort', () => {
  const result = applyDatabaseView(records, fields, '', {
    operator: 'and',
    rules: [
      { id: 'status', fieldId: 'status', operator: 'is-not-empty' },
      { id: 'tags', fieldId: 'tags', operator: 'contains-any', value: ['UI'] }
    ]
  }, [
    { fieldId: 'status', direction: 'desc' },
    { fieldId: '__updated_at__', direction: 'desc' }
  ])

  assert.deepEqual(result.map((record) => record.id), ['b', 'a'])
  assert.deepEqual(applyDatabaseView(records, fields, 'workspace', { operator: 'and', rules: [] }, []).map((record) => record.id), ['a'])
})

test('database records group into select, multi-select, and empty board columns', () => {
  assert.deepEqual(groupDatabaseRecords(records, 'status').map((group) => [group.label, group.records.map((record) => record.id)]), [
    ['Doing', ['a']],
    ['Todo', ['b']],
    ['未分组', ['c']]
  ])
  assert.deepEqual(groupDatabaseRecords(records, 'tags').map((group) => [group.label, group.records.map((record) => record.id)]), [
    ['Core', ['b']],
    ['UI', ['a', 'b']],
    ['未分组', ['c']]
  ])
})
