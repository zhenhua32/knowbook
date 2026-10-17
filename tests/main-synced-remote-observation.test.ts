import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { decodeSyncedOperationAck } from '../src/main/database/synced-host-operation-receipt'
import { decodeSyncedGroupOperationAck } from '../src/main/database/synced-group-operation-receipt'
import { assertSyncedLifecycleSchema } from '../src/main/database/synced-lifecycle-schema'
import { captureSyncedBaselineOwner, getSyncedOperationWithOwnedLinkSource, releaseSyncedReadOwner } from '../src/main/database/synced-binding-sources'
import { withObservationFixture, openSyncedRemoteObservation, observeSyncedRemoteExposure, retrySyncedRemoteObservationCommit,
  disposeSyncedRemoteObservation, requireObserved, invariantTables, marker, markerRows, exposureRows, stableKey, localHash,
  createRestoreInput, restoreCreated, restoreSyncedHostOperation, getSyncedCreateRestoreContext, refusedRestore,
  createRequest, created, applySyncedHostCommand, editCreatedGroup, snapshot, bodyId, allTables, totalChanges,
  prepared, publishInitialSyncedPublication, disposePreparedSyncedPublication, readSyncedPublishedSnapshot,
  readSyncedPublishedSnapshotFacts, runtime, rejectedCode, remoteManifest, alterRemoteRecord, expectedClosure, manifestPath, encode, hash } from './helpers/synced-remote-observation-fixture'

const key = (f: Parameters<Parameters<typeof withObservationFixture>[0]>[0]) => stableKey(f.createAck.createdLifecycle.groupId, f.createAck.createdLifecycle.creationId)
function contextUnavailable(db: Parameters<typeof getSyncedCreateRestoreContext>[0], token: string | null, direction: 'undo' | 'redo') {
  assert.deepEqual(getSyncedCreateRestoreContext(db, { historyToken: token, direction }), { status: 'unavailable', reason: 'lifecycle' })
}
function readOnlyRequests(requests: Array<{ method: string; path: string }>) {
  assert.ok(requests.length > 0 && requests.every(request => ['GET', 'HEAD', 'PROPFIND'].includes(request.method)), 'The observer performs only actual versioned reads and required metadata, without probe or writes')
  assert.ok(requests.every(request => !request.path.includes('/.probe-')), 'Observation never performs the capability-probe protocol')
}
function rememberRows(db: Parameters<typeof allTables>[0]) {
  return db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations ORDER BY client_operation_id').all()
}
function installLateFailure(db: Parameters<typeof allTables>[0]) {
  const saw: Array<{ markers: number; members: number }> = []
  db.function('observation_late_fixture', (markers: number, members: number) => {
    saw.push({ markers, members }); return 0
  })
  db.exec("CREATE TRIGGER observation_late_failure BEFORE UPDATE OF state ON synced_exposure_attempts WHEN NEW.channel='webdav-manifest5-observed' AND NEW.state='confirmed' BEGIN SELECT observation_late_fixture((SELECT count(*) FROM synced_operations WHERE client_operation_id LIKE 'synced:remote-exposure-observation:v1:%'),(SELECT count(*) FROM synced_group_exposure_members)); SELECT RAISE(ABORT,'remote observation real late SQL fixture'); END;")
  return saw
}

test('real create cloned before publication stays never until active observation commits exact local member authority', () => withObservationFixture(async f => {
  const undo = createRestoreInput(f.db, f.createAck, 'undo').input, original = snapshot(f.db, f.createAck.createdLifecycle.groupId)
  const semantic = localHash(f.db, original.groupId), preserved = invariantTables(f.db), oldRows = rememberRows(f.db)
  assert.equal((f.db.prepare('SELECT exposure_state FROM synced_group_lifecycle WHERE group_id=?').get(original.groupId) as { exposure_state: string }).exposure_state, 'never'); assert.equal(markerRows(f.db).length, 0)
  const bytes = await f.publish(), closure = expectedClosure(f.server, f.actualAssets), observer = f.open(), start = f.server.requests.length, value = requireObserved(await f.observe(observer))
  assert.equal(value.manifestHash, hash(bytes)); assert.equal(value.groups.length, 1)
  assert.equal(value.closureHash, closure)
  assert.deepEqual(value.groups[0], { groupId: original.groupId, creationId: original.creationId, outcome: 'active-confirmed', reused: false })
  const row = marker(f.db, key(f)), envelope = JSON.parse(row.result_json)
  assert.equal(row.request_hash, hash(encode({ method: 'observeSyncedRemoteExposure', proof: envelope })))
  assert.equal(envelope.kind, 'synced-remote-exposure-observation'); assert.equal(envelope.version, 1)
  assert.equal(envelope.remote.manifestHash, hash(bytes)); assert.equal(envelope.remote.closureHash, value.closureHash)
  assert.deepEqual(envelope.incarnation, { groupId: original.groupId, creationId: original.creationId, createdAt: original.createdAt, origin: original.origin })
  const member = f.db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=?').get(envelope.persistence.attemptId) as Record<string, unknown>
  assert.equal(member.revision, original.revision); assert.equal(member.topology_revision, original.topologyRevision); assert.equal(member.semantic_hash, semantic)
  assert.equal((f.db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(envelope.persistence.attemptId) as { state: string }).state, 'confirmed')
  assert.deepEqual(invariantTables(f.db), preserved)
  for (const old of oldRows) assert.ok(rememberRows(f.db).some(row => encode(row) === encode(old)), 'Observation never rewrites an original operation ACK')
  contextUnavailable(f.db, f.createAck.historyToken, 'undo'); refusedRestore(f.db, undo); readOnlyRequests(f.server.requests.slice(start)); assertSyncedLifecycleSchema(f.db)
}))

test('retired observation preserves real retirement ordinary owners and first ACK while old and new Redo both refuse', () => withObservationFixture(async f => {
  const retired = restoreCreated(f.db, f.createAck, 'undo'), oldRedo = createRestoreInput(f.db, retired.ack, 'redo').input
  const originalTables = allTables(f.db), preserved = invariantTables(f.db), originalRows = rememberRows(f.db)
  await f.publish(); const value = requireObserved(await f.observe(f.open()))
  assert.deepEqual(value.groups[0], { groupId: f.createAck.createdLifecycle.groupId, creationId: f.createAck.createdLifecycle.creationId, outcome: 'retired-disabled', reused: false })
  const row = marker(f.db, key(f)), data = JSON.parse(row.result_json), anchor = f.db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(key(f)) as Record<string, unknown>
  assert.equal(data.persistence.anchorId, key(f)); assert.equal(data.local.state, 'retired-create')
  assert.equal(anchor.channel, 'webdav-manifest5-retired-observation-anchor'); assert.equal(anchor.state, 'possible'); assert.equal(anchor.confirmed_at, null)
  assert.equal(anchor.request_hash, row.request_hash); assert.equal(anchor.publication_hash, value.closureHash)
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_group_exposure_members').get() as { n: number }).n, 0)
  assert.deepEqual(invariantTables(f.db), preserved); assert.deepEqual(allTables(f.db).synced_group_lifecycle, originalTables.synced_group_lifecycle)
  for (const old of originalRows) assert.ok(rememberRows(f.db).some(row => encode(row) === encode(old)), 'Retired observation preserves all earlier exact ACK bytes')
  contextUnavailable(f.db, retired.ack.historyToken, 'redo'); refusedRestore(f.db, oldRedo); assertSyncedLifecycleSchema(f.db)
}))

test('a real Undo committed by the second connection during object HTTP is observed as retired in the final transaction', () => withObservationFixture(async f => {
  await f.publish(); const other = f.connect(), gate = f.gateGet(path => path.startsWith('/Publication/objects/')), observer = f.open(), job = f.observe(observer)
  try {
    await gate.wait(job); assert.equal(f.db.inTransaction, false); assert.equal(markerRows(other).length, 0)
    const retired = restoreCreated(other, f.createAck, 'undo'), oldRedo = createRestoreInput(other, retired.ack, 'redo').input
    gate.release(); const result = requireObserved(await job)
    assert.equal(result.groups[0].outcome, 'retired-disabled'); refusedRestore(other, oldRedo)
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('original create Undo and Redo ACK replays remain exact after retired observation but a new operation cannot reactivate', () => withObservationFixture(async f => {
  const firstUndo = restoreCreated(f.db, f.createAck, 'undo'), redo = restoreCreated(f.db, firstUndo.ack, 'redo'), lastUndo = restoreCreated(f.db, redo.ack, 'undo')
  const pending = createRestoreInput(f.db, lastUndo.ack, 'redo').input
  await f.publish(); requireObserved(await f.observe(f.open()))
  const before = allTables(f.db), changes = totalChanges(f.db)
  assert.deepEqual(applySyncedHostCommand(f.db, f.createInput), { ...f.createAck, replayed: true })
  for (const item of [firstUndo, redo, lastUndo]) assert.deepEqual(restoreSyncedHostOperation(f.db, item.input), { ...item.ack, replayed: true })
  assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes); refusedRestore(f.db, pending)
}))

test('the remote mutable canonical and CAS may differ while the member uses the unchanged actual local CAS and semantic hash', () => withObservationFixture(async f => {
  const groupId = f.createAck.createdLifecycle.groupId, local = snapshot(f.db, groupId), semantic = localHash(f.db, groupId), undo = createRestoreInput(f.db, f.createAck, 'undo').input
  editCreatedGroup(f.source.db, groupId); await f.publish()
  const portableHash = remoteManifest(f.server).entries['group:' + groupId]
  assert.notEqual(portableHash, semantic)
  requireObserved(await f.observe(f.open()))
  const row = marker(f.db, key(f)), data = JSON.parse(row.result_json), member = f.db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=?').get(data.persistence.attemptId) as Record<string, unknown>
  assert.equal(data.remote.groupHash, portableHash); assert.equal(member.revision, local.revision); assert.equal(member.topology_revision, local.topologyRevision); assert.equal(member.semantic_hash, semantic)
  refusedRestore(f.db, undo)
}))

test('the full closure hash is independently reconstructed from real manifest object and asset bytes with original aliases', () => withObservationFixture(async f => {
  const bytes = await f.publish(), expected = expectedClosure(f.server, f.actualAssets), value = requireObserved(await f.observe(f.open()))
  assert.equal(f.actualAssets.length, 1); assert.equal(value.manifestHash, hash(bytes)); assert.equal(value.closureHash, expected)
  assert.equal(JSON.parse(marker(f.db, key(f)).result_json).remote.closureHash, expected)
}, { asset: true }))

test('an active historical observation member survives real later canonical edits and repeated observation reuses its original CAS', () => withObservationFixture(async f => {
  await f.publish(); const observer = f.open(); requireObserved(await f.observe(observer))
  const original = marker(f.db, key(f)), members = exposureRows(f.db).members, oldRevision = snapshot(f.db, f.createAck.createdLifecycle.groupId).revision
  editCreatedGroup(f.db, f.createAck.createdLifecycle.groupId)
  assert.notEqual(snapshot(f.db, f.createAck.createdLifecycle.groupId).revision, oldRevision); assertSyncedLifecycleSchema(f.db)
  const before = allTables(f.db), repeated = requireObserved(await f.observe(observer))
  assert.equal(repeated.groups[0].reused, true); assert.deepEqual(marker(f.db, key(f)), original); assert.deepEqual(exposureRows(f.db).members, members); assert.deepEqual(allTables(f.db), before)
}))

test('a different remote workspace still exposes the matching immutable incarnation without borrowing local workspace authority', () => withObservationFixture(async f => {
  const oldScope = (f.db.prepare('SELECT workspace_scope FROM synced_workspace_state').get() as { workspace_scope: string }).workspace_scope
  f.db.prepare('UPDATE synced_workspace_state SET workspace_scope=?').run(randomUUID())
  const undo = createRestoreInput(f.db, f.createAck, 'undo').input
  await f.publish(); const result = requireObserved(await f.observe(f.open()))
  assert.equal(result.remoteWorkspaceId, oldScope); assert.notEqual(result.workspaceScope, result.remoteWorkspaceId); refusedRestore(f.db, undo)
}))

test('a complete foreign incarnation sharing only groupId creates no local proof and leaves a real local Undo usable', () => withObservationFixture(async f => {
  const foreign = f.outer.variant(27), input = createRequest(foreign.db, { groupId: f.createAck.createdLifecycle.groupId }), ack = created(applySyncedHostCommand(foreign.db, input))
  assert.notEqual(ack.createdLifecycle.creationId, f.createAck.createdLifecycle.creationId)
  const oldUndo = createRestoreInput(foreign.db, ack, 'undo').input, before = allTables(foreign.db)
  await f.publish(); const result = requireObserved(await f.observe(f.open(foreign)))
  assert.equal(result.groups.length, 0); assert.equal(result.ignoredRemoteGroups, 1); assert.deepEqual(allTables(foreign.db), before)
  assert.equal(created(restoreSyncedHostOperation(foreign.db, oldUndo)).createdLifecycle.state, 'retired-create')
}))

test('valid remote birth or Origin mismatches do not create a local marker or pending prohibition', async () => {
  for (const field of ['createdAt', 'origin'] as const) await withObservationFixture(async f => {
    const undo = createRestoreInput(f.db, f.createAck, 'undo').input
    await f.publish(); alterRemoteRecord(f.server, 'group:' + f.createAck.createdLifecycle.groupId, record => {
      if (field === 'createdAt') record.createdAt = '2001-02-03T04:05:06.000Z'
      else record.origin = { ...record.origin, pathAtCreation: 'Different original path' }
    })
    const checked = await readSyncedPublishedSnapshot(f.outer.client()); assert.equal(checked.status, 'ready')
    const before = allTables(f.db), result = requireObserved(await f.observe(f.open()))
    assert.equal(result.groups.length, 0); assert.equal(result.ignoredRemoteGroups, 1); assert.deepEqual(allTables(f.db), before)
    assert.equal(created(restoreSyncedHostOperation(f.db, undo)).createdLifecycle.state, 'retired-create')
  })
})

test('same proof and later remote deletion never overwrite the first exact retired observation or reopen inverse', () => withObservationFixture(async f => {
  const retired = restoreCreated(f.db, f.createAck, 'undo'), redo = createRestoreInput(f.db, retired.ack, 'redo').input
  await f.publish(); const observer = f.open(); requireObserved(await f.observe(observer))
  const before = allTables(f.db), changes = totalChanges(f.db), again = requireObserved(await f.observe(observer))
  assert.equal(again.groups[0].reused, true); assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes)
  f.server.files.delete(manifestPath); const missing = await f.observe(observer); assert.deepEqual(missing, { status: 'missing' }); assert.ok(Object.isFrozen(missing), 'Missing is an immutable diagnostic result rather than mutable authority')
  assert.deepEqual(allTables(f.db), before); refusedRestore(f.db, redo)
}))

test('readonly metadata HEAD and PROPFIND are the only fallback requests and the ordinary reader stays SQL free', async () => {
  for (const metadata of ['HEAD', 'PROPFIND'] as const) await withObservationFixture(async f => {
    await f.publish(); f.server.setOptions({ omitGetEtag: true, omitHeadEtag: metadata === 'PROPFIND' })
    const before = allTables(f.db), changes = totalChanges(f.db), start = f.server.requests.length
    const read = await readSyncedPublishedSnapshot(f.outer.client()); assert.equal(read.status, 'ready')
    assert.deepEqual(allTables(f.db), before); assert.equal(totalChanges(f.db), changes)
    requireObserved(await f.observe(f.open())); const requests = f.server.requests.slice(start)
    assert.ok(requests.some(request => request.method === metadata), 'The actual observer reaches the selected readonly metadata branch'); readOnlyRequests(requests)
  })
})

test('bad object or asset bytes and partial closures cannot create any observation or steal real Undo eligibility', async () => {
  for (const damage of ['object-hash', 'missing-object', 'asset-hash', 'missing-asset'] as const) await withObservationFixture(async f => {
    await f.publish(); const undo = createRestoreInput(f.db, f.createAck, 'undo').input
    const path = damage.includes('asset') ? [...f.server.files.keys()].find(path => /^\/Publication\/assets\/[a-f0-9]{64}$/.test(path)) : '/Publication/objects/' + remoteManifest(f.server).entries['group:' + f.createAck.createdLifecycle.groupId] + '.json'
    assert.ok(path, 'The damaged required record or asset comes from the actual sender')
    if (damage.startsWith('missing')) f.server.files.delete(path); else f.server.files.set(path, Buffer.from('wrong actual bytes'))
    const before = allTables(f.db); await rejectedCode(() => f.observe(f.open()), 'invalid')
    assert.deepEqual(allTables(f.db), before); assert.equal(created(restoreSyncedHostOperation(f.db, undo)).createdLifecycle.state, 'retired-create')
  }, { asset: true })
})

test('noncanonical Manifest5 and unsupported version4 are distinct refusals with no completed proof', async () => {
  for (const kind of ['noncanonical5', 'version4'] as const) await withObservationFixture(async f => {
    await f.publish(); const original = remoteManifest(f.server), observer = f.open(), before = allTables(f.db), undo = createRestoreInput(f.db, f.createAck, 'undo').input
    f.server.files.set(manifestPath, Buffer.from(kind === 'version4' ? ' { "version":4,"workspaceId":"old_workspace","entries":{} }\n' : JSON.stringify(original, null, 2)))
    if (kind === 'version4') { const unsupported = await f.observe(observer); assert.deepEqual(unsupported, { status: 'unsupported', reason: 'initial-snapshot-only' }); assert.ok(Object.isFrozen(unsupported), 'Unsupported historical format results are readonly diagnostics') }
    else await rejectedCode(() => f.observe(observer), 'invalid')
    assert.deepEqual(allTables(f.db), before); assert.equal(created(restoreSyncedHostOperation(f.db, undo)).createdLifecycle.state, 'retired-create')
  })
})

test('a real late confirmation SQL failure rolls back every table and blocks both original and second-connection Undo', () => withObservationFixture(async f => {
  await f.publish(); const undo = createRestoreInput(f.db, f.createAck, 'undo').input, other = f.connect(), seen = installLateFailure(f.db), before = allTables(f.db)
  const error = await rejectedCode(() => f.observe(f.open()), 'database')
  assert.ok(error.cause, 'The database error keeps the actual SQLite late-failure cause')
  assert.ok(seen.length === 1 && seen[0].members > 0, 'The trigger observes actual member inserts before the late confirmation failure rolls everything back')
  assert.deepEqual(allTables(f.db), before); contextUnavailable(f.db, f.createAck.historyToken, 'undo'); contextUnavailable(other, f.createAck.historyToken, 'undo')
  refusedRestore(f.db, undo); refusedRestore(other, undo)
  f.db.exec('DROP TRIGGER observation_late_failure')
  const start = f.server.requests.length, result = retrySyncedRemoteObservationCommit(f.open())
  assert.equal(result.status, 'committed'); assert.equal(f.server.requests.length, start); assertSyncedLifecycleSchema(f.db)
  assert.ok(Object.isFrozen(result), 'A synchronous retry returns an immutable result shell')
  if (result.status === 'committed') assert.ok(Object.isFrozen(result.groups) && result.groups.every(group => Object.isFrozen(group)), 'The retry group list and each reused or new group entry are deeply readonly')
}))

test('mixed actual active and retired groups roll back together and retry commits both independent observation forms', () => withObservationFixture(async f => {
  const second = f.second; assert.ok(second, 'The mixed fixture contains a second real create committed before the database clone')
  if (!second) throw new Error('Two actual created groups are required')
  const undo = createRestoreInput(f.db, f.createAck, 'undo').input, retired = restoreCreated(f.db, second.ack, 'undo'), redo = createRestoreInput(f.db, retired.ack, 'redo').input
  await f.publish(); const before = allTables(f.db), seen: number[] = []
  f.db.function('retired_anchor_fixture', (anchors: number) => { seen.push(anchors); return 0 })
  f.db.exec("CREATE TRIGGER observation_retired_failure AFTER INSERT ON synced_exposure_attempts WHEN NEW.channel='webdav-manifest5-retired-observation-anchor' BEGIN SELECT retired_anchor_fixture((SELECT count(*) FROM synced_exposure_attempts WHERE channel='webdav-manifest5-retired-observation-anchor')); SELECT RAISE(ABORT,'remote retired anchor late fixture'); END;")
  await rejectedCode(() => f.observe(f.open()), 'database'); assert.deepEqual(seen, [1]); assert.deepEqual(allTables(f.db), before)
  const other = f.connect(); refusedRestore(other, undo); refusedRestore(other, redo)
  f.db.exec('DROP TRIGGER observation_retired_failure'); const start = f.server.requests.length, result = retrySyncedRemoteObservationCommit(f.open())
  assert.ok(result.status === 'committed', 'The genuine synchronous retry consumes the mixed original proof')
  if (result.status !== 'committed') throw new Error('A mixed proof must commit')
  assert.deepEqual(result.groups.map(group => group.outcome).sort(), ['active-confirmed', 'retired-disabled']); assert.equal(f.server.requests.length, start); assertSyncedLifecycleSchema(f.db)
}, { secondCreate: true }))

test('two failed real targets retain independent pending shares and later retry never overwrites the first completed fact', () => withObservationFixture(async f => {
  await f.publish(); const secondTarget = { ...f.target, directory: 'SecondObservation' }
  for (const [path, bytes] of [...f.server.files]) if (path.startsWith('/Publication/')) f.server.files.set('/SecondObservation/' + path.slice('/Publication/'.length), Buffer.from(bytes))
  const first = f.open(), second = f.open(f.replica, secondTarget); installLateFailure(f.db)
  await rejectedCode(() => f.observe(first), 'database'); await rejectedCode(() => f.observe(second), 'database'); assert.equal(markerRows(f.db).length, 0)
  f.db.exec('DROP TRIGGER observation_late_failure'); const start = f.server.requests.length, committed = retrySyncedRemoteObservationCommit(first)
  assert.ok(committed.status === 'committed', 'The first target retains and commits its own actual pending proof')
  if (committed.status !== 'committed') throw new Error('The first real proof must commit')
  assert.equal(committed.proofs, 1); const original = marker(f.db, key(f)), reused = retrySyncedRemoteObservationCommit(second)
  assert.ok(reused.status === 'committed', 'The other target still retains a separate pending share after the first retry')
  if (reused.status !== 'committed') throw new Error('The second proof must still have its own settlement')
  assert.equal(reused.proofs, 1); assert.equal(reused.groups[0].reused, true); assert.deepEqual(marker(f.db, key(f)), original)
  assert.deepEqual(retrySyncedRemoteObservationCommit(first), { status: 'no-pending' }); assert.deepEqual(retrySyncedRemoteObservationCommit(second), { status: 'no-pending' }); assert.equal(f.server.requests.length, start)
}))

test('a real orphan active group is observed even though no current host instance references it', () => withObservationFixture(async f => {
  assert.equal(snapshot(f.db, f.createAck.createdLifecycle.groupId).instances.length, 0)
  await f.publish(); const result = requireObserved(await f.observe(f.open()))
  assert.equal(result.groups.length, 1); assert.equal(result.groups[0].outcome, 'active-confirmed')
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_group_exposure_members WHERE group_id=?').get(f.createAck.createdLifecycle.groupId) as { n: number }).n, 1)
}, { orphan: true }))

test('changing the remote manifest after its GET does not replace the exact original complete closure proof', () => withObservationFixture(async f => {
  const originalBytes = await f.publish(), oldManifest = remoteManifest(f.server), gate = f.gateGet(path => path.startsWith('/Publication/objects/')), observer = f.open(), job = f.observe(observer)
  try {
    await gate.wait(job); const later = { ...oldManifest, workspaceId: randomUUID() }; f.server.files.set(manifestPath, Buffer.from(encode(later))); gate.release()
    const result = requireObserved(await job); assert.equal(result.manifestHash, hash(originalBytes)); assert.equal(result.remoteWorkspaceId, oldManifest.workspaceId)
    assert.notEqual(hash(f.server.files.get(manifestPath)!), result.manifestHash)
    const original = marker(f.db, key(f)); f.server.files.delete(manifestPath); contextUnavailable(f.db, f.createAck.historyToken, 'undo'); assert.deepEqual(marker(f.db, key(f)), original)
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('closing the failed connection and disposing its handle cannot erase pending and real new-connection retry settles it', () => withObservationFixture(async f => {
  await f.publish(); const undo = createRestoreInput(f.db, f.createAck, 'undo').input, observer = f.open()
  installLateFailure(f.db); await rejectedCode(() => f.observe(observer), 'database')
  assert.equal(disposeSyncedRemoteObservation(observer), true); f.reopen(); contextUnavailable(f.db, f.createAck.historyToken, 'undo'); refusedRestore(f.db, undo)
  f.db.exec('DROP TRIGGER observation_late_failure'); const next = f.open(), start = f.server.requests.length
  const result = retrySyncedRemoteObservationCommit(next); assert.equal(result.status, 'committed'); const noPending = retrySyncedRemoteObservationCommit(next); assert.deepEqual(noPending, { status: 'no-pending' }); assert.ok(Object.isFrozen(noPending), 'No-pending is an immutable diagnostic result')
  assert.equal(f.server.requests.length, start); assert.equal(markerRows(f.db).length, 1); contextUnavailable(f.db, f.createAck.historyToken, 'undo')
}))

test('pending belongs to the actual file and does not forbid a genuine same-incarnation Undo in another file', () => withObservationFixture(async f => {
  const independent = await f.clone(), undo = createRestoreInput(independent.db, f.createAck, 'undo').input
  await f.publish(); installLateFailure(f.db); await rejectedCode(() => f.observe(f.open()), 'database')
  assert.equal(created(restoreSyncedHostOperation(independent.db, undo)).createdLifecycle.state, 'retired-create')
  f.db.exec('DROP TRIGGER observation_late_failure'); assert.equal(retrySyncedRemoteObservationCommit(f.open()).status, 'committed')
}))

test('an epoch change during HTTP never grants old proof new write authority while sticky pending still blocks inverse', () => withObservationFixture(async f => {
  await f.publish(); const undo = createRestoreInput(f.db, f.createAck, 'undo').input, other = f.connect(), gate = f.gateGet(path => path.startsWith('/Publication/objects/')), observer = f.open(), job = f.observe(observer)
  try {
    await gate.wait(job); other.prepare('UPDATE synced_workspace_state SET recovery_epoch=?').run(randomUUID()); gate.release()
    await rejectedCode(() => job, 'unavailable'); assert.equal(markerRows(other).length, 0)
    contextUnavailable(other, f.createAck.historyToken, 'undo'); refusedRestore(other, undo)
    await rejectedCode(() => retrySyncedRemoteObservationCommit(f.open()), 'unavailable')
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('a durable retired fact remains authoritative after an epoch change and actual connection reopen', () => withObservationFixture(async f => {
  const retired = restoreCreated(f.db, f.createAck, 'undo'), redo = createRestoreInput(f.db, retired.ack, 'redo').input
  await f.publish(); requireObserved(await f.observe(f.open())); const original = marker(f.db, key(f))
  f.db.prepare('UPDATE synced_workspace_state SET recovery_epoch=?').run(randomUUID()); f.reopen()
  assertSyncedLifecycleSchema(f.db); assert.deepEqual(marker(f.db, key(f)), original); contextUnavailable(f.db, retired.ack.historyToken, 'redo'); refusedRestore(f.db, redo)
}))

test('a real current-source child reopening the committed retired database cannot recover fresh Redo authority', async t => withObservationFixture(async f => {
  const retired = restoreCreated(f.db, f.createAck, 'undo'), redo = createRestoreInput(f.db, retired.ack, 'redo').input
  await f.publish(); requireObserved(await f.observe(f.open()))
  const result = await f.childReopen(redo)
  assert.ok(typeof result.pid === 'number' && result.pid > 0, 'The reopen oracle is a real isolated child process with an actual PID')
  assert.equal(result.report.status, 'passed'); assert.equal(result.report.beforeHash, result.report.afterHash)
  t.diagnostic(JSON.stringify({ kind: 'current-source-reopen-child', ...result }))
}))

test('a preaborted or incomplete network job has no proof and no pending inverse prohibition', () => withObservationFixture(async f => {
  await f.publish(); const undo = createRestoreInput(f.db, f.createAck, 'undo').input, before = allTables(f.db), observer = f.open(), abort = new AbortController(), start = f.server.requests.length
  abort.abort(); await rejectedCode(() => f.observe(observer, abort.signal), 'transport')
  assert.deepEqual(allTables(f.db), before); assert.equal(f.server.requests.length, start); assert.deepEqual(retrySyncedRemoteObservationCommit(observer), { status: 'no-pending' })
  assert.equal(created(restoreSyncedHostOperation(f.db, undo)).createdLifecycle.state, 'retired-create')
}))

test('cancellation during the real required asset GET cannot mint a complete observation or a pending inverse prohibition', () => withObservationFixture(async f => {
  await f.publish(); const undo = createRestoreInput(f.db, f.createAck, 'undo').input, before = allTables(f.db), observer = f.open(), abort = new AbortController()
  const gate = f.gateGet(path => /^\/Publication\/assets\/[a-f0-9]{64}$/.test(path)), job = f.observe(observer, abort.signal)
  try {
    await gate.wait(job); abort.abort(); gate.release(); await rejectedCode(() => job, 'transport')
    assert.deepEqual(allTables(f.db), before); assert.deepEqual(retrySyncedRemoteObservationCommit(observer), { status: 'no-pending' })
    assert.equal(created(restoreSyncedHostOperation(f.db, undo)).createdLifecycle.state, 'retired-create')
  } finally { gate.release(); await Promise.allSettled([job]) }
}, { asset: true }))

test('dispose and abort after real closure completion cannot skip an already accepted safe commit', () => withObservationFixture(async f => {
  await f.publish(); const observer = f.open(), abort = new AbortController(), events: number[] = []
  f.db.function('observation_dispose_fixture', () => { events.push(1); disposeSyncedRemoteObservation(observer); abort.abort(); return 0 })
  f.db.exec("CREATE TRIGGER observation_dispose_after_closure BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id LIKE 'synced:remote-exposure-observation:v1:%' BEGIN SELECT observation_dispose_fixture(); END;")
  const result = requireObserved(await f.observe(observer, abort.signal)); assert.equal(result.groups.length, 1); assert.deepEqual(events, [1])
  assert.equal(markerRows(f.db).length, 1); contextUnavailable(f.db, f.createAck.historyToken, 'undo')
  await rejectedCode(() => f.observe(observer), 'unavailable')
}))

test('the actual busy observer refuses reentry and disposal prevents new calls without cancelling its accepted HTTP job', () => withObservationFixture(async f => {
  await f.publish(); const observer = f.open(), gate = f.gateGet(path => path.startsWith('/Publication/objects/')), job = f.observe(observer)
  try {
    await gate.wait(job); await rejectedCode(() => f.observe(observer), 'unavailable'); await rejectedCode(() => retrySyncedRemoteObservationCommit(observer), 'unavailable')
    assert.equal(disposeSyncedRemoteObservation(observer), true); assert.equal(disposeSyncedRemoteObservation(observer), false)
    gate.release(); assert.equal(requireObserved(await job).groups.length, 1)
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('opaque handles and caller facts cannot authorize observation and invalid entry connections fail before HTTP', () => withObservationFixture(async f => {
  await f.publish(); const before = allTables(f.db), start = f.server.requests.length
  await rejectedCode(() => observeSyncedRemoteExposure({ kind: 'synced-remote-observation' } as never, runtime), 'unavailable')
  const read = await readSyncedPublishedSnapshot(f.outer.client()); assert.ok(read.status === 'ready', 'The caller obtains genuine readonly remote facts without database authority')
  if (read.status !== 'ready') throw new Error('A real readonly plan is required')
  const publicFacts = readSyncedPublishedSnapshotFacts(read.plan)
  await rejectedCode(() => observeSyncedRemoteExposure(publicFacts as never, runtime), 'unavailable')
  assert.deepEqual(allTables(f.db), before); const noHttpStart = f.server.requests.length
  const readonly = new Database(f.file, { readonly: true, fileMustExist: true }); readonly.pragma('foreign_keys=ON')
  try { await rejectedCode(() => openSyncedRemoteObservation(readonly, { userDataRoot: f.userDataRoot, target: f.target }), 'unavailable') } finally { readonly.close() }
  f.db.pragma('foreign_keys=OFF'); await rejectedCode(() => openSyncedRemoteObservation(f.db, { userDataRoot: f.userDataRoot, target: f.target }), 'invalid'); f.db.pragma('foreign_keys=ON')
  f.db.exec('BEGIN IMMEDIATE'); try { await rejectedCode(() => openSyncedRemoteObservation(f.db, { userDataRoot: f.userDataRoot, target: f.target }), 'invalid') } finally { f.db.exec('ROLLBACK') }
  await rejectedCode(() => openSyncedRemoteObservation(f.db, { userDataRoot: f.userDataRoot + '-wrong', target: f.target }), 'unavailable')
  const old = f.outer.variant(26); assert.deepEqual(openSyncedRemoteObservation(old.db, { userDataRoot: old.userDataRoot, target: f.target }), { status: 'unsupported', reason: 'schema-27-required' })
  assert.equal(f.server.requests.length, noHttpStart); assert.ok(start < noHttpStart, 'Only the explicitly requested readonly reader made HTTP calls')
}))

test('open and post-HTTP commit require every original schema27 guard and a failed current check keeps pending until real retry', async () => {
  for (const phase of ['open', 'current'] as const) await withObservationFixture(async f => {
    const name = 'trg_synced_exposure_attempt_delete', original = f.db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', name) as { sql: string }
    assert.ok(original && original.sql, 'The fixture starts with the actual schema27 immutable-attempt delete guard')
    const undo = createRestoreInput(f.db, f.createAck, 'undo').input, before = allTables(f.db)
    await f.publish()
    if (phase === 'open') {
      const start = f.server.requests.length; f.db.exec('DROP TRIGGER ' + name)
      try { await rejectedCode(() => openSyncedRemoteObservation(f.db, { userDataRoot: f.userDataRoot, target: f.target }), 'invalid'); assert.equal(f.server.requests.length, start); assert.deepEqual(allTables(f.db), before) }
      finally { f.db.exec(original.sql) }
      assert.equal(created(restoreSyncedHostOperation(f.db, undo)).createdLifecycle.state, 'retired-create')
    } else {
      const other = f.connect(), observer = f.open(), gate = f.gateGet(path => path.startsWith('/Publication/objects/')), job = f.observe(observer); let dropped = false
      try {
        await gate.wait(job); other.exec('DROP TRIGGER ' + name); dropped = true; gate.release(); await rejectedCode(() => job, 'invalid')
        assert.deepEqual(allTables(f.db), before); assert.equal(markerRows(other).length, 0)
      } finally { gate.release(); await Promise.allSettled([job]); if (dropped) other.exec(original.sql) }
      contextUnavailable(other, f.createAck.historyToken, 'undo'); refusedRestore(other, undo)
      const start = f.server.requests.length; assert.equal(retrySyncedRemoteObservationCommit(observer).status, 'committed'); assert.equal(f.server.requests.length, start)
    }
    assert.equal((f.db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', name) as { sql: string }).sql, original.sql)
  })
})

test('removing a real retired marker leaves its immutable anchor and both schema and new inverse fail closed without repair', () => withObservationFixture(async f => {
  const retired = restoreCreated(f.db, f.createAck, 'undo'), redo = createRestoreInput(f.db, retired.ack, 'redo').input
  await f.publish(); requireObserved(await f.observe(f.open()))
  assert.equal(f.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(key(f)).changes, 1)
  const before = allTables(f.db); assert.throws(() => assertSyncedLifecycleSchema(f.db)); assert.throws(() => getSyncedCreateRestoreContext(f.db, { historyToken: retired.ack.historyToken, direction: 'redo' }))
  assert.throws(() => restoreSyncedHostOperation(f.db, { ...redo, clientOperationId: randomUUID() })); assert.deepEqual(allTables(f.db), before)
  assert.throws(() => f.db.prepare('DELETE FROM synced_exposure_attempts WHERE id=?').run(key(f)))
}))

test('a marker without its paired anchor is rejected by the reverse schema check and real create context', () => withObservationFixture(async f => {
  const retired = restoreCreated(f.db, f.createAck, 'undo'), clean = await f.clone()
  await f.publish(); requireObserved(await f.observe(f.open())); const original = marker(f.db, key(f))
  clean.db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)').run(original.client_operation_id, original.request_hash, original.result_json, original.created_at)
  const before = allTables(clean.db); assert.throws(() => assertSyncedLifecycleSchema(clean.db)); assert.throws(() => getSyncedCreateRestoreContext(clean.db, { historyToken: retired.ack.historyToken, direction: 'redo' })); assert.deepEqual(allTables(clean.db), before)
}))

test('closed marker field corruption cannot turn stable lookup into missing or rewrite the first immutable anchor', async () => {
  for (const field of ['kind', 'request', 'tuple', 'closure', 'extra'] as const) await withObservationFixture(async f => {
    const retired = restoreCreated(f.db, f.createAck, 'undo'); await f.publish(); requireObserved(await f.observe(f.open()))
    const row = marker(f.db, key(f)), data = JSON.parse(row.result_json)
    if (field === 'request') f.db.prepare('UPDATE synced_operations SET request_hash=? WHERE client_operation_id=?').run('0'.repeat(64), key(f))
    else { if (field === 'kind') data.kind = 'synced-group'; if (field === 'tuple') data.incarnation.origin.pathAtCreation += ' altered'; if (field === 'closure') data.remote.closureHash = '0'.repeat(64); if (field === 'extra') data.extra = true
      f.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(data), key(f)) }
    const before = allTables(f.db); assert.throws(() => assertSyncedLifecycleSchema(f.db)); assert.throws(() => getSyncedCreateRestoreContext(f.db, { historyToken: retired.ack.historyToken, direction: 'redo' })); assert.deepEqual(allTables(f.db), before)
  })
})

test('recomputed marker and anchor hashes cannot legitimize a retired local CAS or semantic hash that disagrees with real retirement', async () => {
  for (const field of ['revision', 'topologyRevision', 'semanticHash'] as const) await withObservationFixture(async f => {
    const retired = restoreCreated(f.db, f.createAck, 'undo'), clean = await f.clone(), redo = createRestoreInput(clean.db, retired.ack, 'redo').input
    await f.publish(); requireObserved(await f.observe(f.open())); const row = marker(f.db, key(f)), data = JSON.parse(row.result_json)
    data.local[field] = field === 'semanticHash' ? '0'.repeat(64) : randomUUID()
    const requestHash = hash(encode({ method: 'observeSyncedRemoteExposure', proof: data }))
    clean.db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)').run(row.client_operation_id, requestHash, encode(data), row.created_at)
    const anchor = f.db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(key(f)) as { id: string; channel: string; target_fingerprint: string; publication_hash: string; state: string; created_at: string; confirmed_at: string | null }
    clean.db.prepare('INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(anchor.id, requestHash, anchor.channel, anchor.target_fingerprint, anchor.publication_hash, anchor.state, anchor.created_at, anchor.confirmed_at)
    const before = allTables(clean.db)
    assert.throws(() => assertSyncedLifecycleSchema(clean.db)); assert.throws(() => getSyncedCreateRestoreContext(clean.db, { historyToken: retired.ack.historyToken, direction: 'redo' }))
    assert.throws(() => restoreSyncedHostOperation(clean.db, { ...redo, clientOperationId: randomUUID() })); assert.deepEqual(allTables(clean.db), before)
  })
})

test('ordinary in-memory create Undo and Redo remain usable without any disk observation or pending proof', async () => {
  const { initialize, ordinary, now, host, other } = await import('./helpers/synced-content-fixture')
  const { installSyncedLifecycleSchema } = await import('../src/main/database/synced-lifecycle-schema')
  const db = new Database(':memory:')
  try {
    initialize(db)
    for (const [index, id] of [host, other].entries()) {
      db.prepare('UPDATE documents SET title=?,path=?,summary=? WHERE id=?').run('Memory Host ' + index, 'Memory/Host ' + index, '', id)
      ordinary(db, bodyId(id), { owner: id, type: 'paragraph', sort: id === host ? 1 : 0 })
    }
    db.prepare("UPDATE blocks SET tags_json='[]'").run()
    db.pragma('user_version=26')
    db.transaction(() => { installSyncedLifecycleSchema(db, now); db.pragma('user_version=27') })()
    const f = { createAck: created(applySyncedHostCommand(db, createRequest(db))) }
    const undo = restoreCreated(db, f.createAck, 'undo'), redo = restoreCreated(db, undo.ack, 'redo')
    assert.equal(undo.ack.createdLifecycle.state, 'retired-create'); assert.equal(redo.ack.createdLifecycle.state, 'active')
    assert.equal(markerRows(db).length, 0); assert.equal(exposureRows(db).attempts.length, 0); assertSyncedLifecycleSchema(db)
  } finally { db.close() }
})

test('active observed marker deletion is rejected even though its confirmed exposure alone already blocks Undo', () => withObservationFixture(async f => {
  await f.publish(); requireObserved(await f.observe(f.open())); f.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(key(f))
  const before = allTables(f.db); assert.throws(() => assertSyncedLifecycleSchema(f.db)); assert.throws(() => getSyncedCreateRestoreContext(f.db, { historyToken: f.createAck.historyToken, direction: 'undo' })); assert.deepEqual(allTables(f.db), before)
}))

test('a valid active marker cannot justify an additional zero-member retired-channel anchor at its stable key', () => withObservationFixture(async f => {
  await f.publish(); requireObserved(await f.observe(f.open())); assertSyncedLifecycleSchema(f.db)
  const row = marker(f.db, key(f)), data = JSON.parse(row.result_json)
  assert.equal(data.persistence.kind, 'active-confirmed'); assert.notEqual(data.persistence.attemptId, key(f))
  f.db.prepare("INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,?,?,?,'possible',?,NULL)")
    .run(key(f), row.request_hash, 'webdav-manifest5-retired-observation-anchor', data.remote.targetFingerprint, data.remote.closureHash, row.created_at)
  const before = allTables(f.db), start = f.server.requests.length
  assert.throws(() => assertSyncedLifecycleSchema(f.db)); await rejectedCode(() => openSyncedRemoteObservation(f.db, { userDataRoot: f.userDataRoot, target: f.target }), 'invalid')
  assert.equal(f.server.requests.length, start); assert.deepEqual(allTables(f.db), before)
}))

test('the reserved marker namespace never becomes a public UUID ACK or a group owned source ticket', () => withObservationFixture(async f => {
  await f.publish(); const owner = captureSyncedBaselineOwner(f.db, { groupId: f.createAck.createdLifecycle.groupId })
  assert.ok(owner.status === 'ready', 'A genuine Main owner exists before testing that the observation envelope cannot sign group sources')
  if (owner.status !== 'ready') throw new Error('A real Main owner is required')
  try {
    requireObserved(await f.observe(f.open())); const row = marker(f.db, key(f)), fakeOperation = randomUUID()
    assert.throws(() => getSyncedOperation(f.db, { clientOperationId: key(f) }))
    assert.throws(() => decodeSyncedOperationAck({ ...row, client_operation_id: fakeOperation }))
    assert.throws(() => decodeSyncedGroupOperationAck({ ...row, client_operation_id: fakeOperation }))
    f.db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)').run(fakeOperation, row.request_hash, row.result_json, row.created_at)
    const before = allTables(f.db); assert.throws(() => getSyncedOperation(f.db, { clientOperationId: fakeOperation })); assert.throws(() => getSyncedOperationWithOwnedLinkSource(f.db, { readOwnerId: owner.readOwnerId, clientOperationId: fakeOperation })); assert.deepEqual(allTables(f.db), before)
  } finally { releaseSyncedReadOwner(f.db, { readOwnerId: owner.readOwnerId }) }
}))

test('a plain zero-member publication remains corruption and cannot use the finite retired anchor exception', () => withObservationFixture(async f => {
  f.db.prepare("INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,?,?,?,'possible',?,NULL)")
    .run(randomUUID(), '1'.repeat(64), 'webdav-initial', '2'.repeat(64), '3'.repeat(64), '2026-10-16T00:00:00.000Z')
  const before = allTables(f.db); assert.throws(() => assertSyncedLifecycleSchema(f.db)); assert.deepEqual(allTables(f.db), before)
}))
