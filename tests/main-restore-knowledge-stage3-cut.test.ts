// This suite uses actual Main-created SQLite history. The sealed stage marker
// is never removed to make an ordinary repository reader accept the database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import Database from 'better-sqlite3'
import type { Capsule2RawSqlTable } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { graph3Text } from '../src/main/database/restore-knowledge-graph3-data'
import { validateSyncedRestoreHostInput } from '../src/shared/syncedBlockInputs'
import { hostHash } from '../src/main/database/synced-host-journal'
import { readRootRestoreReferenceGraphInputs3 } from '../src/main/database/restore-knowledge-reference3-read'
import { reopenRootRestoreCurrentCopy3 } from '../src/main/database/restore-knowledge-stage3-current-copy'
import { prepareRootRestorePhysicalStage3, readRootRestorePhysicalStage3,
  reopenRootRestorePhysicalStage3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { ROOT3_RETAINED_CUT_PREFIX, planRootRestoreStage3RetainedCut3, assertRootRestoreStage3RetainedCutObserved3,
  probeRootRestoreStage3CutRequest3, type RootRestoreStage3RetainedCutContext3 } from '../src/main/database/restore-knowledge-stage3-cut'
import { readObservedLocalIncarnation } from '../src/main/database/synced-remote-observation-read'
import { holdSyncedObservationPending, releaseSyncedObservationPending, hasSyncedObservationPending,
  observationDatabasePath } from '../src/main/database/synced-remote-observation-pending'
import { allTables } from './helpers/synced-backup-v3-fixture'
import { withStage3CutFixture, cutNativeTable, cutNativeSnapshot, cutDiskInventory, cutProbe } from './helpers/stage3-cut-fixture'
import { expectedStage3Execution, stage3RawTablesForHash } from './helpers/stage3-execution-oracle'

type NativeTable = Pick<Capsule2RawSqlTable, 'columns' | 'rows'>
function rowByKey(table: NativeTable, key: string, value: string) {
  const index = table.columns.indexOf(key)
  assert.ok(index >= 0)
  const rows = table.rows.filter(row => graph3Text(row.cells[index], 'UTF-8') === value)
  assert.equal(rows.length, 1, table.columns.join(',') + ' must contain exactly one ' + key + '=' + value)
  return rows[0]
}
function rowsByKey(table: NativeTable, key: string, value: string) {
  const index = table.columns.indexOf(key)
  assert.ok(index >= 0)
  return table.rows.filter(row => graph3Text(row.cells[index], 'UTF-8') === value)
}
function sameExcept(before: NativeTable, after: NativeTable, key: string, id: string, ignored: readonly string[]) {
  assert.deepEqual(after.columns, before.columns)
  const oldRow = rowByKey(before, key, id), newRow = rowByKey(after, key, id)
  assert.equal(newRow.sourceRowId, oldRow.sourceRowId, 'A retained occurrence keeps its original native rowid')
  for (const [index, column] of before.columns.entries()) if (!ignored.includes(column))
    assert.deepEqual(newRow.cells[index], oldRow.cells[index], 'Retained original cell ' + column)
}

test('actual Main stage cuts the complete retained current component while preserving its real history archives and committed ACK facts',
  { concurrency: false }, t => withStage3CutFixture(async f => {
    const actual = await readRootRestoreReferenceGraphInputs3(f.prepared.plan)
    const incarnation = readObservedLocalIncarnation(f.source.db, f.cases.retained.groupId)
    assert.ok(incarnation, 'The pending lease uses the real current-only immutable group incarnation')
    const livePath = observationDatabasePath(f.source.file), lease = holdSyncedObservationPending(livePath, incarnation)
    try {
      await assert.rejects(prepareRootRestorePhysicalStage3(f.prepared.plan), /仍有未持久化的远端观察/)
      assert.equal(hasSyncedObservationPending(livePath, incarnation), true,
        'Refusing an unpersisted observation does not drain or destroy its live pending lease')
      assert.deepEqual(allTables(f.source.db), f.beforeSource)
      assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    } finally {
      assert.equal(releaseSyncedObservationPending(lease), true)
    }
    const physical = await prepareRootRestorePhysicalStage3(f.prepared.plan)
    const value = physical.value, stageDirectory = join(physical.directory, 'database')
    const intent = JSON.parse(await readFile(join(physical.directory, 'intent.json'), 'utf8')) as RootRestoreStage3RetainedCutContext3
    const context = { stageId: physical.stageId, preparedAt: intent.preparedAt,
      copyId: intent.copyId, copyManifestHash: intent.copyManifestHash }
    const preCut = expectedStage3Execution(f.prepared.value, actual.data.inputs.source, actual.data.inputs.current)
    const plan = planRootRestoreStage3RetainedCut3(actual, stage3RawTablesForHash(preCut.tables), context)
    const copy = await reopenRootRestoreCurrentCopy3(f.prepared.plan,
      { copyId: intent.copyId, expectedManifestHash: intent.copyManifestHash })
    const sourceNative = (name: string) => {
      const table = f.currentNative.tables.find(item => item.name === name)
      assert.ok(table); return table
    }
    const sourceSlot = (kind: string, sourceId: string) => {
      const slots = f.prepared.value.allocation.assignments.filter(item => item.physical && item.kind === kind && item.sourceId === sourceId)
      assert.equal(slots.length, 1); return slots[0].targetId
    }

    await t.test('the source-selected host is replaced while every retained current-only identity birth and content cell survives', async () => {
      await cutProbe(stageDirectory, f.receiver.root, db => {
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
        assert.deepEqual(db.pragma('foreign_key_check'), [])
        const documents = cutNativeTable(db, 'documents'), groups = cutNativeTable(db, 'synced_groups')
        for (const hostId of [f.cases.retained.hostId, f.cases.retired.hostId]) {
          sameExcept(sourceNative('documents'), documents, 'id', hostId, ['updated_at'])
          assert.deepEqual(rowsByKey(cutNativeTable(db, 'blocks'), 'document_id', hostId),
            rowsByKey(sourceNative('blocks'), 'document_id', hostId))
        }
        sameExcept(sourceNative('synced_groups'), groups, 'id', f.cases.retained.groupId,
          ['revision', 'topology_revision', 'history_cursor', 'history_position'])
        sameExcept(sourceNative('synced_instances'), cutNativeTable(db, 'synced_instances'), 'instance_id',
          f.cases.retained.instanceId, ['binding_version'])
        assert.deepEqual(rowsByKey(cutNativeTable(db, 'synced_group_blocks'), 'group_id', f.cases.retained.groupId),
          rowsByKey(sourceNative('synced_group_blocks'), 'group_id', f.cases.retained.groupId))
        for (const id of [f.cases.retained.ordinaryId, f.cases.retained.canonicalId, f.cases.retained.instanceId])
          assert.deepEqual(rowByKey(cutNativeTable(db, 'block_identities'), 'id', id), rowByKey(sourceNative('block_identities'), 'id', id))
        for (const [table, key] of [['synced_groups', 'id'], ['synced_group_lifecycle', 'group_id'],
          ['synced_group_retirements', 'group_id']] as const)
          assert.deepEqual(rowByKey(cutNativeTable(db, table), key, f.cases.retired.groupId),
            rowByKey(sourceNative(table), key, f.cases.retired.groupId), 'A truly retired create remains exact inactive evidence')
        const sourceBlocks = f.sourcePacket.source.sourceContent.tables.find(table => table.name === 'blocks')!
        const sourceBody = rowByKey(sourceBlocks, 'id', f.source.hostBodyId)
        const sourceText = graph3Text(sourceBody.cells[sourceBlocks.columns.indexOf('content')], 'UTF-8')
        const currentBody = rowByKey(sourceNative('blocks'), 'id', f.source.hostBodyId)
        assert.notEqual(graph3Text(currentBody.cells[sourceNative('blocks').columns.indexOf('content')], 'UTF-8'), sourceText,
          'The real current shared journal changed the source-selected host before capture')
        assert.deepEqual(db.prepare('SELECT document_id,content FROM blocks WHERE id=?').get(sourceSlot('block', f.source.hostBodyId)),
          { document_id: sourceSlot('document', f.source.hostId), content: sourceText })
      })
    })

    await t.test('the final cut covers all documents active groups and instances including current-only hosts and new incoming groups', async () => {
      await cutProbe(stageDirectory, f.receiver.root, db => {
        assert.deepEqual(assertRootRestoreStage3RetainedCutObserved3(db, actual, plan), value.retainedCut)
        const scalar = (query: string) => (db.prepare(query).get() as { n: number }).n
        assert.equal(plan.allocation.documents.length, scalar('SELECT count(*) AS n FROM documents'))
        assert.equal(plan.allocation.hosts.length, scalar('SELECT count(*) AS n FROM documents'))
        assert.equal(plan.allocation.instances.length, scalar('SELECT count(*) AS n FROM synced_instances'))
        assert.equal(plan.allocation.groups.length, scalar('SELECT count(*) AS n FROM synced_groups'))
        assert.notEqual(plan.allocation.workspace.afterEpoch, plan.allocation.workspace.beforeEpoch)
        const allocated = [plan.allocation.workspace.afterEpoch, ...plan.allocation.hosts.map(row => row.afterCursor),
          ...plan.allocation.instances.map(row => row.afterBindingVersion)]
        for (const group of plan.allocation.groups) if (group.disposition === 'active') {
          for (const column of ['revision', 'topologyRevision', 'historyCursor'] as const) {
            assert.notEqual(group.after[column], group.beforePhysical[column])
            if (group.beforeCurrent) assert.notEqual(group.after[column], group.beforeCurrent[column])
            allocated.push(group.after[column])
          }
          assert.equal(group.after.historyPosition, '0')
        }
        assert.equal(new Set(allocated).size, allocated.length)
        const currentOnly = plan.allocation.groups.find(row => row.groupId === f.cases.retained.groupId)
        assert.ok(currentOnly?.beforeCurrent)
        assert.equal(currentOnly.disposition, 'active')
        const incoming = plan.allocation.groups.filter(row => row.beforeCurrent === null && row.disposition === 'active')
        assert.ok(incoming.length > 0, 'The same full cut includes genuinely allocated source incoming groups')
        for (const document of plan.allocation.documents) {
          assert.equal(document.afterUpdatedAt, plan.allocation.documentBoundary)
          assert.notEqual(document.afterUpdatedAt, document.candidateUpdatedAt)
          assert.notEqual(document.afterUpdatedAt, document.beforeUpdatedAt)
        }
        for (const host of plan.allocation.hosts) {
          assert.notEqual(host.afterCursor, host.beforeCursor)
          assert.equal(host.afterPosition, '0')
        }
        for (const instance of plan.allocation.instances) {
          assert.notEqual(instance.afterBindingVersion, instance.candidateBindingVersion)
          assert.notEqual(instance.afterBindingVersion, instance.beforeBindingVersion)
        }
      })
      assert.equal(value.finalCurrentRetainedCutComplete, true)
      for (const flag of ['currentStageComplete', 'historyCutComplete', 'semanticValidationComplete', 'acceptedCoverage',
        'effective', 'permit', 'installPermit'] as const) assert.equal(value[flag], false)
    })

    await t.test('real Undo Redo and shared-host tails are archived in the genuine current copy while journals pins and ACK rows stay exact', async () => {
      const archivedGroups = sourceNative('synced_group_history'), archivedMappings = sourceNative('synced_host_history_documents')
      assert.equal(rowsByKey(archivedGroups, 'group_id', f.cases.retained.groupId).length, 2)
      for (const token of [f.cases.sharedFirst.ack.historyToken!, f.cases.sharedSecond.ack.historyToken!])
        assert.equal(rowsByKey(archivedMappings, 'history_id', token).length, 2,
          'Both real participants of each shared host journal are part of the cut')
      assert.ok(f.cases.groupBefore.history.undoToken && f.cases.groupBefore.history.redoToken)
      assert.ok(f.cases.retiredRedo.historyToken, 'A real retired-create Redo was ready before the cut')
      await cutProbe(join(copy.directory, 'database'), f.receiver.root, db => {
        assert.deepEqual(cutNativeSnapshot(db), f.currentNative, 'The genuine archive still contains every original history occurrence and native storage cell')
        for (const descriptor of plan.archiveTables) {
          const original = f.currentPacket.source.sourceContent.tables.find(table => table.name === descriptor.table)!
          assert.equal(descriptor.rows, original.rows.length)
          assert.equal(descriptor.rawTableHash,
            capsuleBytesHash('knowbook.restore.stage3.retained-cut.original-table.v1\0' + capsuleJson(original)))
          assert.deepEqual(cutNativeTable(db, descriptor.table), { columns: original.columns, rows: original.rows })
        }
      })
      await cutProbe(stageDirectory, f.receiver.root, db => {
        for (const name of ['synced_operations', 'synced_host_history', 'synced_group_pins', 'document_block_moves'])
          assert.deepEqual(cutNativeTable(db, name), { columns: sourceNative(name).columns, rows: sourceNative(name).rows })
        assert.deepEqual(cutNativeTable(db, 'synced_group_history').rows, [])
        assert.deepEqual(cutNativeTable(db, 'synced_host_history_documents').rows, [])
        for (const host of f.cases.hostHistory) {
          const state = db.prepare('SELECT cursor,position FROM synced_host_history_state WHERE document_id=?').get(host.documentId) as
            { cursor: string; position: number }
          assert.notEqual(state.cursor, host.history.cursor); assert.equal(state.position, 0)
        }
        const record = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(plan.record.key) as
          { value: string; updated_at: string }
        assert.deepEqual(record, { value: plan.record.json, updated_at: intent.preparedAt })
        assert.equal(JSON.parse(record.value).archive.storage, 'genuine-current-copy-and-qualified-originals')
        assertRootRestoreStage3RetainedCutObserved3(db, actual, plan)
      })
    })

    await t.test('old committed requests settle only as immutable ACK facts and unknown old-generation pending requests cannot execute', async () => {
      await cutProbe(stageDirectory, f.receiver.root, db => {
        assertRootRestoreStage3RetainedCutObserved3(db, actual, plan)
        const before = cutNativeSnapshot(db), workspace = plan.allocation.workspace
        for (const operationId of [f.cases.retained.input.clientOperationId, f.cases.groupFirst.input.clientOperationId,
          f.cases.sharedFirst.input.clientOperationId, f.cases.retiredRedo.clientOperationId]) {
          const row = f.source.db.prepare('SELECT request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(operationId) as
            { request_hash: string; result_json: string; created_at: string } | undefined
          // The ready retired Redo input has not been submitted and is checked
          // below as an unknown old-generation request instead of a fake ACK.
          if (operationId === f.cases.retiredRedo.clientOperationId) { assert.equal(row, undefined); continue }
          assert.ok(row)
          const ack = probeRootRestoreStage3CutRequest3(db, plan, { operationId, requestHash: row.request_hash,
            expectedWorkspaceScope: workspace.workspaceScope, expectedRecoveryEpoch: workspace.beforeEpoch })
          assert.equal(ack.kind, 'original-committed-ack')
          if (ack.kind !== 'original-committed-ack') throw new Error('An original committed fact is required')
          assert.equal(ack.resultJson, row.result_json); assert.equal(ack.createdAt, row.created_at)
          assert.equal(ack.executable, false); assert.equal(ack.permit, false)
          assert.throws(() => probeRootRestoreStage3CutRequest3(db, plan, { operationId,
            requestHash: capsuleBytesHash('different request ' + operationId), expectedWorkspaceScope: workspace.workspaceScope,
            expectedRecoveryEpoch: workspace.afterEpoch }), /原已提交operation ID不能被另一请求复用/)
        }
        const pending = { operationId: f.cases.retiredRedo.clientOperationId,
          requestHash: hostHash({ method: 'restoreSyncedHostOperation', input: validateSyncedRestoreHostInput(f.cases.retiredRedo) }),
          expectedWorkspaceScope: workspace.workspaceScope, expectedRecoveryEpoch: workspace.beforeEpoch }
        assert.throws(() => probeRootRestoreStage3CutRequest3(db, plan, pending), /未知旧epoch pending请求已失效/)
        const freshInput = { ...f.cases.retiredRedo, clientOperationId: randomUUID() }
        const fresh = probeRootRestoreStage3CutRequest3(db, plan, { operationId: freshInput.clientOperationId,
          requestHash: hostHash({ method: 'restoreSyncedHostOperation', input: validateSyncedRestoreHostInput(freshInput) }),
          expectedWorkspaceScope: workspace.workspaceScope, expectedRecoveryEpoch: workspace.afterEpoch })
        assert.equal(fresh.kind, 'uncommitted-new-generation')
        if (fresh.kind !== 'uncommitted-new-generation') throw new Error('A new-generation fact is required')
        assert.equal(fresh.accepted, false); assert.equal(fresh.executable, false); assert.equal(fresh.permit, false)
        assert.deepEqual(cutNativeSnapshot(db), before, 'Diagnostic request facts never write or replay any operation')
      })
    })

    await t.test('a late native failure rolls back the whole cut content and FTS transaction before any manifest is published', async child => {
      const collection = dirname(physical.directory), prior = new Set(await readdir(collection))
      const nativeTransaction = Database.prototype.transaction, nativePrepare = Database.prototype.prepare
      let before: ReturnType<typeof cutNativeSnapshot> | undefined, failedPath: string | undefined, injected = false
      const owned = (db: Database.Database) => {
        if (!db.open || db.readonly || db.memory) return false
        const actualPath = realpathSync.native(db.name), local = relative(realpathSync.native(collection), actualPath)
        return local !== '' && !isAbsolute(local) && !local.startsWith('..' + sep) && !local.startsWith(sep)
          && basename(dirname(actualPath)) === 'database' && basename(actualPath) === 'knowbook.db'
      }
      const transactionMock = child.mock.method(Database.prototype, 'transaction', function (this: Database.Database, fn: (...args: unknown[]) => unknown) {
        const db = this
        if (!owned(db) || db.inTransaction) return Reflect.apply(nativeTransaction, db, [fn])
        return Reflect.apply(nativeTransaction, db, [function (this: unknown, ...args: unknown[]) {
          assert.equal(db.inTransaction, true); assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
          assert.equal(before, undefined)
          before = cutNativeSnapshot(db); failedPath = realpathSync.native(db.name)
          return Reflect.apply(fn, this, args)
        }])
      } as typeof Database.prototype.transaction)
      const prepareMock = child.mock.method(Database.prototype, 'prepare', function (this: Database.Database, sql: string) {
        const db = this, statement = Reflect.apply(nativePrepare, db, [sql]) as Database.Statement
        if (!owned(db) || !sql.includes('integrity-check') || !sql.includes('block_search')) return statement
        const nativeRun = statement.run
        child.mock.method(statement, 'run', function (...args: unknown[]) {
          const result = Reflect.apply(nativeRun, statement, args)
          const query = (text: string, ...parameters: unknown[]) => (Reflect.apply(nativePrepare, db, [text]) as Database.Statement).get(...parameters)
          assert.equal(db.inTransaction, true)
          const epoch = query('SELECT recovery_epoch FROM synced_workspace_state WHERE singleton=1') as { recovery_epoch: string }
          assert.notEqual(epoch.recovery_epoch, plan.allocation.workspace.beforeEpoch)
          const currentGroup = query('SELECT revision,history_position FROM synced_groups WHERE id=?', f.cases.retained.groupId) as
            { revision: string; history_position: number }
          assert.notEqual(currentGroup.revision, f.cases.groupBefore.revision); assert.equal(currentGroup.history_position, 0)
          const records = query('SELECT count(*) AS n FROM app_settings WHERE key>=? AND key<?',
            ROOT3_RETAINED_CUT_PREFIX, ROOT3_RETAINED_CUT_PREFIX.slice(0, -1) + '/') as { n: number }
          assert.equal(records.n, 1)
          assert.ok(result); injected = true
          throw new Error('stage3-cut-test-late-native-rollback')
        } as typeof statement.run)
        return statement
      } as typeof Database.prototype.prepare)
      try { await assert.rejects(prepareRootRestorePhysicalStage3(f.prepared.plan), /stage3-cut-test-late-native-rollback/) }
      finally { prepareMock.mock.restore(); transactionMock.mock.restore() }
      assert.equal(injected, true, 'The actual integrity-check ran after the complete native cut; an early gate rejection is insufficient')
      assert.ok(before); assert.ok(failedPath)
      const added = (await readdir(collection)).filter(name => !prior.has(name))
      assert.equal(added.length, 1)
      const failed = join(collection, added[0])
      assert.equal(realpathSync.native(failedPath), realpathSync.native(join(failed, 'database', 'knowbook.db')))
      assert.equal((await readdir(failed)).includes('manifest.json'), false)
      await cutProbe(join(failed, 'database'), f.receiver.root, db => assert.deepEqual(cutNativeSnapshot(db), before,
        'Every native table, FTS shadow, original history cell and schema object rolls back together'))
    })

    await t.test('hot read and genuine durable reopen retain the same cut observation and leave live stores untouched', async () => {
      const before = await cutDiskInventory(stageDirectory)
      assert.deepEqual(await readRootRestorePhysicalStage3(physical.stage), value)
      const reopened = await reopenRootRestorePhysicalStage3(f.prepared.plan,
        { stageId: physical.stageId, expectedManifestHash: physical.manifestHash })
      assert.deepEqual(reopened.value, value)
      assert.deepEqual(await cutDiskInventory(stageDirectory), before)
      assert.deepEqual(allTables(f.source.db), f.beforeSource)
      assert.deepEqual(allTables(f.receiver.db), f.beforeReceiver)
    })
  }))
