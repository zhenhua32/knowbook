import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type {
  SyncedBindingKey, SyncedBlocksApi, SyncedBlocksChangedEvent, SyncedGroupMutationResult,
  SyncedGroupSaved, SyncedGroupSnapshot, SyncedRestoreGroupInput, SyncedUpdateGroupInput
} from '../src/shared/synced-blocks'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { getSyncedGroupSnapshots, getSyncedHostHistory, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { getSyncedOperation, updateSyncedBlockGroup, restoreSyncedGroupOperation } from '../src/main/database/synced-blocks-content'
import { getSyncedWorkspaceController } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { openCanonicalSourceLedger, forkCanonicalSourceLedger, prepareCanonicalSourceFirstApply,
  readPreparedSourceFirstApply, type SourceFirstApplyLease } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import { initialize, addInstance, snapshot, state, groupId, host, other, born, now, uuid } from './helpers/synced-content-fixture'

/** The transport submits to the real SQLite repositories. It does not fabricate
 * ACKs, canonical snapshots, binding targets or capabilities for dirty drafts. */
class MainPort implements SyncedBlocksApi {
  readonly updates: SyncedUpdateGroupInput[] = []
  readonly receipts: SyncedGroupSaved[] = []
  readonly lookups: string[] = []
  readonly listeners = new Set<(event: SyncedBlocksChangedEvent) => void>()
  dropNextUpdateAck = false
  afterFirstCommit: (() => void) | null = null
  reads = 0
  constructor(readonly db: Database.Database) {}
  async getSyncedGroupSnapshots(input: { groupIds: string[] }) {
    this.reads++
    return getSyncedGroupSnapshots(this.db, input)
  }
  async listSyncedGroups(input: { query: string; offset: number; limit: number }) { return listSyncedGroups(this.db, input) }
  async getSyncedHostHistory(input: { documentId: string }) { return getSyncedHostHistory(this.db, input) }
  async getSyncedOperation(input: { clientOperationId: string }) {
    this.lookups.push(input.clientOperationId)
    return getSyncedOperation(this.db, input)
  }
  async updateSyncedBlockGroup(input: SyncedUpdateGroupInput) {
    this.updates.push(structuredClone(input))
    const result = updateSyncedBlockGroup(this.db, input)
    assert.equal(this.db.inTransaction, false, 'Only an actual SQLite commit can publish an ACK or event')
    if ('snapshot' in result) this.receipts.push(structuredClone(result))
    if (result.status === 'saved' && !result.replayed) {
      for (const listener of this.listeners) listener({ operationId: result.operationId,
        changes: [{ groupId: result.snapshot.groupId, revision: result.snapshot.revision,
          topologyRevision: result.snapshot.topologyRevision, kind: 'content' }],
        affectedInstanceIds: result.snapshot.instances.map(instance => instance.instanceId) })
      const after = this.afterFirstCommit
      this.afterFirstCommit = null
      after?.()
    }
    if (this.dropNextUpdateAck && result.status === 'saved') {
      this.dropNextUpdateAck = false
      throw new Error('Fixture discarded delivery of the committed F1 ACK')
    }
    return result
  }
  async restoreSyncedGroupOperation(input: SyncedRestoreGroupInput): Promise<SyncedGroupMutationResult> {
    return restoreSyncedGroupOperation(this.db, input)
  }
  async applySyncedHostStructure(): ReturnType<SyncedBlocksApi['applySyncedHostStructure']> {
    throw new Error('First Source Apply must not invoke a host structure writer')
  }
  async restoreSyncedHostOperation(): ReturnType<SyncedBlocksApi['restoreSyncedHostOperation']> {
    throw new Error('First Source Apply must not invoke a host history writer')
  }
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

const bindingKey = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
function scope(value: SyncedGroupSnapshot, index: number): SyncedGroupScope {
  const instance = value.instances[index]
  assert.ok(instance)
  return { owner: { kind: 'synced-group', groupId: value.groupId }, instanceId: instance.instanceId,
    bindingVersion: instance.bindingVersion, hostDocumentId: instance.hostDocumentId, windowSessionId: 'source-main-window',
    hostSession: {}, mountEpoch: {}, bindingEpoch: {}, domNamespace: `source-main-${index}`, root: () => null, isCurrent: () => true }
}
function sourceLease(value: SyncedGroupScope, editSequence: number, snapshot: SyncedGroupSnapshot): SourceFirstApplyLease {
  return { expectedEditSequence: editSequence, guards: syncedSnapshotGuard(snapshot), scope: {
    groupId: value.owner.groupId, hostDocumentId: value.hostDocumentId, windowSessionId: value.windowSessionId,
    hostSession: value.hostSession, mountEpoch: value.mountEpoch, bindingEpoch: value.bindingEpoch,
    instanceId: value.instanceId, bindingVersion: value.bindingVersion
  } }
}
function historyRows(db: Database.Database) {
  return db.prepare('SELECT * FROM synced_group_history WHERE group_id=? ORDER BY position').all(groupId)
}
function hostDocuments(db: Database.Database) {
  return db.prepare('SELECT * FROM documents WHERE id IN (?,?) ORDER BY id').all(host, other)
}

async function firstDirtyApply(dropFirstAck: boolean): Promise<void> {
  const db = new Database(':memory:')
  try {
    initialize(db)
    addInstance(db, uuid(101), groupId, { owner: other })
    const target = uuid(7100), reusedTarget = uuid(7101)
    db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(target, 'Target', target, 'Original/Target', born, now)
    db.prepare('UPDATE synced_group_blocks SET content=?,tags_json=?,highlight=? WHERE group_id=?')
      .run('Persisted P', JSON.stringify(['keep', '旧']), 'yellow', groupId)
    const persisted = snapshot(db), baselineTables = state(db), baselineHosts = hostDocuments(db)
    assert.deepEqual(persisted.bindings, [])
    assert.equal(historyRows(db).length, 0)

    const port = new MainPort(db), workspace = getSyncedWorkspaceController(port)
    await workspace.load([groupId])
    const controller = workspace.getGroup(groupId)
    assert.ok(controller)
    const first = controller.bind(scope(persisted, 0)), second = controller.bind(scope(persisted, 1))
    try {
      const initial = first.getCurrent(), f1TransactionId = randomUUID(), f2TransactionId = randomUUID()
      const working = initial.working.map(block => ({ ...block, content: 'dirty W🙂\r\n[born](Target.md)' }))
      const workingKeys = captureSyncedGroupBindings(db, persisted.origin,
        working.map(block => ({ ...block, createdAt: persisted.blocks[0].createdAt }))).map(bindingKey)
      assert.equal(workingKeys.length, 1)
      assert.equal(first.apply({ blocks: working, bindingClaims: workingKeys.map(destination => ({ kind: 'new', destination })),
        expectedEditSequence: initial.editSequence, guards: syncedSnapshotGuard(initial.snapshot),
        bookmark: null, transactionId: f1TransactionId }), true)
      const dirty = first.getCurrent()
      assert.equal(dirty.dirty, true)
      assert.equal(dirty.editSequence, initial.editSequence + 1)
      assert.equal(second.getCurrent(), dirty)
      assert.deepEqual(snapshot(db), persisted, 'F1 is working-only; opening Source has not preflushed it')
      assert.equal(port.updates.length, 0)
      assert.equal((db.prepare('SELECT count(*) AS n FROM synced_operations').get() as { n: number }).n, 0)

      const lease = sourceLease(first.scope, dirty.editSequence, dirty.snapshot)
      const opened = openCanonicalSourceLedger({ blocks: dirty.working, origin: dirty.snapshot.origin, lease })
      const draft = forkCanonicalSourceLedger(opened.draft, [{ from: 0, to: 0, insert: '源码 prefix🙂 ' }])
      const result = readPreparedSourceFirstApply(prepareCanonicalSourceFirstApply({ draft, lease,
        freshId: () => { throw new Error('The surviving real canonical block must keep its ID') } }))
      assert.equal(port.updates.length, 0, 'Opening, editing and preparing Source require no Main writer or dirty-source ticket')
      assert.deepEqual(snapshot(db), persisted)
      assert.equal(result.lease.expectedEditSequence, dirty.editSequence)
      assert.equal(result.bindingClaims.length, 1)
      const claim = result.bindingClaims[0]
      assert.equal(claim.kind, 'continue')
      if (claim.kind !== 'continue') throw new Error('F2 must continue the actual W occurrence')
      assert.deepEqual(claim.source, workingKeys[0], 'F2 source is the exact raw W Key, including its original CRLF offset')
      assert.notEqual(claim.source.from, claim.destination.from)
      assert.notEqual(f1TransactionId, f2TransactionId)
      assert.equal(first.apply({ blocks: structuredClone([...result.blocks]), bindingClaims: structuredClone([...result.bindingClaims]),
        expectedEditSequence: result.lease.expectedEditSequence, guards: result.lease.guards,
        bookmark: null, transactionId: f2TransactionId }), true)
      assert.equal(first.getCurrent().editSequence, dirty.editSequence + 1)
      assert.deepEqual(second.getCurrent().working, result.blocks)
      assert.deepEqual(snapshot(db), persisted)

      // This independent fixture mutation happens after the real F1 commit.
      // A mistaken F2=new would now choose reusedTarget rather than target.
      port.afterFirstCommit = () => {
        db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed', 'Original/Renamed', target)
        db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run(reusedTarget, 'Target', reusedTarget, 'Original/Target', born, now)
      }
      port.dropNextUpdateAck = dropFirstAck
      if (dropFirstAck) {
        assert.equal(await second.flush(), false)
        assert.equal(port.updates.length, 1)
        assert.deepEqual(snapshot(db).blocks, port.receipts[0].snapshot.blocks)
        assert.deepEqual(first.getCurrent().snapshot, persisted, 'A dropped ACK cannot update the renderer baseline by guessing')
        assert.deepEqual(first.getCurrent().working, result.blocks)
        assert.equal(first.getCurrent().pending?.clientOperationId, port.updates[0].clientOperationId)
      }
      assert.equal(await first.flush(), true)
      assert.equal(port.updates.length, 2, 'Only the real F1 and F2 requests invoke the SQLite writer')
      assert.equal(port.receipts.length, 2)
      assert.deepEqual(port.lookups, dropFirstAck ? [port.updates[0].clientOperationId] : [])
      assert.equal(port.reads, 1, 'Owned commit events must not race a new snapshot over the exact ACK')
      assert.notEqual(port.updates[0].clientOperationId, port.updates[1].clientOperationId)
      assert.deepEqual(port.updates[0].blocks, working)
      assert.equal(port.updates[0].bindingClaims?.[0].kind, 'new')
      assert.equal(port.updates[0].expectedRevision, persisted.revision)
      assert.equal(port.updates[1].expectedRevision, port.receipts[0].snapshot.revision)
      assert.equal(port.updates[1].expectedTopologyRevision, port.receipts[0].snapshot.topologyRevision)
      assert.deepEqual(port.updates[1].bindingClaims, result.bindingClaims)
      assert.deepEqual(port.updates[1].blocks, result.blocks)

      const final = snapshot(db)
      assert.equal(historyRows(db).length, 2, 'Different accepted transactions persist distinct real history frames')
      assert.equal((db.prepare('SELECT count(*) AS n FROM synced_operations').get() as { n: number }).n, 2)
      assert.deepEqual(final, port.receipts[1].snapshot)
      for (const ack of port.receipts) {
        assert.equal(ack.status, 'saved')
        assert.deepEqual(ack.snapshot.bindings[0].target, { kind: 'document', id: target, state: 'live' })
        assert.deepEqual(getSyncedOperation(db, { clientOperationId: ack.operationId }),
          { status: 'committed', result: { ...ack, replayed: true } })
      }
      assert.deepEqual(first.getCurrent().snapshot, final)
      assert.equal(first.getCurrent(), second.getCurrent())
      assert.equal(first.getCurrent().dirty, false)
      assert.deepEqual(first.getCurrent().working, result.blocks)
      assert.equal(final.blocks[0].id, persisted.blocks[0].id)
      assert.equal(final.blocks[0].createdAt, persisted.blocks[0].createdAt)
      assert.deepEqual(final.blocks[0].tags, persisted.blocks[0].tags)
      assert.equal(final.blocks[0].highlight, persisted.blocks[0].highlight)
      assert.equal(final.blocks[0].parentBlockId, persisted.blocks[0].parentBlockId)
      assert.equal(final.blocks[0].depth, persisted.blocks[0].depth)
      assert.equal(final.creationId, persisted.creationId)
      assert.deepEqual(final.origin, persisted.origin)
      assert.equal(final.topologyRevision, persisted.topologyRevision)
      assert.deepEqual(hostDocuments(db), baselineHosts)
      const finalTables = state(db)
      for (const table of ['blocks', 'document_history', 'document_trash', 'document_block_routes', 'document_block_moves',
        'markdown_link_sources', 'links', 'app_settings', 'block_identities', 'synced_workspace_state', 'synced_instances',
        'synced_host_history', 'synced_host_history_documents', 'synced_host_history_state', 'synced_group_pins']) {
        assert.deepEqual(finalTables[table], baselineTables[table], `Group content must not mutate ${table}`)
      }
    } finally {
      first.dispose(); second.dispose()
      assert.equal(controller.getSnapshot().dirty, false)
      assert.equal(workspace.releaseClean(groupId), true)
      assert.equal(workspace.dispose(), true)
      assert.equal(port.listeners.size, 0)
    }
  } finally { db.close() }
}

test('real dirty working Source first Apply persists F1 then F2 using W keys and exact ACKs without preflush', async () => {
  await firstDirtyApply(false)
})

test('lost F1 ACK is recovered under its original operation before the real Source F2 writer runs', async () => {
  await firstDirtyApply(true)
})
