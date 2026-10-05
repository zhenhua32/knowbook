import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { DocumentTreeNode } from '../src/shared/contracts'
import { DocumentTree } from '../src/renderer/src/components/DocumentTree'
import { setActiveUiLanguage } from '../src/renderer/src/i18n'

type TreeProps = ComponentProps<typeof DocumentTree>
const titleA = 'Shared prefix — Alpha full title <literal markup> — final suffix A'
const titleB = 'Shared prefix — Beta full title — final suffix B'
const node = (id: string, title: string): DocumentTreeNode => ({
  id, title, path: title, updatedAt: '2026-10-01T00:00:00Z', children: []
})
const initialNodes = [node('alpha', titleA), node('beta', titleB), node('short', 'Short')]

async function withTree(run: (context: {
  dom: JSDOM; document: Document; outside: HTMLInputElement; body: HTMLBodyElement
  row: (id: string) => HTMLLIElement; popup: () => HTMLElement | null; reader: () => HTMLDivElement
  render: (patch?: Partial<TreeProps>) => Promise<void>; change: (action: () => void) => Promise<void>
  key: (target: HTMLElement, key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
  enter: (target: HTMLElement, related?: Element | null) => Promise<void>
  leave: (target: HTMLElement, related?: Element | null) => Promise<void>
  pointerDown: (target: HTMLElement) => Promise<void>; advance: (milliseconds: number) => Promise<void>
  timers: () => Array<() => void>; timerCount: () => number; unmount: () => Promise<void>
  observers: Array<{ targets: Set<Element>; disconnected: boolean; notify: () => void }>
  overflow: (value: boolean) => void; focusCalls: HTMLElement[]; opened: string[]; menus: string[]; drags: string[]
}) => Promise<void>, options: { strict?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div><input id="outside" value="Outside draft"></body></html>', { pretendToBeVisual: true })
  const document = dom.window.document, originals = new Map<string, PropertyDescriptor | undefined>()
  let overflow = true, now = 0, nextTimer = 100_000, nextFrame = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const frames = new Map<number, FrameRequestCallback>()
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout
  // Only the reader's open/bridge delays are controlled; React/module timers remain native.
  const setTimer = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 350 && delay !== 200) return nativeSetTimeout(callback, delay, ...args)
    const id = ++nextTimer; timers.set(id, { at: now + delay, run: () => callback(...args) })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  const clearTimer = ((id: Parameters<typeof clearTimeout>[0]) => {
    if (typeof id === 'number' && timers.delete(id)) return
    nativeClearTimeout(id)
  }) as typeof clearTimeout
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame }
  const cancelFrame = (id: number) => { frames.delete(id) }
  const observers: Array<{ targets: Set<Element>; disconnected: boolean; notify: () => void }> = []
  class Observer {
    state: typeof observers[number]
    constructor(callback: ResizeObserverCallback) {
      this.state = { targets: new Set(), disconnected: false, notify: () => callback([], this as unknown as ResizeObserver) }
      observers.push(this.state)
    }
    observe(target: Element) { this.state.targets.add(target) }
    unobserve(target: Element) { this.state.targets.delete(target) }
    disconnect() { this.state.disconnected = true; this.state.targets.clear() }
  }
  for (const [key, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    ResizeObserver: Observer, requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    setTimeout: setTimer, clearTimeout: clearTimer, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperties(dom.window, { ResizeObserver: { configurable: true, value: Observer },
    requestAnimationFrame: { configurable: true, value: requestFrame }, cancelAnimationFrame: { configurable: true, value: cancelFrame } })
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  document.body.tabIndex = -1
  const rect = (element: HTMLElement): DOMRect => {
    if (element.matches('.tree-virtual-scroll')) return new dom.window.DOMRect(20, 40, 220, 180)
    if (element.matches('[role="treeitem"]')) {
      const index = Number(element.style.transform.match(/translateY\((\d+)px\)/)?.[1] ?? 0)
      return new dom.window.DOMRect(20, 40 + index - (document.querySelector('.tree-virtual-scroll')?.scrollTop ?? 0), 220, 36)
    }
    if (element.matches('.tree-document-title')) { const owner = rect(element.closest<HTMLLIElement>('[role="treeitem"]')!); return new dom.window.DOMRect(60, owner.top + 8, 110, 20) }
    if (element.matches('[role="tooltip"]')) return new dom.window.DOMRect(Number.parseFloat(element.style.left) || 248, Number.parseFloat(element.style.top) || 40, 280, 120)
    if (element.matches('.tree-title-preview-text')) { const parent = rect(element.parentElement!); return new dom.window.DOMRect(parent.left + 12, parent.top + 12, 256, 80) }
    return new dom.window.DOMRect(600, 300, 160, 28)
  }
  const prototype = dom.window.HTMLElement.prototype
  prototype.getBoundingClientRect = function () { return rect(this) }
  prototype.getClientRects = function () {
    const values = this.isConnected && !this.closest('[hidden], [inert]') ? [rect(this)] : []
    return Object.assign(values, { item: (index: number) => values[index] ?? null }) as unknown as DOMRectList
  }
  Object.defineProperties(prototype, {
    clientWidth: { configurable: true, get() { return rect(this as HTMLElement).width } },
    clientHeight: { configurable: true, get() { return rect(this as HTMLElement).height } },
    offsetWidth: { configurable: true, get() { return rect(this as HTMLElement).width } },
    offsetHeight: { configurable: true, get() { return rect(this as HTMLElement).height } },
    scrollWidth: { configurable: true, get() { const element = this as HTMLElement; return element.matches('.tree-document-title') ? (element.textContent?.length ?? 0) * 7 : rect(element).width } },
    scrollHeight: { configurable: true, get() { const element = this as HTMLElement; return element.matches('.tree-title-preview-text') && overflow ? 600 : rect(element).height } }
  })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (x: number, y: number) => {
    const candidates = [...document.querySelectorAll<HTMLElement>('[role="tooltip"], [role="treeitem"]')].reverse()
    return candidates.find(element => { const box = rect(element); return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom }) ?? document.body
  } })
  const focusCalls: HTMLElement[] = [], nativeFocus = prototype.focus
  prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const opened: string[] = [], menus: string[] = [], drags: string[] = []
  let props: TreeProps = { nodes: initialNodes, selectedDocumentId: 'alpha', onSelect: id => opened.push(id),
    onOpenContextMenu: item => menus.push(item.id), draggingDocumentId: null, dragOverDocumentId: null,
    onDragStart: id => drags.push(id), onDragEnd: () => undefined, onDragOverNode: () => undefined, onDropOnNode: async () => undefined }
  const root = createRoot(document.getElementById('mount')!), change = async (action: () => void) => { await act(async () => action()) }
  let mounted = true
  const render = async (patch: Partial<TreeProps> = {}) => {
    props = { ...props, ...patch }
    await change(() => {
      const element = <DocumentTree {...props} />
      root.render(options.strict ? <React.StrictMode>{element}</React.StrictMode> : element)
    })
  }
  const row = (id: string) => [...document.querySelectorAll<HTMLLIElement>('[role="treeitem"]')].find(element => element.getAttribute('aria-label') === props.nodes.find(item => item.id === id)?.title)!
  const popup = () => document.querySelector<HTMLElement>('[role="tooltip"]')
  const pointer = async (target: HTMLElement, type: string, related: Element | null = null) => change(() => {
    // JSDOM provides no native pointer default action; pointer transitions and native focus are tested separately.
    target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: related }))
  })
  const settleModule = async () => {
    // Load the real optional controller, then let the shim publish its latest intent.
    // No import response or hook is mocked, and no presentation timer is advanced here.
    await import('../src/renderer/src/hooks/TreeTitlePreviewController')
    await act(async () => { await Promise.resolve() })
  }
  const unmount = async () => { if (mounted) { mounted = false; await change(() => root.unmount()) } }
  try {
    setActiveUiLanguage('en-US'); await render()
    await run({ dom, document, outside: document.getElementById('outside') as HTMLInputElement, body: document.body as HTMLBodyElement,
      row, popup, reader: () => document.querySelector<HTMLDivElement>('.tree-title-preview-text')!, render, change,
      enter: async (target, related = null) => { await pointer(target, 'pointerover', related); await settleModule() },
      leave: (target, related = null) => pointer(target, 'pointerout', related),
      pointerDown: target => pointer(target, 'pointerdown'),
      key: async (target, key, options = {}) => { const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options }); await change(() => target.dispatchEvent(event)); return event as unknown as KeyboardEvent },
      advance: async milliseconds => { await settleModule(); await change(() => {
        now += milliseconds
        for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now && timers.delete(id)) timer.run()
        const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now))
      }) },
      timers: () => [...timers.values()].map(timer => timer.run), timerCount: () => timers.size, observers,
      overflow: value => { overflow = value }, focusCalls, opened, menus, drags, unmount })
  } finally {
    await unmount(); setActiveUiLanguage('en-US')
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
}

test('only truncated titles expose literal full text without changing tree semantics or focus', async () => {
  await withTree(async context => {
    await context.change(() => context.row('short').focus()); await context.advance(350)
    assert.equal(context.popup() === null, true)
    // A reveal scroll can put a short row under an unmoved pointer before lazy loading finishes.
    await context.change(() => {
      context.row('alpha').focus()
      context.row('short').dispatchEvent(new context.dom.window.MouseEvent('pointerover', { bubbles: true }))
    })
    const focusCount = context.focusCalls.length
    await context.advance(349); assert.equal(context.popup() === null, true)
    await context.advance(1)
    assert.ok(context.popup(), 'A truncated tree title must expose its complete reading text')
    assert.equal(context.reader().textContent, titleA); assert.equal(context.reader().children.length, 0)
    assert.equal(context.popup()!.parentElement, context.body)
    assert.equal(context.row('alpha').getAttribute('aria-describedby'), context.popup()!.id)
    assert.equal(context.row('alpha').getAttribute('aria-label'), titleA)
    assert.equal(context.row('alpha').getAttribute('aria-selected'), 'true')
    assert.equal(context.document.querySelectorAll('[role="treeitem"][tabindex="0"]').length, 1)
    assert.ok([...context.document.querySelectorAll<HTMLButtonElement>('[role="tree"] button')].every(button => button.tabIndex === -1))
    assert.equal(context.document.activeElement === context.row('alpha'), true); assert.equal(context.focusCalls.length, focusCount)
    assert.equal(context.opened.length, 0); assert.equal(context.menus.length, 0); assert.equal(context.drags.length, 0)
    const panel = context.popup()!
    await context.enter(context.row('short'))
    assert.equal(context.popup() === panel, true, 'A short hover must preserve the valid focused long-title reader')
    assert.equal(context.reader().textContent, titleA)
    assert.equal(context.document.activeElement === context.row('alpha'), true)
    assert.equal(context.focusCalls.length, focusCount)
    await context.change(() => context.row('short').focus())
    assert.equal(context.popup() === null, true, 'Actually focusing the short row must still close the old reader')
    await context.advance(1_000); assert.equal(context.popup() === null, true)
    assert.equal(context.document.activeElement === context.row('short'), true)
    assert.equal(context.opened.length, 0); assert.equal(context.menus.length, 0); assert.equal(context.drags.length, 0)
  })
})

test('owned Escape dismisses once, IME keys pass through, and another focused control keeps its Escape', async () => {
  await withTree(async context => {
    await context.change(() => context.row('alpha').focus()); await context.advance(350)
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal((await context.key(context.row('alpha'), 'Escape', options)).defaultPrevented, false)
      assert.ok(context.popup())
    }
    // Returning from the panel starts a new delay while the tree still owns focus.
    const panel = context.popup()!
    await context.leave(context.row('alpha'), panel); await context.enter(panel, context.row('alpha'))
    await context.leave(panel, context.row('alpha')); await context.enter(context.row('alpha'), panel)
    assert.equal(context.popup() === null, true)
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal((await context.key(context.row('alpha'), 'Escape', options)).defaultPrevented, false)
      assert.equal(context.timerCount(), 1, 'Candidate Escape must leave the pending reading intent intact')
    }
    const before = context.focusCalls.length
    assert.equal((await context.key(context.row('alpha'), 'Escape')).defaultPrevented, true)
    await context.advance(1_000); assert.equal(context.popup() === null, true)
    assert.equal(context.document.activeElement === context.row('alpha'), true); assert.equal(context.focusCalls.length, before)
    await context.render({ nodes: [...initialNodes] }); await context.advance(350); assert.equal(context.popup() === null, true)
    await context.change(() => context.outside.focus()); await context.change(() => context.row('alpha').focus())
    await context.advance(349); assert.equal(context.popup() === null, true)
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal((await context.key(context.row('alpha'), 'Escape', options)).defaultPrevented, false)
      assert.equal(context.timerCount(), 1)
    }
    assert.equal((await context.key(context.row('alpha'), 'Escape')).defaultPrevented, true)
    assert.equal(context.timerCount(), 0)
    await context.advance(1_000); assert.equal(context.popup() === null, true)
    await context.change(() => context.outside.focus()); await context.change(() => context.row('alpha').focus()); await context.advance(350)
    assert.ok(context.popup(), 'A genuinely new focus session may read the same title again')
    await context.change(() => { context.outside.focus(); context.outside.setSelectionRange(2, 6) })
    await context.enter(context.row('alpha')); await context.advance(350); assert.ok(context.popup())
    assert.equal((await context.key(context.outside, 'Escape')).defaultPrevented, false)
    assert.equal(context.popup() === null, true); assert.equal(context.document.activeElement === context.outside, true)
    assert.equal(context.outside.selectionStart, 2); assert.equal(context.outside.selectionEnd, 6); assert.equal(context.opened.length, 0)
  })
})

test('StrictMode effect replay preserves the first lazy hover and focus intent without duplicate timers or focus', async () => {
  for (const method of ['hover', 'focus'] as const) {
    await withTree(async context => {
      await context.change(() => context.outside.focus())
      if (method === 'hover') await context.enter(context.row('alpha'))
      else await context.change(() => context.row('alpha').focus())
      const before = context.focusCalls.length
      await context.advance(349)
      assert.equal(context.popup() === null, true)
      assert.equal(context.timerCount(), 1, `${method}: effect replay must retain one pending opening`)
      await context.advance(1)
      assert.ok(context.popup(), `${method}: the first optional controller mount must open after StrictMode replay`)
      assert.equal(context.document.querySelectorAll('[role="tooltip"]').length, 1)
      assert.equal(context.reader().textContent, titleA)
      assert.equal(context.row('alpha').getAttribute('aria-describedby'), context.popup()!.id)
      assert.equal(context.document.activeElement === (method === 'hover' ? context.outside : context.row('alpha')), true)
      assert.equal(context.focusCalls.length, before); assert.equal(context.timerCount(), 0)
      assert.equal(context.opened.length, 0); assert.equal(context.menus.length, 0); assert.equal(context.drags.length, 0)
    }, { strict: true })
  }
})

test('the pointer bridge remains readable inside the panel, including native blur while selecting text', async () => {
  await withTree(async context => {
    await context.change(() => context.row('alpha').focus()); await context.advance(350)
    assert.ok(context.popup())
    const panel = context.popup()!
    await context.leave(context.row('alpha'), panel); await context.enter(panel, context.row('alpha'))
    await context.advance(1_000); assert.equal(context.popup() === panel, true)
    await context.pointerDown(context.reader())
    await context.change(() => context.body.focus())
    assert.equal(context.document.activeElement === context.body, true)
    assert.equal(context.popup() === panel, true, 'Selecting hovered reader text must not unmount it when the tree row blurs')
    await context.leave(panel); await context.advance(199); assert.equal(context.popup() === panel, true)
    await context.advance(1); assert.equal(context.popup() === null, true)
    await context.enter(context.row('alpha')); await context.advance(350); assert.ok(context.popup())
    await context.pointerDown(context.outside); await context.change(() => context.outside.focus())
    assert.equal(context.popup() === null, true); assert.equal(context.opened.length, 0)
  })
})

test('Page keys scroll only the owned overflowing reader while tree arrows and activation retain their contract', async () => {
  await withTree(async context => {
    await context.change(() => context.row('alpha').focus()); await context.advance(350)
    assert.equal((await context.key(context.row('alpha'), 'PageDown')).defaultPrevented, true)
    assert.ok(context.reader().scrollTop > 0)
    assert.equal(context.document.querySelector('.tree-virtual-scroll')!.scrollTop, 0)
    assert.equal(context.document.activeElement === context.row('alpha'), true)
    assert.equal((await context.key(context.row('alpha'), 'PageUp')).defaultPrevented, true); assert.equal(context.reader().scrollTop, 0)
    await context.change(() => { context.overflow(false); context.observers.filter(item => !item.disconnected).forEach(item => item.notify()) })
    assert.equal((await context.key(context.row('alpha'), 'PageDown')).defaultPrevented, false)
    assert.equal(context.reader().scrollTop, 0)
    await context.key(context.row('alpha'), 'ArrowDown')
    assert.equal(context.document.activeElement === context.row('beta'), true); assert.equal(context.popup() === null, true)
    assert.equal(context.row('alpha').getAttribute('aria-selected'), 'true'); assert.equal(context.opened.length, 0)
    await context.advance(350); assert.equal(context.reader().textContent, titleB)
    await context.key(context.row('beta'), 'Enter'); await context.key(context.row('beta'), ' ')
    assert.deepEqual(context.opened, ['beta', 'beta']); assert.equal(context.menus.length, 0)
  })
})

test('scroll, resize, background, new focus and owner changes permanently dismiss the old reading session', async () => {
  for (const reason of ['leave', 'resize', 'focus', 'pointer'] as const) {
    await withTree(async context => {
      // Both events occur in one task, before a real dynamic import can publish a controller.
      await context.change(() => {
        context.row('alpha').dispatchEvent(new context.dom.window.MouseEvent('pointerover', { bubbles: true }))
        if (reason === 'leave') context.row('alpha').dispatchEvent(new context.dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: context.outside }))
        else if (reason === 'resize') context.dom.window.dispatchEvent(new context.dom.window.Event('resize'))
        else if (reason === 'focus') context.outside.focus()
        else context.outside.dispatchEvent(new context.dom.window.MouseEvent('pointerdown', { bubbles: true }))
      })
      await context.advance(1_000)
      assert.equal(context.popup() === null, true, `An import arriving after ${reason} must not revive the queued intent`)
      assert.equal(context.timerCount(), 0); assert.equal(context.opened.length, 0); assert.equal(context.menus.length, 0)
    })
  }
  for (const reason of ['scroll', 'resize', 'blur', 'focus', 'rename', 'remove', 'drag'] as const) {
    await withTree(async context => {
      await context.change(() => context.outside.focus()); await context.enter(context.row('alpha'))
      const pending = context.timers()[0]; await context.advance(350); assert.ok(context.popup(), reason)
      if (reason === 'scroll') await context.change(() => context.document.querySelector('.tree-virtual-scroll')!.dispatchEvent(new context.dom.window.Event('scroll')))
      else if (reason === 'resize' || reason === 'blur') await context.change(() => context.dom.window.dispatchEvent(new context.dom.window.Event(reason)))
      else if (reason === 'focus') await context.change(() => context.row('short').focus())
      else if (reason === 'rename') await context.render({ nodes: [node('alpha', 'Renamed full title with its own new suffix'), ...initialNodes.slice(1)] })
      else if (reason === 'remove') await context.render({ nodes: initialNodes.slice(1) })
      else await context.render({ draggingDocumentId: 'alpha' })
      assert.equal(context.popup() === null, true, reason)
      await context.change(() => pending()); await context.advance(1_000)
      assert.equal(context.popup() === null, true, `A late callback must not replay ${reason}`)
      assert.equal(context.opened.length, 0); assert.equal(context.menus.length, 0); assert.equal(context.drags.length, 0)
    })
  }
})

test('late timers cannot detach a newer cancellation handle, and context menus, drag and unmount clean up reading', async () => {
  await withTree(async context => {
    await context.enter(context.row('alpha')); const oldOpen = context.timers()[0]
    await context.leave(context.row('alpha'), context.row('beta')); await context.enter(context.row('beta'), context.row('alpha'))
    assert.equal(context.timerCount(), 1)
    await context.change(() => oldOpen()); await context.pointerDown(context.outside)
    assert.equal(context.timerCount(), 0, 'A stale callback must not lose the newer timer handle before cancellation')
    await context.advance(350); assert.equal(context.popup() === null, true)
    await context.change(() => context.row('alpha').focus()); await context.advance(350)
    assert.equal((await context.key(context.row('alpha'), 'F10', { shiftKey: true })).defaultPrevented, true)
    assert.equal(context.popup() === null, true); assert.deepEqual(context.menus, ['alpha']); assert.equal(context.opened.length, 0)
    await context.enter(context.row('alpha')); await context.advance(350); assert.ok(context.popup())
    const button = context.row('alpha').querySelector<HTMLButtonElement>('.tree-button')!
    await context.change(() => {
      const event = new context.dom.window.Event('dragstart', { bubbles: true })
      Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: '', setData: () => undefined } })
      button.dispatchEvent(event)
    })
    assert.equal(context.popup() === null, true); assert.deepEqual(context.drags, ['alpha']); assert.equal(context.opened.length, 0)
    await context.enter(context.row('beta')); const late = context.timers()[0], focusCount = context.focusCalls.length
    const observers = context.observers.map(item => item.notify)
    await context.unmount(); assert.equal(context.timerCount(), 0)
    await context.change(() => { late(); observers.forEach(notify => notify()) }); await context.advance(1_000)
    assert.equal(context.popup() === null, true); assert.equal(context.focusCalls.length, focusCount)
    assert.ok(context.observers.every(item => item.disconnected)); assert.equal(context.menus.length, 1); assert.equal(context.drags.length, 1)
  })
})
