import assert from 'node:assert/strict'
import test from 'node:test'
import { withTombstones, completed, deleteGroup, assertAbsentKnowledge, missingGroup, hostEdit, count,
  readStrictHostDocument, snapshot, encode } from './helpers/synced-exchange-tombstone-fixture'

test('actual zero-active tombstone workspace publishes a new ordinary Main edit at the same protocol5 target after reopen without fake groups or invalid empty publication attempts', () => withTombstones(async f => {
  assert.equal(f.groupId, f.orphanId, 'This genuine source has exactly one real orphan incarnation before deletion')
  assert.equal(count(f.B.db, 'synced_groups'), 1); assert.equal(count(f.B.db, 'synced_group_pins', 'group_id', f.groupId), 0)
  f.remoteFinal(records => { deleteGroup(records, f.groupId) }); completed(await f.exchange(), 'applied')
  const key = 'group:' + f.groupId, saved = assertAbsentKnowledge(f.B.db, key)
  const originalMarker = saved.row, originalAnchor = saved.anchor
  assert.equal(count(f.B.db, 'synced_group_blocks'), 0); assert.equal(count(f.B.db, 'synced_instances'), 0)
  missingGroup(f.B.db, f.groupId); f.reopenPeer()
  const text = 'Actual ordinary Main outbound edit after deleting the final active group'
  const beforeRemote = f.remote(), beforeAttempts = new Set((f.B.db.prepare('SELECT id FROM synced_exposure_attempts').all() as Array<{ id: string }>).map(row => row.id))
  const edited = hostEdit(f.B.db, f.islands[0], text)
  assert.equal(edited.ack.status, 'applied')
  assert.equal(readStrictHostDocument(f.B.db, f.islands[0]).detail.blocks[0].content, text)
  const result = completed(await f.exchange(), 'applied'), afterRemote = f.remote()
  assert.ok(result.publishedKeys.includes('doc:' + f.islands[0]), 'The ordinary Main edit really publishes at the original same target rather than only recording a sticky5 noop')
  assert.equal(afterRemote.manifest.version, 5); assert.notEqual(afterRemote.hash, beforeRemote.hash)
  const record = afterRemote.records.get('doc:' + f.islands[0])
  assert.ok(record?.kind === 'document', 'The actual remote immutable object is the complete live ordinary host wire')
  assert.equal(record.content.blocks[0].content, text)
  assert.equal(afterRemote.records.get(key)?.kind, 'synced-group-deleted')
  assert.equal(afterRemote.manifest.entries[key], beforeRemote.manifest.entries[key])
  assert.equal([...afterRemote.records.values()].some(value => value.kind === 'synced-group'), false, 'A document-only write does not manufacture a fake live G to satisfy a member barrier')
  assert.deepEqual(afterRemote.manifest.syncedInstances, [])
  assert.equal(count(f.B.db, 'synced_groups'), 1); assert.equal(count(f.B.db, 'synced_group_blocks'), 0); assert.equal(count(f.B.db, 'synced_instances'), 0)
  const attempts = f.B.db.prepare(`SELECT a.id,a.channel,(SELECT count(*) FROM synced_group_exposure_members m WHERE m.attempt_id=a.id) AS members
    FROM synced_exposure_attempts a ORDER BY a.id`).all() as Array<{ id: string; channel: string; members: number }>
  const newAttempts = attempts.filter(row => !beforeAttempts.has(row.id))
  assert.equal(newAttempts.some(row => row.members === 0 && ['webdav-manifest5', 'webdav-manifest5-exchange'].includes(row.channel)), false,
    'No ordinary zero-member publication attempt is invented for a document-only outgoing job')
  const afterProof = assertAbsentKnowledge(f.B.db, key)
  assert.deepEqual(afterProof.row, originalMarker); assert.deepEqual(afterProof.anchor, originalAnchor)
  const noop = completed(await f.exchange(), 'noop')
  assert.deepEqual(noop.publishedKeys, []); assert.equal(f.remote().manifest.version, 5)
  assert.equal(assertAbsentKnowledge(f.B.db, key).row.result_json, originalMarker.result_json)
}, { onlyOrphan: true }))
