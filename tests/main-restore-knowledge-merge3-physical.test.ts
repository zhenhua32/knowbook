import assert from 'node:assert/strict'
import test from 'node:test'
import { capsule2ApplicationColumns, type Capsule2RawSqlTable } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { graph3Encode, type Graph3Inputs } from '../src/main/database/restore-knowledge-graph3-data'
import { MERGE3_PHYSICAL_TABLES, selectMerge3PhysicalRows3, type Merge3PhysicalTable } from '../src/main/database/restore-knowledge-merge3-physical'
import { finishMerge3Table, prepareMerge3Table, type Merge3Material } from '../src/main/database/restore-knowledge-merge3-storage'
import type { RawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'

const id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0')
const hash = (n: number) => n.toString(16).padStart(64, '0')
const at = '2030-01-02T03:04:05.000Z', groupId = id(20), instanceId = id(30)
type Values = Record<string, string | number | null>
type Rows = Record<Merge3PhysicalTable, Values[]>
const empty = (): Rows => ({ documents: [], blocks: [], synced_groups: [], synced_group_blocks: [], synced_instances: [] })
const document = (name: string): Values => ({ id: name, parent_id: null, title: name, path: name, slug: 'doc-' + name,
  summary: '', sort_order: 0, created_at: at, updated_at: at })
const block = (name: string, owner: string, content = name, depth = 0, parent: string | null = null, type = 'paragraph'): Values => ({
  id: name, document_id: owner, parent_block_id: parent, sort_order: depth, type, content, checked: 0, depth,
  tags_json: '[]', language: null, list_start: null, markdown_format_json: null, highlight: null, created_at: at, updated_at: at })
const canonical = (name: string, depth = 0, parent: string | null = null, type = 'paragraph'): Values => {
  const { document_id: _owner, updated_at: _updated, ...value } = block(name, '', name, depth, parent, type)
  return { ...value, group_id: groupId, tags_json: null }
}
const group = (): Values => ({ id: groupId, creation_id: id(21), created_at: at,
  origin_json: JSON.stringify({ version: 1, documentId: 'restored', pathAtCreation: 'Original path', firstInstanceId: instanceId }),
  bindings_json: ' [ ] ', revision: id(22), topology_revision: id(23), history_cursor: id(24), history_position: 0 })
const registry = (host: string, depth = 0, parent: string | null = null): Values => ({ instance_id: instanceId,
  group_id: groupId, host_document_id: host, depth, parent_block_id: parent, binding_version: id(31) })
function columns(name: Merge3PhysicalTable) {
  const ordinary = capsule2ApplicationColumns().get(name)
  if (ordinary) return [...ordinary]
  if (name === 'synced_groups') return ['id', 'creation_id', 'created_at', 'origin_json', 'bindings_json', 'revision', 'topology_revision', 'history_cursor', 'history_position']
  if (name === 'synced_instances') return ['instance_id', 'group_id', 'host_document_id', 'binding_version', 'parent_block_id', 'depth']
  return ['id', 'group_id', 'parent_block_id', 'sort_order', 'type', 'content', 'checked', 'depth', 'tags_json', 'language', 'list_start', 'markdown_format_json', 'highlight', 'created_at']
}
function table(name: Merge3PhysicalTable, values: Values[], side: 'source' | 'current'): Capsule2RawSqlTable {
  const names = columns(name)
  return { name, role: 'content', columns: names, primaryKey: [name === 'synced_instances' ? 'instance_id' : 'id'],
    rows: values.map((value, index) => ({ sourceRowId: String(index + (side === 'source' ? 1 : 100)), cells: names.map(name => {
      const cell = value[name] ?? null
      return cell === null ? ['null'] : typeof cell === 'number' ? ['integer', String(cell)] : graph3Encode(cell, 'UTF-8')
    }) as RawRestoreSqlCell[] })) }
}
function material(side: 'source' | 'current'): Merge3Material {
  const n = side === 'source' ? 1 : 2
  return { payload: hash(n), materialHash: hash(n + 10), witness: { domain: [], side, projectionHash: hash(n + 20),
    capsule: { kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace: { kind: 'native' }, operationId: id(n), capsuleId: id(n + 10),
      manifestHash: hash(n + 30), readerVersion: 'knowbook-durable-sql-coverage-v2' } } }
}
/** Synthetic pure-model data only. No DTO below is passed to a Main factory
 * or advertised as a certified original, physical SQL reader or install plan. */
function fixture(sourceRows: Rows, currentRows: Rows, inactive = false) {
  const source = material('source'), current = material('current')
  const sourceTables = MERGE3_PHYSICAL_TABLES.map(name => table(name, sourceRows[name], 'source'))
  const currentTables = MERGE3_PHYSICAL_TABLES.map(name => table(name, currentRows[name], 'current'))
  const assignments = (['documents', 'blocks', 'synced_groups', 'synced_group_blocks'] as const).flatMap(name => sourceRows[name].map(row => ({
    kind: name === 'documents' ? 'document' : name === 'synced_groups' ? 'group' : 'block', sourceId: row.id,
    targetId: row.id, targetCreationId: name === 'synced_groups' ? row.creation_id : null, birth: row.created_at,
    physical: true, ambiguous: false, ownerKind: name === 'blocks' ? 'document' : name === 'synced_group_blocks' ? 'group' : null,
    ownerId: name === 'blocks' ? row.document_id : name === 'synced_group_blocks' ? row.group_id : null,
    incarnation: name === 'synced_groups' ? hash(50) : null })))
  const facts = (rows: Rows, side: 'source' | 'current') => ({ documents: rows.documents.map(row => ({ documentId: row.id, createdAt: row.created_at })),
    groups: rows.synced_groups.map(row => ({ groupId: row.id, lifecycle: null,
      snapshot: side === 'source' && inactive ? null : {}, absence: side === 'source' && inactive ? 'retired-create' : null })) })
  const data = { value: { assignments }, inputs: {
    source: { materialHash: source.materialHash, knowledge: { groups: sourceRows.synced_groups.map(row => ({ tuple: { groupId: row.id }, comparisonKey: hash(50) })) },
      source: { sourceContent: { encoding: 'UTF-8', tables: sourceTables }, physical: facts(sourceRows, 'source') } },
    current: { materialHash: current.materialHash, source: { sourceContent: { encoding: 'UTF-8', tables: currentTables }, physical: facts(currentRows, 'current') } },
    knowledge: { constraints: { payloads: [{ key: source.payload, witness: source.witness }, { key: current.payload, witness: current.witness }] } }
  } } as unknown as Graph3Inputs
  const prepared = sourceTables.map((sourceOriginal, index) => prepareMerge3Table({ sourceOriginal, sourceCandidate: sourceOriginal,
    currentOriginal: currentTables[index], sourceEncoding: 'UTF-8', currentEncoding: 'UTF-8', source, current }))
  return { data, prepared, run: () => selectMerge3PhysicalRows3(data, prepared) }
}

test('merge3 physical whole-forest selection replaces unmatched current children and retains unrelated hosts and orphan groups', () => {
  const source = empty(), current = empty()
  source.documents = [document('restored')]; source.blocks = [block('incoming child', 'restored')]
  current.documents = [document('restored'), document('retained')]
  current.blocks = [block('old removed child', 'restored'), block('untouched child', 'retained')]
  current.synced_groups = [group()]; current.synced_group_blocks = [canonical('orphan child')]
  const f = fixture(source, current), value = f.run()
  assert.equal(value.physicalShapeValidated, true); assert.deepEqual(value.conflicts, [])
  const blocks = value.tables.find(table => table.name === 'blocks')!, prepared = f.prepared.find(table => table.name === 'blocks')!
  assert.equal(blocks.dispositions.find(row => row.rowKey === prepared.currentRows[0].key)?.status, 'replaced')
  assert.equal(blocks.selectedRows.some(row => row.rowKey === prepared.currentRows[0].key), false)
  const finished = value.tables.map(choice => finishMerge3Table(f.prepared.find(table => table.name === choice.name)!, choice.selectedRows, choice.dispositions))
  const docs = finished.find(table => table.table.name === 'documents')!.table.rows
  assert.equal(docs.find(row => row.sourceRef.side === 'source')!.targetRowId, '100')
  const orphan = finished.find(table => table.table.name === 'synced_groups')!.table.rows[0]
  assert.equal(orphan.sourceRef.side, 'current'); assert.equal(orphan.targetRowId, '100')
  assert.equal(value.rewrittenBindingsValidated, false); assert.equal(value.permit, false)
})

test('merge3 physical retains inactive source evidence and conflicts when its selected header would strand a retained current host', () => {
  const source = empty(), current = empty()
  source.documents = [document('restored')]; source.synced_groups = [group()]
  current.documents = [document('retained')]; current.synced_groups = [group()]; current.synced_group_blocks = [canonical('current child')]
  current.blocks = [block(instanceId, 'retained', JSON.stringify({ version: 1, groupId }), 0, null, 'synced-block')]
  current.synced_instances = [registry('retained')]
  const f = fixture(source, current, true), value = f.run()
  assert.equal(value.physicalShapeValidated, false)
  assert.ok(value.conflicts.some(item => item.code === 'merged-reference-target-is-missing-or-inactive'))
  assert.equal(value.participatingGroups[0].active, false); assert.equal(value.participatingGroups[0].absence, 'retired-create')
  const canonicalChoice = value.tables.find(table => table.name === 'synced_group_blocks')!
  assert.deepEqual(canonicalChoice.selectedRows, []); assert.equal(canonicalChoice.dispositions[0].status, 'replaced')
  assert.equal(value.materializationDecisionsComplete, false)
})

test('merge3 physical does not claim a child PK in an unrelated retained current owner', () => {
  const source = empty(), current = empty()
  source.documents = [document('restored')]; source.blocks = [block('occupied child', 'restored')]
  current.documents = [document('retained')]; current.blocks = [block('occupied child', 'retained')]
  const f = fixture(source, current), value = f.run()
  const prepared = f.prepared.find(table => table.name === 'blocks')!, choice = value.tables.find(table => table.name === 'blocks')!
  assert.equal(choice.dispositions.find(row => row.rowKey === prepared.sourceRows[0].key)?.status, 'conflict')
  assert.equal(choice.dispositions.find(row => row.rowKey === prepared.currentRows[0].key)?.status, 'selected')
  assert.equal(choice.selectedRows.length, 1); assert.equal(choice.selectedRows[0].rowKey, prepared.currentRows[0].key)
  assert.equal(value.physicalShapeValidated, false)
  assert.ok(value.conflicts.some(item => item.code === 'incoming-physical-id-occupied-by-retained-current'))
})

test('merge3 physical checks a changed source canonical forest against retained host depth and exact instance registry mirrors', () => {
  const source = empty(), current = empty()
  source.synced_groups = [group()]; source.synced_group_blocks = [canonical('root', 0, null, 'callout'), canonical('child', 1, 'root')]
  current.documents = [document('retained')]; current.synced_groups = [group()]; current.synced_group_blocks = [canonical('old root')]
  current.blocks = Array.from({ length: 6 }, (_, index) => block('parent ' + index, 'retained', '', index, index ? 'parent ' + (index - 1) : null, 'callout'))
  current.blocks.push(block(instanceId, 'retained', JSON.stringify({ version: 1, groupId }), 6, 'parent 5', 'synced-block'))
  current.synced_instances = [registry('retained', 6, 'parent 5')]
  const value = fixture(source, current).run()
  assert.equal(value.physicalShapeValidated, false)
  assert.ok(value.conflicts.some(item => item.code === 'merged-canonical-expanded-depth'))
  current.synced_instances[0] = { ...current.synced_instances[0], depth: 5 }
  const badMirror = fixture(source, current).run()
  assert.ok(badMirror.conflicts.some(item => item.code === 'merged-instance-registry-mirror'))
})
