import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPSULE2_READER, hashValidatedCapsule2RawSqlTable, type Capsule2Encoding,
  scopedCapsule2TableOwnerLookup, scopedCapsule2TableRowOwnership, type Capsule2RawContent } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { graph3Encode } from '../src/main/database/restore-knowledge-graph3-data'
import { scopeCurrentReferenceBlocks5, scopeIncomingReferenceTables5, withReferenceOriginalRows5 } from '../src/main/database/restore-knowledge-reference-original-rows5'

function original(encoding: Capsule2Encoding, side: string): Capsule2RawContent {
  return { kind: 'restore-knowledge-capsule2-raw-content', version: 1, forReader: CAPSULE2_READER,
    schemaVersion: 27, encoding, workspaceScope: side, recoveryEpoch: 'epoch', schemaHash: 'a'.repeat(64),
    legacyInventoryHash: 'b'.repeat(64), derivedTablesNotRepeated: [], state: 'raw-storage-only', semanticValidationComplete: false,
    certified: false, tables: [{ name: 'synced_group_blocks', role: 'content', columns: ['id', 'group_id', 'content'], primaryKey: ['id'],
      rows: [{ sourceRowId: '-19', cells: [graph3Encode('先', encoding), graph3Encode('组', encoding), graph3Encode('双侧 ' + side, encoding)] },
        { sourceRowId: '2', cells: [graph3Encode('后', encoding), graph3Encode('另一组', encoding), graph3Encode('A\r\n😊', encoding)] },
        { sourceRowId: '9223372036854775807', cells: [graph3Encode('末', encoding), graph3Encode('组', encoding), graph3Encode('B', encoding)] }] }] }
}

test('Reference3 original tables retain ordered row hashes and close the lookup scope', async () => {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const) {
    const source = original(encoding, 'source'), current = original(encoding, 'current')
    const scope = await withReferenceOriginalRows5(async store => ({ source: store('source', source), current: store('current', current) }), async rows => {
      const sourceTable = rows.source.tables[0], currentTable = rows.current.tables[0]
      assert.deepEqual([...sourceTable.rows].map(row => row.sourceRowId), ['-19', '2', '9223372036854775807'])
      assert.deepEqual(sourceTable.byId('先'), source.tables[0].rows[0])
      assert.deepEqual(currentTable.byId('先'), current.tables[0].rows[0])
      assert.equal(sourceTable.byId('其他'), undefined)
      for (const [opened, expected] of [[sourceTable, source.tables[0]], [currentTable, current.tables[0]]] as const) {
        assert.equal(hashValidatedCapsule2RawSqlTable('test.original', opened), hashValidatedCapsule2RawSqlTable('test.original', expected))
      }
      return sourceTable
    })
    assert.throws(() => scope.byId('先'), /读取范围已结束/)
    assert.throws(() => [...scope.rows], /读取范围已结束/)
  }
})

test('Reference3 owner lookup keeps the original row order, role and lifetime', async () => {
  const source = original('UTF-16be', 'source'), current = original('UTF-16be', 'current')
  const { rows, owns, selected } = await withReferenceOriginalRows5(async store => ({
    source: scopeIncomingReferenceTables5(source, store).tables[0],
    current: scopeCurrentReferenceBlocks5(current, store).tables[0]
  }), async tables => {
    assert.throws(() => tables.current.rows, /逐行读取范围/)
    assert.equal(scopedCapsule2TableOwnerLookup(tables.current, 'document_id'), undefined)
    const rows = scopedCapsule2TableOwnerLookup(tables.current, 'group_id')!
    const owns = scopedCapsule2TableRowOwnership(tables.current)!
    const selected = [...rows('组')]
    assert.deepEqual(selected, [current.tables[0].rows[0], current.tables[0].rows[2]])
    assert.deepEqual([...rows('不存在')], [])
    assert.equal(owns(selected[0]), true)
    assert.equal(owns({ ...selected[0] }), false)
    const [sourceRow] = [...scopedCapsule2TableOwnerLookup(tables.source, 'group_id')!('组')]
    assert.equal(owns(sourceRow), false)
    return { rows, owns, selected }
  })
  assert.throws(() => [...rows('组')], /读取范围已结束/)
  assert.throws(() => owns(selected[0]), /读取范围已结束/)
})
