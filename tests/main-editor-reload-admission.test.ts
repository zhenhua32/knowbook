import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createEditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { runSyncedEditingSessionWithAdmission } from '../src/main/synced-editing-session-admission'
import { KnowbookStore } from '../src/main/database/store'
import { SYNCED_METADATA_BASELINE2_PREFIX } from '../src/main/database/synced-metadata-capture-record2'
import { withV3Fixture, allTables } from './helpers/synced-backup-v3-fixture'
import { EDITOR_CLOSE_REQUEST_CHANNEL, EDITOR_CLOSE_CANCELLED_CHANNEL, type EditorCloseRequest } from '../src/shared/editor-close'

let nextId = 1
class Contents extends EventEmitter {
  readonly id = nextId++; mainFrame = { processId: this.id + 100, routingId: this.id + 200, detached: false }
  destroyed = false; readonly sent: Array<{ channel: string; value: unknown }> = []
  isDestroyed() { return this.destroyed }
  getOSProcessId() { return this.id + 300 }
  send(channel: string, value: unknown) { this.sent.push({ channel, value }) }
  requests() { return this.sent.filter(item => item.channel === EDITOR_CLOSE_REQUEST_CHANNEL).map(item => item.value as EditorCloseRequest) }
  navigate() {
    this.emit('did-start-navigation', {}, 'file:///renderer/index.html', false, true)
    this.mainFrame = { processId: this.mainFrame.processId + 1, routingId: this.mainFrame.routingId + 1, detached: false }
  }
}
class Window extends EventEmitter {
  readonly webContents = new Contents(); destroyed = false; closed = 0
  isDestroyed() { return this.destroyed }
  close() {
    let prevented = false
    this.emit('close', { preventDefault() { prevented = true } })
    if (!prevented) { this.closed++; this.destroyed = true; this.webContents.destroyed = true; this.emit('closed') }
  }
}
function harness() {
  let shutdowns = 0, reloadThrows = false
  const timers = new Set<() => void>(), budgets: number[] = [], reloads: Array<{ window: Window; ignoreCache: boolean }> = []
  const barrier = createEditorCloseBarrier({ beginShutdown() { shutdowns++ },
    reloadEditor(window, ignoreCache) { if (reloadThrows) throw new Error('actual reload failed'); reloads.push({ window: window as Window, ignoreCache }) },
    setTimer(callback, budget) { budgets.push(budget); timers.add(callback); return callback }, clearTimer(timer) { timers.delete(timer as () => void) } })
  const event = (window: Window): EditorCloseIpcEvent => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame })
  const ack = (window: Window, status: 'flushed' | 'blocked' = 'flushed', requestId = window.webContents.requests().at(-1)!.requestId) => barrier.acknowledge(event(window), { requestId, status })
  return { barrier, event, ack, timers, budgets, reloads, get shutdowns() { return shutdowns },
    throwReload() { reloadThrows = true }, expire() { for (const callback of [...timers]) callback() },
    window() { const window = new Window(); barrier.registerWindow(window); return window } }
}

test('reload requires its exact current frame nonce and complete drain, stays frozen until real navigation, and never shuts services down', async () => {
  const h = harness(), window = h.window(), foreign = new Window(), oldEvent = h.event(window)
  const nonce = h.barrier.requestReload(oldEvent)!
  assert.ok(nonce)
  assert.equal(h.barrier.requestReload(oldEvent, true), nonce, 'repetition cannot upgrade the accepted reload cache mode')
  assert.deepEqual(window.webContents.requests(), [{ requestId: nonce, reason: 'reload' }])
  assert.equal(h.barrier.requestReload(h.event(foreign)), null)
  assert.equal(h.barrier.requestReload({ sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } }), null)
  assert.equal(h.barrier.acknowledge(h.event(foreign), { requestId: nonce, status: 'flushed' }), false)
  await h.barrier.runEditorMutation(h.event(window), () => undefined)
  assert.equal(h.reloads.length, 0)
  const lateTimer = [...h.timers][0]
  assert.equal(h.ack(window), true)
  assert.deepEqual(h.reloads, [{ window, ignoreCache: false }])
  assert.equal(h.shutdowns, 0); assert.equal(window.closed, 0); assert.equal(h.timers.size, 0)
  assert.throws(() => h.barrier.assertEditorMutationAllowed(h.event(window)), /frozen/)
  lateTimer()
  window.webContents.emit('did-start-navigation', {}, 'file:///renderer/index.html#same-realm', true, true)
  assert.throws(() => h.barrier.assertEditorMutationAllowed(h.event(window)), /frozen/, 'late timer or in-place navigation must not reopen saved input before queued full reload')
  assert.equal(h.barrier.replayPending(h.event(window)), false)
  window.webContents.navigate()
  assert.equal(h.barrier.acknowledge(oldEvent, { requestId: nonce, status: 'flushed' }), false)
  assert.equal(h.barrier.replayPending(h.event(window)), false)
  assert.equal(window.webContents.sent.some(item => item.channel === EDITOR_CLOSE_CANCELLED_CHANNEL), false, 'successful reload must not unlock its departing old W realm')
  h.barrier.assertEditorMutationAllowed(h.event(window))
  assert.equal(h.shutdowns, 0)
  // The production admission helper must also reject the new persistent read
  // evidence while an admitted reload has not actually started navigation.
  // Only the structural reload/window port is fake; DB/session/point capture
  // and the nonce/ACK state machine are actual Main implementations.
  await withV3Fixture(async f => {
    const store = KnowbookStore.openCanonicalRuntime(f.file), r = harness(), editor = r.window(), event = r.event(editor)
    try {
      const db = store.getUnsafeDatabaseHandle(), opened = store.openSyncedEditingSession(event.senderFrame!, {
        kind: 'instance', hostDocumentId: f.hostId, instanceId: f.instanceId, groupId: f.groupId })
      assert.equal(opened.status, 'ready'); if (opened.status !== 'ready') throw new Error('The real original instance must open')
      const capture = () => runSyncedEditingSessionWithAdmission(r.barrier, event, 'captureBaseline', () =>
        store.invokeSyncedEditingSession(event.senderFrame!, { sessionId: opened.session.sessionId, method: 'captureBaseline', input: { groupId: f.groupId } }))
      assert.equal((db.prepare('SELECT count(*) AS n FROM synced_operations WHERE substr(client_operation_id,1,?)=?')
        .get(SYNCED_METADATA_BASELINE2_PREFIX.length, SYNCED_METADATA_BASELINE2_PREFIX) as { n: number }).n, 0,
      'An incorrectly admitted invocation would have to persist an actual new point')
      const before = allTables(db), started = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
      const reload = r.barrier.requestReload(event)!
      assert.equal(r.ack(editor, 'flushed', reload), true)
      assert.equal(r.reloads.length, 1); assert.equal(r.shutdowns, 0); assert.equal(db.open, true)
      await assert.rejects(async () => capture(), /frozen/)
      assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, started)
      assert.deepEqual(allTables(db), before)
      assert.equal(r.barrier.isShuttingDown(), false, 'Reload admission is separate from service teardown')
      const ordinary = store.getDocumentDetail(f.targetId); assert.ok(ordinary)
      const input = { title: ordinary.title, summary: ordinary.summary + ' saved after new realm readiness',
        blocks: ordinary.blocks, expectedUpdatedAt: ordinary.updatedAt }
      const writeOrdinary = () => r.barrier.runEditorMutation(event, () => store.updateDocument(f.targetId, input))
      // Emit the actual start-event shape without the fake navigate() helper's
      // immediate frame replacement. The old realm can still own this frame
      // while its real replacement document has not announced listener READY.
      editor.webContents.emit('did-start-navigation', {}, 'file:///renderer/index.html', false, true)
      assert.equal(editor.webContents.mainFrame, event.senderFrame)
      await assert.rejects(writeOrdinary, /frozen/)
      assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, started)
      assert.deepEqual(allTables(db), before, 'Navigation start alone cannot admit a real ordinary SQL write')
      editor.webContents.emit('did-start-navigation', {}, 'file:///renderer/index.html#same-realm', true, true)
      await assert.rejects(writeOrdinary, /frozen/)
      assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, started)
      assert.deepEqual(allTables(db), before)
      // Normal subscriptions never send another READY. This direct barrier
      // port models the new preload's actual listener-ready notification; it
      // is not a fabricated close ACK or a promise that Electron was tested.
      assert.equal(r.barrier.replayPending(event), false)
      await writeOrdinary()
      const saved = store.getDocumentDetail(f.targetId); assert.ok(saved)
      assert.equal(saved.summary, input.summary); assert.notEqual(saved.updatedAt, ordinary.updatedAt)
      assert.ok((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n > started)
      assert.equal(r.barrier.acknowledge(event, { requestId: reload, status: 'flushed' }), false)
    } finally { store.destroy() }
  })
})

test('reload 8s timeout, renderer blocker and in-flight Main Promise only cancel; no path manufactures permission to reload', async () => {
  const h = harness(), window = h.window()
  const timed = h.barrier.requestReload(h.event(window), true)!
  assert.deepEqual(h.budgets, [8000]); h.expire()
  assert.equal(h.reloads.length, 0); assert.equal(h.shutdowns, 0); assert.equal(window.closed, 0)
  assert.equal(h.ack(window, 'flushed', timed), false)
  h.barrier.assertEditorMutationAllowed(h.event(window))
  h.barrier.requestReload(h.event(window)); assert.equal(h.ack(window, 'blocked'), true)
  assert.equal(h.reloads.length, 0)
  let release!: () => void
  const work = h.barrier.runEditorMutation(h.event(window), () => new Promise<void>(resolve => { release = resolve }))
  h.barrier.requestReload(h.event(window)); assert.equal(h.ack(window), false)
  assert.equal(h.reloads.length, 0)
  release(); await work
  h.barrier.requestReload(h.event(window), true); assert.equal(h.ack(window), true)
  assert.equal(h.reloads.length, 1); assert.equal(h.reloads[0].ignoreCache, true)
  h.expire(); assert.throws(() => h.barrier.assertEditorMutationAllowed(h.event(window)), /frozen/, 'an admitted queued navigation must not reopen old input on a timer')
})

test('X and quit replace only waiting reloads; intents arriving after admission wait for fresh-frame listener readiness and a new nonce', () => {
  const x = harness(), one = x.window()
  const reload = x.barrier.requestReload(x.event(one))!
  one.close()
  assert.equal(one.webContents.requests().at(-1)!.reason, 'window')
  assert.notEqual(one.webContents.requests().at(-1)!.requestId, reload)
  assert.equal(x.ack(one, 'flushed', reload), false); assert.equal(x.ack(one), true)
  assert.equal(one.closed, 1); assert.equal(x.reloads.length, 0); assert.equal(x.shutdowns, 0)

  const h = harness(), a = h.window(), b = h.window()
  const admitted = h.barrier.requestReload(h.event(a))!, oldEvent = h.event(a)
  assert.equal(h.ack(a), true)
  b.close() // Must not turn a different window's queued X into X for a.
  assert.equal(b.closed, 0); assert.equal(b.webContents.requests().length, 0)
  assert.equal(h.barrier.requestQuit(), admitted)
  assert.equal(h.shutdowns, 0)
  a.webContents.navigate()
  assert.equal(h.barrier.replayPending(oldEvent), false)
  assert.equal(h.barrier.replayPending(h.event(a)), true)
  const quit = a.webContents.requests().at(-1)!
  assert.equal(quit.reason, 'quit'); assert.notEqual(quit.requestId, admitted)
  assert.equal(b.webContents.requests().at(-1)!.requestId, quit.requestId)
  assert.equal(h.ack(a, 'flushed', admitted), false)
  assert.equal(h.ack(a), true); assert.equal(h.shutdowns, 0)
  assert.equal(h.ack(b), true); assert.equal(h.shutdowns, 1)
})

test('actual reload call failure cancels without shutdown; unadmitted navigation/process loss cannot retain a live reload permit', () => {
  const h = harness(), window = h.window()
  h.throwReload(); h.barrier.requestReload(h.event(window)); assert.equal(h.ack(window), true)
  assert.equal(h.reloads.length, 0); assert.equal(h.shutdowns, 0)
  h.barrier.assertEditorMutationAllowed(h.event(window))
  const waiting = h.barrier.requestReload(h.event(window))!
  window.webContents.navigate()
  assert.equal(h.ack(window, 'flushed', waiting), false)
  const crash = h.barrier.requestReload(h.event(window))!
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(h.ack(window, 'flushed', crash), false)
  assert.equal(h.shutdowns, 0)
  const legacy = createEditorCloseBarrier({ beginShutdown() {} })
  const withoutReloadPort = new Window(); legacy.registerWindow(withoutReloadPort)
  assert.equal(legacy.requestReload(h.event(withoutReloadPort)), null, 'legacy close-only constructors gain no fake reload port')
})
