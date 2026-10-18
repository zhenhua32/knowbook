import assert from 'node:assert/strict'
import test from 'node:test'
import { withDeletionChoices, groupConflict, docConflict, realNewReference, ready, component, choose, completed,
  snapshot, count, randomUUID, allTables, rejected, localPortable, hostEdit, readStrictHostDocument, proof2,
  createRequest, created, applySyncedHostCommand, deleteDocument } from './helpers/synced-deletion-choice-fixture'

test('real producer-created history pins exclude keep-delete and a caller cannot turn that displayed blocker into deletion authority', () => withDeletionChoices(async f => {
  const conflict = realNewReference(f), p = ready(await f.preview()), c = component(p, conflict.key)
  assert.equal(c.keepDeleteReason, 'history-pin'); assert.equal(c.choices.includes('keep-delete'), false)
  const before = allTables(f.B.db), requests = f.server.requests.length
  await rejected(() => f.resolve(p, [{ componentId: c.componentId, choice: 'keep-delete' }]), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id').all(conflict.id), conflict.pins)
}))

test('permanent proof2 denial has no keep-live resurrection or proof-before copy source after this peer really accepted the changed G deletion', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), originalPreview = ready(await f.preview()), originalComponent = component(originalPreview, conflict.key), operationId = randomUUID()
  completed(await f.resolve(originalPreview, [choose(originalComponent, 'keep-delete')], operationId), 'applied')
  const original = proof2(f, operationId, conflict.key), identities = f.B.db.prepare('SELECT * FROM block_identities ORDER BY id').all()
  f.remoteFinal(records => { records.set(conflict.key, structuredClone(conflict.localWire)) })
  const p = ready(await f.preview())
  assert.equal(p.components.some(c => c.keys.includes(conflict.key) && c.choices.includes('keep-live')), false, 'An accepted permanent denial is never another live candidate even when R advertises old content again')
  const before = allTables(f.B.db), requests = f.server.requests.length
  await rejected(() => f.resolve(p, [{ componentId: originalComponent.componentId, choice: 'keep-live' }]), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  assert.deepEqual(proof2(f, operationId, conflict.key), original)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM block_identities ORDER BY id').all(), identities)
  assert.equal(count(f.B.db, 'synced_group_blocks', 'group_id', conflict.id), 0)
}))

test('a current Main host edit during real resolve HTTP withdraws only its complete selected deletion component and keeps independent U incoming', () => withDeletionChoices(async f => {
  const conflict = docConflict(f)
  hostEdit(f.A.db, f.islands[1], 'Actual U beside await-time deletion guard drift'); completed(await f.exchange(f.A), 'applied')
  const p = ready(await f.preview()), c = component(p, conflict.key), gate = f.gate(r => r.method === 'GET' && r.path.endsWith('/manifest.json'))
  const job = f.resolve(p, [choose(c, 'keep-delete')])
  try {
    await gate.wait(job); const other = f.connect(f.B)
    hostEdit(other, conflict.id, 'Actual intervening Main edit during deletion resolve')
    const current = readStrictHostDocument(other, conflict.id); gate.release()
    const result = completed(await job, 'applied')
    assert.ok(result.deferred.some(row => row.keys.includes(conflict.key)), 'The original L/R/B selection cannot survive a new actual current host guard')
    assert.equal(result.acceptedKeys.includes(conflict.key), false); assert.deepEqual(readStrictHostDocument(f.B.db, conflict.id), current)
    assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'Actual U beside await-time deletion guard drift')
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('a changed-back raw group history cursor cannot renew an original keep-delete decision even though the current portable L is byte-identical', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), p = ready(await f.preview()), c = component(p, conflict.key), hash = localPortable(f.B).entries[conflict.key]
  const original = snapshot(f.B.db, conflict.id)
  f.B.db.prepare('UPDATE synced_groups SET history_cursor=? WHERE id=?').run(randomUUID(), conflict.id)
  assert.equal(localPortable(f.B).entries[conflict.key], hash)
  hostEdit(f.A.db, f.islands[1], 'U proceeds across current raw history fence'); completed(await f.exchange(f.A), 'applied')
  const current = snapshot(f.B.db, conflict.id), result = completed(await f.resolve(p, [choose(c, 'keep-delete')]), 'applied')
  assert.notEqual(current.history.cursor, original.history.cursor)
  assert.ok(result.deferred.some(row => row.keys.includes(conflict.key)), 'Raw cursor identity participates independently from semantic wire content')
  assert.equal(result.acceptedKeys.includes(conflict.key), false); assert.deepEqual(snapshot(f.B.db, conflict.id), current)
}))

test('keep-delete cannot erase a genuine L-only newly created group just because R has no record key for that real local owner', () => withDeletionChoices(async f => {
  const id = f.islands[0], body = readStrictHostDocument(f.B.db, id).detail.blocks[0]
  const input = createRequest(f.B.db, { documentId: id, selectedRootIds: [body.id] }), creation = created(applySyncedHostCommand(f.B.db, input))
  f.remoteFinal(records => { deleteDocument(records, id) })
  const p = ready(await f.preview()), c = component(p, 'doc:' + id), fresh = creation.createdLifecycle.groupId
  assert.ok(c.keys.includes('group:' + fresh), 'The actual local create owner-release and origin edges stay in the whole component')
  assert.equal(c.choices.includes('keep-delete'), false)
  const before = allTables(f.B.db), requests = f.server.requests.length
  await rejected(() => f.resolve(p, [{ componentId: c.componentId, choice: 'keep-delete' }]), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  assert.equal(snapshot(f.B.db, fresh).creationId, creation.createdLifecycle.creationId)
}))

test('unknown or bad predecessor group tombstones offer neither deletion decision and never borrow a real L from the same spelling', async () => {
  for (const fault of ['wrong-predecessor', 'wrong-creation'] as const) await withDeletionChoices(async f => {
    const conflict = groupConflict(f)
    f.remoteFinal(records => {
      const value = records.get(conflict.key)
      assert.ok(value?.kind === 'synced-group-deleted', 'The negative mutates the actual complete remote tombstone input')
      if (fault === 'wrong-predecessor') value.previousHash = '0'.repeat(64)
      else value.creationId = randomUUID()
    })
    const p = ready(await f.preview()), c = component(p, conflict.key), before = allTables(f.B.db), requests = f.server.requests.length
    assert.deepEqual(c.choices, [])
    assert.equal(c.keepLiveReason, fault === 'wrong-creation' ? 'incarnation' : 'tombstone')
    for (const choice of ['keep-live', 'keep-delete'] as const) await rejected(() => f.resolve(p, [{ componentId: c.componentId, choice }]), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  })
})
