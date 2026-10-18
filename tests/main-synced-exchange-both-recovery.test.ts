import assert from 'node:assert/strict'
import test from 'node:test'
import { withBoth, readyBoth, bothComponent, selectBoth, acceptedBoth, forkSummary, overlappingGroup, insert,
  snapshot, completed, hostEdit, identity, physicalKnowledge, stateRow, remoteActual, executionRows,
  readonlyRequests, rejected, randomUUID, readStrictHostDocument } from './helpers/synced-exchange-both-fixture'

const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"

test('actual installed both replays its original fork map with zero HTTP after a new connection and later genuine fork edit', () => withBoth(async f => {
  const id = await overlappingGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), decision = selectBoth(c, { copies: [], hosts: 'existing' }), operationId = randomUUID()
  const original = acceptedBoth(await f.resolveBoth(p, [decision], operationId)), summary = forkSummary(original, c.componentId), fresh = summary.groups[0].groupId
  const { changeGroup } = await import('./helpers/synced-exchange-both-fixture')
  changeGroup(f.B.db, fresh, blocks => { blocks[0].content = 'later actual local fork edit after original receipt' })
  const edited = snapshot(f.B.db, fresh), before = executionRows(f.B), beforePhysical = physicalKnowledge(f.B.db)
  const row = f.B.db.prepare('SELECT request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(operationId)
  f.reopen()
  const start = f.server.requests.length, replay = acceptedBoth(await f.resolveBoth(p, [decision], operationId))
  assert.deepEqual(replay, { ...original, replayed: true }); assert.deepEqual(replay.forks, original.forks)
  assert.deepEqual(f.server.requests.slice(start), [], 'Original v3 success is replayed before any remote read or publication')
  assert.deepEqual(snapshot(f.B.db, fresh), edited); assert.deepEqual(physicalKnowledge(f.B.db), beforePhysical)
  assert.deepEqual(executionRows(f.B), before)
  assert.deepEqual(f.B.db.prepare('SELECT request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(operationId), row)
}))

test('actual both late receipt SQL failure rolls back installed forks and baseline while same-operation reopen settles the one original remote map', () => withBoth(async f => {
  const id = await overlappingGroup(f), p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), decision = selectBoth(c, { copies: [], hosts: 'none' }), operationId = randomUUID()
  const fresh = c.groups.find(group => group.sourceGroupId === id)
  assert.ok(fresh, 'The accepted original preview supplies the single stable orphan fork identity')
  const before = physicalKnowledge(f.B.db), baseline = stateRow(f.B.db).value, remoteBefore = remoteActual(f).bytes
  const seen: Array<{ groups: number; canonical: number; lifecycle: number }> = []
  f.B.db.function('both_late_scalar', (groups: number, canonical: number, lifecycle: number) => { seen.push({ groups, canonical, lifecycle }); return 0 })
  f.B.db.exec('CREATE TRIGGER both_late_receipt BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id=' + literal(operationId)
    + ' BEGIN SELECT both_late_scalar((SELECT count(*) FROM synced_groups WHERE id=' + literal(fresh.groupId) + '),'
    + '(SELECT count(*) FROM synced_group_blocks WHERE group_id=' + literal(fresh.groupId) + '),'
    + '(SELECT count(*) FROM synced_group_lifecycle WHERE group_id=' + literal(fresh.groupId) + ")); SELECT RAISE(ABORT,'both exact late receipt fixture'); END")
  try { await rejected(() => f.resolveBoth(p, [decision], operationId), 'database') }
  finally { f.B.db.exec('DROP TRIGGER both_late_receipt') }
  assert.ok(seen.some(row => row.groups === 1 && row.canonical > 0 && row.lifecycle === 1), 'The real SQL trigger observes genuine installed fork rows before raising, without callback SQL reentry')
  assert.deepEqual(physicalKnowledge(f.B.db), before); assert.equal(stateRow(f.B.db).value, baseline)
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined)
  const published = remoteActual(f)
  assert.notDeepEqual(published.bytes, remoteBefore); assert.ok(published.manifest.entries['group:' + fresh.groupId], 'The remote content manifest actually committed the original fixed fork before local rollback')
  f.reopen()
  const start = f.server.requests.length, result = acceptedBoth(await f.resolveBoth(p, [decision], operationId)), summary = forkSummary(result, c.componentId)
  assert.equal(summary.groups[0].groupId, fresh.groupId); assert.equal(summary.groups[0].creationId, fresh.creationId)
  assert.equal(snapshot(f.B.db, fresh.groupId).createdAt, fresh.createdAt)
  readonlyRequests(f.server.requests.slice(start))
  assert.deepEqual(remoteActual(f).bytes, published.bytes)
  assert.equal((f.B.db.prepare('SELECT count(*) AS n FROM synced_groups WHERE id=?').get(fresh.groupId) as { n: number }).n, 1)
  const replayStart = f.server.requests.length
  assert.equal(acceptedBoth(await f.resolveBoth(p, [decision], operationId)).replayed, true)
  assert.deepEqual(f.server.requests.slice(replayStart), [])
}))

test('actual both detects a fresh instance candidate occupied by another real writer before publication and still accepts an unrelated incoming island', () => withBoth(async f => {
  const id = await overlappingGroup(f)
  assert.ok(f.orphanId, 'The independent active orphan group is a real initial fixture group')
  hostEdit(f.A.db, f.islands[1], 'unrelated accepted incoming beside a both allocation collision'); completed(await f.exchange(f.A), 'applied')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), destination = c.groups.find(group => group.sourceGroupId === id)
  assert.ok(destination, 'The real preview exposes its immutable candidate before the operation runs')
  const candidate = destination.hosts.find(host => host.destination === 'existing')
  assert.ok(candidate, 'There is a real existing occurrence selector with a fresh candidate instance ID')
  const other = f.connect(f.B), foreign = { ...f.B, db: other }
  insert(foreign, f.orphanId, f.islands[2], { instanceId: candidate.instanceId })
  const owner = identity(other, candidate.instanceId), originalLocal = snapshot(f.B.db, id), originalRemote = remoteActual(f), start = f.server.requests.length
  const result = acceptedBoth(await f.resolveBoth(p, [selectBoth(c, { copies: [], hosts: 'existing' })]))
  assert.ok(result.deferred.some(row => row.keys.includes('group:' + id)), 'The fork source component is withdrawn instead of stealing the independently occupied candidate')
  assert.equal(result.acceptedKeys.includes('group:' + id), false)
  assert.equal(result.forks.some(row => row.componentId === c.componentId), false)
  assert.deepEqual(snapshot(f.B.db, id), originalLocal); assert.deepEqual(identity(other, candidate.instanceId), owner)
  assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'unrelated accepted incoming beside a both allocation collision')
  const remote = remoteActual(f)
  assert.equal(remote.manifest.entries['group:' + id], originalRemote.manifest.entries['group:' + id])
  assert.equal(remote.manifest.entries['group:' + destination.groupId], undefined)
  const badContent = f.server.requests.slice(start).filter(request => request.method === 'PUT' && /\/objects\//.test(request.path)).filter(request => {
    try { return (JSON.parse(request.bytes.toString()) as { id?: string }).id === destination.groupId } catch { return false }
  })
  assert.deepEqual(badContent, [], 'A collision known before execution cannot publish even the rejected fork object')
}, { orphan: true }))

test('actual both remote-success local-collision remains a structured blocker across reopen without changing its original map or foreign owner', () => withBoth(async f => {
  const id = await overlappingGroup(f)
  assert.ok(f.orphanId, 'The foreign writer uses the real independent active orphan')
  const p = readyBoth(await f.previewBoth()), c = bothComponent(p, 'group:' + id), decision = selectBoth(c, { copies: [], hosts: 'existing' }), destination = c.groups.find(group => group.sourceGroupId === id)
  assert.ok(destination, 'The original candidate group and fresh instances are displayed')
  const candidate = destination.hosts.find(host => host.destination === 'existing')
  assert.ok(candidate, 'An existing occurrence has a stable fresh instance candidate')
  const operationId = randomUUID(), beforeBaseline = stateRow(f.B.db).value, local = snapshot(f.B.db, id)
  const gate = f.gate(request => request.method === 'GET' && request.path.endsWith('/manifest.json') && (() => {
    const raw = f.server.files.get('/' + f.targetConfig.directory + '/manifest.json')
    return Boolean(raw && (JSON.parse(raw.toString()) as { entries: Record<string, string> }).entries['group:' + destination.groupId])
  })())
  const job = f.resolveBoth(p, [decision], operationId)
  let owner: ReturnType<typeof identity>
  try {
    await gate.wait(job)
    const other = f.connect(f.B)
    insert({ ...f.B, db: other }, f.orphanId, f.islands[2], { instanceId: candidate.instanceId })
    owner = identity(other, candidate.instanceId)
  } finally { gate.release() }
  const blocked = await job
  assert.ok(blocked.status === 'blocked', 'Actual remote success with a foreign occupied instance is not an installed or accepted receipt')
  assert.equal(blocked.stage, 'published-local'); assert.equal(blocked.reason, 'identity-collision')
  assert.ok(blocked.collisions.some(row => row.id === candidate.instanceId), 'The blocker names the actual independently owned candidate')
  assert.ok(blocked.componentIds.includes(c.componentId), 'The exact fork component remains tracked as uninstalled')
  assert.equal(stateRow(f.B.db).value, beforeBaseline); assert.deepEqual(snapshot(f.B.db, id), local)
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(destination.groupId), undefined)
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId), undefined)
  assert.deepEqual(identity(f.B.db, candidate.instanceId), owner)
  const published = remoteActual(f)
  assert.equal(blocked.publishedManifestHash, published.hash); assert.ok(published.manifest.entries['group:' + destination.groupId], 'The fixed original map is genuinely present remotely')
  f.reopen()
  const start = f.server.requests.length, again = await f.resolveBoth(p, [decision], operationId)
  assert.ok(again.status === 'blocked', 'A new SQLite connection cannot turn remote history into foreign local ownership')
  assert.equal(again.allocationHash, blocked.allocationHash); assert.equal(again.publishedManifestHash, blocked.publishedManifestHash)
  readonlyRequests(f.server.requests.slice(start)); assert.deepEqual(remoteActual(f).bytes, published.bytes)
  assert.deepEqual(identity(f.B.db, candidate.instanceId), owner); assert.equal(stateRow(f.B.db).value, beforeBaseline)
}, { orphan: true }))
