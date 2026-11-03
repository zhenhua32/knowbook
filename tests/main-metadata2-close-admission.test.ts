import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { SyncedGroupSnapshot } from '../src/shared/synced-blocks'
import type { EditorCloseRequest } from '../src/shared/editor-close'
import { EDITOR_CLOSE_REQUEST_CHANNEL } from '../src/shared/editor-close'
import { createEditorCloseBarrier } from '../src/main/editor-close-barrier'
import { runSyncedEditingSessionWithAdmission } from '../src/main/synced-editing-session-admission'
import { KnowbookStore } from '../src/main/database/store'
import { SYNCED_METADATA_BASELINE2_PREFIX } from '../src/main/database/synced-metadata-capture-record2'
import { withV3Fixture, allTables } from './helpers/synced-backup-v3-fixture'

// Structural window/frame delivery only. The request nonce, admission/ACK state
// machine, original DB, editing session and every captured point are real Main
// implementations. This Node test does not claim an Electron teardown run.
class Contents extends EventEmitter {
  readonly id = 1
  readonly mainFrame = { processId: 101, routingId: 201, detached: false }
  readonly requests: EditorCloseRequest[] = []
  isDestroyed() { return false }
  getOSProcessId() { return 301 }
  send(channel: string, value: unknown) { if (channel === EDITOR_CLOSE_REQUEST_CHANNEL) this.requests.push(value as EditorCloseRequest) }
}
class Window extends EventEmitter {
  readonly webContents = new Contents()
  isDestroyed() { return false }
  close() { throw new Error('The quit test never asks a fake window to close') }
}

test('real metadata2 source capture obeys waiting, cancellation and acknowledged quit admission without revoking existing read owners or cleanup', () => withV3Fixture(async f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file), window = new Window(), db = store.getUnsafeDatabaseHandle()
  let shutdowns = 0, finishShutdown!: () => void
  const heldShutdown = new Promise<void>(resolve => { finishShutdown = resolve })
  const barrier = createEditorCloseBarrier({ beginShutdown() { shutdowns++; return heldShutdown } })
  barrier.registerWindow(window)
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  try {
    const opened = store.openSyncedEditingSession(event.senderFrame, { kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
    assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw new Error('The actual original instance must open')
    const sessionId = opened.session.sessionId
    const capture = () => runSyncedEditingSessionWithAdmission(barrier, event, 'captureBaseline', () =>
      store.invokeSyncedEditingSession(event.senderFrame, { sessionId, method: 'captureBaseline', input: { groupId: f.groupId } }))
    const change = (snapshot: SyncedGroupSnapshot, suffix: string) => {
      const instance = snapshot.instances.find(item => item.instanceId === f.instanceId); assert.ok(instance)
      return runSyncedEditingSessionWithAdmission(barrier, event, 'updateSyncedBlockGroup', () =>
        store.invokeSyncedEditingSession(event.senderFrame, { sessionId, method: 'updateSyncedBlockGroup', input: {
          clientOperationId: randomUUID(), groupId: f.groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision,
          expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
          blocks: snapshot.blocks.map(({ createdAt: _birth, ...block }, index) => ({ ...block, content: index === 0 ? block.content + suffix : block.content }))
        } }))
    }
    const countPoints = () => (db.prepare('SELECT count(*) AS n FROM synced_operations WHERE substr(client_operation_id,1,?)=?')
      .get(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX) as { n: number }).n
    const totalChanges = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const waiting = barrier.requestQuit()!
    assert.deepEqual(window.webContents.requests.at(-1), { requestId: waiting, reason: 'quit' })
    const original = await capture(); assert.equal(original.status, 'ready')
    if (original.status !== 'ready') throw new Error('Waiting admission permits the genuine original point')
    assert.equal(countPoints(), 1); assert.equal(shutdowns, 0)
    assert.equal(barrier.acknowledge(event, { requestId: waiting, status: 'blocked', message: 'The actual draft still needs editing' }), true)
    assert.equal(barrier.isShuttingDown(), false)
    const edited = await change(original.snapshot, ' after matching cancellation')
    assert.equal(edited.status, 'saved'); if (edited.status !== 'saved') throw new Error('The unchanged business admission must allow this real canonical edit')
    const resumed = await capture(); assert.equal(resumed.status, 'ready')
    if (resumed.status !== 'ready') throw new Error('Matching cancellation must restore real capture admission')
    assert.equal(resumed.snapshot.revision, edited.snapshot.revision); assert.equal(countPoints(), 2)
    const latest = await change(resumed.snapshot, ' new point not yet captured')
    assert.equal(latest.status, 'saved'); if (latest.status !== 'saved') throw new Error('The real writer must prepare a new distinct point')
    assert.notEqual(latest.snapshot.revision, resumed.snapshot.revision)
    const before = allTables(db), started = totalChanges(), quitting = barrier.requestQuit()!
    assert.notEqual(quitting, waiting)
    assert.equal(barrier.acknowledge(event, { requestId: quitting, status: 'flushed' }), true)
    assert.equal(shutdowns, 1); assert.equal(barrier.isShuttingDown(), true)
    assert.equal(db.open, true, 'The actual DB and original frame session still exist while shutdown awaits')
    await assert.rejects(async () => capture(), /frozen/)
    assert.equal(totalChanges(), started, 'Rejected post-ACK capture must not INSERT then rollback a point')
    assert.deepEqual(allTables(db), before); assert.equal(countPoints(), 2)
    const validated = await runSyncedEditingSessionWithAdmission(barrier, event, 'validateOwner', () =>
      store.invokeSyncedEditingSession(event.senderFrame, { sessionId, method: 'validateOwner', input: { readOwnerId: original.readOwnerId } }))
    assert.deepEqual(validated, { status: 'ready', workspaceScope: original.workspaceScope })
    const read = await runSyncedEditingSessionWithAdmission(barrier, event, 'getSyncedGroupSnapshots', () =>
      store.invokeSyncedEditingSession(event.senderFrame, { sessionId, method: 'getSyncedGroupSnapshots', input: { groupIds: [f.groupId] } }))
    assert.equal(read.items[0].status, 'ready')
    if (read.items[0].status === 'ready') assert.equal(read.items[0].snapshot.revision, latest.snapshot.revision)
    await runSyncedEditingSessionWithAdmission(barrier, event, 'releaseOwner', () =>
      store.invokeSyncedEditingSession(event.senderFrame, { sessionId, method: 'releaseOwner', input: { readOwnerId: original.readOwnerId } }))
    assert.equal(store.invokeSyncedEditingSession(event.senderFrame, { sessionId, method: 'validateOwner', input: { readOwnerId: original.readOwnerId } }).status, 'owner-unavailable')
    assert.equal(totalChanges(), started); assert.deepEqual(allTables(db), before)
  } finally { finishShutdown(); store.destroy() }
}))

test('the production session IPC uses the same admission seam without moving its actual invoke and notification closure', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(source, /import\s*\{\s*runSyncedEditingSessionWithAdmission\s*\}\s*from\s*['"]\.\/synced-editing-session-admission['"]/)
  assert.match(source, /return runSyncedEditingSessionWithAdmission\(editorCloseBarrier, event, input\.method, invoke\)/)
  assert.match(source, /const result=store\.invokeSyncedEditingSession\(event\.senderFrame!,input\)/)
})
