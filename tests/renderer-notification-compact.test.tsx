import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, StrictMode } from 'react'
import { JSDOM } from 'jsdom'
import type { AppNotificationInput } from '../src/shared/app-notification'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { waitForRenderer } from './helpers/renderer-async'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
// Resolve the lazy module before mounting, while retaining the real Host and store.
await import('../src/renderer/src/components/AppNotificationList')
await Promise.all([
  import('../src/renderer/src/notification-history'),
  import('../src/renderer/src/backup-notifications')
])
const { AppNotificationHost } = await import('../src/renderer/src/components/AppNotificationHost')

const mediaQuery = '(max-width:900px), (max-height:700px)'
const clearanceProperty = '--kb-notification-clearance'
type Bounds = { top: number; height: number }
type Observer = { target: Element | null; disconnected: boolean; deliver: () => void }
type Context = {
  document: Document
  style: CSSStyleDeclaration
  observers: Observer[]
  mediaQueries: string[]
  mediaListenerCount: () => number
  resizeListenerCount: () => number
  subscriptions: { plugin: number; backup: number }
  summary: () => HTMLElement
  bell: () => HTMLButtonElement
  outside: HTMLInputElement
  change: (run: () => void) => Promise<void>
  viewport: (width: number, height: number) => Promise<void>
  setBounds: (bounds: Bounds) => void
  language: (isZh: boolean) => Promise<void>
  advance: (milliseconds: number) => Promise<void>
  dispatch: (target: EventTarget, event: Event) => Promise<void>
  event: (type: string) => Event
  mouse: (type: string, relatedTarget?: EventTarget | null) => MouseEvent
  tab: (shiftKey?: boolean) => KeyboardEvent
  unmount: () => Promise<void>
}

function clearStore() {
  const ids = new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))
  for (const id of ids) appNotifications.dismiss(id)
  appNotifications.clearCompleted()
}

async function withHost(run: (context: Context) => Promise<void>, options: {
  width?: number; height?: number; isZh?: boolean; strict?: boolean; priorValue?: string; bounds?: Bounds
} = {}) {
  clearStore()
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Workspace query">', { url: 'http://localhost' })
  const { document } = dom.window
  const originals = new Map<string, PropertyDescriptor | undefined>()
  let width = options.width ?? 760
  let height = options.height ?? 640
  let bounds = options.bounds ?? { top: 520.4, height: 88 }
  const style = document.documentElement.style
  if (options.priorValue) style.setProperty(clearanceProperty, options.priorValue, 'important')
  style.setProperty('--kb-accent', '#123456')
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  const setViewportSize = () => {
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, writable: true, value: width })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, writable: true, value: height })
  }
  setViewportSize()
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches('.app-notifications')
      ? new dom.window.DOMRect(0, bounds.top, 360, bounds.height)
      : new dom.window.DOMRect(0, 0, 160, 32)
  }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.closest('[hidden], [inert]') ? [] : [this.getBoundingClientRect()]
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (focusOptions) {
    // A native closed dialog cannot receive React's mount-time autoFocus. Its
    // showModal call focuses the first control only after the old summary left.
    const dialog = this.closest('dialog')
    if (dialog && !dialog.hasAttribute('open')) return
    nativeFocus.call(this, focusOptions)
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
    this.querySelector<HTMLButtonElement>('.app-notification-close')?.focus()
  }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }

  const mediaQueries: string[] = []
  const mediaListeners = new Set<EventListenerOrEventListenerObject>()
  const matches = () => width <= 900 || height <= 700
  const mql = {
    media: mediaQuery,
    get matches() { return matches() },
    onchange: null,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (type === 'change' && listener) mediaListeners.add(listener)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (type === 'change' && listener) mediaListeners.delete(listener)
    },
    addListener: (listener: EventListener | null) => { if (listener) mediaListeners.add(listener) },
    removeListener: (listener: EventListener | null) => { if (listener) mediaListeners.delete(listener) },
    dispatchEvent: (event: Event) => {
      for (const listener of [...mediaListeners]) {
        if (typeof listener === 'function') listener.call(mql, event)
        else listener.handleEvent(event)
      }
      return !event.defaultPrevented
    }
  } as MediaQueryList
  dom.window.matchMedia = query => { mediaQueries.push(query); return mql }
  const mediaChange = () => {
    const event = new dom.window.Event('change')
    Object.defineProperties(event, { matches: { value: matches() }, media: { value: mediaQuery } })
    mql.dispatchEvent(event)
  }

  const observers: Observer[] = []
  class ControlledResizeObserver implements ResizeObserver, Observer {
    target: Element | null = null
    disconnected = false
    constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
    observe(target: Element) { this.target = target; this.disconnected = false }
    unobserve(target: Element) { if (this.target === target) this.target = null }
    disconnect() { this.disconnected = true }
    deliver() {
      assert.ok(this.target)
      this.callback([{ target: this.target, contentRect: this.target.getBoundingClientRect() } as ResizeObserverEntry], this)
    }
  }
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: ControlledResizeObserver })
  const resizeListeners = new Set<unknown>()
  const addListener = dom.window.addEventListener.bind(dom.window)
  const removeListener = dom.window.removeEventListener.bind(dom.window)
  dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | AddEventListenerOptions) => {
    if (listener) {
      if (type === 'resize') resizeListeners.add(listener)
      addListener(type, listener, listenerOptions)
    }
  }) as typeof dom.window.addEventListener
  dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, listenerOptions?: boolean | EventListenerOptions) => {
    if (listener) {
      if (type === 'resize') resizeListeners.delete(listener)
      removeListener(type, listener, listenerOptions)
    }
  }) as typeof dom.window.removeEventListener
  const subscriptions = { plugin: 0, backup: 0 }
  Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: {
    onPluginNotification: () => { subscriptions.plugin++; return () => { subscriptions.plugin-- } },
    onBackupHealth: () => { subscriptions.backup++; return () => { subscriptions.backup-- } },
    getBackupHealth: async () => ({ revision: 0, error: null })
  } })
  for (const [key, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }

  // Only notification expiry is virtualized. React and module-loading timers remain native.
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let time = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 6_000) return originalSetTimeout(callback, delay, ...args)
    const id = ++nextTimer
    timers.set(id, { at: time + delay, run: () => callback(...args) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    if (typeof timer === 'number' && timers.delete(timer)) return
    originalClearTimeout(timer)
  }) as typeof globalThis.clearTimeout
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  let mounted = true
  let isZh = options.isZh ?? false
  const render = () => {
    const element = createElement(AppNotificationHost, { isZh, onOpenDocument: () => {} })
    root.render(options.strict ? createElement(StrictMode, null, element) : element)
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await act(async () => { render(); await Promise.resolve() })
    await run({ document, style, observers, mediaQueries, subscriptions,
      mediaListenerCount: () => mediaListeners.size, resizeListenerCount: () => resizeListeners.size,
      summary: () => {
        const summary = document.querySelector<HTMLElement>('.app-notification-summary')
        assert.ok(summary, 'A compact viewport must expose one notification summary')
        return summary
      },
      bell: () => document.querySelector<HTMLButtonElement>('.notification-bell')!,
      outside: document.getElementById('outside') as HTMLInputElement,
      change: async callback => { await act(async () => callback()) },
      viewport: async (nextWidth, nextHeight) => { await act(async () => {
        const previous = matches()
        width = nextWidth; height = nextHeight; setViewportSize()
        if (matches() !== previous) mediaChange()
        dom.window.dispatchEvent(new dom.window.Event('resize'))
      }) },
      setBounds: next => { bounds = next },
      language: async next => { await act(async () => { isZh = next; render() }) },
      advance: async milliseconds => { await act(async () => {
        time += milliseconds
        for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) {
          if (timer.at <= time && timers.delete(id)) timer.run()
        }
      }) },
      dispatch: async (target, event) => { await act(async () => { target.dispatchEvent(event) }) },
      event: type => new dom.window.Event(type, { bubbles: true, cancelable: true }),
      mouse: (type, relatedTarget = null) => new dom.window.MouseEvent(type, { bubbles: true, relatedTarget }),
      tab: (shiftKey = false) => new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }),
      unmount })
  } finally {
    await unmount()
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    clearStore()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function show(input: AppNotificationInput) { return appNotifications.show(input) }
function card(document: Document, id: string | null) {
  assert.ok(id)
  const result = document.querySelector<HTMLElement>(`.app-notification[data-notification-id="${id}"]`)
  assert.ok(result)
  return result
}

test('compact summaries follow the latest updated live record and responsive changes preserve all full cards and task actions', async () => {
  await withHost(async context => {
    let runCalls = 0
    let task!: ReturnType<typeof show>
    await context.change(() => {
      task = show({ title: 'Backup', message: 'Writing local copy', level: 'progress', progress: 40,
        actions: [{ label: 'Inspect task', run: () => { runCalls++ } }] })
      show({ title: 'Saved', message: 'First document is ready', level: 'success', persistent: true })
      show({ title: 'Newer information', message: 'A later-created notice', level: 'info', persistent: true })
    })
    // Preloading the module does not settle React.lazy's first import promise.
    await waitForRenderer(() => context.document.querySelectorAll('.app-notification').length === 3,
      'The notification list must finish its first lazy import before inspecting notification cards')
    assert.equal(context.document.querySelectorAll('.app-notification').length, 3)
    assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 0)
    const taskId = String(appNotifications.getSnapshot()[0].id)
    const taskCard = card(context.document, taskId)
    assert.equal(taskCard.querySelector('progress')!.value, 40)
    await context.change(() => taskCard.querySelector<HTMLButtonElement>('.app-notification-actions button')!.click())
    assert.equal(runCalls, 1)

    await context.change(() => taskCard.querySelector<HTMLButtonElement>('.app-notification-close')!.focus())
    await context.viewport(760, 800)
    const originalSummary = context.summary()
    const originalButton = originalSummary.querySelector<HTMLButtonElement>('button')!
    assert.equal(originalSummary.getAttribute('data-testid'), 'notification-summary')
    assert.equal(originalSummary.getAttribute('data-notification-id'), String(appNotifications.getSnapshot().at(-1)!.id))
    assert.equal(originalButton.textContent, 'View all (3)')
    assert.equal(originalButton.getAttribute('aria-label'), 'View 3 notifications')
    assert.equal(context.document.querySelectorAll('.app-notification').length, 3, 'Compact presentation cannot unmount the expiry owners')
    assert.equal(card(context.document, taskId) === taskCard, true)
    assert.equal(context.document.activeElement === originalButton, true, 'A focused full-card control needs a visible continuation after compacting')

    const reason = 'Backup failed: permission denied\nThe original file remains available. '.repeat(8)
    await context.change(() => task.update({ title: 'Backup failed', message: reason, level: 'error' }))
    assert.equal(context.summary() === originalSummary, true)
    assert.equal(context.summary().querySelector('button') === originalButton, true)
    assert.equal(context.document.activeElement === originalButton, true)
    assert.equal(context.summary().getAttribute('data-notification-id'), taskId)
    assert.notEqual(taskId, String(appNotifications.getSnapshot().at(-1)!.id), 'The snapshot retains creation order')
    assert.equal(context.summary().querySelector('.app-notification-title')!.textContent, 'Backup failed')
    assert.equal(context.summary().querySelector('.app-notification-message')!.textContent, reason)
    const alert = context.summary().querySelector('[role="alert"]') ?? (context.summary().getAttribute('role') === 'alert' ? context.summary() : null)
    assert.ok(alert)
    assert.equal(alert.textContent!.includes(reason), true, 'Visual truncation must retain the complete accessible reason')

    await context.viewport(1180, 640)
    assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 1, 'A short wide window also needs a compact overlay')
    await context.viewport(1180, 800)
    assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 0)
    assert.equal(context.document.activeElement === context.bell(), true, 'A disappearing focused summary returns to the stable notification entry')
    assert.equal(card(context.document, taskId) === taskCard, true)
    assert.equal(card(context.document, taskId).querySelector('.app-notification-message')!.textContent, reason)
    assert.ok(context.mediaQueries.every(query => query === mediaQuery))
  }, { width: 1180, height: 800 })
})

test('summary hover and focus pause the mounted normal card expiry without losing history, while errors remain persistent', async () => {
  await withHost(async context => {
    await context.change(() => {
      show({ title: 'Action failed', message: 'Retry is available in the workspace.', level: 'error' })
      show({ title: 'Copied', message: 'Link copied to the clipboard.', level: 'success' })
    })
    const copiedId = Number(context.summary().getAttribute('data-notification-id'))
    const mountedCard = card(context.document, String(copiedId))
    await context.advance(5_000)
    await context.dispatch(context.summary(), context.mouse('mouseover', context.outside))
    await context.advance(7_000)
    assert.equal(context.summary().getAttribute('data-notification-id'), String(copiedId))
    assert.equal(card(context.document, String(copiedId)) === mountedCard, true)
    await context.dispatch(context.summary(), context.mouse('mouseout', context.outside))
    await context.advance(5_999)
    assert.equal(appNotifications.getSnapshot().some(item => item.id === copiedId), true)
    await context.advance(1)
    assert.equal(appNotifications.getSnapshot().some(item => item.id === copiedId), false)
    assert.equal(appNotifications.getHistorySnapshot().some(item => item.id === copiedId), true)

    await context.change(() => { show({ title: 'Saved again', message: 'A new normal notice.', level: 'success' }) })
    const focusedId = Number(context.summary().getAttribute('data-notification-id'))
    await context.change(() => context.summary().querySelector<HTMLButtonElement>('button')!.focus())
    await context.advance(7_000)
    assert.equal(appNotifications.getSnapshot().some(item => item.id === focusedId), true)
    await context.change(() => context.outside.focus())
    await context.advance(6_000)
    assert.equal(appNotifications.getSnapshot().some(item => item.id === focusedId), false)
    assert.equal(appNotifications.getHistorySnapshot().some(item => item.id === focusedId), true)
    await context.advance(7_000)
    assert.equal(context.summary().querySelector('.app-notification-title')!.textContent, 'Action failed')
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.equal(appNotifications.getHistorySnapshot().length, 3)
    assert.equal(context.document.activeElement === context.outside, true)
  })
})

test('opening the center from an unmounted summary returns to the stable bell and leaves outside keyboard focus alone', async () => {
  for (const isZh of [false, true]) {
    await withHost(async context => {
      await context.change(() => { show({ title: 'Action failed', message: 'The complete failure reason.', level: 'error' }) })
      const bell = context.bell()
      const summaryButton = context.summary().querySelector<HTMLButtonElement>('button')!
      await context.change(() => { summaryButton.focus(); summaryButton.click() })
      assert.equal(summaryButton.isConnected, false)
      assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 0)
      const dialog = context.document.querySelector<HTMLDialogElement>('.notification-center[open]')!
      assert.ok(dialog)
      const close = dialog.querySelector<HTMLButtonElement>('.app-notification-close')!
      assert.equal(close.getAttribute('aria-label'), isZh ? '关闭通知中心' : 'Close notification center')
      assert.equal(dialog.querySelector('.app-notification-message')!.textContent, 'The complete failure reason.')
      await context.change(() => close.focus())
      let escapedKeys = 0
      const onKeyDown = () => { escapedKeys++ }
      context.document.addEventListener('keydown', onKeyDown)
      try {
        // JSDOM does not implement a native dialog's Tab loop. Verify only the
        // existing event boundary here; real Tab trapping belongs to Electron.
        await context.dispatch(close, context.tab(true))
        assert.equal(escapedKeys, 0)
        await context.change(() => context.outside.focus())
        const outsideTab = context.tab()
        await context.dispatch(context.outside, outsideTab)
        assert.equal(outsideTab.defaultPrevented, false)
        assert.equal(escapedKeys, 1)
        assert.equal(context.document.activeElement === context.outside, true)
      } finally {
        context.document.removeEventListener('keydown', onKeyDown)
      }
      await context.change(() => { close.focus(); close.click() })
      assert.equal(context.document.querySelectorAll('.notification-center').length, 0)
      assert.equal(context.bell() === bell && bell.isConnected, true)
      assert.equal(context.document.activeElement === bell, true)

      await context.change(() => bell.click())
      const reopened = context.document.querySelector<HTMLDialogElement>('.notification-center[open]')!
      assert.ok(reopened)
      // Native Escape emits cancel on a modal dialog; dispatching cancel tests its
      // React close lifecycle without pretending JSDOM implements native Escape.
      await context.dispatch(reopened, context.event('cancel'))
      assert.equal(context.document.querySelectorAll('.notification-center').length, 0)
      assert.equal(context.document.activeElement === bell, true)
    }, { isZh })
  }
})

test('language and compact-mode changes measure the overlay and clean listeners, observers and prior clearance under StrictMode', async () => {
  await withHost(async context => {
    let error!: ReturnType<typeof show>
    await context.change(() => { error = show({ title: 'Action failed', message: 'Read the retained reason.', level: 'error' }) })
    assert.equal(context.style.getPropertyValue(clearanceProperty), '132px')
    assert.equal(context.mediaListenerCount(), 1)
    assert.equal(context.resizeListenerCount(), 1)
    assert.equal(context.observers.filter(observer => !observer.disconnected).length, 1)
    assert.equal(context.subscriptions.plugin, 1)
    assert.equal(context.subscriptions.backup, 1)
    await context.change(() => context.outside.focus())
    context.setBounds({ top: 480.5, height: 140 })
    await context.language(true)
    await context.change(() => error.update({ title: '操作失败', message: '错误详情保存在通知中心，可继续重试。', level: 'error' }))
    assert.equal(context.summary().querySelector('button')!.textContent, '查看通知 (1)')
    assert.equal(context.summary().querySelector('button')!.getAttribute('aria-label'), '查看 1 条通知')
    assert.equal(context.summary().querySelector('.app-notification-message')!.textContent, '错误详情保存在通知中心，可继续重试。')
    assert.equal(context.style.getPropertyValue(clearanceProperty), '172px')
    assert.equal(context.subscriptions.plugin, 1)
    context.setBounds({ top: 420.25, height: 200 })
    const observer = [...context.observers].reverse().find(item => !item.disconnected)!
    await context.change(() => observer.deliver())
    assert.equal(context.style.getPropertyValue(clearanceProperty), '232px', 'Font or translated-line geometry is reported by ResizeObserver, not JSDOM CSS')

    context.setBounds({ top: 600, height: 180 })
    await context.viewport(1180, 900)
    assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 0)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '312px')
    assert.equal(context.document.activeElement === context.outside, true)
    await context.viewport(760, 900)
    assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 1)
    assert.equal(context.mediaListenerCount(), 1)
    assert.equal(context.resizeListenerCount(), 1)
    assert.equal(context.document.activeElement === context.outside, true)
    const queuedObserver = [...context.observers].reverse().find(item => !item.disconnected)!
    await context.unmount()
    assert.equal(context.mediaListenerCount(), 0)
    assert.equal(context.resizeListenerCount(), 0)
    assert.equal(context.observers.every(item => item.disconnected), true)
    assert.deepEqual(context.subscriptions, { plugin: 0, backup: 0 })
    assert.equal(context.style.getPropertyValue(clearanceProperty), '53px')
    assert.equal(context.style.getPropertyPriority(clearanceProperty), 'important')
    await context.change(() => queuedObserver.deliver())
    await context.viewport(1180, 800)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '53px')
    assert.equal(context.style.getPropertyPriority(clearanceProperty), 'important')
    assert.equal(context.style.getPropertyValue('--kb-accent'), '#123456')
    assert.equal(context.document.activeElement === context.outside, true)
  }, { strict: true, priorValue: '53px' })
})

test('full-card pointer exit cannot expire an ordinary notification while its dismiss control still has focus', async () => {
  for (const level of ['success', 'info', 'warning'] as const) {
    await withHost(async context => {
      await context.change(() => { show({ title: `Ordinary ${level}`, message: 'Keep this notice while reading its controls.', level }) })
      assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 0)
      const id = appNotifications.getSnapshot()[0].id
      const notification = card(context.document, String(id))
      const dismiss = notification.querySelector<HTMLButtonElement>('.app-notification-close')!
      await context.dispatch(notification, context.mouse('mouseover', context.outside))
      await context.change(() => dismiss.focus())
      assert.equal(context.document.activeElement === dismiss, true)
      await context.dispatch(notification, context.mouse('mouseout', context.outside))
      await context.advance(6_001)
      assert.equal(notification.isConnected, true, 'Pointer exit must not clear the independent keyboard pause')
      assert.equal(appNotifications.getSnapshot().some(item => item.id === id), true)
      assert.equal(context.document.activeElement === dismiss, true)

      await context.change(() => context.outside.focus())
      await context.advance(5_999)
      assert.equal(notification.isConnected, true)
      assert.equal(appNotifications.getSnapshot().some(item => item.id === id), true)
      await context.advance(1)
      assert.equal(notification.isConnected, false)
      assert.equal(appNotifications.getSnapshot().some(item => item.id === id), false)
      assert.equal(appNotifications.getHistorySnapshot().some(item => item.id === id), true)
      assert.equal(context.document.activeElement === context.outside, true)
    }, { width: 1360, height: 880 })
  }
})

test('full-card focus exit cannot expire an ordinary notification while the pointer remains over it', async () => {
  for (const level of ['success', 'info', 'warning'] as const) {
    await withHost(async context => {
      await context.change(() => { show({ title: `Ordinary ${level}`, message: 'Keep this notice while the pointer is reading it.', level }) })
      assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 0)
      const id = appNotifications.getSnapshot()[0].id
      const notification = card(context.document, String(id))
      const dismiss = notification.querySelector<HTMLButtonElement>('.app-notification-close')!
      await context.dispatch(notification, context.mouse('mouseover', context.outside))
      await context.change(() => dismiss.focus())
      assert.equal(context.document.activeElement === dismiss, true)
      await context.change(() => context.outside.focus())
      await context.advance(6_001)
      assert.equal(notification.isConnected, true, 'Focus exit must not clear the independent pointer pause')
      assert.equal(appNotifications.getSnapshot().some(item => item.id === id), true)
      assert.equal(context.document.activeElement === context.outside, true)

      await context.dispatch(notification, context.mouse('mouseout', context.outside))
      await context.advance(5_999)
      assert.equal(notification.isConnected, true)
      assert.equal(appNotifications.getSnapshot().some(item => item.id === id), true)
      await context.advance(1)
      assert.equal(notification.isConnected, false)
      assert.equal(appNotifications.getSnapshot().some(item => item.id === id), false)
      assert.equal(appNotifications.getHistorySnapshot().some(item => item.id === id), true)
      assert.equal(context.document.activeElement === context.outside, true)
    }, { width: 1360, height: 880 })
  }
})
