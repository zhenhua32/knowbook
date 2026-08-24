import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DATABASE_SYSTEM_FIELD_IDS,
  areDatabaseViewConfigsEqual,
  createDefaultDatabaseViewConfig,
  createLegacyDatabaseViewConfig,
  normalizeDatabaseViewConfig,
  repairDatabaseViewConfig
} from '../src/shared/database-workspace.ts'
import type { DatabaseField } from '../src/shared/contracts.ts'

test('default database view config is versioned and isolated from caller arrays', () => {
  const visible = ['status']
  const config = createDefaultDatabaseViewConfig('table', visible)
  visible.push('owner')

  assert.equal(config.version, 1)
  assert.equal(config.layout, 'table')
  assert.deepEqual(config.visibleFieldIds, ['status'])
  assert.deepEqual(config.sorts, [{ fieldId: DATABASE_SYSTEM_FIELD_IDS.updatedAt, direction: 'desc' }])
})

test('legacy database view fields map into the versioned view config', () => {
  const config = createLegacyDatabaseViewConfig({
    filterQuery: 'Tina',
    filterScope: 'owner',
    sortMode: 'created-asc',
    viewMode: 'cards'
  })

  assert.equal(config.layout, 'cards')
  assert.deepEqual(config.sorts, [{ fieldId: DATABASE_SYSTEM_FIELD_IDS.createdAt, direction: 'asc' }])
  assert.deepEqual(config.filters.rules, [{
    id: 'legacy-owner',
    fieldId: 'owner',
    operator: 'contains',
    value: 'Tina'
  }])
})

test('view config normalization rejects malformed values and bounds column widths', () => {
  const fallback = createDefaultDatabaseViewConfig('table', ['status'])
  const config = normalizeDatabaseViewConfig({
    version: 1,
    layout: 'board',
    query: 'roadmap',
    filters: { operator: 'and', rules: [] },
    sorts: [{ fieldId: 'status', direction: 'asc' }],
    groupBy: { fieldId: 'status' },
    visibleFieldIds: ['status', 'status'],
    fieldOrder: ['status'],
    columnWidths: { status: 240, huge: 5000 },
    cardFieldIds: ['status']
  }, fallback)

  assert.equal(config.layout, 'board')
  assert.deepEqual(config.visibleFieldIds, ['status'])
  assert.deepEqual(config.columnWidths, { status: 240 })
  assert.equal(normalizeDatabaseViewConfig(null, fallback).layout, 'table')
})

test('view config repair removes stale field references and keeps title visible', () => {
  const fields: DatabaseField[] = [
    { id: DATABASE_SYSTEM_FIELD_IDS.title, name: 'Title', type: 'text', role: 'title', options: [], editable: true, hideable: false, deletable: false, sortOrder: 0 },
    { id: 'status', name: 'Status', type: 'select', role: 'property', options: [], editable: true, hideable: true, deletable: true, sortOrder: 1 }
  ]
  const config = createDefaultDatabaseViewConfig('board', ['missing', 'status'])
  config.groupBy.fieldId = 'missing'
  config.filters.rules.push({ id: 'stale', fieldId: 'missing', operator: 'equals', value: 'x' })
  config.columnWidths = { missing: 200, status: 180 }

  const repaired = repairDatabaseViewConfig(config, fields)
  assert.deepEqual(repaired.visibleFieldIds, [DATABASE_SYSTEM_FIELD_IDS.title, 'status'])
  assert.deepEqual(repaired.filters.rules, [])
  assert.equal(repaired.groupBy.fieldId, null)
  assert.deepEqual(repaired.columnWidths, { status: 180 })
  assert.equal(areDatabaseViewConfigsEqual(repaired, { ...repaired }), true)
})

test('view config repair shows newly added property fields without unhiding existing fields', () => {
  const fields: DatabaseField[] = [
    field('__title__', 'Title', 'title'),
    field('hidden', 'Hidden', 'property'),
    field('new-field', 'New field', 'property')
  ]
  const config = createDefaultDatabaseViewConfig('table', ['__title__'], ['__title__', 'hidden'])
  const repaired = repairDatabaseViewConfig(config, fields)

  assert.deepEqual(repaired.visibleFieldIds, ['__title__', 'new-field'])
  assert.deepEqual(repaired.fieldOrder, ['__title__', 'hidden', 'new-field'])
})

function field(id: string, name: string, role: DatabaseField['role']): DatabaseField {
  return {
    id,
    name,
    role,
    type: 'text',
    options: [],
    editable: role !== 'system',
    hideable: role !== 'title',
    deletable: role === 'property',
    sortOrder: 0
  }
}
