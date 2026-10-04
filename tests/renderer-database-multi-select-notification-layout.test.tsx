import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { act, createElement, Fragment } from 'react'
import { JSDOM } from 'jsdom'
import type { AppNotificationHandle } from '../src/shared/app-notification'
import type { DocumentDatabaseColumn, DocumentDatabaseFieldValue } from '../src/shared/contracts'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import type { DatabaseValueCommitResult } from '../src/renderer/src/features/database/model/databaseTextDrafts'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
await Promise.all([import('../src/renderer/src/components/AppNotificationList'),
  import('../src/renderer/src/notification-history'), import('../src/renderer/src/backup-notifications')])
const { AppNotificationHost } = await import('../src/renderer/src/components/AppNotificationHost')
const { DatabaseValueEditor } = await import('../src/renderer/src/features/database/components/DatabaseValueEditor')

type Box = { left: number; top: number; width: number; height: number }
type Layout = { width: number; height: number; anchor: Box; outer: Box; scroller: Box; toastHeight: number }
type Observed = { targets: Set<Element>; ever: Set<Element>; disconnected: boolean; deliver: (target: Element) => void }
const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height })
const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
function within(actual: DOMRect, bounds: DOMRect) {
  assert.equal(actual.left >= bounds.left && actual.right <= bounds.right
    && actual.top >= bounds.top && actual.bottom <= bounds.bottom, true,
  `box ${JSON.stringify(actual.toJSON())} must fit ${JSON.stringify(bounds.toJSON())}`)
}
function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) appNotifications.dismiss(id)
  appNotifications.clearCompleted()
}

async function withLayout(run: (context: {
  document: Document; window: JSDOM['window']; layout: Layout; observers: Observed[]; focusCalls: HTMLElement[]
  commits: DocumentDatabaseFieldValue[]; frames: Map<number, FrameRequestCallback>
  details: () => HTMLDetailsElement; menu: () => HTMLDivElement; option: (name: string) => HTMLInputElement
  change: (run: () => void) => Promise<void>; flush: () => Promise<void>; open: (value: boolean) => Promise<void>
  render: (shown: boolean, identity?: number) => Promise<void>; resize: () => Promise<void>
  notice: () => Promise<AppNotificationHandle>; observedResize: (target: Element) => Promise<void>
  acknowledgeReadFailure: () => Promise<void>; clip: () => DOMRect; cards: () => HTMLElement[]
}) => Promise<void>, options: { locale?: 'en-US' | 'zh-CN'; choices?: string[] } = {}) {
  clearNotifications()
  const locale = options.locale ?? 'en-US', text = getDatabaseWorkspaceText(locale)
  const dom = new JSDOM('<button id="outside">Outside</button><div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const document = dom.window.document
  // Load the real rules so compact-hidden cards and scrollable menus have their
  // production visibility/overflow. Only JSDOM's absent layout metrics are supplied.
  const css = document.createElement('style')
  css.textContent = readFileSync(new URL('../src/renderer/src/features/database/database-workspace.css', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/renderer/src/components/app-notifications.css', import.meta.url), 'utf8')
  document.head.append(css)
  const layout: Layout = { width: 1100, height: 760, anchor: box(680, 370, 120, 32),
    outer: box(0, 0, 1100, 760), scroller: box(240, 140, 820, 560), toastHeight: 80 }
  Object.defineProperties(dom.window, {
    innerWidth: { configurable: true, get: () => layout.width }, innerHeight: { configurable: true, get: () => layout.height }
  })
  const mediaListeners = new Set<EventListenerOrEventListenerObject>()
  const media = { media: '(max-width:900px), (max-height:700px)', get matches() { return layout.width <= 900 || layout.height <= 700 },
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => mediaListeners.delete(listener)
  }
  dom.window.matchMedia = () => media as unknown as MediaQueryList
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  dom.window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
  dom.window.cancelAnimationFrame = id => { frames.delete(id) }
  const observers: Observed[] = []
  class ControlledResizeObserver {
    state: Observed
    constructor(callback: ResizeObserverCallback) {
      this.state = { targets: new Set(), ever: new Set(), disconnected: false,
        deliver: target => callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver) }
      observers.push(this.state)
    }
    observe(target: Element) { this.state.targets.add(target); this.state.ever.add(target); this.state.disconnected = false }
    unobserve(target: Element) { this.state.targets.delete(target) }
    disconnect() { this.state.targets.clear(); this.state.disconnected = true }
  }
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: ControlledResizeObserver })
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  const originalRects = dom.window.HTMLElement.prototype.getClientRects
  const originalFocus = dom.window.HTMLElement.prototype.focus
  const focusCalls: HTMLElement[] = []
  const rect = (value: Box) => new dom.window.DOMRect(value.left, value.top, value.width, value.height)
  const visibleCards = () => [...document.querySelectorAll<HTMLElement>('.app-notifications > .app-notification, .app-notifications > .app-notification-summary')]
    .filter(card => dom.window.getComputedStyle(card).display !== 'none')
  const toastBoxes = () => {
    const cards = visibleCards(), height = layout.toastHeight
    const total = cards.length * height + Math.max(0, cards.length - 1) * 10 + 8
    const left = Math.max(0, layout.width - 24 - Math.min(380, layout.width - 32)), top = layout.height - 24 - total
    return { list: box(left, top, Math.min(380, layout.width - 32), total), cards: new Map(cards.map((card, index) =>
      [card, box(left + 4, top + 4 + index * (height + 10), Math.min(372, layout.width - 40), height)])) }
  }
  const contentHeight = (menu: HTMLElement) => menu.querySelectorAll('label').length * 32 + 14
    + (menu.querySelector('.dbw-multi-feedback') ? 64 : 0) + (menu.querySelector('button') ? 34 : 0)
  const menuBox = (menu: HTMLElement) => {
    const width = Number.parseFloat(menu.style.width) || layout.anchor.width
    const limit = Number.parseFloat(menu.style.maxHeight)
    const height = Math.min(contentHeight(menu) + 2, Number.isFinite(limit) ? limit : contentHeight(menu) + 2)
    // Interpret the emitted CSS coordinates, rather than reproducing the hook's
    // placement/obstacle algorithm or supplying its desired answer as a rect.
    const above = menu.style.bottom !== '' && menu.style.bottom !== 'auto'
    const offset = Number.parseFloat((above ? menu.style.bottom : menu.style.top).match(/\+\s*([\d.]+)px/)?.[1] ?? '0')
    return box(layout.anchor.left + (Number.parseFloat(menu.style.left) || 0),
      above ? layout.anchor.top - offset - height : layout.anchor.top + layout.anchor.height + offset, width, height)
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === 'outer') return rect(layout.outer)
    if (this.id === 'scroller') return rect(layout.scroller)
    if (this.matches('.dbw-multi-editor, .dbw-multi-editor > summary')) return rect(layout.anchor)
    if (this.classList.contains('app-notifications')) return rect(toastBoxes().list)
    if (this.matches('.app-notifications > .app-notification, .app-notifications > .app-notification-summary')) return rect(toastBoxes().cards.get(this) ?? box(0, 0, 0, 0))
    if (this.classList.contains('dbw-multi-editor-menu')) return rect(menuBox(this))
    const menu = this.closest<HTMLElement>('.dbw-multi-editor-menu')
    if (menu) {
      const bounds = menuBox(menu), label = this.closest('label')
      const labels = [...menu.querySelectorAll('label')]
      const top = bounds.top + 7 - menu.scrollTop + (label ? labels.indexOf(label) * 32
        : labels.length * 32 + (this.matches('button') ? 64 : 0))
      return rect(box(bounds.left + 7, top, bounds.width - 14, label ? 32 : this.matches('button') ? 34 : 64))
    }
    return rect(box(0, 0, 100, 32))
  }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    let visible = this.isConnected
    for (let element: HTMLElement | null = this; element && visible; element = element.parentElement) {
      if (element.hidden || dom.window.getComputedStyle(element).display === 'none') visible = false
    }
    const values = visible ? [this.getBoundingClientRect()] : []
    return Object.assign(values, { item: (index: number) => values[index] ?? null }) as unknown as DOMRectList
  }
  dom.window.HTMLElement.prototype.focus = function (settings) { focusCalls.push(this); originalFocus.call(this, settings) }
  const dimension = (element: HTMLElement, name: 'clientWidth' | 'clientHeight') => {
    if (element.id === 'outer' || element.id === 'scroller') return (name === 'clientWidth' ? element.getBoundingClientRect().width : element.getBoundingClientRect().height) - 4
    if (element.classList.contains('dbw-multi-editor-menu')) return (name === 'clientWidth' ? element.getBoundingClientRect().width : element.getBoundingClientRect().height) - 2
    return 0
  }
  for (const name of ['clientWidth', 'clientHeight'] as const) Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true,
    get() { return dimension(this as HTMLElement, name) } })
  for (const name of ['clientTop', 'clientLeft'] as const) Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true,
    get() { return (this as HTMLElement).matches('#outer, #scroller') ? 2 : 0 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true,
    get() { return (this as HTMLElement).classList.contains('dbw-multi-editor-menu') ? contentHeight(this as HTMLElement) : this.clientHeight } })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: { onPluginNotification: () => () => {}, onBackupHealth: () => () => {},
    getBackupHealth: async () => ({ revision: 0, error: null }) } })
  const commits: DocumentDatabaseFieldValue[] = []
  let acknowledge!: (value: DatabaseValueCommitResult) => void
  const promise = new Promise<DatabaseValueCommitResult>(resolve => { acknowledge = resolve })
  const column: DocumentDatabaseColumn = { id: 'tags', name: 'Tags', type: 'multi-select',
    options: options.choices ?? ['Blue', 'Red', 'Green'], sortOrder: 0 }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const flush = async () => {
    for (let turn = 0; turn < 8; turn++) {
      await act(async () => {
        await Promise.resolve()
        const pending = [...frames]
        for (const [id, callback] of pending) { frames.delete(id); callback(turn) }
        await Promise.resolve()
      })
      if (frames.size === 0) { await act(async () => { await Promise.resolve() }); if (frames.size === 0) return }
    }
    assert.equal(frames.size, 0, 'observer-driven positioning must settle without a frame loop')
  }
  const render = async (shown: boolean, identity = 0) => {
    await act(async () => root.render(createElement(Fragment, null,
      createElement('div', { id: 'outer', style: { overflowX: 'hidden', overflowY: 'hidden' } },
        createElement('div', { id: 'scroller', style: { overflowX: 'auto', overflowY: 'auto' } }, shown ? createElement(DatabaseValueEditor,
          { key: identity, column, value: ['Blue'], text, onRefreshValue: async () => {},
            onChangeValue: value => { commits.push(structuredClone(value)); return promise } }) : null)),
      createElement(AppNotificationHost, { isZh: locale === 'zh-CN', onOpenDocument: () => {} }))))
    await flush()
  }
  const details = () => document.querySelector<HTMLDetailsElement>('.dbw-multi-editor')!
  const menu = () => details().querySelector<HTMLDivElement>('.dbw-multi-editor-menu')!
  const open = async (value: boolean) => {
    if (details().open !== value) await act(async () => { details().querySelector('summary')!.click(); await new Promise(resolve => dom.window.setTimeout(resolve, 0)) })
    assert.equal(details().open, value)
    await flush()
  }
  const clip = () => {
    const left = Math.max(0, layout.outer.left + 2, layout.scroller.left + 2), top = Math.max(0, layout.outer.top + 2, layout.scroller.top + 2)
    const right = Math.min(layout.width, layout.outer.left + layout.outer.width - 2, layout.scroller.left + layout.scroller.width - 2)
    const bottom = Math.min(layout.height, layout.outer.top + layout.outer.height - 2, layout.scroller.top + layout.scroller.height - 2)
    return new dom.window.DOMRect(left, top, right - left, bottom - top)
  }
  try {
    await render(true)
    await open(true)
    await run({ document, window: dom.window, layout, observers, focusCalls, commits, frames, details, menu, change, flush, open, render, clip,
      option: name => { const input = [...menu().querySelectorAll<HTMLInputElement>('input')].find(input => input.parentElement?.textContent === name); assert.ok(input); return input },
      resize: async () => { await change(() => {
        for (const listener of [...mediaListeners]) { const event = new dom.window.Event('change'); if (typeof listener === 'function') listener(event); else listener.handleEvent(event) }
        dom.window.dispatchEvent(new dom.window.Event('resize'))
      }); await flush() },
      notice: async () => { let notice!: AppNotificationHandle; await change(() => { notice = appNotifications.show({ title: 'Read failed', message: text.savedRefreshFailed, level: 'error' }) }); await flush(); return notice },
      observedResize: async target => {
        const active = observers.filter(observer => !observer.disconnected && observer.targets.has(target))
        assert.ok(active.length > 0, 'a resize must reach observers actually watching this element')
        await change(() => active.forEach(observer => observer.deliver(target))); await flush()
      },
      acknowledgeReadFailure: async () => { await change(() => acknowledge({ status: 'saved', value: ['Blue', 'Red'], refreshError: text.savedRefreshFailed })); await flush() },
      cards: visibleCards })
  } finally {
    await act(async () => root.unmount())
    clearNotifications()
    frames.clear()
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect
    dom.window.HTMLElement.prototype.getClientRects = originalRects
    dom.window.HTMLElement.prototype.focus = originalFocus
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
    dom.window.close()
  }
}

test('live notification appearance, height updates and removal keep the saved Refresh menu readable without restoring checkbox focus', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withLayout(async context => {
    const red = context.option('Red'), menu = context.menu()
    await context.change(() => { red.focus(); red.click() })
    await context.acknowledgeReadFailure()
    context.focusCalls.length = 0
    const refresh = menu.querySelector<HTMLButtonElement>('button')!
    assert.equal(refresh.textContent, getDatabaseWorkspaceText(locale).refresh)
    assert.equal(menu.querySelector('.dbw-multi-feedback')?.textContent, getDatabaseWorkspaceText(locale).savedRefreshFailed)
    const original = menu.getBoundingClientRect()
    const notice = await context.notice()
    const check = () => {
      const current = menu.getBoundingClientRect()
      within(current, context.clip())
      within(refresh.getBoundingClientRect(), current)
      for (const card of context.cards()) assert.equal(intersects(current, card.getBoundingClientRect()), false)
      assert.equal(context.option('Red') === red && context.document.activeElement === red, true)
      assert.equal(red.checked, true)
      assert.equal(context.option('Blue').checked, true)
      assert.equal(context.option('Green').checked, false)
      assert.deepEqual(context.commits, [['Blue', 'Red']])
      assert.equal(context.focusCalls.length, 0)
    }
    check()
    // No store update, menu resize or viewport event accompanies this font/wrap
    // change: only the actual visible notification's ResizeObserver is delivered.
    context.layout.toastHeight = 240
    await context.observedResize(context.cards()[0])
    check()
    assert.equal(menu.getBoundingClientRect().left !== original.left || menu.getBoundingClientRect().top !== original.top, true)
    await context.change(() => notice.update({ title: 'Shorter notice', message: 'Saved choices remain available.', level: 'error' }))
    context.layout.toastHeight = 80
    await context.observedResize(context.cards()[0])
    check()
    assert.equal(menu.getBoundingClientRect().left, original.left)
    await context.change(() => appNotifications.hide(Number(context.cards()[0].dataset.notificationId)))
    await context.flush()
    assert.equal(context.document.querySelectorAll('.app-notifications').length, 0)
    check()
    assert.equal(menu.getBoundingClientRect().left, original.left)
    assert.equal(menu.getBoundingClientRect().top, original.top)
  }, { locale })
})

test('a short narrow viewport intersects every scroll ancestor and leaves an internally scrollable menu with unchanged choices', async () => {
  await withLayout(async context => {
    Object.assign(context.layout, { width: 360, height: 300, outer: box(20, 30, 300, 240),
      scroller: box(40, 50, 240, 170), anchor: box(215, 145, 80, 32), toastHeight: 64 })
    const red = context.option('Red')
    await context.change(() => red.focus())
    context.focusCalls.length = 0
    await context.resize()
    const notice = await context.notice()
    const menu = context.menu(), before = menu.getBoundingClientRect()
    assert.equal(context.document.querySelectorAll('.app-notification-summary').length, 1)
    assert.equal(context.document.querySelector('.app-notification')!.getClientRects().length, 0, 'compact-hidden full cards must not become obstacles')
    within(before, context.clip())
    for (const card of context.cards()) assert.equal(intersects(before, card.getBoundingClientRect()), false)
    assert.equal(menu.scrollHeight > menu.clientHeight, true)
    assert.equal(context.window.getComputedStyle(menu).overflow, 'auto')
    await context.change(() => { menu.scrollTop = menu.scrollHeight - menu.clientHeight; menu.dispatchEvent(new context.window.Event('scroll', { bubbles: true })) })
    await context.flush()
    const last = context.option('Last option')
    within(last.getBoundingClientRect(), menu.getBoundingClientRect())
    within(menu.getBoundingClientRect(), context.clip())
    assert.equal(context.document.activeElement === red, true)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.commits, [])
    assert.equal(context.option('Blue').checked, true)
    assert.equal(red.checked, false)
    await context.change(() => notice.dismiss())
    await context.flush()
    within(menu.getBoundingClientRect(), context.clip())
    assert.equal(context.document.activeElement === red, true)
    assert.equal(context.focusCalls.length, 0)
  }, { choices: ['Blue', 'Red', 'Green', ...Array.from({ length: 8 }, (_, index) => `Option ${index}`), 'Last option'] })
})

test('closed and unmounted editors discard queued positioning callbacks without changing a newly opened menu or focus', async () => {
  await withLayout(async context => {
    const oldMenu = context.menu()
    const oldObservers = context.observers.filter(observer => observer.ever.has(oldMenu))
    assert.ok(oldObservers.length > 0)
    await context.notice()
    await context.change(() => context.window.dispatchEvent(new context.window.Event('resize')))
    const copied = [...context.frames.values()]
    assert.ok(copied.length > 0)
    await context.open(false)
    assert.equal(oldObservers.every(observer => observer.disconnected), true)
    const closedStyle = oldMenu.getAttribute('style')
    await context.change(() => { oldObservers.forEach(observer => observer.deliver(oldMenu)); copied.forEach(callback => callback(1)) })
    await context.flush()
    assert.equal(oldMenu.getAttribute('style'), closedStyle)
    await context.render(false)
    assert.equal(oldMenu.isConnected, false)
    context.layout.anchor = box(400, 320, 120, 32)
    await context.render(true, 1)
    await context.open(true)
    const currentMenu = context.menu(), red = context.option('Red')
    await context.change(() => red.focus())
    context.focusCalls.length = 0
    const currentStyle = currentMenu.getAttribute('style')
    await context.change(() => { oldObservers.forEach(observer => observer.deliver(oldMenu)); copied.forEach(callback => callback(2)) })
    await context.flush()
    assert.equal(context.menu() === currentMenu && currentMenu !== oldMenu, true)
    assert.equal(currentMenu.getAttribute('style'), currentStyle)
    assert.equal(context.document.activeElement === red, true)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.commits, [])
    within(currentMenu.getBoundingClientRect(), context.clip())
    context.layout.toastHeight = 240
    await context.observedResize(context.cards()[0])
    within(currentMenu.getBoundingClientRect(), context.clip())
    for (const card of context.cards()) assert.equal(intersects(currentMenu.getBoundingClientRect(), card.getBoundingClientRect()), false)
    assert.equal(context.document.activeElement === red, true)
    assert.equal(context.focusCalls.length, 0)
  })
})
