import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { allTables, guards, snapshot } from './helpers/synced-host-final-fixture'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import type { EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import type { DecideEditorRecoveryDraftInput, EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'
import type { SyncedHostWorkingBefore } from '../src/shared/synced-blocks'
import { openColdHostSourceOwner } from '../src/renderer/src/features/editor-recovery/sourceColdOwner'
import { recoveryData } from '../src/renderer/src/features/editor-recovery/sourceSnapshots'
import { applySyncedHostSourceChanges, createSyncedHostSourceDraft, insertSyncedHostSourceReference, moveSyncedHostSourceRange,
  prepareSyncedHostSourceApply, readSyncedHostSourceRecovery, restoreSyncedHostSourceDraft } from '../src/renderer/src/features/synced-blocks/hostSource'

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

    assert.equal(original.base.persistedWorking.kind, 'host')
    if (original.base.persistedWorking.kind !== 'host') throw new Error('Actual host required')
    const { kind: _kind, ...workingBefore } = original.base.persistedWorking
    const sourceOpening = createSyncedHostSourceDraft({ documentId: f.hostId, expectedPersistedUpdatedAt: current.updatedAt,
      workingBefore } as SyncedHostWorkingBefore)
    const sourceDraft = applySyncedHostSourceChanges(sourceOpening, [{ from: 0, to: 0, insert: 'Original source ' }])
    const valid = service.open(live, { ...request, openRequestId: randomUUID() })
    const validExpected = service.write(live, { records: [{ draftSessionId: valid.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: valid.base.persistedWorking, pending: [], selection: null, composing: false, importing: false,
      sources: [{ sourceId: randomUUID(), kind: 'synced-host', openingSource: sourceOpening.source, acceptedSource: sourceOpening.source,
        source: sourceDraft.source, selection: { anchor: 1, head: 0 }, composing: false, applying: false, importing: false,
        replayJson: JSON.stringify(recoveryData({ kind: 'knowbook-source-replay-data', version: 1, opening: sourceOpening,
          accepted: sourceOpening, current: sourceDraft, provenance: readSyncedHostSourceRecovery(sourceDraft) })) }]
    }] }, { kind: 'background' }).records[0]
    const validHead = { recordId: validExpected.recordId, generation: validExpected.generation, hash: validExpected.hash }
    const initiallyRestorable = service.read(cold, validHead)
    assert.equal(initiallyRestorable.mode, 'editable-source-draft')

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
    const drifted = service.read(cold, validHead)
    assert.equal(drifted.hostSourcePins, 'changed')
    assert.equal(drifted.mode, 'view-only')
    assert.throws(() => service.decide(cold, initiallyRestorable.recoveryOwnerId, 'restore-draft'), /requires explicit review/)
    assert.deepEqual(drifted.record, initiallyRestorable.record)
    assert.deepEqual(allTables(f.db), sqlAfterEdit)
  } finally {
    service.dispose()
    side.close()
  }
}))

test('a cold pinned host Source restores exact draft coordinates and permits only a later explicit Main Apply', () => withV3Fixture(async f => {
  const sidePath = join(f.root, 'editable-source-pins-side')
  let side = new EditorRecoveryDraftStore(sidePath), service = new EditorRecoveryDraftService(side, f.store, () => {})
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  try {
    const live = recoveryEvent(), detail = f.store.getDocumentDetail(f.hostId)!
    const original = service.open(live, { kind: 'host', documentId: f.hostId, expectedUpdatedAt: detail.updatedAt,
      source: true, openRequestId: randomUUID() })
    assert.ok(original.base.hostSourcePins)
    assert.equal(original.base.persistedWorking.kind, 'host')
    if (original.base.persistedWorking.kind !== 'host') throw new Error('Actual host required')
    const { kind: _kind, ...workingBefore } = original.base.persistedWorking
    const host = { documentId: f.hostId, expectedPersistedUpdatedAt: detail.updatedAt, workingBefore } as SyncedHostWorkingBefore
    const opening = createSyncedHostSourceDraft(host), reference = opening.references.anchors[0]
    const edited = applySyncedHostSourceChanges(opening, [{ from: 0, to: 'Ordinary'.length, insert: 'Retained' },
      { from: opening.source.length, to: opening.source.length, insert: '\n\nAnother ordinary paragraph' }])
    const moved = moveSyncedHostSourceRange(edited, { from: edited.references.anchors[0].from,
      to: edited.references.anchors[0].to + 2, insertAt: 0 })
    const removed = applySyncedHostSourceChanges(edited, [{ from: edited.references.anchors[0].from, to: edited.references.anchors[0].to, insert: '' }])
    const inputFor = (current: typeof opening, generation: number, mutate?: (packet: Record<string, unknown>) => void): EditorRecoveryDraftInput => {
      const packet = recoveryData({ kind: 'knowbook-source-replay-data', version: 1, opening, accepted: opening, current,
        provenance: readSyncedHostSourceRecovery(current) }) as Record<string, unknown>
      mutate?.(packet)
      return { draftSessionId: original.draftSessionId, generation, expectedPreviousGeneration: generation - 1,
        working: original.base.persistedWorking, pending: [], selection: null, composing: false, importing: false,
        sources: [{ sourceId: randomUUID(), kind: 'synced-host', openingSource: opening.source, acceptedSource: opening.source,
          source: current.source, selection: { anchor: current.source.length, head: 0 }, composing: false, applying: false,
          importing: false, replayJson: JSON.stringify(packet) }] }
    }
    const write = (input: EditorRecoveryDraftInput) => {
      const { recordId, generation, hash } = service.write(live, { records: [input] }, { kind: 'background' }).records[0]
      return { recordId, generation, hash }
    }
    const malformed = write(inputFor(edited, 1, packet => {
      const current = packet.current as { references: { anchors: Array<{ key: string }> } }
      current.references.anchors[0].key = randomUUID()
    }))
    assert.equal(service.read(live, malformed).mode, 'view-only')
    const unsupportedAck = write(inputFor(edited, 2, packet => { packet.provenance = { kind: 'actual-host-source-ack' } }))
    assert.equal(service.read(live, unsupportedAck).mode, 'view-only')
    const pin = original.base.hostSourcePins.groups[0]
    const inserted = insertSyncedHostSourceReference(edited, { at: edited.source.length,
      identity: { workspaceScope: original.base.workspaceScope, groupId: pin.groupId, creationId: pin.creationId } })
    const newReference = write(inputFor(inserted, 3))
    assert.equal(service.read(live, newReference).mode, 'view-only')
    const deleted = write(inputFor(removed, 4))
    assert.equal(service.read(live, deleted).mode, 'editable-source-draft')
    const draft = inputFor(moved, 5), expected = write(draft)
    service.dispose(); side.close()
    side = new EditorRecoveryDraftStore(sidePath); service = new EditorRecoveryDraftService(side, f.store, () => {})

    const cold = recoveryEvent(), sqlBefore = allTables(f.db), candidate = service.read(cold, expected)
    assert.equal(candidate.mode, 'editable-source-draft')
    assert.equal(candidate.hostSourcePins, 'unchanged')
    assert.equal(candidate.writePermit, false)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
      decideEditorRecoveryDraft: async (input: DecideEditorRecoveryDraftInput) => service.decide(cold, input.recoveryOwnerId, input.decision)
    } } })
    const restored = restoreSyncedHostSourceDraft(await openColdHostSourceOwner(candidate.recoveryOwnerId), { hostSession: {}, editSequence: 0, host })
    assert.equal(restored.draft.source, moved.source)
    assert.equal(restored.draft.references.anchors[0].key, reference.key)
    assert.equal(restored.draft.references.anchors[0].instanceId, f.instanceId)
    assert.equal(restored.draft.references.anchors[0].groupId, f.groupId)
    assert.deepEqual(restored.selection, draft.sources[0].selection)
    assert.deepEqual(allTables(f.db), sqlBefore)
    assert.deepEqual(side.head(original.draftSessionId)?.expected, expected)

    const prepared = prepareSyncedHostSourceApply(restored.draft)
    assert.deepEqual(prepared.newRefSources, [])
    assert.equal(prepared.finalAfter[0].blocks.find(block => block.type === 'synced-block')?.id, f.instanceId)
    const frame = cold.senderFrame!, session = f.store.openSyncedEditingSession(frame, {
      kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
    assert.equal(session.status, 'ready')
    if (session.status !== 'ready') throw new Error('Actual host writer missing')
    const applied = f.store.invokeSyncedEditingSession(frame, { sessionId: session.session.sessionId, method: 'applySyncedHostStructure', input: {
      ...guards(f.db, [f.hostId], prepared.finalAfter), ...prepared, clientOperationId: randomUUID(), mode: 'host-final', reason: 'source-apply' } })
    assert.equal(applied.status, 'applied')
    assert.equal(f.store.getDocumentDetail(f.hostId)?.blocks.some(block => block.content.includes('Retained host body')), true)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    service.dispose(); side.close()
  }
}))
