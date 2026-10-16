import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { getSyncedOperation, restoreSyncedGroupOperation, updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { born, now, host, other, groupId, instanceId, uuid, paragraph, edits, createGroup, ordinary, addInstance,
  withDatabase, withTwoClients, snapshot, update, restore, saved, state } from './helpers/synced-content-fixture'

test('two persistent SQLite clients race the same real group CAS: one commits and the other preserves all tables on conflict', () => withTwoClients((a, b) => {
  const first = update(a, [{ ...edits(snapshot(a).blocks)[0], content: 'Winner' }])
  const stale = update(b, [{ ...edits(snapshot(b).blocks)[0], content: 'Loser' }])
  const hostBefore = a.prepare('SELECT * FROM documents ORDER BY id').all(), instanceBefore = a.prepare('SELECT * FROM synced_instances').all()
  const accepted = saved(updateSyncedBlockGroup(a, first))
  assert.equal(accepted.status, 'saved'); assert.equal(accepted.replayed, false)
  assert.notEqual(accepted.snapshot.revision, first.expectedRevision)
  assert.equal(accepted.snapshot.topologyRevision, first.expectedTopologyRevision)
  const before = state(b), rejected = updateSyncedBlockGroup(b, stale)
  assert.ok(rejected.status === 'conflict' && rejected.kind === 'group')
  assert.deepEqual(state(b), before)
  assert.equal(snapshot(b).blocks[0].content, 'Winner')
  assert.deepEqual(b.prepare('SELECT * FROM documents ORDER BY id').all(), hostBefore)
  assert.deepEqual(b.prepare('SELECT * FROM synced_instances').all(), instanceBefore)
  assert.equal(a.inTransaction, false); assert.equal(b.inTransaction, false)
}))

test('a committed lost ACK replays the stored old snapshot after later writes, while cross-method and changed requests cannot reuse its ID', () => withTwoClients((a, b) => {
  const input = update(a, [{ ...edits(snapshot(a).blocks)[0], content: 'B' }]), first = saved(updateSyncedBlockGroup(a, input))
  const oldSnapshot = structuredClone(first.snapshot)
  saved(updateSyncedBlockGroup(a, update(a, [{ ...edits(snapshot(a).blocks)[0], content: 'C' }])))
  const before = state(b), repeated = saved(updateSyncedBlockGroup(b, input))
  assert.deepEqual(repeated, { ...first, replayed: true })
  assert.deepEqual(repeated.snapshot, oldSnapshot)
  assert.notEqual(repeated.snapshot.revision, snapshot(b).revision)
  assert.deepEqual(getSyncedOperation(b, { clientOperationId: input.clientOperationId }), { status: 'committed', result: repeated })
  assert.deepEqual(updateSyncedBlockGroup(b, { ...input, blocks: [{ ...input.blocks[0], content: 'Different' }] }), { status: 'idempotency-mismatch' })
  assert.deepEqual(restoreSyncedGroupOperation(b, restore(b, 'undo', input.clientOperationId)), { status: 'idempotency-mismatch' })
  assert.deepEqual(getSyncedOperation(b, { clientOperationId: randomUUID() }), { status: 'unknown' })
  assert.deepEqual(state(b), before)
}))

test('corrupt stored receipts fail closed rather than becoming unknown or re-executing a committed operation', () => {
  for (const corruption of ['duplicate-key', 'wrong-operation', 'invalid-snapshot', 'replayed-in-storage', 'invalid-hash']) withDatabase(db => {
    const input = update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'B' }]), result = saved(updateSyncedBlockGroup(db, input))
    const changed = corruption === 'wrong-operation' ? { ...result, operationId: randomUUID() }
      : corruption === 'invalid-snapshot' ? { ...result, snapshot: { ...result.snapshot, revision: 'not-a-uuid' } }
        : corruption === 'replayed-in-storage' ? { ...result, replayed: true } : result
    const source = JSON.stringify(changed)
    db.prepare('UPDATE synced_operations SET result_json=?,request_hash=CASE WHEN ? THEN ? ELSE request_hash END WHERE client_operation_id=?')
      .run(corruption === 'duplicate-key' ? '{"status":"saved",' + source.slice(1) : source, corruption === 'invalid-hash' ? 1 : 0, 'bad', input.clientOperationId)
    const before = state(db)
    assert.throws(() => getSyncedOperation(db, { clientOperationId: input.clientOperationId }), /收据损坏/)
    assert.throws(() => updateSyncedBlockGroup(db, input), /收据损坏/)
    assert.deepEqual(state(db), before)
  })
})

test('noop commits only its receipt and preserves the exact Undo cursor and Redo branch; a new content edit alone truncates Redo', () => withDatabase(db => {
  const b = saved(updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'B' }])))
  saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
  const before = snapshot(db), history = db.prepare('SELECT * FROM synced_group_history ORDER BY position').all()
  const noop = saved(updateSyncedBlockGroup(db, update(db)))
  assert.equal(noop.status, 'noop'); assert.deepEqual(noop.snapshot, before)
  assert.deepEqual(db.prepare('SELECT * FROM synced_group_history ORDER BY position').all(), history)
  assert.equal(saved(restoreSyncedGroupOperation(db, restore(db, 'redo'))).snapshot.blocks[0].content, 'B')
  saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
  const oldRedo = restore(db, 'redo')
  saved(updateSyncedBlockGroup(db, update(db, [{ ...edits(before.blocks)[0], content: 'C' }])))
  const final = snapshot(db)
  assert.equal(final.history.redoToken, null)
  assert.notEqual(final.history.undoToken, b.snapshot.history.undoToken)
  assert.equal(db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(b.snapshot.history.undoToken), undefined)
  const stable = state(db), refused = restoreSyncedGroupOperation(db, oldRedo)
  assert.equal(refused.status, 'conflict'); assert.deepEqual(state(db), stable)
}))

test('consecutive group Undo and Redo follow exact sides and fresh cursors without adding journal rows', () => withDatabase(db => {
  const revisions = new Set([snapshot(db).revision]), cursors = new Set([snapshot(db).history.cursor])
  for (const content of ['B', 'C']) {
    const result = saved(updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], content }])))
    revisions.add(result.snapshot.revision); cursors.add(result.snapshot.history.cursor)
  }
  for (const [direction, content] of [['undo', 'B'], ['undo', 'A'], ['redo', 'B'], ['redo', 'C']] as const) {
    const result = saved(restoreSyncedGroupOperation(db, restore(db, direction)))
    assert.equal(result.snapshot.blocks[0].content, content)
    revisions.add(result.snapshot.revision); cursors.add(result.snapshot.history.cursor)
  }
  assert.equal(revisions.size, 7); assert.equal(cursors.size, 7)
  assert.equal((db.prepare('SELECT count(*) AS count FROM synced_group_history').get() as { count: number }).count, 2)
}))

test('the current tail token, history side, cursor and instance lease are checked before any historical write', () => withDatabase(db => {
  saved(updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'B' }])))
  const undo = restore(db, 'undo'), before = state(db)
  for (const invalid of [{ ...undo, historyToken: randomUUID() }, { ...undo, expectedHistoryCursor: randomUUID() },
    { ...undo, expectedInstanceBinding: { ...undo.expectedInstanceBinding, hostDocumentId: other } }]) {
    assert.equal(restoreSyncedGroupOperation(db, invalid).status, 'conflict')
    assert.deepEqual(state(db), before)
  }
  db.prepare('UPDATE synced_group_history SET before_hash=? WHERE id=?').run('0'.repeat(64), undo.historyToken)
  const corrupted = state(db)
  assert.throws(() => restoreSyncedGroupOperation(db, undo), /历史内容或校验值损坏/)
  assert.deepEqual(state(db), corrupted)
}))

test('a real instance move invalidates its old host lease and deleting the last occurrence does not grant orphan write authority', () => withDatabase(db => {
  const old = update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'B' }])
  db.transaction(() => {
    db.prepare('DELETE FROM synced_instances WHERE instance_id=?').run(instanceId)
    db.prepare('UPDATE blocks SET document_id=? WHERE id=?').run(other, instanceId)
    db.prepare('INSERT INTO synced_instances VALUES(?,?,?,?,NULL,0)').run(instanceId, groupId, other, randomUUID())
    db.prepare('UPDATE synced_groups SET topology_revision=? WHERE id=?').run(randomUUID(), groupId)
  })()
  let before = state(db)
  assert.equal(updateSyncedBlockGroup(db, old).status, 'conflict'); assert.deepEqual(state(db), before)
  const fresh = update(db, old.blocks)
  db.prepare('DELETE FROM blocks WHERE id=?').run(instanceId)
  before = state(db)
  const refused = updateSyncedBlockGroup(db, fresh)
  assert.ok(refused.status === 'missing' && refused.kind === 'instance')
  assert.equal(snapshot(db).instances.length, 0); assert.deepEqual(state(db), before)
}))

test('a deep second instance blocks content that fits the first instance and returns the actual blocking lease', () => withDatabase(db => {
  for (let depth = 0; depth < 6; depth++) ordinary(db, `parent-${depth}`, { owner: other,
    parent: depth ? `parent-${depth - 1}` : undefined, depth, sort: depth })
  const deep = uuid(101)
  addInstance(db, deep, groupId, { owner: other, parent: 'parent-5', depth: 6 })
  const root = { ...edits(snapshot(db).blocks)[0], type: 'toggle' }
  const before = state(db), result = updateSyncedBlockGroup(db, update(db, [root,
    { id: randomUUID(), type: 'paragraph', content: 'Nested', checked: false, depth: 1, parentBlockId: root.id }]))
  assert.ok(result.status === 'invalid' && result.code === 'depth')
  assert.deepEqual(result.blockingInstances.map(value => value.instanceId), [deep])
  assert.deepEqual(state(db), before)
}))

test('same-page repetitions count every occurrence in the host budget instead of counting the group only once', () => withDatabase(db => {
  for (let index = 1; index < 4; index++) addInstance(db, uuid(100 + index))
  const before = state(db), result = updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'x'.repeat(4_300_000) }]))
  assert.ok(result.status === 'invalid' && result.code === 'budget')
  assert.equal(result.blockingInstances.length, 4)
  assert.deepEqual(state(db), before)
}))

test('host budget includes other real reference dependencies, including their repeated occurrences', () => withDatabase(db => {
  const sibling = uuid(20)
  createGroup(db, sibling, [paragraph('sibling-body', 's'.repeat(4_300_000))])
  for (let index = 0; index < 3; index++) addInstance(db, uuid(200 + index), sibling)
  const before = state(db), result = updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'x'.repeat(4_300_000) }]))
  assert.ok(result.status === 'invalid' && result.code === 'budget')
  assert.deepEqual(state(db), before)
}))

test('global ordinary, foreign canonical and reserved identities cannot be stolen by group content', () => withDatabase(db => {
  ordinary(db, 'ordinary-id', { owner: other })
  createGroup(db, uuid(20), [paragraph('foreign-id')])
  db.prepare(`INSERT INTO block_identities VALUES('reserved-id','reserved','fixture','retained',NULL)`).run()
  const before = state(db)
  for (const id of ['ordinary-id', 'foreign-id', 'reserved-id']) {
    const result = updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], id }]))
    assert.ok(result.status === 'invalid' && result.code === 'identity')
    assert.deepEqual(state(db), before)
  }
}))

test('opaque IDs, exact birth bytes, optional tags and old routes survive content deletion, same-group revival and historical restoration', () => withDatabase(db => {
  const original = snapshot(db).blocks[0], fresh = randomUUID()
  db.prepare('INSERT INTO document_block_routes VALUES(?,?)').run('Former/Owner', original.id)
  const next = { ...edits([original])[0], id: fresh, content: 'New', tags: [] }
  const b = saved(updateSyncedBlockGroup(db, update(db, [next])))
  assert.equal(b.snapshot.blocks[0].id, fresh)
  assert.ok(Number.isFinite(Date.parse(b.snapshot.blocks[0].createdAt)))
  assert.notEqual(b.snapshot.blocks[0].createdAt, born)
  assert.equal((db.prepare('SELECT state FROM block_identities WHERE id=?').get(original.id) as { state: string }).state, 'retained')
  const reverted = saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
  assert.deepEqual(reverted.snapshot.blocks[0], original)
  const redone = saved(restoreSyncedGroupOperation(db, restore(db, 'redo')))
  assert.deepEqual(redone.snapshot.blocks, b.snapshot.blocks)
  const revived = saved(updateSyncedBlockGroup(db, update(db, [edits([original])[0], next])))
  assert.equal(revived.snapshot.blocks[0].createdAt, born)
  assert.equal(revived.snapshot.blocks[1].createdAt, b.snapshot.blocks[0].createdAt)
  assert.equal(Object.hasOwn(revived.snapshot.blocks[0], 'tags'), false)
  assert.deepEqual(revived.snapshot.blocks[1].tags, [])
  assert.deepEqual(db.prepare('SELECT * FROM document_block_routes').all(), [{ document_path: 'Former/Owner', block_id: original.id }])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  const unknown = randomUUID()
  db.prepare("INSERT INTO block_identities VALUES(?,'group',?,'retained',NULL)").run(unknown, groupId)
  const accepted = saved(updateSyncedBlockGroup(db, update(db, [...edits(revived.snapshot.blocks), edits([paragraph(unknown, 'Unknown historical birth')])[0]])))
  assert.ok(Number.isFinite(Date.parse(accepted.snapshot.blocks[2].createdAt)))
  assert.notEqual(accepted.snapshot.blocks[2].createdAt, born, 'unknown birth is not replaced by a fake historical timestamp')
}))

test('historical Undo and Redo preserve exact link targets and state hints after a real target rename, deletion and same-path replacement', () => {
  for (const removed of [false, true]) withDatabase(db => {
    db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('target-old', 'Target', 'target-old', 'Original/Target', born, now)
    const content = '[x](Target.md)', binding = { blockId: snapshot(db).blocks[0].id, from: 4, to: 13, raw: 'Target.md', syntax: 'markdown' as const,
      target: { kind: 'document' as const, id: 'target-old', state: 'live' as const } }
    db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run(content, groupId)
    db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify([binding]), groupId)
    const original = snapshot(db), next = [{ ...edits(original.blocks)[0], content: 'Before ' + content }]
    const changed = saved(updateSyncedBlockGroup(db, update(db, next)))
    assert.equal(changed.snapshot.bindings[0].target.kind, 'document')
    if (removed) db.prepare('DELETE FROM documents WHERE id=?').run('target-old')
    else db.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed', 'Moved/Renamed', 'target-old')
    db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('replacement', 'Target', 'replacement', 'Original/Target', born, now)
    const undone = saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
    assert.deepEqual(undone.snapshot.blocks, original.blocks)
    assert.deepEqual(undone.snapshot.bindings, original.bindings)
    const redone = saved(restoreSyncedGroupOperation(db, restore(db, 'redo')))
    assert.deepEqual(redone.snapshot.blocks, changed.snapshot.blocks)
    assert.deepEqual(redone.snapshot.bindings, changed.snapshot.bindings)
  })
})

test('external semantic replacement without clearing the executable history cannot silently attach a new local edit to that old branch', () => withDatabase(db => {
  saved(updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'B' }])))
  db.prepare('UPDATE synced_group_blocks SET content=? WHERE group_id=?').run('External', groupId)
  db.prepare('UPDATE synced_groups SET revision=? WHERE id=?').run(randomUUID(), groupId)
  const before = state(db)
  const result = updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'Local after external' }]))
  assert.ok(result.status === 'conflict' && result.kind === 'history')
  assert.deepEqual(state(db), before)
}))

test('ambiguous split lineage is rejected by the real repository before an old URL can bind a same-path replacement', () => withDatabase(db => {
  db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('old-target', 'Renamed', 'old-target', 'Moved/Renamed', born, now)
  db.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('new-target', 'Target', 'new-target', 'Original/Target', born, now)
  const original = snapshot(db).blocks[0], content = '[x](Target.md)'
  db.prepare('UPDATE synced_group_blocks SET content=? WHERE id=?').run(content, original.id)
  db.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify([
    { blockId: original.id, from: 4, to: 13, raw: 'Target.md', syntax: 'markdown', target: { kind: 'document', id: 'old-target', state: 'live' } }
  ]), groupId)
  const before = state(db), result = updateSyncedBlockGroup(db, update(db, [
    { ...edits([original])[0], content: 'Left' }, edits([paragraph(randomUUID(), content)])[0]
  ]))
  assert.ok(result.status === 'invalid' && result.code === 'binding')
  assert.deepEqual(state(db), before)
}))

test('a real failure after historical row replacement rolls back Undo and allows the original operation to retry once', () => withDatabase(db => {
  const original = snapshot(db).blocks
  saved(updateSyncedBlockGroup(db, update(db, edits([paragraph(randomUUID(), 'Replacement')]))))
  const input = restore(db, 'undo'), before = state(db)
  db.exec(`CREATE TEMP TRIGGER reject_content_undo BEFORE UPDATE ON synced_groups
    WHEN NEW.id='${groupId}' BEGIN SELECT RAISE(ABORT,'injected historical commit failure'); END`)
  assert.throws(() => restoreSyncedGroupOperation(db, input), /injected historical commit failure/)
  assert.deepEqual(state(db), before)
  assert.deepEqual(getSyncedOperation(db, { clientOperationId: input.clientOperationId }), { status: 'unknown' })
  db.exec('DROP TRIGGER reject_content_undo')
  const result = saved(restoreSyncedGroupOperation(db, input))
  assert.deepEqual(result.snapshot.blocks, original)
  assert.deepEqual(saved(restoreSyncedGroupOperation(db, input)), { ...result, replayed: true })
}))

test('a real late receipt trigger rolls back canonical rows, identities, Redo truncation, history and cursors before exact retry', () => withDatabase(db => {
  saved(updateSyncedBlockGroup(db, update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'B' }])))
  saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
  const input = update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'C' }, edits([paragraph(randomUUID(), 'New identity')])[0]])
  const before = state(db)
  db.exec(`CREATE TEMP TRIGGER reject_content_receipt BEFORE INSERT ON synced_operations
    WHEN NEW.client_operation_id='${input.clientOperationId}' BEGIN SELECT RAISE(ABORT,'injected content receipt failure'); END`)
  assert.throws(() => updateSyncedBlockGroup(db, input), /injected content receipt failure/)
  assert.deepEqual(state(db), before); assert.equal(db.inTransaction, false)
  db.exec('DROP TRIGGER reject_content_receipt')
  const result = saved(updateSyncedBlockGroup(db, input))
  assert.equal(result.status, 'saved'); assert.equal(result.snapshot.blocks[0].content, 'C')
  assert.equal(result.snapshot.history.redoToken, null)
  assert.deepEqual(getSyncedOperation(db, { clientOperationId: input.clientOperationId }), { status: 'committed', result: { ...result, replayed: true } })
}))

test('repositories refuse outer savepoints and strict invalid inputs without claiming durable commits', () => withDatabase(db => {
  const input = update(db, [{ ...edits(snapshot(db).blocks)[0], content: 'B' }]), before = state(db)
  db.transaction(() => {
    assert.throws(() => updateSyncedBlockGroup(db, input), /独占事务/)
    assert.throws(() => getSyncedOperation(db, { clientOperationId: input.clientOperationId }), /独占事务/)
  })()
  for (const invalid of [{ ...input, claims: [] }, { ...input, blocks: [] }, { ...input, blocks: [{ ...input.blocks[0], createdAt: now }] }]) {
    assert.equal(updateSyncedBlockGroup(db, invalid).status, 'invalid')
    assert.deepEqual(state(db), before)
  }
  db.pragma('foreign_keys=OFF')
  assert.throws(() => updateSyncedBlockGroup(db, input), /启用 SQLite 外键/)
  assert.deepEqual(state(db), before)
  db.pragma('foreign_keys=ON')
}))

test('new canonical self and cross block references resolve from the complete accepted candidate without premature ledger writes and survive exact history replay', () => {
  withDatabase(db => {
    const foreign = randomUUID(), reserved = randomUUID()
    createGroup(db, uuid(20), [paragraph(foreign)])
    db.prepare("INSERT INTO block_identities VALUES(?,'reserved','fixture','retained',NULL)").run(reserved)
    for (const occupied of [foreign, reserved]) {
      const fresh = randomUUID(), before = state(db)
      const input = update(db, edits([
        paragraph(fresh, `[self](#^${fresh}) [cross](#^${occupied})`),
        paragraph(occupied, `[self](#^${occupied}) [cross](#^${fresh})`)
      ]))
      assert.equal(db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(fresh), undefined)
      const refused = updateSyncedBlockGroup(db, input)
      assert.ok(refused.status === 'invalid' && refused.code === 'identity')
      assert.deepEqual(state(db), before)
      assert.equal(db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(fresh), undefined)
    }
  })
  withDatabase(db => {
    const original = snapshot(db), first = randomUUID(), second = randomUUID()
    const blocks = edits([
      paragraph(first, `[self](#^${first}) [cross](#^${second})`),
      paragraph(second, `[self](#^${second}) [cross](#^${first})`)
    ])
    for (const id of [first, second]) assert.equal(db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(id), undefined)
    // Binding planning must use the accepted candidate; it cannot create fake
    // identities merely to make its reads resolve before real content insertion.
    db.exec(`CREATE TEMP TRIGGER reject_premature_candidate_identity BEFORE INSERT ON synced_group_blocks
      WHEN NEW.id='${first}' BEGIN
        SELECT CASE WHEN EXISTS(SELECT 1 FROM block_identities WHERE id IN ('${first}','${second}'))
          THEN RAISE(ABORT,'premature candidate identity write') END;
      END`)
    const input = update(db, blocks), result = saved(updateSyncedBlockGroup(db, input))
    db.exec('DROP TRIGGER reject_premature_candidate_identity')
    const expected = blocks.flatMap((block, index) => [index ? second : first, index ? first : second].map(id => {
      const raw = '#^' + id, from = block.content.indexOf(raw)
      return { blockId: block.id, from, to: from + raw.length, raw, syntax: 'markdown',
        target: { kind: 'block', id, documentId: null, state: 'live' } }
    }))
    assert.deepEqual(result.snapshot.bindings, expected)
    for (const block of result.snapshot.blocks) assert.deepEqual(
      db.prepare('SELECT last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(block.id),
      { last_owner_kind: 'group', last_owner_id: groupId, state: 'live', created_at: block.createdAt })
    const journal = db.prepare('SELECT * FROM synced_group_history ORDER BY position').all()
    const undone = saved(restoreSyncedGroupOperation(db, restore(db, 'undo')))
    assert.deepEqual(undone.snapshot.blocks, original.blocks)
    assert.deepEqual(undone.snapshot.bindings, original.bindings)
    for (const block of result.snapshot.blocks) assert.deepEqual(
      db.prepare('SELECT last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(block.id),
      { last_owner_kind: 'group', last_owner_id: groupId, state: 'retained', created_at: block.createdAt })
    const beforeReplay = state(db)
    assert.deepEqual(saved(updateSyncedBlockGroup(db, input)), { ...result, replayed: true })
    assert.deepEqual(getSyncedOperation(db, { clientOperationId: input.clientOperationId }),
      { status: 'committed', result: { ...result, replayed: true } })
    assert.deepEqual(state(db), beforeReplay)
    const redone = saved(restoreSyncedGroupOperation(db, restore(db, 'redo')))
    assert.deepEqual(redone.snapshot.blocks, result.snapshot.blocks)
    assert.deepEqual(redone.snapshot.bindings, expected)
    assert.notEqual(redone.snapshot.revision, result.snapshot.revision)
    assert.deepEqual(db.prepare('SELECT * FROM synced_group_history ORDER BY position').all(), journal)
    const afterRedo = state(db)
    assert.deepEqual(saved(updateSyncedBlockGroup(db, input)), { ...result, replayed: true })
    assert.deepEqual(state(db), afterRedo)
  })
})
