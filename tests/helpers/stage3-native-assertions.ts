// Integration assertions for actual Main-owned stages. Native input edits are
// restricted to technical rowids, view ordering and nullable value occurrences;
// all block identities, births, lifecycle and history are produced by Main.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { graph3Text } from '../../src/main/database/restore-knowledge-graph3-data'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from '../../src/main/database/restore-knowledge-sql-cell'
import { MERGE3_CONTENT_TABLES } from '../../src/main/database/restore-knowledge-merge3-storage'
import { prepareRootRestorePhysicalStage3 } from '../../src/main/database/restore-knowledge-stage3-physical'
import { stage3MarkerKey } from '../../src/main/database/restore-knowledge-stage3-marker-model'
import { expectedStage3Execution } from './stage3-execution-oracle'
import { withStage3Fixture, type Stage3NativeEdges } from './stage3-fixture'
import { allTables } from './synced-backup-v3-fixture'

type Encoding = Stage3NativeEdges['encoding']
type RawRow = { sourceRowId: string; cells: readonly RawRestoreSqlCell[] }
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const sortRows = (rows: readonly RawRow[]) => [...rows].sort((a, b) => BigInt(a.sourceRowId) < BigInt(b.sourceRowId) ? -1 : BigInt(a.sourceRowId) > BigInt(b.sourceRowId) ? 1 : 0)
function nativeTable(db: Database.Database, name: string, encoding: Encoding) {
  const columns = db.prepare('SELECT * FROM main.' + quote(name) + ' LIMIT 0').columns().map(column => column.name)
  const projection = columns.flatMap(column => ['typeof(' + quote(column) + ')',
    'CASE WHEN typeof(' + quote(column) + ")='text' THEN CAST(" + quote(column) + ' AS BLOB) ELSE ' + quote(column) + ' END']).join(',')
  const rows = (db.prepare('SELECT _rowid_,' + projection + ' FROM main.' + quote(name) + ' ORDER BY _rowid_')
    .safeIntegers(true).raw(true).all() as unknown[][]).map(row => ({ sourceRowId: String(row[0]),
      cells: columns.map((_column, index) => rawRestoreSqlCell(row[1 + index * 2], row[2 + index * 2], encoding)) }))
  return { columns, rows }
}
async function inventory(directory: string) {
  const entries: Array<{ name: string; bytes: Buffer | null }> = []
  for (const name of ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm']) {
    try { entries.push({ name, bytes: await readFile(join(directory, name)) }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries.push({ name, bytes: null }) }
  }
  return entries
}

export async function assertActualStage3NativeEdges(encoding: Encoding) {
  await withStage3Fixture(async f => {
    assert.ok(f.nativeEdges); assert.equal(f.nativeEdges.encoding, encoding)
    const native = f.nativeEdges
    for (const packet of [f.sourcePacket, f.currentPacket]) {
      const content = packet.source.sourceContent
      assert.equal(content.encoding, encoding)
      const views = content.tables.find(table => table.name === 'database_saved_views')!
      for (const expected of native.views) {
        const row = views.rows.find(candidate => graph3Text(candidate.cells[views.columns.indexOf('id')], encoding) === expected.id)!
        assert.ok(row); assert.equal(row.sourceRowId, expected.rowid)
        assert.deepEqual(row.cells[views.columns.indexOf('sort_order')], ['integer', expected.sortOrder])
      }
      const values = content.tables.find(table => table.name === 'document_database_values')!
      const anonymous = values.rows.filter(row => native.anonymousSourceRowIds.some(id => id === row.sourceRowId))
      assert.equal(anonymous.length, 2)
      assert.deepEqual(anonymous[0].cells, anonymous[1].cells, 'Two equal nullable occurrences must remain two original SQL rows')
      for (const row of anonymous) for (const column of ['document_id', 'entity_id', 'value_text'])
        assert.deepEqual(row.cells[values.columns.indexOf(column)], ['null'])
    }
    const expected = expectedStage3Execution(f.prepared.value, f.sourcePacket, f.currentPacket)
    const prepared = await prepareRootRestorePhysicalStage3(f.prepared.plan), value = prepared.value
    assert.deepEqual(value.tables, expected.tables)
    assert.deepEqual(value.executionChanges, expected.executionChanges)
    assert.equal(value.sourceCandidate12TablesHash, expected.sourceCandidate12TablesHash)
    assert.equal(value.physical12TablesHash, expected.physical12TablesHash)
    assert.equal(value.stageExecutionHash, expected.stageExecutionHash)
    assert.deepEqual(value.tables.map(table => table.name).sort(), [...MERGE3_CONTENT_TABLES].sort())
    const savedViews = value.tables.find(table => table.name === 'database_saved_views')!
    for (const view of native.views) {
      const row = savedViews.rows.find(candidate => graph3Text(candidate.cells[savedViews.columns.indexOf('id')], encoding) === view.id)!
      assert.ok(row); assert.equal(row.targetRowId, view.rowid)
      assert.deepEqual(row.cells[savedViews.columns.indexOf('sort_order')], ['integer', view.sortOrder])
    }
    const values = value.tables.find(table => table.name === 'document_database_values')!
    const anonymous = values.rows.filter(row => row.cells[values.columns.indexOf('document_id')][0] === 'null' &&
      row.cells[values.columns.indexOf('entity_id')][0] === 'null' &&
      graph3Text(row.cells[values.columns.indexOf('column_id')], encoding) === native.anonymousColumnId)
    assert.equal(anonymous.length, 2)
    assert.equal(new Set(anonymous.map(row => row.targetRowId)).size, 2)
    assert.deepEqual(anonymous.map(row => row.sourceRef.sourceRowId).sort(), [...native.anonymousSourceRowIds].sort())
    assert.ok(anonymous.every(row => row.sourceRef.side === 'source' && row.sourceRef.table === values.name))
    assert.deepEqual(anonymous[0].cells, anonymous[1].cells)

    const directory = join(prepared.directory, 'database'), before = await inventory(directory)
    const copy = join(f.receiver.root, 'native-stage-probe-' + randomUUID()); await mkdir(copy)
    for (const file of before) if (file.bytes !== null) await copyFile(join(directory, file.name), join(copy, file.name), constants.COPYFILE_EXCL)
    assert.deepEqual(await inventory(copy), before)
    const main = before.find(file => file.name === 'knowbook.db')!.bytes!
    assert.equal(main.readUInt32BE(56), encoding === 'UTF-16le' ? 2 : 3, 'The sealed SQLite header retains its actual native encoding')
    const db = new Database(join(copy, 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      db.pragma('query_only=ON'); db.pragma('foreign_keys=ON')
      db.transaction(() => {
        assert.equal(db.pragma('encoding', { simple: true }), encoding)
        assert.equal(db.pragma('user_version', { simple: true }), 27)
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
        assert.deepEqual(db.pragma('foreign_key_check'), [])
        for (const table of value.tables) {
          const actual = nativeTable(db, table.name, encoding)
          assert.deepEqual(actual.columns, table.columns)
          assert.deepEqual(actual.rows, sortRows(table.rows.map(row => ({ sourceRowId: row.targetRowId, cells: row.cells }))), table.name)
        }
        assert.deepEqual(db.prepare('SELECT id,CAST(_rowid_ AS TEXT) AS rowid,CAST(sort_order AS TEXT) AS sortOrder FROM database_saved_views WHERE database_id=? ORDER BY sort_order,_rowid_')
          .all(f.source.customId), native.views, 'Adjacent >safe INTEGER sort keys and max rowid must reach actual SQL without Number conversion')
        const actualAnonymous = db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,document_id,entity_id,column_id,value_text,updated_at FROM document_database_values ' +
          'WHERE document_id IS NULL AND entity_id IS NULL AND column_id=? ORDER BY _rowid_').all(native.anonymousColumnId)
        assert.deepEqual(actualAnonymous, sortRows(anonymous.map(row => ({ sourceRowId: row.targetRowId, cells: row.cells }))).map(row => ({
          rowid: row.sourceRowId, document_id: null, entity_id: null, column_id: native.anonymousColumnId,
          value_text: null, updated_at: native.anonymousUpdatedAt })))
        const originalLife = f.currentPacket.source.sourceContent.tables.find(table => table.name === 'synced_group_lifecycle')!
        const currentRowids = new Set(originalLife.rows.map(row => row.sourceRowId))
        assert.deepEqual(nativeTable(db, originalLife.name, encoding).rows.filter(row => currentRowids.has(row.sourceRowId)), sortRows(originalLife.rows))
        const marker = db.prepare('SELECT value FROM app_settings WHERE key=?').get(stage3MarkerKey(prepared.stageId)) as { value: string }
        assert.equal(JSON.parse(marker.value).stageIntentHash, value.stageIntentHash)
      })()
    } finally { db.close() }
    assert.deepEqual(await inventory(directory), before)
    assert.deepEqual(allTables(f.source.db), f.beforeSource)
    assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    for (const flag of ['currentStageComplete', 'historyCutComplete', 'finalCurrentRetainedCutComplete', 'semanticValidationComplete',
      'acceptedCoverage', 'effective', 'permit', 'installPermit'] as const) assert.equal(value[flag], false)
  }, undefined, undefined, { encoding })
}
