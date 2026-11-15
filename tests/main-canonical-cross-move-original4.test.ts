import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { readSyncedBaselineMetadataCaptureOwned2 } from '../src/main/database/synced-binding-sources'
import { hostHash } from '../src/main/database/synced-host-journal'
import { SYNCED_METADATA_BASELINE2_PREFIX } from '../src/main/database/synced-metadata-capture-record2'
import { readCanonicalCrossMoveOriginal4Owned } from '../src/main/editor-recovery/canonical-cross-move-original4'
import { request, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import type { V3Fixture } from './helpers/synced-backup-v3-fixture'
import { restoreInput } from './helpers/synced-host-command-move-fixture'

function commit(f: V3Fixture, canonicalRedo = false) {
  const sender = Object.freeze({})
  const source = f.store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: f.hostId,
    groupId: f.groupId, instanceId: f.instanceId })
  const target = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: f.targetId })
  assert.ok(source.status === 'ready' && source.instance && source.snapshot && target.status === 'ready')
  assert.equal(source.session.sessionId, target.session.sessionId)
  const sessionId = source.session.sessionId
  if (canonicalRedo) {
    const { groupId, revision, topologyRevision, blocks, instances } = source.snapshot
    const { instanceId, hostDocumentId, bindingVersion } = instances[0]
    const expectedInstanceBinding = { instanceId, hostDocumentId, bindingVersion }
    const updated = f.store.invokeSyncedEditingSession(sender, { sessionId, method: 'updateSyncedBlockGroup', input: {
      clientOperationId: randomUUID(), groupId, expectedInstanceBinding, expectedRevision: revision, expectedTopologyRevision: topologyRevision,
      blocks: syncedCanonicalEdits(blocks).map(block => ({ ...block, content: block.content + ' retained Redo tail' }))
    } })
    assert.ok(updated.status === 'saved' && updated.snapshot.history.undoToken)
    const restored = f.store.invokeSyncedEditingSession(sender, { sessionId, method: 'restoreSyncedGroupOperation', input: {
      clientOperationId: randomUUID(), groupId, expectedInstanceBinding, expectedRevision: updated.snapshot.revision,
      expectedTopologyRevision: updated.snapshot.topologyRevision, expectedHistoryCursor: updated.snapshot.history.cursor,
      historyToken: updated.snapshot.history.undoToken, direction: 'undo'
    } })
    assert.ok(restored.status === 'saved' && restored.snapshot.history.redoToken)
  }
  const baseline = f.store.invokeSyncedEditingSession(sender, { sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
  assert.equal(baseline.status, 'ready')
  const point = f.db.transaction(() => readSyncedBaselineMetadataCaptureOwned2(f.db, baseline.readOwnerId))()
  assert.ok(point.status === 'captured' && point.record.pointHash)
  const { clientOperationId, hostsWorkingBefore, groups, expectedInstances } = request(f.db, [f.hostId, f.targetId])
  const input = { clientOperationId, hostsWorkingBefore, groups, expectedInstances, mode: 'command' as const,
    action: { kind: 'move' as const, selection: { documentId: f.hostId, selectedRootIds: [f.instanceId] },
      target: { documentId: f.targetId, parentBlockId: null, beforeBlockId: null, depth: 0 } } }
  const result = f.store.invokeSyncedEditingSession(sender, { sessionId, method: 'applySyncedHostStructure', input })
  assert.ok(result.status === 'applied' && result.historyToken, JSON.stringify(result))
  const requestHash = hostHash({ method: 'applySyncedHostCommand', input })
  return { source, result, sender, sessionId, selector: { operationId: clientOperationId, requestHash,
    baselineKey: SYNCED_METADATA_BASELINE2_PREFIX + point.record.pointHash, baselineHash: point.record.recordHash } }
}

test('real v4 last-occurrence move proves the same physical reference on its original writable connection and independent readonly reopen', () => withV3Fixture(f => {
  const { source, result, selector } = commit(f)
  const read = () => readCanonicalCrossMoveOriginal4Owned(f.db, selector)
  assert.throws(read, /cannot be proved/)
  const beforeChanges = (f.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
  const proof = f.db.transaction(read)()
  assert.equal((f.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count, beforeChanges)
  assert.equal(proof.writePermit, false)
  assert.equal(proof.historyToken, result.historyToken)
  assert.deepEqual(proof.canonicalHistory, source.snapshot!.history)
  assert.equal(proof.canonicalRevision, source.snapshot!.revision)
  assert.equal(proof.creationId, source.snapshot!.creationId)
  assert.equal(proof.instanceCreatedAt, source.instance!.instanceCreatedAt)
  assert.equal(proof.before.hostDocumentId, f.hostId)
  assert.equal(proof.after.hostDocumentId, f.targetId)
  assert.equal(proof.before.instanceId, f.instanceId)
  assert.equal(proof.after.instanceId, f.instanceId)
  assert.equal(proof.before.bindingVersion, source.instance!.bindingVersion)
  assert.equal(proof.after.bindingVersion, result.groups[0].instances[0].bindingVersion)
  assert.notEqual(proof.before.bindingVersion, proof.after.bindingVersion)
  assert.notEqual(proof.before.topologyRevision, proof.after.topologyRevision)
  assert.throws(f.db.transaction(() => readCanonicalCrossMoveOriginal4Owned(f.db, { ...selector, requestHash: '0'.repeat(64) })), /cannot be proved/)
  assert.throws(f.db.transaction(() => readCanonicalCrossMoveOriginal4Owned(f.db, { ...selector, baselineHash: '0'.repeat(64) })), /cannot be proved/)
  assert.throws(f.db.transaction(() => readCanonicalCrossMoveOriginal4Owned(f.db, { ...selector, operationId: randomUUID() })), /cannot be proved/)

  f.close()
  const cold = new Database(f.file, { readonly: true, fileMustExist: true })
  try {
    cold.pragma('foreign_keys=ON')
    cold.pragma('query_only=ON')
    assert.deepEqual(cold.transaction(() => readCanonicalCrossMoveOriginal4Owned(cold, selector))(), proof)
    assert.equal((cold.prepare('SELECT total_changes() AS count').get() as { count: number }).count, 0)
  } finally { cold.close() }
}))

test('current binding and canonical revisions must still equal the original v4 acknowledgement', () => withV3Fixture(f => {
  const { selector } = commit(f, true)
  const prove = f.db.transaction(() => readCanonicalCrossMoveOriginal4Owned(f.db, selector))
  const original = prove()
  assert.ok(original.canonicalHistory.redoToken)
  const abort = new Error('rollback actual rejected drift probe')
  for (const change of [
    () => f.db.prepare('UPDATE synced_instances SET binding_version=? WHERE instance_id=?').run(randomUUID(), f.instanceId),
    () => f.db.prepare('UPDATE synced_groups SET revision=? WHERE id=?').run(randomUUID(), f.groupId),
    () => f.db.prepare('UPDATE synced_groups SET history_cursor=? WHERE id=?').run(randomUUID(), f.groupId),
    () => f.db.prepare('UPDATE documents SET updated_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', f.hostId),
    () => f.db.prepare('UPDATE synced_group_history SET created_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', original.canonicalHistory.redoToken),
    () => f.db.prepare("UPDATE synced_operations SET result_json=json_set(result_json,'$.result.groups[0].instances[0].bindingVersion',?) WHERE client_operation_id=?")
      .run(randomUUID(), selector.operationId)
  ]) {
    assert.throws(f.db.transaction(() => {
      assert.equal(change().changes, 1)
      assert.throws(prove, /cannot be proved/)
      throw abort
    }), error => error === abort)
    assert.deepEqual(prove(), original)
  }
}))

test('an original move acknowledgement cannot authorize a draft handoff after a real host Undo', () => withV3Fixture(f => {
  const { result, selector, sender, sessionId } = commit(f)
  assert.equal(f.store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: f.targetId, instanceId: f.instanceId,
    groupId: f.groupId }).status, 'ready')
  const undone = f.store.invokeSyncedEditingSession(sender, { sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(f.db, result, 'undo') })
  assert.ok(undone.status === 'applied' && undone.historyToken === result.historyToken)
  assert.throws(f.db.transaction(() => readCanonicalCrossMoveOriginal4Owned(f.db, selector)), /cannot be proved/)
}))
