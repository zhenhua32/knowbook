import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_ROWS, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2ApplicationColumns,
  type Capsule2Encoding, type Capsule2RawSqlTable } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { graph3Encode, graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { MERGE3_CONTENT_TABLES, assertMerge3StorageTablesBudget, finishMerge3Table, merge3RowValues, prepareMerge3Table,
  type FinishedMerge3Table, type Merge3ContentTable, type Merge3Material, type Merge3RowDisposition, type Merge3SelectedRow,
  type PreparedMerge3Table } from '../src/main/database/restore-knowledge-merge3-storage'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'

const id = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0')
const digest = (n: number) => n.toString(16).padStart(64, '0')
function material(side: 'source' | 'current', n = side === 'source' ? 1 : 2): Merge3Material {
  return { payload: digest(n), materialHash: digest(n + 10), witness: { domain: [], side,
    capsule: { kind: 'restore-knowledge-origin-capsule-ref', version: 1, namespace: { kind: 'native' }, operationId: id(n), capsuleId: id(n + 10),
      manifestHash: digest(n + 20), readerVersion: 'knowbook-durable-sql-coverage-v2' }, projectionHash: digest(n + 30) } }
}
function columnNames(name: Merge3ContentTable): string[] {
  const ordinary = capsule2ApplicationColumns().get(name)
  if (ordinary) return [...ordinary]
  if (name === 'synced_groups') return ['id', 'creation_id', 'created_at', 'origin_json', 'bindings_json', 'revision', 'topology_revision', 'history_cursor', 'history_position']
  if (name === 'synced_instances') return ['instance_id', 'group_id', 'host_document_id', 'binding_version', 'parent_block_id', 'depth']
  return ['id', 'group_id', 'parent_block_id', 'sort_order', 'type', 'content', 'checked', 'depth', 'tags_json', 'language', 'list_start', 'markdown_format_json', 'highlight', 'created_at']
}
const primaryKey = (name: Merge3ContentTable) => name === 'database_entity_values' ? ['entity_id', 'column_id']
  : name === 'document_database_values' ? ['document_id', 'column_id'] : [name === 'synced_instances' ? 'instance_id' : 'id']
function table(name: Merge3ContentTable, rows: Array<{ rowid: string; values: Record<string, RawRestoreSqlCell> }> = [],
  columns = columnNames(name)): Capsule2RawSqlTable {
  return { name, role: 'content', columns, primaryKey: primaryKey(name), rows: rows.map(row => ({ sourceRowId: row.rowid,
    cells: columns.map(column => row.values[column] ?? ['null']) })) }
}
function prepare(source: Capsule2RawSqlTable, current: Capsule2RawSqlTable, candidate = source,
  sourceEncoding: Capsule2Encoding = 'UTF-8', currentEncoding: Capsule2Encoding = 'UTF-8') {
  return prepareMerge3Table({ sourceOriginal: source, sourceCandidate: candidate, currentOriginal: current, sourceEncoding, currentEncoding,
    source: material('source'), current: material('current') })
}
function dispositions(p: PreparedMerge3Table, selected: readonly Merge3SelectedRow[], other: Merge3RowDisposition['status'] = 'excluded') {
  const keys = new Set(selected.map(row => row.rowKey)), replaced = new Set(selected.map(row => row.replaceCurrentRowKey))
  return [...p.sourceRows, ...p.currentRows].map(row => ({ rowKey: row.key,
    status: keys.has(row.key) ? 'selected' as const : replaced.has(row.key) ? 'replaced' as const : other,
    decision: 'explicit-test-owner-collection-choice' }))
}
const select = (row: PreparedMerge3Table['sourceRows'][number], replaced?: PreparedMerge3Table['currentRows'][number]): Merge3SelectedRow =>
  ({ rowKey: row.key, replaceCurrentRowKey: replaced?.key ?? null })
const valueRow = (rowid: string, document: RawRestoreSqlCell, column: RawRestoreSqlCell, value: RawRestoreSqlCell, enc: Capsule2Encoding = 'UTF-8') =>
  ({ rowid, values: { document_id: document, column_id: column, value_text: value, updated_at: graph3Encode('literal clock', enc), entity_id: ['null'] as const } })

test('merge3 aligns every fixed content table by column name and never grants a DTO SQL authority', () => {
  const finished: FinishedMerge3Table[] = []
  for (const name of MERGE3_CONTENT_TABLES) {
    const original = table(name), current = table(name, [], [...original.columns].reverse())
    const p = prepare(original, current)
    assert.deepEqual(p.columns, current.columns)
    assert.deepEqual(p.originalColumns.source, original.columns)
    assert.deepEqual(p.originalColumns.current, current.columns)
    assert.equal(p.targetEncoding, 'UTF-8')
    const value = finishMerge3Table(p, [], [])
    assert.equal(value.complete, true)
    assert.equal(value.semanticValidationComplete, false)
    assert.equal(value.permit, false)
    assert.ok(Object.isFrozen(value.table.rows))
    finished.push(value)
  }
  assert.doesNotThrow(() => assertMerge3StorageTablesBudget(finished))
  assert.throws(() => assertMerge3StorageTablesBudget(finished.slice(1)), /固定12/)
  assert.throws(() => assertMerge3StorageTablesBudget([...finished.slice(1), finished[1]]), /重复/)
  const unknown = { ...table('documents'), name: 'caller_table' }
  assert.throws(() => prepare(unknown as Capsule2RawSqlTable, table('documents')), /固定12/)
})

test('merge3 keeps full original refs, exact bytes and stable occurrence keys through candidate patches and all TEXT encoding pairs', () => {
  for (const sourceEncoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const) for (const targetEncoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const) {
    const text = '\ufeff原文\0𠮷🙂\r\n', name = 'document_database_values'
    const source = table(name, [valueRow('-9223372036854775808', graph3Encode('doc', sourceEncoding), graph3Encode('column', sourceEncoding), graph3Encode(text, sourceEncoding), sourceEncoding)])
    const current = table(name, [], [...source.columns].reverse())
    const candidate = table(name, [valueRow('-9223372036854775808', graph3Encode('mapped doc', sourceEncoding), graph3Encode('column', sourceEncoding), graph3Encode(text, sourceEncoding), sourceEncoding)], [...source.columns].reverse())
    const p = prepare(source, current, candidate, sourceEncoding, targetEncoding)
    const unchanged = prepare(source, current, source, sourceEncoding, targetEncoding)
    assert.equal(p.sourceRows[0].key, unchanged.sourceRows[0].key)
    assert.equal(p.sourceRows[0].ref.originalRowHash, unchanged.sourceRows[0].ref.originalRowHash)
    assert.deepEqual(p.sourceRows[0].originalCells, source.rows[0].cells)
    assert.deepEqual(merge3RowValues(p, p.sourceRows[0]), { entity_id: null, updated_at: 'literal clock', value_text: text, column_id: 'column', document_id: 'mapped doc' })
    assert.deepEqual(p.sourceRows[0].cells[p.columns.indexOf('value_text')], graph3Encode(text, targetEncoding))
    const selected = [select(p.sourceRows[0])], result = finishMerge3Table(p, selected, dispositions(p, selected))
    assert.equal(result.table.rows[0].targetRowId, '1')
    assert.equal(result.table.rows[0].sourceRef.sourceRowId, '-9223372036854775808')
    assert.equal(result.table.rows[0].sourceRef.side, 'source')
    assert.equal(result.table.rows[0].sourceRef.payload, material('source').payload)
    assert.deepEqual(result.table.rows[0].sourceRef.witness, material('source').witness)
    assert.deepEqual(result.dispositions[0].sourceRef, p.sourceRows[0].ref)
    assert.equal(capsuleJson(result).includes('mapped doc'), false, 'TEXT is serialized as exact storage bytes, not a decoded mutable values map')
  }
})

test('merge3 uses explicit exact non-NULL target PK replacement while retaining current rowid and independent original evidence', () => {
  const enc = 'UTF-8', name = 'document_database_values', key = graph3Encode('doc', enc), field = graph3Encode('column', enc)
  const source = table(name, [valueRow('9', graph3Encode('old doc', enc), field, graph3Encode('incoming', enc))])
  const candidate = table(name, [valueRow('9', key, field, graph3Encode('incoming', enc))])
  const current = table(name, [valueRow('9', key, field, graph3Encode('current', enc)), valueRow('20', graph3Encode('retained', enc), field, ['null'])])
  const p = prepare(source, current, candidate)
  assert.notEqual(p.sourceRows[0].key, p.currentRows[0].key)
  const chosen = [select(p.currentRows[1]), select(p.sourceRows[0], p.currentRows[0])]
  const result = finishMerge3Table(p, chosen, dispositions(p, chosen))
  assert.deepEqual(result.table.rows.map(row => row.targetRowId), ['9', '20'])
  assert.deepEqual(result.table.rows[0].replaces, p.currentRows[0].ref)
  assert.deepEqual(result.table.rows[1].sourceRef, p.currentRows[1].ref)
  assert.equal(result.table.rows[0].sourceRef.sourceRowId, '9')
  assert.equal(result.dispositions.find(row => row.rowKey === p.currentRows[0].key)?.status, 'replaced')
  assert.deepEqual(finishMerge3Table(structuredClone(p), [...chosen].reverse(), [...dispositions(p, chosen)].reverse()), result)
  const implicit = [select(p.currentRows[0]), select(p.sourceRows[0])]
  assert.throws(() => finishMerge3Table(p, implicit, dispositions(p, implicit)), /非NULL PK重复/)
  const wrong = [select(p.sourceRows[0], p.currentRows[1])]
  assert.throws(() => finishMerge3Table(p, wrong, dispositions(p, wrong)), /非NULL PK/)
})

test('merge3 never coalesces NULL PK occurrences or recycles excluded current rowids, including int64 extremes', () => {
  const field = graph3Encode('same column', 'UTF-8'), name = 'document_database_values'
  const source = table(name, [valueRow('-4', ['null'], field, ['null']), valueRow('3', ['null'], field, ['null']), valueRow('9', ['null'], field, ['null'])])
  const current = table(name, [valueRow('1', ['null'], field, ['null']), valueRow('3', ['null'], field, ['null']), valueRow('9223372036854775807', ['null'], field, ['null'])])
  const p = prepare(source, current), chosen = [select(p.sourceRows[2]), select(p.currentRows[0]), select(p.sourceRows[1]), select(p.sourceRows[0])]
  const result = finishMerge3Table(p, chosen, dispositions(p, chosen))
  assert.deepEqual(result.table.rows.map(row => row.targetRowId), ['1', '2', '4', '5'])
  assert.deepEqual(result.table.rows.filter(row => row.sourceRef.side === 'source').map(row => row.sourceRef.sourceRowId), ['-4', '3', '9'])
  assert.equal(new Set([...p.sourceRows, ...p.currentRows].map(row => row.key)).size, 6)
  assert.equal(p.sourceRows.every(row => row.primaryKeyCells === null), true)
  const invalid = [select(p.sourceRows[0], p.currentRows[0])]
  assert.throws(() => finishMerge3Table(p, invalid, dispositions(p, invalid)), /非NULL PK/)
  assert.equal(result.dispositions.filter(row => row.status === 'excluded').length, 2)
  assert.equal(result.dispositions.filter(row => row.status === 'excluded').every(row => row.sourceRef.side === 'current'), true)
})

test('merge3 requires one explicit disposition for every original and preserves conflicts without claiming completeness', () => {
  const source = table('document_database_values', [valueRow('1', ['null'], graph3Encode('field', 'UTF-8'), ['null'])]), p = prepare(source, source)
  const selected = [select(p.sourceRows[0])], complete = dispositions(p, selected)
  assert.throws(() => finishMerge3Table(p, selected, complete.slice(1)), /无disposition/)
  assert.throws(() => finishMerge3Table(p, selected, [complete[0], complete[0]]), /disposition/)
  assert.throws(() => finishMerge3Table(p, selected, complete.map(row => ({ ...row, decision: '  ' }))), /disposition/)
  const result = finishMerge3Table(p, selected, dispositions(p, selected, 'conflict'))
  assert.equal(result.complete, false)
  assert.equal(result.conflicts.length, 1)
  assert.deepEqual(result.conflicts[0].sourceRef, p.currentRows[0].ref)
  assert.equal(result.permit, false)
})

test('merge3 rejects missing candidate occurrences, changed refs, corrupt TEXT and getter inputs without reading accessors', () => {
  const source = table('document_database_values', [valueRow('1', ['null'], graph3Encode('field', 'UTF-8'), ['null'])]), current = table('document_database_values')
  assert.throws(() => prepare(source, current, { ...source, rows: [] }), /逐原行/)
  const corrupt = structuredClone(source)
  Reflect.set(corrupt.rows[0].cells, source.columns.indexOf('value_text'), ['text', '//4='])
  assert.throws(() => prepare(corrupt, current), /非法编码|无损回读/)
  const p = prepare(source, current), selected = [select(p.sourceRows[0])], tamper = structuredClone(p)
  Reflect.set(tamper.sourceRows[0].ref, 'sourceRowId', '2')
  assert.throws(() => finishMerge3Table(tamper, selected, dispositions(p, selected)), /hash\/key/)
  let calls = 0
  const getter = { ...source }
  Object.defineProperty(getter, 'rows', { enumerable: true, get() { calls++; return source.rows } })
  assert.throws(() => prepare(getter, current), /访问器/)
  const getterPrepared = { ...p }
  Object.defineProperty(getterPrepared, 'columns', { enumerable: true, get() { calls++; return p.columns } })
  assert.throws(() => finishMerge3Table(getterPrepared, selected, dispositions(p, selected)), /访问器/)
  assert.equal(calls, 0)
})

test('merge3 enforces the inherited actual row and value-byte caps before completing a candidate', () => {
  const empty = table('document_database_values'), field = graph3Encode('field', 'UTF-8')
  const one = valueRow('1', ['null'], field, ['null'])
  const tooMany = table('document_database_values', Array.from({ length: CAPSULE2_RAW_MAX_ROWS + 1 }, (_, index) => ({ ...one, rowid: String(index + 1) })))
  assert.throws(() => prepare(tooMany, empty), /数组超预算/)
  // One canonical shared base64 spelling avoids allocating a giant cell. The
  // accumulator still charges every original SQL occurrence, never dedupes it.
  const blob: RawRestoreSqlCell = ['blob', 'A'.repeat(87_384)], decodedBytes = blob[1].length / 4 * 3
  const count = Math.floor(CAPSULE2_RAW_MAX_VALUE_BYTES / decodedBytes) + 1
  const over = table('document_database_values', Array.from({ length: count }, (_, index) => valueRow(String(index + 1), ['null'], field, blob)))
  assert.throws(() => prepare(over, empty), /valueBytes超原有限预算/)
})

test('merge3 whole-table budget counts actual rows and complete metadata without trusting cloned DTO counters or hashes', () => {
  const all = MERGE3_CONTENT_TABLES.map(name => finishMerge3Table(prepare(table(name), table(name)), [], []))
  const source = table('document_database_values', [valueRow('1', ['null'], graph3Encode('field', 'UTF-8'), ['null'])])
  const p = prepare(source, table('document_database_values')), chosen = [select(p.sourceRows[0])]
  const seed = finishMerge3Table(p, chosen, dispositions(p, chosen)), probeRow = seed.table.rows[0]
  // Pure malformed/over-budget DTO probes are not Main source factories. Each
  // actual cell still has to be counted even if its object/bytes are shared.
  const rowProbe = all.map(value => value.table.name !== 'document_database_values' && value.table.name !== 'documents' ? value : {
    ...value, table: { ...value.table, rows: Array.from({ length: 50_001 }, (_, index) => ({ ...probeRow,
      targetRowId: String(index + 1), cells: value.table.columns.map(() => ['null'] as const) })) }
  })
  assert.throws(() => assertMerge3StorageTablesBudget(rowProbe), /rows超原有限预算/)
  const largeSharedDecision = 'D'.repeat(1024 * 1024)
  const jsonProbe = all.map(value => value.table.name !== 'document_database_values' ? value : { ...value,
    dispositions: Array.from({ length: 129 }, () => ({ ...seed.dispositions[0], decision: largeSharedDecision })) })
  assert.throws(() => assertMerge3StorageTablesBudget(jsonProbe), /jsonBytes超原有限预算/)
  const getterProbe = structuredClone(all)
  let reads = 0
  Object.defineProperty(getterProbe[0], 'dispositions', { enumerable: true, get() { reads++; return [] } })
  assert.throws(() => assertMerge3StorageTablesBudget(getterProbe), /访问器/)
  assert.equal(reads, 0)
})

function capture(db: Database.Database, name: Merge3ContentTable): Capsule2RawSqlTable {
  const columns = db.prepare('SELECT * FROM ' + name + ' LIMIT 0').columns().map(column => column.name)
  const enc = db.pragma('encoding', { simple: true }) as Capsule2Encoding
  const projection = columns.flatMap(column => ['typeof("' + column + '")', 'CASE WHEN typeof("' + column + '")=\'text\' THEN CAST("' + column + '" AS BLOB) ELSE "' + column + '" END'])
  const rows = db.prepare('SELECT _rowid_,' + projection.join(',') + ' FROM ' + name + ' ORDER BY _rowid_').safeIntegers(true).raw(true).all() as unknown[][]
  return { name, role: 'content', columns, primaryKey: primaryKey(name), rows: rows.map(row => ({ sourceRowId: String(row[0]),
    cells: columns.map((_, index) => rawRestoreSqlCell(row[2 * index + 1], row[2 * index + 2], enc)) })) }
}
function nativeDb(enc: Capsule2Encoding, reversed: boolean) {
  const db = new Database(':memory:')
  db.pragma('encoding="' + enc + '"')
  // Independent ordinary SQLite only. Values intentionally have no affinity
  // so this test can verify every storage class, not just valid catalog values.
  db.exec(reversed
    ? 'CREATE TABLE document_database_values(entity_id TEXT,updated_at,value_text,column_id TEXT NOT NULL,document_id TEXT,PRIMARY KEY(document_id,column_id))'
    : 'CREATE TABLE document_database_values(document_id TEXT,column_id TEXT NOT NULL,value_text,updated_at,entity_id TEXT,PRIMARY KEY(document_id,column_id))')
  return db
}
function sqlValue(cell: RawRestoreSqlCell, enc: Capsule2Encoding): string | bigint | number | Buffer | null {
  return cell[0] === 'null' ? null : cell[0] === 'text' ? graph3Text(cell, enc) : cell[0] === 'integer' ? BigInt(cell[1])
    : cell[0] === 'real-ieee754-le' ? Buffer.from(cell[1], 'hex').readDoubleLE() : Buffer.from(cell[1], 'base64')
}
for (const [sourceEncoding, targetEncoding] of [['UTF-16be', 'UTF-8'], ['UTF-8', 'UTF-16le']] as const) {
  test(`merge3 independent native SQLite preserves NULL occurrences, storage classes and target rowids from ${sourceEncoding} to ${targetEncoding}`, () => {
    const source = nativeDb(sourceEncoding, false), current = nativeDb(targetEncoding, true), target = nativeDb(targetEncoding, true)
    try {
      const sourceInsert = source.prepare('INSERT INTO document_database_values(_rowid_,document_id,column_id,value_text,updated_at,entity_id) VALUES(?,NULL,?,?,?,NULL)')
      sourceInsert.run(-4n, 'field\0原值', 9223372036854775807n, 'clock')
      sourceInsert.run(3n, 'field\0原值', -1.5, 'clock')
      sourceInsert.run(9n, 'field\0原值', Buffer.from([0, 255, 128]), 'clock')
      sourceInsert.run(50n, 'field\0原值', '\ufeff原文\0𠮷🙂\r\n', 'clock')
      const currentInsert = current.prepare('INSERT INTO document_database_values(_rowid_,document_id,column_id,value_text,updated_at,entity_id) VALUES(?,NULL,?,?,?,NULL)')
      currentInsert.run(1n, 'field\0原值', null, 'current clock')
      currentInsert.run(3n, 'field\0原值', 'excluded occurrence', 'current clock')
      currentInsert.run(9223372036854775807n, 'field\0原值', 'excluded max rowid', 'current clock')
      const sourceBefore = capture(source, 'document_database_values'), currentBefore = capture(current, 'document_database_values')
      const p = prepare(sourceBefore, currentBefore, sourceBefore, sourceEncoding, targetEncoding)
      const selected = [...p.sourceRows.map(row => select(row)), select(p.currentRows[0])]
      const value = finishMerge3Table(p, [...selected].reverse(), dispositions(p, selected))
      const insert = target.prepare('INSERT INTO document_database_values(_rowid_,' + value.table.columns.map(column => '"' + column + '"').join(',')
        + ') VALUES(' + Array.from({ length: value.table.columns.length + 1 }, () => '?').join(',') + ')')
      target.transaction(() => {
        for (const row of value.table.rows) insert.run(BigInt(row.targetRowId), ...row.cells.map(cell => sqlValue(cell, targetEncoding)))
      })()
      const actual = capture(target, 'document_database_values')
      assert.deepEqual(actual.columns, value.table.columns)
      assert.deepEqual(actual.rows, value.table.rows.map(row => ({ sourceRowId: row.targetRowId, cells: row.cells })))
      assert.deepEqual(actual.rows.map(row => row.sourceRowId), ['1', '2', '4', '5', '6'])
      assert.deepEqual(target.prepare('SELECT typeof(value_text) AS storage,count(*) AS n FROM document_database_values GROUP BY storage ORDER BY storage').all(),
        [{ storage: 'blob', n: 1 }, { storage: 'integer', n: 1 }, { storage: 'null', n: 1 }, { storage: 'real', n: 1 }, { storage: 'text', n: 1 }])
      assert.equal((target.prepare('SELECT count(*) AS n FROM document_database_values WHERE document_id IS NULL').get() as { n: number }).n, 5)
      assert.deepEqual(capture(source, 'document_database_values'), sourceBefore)
      assert.deepEqual(capture(current, 'document_database_values'), currentBefore)
      assert.equal((source.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 4)
      assert.equal((current.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 3)
    } finally { source.close(); current.close(); target.close() }
  })
}
