import assert from 'node:assert/strict'
import test from 'node:test'
import type { DatabaseField, DatabaseFilterRule, DatabaseRecord } from '../src/shared/contracts.ts'
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

const datedRecord = (id: string, value: string | null): DatabaseRecord => ({
  ...records[0], id, title: id, fieldValues: { __updated_at__: value, due: value, tags: ['UI'] }
})
const dateRules = (input: DatabaseRecord[], operator: DatabaseFilterRule['operator'], value?: DatabaseFilterRule['value'], fieldId = '__updated_at__') =>
  applyDatabaseView(input, [...fields, { ...fields[3], id: 'due', role: 'property' }], '', {
    operator: 'and', rules: [{ id: 'date', fieldId, operator, value }]
  }, []).map(record => record.id)

test('calendar date conditions match system timestamps on the displayed local day, including both ends of a day', () => {
  const input = [
    datedRecord('a-morning', new Date(2026, 9, 1, 0, 5).toISOString()),
    datedRecord('b-evening', new Date(2026, 9, 1, 23, 55).toISOString()),
    datedRecord('c-earlier', new Date(2026, 8, 30, 23, 55).toISOString()),
    datedRecord('d-later', new Date(2026, 9, 2, 0, 5).toISOString()),
    datedRecord('e-missing', null), datedRecord('f-invalid', 'invalid date')
  ]
  assert.deepEqual(dateRules(input, 'equals', '2026-10-01'), ['a-morning', 'b-evening'])
  assert.deepEqual(dateRules(input, 'before', '2026-10-01'), ['c-earlier'])
  assert.deepEqual(dateRules(input, 'after', '2026-10-01'), ['d-later'])
  assert.deepEqual(dateRules(input, 'between', ['2026-10-01', '2026-10-01']), ['a-morning', 'b-evening'])
  assert.deepEqual(dateRules(input, 'between', ['2026-09-30', '2026-10-01']), ['a-morning', 'b-evening', 'c-earlier'])
  assert.deepEqual(dateRules(input, 'is-empty'), ['e-missing'])
})

test('date properties retain calendar days without shifting them into a different timezone', () => {
  const input = [datedRecord('a-today', '2026-10-01'), datedRecord('b-before', '2026-09-30'), datedRecord('c-after', '2026-10-02'), datedRecord('d-empty', '')]
  assert.deepEqual(dateRules(input, 'equals', '2026-10-01', 'due'), ['a-today'])
  assert.deepEqual(dateRules(input, 'before', '2026-10-01', 'due'), ['b-before'])
  assert.deepEqual(dateRules(input, 'after', '2026-10-01', 'due'), ['c-after'])
  assert.deepEqual(dateRules(input, 'not-equals', '2026-10-01', 'due'), ['b-before', 'c-after', 'd-empty'])
  for (const operator of ['before', 'after', 'greater-than', 'less-than'] as const) {
    assert.deepEqual(dateRules(input, operator, '', 'due'), [], `an empty ${operator} boundary does not match records`)
  }
  assert.deepEqual(dateRules(input, 'between', ['2026-10-01', ''], 'due'), [])
})

test('full timestamp conditions and chronological sorting retain their precision while missing dates stay outside ordered ranges', () => {
  const morning = new Date(2026, 9, 1, 8).toISOString()
  const evening = new Date(2026, 9, 1, 20).toISOString()
  const input = [datedRecord('b-morning', morning), datedRecord('a-evening', evening), datedRecord('c-missing', null)]
  assert.deepEqual(dateRules(input, 'equals', morning), ['b-morning'])
  assert.deepEqual(dateRules(input, 'before', evening), ['b-morning'])
  assert.deepEqual(dateRules(input, 'after', morning), ['a-evening'])
  assert.deepEqual(dateRules(input, 'between', [morning, evening]), ['a-evening', 'b-morning'])
  assert.deepEqual(applyDatabaseView(input.slice(0, 2), fields, '', { operator: 'and', rules: [] }, [{ fieldId: '__updated_at__', direction: 'asc' }]).map(record => record.id), ['b-morning', 'a-evening'])
})

test('nested date filters retain their field context when combined with other conditions', () => {
  const input = [datedRecord('a-today', new Date(2026, 9, 1, 23).toISOString()), datedRecord('b-earlier', new Date(2026, 8, 30, 23).toISOString())]
  const result = applyDatabaseView(input, fields, '', {
    operator: 'and', rules: [
      { id: 'tag', fieldId: 'tags', operator: 'contains-any', value: ['UI'] },
      { operator: 'or', rules: [
        { id: 'today', fieldId: '__updated_at__', operator: 'equals', value: '2026-10-01' },
        { id: 'future', fieldId: '__updated_at__', operator: 'after', value: '2026-10-02' }
      ] }
    ]
  }, [])
  assert.deepEqual(result.map(record => record.id), ['a-today'])
})
