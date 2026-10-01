import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, StrictMode, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { AppNotification } from '../src/renderer/src/app-notifications'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: AppNotificationList } = await import('../src/renderer/src/components/AppNotificationList')

type Props = ComponentProps<typeof AppNotificationList>
type Bounds = { top: number; height: number }
const clearanceProperty = '--kb-notification-clearance'
const notice = (message = 'The saved settings are ready.'): AppNotification => ({
  id: 1, title: 'Settings', message, level: 'success', persistent: true,
  createdAt: 0, updatedAt: 0, read: false
})

type Observer = {
  target: Element | null
  disconnected: boolean
  disconnectCalls: number
  deliver: () => void
}
function activeObserver(observers: readonly Observer[]): Observer {
  const observer = [...observers].reverse().find(item => !item.disconnected)
  assert.ok(observer)
  return observer
}
type Context = {
  document: Document
  style: CSSStyleDeclaration
  observers: Observer[]
  list: () => HTMLElement
  patch: (props: Partial<Props>) => Promise<void>
  setBounds: (bounds: Bounds) => void
  notifyResize: (observer?: Observer) => Promise<void>
  resizeWindow: (height: number) => Promise<void>
  unmount: () => Promise<void>
  resizeListenerCount: () => number
  dialogCalls: { show: number; close: number }
}

async function withNotifications(run: (context: Context) => Promise<void>, options: {
  strict?: boolean
  noResizeObserver?: boolean
  notifications?: readonly AppNotification[]
  priorValue?: string
  priorPriority?: string
  bounds?: Bounds
} = {}) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const style = dom.window.document.documentElement.style
  if (options.priorValue) style.setProperty(clearanceProperty, options.priorValue, options.priorPriority ?? '')
  style.setProperty('--kb-accent', '#123456')
  style.setProperty('--unrelated-layout-token', 'preserved')
  let bounds = options.bounds ?? { top: 600, height: 120 }
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, writable: true, value: 800 })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches('.app-notifications')
      ? new dom.window.DOMRect(0, bounds.top, 360, bounds.height)
      : new dom.window.DOMRect(0, 0, 240, 32)
  }
  const observers: Observer[] = []
  class ControlledResizeObserver implements ResizeObserver, Observer {
    target: Element | null = null
    disconnected = false
    disconnectCalls = 0
    constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
    observe(target: Element) { this.target = target; this.disconnected = false }
    unobserve(target: Element) { if (this.target === target) this.target = null }
    disconnect() { this.disconnected = true; this.disconnectCalls++ }
    deliver() {
      assert.ok(this.target)
      // Retaining the target also lets a test deliver a callback queued before cleanup.
      this.callback([{ target: this.target, contentRect: this.target.getBoundingClientRect() } as ResizeObserverEntry], this)
    }
  }
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true,
    value: options.noResizeObserver ? undefined : ControlledResizeObserver })
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
  const dialogCalls = { show: 0, close: 0 }
  dom.window.HTMLDialogElement.prototype.showModal = function () { dialogCalls.show++; this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { dialogCalls.close++; this.removeAttribute('open') }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true
  const notifications = options.notifications ?? [notice()]
  let props: Props = { notifications, history: notifications, open: false, isZh: false,
    onClose: () => {}, onDismiss: () => {}, onOpenDocument: () => {} }
  const render = () => {
    const element = createElement(AppNotificationList, props)
    root.render(options.strict ? createElement(StrictMode, null, element) : element)
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await act(async () => render())
    await run({ document: dom.window.document, style, observers, dialogCalls,
      list: () => dom.window.document.querySelector<HTMLElement>('.app-notifications')!,
      patch: async changes => { await act(async () => { props = { ...props, ...changes }; render() }) },
      setBounds: next => { bounds = next },
      notifyResize: async observer => {
        const current = observer ?? activeObserver(observers)
        await act(async () => current.deliver())
      },
      resizeWindow: async height => { await act(async () => {
        Object.defineProperty(dom.window, 'innerHeight', { configurable: true, writable: true, value: height })
        dom.window.dispatchEvent(new dom.window.Event('resize'))
      }) },
      unmount, resizeListenerCount: () => resizeListeners.size })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('notification clearance is measured before paint, rounded up, and clamped without changing other design tokens', async () => {
  for (const strict of [false, true]) {
    await withNotifications(async context => {
      assert.equal(context.style.getPropertyValue(clearanceProperty), '176px')
      assert.equal(context.list().children.length, 1)
      assert.equal(context.observers.filter(observer => !observer.disconnected).length, 1)
      assert.equal(activeObserver(context.observers).target, context.list())
      assert.equal(context.resizeListenerCount(), 1)
      assert.equal(context.style.getPropertyValue('--kb-accent'), '#123456')
      assert.equal(context.style.getPropertyValue('--unrelated-layout-token'), 'preserved')
      context.setBounds({ top: 900, height: 72 })
      await context.notifyResize()
      assert.equal(context.style.getPropertyValue(clearanceProperty), '0px')
      assert.equal(context.list().querySelector('.app-notification-message')!.textContent, notice().message)
      assert.equal(context.style.getPropertyValue('--kb-accent'), '#123456')
    }, { strict, bounds: { top: 636.4, height: 72 } })
  }
})

test('same-count notification updates, wrapped translations, and viewport resize all refresh the measured clearance', async () => {
  await withNotifications(async context => {
    const translated = notice('桥接设置已保存。请把最新的提交地址和令牌同步到浏览器扩展。')
    assert.equal(context.style.getPropertyValue(clearanceProperty), '212px')
    context.setBounds({ top: 560.25, height: 176 })
    await context.patch({ notifications: [translated], history: [translated], isZh: true })
    assert.equal(context.list().getAttribute('aria-label'), '应用内通知')
    assert.equal(context.list().querySelector('.app-notification-message')!.textContent, translated.message)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '252px', 'A same-count update must measure on its own commit')
    // JSDOM does not lay out text. The controlled rectangle represents the browser
    // reporting extra wrapped lines after fonts or available width change.
    context.setBounds({ top: 480.5, height: 254 })
    assert.equal(context.style.getPropertyValue(clearanceProperty), '252px')
    await context.notifyResize()
    assert.equal(context.style.getPropertyValue(clearanceProperty), '332px')
    context.setBounds({ top: 400.4, height: 176 })
    await context.resizeWindow(640)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '252px')
    assert.equal(context.list().querySelector('.app-notification-message')!.textContent, translated.message)
    assert.equal(context.resizeListenerCount(), 1)
  })
})

test('empty notification lists and zero-height overlays reserve no space and recover after real cards return', async () => {
  await withNotifications(async context => {
    assert.equal(context.list().children.length, 0)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '0px', 'An empty section must not reserve its supplied rectangle')
    await context.patch({ notifications: [notice()] })
    assert.equal(context.style.getPropertyValue(clearanceProperty), '212px')
    context.setBounds({ top: 600, height: 0 })
    await context.notifyResize()
    assert.equal(context.style.getPropertyValue(clearanceProperty), '0px')
    context.setBounds({ top: 600, height: 120 })
    await context.notifyResize()
    assert.equal(context.style.getPropertyValue(clearanceProperty), '212px')
    await context.patch({ notifications: [] })
    assert.equal(context.list().children.length, 0)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '0px')
    await context.resizeWindow(900)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '0px')
  }, { notifications: [] })
})

test('opening history and unmounting restore a prior CSS value and priority while cleaning observers and resize listeners', async () => {
  await withNotifications(async context => {
    assert.equal(context.style.getPropertyValue(clearanceProperty), '212px')
    const previousObserver = activeObserver(context.observers)
    const previousList = context.list()
    await context.patch({ open: true })
    assert.equal(context.document.querySelector('.app-notifications'), null)
    assert.equal(previousList.isConnected, false)
    assert.equal(context.document.querySelectorAll('dialog[open]').length, 1)
    assert.equal(context.dialogCalls.show, 1)
    assert.equal(previousObserver.disconnected, true)
    assert.equal(previousObserver.disconnectCalls, 1)
    assert.equal(context.resizeListenerCount(), 0)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '53px')
    assert.equal(context.style.getPropertyPriority(clearanceProperty), 'important')
    context.setBounds({ top: 300, height: 360 })
    await context.notifyResize(previousObserver)
    await context.resizeWindow(640)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '53px', 'Late callbacks cannot reclaim a restored property')
    assert.equal(context.style.getPropertyPriority(clearanceProperty), 'important')
    await context.patch({ open: false })
    assert.equal(context.dialogCalls.close, 1)
    assert.ok(context.list().isConnected)
    assert.notEqual(context.list(), previousList)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '352px')
    assert.equal(context.resizeListenerCount(), 1)
    const currentObserver = activeObserver(context.observers)
    await context.unmount()
    assert.equal(currentObserver.disconnected, true)
    assert.equal(context.resizeListenerCount(), 0)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '53px')
    assert.equal(context.style.getPropertyPriority(clearanceProperty), 'important')
    await context.notifyResize(currentObserver)
    await context.resizeWindow(1000)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '53px')
    assert.equal(context.style.getPropertyPriority(clearanceProperty), 'important')
    assert.equal(context.style.getPropertyValue('--kb-accent'), '#123456')
    assert.equal(context.style.getPropertyValue('--unrelated-layout-token'), 'preserved')
  }, { priorValue: '53px', priorPriority: 'important' })
})

test('an originally absent clearance property is removed on cleanup and cannot be recreated by late callbacks', async () => {
  await withNotifications(async context => {
    const observer = activeObserver(context.observers)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '212px')
    await context.unmount()
    assert.equal(observer.disconnected, true)
    assert.equal(context.resizeListenerCount(), 0)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '')
    await context.notifyResize(observer)
    await context.resizeWindow(600)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '')
    assert.equal(context.style.getPropertyValue('--kb-accent'), '#123456')
  })
})

test('initial measurement and viewport resize still work when ResizeObserver is unavailable', async () => {
  await withNotifications(async context => {
    assert.equal(context.observers.length, 0)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '212px')
    assert.equal(context.resizeListenerCount(), 1)
    context.setBounds({ top: 450.5, height: 176 })
    await context.resizeWindow(700)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '262px')
    await context.unmount()
    assert.equal(context.resizeListenerCount(), 0)
    assert.equal(context.style.getPropertyValue(clearanceProperty), '')
  }, { noResizeObserver: true })
})
