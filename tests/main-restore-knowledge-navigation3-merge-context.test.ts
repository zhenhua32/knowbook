import assert from 'node:assert/strict'
import test from 'node:test'
import { capsule2ApplicationColumns, type Capsule2Encoding, type Capsule2RawSqlTable } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { hashBoundedCapsuleJson } from '../src/main/database/restore-knowledge-capsule-json-hash'
import { markdownOriginalOffsetLookup } from '../src/shared/markdownNativeText'
import { deriveStage4AliasNavigation } from '../src/main/database/restore-knowledge-derived-stage4-observation'
import { graph3Encode, graph3Key, graph3Text, type Graph3Inputs } from '../src/main/database/restore-knowledge-graph3-data'
import { createNavigation3DocumentBlockReader, deriveRootRestoreNavigationMergeContext3, buildMerge3NavigationFinalIndex3, resolveFinalNavigation3,
  withStoredMerge3NavigationFinalIndex3, withStoredRootRestoreNavigationMergeContext3 } from '../src/main/database/restore-knowledge-navigation3-merge-context'
import { materializeNavigation3Tables, navigation3TableHashInput, projectNavigation3TableRows,
  withNavigation3TextPatches, withStoredNavigation3TableScan, withStoredNavigation3Tables } from '../src/main/database/restore-knowledge-navigation3-tables'
import { finishMerge3Table, prepareMerge3Table, type Merge3Material } from '../src/main/database/restore-knowledge-merge3-storage'
import type { deriveRootRestoreMergedContent3 } from '../src/main/database/restore-knowledge-merge3-model'
import { toReference3GraphInputs } from '../src/main/database/restore-knowledge-reference3-model'
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
function fixture(repeated = false, originalAccess?: { source: Capsule2Encoding; current: Capsule2Encoding }) {
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
  const sourceEncoding = originalAccess?.source ?? 'UTF-8', currentEncoding = originalAccess?.current ?? 'UTF-8'
  if (originalAccess) {
    currentTables[currentTables.length - 1] = table('document_block_routes',
      [{ document_path: 'Previous route 🍃', block_id: 'retained' }, { document_path: 'Removed route', block_id: 'removed' }])
    const extremes = ['-9223372036854775808', '-2', '9223372036854775807']
    for (const [tables, encoding] of [[sourceTables, sourceEncoding], [currentTables, currentEncoding]] as const) {
      for (const [index, original] of tables.entries()) {
        tables[index] = { ...original, rows: original.rows.map((row, ordinal) => ({
          sourceRowId: original.name === 'blocks' || original.name === 'document_block_routes' ? extremes[ordinal] : row.sourceRowId,
          cells: row.cells.map(cell => cell[0] === 'text' ? graph3Encode(graph3Text(cell, 'UTF-8'), encoding) : cell)
        })) }
      }
    }
  }
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
    inputs: { source: { materialHash: source.materialHash, knowledge, source: { sourceContent: { encoding: sourceEncoding, tables: sourceTables },
      physical: { documents: [physicalDoc(doc('d', 'Restored', 'Source literal', repeated ? '[second](#echo-1)' : '[self](#new-heading)'), sourceBlocks)], groups: repeated ? [groupFact] : [],
        instances: repeated ? instances : [] } } },
    current: { materialHash: current.materialHash, knowledge, source: { sourceContent: { encoding: currentEncoding, tables: currentTables },
      physical: { documents: [physicalDoc(doc('d', 'Current', 'BeforeCurrent'), currentBlocks), physicalDoc(doc('r', 'BeforeCurrent', 'Retained'), [retained])],
        groups: repeated ? [groupFact] : [], instances: repeated ? instances : [] } } },
    knowledge: { conservationHash: digest(31), constraints: { root: { kind: 'restore-knowledge-origin-root-ref', version: 1, namespace: { kind: 'native' },
      operationId: id(40), dagId: id(41), rootHash: digest(42), readerVersion: 'knowbook-required-sql-knowledge-dag-v2' },
      payloads: [{ key: source.payload, witness: source.witness }, { key: current.payload, witness: current.witness }] } } } } as unknown as Graph3Inputs
  const finished = names.map(name => {
    const sourceOriginal = sourceTables.find(table => table.name === name)!, currentOriginal = currentTables.find(table => table.name === name)!
    const p = prepareMerge3Table({ sourceOriginal, sourceCandidate: sourceOriginal, currentOriginal,
      sourceEncoding, currentEncoding, source, current })
    const incomingIds = new Set(p.sourceRows.map(row => row.primaryKeyCells && JSON.stringify(row.primaryKeyCells)))
    const selected = p.sourceRows.map(row => ({ rowKey: row.key,
      replaceCurrentRowKey: p.currentRows.find(old => JSON.stringify(old.primaryKeyCells) === JSON.stringify(row.primaryKeyCells))?.key ?? null }))
    for (const row of p.currentRows) if (!incomingIds.has(row.primaryKeyCells && JSON.stringify(row.primaryKeyCells))
      && !(name === 'blocks' && row.ref.sourceRowId !== currentOriginal.rows[currentBlocks.length].sourceRowId)) selected.push({ rowKey: row.key, replaceCurrentRowKey: null })
    const chosen = new Set(selected.map(row => row.rowKey))
    return finishMerge3Table(p, selected, [...p.sourceRows, ...p.currentRows].map(row => ({ rowKey: row.key,
      status: chosen.has(row.key) ? 'selected' : 'replaced', decision: 'pure-explicit-fixture-selection' })))
  })
  const tables = finished.map(value => value.table.name !== 'documents' ? value.table : { ...value.table,
    rows: value.table.rows.map(row => ({ ...row, cells: row.cells.map((cell, index) => value.table.columns[index] === 'path'
      ? graph3Encode(row.sourceRef.side === 'source' ? 'Restored' : 'BeforeCurrent', currentEncoding) : cell) })) })
  const merged = { tables, mergedContentHash: digest(50) } as unknown as ReturnType<typeof deriveRootRestoreMergedContent3>
  return { data, merged, first, second }
}

test('the SQLite scope index preserves the native navigation hash and yields every scope in original order', () => {
  const { data, merged } = fixture(true)
  const full = buildMerge3NavigationFinalIndex3(data, merged.tables)
  const locations = withStoredMerge3NavigationFinalIndex3(data, merged.tables, ({ scopes, scope, scopeCount, hashInput: _hashInput, physicalLocations, physicalBlock, ...metadata }) => {
    assert.equal(scopeCount, full.scopes.length)
    assert.deepEqual(physicalLocations, full.physicalBlocks.map(({ block: _body, ...location }) => location))
    for (const block of full.physicalBlocks) assert.deepEqual(physicalBlock(block.id), block)
    assert.equal(physicalBlock('unused'), undefined)
    assert.deepEqual({ ...metadata, scopes: [...scopes()] }, full)
    assert.deepEqual([...scopes()], full.scopes)
    assert.deepEqual(scope(full.scopes[0].scopeId), full.scopes[0])
    assert.equal(scope('unused'), undefined)
    return physicalLocations
  })
  const table = merged.tables.find(item => item.name === 'blocks')!
  const read = createNavigation3DocumentBlockReader({ ...table, rows: [...table.rows].reverse() }, locations)
  for (const document of full.documents) assert.deepEqual(read(document.id),
    full.physicalBlocks.filter(block => block.documentId === document.id).map(block => block.block))
  const wrongOwner = createNavigation3DocumentBlockReader({ ...table, rows: table.rows.map(row => ({ ...row,
    cells: row.cells.map((cell, index) => table.columns[index] === 'document_id' ? graph3Encode('wrong', table.encoding) : cell) })) }, locations)
  assert.throws(() => wrongOwner('d'), /navigation-final-document-block-owner/)
})

test('attachment alias navigation compares projected ranges and preserves the exact rewritten index and routes', () => {
  const { data, merged } = fixture(false, { source: 'UTF-16le', current: 'UTF-8' })
  const body = { kind: 'root-restore-reference-allocation', version: 1, policyVersion: 1, purposeVersion: 1,
    baseIdentityAllocationHash: data.value.allocationHash, conservationHash: data.inputs.knowledge.conservationHash,
    sourceMaterialHash: data.inputs.source.materialHash, currentMaterialHash: data.inputs.current.materialHash,
    assignments: data.value.assignments, execution: [] }
  const allocation = { ...body,
    derivedReferenceAllocationHash: capsuleBytesHash('knowbook.restore.reference3.allocation.v1\0' + capsuleJson(body))
  } as unknown as Parameters<typeof toReference3GraphInputs>[1]
  const graph = toReference3GraphInputs(data, allocation)
  const fromUri = 'file:///a.png', toUri = 'file:///new-attachments/a.png'
  const prefix = '😀\r\n\r\n![photo](<'
  const content = (uri: string, target: string) => `${prefix}${uri}>) [target](${target})`
  const blocks = merged.tables.find(item => item.name === 'blocks')!
  const column = blocks.columns.indexOf('content')
  const retained = blocks.rows.find(row => row.sourceRef.side === 'current')!
  const tables = (uri: string, target: string) => merged.tables.map(table => ({ ...table,
    rows: table.rows.map(row => row !== retained || table !== blocks ? row : { ...row,
      cells: row.cells.map((cell, index) => index === column ? graph3Encode(content(uri, target), table.encoding) : cell) }) }))
  const original = tables(fromUri, '/Restored.md'), rewritten = tables(toUri, '/Restored.md')
  const source = { data, allocation, physical: { tables: original, finalSyntaxIndexHash: buildMerge3NavigationFinalIndex3(graph, original).indexHash },
    tables: rewritten, navigationEdits: [{ table: 'blocks', targetRowId: retained.targetRowId, column: 'content', edits: [{
      from: prefix.length, to: prefix.length + fromUri.length, before: fromUri, after: toUri, uri: fromUri, kind: 'image' }] }]
  } as unknown as Parameters<typeof deriveStage4AliasNavigation>[0]
  const result = withStoredNavigation3TableScan(append => {
    for (const { rows, ...layout } of rewritten) append(layout, rows.values())
  }, (_metadata, tables) => deriveStage4AliasNavigation({ ...source, tables }))
  assert.deepEqual(result, deriveStage4AliasNavigation(source))
  assert.equal(result.syntaxIndexHash, buildMerge3NavigationFinalIndex3(graph, rewritten).indexHash)
  assert.deepEqual(result.routes.routes.get(capsuleJson(['Previous route 🍃', 'retained'])), {
    path: 'Previous route 🍃', blockId: 'retained', documentId: 'r', createdAt: born, currentRowId: '-9223372036854775808'
  })
  assert.throws(() => deriveStage4AliasNavigation({ ...source, tables: tables(toUri, '/Unexpected.md') }), /实际导航或有效定义/)
})

test('original Markdown offsets preserve surrogate pairs, lone CR and exact CRLF boundaries', () => {
  const rawOffset = markdownOriginalOffsetLookup([{ content: '😀\r\nx\ry\r\n' }])
  assert.deepEqual(Array.from({ length: 8 }, (_, offset) => rawOffset(0, offset)), [0, 1, 2, 4, 5, 6, 7, 9])
  assert.equal(rawOffset(0, 8), null)
  assert.equal(rawOffset(0, 2.5), null)
  assert.equal(rawOffset(1, 0), null)
})

test('stored source, current and final scopes preserve the complete merge context and its canonical hash', () => {
  for (const repeated of [false, true]) {
    const { data, merged } = fixture(repeated)
    const full = deriveRootRestoreNavigationMergeContext3(data, merged)
    withStoredRootRestoreNavigationMergeContext3(data, merged, stored => {
      assert.equal(stored.contextHash, full.contextHash)
      assert.equal(stored.sourceNavigationInputHash, full.source.navigationInputHash)
      assert.equal(stored.currentNavigationInputHash, full.current.navigationInputHash)
      assert.equal(stored.final.indexHash, full.final.indexHash)
      assert.deepEqual([...stored.scopes()], full.scopes)
    })
  }
})

test('file-backed candidate rows preserve exact SQL order and canonical bytes across sparse rewrite and final navigation', () => {
  const { data, merged } = fixture(true), full = deriveRootRestoreNavigationMergeContext3(data, merged)
  let readAfterScope: (() => unknown) | undefined
  withStoredNavigation3Tables(() => ({ metadata: merged.mergedContentHash, tables: merged.tables }), (mergedContentHash, tables) => {
    assert.deepEqual(tables.map(table => table.rows.length), merged.tables.map(table => table.rows.length))
    assert.deepEqual(materializeNavigation3Tables(tables), merged.tables)
    assert.equal(hashBoundedCapsuleJson(navigation3TableHashInput(tables), Number.MAX_SAFE_INTEGER), capsuleBytesHash(capsuleJson(merged.tables)))
    withStoredRootRestoreNavigationMergeContext3(data, { mergedContentHash, tables }, stored => {
      assert.equal(stored.contextHash, full.contextHash)
      assert.deepEqual([...stored.scopes()], full.scopes)
    })
    const changed = tables.map(table => {
      if (table.name !== 'blocks') return table
      readAfterScope = () => table.rows.at(0)
      const column = table.columns.indexOf('content'), type = table.columns.indexOf('type')
      const target = [...table.rows].find(row => graph3Text(row.cells[type], table.encoding) !== 'synced-block')!
      return projectNavigation3TableRows(table, row => row.key === target.key ? { ...row,
        cells: row.cells.map((cell, ordinal) => ordinal === column ? graph3Encode('A rewritten body 😀\r\n', table.encoding) : cell) } : row)
    })
    const materialized = materializeNavigation3Tables(changed), expected = capsuleBytesHash(capsuleJson(materialized))
    assert.equal(hashBoundedCapsuleJson(navigation3TableHashInput(changed), Number.MAX_SAFE_INTEGER), expected)
    withStoredMerge3NavigationFinalIndex3(data, changed, stored => {
      assert.equal(stored.indexHash, buildMerge3NavigationFinalIndex3(data, materialized).indexHash)
    })
  })
  assert.throws(readAfterScope!, /connection is not open/)
  const verbatim = '\0正文😀\r\n\ud800'
  withNavigation3TextPatches((write, read) => { write('patch', verbatim); return read }, read => assert.equal(read('patch'), verbatim))
})

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

for (const [source, current] of [['UTF-8', 'UTF-16le'], ['UTF-16le', 'UTF-16be'], ['UTF-16be', 'UTF-8']] as const) {
  test(`navigation binds exact signed original rowids and full unprojected cell bytes in ${source} and ${current}`, () => {
    const { data, merged } = fixture(false, { source, current })
    const final = buildMerge3NavigationFinalIndex3(data, merged.tables)
    const retained = final.physicalBlocks.find(block => block.id === 'retained')!
    assert.equal(retained.sourceRef.sourceRowId, '9223372036854775807')
    assert.equal(final.routes.length, 1)
    const route = data.inputs.current.source.sourceContent.tables.find(table => table.name === 'document_block_routes')!
    const original = route.rows[0]
    const expected = capsuleBytesHash('knowbook.restore.merge3.original-row.v1\0' + capsuleJson({
      table: route.name, columns: route.columns, primaryKey: route.primaryKey, encoding: current, sourceRowId: original.sourceRowId, cells: original.cells
    }))
    assert.equal(final.routes[0].path, 'Previous route 🍃')
    assert.equal(final.routes[0].sourceRowId, '-9223372036854775808')
    assert.equal(final.routes[0].originalRowHash, expected)
    const tampered = structuredClone(data)
    const blocks = tampered.inputs.current.source.sourceContent.tables.find(table => table.name === 'blocks')!
    Reflect.set(blocks.rows[2].cells, blocks.columns.indexOf('content'), graph3Encode('unprojected changed body', current))
    assert.throws(() => buildMerge3NavigationFinalIndex3(tampered, merged.tables), /navigation-merge-original-ref/)
  })
}
