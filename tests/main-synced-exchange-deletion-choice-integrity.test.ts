import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSyncedExchangeDeletions, resolveSyncedExchangeConflicts, resolveSyncedExchangeBoth } from '../src/main/sync/synced-exchange'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { captureSyncedBaselineOwner, getSyncedOperationWithOwnedLinkSource, releaseSyncedReadOwner } from '../src/main/database/synced-binding-sources'
import { withDeletionChoices, groupConflict, docConflict, ready, component, choose, completed, randomUUID,
  allTables, rejected, encode, hash, flip, job7, proof2, receipt7, runtime } from './helpers/synced-deletion-choice-fixture'

test('actual deletion preview private bytes and index are indispensable and a jointly changed public component cannot replace its original complete source fence', async () => {
  for (const fault of ['index-hash', 'private-component-with-new-index-hash'] as const) await withDeletionChoices(async f => {
    const conflict = groupConflict(f), p = ready(await f.preview()), decision = choose(component(p, conflict.key), 'keep-delete')
    const key = 'sync.webdav.protocol5.exchange-deletion-preview.v1.' + p.previewId
    const row = f.B.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined
    assert.ok(row, 'The real Main preview has its own exact private index row before any negative mutation')
    const index = JSON.parse(row.value) as { previewHash: string }, file = join(f.B.root, 'storage', 'synced-exchange-deletion-previews-v1', p.previewId, 'preview.json')
    const original = readFileSync(file)
    assert.equal(hash(original), index.previewHash)
    if (fault === 'index-hash') index.previewHash = flip(index.previewHash)
    else {
      const payload = JSON.parse(original.toString()) as { components: Array<{ componentId: string; dependencySignature: string }> }
      const selected = payload.components.find(c => c.componentId === decision.componentId)
      assert.ok(selected, 'The negative changes a component actually displayed by the genuine complete preview')
      selected.dependencySignature = flip(selected.dependencySignature)
      const changed = Buffer.from(encode(payload)); writeFileSync(file, changed); index.previewHash = hash(changed)
    }
    f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(index), key)
    const before = allTables(f.B.db), requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => f.resolve(p, [decision]), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
    assert.equal(hash(readFileSync(file)), fault === 'index-hash' ? hash(original) : index.previewHash)
  })
})

test('closed deletion selectors reject extra authority fields duplicates and unknown choices before HTTP without turning readonly preview facts into a write permit', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), p = ready(await f.preview()), decision = choose(component(p, conflict.key), 'keep-delete')
  let getterReads = 0
  const accessor = Object.defineProperty({ componentId: decision.componentId }, 'choice', { enumerable: true, get: () => { getterReads++; return 'keep-delete' } })
  const negatives: unknown[] = [
    [{ ...decision, localBefore: conflict.localWire }], [decision, structuredClone(decision)],
    [{ componentId: decision.componentId, choice: 'both' }], [accessor],
    [{ componentId: flip(decision.componentId), choice: 'keep-delete' }]
  ]
  const before = allTables(f.B.db), requests = f.server.requests.length
  for (const decisions of negatives) await rejected(() => f.track(resolveSyncedExchangeDeletions(f.B.db,
    { ...f.input(), previewId: p.previewId, decisions } as Parameters<typeof resolveSyncedExchangeDeletions>[1], runtime)), 'invalid')
  assert.equal(getterReads, 0, 'Closed data validation never invokes a caller selector getter')
  assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
}))

test('a genuine successful format7 cannot launder jointly edited receipt and job decision source hashes or a rewritten private fence past the original historical phase inputs', async () => {
  for (const fault of ['joint-hash', 'joint-source'] as const) await withDeletionChoices(async f => {
    const conflict = groupConflict(f), p = ready(await f.preview()), decision = choose(component(p, conflict.key), 'keep-live'), operationId = randomUUID()
    completed(await f.resolve(p, [decision], operationId), 'applied')
    const original = job7(f, operationId), before = allTables(f.B.db)
    assert.ok(original.job.decisionSource.baseRecords.some(row => row.key === conflict.key), 'The genuine job owns the exact true common B as historical evidence')
    if (fault === 'joint-source') {
      original.job.decisionSource.localFingerprint = flip(original.job.decisionSource.localFingerprint)
      original.job.decisionSourceHash = hash(encode(original.job.decisionSource))
    } else original.job.decisionSourceHash = flip(original.job.decisionSourceHash)
    original.receipt.provenance.decisionSourceHash = original.job.decisionSourceHash
    f.B.db.transaction(() => {
      f.B.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(encode(original.job), original.jobRow.key)
      f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(original.receipt), operationId)
    })()
    const corrupted = allTables(f.B.db), omit = (tables: ReturnType<typeof allTables>) => ({ ...tables,
      app_settings: (tables.app_settings as Array<{ key: string }>).filter(row => row.key !== original.jobRow.key),
      synced_operations: (tables.synced_operations as Array<{ client_operation_id: string }>).filter(row => row.client_operation_id !== operationId) })
    assert.deepEqual(omit(corrupted), omit(before), 'Only the two selected JSON facts change while phases original inputs and the complete physical database stay exact')
    const requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => f.resolve(p, [decision], operationId), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), corrupted)
  })
})

test('a real proof2 still authenticates distinct true B current L and exact original decision source and corruption cannot be repaired through the historical receipt', async () => {
  for (const fault of ['base-hash', 'local-before-hash', 'decision-source-hash'] as const) await withDeletionChoices(async f => {
    const conflict = docConflict(f), p = ready(await f.preview()), decision = choose(component(p, conflict.key), 'keep-delete'), operationId = randomUUID()
    completed(await f.resolve(p, [decision], operationId), 'applied')
    const original = proof2(f, operationId, conflict.key)
    if (fault === 'base-hash') original.value.baseLiveHash = flip(original.value.baseLiveHash)
    else if (fault === 'local-before-hash') original.value.localBeforeHash = flip(original.value.localBeforeHash)
    else original.value.decision.decisionSourceHash = flip(original.value.decision.decisionSourceHash)
    f.B.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(encode(original.value), original.markerRow.client_operation_id)
    const before = allTables(f.B.db), requests = f.server.requests.length
    f.reopenPeer(); await rejected(() => f.resolve(p, [decision], operationId), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
  })
})

test('new format7 history is not an old auto selection both or group owned source receipt and cannot be grafted across those methods even with the same operation UUID', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), owner = captureSyncedBaselineOwner(f.B.db, { groupId: conflict.id })
  assert.ok(owner.status === 'ready', 'The independent source owner is minted by a real initial live group read')
  try {
    const p = ready(await f.preview()), decision = choose(component(p, conflict.key), 'keep-live'), operationId = randomUUID()
    completed(await f.resolve(p, [decision], operationId), 'applied'); const original = receipt7(f, operationId), before = allTables(f.B.db), requests = f.server.requests.length
    assert.throws(() => getSyncedOperation(f.B.db, { clientOperationId: operationId }), /收据损坏/)
    assert.throws(() => getSyncedOperationWithOwnedLinkSource(f.B.db, { readOwnerId: owner.readOwnerId, clientOperationId: operationId }), /收据损坏/)
    await rejected(() => f.exchange(f.B, operationId), 'invalid')
    await rejected(() => f.track(resolveSyncedExchangeConflicts(f.B.db, { ...f.input(operationId), previewId: p.previewId, decisions: [] }, runtime)), 'invalid')
    await rejected(() => f.track(resolveSyncedExchangeBoth(f.B.db, { ...f.input(operationId), previewId: p.previewId, decisions: [] }, runtime)), 'invalid')
    assert.equal(f.server.requests.length, requests); assert.deepEqual(allTables(f.B.db), before)
    assert.equal(receipt7(f, operationId).row.result_json, original.row.result_json)
  } finally { releaseSyncedReadOwner(f.B.db, { readOwnerId: owner.readOwnerId }) }
}))
