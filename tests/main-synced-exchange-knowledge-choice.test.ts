import assert from 'node:assert/strict'
import test from 'node:test'
import { withKnowledge, divergeGroup, divergeDocument, ready, component, side, mergeDecision, completed,
  snapshot, unchangedDenial, unchangedDenialFacts, execution, localPortable, storedReceipt, randomUUID, readStrictHostDocument,
  allTables, rejected, count } from './helpers/synced-exchange-knowledge-fixture'

test('accepted Origin deletion remains a fixed member of a ready live G conflict preview without minting new execution authority', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), before = execution(f.B.db), physical = localPortable(f.B), remote = f.remote().bytes
  const p = ready(await f.preview()), c = component(p, conflict.key)
  assert.ok(c.keys.includes(f.denialKey), 'The original deleted Origin stays in the complete component instead of being filtered out before graph partitioning')
  assert.ok(['local', 'remote', 'merge'].every(choice => c.choices.includes(choice as 'local' | 'remote' | 'merge')), 'Fixed authenticated absence does not suppress genuine live choices')
  const fixed = c.records.find(record => record.key === f.denialKey)
  assert.ok(fixed, 'Public diagnostics retain the real fixed participant alongside mutable live records')
  assert.equal(fixed.merge, null)
  assert.equal(fixed.remoteHash, f.denialB.tombstoneHash)
  assert.deepEqual(execution(f.B.db), before); assert.deepEqual(localPortable(f.B), physical); assert.deepEqual(f.remote().bytes, remote)
  unchangedDenial(f)
}))

test('live local choice with deleted Origin preserves the actual local full Key mapping and every original denial byte', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f, true), before = snapshot(f.B.db, conflict.id), originalTargets = before.bindings.map(binding => binding.target)
  assert.ok(before.bindings.length >= 2 && new Set(before.bindings.filter(binding => binding.raw === 'Target.md').map(binding => JSON.stringify(binding.target))).size === 2, 'The real old source has equal URL spellings with distinct historical physical targets')
  const p = ready(await f.preview()), c = component(p, conflict.key), operationId = randomUUID()
  const result = completed(await f.resolve(p, [side(c, 'local')], operationId), 'applied')
  assert.ok(result.acceptedKeys.includes(conflict.key) && !result.acceptedKeys.includes(f.denialKey), 'Only the live choice is newly accepted; fixed absence keeps its old accepting operation')
  assert.deepEqual(snapshot(f.B.db, conflict.id).blocks, before.blocks); assert.deepEqual(snapshot(f.B.db, conflict.id).bindings, before.bindings)
  assert.deepEqual(snapshot(f.B.db, conflict.id).bindings.map(binding => binding.target), originalTargets)
  assert.equal(f.remote().manifest.entries[conflict.key], localPortable(f.B).entries[conflict.key])
  const receipt = storedReceipt(f.B.db, operationId, 5)
  assert.equal(receipt.value.provenance.accepted.some(row => row.key === f.denialKey), false)
  unchangedDenial(f); completed(await f.exchange(f.A), 'applied'); unchangedDenialFacts(f, f.A)
}, { sameUrl: true }))

test('live remote choice with deleted Origin installs the real remote canonical body and complete historical bindings without reviving its origin', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f, true), p = ready(await f.preview()), c = component(p, conflict.key), operationId = randomUUID()
  completed(await f.resolve(p, [side(c, 'remote')], operationId), 'applied')
  const actual = snapshot(f.B.db, conflict.id)
  assert.deepEqual(actual.blocks, conflict.remote.blocks); assert.deepEqual(actual.bindings, conflict.remote.bindings)
  assert.equal(actual.origin.documentId, f.host); assert.equal(count(f.B.db, 'documents', 'id', f.host), 0)
  storedReceipt(f.B.db, operationId, 5); unchangedDenial(f)
}, { sameUrl: true }))

test('live explicit merge beside fixed deleted Origin really publishes and installs untrimmed selected text while absence retains its format4 proof', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = ready(await f.preview()), c = component(p, conflict.key), text = '  exact Main selected merged body  '
  const decision = mergeDecision(c, () => ({ choice: 'custom', text })), operationId = randomUUID()
  const result = completed(await f.resolve(p, [decision], operationId), 'applied')
  assert.equal(snapshot(f.B.db, conflict.id).blocks[0].content, text)
  const remote = f.remote().records.get(conflict.key)
  assert.ok(remote?.kind === 'synced-group', 'The selected merge is a real complete immutable remote group object')
  assert.equal(remote.blocks[0].content, text); assert.ok(result.publishedKeys.includes(conflict.key), 'The custom result actually traversed the same-target publication consumer')
  const receipt = storedReceipt(f.B.db, operationId, 5)
  assert.ok(receipt.value.provenance.merges.length > 0, 'The real finite result retains its exact original common-source merge provenance')
  unchangedDenial(f)
}))

test('ordinary whole-side conflict beside authenticated group absence is truly resolved without projecting state2 back into live-only state1', () => withKnowledge(async f => {
  const conflict = await divergeDocument(f), p = ready(await f.preview()), c = component(p, conflict.key), operationId = randomUUID()
  const result = completed(await f.resolve(p, [side(c, 'remote')], operationId), 'applied')
  assert.equal(readStrictHostDocument(f.B.db, conflict.id).detail.blocks[0].content, 'REMOTE ordinary overlapping body')
  assert.ok(result.appliedKeys.includes(conflict.key), 'The real Main SQL consumer installs the selected ordinary forest')
  storedReceipt(f.B.db, operationId, 5); unchangedDenial(f)
}, { denial: 'orphan' }))

test('zero-active state2 still resolves a genuine ordinary conflict and stays protocol5 without inventing an active group or ordinary empty-member publication', () => withKnowledge(async f => {
  const conflict = await divergeDocument(f), p = ready(await f.preview()), c = component(p, conflict.key)
  completed(await f.resolve(p, [side(c, 'local')]), 'applied')
  assert.equal(readStrictHostDocument(f.B.db, conflict.id).detail.blocks[0].content, 'LOCAL ordinary overlapping body')
  assert.equal(f.remote().manifest.version, 5)
  for (const profile of [f.A, f.B]) {
    assert.deepEqual(profile.db.prepare('SELECT * FROM synced_group_blocks').all(), [])
    assert.deepEqual(profile.db.prepare('SELECT * FROM synced_instances').all(), [])
  }
  const ordinaryEmpty = f.B.db.prepare("SELECT a.id FROM synced_exposure_attempts a WHERE a.channel IN('webdav-manifest5','webdav-manifest5-exchange') AND NOT EXISTS(SELECT 1 FROM synced_group_exposure_members m WHERE m.attempt_id=a.id)").all()
  assert.deepEqual(ordinaryEmpty, [], 'Zero-active publication does not fake the original group-member publication channel')
  unchangedDenial(f); completed(await f.exchange(), 'noop'); unchangedDenialFacts(f)
}, { denial: 'zero' }))

test('caller cannot submit the fixed denied record as a merge selector or an extra whole-component authority', () => withKnowledge(async f => {
  const conflict = await divergeGroup(f), p = ready(await f.preview()), c = component(p, conflict.key), original = mergeDecision(c, () => ({ choice: 'remote' }))
  assert.ok(original.choice === 'merge', 'The negative starts with an actual guarded public merge decision')
  const forged = { ...original, records: [...original.records, { key: f.denialKey, parts: [] }].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) }
  const before = allTables(f.B.db), requests = f.server.requests.length
  await rejected(() => f.resolve(p, [forged]), 'invalid')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  unchangedDenial(f)
}))
