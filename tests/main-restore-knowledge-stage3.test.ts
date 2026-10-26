// Calls the real Main stage factory and inspects independent copies of its
// actual SQL output. No model
// DTO, test path, row map, callback or fault flag is passed to that factory.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { appendFileSync, constants, realpathSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import Database from 'better-sqlite3'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { rawRestoreSqlCell, type RawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'
import { capsule2DerivedFtsTables, type Capsule2Encoding } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { MERGE3_CONTENT_TABLES } from '../src/main/database/restore-knowledge-merge3-storage'
import { prepareRootRestorePhysicalStage3, readRootRestorePhysicalStage3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { stage3MarkerKey } from '../src/main/database/restore-knowledge-stage3-marker-model'
import { assertSyncedStoredBindings } from '../src/main/database/synced-stored-binding-read'
import { syncedLifecycleSemanticHash } from '../src/main/database/synced-lifecycle-state'
import { KnowbookStore } from '../src/main/database/store'
import { inspectOrdinaryRestoreDatabase, inspectRawRestoreConnection } from '../src/main/database/restore-safety-read'
import { parseSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { withStage3Fixture } from './helpers/stage3-fixture'
import { expectedStage3Execution } from './helpers/stage3-execution-oracle'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'

type NativeRow = { sourceRowId: string; cells: readonly RawRestoreSqlCell[] }
const trace = process.env.KNOWBOOK_STAGE3_TEST_TRACE, started = Date.now()
const mark = (phase: string) => { if (trace) appendFileSync(trace, JSON.stringify({ phase, elapsedMs: Date.now() - started }) + '\n') }
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const sorted = <T extends NativeRow>(rows: readonly T[]) => [...rows].sort((a, b) => BigInt(a.sourceRowId) < BigInt(b.sourceRowId) ? -1 : BigInt(a.sourceRowId) > BigInt(b.sourceRowId) ? 1 : 0)
function nativeTable(db: Database.Database, name: string) {
  const encoding = db.pragma('encoding', { simple: true }) as Capsule2Encoding
  const columns = db.prepare('SELECT * FROM main.' + quote(name) + ' LIMIT 0').columns().map(column => column.name)
  const sql = (db.prepare("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string }).sql
  const rowid = !/\bWITHOUT\s+ROWID\b/i.test(sql), project = columns.flatMap(column => [
    'typeof(' + quote(column) + ')', 'CASE WHEN typeof(' + quote(column) + ")='text' THEN CAST(" + quote(column) + ' AS BLOB) ELSE ' + quote(column) + ' END'
  ]).join(',')
  const rows = (db.prepare('SELECT ' + (rowid ? '_rowid_,' : '') + project + ' FROM main.' + quote(name) + (rowid ? ' ORDER BY _rowid_' : ''))
    .safeIntegers(true).raw(true).all() as unknown[][]).map(row => ({ sourceRowId: rowid ? String(row[0]) : '',
      cells: columns.map((_column, index) => rawRestoreSqlCell(row[index * 2 + (rowid ? 1 : 0)], row[index * 2 + (rowid ? 2 : 1)], encoding)) }))
  if (!rowid) rows.sort((a, b) => capsuleJson(a.cells) < capsuleJson(b.cells) ? -1 : capsuleJson(a.cells) > capsuleJson(b.cells) ? 1 : 0)
  return { columns, rows }
}
function nativeSnapshot(db: Database.Database) {
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all()
  const tables = (db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name").all() as Array<{ name: string }>)
    .map(row => ({ name: row.name, ...nativeTable(db, row.name) }))
  return { schema, userVersion: db.pragma('user_version', { simple: true }), encoding: db.pragma('encoding', { simple: true }), tables }
}
async function diskInventory(directory: string) {
  const records = []
  for (const name of ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm']) {
    try { const bytes = await readFile(join(directory, name)); records.push({ name, present: true, bytes: bytes.length, sha256: capsuleBytesHash(bytes) }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; records.push({ name, present: false, bytes: 0, sha256: null }) }
  }
  return records
}
async function probe<T>(sourceDirectory: string, probeRoot: string, run: (db: Database.Database) => T): Promise<T> {
  const before = await diskInventory(sourceDirectory), target = join(probeRoot, 'stage3-core-probe-' + randomUUID())
  await mkdir(target)
  for (const file of before) if (file.present) await copyFile(join(sourceDirectory, file.name), join(target, file.name), constants.COPYFILE_EXCL)
  assert.deepEqual(await diskInventory(target), before)
  const db = new Database(join(target, 'knowbook.db'), { readonly: true, fileMustExist: true })
  try { db.pragma('foreign_keys=ON'); db.pragma('query_only=ON'); return db.transaction(() => run(db))() }
  finally { db.close(); assert.deepEqual(await diskInventory(sourceDirectory), before, 'The sealed stage is never opened by this SQL oracle') }
}
test('actual Main physical stage atomically materializes the complete candidate and preserves current evidence without granting execution', { concurrency: false }, t =>
  withStage3Fixture(async f => {
    mark('fixture-returned')
    const baseBytes = await readFile(join(f.base.directory, 'manifest.json')), referenceBytes = await readFile(join(f.prepared.directory, 'manifest.json'))
    const prepared = await prepareRootRestorePhysicalStage3(f.prepared.plan), value = prepared.value
    const expected = expectedStage3Execution(f.prepared.value, f.sourcePacket, f.currentPacket)
    mark('physical-stage-prepared')
    const databaseDirectory = join(prepared.directory, 'database'), manifestPath = join(prepared.directory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { sealedInventory: Awaited<ReturnType<typeof diskInventory>>; copyId: string; physicalObservationHash: string }
    const operationRoot = dirname(dirname(prepared.directory)), copyDatabase = join(operationRoot, 'restore-current-copies-v3', manifest.copyId, 'database')
    const copyBefore = await diskInventory(copyDatabase), sealedBefore = await diskInventory(databaseDirectory)
    assert.deepEqual(sealedBefore, manifest.sealedInventory)
    assert.equal(value.physicalObservationHash, manifest.physicalObservationHash)
    const slot = (kind: string, id: string) => {
      const found = f.prepared.value.allocation.assignments.filter(item => item.physical && item.kind === kind && item.sourceId === id)
      assert.equal(found.length, 1); return found[0]
    }

    await t.test('all twelve real SQL tables preserve target rowids storage classes canonical text and native ordinary title and template meaning', async () => {
      mark('case-native-content')
      assert.deepEqual([...value.tables.map(table => table.name)].sort(), [...MERGE3_CONTENT_TABLES].sort())
      assert.deepEqual(value.tables, expected.tables, 'Only the exact declared execution columns may differ from the complete canonical candidate')
      assert.deepEqual(value.executionChanges, expected.executionChanges)
      assert.equal(value.checkedCanonicalCandidateHash, f.prepared.value.candidate.checkedCanonicalCandidateHash)
      assert.equal(value.sourceCandidate12TablesHash, expected.sourceCandidate12TablesHash)
      assert.equal(value.physical12TablesHash, expected.physical12TablesHash)
      assert.equal(value.stageExecutionHash, expected.stageExecutionHash)
      assert.ok(expected.executionChanges.some(change => change.table === 'synced_groups' && change.proofKind === 'new-incoming-allocation'))
      assert.ok(expected.executionChanges.some(change => change.table === 'synced_instances' && change.proofKind === 'new-incoming-allocation'))
      for (const [packet, names] of [[f.sourcePacket, f.cases.sourceSwapViews], [f.currentPacket, f.cases.currentSwapViews]] as const) {
        const content = packet.source.sourceContent, views = content.tables.find(table => table.name === 'database_saved_views')!
        for (const view of names) {
          const row = views.rows.find(candidate => graph3Text(candidate.cells[views.columns.indexOf('id')], content.encoding) === view.id)!
          assert.ok(row)
          assert.equal(graph3Text(row.cells[views.columns.indexOf('name')], content.encoding), view.name)
        }
      }
      const plannedViews = expected.tables.find(table => table.name === 'database_saved_views')!
      for (const view of f.cases.sourceSwapViews) {
        const current = f.cases.currentSwapViews.find(row => row.id === view.id)!
        assert.notEqual(current.name, view.name, 'The source/current view names genuinely exchange under the same native unique index')
        const row = plannedViews.rows.find(candidate => graph3Text(candidate.cells[plannedViews.columns.indexOf('id')], plannedViews.encoding) === view.id)!
        assert.ok(row); assert.equal(row.sourceRef.side, 'source')
        assert.equal(graph3Text(row.cells[plannedViews.columns.indexOf('name')], plannedViews.encoding), view.name)
      }
      for (const [packet, entities] of [[f.sourcePacket, f.cases.sourceSwapEntities], [f.currentPacket, f.cases.currentSwapEntities]] as const) {
        const content = packet.source.sourceContent, table = content.tables.find(candidate => candidate.name === 'database_entities')!
        for (const entity of entities) {
          const row = table.rows.find(candidate => graph3Text(candidate.cells[table.columns.indexOf('id')], content.encoding) === entity.id)!
          assert.ok(row)
          assert.equal(graph3Text(row.cells[table.columns.indexOf('document_id')], content.encoding), entity.document_id)
        }
      }
      const plannedEntities = expected.tables.find(table => table.name === 'database_entities')!
      for (const entity of f.cases.sourceSwapEntities) {
        const current = f.cases.currentSwapEntities.find(row => row.id === entity.id)!
        assert.notEqual(current.document_id, entity.document_id, 'Both real entity document bindings must exchange under the immediate uniqueness trigger')
        const row = plannedEntities.rows.find(candidate => graph3Text(candidate.cells[plannedEntities.columns.indexOf('id')], plannedEntities.encoding) === entity.id)!
        assert.ok(row); assert.equal(row.sourceRef.side, 'source')
        assert.equal(graph3Text(row.cells[plannedEntities.columns.indexOf('document_id')], plannedEntities.encoding), entity.document_id)
      }
      await probe(databaseDirectory, f.receiver.root, db => {
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
        assert.deepEqual(db.pragma('foreign_key_check'), [])
        for (const table of value.tables) {
          const actual = nativeTable(db, table.name)
          assert.deepEqual(actual.columns, table.columns)
          assert.deepEqual(actual.rows, sorted(table.rows.map(row => ({ sourceRowId: row.targetRowId, cells: row.cells }))), table.name)
        }
        const counts = db.prepare('SELECT d.id,d.block_count,d.child_count,(SELECT count(*) FROM blocks b WHERE b.document_id=d.id) AS actual_blocks,' +
          '(SELECT count(*) FROM documents child WHERE child.parent_id=d.id) AS actual_children FROM documents d ORDER BY d.id')
          .all() as Array<{ id: string; block_count: number; child_count: number; actual_blocks: number; actual_children: number }>
        for (const row of counts) {
          assert.equal(row.block_count, row.actual_blocks, 'Actual physical block count for ' + row.id)
          assert.equal(row.child_count, row.actual_children, 'Actual physical child count for ' + row.id)
        }
        const selectedHost = counts.find(row => row.id === slot('document', f.cases.linkedHostId).targetId)!
        assert.ok(selectedHost)
        assert.equal(f.cases.sourceLinkedHostBlockCount, 3); assert.equal(f.cases.currentLinkedHostBlockCount, 4)
        assert.equal(selectedHost.actual_blocks, f.cases.sourceLinkedHostBlockCount)
        assert.notEqual(selectedHost.actual_blocks, f.cases.currentLinkedHostBlockCount, 'The real writer must handle a net block-count decrease')
        for (const view of f.cases.sourceSwapViews)
          assert.deepEqual(db.prepare('SELECT id,name FROM database_saved_views WHERE id=?').get(view.id), view,
            'The actual native unique-index write must restore both source names, including a two-row swap')
        assert.equal(db.prepare('SELECT 1 FROM database_saved_views WHERE database_id=? AND name=?')
          .get(f.cases.swappedViewDatabaseId, 'Stage Swap Temporary'), undefined)
        for (const entity of f.cases.sourceSwapEntities)
          assert.deepEqual(db.prepare('SELECT id,document_id FROM database_entities WHERE id=?').get(entity.id), entity,
            'The actual native uniqueness-trigger write must restore both source entity bindings')
        assert.deepEqual(db.prepare('SELECT CAST(_rowid_ AS TEXT) AS rowid,entity_id,column_id,value_text,updated_at FROM database_entity_values WHERE column_id=? ORDER BY entity_id')
          .all(f.cases.swappedEntityColumnId), f.cases.sourceSwapEntityValues, 'The swap preserves every original child value and its technical rowid')
        const document = db.prepare('SELECT title FROM documents WHERE id=?').get(slot('document', f.cases.longDocumentId).targetId) as { title: string }
        assert.equal(document.title, f.cases.longTitle); assert.equal(document.title.length, 501)
        const template = db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(f.cases.template.id) as { blocks_json: string }
        const blocks = JSON.parse(template.blocks_json) as Array<{ id: string; content: string }>
        assert.equal(blocks[0].id, f.cases.linkedId)
        assert.notEqual(blocks[0].id, slot('block', f.cases.linkedId).targetId)
        assert.equal(parseSyncedBlockPayload(blocks[0].content).groupId, slot('group', f.cases.linkedGroupId).targetId)
        const linked = db.prepare('SELECT content FROM synced_group_blocks WHERE id=?').get(slot('block', f.cases.linkedId).targetId) as { content: string }
        assert.ok(linked.content.includes('😀 ')); assert.ok(linked.content.includes('\r\n<a href='))
      })
    })
    await t.test('actual ledger reservations complete source instances retained external references and active orphan lifecycle agree with final wires', async () => {
      mark('case-ledger-lifecycle')
      await probe(databaseDirectory, f.receiver.root, db => {
        assert.deepEqual(nativeTable(db, 'block_identities'), { columns: value.ledger.columns, rows: sorted(value.ledger.rows) })
        assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id=? UNION ALL SELECT 1 FROM synced_group_blocks WHERE id=?')
          .get(f.cases.currentOnlyBlockId, f.cases.currentOnlyBlockId), undefined)
        assert.deepEqual(db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(f.cases.currentOnlyBlockId),
          { ...f.cases.currentOnlyBlockLedger, state: 'retained' }, 'The removed current block keeps its exact original birth and document owner')
        assert.equal(f.cases.currentOnlyBlockLedger.created_at, f.cases.currentOnlyBlockBirth)
        assert.equal(f.cases.currentOnlyBlockLedger.last_owner_id, f.cases.linkedHostId)
        for (const row of f.prepared.value.allocation.materialization.reservationRows) {
          assert.deepEqual(db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(row.id),
            { id: row.id, last_owner_kind: 'reserved', last_owner_id: row.last_owner_id, state: 'retained', created_at: null })
          assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id=? UNION ALL SELECT 1 FROM synced_group_blocks WHERE id=?').get(row.id, row.id), undefined)
        }
        const newGroup = slot('group', f.cases.linkedGroupId).targetId
        const members = db.prepare('SELECT instance_id FROM synced_instances WHERE group_id=? ORDER BY instance_id').all(newGroup) as Array<{ instance_id: string }>
        assert.deepEqual(members.map(row => row.instance_id), f.cases.linkedInstanceIds.map(id => slot('block', id).targetId).sort())
        assert.deepEqual(db.prepare('SELECT group_id,host_document_id FROM synced_instances WHERE instance_id=?').get(f.cases.externalInstanceId),
          { group_id: f.cases.linkedGroupId, host_document_id: f.cases.externalHostId })
        assert.equal((db.prepare('SELECT count(*) AS n FROM synced_instances WHERE group_id=?').get(f.cases.linkedGroupId) as { n: number }).n, 1)
        const oldGroupIds = new Set(f.currentPacket.source.physical.groups.map(group => group.groupId))
        const newWires = f.prepared.value.candidate.activeGroupWires.filter(wire => !oldGroupIds.has(wire.id))
        assert.equal(value.lifecycleAdded.length, newWires.length)
        for (const wire of newWires) {
          const life = db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(wire.id) as Record<string, unknown>
          const allocated = f.prepared.value.allocation.execution.groups.find(group => group.targetGroupId === wire.id)!
          assert.equal(life.state, 'active'); assert.equal(life.state_version, 1); assert.equal(life.exposure_state, 'unknown'); assert.equal(life.create_history_id, null)
          assert.equal(life.activation_revision, allocated.revision); assert.equal(life.activation_topology_revision, allocated.topologyRevision)
          assert.equal(life.activation_hash, syncedLifecycleSemanticHash(wire))
          const actual = db.prepare('SELECT instance_id AS instanceId,host_document_id AS hostDocumentId,binding_version AS bindingVersion FROM synced_instances WHERE group_id=? ORDER BY instance_id').all(wire.id)
          assert.deepEqual(JSON.parse(String(life.activation_instances_json)), actual)
          assertSyncedStoredBindings(db, wire.origin, wire.blocks, wire.bindings)
        }
        const orphanId = slot('group', f.cases.orphanGroupId).targetId
        assert.equal((db.prepare('SELECT count(*) AS n FROM synced_instances WHERE group_id=?').get(orphanId) as { n: number }).n, 0)
        assert.ok((db.prepare('SELECT count(*) AS n FROM synced_group_blocks WHERE group_id=?').get(orphanId) as { n: number }).n > 0)
        assert.equal((db.prepare('SELECT activation_instances_json FROM synced_group_lifecycle WHERE group_id=?').get(orphanId) as { activation_instances_json: string }).activation_instances_json, '[]')
      })
    })
    await t.test('all old current K history support policy rows and lifecycle cells stay exact except the explicitly declared physical ledger and own marker additions', async () => {
      mark('case-current-preservation')
      const content = new Set<string>(MERGE3_CONTENT_TABLES), fts = new Set([...capsule2DerivedFtsTables(), 'document_search_ids', 'block_search_ids'])
      const expectedNames = f.currentPacket.source.sourceContent.tables.filter(table => !content.has(table.name) && !fts.has(table.name)).map(table => table.name).sort()
      assert.deepEqual(value.protectedObservations.map(table => table.table).sort(), expectedNames)
      await probe(databaseDirectory, f.receiver.root, db => {
        for (const table of f.currentPacket.source.sourceContent.tables) {
          if (content.has(table.name) || fts.has(table.name) || table.name === 'block_identities') continue
          const actual = nativeTable(db, table.name)
          assert.deepEqual(actual.columns, table.columns)
          if (table.name === 'app_settings' || table.name === 'synced_group_lifecycle') {
            const original = new Map(table.rows.map(row => [row.sourceRowId, row]))
            assert.deepEqual(actual.rows.filter(row => original.has(row.sourceRowId)), sorted(table.rows), table.name)
            assert.equal(actual.rows.length - original.size, table.name === 'app_settings' ? 1 : value.lifecycleAdded.length)
          } else assert.deepEqual(actual.rows, sorted(table.rows), table.name)
        }
        const own = db.prepare('SELECT value FROM app_settings WHERE key=?').get(stage3MarkerKey(prepared.stageId)) as { value: string }
        assert.equal(JSON.parse(own.value).stageIntentHash, value.stageIntentHash)
      })
      assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
      assert.deepEqual(await diskInventory(copyDatabase), copyBefore)
    })
    await t.test('a genuine stage remains non-executable and copied handles cannot supply source paths rows or installation rights', async () => {
      mark('case-private-owner')
      for (const key of ['currentStageComplete', 'historyCutComplete', 'finalCurrentRetainedCutComplete', 'semanticValidationComplete', 'acceptedCoverage', 'effective', 'permit', 'installPermit'] as const)
        assert.equal(value[key], false)
      assert.equal(value.materializedInIndependentSql, true)
      await assert.rejects(prepareRootRestorePhysicalStage3({ ...f.prepared.plan }))
      await assert.rejects(readRootRestorePhysicalStage3({ ...prepared.stage }))
      let calls = 0
      const fake = Object.defineProperty({}, 'kind', { get() { calls++; throw new Error('caller getter') } })
      await assert.rejects(prepareRootRestorePhysicalStage3(fake as never))
      assert.equal(calls, 0)
      await probe(databaseDirectory, f.receiver.root, db => {
        let unexpected: KnowbookStore | undefined
        try { assert.throws(() => { unexpected = new KnowbookStore(db.name) }, /未知恢复边界metadata版本/) }
        finally { unexpected?.destroy() }
        assert.throws(() => inspectOrdinaryRestoreDatabase(db.name), /未知恢复边界metadata版本/)
        assert.throws(() => inspectRawRestoreConnection(db), /未知恢复边界metadata版本/)
      })
    })
    await t.test('hot stage reads reject changed stage manifests and changed original reference kernels instead of replaying a cached observation', async () => {
      mark('case-manifests')
      for (const path of [manifestPath, join(prepared.directory, 'intent.json'), join(f.prepared.directory, 'manifest.json')]) {
        const bytes = await readFile(path)
        try { await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')])); await assert.rejects(readRootRestorePhysicalStage3(prepared.stage)) }
        finally { await writeFile(path, bytes) }
      }
      assert.deepEqual(await readFile(join(f.base.directory, 'manifest.json')), baseBytes)
      assert.deepEqual(await readFile(join(f.prepared.directory, 'manifest.json')), referenceBytes)
    })
    await t.test('a fault after native FTS verification rolls back the real marker business ledger lifecycle and every original SQL table', async child => {
      mark('case-real-rollback')
      const collection = dirname(prepared.directory), priorDirectories = new Set(await readdir(collection))
      const nativeTransaction = Database.prototype.transaction, nativePrepare = Database.prototype.prepare
      let before: ReturnType<typeof nativeSnapshot> | undefined, failedPath: string | undefined, injected = false
      const owned = (db: Database.Database) => {
        if (db.readonly || db.memory) return false
        // Native SQLite uses a namespaced Windows filename; compare actual
        // filesystem paths so the fault really reaches its write transaction.
        const actual = realpathSync.native(db.name), local = relative(realpathSync.native(collection), actual)
        return local !== '' && !isAbsolute(local) && !local.startsWith('..' + sep) && !local.startsWith(sep)
          && basename(dirname(actual)) === 'database' && basename(actual) === 'knowbook.db'
      }
      const transactionMock = child.mock.method(Database.prototype, 'transaction', function (this: Database.Database, fn: (...args: unknown[]) => unknown) {
        const db = this
        if (!owned(db)) return Reflect.apply(nativeTransaction, db, [fn])
        return Reflect.apply(nativeTransaction, db, [function (this: unknown, ...args: unknown[]) {
          assert.equal(db.inTransaction, true); assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
          assert.equal(before, undefined, 'Exactly one real write transaction is observed')
          before = nativeSnapshot(db); failedPath = realpathSync.native(db.name)
          return Reflect.apply(fn, this, args)
        }])
      } as typeof Database.prototype.transaction)
      const prepareMock = child.mock.method(Database.prototype, 'prepare', function (this: Database.Database, sql: string) {
        const db = this, statement = Reflect.apply(nativePrepare, db, [sql]) as Database.Statement
        if (!owned(db) || !sql.includes('integrity-check') || !sql.includes('block_search')) return statement
        const nativeRun = statement.run
        child.mock.method(statement, 'run', function (...args: unknown[]) {
          const result = Reflect.apply(nativeRun, statement, args)
          assert.equal(db.inTransaction, true)
          const scalar = (query: string) => (Reflect.apply(nativePrepare, db, [query]) as Database.Statement).get() as { n: number }
          const markerRows = scalar("SELECT count(*) AS n FROM app_settings WHERE key>='synced.recovery.history.stage3.' AND key<'synced.recovery.history.stage3/'")
          assert.equal(markerRows.n, 1)
          assert.ok(scalar('SELECT count(*) AS n FROM synced_group_lifecycle').n > f.currentPacket.source.physical.groups.length)
          assert.ok(result)
          injected = true
          throw new Error('stage3-test-late-native-rollback')
        } as typeof statement.run)
        return statement
      } as typeof Database.prototype.prepare)
      try { await assert.rejects(prepareRootRestorePhysicalStage3(f.prepared.plan), /stage3-test-late-native-rollback/) }
      finally { prepareMock.mock.restore(); transactionMock.mock.restore() }
      assert.equal(injected, true, 'The real native integrity-check ran after SQL mutations; this is not an early admission failure')
      assert.ok(before); assert.ok(failedPath)
      const added = (await readdir(collection)).filter(name => !priorDirectories.has(name))
      assert.equal(added.length, 1)
      const failed = join(collection, added[0])
      assert.equal(realpathSync.native(failedPath), realpathSync.native(join(failed, 'database', 'knowbook.db')))
      assert.equal((await readdir(failed)).includes('manifest.json'), false, 'A failed SQL transaction never publishes a completed stage manifest')
      await probe(join(failed, 'database'), f.receiver.root, db => {
        assert.deepEqual(nativeSnapshot(db), before)
        assert.equal(db.prepare("SELECT 1 FROM app_settings WHERE key>='synced.recovery.history.stage3.' AND key<'synced.recovery.history.stage3/'").get(), undefined)
      })
      assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    })
    await t.test('a fresh complete hot read reconstructs the same actual SQL result after failures and leaves both live stores and immutable input copies untouched', async () => {
      mark('case-final-hot-read')
      assert.deepEqual(await readRootRestorePhysicalStage3(prepared.stage), value)
      assert.deepEqual(await diskInventory(databaseDirectory), sealedBefore)
      assert.deepEqual(await diskInventory(copyDatabase), copyBefore)
      assert.deepEqual(await readFile(join(f.base.directory, 'manifest.json')), baseBytes)
      assert.deepEqual(await readFile(join(f.prepared.directory, 'manifest.json')), referenceBytes)
      assert.deepEqual(allTables(f.source.db), f.beforeSource); assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    })
    mark('complete')
  }, phase => mark('fixture:' + phase)))
