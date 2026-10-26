import assert from 'node:assert/strict'
import test from 'node:test'
import { capsule2ApplicationColumns, type Capsule2Encoding } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { graph3Encode, graph3Text, type Graph3Inputs } from '../src/main/database/restore-knowledge-graph3-data'
import { applyMerge3DocumentLayout3 } from '../src/main/database/restore-knowledge-merge3-layout'
import type { FinishedMerge3Table, MergedRow3 } from '../src/main/database/restore-knowledge-merge3-storage'

// Pure candidate layout fixtures. They never enter a Main reader or mint an
// original, identity, merge or installation owner.
type Table = FinishedMerge3Table['table']
const columns = capsule2ApplicationColumns()
function row(name: 'documents' | 'blocks', rowid: number, side: 'source' | 'current', value: Record<string, unknown>, encoding: Capsule2Encoding): MergedRow3 {
  const original: Record<string, unknown> = name === 'documents' ? { id: 'd-' + rowid, title: 'Document ' + rowid,
    slug: 'original-' + rowid, parent_id: null, path: 'Original ' + rowid, summary: '', sort_order: 0n,
    block_count: 0n, child_count: 0n, link_count: 9n, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...value }
    : { id: 'b-' + rowid, document_id: 'd-1', parent_block_id: null, sort_order: 0n, type: 'paragraph', content: 'Body', checked: 0n,
      depth: 0n, tags_json: '[]', language: null, list_start: null, markdown_format_json: null, highlight: null,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', ...value }
  return { key: side + '/' + name + '/' + rowid, targetRowId: String(rowid), replaces: null,
    cells: columns.get(name)!.map(column => {
      const cell = original[column]
      return cell === null ? ['null'] : typeof cell === 'bigint' ? ['integer', cell.toString()] : graph3Encode(String(cell), encoding)
    }), sourceRef: { side, table: name, sourceRowId: String(rowid), materialHash: 'a'.repeat(64), payload: 'b'.repeat(64),
      originalRowHash: 'c'.repeat(64), witness: { domain: [], side, projectionHash: 'd'.repeat(64),
        capsule: { kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace: { kind: 'native' },
          operationId: '10000000-0000-4000-8000-000000000001', capsuleId: '10000000-0000-4000-8000-000000000002',
          manifestHash: 'e'.repeat(64), readerVersion: 'knowbook-durable-sql-coverage-v2' } } } }
}
function table(name: 'documents' | 'blocks', rows: MergedRow3[], encoding: Capsule2Encoding): Table {
  return { name, role: 'content', columns: columns.get(name)!, primaryKey: ['id'], encoding, rows }
}
function data(current: Table): Graph3Inputs {
  return { inputs: { current: { source: { sourceContent: { encoding: current.encoding,
    tables: [{ name: current.name, role: current.role, columns: current.columns, primaryKey: current.primaryKey,
      rows: current.rows.map(row => ({ sourceRowId: row.targetRowId, cells: row.cells })) }] } } } } } as unknown as Graph3Inputs
}
function field(value: ReturnType<typeof applyMerge3DocumentLayout3>, id: string, column: string) {
  const documents = value.tables.find(table => table.name === 'documents')!
  const result = documents.rows.find(row => graph3Text(row.cells[documents.columns.indexOf('id')], documents.encoding) === id)!
  const cell = result.cells[documents.columns.indexOf(column)]
  return cell[0] === 'text' ? graph3Text(cell, documents.encoding) : cell[0] === 'integer' ? BigInt(cell[1]) : null
}

test('merge3 layout keeps the target slug and rowid while relocating retained descendants and rebuilding physical counts', () => {
  const encoding = 'UTF-16be', oldParent = row('documents', 1, 'current', { title: 'Old', path: 'Old', slug: 'stable-target-slug' }, encoding)
  const child = row('documents', 2, 'current', { title: 'Retained child', parent_id: 'd-1', path: 'Old/Retained child' }, encoding)
  const restored = { ...row('documents', 1, 'source', { title: 'Restored', path: 'literal old\0path', slug: 'incoming-old-slug' }, encoding), replaces: oldParent.sourceRef }
  const inserted = row('documents', 3, 'source', { title: 'A'.repeat(501) }, encoding)
  const actual = applyMerge3DocumentLayout3(data(table('documents', [oldParent, child], encoding)), [
    table('documents', [restored, child, inserted], encoding), table('blocks', [row('blocks', 4, 'current', { document_id: 'd-2' }, encoding)], encoding)
  ])
  assert.deepEqual(actual.conflicts, [])
  assert.equal(field(actual, 'd-1', 'slug'), 'stable-target-slug')
  assert.equal(field(actual, 'd-2', 'path'), 'Restored/Retained child')
  assert.equal(field(actual, 'd-1', 'child_count'), 1n)
  assert.equal(field(actual, 'd-2', 'block_count'), 1n)
  assert.equal(field(actual, 'd-2', 'link_count'), 9n, 'Link indexes await final navigation rewriting')
  assert.equal(field(actual, 'd-3', 'title'), 'A'.repeat(501))
  assert.equal(field(actual, 'd-3', 'slug'), 'doc-d-3')
  assert.equal(actual.tables[0].rows[1].targetRowId, child.targetRowId)
  assert.deepEqual(actual.tables[0].rows[1].sourceRef, child.sourceRef)
  assert.equal(actual.permit, false)
  assert.equal(actual.navigationRewritten, false)
})

test('merge3 layout reports path and slug collisions without silently changing restored or retained names', () => {
  const encoding = 'UTF-8', current = row('documents', 1, 'current', { title: 'Same', slug: 'doc-d-2' }, encoding)
  const incoming = row('documents', 2, 'source', { title: 'Same' }, encoding)
  const actual = applyMerge3DocumentLayout3(data(table('documents', [current], encoding)), [
    table('documents', [current, incoming], encoding), table('blocks', [], encoding)
  ])
  assert.deepEqual(actual.conflicts.map(value => value.code).sort(), ['duplicate-document-path', 'duplicate-document-slug'])
  assert.equal(field(actual, 'd-1', 'title'), 'Same')
  assert.equal(field(actual, 'd-2', 'title'), 'Same')
  assert.equal(actual.documentHierarchyLaidOut, false)
})

test('merge3 layout reports missing and cyclic document parents while retaining every selected row', () => {
  const encoding = 'UTF-8', rows = [row('documents', 1, 'current', { parent_id: 'd-2' }, encoding),
    row('documents', 2, 'current', { parent_id: 'd-1' }, encoding), row('documents', 3, 'current', { parent_id: 'missing' }, encoding)]
  const actual = applyMerge3DocumentLayout3(data(table('documents', rows, encoding)), [table('documents', rows, encoding), table('blocks', [], encoding)])
  assert.equal(actual.tables[0].rows.length, 3)
  assert.ok(actual.conflicts.some(value => value.code === 'missing-document-parent'))
  assert.ok(actual.conflicts.some(value => value.code === 'cyclic-or-unreachable-document-layout'))
})

test('merge3 layout iterates deep document trees and rejects cumulative target paths before exceeding the original value budget', () => {
  const make = (count: number) => Array.from({ length: count }, (_, index) => row('documents', index + 1, 'current',
    { title: 'node', parent_id: index ? 'd-' + index : null }, 'UTF-16le'))
  const rows = make(1000), documents = table('documents', rows, 'UTF-16le')
  const actual = applyMerge3DocumentLayout3(data(documents), [documents, table('blocks', [], 'UTF-16le')])
  assert.deepEqual(actual.conflicts, [])
  assert.equal(field(actual, 'd-1000', 'path'), Array(1000).fill('node').join('/'))
  const oversized = table('documents', make(4000), 'UTF-16le')
  assert.throws(() => applyMerge3DocumentLayout3(data(oversized), [oversized, table('blocks', [], 'UTF-16le')]), /complete-path-budget/)
})
