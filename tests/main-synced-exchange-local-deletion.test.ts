import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { assertSyncedLogicalDeletionRecords } from '../src/main/database/synced-logical-deletion-read'
import { previewSyncedExchangeDeletionDetails, resolveSyncedExchangeDeletions } from '../src/main/sync/synced-exchange'
import { assertAbsentKnowledge, completed, count, hostEdit, randomUUID, readStrictHostDocument, runtime, withTombstones } from './helpers/synced-exchange-tombstone-fixture'

function deleteThroughStore(file: string, documentId: string, purge = false): void {
  const store = KnowbookStore.openCanonicalRuntime(file)
  try {
    store.deleteDocument(documentId)
    if (purge) store.documentRecovery.purge(documentId)
  } finally { store.destroy() }
}

test('an explicit local document deletion survives Trash purge, restart and synchronization without reviving its old identity', () => withTombstones(async f => {
  const documentId = f.islands[0], key = 'doc:' + documentId
  const operationId = randomUUID(), before = f.remote()
  deleteThroughStore(f.A.file, documentId, true)
  assert.equal(count(f.B.db, 'documents', 'id', documentId), 1)
  assert.equal(count(f.A.db, 'document_trash', 'id', documentId), 0)
  f.reopenPeer(f.A)

  const published = completed(await f.exchange(f.A, operationId), 'applied')
  assert.ok(published.publishedKeys.includes(key))
  const after = f.remote()
  assert.notEqual(after.hash, before.hash)
  assert.deepEqual(after.records.get(key), { kind: 'deleted', id: documentId })
  assert.ok(assertAbsentKnowledge(f.A.db, key).proof)
  f.reopenPeer(f.A)
  const replay = completed(await f.exchange(f.A, operationId), 'applied')
  assert.equal(replay.replayed, true)

  f.reopenPeer()
  assert.ok(completed(await f.exchange(f.B), 'applied').appliedKeys.includes(key))
  assert.equal(count(f.B.db, 'documents', 'id', documentId), 0)
  assert.ok(assertAbsentKnowledge(f.B.db, key).proof)
  f.reopenPeer()
  completed(await f.exchange(f.B), 'noop')
  assert.equal(f.remote().hash, after.hash)
}))

for (const choice of ['keep-live', 'keep-delete'] as const) test(`offline local deletion versus remote edit permits an explicit ${choice} decision`, () => withTombstones(async f => {
  const documentId = f.islands[0], key = 'doc:' + documentId, peerText = 'Published edit while the deleting device was offline'
  deleteThroughStore(f.A.file, documentId)
  assert.equal(hostEdit(f.B.db, documentId, peerText).ack.status, 'applied')
  assert.ok(completed(await f.exchange(f.B), 'applied').publishedKeys.includes(key))
  const peerHead = f.remote()

  f.reopenPeer(f.A)
  const conflict = completed(await f.exchange(f.A), 'deferred')
  assert.ok(conflict.deferred.some(component => component.keys.includes(key) && component.reason === 'diverged'))
  assert.equal(conflict.publishedKeys.includes(key), false)
  assert.equal(f.remote().hash, peerHead.hash)
  assert.equal(count(f.A.db, 'documents', 'id', documentId), 0)
  assert.equal(count(f.A.db, 'document_trash', 'id', documentId), 1)
  assert.equal(readStrictHostDocument(f.B.db, documentId).detail.blocks[0].content, peerText)

  const target = { userDataRoot: f.A.root, target: f.targetConfig }
  const preview = await previewSyncedExchangeDeletionDetails(f.A.db, { ...target, previewId: randomUUID() }, runtime)
  assert.equal(preview.status, 'ready')
  if (preview.status !== 'ready') return
  const component = preview.preview.components.find(row => row.records.some(record => record.key === key))
  assert.ok(component)
  assert.ok(component.choices.includes(choice))
  const display = component.records.find(record => record.key === key)!
  assert.equal(display.local.kind, 'deleted')
  const remoteDocument = peerHead.records.get(key)
  assert.ok(remoteDocument?.kind === 'document')
  assert.equal(display.remote.kind === 'live' && display.remote.text, [remoteDocument.content.summary, peerText].filter(Boolean).join('\n'))
  const result = completed(await resolveSyncedExchangeDeletions(f.A.db, { ...target, operationId: randomUUID(),
    previewId: preview.preview.previewId, expectedPreviewHash: preview.preview.previewHash,
    decisions: [{ componentId: component.componentId, choice }] }, runtime), 'applied')
  assert.ok(result.appliedKeys.includes(key))
  f.reopenPeer(f.A)

  if (choice === 'keep-delete') {
    assert.ok(result.publishedKeys.includes(key))
    assert.equal(assertSyncedLogicalDeletionRecords(f.A.db).get(key)?.version, 2)
    f.reopenPeer()
    assert.ok(completed(await f.exchange(f.B), 'applied').appliedKeys.includes(key))
    assert.equal(count(f.B.db, 'documents', 'id', documentId), 0)
    const store = KnowbookStore.openCanonicalRuntime(f.A.file)
    let copyId: string
    try { copyId = store.restoreTrashedDocument(documentId) } finally { store.destroy() }
    assert.notEqual(copyId, documentId)
    assert.ok(completed(await f.exchange(f.A), 'applied').publishedKeys.includes('doc:' + copyId))
    assert.ok(completed(await f.exchange(f.B), 'applied').appliedKeys.includes('doc:' + copyId))
    assert.equal(count(f.B.db, 'documents', 'id', documentId), 0)
    assert.equal(count(f.B.db, 'documents', 'id', copyId), 1)
  } else {
    assert.equal(result.publishedKeys.includes(key), false)
    assert.equal(f.remote().hash, peerHead.hash)
    assert.equal(readStrictHostDocument(f.A.db, documentId).detail.blocks[0].content, peerText)
  }
}))
