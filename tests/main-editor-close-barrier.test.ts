import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createEditorCloseBarrier, type EditorCloseBarrier, type EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import { EDITOR_CLOSE_REQUEST_CHANNEL, EDITOR_CLOSE_CANCELLED_CHANNEL, type EditorCloseRequest,
  type EditorCloseCancelled } from '../src/shared/editor-close'

let nextId = 1
class FakeContents extends EventEmitter {
  readonly id = nextId++
  mainFrame = { processId: this.id + 100, routingId: this.id + 200, detached: false }
  osProcessId = this.id + 300
  destroyed = false
  readonly sent: Array<{ channel: string; value: unknown }> = []
  onSend?: (channel: string, value: unknown) => void
  isDestroyed() { return this.destroyed }
  getOSProcessId() { return this.osProcessId }
  send(channel: string, value: unknown) {
    this.sent.push({ channel, value })
    this.onSend?.(channel, value)
  }
  requests() { return this.sent.filter(item => item.channel === EDITOR_CLOSE_REQUEST_CHANNEL).map(item => item.value as EditorCloseRequest) }
  cancellations() { return this.sent.filter(item => item.channel === EDITOR_CLOSE_CANCELLED_CHANNEL).map(item => item.value as EditorCloseCancelled) }
  reload() {
    this.emit('did-start-navigation', {}, 'file:///renderer/index.html', false, true)
    this.mainFrame = { processId: this.mainFrame.processId + 1, routingId: this.mainFrame.routingId + 1, detached: false }
    this.osProcessId++
  }
}
class FakeWindow extends EventEmitter {
  readonly webContents = new FakeContents()
  destroyed = false
  closeCalls = 0
  prevented = 0
  isDestroyed() { return this.destroyed }
  close() {
    if (this.destroyed) return
    this.closeCalls++
    let blocked = false
    this.emit('close', { preventDefault() { blocked = true } })
    if (blocked) { this.prevented++; return }
    this.forceClose()
  }
  forceClose() {
    this.webContents.destroyed = true
    this.webContents.emit('destroyed')
    this.destroyed = true
    this.emit('closed')
  }
}
function harness(options: { beginShutdown?: () => void | Promise<void>; onShutdownError?: (error: unknown) => void } = {}) {
  let shutdownCalls = 0, timerId = 0
  const timers = new Map<number, () => void>(), budgets: number[] = []
  const barrier = createEditorCloseBarrier({
    beginShutdown() { shutdownCalls++; return options.beginShutdown?.() },
    onShutdownError: options.onShutdownError,
    setTimer(callback, budget) { budgets.push(budget); const id = ++timerId; timers.set(id, callback); return id },
    clearTimer(id) { timers.delete(id as number) }
  })
  return { barrier, timers, budgets, get shutdownCalls() { return shutdownCalls },
    window() { const window = new FakeWindow(); barrier.registerWindow(window); return window },
    expire() { for (const callback of [...timers.values()]) callback() } }
}
function event(window: FakeWindow): EditorCloseIpcEvent { return { sender: window.webContents, senderFrame: window.webContents.mainFrame } }
function ack(barrier: EditorCloseBarrier, window: FakeWindow, status: 'flushed' | 'blocked' = 'flushed', requestId = window.webContents.requests().at(-1)!.requestId) {
  return barrier.acknowledge(event(window), { requestId, status })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('editor X waits for its real frame ACK, deduplicates repeated X, and preserves window-only semantics', async () => {
  const h = harness(), window = h.window(), contents = window.webContents
  window.close(); window.close()
  assert.equal(window.isDestroyed(), false)
  assert.equal(window.prevented, 2)
  assert.equal(contents.requests().length, 1)
  assert.equal(contents.requests()[0].reason, 'window')
  assert.equal(h.shutdownCalls, 0)
  let saved = 0
  await h.barrier.runEditorMutation(event(window), () => { saved++ })
  assert.equal(saved, 1, 'pending phase must admit the real renderer flush')
  assert.equal(ack(h.barrier, window), true)
  assert.equal(window.isDestroyed(), true)
  assert.equal(h.shutdownCalls, 0, 'window X must not silently become app quit on macOS')
  assert.equal(h.timers.size, 0)
  assert.equal(h.barrier.requestQuit() !== null, true)
  assert.equal(h.shutdownCalls, 1, 'normal final-window app quit may now begin shutdown')
})

test('app quit waits all current editor windows; blocked ACK cancels and unfreezes every peer', async () => {
  const h = harness(), a = h.window(), b = h.window()
  const first = h.barrier.requestQuit()!
  assert.equal(h.barrier.requestQuit(), first)
  assert.equal(a.webContents.requests().length, 1)
  assert.equal(b.webContents.requests().length, 1)
  assert.equal(ack(h.barrier, a), true)
  assert.throws(() => h.barrier.assertEditorMutationAllowed(event(a)), /frozen/)
  h.barrier.assertEditorMutationAllowed(event(b))
  assert.equal(h.shutdownCalls, 0)
  assert.equal(ack(h.barrier, b, 'blocked'), true)
  assert.deepEqual(a.webContents.cancellations().map(value => value.requestId), [first])
  assert.deepEqual(b.webContents.cancellations().map(value => value.requestId), [first])
  await h.barrier.runEditorMutation(event(a), () => undefined)
  assert.equal(ack(h.barrier, a, 'flushed', first), false)
  const second = h.barrier.requestQuit()!
  assert.notEqual(second, first)
  assert.equal(ack(h.barrier, a), true)
  assert.equal(ack(h.barrier, b), true)
  assert.equal(h.shutdownCalls, 1)
  assert.equal(h.barrier.isShuttingDown(), true)
  assert.equal(h.barrier.requestQuit(), null)
  assert.throws(() => h.barrier.assertEditorMutationAllowed(event(a)), /frozen/)
  assert.throws(() => h.barrier.assertEditorMutationAllowed(event(b)), /frozen/)
  assert.equal(h.timers.size, 0)
})

test('flushed ACK cannot overtake an actual Main mutation Promise and never repeats that write', async () => {
  const h = harness(), window = h.window(), pending = deferred()
  let writes = 0
  const write = h.barrier.runEditorMutation(event(window), async () => { writes++; await pending.promise })
  h.barrier.requestQuit()
  assert.equal(ack(h.barrier, window), false)
  assert.equal(h.shutdownCalls, 0)
  assert.equal(window.webContents.cancellations().length, 1)
  assert.equal(writes, 1)
  pending.resolve(); await write
  assert.equal(writes, 1)
  h.barrier.requestQuit()
  assert.equal(ack(h.barrier, window), true)
  assert.equal(h.shutdownCalls, 1)
})

test('timeout only cancels, preserves the window and services, and rejects every late ACK', async () => {
  const h = harness(), window = h.window()
  const first = h.barrier.requestQuit()!
  assert.deepEqual(h.budgets, [8000])
  h.expire()
  assert.equal(window.isDestroyed(), false)
  assert.equal(h.shutdownCalls, 0)
  assert.equal(h.barrier.isShuttingDown(), false)
  assert.equal(h.timers.size, 0)
  assert.equal(window.webContents.cancellations()[0].requestId, first)
  assert.equal(ack(h.barrier, window, 'flushed', first), false)
  await h.barrier.runEditorMutation(event(window), () => undefined)
  const second = h.barrier.requestQuit()!
  assert.notEqual(second, first)
  assert.equal(h.barrier.acknowledge(event(window), { requestId: first, status: 'blocked' }), false)
  assert.equal(ack(h.barrier, window), true)
  assert.equal(h.shutdownCalls, 1)
})

test('nonce rejects foreign contents, subframes, replay, and descriptor accessors without invoking getters', () => {
  const h = harness(), window = h.window(), foreign = new FakeWindow()
  const requestId = h.barrier.requestQuit()!
  assert.equal(h.barrier.acknowledge(event(foreign), { requestId, status: 'flushed' }), false)
  assert.equal(h.barrier.acknowledge({ sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } }, { requestId, status: 'flushed' }), false)
  let getters = 0
  const hostile = Object.defineProperty({ status: 'flushed' }, 'requestId', { enumerable: true, get() { getters++; return requestId } })
  assert.equal(h.barrier.acknowledge(event(window), hostile), false)
  assert.equal(getters, 0)
  assert.equal(h.barrier.acknowledge(event(window), { requestId, status: 'flushed', unexpected: true }), false)
  assert.equal(ack(h.barrier, window), true)
  assert.equal(ack(h.barrier, window), false)
  assert.equal(h.shutdownCalls, 1)
})

test('main-frame reload or process exit cancels the complete attempt and an old frame can never ACK the new one', () => {
  const h = harness(), a = h.window(), b = h.window()
  const first = h.barrier.requestQuit()!, oldEvent = event(b)
  assert.equal(ack(h.barrier, a), true)
  b.webContents.reload()
  assert.equal(h.shutdownCalls, 0)
  assert.equal(a.webContents.cancellations().length, 1)
  h.barrier.assertEditorMutationAllowed(event(a))
  h.barrier.requestQuit()
  const second = b.webContents.requests().at(-1)!.requestId
  assert.notEqual(second, first)
  assert.equal(h.barrier.acknowledge(oldEvent, { requestId: second, status: 'flushed' }), false)
  assert.equal(ack(h.barrier, b, 'flushed', first), false)
  b.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(a.webContents.cancellations().length, 2)
  assert.equal(h.shutdownCalls, 0)
  assert.equal(ack(h.barrier, a, 'flushed', second), false)
})

test('same frame object with changed process/routing/OS identity cannot reuse a nonce', () => {
  for (const mutate of [
    (contents: FakeContents) => { contents.mainFrame.processId++ },
    (contents: FakeContents) => { contents.mainFrame.routingId++ },
    (contents: FakeContents) => { contents.osProcessId++ }
  ]) {
    const h = harness(), window = h.window()
    h.barrier.requestQuit(); mutate(window.webContents)
    assert.equal(ack(h.barrier, window), false)
    h.expire()
    assert.equal(h.shutdownCalls, 0)
    assert.equal(window.webContents.cancellations().length, 1)
  }
})

test('quit replaces X with a fresh nonce and new real windows join without extending the deadline', () => {
  const h = harness(), a = h.window(), b = h.window()
  a.close()
  const windowRequest = a.webContents.requests()[0]
  const quitRequest = h.barrier.requestQuit()!
  assert.notEqual(quitRequest, windowRequest.requestId)
  assert.equal(a.webContents.cancellations()[0].requestId, windowRequest.requestId)
  assert.equal(ack(h.barrier, a, 'flushed', windowRequest.requestId), false)
  assert.equal(ack(h.barrier, a), true)
  const c = h.window()
  assert.deepEqual(c.webContents.requests(), [{ requestId: quitRequest, reason: 'quit' }])
  assert.equal(h.budgets.length, 2, 'the new window shares the current quit timer')
  assert.equal(h.shutdownCalls, 0)
  assert.equal(ack(h.barrier, b), true)
  assert.equal(h.shutdownCalls, 0)
  assert.equal(ack(h.barrier, c), true)
  assert.equal(h.shutdownCalls, 1)
})

test('synchronous renderer reply cannot complete a partially assembled multi-window request', () => {
  const h = harness(), a = h.window(), b = h.window()
  const observedShutdown: number[] = []
  for (const window of [a, b]) window.webContents.onSend = (channel, value) => {
    if (channel !== EDITOR_CLOSE_REQUEST_CHANNEL) return
    const request = value as EditorCloseRequest
    assert.equal(h.barrier.acknowledge(event(window), { requestId: request.requestId, status: 'flushed' }), true)
    observedShutdown.push(h.shutdownCalls)
  }
  h.barrier.requestQuit()
  assert.deepEqual(observedShutdown, [0, 0])
  assert.equal(h.shutdownCalls, 1)
  assert.equal(a.webContents.requests().length, 1)
  assert.equal(b.webContents.requests().length, 1)
})

test('navigation during a vetoed approved window close cancels instead of leaving a stale close permit', () => {
  const h = harness(), window = h.window()
  let approvedClose = false
  window.on('close', (closeEvent: { preventDefault(): void }) => {
    if (!approvedClose) return
    closeEvent.preventDefault()
    window.webContents.reload()
  })
  window.close()
  approvedClose = true
  assert.equal(ack(h.barrier, window), true)
  assert.equal(window.isDestroyed(), false)
  assert.equal(window.webContents.cancellations().length, 1)
  assert.equal(h.shutdownCalls, 0)
  approvedClose = false
  window.close()
  assert.equal(window.webContents.requests().length, 2)
  assert.equal(ack(h.barrier, window), true)
  assert.equal(window.isDestroyed(), true)
})

test('last-window loss cancels an active attempt; a zero-window quit still waits in-flight Main writes', async () => {
  const h = harness(), window = h.window(), pending = deferred()
  const write = h.barrier.runEditorMutation(event(window), () => pending.promise)
  h.barrier.requestQuit()
  window.forceClose()
  assert.equal(h.shutdownCalls, 0)
  const requestId = h.barrier.requestQuit()
  assert.equal(typeof requestId, 'string')
  assert.equal(h.shutdownCalls, 0)
  h.expire()
  pending.resolve(); await write
  assert.equal(h.shutdownCalls, 0, 'settling a write must not revive an expired quit')
  h.barrier.requestQuit()
  assert.equal(h.shutdownCalls, 1)
})

test('irreversible shutdown starts once and a plugin/service rejection never falsely cancels it', async () => {
  const failure = new Error('existing best-effort teardown failed'), reported: unknown[] = []
  const h = harness({ beginShutdown: async () => { throw failure }, onShutdownError: error => { reported.push(error) } })
  const window = h.window()
  h.barrier.requestQuit()
  assert.equal(ack(h.barrier, window), true)
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(reported, [failure])
  assert.equal(h.shutdownCalls, 1)
  assert.equal(h.barrier.isShuttingDown(), true)
  assert.equal(h.barrier.requestQuit(), null)
  assert.throws(() => h.window(), /after service shutdown/)
  window.webContents.reload()
  h.expire()
  assert.equal(window.webContents.cancellations().length, 0)
  assert.equal(h.shutdownCalls, 1)
  assert.throws(() => h.barrier.assertEditorMutationAllowed(event(window)), /frozen/)
})

test('a real preload-ready frame replays its original waiting nonce without acknowledging and cannot revive a reload-cancelled attempt', () => {
  const h = harness(), window = h.window()
  window.close()
  const original = window.webContents.requests()[0]
  assert.equal(h.barrier.replayPending({ sender: window.webContents, senderFrame: { ...window.webContents.mainFrame } }), false)
  assert.equal(h.barrier.replayPending(event(window)), true)
  assert.deepEqual(window.webContents.requests(), [original, original])
  assert.equal(window.isDestroyed(), false); assert.equal(h.shutdownCalls, 0)
  const unrelated = h.window()
  assert.equal(h.barrier.replayPending(event(unrelated)), false)
  window.webContents.reload()
  assert.equal(h.barrier.replayPending(event(window)), false)
  assert.equal(window.webContents.cancellations()[0].requestId, original.requestId)
  assert.equal(window.isDestroyed(), false); assert.equal(h.shutdownCalls, 0)
  h.barrier.requestQuit()
  const fresh = window.webContents.requests().at(-1)!
  assert.notEqual(fresh.requestId, original.requestId)
  assert.equal(h.barrier.replayPending(event(window)), true)
  assert.equal(window.webContents.requests().at(-1)!.requestId, fresh.requestId)
  assert.equal(ack(h.barrier, window), true); assert.equal(h.shutdownCalls, 0)
  assert.equal(ack(h.barrier, unrelated), true); assert.equal(h.shutdownCalls, 1)
})
