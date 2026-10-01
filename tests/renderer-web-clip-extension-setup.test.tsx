import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import type { ElectronApi, WebClipExtensionExportResult } from '../src/shared/contracts'
import { useWebClipExtensionSetup } from '../src/renderer/src/hooks/useWebClipExtensionSetup'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { WebClipExtensionSetup } = await import('../src/renderer/src/components/WebClipExtensionSetup')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const result = (directory = 'C:\\Exports\\KnowBook extension', version = '1.2.3'): WebClipExtensionExportResult => ({ directory, version })
type State = ReturnType<typeof useWebClipExtensionSetup>
type View = Pick<State, 'exportedExtension' | 'pending' | 'error' | 'completed'>
type Props = { isZh: boolean; active: boolean }
type Context = {
  document: Document
  window: Window & typeof globalThis
  state: () => State
  view: () => View
  exports: Array<ReturnType<typeof deferred<WebClipExtensionExportResult | null>>>
  opens: Array<ReturnType<typeof deferred<void>>>
  openArguments: unknown[][]
  render: (changes?: Partial<Props>) => Promise<void>
  unmount: () => Promise<void>
  start: (action: () => Promise<void>) => Promise<{ completion: Promise<void> }>
  settle: (action: () => void, completion?: Promise<unknown>) => Promise<void>
  activate: (button: HTMLButtonElement) => Promise<void>
  setForeground: (foreground: boolean) => void
}

async function withSetup(run: (context: Context) => Promise<void>, options: Partial<Props> & { strict?: boolean; component?: boolean } = {}) {
  const dom = new JSDOM('<div id="mount"></div><button id="other">Other action</button>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const exports: Context['exports'] = [], opens: Context['opens'] = [], openArguments: unknown[][] = []
  const api: Pick<ElectronApi, 'exportWebClipExtension' | 'openWebClipExtensionDirectory'> = {
    exportWebClipExtension: () => { const request = deferred<WebClipExtensionExportResult | null>(); exports.push(request); return request.promise },
    openWebClipExtensionDirectory: (...args: unknown[]) => { openArguments.push(args); const request = deferred<void>(); opens.push(request); return request.promise }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  let foreground = true
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => foreground })
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return !this.isConnected || this.closest('[hidden], [inert], [aria-hidden="true"]')
      ? [] as unknown as DOMRectList : [new dom.window.DOMRect(0, 0, 240, 36)] as unknown as DOMRectList
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const mount = dom.window.document.getElementById('mount')!
  let root: ReturnType<typeof createRoot>, mounted = false
  let props: Props = { isZh: options.isZh ?? false, active: options.active ?? true }
  let state!: State
  function Harness(next: Props) {
    state = useWebClipExtensionSetup(next)
    const view: View = { exportedExtension: state.exportedExtension, pending: state.pending, error: state.error, completed: state.completed }
    return createElement('output', null, JSON.stringify(view))
  }
  const render: Context['render'] = async changes => {
    props = { ...props, ...changes }
    if (!mounted) { root = createRoot(mount); mounted = true }
    const element = options.component ? createElement(WebClipExtensionSetup, props) : createElement(Harness, props)
    await act(async () => root.render(options.strict ? createElement(StrictMode, null, element) : element))
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window as unknown as Window & typeof globalThis,
      state: () => state, view: () => JSON.parse(mount.querySelector('output')!.textContent!) as View,
      exports, opens, openArguments, render, unmount,
      start: async action => { let completion!: Promise<void>; await act(async () => { completion = action() }); return { completion } },
      settle: async (action, completion) => { await act(async () => { action(); await completion }) },
      activate: async button => {
        await act(async () => { button.focus(); button.click() })
        await act(async () => {
          // JSDOM omits Chrome's disable blur. Reproduce it without altering the final disabled state.
          if (button.disabled && dom.window.document.activeElement === button) { button.disabled = false; button.blur(); button.disabled = true }
        })
      },
      setForeground: next => { foreground = next }
    })
  } finally {
    await unmount()
    await act(async () => { exports.forEach(request => request.resolve(null)); opens.forEach(request => request.resolve()) })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function exportButton(document: Document) { return document.querySelector<HTMLButtonElement>('.web-clip-extension-export')! }
function openButton(document: Document) { return document.querySelector<HTMLButtonElement>('.web-clip-extension-open')! }

test('unknown, inactive and unmounted setup actions do not call native APIs', async () => {
  await withSetup(async context => {
    assert.deepEqual(context.view(), { exportedExtension: null, pending: null, error: null, completed: null })
    await context.start(() => context.state().openDirectory())
    await context.start(() => context.state().exportExtension())
    assert.equal(context.exports.length, 0)
    assert.equal(context.opens.length, 0)
    await context.render({ active: true })
    await context.start(() => context.state().openDirectory())
    assert.equal(context.opens.length, 0)
    const old = context.state()
    await context.unmount()
    await old.exportExtension()
    await old.openDirectory()
    assert.equal(context.exports.length, 0)
    assert.equal(context.opens.length, 0)
  }, { active: false })
})

test('export and open share a synchronous lock and their returned promises wait for the actual native operation', async () => {
  for (const strict of [false, true]) {
    await withSetup(async context => {
      const callbacks = context.state()
      let first!: Promise<void>, duplicate!: Promise<void>, blockedOpen!: Promise<void>, finished = false
      await act(async () => {
        first = callbacks.exportExtension()
        void first.then(() => { finished = true })
        duplicate = callbacks.exportExtension()
        blockedOpen = callbacks.openDirectory()
      })
      assert.equal(finished, false)
      assert.equal(context.exports.length, 1)
      assert.equal(context.opens.length, 0)
      assert.equal(context.view().pending, 'export')
      await context.settle(() => context.exports[0].resolve(result()), Promise.all([first, duplicate, blockedOpen]))
      assert.equal(finished, true)
      assert.deepEqual(context.view(), { exportedExtension: result(), pending: null, error: null, completed: 'export' })
      let opening!: Promise<void>, duplicateOpen!: Promise<void>, blockedExport!: Promise<void>
      await act(async () => {
        opening = callbacks.openDirectory()
        duplicateOpen = callbacks.openDirectory()
        blockedExport = callbacks.exportExtension()
      })
      assert.equal(context.opens.length, 1)
      assert.equal(context.exports.length, 1)
      assert.deepEqual(context.openArguments, [[]], 'The renderer opens the service-owned last directory without a path argument')
      assert.equal(context.view().pending, 'open')
      await context.settle(() => context.opens[0].resolve(), Promise.all([opening, duplicateOpen, blockedExport]))
      assert.equal(context.view().completed, 'open')
      assert.equal(context.view().pending, null)
    }, { strict })
  }
})

test('canceling a picker stays silent and preserves the previously exported folder for opening', async () => {
  await withSetup(async context => {
    const initial = await context.start(() => context.state().exportExtension())
    await context.settle(() => context.exports[0].resolve(null), initial.completion)
    assert.deepEqual(context.view(), { exportedExtension: null, pending: null, error: null, completed: null })
    const saved = await context.start(() => context.state().exportExtension())
    await context.settle(() => context.exports[1].resolve(result()), saved.completion)
    const canceled = await context.start(() => context.state().exportExtension())
    assert.equal(context.view().completed, null, 'A new attempt must not announce an earlier success')
    await context.settle(() => context.exports[2].resolve(null), canceled.completion)
    assert.deepEqual(context.view(), { exportedExtension: result(), pending: null, error: null, completed: null })
    const open = await context.start(() => context.state().openDirectory())
    assert.equal(context.opens.length, 1)
    await context.settle(() => context.opens[0].resolve(), open.completion)
  })
})

test('export failures clean IPC wrappers, use the current language fallback, and allow retry without losing an earlier result', async () => {
  await withSetup(async context => {
    const initial = await context.start(() => context.state().exportExtension())
    await context.render({ isZh: false })
    await context.settle(() => context.exports[0].reject(new Error('')), initial.completion)
    assert.deepEqual(context.view().error, { kind: 'export', message: 'Could not export the browser extension. Retry.' })
    const retry = await context.start(() => context.state().exportExtension())
    assert.equal(context.view().error, null)
    const reason = 'Folder is unavailable\nChoose another location.'
    await context.settle(() => context.exports[1].reject(new Error(`Error invoking remote method 'knowbook:export-web-clip-extension': Error: ${reason}`)), retry.completion)
    assert.deepEqual(context.view().error, { kind: 'export', message: reason })
    const saved = await context.start(() => context.state().exportExtension())
    await context.settle(() => context.exports[2].resolve(result()), saved.completion)
    assert.equal(context.view().error, null)
    const later = await context.start(() => context.state().exportExtension())
    await context.settle(() => context.exports[3].reject(new Error('Permission denied')), later.completion)
    assert.deepEqual(context.view().exportedExtension, result())
    assert.equal(context.view().completed, null)
    assert.equal(context.view().pending, null)
  }, { isZh: true })
})

test('opening can fail and retry independently with current-language feedback and the successful export intact', async () => {
  await withSetup(async context => {
    const saved = await context.start(() => context.state().exportExtension())
    await context.settle(() => context.exports[0].resolve(result()), saved.completion)
    const open = await context.start(() => context.state().openDirectory())
    await context.render({ isZh: true })
    await context.settle(() => context.opens[0].reject(new Error('')), open.completion)
    assert.deepEqual(context.view(), { exportedExtension: result(), pending: null,
      error: { kind: 'open', message: '无法打开导出目录，请重试。' }, completed: null })
    const retry = await context.start(() => context.state().openDirectory())
    assert.equal(context.view().error, null)
    assert.equal(context.exports.length, 1, 'Opening a folder must never export the files again')
    await context.settle(() => context.opens[1].resolve(), retry.completion)
    assert.deepEqual(context.view(), { exportedExtension: result(), pending: null, error: null, completed: 'open' })
  })
})

test('leaving the setup suppresses late feedback while preserving the native operation lock and latest successful directory', async () => {
  await withSetup(async context => {
    const initial = await context.start(() => context.state().exportExtension())
    await context.settle(() => context.exports[0].resolve(result()), initial.completion)
    const lateFailure = await context.start(() => context.state().exportExtension())
    await context.render({ active: false })
    await context.render({ active: true })
    await context.start(() => context.state().exportExtension())
    await context.start(() => context.state().openDirectory())
    assert.equal(context.exports.length, 2)
    assert.equal(context.opens.length, 0)
    await context.settle(() => context.exports[1].reject(new Error('Old view failure')), lateFailure.completion)
    assert.equal(context.view().error, null)
    assert.equal(context.view().completed, null)
    const lateSuccess = await context.start(() => context.state().exportExtension())
    await context.render({ active: false })
    const latest = result('D:\\另一个位置\\扩展', '2.0.0')
    await context.settle(() => context.exports[2].resolve(latest), lateSuccess.completion)
    assert.equal(context.view().pending, null)
    assert.equal(context.view().completed, null, 'A hidden native completion must not publish a success announcement')
    await context.render({ active: true })
    assert.deepEqual(context.view().exportedExtension, latest, 'Returning must show the same latest directory that the main service opens')
    const open = await context.start(() => context.state().openDirectory())
    assert.equal(context.opens.length, 1)
    await context.render({ active: false })
    await context.render({ active: true })
    await context.settle(() => context.opens[0].reject(new Error('Old open failure')), open.completion)
    assert.equal(context.view().error, null)
    assert.equal(context.view().completed, null)
    assert.deepEqual(context.view().exportedExtension, latest)
  })
})

test('unmounting preserves the native operation lock, while old callbacks and late errors cannot act in the returning view', async () => {
  for (const succeeded of [false, true]) {
    await withSetup(async context => {
      const old = context.state()
      const previous = await context.start(() => old.exportExtension())
      await context.unmount()
      await context.render()
      assert.deepEqual(context.view(), { exportedExtension: null, pending: 'export', error: null, completed: null })
      await context.start(() => context.state().exportExtension())
      await context.start(() => context.state().openDirectory())
      await old.exportExtension()
      await old.openDirectory()
      assert.equal(context.exports.length, 1, 'Returning or using an old callback must not start a second native picker')
      assert.equal(context.opens.length, 0)
      await context.settle(() => {
        if (succeeded) context.exports[0].resolve(result('C:\\Previous session', '0.0.1'))
        else context.exports[0].reject(new Error('Unmounted request failed'))
      }, previous.completion)
      assert.deepEqual(context.view(), { exportedExtension: succeeded ? result('C:\\Previous session', '0.0.1') : null,
        pending: null, error: null, completed: null })
      const current = await context.start(() => context.state().exportExtension())
      await context.start(() => context.state().exportExtension())
      assert.equal(context.exports.length, 2)
      assert.equal(context.view().pending, 'export')
      await context.settle(() => context.exports[1].resolve(result()), current.completion)
      assert.deepEqual(context.view(), { exportedExtension: result(), pending: null, error: null, completed: 'export' })
    })
  }
})

test('a completed export survives real settings unmounts and opens directly without exporting again', async () => {
  await withSetup(async context => {
    const saved = await context.start(() => context.state().exportExtension())
    await context.settle(() => context.exports[0].resolve(result()), saved.completion)
    await context.unmount()
    await context.render()
    assert.deepEqual(context.view(), { exportedExtension: result(), pending: null, error: null, completed: null })
    const open = await context.start(() => context.state().openDirectory())
    await context.unmount()
    await context.render()
    assert.deepEqual(context.view(), { exportedExtension: result(), pending: 'open', error: null, completed: null })
    await context.start(() => context.state().openDirectory())
    await context.start(() => context.state().exportExtension())
    assert.equal(context.opens.length, 1)
    assert.equal(context.exports.length, 1)
    assert.deepEqual(context.openArguments, [[]])
    await context.settle(() => context.opens[0].reject(new Error('Closed view open failed')), open.completion)
    assert.deepEqual(context.view(), { exportedExtension: result(), pending: null, error: null, completed: null })
    const retry = await context.start(() => context.state().openDirectory())
    await context.settle(() => context.opens[1].resolve(), retry.completion)
    assert.deepEqual(context.view(), { exportedExtension: result(), pending: null, error: null, completed: 'open' })
    assert.equal(context.exports.length, 1)
  })
})

test('server rendering uses a stable empty snapshot without accessing a browser or native API', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'window')
  const views: View[] = []
  function ServerHarness() {
    const state = useWebClipExtensionSetup({ isZh: false, active: true })
    const view: View = { exportedExtension: state.exportedExtension, pending: state.pending, error: state.error, completed: state.completed }
    views.push(view)
    return createElement('output', null, JSON.stringify(view))
  }
  try {
    assert.equal(renderToString(createElement(ServerHarness)), renderToString(createElement(ServerHarness)))
    assert.equal(views.length, 2)
    views.forEach(view => assert.deepEqual(view, { exportedExtension: null, pending: null, error: null, completed: null }))
    const markup = renderToString(createElement(WebClipExtensionSetup, { isZh: true, active: false }))
    assert.match(markup, /导出浏览器扩展/)
    assert.doesNotMatch(markup, /web-clip-extension-open|web-clip-extension-result|role="(?:alert|status)"/)
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
  }
})

test('localized setup controls associate progress with its action and keep export metadata as plain readable text', async () => {
  for (const isZh of [false, true]) {
    await withSetup(async context => {
      const { document } = context
      const button = exportButton(document)
      assert.equal(button.textContent?.trim(), isZh ? '导出浏览器扩展' : 'Export browser extension')
      assert.equal(document.querySelector('.web-clip-extension-open'), null)
      await context.activate(button)
      assert.equal(button.disabled, true)
      assert.equal(button.getAttribute('aria-busy'), 'true')
      const progress = document.querySelector('[role="status"]')!
      assert.equal(progress.closest('[aria-busy="true"]'), null)
      assert.match(progress.textContent!, isZh ? /选择导出位置/ : /folder picker/)
      await context.settle(() => context.exports[0].resolve(result()))
      assert.equal(document.activeElement, button)
      const open = openButton(document)
      assert.equal(open.textContent?.trim(), isZh ? '打开导出目录' : 'Open export folder')
      assert.deepEqual([...document.querySelectorAll('.web-clip-extension-result dd')].map(item => item.textContent), [result().directory, result().version])
      assert.equal(document.querySelectorAll('input, .meta-grid').length, 0)
      assert.equal(document.querySelector('[role="status"]')!.textContent!.includes(result().directory), false)
      await context.activate(open)
      assert.equal(open.getAttribute('aria-busy'), 'true')
      assert.equal(button.getAttribute('aria-busy'), 'false')
      assert.equal(button.disabled, true)
      await context.settle(() => context.opens[0].reject(new Error('Folder was moved')))
      assert.equal(document.activeElement, open)
      const error = document.querySelector('.web-clip-extension-error')!
      assert.equal(error.getAttribute('role'), 'alert')
      assert.equal(error.getAttribute('data-action-kind'), 'open')
      assert.equal(error.closest('[aria-busy="true"]'), null)
      assert.equal(document.querySelector('[role="status"]'), null, 'A previous export success must not mask the open failure')
      assert.equal(open.disabled, false)
      await context.activate(open)
      assert.equal(document.querySelector('[role="alert"]'), null)
      await context.settle(() => context.opens[1].resolve())
      assert.equal(document.activeElement, open)
      assert.equal(context.exports.length, 1)
    }, { component: true, isZh })
  }
})

test('completion respects a new focus target, hidden settings and a background window', async () => {
  await withSetup(async context => {
    const { document } = context
    const button = exportButton(document), other = document.getElementById('other')!
    await context.activate(button)
    await act(async () => other.focus())
    await context.settle(() => context.exports[0].reject(new Error('Export failed')))
    assert.equal(document.activeElement, other)
    await context.activate(button)
    await context.render({ active: false })
    assert.equal(document.querySelector<HTMLElement>('.web-clip-extension-setup')!.hidden, true)
    await context.settle(() => context.exports[1].resolve(result()))
    assert.equal(document.activeElement, document.body)
    assert.equal(document.querySelector('[role="status"]'), null)
    await context.render({ active: true })
    assert.equal(document.activeElement, document.body, 'Returning to the category must not focus a completed old action')
    assert.equal(openButton(document).disabled, false)
    await context.activate(openButton(document))
    context.setForeground(false)
    await act(async () => context.window.dispatchEvent(new context.window.Event('blur')))
    await context.settle(() => context.opens[0].reject(new Error('Open failed')))
    assert.equal(document.activeElement, document.body)
    context.setForeground(true)
    await context.render({ isZh: true })
    assert.equal(document.activeElement, document.body)
  }, { component: true })
})
