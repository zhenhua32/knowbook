import assert from 'node:assert/strict'
import test from 'node:test'
import { capsule2ApplicationColumns, type Capsule2RawSqlTable } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { graph3Encode, graph3Key, type Graph3Inputs } from '../src/main/database/restore-knowledge-graph3-data'
import { deriveRootRestoreNavigationMergeContext3, buildMerge3NavigationFinalIndex3, resolveFinalNavigation3 } from '../src/main/database/restore-knowledge-navigation3-merge-context'
import { finishMerge3Table, prepareMerge3Table, type Merge3Material } from '../src/main/database/restore-knowledge-merge3-storage'
import type { deriveRootRestoreMergedContent3 } from '../src/main/database/restore-knowledge-merge3-model'
import type { RawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'

// These are small pure syntax/projection fixtures, never Main handles, certified
// SQL material, a restore owner or a permission to write a database.
const born = '2030-01-02T03:04:05.000Z'
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const digest = (n: number) => String(n).padStart(64, '0')
function meta(side: 'source' | 'current'): Merge3Material {
  const n = side === 'source' ? 1 : 2
  return { payload: digest(n), materialHash: digest(n + 2), witness: { domain: [], side, projectionHash: digest(n + 4),
    capsule: { kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace: { kind: 'native' },
      operationId: id(n), capsuleId: id(n + 2), manifestHash: digest(n + 6), readerVersion: 'knowbook-durable-sql-coverage-v2' } } }
}
type Value = Record<string, string | bigint | null>
const columns = capsule2ApplicationColumns()
const groupColumns = ['id', 'creation_id', 'created_at', 'origin_json', 'bindings_json', 'revision', 'topology_revision', 'history_cursor', 'history_position']
const canonicalColumns = ['id', 'group_id', 'parent_block_id', 'sort_order', 'type', 'content', 'checked', 'depth', 'tags_json', 'language', 'list_start', 'markdown_format_json', 'highlight', 'created_at']
const instanceColumns = ['instance_id', 'group_id', 'host_document_id', 'binding_version', 'parent_block_id', 'depth']
function table(name: string, values: Value[]): Capsule2RawSqlTable {
  const fields = columns.get(name) ?? (name === 'synced_groups' ? groupColumns : name === 'synced_group_blocks' ? canonicalColumns : instanceColumns)
  return { name, role: name === 'document_block_routes' ? 'identity-evidence' : 'content', columns: fields,
    primaryKey: name === 'document_block_routes' ? ['document_path', 'block_id'] : [name === 'synced_instances' ? 'instance_id' : 'id'],
    rows: values.map((value, index) => ({ sourceRowId: String(index + 1), cells: fields.map(name => {
      const cell = value[name] ?? null
      return cell === null ? ['null'] : typeof cell === 'bigint' ? ['integer', String(cell)] : graph3Encode(cell, 'UTF-8')
    }) as RawRestoreSqlCell[] })) }
}
const doc = (key: string, title: string, path: string, summary = ''): Value => ({ id: key, title, path, summary, slug: 'doc-' + key,
  parent_id: null, sort_order: 0n, block_count: 0n, child_count: 0n, link_count: 0n, created_at: born, updated_at: born })
const block = (key: string, document: string, content: string, type = 'paragraph', order = 0): Value => ({ id: key,
  document_id: document, content, type, parent_block_id: null, depth: 0n, checked: 0n, sort_order: BigInt(order), tags_json: '[]',
  language: null, list_start: null, markdown_format_json: null, highlight: null, created_at: born, updated_at: born })
const syntax = (value: Value) => ({ id: String(value.id), type: String(value.type), content: String(value.content), checked: false, depth: 0, parentBlockId: null, tags: [] })
function fixture(repeated = false) {
  const source = meta('source'), current = meta('current'), g = id(20), first = id(21), second = id(22)
  const ordinaryLink = '[document](/BeforeCurrent.md) [removed](/BeforeCurrent.md#^removed) [heading](/BeforeCurrent.md#old-heading)'
  const sourceBlocks = repeated ? [block(first, 'd', JSON.stringify({ version: 1, groupId: g }), 'synced-block'),
    block(second, 'd', JSON.stringify({ version: 1, groupId: g }), 'synced-block', 1)] : [block('h', 'd', 'New heading', 'heading-1')]
  const currentBlocks = repeated ? sourceBlocks : [block('h', 'd', 'Old heading', 'heading-1'), block('removed', 'd', 'Removed current-only child', 'paragraph', 1)]
  const retained = block('retained', 'r', ordinaryLink)
  const origin = { version: 1, documentId: 'd', pathAtCreation: 'Source literal', firstInstanceId: first }
  const group: Value = { id: g, creation_id: id(23), created_at: born, origin_json: JSON.stringify(origin), bindings_json: '[]',
    revision: id(24), topology_revision: id(25), history_cursor: id(26), history_position: 0n }
  const { document_id: _owner, updated_at: _updated, ...canonical } = block('canonical-heading', '', 'Echo', 'heading-1')
  const canonicalRow: Value = { ...canonical, group_id: g }
  const instances = [first, second].map(instance => ({ instance_id: instance, group_id: g, host_document_id: 'd',
    binding_version: id(30), parent_block_id: null, depth: 0n }))
  const names = ['documents', 'blocks', 'synced_groups', 'synced_group_blocks', 'synced_instances'] as const
  const sourceTables = [table('documents', [doc('d', 'Restored', 'Source literal', repeated ? '[second](#echo-1)' : '[self](#new-heading)')]), table('blocks', sourceBlocks),
    table('synced_groups', repeated ? [group] : []), table('synced_group_blocks', repeated ? [canonicalRow] : []), table('synced_instances', repeated ? instances : []), table('document_block_routes', [])]
  const currentTables = [table('documents', [doc('d', 'Current', 'BeforeCurrent'), doc('r', 'BeforeCurrent', 'Retained')]), table('blocks', [...currentBlocks, retained]),
    table('synced_groups', repeated ? [group] : []), table('synced_group_blocks', repeated ? [canonicalRow] : []), table('synced_instances', repeated ? instances : []), table('document_block_routes', [])]
  const physicalDoc = (value: Value, blocks: Value[]) => ({ documentId: value.id, title: value.title, path: value.path, summary: value.summary,
    parentId: null, sortOrder: 0, createdAt: born, updatedAt: born, births: blocks.map(block => [block.id, born]), blocks: blocks.map(syntax) })
  const groupFact = { groupId: g, absence: null, lifecycle: null, snapshot: { groupId: g, creationId: id(23), createdAt: born,
    origin, bindings: [], blocks: [{ ...syntax(canonicalRow), createdAt: born }] } }
  const assignments = [
    { kind: 'document', sourceId: 'd', targetId: 'd', birth: born, physical: true, ambiguous: false, ownerKind: null, ownerId: null },
    ...sourceBlocks.map(row => ({ kind: 'block', sourceId: row.id, targetId: row.id, birth: born, physical: true, ambiguous: false, ownerKind: 'document', ownerId: 'd' })),
    ...(repeated ? [{ kind: 'group', sourceId: g, targetId: g, birth: born, physical: true, ambiguous: false, ownerKind: null, ownerId: null },
      { kind: 'block', sourceId: canonicalRow.id, targetId: canonicalRow.id, birth: born, physical: true, ambiguous: false, ownerKind: 'group', ownerId: g }] : [])
  ].map(assignment => ({ ...assignment, key: graph3Key('pure-fixture-assignment', assignment.kind, assignment.sourceId, assignment.birth) }))
  const knowledge = { groups: repeated ? [{ tuple: { groupId: g, creationId: id(23), createdAt: born, origin }, comparisonKey: digest(20) }] : [] }
  const data = { value: { assignments, sourceWitness: source.witness, sourcePayload: source.payload, allocationHash: digest(30) },
    inputs: { source: { materialHash: source.materialHash, knowledge, source: { sourceContent: { encoding: 'UTF-8', tables: sourceTables },
      physical: { documents: [physicalDoc(doc('d', 'Restored', 'Source literal', repeated ? '[second](#echo-1)' : '[self](#new-heading)'), sourceBlocks)], groups: repeated ? [groupFact] : [],
        instances: repeated ? instances : [] } } },
    current: { materialHash: current.materialHash, knowledge, source: { sourceContent: { encoding: 'UTF-8', tables: currentTables },
      physical: { documents: [physicalDoc(doc('d', 'Current', 'BeforeCurrent'), currentBlocks), physicalDoc(doc('r', 'BeforeCurrent', 'Retained'), [retained])],
        groups: repeated ? [groupFact] : [], instances: repeated ? instances : [] } } },
    knowledge: { conservationHash: digest(31), constraints: { root: { kind: 'restore-knowledge-origin-root-ref', version: 1, namespace: { kind: 'native' },
      operationId: id(40), dagId: id(41), rootHash: digest(42), readerVersion: 'knowbook-required-sql-knowledge-dag-v2' },
      payloads: [{ key: source.payload, witness: source.witness }, { key: current.payload, witness: current.witness }] } } } } as unknown as Graph3Inputs
  const finished = names.map(name => {
    const sourceOriginal = sourceTables.find(table => table.name === name)!, currentOriginal = currentTables.find(table => table.name === name)!
    const p = prepareMerge3Table({ sourceOriginal, sourceCandidate: sourceOriginal, currentOriginal,
      sourceEncoding: 'UTF-8', currentEncoding: 'UTF-8', source, current })
    const incomingIds = new Set(p.sourceRows.map(row => row.primaryKeyCells && JSON.stringify(row.primaryKeyCells)))
    const selected = p.sourceRows.map(row => ({ rowKey: row.key,
      replaceCurrentRowKey: p.currentRows.find(old => JSON.stringify(old.primaryKeyCells) === JSON.stringify(row.primaryKeyCells))?.key ?? null }))
    for (const row of p.currentRows) if (!incomingIds.has(row.primaryKeyCells && JSON.stringify(row.primaryKeyCells))
      && !(name === 'blocks' && row.ref.sourceRowId !== String(currentBlocks.length + 1))) selected.push({ rowKey: row.key, replaceCurrentRowKey: null })
    const chosen = new Set(selected.map(row => row.rowKey))
    return finishMerge3Table(p, selected, [...p.sourceRows, ...p.currentRows].map(row => ({ rowKey: row.key,
      status: chosen.has(row.key) ? 'selected' : 'replaced', decision: 'pure-explicit-fixture-selection' })))
  })
  const tables = finished.map(value => value.table.name !== 'documents' ? value.table : { ...value.table,
    rows: value.table.rows.map(row => ({ ...row, cells: row.cells.map((cell, index) => value.table.columns[index] === 'path'
      ? graph3Encode(row.sourceRef.side === 'source' ? 'Restored' : 'BeforeCurrent', 'UTF-8') : cell) })) })
  const merged = { tables, mergedContentHash: digest(50) } as unknown as ReturnType<typeof deriveRootRestoreMergedContent3>
  return { data, merged, first, second }
}

test('navigation merge context preserves source/current birth evidence and maps retained links before final path lookup', () => {
  const { data, merged } = fixture(), value = deriveRootRestoreNavigationMergeContext3(data, merged)
  const retained = value.scopes.find(scope => scope.side === 'current' && scope.document.id === 'r' && scope.field === 'body')!
  assert.equal(retained.finalDocumentId, 'r')
  assert.equal(retained.blocks[0].cell?.sourceRef.side, 'current')
  assert.equal(retained.blocks[0].finalOccurrenceKey, graph3Key(null, 'retained'))
  const [document, removed, heading] = retained.destinations
  assert.deepEqual(document.finalTarget, { kind: 'document', documentId: 'd', documentPath: 'Restored' })
  assert.equal(removed.finalTarget.kind, 'unresolved')
  assert.deepEqual(heading.finalTarget, { kind: 'heading', documentId: 'd', documentPath: 'Restored', headingKey: graph3Key(null, 'h') + ':0', slug: 'new-heading' })
  assert.deepEqual(resolveFinalNavigation3(value.final, 'r', '/BeforeCurrent.md', false), { kind: 'document', documentId: 'r', documentPath: 'BeforeCurrent' })
  const overwritten = value.scopes.find(scope => scope.side === 'current' && scope.document.id === 'd' && scope.field === 'body')!
  assert.equal(overwritten.finalDocumentId, 'd')
  assert.equal(overwritten.blocks.every(block => block.cell === null && block.finalOccurrenceKey === null), true, 'replaces proves a target incarnation, not ownership of replaced body bytes')
  assert.equal(value.current.scopes[0].document.assignmentKey, null)
  assert.equal(typeof value.source.scopes[0].document.assignmentKey, 'string')
  assert.equal(value.permit, false)
})

test('navigation merge final syntax keeps canonical heading occurrences distinct and does not validate obsolete wire binding ranges', () => {
  const { data, merged, first, second } = fixture(true), value = deriveRootRestoreNavigationMergeContext3(data, merged)
  const namespace = value.final.headingNamespaces.find(namespace => namespace.document.id === 'd')!
  const headings = namespace.headings.filter(heading => heading.location?.blockId === 'canonical-heading')
  assert.deepEqual(headings.map(heading => heading.slug), ['echo', 'echo-1'])
  assert.deepEqual(headings.map(heading => heading.location?.instanceId), [first, second])
  assert.notEqual(headings[0].key, headings[1].key)
  assert.equal(headings[0].location?.blockBirth, born)
  assert.equal(headings[1].location?.instanceBirth, born)
  const summary = value.scopes.find(scope => scope.side === 'source' && scope.document.id === 'd' && scope.field === 'summary')!
  assert.deepEqual(summary.destinations[0].finalTarget, { kind: 'heading', documentId: 'd', documentPath: 'Restored', headingKey: headings[1].key, slug: 'echo-1' })
  assert.equal(value.final.bindingsValidated, false)
  const changed = merged.tables.map(table => table.name !== 'synced_groups' ? table : { ...table, rows: table.rows.map(row => ({ ...row,
    cells: row.cells.map((cell, index) => table.columns[index] === 'bindings_json' ? graph3Encode('[{"obsolete":"not a binding"}]', table.encoding) : cell) })) })
  assert.doesNotThrow(() => buildMerge3NavigationFinalIndex3(data, changed), 'Final syntax does not authenticate or repair historical binding DTOs')
})

test('navigation final resolver keeps removed caret targets missing and rejects a changed physical birth', () => {
  const { data, merged } = fixture(), index = buildMerge3NavigationFinalIndex3(data, merged.tables)
  assert.equal(resolveFinalNavigation3(index, 'r', '/Restored.md#^removed', false).kind, 'unresolved')
  assert.equal(resolveFinalNavigation3(index, 'r', 'removed', true).kind, 'unresolved')
  assert.equal(resolveFinalNavigation3(index, 'r', 'https://example.test/', false).kind, 'opaque')
  assert.equal(resolveFinalNavigation3(index, 'r', '/Restored.md#new-heading', false).kind, 'heading')
  const broken = structuredClone(merged.tables)
  const blocks = broken.find(table => table.name === 'blocks')!, birth = blocks.columns.indexOf('created_at')
  Reflect.set(blocks.rows[0].cells, birth, graph3Encode('2040-01-02T03:04:05.000Z', blocks.encoding))
  assert.throws(() => buildMerge3NavigationFinalIndex3(data, broken), /identity-or-birth/)
})
