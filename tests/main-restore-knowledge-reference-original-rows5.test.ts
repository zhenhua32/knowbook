import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPSULE2_READER, hashValidatedCapsule2RawSqlTable, type Capsule2Encoding,
  type Capsule2RawContent } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { graph3Encode } from '../src/main/database/restore-knowledge-graph3-data'
import { withReferenceOriginalRows5 } from '../src/main/database/restore-knowledge-reference-original-rows5'

function original(encoding: Capsule2Encoding, side: string): Capsule2RawContent {
  return { kind: 'restore-knowledge-capsule2-raw-content', version: 1, forReader: CAPSULE2_READER,
    schemaVersion: 27, encoding, workspaceScope: side, recoveryEpoch: 'epoch', schemaHash: 'a'.repeat(64),
    legacyInventoryHash: 'b'.repeat(64), derivedTablesNotRepeated: [], state: 'raw-storage-only', semanticValidationComplete: false,
    certified: false, tables: [{ name: 'synced_group_blocks', role: 'content', columns: ['id', 'group_id', 'content'], primaryKey: ['id'],
      rows: [{ sourceRowId: '-19', cells: [graph3Encode('先', encoding), graph3Encode('组', encoding), graph3Encode('双侧 ' + side, encoding)] },
        { sourceRowId: '2', cells: [graph3Encode('后', encoding), graph3Encode('另一组', encoding), graph3Encode('A\r\n😊', encoding)] }] }] }
}

test('Reference3 original tables retain ordered row hashes and close the lookup scope', async () => {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const) {
    const source = original(encoding, 'source'), current = original(encoding, 'current')
    const scope = await withReferenceOriginalRows5(async store => ({ source: store('source', source), current: store('current', current) }), async rows => {
      const sourceTable = rows.source.tables[0], currentTable = rows.current.tables[0]
      assert.deepEqual([...sourceTable.rows].map(row => row.sourceRowId), ['-19', '2'])
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
