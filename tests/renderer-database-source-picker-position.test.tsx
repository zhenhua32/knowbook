import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseSource } from '../src/shared/contracts'
import { DatabaseHeader } from '../src/renderer/src/features/database/components/DatabaseHeader'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

type Box = { left: number; top: number; width: number; height: number }
type Layout = { width: number; height: number; outer: Box; shell: Box; anchor: Box; rowHeight: number;
  searchHeight: number; createHeight: number }
type Observer = { targets: Set<Element>; disconnected: boolean; deliver: (target: Element) => void }
type Context = {
  document: Document; window: JSDOM['window']; layout: Layout; observers: Observer[]
  frames: Map<number, FrameRequestCallback>; copies: FrameRequestCallback[]; focusCalls: HTMLElement[]
  model: { currentSource: DatabaseSource; sources: DatabaseSource[]; sourceSessionKey: object }
  calls: { create: (HTMLElement | null)[]; edit: (HTMLElement | null)[]; record: number; delete: number; refresh: number; source: string[] }
  find: <T extends HTMLElement>(selector: string) => T
  change: (callback: () => void) => Promise<void>; render: (shown?: boolean) => Promise<void>
  open: () => Promise<void>; close: () => Promise<void>; fill: (value: string) => Promise<void>
  flush: () => Promise<void>; resize: () => Promise<void>; observedResize: (target: Element) => Promise<void>
  clip: () => DOMRect; subscriptions: () => number; assertData: () => void
}
const rawQuery = ' Shared source '
const sources: DatabaseSource[] = [
  { id: 'catalog', kind: 'document-catalog', name: 'Catalog', description: 'Original catalog metadata',
    canDelete: false, canCreateDetachedRecord: false },
  ...Array.from({ length: 7 }, (_, index): DatabaseSource => ({ id: `source-${index}`, kind: 'custom',
    name: `Shared source ${index} — distinguishing name suffix`,
    description: `Keep original description ${index} and all database records.`, canDelete: true, canCreateDetachedRecord: true }))
]
const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height })
const pixels = (value: string) => { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? parsed : 0 }
function within(actual: DOMRect, clip: DOMRect, message: string) {
  assert.equal(actual.left >= clip.left - 0.001 && actual.top >= clip.top - 0.001
    && actual.right <= clip.right + 0.001 && actual.bottom <= clip.bottom + 0.001, true,
  `${message}: actual=${JSON.stringify(actual.toJSON())}, clip=${JSON.stringify(clip.toJSON())}`)
}

async function withLayout(run: (context: Context) => Promise<void>, options: { locale?: 'en-US' | 'zh-CN'; tall?: boolean } = {}) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const document = dom.window.document, locale = options.locale ?? 'en-US'
  const css = document.createElement('style')
  css.textContent = readFileSync(new URL('../src/renderer/src/features/database/database-workspace.css', import.meta.url), 'utf8')
  document.head.append(css)
  // JSDOM retains overflow shorthand but returns initial `visible` for its
  // undeclared axes. Expand only those axes; explicit longhands stay authoritative.
  const nativeComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  dom.window.getComputedStyle = (element, pseudoElement) => {
    const style = nativeComputedStyle(element, pseudoElement)
    const declared = new Set(Array.from({ length: style.length }, (_, index) => style.item(index)))
    const shorthand = declared.has('overflow') ? style.overflow.trim().split(/\s+/) : []
    const axes: Record<string, string> = {}
    if (shorthand.length >= 1 && shorthand.length <= 2
      && shorthand.every(value => /^(visible|hidden|clip|scroll|auto)$/.test(value))) {
      if (!declared.has('overflow-x')) axes['overflow-x'] = shorthand[0]
      if (!declared.has('overflow-y')) axes['overflow-y'] = shorthand[1] ?? shorthand[0]
    }
    return new Proxy(style, { get(target, property) {
      if (property === 'overflowX' && axes['overflow-x']) return axes['overflow-x']
      if (property === 'overflowY' && axes['overflow-y']) return axes['overflow-y']
      if (property === 'getPropertyValue') return (name: string) => axes[name] ?? target.getPropertyValue(name)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  const layout: Layout = { width: 760, height: options.tall ? 760 : 440,
    outer: box(18.25, 20.5, 714.5, options.tall ? 722.25 : 402.25), shell: box(30.5, 26.25, 688.75, 740),
    anchor: box(100.25, 76.75, 250, 59), rowHeight: 64, searchHeight: 42, createHeight: 42 }
  Object.defineProperties(dom.window, { innerWidth: { configurable: true, get: () => layout.width },
    innerHeight: { configurable: true, get: () => layout.height } })
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  const frames = new Map<number, FrameRequestCallback>(), copies: FrameRequestCallback[] = [], observers: Observer[] = []
  let frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); copies.push(callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  dom.window.requestAnimationFrame = requestFrame; dom.window.cancelAnimationFrame = cancelFrame
  class ControlledResizeObserver {
    state: Observer
    constructor(callback: ResizeObserverCallback) {
      this.state = { targets: new Set(), disconnected: false,
        deliver: target => callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver) }
      observers.push(this.state)
    }
    observe(target: Element) { this.state.targets.add(target); this.state.disconnected = false }
    unobserve(target: Element) { this.state.targets.delete(target) }
    disconnect() { this.state.targets.clear(); this.state.disconnected = true }
  }
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: ControlledResizeObserver })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    ResizeObserver: ControlledResizeObserver, requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector); assert.ok(element, `Expected actual Header DOM: ${selector}`); return element
  }
  const rect = (value: Box) => new dom.window.DOMRect(value.left, value.top, value.width, value.height)
  const outerScroll = () => document.getElementById('outer')?.scrollTop ?? 0
  const anchor = () => ({ ...layout.anchor, top: layout.anchor.top - outerScroll() })
  const border = (element: HTMLElement, edge: 'Top' | 'Bottom' | 'Left' | 'Right') => pixels(
    dom.window.getComputedStyle(element).getPropertyValue(`border-${edge.toLowerCase()}-width`))
  const padding = (element: HTMLElement, edge: 'Top' | 'Bottom' | 'Left' | 'Right') => pixels(
    dom.window.getComputedStyle(element).getPropertyValue(`padding-${edge.toLowerCase()}`))
  const naturalListHeight = (menu: HTMLElement) => {
    const list = menu.querySelector('.dbw-source-list')!
    return list.querySelectorAll('.dbw-source-option').length * layout.rowHeight
      + list.querySelectorAll('.dbw-menu-label').length * 24 + (list.querySelector('.dbw-source-empty') ? 42 : 0) + 12
  }
  const chromeHeight = (menu: HTMLElement) => layout.searchHeight + layout.createHeight
    + border(menu, 'Top') + border(menu, 'Bottom') + padding(menu, 'Top') + padding(menu, 'Bottom')
  const listLimit = (menu: HTMLElement) => {
    const value = pixels(dom.window.getComputedStyle(menu.querySelector('.dbw-source-list')!).maxHeight)
    return value > 0 ? value : Infinity
  }
  const menuBox = (menu: HTMLElement): Box => {
    const style = dom.window.getComputedStyle(menu), wrap = anchor()
    const natural = chromeHeight(menu) + Math.min(naturalListHeight(menu), listLimit(menu))
    const maximum = Number.parseFloat(style.maxHeight)
    const height = Math.min(natural, Number.isFinite(maximum) ? maximum : natural)
    const preferredWidth = Math.min(390, layout.width - 70)
    const requestedWidth = Number.parseFloat(style.width) || preferredWidth
    const maximumWidth = Number.parseFloat(style.maxWidth)
    const width = Math.min(requestedWidth, Number.isFinite(maximumWidth) ? maximumWidth : requestedWidth)
    const left = menu.style.left ? pixels(menu.style.left) : 0
    // Interpret emitted CSS relative coordinates, not the hook's placement or
    // clip algorithm. CSS's old percentage top is relative to source-wrap.
    const top = menu.style.top && !menu.style.top.includes('%') ? pixels(menu.style.top) : wrap.height + 10
    return box(wrap.left + left, wrap.top + top, width, height)
  }
  const listBox = (menu: HTMLElement): Box => {
    const bounds = menuBox(menu), style = dom.window.getComputedStyle(menu)
    const natural = Math.min(naturalListHeight(menu), listLimit(menu))
    const flexible = style.display === 'flex' && style.flexDirection === 'column'
    const height = flexible ? Math.min(natural, Math.max(0, bounds.height - chromeHeight(menu))) : natural
    return box(bounds.left + border(menu, 'Left') + padding(menu, 'Left'),
      bounds.top + border(menu, 'Top') + padding(menu, 'Top') + layout.searchHeight,
      bounds.width - border(menu, 'Left') - border(menu, 'Right') - padding(menu, 'Left') - padding(menu, 'Right'), height)
  }
  // JSDOM supplies no layout. These sensors model standard CSS sizing and
  // scroll offsets; text glyphs, hit testing and browser Tab remain native E2E.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.id === 'outer') return rect(layout.outer)
    if (this.id === 'shell') return rect({ ...layout.shell, top: layout.shell.top - outerScroll() })
    if (this.matches('.dbw-source-wrap')) return rect(anchor())
    if (this.matches('.dbw-source-trigger')) return rect({ ...anchor(), height: 32 })
    if (this.matches('.dbw-header')) return rect(box(layout.shell.left, layout.shell.top - outerScroll(), layout.shell.width, 108))
    if (this.matches('.dbw-source-picker')) return rect(menuBox(this))
    const menu = this.closest<HTMLElement>('.dbw-source-picker')
    if (menu) {
      const bounds = listBox(menu), menuBounds = menuBox(menu)
      if (this.matches('.dbw-source-list')) return rect(bounds)
      if (this.matches('.dbw-source-search, .dbw-source-search input')) return rect(box(bounds.left,
        menuBounds.top + border(menu, 'Top') + padding(menu, 'Top'), bounds.width, layout.searchHeight))
      if (this.matches('.dbw-menu-create')) return rect(box(bounds.left, bounds.top + bounds.height, bounds.width, layout.createHeight))
      const list = menu.querySelector<HTMLElement>('.dbw-source-list')!
      const option = this.closest<HTMLElement>('.dbw-source-option')
      const index = option ? [...list.querySelectorAll('.dbw-source-option')].indexOf(option) : 0
      return rect(box(bounds.left, bounds.top + index * layout.rowHeight - list.scrollTop, bounds.width, layout.rowHeight))
    }
    return rect(box(0, 0, 100, 32))
  }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    let visible = this.isConnected
    for (let element: HTMLElement | null = this; element && visible; element = element.parentElement) {
      const style = dom.window.getComputedStyle(element)
      if (element.hidden || element.hasAttribute('inert') || style.display === 'none' || style.visibility === 'hidden') visible = false
    }
    return (visible ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList
  }
  for (const name of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'] as const) {
    Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, get() {
      const element = this as HTMLElement, bounds = element.getBoundingClientRect(), horizontal = name.endsWith('Width')
      const size = horizontal ? bounds.width : bounds.height
      return name.startsWith('offset') ? size : size - (horizontal ? border(element, 'Left') + border(element, 'Right')
        : border(element, 'Top') + border(element, 'Bottom'))
    } })
  }
  for (const [name, edge] of [['clientLeft', 'Left'], ['clientTop', 'Top']] as const) {
    Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true,
      get() { return Math.round(border(this as HTMLElement, edge)) } })
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
    const element = this as HTMLElement, menu = element.closest<HTMLElement>('.dbw-source-picker')
    if (menu && element.matches('.dbw-source-list')) return naturalListHeight(menu)
    if (element.matches('.dbw-source-picker')) return menuBox(element).height - border(element, 'Top') - border(element, 'Bottom')
    return element.clientHeight
  } })
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (settings) { focusCalls.push(this); nativeFocus.call(this, settings) }
  const activeSubscriptions = new Set<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; capture: boolean }>()
  for (const target of [document, dom.window]) {
    const eventTarget = target as unknown as EventTarget
    const add = eventTarget.addEventListener.bind(eventTarget), remove = eventTarget.removeEventListener.bind(eventTarget)
    eventTarget.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, settings?: AddEventListenerOptions | boolean) => {
      if (listener && (type === 'resize' || type === 'scroll')) activeSubscriptions.add({ target: eventTarget, type, listener,
        capture: typeof settings === 'boolean' ? settings : Boolean(settings?.capture) })
      add(type, listener!, settings)
    }) as typeof eventTarget.addEventListener
    eventTarget.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, settings?: EventListenerOptions | boolean) => {
      const capture = typeof settings === 'boolean' ? settings : Boolean(settings?.capture)
      for (const registration of activeSubscriptions) if (registration.target === eventTarget && registration.type === type
        && registration.listener === listener && registration.capture === capture) activeSubscriptions.delete(registration)
      remove(type, listener!, settings)
    }) as typeof eventTarget.removeEventListener
  }
  const model: Context['model'] = { currentSource: structuredClone(sources[1]), sources: structuredClone(sources), sourceSessionKey: {} }
  const before = structuredClone(model), calls: Context['calls'] = { create: [], edit: [], record: 0, delete: 0, refresh: 0, source: [] }
  const { createRoot } = await import('react-dom/client'), root = createRoot(document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => { callback(); await new Promise<void>(resolve => setImmediate(resolve)) }) }
  const render = (shown = true) => change(() => root.render(createElement('div', { id: 'outer', className: 'content page-database',
    style: { overflowX: 'auto', overflowY: 'auto', borderTop: '.75px solid black', borderBottom: '1.25px solid black',
      borderLeft: '.75px solid black', borderRight: '1.25px solid black' } },
  createElement('section', { id: 'shell', className: 'dbw-shell', style: { overflowX: 'hidden', overflowY: 'hidden',
    borderTop: '1.25px solid black', borderBottom: '.75px solid black', borderLeft: '1.25px solid black', borderRight: '.75px solid black' } },
  shown ? createElement(DatabaseHeader, { ...model, text: getDatabaseWorkspaceText(locale), refreshing: false,
    onCreateDatabase: target => { calls.create.push(target) }, onEditDatabase: target => { calls.edit.push(target) },
    onCreateRecord: () => { calls.record++ }, onDeleteDatabase: () => { calls.delete++ },
    onRefresh: () => { calls.refresh++ }, onSourceChange: id => { calls.source.push(id) } }) : null))))
  const flush = async () => {
    for (let turn = 0; turn < 8; turn++) {
      await change(() => { const pending = [...frames]; for (const [id, callback] of pending) { frames.delete(id); callback(turn) } })
      if (!frames.size) return
    }
    assert.equal(frames.size, 0, 'Positioning must settle without a frame loop')
  }
  const clip = () => {
    let left = 0, top = 0, right = layout.width, bottom = layout.height
    for (const element of [find('#outer'), find('#shell')]) {
      const bounds = element.getBoundingClientRect()
      left = Math.max(left, bounds.left + border(element, 'Left')); top = Math.max(top, bounds.top + border(element, 'Top'))
      right = Math.min(right, bounds.right - border(element, 'Right')); bottom = Math.min(bottom, bounds.bottom - border(element, 'Bottom'))
    }
    return new dom.window.DOMRect(left, top, right - left, bottom - top)
  }
  try {
    await render()
    await run({ document, window: dom.window, layout, observers, frames, copies, focusCalls, model, calls, find, change, render, flush, clip,
      open: () => change(() => { const trigger = find<HTMLButtonElement>('.dbw-source-trigger'); trigger.focus(); trigger.click() }),
      close: () => change(() => document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))),
      fill: value => change(() => {
        const input = find<HTMLInputElement>('.dbw-source-search input')
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      resize: () => change(() => dom.window.dispatchEvent(new dom.window.Event('resize'))),
      observedResize: target => change(() => {
        const watching = observers.filter(observer => !observer.disconnected && observer.targets.has(target))
        assert.ok(watching.length > 0, 'Deliver RO only to observers really watching the changed DOM')
        watching.forEach(observer => observer.deliver(target))
      }), subscriptions: () => activeSubscriptions.size,
      assertData: () => { assert.deepEqual(model, before); assert.deepEqual(calls, { create: [], edit: [], record: 0, delete: 0, refresh: 0, source: [] }) }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
    dom.window.close()
  }
}

function assertReachable(context: Context) {
  const menu = context.find('.dbw-source-picker'), list = context.find('.dbw-source-list'), clip = context.clip()
  within(menu.getBoundingClientRect(), clip, 'The complete picker must fit viewport and both fractional-border clips')
  within(context.find('.dbw-source-search').getBoundingClientRect(), clip, 'Search chrome must remain visible')
  within(context.find('.dbw-menu-create').getBoundingClientRect(), clip, 'Create chrome must remain visible')
  within(list.getBoundingClientRect(), clip, 'The actual source list must fit its available capacity')
  assert.ok(list.clientHeight > 0, 'The picker must leave usable reading space')
  assert.equal(/auto|scroll/.test(context.window.getComputedStyle(list).overflowY || context.window.getComputedStyle(list).overflow), true)
  assert.equal(/auto|scroll/.test(context.window.getComputedStyle(menu).overflowY || context.window.getComputedStyle(menu).overflow), false,
    'Only the source list scrolls; Search and Create are outside it')
}
async function captureInput(context: Context) {
  await context.fill(rawQuery)
  const input = context.find<HTMLInputElement>('.dbw-source-search input')
  await context.change(() => input.setSelectionRange(2, 13))
  await context.flush(); context.focusCalls.length = 0
  return input
}
function assertInput(context: Context, input: HTMLInputElement) {
  assert.equal(context.find('.dbw-source-search input') === input, true)
  assert.equal(input.value, rawQuery); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 13)
  assert.equal(context.document.activeElement === input, true); assert.equal(context.focusCalls.length, 0)
}

test('source picker synchronously fits short 440px viewport and real overflow ancestors before any positioning frame', async t => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withLayout(async context => {
    await context.open()
    const menu = context.find('.dbw-source-picker')
    t.diagnostic(JSON.stringify({ locale, picker: menu.getBoundingClientRect().toJSON(), clip: context.clip().toJSON(),
      styles: menu.style.cssText, listHeight: context.find('.dbw-source-list').clientHeight, calls: context.calls }))
    assertReachable(context)
    assert.equal(context.document.activeElement === context.find('.dbw-source-search input'), true)
    context.assertData()
  }, { locale })
})

test('source picker fits a narrower nested horizontal clip rather than only the browser width', async () => {
  await withLayout(async context => {
    context.layout.outer = box(180.25, 20.5, 290.5, 402.25)
    context.layout.shell = box(170.5, 26.25, 320.75, 740)
    context.layout.anchor = box(240.25, 76.75, 180, 59)
    await context.open(); assertReachable(context)
    const menu = context.find('.dbw-source-picker')
    assert.ok(menu.getBoundingClientRect().width < 390, 'The available ancestor width must constrain a long-source picker')
    context.assertData()
  })
})

test('resizing tall to short and back keeps the exact source-search input, query, focus and selection', async () => {
  await withLayout(async context => {
    await context.open(); const input = await captureInput(context)
    for (const height of [440, 850, 440]) {
      context.layout.height = height; context.layout.outer.height = height - 37.75
      await context.resize(); await context.flush()
      assertReachable(context); assertInput(context, input); context.assertData()
    }
  }, { tall: true })
})

test('ancestor scroll repositions the picker while the source list scroll leaves its chrome and focus stationary', async () => {
  await withLayout(async context => {
    await context.open(); const input = await captureInput(context)
    const outer = context.find('#outer')
    await context.change(() => { outer.scrollTop = 48; outer.dispatchEvent(new context.window.Event('scroll')) })
    await context.flush(); assertReachable(context); assertInput(context, input)
    const menu = context.find('.dbw-source-picker'), list = context.find('.dbw-source-list')
    const before = { picker: menu.getBoundingClientRect().toJSON(), search: input.getBoundingClientRect().toJSON(),
      create: context.find('.dbw-menu-create').getBoundingClientRect().toJSON(), style: menu.style.cssText }
    await context.change(() => { list.scrollTop = 80; list.dispatchEvent(new context.window.Event('scroll')) })
    await context.flush()
    assert.deepEqual({ picker: menu.getBoundingClientRect().toJSON(), search: input.getBoundingClientRect().toJSON(),
      create: context.find('.dbw-menu-create').getBoundingClientRect().toJSON(), style: menu.style.cssText }, before)
    assert.equal(list.scrollTop, 80); assertInput(context, input); context.assertData()
  })
})

test('observed anchor and chrome size changes update available capacity without restoring or replacing input focus', async () => {
  await withLayout(async context => {
    await context.open(); const input = await captureInput(context)
    context.layout.anchor.top += 22
    await context.observedResize(context.find('.dbw-source-wrap')); await context.flush()
    assertReachable(context); assertInput(context, input)
    context.layout.searchHeight = 58; context.layout.createHeight = 60
    await context.observedResize(context.find('.dbw-source-picker')); await context.flush()
    assertReachable(context); assertInput(context, input); context.assertData()
  })
})

test('filtering to empty and one source recalculates natural height without stretching a small picker to its capacity', async () => {
  await withLayout(async context => {
    await context.open(); await context.flush()
    const menu = context.find('.dbw-source-picker'), large = menu.getBoundingClientRect().height
    await context.fill('No matching source'); await context.flush()
    assert.equal(context.document.querySelectorAll('.dbw-source-option').length, 0)
    assertReachable(context)
    const empty = menu.getBoundingClientRect().height
    assert.ok(empty < large - 40, 'An empty search must shrink to its real chrome and empty message')
    await context.fill('Shared source 4'); await context.flush()
    assert.equal(context.document.querySelectorAll('.dbw-source-option').length, 1)
    assertReachable(context)
    assert.ok(menu.getBoundingClientRect().height < large - 40)
    assert.equal(context.document.activeElement === context.find('.dbw-source-search input'), true)
    context.assertData()
  }, { tall: true })
})

test('same-session metadata leaves the open search untouched while source-session replacement cancels old positioning work', async () => {
  await withLayout(async context => {
    await context.open(); const input = await captureInput(context), oldMenu = context.find('.dbw-source-picker')
    context.model.currentSource = { ...context.model.currentSource, description: 'Updated source metadata' }
    await context.render(); await context.flush(); assertInput(context, input); assertReachable(context)
    const expected = structuredClone(context.model), oldStyle = oldMenu.style.cssText
    await context.resize(); const oldFrames = [...context.copies]
    context.model.sourceSessionKey = {}
    await context.render()
    assert.equal(context.document.querySelectorAll('.dbw-source-picker').length, 0)
    assert.equal(context.frames.size, 0)
    await context.change(() => oldFrames.forEach(callback => callback(0)))
    assert.equal(oldMenu.style.cssText, oldStyle)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.model.sources, expected.sources)
    assert.deepEqual(context.model.currentSource, expected.currentSource)
    assert.deepEqual(context.calls, { create: [], edit: [], record: 0, delete: 0, refresh: 0, source: [] })
    await context.open()
    assert.equal(context.find<HTMLInputElement>('.dbw-source-search input').value, rawQuery)
  })
})

test('closing and unmount discard subscriptions and copied late callbacks without mutating old or freshly opened picker DOM', async () => {
  await withLayout(async context => {
    const closedSubscriptions = context.subscriptions()
    await context.open(); await captureInput(context)
    const oldMenu = context.find('.dbw-source-picker'), oldStyle = oldMenu.style.cssText
    await context.resize()
    const oldFrames = [...context.copies], oldObservers = [...context.observers]
    await context.close()
    assert.equal(context.document.querySelectorAll('.dbw-source-picker').length, 0)
    assert.equal(context.frames.size, 0); assert.equal(context.subscriptions(), closedSubscriptions)
    assert.equal(oldObservers.every(observer => observer.disconnected && observer.targets.size === 0), true)
    const trigger = context.find('.dbw-source-trigger')
    context.focusCalls.length = 0
    await context.change(() => { oldFrames.forEach(callback => callback(0)); oldObservers.forEach(observer => observer.deliver(oldMenu)) })
    assert.equal(oldMenu.style.cssText, oldStyle); assert.equal(context.frames.size, 0)
    assert.equal(context.document.activeElement === trigger, true); assert.equal(context.focusCalls.length, 0)
    await context.open(); const freshMenu = context.find('.dbw-source-picker'), freshInput = await captureInput(context)
    const freshStyle = freshMenu.style.cssText
    await context.change(() => oldFrames.forEach(callback => callback(0)))
    assert.equal(freshMenu.style.cssText, freshStyle); assertInput(context, freshInput)
    await context.resize(); const pending = [...context.copies], watched = [...context.observers]
    await context.render(false)
    assert.equal(context.frames.size, 0); assert.equal(context.subscriptions(), closedSubscriptions)
    assert.equal(watched.every(observer => observer.disconnected && observer.targets.size === 0), true)
    const finalStyle = freshMenu.style.cssText
    context.focusCalls.length = 0
    await context.change(() => { pending.forEach(callback => callback(0)); watched.forEach(observer => observer.deliver(freshMenu)) })
    assert.equal(freshMenu.style.cssText, finalStyle); assert.equal(context.frames.size, 0); assert.equal(context.focusCalls.length, 0)
    context.assertData()
  })
})
