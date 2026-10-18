import assert from 'node:assert/strict'
import { withTombstones, snapshot, changeGroup, count, hostEdit, randomUUID, request, applySyncedHostFinal,
  insertAck, insertCommand, applySyncedHostCommand, deleteGroup, deleteDocument, document,
  type Fixture } from './synced-exchange-tombstone-fixture'
import { localPortable } from './synced-exchange-fixture'

export * from './synced-exchange-tombstone-fixture'
export { localPortable, lateReceipt } from './synced-exchange-fixture'
export { readonlyRequests } from './synced-initial-incoming-fixture'
export { withTombstones }
export type { Fixture }
export function commonHash(f: Fixture, key: string) {
  const rows = f.B.db.prepare("SELECT value FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange.v1.%'").all() as Array<{ value: string }>
  assert.equal(rows.length, 1)
  const state = JSON.parse(rows[0].value) as { baseline: Array<{ key: string; commonHash: string | null }> }, actual = state.baseline.find(row => row.key === key)
  assert.ok(actual?.commonHash, 'The actual settled same-target baseline owns the exact common ancestor hash')
  return actual.commonHash
}

/** No SQL success is fabricated: first a real content ACK, then the supported
 * P != W == A host-final persistence boundary with no new logical journal. */
export function divergentUnpinnedGroup(f: Fixture) {
  const id = f.groupId, key = 'group:' + id, before = snapshot(f.B.db, id), base = f.remote(), oldHash = commonHash(f, key)
  assert.equal(base.manifest.entries[key], oldHash)
  assert.ok(before.instances.some(instance => instance.hostDocumentId === f.host), 'The actual receiver instance authorizes the real local content edit')
  assert.equal(count(f.B.db, 'synced_group_pins', 'group_id', id), 0, 'The independent receiver has no source create or host history pin to hide')
  const contentAck = changeGroup(f.B.db, id, blocks => { blocks[0].content = 'LOCAL real edited G before explicit deletion choice' })
  assert.equal(contentAck.status, 'saved')
  assert.ok(count(f.B.db, 'synced_group_history', 'group_id', id) > 0, 'The actual group writer created its real own content history rather than a direct SQL body mutation')
  const p = f.B.db.prepare('SELECT * FROM synced_instances WHERE host_document_id=? AND group_id=?').all(f.host, id)
  assert.equal(p.length, 1, 'The true persisted P still has its original physical reference before host working is saved')
  const newParagraph = { id: randomUUID(), type: 'paragraph' as const, content: 'Actual working paragraph after removing the reference', checked: false, depth: 0, parentBlockId: null, tags: [] }
  const input = request(f.B.db, [f.host], (after, working) => {
    after[0].blocks = [newParagraph]
    working[0].workingBefore.blocks = structuredClone(after[0].blocks)
  })
  assert.deepEqual(input.hostsWorkingBefore[0].workingBefore, { title: input.finalAfter[0].title, summary: input.finalAfter[0].summary, blocks: input.finalAfter[0].blocks }, 'W and A are exactly the actual already-edited working forest')
  const persisted = applySyncedHostFinal(f.B.db, input)
  assert.ok(persisted.status === 'applied', 'The real Main writer persistently changes P to the supported equal W/A without a fabricated SQL transition')
  assert.equal(persisted.historyToken, null, 'An identity logical W to A does not manufacture a new inverse pin')
  assert.equal(count(f.B.db, 'synced_instances', 'group_id', id), 0)
  assert.equal(count(f.B.db, 'synced_group_pins', 'group_id', id), 0, 'No existing persistent pin was removed or concealed by the working fixture')
  const current = snapshot(f.B.db, id), portable = localPortable(f.B), host = portable.records.find(record => record.kind === 'document' && record.id === f.host)
  assert.ok(host?.kind === 'document', 'The real saved host has its complete actual portable record')
  assert.notEqual(portable.entries[key], oldHash)
  f.remoteFinal(records => { records.set('doc:' + f.host, structuredClone(host)); deleteGroup(records, id) })
  const deletion = f.remote().records.get(key)
  assert.ok(deletion?.kind === 'synced-group-deleted', 'The explicit remote input is a real strict finite group tombstone')
  assert.equal(deletion.creationId, before.creationId); assert.equal(deletion.previousHash, oldHash)
  return { id, key, baseHash: oldHash, before, local: current, input, contentAck, persisted, tombstone: deletion }
}
export function divergentDocument(f: Fixture) {
  const id = f.islands[0], key = 'doc:' + id, baseHash = commonHash(f, key), before = localPortable(f.B).records.find(record => record.kind === 'document' && record.id === id)
  assert.ok(before?.kind === 'document', 'The initial common document is a genuine complete live record')
  hostEdit(f.B.db, id, 'LOCAL actual document edit before explicit deletion choice')
  const local = localPortable(f.B).records.find(record => record.kind === 'document' && record.id === id)
  assert.ok(local?.kind === 'document', 'The actual host-final writer produced the current live source')
  assert.notEqual(localPortable(f.B).entries[key], baseHash)
  f.remoteFinal(records => { deleteDocument(records, id) })
  return { id, key, baseHash, before, local }
}
export function realNewReference(f: Fixture) {
  const id = f.orphanId, key = 'group:' + id, before = snapshot(f.B.db, id), baseHash = commonHash(f, key)
  assert.deepEqual(before.instances, []); assert.equal(count(f.B.db, 'synced_group_pins', 'group_id', id), 0)
  const input = insertCommand(f.B.db, { documentId: f.islands[0], groupId: id }), ack = insertAck(applySyncedHostCommand(f.B.db, input))
  assert.ok(ack.historyToken, 'A genuine local insert creates its actual immutable host journal')
  const pins = f.B.db.prepare('SELECT * FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id').all(id)
  assert.ok(pins.length > 0, 'The new-reference conflict has real producer-created pins rather than hand-seeded successful authority')
  f.remoteFinal(records => { deleteGroup(records, id) })
  return { id, key, baseHash, before, input, ack, pins, local: snapshot(f.B.db, id) }
}
