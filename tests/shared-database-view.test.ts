import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { parseStrictJson } from '../src/shared/strictJson'
import { collectDatabaseViewFieldIds, mapDatabaseViewConfigFieldIds, mapDatabaseViewReferences, parseDatabaseViewPayload,
  serializeDatabaseViewPayload, validateDatabaseViewBlock, validateDatabaseViewConfig, type DatabaseViewBlockPayloadV1 } from '../src/shared/databaseViewBlock'

const limits = { maxBytes: 8192, maxDepth: 16 }
const value = (): DatabaseViewBlockPayloadV1 => ({ version: 1, databaseId: 'source-db', viewId: 'source-view',
  config: { ...createDefaultDatabaseViewConfig('table', ['__title__', 'status', 'date']), query: '[status](file:///private/old-db.md)',
    filters: { operator: 'and', rules: [{ id: 'first', fieldId: 'status', operator: 'equals', value: 'status' },
      { operator: 'or', rules: [{ id: 'second', fieldId: 'date', operator: 'between', value: ['2026-10-15', '2026-10-15'] }] }] },
    sorts: [{ fieldId: 'date', direction: 'desc' }], groupBy: { fieldId: 'status' }, columnWidths: { status: 160 }, cardFieldIds: ['date'] } })

test('strict JSON rejects duplicate decoded keys at every object without confusing quoted values', () => {
  for (const json of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '[{"a":{"b":0,"b":1}}]']) {
    assert.throws(() => parseStrictJson(json, limits), /JSON/)
  }
  assert.deepEqual(parseStrictJson('{"a":"\\\"a\\\":1,\\\"a\\\":2","b":"constructor"}', limits),
    { a: '"a":1,"a":2', b: 'constructor' })
})

test('strict JSON validates actual syntax, finite numbers, UTF-8 bytes and nesting before decoding', () => {
  for (const json of ['', ' ', '{"a":1,}', '[1,]', '[01]', '[1e]', '{a:1}', 'true false', '"bad\\x"', '[1e999]']) {
    assert.throws(() => parseStrictJson(json, limits), /JSON/, json)
  }
  assert.equal(parseStrictJson('"中"', { maxBytes: 5, maxDepth: 1 }), '中')
  assert.throws(() => parseStrictJson('"中"', { maxBytes: 4, maxDepth: 1 }), /JSON/)
  assert.deepEqual(parseStrictJson('{"a":[1]}', { maxBytes: 100, maxDepth: 2 }), { a: [1] })
  assert.throws(() => parseStrictJson('{"a":[{}]}', { maxBytes: 100, maxDepth: 2 }), /JSON/)
})

test('strict JSON rejects prototype keys while preserving ordinary strings with those words', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => parseStrictJson(`{"nested":{"${key}":1}}`, limits), /JSON/)
  }
  assert.deepEqual(parseStrictJson('["__proto__","prototype"]', limits), ['__proto__', 'prototype'])
  assert.equal(Object.hasOwn(Object.prototype, 'nested'), false)
})

test('database-view payload canonicalizes key order and preserves complete authored configuration', () => {
  const original = value(), pretty = JSON.stringify(original, null, 2)
  const serialized = serializeDatabaseViewPayload(parseDatabaseViewPayload(pretty))
  assert.equal(serialized.includes('\n'), false)
  assert.ok(serialized.startsWith('{"config":'))
  assert.deepEqual(parseDatabaseViewPayload(serialized), original)
  const emptySorts = { ...original.config, sorts: [] }
  assert.deepEqual(validateDatabaseViewConfig(emptySorts).sorts, [])
  assert.deepEqual(validateDatabaseViewConfig(original.config).filters, original.config.filters)
})

test('invalid database-view data never normalizes into a usable default view', () => {
  const mutations: Array<(payload: Record<string, any>) => void> = [
    p => { p.version = 2 }, p => { p.extra = true }, p => { delete p.config }, p => { p.databaseId = ' source-db' },
    p => { p.viewId = '' }, p => { p.config.layout = 'grid' }, p => { delete p.config.query },
    p => { p.config.filters.rules[0].operator = 'anything' }, p => { p.config.filters.rules[0].extra = 'unknown' },
    p => { p.config.filters.rules[1].rules[0].id = 'first' }, p => { p.config.filters.operator = 'xor' },
    p => { p.config.visibleFieldIds = ['status', 'status'] }, p => { p.config.fieldOrder = ['__unknown__'] },
    p => { p.config.sorts[0].direction = 'up' }, p => { p.config.columnWidths.status = 160.5 },
    p => { p.config.columnWidths.status = 79 }, p => { p.config.columnWidths.status = 1201 },
    p => { p.config.filters.rules[0].value = { nested: 'value' } }, p => { p.config.query = '中'.repeat(50_000) },
  ]
  for (const mutate of mutations) {
    const payload = structuredClone(value()) as Record<string, any>
    mutate(payload)
    assert.throws(() => parseDatabaseViewPayload(JSON.stringify(payload)))
  }
  assert.throws(() => parseDatabaseViewPayload(serializeDatabaseViewPayload(value()).replace('"version":1', '"version":1,"version":1')), /JSON/)
})

test('database-view bounds group depth and total rules independently of JSON size', () => {
  const config = value().config
  let filters = { operator: 'and', rules: [] } as typeof config.filters
  for (let index = 0; index < 8; index++) filters = { operator: 'and', rules: [filters] }
  assert.throws(() => validateDatabaseViewConfig({ ...config, filters }))
  const rules = Array.from({ length: 257 }, (_, index) => ({ id: `rule-${index}`, fieldId: 'status', operator: 'equals' as const, value: false }))
  assert.throws(() => validateDatabaseViewConfig({ ...config, filters: { operator: 'and', rules } }))
  assert.equal(validateDatabaseViewConfig({ ...config, filters: { operator: 'and', rules: rules.slice(0, 256) } }).filters.rules.length, 256)
})

test('database-view atom forbids list/code/container attributes without inventing source objects', () => {
  const atom = { type: 'database-view', content: serializeDatabaseViewPayload(value()), checked: false }
  validateDatabaseViewBlock(atom)
  for (const extra of [{ checked: true }, { language: 'json' }, { listStart: 1 }, { markdownFormat: {} }, { type: ' database-view' }]) {
    assert.throws(() => validateDatabaseViewBlock({ ...atom, ...extra }))
  }
  const missing = value(); missing.databaseId = 'missing-exact-source'; missing.viewId = 'missing-exact-view'
  assert.deepEqual(parseDatabaseViewPayload(serializeDatabaseViewPayload(missing)), missing)
})

test('reference mapping covers every field position once and leaves data strings opaque', () => {
  const original = value(), calls = new Map<string, number>()
  const mapped = mapDatabaseViewReferences(original, { databaseId: () => 'restored-db', viewId: (source, view) => {
    assert.equal(source, 'source-db'); assert.equal(view, 'source-view'); return 'restored-view'
  }, fieldId: (source, field) => {
    assert.equal(source, 'source-db'); calls.set(field, (calls.get(field) ?? 0) + 1)
    return field.startsWith('__') ? field : `restored-${field}`
  } })
  assert.deepEqual(collectDatabaseViewFieldIds(mapped), new Set(['restored-status', 'restored-date', '__title__']))
  assert.deepEqual([...calls.values()], [1, 1, 1])
  assert.equal(mapped.config.query, original.config.query)
  assert.equal((mapped.config.filters.rules[0] as { value: unknown }).value, 'status')
  assert.equal(mapped.databaseId, 'restored-db'); assert.equal(mapped.viewId, 'restored-view')
  assert.deepEqual(mapped.config.columnWidths, { 'restored-status': 160 })
  assert.deepEqual(value(), original)
})

test('mapping refuses identity collisions, system-field changes and unresolved callbacks', () => {
  const original = value()
  assert.throws(() => mapDatabaseViewReferences(original, { databaseId: () => undefined as unknown as string }))
  assert.throws(() => mapDatabaseViewConfigFieldIds(original.config, () => 'same-target'))
  assert.throws(() => mapDatabaseViewConfigFieldIds(original.config, field => field === '__title__' ? 'other-title' : field))
  const missing = { ...original, viewId: null }
  assert.equal(mapDatabaseViewReferences(missing, { viewId: () => { throw new Error('null must stay null') } }).viewId, null)
})
