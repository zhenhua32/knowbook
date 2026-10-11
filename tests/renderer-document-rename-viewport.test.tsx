import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { useDocumentViewport } from '../src/renderer/src/hooks/useDocumentViewport'

type Viewport = ReturnType<typeof useDocumentViewport>
type Model = { documentId: string; reading: boolean; prefix: number; owner: number }
type ViewportFixture = {
  viewport: () => Viewport
  scroll: () => HTMLElement
  row: (index: number) => HTMLElement
  setScroll: (top: number) => Promise<void>
  render: (next: Partial<Model>, restore?: () => void) => Promise<void>
  resize: () => Promise<void>
  flushFrames: () => Promise<void>
  advance: (milliseconds: number) => void
  activity: (type: 'wheel' | 'keydown' | 'pointerdown' | 'touchstart', outside?: boolean) => Promise<void>
  unmount: () => Promise<void>
  remount: () => Promise<void>
}

async function withViewport(run: (fixture: ViewportFixture) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://knowbook.test/' })
  const frames = new Map<number, FrameRequestCallback>()
  const observers: LayoutObserver[] = []
  let frameId = 0, now = 10_000
  let model: Model = { documentId: 'a', reading: true, prefix: 0, owner: 0 }
  let current!: Viewport, mounted = true, instance = 0
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const originalNow = Date.now
  Date.now = () => now
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  class LayoutObserver {
    targets = new Set<Element>()
    disconnected = false
    constructor(private callback: ResizeObserverCallback) { observers.push(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.disconnected = true; this.targets.clear() }
    notify() {
      if (!this.disconnected && [...this.targets].some(target => target.isConnected)) {
        this.callback([], this as unknown as ResizeObserver)
      }
    }
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, HTMLDetailsElement: dom.window.HTMLDetailsElement,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    ResizeObserver: LayoutObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: requestFrame })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: cancelFrame })
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: LayoutObserver })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const scroll = () => dom.window.document.querySelector<HTMLElement>('[data-scroll]')!
  const row = (index: number) => dom.window.document.querySelector<HTMLElement>(`[data-block-index="${index}"]`)!
  const rect = (top: number, height: number) => new dom.window.DOMRect(20, top, 600, height)
  const attachScroll = (element: HTMLElement | null) => {
    current.scrollRef.current = element
    if (!element) return
    Object.defineProperties(element, {
      clientWidth: { configurable: true, get: () => 600 },
      clientHeight: { configurable: true, get: () => 600 },
      scrollHeight: { configurable: true, get: () => 2400 + model.prefix }
    })
    element.getBoundingClientRect = () => rect(100, 600)
  }
  const attachHeader = (element: HTMLDivElement | null) => {
    current.headerRef.current = element
    if (element) element.getBoundingClientRect = () => rect(100, 96)
  }
  const attachContent = (element: HTMLDivElement | null) => {
    current.contentRef.current = element
    if (!element) return
    Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => 600 })
    element.getBoundingClientRect = () => rect(300 + model.prefix - scroll().scrollTop, 2200)
  }
  const attachRow = (index: number, element: HTMLElement | null) => {
    if (element) element.getBoundingClientRect = () => rect(300 + index * 200 + model.prefix - scroll().scrollTop, 180)
  }
  function Harness() {
    current = useDocumentViewport({ documentId: model.documentId, reading: model.reading,
      navigation: null, onRevealBlock: () => {} })
    return createElement('article', { key: model.owner, 'data-scroll': true, ref: attachScroll },
      createElement('div', { ref: attachHeader }, 'Sticky document tools'),
      createElement('div', { ref: attachContent }, Array.from({ length: 8 }, (_, index) =>
        createElement('section', { key: index, 'data-block-id': `block-${index}`, 'data-block-index': index,
          'data-heading-level': index % 2 === 0 ? 2 : undefined,
          ref: (element: HTMLElement | null) => attachRow(index, element) }, `Paragraph ${index}`))))
  }
  const publish = () => root.render(mounted ? createElement(Harness, { key: instance }) : null)
  const flushFrames = async () => {
    for (let batch = 0; frames.size > 0; batch++) {
      assert.ok(batch < 8, 'layout settling must not schedule an endless animation frame loop')
      await act(async () => {
        const pending = [...frames.values()]
        frames.clear()
        pending.forEach(callback => callback(now))
      })
    }
  }
  const resize = async () => { await act(async () => observers.forEach(observer => observer.notify())); await flushFrames() }
  const setScroll = async (top: number) => {
    await act(async () => { scroll().scrollTop = top; scroll().dispatchEvent(new dom.window.Event('scroll')) })
    await flushFrames()
  }
  const render = async (next: Partial<Model>, restore?: () => void) => {
    await act(async () => { model = { ...model, ...next }; publish(); restore?.() })
    await resize()
  }
  const activity = async (type: 'wheel' | 'keydown' | 'pointerdown' | 'touchstart', outside = false) => {
    const target = outside ? dom.window.document.body : scroll()
    const event = type === 'wheel' ? new dom.window.WheelEvent(type, { bubbles: true, deltaY: 120 })
      : type === 'keydown' ? new dom.window.KeyboardEvent(type, { bubbles: true, key: 'ArrowDown' })
        : type === 'pointerdown' ? new dom.window.MouseEvent(type, { bubbles: true })
          : new dom.window.Event(type, { bubbles: true })
    await act(async () => target.dispatchEvent(event))
  }
  const unmount = async () => { mounted = false; await act(async () => publish()); await flushFrames() }
  const remount = async () => { mounted = true; instance++; await act(async () => publish()); await flushFrames() }
  try {
    await act(async () => publish())
    await flushFrames()
    await setScroll(500)
    await run({ viewport: () => current, scroll, row, setScroll, render, resize, flushFrames,
      advance: milliseconds => { now += milliseconds }, activity, unmount, remount })
  } finally {
    await act(async () => root.unmount())
    assert.ok(observers.every(observer => observer.disconnected), 'unmount disconnects every layout observer')
    Date.now = originalNow
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('successful rename layout restoration preserves the paragraph offset after content above it changes', async () => {
  await withViewport(async ({ viewport, scroll, row, render }) => {
    const visibleParagraphTop = row(2).getBoundingClientRect().top
    const originalScroll = scroll().scrollTop
    const restore = viewport().captureLayoutPosition()
    assert.equal(scroll().scrollTop, originalScroll, 'capturing the form opener does not scroll the document')
    await render({ prefix: 120 }, restore)
    assert.equal(row(2).getBoundingClientRect().top, visibleParagraphTop,
      'the same paragraph stays at the same visible offset rather than retaining a stale numeric scrollTop')
    assert.equal(scroll().scrollTop, originalScroll + 120)
    assert.ok(viewport().progress > 0, 'the normal viewport update still publishes progress')
  })
})

test('a successful layout restore is consumed once and cannot later revive its older reading position', async () => {
  await withViewport(async ({ viewport, scroll, render, setScroll, advance }) => {
    const restore = viewport().captureLayoutPosition()
    await render({ prefix: 120 }, restore)
    assert.equal(scroll().scrollTop, 620)
    advance(2000)
    await setScroll(400)
    await render({ prefix: 200 }, restore)
    assert.equal(scroll().scrollTop, 400, 'reusing a completed form callback cannot scroll the reader back')
  })
})

test('opening then cancelling rename does not seed a later reading-mode restoration', async () => {
  await withViewport(async ({ viewport, scroll, setScroll, render }) => {
    viewport().captureLayoutPosition() // The rename form is cancelled; its callback is never called.
    await setScroll(700)
    await render({ reading: false, prefix: 120 })
    assert.equal(scroll().scrollTop, 700, 'a discarded rename capture must not populate the mode-switch bookmark')
  })
})

test('the ordinary explicit mode-switch bookmark still keeps the same paragraph offset', async () => {
  await withViewport(async ({ viewport, scroll, row, render }) => {
    const visibleParagraphTop = row(2).getBoundingClientRect().top
    viewport().capturePosition()
    await render({ reading: false, prefix: 120 })
    assert.equal(scroll().scrollTop, 620)
    assert.equal(row(2).getBoundingClientRect().top, visibleParagraphTop)
  })
})

test('new reader wheel, keyboard, pointer and touch activity supersedes a pending rename restoration', async () => {
  for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const) {
    await withViewport(async ({ viewport, scroll, activity, setScroll, render }) => {
      const restore = viewport().captureLayoutPosition()
      await activity(type)
      await setScroll(700)
      await render({ prefix: 120 }, restore)
      assert.equal(scroll().scrollTop, 700, `${type} gives the reader ownership of the newer position`)
    })
  }
})

test('interacting with the rename form outside the document does not invalidate its layout bookmark', async () => {
  await withViewport(async ({ viewport, scroll, row, activity, render }) => {
    const visibleParagraphTop = row(2).getBoundingClientRect().top
    const restore = viewport().captureLayoutPosition()
    await activity('pointerdown', true)
    await activity('keydown', true)
    await render({ prefix: 120 }, restore)
    assert.equal(scroll().scrollTop, 620)
    assert.equal(row(2).getBoundingClientRect().top, visibleParagraphTop)
  })
})

test('opening a newer rename form invalidates an older callback while preserving the newer bookmark', async () => {
  await withViewport(async ({ viewport, scroll, row, setScroll, render, flushFrames }) => {
    const oldRestore = viewport().captureLayoutPosition()
    await setScroll(700)
    const paragraphTop = row(3).getBoundingClientRect().top
    const newRestore = viewport().captureLayoutPosition()
    await render({ prefix: 120 }, oldRestore)
    assert.equal(scroll().scrollTop, 700, 'a superseded form callback cannot use its older paragraph')
    await act(async () => newRestore())
    await flushFrames()
    assert.equal(scroll().scrollTop, 820)
    assert.equal(row(3).getBoundingClientRect().top, paragraphTop)
  })
})

test('a reading-mode change invalidates a pending rename bookmark even when the document ID stays the same', async () => {
  await withViewport(async ({ viewport, scroll, render }) => {
    const restore = viewport().captureLayoutPosition()
    await render({ reading: false, prefix: 120 }, restore)
    assert.equal(scroll().scrollTop, 500, 'the previous reading presentation cannot restore into the new editor presentation')
  })
})

test('a document ABA visit cannot consume a rename bookmark from its previous viewport session', async () => {
  await withViewport(async ({ viewport, scroll, render, advance, setScroll }) => {
    const restore = viewport().captureLayoutPosition()
    await render({ documentId: 'b' })
    await render({ documentId: 'a' })
    advance(2000)
    await setScroll(700)
    await render({ prefix: 120 }, restore)
    assert.equal(scroll().scrollTop, 700, 'returning to the same ID is still a different viewport visit')
  })
})

test('an unmounted rename opener cannot restore a subsequently mounted document viewport', async () => {
  await withViewport(async ({ viewport, scroll, unmount, remount, advance, setScroll, render }) => {
    const restore = viewport().captureLayoutPosition()
    await unmount()
    await act(async () => restore())
    await remount()
    advance(2000)
    await setScroll(700)
    await render({ prefix: 120 }, restore)
    assert.equal(scroll().scrollTop, 700)
  })
})

test('replacing the scroll-region element makes a captured rename owner stale', async () => {
  await withViewport(async ({ viewport, scroll, render, setScroll, flushFrames }) => {
    const originalOwner = scroll()
    const restore = viewport().captureLayoutPosition()
    await render({ owner: 1, prefix: 120 })
    assert.notEqual(scroll(), originalOwner)
    await setScroll(700)
    await act(async () => restore())
    await flushFrames()
    assert.equal(scroll().scrollTop, 700, 'a bookmark is owned by the actual scroller captured when the form opened')
  })
})
