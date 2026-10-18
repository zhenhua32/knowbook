import assert from 'node:assert/strict'
import test from 'node:test'
import { withDeletionChoices, groupConflict, docConflict, ready, component, choose, completed, hostEdit,
  localPortable, snapshot, count, readStrictHostDocument, insertCommand, insertAck, applySyncedHostCommand } from './helpers/synced-deletion-choice-fixture'

test('an actual Main changed-back ordinary body cannot revive an original deletion decision and its unrelated incoming island still commits', () => withDeletionChoices(async f => {
  const conflict = docConflict(f), p = ready(await f.preview()), c = component(p, conflict.key), originalHash = localPortable(f.B).entries[conflict.key]
  const originalHistory = f.B.db.prepare('SELECT * FROM synced_host_history_state WHERE document_id=?').get(conflict.id)
  hostEdit(f.B.db, conflict.id, 'A real intervening body before changing back')
  hostEdit(f.B.db, conflict.id, conflict.local.content.blocks[0].content)
  const current = readStrictHostDocument(f.B.db, conflict.id)
  assert.equal(localPortable(f.B).entries[conflict.key], originalHash)
  assert.notDeepEqual(f.B.db.prepare('SELECT * FROM synced_host_history_state WHERE document_id=?').get(conflict.id), originalHistory, 'The actual Main history guard changes even when its semantic body returns to the original L')
  hostEdit(f.A.db, f.islands[1], 'Independent U after actual changed-back Main edit'); completed(await f.exchange(f.A), 'applied')
  const result = completed(await f.resolve(p, [choose(c, 'keep-delete')]), 'applied')
  assert.ok(result.deferred.some(part => part.keys.includes(conflict.key)), 'Exact original selection guards reject changed-back current history instead of borrowing equal wire content')
  assert.equal(result.acceptedKeys.includes(conflict.key), false)
  assert.deepEqual(readStrictHostDocument(f.B.db, conflict.id), current)
  assert.equal(readStrictHostDocument(f.B.db, f.islands[1]).detail.blocks[0].content, 'Independent U after actual changed-back Main edit')
}))

test('a genuine new Main reference and journal pin during resolve expands and defers the whole selected deletion component while independent U still installs', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), p = ready(await f.preview()), c = component(p, conflict.key)
  hostEdit(f.A.db, f.islands[2], 'Independent U across real pin creation'); completed(await f.exchange(f.A), 'applied')
  const gate = f.gate(request => request.method === 'GET' && request.path.endsWith('/manifest.json'))
  const job = f.resolve(p, [choose(c, 'keep-delete')])
  try {
    await gate.wait(job)
    const other = f.connect(f.B), input = insertCommand(other, { documentId: f.islands[0], groupId: conflict.id })
    const ack = insertAck(applySyncedHostCommand(other, input))
    assert.ok(ack.historyToken, 'The intervening current reference comes from an actual Main insert with a real immutable journal')
    assert.ok(count(other, 'synced_group_pins', 'group_id', conflict.id) > 0, 'The inserted reference owns real persistent pins rather than a caller-provided counter')
    const current = snapshot(other, conflict.id), host = readStrictHostDocument(other, f.islands[0])
    const pins = other.prepare('SELECT * FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id').all(conflict.id)
    gate.release(); const result = completed(await job, 'applied')
    const deferred = result.deferred.find(part => part.keys.includes(conflict.key))
    assert.ok(deferred?.keys.includes('doc:' + f.islands[0]), 'The current dependency component includes the actual newly referenced host and is withdrawn as a whole')
    assert.equal(result.acceptedKeys.includes(conflict.key), false)
    assert.deepEqual(snapshot(f.B.db, conflict.id), current); assert.deepEqual(readStrictHostDocument(f.B.db, f.islands[0]), host)
    assert.deepEqual(f.B.db.prepare('SELECT * FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id').all(conflict.id), pins)
    assert.equal(readStrictHostDocument(f.B.db, f.islands[2]).detail.blocks[0].content, 'Independent U across real pin creation')
  } finally { gate.release(); await Promise.allSettled([job]) }
}))
