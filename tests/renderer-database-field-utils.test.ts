import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentDatabase } from '../src/shared/contracts.ts'
import {
  areDocumentDatabaseFieldValuesEqual,
  compactDocumentDatabaseFieldValues,
  formatDocumentCatalogFieldValueForDisplay,
  formatDocumentDatabaseFieldValueForDraft,
  isDefaultDocumentDatabase,
  normalizeDatabaseColumnOptionsInput,
  normalizeDocumentDatabaseFieldValue
} from '../src/renderer/src/components/database/databaseFieldUtils.ts'

test('database option input is trimmed, de-duplicated, and order preserving', () => {
  assert.deepEqual(normalizeDatabaseColumnOptionsInput(' todo, doing, todo, , done '), ['todo', 'doing', 'done'])
})

test('database field normalization handles scalar and multi-select empty values', () => {
  assert.equal(normalizeDocumentDatabaseFieldValue('  note  '), 'note')
  assert.equal(normalizeDocumentDatabaseFieldValue('  '), null)
  assert.deepEqual(normalizeDocumentDatabaseFieldValue([' alpha ', '', 'alpha', 'beta']), ['alpha', 'beta'])
  assert.equal(normalizeDocumentDatabaseFieldValue([]), null)
  assert.equal(normalizeDocumentDatabaseFieldValue(false), false)
})

test('database field equality is order insensitive but never conflates arrays with scalar values', () => {
  assert.equal(areDocumentDatabaseFieldValuesEqual(['b', 'a'], ['a', 'b']), true)
  assert.equal(areDocumentDatabaseFieldValuesEqual([], null), true)
  assert.equal(areDocumentDatabaseFieldValuesEqual(['x'], 'x'), false)
  assert.equal(areDocumentDatabaseFieldValuesEqual([], 'x'), false)
  assert.equal(areDocumentDatabaseFieldValuesEqual([], false), false)
})

test('database field formatting covers arrays, booleans, null, and strings', () => {
  assert.equal(formatDocumentDatabaseFieldValueForDraft(['a', 'b']), 'a, b')
  assert.equal(formatDocumentDatabaseFieldValueForDraft(true), '')
  assert.equal(formatDocumentCatalogFieldValueForDisplay(['a', 'b']), 'a, b')
  assert.equal(formatDocumentCatalogFieldValueForDisplay(true), 'True')
  assert.equal(formatDocumentCatalogFieldValueForDisplay(false), 'False')
  assert.equal(formatDocumentCatalogFieldValueForDisplay(null), '')
})

test('compacting database values drops normalized nulls while retaining false', () => {
  assert.deepEqual(compactDocumentDatabaseFieldValues({
    emptyText: ' ',
    emptyMulti: [],
    title: ' note ',
    tags: ['alpha', ' alpha ', ''],
    done: false
  }), {
    title: 'note',
    tags: ['alpha'],
    done: false
  })
})

test('default database detection uses the explicit source kind instead of mutable metadata', () => {
  const database: DocumentDatabase = {
    id: 'default',
    kind: 'document-catalog',
    name: 'Default',
    description: 'Default database',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  assert.equal(isDefaultDocumentDatabase(database), true)
  assert.equal(isDefaultDocumentDatabase({ ...database, name: 'Renamed', description: 'User database' }), true)
  assert.equal(isDefaultDocumentDatabase({ ...database, kind: 'custom' }), false)
})
