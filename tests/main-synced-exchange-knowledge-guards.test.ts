import assert from 'node:assert/strict'
import test from 'node:test'
import { withKnowledge, divergeGroup, ready, component, side, completed, snapshot, unchangedDenial, captureDenial,
  hostEdit, changeGroup, localPortable, readStrictHostDocument, state, allTables, rejected, encode, flip,
  randomUUID, document, deleteGroup, group } from './helpers/synced-exchange-knowledge-fixture'

test('a real changed-back live CAS withdraws its complete knowledge selection while an independent incoming island still commits', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = ready(await f.preview()), c = component(p, conflict.key), hash = localPortable(f.B).entries[conflict.key]
  const baseline = state(f.B.db).parsed.baseline.find(row => row.key === conflict.key), text = snapshot(f.B.db, conflict.id).blocks[0].content
  changeGroup(f.B.db, conflict.id, blocks => { blocks[0].content = 'Real intervening guard edit' }); changeGroup(f.B.db, conflict.id, blocks => { blocks[0].content = text })
  assert.equal(localPortable(f.B).entries[conflict.key], hash)
  hostEdit(f.A.db, f.islands[1], 'Independent accepted U beside invalidated full knowledge fence'); completed(await f.exchange(f.A), 'applied')
  const before = snapshot(f.B.db, conflict.id), result = completed(await f.resolve(p, [side(c, 'remote')]), 'applied')
  assert.ok(result.deferred.some(row => row.keys.includes(conflict.key)), 'Matching final text cannot renew the original CAS and raw history authority')
  assert.equal(result.acceptedKeys.includes(conflict.key), false); assert.deepEqual(snapshot(f.B.db, conflict.id), before)
  assert.deepEqual(state(f.B.db).parsed.baseline.find(row => row.key === conflict.key), baseline)
  assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'Independent accepted U beside invalidated full knowledge fence')
  unchangedDenial(f)
}))

test('a real same-component Main edit during resolve HTTP revokes the selected live subset without dropping its fixed absent participant', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f)
  hostEdit(f.A.db, f.islands[1], 'U progresses across actual selected HTTP pause'); completed(await f.exchange(f.A), 'applied')
  const p = ready(await f.preview()), c = component(p, conflict.key), gate = f.gate(request => request.method === 'GET' && request.path.endsWith('/manifest.json'))
  const job = f.resolve(p, [side(c, 'remote')])
  try {
    await gate.wait(job); const peer = f.connect(f.B)
    changeGroup(peer, conflict.id, blocks => { blocks[0].content = 'Actual other-connection local edit during resolve read' })
    const actual = snapshot(peer, conflict.id); gate.release()
    const result = completed(await job, 'applied')
    assert.ok(result.deferred.some(row => row.keys.includes(conflict.key)), 'The complete original partition and signatures are rechecked after a real await')
    assert.deepEqual(snapshot(f.B.db, conflict.id), actual)
    assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'U progresses across actual selected HTTP pause')
    unchangedDenial(f)
  } finally { gate.release(); await Promise.allSettled([job]) }
}))

test('a fixed deleted Origin remotely resurrected after preview cannot be filtered out to authorize its formerly live component', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = ready(await f.preview()), c = component(p, conflict.key), before = snapshot(f.B.db, conflict.id)
  const { deletionProof } = await import('./helpers/synced-exchange-tombstone-fixture')
  const originalLiveOrigin = deletionProof(f.B.db, f.denialKey).proof.before
  f.remoteFinal(records => { records.set(f.denialKey, structuredClone(originalLiveOrigin)); document(records, f.islands[1]).content.blocks[0].content = 'Unrelated U beside forbidden Origin resurrection' })
  const result = completed(await f.resolve(p, [side(c, 'remote')]), 'applied')
  assert.ok(result.deferred.some(row => row.keys.includes(conflict.key) && row.keys.includes(f.denialKey)), 'Changing the fixed denial participant invalidates the whole originally authorized component')
  assert.equal(result.acceptedKeys.includes(conflict.key), false); assert.deepEqual(snapshot(f.B.db, conflict.id), before)
  assert.deepEqual(captureDenial(f.B.db, f.denialKey), f.denialB)
  assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'Unrelated U beside forbidden Origin resurrection')
}))

test('a new unrelated tombstone is accurately blocked rather than silently accepted by live selectors while a separate genuine G conflict remains executable', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), unknown = randomUUID(), key = 'group:' + unknown
  f.remoteFinal(records => { records.set(key, { kind: 'synced-group-deleted', id: unknown, creationId: randomUUID(), previousHash: '0'.repeat(64), deletedAt: new Date().toISOString() }) })
  const p = ready(await f.preview()), blocked = component(p, key), selected = component(p, conflict.key)
  assert.deepEqual(blocked.choices, []); assert.ok(blocked.reason, 'A strictly decoded but unauthenticated new deletion has an explicit blocker')
  const result = completed(await f.resolve(p, [side(selected, 'local')]), 'applied')
  assert.equal(result.acceptedKeys.includes(key), false); assert.ok(result.deferred.some(row => row.keys.includes(key)), 'A new manual format never mints deletion proof for an unknown remote tombstone')
  assert.equal(state(f.B.db).parsed.baseline.some(row => row.key === key), false)
  assert.equal(snapshot(f.B.db, conflict.id).blocks[0].content, conflict.local.blocks[0].content)
  unchangedDenial(f)
}))

test('a real fixed Origin proof modified after preview is refused before resolve HTTP and is not repaired from private remembered facts', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = ready(await f.preview()), c = component(p, conflict.key)
  const original = f.denialB.marker, proof = JSON.parse(original.result_json) as { intentHash: string }
  proof.intentHash = flip(proof.intentHash)
  f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(proof), original.client_operation_id)
  const before = allTables(f.B.db), requests = f.server.requests.length
  f.reopenPeer(); await rejected(() => f.resolve(p, [side(c, 'local')]), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
}))

test('a new remote deletion of a live chosen group remains blocked with its real dependency component rather than being coerced into a local remote or merge choice', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f)
  f.remoteFinal(records => {
    for (const record of records.values()) if (record.kind === 'document') {
      record.content.blocks = record.content.blocks.filter(block => block.type !== 'synced-block' || JSON.parse(block.content).groupId !== conflict.id)
      if (!record.content.blocks.length) record.content.blocks.push({ id: randomUUID(), type: 'paragraph', content: 'Explicit remote surviving paragraph', checked: false, depth: 0, parentBlockId: null, tags: [] })
    }
    const actual = group(records, conflict.id); assert.equal(actual.id, conflict.id); deleteGroup(records, conflict.id)
    document(records, f.islands[1]).content.blocks[0].content = 'Unrelated accepted U next to a new chosen-group tombstone'
  })
  const p = ready(await f.preview()), c = component(p, conflict.key), kept = snapshot(f.B.db, conflict.id)
  assert.deepEqual(c.choices, []); assert.ok(c.reason, 'The old conflict GUI cannot authorize fresh group deletion')
  for (const choice of ['local', 'remote', 'merge'] as const) await rejected(() => f.resolve(p, [{ componentId: c.componentId, choice } as never]), 'invalid')
  assert.deepEqual(snapshot(f.B.db, conflict.id), kept); unchangedDenial(f)
}))
