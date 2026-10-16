import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedBindingSource, SyncedCanonicalWire, SyncedGroupSnapshot } from '../src/shared/synced-blocks'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { getSyncedGroupSnapshotsWithLinkSources, resolveSyncedBindingSource, SYNCED_BINDING_SOURCE_LIMITS } from '../src/main/database/synced-binding-sources'
import { restoreSyncedGroupOperation, updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { born, now, host, other, groupId, uuid, paragraph, edits, createGroup, addInstance, withDatabase, withTwoClients,
  snapshot, update, restore, saved, state, ordinary } from './helpers/synced-content-fixture'

const bindingKey = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
function keys(db: Database.Database, blocks: SyncedCanonicalWire[], before = snapshot(db)): SyncedBindingKey[] {
  return captureSyncedGroupBindings(db, before.origin, blocks).map(bindingKey)
}
function seed(db: Database.Database, content = '[old](Target.md)'): SyncedGroupSnapshot {
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Target', 'Original/Target', other)
  const before = snapshot(db), blocks = [{ ...before.blocks[0], content }]
  const bindings = captureSyncedGroupBindings(db, before.origin, blocks)
  db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run(content, groupId)
  db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(bindings), groupId)
  return snapshot(db)
}
function read(db: Database.Database, ids = [groupId]) {
  return getSyncedGroupSnapshotsWithLinkSources(db, { groupIds: ids })
}
function source(db: Database.Database): SyncedBindingSource {
  const item = read(db).items[0]
  assert.equal(item.status, 'ready')
  if (item.status !== 'ready') throw new Error('fixture')
  return item.bindingSource
}
function newTarget(db: Database.Database): string {
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed', 'Original/Renamed', other)
  const id = randomUUID()
  db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'Target', id, 'Original/Target', born, now)
  return id
}
function invalidWithoutWrites(db: Database.Database, blocks: SyncedCanonicalWire[], bindingClaims: unknown): void {
  const before = state(db)
  const result = updateSyncedBlockGroup(db, { ...update(db, edits(blocks)), bindingClaims })
  assert.equal(result.status, 'invalid', JSON.stringify(result))
  assert.deepEqual(state(db), before)
  assert.equal(db.inTransaction, false)
}

test('exact claims preserve distinct old targets through real split/join and edits on both sides of equal URLs', () => withDatabase(db => {
  const initial = seed(db), replacement = newTarget(db)
  const doubled = [{ ...initial.blocks[0], content: 'before [old](Target.md) after [new](Target.md)' }]
  const [first, second] = keys(db, doubled)
  const accepted = saved(updateSyncedBlockGroup(db, { ...update(db, edits(doubled)), bindingClaims: [
    { kind: 'continue', source: bindingKey(initial.bindings[0]), destination: first }, { kind: 'new', destination: second }
  ] }))
  assert.deepEqual(accepted.snapshot.bindings.map(item => item.target), [
    { kind: 'document', id: other, state: 'live' }, { kind: 'document', id: replacement, state: 'live' }
  ])
  const split = [paragraph(' split:__proto__ ', 'changed [old](Target.md) left'), paragraph('constructor', 'right [new](Target.md) changed')]
  const splitKeys = keys(db, split)
  assert.equal(updateSyncedBlockGroup(db, update(db, edits(split))).status, 'invalid', 'The conservative fallback must still refuse ambiguous edits')
  const moved = saved(updateSyncedBlockGroup(db, { ...update(db, edits(split)), bindingClaims: accepted.snapshot.bindings.map((binding, index) =>
    ({ kind: 'continue', source: bindingKey(binding), destination: splitKeys[index] })) }))
  assert.deepEqual(moved.snapshot.bindings.map(item => item.target), accepted.snapshot.bindings.map(item => item.target))
  const joined = [paragraph(' joined:正文 ', 'both [old](Target.md) middle [new](Target.md) sides')], joinedKeys = keys(db, joined)
  const result = saved(updateSyncedBlockGroup(db, { ...update(db, edits(joined)), bindingClaims: moved.snapshot.bindings.map((binding, index) =>
    ({ kind: 'continue', source: bindingKey(binding), destination: joinedKeys[index] })) }))
  assert.deepEqual(result.snapshot.bindings.map(item => item.target), accepted.snapshot.bindings.map(item => item.target))
  assert.deepEqual(result.snapshot.blocks.map(item => item.id), [' joined:正文 '])
  const after = state(db)
  invalidWithoutWrites(db, joined, [{ kind: 'continue', source: bindingKey(result.snapshot.bindings[0]), destination: joinedKeys[0] }])
  assert.deepEqual(state(db), after)
}))

test('every final parser occurrence is claimed once and source syntax/decoded URL cannot be replaced or forged', () => withDatabase(db => {
  const before = seed(db), original = bindingKey(before.bindings[0])
  const repeated = [{ ...before.blocks[0], content: '[one](Target.md) [two](Target.md)' }], destinations = keys(db, repeated)
  const copied = saved(updateSyncedBlockGroup(db, { ...update(db, edits(repeated)), bindingClaims: destinations.map(destination =>
    ({ kind: 'copy', source: { kind: 'current', key: original }, destination })) }))
  assert.deepEqual(copied.snapshot.bindings.map(item => item.target), [before.bindings[0].target, before.bindings[0].target])
  const current = copied.snapshot.bindings.map(bindingKey)
  const valid: SyncedBindingClaim[] = current.map((destination, index) => ({ kind: 'continue', source: current[index], destination }))
  for (const claims of [[], [valid[0]], [...valid, valid[0]], [{ ...valid[0], destination: { ...current[0], from: 0, to: 9 } }, valid[1]],
    [{ kind: 'continue', source: current[0], destination: current[0] }, { kind: 'continue', source: current[0], destination: current[1] }],
    [{ kind: 'copy', source: { kind: 'current', key: { ...current[0], raw: 'forged' } }, destination: current[0] }, valid[1]],
    [{ kind: 'new', destination: current[0], target: { kind: 'document', id: host, state: 'live' } }, valid[1]]]) {
    invalidWithoutWrites(db, repeated, claims)
  }
  const changed = [{ ...repeated[0], content: '[one](Renamed.md)' }], destination = keys(db, changed)[0]
  invalidWithoutWrites(db, changed, [{ kind: 'continue', source: current[0], destination }])
  const wiki = [{ ...repeated[0], content: '[[Target.md]]' }]
  invalidWithoutWrites(db, wiki, [{ kind: 'copy', source: { kind: 'current', key: current[0] }, destination: keys(db, wiki)[0] }])
  // The raw escape changes, but the actual parser-decoded address is identical.
  const encoded = [{ ...repeated[0], content: '[escaped](Target&#46;md)' }]
  const result = saved(updateSyncedBlockGroup(db, { ...update(db, edits(encoded)), bindingClaims: [
    { kind: 'continue', source: current[0], destination: keys(db, encoded)[0] }
  ] }))
  assert.deepEqual(result.snapshot.bindings[0].target, before.bindings[0].target)
}))

test('whole-forest reference definitions and table destinations require their exact UTF16 parser ranges', () => withDatabase(db => {
  const before = seed(db, '\uFEFF🙂\r\n[use][ref]\r\n\r\n[ref]: Target.md\r\n\r\n| Label | Value |\r\n| --- | --- |\r\n| A | [table](Target.md) |')
  assert.equal(before.bindings.length, 2, 'Only the active definition and actual table link have destinations')
  const changed = [{ ...before.blocks[0], content: 'prefix\r\n' + before.blocks[0].content + '\r\nsuffix' }]
  const destinations = keys(db, changed)
  assert.equal(destinations.length, 2)
  const accepted = saved(updateSyncedBlockGroup(db, { ...update(db, edits(changed)), bindingClaims: destinations.map((destination, index) =>
    ({ kind: 'continue', source: bindingKey(before.bindings[index]), destination })) }))
  assert.deepEqual(accepted.snapshot.bindings.map(item => item.target), before.bindings.map(item => item.target))
  for (const binding of accepted.snapshot.bindings) assert.equal(changed[0].content.slice(binding.from, binding.to), binding.raw)
  const literal = [{ ...changed[0], content: 'Target.md is plain text' }]
  invalidWithoutWrites(db, literal, [{ kind: 'copy', source: { kind: 'current', key: bindingKey(accepted.snapshot.bindings[0]) },
    destination: { blockId: literal[0].id, from: 0, to: 9, raw: 'Target.md', syntax: 'markdown' } }])
}))

test('empty destinations copy by their exact parser points and explicit new claims resolve fresh same-candidate block IDs', () => withDatabase(db => {
  const before = seed(db, '[self]()'), original = bindingKey(before.bindings[0])
  const copies = [{ ...before.blocks[0], content: '[first]() [second](<>)' }]
  const destinations = keys(db, copies)
  assert.equal(destinations.length, 2)
  assert.ok(destinations.every(item => item.from === item.to && item.raw === ''))
  const result = saved(updateSyncedBlockGroup(db, { ...update(db, edits(copies)), bindingClaims: destinations.map(destination =>
    ({ kind: 'copy', source: { kind: 'current', key: original }, destination })) }))
  assert.deepEqual(result.snapshot.bindings.map(item => item.target), [before.bindings[0].target, before.bindings[0].target])
  const fresh = [paragraph('__proto__', '[self](#^__proto__) [cross](#^constructor)'), paragraph('constructor', 'Second block')]
  const accepted = saved(updateSyncedBlockGroup(db, { ...update(db, edits(fresh)), bindingClaims: keys(db, fresh).map(destination => ({ kind: 'new', destination })) }))
  assert.deepEqual(accepted.snapshot.bindings.map(item => item.target), [
    { kind: 'block', id: '__proto__', documentId: null, state: 'live' },
    { kind: 'block', id: 'constructor', documentId: null, state: 'live' }
  ])
}))

test('initial snapshot tickets survive cut-save-paste, later ACKs, target rename and real Redo pruning without retargeting', () => withDatabase(db => {
  const initial = seed(db), ticket = source(db), entry = ticket.entries[0]
  assert.equal((db.prepare('SELECT count(*) AS n FROM synced_operations').get() as { n: number }).n, 0, 'Initial source has no prior operation')
  const cut = [{ ...initial.blocks[0], content: 'Cut body' }]
  saved(updateSyncedBlockGroup(db, { ...update(db, edits(cut)), bindingClaims: [] }))
  saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
  saved(updateSyncedBlockGroup(db, { ...update(db, edits([{ ...cut[0], content: 'A different branch' }])), bindingClaims: [] }))
  assert.equal(snapshot(db).history.redoToken, null)
  const replacement = newTarget(db), pasted = [{ ...initial.blocks[0], content: '\uFEFF🙂\r\n[paste](Target.md) [again](Target.md)' }]
  const input = { ...update(db, edits(pasted)), bindingClaims: keys(db, pasted).map(destination => ({
    kind: 'copy' as const, source: { kind: 'ticket' as const, ticketId: ticket.ticketId, entryId: entry.entryId }, destination
  })) }
  const accepted = saved(updateSyncedBlockGroup(db, input))
  assert.deepEqual(accepted.snapshot.bindings.map(item => item.target), [initial.bindings[0].target, initial.bindings[0].target])
  assert.notEqual((accepted.snapshot.bindings[0].target as { id: string }).id, replacement)
  saved(updateSyncedBlockGroup(db, update(db, edits([{ ...pasted[0], content: 'later body' }]))))
  const frozen = state(db)
  db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
  const recovered = state(db)
  // The committed request must replay its exact old ACK before looking at expired tickets or stale CAS.
  assert.deepEqual(saved(updateSyncedBlockGroup(db, input)), { ...accepted, replayed: true })
  assert.deepEqual(state(db), recovered)
  assert.throws(() => resolveSyncedBindingSource(db, ticket.ticketId, entry.entryId), /重启或恢复/)
  assert.notDeepEqual(recovered.synced_workspace_state, frozen.synced_workspace_state)
  invalidWithoutWrites(db, pasted, input.bindingClaims)
}))

test('ticket facts are private clones, reusable across source groups and not capabilities to inject targets', () => withDatabase(db => {
  const before = seed(db), item = read(db).items[0]
  assert.ok(item.status === 'ready')
  const captured = structuredClone(item.bindingSource), entry = captured.entries[0]
  item.snapshot.bindings[0].target = { kind: 'document', id: host, state: 'live' }
  item.bindingSource.entries[0].key.raw = 'mutated caller'
  const returned = resolveSyncedBindingSource(db, captured.ticketId, entry.entryId)
  assert.deepEqual(returned.target, before.bindings[0].target)
  returned.target = { kind: 'document', id: host, state: 'live' }
  assert.deepEqual(resolveSyncedBindingSource(db, captured.ticketId, entry.entryId).target, before.bindings[0].target)
  const otherGroup = uuid(20)
  createGroup(db, otherGroup, [paragraph('other-canonical', 'Empty destination')])
  addInstance(db, uuid(300), otherGroup)
  const origin = { ...snapshot(db, otherGroup).origin, documentId: other, pathAtCreation: 'Elsewhere/Context' }
  db.prepare('UPDATE synced_groups SET origin_json=? WHERE id=?').run(JSON.stringify(origin), otherGroup)
  const destinationBefore = snapshot(db, otherGroup), destinationBlocks = [{ ...destinationBefore.blocks[0], content: '[destination](Target.md)' }]
  const destination = keys(db, destinationBlocks, destinationBefore)[0]
  const resolved = resolveSyncedBindingSource(db, captured.ticketId, entry.entryId)
  assert.equal(resolved.key.raw, entry.key.raw)
  // Registry resolution itself has no mutation, and uses the selected old target rather than the new origin.
  const stable = state(db)
  assert.deepEqual(resolveSyncedBindingSource(db, captured.ticketId, entry.entryId), resolved)
  assert.deepEqual(state(db), stable)
  assert.equal(destination.raw, entry.key.raw)
  const instance = destinationBefore.instances[0]
  const accepted = saved(updateSyncedBlockGroup(db, { ...update(db, edits(destinationBlocks)), groupId: otherGroup,
    expectedRevision: destinationBefore.revision, expectedTopologyRevision: destinationBefore.topologyRevision,
    expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
    bindingClaims: [{ kind: 'copy', source: { kind: 'ticket', ticketId: captured.ticketId, entryId: entry.entryId }, destination }] }))
  assert.deepEqual(accepted.snapshot.bindings[0].target, before.bindings[0].target)
  assert.deepEqual(accepted.snapshot.origin, origin)
  assert.deepEqual(keys(db, destinationBlocks, destinationBefore), [destination])
  assert.throws(() => resolveSyncedBindingSource(db, captured.ticketId, randomUUID()), /失效/)
  assert.throws(() => resolveSyncedBindingSource(db, randomUUID(), entry.entryId), /失效/)
}))

test('tickets reject other real connections and recovery epochs even for the same database/workspace', () => withTwoClients((a, b) => {
  seed(a)
  const ticket = source(a), entry = ticket.entries[0], before = state(b)
  assert.throws(() => resolveSyncedBindingSource(b, ticket.ticketId, entry.entryId), /失效/)
  const blocks = [{ ...snapshot(b).blocks[0], content: 'different [old](Target.md) sides' }]
  invalidWithoutWrites(b, blocks, [{ kind: 'copy', source: { kind: 'ticket', ticketId: ticket.ticketId, entryId: entry.entryId }, destination: keys(b, blocks)[0] }])
  assert.deepEqual(state(b), before)
  assert.deepEqual(resolveSyncedBindingSource(a, ticket.ticketId, entry.entryId).target, { kind: 'document', id: other, state: 'live' })
  a.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
  assert.throws(() => resolveSyncedBindingSource(a, ticket.ticketId, entry.entryId), /失效/)
}))

test('ticket copies retain an exact retired block target without reclaiming its owner or creation metadata', () => withDatabase(db => {
  ordinary(db, ' target:旧块 ', { owner: other, type: 'paragraph' })
  // URL encoding keeps the historical opaque ID's original surrounding spaces.
  const initial = seed(db, '[block](Target.md#^%20target%3A旧块%20)'), ticket = source(db), entry = ticket.entries[0]
  assert.deepEqual(initial.bindings[0].target, { kind: 'block', id: ' target:旧块 ', documentId: other, state: 'live' })
  db.prepare('DELETE FROM blocks WHERE id=?').run(' target:旧块 ')
  const retained = db.prepare('SELECT * FROM block_identities WHERE id=?').get(' target:旧块 ')
  const copied = [{ ...initial.blocks[0], content: 'both [copy](Target.md#^%20target%3A旧块%20) sides' }]
  const result = saved(updateSyncedBlockGroup(db, { ...update(db, edits(copied)), bindingClaims: [
    { kind: 'copy', source: { kind: 'ticket', ticketId: ticket.ticketId, entryId: entry.entryId }, destination: keys(db, copied)[0] }
  ] }))
  assert.deepEqual(result.snapshot.bindings[0].target, initial.bindings[0].target)
  assert.deepEqual(db.prepare('SELECT * FROM block_identities WHERE id=?').get(' target:旧块 '), retained)
  assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id=?').get(' target:旧块 '), undefined)
  assert.equal(db.prepare('SELECT 1 FROM synced_group_blocks WHERE id=?').get(' target:旧块 '), undefined)
}))

test('source signing validates complete parser coverage and ledger in an owned read without issuing uncommitted capabilities', () => withDatabase(db => {
  seed(db)
  const ticket = source(db), before = state(db)
  assert.throws(() => db.transaction(() => {
    db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run('[uncommitted](Changed.md)', groupId)
    read(db)
  })(), /独占只读事务/)
  assert.deepEqual(state(db), before)
  assert.equal(read(db).items[0].status, 'ready')
  assert.deepEqual(source(db), ticket, 'Repeated identical source reads reuse the same source ticket')
  db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run('[]', groupId)
  const corrupt = state(db)
  assert.throws(() => read(db), SyncedValidationError)
  assert.deepEqual(state(db), corrupt)
  // A missing block ledger target must never use the candidate-only missing-ledger exemption.
  const current = snapshot(db), fake = captureSyncedGroupBindings(db, current.origin, current.blocks)
  fake[0].target = { kind: 'block', id: 'never-registered', documentId: null, state: 'live' }
  db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(fake), groupId)
  assert.throws(() => read(db), /保留身份/)
  assert.deepEqual(resolveSyncedBindingSource(db, ticket.ticketId, ticket.entries[0].entryId).target, { kind: 'document', id: other, state: 'live' })
}))

test('a failed content transaction does not consume a ticket and retry preserves the exact source after SQL rollback', () => withDatabase(db => {
  const initial = seed(db), ticket = source(db), blocks = [{ ...initial.blocks[0], content: 'both [old](Target.md) sides' }]
  const bindingClaims: SyncedBindingClaim[] = [{ kind: 'copy', source: { kind: 'ticket', ticketId: ticket.ticketId, entryId: ticket.entries[0].entryId }, destination: keys(db, blocks)[0] }]
  const input = { ...update(db, edits(blocks)), bindingClaims }
  db.exec(`CREATE TRIGGER fail_claim_receipt BEFORE INSERT ON synced_operations BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END`)
  const before = state(db)
  assert.throws(() => updateSyncedBlockGroup(db, input), /fixture receipt failure/)
  assert.deepEqual(state(db), before)
  assert.deepEqual(resolveSyncedBindingSource(db, ticket.ticketId, ticket.entries[0].entryId).target, initial.bindings[0].target)
  db.exec('DROP TRIGGER fail_claim_receipt')
  const result = saved(updateSyncedBlockGroup(db, input))
  assert.deepEqual(result.snapshot.bindings[0].target, initial.bindings[0].target)
  assert.deepEqual(saved(updateSyncedBlockGroup(db, input)), { ...result, replayed: true })
}))

test('a full source registry rejects a whole new batch without evicting existing clipboard sources', () => withDatabase(db => {
  seed(db)
  const ticket = source(db), ids = Array.from({ length: SYNCED_BINDING_SOURCE_LIMITS.tickets }, (_, index) => uuid(2000 + index))
  db.transaction(() => ids.forEach((id, index) => createGroup(db, id, [paragraph(`capacity-${index}`)])))()
  const before = state(db)
  assert.throws(() => read(db, ids), /容量已满/)
  assert.deepEqual(state(db), before)
  assert.equal(read(db, ids.slice(1)).items.length, SYNCED_BINDING_SOURCE_LIMITS.tickets - 1, 'Failed batch reserves no capacity')
  assert.throws(() => read(db, [ids[0]]), /容量已满/)
  assert.deepEqual(resolveSyncedBindingSource(db, ticket.ticketId, ticket.entries[0].entryId).target, { kind: 'document', id: other, state: 'live' })
  assert.deepEqual(source(db), ticket)
  assert.deepEqual(state(db), before)
}))
