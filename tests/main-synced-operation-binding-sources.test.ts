import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedBindingKey, SyncedCanonicalWire, SyncedGroupSaved, SyncedGroupSnapshot } from '../src/shared/synced-blocks'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { getSyncedOperationWithLinkSource, getSyncedGroupSnapshotsWithLinkSources,
  resolveSyncedBindingSource, SYNCED_BINDING_SOURCE_LIMITS } from '../src/main/database/synced-binding-sources'
import { getSyncedOperation, updateSyncedBlockGroup, restoreSyncedGroupOperation } from '../src/main/database/synced-blocks-content'
import { born, now, other, groupId, uuid, paragraph, edits, createGroup, ordinary, withDatabase, withTwoClients,
  snapshot, update, restore, saved, state } from './helpers/synced-content-fixture'

const key = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
function totalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
}
function readOnly<T>(db: Database.Database, run: () => T): T {
  const before = state(db), changes = totalChanges(db)
  try { return run() }
  finally {
    assert.equal(totalChanges(db), changes, 'A source read issues no SQL mutation, including rolled-back DML')
    assert.deepEqual(state(db), before, 'Every persistent table keeps its exact contents')
    assert.equal(db.inTransaction, false)
  }
}
function seed(db: Database.Database, content = '[old](Target.md)'): SyncedGroupSnapshot {
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Target', 'Original/Target', other)
  const before = snapshot(db), blocks = [{ ...before.blocks[0], content }]
  const bindings = captureSyncedGroupBindings(db, before.origin, blocks)
  db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run(content, groupId)
  db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(bindings), groupId)
  return snapshot(db)
}
function saveBody(db: Database.Database, content: string) {
  const before = snapshot(db), blocks = [{ ...before.blocks[0], content }]
  const destinations = captureSyncedGroupBindings(db, before.origin, blocks).map(key)
  const input = { ...update(db, edits(blocks)), bindingClaims: destinations.map(destination => ({ kind: 'new' as const, destination })) }
  return { input, ack: saved(updateSyncedBlockGroup(db, input)) }
}
function operationSource(db: Database.Database, ack: SyncedGroupSaved) {
  const result = readOnly(db, () => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId }))
  assert.equal(result.status, 'committed')
  if (result.status !== 'committed') throw new Error('Expected a real committed operation source')
  assert.equal(result.workspaceScope, uuid(900))
  assert.deepEqual(result.result, { ...ack, replayed: true }, 'The original stored ACK is never hydrated from the current group')
  return result
}
function currentSource(db: Database.Database, ids = [groupId]) {
  return getSyncedGroupSnapshotsWithLinkSources(db, { groupIds: ids })
}
function replacement(db: Database.Database): string {
  db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed', 'Original/Renamed', other)
  const id = randomUUID()
  db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'Target', id, 'Original/Target', born, now)
  return id
}
function copyFrom(db: Database.Database, content: string, source: ReturnType<typeof operationSource>) {
  const before = snapshot(db), blocks = [{ ...before.blocks[0], content }]
  const destinations = captureSyncedGroupBindings(db, before.origin, blocks).map(key), entry = source.bindingSource.entries[0]
  assert.ok(entry)
  return saved(updateSyncedBlockGroup(db, { ...update(db, edits(blocks)), bindingClaims: destinations.map(destination => ({
    kind: 'copy' as const, source: { kind: 'ticket' as const, ticketId: source.bindingSource.ticketId, entryId: entry.entryId }, destination
  })) }))
}

test('operation source accepts only a closed UUID lookup and unknown never creates a receipt or ticket', () => withDatabase(db => {
  seed(db)
  const known = saveBody(db, '[committed](Target.md)').ack, source = operationSource(db, known)
  assert.deepEqual(readOnly(db, () => getSyncedOperationWithLinkSource(db, { clientOperationId: randomUUID() })), { status: 'unknown' })
  for (const input of [null, {}, { clientOperationId: 'bad' }, { clientOperationId: known.operationId, snapshot: known.snapshot },
    { clientOperationId: known.operationId, target: known.snapshot.bindings[0].target }]) {
    assert.throws(() => readOnly(db, () => getSyncedOperationWithLinkSource(db, input)), SyncedValidationError)
  }
  assert.deepEqual(operationSource(db, known), source)
}))

test('saved and noop operation sources return exact original ACKs after later writes and lost delivery, with private reusable facts', () => withDatabase(db => {
  seed(db)
  const original = saveBody(db, '[committed](Target.md)'), noop = saveBody(db, '[committed](Target.md)')
  assert.equal(original.ack.status, 'saved'); assert.equal(noop.ack.status, 'noop')
  const captured = operationSource(db, original.ack), current = currentSource(db).items[0]
  assert.equal(current.status, 'ready')
  if (current.status !== 'ready') throw new Error('fixture')
  assert.deepEqual(current.bindingSource, captured.bindingSource, 'Both APIs share the same semantic ticket')
  const untouched = structuredClone(captured)
  captured.bindingSource.entries[0].key.raw = 'caller mutation'
  captured.result.snapshot.blocks[0].content = 'caller mutation'
  assert.deepEqual(operationSource(db, original.ack), untouched)
  assert.deepEqual(operationSource(db, noop.ack).bindingSource, untouched.bindingSource)
  // Deliberately discard the next committed ACK as an IPC loss would; lookup
  // still reads its real persisted row, with no synthetic saved result.
  const lost = saveBody(db, '[lost delivery](Target.md)').ack
  saveBody(db, 'A later committed body')
  operationSource(db, original.ack); operationSource(db, noop.ack); operationSource(db, lost)
  const before = state(db)
  assert.deepEqual(saved(updateSyncedBlockGroup(db, original.input)), { ...original.ack, replayed: true })
  assert.deepEqual(state(db), before)
}))

test('a historical same-body operation source restores T1 after the identical current key was explicitly rebound to T2', () => withDatabase(db => {
  seed(db)
  const first = saveBody(db, '[same](Target.md)'), nextTarget = replacement(db)
  const second = saveBody(db, '[same](Target.md)')
  assert.deepEqual(first.ack.snapshot.blocks, second.ack.snapshot.blocks)
  assert.deepEqual(first.ack.snapshot.bindings[0].target, { kind: 'document', id: other, state: 'live' })
  assert.deepEqual(second.ack.snapshot.bindings[0].target, { kind: 'document', id: nextTarget, state: 'live' })
  const source = operationSource(db, first.ack), restored = copyFrom(db, '[same](Target.md)', source)
  assert.deepEqual(restored.snapshot.bindings[0].target, first.ack.snapshot.bindings[0].target)
  assert.notEqual(operationSource(db, second.ack).bindingSource.ticketId, source.bindingSource.ticketId)
  const frozen = state(db)
  assert.deepEqual(saved(updateSyncedBlockGroup(db, first.input)), { ...first.ack, replayed: true })
  assert.deepEqual(state(db), frozen)
}))

test('old operation sources preserve renamed reused and deleted document or retained block targets without reclaiming identities', () => {
  for (const kind of ['document', 'block'] as const) withDatabase(db => {
    const opaque = ' target:旧块 ', href = kind === 'document' ? 'Target.md' : 'Target.md#^%20target%3A旧块%20'
    if (kind === 'block') ordinary(db, opaque, { owner: other, type: 'paragraph' })
    seed(db, `[old](${href})`)
    const original = saveBody(db, `[committed](${href})`).ack
    replacement(db)
    if (kind === 'block') db.prepare('DELETE FROM blocks WHERE id=?').run(opaque)
    else db.prepare('DELETE FROM documents WHERE id=?').run(other)
    const before = state(db), source = operationSource(db, original)
    assert.deepEqual(state(db), before)
    const restored = copyFrom(db, `prefix [copy](${href}) suffix`, source)
    assert.deepEqual(restored.snapshot.bindings[0].target, original.snapshot.bindings[0].target)
    assert.deepEqual(state(db).block_identities, before.block_identities)
    assert.deepEqual(state(db).document_block_routes, before.document_block_routes)
    assert.deepEqual(state(db).documents, before.documents)
    if (kind === 'block') {
      assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id=?').get(opaque), undefined)
      assert.equal(db.prepare('SELECT 1 FROM synced_group_blocks WHERE id=?').get(opaque), undefined)
    }
  })
})

test('source signing uses the durable operation after-side even after its executable Redo row was pruned', () => withDatabase(db => {
  seed(db)
  const original = saveBody(db, '[committed](Target.md)').ack
  const token = original.snapshot.history.undoToken
  assert.ok(token)
  saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
  saveBody(db, 'A fresh branch without links')
  assert.equal(db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(token), undefined)
  const source = operationSource(db, original)
  assert.deepEqual(copyFrom(db, '[copy](Target.md)', source).snapshot.bindings[0].target, original.snapshot.bindings[0].target)
  operationSource(db, original)
}))

test('two persistent SQLite clients sign connection-local tickets for the same actual stored operation', () => withTwoClients((a, b) => {
  seed(a)
  const ack = saveBody(a, '[committed](Target.md)').ack, left = operationSource(a, ack), right = operationSource(b, ack)
  assert.notEqual(left.bindingSource.ticketId, right.bindingSource.ticketId)
  const entry = left.bindingSource.entries[0], rightEntry = right.bindingSource.entries[0]
  assert.throws(() => readOnly(b, () => resolveSyncedBindingSource(b, left.bindingSource.ticketId, entry.entryId)), /失效/)
  assert.deepEqual(resolveSyncedBindingSource(a, left.bindingSource.ticketId, entry.entryId).target, ack.snapshot.bindings[0].target)
  assert.deepEqual(resolveSyncedBindingSource(b, right.bindingSource.ticketId, rightEntry.entryId).target, ack.snapshot.bindings[0].target)
}))

test('recovery epochs invalidate old tickets and an explicit new capture never resurrects the original capability', () => withDatabase(db => {
  seed(db)
  const ack = saveBody(db, '[committed](Target.md)').ack, first = operationSource(db, ack), entry = first.bindingSource.entries[0]
  db.prepare('UPDATE synced_workspace_state SET recovery_epoch=? WHERE singleton=1').run(randomUUID())
  assert.throws(() => readOnly(db, () => resolveSyncedBindingSource(db, first.bindingSource.ticketId, entry.entryId)), /失效/)
  const next = operationSource(db, ack)
  assert.notEqual(next.bindingSource.ticketId, first.bindingSource.ticketId)
  assert.deepEqual(next.result, first.result)
  const nextEntry = next.bindingSource.entries[0]
  assert.deepEqual(resolveSyncedBindingSource(db, next.bindingSource.ticketId, nextEntry.entryId).target, ack.snapshot.bindings[0].target)
  assert.throws(() => resolveSyncedBindingSource(db, first.bindingSource.ticketId, entry.entryId), /失效/)
}))

test('both source APIs share count capacity and preserve all-or-none batch publication and full-capacity reuse', () => withDatabase(db => {
  seed(db)
  const ack = saveBody(db, '[old](Target.md) committed').ack
  saveBody(db, 'Current source has no link')
  const keeper = currentSource(db), ids = Array.from({ length: SYNCED_BINDING_SOURCE_LIMITS.tickets }, (_, index) => uuid(4000 + index))
  db.transaction(() => ids.forEach((id, index) => createGroup(db, id, [paragraph(`capacity-${index}`)])))()
  readOnly(db, () => currentSource(db, ids.slice(0, -2)))
  assert.throws(() => readOnly(db, () => currentSource(db, ids.slice(-2))), /容量已满/)
  const finalSlot = operationSource(db, ack)
  assert.throws(() => readOnly(db, () => currentSource(db, [ids.at(-1)!])), /容量已满/)
  assert.deepEqual(operationSource(db, ack), finalSlot, 'A failed batch consumed no slot and repeated digest still succeeds when full')
  assert.deepEqual(readOnly(db, () => currentSource(db)), keeper)
}))

test('both APIs share the actual byte capacity without lowering limits or evicting prior sources', () => withDatabase(db => {
  seed(db)
  const tail = 'x'.repeat(500_000), ack = saveBody(db, `[large](Missing-${tail}-operation.md)`).ack
  saveBody(db, 'Small current source')
  const keeper = currentSource(db), origin = snapshot(db).origin
  let full = false, successful = 0
  for (let index = 0; index < 64; index++) {
    const id = uuid(6000 + index), blocks: SyncedCanonicalWire[] = [paragraph(`large-${index}`, `[large](Missing-${tail}-${index}.md)`)]
    const bindings = captureSyncedGroupBindings(db, origin, blocks)
    createGroup(db, id, blocks, bindings)
    try { currentSource(db, [id]); successful++ }
    catch (error) {
      assert.ok(error instanceof SyncedValidationError); assert.match(error.message, /容量已满/)
      full = true; break
    }
  }
  assert.ok(full); assert.ok(successful > 0 && successful < SYNCED_BINDING_SOURCE_LIMITS.tickets)
  assert.throws(() => readOnly(db, () => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId })), /容量已满/)
  assert.deepEqual(readOnly(db, () => currentSource(db)), keeper)
}))

test('malformed receipts unsupported envelopes and invalid AST or target-ledger coverage cannot publish a historical source', () => {
  const mutations: Array<(ack: SyncedGroupSaved) => unknown> = [
    ack => ({ ...ack, replayed: true }), ack => ({ ...ack, operationId: randomUUID() }), ack => ({ ...ack, extra: true }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, revision: 'not-uuid' } }),
    ack => ({ status: 'applied', operationId: ack.operationId, snapshot: ack.snapshot, replayed: false }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, bindings: [] } }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, bindings: [...ack.snapshot.bindings, ...ack.snapshot.bindings] } }),
    ack => ({ ...ack, snapshot: { ...ack.snapshot, bindings: ack.snapshot.bindings.map(binding => ({ ...binding,
      target: { kind: 'block', id: 'never-in-ledger', documentId: null, state: 'live' } })) } })
  ]
  for (const mutate of mutations) withDatabase(db => {
    seed(db)
    const ack = saveBody(db, '[committed](Target.md)').ack, prior = operationSource(db, ack), entry = prior.bindingSource.entries[0]
    db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(JSON.stringify(mutate(ack)), ack.operationId)
    assert.throws(() => readOnly(db, () => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId })))
    assert.deepEqual(resolveSyncedBindingSource(db, prior.bindingSource.ticketId, entry.entryId).target, ack.snapshot.bindings[0].target)
  })
  for (const invalidField of ['hash', 'json'] as const) withDatabase(db => {
    seed(db)
    const ack = saveBody(db, '[committed](Target.md)').ack
    if (invalidField === 'hash') db.prepare('UPDATE synced_operations SET request_hash=? WHERE client_operation_id=?').run('bad', ack.operationId)
    else {
      db.pragma('ignore_check_constraints=ON')
      try { db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run('{', ack.operationId) }
      finally { db.pragma('ignore_check_constraints=OFF') }
    }
    assert.throws(() => readOnly(db, () => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId })), /收据损坏/)
  })
})

test('owned source reads reject outer read or write transactions before signing an uncommitted receipt', () => withDatabase(db => {
  seed(db)
  const ack = saveBody(db, '[committed](Target.md)').ack, source = operationSource(db, ack), before = state(db)
  assert.throws(() => db.transaction(() => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId }))(), /独占只读事务/)
  const fakeId = randomUUID()
  assert.throws(() => db.transaction(() => {
    db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
      .run(fakeId, 'a'.repeat(64), JSON.stringify({ ...ack, operationId: fakeId }), now)
    getSyncedOperationWithLinkSource(db, { clientOperationId: fakeId })
  }).immediate(), /独占只读事务/)
  assert.deepEqual(state(db), before)
  assert.deepEqual(readOnly(db, () => getSyncedOperationWithLinkSource(db, { clientOperationId: fakeId })), { status: 'unknown' })
  assert.deepEqual(operationSource(db, ack), source)
}))

test('query-only SQLite accepts unknown saved and noop source reads with no table changes or new schema', () => withDatabase(db => {
  seed(db)
  const savedAck = saveBody(db, '[committed](Target.md)').ack, noopAck = saveBody(db, '[committed](Target.md)').ack
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
  db.pragma('query_only=ON')
  try {
    const source = operationSource(db, savedAck)
    assert.deepEqual(operationSource(db, noopAck).bindingSource, source.bindingSource)
    assert.deepEqual(readOnly(db, () => getSyncedOperationWithLinkSource(db, { clientOperationId: randomUUID() })), { status: 'unknown' })
    assert.deepEqual(readOnly(db, () => getSyncedOperation(db, { clientOperationId: savedAck.operationId })),
      { status: 'committed', result: { ...savedAck, replayed: true } })
    const current = readOnly(db, () => currentSource(db)).items[0]
    assert.ok(current.status === 'ready')
    assert.deepEqual(current.bindingSource, source.bindingSource)
    assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(), schema)
  } finally { db.pragma('query_only=OFF') }
}))
