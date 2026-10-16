import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { updateSyncedBlockGroup, restoreSyncedGroupOperation, getSyncedOperation } from '../src/main/database/synced-blocks-content'
import type { SyncedGroupSnapshot } from '../src/shared/synced-blocks'
import { openCanonicalSourceLedger, forkCanonicalSourceLedger, prepareCanonicalSourceFirstApply,
  readPreparedSourceFirstApply, type SourceFirstApplyLease, type SourceLedgerDraft } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import { withTwoClients, edits, saved, snapshot, update, restore, state, host, other, groupId, born, now, uuid } from './helpers/synced-content-fixture'

function open(value: SyncedGroupSnapshot) {
  const instance = value.instances[0]
  assert.ok(instance)
  const lease: SourceFirstApplyLease = { expectedEditSequence: 0, scope: { groupId: value.groupId, hostDocumentId: instance.hostDocumentId,
    instanceId: instance.instanceId, bindingVersion: instance.bindingVersion, windowSessionId: randomUUID(),
    hostSession: {}, mountEpoch: {}, bindingEpoch: {} }, guards: { groupId: value.groupId,
      expectedRevision: value.revision, expectedTopologyRevision: value.topologyRevision } }
  return { ...openCanonicalSourceLedger({ blocks: edits(value.blocks), origin: value.origin, lease }), lease }
}
function prepare(draft: SourceLedgerDraft, lease: SourceFirstApplyLease) {
  return readPreparedSourceFirstApply(prepareCanonicalSourceFirstApply({ draft, lease }))
}

function actualTargets(removeOriginal: boolean): void {
  withTwoClients((a, b) => {
    const original = uuid(8100), reused = uuid(8101), initial = snapshot(a)
    a.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(original, 'Target', original, 'Original/Target', born, now)
    const content = '[A](Target.md "first") [B](Target.md "second")'
    const wire = initial.blocks.map(block => ({ ...block, content, tags: ['keep', '旧'], highlight: 'yellow' as const }))
    a.prepare('UPDATE synced_group_blocks SET content=?,tags_json=?,highlight=? WHERE group_id=?').run(content, JSON.stringify(['keep', '旧']), 'yellow', groupId)
    // Real parser + actual SQLite target resolution establish the fixture. No
    // hand-assembled binding, target, canonical snapshot or dirty-source ticket.
    const captured = captureSyncedGroupBindings(a, initial.origin, wire)
    assert.equal(captured.length, 2)
    assert.equal(captured.every(binding => binding.target.kind === 'document' && binding.target.id === original), true)
    a.prepare('UPDATE synced_groups SET bindings_json=? WHERE id=?').run(JSON.stringify(captured), groupId)
    const persisted = snapshot(a), first = open(persisted)
    const hosts = a.prepare('SELECT * FROM documents WHERE id IN (?,?) ORDER BY id').all(host, other)
    const stable = state(a)

    b.transaction(() => {
      if (removeOriginal) b.prepare('DELETE FROM documents WHERE id=?').run(original)
      else b.prepare('UPDATE documents SET title=?,path=? WHERE id=?').run('Renamed', 'Original/Renamed', original)
      b.prepare('INSERT INTO documents(id,title,slug,path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(reused, 'Target', reused, 'Original/Target', born, now)
    })()
    const afterTargetChange = state(a), label = first.draft.source.indexOf('[A]') + 1, title = first.draft.source.indexOf('first')
    const continuedDraft = forkCanonicalSourceLedger(first.draft, [{ from: label, to: label + 1, insert: '显示🙂' },
      { from: title, to: title + 5, insert: 'different title' }]), continued = prepare(continuedDraft, first.lease)
    assert.deepEqual(state(a), afterTargetChange, 'Opening/fork/prepare do not write SQLite, flush or sign dirty tickets')
    assert.deepEqual(continued.bindingClaims.map(claim => claim.kind), ['continue', 'continue'])
    const continuedRequest = { ...update(a, [...continued.blocks]), bindingClaims: [...continued.bindingClaims] }
    const continueAck = saved(updateSyncedBlockGroup(a, continuedRequest))
    assert.equal(continueAck.status, 'saved')
    assert.equal(continueAck.snapshot.bindings.every(binding => binding.target.kind === 'document' && binding.target.id === original), true,
      'Actual carrier continuation retains the old ID after rename/delete and path reuse')

    const second = open(continueAck.snapshot), at = second.draft.source.indexOf('Target.md')
    const newDraft = forkCanonicalSourceLedger(second.draft, [{ from: at, to: at + 1, insert: 'T' }]), rebound = prepare(newDraft, second.lease)
    assert.equal(newDraft.source, second.draft.source, 'This is a consumed same-byte partial URL edit, not a text diff')
    assert.deepEqual(rebound.bindingClaims.map(claim => claim.kind), ['new', 'continue'])
    assert.equal(rebound.hasIntent, true)
    const request = { ...update(a, [...rebound.blocks]), bindingClaims: [...rebound.bindingClaims] }, ack = saved(updateSyncedBlockGroup(a, request))
    assert.equal(ack.status, 'saved')
    assert.deepEqual(ack.snapshot.bindings.map(binding => binding.target.kind === 'document' ? binding.target.id : binding.target.kind), [reused, original])
    assert.equal((a.prepare('SELECT count(*) AS n FROM synced_group_history WHERE group_id=?').get(groupId) as { n: number }).n, 2)

    const undone = saved(restoreSyncedGroupOperation(a, restore(a, 'undo')))
    assert.deepEqual(undone.snapshot.bindings, continueAck.snapshot.bindings)
    assert.deepEqual(undone.snapshot.blocks, continueAck.snapshot.blocks)
    const redone = saved(restoreSyncedGroupOperation(a, restore(a, 'redo')))
    assert.deepEqual(redone.snapshot.bindings, ack.snapshot.bindings)
    assert.deepEqual(redone.snapshot.blocks, ack.snapshot.blocks)
    // Identical authored hrefs now intentionally have different historical
    // targets. Editing only the second label must not choose the first target
    // by URL equality, occurrence order or today's reused document path.
    const third = open(redone.snapshot), secondLabel = third.draft.source.indexOf('[B]') + 1
    assert.ok(secondLabel > 0)
    const thirdDraft = forkCanonicalSourceLedger(third.draft, [{ from: secondLabel, to: secondLabel + 1, insert: 'only second' }])
    const thirdResult = prepare(thirdDraft, third.lease)
    assert.deepEqual(thirdResult.bindingClaims.map(claim => claim.kind), ['continue', 'continue'])
    const thirdAck = saved(updateSyncedBlockGroup(a, { ...update(a, [...thirdResult.blocks]), bindingClaims: [...thirdResult.bindingClaims] }))
    assert.equal(thirdAck.status, 'saved')
    assert.deepEqual(thirdAck.snapshot.bindings.map(binding => binding.target.kind === 'document' ? binding.target.id : binding.target.kind), [reused, original])
    assert.equal((a.prepare('SELECT count(*) AS n FROM synced_group_history WHERE group_id=?').get(groupId) as { n: number }).n, 3)
    assert.deepEqual(getSyncedOperation(a, { clientOperationId: continuedRequest.clientOperationId }),
      { status: 'committed', result: { ...continueAck, replayed: true } })
    assert.deepEqual(getSyncedOperation(a, { clientOperationId: request.clientOperationId }),
      { status: 'committed', result: { ...ack, replayed: true } })
    assert.equal(redone.snapshot.blocks[0].id, persisted.blocks[0].id)
    assert.equal(redone.snapshot.blocks[0].createdAt, persisted.blocks[0].createdAt)
    assert.deepEqual(redone.snapshot.blocks[0].tags, persisted.blocks[0].tags)
    assert.equal(redone.snapshot.blocks[0].highlight, persisted.blocks[0].highlight)
    assert.equal(redone.snapshot.topologyRevision, persisted.topologyRevision)
    assert.deepEqual(a.prepare('SELECT * FROM documents WHERE id IN (?,?) ORDER BY id').all(host, other), hosts)
    const final = state(a)
    for (const table of ['blocks', 'block_identities', 'document_block_routes', 'document_block_moves', 'document_history',
      'document_trash', 'synced_instances', 'synced_host_history', 'synced_host_history_documents', 'synced_host_history_state', 'synced_group_pins'])
      assert.deepEqual(final[table], stable[table], `Content changes cannot mutate host/identity table ${table}`)
  })
}

test('real two-client SQLite rename/path reuse distinguishes label/title continue from same-byte partial destination new', () => {
  actualTargets(false)
})

test('real two-client SQLite target deletion/path reuse and Undo/Redo retain exact historical targets and ACKs', () => {
  actualTargets(true)
})
