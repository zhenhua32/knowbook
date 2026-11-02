import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { withCanonicalSearchFixture } from './helpers/canonical-search-fixture'
import { SyncedEditingSessionRepository } from '../src/main/database/synced-editing-session'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { captureSyncedBaselineOwner, validateSyncedReadOwner, getSyncedOperationWithOwnedLinkSource, releaseSyncedReadOwner } from '../src/main/database/synced-binding-sources'
import type { SyncedUpdateGroupInput } from '../src/shared/synced-blocks'

test('real historical ACK reads reject an old session epoch including namespace and missing-registry negatives while old unfenced read semantics stay unchanged',
  { concurrency: false }, () => withCanonicalSearchFixture(f => {
    const repository = new SyncedEditingSessionRepository(f.db), sender = {}, otherSender = {}
    const opened = repository.open(sender, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.firstInstanceId, groupId: f.searchGroupId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') return
    const sessionId = opened.session.sessionId, snapshot = opened.snapshot!, instance = opened.instance!
    const input: SyncedUpdateGroupInput = { groupId: snapshot.groupId, expectedRevision: snapshot.revision,
      expectedTopologyRevision: snapshot.topologyRevision, clientOperationId: randomUUID(),
      expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
      blocks: snapshot.blocks.map(({ createdAt: _birth, ...block }, index) => ({ ...block, content: block.content + (index === 0 ? ' actual ACK' : '') })) }
    const saved = repository.invoke(sender, { sessionId, method: 'updateSyncedBlockGroup', input })
    assert.equal(saved.status, 'saved')
    const original = repository.invoke(sender, { sessionId, method: 'getSyncedOperation', input: { clientOperationId: input.clientOperationId } })
    assert.equal(original.status, 'committed')
    assert.deepEqual(getSyncedOperation(f.db, { clientOperationId: input.clientOperationId }), original)
    const receipt = () => f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId)
    const originalReceipt = receipt()
    const baseline = repository.invoke(sender, { sessionId, method: 'captureBaseline', input: { groupId: f.searchGroupId } })
    assert.equal(baseline.status, 'ready'); if (baseline.status !== 'ready') return
    const other = repository.open(otherSender, { kind: 'host', hostDocumentId: f.hostId })
    assert.equal(other.status, 'ready'); if (other.status !== 'ready') return
    const foreign = repository.invoke(otherSender, { sessionId: other.session.sessionId, method: 'captureBaseline', input: { groupId: f.searchGroupId } })
    assert.equal(foreign.status, 'ready'); if (foreign.status !== 'ready') return
    assert.deepEqual(repository.invoke(sender, { sessionId, method: 'validateOwner', input: { readOwnerId: foreign.readOwnerId } }), { status: 'owner-unavailable' })
    f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
    const probes = [
      () => repository.invoke(sender, { sessionId, method: 'getSyncedOperation', input: { clientOperationId: input.clientOperationId } }),
      () => repository.invoke(sender, { sessionId, method: 'getSyncedGroupSnapshots', input: { groupIds: [f.searchGroupId] } }),
      () => repository.invoke(sender, { sessionId, method: 'listSyncedGroups', input: { query: '', offset: 0, limit: 10 } }),
      () => repository.invoke(sender, { sessionId, method: 'getSyncedHostHistory', input: { documentId: f.hostId } }),
      () => repository.invoke(sender, { sessionId, method: 'captureBaseline', input: { groupId: f.searchGroupId } }),
      () => repository.invoke(sender, { sessionId, method: 'validateOwner', input: { readOwnerId: baseline.readOwnerId } }),
      () => repository.invoke(sender, { sessionId, method: 'ownedOperation', input: { readOwnerId: baseline.readOwnerId, clientOperationId: input.clientOperationId } }),
      () => repository.invoke(sender, { sessionId, method: 'validateOwner', input: { readOwnerId: foreign.readOwnerId } }),
      () => repository.invoke(sender, { sessionId, method: 'ownedOperation', input: { readOwnerId: randomUUID(), clientOperationId: input.clientOperationId } })
    ]
    for (const probe of probes) assert.throws(probe, /workspace epoch changed/)
    // A genuine legacy producer may publish in the new epoch before a new UI
    // session opens. This replaces the registry and exercises the two leaf
    // missing-owner exits, not just the session namespace-missing exit.
    const fresh = captureSyncedBaselineOwner(f.db, { groupId: f.searchGroupId })
    assert.equal(fresh.status, 'ready')
    assert.throws(() => repository.invoke(sender, { sessionId, method: 'validateOwner', input: { readOwnerId: baseline.readOwnerId } }), /workspace epoch changed/)
    assert.throws(() => repository.invoke(sender, { sessionId, method: 'ownedOperation', input: { readOwnerId: baseline.readOwnerId, clientOperationId: input.clientOperationId } }), /workspace epoch changed/)
    assert.deepEqual(getSyncedOperation(f.db, { clientOperationId: input.clientOperationId }), original, 'the old unfenced historical reader and stored ACK values remain unchanged')
    assert.deepEqual(receipt(), originalReceipt)
    const prototype = Database.prototype as unknown as { prepare: (this: Database.Database, sql: string) => Database.Statement }, prepare = prototype.prepare
    let queries = 0
    prototype.prepare = function (this: Database.Database, sql: string) { if (this === f.db) queries++; return prepare.call(this, sql) }
    try {
      assert.equal(repository.invoke(sender, { sessionId, method: 'releaseOwner', input: { readOwnerId: baseline.readOwnerId } }), undefined)
      assert.deepEqual(validateSyncedReadOwner(f.db, { readOwnerId: randomUUID() }), { status: 'owner-unavailable' })
      assert.deepEqual(getSyncedOperationWithOwnedLinkSource(f.db, { readOwnerId: randomUUID(), clientOperationId: input.clientOperationId }), { status: 'owner-unavailable' })
    } finally { prototype.prepare = prepare }
    assert.equal(queries, 0, 'pure old-epoch cleanup and unfenced missing-owner exits may not acquire a new SQL read')
    const closed = new Database(':memory:'); closed.close()
    assert.deepEqual(validateSyncedReadOwner(closed, { readOwnerId: randomUUID() }), { status: 'owner-unavailable' })
    assert.deepEqual(getSyncedOperationWithOwnedLinkSource(closed, { readOwnerId: randomUUID(), clientOperationId: input.clientOperationId }), { status: 'owner-unavailable' })
    if (fresh.status === 'ready') releaseSyncedReadOwner(f.db, { readOwnerId: fresh.readOwnerId })
    repository.releaseAll()
  }))

test('the unchanged historical operation reader checks a real epoch change inside its own read transaction and rolls the injected boundary back without publishing an ACK',
  { concurrency: false }, () => withCanonicalSearchFixture(f => {
    const repository = new SyncedEditingSessionRepository(f.db), sender = {}, opened = repository.open(sender, { kind: 'host', hostDocumentId: f.hostId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') return
    const operationId = f.searchCreate.operationId, sessionId = opened.session.sessionId
    const expected = repository.invoke(sender, { sessionId, method: 'getSyncedOperation', input: { clientOperationId: operationId } })
    assert.equal(expected.status, 'committed')
    const prototype = Database.prototype as unknown as { prepare: (this: Database.Database, sql: string) => Database.Statement }, prepare = prototype.prepare
    let injected = false, readTransaction = false
    prototype.prepare = function (this: Database.Database, sql: string) {
      if (this === f.db && !injected && sql === 'SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1') {
        injected = true; readTransaction = this.inTransaction
        prepare.call(this, 'UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
      }
      return prepare.call(this, sql)
    }
    try { assert.throws(() => repository.invoke(sender, { sessionId, method: 'getSyncedOperation', input: { clientOperationId: operationId } }), /workspace epoch changed/) }
    finally { prototype.prepare = prepare }
    assert.equal(injected, true); assert.equal(readTransaction, true)
    assert.equal((f.db.prepare('SELECT recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { recovery_epoch: string }).recovery_epoch, opened.session.recoveryEpoch)
    assert.deepEqual(repository.invoke(sender, { sessionId, method: 'getSyncedOperation', input: { clientOperationId: operationId } }), expected)
    assert.throws(() => f.db.transaction(() => repository.invoke(sender, { sessionId, method: 'getSyncedOperation', input: { clientOperationId: operationId } }))(), /own outer transaction/)
    repository.releaseAll()
  }))
