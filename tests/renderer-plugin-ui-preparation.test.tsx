import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { performance } from 'node:perf_hooks'
import { act, createElement, StrictMode } from 'react'
import { JSDOM } from 'jsdom'
import { PluginUiPreparationHost } from '../src/renderer/src/components/PluginUiPreparationHost.tsx'
import PluginUiPreparationBatch from '../src/renderer/src/components/PluginUiPreparationBatch.tsx'
import type { PluginUiPreparationRequest, PluginUiPreparationResult } from '../src/shared/plugin-ui.ts'

const moduleValue = { default: PluginUiPreparationBatch }
const realSetTimeout = globalThis.setTimeout
type BatchModule = typeof moduleValue
type Loader = () => Promise<BatchModule>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolve_, reject_) => { resolve = resolve_; reject = reject_ })
  return { promise, resolve, reject }
}

function request(id: string, count = 1): PluginUiPreparationRequest {
  return {
    requestId: id,
    identity: { pluginId: `plugin-${id}`, revisionId: 'revision', runId: 'run', grantSetId: 'grant',
      scope: { kind: 'workspace', workspaceId: 'workspace' } },
    frames: Array.from({ length: count }, (_, index) => ({ contributionId: `frame-${index}`,
      slot: 'workspace.dashboard', title: `${id}-${index}`, height: 100,
      src: `knowbook-plugin-ui://prepared/${id}/${index}` }))
  }
}
function message(source: PluginUiPreparationRequest, index = 0) {
  const frame = source.frames[index]
  return { type: 'knowbook:ready', owner: source.identity, contributionId: frame.contributionId, slot: frame.slot }
}

class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null
  started = false
  closed = 0
  start() { this.started = true }
  close() { this.closed += 1 }
  emit(data: unknown) { this.onmessage?.({ data }) }
}
type Channel = { port1: Port; port2: Port }
type Harness = {
  document: Document
  reports: PluginUiPreparationResult[]
  channels: Channel[]
  subscriptions: { added: number; removed: number }
  send: (source: PluginUiPreparationRequest) => Promise<void>
  tick: (ms: number) => Promise<void>
  connect: (title: string, options?: { failInitialization?: boolean }) => Promise<{ channel: Channel; posted: unknown[][]; iframe: HTMLIFrameElement }>
  unmount: () => Promise<void>
}

async function withHost(context: TestContext, loader: Loader | undefined, run: (harness: Harness) => Promise<void>,
  options: { queued?: PluginUiPreparationRequest; rejectReport?: boolean } = {}) {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true })
  const listeners = new Set<(source: PluginUiPreparationRequest) => void>()
  const reports: PluginUiPreparationResult[] = []
  const channels: Channel[] = []
  const subscriptions = { added: 0, removed: 0 }
  class ControlledMessageChannel {
    port1 = new Port()
    port2 = new Port()
    constructor() { channels.push(this) }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    onPluginUiPreparation: (listener: (source: PluginUiPreparationRequest) => void) => {
      subscriptions.added += 1
      listeners.add(listener)
      // Deliberately replay the same queued IPC on StrictMode's second subscription.
      if (options.queued) listener(options.queued)
      return () => { subscriptions.removed += 1; listeners.delete(listener) }
    },
    reportPluginUiPreparation: (result: PluginUiPreparationResult) => {
      reports.push(result)
      return options.rejectReport ? Promise.reject(new Error('Request is stale')) : Promise.resolve()
    }
  } })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    MessageChannel: ControlledMessageChannel, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true
  const unmount = async () => {
    if (!mounted) return
    mounted = false
    await act(async () => root.unmount())
  }
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 })
  try {
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(PluginUiPreparationHost, { loadBatch: loader }))))
    await run({ document: dom.window.document, reports, channels, subscriptions, unmount,
      send: async source => { await act(async () => { for (const listener of listeners) listener(source) }) },
      tick: async ms => { await act(async () => context.mock.timers.tick(ms)) },
      connect: async (title, options) => {
        const findFrame = () => Array.from(dom.window.document.querySelectorAll('iframe'))
          .find(frame => frame.title === `Preparing ${title}`)
        // Real dynamic imports need I/O turns; act alone only flushes React work.
        // Keep this wall-clock wait separate from the mocked request deadline.
        const waitDeadline = performance.now() + 5_000
        while (!findFrame() && performance.now() < waitDeadline) {
          await act(async () => { await new Promise<void>(resolve => realSetTimeout(resolve, 10)) })
        }
        const iframe = findFrame()
        assert.ok(iframe, `iframe ${title} is mounted`)
        const posted: unknown[][] = []
        Object.defineProperty(iframe.contentWindow, 'postMessage', { configurable: true,
          value: (...args: unknown[]) => {
            posted.push(args)
            if (options?.failInitialization) throw new Error('Controlled initialization failure')
          } })
        await act(async () => iframe.dispatchEvent(new dom.window.Event('load')))
        const channel = channels.at(-1)!
        assert.equal(channel.port1.started, true)
        return { channel, posted, iframe }
      }
    })
  } finally {
    await unmount()
    context.mock.timers.reset()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('preparation host subscribes eagerly and reports replayed empty requests once without loading iframe code', async context => {
  let loads = 0
  const empty = request('empty', 0)
  await withHost(context, async () => { loads += 1; return moduleValue }, async h => {
    assert.equal(h.subscriptions.added, 2)
    assert.equal(h.subscriptions.removed, 1)
    assert.deepEqual(h.reports, [{ requestId: empty.requestId, identity: empty.identity, status: 'ready' }])
    await h.send(empty)
    await h.send(request('second-empty', 0))
    await h.tick(20_000)
    assert.equal(h.reports.length, 2)
    assert.equal(loads, 0)
    assert.equal(h.document.querySelectorAll('iframe').length, 0)
  }, { queued: empty })
})

test('production module loader mounts its sandboxed batch after the first real request', async context => {
  await withHost(context, undefined, async h => {
    const source = request('production-loader')
    assert.equal(h.document.querySelectorAll('iframe').length, 0)
    await h.send(source)
    const connection = await h.connect('production-loader-0')
    await act(async () => connection.channel.port1.emit(message(source)))
    assert.deepEqual(h.reports, [{ requestId: source.requestId, identity: source.identity, status: 'ready' }])
  })
})

test('first nonempty preparation loads once for concurrent requests and requires every addressed frame handshake', async context => {
  const gate = deferred<BatchModule>()
  let loads = 0
  const first = request('first', 2)
  const second = request('second')
  await withHost(context, () => { loads += 1; return gate.promise }, async h => {
    assert.equal(loads, 0)
    await h.send(first)
    await h.send(first)
    await h.send(second)
    assert.equal(loads, 1)
    assert.equal(h.document.querySelectorAll('iframe').length, 0)
    await act(async () => gate.resolve(moduleValue))
    assert.equal(h.document.querySelectorAll('iframe').length, 3)
    const firstConnection = await h.connect('first-0')
    const lastConnection = await h.connect('first-1')
    const secondConnection = await h.connect('second-0')
    assert.equal(firstConnection.iframe.getAttribute('sandbox'), 'allow-scripts')
    assert.equal(firstConnection.iframe.getAttribute('referrerpolicy'), 'no-referrer')
    assert.equal(firstConnection.iframe.hasAttribute('srcdoc'), false)
    assert.deepEqual(firstConnection.posted, [[{ type: 'knowbook:init', owner: first.identity,
      contributionId: first.frames[0].contributionId, slot: first.frames[0].slot }, '*', [firstConnection.channel.port2]]])
    await act(async () => {
      firstConnection.channel.port1.emit(message(second))
      firstConnection.channel.port1.emit({ ...message(first), slot: 'settings.sections' })
      firstConnection.channel.port1.emit({ ...message(first), extra: true })
      firstConnection.channel.port1.emit({ ...message(first), owner: { ...first.identity, runId: 'foreign' } })
    })
    assert.equal(h.reports.length, 0, 'foreign and malformed messages cannot satisfy readiness')
    await act(async () => {
      firstConnection.channel.port1.emit(message(first))
      firstConnection.channel.port1.emit(message(first))
      secondConnection.channel.port1.emit(message(second))
    })
    assert.deepEqual(h.reports.map(result => [result.requestId, result.status]), [['second', 'ready']])
    assert.equal(h.document.querySelectorAll('iframe').length, 2)
    assert.equal(secondConnection.channel.port1.closed, 1)
    await act(async () => lastConnection.channel.port1.emit(message(first, 1)))
    assert.deepEqual(h.reports.map(result => [result.requestId, result.status]), [['second', 'ready'], ['first', 'ready']])
    await h.tick(8_000)
    await h.send(first)
    assert.equal(h.reports.length, 2)
    assert.equal(loads, 1)
    assert.equal(h.document.querySelectorAll('iframe').length, 0)
    assert.equal(firstConnection.channel.port1.closed, 1)
    assert.equal(lastConnection.channel.port1.closed, 1)
  })
})

test('the original 8 second deadline includes loading and stays independent for concurrent requests', async context => {
  const gate = deferred<BatchModule>()
  const first = request('deadline-first')
  const second = request('deadline-second')
  await withHost(context, () => gate.promise, async h => {
    await h.send(first)
    await h.tick(6_000)
    await h.send(second)
    await h.tick(1_000)
    await act(async () => gate.resolve(moduleValue))
    const firstConnection = await h.connect('deadline-first-0')
    const secondConnection = await h.connect('deadline-second-0')
    await h.tick(999)
    assert.equal(h.reports.length, 0)
    await h.tick(1)
    assert.deepEqual(h.reports.map(result => [result.requestId, result.status]), [['deadline-first', 'failed']])
    assert.match(h.reports[0].error!, /ready handshake timed out/)
    assert.equal(firstConnection.channel.port1.closed, 1)
    assert.equal(secondConnection.channel.port1.closed, 0)
    await act(async () => secondConnection.channel.port1.emit(message(second)))
    await h.tick(6_000)
    assert.deepEqual(h.reports.map(result => [result.requestId, result.status]),
      [['deadline-first', 'failed'], ['deadline-second', 'ready']])
  })
})

test('loading past the deadline fails once and a late module never resurrects expired frames', async context => {
  const gate = deferred<BatchModule>()
  const expired = request('expired')
  await withHost(context, () => gate.promise, async h => {
    await h.send(expired)
    await h.tick(8_000)
    assert.equal(h.reports.length, 1)
    assert.equal(h.reports[0].status, 'failed')
    await act(async () => gate.resolve(moduleValue))
    await h.tick(8_000)
    await h.send(expired)
    assert.equal(h.reports.length, 1)
    assert.equal(h.document.querySelectorAll('iframe').length, 0)
    const next = request('after-expiration')
    await h.send(next)
    const connection = await h.connect('after-expiration-0')
    await act(async () => connection.channel.port1.emit(message(next)))
    assert.deepEqual(h.reports.map(result => [result.requestId, result.status]), [['expired', 'failed'], ['after-expiration', 'ready']])
  })
})

test('a rejected module fails every waiting request and a subsequent request can retry loading', async context => {
  const gate = deferred<BatchModule>()
  let loads = 0
  await withHost(context, () => { loads += 1; return loads === 1 ? gate.promise : Promise.resolve(moduleValue) }, async h => {
    const first = request('load-failure-one')
    const second = request('load-failure-two')
    await h.send(first)
    await h.send(second)
    await act(async () => gate.reject(new Error('Controlled chunk load failure')))
    assert.deepEqual(h.reports.map(result => [result.requestId, result.status]),
      [['load-failure-one', 'failed'], ['load-failure-two', 'failed']])
    assert.ok(h.reports.every(result => /component failed to load/.test(result.error!)))
    await h.tick(8_000)
    await h.send(first)
    assert.equal(h.reports.length, 2)
    const retry = request('load-retry')
    await h.send(retry)
    assert.equal(loads, 2)
    const connection = await h.connect('load-retry-0')
    await act(async () => connection.channel.port1.emit(message(retry)))
    assert.equal(h.reports.at(-1)!.status, 'ready')
  })
})

test('a module rejection after expiration still lets the next request retry immediately', async context => {
  const gate = deferred<BatchModule>()
  let loads = 0
  await withHost(context, () => { loads += 1; return loads === 1 ? gate.promise : Promise.resolve(moduleValue) }, async h => {
    await h.send(request('expired-before-rejection'))
    await h.tick(8_000)
    assert.equal(h.reports.length, 1)
    await act(async () => gate.reject(new Error('Late controlled chunk failure')))
    const retry = request('retry-after-late-rejection')
    await h.send(retry)
    assert.equal(loads, 2)
    const connection = await h.connect('retry-after-late-rejection-0')
    await act(async () => connection.channel.port1.emit(message(retry)))
    assert.deepEqual(h.reports.map(result => [result.requestId, result.status]),
      [['expired-before-rejection', 'failed'], ['retry-after-late-rejection', 'ready']])
  })
})

test('frame failures close their port and cannot produce a second result through readiness or timeout', async context => {
  await withHost(context, async () => moduleValue, async h => {
    const failed = request('frame-error', 2)
    await h.send(failed)
    const first = await h.connect('frame-error-0')
    const second = await h.connect('frame-error-1')
    await act(async () => first.channel.port1.emit({ ...message(failed), type: 'knowbook:error', error: 'Controlled frame error' }))
    assert.deepEqual(h.reports, [{ requestId: failed.requestId, identity: failed.identity,
      status: 'failed', error: 'Controlled frame error' }])
    assert.equal(first.channel.port1.closed, 1)
    assert.equal(second.channel.port1.closed, 1)
    assert.equal(first.channel.port1.onmessage, null)
    assert.equal(second.channel.port1.onmessage, null)
    await act(async () => second.channel.port1.emit(message(failed, 1)))
    await h.tick(8_000)
    assert.equal(h.reports.length, 1)
    const initializationError = request('frame-initialization-error')
    await h.send(initializationError)
    const connection = await h.connect('frame-initialization-error-0', { failInitialization: true })
    assert.equal(h.reports.length, 2)
    assert.deepEqual(h.reports[1], { requestId: initializationError.requestId,
      identity: initializationError.identity, status: 'failed', error: 'Plugin iframe initialization failed.' })
    assert.equal(connection.channel.port1.closed, 1)
    assert.equal(connection.channel.port2.closed, 1)
    assert.equal(connection.channel.port1.onmessage, null)
    await act(async () => connection.channel.port1.emit(message(initializationError)))
    await h.tick(8_000)
    assert.equal(h.reports.length, 2)
  })
})

test('frame reconnection and host unmount close ports and clear all deadlines without late reports', async context => {
  await withHost(context, async () => moduleValue, async h => {
    await h.send(request('reconnect'))
    const first = await h.connect('reconnect-0')
    const second = await h.connect('reconnect-0')
    assert.equal(first.channel.port1.closed, 1)
    assert.equal(first.channel.port1.onmessage, null)
    assert.equal(second.channel.port1.closed, 0)
    await h.unmount()
    assert.equal(second.channel.port1.closed, 1)
    assert.equal(second.channel.port1.onmessage, null)
    assert.equal(h.subscriptions.removed, h.subscriptions.added)
    await h.tick(16_000)
    assert.equal(h.reports.length, 0)
  })
})

test('unmount during loading suppresses late module resolution and stale report rejections do not retain frames', async context => {
  const gate = deferred<BatchModule>()
  await withHost(context, () => gate.promise, async h => {
    await h.send(request('unmounted-loading'))
    await h.unmount()
    await act(async () => gate.resolve(moduleValue))
    await h.tick(16_000)
    assert.equal(h.reports.length, 0)
    assert.equal(h.document.querySelectorAll('iframe').length, 0)
  })
  await withHost(context, async () => moduleValue, async h => {
    const stale = request('stale-report')
    await h.send(stale)
    const connection = await h.connect('stale-report-0')
    await act(async () => connection.channel.port1.emit(message(stale)))
    await h.tick(8_000)
    assert.equal(h.reports.length, 1)
    assert.equal(h.document.querySelectorAll('iframe').length, 0)
    assert.equal(connection.channel.port1.closed, 1)
  }, { rejectReport: true })
})
