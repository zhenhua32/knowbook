import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { SyncedEditingSessionRepository } from '../src/main/database/synced-editing-session'
import { getSyncedWorkspaceController } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import type { SyncedBlocksApi } from '../src/shared/synced-blocks'

test('actual epoch replacement retires private entries and owned aliases after its own snapshot without discarding the genuine renderer W; rollback and frame release preserve their boundaries',
  { concurrency: false }, () => withCanonicalSearchFixture(async f => {
    const repository = new SyncedEditingSessionRepository(f.db), sender = {}, peer = {}
    const opened = repository.open(sender, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.firstInstanceId, groupId: f.searchGroupId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') return
    const originalId = opened.session.sessionId, actual = opened.instance!
    const baseline = repository.invoke(sender, { sessionId: originalId, method: 'captureBaseline', input: { groupId: f.searchGroupId } })
    assert.equal(baseline.status, 'ready'); if (baseline.status !== 'ready') return
    const other = repository.open(peer, { kind: 'host', hostDocumentId: f.targetId })
    assert.equal(other.status, 'ready'); if (other.status !== 'ready') return
    const peerOwner = repository.invoke(peer, { sessionId: other.session.sessionId, method: 'captureBaseline', input: { groupId: f.searchGroupId } })
    assert.equal(peerOwner.status, 'ready')
    // Inspect only the actual production private registry to verify release;
    // never insert a token, source DTO, owner, mapper or successful ACK.
    const entries = (repository as unknown as { entries: Map<string, { readOwners: Set<string> }> }).entries
    const firstEntry = entries.get(originalId)!, peerEntry = entries.get(other.session.sessionId)!
    assert.equal(entries.size, 2); assert.equal(firstEntry.readOwners.size, 1)
    const reuse = repository.open(sender, { kind: 'host', hostDocumentId: f.targetId })
    assert.equal(reuse.status, 'ready'); if (reuse.status !== 'ready') return
    assert.equal(reuse.session.sessionId, originalId); assert.equal(firstEntry.readOwners.size, 1)
    assert.equal(repository.invoke(sender, { sessionId: originalId, method: 'validateOwner', input: { readOwnerId: baseline.readOwnerId } }).status, 'ready')
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected structure operation') }
    const api: SyncedBlocksApi = {
      getSyncedGroupSnapshots: input => Promise.resolve(repository.invoke(sender, { sessionId: originalId, method: 'getSyncedGroupSnapshots', input })),
      listSyncedGroups: input => Promise.resolve(repository.invoke(sender, { sessionId: originalId, method: 'listSyncedGroups', input })),
      updateSyncedBlockGroup: async input => repository.invoke(sender, { sessionId: originalId, method: 'updateSyncedBlockGroup', input }),
      restoreSyncedGroupOperation: async input => repository.invoke(sender, { sessionId: originalId, method: 'restoreSyncedGroupOperation', input }),
      getSyncedOperation: async input => repository.invoke(sender, { sessionId: originalId, method: 'getSyncedOperation', input }),
      getSyncedHostHistory: async input => repository.invoke(sender, { sessionId: originalId, method: 'getSyncedHostHistory', input }),
      applySyncedHostStructure: unexpected, restoreSyncedHostOperation: unexpected, onSyncedBlocksChanged: () => () => undefined
    }
    const workspace = getSyncedWorkspaceController(api); await workspace.load([f.searchGroupId])
    const group = workspace.getGroup(f.searchGroupId); assert.ok(group)
    const scope: SyncedGroupScope = { owner: { kind: 'synced-group', groupId: f.searchGroupId }, hostDocumentId: f.hostId,
      instanceId: actual.instanceId, bindingVersion: actual.bindingVersion, windowSessionId: 'actual-retirement-session',
      hostSession: {}, mountEpoch: {}, bindingEpoch: {}, domNamespace: actual.instanceId, root: () => null, isCurrent: () => true }
    const binding = group.bind(scope), before = binding.getCurrent(), working = before.working.map((block, index) => ({ ...block,
      content: block.content + (index === 0 ? ' genuine retained W' : '') }))
    assert.equal(binding.apply({ blocks: working, expectedEditSequence: before.editSequence, guards: syncedSnapshotGuard(before.snapshot),
      transactionId: randomUUID(), bookmark: null }), true)
    const sqlBefore = f.db.prepare('SELECT * FROM synced_group_blocks WHERE group_id=? ORDER BY sort_order').all(f.searchGroupId)
    let previousId = originalId, previousEntry = firstEntry
    for (let round = 0; round < 4; round++) {
      f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
      const fresh = repository.open(sender, { kind: 'host', hostDocumentId: f.hostId })
      assert.equal(fresh.status, 'ready'); if (fresh.status !== 'ready') throw new Error('The actual host disappeared')
      assert.notEqual(fresh.session.sessionId, previousId)
      assert.equal(entries.has(previousId), false); assert.equal(previousEntry.readOwners.size, 0)
      assert.equal(entries.size, 1, 'each durable epoch has only the current genuine entry, not every historical entry')
      assert.equal(peerEntry.readOwners.size, 0, 'the actual global recovery boundary also retires a different old frame')
      assert.throws(() => repository.invoke(sender, { sessionId: previousId, method: 'getSyncedOperation', input: { clientOperationId: f.searchCreate.operationId } }), /not the original IPC frame session/)
      const owned = repository.invoke(sender, { sessionId: fresh.session.sessionId, method: 'captureBaseline', input: { groupId: f.searchGroupId } })
      assert.equal(owned.status, 'ready')
      previousId = fresh.session.sessionId; previousEntry = entries.get(previousId)!
      assert.equal(previousEntry.readOwners.size, 1)
      assert.deepEqual(binding.getCurrent().working, working)
    }
    assert.equal(await binding.flush(), false)
    assert.deepEqual(binding.getCurrent().working, working); assert.equal(binding.getCurrent().dirty, true)
    assert.deepEqual(f.db.prepare('SELECT * FROM synced_group_blocks WHERE group_id=? ORDER BY sort_order').all(f.searchGroupId), sqlBefore)
    f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
    assert.deepEqual(repository.open(sender, { kind: 'host', hostDocumentId: randomUUID() }), { status: 'missing' })
    assert.equal(entries.size, 0); assert.equal(previousEntry.readOwners.size, 0, 'a committed missing-host read still observes and retires the actual old realm')
    const live = repository.open(sender, { kind: 'host', hostDocumentId: f.hostId })
    assert.equal(live.status, 'ready'); if (live.status !== 'ready') throw new Error('The actual original host disappeared')
    const owner = repository.invoke(sender, { sessionId: live.session.sessionId, method: 'captureBaseline', input: { groupId: f.searchGroupId } })
    assert.equal(owner.status, 'ready'); if (owner.status !== 'ready') throw new Error('Actual baseline source missing')
    const liveEntry = entries.get(live.session.sessionId)!
    assert.throws(() => f.db.transaction(() => {
      f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
      repository.open(sender, { kind: 'host', hostDocumentId: f.hostId })
    })(), /own committed SQL snapshot/)
    assert.equal(entries.get(live.session.sessionId), liveEntry); assert.equal(liveEntry.readOwners.size, 1)
    assert.equal(repository.invoke(sender, { sessionId: live.session.sessionId, method: 'validateOwner', input: { readOwnerId: owner.readOwnerId } }).status, 'ready')
    f.db.transaction(() => repository.releaseSender(sender))()
    assert.equal(entries.size, 0); assert.equal(liveEntry.readOwners.size, 0)
    assert.deepEqual(binding.getCurrent().working, working, 'Main frame-loss memory cleanup does not clear renderer W')
    binding.dispose(); assert.equal(workspace.dispose(), false, 'an actual dirty renderer registry is never silently discarded')
    repository.releaseAll()
  }))
