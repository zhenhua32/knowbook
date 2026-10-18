import assert from 'node:assert/strict'
import test from 'node:test'
import { SyncedPublicationError } from '../src/main/sync/synced-publication'
import { withDeletionChoices, groupConflict, docConflict, ready, component, choose, completed, randomUUID,
  snapshot, hostEdit, readStrictHostDocument, liveKnowledge, allTables, rejected, readonlyRequests,
  literal, proof2, receipt7, execution, job7 } from './helpers/synced-deletion-choice-fixture'

test('explicit keep-delete remotely publishes independent U before a late native SQL failure rolls back actual deletion proof and physical rows then the same operation reopens', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f)
  hostEdit(f.B.db, f.islands[1], 'Actual outgoing U together with keep-delete')
  hostEdit(f.A.db, f.islands[2], 'Actual incoming V before delete-choice SQL receipt'); completed(await f.exchange(f.A), 'applied')
  const p = ready(await f.preview()), decision = choose(component(p, conflict.key), 'keep-delete'), operationId = randomUUID()
  const before = liveKnowledge(f.B.db), state = f.B.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange.v1.%'").all()
  const seen: Array<{ canonical: number; markers: number; anchors: number; incoming: number }> = []
  f.B.db.function('deletion_choice_scalar', (canonical: number, markers: number, anchors: number, incoming: number) => { seen.push({ canonical, markers, anchors, incoming }); return 0 })
  f.B.db.exec('CREATE TRIGGER deletion_choice_late BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id=' + literal(operationId)
    + ' BEGIN SELECT deletion_choice_scalar((SELECT count(*) FROM synced_group_blocks WHERE group_id=' + literal(conflict.id) + '),'
    + "(SELECT count(*) FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'),"
    + "(SELECT count(*) FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1'),"
    + '(SELECT count(*) FROM blocks WHERE document_id=' + literal(f.islands[2]) + " AND content='Actual incoming V before delete-choice SQL receipt')); SELECT RAISE(ABORT,'native deletion-choice receipt failure'); END")
  try {
    await rejected(() => f.resolve(p, [decision], operationId), 'database')
    assert.ok(seen.some(row => row.canonical === 0 && row.markers > 0 && row.anchors > 0 && row.incoming > 0), 'SQL scalar arguments witness the real deletion marker anchor and incoming row before the single transaction rolls back')
    assert.deepEqual(liveKnowledge(f.B.db), before)
    assert.deepEqual(f.B.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange.v1.%'").all(), state)
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined)
    assert.equal(f.B.db.prepare("SELECT 1 FROM synced_operations WHERE client_operation_id LIKE 'synced:logical-deletion:v1:%'").get(), undefined)
    const remote = f.remote().records.get('doc:' + f.islands[1])
    assert.ok(remote?.kind === 'document' && remote.content.blocks[0].content === 'Actual outgoing U together with keep-delete', 'The exact combined manifest was genuinely published before local receipt failure')
    assert.ok(execution(f).jobs.length > 0, 'A published original job remains durable and is not replaced by a new current capture')
  } finally { f.B.db.exec('DROP TRIGGER deletion_choice_late') }
  f.reopenPeer(); const published = f.remote().bytes, start = f.server.requests.length
  const settled = completed(await f.resolve(p, [decision], operationId), 'applied')
  readonlyRequests(f.server.requests.slice(start)); assert.deepEqual(f.remote().bytes, published)
  const proof = proof2(f, operationId, conflict.key)
  assert.deepEqual(proof.value.base, conflict.base); assert.deepEqual(proof.value.before, conflict.localWire)
  assert.equal(readStrictHostDocument(f.B.db, f.islands[2]).detail.blocks[0].content, 'Actual incoming V before delete-choice SQL receipt')
  const requests = f.server.requests.length
  assert.deepEqual(await f.resolve(p, [decision], operationId), { ...settled, replayed: true }); assert.equal(f.server.requests.length, requests)
}))

test('explicit keep-live remote publication survives late SQL rollback and resumes its original authenticated decision source after a connection reopen', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), p = ready(await f.preview()), decision = choose(component(p, conflict.key), 'keep-live'), operationId = randomUUID()
  const before = liveKnowledge(f.B.db), seen: number[] = []
  f.B.db.function('deletion_keep_live_scalar', (canonical: number) => { seen.push(canonical); return 0 })
  f.B.db.exec('CREATE TRIGGER deletion_keep_live_late BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id=' + literal(operationId)
    + ' BEGIN SELECT deletion_keep_live_scalar((SELECT count(*) FROM synced_group_blocks WHERE group_id=' + literal(conflict.id) + ")); SELECT RAISE(ABORT,'native keep-live late receipt'); END")
  try {
    await rejected(() => f.resolve(p, [decision], operationId), 'database')
    assert.ok(seen.some(value => value > 0), 'The actual current live canonical forest remains present at the native receipt boundary')
    assert.deepEqual(liveKnowledge(f.B.db), before)
    assert.deepEqual(f.remote().records.get(conflict.key), conflict.localWire)
  } finally { f.B.db.exec('DROP TRIGGER deletion_keep_live_late') }
  const published = f.remote().bytes; f.reopenPeer(); const start = f.server.requests.length
  completed(await f.resolve(p, [decision], operationId), 'applied')
  readonlyRequests(f.server.requests.slice(start)); assert.deepEqual(f.remote().bytes, published)
  assert.deepEqual(snapshot(f.B.db, conflict.id).blocks, conflict.local.blocks)
  const original = job7(f, operationId)
  assert.deepEqual(original.job.decisionSource.decisions, [decision]); assert.equal(original.job.resolution.previewId, p.previewId)
  assert.deepEqual(original.receipt.provenance.deletions, [])
}))

test('an actual conditional manifest 412 invalidates the original deletion component while an independent real outgoing document may continue', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f)
  hostEdit(f.B.db, f.islands[1], 'Independent U survives deletion decision real 412')
  const p = ready(await f.preview()), c = component(p, conflict.key), before = snapshot(f.B.db, conflict.id)
  const gate = f.gate(request => request.method === 'PUT' && request.path.endsWith('/manifest.json')), start = f.server.requests.length
  const job = f.resolve(p, [choose(c, 'keep-live')])
  try {
    await gate.wait(job)
    const pending = f.server.requests.at(-1)
    assert.ok(pending?.method === 'PUT' && pending.ifMatch, 'The pending real manifest publication owns its original exact conditional ETag')
    f.remoteFinal(records => {
      const deleted = records.get(conflict.key)
      assert.ok(deleted?.kind === 'synced-group-deleted', 'The race changes an actual strict remote protocol tombstone rather than any local authority fact')
      deleted.deletedAt = new Date(Date.parse(deleted.deletedAt) + 1000).toISOString()
    })
    const winning = f.remote().manifest.entries[conflict.key]
    assert.notEqual(pending.ifMatch, '"' + f.remote().hash + '"'); gate.release()
    const result = completed(await job, 'applied')
    assert.ok(result.deferred.some(row => row.keys.includes(conflict.key)), 'The 412 replan cannot turn a different remote source into authority for the original selected component')
    assert.equal(result.acceptedKeys.includes(conflict.key), false); assert.deepEqual(snapshot(f.B.db, conflict.id), before)
    assert.equal(f.remote().manifest.entries[conflict.key], winning)
    assert.ok(result.publishedKeys.includes('doc:' + f.islands[1]), 'An unrelated real outgoing component remains independently executable')
    assert.ok(f.server.requests.slice(start).filter(request => request.method === 'PUT' && request.path.endsWith('/manifest.json')).length >= 2, 'The actual failed conditional request is followed by a real replanned conditional publication')
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('a real manifest lost ACK resumes one original keep-live operation after reopen without changing its selected same-creation forest', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), p = ready(await f.preview()), decision = choose(component(p, conflict.key), 'keep-live'), operationId = randomUUID()
  let lost = false
  f.server.setHook(request => { if (!lost && request.method === 'PUT' && request.path.endsWith('/manifest.json')) { lost = true; return { kind: 'persist-then-disconnect' } } })
  try { completed(await f.resolve(p, [decision], operationId), 'applied') } catch (error) {
    assert.ok(error instanceof SyncedPublicationError, 'An unsuccessful immediate lost-ACK recovery keeps its finite transport error and cause')
    assert.equal(error.code, 'transport')
  } finally { f.server.setHook(undefined) }
  assert.equal(lost, true); const published = f.remote().bytes; f.reopenPeer()
  completed(await f.resolve(p, [decision], operationId), 'applied')
  assert.deepEqual(f.remote().bytes, published); assert.deepEqual(snapshot(f.B.db, conflict.id).blocks, conflict.local.blocks)
  const actual = job7(f, operationId)
  assert.deepEqual(actual.job.decisionSource.decisions, [decision]); assert.equal(actual.job.resolution.previewId, p.previewId)
  assert.deepEqual(actual.receipt.provenance.deletions, [])
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_operations WHERE client_operation_id=?').get(operationId) as { n: number }).n, 1)
}))

test('a committed deletion decision replays its original proof2 historical ACK before new epoch authority with zero HTTP but a changed selector cannot reuse that operation', () => withDeletionChoices(async f => {
  const conflict = docConflict(f), p = ready(await f.preview()), c = component(p, conflict.key), decision = choose(c, 'keep-delete'), operationId = randomUUID()
  const first = completed(await f.resolve(p, [decision], operationId), 'applied'), original = proof2(f, operationId, conflict.key)
  f.B.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
  f.reopenPeer(); const before = allTables(f.B.db), start = f.server.requests.length
  assert.deepEqual(await f.resolve(p, [decision], operationId), { ...first, replayed: true })
  assert.equal(f.server.requests.length, start); assert.deepEqual(allTables(f.B.db), before)
  assert.deepEqual(proof2(f, operationId, conflict.key), original)
  await rejected(() => f.resolve(p, [{ componentId: c.componentId, choice: 'keep-live' }], operationId), 'invalid')
  assert.equal(f.server.requests.length, start); assert.deepEqual(allTables(f.B.db), before)
  assert.equal(receipt7(f, operationId).row.result_json, original.row.result_json)
}))
