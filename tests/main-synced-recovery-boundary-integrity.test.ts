import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { advanceSyncedRecoveryEpoch } from '../src/main/database/synced-recovery-boundary'
import { assertSyncedRecoveryBoundaryRecords } from '../src/main/database/synced-recovery-boundary-read'
import { recoveryBoundaryKey, recoveryEpochMarkerId } from '../src/main/database/synced-recovery-boundary-model'
import { assertSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { getSyncedGroupSnapshots, getSyncedHostHistory, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { restoreSyncedHostOperation } from '../src/main/database/synced-host-final'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { assertSyncedLogicalDeletionRecords } from '../src/main/database/synced-logical-deletion-read'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { withV3Fixture, request, applied, applySyncedHostFinal, allTables, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { withDeletionPrimer, completed, encode, hash } from './helpers/synced-exchange-tombstone-primer-fixture'

function allocation(db: Database.Database) {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: string; recovery_epoch: string }
  return { operationId: randomUUID(), expectedWorkspaceScope: row.workspace_scope, expectedRecoveryEpoch: row.recovery_epoch,
    workspaceScope: row.workspace_scope, recoveryEpoch: randomUUID(), documentBoundary: '2047-02-03T04:05:06.000Z', acceptedAt: new Date().toISOString() }
}
async function withBoundary(run: (f: V3Fixture, input: ReturnType<typeof allocation>, oldGroupRow: Record<string, unknown>, oldMappings: Array<Record<string, unknown>>) => void) {
  await withV3Fixture(f => {
    editCreatedGroup(f.db, f.groupId)
    const host = applied(applySyncedHostFinal(f.db, request(f.db, [f.hostId, f.targetId], sides => {
      for (const side of sides) side.summary += ' real shared host history'
    })))
    assert.ok(host.historyToken)
    const oldGroupRow = f.db.prepare('SELECT * FROM synced_group_history WHERE group_id=?').get(f.groupId) as Record<string, unknown>
    assert.ok(oldGroupRow, 'A real content command supplies the archived row')
    const oldMappings = f.db.prepare('SELECT * FROM synced_host_history_documents WHERE history_id=? ORDER BY document_id').all(host.historyToken) as Array<Record<string, unknown>>
    assert.equal(oldMappings.length, 2, 'The old real journal has two actual participants')
    const input = allocation(f.db)
    assert.ok(f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, input)).immediate())
    assertSyncedLifecycleSchema(f.db) // Original startup entry remains valid outside a transaction.
    run(f, input, oldGroupRow, oldMappings)
  })
}
function insertOriginal(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row)
  assert.ok(columns.every(name => /^[a-z_]+$/.test(name)))
  db.prepare('INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')').run(...Object.values(row))
}
function rejectsCurrentReads(f: V3Fixture): void {
  const before = allTables(f.db)
  assert.throws(() => f.db.transaction(() => assertSyncedRecoveryBoundaryRecords(f.db))(), /同步恢复历史边界损坏/)
  assert.throws(() => getSyncedGroupSnapshots(f.db, { groupIds: [f.groupId] }), /同步恢复历史边界损坏/)
  assert.throws(() => listSyncedGroups(f.db, { query: '', offset: 0, limit: 10 }), /同步恢复历史边界损坏/)
  assert.throws(() => getSyncedHostHistory(f.db, { documentId: f.hostId }), /同步恢复历史边界损坏/)
  const document = f.db.prepare('SELECT updated_at FROM documents WHERE id=?').get(f.hostId) as { updated_at: string }
  assert.throws(() => restoreSyncedHostOperation(f.db, { clientOperationId: randomUUID(), historyToken: f.created.historyToken,
    direction: 'undo', expectedHosts: [{ documentId: f.hostId, expectedUpdatedAt: document.updated_at }], groups: [], expectedInstances: [] }), /同步恢复历史边界损坏/)
  assert.deepEqual(allTables(f.db), before, 'Every strict read/refused inverse leaves the corrupted evidence untouched')
}

test('recovery boundary detects reinserted original canonical history even when the current tail would otherwise expose it as redo', () => withBoundary((f, _input, oldGroupRow) => {
  insertOriginal(f.db, 'synced_group_history', oldGroupRow)
  rejectsCurrentReads(f)
}))
for (const complete of [false, true]) test('recovery boundary detects ' + (complete ? 'whole' : 'partial') + ' original shared host mapping resurrection', () => withBoundary((f, _input, _row, mappings) => {
  for (const row of complete ? mappings : mappings.slice(0, 1)) insertOriginal(f.db, 'synced_host_history_documents', row)
  rejectsCurrentReads(f)
}))
for (const target of ['boundary', 'receipt', 'original-ack', 'pin', 'journal'] as const) test('recovery boundary refuses lost or changed ' + target + ' from actual SQL rather than cached facts', () => withBoundary((f, input, _row, mappings) => {
  if (target === 'boundary') f.db.prepare('DELETE FROM app_settings WHERE key=?').run(recoveryBoundaryKey(input.operationId))
  if (target === 'receipt') f.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(recoveryEpochMarkerId(input.operationId))
  if (target === 'original-ack') f.db.prepare("UPDATE synced_operations SET result_json=result_json||' ' WHERE client_operation_id=?").run(f.created.operationId)
  if (target === 'pin') {
    const pin = f.db.prepare('SELECT group_id,kind,pin_id FROM synced_group_pins LIMIT 1').get() as { group_id: string; kind: string; pin_id: string }
    assert.ok(pin, 'The actual Main create/shared host operations left a real retained pin')
    f.db.prepare('DELETE FROM synced_group_pins WHERE group_id=? AND kind=? AND pin_id=?').run(pin.group_id, pin.kind, pin.pin_id)
  }
  if (target === 'journal') f.db.prepare("UPDATE synced_host_history SET action_json=action_json||' ' WHERE id=?").run(mappings[0].history_id)
  rejectsCurrentReads(f)
}))
test('recovery boundary rejects original SQL invalid UTF8 without accepting the driver replacement string', () => withBoundary((f, input) => {
  f.db.prepare("UPDATE app_settings SET value=CAST(X'80' AS TEXT) WHERE key=?").run(recoveryBoundaryKey(input.operationId))
  rejectsCurrentReads(f)
}))
test('recovery boundary immutable zero-member anchor cannot be deleted or confirmed by native SQL', () => withBoundary((f, input) => {
  const before = allTables(f.db), marker = recoveryEpochMarkerId(input.operationId)
  assert.throws(() => f.db.prepare('DELETE FROM synced_exposure_attempts WHERE id=?').run(marker))
  assert.throws(() => f.db.prepare("UPDATE synced_exposure_attempts SET state='confirmed',confirmed_at=? WHERE id=?").run(input.acceptedAt, marker))
  assert.deepEqual(allTables(f.db), before)
  assert.equal(f.db.transaction(() => assertSyncedRecoveryBoundaryRecords(f.db))().boundaries.size, 1)
}))
test('recovery retains the exact actual V3 confirmed exposure while active group guards advance', () => withV3Fixture(f => {
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const attempts = f.db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all() as Array<{ id: string; state: string }>
  const members = f.db.prepare('SELECT * FROM synced_group_exposure_members ORDER BY attempt_id,group_id').all()
  assert.ok(attempts.some(row => row.state === 'confirmed') && members.length > 0, 'The actual V3 writer durably confirmed real publication members')
  const input = allocation(f.db)
  assert.ok(f.db.transaction(() => advanceSyncedRecoveryEpoch(f.db, input)).immediate())
  for (const row of attempts) assert.deepEqual(f.db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(row.id), row)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_group_exposure_members ORDER BY attempt_id,group_id').all(), members)
  assertSyncedLifecycleSchema(f.db)
}))
test('recovery preserves a genuine accepted deletion proof and its exact physical guards across the new epoch', () => withDeletionPrimer(async f => {
  f.remoteFinal(records => {
    const original = records.get('group:' + f.groupId)
    assert.ok(original?.kind === 'synced-group')
    records.set('group:' + f.groupId, { kind: 'synced-group-deleted', id: f.groupId, creationId: original.creationId,
      previousHash: hash(encode(original)), deletedAt: new Date().toISOString() })
  })
  assert.ok(completed(await f.exchange(), 'applied').appliedKeys.includes('group:' + f.groupId))
  const group = f.B.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(f.groupId)
  const before = f.B.db.transaction(() => assertSyncedLogicalDeletionRecords(f.B.db))()
  assert.ok(before.has('group:' + f.groupId), 'Only the genuine Main exchange installs the permanent deletion proof')
  const input = allocation(f.B.db)
  assert.ok(f.B.db.transaction(() => advanceSyncedRecoveryEpoch(f.B.db, input)).immediate())
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_groups WHERE id=?').get(f.groupId), group)
  assert.deepEqual(f.B.db.transaction(() => assertSyncedLogicalDeletionRecords(f.B.db))(), before)
  const boundary = f.B.db.transaction(() => assertSyncedRecoveryBoundaryRecords(f.B.db))().boundaries.get(input.operationId)
  assert.equal(boundary?.groups.find(row => row.groupId === f.groupId)?.disposition, 'deleted-evidence')
  assert.equal(getSyncedGroupSnapshots(f.B.db, { groupIds: [f.groupId] }).items[0].status, 'missing')
}))
