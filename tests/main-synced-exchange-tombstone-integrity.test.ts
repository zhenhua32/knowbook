import assert from 'node:assert/strict'
import test from 'node:test'
import { withTombstones, completed, randomUUID, encode, allTables, deleteGroup, deleteDocument, document,
  assertAbsentKnowledge, state, rejected, liveKnowledge, withDocumentOnlyTombstone, listSyncedGroups, getSyncedGroupSnapshots } from './helpers/synced-exchange-tombstone-fixture'

test('actual committed deletion marker or its original exchange receipt cannot be wholly removed and laundered into an unobserved missing record', async () => {
  for (const fault of ['delete-marker', 'delete-receipt'] as const) await withTombstones(async f => {
    f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
    const saved = assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId), id = fault === 'delete-marker' ? saved.row.client_operation_id : saved.proof.application.operationId
    assert.equal(f.B.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(id).changes, 1)
    const before = allTables(f.B.db), requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => f.exchange(), 'invalid')
    assert.equal(f.server.requests.length, requests, 'The cold current-state boundary rejects missing permanent proof facts before any HTTP or new durable job')
    assert.deepEqual(allTables(f.B.db), before)
  })
})

test('actual deletion receipt exact proof index cannot be edited cleared or replaced even when all physical content remains absent', async () => {
  for (const fault of ['clear-index', 'bad-proof-hash', 'wrong-anchor'] as const) await withTombstones(async f => {
    f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
    const saved = assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId), receipt = structuredClone(saved.receipt)
    if (fault === 'clear-index') receipt.provenance.deletions = []
    else if (fault === 'bad-proof-hash') receipt.provenance.deletions[0].proofHash = '0'.repeat(64)
    else receipt.provenance.deletions[0].anchorId = 'synced:logical-deletion:v1:doc:' + encode('wrong permanent anchor')
    f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(receipt), saved.proof.application.operationId)
    const before = allTables(f.B.db), requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => f.exchange(), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  })
})

test('actual state2 absent outcome and complete baseline key set are authenticated against the original receipt before any remote resurrection can be planned', async () => {
  for (const fault of ['delete-baseline-row', 'fake-live-outcome', 'changed-intent'] as const) await withTombstones(async f => {
    const key = 'group:' + f.orphanId
    f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
    const saved = assertAbsentKnowledge(f.B.db, key), current = state(f.B.db), next = structuredClone(current.parsed)
    const entry = next.baseline.find(row => row.key === key)
    assert.ok(entry, 'The corruption starts from an actual settled per-key absent baseline entry')
    if (fault === 'delete-baseline-row') next.baseline = next.baseline.filter(row => row.key !== key)
    else if (fault === 'fake-live-outcome') entry.local = { kind: 'live', ...{ hash: saved.proof.tombstoneHash } }
    else entry.local.intentHash = '0'.repeat(64)
    f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(next), current.key)
    const before = allTables(f.B.db), requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => f.exchange(), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  })
})

test('actual denial anchor remains nondeletable and an additional reserved-domain orphan anchor cannot be hidden by another valid deletion proof', () => withTombstones(async f => {
  f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
  const saved = assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId)
  assert.throws(() => f.B.db.prepare('DELETE FROM synced_exposure_attempts WHERE id=?').run(saved.row.client_operation_id))
  const id = 'synced:logical-deletion:v1:doc:' + encode(' orphan anchor:opaque\0id ')
  f.B.db.prepare('INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,?,?,?,?,?,NULL)')
    .run(id, saved.anchor.request_hash, 'logical-deletion-denial-v1', saved.anchor.target_fingerprint, saved.anchor.publication_hash, 'possible', saved.anchor.created_at)
  const before = allTables(f.B.db), requests = f.server.requests.length
  f.reopenPeer(); await rejected(() => f.exchange(), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
}))

test('actual doc-only permanent marker mismatch is denied without deleting unrelated identities or repairing surviving catalog and current source facts', () => withTombstones(async f => {
  const id = f.islands[0]
  f.remoteFinal(records => { deleteDocument(records, id) }); completed(await f.exchange(), 'applied')
  const saved = assertAbsentKnowledge(f.B.db, 'doc:' + id), changed = structuredClone(saved.proof)
  changed.localBefore.createdAt = '1900-01-01T00:00:00Z'
  f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(changed), saved.row.client_operation_id)
  const before = allTables(f.B.db), requests = f.server.requests.length
  f.reopenPeer(); await rejected(() => f.exchange(), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
}))

test('actual group-free doc denial orphan is checked by empty group reads list and exchange before any HTTP instead of being skipped with zero raw groups', () => withDocumentOnlyTombstone(async f => {
  f.remoteFinal(records => { deleteDocument(records, f.ordinaryId) }); completed(await f.exchange(), 'applied')
  const saved = assertAbsentKnowledge(f.B.db, 'doc:' + f.ordinaryId)
  assert.equal(f.B.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(saved.row.client_operation_id).changes, 1)
  const before = allTables(f.B.db), requests = f.server.requests.length
  f.reopen()
  assert.throws(() => getSyncedGroupSnapshots(f.B.db, { groupIds: [] }))
  assert.throws(() => listSyncedGroups(f.B.db, { query: '', offset: 0, limit: 10 }))
  await rejected(() => f.exchange(), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
}))
