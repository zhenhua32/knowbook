import assert from 'node:assert/strict'
import test from 'node:test'
import { getSyncedGroupSnapshots, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { withDeletionPrimer, completed, encode, hash } from './helpers/synced-exchange-tombstone-primer-fixture'

test('actual protocol5 tombstone consumer physically deletes a received nopin orphan G and excludes it before public list count and pagination', () => withDeletionPrimer(async f => {
  const db = f.B.db, before = db.prepare('SELECT * FROM synced_groups WHERE id=?').get(f.groupId) as { creation_id: string; created_at: string; origin_json: string; revision: string; topology_revision: string; history_cursor: string }
  const children = db.prepare('SELECT * FROM synced_group_blocks WHERE group_id=? ORDER BY sort_order').all(f.groupId)
  const identities = db.prepare('SELECT * FROM block_identities WHERE id IN (SELECT id FROM synced_group_blocks WHERE group_id=?) ORDER BY id').all(f.groupId) as Array<Record<string, unknown>>
  assert.ok(children.length > 0 && identities.length === children.length, 'The positive starts from real imported physical canonical children and their live global identities')
  const oldList = listSyncedGroups(db, { query: '', offset: 0, limit: 100 })
  assert.ok(oldList.items.some(row => row.groupId === f.groupId), 'The actual nopin orphan is visible before remote deletion')
  f.remoteFinal(records => {
    const old = records.get('group:' + f.groupId)
    assert.ok(old?.kind === 'synced-group', 'The remote tombstone names the actual same-incarnation live B wire')
    records.set('group:' + f.groupId, { kind: 'synced-group-deleted', id: f.groupId, creationId: old.creationId, previousHash: hash(encode(old)), deletedAt: new Date().toISOString() })
  })
  const result = completed(await f.exchange(), 'applied')
  assert.ok(result.appliedKeys.includes('group:' + f.groupId) && result.acceptedKeys.includes('group:' + f.groupId), 'The real consumer accepts deletion knowledge and performs actual physical deletion')
  assert.deepEqual(db.prepare('SELECT * FROM synced_group_blocks WHERE group_id=?').all(f.groupId), [])
  assert.deepEqual(db.prepare('SELECT * FROM synced_instances WHERE group_id=?').all(f.groupId), [])
  const after = db.prepare('SELECT * FROM synced_groups WHERE id=?').get(f.groupId) as typeof before
  assert.ok(after, 'The immutable group identity row remains as a raw occupied identity anchor')
  for (const key of ['creation_id', 'created_at', 'origin_json'] as const) assert.equal(after[key], before[key])
  for (const key of ['revision', 'topology_revision', 'history_cursor'] as const) { assert.notEqual(after[key], before[key]); assert.match(after[key], /^[a-f0-9-]{36}$/) }
  const actualIdentities = db.prepare('SELECT * FROM block_identities WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(encode(identities.map(row => row.id)))
  assert.deepEqual(actualIdentities, identities.map(row => ({ ...row, state: 'retained' })))
  assert.equal(getSyncedGroupSnapshots(db, { groupIds: [f.groupId] }).items[0].status, 'missing')
  const list = listSyncedGroups(db, { query: '', offset: 0, limit: 100 })
  assert.equal(list.total, oldList.total - 1); assert.equal(list.items.some(row => row.groupId === f.groupId), false)
  const paged = Array.from({ length: list.total }, (_, offset) => listSyncedGroups(db, { query: '', offset, limit: 1 }).items[0]?.groupId)
  assert.equal(paged.length, new Set(paged).size); assert.equal(paged.includes(f.groupId), false)
}))

test('actual protocol5 tombstone consumer physically deletes an ordinary document and forest while preserving retained global births and historical routes', () => withDeletionPrimer(async f => {
  const db = f.B.db, id = f.ordinaryId, original = db.prepare('SELECT * FROM documents WHERE id=?').get(id)
  assert.ok(original, 'The ordinary document exists after actual initial install and real shared baseline acceptance')
  const blocks = db.prepare('SELECT id,created_at FROM blocks WHERE document_id=? ORDER BY sort_order').all(id) as Array<{ id: string; created_at: string }>
  const identities = db.prepare('SELECT * FROM block_identities WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(encode(blocks.map(block => block.id))) as Array<Record<string, unknown>>
  const routes = db.prepare('SELECT * FROM document_block_routes WHERE block_id IN (SELECT value FROM json_each(?)) ORDER BY block_id,document_path').all(encode(blocks.map(block => block.id)))
  assert.ok(blocks.length > 0 && identities.length === blocks.length, 'The independent ordinary positive has a real physical forest with Main-accepted births')
  f.remoteFinal(records => { assert.equal(records.get('doc:' + id)?.kind, 'document'); records.set('doc:' + id, { kind: 'deleted', id }) })
  const result = completed(await f.exchange(), 'applied')
  assert.ok(result.appliedKeys.includes('doc:' + id) && result.acceptedKeys.includes('doc:' + id), 'The real consumer actually deletes the requested document and accepts its exact deletion knowledge')
  assert.equal(db.prepare('SELECT * FROM documents WHERE id=?').get(id), undefined)
  assert.deepEqual(db.prepare('SELECT * FROM blocks WHERE document_id=?').all(id), [])
  assert.deepEqual(db.prepare('SELECT * FROM block_identities WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(encode(blocks.map(block => block.id))), identities.map(row => ({ ...row, state: 'retained' })))
  assert.deepEqual(db.prepare('SELECT * FROM document_block_routes WHERE block_id IN (SELECT value FROM json_each(?)) ORDER BY block_id,document_path').all(encode(blocks.map(block => block.id))), routes)
  assert.equal(getSyncedGroupSnapshots(db, { groupIds: [f.groupId] }).items[0].status, 'ready', 'An independent unrelated live orphan remains available')
}))
