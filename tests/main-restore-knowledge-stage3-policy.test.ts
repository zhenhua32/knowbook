import assert from 'node:assert/strict'
import test from 'node:test'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { capsuleBytesHash } from '../src/main/database/restore-knowledge-capsule-model'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { rawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'
import { capsule2DerivedFtsTables, type Capsule2Encoding } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { MERGE3_CONTENT_TABLES } from '../src/main/database/restore-knowledge-merge3-storage'
import { prepareRootRestorePhysicalStage3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { withStage3Fixture } from './helpers/stage3-fixture'
import { expectedStage3Execution } from './helpers/stage3-execution-oracle'

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
function rows(db: Database.Database, name: string) {
  const encoding = db.pragma('encoding', { simple: true }) as Capsule2Encoding
  const columns = db.prepare('SELECT * FROM main.' + quote(name) + ' LIMIT 0').columns().map(column => column.name)
  const projection = columns.flatMap(column => ['typeof(' + quote(column) + ')', 'CASE WHEN typeof(' + quote(column) + ")='text' THEN CAST(" + quote(column) + ' AS BLOB) ELSE ' + quote(column) + ' END']).join(',')
  return (db.prepare('SELECT _rowid_,' + projection + ' FROM main.' + quote(name) + ' ORDER BY _rowid_').safeIntegers(true).raw(true).all() as unknown[][])
    .map(row => ({ sourceRowId: String(row[0]), cells: columns.map((_column, index) => rawRestoreSqlCell(row[index * 2 + 1], row[index * 2 + 2], encoding)) }))
}

test('preserving an exact current group tuple retains the actual later current execution boundary instead of reinstalling older source guards', { concurrency: false }, () =>
  withStage3Fixture(async f => {
    const candidate = f.prepared.value.candidate, allocation = f.prepared.value.allocation
    assert.equal(allocation.choices.originPolicy, 'preserve-exact-current-tuple')
    assert.equal(allocation.forcedGroupForks.length, 0)
    const source = f.sourcePacket.source.sourceContent, current = f.currentPacket.source.sourceContent
    const sourceGroups = source.tables.find(table => table.name === 'synced_groups')!, currentGroups = current.tables.find(table => table.name === 'synced_groups')!
    const originalSource = sourceGroups.rows.find(row => graph3Text(row.cells[sourceGroups.columns.indexOf('id')], source.encoding) === f.cases.linkedGroupId)!
    const originalCurrent = currentGroups.rows.find(row => graph3Text(row.cells[currentGroups.columns.indexOf('id')], current.encoding) === f.cases.linkedGroupId)!
    assert.ok(originalSource); assert.ok(originalCurrent)
    const sourceTopology = originalSource.cells[sourceGroups.columns.indexOf('topology_revision')]
    const currentTopology = originalCurrent.cells[currentGroups.columns.indexOf('topology_revision')]
    assert.notDeepEqual(sourceTopology, currentTopology, 'The true Main insertion of the third current instance must have advanced topology')
    const candidateGroups = candidate.tables.find(table => table.name === 'synced_groups')!
    const selected = candidateGroups.rows.find(row => graph3Text(row.cells[candidateGroups.columns.indexOf('id')], candidateGroups.encoding) === f.cases.linkedGroupId)!
    assert.equal(selected.sourceRef.side, 'source')
    assert.deepEqual(selected.cells[candidateGroups.columns.indexOf('topology_revision')], sourceTopology,
      'This fixture actually presents the older source boundary to the stage transform')
    const expected = expectedStage3Execution(f.prepared.value, f.sourcePacket, f.currentPacket)
    const repair = expected.executionChanges.find(change => change.table === 'synced_groups' && change.targetId === f.cases.linkedGroupId)!
    assert.ok(repair); assert.equal(repair.proofKind, 'current-boundary-preserved')
    assert.ok(repair.currentSourceRef)
    const topology = repair.cells.find(cell => cell.column === 'topology_revision')!
    assert.ok(topology); assert.deepEqual(topology.before, sourceTopology); assert.deepEqual(topology.after, currentTopology)
    assert.equal(topology.allocationField, null)
    assert.equal(expected.executionChanges.some(change => change.proofKind === 'new-incoming-allocation'), false)

    const prepared = await prepareRootRestorePhysicalStage3(f.prepared.plan), value = prepared.value
    assert.deepEqual(value.tables, expected.tables)
    assert.deepEqual(value.executionChanges, expected.executionChanges)
    assert.equal(value.sourceCandidate12TablesHash, expected.sourceCandidate12TablesHash)
    assert.equal(value.physical12TablesHash, expected.physical12TablesHash)
    assert.equal(value.stageExecutionHash, expected.stageExecutionHash)
    assert.deepEqual(value.lifecycleAdded, [], 'Existing current lifecycles are never re-created or patched to fake a cut')
    assert.equal(value.historyCutComplete, false); assert.equal(value.finalCurrentRetainedCutComplete, false)
    assert.equal(value.currentStageComplete, false); assert.equal(value.installPermit, false)

    const manifest = JSON.parse(await readFile(join(prepared.directory, 'manifest.json'), 'utf8')) as {
      sealedInventory: Array<{ name: string; present: boolean; bytes: number; sha256: string | null }>
    }
    assert.deepEqual(manifest.sealedInventory.map(file => file.name), ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm'])
    const inspection = join(f.receiver.root, 'stage3-policy-probe-' + randomUUID())
    await mkdir(inspection)
    for (const file of manifest.sealedInventory) if (file.present) {
      const original = join(prepared.directory, 'database', file.name), bytes = await readFile(original)
      assert.equal(bytes.length, file.bytes); assert.equal(capsuleBytesHash(bytes), file.sha256)
      await copyFile(original, join(inspection, file.name), constants.COPYFILE_EXCL)
    }
    const db = new Database(join(inspection, 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      db.pragma('foreign_keys=ON'); db.pragma('query_only=ON')
      db.transaction(() => {
        for (const table of value.tables) assert.deepEqual(rows(db, table.name), table.rows
          .map(row => ({ sourceRowId: row.targetRowId, cells: row.cells })).sort((a, b) => BigInt(a.sourceRowId) < BigInt(b.sourceRowId) ? -1 : BigInt(a.sourceRowId) > BigInt(b.sourceRowId) ? 1 : 0), table.name)
        const nativeGroups = rows(db, 'synced_groups'), groupIdColumn = currentGroups.columns.indexOf('id')
        for (const prior of currentGroups.rows) {
          const id = graph3Text(prior.cells[groupIdColumn], current.encoding)
          const actual = nativeGroups.find(row => graph3Text(row.cells[groupIdColumn], current.encoding) === id)!
          assert.ok(actual)
          for (const column of ['revision', 'topology_revision', 'history_cursor', 'history_position']) {
            const index = currentGroups.columns.indexOf(column)
            assert.deepEqual(actual.cells[index], prior.cells[index], id + ':' + column)
          }
        }
        const currentInstances = current.tables.find(table => table.name === 'synced_instances')!, nativeInstances = rows(db, 'synced_instances')
        const idColumn = currentInstances.columns.indexOf('instance_id'), bindingColumn = currentInstances.columns.indexOf('binding_version')
        for (const prior of currentInstances.rows) {
          const id = graph3Text(prior.cells[idColumn], current.encoding)
          const actual = nativeInstances.find(row => graph3Text(row.cells[idColumn], current.encoding) === id)!
          assert.ok(actual); assert.deepEqual(actual.cells[bindingColumn], prior.cells[bindingColumn])
        }
        assert.deepEqual(db.prepare('SELECT group_id,host_document_id FROM synced_instances WHERE instance_id=?').get(f.cases.externalInstanceId),
          { group_id: f.cases.linkedGroupId, host_document_id: f.cases.externalHostId })
        const content = new Set<string>(MERGE3_CONTENT_TABLES), fts = new Set([...capsule2DerivedFtsTables(), 'document_search_ids', 'block_search_ids'])
        for (const table of current.tables) {
          if (content.has(table.name) || fts.has(table.name) || table.name === 'block_identities') continue
          const actual = rows(db, table.name)
          if (table.name === 'app_settings') {
            const originalIds = new Set(table.rows.map(row => row.sourceRowId))
            assert.equal(actual.length, originalIds.size + 1)
            assert.deepEqual(actual.filter(row => originalIds.has(row.sourceRowId)), table.rows)
          } else assert.deepEqual(actual, table.rows, table.name)
        }
      })()
    } finally { db.close() }
    for (const file of manifest.sealedInventory) if (file.present) assert.equal(capsuleBytesHash(await readFile(join(prepared.directory, 'database', file.name))), file.sha256)
    assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
  }, undefined, { originPolicy: 'preserve-exact-current-tuple', anonymousValues: 'source' }))
