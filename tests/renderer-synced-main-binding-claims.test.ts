import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type {
  SyncedBindingClaim, SyncedBindingKey, SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedCanonicalEdit,
  SyncedGroupMutationResult, SyncedGroupSnapshot, SyncedRestoreGroupInput, SyncedUpdateGroupInput
} from '../src/shared/synced-blocks'
import { getSyncedWorkspaceController } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard, type SyncedGroupBinding, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { getSyncedGroupSnapshots, getSyncedHostHistory, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { getSyncedOperation, restoreSyncedGroupOperation, updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { getSyncedGroupSnapshotsWithLinkSources } from '../src/main/database/synced-binding-sources'
import { initialize, addInstance, snapshot, groupId, other, born, now, uuid } from './helpers/synced-content-fixture'

/** This injected contract calls the real SQLite repositories. It installs no
 * window.knowbook stand-in and fabricates no saved snapshot or history result. */
class MainPort implements SyncedBlocksApi {
  readonly updates: SyncedUpdateGroupInput[] = []
  readonly restores: SyncedRestoreGroupInput[] = []
  readonly lookups: string[] = []
  readonly listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  dropNextUpdateAck = false
  constructor(readonly db: Database.Database) {}
  async getSyncedGroupSnapshots(input: { groupIds: string[] }) { return getSyncedGroupSnapshots(this.db, input) }
  async listSyncedGroups(input: { query: string; offset: number; limit: number }) { return listSyncedGroups(this.db, input) }
  async getSyncedHostHistory(input: { documentId: string }) { return getSyncedHostHistory(this.db, input) }
  async getSyncedOperation(input: { clientOperationId: string }) {
    this.lookups.push(input.clientOperationId)
    return getSyncedOperation(this.db, input)
  }
  private committed(result: SyncedGroupMutationResult): void {
    assert.equal(this.db.inTransaction, false, 'Events and ACK delivery follow the actual SQLite commit')
    if (result.status !== 'saved' || result.replayed) return
    for (const listener of this.listeners) listener({ operationId: result.operationId,
      changes: [{ groupId: result.snapshot.groupId, revision: result.snapshot.revision,
        topologyRevision: result.snapshot.topologyRevision, kind: 'content' }],
      affectedInstanceIds: result.snapshot.instances.map(instance => instance.instanceId) })
  }
  async updateSyncedBlockGroup(input: SyncedUpdateGroupInput) {
    this.updates.push(structuredClone(input))
    const result = updateSyncedBlockGroup(this.db, input)
    this.committed(result)
    if (this.dropNextUpdateAck && result.status === 'saved') {
      this.dropNextUpdateAck = false
      throw new Error('Fixture lost the delivery of an already committed ACK')
    }
    return result
  }
  async restoreSyncedGroupOperation(input: SyncedRestoreGroupInput) {
    this.restores.push(structuredClone(input))
    const result = restoreSyncedGroupOperation(this.db, input)
    this.committed(result)
    return result
  }
  async applySyncedHostStructure(): ReturnType<SyncedBlocksApi['applySyncedHostStructure']> {
    throw new Error('This content integration must not invoke a host structure writer')
  }
  async restoreSyncedHostOperation(): ReturnType<SyncedBlocksApi['restoreSyncedHostOperation']> {
    throw new Error('This content integration must not invoke a host history writer')
  }
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

const key = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
function scope(value: SyncedGroupSnapshot, index: number): SyncedGroupScope {
  const instance = value.instances[index]
  assert.ok(instance)
  return { owner: { kind: 'synced-group', groupId: value.groupId }, instanceId: instance.instanceId,
    bindingVersion: instance.bindingVersion, hostDocumentId: instance.hostDocumentId, windowSessionId: 'main-integration-window',
    hostSession: {}, mountEpoch: {}, bindingEpoch: {}, domNamespace: `actual-instance-${index}`, root: () => null, isCurrent: () => true }
}
function apply(binding: SyncedGroupBinding, blocks: SyncedCanonicalEdit[], bindingClaims: SyncedBindingClaim[]): boolean {
  const state = binding.getCurrent()
  return binding.apply({ blocks, bindingClaims, expectedEditSequence: state.editSequence, guards: syncedSnapshotGuard(state.snapshot),
    bookmark: null, transactionId: randomUUID() })
}
function replaceTargetPath(db: Database.Database): string {
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed target', 'Original/Renamed', other)
  const replacement = randomUUID()
  db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(replacement, 'Target', replacement, 'Original/Target', born, now)
  return replacement
}
function identities(db: Database.Database) { return db.prepare('SELECT * FROM block_identities ORDER BY id').all() }
function documents(db: Database.Database) { return db.prepare('SELECT * FROM documents ORDER BY id').all() }
function routes(db: Database.Database) { return db.prepare('SELECT * FROM document_block_routes ORDER BY rowid').all() }

async function withMain(run: (db: Database.Database, port: MainPort) => Promise<void>): Promise<void> {
  const db = new Database(':memory:')
  try {
    initialize(db)
    addInstance(db, uuid(101), groupId, { owner: other })
    db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Target', 'Original/Target', other)
    const before = snapshot(db), blocks = [{ ...before.blocks[0], content: '[old](Target.md)' }]
    const bindings = captureSyncedGroupBindings(db, before.origin, blocks)
    db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run(blocks[0].content, groupId)
    db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(bindings), groupId)
    assert.deepEqual(snapshot(db).bindings[0].target, { kind: 'document', id: other, state: 'live' })
    await run(db, new MainPort(db))
  } finally { db.close() }
}
async function setup(port: MainPort) {
  const workspace = getSyncedWorkspaceController(port)
  await workspace.load([groupId])
  const controller = workspace.getGroup(groupId)
  assert.ok(controller)
  const value = snapshot(port.db)
  assert.equal(value.instances.length, 2)
  const first = controller.bind(scope(value, 0)), second = controller.bind(scope(value, 1))
  assert.equal(first.getCurrent(), second.getCurrent())
  assert.notEqual(first.scope.instanceId, second.scope.instanceId)
  assert.notEqual(first.scope.hostDocumentId, second.scope.hostDocumentId)
  return { workspace, controller, first, second }
}

test('real Main and shared controller preserve same-text new intent through local history, lost ACK recovery and group Undo Redo', async () => withMain(async (db, port) => {
  const { workspace, controller, first, second } = await setup(port)
  try {
    const initial = first.getCurrent(), original = structuredClone(initial.working), replacement = replaceTargetPath(db)
    const originalBindings = structuredClone(initial.snapshot.bindings), sqlIdentities = identities(db), sqlDocuments = documents(db), sqlRoutes = routes(db)
    assert.equal(apply(first, original, [{ kind: 'new', destination: key(originalBindings[0]) }]), true)
    assert.equal(first.getCurrent().dirty, true)
    assert.deepEqual(second.getCurrent().working, original)
    assert.equal(await second.undo(), true)
    assert.equal(first.getCurrent().dirty, false)
    assert.deepEqual(first.getCurrent().snapshot.bindings, originalBindings)
    assert.equal(await first.redo(), true)
    assert.equal(second.getCurrent().dirty, true)
    assert.deepEqual(snapshot(db).bindings, originalBindings, 'Local Undo/Redo has not submitted or invented a target')

    port.dropNextUpdateAck = true
    assert.equal(await second.flush(), false)
    const committed = snapshot(db)
    assert.deepEqual(committed.blocks, initial.snapshot.blocks, 'Only typed target semantics changed')
    assert.deepEqual(committed.bindings[0].target, { kind: 'document', id: replacement, state: 'live' })
    assert.deepEqual(first.getCurrent().snapshot.bindings, originalBindings, 'The renderer retains its old baseline until the real ACK is recovered')
    assert.equal(first.getCurrent().dirty, true)
    assert.equal(port.updates.length, 1)
    assert.equal(await first.flush(), true)
    assert.deepEqual(port.lookups, [port.updates[0].clientOperationId])
    assert.equal(port.updates.length, 1, 'Uncertain delivery resolves through the real operation repository')
    assert.equal(first.getCurrent().dirty, false)
    assert.equal(first.getCurrent(), second.getCurrent())
    assert.deepEqual(first.getCurrent().snapshot.bindings, committed.bindings)

    const row = db.prepare('SELECT before_json,after_json,before_hash,after_hash FROM synced_group_history WHERE group_id=?').get(groupId) as
      { before_json: string; after_json: string; before_hash: string; after_hash: string }
    const beforeSide = JSON.parse(row.before_json) as { blocks: unknown; bindings: unknown }
    const afterSide = JSON.parse(row.after_json) as { blocks: unknown; bindings: unknown }
    assert.deepEqual(beforeSide.blocks, afterSide.blocks)
    assert.deepEqual(beforeSide.bindings, originalBindings)
    assert.deepEqual(afterSide.bindings, committed.bindings)
    assert.notEqual(row.before_hash, row.after_hash)

    assert.equal(await second.undo(), true)
    assert.deepEqual(snapshot(db).bindings, originalBindings)
    assert.deepEqual(first.getCurrent().snapshot.bindings, originalBindings)
    assert.deepEqual(first.getCurrent().working, original)
    assert.equal(await first.redo(), true)
    assert.deepEqual(snapshot(db).bindings, committed.bindings)
    assert.deepEqual(second.getCurrent().snapshot.bindings, committed.bindings)
    assert.deepEqual(second.getCurrent().working, original)
    assert.deepEqual(port.restores.map(input => input.direction), ['undo', 'redo'])
    assert.equal((db.prepare('SELECT count(*) AS n FROM synced_group_history WHERE group_id=?').get(groupId) as { n: number }).n, 1)
    const exact = await port.getSyncedOperation({ clientOperationId: port.updates[0].clientOperationId })
    assert.equal(exact.status, 'committed')
    if (exact.status !== 'committed' || !('snapshot' in exact.result)) throw new Error('Expected the real stored group ACK')
    assert.deepEqual(exact.result.snapshot, committed, 'Lookup returns the original after snapshot, not the later Redo CAS')
    assert.notEqual(exact.result.snapshot.revision, snapshot(db).revision)
    assert.deepEqual(identities(db), sqlIdentities)
    assert.deepEqual(documents(db), sqlDocuments)
    assert.deepEqual(routes(db), sqlRoutes)
  } finally {
    first.dispose(); second.dispose()
    assert.equal(controller.getSnapshot().dirty, false)
    assert.equal(workspace.releaseClean(groupId), true)
    assert.equal(workspace.dispose(), true)
    assert.equal(port.listeners.size, 0)
  }
}))

test('an initial Main ticket keeps its old stable target through controller saves and actual journal Redo pruning', async () => withMain(async (db, port) => {
  const captured = getSyncedGroupSnapshotsWithLinkSources(db, { groupIds: [groupId] }).items[0]
  assert.ok(captured.status === 'ready')
  assert.equal((db.prepare('SELECT count(*) AS n FROM synced_operations').get() as { n: number }).n, 0)
  const ticket = captured.bindingSource, entry = ticket.entries[0], initial = captured.snapshot
  const replacement = replaceTargetPath(db), sqlIdentities = identities(db), sqlDocuments = documents(db), sqlRoutes = routes(db)
  const { workspace, first, second } = await setup(port)
  try {
    const cut = [{ ...first.getCurrent().working[0], content: 'Cut body' }]
    assert.equal(apply(first, cut, []), true)
    assert.equal(await second.flush(), true)
    assert.deepEqual(snapshot(db).bindings, [])
    assert.equal(await first.undo(), true)
    assert.deepEqual(snapshot(db).bindings, initial.bindings)
    const discardedRedo = snapshot(db).history.redoToken
    assert.ok(discardedRedo)
    assert.ok(db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(discardedRedo))
    const branch = [{ ...first.getCurrent().working[0], content: 'New branch without a link' }]
    assert.equal(apply(second, branch, []), true)
    assert.equal(await first.flush(), true)
    assert.equal(snapshot(db).history.redoToken, null)
    assert.equal(db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(discardedRedo), undefined, 'The source does not depend on the pruned history side')

    const pasted = [{ ...first.getCurrent().working[0], content: '\uFEFF🙂\r\n[paste](Target.md) [again](Target.md)' }]
    const actualKeys = captureSyncedGroupBindings(db, snapshot(db).origin, pasted.map(block => ({ ...block, createdAt: born }))).map(key)
    assert.equal(actualKeys.length, 2)
    assert.equal(apply(first, pasted, actualKeys.map(destination => ({ kind: 'copy',
      source: { kind: 'ticket', ticketId: ticket.ticketId, entryId: entry.entryId }, destination }))), true)
    assert.equal(await second.flush(), true)
    const accepted = snapshot(db)
    assert.deepEqual(accepted.bindings.map(binding => binding.target), [initial.bindings[0].target, initial.bindings[0].target])
    assert.ok(accepted.bindings.every(binding => binding.target.kind === 'document' && binding.target.id === other && binding.target.id !== replacement))
    assert.deepEqual(first.getCurrent().snapshot.bindings, accepted.bindings)
    assert.equal(first.getCurrent(), second.getCurrent())
    assert.equal(first.getCurrent().dirty, false)
    assert.equal(accepted.blocks[0].id, initial.blocks[0].id)
    assert.equal(accepted.blocks[0].createdAt, initial.blocks[0].createdAt)
    assert.equal(accepted.creationId, initial.creationId)
    assert.deepEqual(accepted.origin, initial.origin)
    assert.deepEqual(identities(db), sqlIdentities)
    assert.deepEqual(documents(db), sqlDocuments)
    assert.deepEqual(routes(db), sqlRoutes)
    assert.equal(db.inTransaction, false)
  } finally {
    first.dispose(); second.dispose()
    assert.equal(workspace.releaseClean(groupId), true)
    assert.equal(workspace.dispose(), true)
    assert.equal(port.listeners.size, 0)
  }
}))
