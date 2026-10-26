import assert from 'node:assert/strict'
import test from 'node:test'
import { capsule2ApplicationColumns, type Capsule2Encoding, type Capsule2RawSqlTable } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { graph3Encode, graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { checkMerge3NativeStorage3 } from '../src/main/database/restore-knowledge-merge3-native'
import { MERGE3_CONTENT_TABLES, finishMerge3Table, prepareMerge3Table, type Merge3ContentTable,
  type Merge3Material } from '../src/main/database/restore-knowledge-merge3-storage'
import type { RawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'

const id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0')
const digest = (n: number) => n.toString(16).padStart(64, '0')
function material(side: 'source' | 'current'): Merge3Material {
  const n = side === 'source' ? 1 : 2
  return { payload: digest(n), materialHash: digest(n + 10), witness: { domain: [], side, projectionHash: digest(n + 20),
    capsule: { kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace: { kind: 'native' }, operationId: id(n), capsuleId: id(n + 10),
      manifestHash: digest(n + 30), readerVersion: 'knowbook-durable-sql-coverage-v2' } } }
}
function columns(name: Merge3ContentTable) {
  const ordinary = capsule2ApplicationColumns().get(name)
  if (ordinary) return [...ordinary]
  if (name === 'synced_groups') return ['id', 'creation_id', 'created_at', 'origin_json', 'bindings_json', 'revision', 'topology_revision', 'history_cursor', 'history_position']
  if (name === 'synced_instances') return ['instance_id', 'group_id', 'host_document_id', 'binding_version', 'parent_block_id', 'depth']
  return ['id', 'group_id', 'parent_block_id', 'sort_order', 'type', 'content', 'checked', 'depth', 'tags_json', 'language', 'list_start', 'markdown_format_json', 'highlight', 'created_at']
}
type Values = Partial<Record<Merge3ContentTable, Array<Record<string, string | null>>>>
/** Collation-only synthetic tables. They are never supplied to Main as source
 * records and do not claim full physical/catalog or installation validation. */
function tables(values: Values, encoding: Capsule2Encoding = 'UTF-8') {
  return MERGE3_CONTENT_TABLES.map(name => {
    const names = columns(name), pk = name === 'database_entity_values' ? ['entity_id', 'column_id']
      : name === 'document_database_values' ? ['document_id', 'column_id'] : [name === 'synced_instances' ? 'instance_id' : 'id']
    const source: Capsule2RawSqlTable = { name, role: 'content', columns: names, primaryKey: pk,
      rows: (values[name] ?? []).map((row, index) => ({ sourceRowId: String(index + 1), cells: names.map(column => {
        const value = row[column] ?? null
        return value === null ? ['null'] : graph3Encode(value, encoding)
      }) as RawRestoreSqlCell[] })) }
    const p = prepareMerge3Table({ sourceOriginal: source, sourceCandidate: source, currentOriginal: { ...source, rows: [] },
      sourceEncoding: encoding, currentEncoding: encoding, source: material('source'), current: material('current') })
    const choices = p.sourceRows.map(row => ({ rowKey: row.key, replaceCurrentRowKey: null }))
    return finishMerge3Table(p, choices, p.sourceRows.map(row => ({ rowKey: row.key, status: 'selected', decision: 'native-collation-only-fixture' }))).table
  })
}

test('merge3 native SQLite retains real NOCASE NUL ASCII semantics and exact duplicate membership in all target encodings', () => {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const) {
    const input = tables({ database_saved_views: [
      { id: 'first', database_id: 'db', name: 'Alpha\0one' }, { id: 'second', database_id: 'db', name: 'aLPHA\0two' },
      { id: 'unicode upper', database_id: 'db', name: 'Ä' }, { id: 'unicode lower', database_id: 'db', name: 'ä' },
      { id: 'other owner', database_id: 'other-db', name: 'Alpha\0one' }, { id: 'different length', database_id: 'db', name: 'ALPHA\0xx' },
      { id: 'binary owner one', database_id: 'db\0one', name: 'Same' }, { id: 'binary owner two', database_id: 'db\0two', name: 'same' }
    ] }, encoding)
    const value = checkMerge3NativeStorage3(input), conflict = value.conflicts.filter(item => item.code === 'native-nocase-saved-view-name-duplicate')
    const views = input.find(table => table.name === 'database_saved_views')!
    const keys = views.rows.filter(row => ['first', 'second'].includes(graph3Text(row.cells[views.columns.indexOf('id')], encoding))).map(row => row.key)
    assert.equal(conflict.length, 1); assert.deepEqual(conflict[0].rowKeys, keys); assert.equal(conflict[0].detail.count, 2)
    assert.equal(value.targetEncoding, encoding); assert.equal(value.comparisonRows, 16)
    assert.equal(value.stagingDatabase, false); assert.equal(value.sourceSqlRead, false)
    assert.equal(value.foreignKeysValidated, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
    assert.deepEqual(checkMerge3NativeStorage3(structuredClone(input)), value)
  }
})

test('merge3 native BINARY slug and entity-document checks leave NULL values and distinct owner suffixes independent', () => {
  const input = tables({
    documents: [{ id: 'one', slug: 'x\0a' }, { id: 'two', slug: 'x\0b' }, { id: 'three', slug: 'same' }, { id: 'four', slug: 'same' }],
    database_entities: [
      { id: 'one', database_id: 'db', document_id: null }, { id: 'two', database_id: 'db', document_id: null },
      { id: 'three', database_id: 'db', document_id: 'x\0a' }, { id: 'four', database_id: 'db', document_id: 'x\0a' },
      { id: 'five', database_id: 'db', document_id: 'x\0b' }, { id: 'six', database_id: 'other-db', document_id: 'x\0a' }
    ], document_database_values: [{ document_id: null, column_id: 'field' }, { document_id: null, column_id: 'field' }]
  })
  const value = checkMerge3NativeStorage3(input)
  assert.deepEqual(value.conflicts.map(item => item.code).sort(), ['native-binary-document-slug-duplicate', 'native-binary-database-document-duplicate'].sort())
  assert.equal(value.conflicts.every(item => item.rowKeys.length === 2 && item.detail.count === 2), true)
  assert.equal(value.checks.find(check => check.rule === 'document_database_values:primary-key')!.nullKeyRowsSkipped, 2)
  assert.equal(value.checks.find(check => check.rule === 'database_entities:database-document')!.nullKeyRowsSkipped, 2)
})

test('merge3 native refuses missing fixed tables and descriptor getters without evaluating caller properties', () => {
  const input = tables({})
  assert.throws(() => checkMerge3NativeStorage3(input.slice(1)), /twelve/)
  let calls = 0
  const fake = Object.defineProperty({ ...input[0] }, 'name', { enumerable: true, get() { calls++; return input[0].name } })
  assert.throws(() => checkMerge3NativeStorage3([fake, ...input.slice(1)]))
  assert.equal(calls, 0)
})

test('merge3 native checks nested original metadata descriptors before JSON serialization or SQLite work', () => {
  const original = tables({ documents: [{ id: 'one', slug: 'one' }] })
  for (const property of ['payload', 'toJSON']) {
    const input = structuredClone(original), document = input.find(table => table.name === 'documents')!
    let calls = 0
    Object.defineProperty(document.rows[0].sourceRef, property, { enumerable: true, get() { calls++; throw new Error('metadata getter ran') } })
    assert.throws(() => checkMerge3NativeStorage3(input), /访问器|data/)
    assert.equal(calls, 0)
  }
})
