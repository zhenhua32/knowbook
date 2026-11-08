import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { allTables, snapshot } from './helpers/synced-host-final-fixture'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import type { EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'

function recoveryEvent(): EditorCloseIpcEvent {
  const senderFrame = { processId: 1, routingId: 1, detached: false }
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: senderFrame,
    isDestroyed: () => false, getOSProcessId: () => 1, send: () => {} })
  return { sender, senderFrame }
}

test('real host Source dependency pins survive side reopen and detect group drift without granting recovery', () => withV3Fixture(f => {
  const sidePath = join(f.root, 'source-pins-side')
  let side = new EditorRecoveryDraftStore(sidePath), service = new EditorRecoveryDraftService(side, f.store, () => {})
  try {
    const live = recoveryEvent(), current = f.store.getDocumentDetail(f.hostId)!
    const before = snapshot(f.db, f.groupId)
    const instance = before.instances.find(item => item.instanceId === f.instanceId)!
    const opening = { kind: 'host' as const, documentId: f.hostId, expectedUpdatedAt: current.updatedAt }
    const unpinned = service.open(live, { ...opening, openRequestId: randomUUID() })
    assert.equal(Object.hasOwn(unpinned.base, 'hostSourcePins'), false)
    const openRequestId = randomUUID(), request = { ...opening, openRequestId, source: true }
    const original = service.open(live, request)
    assert.deepEqual(service.open(live, request), original)
    assert.throws(() => service.open(live, { ...opening, openRequestId }), /different complete input/)
    const row = f.db.prepare('SELECT created_at FROM blocks WHERE id=?').get(f.instanceId) as { created_at: string }
    assert.deepEqual(original.base.hostSourcePins, { groups: [{
      groupId: before.groupId, creationId: before.creationId, createdAt: before.createdAt, revision: before.revision,
      topologyRevision: before.topologyRevision, historyCursor: before.history.cursor, instances: [{ ...instance, createdAt: row.created_at }]
    }] })
    assert.deepEqual(original.base.originals, [])
    assert.equal(original.writePermit, false)

    const receipt = service.write(live, { records: [{ draftSessionId: original.draftSessionId, generation: 1,
      expectedPreviousGeneration: 0, working: original.base.persistedWorking, pending: [], selection: null,
      composing: false, importing: false, sources: [{ sourceId: randomUUID(), kind: 'synced-host', openingSource: 'P',
        acceptedSource: 'P', source: 'C', selection: { anchor: 1, head: 0 }, composing: false, applying: false, importing: false }]
    }] }, { kind: 'background' })
    const { recordId, generation, hash } = receipt.records[0], expected = { recordId, generation, hash }
    service.dispose()
    side.close()
    side = new EditorRecoveryDraftStore(sidePath)
    service = new EditorRecoveryDraftService(side, f.store, () => {})

    const cold = recoveryEvent(), sqlBefore = allTables(f.db), unchanged = service.read(cold, expected)
    assert.equal(unchanged.hostSourcePins, 'unchanged')
    assert.deepEqual(unchanged.record.base.hostSourcePins, original.base.hostSourcePins)
    assert.equal(unchanged.mode, 'view-only')
    assert.equal(unchanged.writePermit, false)
    assert.equal(unchanged.historicalKeyLineageComplete, false)
    assert.throws(() => service.decide(cold, unchanged.recoveryOwnerId, 'restore-draft'), /requires explicit review/)
    assert.deepEqual(allTables(f.db), sqlBefore)

    const nativeFrame = {}, opened = f.store.openSyncedEditingSession(nativeFrame, { kind: 'host', hostDocumentId: f.hostId })
    assert.equal(opened.status, 'ready')
    if (opened.status !== 'ready') throw new Error('Actual host editing session missing')
    const edited = f.store.invokeSyncedEditingSession(nativeFrame, { sessionId: opened.session.sessionId, method: 'updateSyncedBlockGroup',
      input: { clientOperationId: randomUUID(), groupId: f.groupId, expectedRevision: before.revision, expectedTopologyRevision: before.topologyRevision,
        expectedInstanceBinding: { instanceId: f.instanceId, hostDocumentId: f.hostId, bindingVersion: instance.bindingVersion },
        blocks: syncedCanonicalEdits(before.blocks).map(block => ({ ...block, content: block.content + ' native group change' })) } })
    assert.equal(edited.status, 'saved')
    assert.deepEqual(f.store.getDocumentDetail(f.hostId), current)
    const sqlAfterEdit = allTables(f.db), changed = service.read(cold, expected)
    assert.equal(changed.hostSourcePins, 'changed')
    assert.equal(changed.reasons.includes('base-content-changed'), false)
    assert.equal(changed.reasons.includes('base-version-changed'), false)
    assert.equal(changed.mode, 'view-only')
    assert.equal(changed.writePermit, false)
    assert.deepEqual(changed.record, unchanged.record)
    assert.deepEqual(allTables(f.db), sqlAfterEdit)
  } finally {
    service.dispose()
    side.close()
  }
}))
