import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DatabaseFormDialog } = await import('../src/renderer/src/features/database/components/DatabaseDialogs')

type ObservedResize = { target: Element | null; disconnected: boolean; notify: () => void }
type Geometry = { top: number; height: number; clientHeight: number; fieldTop: number; fieldHeight: number }
type Context = {
  document: Document; window: JSDOM['window']; observers: ObservedResize[]; focusCalls: HTMLElement[]
  body: () => HTMLDivElement; field: () => HTMLTextAreaElement; outside: () => HTMLButtonElement
  render: (open: boolean) => Promise<void>; change: (callback: () => void) => Promise<void>
  geometry: (values: Partial<Geometry>) => void; foreground: (value: boolean) => void
  unmount: () => Promise<void>
}

async function withResize(run: (context: Context) => Promise<void>, supported = true) {
  const dom = new JSDOM('<button id="outside">Outside</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0, foreground = true, mounted = true
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => foreground })
  const geometry: Geometry = { top: 101.333, height: 204.542, clientHeight: 205, fieldTop: 223.333, fieldHeight: 85.333 }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('dbw-form-body')) return new dom.window.DOMRect(100, geometry.top, 400, geometry.height)
    if (this.tagName === 'TEXTAREA') {
      const body = this.closest<HTMLDivElement>('.dbw-form-body')!
      return new dom.window.DOMRect(120, geometry.fieldTop - body.scrollTop, 360, geometry.fieldHeight)
    }
    return new dom.window.DOMRect(100, 100, 400, 40)
  }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.isConnected && !this.closest('[hidden], [inert], [aria-hidden="true"]') ? [this.getBoundingClientRect()] : []
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const observers: ObservedResize[] = []
  if (supported) Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: class {
    state: ObservedResize
    constructor(callback: ResizeObserverCallback) {
      this.state = { target: null, disconnected: false, notify: () => callback([], this as unknown as ResizeObserver) }
      observers.push(this.state)
    }
    observe(target: Element) { this.state.target = target }
    disconnect() { this.state.disconnected = true }
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const render = async (open: boolean) => {
    await act(async () => root.render(createElement(DatabaseFormDialog, {
      open, name: 'Retained name', description: 'Retained description', withDescription: true,
      text: getDatabaseWorkspaceText('en-US'), title: 'Edit database', returnFocusTarget: null,
      onCancel: () => {}, onSubmit: () => {}, onNameChange: () => {}, onDescriptionChange: () => {}
    })))
    const element = dom.window.document.querySelector<HTMLDivElement>('.dbw-form-body')
    if (element) Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => geometry.clientHeight })
  }
  const body = () => dom.window.document.querySelector<HTMLDivElement>('.dbw-form-body')!
  const field = () => body().querySelector<HTMLTextAreaElement>('textarea')!
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  try {
    await render(true)
    await run({ document: dom.window.document, window: dom.window, observers, focusCalls, body, field,
      outside: () => dom.window.document.getElementById('outside') as HTMLButtonElement,
      render, change, geometry: values => Object.assign(geometry, values), foreground: value => { foreground = value }, unmount })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('body resize reveals the fractional clipped frame of the currently focused field without touching focus or selection', async () => {
  await withResize(async context => {
    const body = context.body(), field = context.field()
    assert.equal(context.observers[0].target, body)
    await context.change(() => { field.focus(); field.setSelectionRange(1, 4) })
    const beforeFocus = context.focusCalls.length
    await context.change(() => context.observers[0].notify())
    assert.equal(body.scrollTop, 3, 'The real fractional bottom, not rounded clientHeight, determines the adjustment')
    assert.equal(field.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom, true)
    assert.equal(context.document.activeElement === field, true)
    assert.deepEqual([field.value, field.selectionStart, field.selectionEnd], ['Retained description', 1, 4])
    assert.equal(context.focusCalls.length, beforeFocus)

    body.scrollTop = 8
    context.geometry({ fieldTop: 109.083 })
    await context.change(() => context.observers[0].notify())
    assert.equal(body.scrollTop, 7, 'A frame clipped above the scrollport adjusts only the body in the opposite direction')
    assert.equal(context.document.activeElement === field, true)
    assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 4])
    assert.equal(context.focusCalls.length, beforeFocus)

    body.scrollTop = 0
    context.geometry({ fieldTop: 223.333 })
    field.style.outlineWidth = '2px'
    field.style.outlineStyle = 'solid'
    field.style.outlineColor = 'red'
    field.style.outlineOffset = '2px'
    const computed = context.window.getComputedStyle(field)
    assert.equal(computed.outlineWidth, '2px')
    assert.equal(computed.outlineOffset, '2px')
    await context.change(() => context.observers[0].notify())
    assert.equal(body.scrollTop, 7, 'The measured 2px outline and 2px offset are revealed along with the control frame')
    assert.equal(field.getBoundingClientRect().bottom + 4 <= body.getBoundingClientRect().bottom, true)
    assert.equal(context.document.activeElement === field, true)
    assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 4])
    assert.equal(context.focusCalls.length, beforeFocus)
  })
})

test('visible and oversized fields, external focus, a higher modal and a background document do not scroll the form', async () => {
  await withResize(async context => {
    const body = context.body(), field = context.field()
    body.scrollTop = 7
    context.geometry({ fieldTop: 150 })
    await context.change(() => field.focus())
    await context.change(() => context.observers[0].notify())
    assert.equal(body.scrollTop, 7, 'An already visible field is left alone')

    context.geometry({ fieldTop: 223.333, fieldHeight: 300 })
    await context.change(() => context.observers[0].notify())
    assert.equal(body.scrollTop, 7, 'A user-enlarged field that cannot fit keeps native caret scrolling')
    context.geometry({ fieldHeight: 85.333 })
    body.scrollTop = 0
    await context.change(() => context.outside().focus())
    await context.change(() => context.observers[0].notify())
    assert.equal(body.scrollTop, 0)
    assert.equal(context.document.activeElement === context.outside(), true)

    await context.change(() => field.focus())
    const modal = context.document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    context.document.body.append(modal)
    const beforeFocus = context.focusCalls.length
    await context.change(() => context.observers[0].notify())
    assert.equal(body.scrollTop, 0, 'A newer visible modal owns the interaction even if focus still appears in the underlying field')
    assert.equal(context.focusCalls.length, beforeFocus)
    modal.remove()
    context.foreground(false)
    await context.change(() => context.observers[0].notify())
    assert.equal(body.scrollTop, 0)
    assert.equal(context.document.activeElement === field, true)
  })
})

test('close and unmount disconnect resize observation, and queued old callbacks cannot affect a reopened form', async () => {
  await withResize(async context => {
    const oldBody = context.body(), oldObserver = context.observers[0]
    await context.change(() => context.field().focus())
    await context.render(false)
    assert.equal(oldObserver.disconnected, true)
    await context.render(true)
    const currentBody = context.body(), currentField = context.field(), currentObserver = context.observers[1]
    assert.equal(currentBody === oldBody, false)
    await context.change(() => currentField.focus())
    const beforeFocus = context.focusCalls.length
    await context.change(() => oldObserver.notify())
    assert.equal(oldBody.scrollTop, 0)
    assert.equal(currentBody.scrollTop, 0)
    assert.equal(context.document.activeElement === currentField, true)
    assert.equal(context.focusCalls.length, beforeFocus)
    await context.change(() => currentObserver.notify())
    assert.equal(currentBody.scrollTop, 3)
    await context.unmount()
    assert.equal(currentObserver.disconnected, true)
    await context.change(() => currentObserver.notify())
    assert.equal(currentBody.scrollTop, 3)
  })
})

test('opening and closing a form without ResizeObserver support remains safe', async () => {
  await withResize(async context => {
    assert.equal(context.observers.length, 0)
    await context.change(() => context.field().focus())
    assert.equal(context.document.activeElement === context.field(), true)
    await context.render(false)
    await context.render(true)
    assert.equal(context.body().isConnected, true)
    assert.equal(context.observers.length, 0)
  }, false)
})
