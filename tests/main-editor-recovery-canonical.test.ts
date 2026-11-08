import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { resolveSyncedBindingSource } from '../src/main/database/synced-binding-sources'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { attestCanonicalRecoveryCompletionOwned, prepareCanonicalRecoveryCompletionOwned, type PreparedCanonicalRecoveryCompletion } from '../src/main/editor-recovery/canonical-completion'
import type { CompleteEditorRecoveryGroupInput, EditorRecoveryOpened, ParkEditorRecoveryDraftInput, PrepareEditorRecoveryGroupInput, PrepareEditorRecoveryGroupFloorInput, RetireEditorRecoveryDraftInput, WriteEditorRecoveryDraftsInput } from '../src/shared/editor-recovery-drafts'
import type { SyncedBlocksApi, SyncedGroupSaved, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { decodeCanonicalRecoveryData, decodeCanonicalRecoveryFollowupData } from '../src/shared/editor-recovery-canonical'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { EditorRecoveryCoordinator, recoveryPending, type RecoveryContent } from '../src/renderer/src/features/editor-recovery/coordinator'
import { recoveryData } from '../src/renderer/src/features/editor-recovery/sourceSnapshots'
import { openColdCanonicalRecoveryOwner, openColdCanonicalFollowupOwner, closeColdCanonicalRecoveryOwner } from '../src/renderer/src/features/editor-recovery/canonicalColdOwner'
import { getSyncedWorkspaceController, captureSyncedWorkspaceRecovery, restoreSyncedCanonicalRecovery,
  acceptSyncedCanonicalRecoveryReview, flushSyncedWorkspacePendingChanges } from '../src/renderer/src/features/synced-blocks/controller'
import { adoptSyncedSourceBaseline, registerSyncedSourceHistorySide, closeSyncedSourceReadOwner } from '../src/renderer/src/features/synced-blocks/sourceLedger'
import type { SyncedReadSourcesPort } from '../src/renderer/src/features/synced-blocks/sourceReadOwner'
import { syncedSnapshotGuard, type SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { withV3Fixture, allTables, randomUUID } from './helpers/synced-backup-v3-fixture'
import { sourceSession, sourceOwner, adopted } from './helpers/source-history-copy-main-fixture'

class Contents extends EventEmitter {
  readonly id = 12; readonly mainFrame = { processId: 102, routingId: 202, detached: false }
  isDestroyed() { return false }; getOSProcessId() { return 302 }; send() {}
}
class Window extends EventEmitter { readonly webContents = new Contents(); isDestroyed() { return false }; close() {} }
function eventFor() {
  const window = new Window(), barrier = createEditorCloseBarrier({ beginShutdown() {} }); barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  return { event, barrier }
}
function sessionApi(store: KnowbookStore, event: EditorCloseIpcEvent, sessionId: string) {
  const writes: SyncedUpdateGroupInput[] = []
  const accepted: Array<{ input: SyncedUpdateGroupInput; ack: SyncedGroupSaved }> = []
  const api: SyncedBlocksApi = {
    getSyncedGroupSnapshots: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'getSyncedGroupSnapshots', input }),
    listSyncedGroups: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'listSyncedGroups', input }),
    updateSyncedBlockGroup: async input => {
      writes.push(structuredClone(input))
      const result = store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'updateSyncedBlockGroup', input })
      if ('snapshot' in result) accepted.push({ input: structuredClone(input), ack: structuredClone(result) })
      return result
    },
    restoreSyncedGroupOperation: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'restoreSyncedGroupOperation', input }),
    getSyncedOperation: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'getSyncedOperation', input }),
    applySyncedHostStructure: async input => {
      const result = store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'applySyncedHostStructure', input })
      if (result.status === 'unsupported') throw new Error(result.reason)
      return result
    },
    restoreSyncedHostOperation: async input => {
      const result = store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'restoreSyncedHostOperation', input })
      if (result.status === 'unsupported') throw new Error(result.reason)
      return result
    },
    getSyncedHostHistory: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'getSyncedHostHistory', input }),
    onSyncedBlocksChanged: () => () => {}
  }
  const reads: SyncedReadSourcesPort = {
    captureBaseline: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'captureBaseline', input }),
    operation: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'ownedOperation', input }),
    validate: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'validateOwner', input }),
    release: async input => store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'releaseOwner', input })
  }
  return { api, reads, writes, accepted }
}
function groupScope(instance: { instanceId: string; hostDocumentId: string; bindingVersion: string }, groupId: string): SyncedGroupScope {
  return { owner: { kind: 'synced-group', groupId }, ...instance, windowSessionId: randomUUID(), hostSession: {}, mountEpoch: {}, bindingEpoch: {},
    domNamespace: 'cold-canonical-owned', root: () => null, isCurrent: () => true }
}

async function canonicalCase(branch: 'active' | 'redo') { await withV3Fixture(async f => {
  const old = eventFor(), sidePath = join(f.root, 'editor-recovery')
  const side = new EditorRecoveryDraftStore(sidePath), service = new EditorRecoveryDraftService(side, f.store, event => old.barrier.assertEditorMutationAllowed(event))
  const session = f.store.openSyncedEditingSession(old.event.senderFrame!, { kind: 'instance', hostDocumentId: f.hostId, groupId: f.groupId, instanceId: f.instanceId })
  if (session.status !== 'ready') throw new Error('The actual original inline session is required')
  const originalPort = sessionApi(f.store, old.event, session.session.sessionId)
  const originalState: { opened: EditorRecoveryOpened | null } = { opened: null }
  const originalRead: SyncedReadSourcesPort = { ...originalPort.reads, captureBaseline: async input => {
    const result = await originalPort.reads.captureBaseline(input)
    if (result.status === 'ready') originalState.opened = service.open(old.event, { kind: 'group', groupId: f.groupId,
      sessionId: session.session.sessionId, readOwnerId: result.readOwnerId, openRequestId: randomUUID() })
    return result
  } }
  const workspace = getSyncedWorkspaceController(originalPort.api, { readSources: originalRead })
  const coordinator = new EditorRecoveryCoordinator(), originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let retiredCalls = 0
  let coldStore: KnowbookStore | null = null, coldSide: EditorRecoveryDraftStore | null = null, coldService: EditorRecoveryDraftService | null = null
  try {
    await workspace.load([f.groupId])
    const controller = workspace.getGroup(f.groupId)
    const opened = originalState.opened
    assert.ok(controller); assert.ok(opened)
    const binding = controller.bind(groupScope(controller.getSnapshot().snapshot.instances[0], f.groupId)), source = sourceSession(binding)
    const owner = await sourceOwner(source), originalSide = adopted(await adoptSyncedSourceBaseline(owner))
    assert.equal((await registerSyncedSourceHistorySide({ checkpoint: source.checkpoint, side: originalSide.side })).status, 'registered')
    const original = source.draft, marker = f.raw, at = original.source.indexOf(marker)
    assert.ok(at >= 0)
    const cut = source.edit(at, at + marker.length, '')
    source.apply(cut, 'real-local-cut')
    const copied = source.apply(source.replay(original), 'real-local-replay', owner)
    assert.equal(copied.facts.bindingClaims.filter(claim => claim.kind === 'copy' && claim.source.kind === 'ticket').length, 1)
    assert.deepEqual(controller.getSnapshot().working, originalSide.facts.snapshot.blocks.map(({ createdAt: _createdAt, ...block }) => block))
    assert.equal(controller.getSnapshot().dirty, true, 'Same bytes still have actual authored copy frames')
    assert.equal(originalPort.writes.length, 0)
    const firstCapture = captureSyncedWorkspaceRecovery(workspace)[0]
    const read = (): RecoveryContent => {
      const current = captureSyncedWorkspaceRecovery(workspace)[0]
      return { working: { kind: 'group', blocks: current.state.working, incoming: null }, authoredWork: current.authoredWork,
        ...(current.canonicalReadOwnerId ? { canonicalReadOwnerId: current.canonicalReadOwnerId } : {}),
        pending: [], selection: null, composing: false, importing: false,
        replayJson: JSON.stringify(recoveryData(current.replay)) }
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
      writeEditorRecoveryDrafts: async (input: WriteEditorRecoveryDraftsInput) => service.write(old.event, { records: input.records }, { kind: 'background' }),
      retireCleanEditorRecoveryDraft: async (input: RetireEditorRecoveryDraftInput) => { retiredCalls++; return service.retireClean(old.event, input) },
      parkEditorRecoveryDraft: async (input: ParkEditorRecoveryDraftInput) => service.park(old.event, input)
    } } })
    coordinator.register(firstCapture.identity, { kind: 'group', groupId: f.groupId }, async () => opened!, read)
    await coordinator.background()
    const durable = side.head(opened.draftSessionId)
    assert.ok(durable, 'Background COMMIT must preserve real semantic work even though complete W bytes equal B')
    assert.match(durable.record.canonicalOriginalAliasHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal(Object.hasOwn(durable.record.draft, 'authoredWork'), false)
    assert.equal(service.retireClean(old.event, { draftSessionId: opened.draftSessionId, expectedHead: durable.expected,
      working: durable.record.draft.working }), false, 'Main independently refuses to erase canonical identity/history intent solely because the complete body matches SQL')
    source.apply(source.append(' later ordinary tail'), 'real-third-local-frame')
    if (branch === 'redo') assert.equal(await binding.undo(), true)
    assert.equal(controller.getSnapshot().working[0].content.includes(marker), true)
    coordinator.observe(firstCapture.identity); await coordinator.background()
    const withRedo = side.head(opened.draftSessionId)
    assert.ok(withRedo); assert.equal(withRedo.expected.generation, durable.expected.generation + 1)
    const raw = JSON.parse(withRedo.record.draft.replayJson!)
    assert.equal(raw.frames.length, branch === 'active' ? 3 : 2); assert.equal(raw.redoFrames.length, branch === 'active' ? 0 : 1)
    coordinator.detach(firstCapture.identity); await coordinator.background(); coordinator.freeze()
    assert.equal(retiredCalls, 0, 'The actual producer cannot request byte-only clean retirement of authored canonical frames')
    assert.equal(side.head(opened.draftSessionId)!.expected.hash, withRedo.expected.hash, 'Detaching parks the actual authored history and cannot clean-retire it by equal bytes')
    await closeSyncedSourceReadOwner(owner)
    service.dispose(); side.close(); f.store.destroy()

    coldStore = KnowbookStore.openCanonicalRuntime(f.file); coldSide = new EditorRecoveryDraftStore(sidePath)
    const next = eventFor(), actualStore = coldStore
    coldService = new EditorRecoveryDraftService(coldSide, actualStore, event => next.barrier.assertEditorMutationAllowed(event))
    const actualService = coldService, actualDb = actualStore.getUnsafeDatabaseHandle()
    const nextSession = actualStore.openSyncedEditingSession(next.event.senderFrame!, { kind: 'instance', hostDocumentId: f.hostId, groupId: f.groupId, instanceId: f.instanceId })
    if (nextSession.status !== 'ready') throw new Error('A real new inline session is required')
    const freshPort = sessionApi(actualStore, next.event, nextSession.session.sessionId)
    freshPort.reads.captureBaseline = async () => { throw new Error('Recovery cannot mint a fresh baseline in place of its old original') }
    const freshWorkspace = getSyncedWorkspaceController(freshPort.api)
    await freshWorkspace.load([f.groupId])
    const freshController = freshWorkspace.getGroup(f.groupId)
    assert.ok(freshController)
    const freshBinding = freshController.bind(groupScope(freshController.getSnapshot().snapshot.instances[0], f.groupId))
    const candidate = actualService.read(next.event, withRedo.expected)
    assert.equal(candidate.writePermit, false); assert.equal(candidate.historicalKeyLineageComplete, false)
    const privateCompletion: { owner: PreparedCanonicalRecoveryCompletion | null; live: EditorRecoveryOpened | null } = { owner: null, live: null }
    const completionTransport: { input: CompleteEditorRecoveryGroupInput | null } = { input: null }
    let deliverCompletion!: (saved: boolean) => void
    const completionReply = new Promise<boolean>(resolve => { deliverCompletion = resolve })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
      prepareEditorRecoveryGroup: async (input: PrepareEditorRecoveryGroupInput) => {
        const result = actualService.prepareGroup(next.event, input)
        if (result.baseline.status !== 'ready') throw new Error('The actual old point must reopen')
        const baseline = result.baseline
        privateCompletion.owner = actualDb.transaction(() => prepareCanonicalRecoveryCompletionOwned(actualDb, result.record, baseline))()
        privateCompletion.live = actualService.open(next.event, { kind: 'group', groupId: f.groupId, sessionId: input.sessionId,
          readOwnerId: baseline.readOwnerId, openRequestId: randomUUID() })
        return result
      },
      completeEditorRecoveryGroup: async (input: CompleteEditorRecoveryGroupInput) => {
        completionTransport.input = structuredClone(input)
        return completionReply
      }
    } } })
    const before = allTables(actualDb), changes = (actualDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const oldSource = originalSide.facts.bindingSource
    assert.throws(() => resolveSyncedBindingSource(actualDb, oldSource.ticketId, oldSource.entries[0].entryId))
    const recovered = await openColdCanonicalRecoveryOwner(candidate.recoveryOwnerId, nextSession.session.sessionId, freshPort.reads)
    assert.equal(await restoreSyncedCanonicalRecovery(freshBinding, { kind: 'actual-cold-canonical-recovery-owner' }), false, 'Equal DTOs do not recreate the private cold owner')
    assert.equal(await restoreSyncedCanonicalRecovery(freshBinding, recovered), true)
    assert.equal(await restoreSyncedCanonicalRecovery(freshBinding, recovered), false, 'One actual cold owner cannot be adopted twice')
    assert.deepEqual(freshController.getSnapshot().working, controller.getSnapshot().working)
    assert.equal(freshController.getSnapshot().recoveryReview, true)
    assert.equal(await freshBinding.flush(), false)
    assert.equal(await flushSyncedWorkspacePendingChanges(freshWorkspace), false)
    if (branch === 'redo') {
      assert.equal(await freshBinding.undo(), true)
      assert.equal(await freshBinding.undo(), true)
      assert.equal(await freshBinding.undo(), false, 'Review Undo stops at the original accepted B; it cannot issue an older business inverse')
      assert.equal(await flushSyncedWorkspacePendingChanges(freshWorkspace), false, 'Restored Redo/review cannot bypass the workspace barrier at equal B bytes')
      assert.equal(await freshBinding.redo(), true)
      assert.equal(await freshBinding.redo(), true, 'The original retained copy has a real new frame lease')
      assert.equal(await freshBinding.redo(), true, 'The complete original Redo tail survives the cold owner transition')
    }
    assert.equal(freshPort.writes.length, 0)
    assert.deepEqual(allTables(actualDb), before)
    assert.equal((actualDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    assert.equal(acceptSyncedCanonicalRecoveryReview(freshBinding), true)
    assert.equal(await freshBinding.flush(), true)
    assert.equal(freshPort.writes.length, 3, 'Only explicit Save submits the three actual restored frames through Main, including the non-tail copy lease')
    const saved = freshController.getSnapshot().snapshot
    assert.deepEqual(saved.bindings.map(binding => binding.target), originalSide.facts.snapshot.bindings.map(binding => binding.target))
    const sentCopies = freshPort.writes.flatMap(input => input.bindingClaims ?? []).filter(claim => claim.kind === 'copy' && claim.source.kind === 'ticket')
    assert.equal(sentCopies.length, 1)
    assert.equal(sentCopies.some(claim => claim.kind === 'copy' && claim.source.kind === 'ticket' && claim.source.ticketId === oldSource.ticketId), false)
    const completion = privateCompletion.owner
    assert.ok(completion)
    const transactions = ['real-local-cut', 'real-local-replay', 'real-third-local-frame']
    const evidence = freshPort.accepted.map((value, index) => ({ transactionId: transactions[index], ...value }))
    const requested = completionTransport.input
    assert.ok(requested, 'The actual restored frame registry requested retirement after real Save')
    assert.deepEqual(requested.accepted, evidence)
    const savedTables = allTables(actualDb), savedChanges = (actualDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const check = (proof: unknown) => actualDb.transaction(() => attestCanonicalRecoveryCompletionOwned(actualDb, completion, withRedo.record, proof))()
    assert.equal(check(evidence), true, 'The actual old B and each real SQL receipt/history edge close the complete original branch')
    assert.equal(check(evidence.slice(0, 2)), false, 'An omitted accepted frame or Redo tail cannot retire the original')
    assert.equal(check([...evidence].reverse()), false, 'Even genuine receipts cannot be reordered')
    const wrong = structuredClone(evidence); wrong[1].input.clientOperationId = randomUUID()
    assert.equal(check(wrong), false)
    const changedAck = structuredClone(evidence); changedAck[1].ack.snapshot.history.cursor = randomUUID()
    assert.equal(check(changedAck), false)
    assert.equal(actualDb.transaction(() => attestCanonicalRecoveryCompletionOwned(actualDb, { ...completion }, withRedo.record, evidence))(), false)
    assert.deepEqual(allTables(actualDb), savedTables)
    assert.equal((actualDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n, savedChanges)
    assert.equal(coldSide.head(opened.draftSessionId)!.expected.hash, withRedo.expected.hash, 'The read-only proof does not itself retire the side head')
    assert.throws(actualDb.transaction(() => {
      const token = evidence[1].ack.snapshot.history.undoToken
      assert.ok(token)
      assert.equal(actualDb.prepare('UPDATE synced_group_history SET before_hash=? WHERE id=?').run('0'.repeat(64), token).changes, 1)
      assert.equal(attestCanonicalRecoveryCompletionOwned(actualDb, completion, withRedo.record, evidence), false, 'Exact real history bytes and hashes remain required even with the complete valid ACKs')
      throw new Error('Rollback only the fixture corruption')
    }), /Rollback only the fixture corruption/)
    assert.deepEqual(allTables(actualDb), savedTables)
    assert.equal(actualService.completeGroup(next.event, { ...requested, accepted: requested.accepted.slice(0, 2) }), false)
    assert.equal(actualService.completeGroup(next.event, { ...requested, readOwnerId: randomUUID() }), false)
    if (branch === 'active') {
      const beforeRetireChanges = (actualDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n
      const retired = actualService.completeGroup(next.event, requested)
      assert.equal(retired, true)
      assert.equal(coldSide.head(opened.draftSessionId), null)
      assert.equal((actualDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n, beforeRetireChanges)
      deliverCompletion(retired)
    } else {
      const later = structuredClone(withRedo.record.draft)
      later.expectedPreviousGeneration = later.generation; later.generation++
      later.working.blocks[0].content += ' later retained C'
      const current = coldSide.write([{ base: withRedo.record.base, draft: later }], { kind: 'background' }).records[0]
      const retired = actualService.completeGroup(next.event, requested)
      assert.equal(retired, false, 'The original accepted branch does not retire a newer side head')
      assert.equal(coldSide.head(opened.draftSessionId)!.expected.hash, current.hash)
      assert.deepEqual(coldSide.read(current).draft, later)
      deliverCompletion(retired)
    }
    assert.deepEqual(allTables(actualDb), savedTables)
    const live = privateCompletion.live
    assert.ok(live)
    const final = captureSyncedWorkspaceRecovery(freshWorkspace)[0]
    assert.equal(final.state.dirty, false); assert.equal(final.pending, null)
    const finalCheckpoint = actualService.write(next.event, { records: [{ draftSessionId: live.draftSessionId,
      generation: 1, expectedPreviousGeneration: 0, working: { kind: 'group', blocks: final.state.working, incoming: null },
      pending: [], sources: [], selection: null, composing: false, importing: false, replayJson: JSON.stringify(recoveryData(final.replay)),
      ...(final.canonicalReadOwnerId ? { canonicalReadOwnerId: final.canonicalReadOwnerId } : {}) }] }, { kind: 'background' }).records[0]
    assert.equal(actualService.list(next.event, { limit: 20 }).records.some(item => item.recordId === finalCheckpoint.recordId), false)
    assert.ok(coldSide.head(live.draftSessionId), 'Listing while the final saved producer is live cannot retire it')
    closeColdCanonicalRecoveryOwner(recovered)
    freshBinding.dispose(); assert.equal(freshWorkspace.dispose(), true)
    actualService.releaseSender(next.event.sender)
    const laterMain = KnowbookStore.openCanonicalRuntime(f.file), laterSide = new EditorRecoveryDraftStore(sidePath), laterFrame = eventFor()
    const laterService = new EditorRecoveryDraftService(laterSide, laterMain, event => laterFrame.barrier.assertEditorMutationAllowed(event))
    try {
      const db = laterMain.getUnsafeDatabaseHandle(), beforeList = allTables(db)
      const listChanges = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
      const retained = laterService.list(laterFrame.event, { limit: 20 }).records
      assert.equal(retained.some(item => item.recordId === finalCheckpoint.recordId), false)
      assert.equal(laterSide.head(live.draftSessionId), null, 'Cold Main retires the exact clean checkpoint from its actual stored ACK and history')
      assert.equal(retained.some(item => item.draftSessionId === opened.draftSessionId), branch === 'redo', 'A newer retained C stays visible')
      assert.deepEqual(allTables(db), beforeList)
      assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, listChanges)
    } finally { laterService.dispose(); laterSide.close(); laterMain.destroy() }
  } finally {
    coordinator.freeze()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window')
    service.dispose(); if (side) side.close(); coldService?.dispose(); coldSide?.close(); coldStore?.destroy()
  }
}) }

for (const branch of ['active', 'redo'] as const) test('actual same-byte CM identity intent -> durable complete ' + branch + ' frames -> cold original/new owner -> explicit Main Save', () => canonicalCase(branch))

for (const capture of ['pending', 'accepted'] as const) {
  test('cold canonical ' + capture + ' A restores later C for review and sends only C through the real Main writer', () => withV3Fixture(async f => {
    const original = eventFor(), directory = join(f.root, 'canonical-followup')
    const side = new EditorRecoveryDraftStore(directory)
    const service = new EditorRecoveryDraftService(side, f.store, event => original.barrier.assertEditorMutationAllowed(event))
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    let coldStore: KnowbookStore | null = null, coldSide: EditorRecoveryDraftStore | null = null, coldService: EditorRecoveryDraftService | null = null
    let committed!: () => void, deliverA!: () => void
    const beforeReply = new Promise<void>(resolve => { committed = resolve })
    const afterReply = new Promise<void>(resolve => { deliverA = resolve })
    try {
      const address = { kind: 'instance' as const, hostDocumentId: f.hostId, groupId: f.groupId, instanceId: f.instanceId }
      const opened = f.store.openSyncedEditingSession(original.event.senderFrame!, address)
      if (opened.status !== 'ready') throw new Error('The original editing session is unavailable')
      const sessionId = opened.session.sessionId
      const old = sessionApi(f.store, original.event, sessionId)
      const save = old.api.updateSyncedBlockGroup
      // The wrapper reports the commit via the actual Main return value before
      // withholding the renderer transport ACK. No request is staged by SQL.
      old.api.updateSyncedBlockGroup = async input => {
        const result = await save(input).finally(committed)
        await afterReply
        return result
      }
      const owner: { value?: EditorRecoveryOpened } = {}
      const oldWorkspace = getSyncedWorkspaceController(old.api, { readSources: { ...old.reads, captureBaseline: async input => {
        const baseline = await old.reads.captureBaseline(input)
        if (baseline.status === 'ready') owner.value = service.open(original.event, {
          kind: 'group', groupId: f.groupId, sessionId, readOwnerId: baseline.readOwnerId, openRequestId: randomUUID()
        })
        return baseline
      } } })
      await oldWorkspace.load([f.groupId])
      const oldController = oldWorkspace.getGroup(f.groupId), oldOwner = owner.value
      assert.ok(oldController); assert.ok(oldOwner)
      const oldBinding = oldController.bind(groupScope(oldController.getSnapshot().snapshot.instances[0], f.groupId))
      const append = (content: string) => {
        const before = oldBinding.getCurrent()
        return oldBinding.apply({ guards: syncedSnapshotGuard(before.snapshot), expectedEditSequence: before.editSequence,
          bookmark: null, transactionId: randomUUID(),
          blocks: before.working.map((block, index) => index ? block : { ...block, content: block.content + content }) })
      }
      assert.equal(append(' real A'), true)
      const saveA = oldBinding.flush()
      await beforeReply
      const operationA = old.accepted[0]
      assert.ok(operationA)
      assert.equal(operationA.ack.status, 'saved')
      assert.equal(append(' later C typed while A was in flight'), true)
      if (capture === 'accepted') { deliverA(); assert.equal(await saveA, true) }
      const frame = captureSyncedWorkspaceRecovery(oldWorkspace)[0]
      assert.equal(Boolean(frame.pending), capture === 'pending')
      const pending = frame.pending ? await recoveryPending([{ method: frame.pending.method, input: frame.pending.input,
        submittedWorking: { kind: 'group', blocks: frame.pending.submitted, incoming: null } }]) : []
      const working = { kind: 'group' as const, blocks: frame.state.working, incoming: null }
      const { draftSessionId: _draftSessionId, ...expected } = service.write(original.event, { records: [{ draftSessionId: oldOwner.draftSessionId, generation: 1,
        expectedPreviousGeneration: 0, working, pending, sources: [], selection: null, composing: false, importing: false,
        replayJson: JSON.stringify(recoveryData(frame.replay)),
        ...(frame.canonicalReadOwnerId ? { canonicalReadOwnerId: frame.canonicalReadOwnerId } : {}) }] }, { kind: 'background' }).records[0]
      deliverA()
      assert.equal(await saveA, true)
      assert.equal(old.writes.length, 1)
      oldBinding.dispose()
      service.dispose(); side.close(); f.store.destroy()

      coldStore = KnowbookStore.openCanonicalRuntime(f.file)
      coldSide = new EditorRecoveryDraftStore(directory)
      const actual = coldStore, next = eventFor()
      coldService = new EditorRecoveryDraftService(coldSide, actual, event => next.barrier.assertEditorMutationAllowed(event))
      const recovery = coldService, db = actual.getUnsafeDatabaseHandle()
      const current = actual.openSyncedEditingSession(next.event.senderFrame!, address)
      if (current.status !== 'ready') throw new Error('The fresh occurrence is unavailable')
      const freshSessionId = current.session.sessionId
      const fresh = sessionApi(actual, next.event, freshSessionId), workspace = getSyncedWorkspaceController(fresh.api)
      await workspace.load([f.groupId])
      const controller = workspace.getGroup(f.groupId)
      assert.ok(controller)
      const instance = controller.getSnapshot().snapshot.instances[0], binding = controller.bind(groupScope(instance, f.groupId))
      const guard = { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion }
      const originalRows = allTables(db)
      const originalChanges = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
      const readA = () => db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(operationA.input.clientOperationId)
      const originalOperation = readA()
      assert.ok(originalOperation)
      const candidate = recovery.read(next.event, expected)
      assert.equal(candidate.mode, 'view-only'); assert.equal(candidate.canonicalFollowupAvailable, true); assert.equal(candidate.writePermit, false)
      assert.equal(candidate.canonicalHostDocumentId, guard.hostDocumentId)
      const input = { recoveryOwnerId: candidate.recoveryOwnerId, sessionId: freshSessionId, instance: guard }
      assert.throws(() => recovery.prepareGroupFloor(next.event, { ...input, instance: { ...guard, bindingVersion: randomUUID() } }))
      assert.throws(() => recovery.prepareGroupFloor(next.event, { ...input, sessionId: randomUUID() }), /not the actual new recovery frame session/)
      assert.throws(() => recovery.prepareGroupFloor(eventFor().event, input), /Editor writes are frozen/)
      const prepared = recovery.prepareGroupFloor(next.event, input)
      const data = decodeCanonicalRecoveryFollowupData(prepared.record, prepared.floor)
      assert.equal(prepared.floor.from, capture)
      assert.equal(prepared.floor.original.key, operationA.input.clientOperationId)
      assert.equal(data.frames.length, 1); assert.deepEqual(data.frames[0].before, operationA.input.blocks)
      assert.deepEqual(data.frames[0].after, working.blocks)
      const forged = structuredClone(prepared.record)
      const packet = JSON.parse(forged.draft.replayJson!)
      packet.frames.at(-1).copySources = [{ ticketId: randomUUID(), entryId: randomUUID() }]
      forged.draft.replayJson = JSON.stringify(packet)
      assert.throws(() => decodeCanonicalRecoveryFollowupData(forged, prepared.floor), /historical copy alias/)

      let retired: boolean | undefined
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { knowbook: {
        prepareEditorRecoveryGroupFloor: async (request: PrepareEditorRecoveryGroupFloorInput) => recovery.prepareGroupFloor(next.event, request),
        completeEditorRecoveryGroup: async (request: CompleteEditorRecoveryGroupInput) => {
          assert.equal(request.readOwnerId, undefined, 'A cold continuation does not receive the old ticket namespace')
          retired = recovery.completeGroup(next.event, request)
          return retired
        }
      } } })
      const owned = await openColdCanonicalFollowupOwner(candidate.recoveryOwnerId, freshSessionId, guard)
      assert.equal(await restoreSyncedCanonicalRecovery(binding, owned), true)
      assert.equal(await restoreSyncedCanonicalRecovery(binding, owned), false)
      closeColdCanonicalRecoveryOwner(owned)
      assert.equal(binding.getCurrent().recoveryReview, true)
      assert.deepEqual(binding.getCurrent().working, working.blocks)
      assert.equal(await binding.flush(), false)
      assert.equal(await binding.undo(), true)
      assert.deepEqual(binding.getCurrent().working, operationA.input.blocks)
      assert.equal(await binding.undo(), false, 'Review Undo stops at the confirmed A')
      assert.equal(await binding.redo(), true)
      assert.deepEqual(binding.getCurrent().working, working.blocks)
      assert.equal(fresh.writes.length, 0)
      assert.deepEqual(allTables(db), originalRows)
      assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, originalChanges)

      assert.equal(acceptSyncedCanonicalRecoveryReview(binding), true)
      assert.equal(await binding.flush(), true)
      assert.equal(retired, true)
      assert.equal(fresh.writes.length, 1)
      assert.notEqual(fresh.writes[0].clientOperationId, operationA.input.clientOperationId)
      assert.equal(fresh.writes[0].expectedRevision, operationA.ack.snapshot.revision)
      assert.deepEqual(fresh.writes[0].blocks, working.blocks)
      assert.equal(coldSide.head(oldOwner.draftSessionId), null)
      assert.deepEqual(readA(), originalOperation)
      binding.dispose()
    } finally {
      deliverA()
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window')
      service.dispose(); side.close(); coldService?.dispose(); coldSide?.close(); coldStore?.destroy()
    }
  }))
}

test('canonical cold decoding keeps unfinished Source, original ACK floors, lost original frames and forged binding ranges gated', async () => withV3Fixture(async f => {
  const original = eventFor(), side = new EditorRecoveryDraftStore(join(f.root, 'gated-recovery'))
  const service = new EditorRecoveryDraftService(side, f.store, event => original.barrier.assertEditorMutationAllowed(event))
  try {
    const session = f.store.openSyncedEditingSession(original.event.senderFrame!, { kind: 'instance', hostDocumentId: f.hostId, groupId: f.groupId, instanceId: f.instanceId })
    if (session.status !== 'ready') throw new Error('Actual inline session required')
    const result = f.store.invokeSyncedEditingSession(original.event.senderFrame!, { sessionId: session.session.sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
    if (result.status !== 'ready') throw new Error('Actual initial source required')
    const opened = service.open(original.event, { kind: 'group', groupId: f.groupId, sessionId: session.session.sessionId, readOwnerId: result.readOwnerId, openRequestId: randomUUID() })
    if (opened.base.persistedWorking.kind !== 'group') throw new Error('The real sealed canonical B is required')
    const blocks = structuredClone(opened.base.persistedWorking.blocks)
    const replay = { kind: 'knowbook-canonical-recovery-data', version: 2, snapshot: result.snapshot, readSource: {
      workspaceScope: result.workspaceScope, readOwnerId: result.readOwnerId, snapshot: result.snapshot, bindingSource: result.bindingSource }, accepted: null,
      frames: [], redoFrames: [], serverRedo: [], cutServerRedo: false }
    const draft = { draftSessionId: opened.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: { kind: 'group' as const, blocks, incoming: null }, pending: [], sources: [], selection: null, composing: false, importing: false, replayJson: JSON.stringify(replay) }
    const { draftSessionId: _draftSessionId, ...expected } = service.write(original.event, { records: [draft] }, { kind: 'background' }).records[0]
    const candidate = service.read(original.event, expected), prepared = service.prepareGroup(original.event, { recoveryOwnerId: candidate.recoveryOwnerId, sessionId: session.session.sessionId })
    const before = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    assert.equal(decodeCanonicalRecoveryData(prepared.record, prepared.baseline).frames.length, 0)
    for (const change of [
      (value: typeof replay) => { Reflect.set(value, 'accepted', { guessed: 'equal-looking-ACK' }) },
      (value: typeof replay) => { Reflect.set(value, 'version', 1) },
      (value: typeof replay) => { Reflect.set(value, 'redoFrames', undefined) },
      (value: typeof replay) => { Reflect.set(value, 'unexpected', true) }
    ]) {
      const wrong = structuredClone(replay); change(wrong)
      assert.throws(() => decodeCanonicalRecoveryData({ ...prepared.record, draft: { ...prepared.record.draft, replayJson: canonicalSyncedPortableJson(wrong) } }, prepared.baseline))
    }
    const changedW = structuredClone(prepared.record); changedW.draft.working.blocks[0].content += ' no real captured frame'
    assert.throws(() => decodeCanonicalRecoveryData(changedW, prepared.baseline), /real private frame tail/)
    const wrongRange = structuredClone(replay), originalKey = result.bindingSource.entries[0].key
    Reflect.set(wrongRange, 'cutServerRedo', true)
    Reflect.set(wrongRange.frames, 0, { before: blocks, after: blocks, copySources: [], instance: {
      instanceId: f.instanceId, hostDocumentId: f.hostId, bindingVersion: result.snapshot.instances[0].bindingVersion }, transactionId: randomUUID(), sequence: 1,
      bindingClaims: [{ kind: 'continue', source: originalKey,
        destination: { ...originalKey, from: originalKey.from + 1, to: originalKey.to + 1 } }] })
    assert.throws(() => decodeCanonicalRecoveryData({ ...prepared.record, draft: { ...prepared.record.draft, replayJson: JSON.stringify(wrongRange) } }, prepared.baseline), /exact frame ranges/)
    const unfinished = structuredClone(prepared.record); unfinished.draft.sources.push({ sourceId: randomUUID(), kind: 'canonical', openingSource: 'B', acceptedSource: 'B',
      source: 'unclosed C\u0000\ud800', selection: { anchor: 1, head: 0 }, composing: false, importing: false, applying: false })
    assert.throws(() => decodeCanonicalRecoveryData(unfinished, prepared.baseline), /pending\/Source\/conflict replay/)
    assert.deepEqual(allTables(f.db), before)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  } finally { service.dispose(); side.close() }
}))
