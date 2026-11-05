import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { withV3Fixture, allTables, randomUUID } from './helpers/synced-backup-v3-fixture'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import type { EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'

class Contents extends EventEmitter {
  readonly id = 12; readonly mainFrame = { processId: 102, routingId: 202, detached: false }
  isDestroyed() { return false }; getOSProcessId() { return 302 }; send() {}
}
class Window extends EventEmitter { readonly webContents = new Contents(); isDestroyed() { return false }; close() {} }

test('a retained generation-one candidate cannot mint an old recovery owner after generation two is durable, while the actual latest candidate reopens the sealed original without SQL writes', () => withV3Fixture(f => {
  const window = new Window(), barrier = createEditorCloseBarrier({ beginShutdown() {} }); barrier.registerWindow(window)
  const event: EditorCloseIpcEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const side = new EditorRecoveryDraftStore(join(f.root, 'recovery')), service = new EditorRecoveryDraftService(side, f.store, value => barrier.assertEditorMutationAllowed(value))
  try {
    const session = f.store.openSyncedEditingSession(event.senderFrame!, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
    assert.equal(session.status, 'ready'); if (session.status !== 'ready') throw new Error('Actual inline session required')
    const baseline = f.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId: session.session.sessionId, method: 'captureBaseline', input: { groupId: f.groupId } })
    assert.equal(baseline.status, 'ready'); if (baseline.status !== 'ready') throw new Error('Actual initial source required')
    const opened = service.open(event, { kind: 'group', groupId: f.groupId, sessionId: session.session.sessionId, readOwnerId: baseline.readOwnerId, openRequestId: randomUUID() })
    const draft: EditorRecoveryDraftInput = { draftSessionId: opened.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: structuredClone(opened.base.persistedWorking), pending: [], sources: [], selection: null, composing: false, importing: false }
    const first = service.write(event, { records: [draft] }, { kind: 'background' }).records[0]
    const oldCandidate = service.read(event, { recordId: first.recordId, generation: first.generation, hash: first.hash })
    const next = structuredClone(draft); next.generation = 2; next.expectedPreviousGeneration = 1
    next.working.blocks[0].content += ' local generation two'
    // Direct actual side-store transaction deliberately retains gen1. This
    // proves the cold check binds its current head instead of relying on GC.
    const second = side.write([{ base: opened.base, draft: next }], { kind: 'background' }).records[0]
    assert.equal(side.read(first).draft.generation, 1)
    const before = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    assert.throws(() => service.prepareGroup(event, { recoveryOwnerId: oldCandidate.recoveryOwnerId, sessionId: session.session.sessionId }), /old cold owner.*newer durable/)
    assert.equal(f.store.invokeSyncedEditingSession(event.senderFrame!, { sessionId: session.session.sessionId, method: 'validateOwner', input: { readOwnerId: baseline.readOwnerId } }).status, 'ready')
    const current = service.read(event, { recordId: second.recordId, generation: second.generation, hash: second.hash })
    const prepared = service.prepareGroup(event, { recoveryOwnerId: current.recoveryOwnerId, sessionId: session.session.sessionId })
    assert.equal(prepared.baseline.status, 'ready'); assert.equal(prepared.writePermit, false); assert.equal(prepared.historicalKeyLineageComplete, false)
    assert.deepEqual(allTables(f.db), before)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  } finally { service.dispose(); side.close() }
}))
