import assert from 'node:assert/strict'
import test from 'node:test'
import { SyncedPublicationError } from '../src/main/sync/synced-publication'
import { withKnowledge, divergeGroup, ready, component, side, mergeDecision, completed, snapshot, unchangedDenial,
  readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary, storedReceipt, randomUUID, lateReceipt,
  hostEdit, changeGroup, state, liveKnowledge, allTables, literal, rejected, readonlyRequests, execution } from './helpers/synced-exchange-knowledge-fixture'

test('format5 selected merge remotely commits before late native SQL rollback and a new connection settles the same operation without touching earlier deletion facts', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f)
  hostEdit(f.A.db, f.islands[1], 'Actual incoming island before knowledge merge receipt'); completed(await f.exchange(f.A), 'applied')
  const p = ready(await f.preview()), c = component(p, conflict.key), text = 'Exact knowledge selected body before late SQL rollback'
  const decision = mergeDecision(c, () => ({ choice: 'custom', text })), operationId = randomUUID(), before = liveKnowledge(f.B.db), baseline = state(f.B.db).value
  const failure = lateReceipt(f.B.db, operationId, { documentId: f.islands[1], content: 'Actual incoming island before knowledge merge receipt' })
  try {
    await rejected(() => f.resolve(p, [decision], operationId), 'database')
    assert.ok(failure.seen.some(row => row.incomingMatches > 0), 'The native late SQL trigger observed a real installed incoming row without reentrant callback SQL')
    const wire = f.remote().records.get(conflict.key)
    assert.ok(wire?.kind === 'synced-group' && wire.blocks[0].content === text, 'The exact chosen merge really reached the remote manifest before SQL failed')
    assert.deepEqual(liveKnowledge(f.B.db), before); assert.equal(state(f.B.db).value, baseline)
    assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined)
    assert.ok(execution(f.B.db).jobs.length > 0, 'The original durable pending exchange remains after local rollback')
    unchangedDenial(f)
  } finally { failure.remove() }
  f.reopenPeer(); const published = f.remote().bytes, start = f.server.requests.length, settled = completed(await f.resolve(p, [decision], operationId), 'applied')
  readonlyRequests(f.server.requests.slice(start)); assert.deepEqual(f.remote().bytes, published)
  assert.equal(snapshot(f.B.db, conflict.id).blocks[0].content, text)
  storedReceipt(f.B.db, operationId, 5); unchangedDenial(f)
  const requests = f.server.requests.length; assert.deepEqual(await f.resolve(p, [decision], operationId), { ...settled, replayed: true }); assert.equal(f.server.requests.length, requests)
}))

test('format6 actual fork late SQL rollback preserves the one remote allocation and fixed Origin proof across a same-operation connection reopen', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, conflict.key), decision = selectBoth(c, { copies: [], hosts: 'none' })
  const destination = c.groups.find(group => group.sourceGroupId === conflict.id)
  assert.ok(destination, 'The original real both preview fixes the exact orphan destination before execution')
  const operationId = randomUUID(), before = liveKnowledge(f.B.db), baseline = state(f.B.db).value, seen: Array<{ groups: number; canonical: number; anchors: number }> = []
  f.B.db.function('knowledge_both_scalar', (groups: number, canonical: number, anchors: number) => { seen.push({ groups, canonical, anchors }); return 0 })
  f.B.db.exec('CREATE TRIGGER knowledge_both_late BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id=' + literal(operationId)
    + ' BEGIN SELECT knowledge_both_scalar((SELECT count(*) FROM synced_groups WHERE id=' + literal(destination.groupId) + '),'
    + '(SELECT count(*) FROM synced_group_blocks WHERE group_id=' + literal(destination.groupId) + '),'
    + "(SELECT count(*) FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1')); SELECT RAISE(ABORT,'actual knowledge fork late receipt'); END")
  try {
    await rejected(() => f.resolveBoth(p, [decision], operationId), 'database')
    assert.ok(seen.some(row => row.groups === 1 && row.canonical > 0 && row.anchors > 0), 'Actual SQL saw the new fork and old permanent denial together before atomically rolling back')
    assert.deepEqual(liveKnowledge(f.B.db), before); assert.equal(state(f.B.db).value, baseline); unchangedDenial(f)
  } finally { f.B.db.exec('DROP TRIGGER knowledge_both_late') }
  const published = f.remote().bytes
  assert.ok(f.remote().manifest.entries['group:' + destination.groupId], 'The original exact fork is a real remote publication despite local rollback')
  f.reopenPeer(); const start = f.server.requests.length, result = acceptedBoth(await f.resolveBoth(p, [decision], operationId)), summary = forkSummary(result, c.componentId)
  readonlyRequests(f.server.requests.slice(start)); assert.deepEqual(f.remote().bytes, published)
  assert.equal(summary.groups[0].groupId, destination.groupId); assert.equal(summary.groups[0].creationId, destination.creationId)
  assert.equal(snapshot(f.B.db, destination.groupId).createdAt, destination.createdAt)
  storedReceipt(f.B.db, operationId, 6); unchangedDenial(f)
}))

test('a genuine manifest 412 invalidates only an old selected complete component and cannot apply its old choice to a new R beside fixed absence', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f)
  hostEdit(f.B.db, f.islands[1], 'Independent actual outgoing U keeps real 412 replan useful')
  const p = ready(await f.preview()), c = component(p, conflict.key), before = snapshot(f.B.db, conflict.id), gate = f.gate(request => request.method === 'PUT' && request.path.endsWith('/manifest.json'))
  const job = f.resolve(p, [side(c, 'local')])
  try {
    await gate.wait(job)
    changeGroup(f.A.db, conflict.id, blocks => { blocks[0].content = 'New actual remote G defeats the original knowledge selector' }); completed(await f.exchange(f.A), 'applied')
    const winning = f.remote().manifest.entries[conflict.key]; gate.release()
    const result = completed(await job, 'applied')
    assert.ok(result.deferred.some(row => row.keys.includes(conflict.key)), 'The new attempt preserves the old full-component selection binding instead of reauthorizing it from fresh R')
    assert.equal(result.acceptedKeys.includes(conflict.key), false); assert.deepEqual(snapshot(f.B.db, conflict.id), before)
    assert.equal(f.remote().manifest.entries[conflict.key], winning)
    assert.ok(result.publishedKeys.includes('doc:' + f.islands[1]), 'Unrelated outgoing work remains independently executable after the real 412')
    const puts = f.server.requests.filter(request => request.method === 'PUT' && request.path.endsWith('/manifest.json'))
    assert.ok(puts.length >= 2, 'A real rejected conditional manifest causes another actual conditional publication')
    unchangedDenial(f)
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('a real both manifest lost ACK resumes the same format6 allocation after reopen and never creates a second fork or deletion anchor', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, conflict.key), decision = selectBoth(c, { copies: [], hosts: 'none' }), operationId = randomUUID()
  const destination = c.groups.find(group => group.sourceGroupId === conflict.id)
  assert.ok(destination, 'The original readonly preview fixes the only later genuine fork identity')
  let lost = false
  f.server.setHook(request => { if (!lost && request.method === 'PUT' && request.path.endsWith('/manifest.json')) { lost = true; return { kind: 'persist-then-disconnect' } } })
  try { acceptedBoth(await f.resolveBoth(p, [decision], operationId)) } catch (error) {
    assert.ok(error instanceof SyncedPublicationError, 'A failed immediate lost-ACK recovery reports the original finite transport error')
    assert.equal(error.code, 'transport')
  } finally { f.server.setHook(undefined) }
  assert.equal(lost, true); f.reopenPeer()
  const result = acceptedBoth(await f.resolveBoth(p, [decision], operationId)), summary = forkSummary(result, c.componentId)
  assert.equal(summary.groups[0].groupId, destination.groupId); assert.equal(summary.groups[0].creationId, destination.creationId)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_groups WHERE id=?').get(destination.groupId) as { n: number }).n, 1)
  storedReceipt(f.B.db, operationId, 6); unchangedDenial(f)
}))

test('committed format5 and format6 receipts replay before new preview or epoch authority with zero HTTP while fixed deletion facts remain immutable', async () => {
  for (const mode of ['choice', 'both'] as const) await withKnowledge(async f => {
    const conflict = await divergeGroup(f), operationId = randomUUID()
    const p = mode === 'choice' ? ready(await f.preview()) : readyBoth(await f.previewBoth())
    const decision = mode === 'choice' ? side(component(p as ReturnType<typeof ready>, conflict.key), 'remote')
      : selectBoth(bothComponent(p as ReturnType<typeof readyBoth>, conflict.key), { copies: [], hosts: 'none' })
    const call = () => mode === 'choice' ? f.resolve(p as ReturnType<typeof ready>, [decision as Parameters<typeof f.resolve>[1][number]], operationId)
      : f.resolveBoth(p as ReturnType<typeof readyBoth>, [decision as Parameters<typeof f.resolveBoth>[1][number]], operationId)
    const first = await call()
    if (mode === 'choice') completed(first as Awaited<ReturnType<typeof f.resolve>>); else acceptedBoth(first as Awaited<ReturnType<typeof f.resolveBoth>>)
    changeGroup(f.B.db, conflict.id, blocks => { blocks[0].content = 'A later genuine edit cannot rewrite the earlier historical selector ACK' })
    f.B.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
    f.reopenPeer(); const before = allTables(f.B.db), requests = f.server.requests.length
    assert.deepEqual(await call(), { ...first, replayed: true }); assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
    unchangedDenial(f)
  })
})
