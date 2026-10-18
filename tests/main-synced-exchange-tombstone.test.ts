import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { assetPath } from './helpers/synced-initial-incoming-fixture'
import { BlockIdentityRepository } from '../src/main/database/block-identities'
import { withTombstones, completed, randomUUID, encode, hash, physical, count, deleteGroup, deleteDocument, document,
  group, removeGroupReferences, rawGroup, missingGroup, assertAbsentKnowledge, state, snapshot, createRequest,
  created, applySyncedHostCommand, readStrictHostDocument, liveKnowledge, withDocumentOnlyTombstone } from './helpers/synced-exchange-tombstone-fixture'

test('actual tombstone exchange deletes a received nopin orphan canonical body while keeping its immutable raw identity denial and exact absent baseline', () => withTombstones(async f => {
  const before = rawGroup(f.B.db, f.orphanId), old = snapshot(f.B.db, f.orphanId), life = f.B.db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(f.orphanId)
  const identities = old.blocks.map(block => physical(f.B.db, block.id)), input = f.remoteFinal(records => { deleteGroup(records, f.orphanId) })
  const result = completed(await f.exchange(), 'applied')
  assert.ok(result.appliedKeys.includes('group:' + f.orphanId) && result.acceptedKeys.includes('group:' + f.orphanId), 'The actual result reports both physical deletion and acceptance of the exact tombstone knowledge')
  assert.equal(result.publishedKeys.includes('group:' + f.orphanId), false)
  missingGroup(f.B.db, f.orphanId); assert.equal(count(f.B.db, 'synced_group_blocks', 'group_id', f.orphanId), 0)
  const after = rawGroup(f.B.db, f.orphanId)
  for (const key of ['id', 'creation_id', 'created_at', 'origin_json'] as const) assert.equal(after[key], before[key])
  for (const key of ['revision', 'topology_revision', 'history_cursor'] as const) { assert.notEqual(after[key], before[key]); assert.match(after[key], /^[a-f0-9-]{36}$/) }
  assert.equal(after.history_position, 0)
  const lifeAfter = f.B.db.prepare('SELECT * FROM synced_group_lifecycle WHERE group_id=?').get(f.orphanId) as Record<string, unknown>
  for (const key of ['state', 'exposure_state', 'activation_revision', 'activation_topology_revision', 'activation_hash', 'activation_instances_json']) assert.equal(lifeAfter[key], (life as Record<string, unknown>)[key])
  old.blocks.forEach((block, index) => {
    const actual = physical(f.B.db, block.id)
    assert.equal(actual.canonical, undefined); assert.equal(actual.ordinary, undefined); assert.deepEqual(actual.routes, identities[index].routes)
    assert.deepEqual(actual.identity, { ...(identities[index].identity as Record<string, unknown>), state: 'retained' })
    assert.equal(new BlockIdentityRepository(f.B.db).resolveLiveOwner(block.id), null)
  })
  const saved = assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId)
  assert.equal(saved.proof.source.manifestHash, input.hash); assert.equal(saved.proof.baseLiveHash, hash(encode(saved.proof.before)))
  assert.equal(saved.row.client_operation_id, 'synced:logical-deletion:v1:group:' + old.groupId + ':' + old.creationId)
  assert.deepEqual(saved.proof.identities.map(row => row.before.id).sort(), old.blocks.map(block => block.id).sort())
  assert.ok(saved.proof.identities.every(row => row.after.kind === 'retained'), 'The original simple deletion records retained outcomes for its complete actual canonical child set')
  completed(await f.exchange(f.A), 'applied'); f.reopenPeer(); completed(await f.exchange(), 'noop')
  missingGroup(f.B.db, f.orphanId); assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId)
}))

test('actual ordinary document tombstone deletes its physical forest and current owner while keeping birth routes and stable denial independent of a live group', () => withTombstones(async f => {
  const id = f.islands[0], before = readStrictHostDocument(f.B.db, id), children = before.detail.blocks.map(block => [block.id, physical(f.B.db, block.id)] as const)
  const remote = f.remoteFinal(records => { deleteDocument(records, id) }), result = completed(await f.exchange(), 'applied')
  assert.ok(result.appliedKeys.includes('doc:' + id), 'The actual consumer applies the ordinary physical deletion')
  assert.equal(f.B.db.prepare('SELECT * FROM documents WHERE id=?').get(id), undefined); assert.equal(count(f.B.db, 'blocks', 'document_id', id), 0)
  for (const [blockId, old] of children) { const actual = physical(f.B.db, blockId); assert.equal(actual.ordinary, undefined); assert.deepEqual(actual.identity, { ...(old.identity as Record<string, unknown>), state: 'retained' }); assert.deepEqual(actual.routes, old.routes) }
  const saved = assertAbsentKnowledge(f.B.db, 'doc:' + id)
  assert.equal(saved.row.client_operation_id, 'synced:logical-deletion:v1:doc:' + encode(id))
  assert.equal(saved.proof.source.manifestHash, remote.hash); assert.deepEqual(saved.proof.deletion, { kind: 'deleted', id })
  assert.equal(saved.proof.before.id, id)
  assert.equal(snapshot(f.B.db, f.groupId).groupId, f.groupId)
  completed(await f.exchange(f.A), 'applied'); f.reopenPeer(); completed(await f.exchange(), 'noop'); assertAbsentKnowledge(f.B.db, 'doc:' + id)
}, { onlyOrphan: true }))

test('actual deleting a reference host changes real topology but leaves its formerly referenced group as an editable discoverable orphan', () => withTombstones(async f => {
  // The child has an explicit remote parent transition; no FK SET NULL is used as implicit policy.
  const old = snapshot(f.B.db, f.groupId), host = readStrictHostDocument(f.B.db, f.host)
  f.remoteFinal(records => { document(records, f.child).parentId = null; deleteDocument(records, f.host) })
  completed(await f.exchange(), 'applied')
  assert.equal(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(f.host), undefined)
  const orphan = snapshot(f.B.db, f.groupId)
  assert.equal(orphan.instances.length, 0); assert.deepEqual(orphan.blocks, old.blocks); assert.notEqual(orphan.topologyRevision, old.topologyRevision)
  assert.equal(readStrictHostDocument(f.B.db, f.child).parentId, null)
  assertAbsentKnowledge(f.B.db, 'doc:' + f.host)
  for (const block of host.detail.blocks) assert.equal(physical(f.B.db, block.id).ordinary, undefined)
  assert.equal(count(f.B.db, 'synced_group_blocks', 'group_id', f.groupId), old.blocks.length)
}))

test('actual final live-group deletion keeps protocol5 sticky on another connection and never falls through the legacy zero-active sender path', () => withTombstones(async f => {
  f.remoteFinal(records => { for (const id of new Set([f.groupId, f.orphanId])) { removeGroupReferences(records, id); deleteGroup(records, id) } })
  completed(await f.exchange(), 'applied')
  for (const id of [f.groupId, f.orphanId]) { missingGroup(f.B.db, id); assertAbsentKnowledge(f.B.db, 'group:' + id) }
  assert.equal(count(f.B.db, 'synced_group_blocks'), 0); assert.equal(count(f.B.db, 'synced_instances'), 0)
  assert.equal(f.remote().manifest.version, 5)
  f.reopenPeer(); const old = state(f.B.db), result = completed(await f.exchange(), 'noop')
  assert.deepEqual(result.publishedKeys, []); assert.equal(f.remote().manifest.version, 5)
  assert.equal(state(f.B.db).parsed.baseline.length, old.parsed.baseline.length)
  for (const id of [f.groupId, f.orphanId]) assertAbsentKnowledge(f.B.db, 'group:' + id)
}, { onlyOrphan: true }))

test('actual group deletion can transfer every canonical child to an explicit ordinary owner and later real create preserves its historical deletion proof', () => withTombstones(async f => {
  const old = snapshot(f.B.db, f.orphanId), child = old.blocks[0], key = 'group:' + f.orphanId
  assert.equal(old.blocks.length, 1)
  f.remoteFinal(records => {
    deleteGroup(records, f.orphanId)
    const { createdAt: _birth, ...ordinary } = child
    document(records, f.islands[0]).content.blocks.push(structuredClone(ordinary))
  })
  completed(await f.exchange(), 'applied'); missingGroup(f.B.db, f.orphanId)
  const actual = physical(f.B.db, child.id)
  assert.deepEqual(actual.ordinary, { id: child.id, document_id: f.islands[0], created_at: child.createdAt }); assert.equal(actual.canonical, undefined)
  const proof = assertAbsentKnowledge(f.B.db, key)
  assert.deepEqual(proof.proof.identities.find(row => row.before.id === child.id)?.after, { kind: 'transferred', ownerKind: 'document', ownerId: f.islands[0], createdAt: child.createdAt })
  const input = createRequest(f.B.db, { documentId: f.islands[0], selectedRootIds: [child.id] }), ack = created(applySyncedHostCommand(f.B.db, input))
  const fresh = snapshot(f.B.db, ack.createdLifecycle.groupId)
  assert.deepEqual(fresh.blocks.map(block => [block.id, block.createdAt]), [[child.id, child.createdAt]])
  completed(await f.exchange(), 'applied'); f.reopenPeer(); completed(await f.exchange(), 'noop')
  assert.equal(assertAbsentKnowledge(f.B.db, key).row.result_json, proof.row.result_json)
  missingGroup(f.B.db, f.orphanId); assert.equal(snapshot(f.B.db, fresh.groupId).blocks[0].id, child.id)
}))

test('actual document deletion may pair its ordinary release with canonical adoption using exact remote canonical birth rather than receiver-local ordinary birth', () => withTombstones(async f => {
  const id = f.islands[0], before = readStrictHostDocument(f.B.db, id), body = before.detail.blocks[0]
  const sourceBirth = (f.S.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(body.id) as { created_at: string }).created_at
  const localBirth = (physical(f.B.db, body.id).identity as { created_at: string }).created_at
  f.remoteFinal(records => {
    const originalWireChild = document(records, id).content.blocks.find(block => block.id === body.id)
    assert.ok(originalWireChild, 'The canonical receiver gets the exact original ordinary wire child without local DocumentDetail sortOrder fields')
    deleteDocument(records, id); group(records, f.orphanId).blocks.push({ ...structuredClone(originalWireChild), createdAt: sourceBirth })
  })
  completed(await f.exchange(), 'applied')
  assert.equal(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(id), undefined)
  const actual = physical(f.B.db, body.id)
  assert.equal(actual.ordinary, undefined); assert.deepEqual(actual.canonical, { id: body.id, group_id: f.orphanId, created_at: sourceBirth })
  const saved = assertAbsentKnowledge(f.B.db, 'doc:' + id), effect = saved.proof.identities.find(row => row.before.id === body.id)
  assert.ok(effect, 'The complete original ordinary identity is explicitly covered by the historical deletion proof')
  assert.equal(effect.before.created_at, localBirth)
  assert.deepEqual(effect.after, { kind: 'transferred', ownerKind: 'group', ownerId: f.orphanId, createdAt: sourceBirth })
  f.reopenPeer(); completed(await f.exchange(), 'noop'); assert.equal(assertAbsentKnowledge(f.B.db, 'doc:' + id).row.result_json, saved.row.result_json)
}))

test('actual tombstone of the only orphan preserves managed asset aliases and exact bytes rather than treating permanent denial as asset garbage collection', () => withTombstones(async f => {
  assert.equal(f.aliases.length, 2)
  const paths = f.aliases.map(alias => ({ path: assetPath(f.B, alias), bytes: Buffer.from(alias.bytes) }))
  for (const item of paths) assert.deepEqual(readFileSync(item.path), item.bytes)
  const requests = f.server.requests.length
  f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(), 'applied')
  for (const item of paths) assert.deepEqual(readFileSync(item.path), item.bytes)
  assert.equal(f.server.requests.slice(requests).some(request => (request.method === 'PUT' || request.method === 'MOVE') && /\/(?:assets|objects)\//.test(request.path)), false)
  assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId); missingGroup(f.B.db, f.orphanId)
}, { onlyOrphan: true, assets: true }))

test('actual opaque document deletion in a genuinely group-free schema27 profile persists denial knowledge and remains readable after a new SQLite connection', () => withDocumentOnlyTombstone(async f => {
  f.remoteFinal(records => { deleteDocument(records, f.ordinaryId) })
  const result = completed(await f.exchange(), 'applied')
  assert.ok(result.appliedKeys.includes('doc:' + f.ordinaryId), 'The real group-free receiver performs physical document deletion without a group-owned capability')
  assert.equal(count(f.B.db, 'synced_groups'), 0); assert.equal(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(f.ordinaryId), undefined)
  const proof = assertAbsentKnowledge(f.B.db, 'doc:' + f.ordinaryId)
  assert.equal(proof.row.client_operation_id, 'synced:logical-deletion:v1:doc:' + encode(f.ordinaryId))
  f.reopen(); completed(await f.exchange(), 'noop')
  assert.equal(assertAbsentKnowledge(f.B.db, 'doc:' + f.ordinaryId).row.result_json, proof.row.result_json)
}))
