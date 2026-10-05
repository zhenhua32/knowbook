import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import { DocumentNavigationBar } from '../src/renderer/src/components/DocumentNavigationBar'

type Outline = NonNullable<ComponentProps<typeof DocumentNavigationBar>['outline']>
type ScrollWrite = { element: HTMLElement; value: number }
type Context = {
  document: Document; window: JSDOM['window']; items: Outline['items']; selected: number[]
  focusCalls: HTMLElement[]; scrollWrites: ScrollWrite[]; frames: FrameRequestCallback[]
  open: () => Promise<void>; active: (index: number | null) => Promise<void>
  fill: (value: string) => Promise<void>; key: (target: HTMLElement, options?: KeyboardEventInit) => Promise<KeyboardEvent>
  unmount: () => Promise<void>; assertUntouched: () => void
}

const trigger = (document: Document) => document.querySelector<HTMLButtonElement>('[aria-controls="document-outline-popover"]')!
const list = (document: Document) => document.querySelector<HTMLElement>('.document-outline-panel nav')!
const filter = (document: Document) => document.querySelector<HTMLInputElement>('.outline-filter')!
const current = (document: Document) => document.querySelector<HTMLElement>('.toc-item[aria-current="location"]')
const box = (x: number, y: number, width: number, height: number): DOMRect => ({ x, y, width, height,
  top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({ x, y, width, height }) })
const boxes = (document: Document) => [...document.querySelectorAll<HTMLElement>('.panel-label, .outline-fold-actions, .outline-filter')]
  .map(element => { const rect = element.getBoundingClientRect(); return [rect.top, rect.bottom, rect.left, rect.right] })

async function withOutline(isZh: boolean, run: (context: Context) => Promise<void>,
  options: { count?: number; active?: number | null; strict?: boolean; pixelRatio?: number } = {}) {
  const dom = new JSDOM('<main id="outer"><div id="mount"></div></main><textarea id="editor">Unchanged document draft</textarea>', { url: 'http://localhost' })
  const document = dom.window.document, prototype = dom.window.HTMLElement.prototype
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const focusCalls: HTMLElement[] = [], scrollWrites: ScrollWrite[] = [], frames: FrameRequestCallback[] = []
  const scrollPositions = new WeakMap<HTMLElement, number>()
  const nativeFocus = prototype.focus
  prototype.focus = function (focusOptions?: FocusOptions) { focusCalls.push(this); nativeFocus.call(this, focusOptions) }
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: options.pixelRatio ?? 1 })
  const rowGap = options.pixelRatio === undefined ? 30 : 30.25
  const rowHeight = options.pixelRatio === undefined ? 24 : 26.5

  // JSDOM supplies native focus and React events, but no layout. These sensors
  // describe a fractional-border list viewport and actual rendered row order.
  // They do not implement the reveal or emulate browser CSS layout/Tab defaults.
  prototype.getBoundingClientRect = function () {
    if (this.matches('.document-outline-panel nav')) return box(80, 220, 280, 121.5)
    if (this.matches('.toc-item')) {
      const nav = this.closest<HTMLElement>('nav')!
      const index = [...nav.querySelectorAll('.toc-item')].indexOf(this)
      return box(86, 220.75 + index * rowGap - nav.scrollTop, 264, rowHeight)
    }
    if (this.matches('.document-outline-panel')) return box(66, 100, 308, 253)
    if (this.matches('.panel-label')) return box(80, 110, 280, 18)
    if (this.matches('.outline-fold-actions')) return box(80, 134, 280, 28)
    if (this.matches('.outline-filter')) return box(80, 174, 280, 32)
    return box(20, 20, 100, 24)
  }
  prototype.getClientRects = function () { return (this.isConnected ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList }
  Object.defineProperties(prototype, {
    clientTop: { configurable: true, get() { return this.matches('.document-outline-panel nav') ? 0.75 : 0 } },
    clientHeight: { configurable: true, get() { return this.matches('.document-outline-panel nav') ? 120 : 400 } },
    scrollHeight: { configurable: true, get() { return this.matches('.document-outline-panel nav')
      ? Math.max(120, this.querySelectorAll('.toc-item').length * rowGap) : 2000 } },
    scrollTop: { configurable: true, get() { return scrollPositions.get(this) ?? 0 }, set(value: number) {
      const clamped = Math.min(Math.max(0, Number(value)), Math.max(0, this.scrollHeight - this.clientHeight))
      // Quantize only the tested list scroller; unrelated document offsets stay unchanged.
      const next = options.pixelRatio !== undefined && this.matches('.document-outline-panel nav')
        ? Math.floor(clamped * options.pixelRatio) / options.pixelRatio : clamped
      scrollPositions.set(this, next); scrollWrites.push({ element: this, value: next })
    } }
  })
  const raf = (callback: FrameRequestCallback) => { frames.push(callback); return frames.length }
  dom.window.requestAnimationFrame = raf
  dom.window.cancelAnimationFrame = () => {}
  for (const [key, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, requestAnimationFrame: raf,
    cancelAnimationFrame: dom.window.cancelAnimationFrame, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const items: Outline['items'] = Array.from({ length: options.count ?? 32 }, (_, index) => ({
    id: `heading-${index}`, index, level: index === 0 ? 1 : 2,
    title: `${isZh ? '章节' : 'Chapter'} ${index + 1}`, hasChildren: index === 0
  }))
  const originalItems = structuredClone(items), selected: number[] = [], otherActions: string[] = []
  let activeIndex = options.active === undefined ? 28 : options.active, mounted = true
  const render = () => {
    const element = createElement(DocumentNavigationBar, {
      isZh, activeIndex, progress: 82, reading: true,
      onToggleReading: () => { otherActions.push('mode') }, onOpenSearch: () => { otherActions.push('search') },
      outline: { title: isZh ? '文档大纲' : 'Document outline', items, isZh,
        emptyHeadingTitleLevel1: 'Untitled', emptyHeadingTitleLevel2: 'Untitled',
        filterPlaceholder: isZh ? '筛选标题' : 'Filter headings', noMatchText: isZh ? '没有匹配标题' : 'No matching headings',
        onSelect: index => { selected.push(index) }, onToggleFold: () => { otherActions.push('fold') },
        onCollapseAll: () => { otherActions.push('collapse') }, onExpandAll: () => { otherActions.push('expand') },
        onFocusSection: () => { otherActions.push('focus-section') } },
      search: { isOpen: false, query: '', placeholder: 'Find', noMatchText: 'No matches', items: [],
        onQueryChange: () => { otherActions.push('query') }, onClose: () => { otherActions.push('close-search') },
        onSelect: () => { otherActions.push('select-search') } }
    })
    root.render(options.strict ? createElement(StrictMode, null, element) : element)
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await act(async () => render())
    document.getElementById('outer')!.scrollTop = 83
    document.documentElement.scrollTop = 117
    scrollWrites.length = 0
    await run({ document, window: dom.window, items, selected, focusCalls, scrollWrites, frames, unmount,
      open: async () => { await act(async () => { trigger(document).focus(); focusCalls.length = 0; trigger(document).click() }) },
      active: async index => { activeIndex = index; await act(async () => render()) },
      fill: async value => { await act(async () => {
        const input = filter(document)
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      key: async (target, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
        await act(async () => target.dispatchEvent(event)); return event
      },
      assertUntouched: () => {
        assert.deepEqual(items, originalItems)
        assert.deepEqual(otherActions, [])
        assert.equal(document.getElementById('outer')!.scrollTop, 83)
        assert.equal(document.documentElement.scrollTop, 117)
        assert.equal(document.querySelector<HTMLTextAreaElement>('#editor')!.value, 'Unchanged document draft')
        assert.equal(document.querySelector('.document-reading-progress')?.textContent, '82%')
      }
    })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function assertCurrentVisible(document: Document) {
  const nav = list(document), target = current(document)
  assert.ok(target, 'The actual current heading remains in the rendered outline')
  const rect = target.getBoundingClientRect(), viewport = nav.getBoundingClientRect()
  assert.ok(rect.top >= viewport.top + nav.clientTop - 0.01, 'Current heading top is inside the list viewport')
  assert.ok(rect.bottom <= viewport.top + nav.clientTop + nav.clientHeight + 0.01, 'Current heading bottom is inside the list viewport')
}

test('opening the real long outline reveals its later current heading only in the list without moving focus', async () => {
  for (const isZh of [false, true]) await withOutline(isZh, async context => {
    const { document } = context
    await context.open()
    const nav = list(document), controls = boxes(document)
    assert.equal(current(document)?.textContent, isZh ? '章节 29' : 'Chapter 29')
    assertCurrentVisible(document)
    assert.ok(nav.scrollTop > 0)
    assert.deepEqual(context.scrollWrites.map(write => write.element === nav), [true])
    assert.equal(document.activeElement === trigger(document), true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(document.querySelector<HTMLElement>('.document-outline-panel')!.scrollTop, 0)
    nav.scrollTop = 0
    assert.deepEqual(boxes(document), controls, 'The simulated chrome is independent of the list scroll')
    context.assertUntouched()
    assert.deepEqual(context.selected, [])
    assert.equal(context.frames.length, 0)
  })
})

test('short outlines and missing current locations do not manufacture a scroll or focus action', async () => {
  for (const options of [{ count: 3, active: 1 }, { count: 32, active: 999 }, { count: 32, active: null }]) {
    await withOutline(false, async context => {
      await context.open()
      assert.equal(list(context.document).scrollTop, 0)
      assert.equal(context.scrollWrites.length, 0)
      assert.equal(context.focusCalls.length, 0)
      assert.equal(current(context.document) !== null, options.active === 1)
      if (options.active === 1) assertCurrentVisible(context.document)
      context.assertUntouched()
      assert.deepEqual(context.selected, [])
    }, options)
  }
})

test('filtering, manual reading and active-heading updates never replay the opening reveal until a new opening', async () => {
  await withOutline(false, async context => {
    const { document, window } = context
    await context.open()
    const nav = list(document), input = filter(document), controls = boxes(document)
    await act(async () => { nav.scrollTop = 45; nav.dispatchEvent(new window.Event('scroll')); input.focus(); input.setSelectionRange(0, 0) })
    context.scrollWrites.length = 0; context.focusCalls.length = 0
    await context.active(30)
    assert.equal(list(document) === nav, true)
    assert.equal(nav.scrollTop, 45)
    assert.equal(context.scrollWrites.length, 0)
    await context.fill('Chapter 2')
    assert.equal(current(document) === null, true, 'Filtering may remove the current chapter without revealing another row')
    assert.equal(nav.scrollTop, 45)
    await context.fill('')
    assert.equal(filter(document) === input, true)
    assert.equal(document.activeElement === input, true)
    assert.equal(nav.scrollTop, 45)
    assert.equal(context.scrollWrites.length, 0)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(boxes(document), controls)
    context.assertUntouched()
    const escape = await context.key(input)
    assert.equal(escape.defaultPrevented, true)
    assert.equal(document.querySelectorAll('.document-outline-popover').length, 0)
    await context.open()
    assert.equal(list(document) !== nav, true)
    assert.equal(current(document)?.textContent, 'Chapter 31')
    assertCurrentVisible(document)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.selected, [])
  })
})

test('the new initial list reveal leaves original filter IME, Escape and exact selection contracts intact', async () => {
  for (const isZh of [false, true]) await withOutline(isZh, async context => {
    const { document, window } = context
    await context.open()
    const input = filter(document)
    await act(async () => input.focus())
    await context.fill(isZh ? '章节 29' : 'Chapter 29')
    const writes = context.scrollWrites.length
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    const composingEscape = await context.key(input)
    assert.equal(composingEscape.defaultPrevented, false)
    assert.equal(trigger(document).getAttribute('aria-expanded'), 'true')
    assert.equal(document.activeElement === input, true)
    assert.equal(context.scrollWrites.length, writes)
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal((await context.key(input, options)).defaultPrevented, false)
      assert.equal(trigger(document).getAttribute('aria-expanded'), 'true')
    }
    const consumed = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    consumed.preventDefault()
    await act(async () => input.dispatchEvent(consumed))
    assert.equal(trigger(document).getAttribute('aria-expanded'), 'true')
    assert.equal(input.value, isZh ? '章节 29' : 'Chapter 29')
    context.focusCalls.length = 0
    await act(async () => current(document)!.click())
    assert.deepEqual(context.selected, [28])
    assert.equal(document.querySelectorAll('.document-outline-popover').length, 0)
    assert.equal(document.activeElement === trigger(document), true)
    assert.deepEqual(context.focusCalls.map(element => element === trigger(document)), [true])
    context.assertUntouched()
  })
})

test('StrictMode opening reveals once and unmount leaves no deferred scroll or stale focus restoration', async () => {
  await withOutline(false, async context => {
    const { document, window } = context
    await context.open()
    const nav = list(document), oldTrigger = trigger(document)
    assertCurrentVisible(document)
    assert.deepEqual(context.scrollWrites.map(write => write.element === nav), [true])
    assert.equal(context.frames.length, 0)
    await act(async () => filter(document).focus())
    const writes = context.scrollWrites.length, focusCount = context.focusCalls.length
    await context.unmount()
    await act(async () => { window.dispatchEvent(new window.Event('resize')); window.dispatchEvent(new window.Event('focus')) })
    assert.equal(nav.isConnected, false)
    assert.equal(oldTrigger.isConnected, false)
    assert.equal(document.activeElement === document.body, true)
    assert.equal(context.scrollWrites.length, writes)
    assert.equal(context.focusCalls.length, focusCount)
    assert.equal(context.frames.length, 0)
    assert.deepEqual(context.selected, [])
  }, { strict: true })
})

test('a DPR 1.5 quantized list scroll leaves the whole current heading visible with breathing room', async t => {
  await withOutline(false, async context => {
    const { document, window } = context
    await context.open()
    const nav = list(document), target = current(document)!
    const bounds = target.getBoundingClientRect(), viewport = nav.getBoundingClientRect()
    const top = viewport.top + nav.clientTop, bottom = top + nav.clientHeight
    t.diagnostic(JSON.stringify({ pixelRatio: window.devicePixelRatio, scrollTop: nav.scrollTop,
      currentTop: bounds.top, currentBottom: bounds.bottom, viewportTop: top, viewportBottom: bottom }))
    assertCurrentVisible(document)
    assert.ok(bounds.top - top >= 1, 'Physical pixel quantization must not clip the current heading top')
    assert.ok(bottom - bounds.bottom >= 1, 'A small bottom margin survives rounding down to the physical pixel grid')
    assert.equal(Number.isInteger(nav.scrollTop * 1.5), true)
    assert.deepEqual(context.scrollWrites.map(write => write.element === nav), [true])
    assert.equal(document.querySelector<HTMLElement>('.document-outline-panel')!.scrollTop, 0)
    assert.equal(document.activeElement === trigger(document), true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.frames.length, 0)
    assert.deepEqual(context.selected, [])
    context.assertUntouched()
  }, { pixelRatio: 1.5 })
})
