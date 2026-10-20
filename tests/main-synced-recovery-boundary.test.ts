import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { SyncedRestoreGroupInput, SyncedRestoreHostInput, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { advanceSyncedRecoveryEpoch, type SyncedRecoveryEpochAllocation } from '../src/main/database/synced-recovery-boundary'
import { assertSyncedRecoveryBoundaryRecords } from '../src/main/database/synced-recovery-boundary-read'
import { recoveryBoundaryKey } from '../src/main/database/synced-recovery-boundary-model'
import { KnowbookStore } from '../src/main/database/store'
import { assertSyncedBlockSchema } from '../src/main/database/synced-schema'
import { assertSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { restoreSyncedGroupOperation, updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { getSyncedCreateRestoreContext } from '../src/main/database/synced-host-final'
import { withV3Fixture, snapshot, allTables, created, createRequest, createRestoreInput, applySyncedHostCommand,
  applySyncedHostFinal, restoreSyncedHostOperation, request, applied, logical } from './helpers/synced-backup-v3-fixture'
import { savedGroup, restoreInput, stamp } from './helpers/synced-host-final-fixture'

let sequence = 0
function allocation(db: Database.Database): SyncedRecoveryEpochAllocation {
  const actual = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: string; recovery_epoch: string }
  const boundary = new Date(Date.parse('2040-01-01T00:00:00.000Z') + ++sequence * 1000).toISOString()
  return { operationId: randomUUID(), expectedWorkspaceScope: actual.workspace_scope, expectedRecoveryEpoch: actual.recovery_epoch,
    workspaceScope: actual.workspace_scope, recoveryEpoch: randomUUID(), documentBoundary: boundary, acceptedAt: boundary }
}
function advance(db: Database.Database, input = allocation(db)) {
  const receipt = db.transaction(() => advanceSyncedRecoveryEpoch(db, input)).immediate()
  assert.ok(receipt, 'A real synced workspace commits a nonempty execution-boundary receipt')
  return { input, receipt }
}
function boundary(db: Database.Database, operationId: string) {
  const actual = db.transaction(() => assertSyncedRecoveryBoundaryRecords(db))().boundaries.get(operationId)
  assert.ok(actual, 'The genuine SQL marker/anchor authenticates the persisted boundary')
  return actual
}
function groupEdit(db: Database.Database, groupId: string, suffix: string) {
  const before = snapshot(db, groupId), instance = before.instances[0]
  assert.ok(instance, 'The actual canonical edit has a real registered instance')
  const input: SyncedUpdateGroupInput = { clientOperationId: randomUUID(), groupId, expectedRevision: before.revision,
    expectedTopologyRevision: before.topologyRevision, expectedInstanceBinding: { instanceId: instance.instanceId,
      hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
    blocks: before.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: block.content + suffix })) }
  return { input, ack: savedGroup(updateSyncedBlockGroup(db, input)) }
}
function groupRestore(db: Database.Database, groupId: string, historyToken: string, direction: 'undo' | 'redo'): SyncedRestoreGroupInput {
  const before = snapshot(db, groupId), instance = before.instances[0]
  assert.ok(instance, 'Fresh guards come from the current real instance, not the old ACK')
  return { clientOperationId: randomUUID(), groupId, historyToken, direction, expectedRevision: before.revision,
    expectedTopologyRevision: before.topologyRevision, expectedHistoryCursor: before.history.cursor,
    expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion } }
}
function freshCreateRestore(db: Database.Database, original: SyncedRestoreHostInput): SyncedRestoreHostInput {
  return { ...original, clientOperationId: randomUUID(), expectedHosts: original.expectedHosts.map(row => ({
    documentId: row.documentId, expectedUpdatedAt: stamp(db, row.documentId) })),
    groups: original.groups.map(row => {
      const actual = db.prepare('SELECT revision,topology_revision FROM synced_groups WHERE id=?').get(row.groupId) as
        { revision: string; topology_revision: string }
      return { groupId: row.groupId, expectedRevision: actual.revision, expectedTopologyRevision: actual.topology_revision }
    }), expectedInstances: original.expectedInstances.map(row => {
      const actual = db.prepare('SELECT host_document_id,binding_version FROM synced_instances WHERE instance_id=?').get(row.instanceId) as
        { host_document_id: string; binding_version: string }
      assert.ok(actual, 'The active create retry receives its current real instance lease')
      return { instanceId: row.instanceId, hostDocumentId: actual.host_document_id, bindingVersion: actual.binding_version }
    }) }
}
function historyConflict(db: Database.Database, run: () => ReturnType<typeof restoreSyncedHostOperation> | ReturnType<typeof restoreSyncedGroupOperation>) {
  const before = allTables(db), result = run()
  assert.ok(result.status === 'conflict' && result.kind === 'history', JSON.stringify(result))
  assert.deepEqual(allTables(db), before, 'An old token with fresh guards cannot alter any SQL table')
}
function retained(db: Database.Database) {
  return { operations: db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all() as Array<{ client_operation_id: string }>,
    journals: db.prepare('SELECT * FROM synced_host_history ORDER BY id').all(),
    pins: db.prepare('SELECT * FROM synced_group_pins ORDER BY group_id,kind,pin_id').all() }
}
function assertRetained(db: Database.Database, original: ReturnType<typeof retained>) {
  for (const row of original.operations) assert.deepEqual(db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(row.client_operation_id), row)
  assert.deepEqual(db.prepare('SELECT * FROM synced_host_history ORDER BY id').all(), original.journals)
  assert.deepEqual(db.prepare('SELECT * FROM synced_group_pins ORDER BY group_id,kind,pin_id').all(), original.pins)
}

test('recovery boundary archives real group Undo and Redo, rejects both with fresh guards, preserves old ACK, and permits a new content branch', async () => withV3Fixture(f => {
  const first = groupEdit(f.db, f.groupId, ' first'), second = groupEdit(f.db, f.groupId, ' second')
  assert.ok(second.ack.snapshot.history.undoToken)
  savedGroup(restoreSyncedGroupOperation(f.db, groupRestore(f.db, f.groupId, second.ack.snapshot.history.undoToken, 'undo')))
  const before = snapshot(f.db, f.groupId), original = retained(f.db)
  assert.ok(before.history.undoToken && before.history.redoToken, 'Actual Main content writes leave both executable tails before recovery')
  const rows = f.db.prepare('SELECT * FROM synced_group_history WHERE group_id=? ORDER BY position').all(f.groupId)
  const rotated = advance(f.db), after = snapshot(f.db, f.groupId), proof = boundary(f.db, rotated.input.operationId)
  assert.deepEqual(after.blocks, before.blocks)
  assert.notEqual(after.revision, before.revision); assert.notEqual(after.topologyRevision, before.topologyRevision)
  assert.notEqual(after.history.cursor, before.history.cursor)
  assert.notEqual(after.instances[0].bindingVersion, before.instances[0].bindingVersion)
  assert.equal(after.history.undoToken, null); assert.equal(after.history.redoToken, null)
  assert.deepEqual(proof.groups.find(row => row.groupId === f.groupId)?.rows, rows)
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM synced_group_history').get() as { count: number }).count, 0)
  historyConflict(f.db, () => restoreSyncedGroupOperation(f.db, groupRestore(f.db, f.groupId, before.history.undoToken!, 'undo')))
  historyConflict(f.db, () => restoreSyncedGroupOperation(f.db, groupRestore(f.db, f.groupId, before.history.redoToken!, 'redo')))
  const priorReplay = allTables(f.db)
  assert.deepEqual(savedGroup(updateSyncedBlockGroup(f.db, first.input)), { ...first.ack, replayed: true })
  assert.deepEqual(allTables(f.db), priorReplay)
  assertRetained(f.db, original)
  const next = groupEdit(f.db, f.groupId, ' after recovery')
  assert.ok(next.ack.snapshot.history.undoToken)
  assert.ok(!rows.some(row => (row as { id: string }).id === next.ack.snapshot.history.undoToken))
  const undone = savedGroup(restoreSyncedGroupOperation(f.db, groupRestore(f.db, f.groupId, next.ack.snapshot.history.undoToken, 'undo')))
  assert.deepEqual(undone.snapshot.blocks, before.blocks)
  const redone = savedGroup(restoreSyncedGroupOperation(f.db, groupRestore(f.db, f.groupId, next.ack.snapshot.history.undoToken, 'redo')))
  assert.deepEqual(redone.snapshot.blocks, next.ack.snapshot.blocks)
  assert.equal(f.db.pragma('user_version', { simple: true }), 27)
}))

test('active create history is unavailable after recovery even with fresh leases, while a genuinely new create still supports Undo and Redo', async () => withV3Fixture(f => {
  const original = retained(f.db), old = createRestoreInput(f.db, f.created, 'undo').input
  const rotated = advance(f.db)
  assert.ok(boundary(f.db, rotated.input.operationId).hostCuts.some(row => row.historyToken === f.created.historyToken))
  assert.deepEqual(getSyncedCreateRestoreContext(f.db, { historyToken: f.created.historyToken, direction: 'undo' }), { status: 'unavailable', reason: 'history' })
  historyConflict(f.db, () => restoreSyncedHostOperation(f.db, freshCreateRestore(f.db, old)))
  const beforeReplay = allTables(f.db)
  assert.deepEqual(created(applySyncedHostCommand(f.db, f.createInput)), { ...f.created, replayed: true })
  assert.deepEqual(allTables(f.db), beforeReplay)
  assertRetained(f.db, original)
  const nextInput = createRequest(f.db, { documentId: f.hostId, selectedRootIds: [f.hostBodyId] })
  const next = created(applySyncedHostCommand(f.db, nextInput))
  const nextBlocks = snapshot(f.db, nextInput.action.groupId).blocks
  assert.notEqual(next.historyToken, f.created.historyToken)
  const undo = created(restoreSyncedHostOperation(f.db, createRestoreInput(f.db, next, 'undo').input))
  assert.equal(undo.createdLifecycle.state, 'retired-create')
  const redo = created(restoreSyncedHostOperation(f.db, createRestoreInput(f.db, undo, 'redo').input))
  assert.equal(redo.createdLifecycle.state, 'active')
  assert.deepEqual(snapshot(f.db, nextInput.action.groupId).blocks, nextBlocks)
  assert.equal(snapshot(f.db, f.groupId).groupId, f.groupId)
}))

test('a truly retired create keeps its frozen evidence through recovery, cannot Redo with fresh guards, and permits new ordinary host Undo', async () => withV3Fixture(f => {
  const retired = created(restoreSyncedHostOperation(f.db, createRestoreInput(f.db, f.created, 'undo').input))
  assert.equal(retired.createdLifecycle.state, 'retired-create')
  const oldRedo = createRestoreInput(f.db, retired, 'redo').input
  const group = f.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(f.groupId)
  const life = f.db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(f.groupId)
  const retirement = f.db.prepare('SELECT * FROM synced_group_retirements WHERE group_id=?').get(f.groupId)
  const original = retained(f.db), ordinaryBefore = logical(f.db, f.hostId)
  const rotated = advance(f.db)
  assert.equal(boundary(f.db, rotated.input.operationId).groups.find(row => row.groupId === f.groupId)?.disposition, 'retired-evidence')
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(f.groupId), group)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(f.groupId), life)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_group_retirements WHERE group_id=?').get(f.groupId), retirement)
  assert.deepEqual(getSyncedCreateRestoreContext(f.db, { historyToken: retired.historyToken, direction: 'redo' }), { status: 'unavailable', reason: 'history' })
  historyConflict(f.db, () => restoreSyncedHostOperation(f.db, freshCreateRestore(f.db, oldRedo)))
  assertRetained(f.db, original)
  const input = request(f.db, [f.hostId], after => { after[0].blocks.find(row => row.id === f.hostBodyId)!.content += ' new host branch' })
  const ack = applied(applySyncedHostFinal(f.db, input))
  assert.ok(ack.historyToken)
  applied(restoreSyncedHostOperation(f.db, restoreInput(f.db, ack, 'undo')))
  assert.deepEqual(logical(f.db, f.hostId), ordinaryBefore)
  applied(restoreSyncedHostOperation(f.db, restoreInput(f.db, ack, 'redo')))
  assert.deepEqual(logical(f.db, f.hostId), input.finalAfter[0])
}))

test('recovery cuts every participant of a real shared host journal and new shared Undo and Redo keep working', async () => withV3Fixture(f => {
  const input = request(f.db, [f.hostId, f.targetId], after => {
    after[0].blocks.find(row => row.id === f.hostBodyId)!.content += ' shared before recovery'
    after[1].summary += ' shared before recovery'
  })
  const ack = applied(applySyncedHostFinal(f.db, input))
  assert.ok(ack.historyToken)
  const original = retained(f.db), rotated = advance(f.db), proof = boundary(f.db, rotated.input.operationId)
  const cut = proof.hostCuts.find(row => row.historyToken === ack.historyToken)
  assert.ok(cut)
  assert.deepEqual(cut.documentIds, [f.hostId, f.targetId].sort())
  assert.equal(cut.mappings.length, 2)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_host_history_documents').all(), [])
  historyConflict(f.db, () => restoreSyncedHostOperation(f.db, restoreInput(f.db, ack, 'undo')))
  assertRetained(f.db, original)
  const before = [logical(f.db, f.hostId), logical(f.db, f.targetId)]
  const next = request(f.db, [f.hostId, f.targetId], after => {
    after[0].blocks.find(row => row.id === f.hostBodyId)!.content += ' shared new branch'
    after[1].summary += ' shared new branch'
  })
  const accepted = applied(applySyncedHostFinal(f.db, next))
  assert.ok(accepted.historyToken && accepted.historyToken !== ack.historyToken)
  applied(restoreSyncedHostOperation(f.db, restoreInput(f.db, accepted, 'undo')))
  assert.deepEqual([logical(f.db, f.hostId), logical(f.db, f.targetId)], before)
  applied(restoreSyncedHostOperation(f.db, restoreInput(f.db, accepted, 'redo')))
  assert.deepEqual([logical(f.db, f.hostId), logical(f.db, f.targetId)], next.finalAfter)
}))

test('a late epoch SQL abort rolls back the complete savepoint even when its owner catches the error, and the fixed allocation remains retryable', async () => withV3Fixture(f => {
  groupEdit(f.db, f.groupId, ' real history before late abort')
  const input = allocation(f.db)
  f.db.exec(`CREATE TRIGGER recovery_test_late_abort BEFORE UPDATE OF recovery_epoch ON synced_workspace_state
    BEGIN SELECT RAISE(ABORT,'recovery-late-abort'); END`)
  const before = allTables(f.db)
  f.db.transaction(() => {
    assert.throws(() => advanceSyncedRecoveryEpoch(f.db, input), /recovery-late-abort/)
    assert.equal(f.db.inTransaction, true, 'The maintenance owner can catch a repository savepoint failure')
    assert.deepEqual(allTables(f.db), before, 'No archive, marker, anchor, removed history, or rotated guard escapes the failed savepoint')
  }).immediate()
  assert.deepEqual(allTables(f.db), before)
  f.db.exec('DROP TRIGGER recovery_test_late_abort')
  const recovered = advance(f.db, input)
  assert.equal(recovered.receipt.afterEpoch, input.recoveryEpoch)
  assert.equal(boundary(f.db, input.operationId).operationId, input.operationId)
}))

test('an AFTER UPDATE trigger that restores the old workspace epoch and reports IGNORE cannot commit a partial recovery boundary', async () => withV3Fixture(f => {
  groupEdit(f.db, f.groupId, ' real history before ignored epoch')
  const input = allocation(f.db)
  f.db.exec(`CREATE TRIGGER recovery_test_ignore_epoch AFTER UPDATE OF recovery_epoch ON synced_workspace_state
    WHEN NEW.recovery_epoch='${input.recoveryEpoch}' BEGIN
      UPDATE synced_workspace_state SET recovery_epoch=OLD.recovery_epoch WHERE singleton=OLD.singleton;
      SELECT RAISE(IGNORE);
    END`)
  const before = allTables(f.db)
  f.db.transaction(() => {
    assert.throws(() => advanceSyncedRecoveryEpoch(f.db, input), /实际workspace未按固定epoch推进/)
    assert.deepEqual(allTables(f.db), before, 'Final guards authenticate actual SQL state, and the owner cannot retain earlier writes')
  }).immediate()
  assert.deepEqual(allTables(f.db), before)
  f.db.exec('DROP TRIGGER recovery_test_ignore_epoch')
  advance(f.db, input)
}))

test('an AFTER UPDATE trigger that restores old active group guards and reports IGNORE rolls back the full boundary', async () => withV3Fixture(f => {
  groupEdit(f.db, f.groupId, ' real history before ignored group guards')
  const input = allocation(f.db), previous = snapshot(f.db, f.groupId)
  f.db.exec(`CREATE TRIGGER recovery_test_ignore_group AFTER UPDATE OF revision ON synced_groups
    WHEN OLD.id='${f.groupId}' AND OLD.revision='${previous.revision}' AND NEW.revision<>OLD.revision BEGIN
      UPDATE synced_groups SET revision=OLD.revision,topology_revision=OLD.topology_revision,history_cursor=OLD.history_cursor WHERE id=OLD.id;
      SELECT RAISE(IGNORE);
    END`)
  const before = allTables(f.db)
  f.db.transaction(() => {
    assert.throws(() => advanceSyncedRecoveryEpoch(f.db, input), /实际group guards\/position未闭合/)
    assert.deepEqual(allTables(f.db), before, 'Restored old guards cannot be hidden behind successful changes counts or the persisted receipt')
  }).immediate()
  assert.deepEqual(allTables(f.db), before)
  f.db.exec('DROP TRIGGER recovery_test_ignore_group')
  advance(f.db, input)
}))

test('a second boundary preserves archives and replay semantics across a native connection and Main repository reopen while the production Store gate still refuses synced content', async () => withV3Fixture(f => {
  const originalEdit = groupEdit(f.db, f.groupId, ' first generation')
  assert.ok(originalEdit.ack.snapshot.history.undoToken)
  const first = advance(f.db)
  const firstRaw = f.db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(recoveryBoundaryKey(first.input.operationId))
  const between = groupEdit(f.db, f.groupId, ' between boundaries')
  assert.ok(between.ack.snapshot.history.undoToken)
  const hostInput = request(f.db, [f.hostId], after => {
    after[0].blocks.find(row => row.id === f.hostBodyId)!.content += ' between boundaries'
  })
  const hostAck = applied(applySyncedHostFinal(f.db, hostInput))
  assert.ok(hostAck.historyToken)

  const reused = { ...allocation(f.db), documentBoundary: first.input.documentBoundary }
  const beforeInvalid = allTables(f.db)
  assert.throws(() => f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, reused)).immediate(), /复用了已知恢复历史守卫/)
  assert.deepEqual(allTables(f.db), beforeInvalid)

  const second = advance(f.db), secondProof = boundary(f.db, second.input.operationId)
  assert.equal(secondProof.beforeEpoch, first.input.recoveryEpoch)
  assert.ok(secondProof.groups.find(row => row.groupId === f.groupId)?.rows.some(row => row.id === between.ack.snapshot.history.undoToken))
  assert.ok(secondProof.hostCuts.some(row => row.historyToken === hostAck.historyToken))
  assert.deepEqual(f.db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(recoveryBoundaryKey(first.input.operationId)), firstRaw)
  historyConflict(f.db, () => restoreSyncedGroupOperation(f.db, groupRestore(f.db, f.groupId, between.ack.snapshot.history.undoToken!, 'undo')))
  historyConflict(f.db, () => restoreSyncedHostOperation(f.db, restoreInput(f.db, hostAck, 'undo')))

  const fresh = groupEdit(f.db, f.groupId, ' after second boundary')
  assert.ok(fresh.ack.snapshot.history.undoToken)
  const beforeReplay = allTables(f.db)
  const replay = f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, first.input)).immediate()
  assert.deepEqual(replay, first.receipt)
  assert.deepEqual(allTables(f.db), beforeReplay, 'Replaying the first fixed allocation cannot recut a later real history branch')
  assert.equal(snapshot(f.db, f.groupId).history.undoToken, fresh.ack.snapshot.history.undoToken)

  f.close()
  const originalBytes = readFileSync(f.file)
  assert.throws(() => new KnowbookStore(f.file), {
    message: '此构建尚不支持数据库中已启用的同步块正文，请使用支持同步块的完整版本；原数据未修改。'
  }, 'The production Store gate remains closed until complete synced persistence/export support is installed')
  assert.deepEqual(readFileSync(f.file), originalBytes, 'The production refusal preserves the original database bytes')
  const db = new Database(f.file)
  try {
    db.pragma('foreign_keys=ON')
    assert.deepEqual(allTables(db), beforeReplay, 'The refused Store open and native connection reopen preserve every SQL row')
    assert.equal(db.pragma('user_version', { simple: true }), 27)
    const records = db.transaction(() => {
      assertSyncedBlockSchema(db)
      assertSyncedLifecycleSchema(db)
      return assertSyncedRecoveryBoundaryRecords(db)
    })()
    assert.equal(records.boundaries.size, 2)
    assert.ok(records.boundaries.has(first.input.operationId) && records.boundaries.has(second.input.operationId))
    assert.equal((db.prepare('SELECT recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { recovery_epoch: string }).recovery_epoch, second.input.recoveryEpoch)
    assert.deepEqual(db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(recoveryBoundaryKey(first.input.operationId)), firstRaw)
    historyConflict(db, () => restoreSyncedGroupOperation(db, groupRestore(db, f.groupId, originalEdit.ack.snapshot.history.undoToken!, 'undo')))
    historyConflict(db, () => restoreSyncedGroupOperation(db, groupRestore(db, f.groupId, between.ack.snapshot.history.undoToken!, 'undo')))
    historyConflict(db, () => restoreSyncedHostOperation(db, restoreInput(db, hostAck, 'undo')))

    const beforeUndo = snapshot(db, f.groupId), resumed = savedGroup(restoreSyncedGroupOperation(db,
      groupRestore(db, f.groupId, fresh.ack.snapshot.history.undoToken!, 'undo')))
    assert.deepEqual(resumed.snapshot.blocks, between.ack.snapshot.blocks, 'The Main repository branch remains usable after its native connection reopens')
    const redone = savedGroup(restoreSyncedGroupOperation(db, groupRestore(db, f.groupId, fresh.ack.snapshot.history.undoToken!, 'redo')))
    assert.deepEqual(redone.snapshot.blocks, beforeUndo.blocks)
    const cold = groupEdit(db, f.groupId, ' new repository edit after native reopen')
    assert.ok(cold.ack.snapshot.history.undoToken)
    const undone = savedGroup(restoreSyncedGroupOperation(db, groupRestore(db, f.groupId, cold.ack.snapshot.history.undoToken, 'undo')))
    assert.deepEqual(undone.snapshot.blocks, beforeUndo.blocks)
  } finally { db.close() }
}))
