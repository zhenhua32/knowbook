import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { withCrossMoveDraftCheck } from '../src/main/database/synced-cross-move-draft-guard'
import { hostHash } from '../src/main/database/synced-host-journal'
import type { SyncedHostHistoryBranchRow } from '../src/main/database/synced-host-history-branch'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { readCanonicalBatchCrossMoveJournal, readCanonicalBatchCrossMoveOriginalOwned } from '../src/main/editor-recovery/canonical-cross-move-original4'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { readCanonicalRecoveryClosedFrames } from '../src/shared/editor-recovery-canonical'
import type { EditorRecoveryDraftInput, EditorRecoveryOpened } from '../src/shared/editor-recovery-drafts'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { addV3CrossMoveDependency, addV3SameGroupReference, applySyncedHostCommand, createRequest, randomUUID, request,
  withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { restoreInput } from './helpers/synced-host-command-move-fixture'

function owner(store: KnowbookStore, folder: string) {
  const barrier = createEditorCloseBarrier({ beginShutdown() {} })
  class Contents extends EventEmitter {
    readonly id = 21
    readonly mainFrame = { processId: 100, routingId: this.id }
    isDestroyed() { return false }
    getOSProcessId() { return 300 }
    send() {}
  }
  class Window extends EventEmitter {
    readonly webContents = new Contents()
    isDestroyed() { return false }
    close() {}
  }
  const window = new Window()
  barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }, frame = event.senderFrame!
  const side = new EditorRecoveryDraftStore(folder)
  const service = new EditorRecoveryDraftService(side, store, event => barrier.assertEditorMutationAllowed(event))
  return { barrier, event, frame, side, service, dispose() { service.dispose(); side.close() } }
}

function sealGroup(store: KnowbookStore, ctx: ReturnType<typeof owner>, hostDocumentId: string, groupId: string, instanceId: string) {
  const { frame, event, service } = ctx
  const from = store.openSyncedEditingSession(frame, { kind: 'instance', hostDocumentId, groupId, instanceId })
  assert.ok(from.status === 'ready' && from.instance)
  const { sessionId } = from.session, { bindingVersion } = from.instance
  const baseline = store.invokeSyncedEditingSession(frame, { sessionId, method: 'captureBaseline', input: { groupId } })
  assert.equal(baseline.status, 'ready')
  const group = service.open(event, { kind: 'group', groupId, sessionId, readOwnerId: baseline.readOwnerId, openRequestId: randomUUID() })
  const before = syncedCanonicalEdits(baseline.snapshot.blocks), after = before.map(block => ({ ...block, content: block.content + ' unsaved W' }))
  const redo = after.map(block => ({ ...block, content: block.content + ' unsaved Redo' })), instance = { hostDocumentId, instanceId, bindingVersion }
  const draft: EditorRecoveryDraftInput = { draftSessionId: group.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
    working: { kind: 'group', blocks: after, incoming: null }, selection: null, composing: false, importing: false, pending: [], sources: [],
    replayJson: JSON.stringify({ kind: 'knowbook-canonical-recovery-data', version: 2, snapshot: baseline.snapshot,
      readSource: { workspaceScope: baseline.workspaceScope, readOwnerId: baseline.readOwnerId, snapshot: baseline.snapshot, bindingSource: baseline.bindingSource },
      accepted: null, frames: [{ before, after, instance, copySources: [], sequence: 1, transactionId: randomUUID() }],
      redoFrames: [{ before: after, after: redo, instance, copySources: [], sequence: 2, transactionId: randomUUID() }], serverRedo: [], cutServerRedo: true }) }
  const [head] = service.write(event, { records: [draft] }, { kind: 'background' }).records
  return { group, draft, head, sessionId, baseline, after, redo }
}

for (const scenario of ['v8 ordinary initiator', 'v12 shared initiator', 'second dirty group', 'same-group stationary reference',
  'unconsumed initiating W', 'parked ordinary source',
  'parked external page', 'close barrier'] as const) {
  test(`actual two-source batch with one sealed shared W (${scenario})`, () => withV3Fixture(async fixture => {
    const { store, db, hostId, targetId, groupId, instanceId } = fixture
    const other = store.createDocument(null), ordinaryId = randomUUID()
    store.updateDocument(other, { title: 'Independent move source', summary: '', blocks: [
      { id: ordinaryId, type: 'paragraph', content: 'Move my ordinary body', depth: 0, checked: false, parentBlockId: null }
    ] })
    const second = scenario === 'second dirty group' ? createRequest(db, { documentId: other, selectedRootIds: [ordinaryId] }) : undefined
    if (second) assert.equal(applySyncedHostCommand(db, second).status, 'applied')
    const stationary = scenario === 'same-group stationary reference' ? addV3SameGroupReference(fixture, targetId) : undefined
    const external = scenario === 'v12 shared initiator' || scenario === 'parked external page' ? addV3CrossMoveDependency(fixture, 'wiki') : undefined
    const participants = [hostId, targetId, other, ...(external ? [external.documentId] : [])]
    const initiator = scenario === 'v8 ordinary initiator' ? other : hostId
    const folder = join(fixture.root, 'batch-recovery'), ctx = owner(store, folder)
    const { event, frame, service, side, barrier } = ctx
    try {
      const group = sealGroup(store, ctx, hostId, groupId, instanceId)
      const otherGroup = second && sealGroup(store, ctx, other, second.action.groupId, second.action.instanceId)
      const { sessionId } = group
      for (const hostDocumentId of participants) {
        const opened = store.openSyncedEditingSession(frame, { kind: 'host', hostDocumentId })
        assert.equal(opened.status, 'ready')
        assert.equal(opened.session.sessionId, sessionId)
      }
      const rootTarget = { documentId: targetId, parentBlockId: null, beforeBlockId: null, depth: 0 }
      const moves = [{ selection: { documentId: other, selectedRootIds: [second?.action.instanceId ?? ordinaryId] }, target: rootTarget },
        { selection: { documentId: hostId, selectedRootIds: [instanceId] }, target: rootTarget }]
      if (initiator === other) moves.reverse()
      const { clientOperationId, hostsWorkingBefore, groups, expectedInstances } = request(db, participants)
      const input = { clientOperationId, hostsWorkingBefore, groups, expectedInstances, mode: 'command' as const,
        action: { kind: 'move-batch' as const, moves } }
      const host = (documentId: string) => {
        const before = hostsWorkingBefore.find(page => page.documentId === documentId)!
        return { producer: service.open(event, { kind: 'host', documentId, expectedUpdatedAt: before.expectedPersistedUpdatedAt, openRequestId: randomUUID() }),
          working: { kind: 'host' as const, ...before.workingBefore } }
      }
      const { producer, working } = host(initiator)
      const method = 'applySyncedHostStructure' as const
      function seal(producer: EditorRecoveryOpened, working: Extract<EditorRecoveryDraftInput['working'], { kind: 'host' }>, pending: EditorRecoveryDraftInput['pending']) {
        return service.write(event, { records: [{ draftSessionId: producer.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
          working, pending, selection: null, composing: false, importing: false, sources: [] }] }, { kind: 'background' }).records[0]
      }
      const hostDraft = scenario === 'unconsumed initiating W' ? { ...working, summary: working.summary + ' later independent W' } : working
      const { draftSessionId: _hostSession, ...hostHead } = seal(producer, hostDraft, [{ method, clientOperationId, requestHash: hostHash({ method, input }),
        inputJson: JSON.stringify(input), submittedWorking: working }])
      assert.equal(Boolean(side.read(hostHead).crossMoveGroupHead), !second && !stationary)
      const parkedDocument = scenario === 'parked ordinary source' ? other : scenario === 'parked external page' ? external!.documentId : undefined
      const parked = parkedDocument && host(parkedDocument)
      const parkedWorking = parked ? { ...parked.working, summary: parked.working.summary + ' preserved local W' } : undefined
      const parkedHead = parked && parkedWorking ? seal(parked.producer, parkedWorking, []) : undefined
      if (parked && parkedHead) service.park(event, { draftSessionId: parked.producer.draftSessionId,
        expectedHead: { recordId: parkedHead.recordId, generation: parkedHead.generation, hash: parkedHead.hash } })

      let dispatches = 0
      const apply = () => barrier.runEditorMutation(event, () => service.applyHotCrossMove(event, { sessionId, hostHead: {
        recordId: hostHead.recordId, generation: hostHead.generation, hash: hostHead.hash
      } }, original => {
        dispatches++
        return withCrossMoveDraftCheck(db, service.crossMoveDraftCheck(event), () => store.invokeSyncedEditingSession(frame, original))
      }))
      const sqlBefore = db.prepare('SELECT total_changes() AS count').get()
      if (scenario === 'close barrier' || scenario === 'unconsumed initiating W' || parked || second || stationary) {
        if (scenario === 'close barrier') {
          const requestId = barrier.requestQuit()
          assert.ok(requestId)
          assert.equal(barrier.acknowledge(event, { requestId, status: 'flushed' }), true)
          await assert.rejects(apply(), /关闭|close|frozen/i)
        } else assert.deepEqual(await apply(), { status: 'rejected' })
        assert.equal(dispatches, scenario === 'parked ordinary source' ? 1 : 0)
        assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), sqlBefore)
        assert.deepEqual(side.read(group.head).draft, group.draft)
        assert.deepEqual(side.read(hostHead).draft.working, hostDraft)
        if (otherGroup) assert.deepEqual(side.read(otherGroup.head).draft, otherGroup.draft)
        if (parkedHead) assert.deepEqual(side.read(parkedHead).draft.working, parkedWorking)
        if (stationary) assert.ok(store.getDocumentDetail(targetId)?.blocks.some(block => block.id === stationary && block.type === 'synced-block'))
        assert.equal(store.getDocumentDetail(hostId)?.blocks.some(block => block.id === instanceId), true)
        return
      }
      const moved = await apply()
      assert.equal(moved.status, 'moved')
      assert.deepEqual(await apply(), moved)
      assert.equal(dispatches, 1)
      const result = moved.result
      assert.equal(result.hosts.length, participants.length)
      assert.deepEqual(result.affectedInstanceIds, [instanceId])
      assert.equal(result.groups[0].revision, group.baseline.snapshot.revision)
      assert.deepEqual(result.groups[0].history, group.baseline.snapshot.history)
      const journal = db.prepare('SELECT * FROM synced_host_history WHERE id=?').get(result.historyToken) as SyncedHostHistoryBranchRow
      const original = readCanonicalBatchCrossMoveJournal(journal)
      assert.equal(original.version, external ? 12 : 8)
      assert.deepEqual(original.original.crossMove.transfers.map(item => [item.blockId, item.from, item.to]).sort(),
        [[instanceId, hostId, targetId], [ordinaryId, other, targetId]].sort())
      if (external) assert.equal(store.getDocumentDetail(external.documentId)?.blocks[0].content, external.after)
      const [metadata] = group.group.base.originals
      assert.ok(producer.base.owner.kind === 'host')
      const hostRecord = side.read(hostHead), incorrect = { ...hostRecord, base: { ...hostRecord.base,
        owner: { ...producer.base.owner, createdAt: '1999-01-01T00:00:00.000Z' } } }
      assert.throws(db.transaction(() => readCanonicalBatchCrossMoveOriginalOwned(db, { operationId: clientOperationId,
        requestHash: hostHash({ method: 'applySyncedHostCommand', input }), baselineKey: metadata.key, baselineHash: metadata.requestHash }, incorrect, instanceId)), /cannot be proved/)
      ctx.dispose(); fixture.close()

      const cold = KnowbookStore.openCanonicalRuntime(fixture.file), visit = owner(cold, folder)
      try {
        const candidate = visit.service.read(visit.event, hostHead)
        assert.equal(candidate.writePermit, false)
        assert.deepEqual(candidate.pending, [{ clientOperationId, status: 'committed-attested' }])
        const link = candidate.canonicalCrossMoveRecovery
        assert.ok(link && link.hostDocumentId === targetId)
        const opened = cold.openSyncedEditingSession(visit.frame, { kind: 'instance', hostDocumentId: targetId, groupId, instanceId })
        assert.ok(opened.status === 'ready' && opened.instance)
        const { sessionId } = opened.session, binding = { instanceId, hostDocumentId: targetId, bindingVersion: opened.instance.bindingVersion }
        const baseline = cold.invokeSyncedEditingSession(visit.frame, { sessionId, method: 'captureBaseline', input: { groupId } })
        assert.equal(baseline.status, 'ready')
        const target = visit.service.open(visit.event, { kind: 'group', sessionId, groupId, readOwnerId: baseline.readOwnerId, openRequestId: randomUUID() })
        const liveDb = cold.getUnsafeDatabaseHandle()
        for (const hostDocumentId of participants) {
          assert.equal(cold.openSyncedEditingSession(visit.frame, { kind: 'host', hostDocumentId }).status, 'ready')
          const history = cold.invokeSyncedEditingSession(visit.frame, { sessionId, method: 'getSyncedCrossHostMoveHistory', input: { documentId: hostDocumentId } })
          assert.equal(history[0]?.historyToken, result.historyToken)
        }
        const reverse = (direction: 'undo' | 'redo') => {
          for (const hostDocumentId of participants) {
            const fresh = cold.openSyncedEditingSession(visit.frame, { kind: 'host', hostDocumentId })
            assert.ok(fresh.status === 'ready' && fresh.session.sessionId === sessionId)
          }
          return withCrossMoveDraftCheck(liveDb, visit.service.crossMoveDraftCheck(visit.event), () =>
            cold.invokeSyncedEditingSession(visit.frame, { sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(liveDb, result, direction) }))
        }
        assert.equal(reverse('undo').status, 'conflict', 'Batch inverse cannot strand the current old paired drafts before review')
        assert.equal(visit.side.head(producer.draftSessionId)?.expected.hash, hostHead.hash)
        assert.equal(visit.side.head(group.group.draftSessionId)?.expected.hash, group.head.hash)
        const beforeRecovery = liveDb.prepare('SELECT total_changes() AS count').get()
        const transfer = { recoveryOwnerId: candidate.recoveryOwnerId, sessionId, targetDraftSessionId: target.draftSessionId, instance: binding, proofHash: link.proofHash }
        const restored = visit.service.prepareGroupCrossMove(visit.event, transfer)
        assert.deepEqual(visit.service.prepareGroupCrossMove(visit.event, transfer), restored)
        assert.equal(visit.side.head(producer.draftSessionId), null)
        assert.equal(visit.side.head(group.group.draftSessionId), null)
        const frames = readCanonicalRecoveryClosedFrames(restored.record, restored.baseline, target.base.workspaceScope)
        assert.deepEqual(frames.frames.map(frame => [frame.instance, frame.after]), [[binding, group.after]])
        assert.deepEqual(frames.redoFrames.map(frame => [frame.instance, frame.after]), [[binding, group.redo]])
        assert.deepEqual(liveDb.prepare('SELECT total_changes() AS count').get(), beforeRecovery)
        const saved = cold.invokeSyncedEditingSession(visit.frame, { sessionId, method: 'updateSyncedBlockGroup', input: {
          clientOperationId: randomUUID(), groupId, expectedInstanceBinding: binding, expectedRevision: restored.baseline.revision,
          expectedTopologyRevision: restored.baseline.topologyRevision, blocks: frames.redoFrames[0].after
        } })
        assert.equal(saved.status, 'saved')
        assert.equal(reverse('undo').status, 'applied')
        assert.ok(cold.getDocumentDetail(hostId)?.blocks.some(block => block.id === instanceId))
        assert.ok(cold.getDocumentDetail(other)?.blocks.some(block => block.id === ordinaryId))
        if (external) assert.equal(cold.getDocumentDetail(external.documentId)?.blocks[0].content, external.before)
        assert.equal(reverse('redo').status, 'applied')
        assert.ok(cold.getDocumentDetail(targetId)?.blocks.some(block => block.id === instanceId))
        assert.ok(cold.getDocumentDetail(targetId)?.blocks.some(block => block.id === ordinaryId))
        if (external) assert.equal(cold.getDocumentDetail(external.documentId)?.blocks[0].content, external.after)
      } finally { visit.dispose(); cold.destroy() }
    } finally { ctx.dispose() }
  }))
}
