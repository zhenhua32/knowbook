import assert from 'node:assert/strict'
import test from 'node:test'
import { getSyncedOperation, updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { getSyncedCreateRestoreContext, restoreSyncedHostOperation } from '../src/main/database/synced-host-final'
import { captureSyncedBaselineOwner, validateSyncedReadOwner, releaseSyncedReadOwner, getSyncedGroupSnapshotsWithLinkSources } from '../src/main/database/synced-binding-sources'
import { BlockIdentityRepository } from '../src/main/database/block-identities'
import { restoreInput } from './helpers/synced-host-final-fixture'
import { withTombstones, completed, randomUUID, encode, allTables, deleteGroup, deleteDocument, document,
  missingGroup, assertAbsentKnowledge, snapshot, insertCommand, applySyncedHostCommand, request, applySyncedHostFinal,
  readStrictHostDocument, hostEdit, liveKnowledge, denied, rawGroup, rejected } from './helpers/synced-exchange-tombstone-fixture'

function noCurrentAuthority(action: () => unknown) {
  let result: unknown, failure: unknown
  try { result = action() } catch (error) { failure = error }
  if (!failure) denied(result)
}

test('actual cached insert and host-final reference requests cannot attach an effectively deleted G even though its raw active identity survives', () => withTombstones(async f => {
  const cached = insertCommand(f.B.db, { documentId: f.islands[0], groupId: f.orphanId }), old = snapshot(f.B.db, f.orphanId)
  const host = request(f.B.db, [f.islands[0]], sides => { sides[0].blocks.push({ id: randomUUID(), type: 'synced-block', content: encode({ version: 1, groupId: f.orphanId }), checked: false, depth: 0, parentBlockId: null, tags: [] }) })
  host.groups.push({ groupId: old.groupId, expectedRevision: old.revision, expectedTopologyRevision: old.topologyRevision })
  f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
  const before = liveKnowledge(f.B.db), fresh = rawGroup(f.B.db, f.orphanId)
  noCurrentAuthority(() => applySyncedHostCommand(f.B.db, cached))
  noCurrentAuthority(() => applySyncedHostCommand(f.B.db, { ...cached, clientOperationId: randomUUID(), groups: [{ groupId: old.groupId, expectedRevision: fresh.revision, expectedTopologyRevision: fresh.topology_revision }] }))
  noCurrentAuthority(() => applySyncedHostFinal(f.B.db, host))
  assert.deepEqual(liveKnowledge(f.B.db), before); missingGroup(f.B.db, f.orphanId)
  assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId)
}))

test('actual original host ACK remains immutable after remote document deletion while its exact-tail Undo cannot resurrect the deleted owner', () => withTombstones(async f => {
  const childId = readStrictHostDocument(f.B.db, f.islands[0]).detail.blocks[0].id
  const input = { ...request(f.B.db, [f.islands[0]]), clientOperationId: randomUUID() }
  // Use an actual ordinary edit ACK as a historical fact; the source create's ACK is not imported.
  input.finalAfter[0].blocks[0].content = 'B exact ordinary ACK before shared deletion baseline'
  const ack = applySyncedHostFinal(f.B.db, input)
  assert.ok(ack.status === 'applied' && ack.historyToken, 'The real local Main edit produces an executable immutable exact ACK')
  if (ack.status !== 'applied') throw new Error('Expected an actual local applied ACK')
  completed(await f.exchange(), 'applied'); completed(await f.exchange(f.A), 'applied')
  const oldRow = f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId)
  const restore = restoreInput(f.B.db, ack, 'undo')
  f.remoteFinal(records => { deleteDocument(records, f.islands[0]) }); completed(await f.exchange(), 'applied')
  const before = liveKnowledge(f.B.db)
  assert.deepEqual(applySyncedHostFinal(f.B.db, input), { ...ack, replayed: true })
  assert.deepEqual(getSyncedOperation(f.B.db, { clientOperationId: input.clientOperationId }), { status: 'committed', result: { ...ack, replayed: true } })
  noCurrentAuthority(() => restoreSyncedHostOperation(f.B.db, restore))
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId), oldRow)
  assert.deepEqual(liveKnowledge(f.B.db), before); assert.equal(new BlockIdentityRepository(f.B.db).resolveLiveOwner(childId), null)
}))

test('actual document deletion does not rewrite another group historical target hints or Source binding facts into a new target', () => withTombstones(async f => {
  const before = snapshot(f.B.db, f.groupId), targetBindings = before.bindings.filter(binding => binding.target.kind === 'document' && binding.target.id === f.target)
  assert.ok(targetBindings.length > 0, 'The real source group has an actual persisted link to the document to be deleted')
  const source = getSyncedGroupSnapshotsWithLinkSources(f.B.db, { groupIds: [f.groupId] })
  assert.equal(source.items[0].status, 'ready')
  f.remoteFinal(records => { deleteDocument(records, f.target) }); completed(await f.exchange(), 'applied')
  const after = snapshot(f.B.db, f.groupId)
  assert.deepEqual(after.bindings, before.bindings, 'Historical binding state and hints remain exact original facts instead of being rehydrated from current paths')
  assert.equal(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(f.target), undefined)
  assertAbsentKnowledge(f.B.db, 'doc:' + f.target)
  assert.deepEqual(after.blocks, before.blocks)
}))

test('actual held baseline read owner stays a historical fact but new capture and all fresh canonical writes to deleted G are denied', () => withTombstones(async f => {
  const old = snapshot(f.B.db, f.orphanId), owner = captureSyncedBaselineOwner(f.B.db, { groupId: f.orphanId })
  assert.equal(owner.status, 'ready'); assert.ok(owner.status === 'ready', 'A real pre-deletion Main read owner is captured from the original actual snapshot')
  f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
  try {
    assert.equal(captureSyncedBaselineOwner(f.B.db, { groupId: f.orphanId }).status, 'missing')
    // Immutable incarnation survives: validating an old read fact is not a new writer lease.
    assert.equal(validateSyncedReadOwner(f.B.db, { readOwnerId: owner.readOwnerId }).status, 'ready')
    const fresh = rawGroup(f.B.db, f.orphanId), before = liveKnowledge(f.B.db)
    noCurrentAuthority(() => updateSyncedBlockGroup(f.B.db, { clientOperationId: randomUUID(), groupId: old.groupId,
      expectedRevision: fresh.revision, expectedTopologyRevision: fresh.topology_revision,
      expectedInstanceBinding: { instanceId: old.origin.firstInstanceId, hostDocumentId: old.origin.documentId, bindingVersion: randomUUID() },
      blocks: old.blocks.map(({ createdAt: _birth, ...block }) => block) }))
    assert.deepEqual(liveKnowledge(f.B.db), before)
  } finally { releaseSyncedReadOwner(f.B.db, { readOwnerId: owner.readOwnerId }) }
}))

test('actual accepted tombstone cannot be undone by a same-incarnation live object at the same target or by a different remote target', () => withTombstones(async f => {
  const old = f.remote().records.get('group:' + f.orphanId)
  assert.ok(old?.kind === 'synced-group', 'The future resurrection negative retains the actual original same-incarnation live wire')
  f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
  const proof = assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId), before = liveKnowledge(f.B.db)
  f.remoteFinal(records => { records.set('group:' + f.orphanId, old) })
  const result = completed(await f.exchange())
  assert.ok(result.deferred.some(c => c.keys.includes('group:' + f.orphanId)), 'A durable deleted incarnation is not silently reinserted as a new live object')
  assert.deepEqual(liveKnowledge(f.B.db), before); assert.equal(assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId).row.result_json, proof.row.result_json)
  const target = { ...f.targetConfig, directory: 'AnotherRemoteTarget' }, prefix = '/' + f.targetConfig.directory + '/', destination = '/' + target.directory + '/'
  for (const [path, bytes] of [...f.server.files]) if (path.startsWith(prefix)) f.server.files.set(destination + path.slice(prefix.length), Buffer.from(bytes))
  const { exchangeSyncedSnapshot, runtime } = await import('./helpers/synced-exchange-tombstone-fixture')
  const otherOperation = randomUUID()
  const error = await rejected(() => f.track(exchangeSyncedSnapshot(f.B.db, { operationId: otherOperation, userDataRoot: f.B.root, target }, runtime)), 'unavailable')
  assert.match(error.message, /没有可认证的共同baseline/)
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(otherOperation), undefined)
  assert.equal((f.B.db.prepare("SELECT count(*) AS n FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-job%' AND instr(value,?)>0").get(otherOperation) as { n: number }).n, 0)
  missingGroup(f.B.db, f.orphanId); assert.deepEqual(liveKnowledge(f.B.db), before)
}))
