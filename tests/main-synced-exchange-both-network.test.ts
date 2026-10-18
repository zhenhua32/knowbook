import assert from 'node:assert/strict'
import test from 'node:test'
import { withBoth, overlappingGroup, readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary,
  hostEdit, readStrictHostDocument, completed, converged, remoteActual, snapshot, randomUUID } from './helpers/synced-exchange-both-fixture'

test('actual both manifest CAS 412 replans an unrelated real peer write while keeping the original displayed fork map', () => withBoth(async f => {
  const id = await overlappingGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), decision = selectBoth(c, { copies: [], hosts: 'none' })
  const shown = c.groups.find(group => group.sourceGroupId === id)
  assert.ok(shown, 'The accepted selector names the original stable local group fork')
  const original = remoteActual(f), operationId = randomUUID(), start = f.server.requests.length
  const gate = f.gate(request => request.method === 'PUT' && request.path.endsWith('/manifest.json') && request.ifMatch === original.etag)
  const job = f.resolveBoth(p, [decision], operationId)
  try {
    await gate.wait(job)
    hostEdit(f.A.db, f.islands[1], 'real unrelated peer write winning the fork manifest CAS')
    completed(await f.exchange(f.A), 'applied')
    const winner = remoteActual(f)
    assert.notEqual(winner.hash, original.hash)
    gate.release()
    const result = acceptedBoth(await job), summary = forkSummary(result, c.componentId)
    assert.deepEqual(summary.groups, [{ sourceGroupId: id, groupId: shown.groupId, creationId: shown.creationId }])
    assert.equal(snapshot(f.B.db, shown.groupId).createdAt, shown.createdAt)
    assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'real unrelated peer write winning the fork manifest CAS')
    const writes = f.server.requests.slice(start).filter(request => request.method === 'PUT' && request.path.endsWith('/manifest.json') && request.ifMatch)
    assert.ok(writes.some(request => request.ifMatch === winner.etag), 'The actual rejected stale CAS is followed by a new conditional write against the winning peer ETag')
    assert.ok(writes.length >= 3, 'The stale fork write, winning independent peer write and successful replan are distinct real HTTP attempts')
    completed(await f.exchange(f.A), 'applied'); converged(f)
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('actual both persist-then-disconnect queries only the original accepted publication and replays its fixed map with zero HTTP after reopen', () => withBoth(async f => {
  const id = await overlappingGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), decision = selectBoth(c, { copies: [], hosts: 'none' })
  const shown = c.groups.find(group => group.sourceGroupId === id)
  assert.ok(shown, 'The original preview fixes the one local fork before its publication starts')
  const operationId = randomUUID(), start = f.server.requests.length
  let dropped = false
  f.server.setHook(request => {
    if (!dropped && request.method === 'PUT' && request.path.endsWith('/manifest.json') && request.ifMatch) {
      dropped = true; return { kind: 'persist-then-disconnect' }
    }
  })
  const original = acceptedBoth(await f.resolveBoth(p, [decision], operationId)), summary = forkSummary(original, c.componentId)
  assert.equal(dropped, true)
  assert.deepEqual(summary.groups, [{ sourceGroupId: id, groupId: shown.groupId, creationId: shown.creationId }])
  const settled = remoteActual(f), end = f.server.requests.length
  assert.equal(f.server.requests.slice(start, end).filter(request => request.method === 'PUT' && request.path.endsWith('/manifest.json') && request.ifMatch).length, 1, 'A lost native ACK does not cause another semantic manifest publication or allocation')
  assert.ok(f.server.requests.slice(start, end).some(request => request.method === 'GET' && request.path.endsWith('/manifest.json')), 'The actual sender reads back the committed native bytes')
  f.reopen()
  const replay = acceptedBoth(await f.resolveBoth(p, [decision], operationId))
  assert.deepEqual(replay, { ...original, replayed: true }); assert.equal(f.server.requests.length, end)
  assert.deepEqual(remoteActual(f).bytes, settled.bytes)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_groups WHERE id=?').get(shown.groupId) as { n: number }).n, 1)
  completed(await f.exchange(f.A), 'applied'); converged(f)
}))
