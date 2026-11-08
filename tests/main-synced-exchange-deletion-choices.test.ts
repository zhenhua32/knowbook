import assert from 'node:assert/strict'
import test from 'node:test'
import { previewSyncedExchangeDeletionDetails, resolveSyncedExchangeDeletions } from '../src/main/sync/synced-exchange'
import { withDeletionChoices, groupConflict, docConflict, realNewReference, ready, component, choose, completed,
  proof2, receipt7, snapshot, count, randomUUID, encode, hash, localPortable, missingGroup,
  readStrictHostDocument, hostEdit, deleteGroup, assertAbsentKnowledge, state } from './helpers/synced-deletion-choice-fixture'
import { runtime } from './helpers/synced-deletion-choice-setup'

test('deletion presentation uses the original hash-verified common, local and remote objects and rejects a different preview hash', () => withDeletionChoices(async f => {
  const conflict = docConflict(f), previewId = randomUUID(), operationId = randomUUID()
  const input = { previewId, userDataRoot: f.B.root, target: f.targetConfig }
  const readonlyStart = f.server.requests.length
  const result = await f.track(previewSyncedExchangeDeletionDetails(f.B.db, input, runtime))
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') throw new Error('The genuine deletion preview is unavailable')
  const { preview } = result, group = preview.components.find(row => row.records.some(record => record.key === conflict.key))!
  const record = group.records.find(row => row.key === conflict.key)!
  assert.deepEqual(record.base, { kind: 'live', hash: hash(encode(conflict.base)), title: conflict.base.content.title,
    text: [conflict.base.content.summary, ...conflict.base.content.blocks.map(block => block.content)].filter(Boolean).join('\n'), truncated: false })
  assert.deepEqual(record.local, { kind: 'live', hash: hash(encode(conflict.local)), title: conflict.local.content.title,
    text: [conflict.local.content.summary, ...conflict.local.content.blocks.map(block => block.content)].filter(Boolean).join('\n'), truncated: false })
  assert.deepEqual(record.remote, { kind: 'deleted', hash: f.remote().manifest.entries[conflict.key] })
  assert.ok(group.choices.includes('keep-delete'))
  assert.equal(preview.previewHash, ready(await f.preview(f.B, previewId)).previewHash)
  assert.ok(f.server.requests.slice(readonlyStart).every(request => ['GET', 'HEAD', 'PROPFIND'].includes(request.method)))
  const operation = { ...input, operationId, decisions: [{ componentId: group.componentId, choice: 'keep-delete' as const }] }
  const wrongHash = preview.previewHash.replace(/^./, char => char === '0' ? '1' : '0')
  await assert.rejects(f.track(resolveSyncedExchangeDeletions(f.B.db, { ...operation, expectedPreviewHash: wrongHash }, runtime)), /预览已变化/)
  assert.equal(count(f.B.db, 'documents', 'id', conflict.id), 1)
  completed(await f.track(resolveSyncedExchangeDeletions(f.B.db, { ...operation, expectedPreviewHash: preview.previewHash }, runtime)), 'applied')
  assert.equal(count(f.B.db, 'documents', 'id', conflict.id), 0)
  proof2(f, operationId, conflict.key)
  await assert.rejects(f.track(resolveSyncedExchangeDeletions(f.B.db, { ...operation, expectedPreviewHash: wrongHash }, runtime)), /预览已变化/)
  assert.deepEqual(await f.track(previewSyncedExchangeDeletionDetails(f.B.db, input, runtime)), result)
}))

test('explicit keep-delete really removes changed unpinned G and records both true B and current L with its original remote predecessor', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), p = ready(await f.preview()), c = component(p, conflict.key), operationId = randomUUID()
  assert.ok(c.deletionKeys.includes(conflict.key), 'The actual preview distinguishes the new deletion from any fixed denial')
  assert.ok(c.choices.includes('keep-live') && c.choices.includes('keep-delete'), 'The genuine changed orphan has both qualified choices, not a fake pin-free DTO')
  const actual = c.records.find(record => record.key === conflict.key)
  assert.equal(actual?.baseHash, conflict.baseHash); assert.equal(actual?.localHash, hash(encode(conflict.localWire)))
  const result = completed(await f.resolve(p, [choose(c, 'keep-delete')], operationId), 'applied')
  assert.ok(result.appliedKeys.includes(conflict.key) && result.acceptedKeys.includes(conflict.key), 'The actual Main consumer installs and accepts the chosen group deletion')
  missingGroup(f.B.db, conflict.id); assert.equal(count(f.B.db, 'synced_group_blocks', 'group_id', conflict.id), 0)
  const saved = proof2(f, operationId, conflict.key)
  assert.deepEqual(saved.value.base, conflict.base); assert.deepEqual(saved.value.before, conflict.localWire)
  assert.equal(saved.value.deletion.kind, 'synced-group-deleted')
  if (saved.value.deletion.kind !== 'synced-group-deleted') throw new Error('Expected actual strict group tombstone')
  assert.equal(saved.value.deletion.previousHash, conflict.baseHash); assert.equal(saved.value.deletion.creationId, conflict.before.creationId)
  assert.equal(f.remote().manifest.entries[conflict.key], saved.value.tombstoneHash)
  const raw = f.B.db.prepare('SELECT creation_id,created_at,origin_json,revision,topology_revision,history_cursor FROM synced_groups WHERE id=?').get(conflict.id) as Record<string, string>
  assert.equal(raw.creation_id, conflict.before.creationId); assert.equal(raw.created_at, conflict.before.createdAt); assert.equal(raw.origin_json, encode(conflict.before.origin))
  assert.notEqual(raw.revision, conflict.local.revision); assert.notEqual(raw.topology_revision, conflict.local.topologyRevision); assert.notEqual(raw.history_cursor, conflict.local.history.cursor)
  for (const effect of saved.value.identities) assert.deepEqual(f.B.db.prepare('SELECT last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(effect.before.id), { last_owner_kind: 'group', last_owner_id: conflict.id, state: 'retained', created_at: effect.before.created_at })
}))

test('explicit keep-live preserves the real same-creation orphan L and republishes it only while this peer has not accepted permanent denial', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), p = ready(await f.preview()), c = component(p, conflict.key), operationId = randomUUID()
  const beforeIdentities = conflict.local.blocks.map(block => f.B.db.prepare('SELECT * FROM block_identities WHERE id=?').get(block.id))
  const result = completed(await f.resolve(p, [choose(c, 'keep-live')], operationId), 'applied')
  assert.ok(result.publishedKeys.includes(conflict.key), 'The real same-target manifest CAS keeps the authorized current live branch')
  assert.deepEqual(snapshot(f.B.db, conflict.id).blocks, conflict.local.blocks)
  assert.deepEqual(snapshot(f.B.db, conflict.id).origin, conflict.before.origin); assert.equal(snapshot(f.B.db, conflict.id).creationId, conflict.before.creationId)
  assert.deepEqual(conflict.local.blocks.map(block => f.B.db.prepare('SELECT * FROM block_identities WHERE id=?').get(block.id)), beforeIdentities)
  const wire = f.remote().records.get(conflict.key)
  assert.deepEqual(wire, conflict.localWire)
  assert.equal(count(f.B.db, 'synced_operations', 'client_operation_id', 'synced:logical-deletion:v1:group:' + conflict.id + ':' + conflict.before.creationId), 0)
  assert.deepEqual(receipt7(f, operationId).receipt.provenance.deletions, [])
}))

test('explicit doc keep-delete persists the actual edited ordinary forest as proof before deleting it while keeping its exact common ancestor separate', () => withDeletionChoices(async f => {
  const conflict = docConflict(f), p = ready(await f.preview()), c = component(p, conflict.key), operationId = randomUUID()
  completed(await f.resolve(p, [choose(c, 'keep-delete')], operationId), 'applied')
  assert.equal(count(f.B.db, 'documents', 'id', conflict.id), 0); assert.equal(count(f.B.db, 'blocks', 'document_id', conflict.id), 0)
  const saved = proof2(f, operationId, conflict.key)
  assert.deepEqual(saved.value.base, conflict.base); assert.deepEqual(saved.value.before, conflict.local)
  assert.deepEqual(saved.value.deletion, { kind: 'deleted', id: conflict.id })
  const baseline = state(f.B.db).parsed.baseline.find(row => row.key === conflict.key)
  assert.deepEqual(baseline?.local, { kind: 'absent', tombstoneHash: saved.value.tombstoneHash, deletionOperationId: operationId, intentHash: saved.value.intentHash })
  assert.equal(baseline?.commonHash, saved.value.tombstoneHash)
}))

test('a genuine new reference offers only keep-live and its Main journal pins and complete ordinary host survive the decision', () => withDeletionChoices(async f => {
  const conflict = realNewReference(f), p = ready(await f.preview()), c = component(p, conflict.key)
  assert.ok(c.choices.includes('keep-live'), 'The real same-creation source may preserve its newly inserted reference')
  assert.equal(c.choices.includes('keep-delete'), false); assert.equal(c.keepDeleteReason, 'history-pin')
  const host = readStrictHostDocument(f.B.db, f.islands[0]), operationId = randomUUID()
  completed(await f.resolve(p, [choose(c, 'keep-live')], operationId), 'applied')
  assert.deepEqual(readStrictHostDocument(f.B.db, f.islands[0]).content, host.content)
  assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id').all(conflict.id), conflict.pins)
  assert.equal(snapshot(f.B.db, conflict.id).instances.length, 1)
  assert.ok(f.remote().manifest.syncedInstances.some(row => row.instanceId === conflict.input.action.instanceId && row.groupId === conflict.id), 'The real published closure keeps the exact fresh reference to the genuine source')
  assert.deepEqual(receipt7(f, operationId).receipt.provenance.deletions, [])
}))

test('a peer that truly accepted permanent denial refuses a later other-peer keep-live and never borrows proof before as a source to converge the old tuple', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f)
  completed(await f.exchange(f.A), 'applied')
  const denied = assertAbsentKnowledge(f.A.db, conflict.key)
  const originalRows = { marker: denied.row, anchor: denied.anchor, receipt: denied.receiptRow }
  const p = ready(await f.preview()), c = component(p, conflict.key)
  completed(await f.resolve(p, [choose(c, 'keep-live')]), 'applied')
  const other = completed(await f.exchange(f.A))
  assert.ok(other.deferred.some(row => row.keys.includes(conflict.key)), 'Another peer permanent denial is not cancelled by this peer authorizing its previously unaccepted live branch')
  missingGroup(f.A.db, conflict.id)
  const after = assertAbsentKnowledge(f.A.db, conflict.key)
  assert.deepEqual({ marker: after.row, anchor: after.anchor, receipt: after.receiptRow }, originalRows)
  assert.equal(snapshot(f.B.db, conflict.id).creationId, conflict.before.creationId)
}))

test('preexisting fixed absence is carried byte-exact while a genuine independent edited document deletion and unrelated incoming island are accepted', () => withDeletionChoices(async f => {
  f.remoteFinal(records => { deleteGroup(records, f.orphanId) }); completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  const conflict = docConflict(f)
  hostEdit(f.A.db, f.islands[1], 'Unrelated incoming across explicit deletion choice'); completed(await f.exchange(f.A), 'applied')
  const fixed = assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId), baseline = structuredClone(state(f.B.db).parsed.baseline.find(row => row.key === 'group:' + f.orphanId))
  const p = ready(await f.preview()), c = component(p, conflict.key), operationId = randomUUID()
  const result = completed(await f.resolve(p, [choose(c, 'keep-delete')], operationId), 'applied')
  assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'Unrelated incoming across explicit deletion choice')
  assert.deepEqual(assertAbsentKnowledge(f.B.db, 'group:' + f.orphanId), fixed)
  assert.deepEqual(state(f.B.db).parsed.baseline.find(row => row.key === 'group:' + f.orphanId), baseline)
  assert.ok(result.acceptedKeys.includes(conflict.key) && !result.acceptedKeys.includes('group:' + f.orphanId), 'Existing absence retains its original accepting operation instead of being re-signed by the new decision')
  proof2(f, operationId, conflict.key)
}))
