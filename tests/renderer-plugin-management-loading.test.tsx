import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentDetail, ElectronApi, HomeData, PluginDocumentAction, PluginV2InstallationSummary, SystemPluginSummary } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { usePluginManagement } from '../src/renderer/src/hooks/usePluginManagement'
import { createPluginManagementActions } from '../src/renderer/src/hooks/pluginManagementActions'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const module = { createPluginManagementActions }
type State = ReturnType<typeof usePluginManagement>
type Loader = () => Promise<typeof module>
type MockApi = { [K in keyof ElectronApi]?: ElectronApi[K] extends (...args: infer Args) => unknown ? (...args: Args) => unknown : never }
const plugin = { pluginId: 'plugin', name: 'Sample' } as PluginV2InstallationSummary
const action = { pluginId: 'plugin', id: 'act', label: 'Action' } as PluginDocumentAction
async function withManagement(load: Loader, api: MockApi, run: (context: {
  state: () => State; dom: JSDOM; messages: unknown[][]; homeChanges: unknown[]; detailChanges: unknown[]; summaries: string[];
  select: (id: string) => Promise<void>; unmount: () => Promise<void>;
  begin: (invoke: (state: State) => Promise<void>) => Promise<{ completion: Promise<void> }>;
  settle: (work: () => void, completion?: Promise<void>) => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<button id="opener">Run</button><input id="other"><div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: { getPluginHomeData: async () => ({ plugins: [] }), ...api } })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const messages: unknown[][] = [], homeChanges: unknown[] = [], detailChanges: unknown[] = [], summaries: string[] = []
  let selected = 'source', state!: State, mounted = true
  function Harness() {
    state = usePluginManagement({ selectedDocumentId: selected, selectedDocument: { id: selected, summary: selected } as DocumentDetail,
      ui: getUiText('en-US'), onHomeDataChange: value => homeChanges.push(typeof value === 'function' ? value({} as HomeData) : value),
      onSelectedDocumentChange: value => detailChanges.push(value), onDraftSummaryChange: value => summaries.push(value),
      onMessage: (...values) => messages.push(values) }, load)
    return null
  }
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  try {
    await act(async () => root.render(createElement(Harness)))
    dom.window.document.getElementById('opener')!.focus()
    await run({ state: () => state, dom, messages, homeChanges, detailChanges, summaries,
      select: async id => { selected = id; await act(async () => root.render(createElement(Harness))) }, unmount,
      begin: async invoke => { let completion!: Promise<void>; await act(async () => { completion = invoke(state); await Promise.resolve() }); return { completion } },
      settle: async (work, completion) => { await act(async () => { work(); if (completion) await completion; else await Promise.resolve() }) } })
  } finally {
    await unmount(); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

test('plugin management is cold at mount, exposes busy immediately, deduplicates cold and running requests, and preserves completion focus', async () => {
  const chunk = deferred<typeof module>(), ipc = deferred<void>()
  let loads = 0, requests = 0
  await withManagement(() => { loads++; return chunk.promise }, { setPluginV2Enabled: async input => {
    requests++; assert.deepEqual(input, { pluginId: 'plugin', enabled: true }); return ipc.promise
  } }, async context => {
    assert.equal(loads, 0)
    const first = await context.begin(state => state.setPluginV2Enabled(plugin, true))
    assert.equal(context.state().pluginBusyId, 'plugin'); assert.equal(loads, 1); assert.equal(requests, 0)
    await context.begin(state => state.setPluginV2Enabled(plugin, true))
    assert.equal(loads, 1)
    await context.settle(() => chunk.resolve(module))
    assert.equal(requests, 1)
    await context.begin(state => state.setPluginV2Enabled(plugin, true)); assert.equal(requests, 1)
    context.dom.window.document.getElementById('other')!.focus()
    await context.settle(() => ipc.resolve(), first.completion)
    assert.equal(context.state().pluginBusyId, null)
    assert.equal(context.dom.window.document.activeElement?.id, 'other')
    assert.equal(context.homeChanges.length, 1); assert.equal(context.messages.length, 1)
  })
})

test('a cold module failure reports the error, clears busy, and permits an explicit retry', async () => {
  const chunk = deferred<typeof module>()
  let loads = 0, requests = 0
  await withManagement(() => ++loads === 1 ? chunk.promise : Promise.resolve(module), {
    setPluginV2Enabled: async () => { requests++ }
  }, async context => {
    const failed = await context.begin(state => state.setPluginV2Enabled(plugin, true))
    await context.settle(() => chunk.reject(new Error('Plugin actions chunk unavailable')), failed.completion)
    assert.deepEqual(context.messages, [['Plugin actions chunk unavailable', 'error']])
    assert.equal(context.state().pluginBusyId, null); assert.equal(requests, 0)
    assert.equal(context.dom.window.document.activeElement?.id, 'opener')
    const retry = await context.begin(state => state.setPluginV2Enabled(plugin, true))
    await context.settle(() => {}, retry.completion)
    assert.equal(loads, 2); assert.equal(requests, 1); assert.equal(context.state().pluginBusyId, null)
  })
})

for (const interrupt of ['focus-return', 'blur-return'] as const) test(`cold plugin confirmations permanently cancel after ${interrupt} without stealing focus`, async () => {
  const chunk = deferred<typeof module>()
  let requests = 0
  await withManagement(() => chunk.promise, { removePluginV2: async () => { requests++ } }, async context => {
    const pending = await context.begin(state => state.removePluginV2(plugin))
    await context.settle(() => {
      if (interrupt === 'focus-return') context.dom.window.document.getElementById('other')!.focus()
      else context.dom.window.dispatchEvent(new context.dom.window.Event('blur'))
      context.dom.window.document.getElementById('opener')!.focus()
      chunk.resolve(module)
    }, pending.completion)
    assert.equal(requests, 0); assert.equal(context.dom.window.document.querySelector('dialog'), null)
    assert.equal(context.state().pluginBusyId, null)
    assert.equal(context.dom.window.document.activeElement?.id, 'opener')
  })
})

test('a cold document action is permanently cancelled after navigating away and back before loading', async () => {
  const chunk = deferred<typeof module>()
  let requests = 0
  await withManagement(() => chunk.promise, { runPluginDocumentAction: async () => { requests++; return { message: 'Done', refreshDocument: false } } }, async context => {
    const pending = await context.begin(state => state.runPluginDocumentAction(action))
    assert.equal(context.state().pluginActionBusyKey, 'plugin:act')
    await context.select('destination'); await context.select('source')
    await context.settle(() => chunk.resolve(module), pending.completion)
    assert.equal(requests, 0); assert.equal(context.state().pluginActionBusyKey, null)
    assert.deepEqual(context.messages, [])
  })
})

test('running plugin actions keep their captured document but do not publish stale detail or summary after navigation', async () => {
  const result = deferred<{ message: string; refreshDocument: boolean }>()
  const requests: unknown[] = []
  await withManagement(async () => module, {
    runPluginDocumentAction: async input => { requests.push(input); return result.promise },
    getHomeData: async () => ({ refreshed: true }) as unknown as HomeData,
    getDocumentDetail: async id => ({ id, summary: 'Stale source summary' }) as DocumentDetail
  }, async context => {
    const pending = await context.begin(state => state.runPluginDocumentAction(action))
    assert.deepEqual(requests, [{ pluginId: 'plugin', actionId: 'act', documentId: 'source' }])
    await context.select('destination'); context.dom.window.document.getElementById('other')!.focus()
    await context.settle(() => result.resolve({ message: 'Done', refreshDocument: true }), pending.completion)
    assert.equal(context.homeChanges.length, 1)
    assert.deepEqual(context.detailChanges, []); assert.deepEqual(context.summaries, [])
    assert.equal(context.dom.window.document.activeElement?.id, 'other')
    assert.equal(context.state().pluginActionBusyKey, null)
  })
})

test('unmount before loading cannot start a plugin operation or publish any completion', async () => {
  const chunk = deferred<typeof module>()
  let requests = 0
  await withManagement(() => chunk.promise, { setPluginV2Enabled: async () => { requests++ } }, async context => {
    const pending = await context.begin(state => state.setPluginV2Enabled(plugin, true))
    await context.unmount()
    await context.settle(() => chunk.resolve(module), pending.completion)
    assert.equal(requests, 0); assert.deepEqual(context.messages, []); assert.deepEqual(context.homeChanges, [])
  })
})

test('the deferred OS-startup action preserves the exact recorded revision and separate acknowledgement', async () => {
  const requests: unknown[] = []
  const system = { pluginId: 'system', name: 'System', osPersistence: { id: 'record', revisionHash: 'sha256:exact-revision' } } as SystemPluginSummary
  await withManagement(async () => module, { resolveSystemPluginOsPersistence: async input => { requests.push(input) } }, async context => {
    const pending = await context.begin(state => state.resolveSystemPluginOsPersistence(system, 'confirm', true))
    await context.settle(() => {}, pending.completion)
    assert.deepEqual(requests, [{ recordId: 'record', pluginId: 'system', revisionHash: 'sha256:exact-revision', decision: 'confirm', acknowledgeSystemStartup: true }])
    assert.equal(context.state().pluginBusyId, null)
  })
})
