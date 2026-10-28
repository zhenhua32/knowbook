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
import { capsuleBytesHash, capsuleJson } from '../../src/main/database/restore-knowledge-capsule-model'
import type { Capsule2Encoding, Capsule2RawContent } from '../../src/main/database/restore-knowledge-capsule2-raw-model'
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
function nativeTable(db: Database.Database, name: string, encoding: Capsule2Encoding) {
  const columns = db.prepare('SELECT * FROM main.' + quote(name) + ' LIMIT 0').columns().map(column => column.name)
  const projection = columns.flatMap(column => ['typeof(' + quote(column) + ')',
    'CASE WHEN typeof(' + quote(column) + ")='text' THEN CAST(" + quote(column) + ' AS BLOB) ELSE ' + quote(column) + ' END']).join(',')
  const rows = (db.prepare('SELECT _rowid_,' + projection + ' FROM main.' + quote(name) + ' ORDER BY _rowid_')
    .safeIntegers(true).raw(true).all() as unknown[][]).map(row => ({ sourceRowId: String(row[0]),
      cells: columns.map((_column, index) => rawRestoreSqlCell(row[1 + index * 2], row[2 + index * 2], encoding)) }))
  return { columns, rows }
}
type StageValue = Awaited<ReturnType<typeof prepareRootRestorePhysicalStage3>>['value']
type ExpectedExecution = ReturnType<typeof expectedStage3Execution>
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
export const stage3CutProtectedTables = new Set(['synced_workspace_state', 'synced_host_history_state',
  'synced_host_history_documents', 'synced_group_history'])

/** The old independent oracle still proves every candidate -> pre-cut cell.
 * Final guards are checked by freshness/native SQL, never a copied UUID recipe. */
export function assertStage3PreCutOracle(value: StageValue, expected: ExpectedExecution) {
  assert.deepEqual(value.executionChanges, expected.executionChanges)
  assert.equal(value.sourceCandidate12TablesHash, expected.sourceCandidate12TablesHash)
  assert.equal(value.preCutPhysical12TablesHash, expected.physical12TablesHash)
  assert.equal(value.preCutStageExecutionHash, expected.stageExecutionHash)
  assert.notEqual(value.physical12TablesHash, expected.physical12TablesHash)
  assert.notEqual(value.stageExecutionHash, expected.stageExecutionHash)
  assert.deepEqual(value.tables.map(table => table.name), expected.tables.map(table => table.name))
  for (const before of expected.tables) {
    const after = value.tables.find(table => table.name === before.name)!
    const originals = new Map(before.rows.map(row => [row.targetRowId, row]))
    assert.equal(after.rows.length, originals.size, before.name + ' complete final row set')
    assert.equal(new Set(after.rows.map(row => row.targetRowId)).size, originals.size)
    assert.deepEqual({ ...after, rows: after.rows.map(row => {
      const original = originals.get(row.targetRowId); assert.ok(original)
      return { ...row, cells: original.cells }
    }) }, before, before.name + ' keeps every rowid/source reference and table descriptor')
    const execution = new Set(before.name === 'documents' ? ['updated_at'] : before.name === 'synced_groups'
      ? ['revision', 'topology_revision', 'history_cursor', 'history_position'] : before.name === 'synced_instances' ? ['binding_version'] : [])
    for (const row of after.rows) for (const [index, column] of before.columns.entries()) if (!execution.has(column))
      assert.deepEqual(row.cells[index], originals.get(row.targetRowId)!.cells[index], before.name + ':' + row.targetRowId + ':' + column)
  }
  assert.equal(value.finalCurrentRetainedCutComplete, true)
  assert.equal(value.retainedCut.finalCurrentRetainedCutComplete, true)
  assert.equal(value.currentExecutionBoundariesPreserved, false)
  assert.equal(value.workspaceEpochAndDocumentCasAndHostCutPending, false)
  assert.equal(value.currentHistoryEvidenceRetained, true)
  assert.equal(value.currentExecutableHistoryCut, true)
}

/** Reads an independent native probe. Only actual SQL cells enter the final
 * hash; original packets and the unchanged oracle supply the independent sides. */
export function assertStage3PostCutNative(db: Database.Database, value: StageValue, expected: ExpectedExecution,
  source: Capsule2RawContent, current: Capsule2RawContent, activeGroupIds: readonly string[]) {
  const encoding = current.encoding, native = new Map<string, ReturnType<typeof nativeTable>>()
  const read = (name: string) => {
    let table = native.get(name)
    if (!table) { table = nativeTable(db, name, encoding); native.set(name, table) }
    return table
  }
  const old = new Set<string>(), fresh = new Set<string>()
  // Decode embedded journal/ACK JSON too, so escaped historical guards remain
  // occupied. No production allocation, cut plan or UUID derivation is used.
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      old.add(value)
      try { const parsed: unknown = JSON.parse(value); if (parsed !== value) collect(parsed) } catch { /* ordinary text */ }
    } else if (Array.isArray(value)) for (const item of value) collect(item)
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { old.add(key); collect(item) }
  }
  for (const packet of [source, current]) for (const table of packet.tables) for (const row of table.rows)
    for (const cell of row.cells) if (cell[0] === 'text') collect(graph3Text(cell, packet.encoding))
  for (const table of expected.tables) for (const row of table.rows) for (const cell of row.cells)
    if (cell[0] === 'text') collect(graph3Text(cell, table.encoding))
  old.add(value.stageId)
  const newGuard = (cell: RawRestoreSqlCell, label: string) => {
    assert.equal(cell[0], 'text', label + ' is native TEXT')
    const guard = graph3Text(cell, encoding)
    assert.match(guard, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, label)
    assert.equal(old.has(guard), false, label + ' differs from every source/current/pre-cut guard')
    assert.equal(fresh.has(guard), false, label + ' has its own guard domain')
    fresh.add(guard); return guard
  }
  const finalRaw = expected.tables.map(table => {
    const actual = read(table.name)
    assert.deepEqual(actual.columns, table.columns)
    const info = db.prepare('PRAGMA main.table_info(' + quote(table.name) + ')').all() as Array<{ name: string; pk: number }>
    const primaryKey = info.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name)
    assert.deepEqual(primaryKey, table.primaryKey)
    const reported = value.tables.find(candidate => candidate.name === table.name)!
    assert.deepEqual(actual.rows, sortRows(reported.rows.map(row => ({ sourceRowId: row.targetRowId, cells: row.cells }))), table.name)
    return { name: table.name, role: 'content' as const, columns: actual.columns, primaryKey, rows: actual.rows }
  })
  assert.equal(hash('knowbook.restore.stage3.planned-content.v1', finalRaw), value.physical12TablesHash)
  const documents = read('documents'), docId = documents.columns.indexOf('id'), docCas = documents.columns.indexOf('updated_at')
  const documentIds = documents.rows.map(row => graph3Text(row.cells[docId], encoding)).sort()
  const boundaries = new Set(documents.rows.map(row => {
    assert.equal(row.cells[docCas][0], 'text')
    const stamp = graph3Text(row.cells[docCas], encoding)
    assert.equal(new Date(stamp).toISOString(), stamp)
    assert.equal(old.has(stamp), false, 'Final document CAS differs from all original/candidate timestamps')
    return stamp
  }))
  assert.equal(boundaries.size, documents.rows.length ? 1 : 0)
  const groups = read('synced_groups'), groupId = groups.columns.indexOf('id'), active = new Set(activeGroupIds)
  const beforeGroups = expected.tables.find(table => table.name === 'synced_groups')!
  assert.equal(new Set(groups.rows.map(row => graph3Text(row.cells[groupId], encoding))).size, groups.rows.length)
  let activeCount = 0
  for (const row of groups.rows) {
    const id = graph3Text(row.cells[groupId], encoding)
    const before = beforeGroups.rows.find(candidate => candidate.targetRowId === row.sourceRowId); assert.ok(before)
    if (active.has(id)) {
      activeCount++
      for (const column of ['revision', 'topology_revision', 'history_cursor']) newGuard(row.cells[groups.columns.indexOf(column)], id + ':' + column)
      assert.deepEqual(row.cells[groups.columns.indexOf('history_position')], ['integer', '0'])
    } else for (const column of ['revision', 'topology_revision', 'history_cursor', 'history_position']) {
      const index = groups.columns.indexOf(column)
      assert.deepEqual(row.cells[index], before.cells[index], 'Inactive evidence guard remains exact: ' + id + ':' + column)
    }
  }
  assert.equal(activeCount, active.size)
  const instances = read('synced_instances')
  for (const row of instances.rows) newGuard(row.cells[instances.columns.indexOf('binding_version')], 'instance:' + row.sourceRowId)
  const workspace = read('synced_workspace_state'), originalWorkspace = current.tables.find(table => table.name === 'synced_workspace_state')!
  assert.equal(workspace.rows.length, 1); assert.equal(originalWorkspace.rows.length, 1)
  assert.deepEqual(workspace.columns, originalWorkspace.columns)
  const epoch = workspace.columns.indexOf('recovery_epoch')
  for (const [index, column] of workspace.columns.entries()) if (index !== epoch)
    assert.deepEqual(workspace.rows[0].cells[index], originalWorkspace.rows[0].cells[index], 'workspace:' + column)
  assert.equal(workspace.rows[0].sourceRowId, originalWorkspace.rows[0].sourceRowId)
  newGuard(workspace.rows[0].cells[epoch], 'workspace recovery epoch')
  const hosts = read('synced_host_history_state'), hostId = hosts.columns.indexOf('document_id')
  assert.deepEqual(hosts.rows.map(row => graph3Text(row.cells[hostId], encoding)).sort(), documentIds)
  const oldHosts = current.tables.find(table => table.name === 'synced_host_history_state')!
  assert.deepEqual(hosts.columns, oldHosts.columns)
  const occupiedHostRowids = new Set(oldHosts.rows.map(row => row.sourceRowId))
  for (const row of hosts.rows) {
    const id = graph3Text(row.cells[hostId], encoding)
    const prior = oldHosts.rows.find(candidate => graph3Text(candidate.cells[oldHosts.columns.indexOf('document_id')], encoding) === id)
    if (prior) assert.equal(row.sourceRowId, prior.sourceRowId, 'Retained host state keeps its native rowid')
    else assert.equal(occupiedHostRowids.has(row.sourceRowId), false, 'New host state does not reuse a retained old rowid')
    newGuard(row.cells[hosts.columns.indexOf('cursor')], 'host:' + id)
    assert.deepEqual(row.cells[hosts.columns.indexOf('position')], ['integer', '0'])
  }
  assert.deepEqual(read('synced_group_history').rows, [])
  assert.deepEqual(read('synced_host_history_documents').rows, [])
  const observationNames = ['documents', 'synced_groups', 'synced_instances', ...stage3CutProtectedTables,
    'synced_host_history', 'synced_operations', 'synced_group_pins', 'document_block_moves']
  assert.deepEqual(value.retainedCut.observations.map(row => row.table).sort(), [...observationNames].sort())
  for (const observation of value.retainedCut.observations) {
    const original = current.tables.find(table => table.name === observation.table)!
    const actual = read(observation.table)
    const table = { ...original, columns: actual.columns, rows: actual.rows }
    assert.equal(observation.rows, actual.rows.length)
    assert.equal(observation.rawTableHash, hash('knowbook.restore.stage3.retained-cut.observed-table.v1', table))
    if (['synced_host_history', 'synced_operations', 'synced_group_pins', 'document_block_moves'].includes(observation.table))
      assert.deepEqual(actual.rows, sortRows(original.rows), observation.table + ' original evidence')
  }
  const saved = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?')
    .get('knowbook.root.restore.retained-cut.v1.' + value.stageId) as { value: string; updated_at: string } | undefined
  assert.ok(saved)
  const record = JSON.parse(saved.value)
  assert.equal(record.kind, 'root-restore-current-retained-cut'); assert.equal(record.version, 1)
  assert.equal(record.cutHash, value.retainedCut.cutHash)
  assert.equal(hash('knowbook.restore.stage3.retained-cut.record.v1', record), value.retainedCut.recordHash)
  assert.equal(saved.updated_at, record.bindings.preparedAt)
  assert.equal(record.workspace.workspaceScope, graph3Text(originalWorkspace.rows[0].cells[workspace.columns.indexOf('workspace_scope')], encoding))
  assert.equal(record.workspace.beforeEpoch, graph3Text(originalWorkspace.rows[0].cells[epoch], encoding))
  assert.equal(record.workspace.afterEpoch, graph3Text(workspace.rows[0].cells[epoch], encoding))
  assert.equal(record.archive.encoding, encoding)
  assert.equal(record.archive.currentOriginalRawTablesHash, hash('knowbook.restore.stage3.retained-cut.all-original-tables.v1', current.tables))
  if (documents.rows.length) assert.deepEqual([...boundaries], [record.documentBoundary])
  assert.deepEqual(record.counts, { documents: documents.rows.length, hosts: hosts.rows.length, groups: groups.rows.length,
    activeGroups: activeCount, instances: instances.rows.length,
    archivedHostMappings: current.tables.find(table => table.name === 'synced_host_history_documents')!.rows.length,
    archivedGroupHistory: current.tables.find(table => table.name === 'synced_group_history')!.rows.length,
    retainedOperations: read('synced_operations').rows.length, retainedPins: read('synced_group_pins').rows.length })
  assert.deepEqual((record.archive.tables as Array<{ table: string }>).map(row => row.table).sort(),
    ['app_settings', 'documents', 'document_block_moves', 'synced_workspace_state', 'synced_groups', 'synced_instances',
      'synced_host_history_state', 'synced_host_history_documents', 'synced_host_history', 'synced_group_history',
      'synced_operations', 'synced_group_pins', 'synced_group_lifecycle'].sort())
  for (const descriptor of record.archive.tables as Array<{ table: string; rows: number; rawTableHash: string }>) {
    const original = current.tables.find(table => table.name === descriptor.table); assert.ok(original)
    assert.equal(descriptor.rows, original.rows.length)
    assert.equal(descriptor.rawTableHash, hash('knowbook.restore.stage3.retained-cut.original-table.v1', original))
  }
  assert.equal(value.retainedCut.oldGroupHistoryExecutable, false)
  assert.equal(value.retainedCut.oldHostHistoryMappingsExecutable, false)
  assert.equal(value.retainedCut.originalCommittedAcksRetained, true)
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
    assertStage3PreCutOracle(value, expected)
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
        assertStage3PostCutNative(db, value, expected, f.sourcePacket.source.sourceContent,
          f.currentPacket.source.sourceContent, f.prepared.value.candidate.activeGroupWires.map(wire => wire.id))
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
    assert.equal(value.finalCurrentRetainedCutComplete, true)
    for (const flag of ['currentStageComplete', 'historyCutComplete', 'semanticValidationComplete',
      'acceptedCoverage', 'effective', 'permit', 'installPermit'] as const) assert.equal(value[flag], false)
  }, undefined, undefined, { encoding })
}
