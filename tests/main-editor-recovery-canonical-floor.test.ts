import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { attestCanonicalRecoveryAcceptedFloorOwned } from '../src/main/editor-recovery/canonical-accepted-floor'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import type { EditorRecoveryDraftInput, EditorRecoveryWorking } from '../src/shared/editor-recovery-drafts'
import type { SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { recoveryPending } from '../src/renderer/src/features/editor-recovery/coordinator'
import { allTables, withV3Fixture } from './helpers/synced-backup-v3-fixture'

class Contents extends EventEmitter {
  readonly id = 12
  readonly mainFrame = { processId: 102, routingId: 202, detached: false }
  isDestroyed() { return false }
  getOSProcessId() { return 302 }
  send() {}
}
class FixtureWindow extends EventEmitter {
  readonly webContents = new Contents()
  isDestroyed() { return false }
  close() {}
}

test('actual sealed B and the exact original group commit prove A for accepted and pending captures without adopting later C or retrying a nonce', () => withV3Fixture(async f => {
  const barrier = createEditorCloseBarrier({ beginShutdown() {} }), window = new FixtureWindow()
  barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const side = new EditorRecoveryDraftStore(join(f.root, 'floor-side'))
  const service = new EditorRecoveryDraftService(side, f.store, input => barrier.assertEditorMutationAllowed(input))
  try {
    const opened = f.store.openSyncedEditingSession(event.senderFrame!, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
    if (opened.status !== 'ready') throw new Error('Actual group session required')
    const sessionId = opened.session.sessionId
    const original = f.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
    if (original.status !== 'ready') throw new Error('Actual original baseline required')
    const draftOwner = service.open(event, { kind: 'group', groupId: f.groupId, sessionId, readOwnerId: original.readOwnerId, openRequestId: randomUUID() })
    const snapshot = original.snapshot, instance = snapshot.instances[0]
    const submitted: SyncedUpdateGroupInput = { clientOperationId: randomUUID(), groupId: f.groupId, expectedRevision: snapshot.revision,
      expectedTopologyRevision: snapshot.topologyRevision,
      expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
      blocks: syncedCanonicalEdits(snapshot.blocks).map(block => ({ ...block, content: block.content + ' actual submitted A' })) }
    const ack = f.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'updateSyncedBlockGroup', input: submitted })
    assert.equal(ack.status, 'saved')
    if (ack.status !== 'saved') throw new Error('The real writer must commit A')
    const submittedWorking: EditorRecoveryWorking = { kind: 'group', blocks: submitted.blocks, incoming: null }
    const later: EditorRecoveryWorking = { kind: 'group', blocks: submitted.blocks.map(block => ({ ...block, content: block.content + ' later durable C' })), incoming: null }
    const captured = await recoveryPending([{ method: 'updateSyncedBlockGroup', input: submitted, submittedWorking }])
    const draft: EditorRecoveryDraftInput = { draftSessionId: draftOwner.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: later, pending: captured, sources: [], selection: null, composing: false, importing: false }
    const { draftSessionId: _firstSessionId, ...first } = service.write(event, { records: [draft] }, { kind: 'background' }).records[0]
    const retainedPending = side.read(first)
    const { status: _status, ...readSource } = original
    const acknowledged = { kind: 'knowbook-canonical-recovery-data', version: 2, snapshot: ack.snapshot, readSource,
      accepted: { method: 'updateSyncedBlockGroup', input: submitted, ack }, frames: [], redoFrames: [], serverRedo: [], cutServerRedo: true }
    const { draftSessionId: _secondSessionId, ...second } = service.write(event, { records: [{ ...draft, generation: 2, expectedPreviousGeneration: 1, pending: [],
      replayJson: JSON.stringify(acknowledged) }] }, { kind: 'background' }).records[0]
    const retainedAccepted = side.read(second), before = allTables(f.db)
    const changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const attest = (value: unknown) => f.db.transaction(() => attestCanonicalRecoveryAcceptedFloorOwned(f.db, value))()
    for (const [from, retained] of [['pending', retainedPending], ['accepted', retainedAccepted]] as const) {
      const proof = attest(retained)
      assert.ok(proof)
      assert.equal(proof.from, from); assert.equal(proof.original.key, submitted.clientOperationId)
      assert.deepEqual(proof.floor, ack.snapshot); assert.deepEqual(proof.submitted, submittedWorking)
      assert.deepEqual(proof.retainedWorking, later)
      assert.equal(proof.sourceReplayComplete, false); assert.equal(proof.historicalKeyLineageComplete, false); assert.equal(proof.writePermit, false)
    }
    const mismatch = structuredClone(retainedPending); mismatch.draft.pending[0].requestHash = '0'.repeat(64)
    assert.equal(attest(mismatch), null)
    const alteredOriginal = structuredClone(retainedAccepted); alteredOriginal.base.originals[0].createdAt = '2020-01-01T00:00:00.000Z'
    assert.equal(attest(alteredOriginal), null)
    const changedAck = structuredClone(acknowledged); changedAck.accepted.ack.snapshot.history.cursor = randomUUID()
    assert.equal(attest({ ...retainedAccepted, draft: { ...retainedAccepted.draft, replayJson: JSON.stringify(changedAck) } }), null)
    assert.deepEqual(allTables(f.db), before)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    const token = ack.snapshot.history.undoToken
    assert.ok(token)
    assert.throws(f.db.transaction(() => {
      assert.equal(f.db.prepare('UPDATE synced_group_history SET before_hash=? WHERE id=?').run('0'.repeat(64), token).changes, 1)
      assert.equal(attestCanonicalRecoveryAcceptedFloorOwned(f.db, retainedAccepted), null)
      throw new Error('Rollback fixture corruption')
    }), /Rollback fixture corruption/)
    assert.deepEqual(allTables(f.db), before)

    const newer = f.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId, method: 'updateSyncedBlockGroup', input: {
      ...submitted, clientOperationId: randomUUID(), expectedRevision: ack.snapshot.revision,
      blocks: submitted.blocks.map(block => ({ ...block, content: block.content + ' separately saved D' })) } })
    assert.equal(newer.status, 'saved')
    assert.equal(attest(retainedPending), null); assert.equal(attest(retainedAccepted), null)
    assert.deepEqual(side.read(second).draft.working, later, 'An older attested nonce never overwrites current D or the retained C')
  } finally { service.dispose(); side.close() }
}))
