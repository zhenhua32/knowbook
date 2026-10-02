import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: QuickCaptureDialog } = await import('../src/renderer/src/components/QuickCaptureDialog')

type Observation = { targets: Set<Element>; disconnected: boolean; notify: () => void }
type Geometry = { bodyTop: number; bodyHeight: number; errorBodyHeight: number | null; contentTop: number; titleTop: number; titleHeight: number }
type Context = {
  document: Document; window: JSDOM['window']; observations: Observation[]; focusCalls: HTMLElement[]
  body: HTMLFormElement; content: HTMLTextAreaElement; title: HTMLInputElement; dialog: HTMLDialogElement; outside: HTMLButtonElement
  frames: Map<number, FrameRequestCallback>; change: (callback: () => void) => Promise<void>; flush: () => Promise<void>
  geometry: (values: Partial<Geometry>) => void; foreground: (value: boolean) => void
  fill: (input: HTMLInputElement | HTMLTextAreaElement, value: string) => Promise<void>; unmount: () => Promise<void>
}

async function withLayout(run: (context: Context) => Promise<void>, supported = true,
  onSave: ComponentProps<typeof QuickCaptureDialog>['onSave'] = async () => {}) {
  const dom = new JSDOM('<button id="outside">Outside</button><div id="mount"></div>', { url: 'http://localhost' })
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0, foreground = true, mounted = true
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: requestFrame })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: cancelFrame })
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => foreground })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  const geometry: Geometry = { bodyTop: 120, bodyHeight: 371.583, errorBodyHeight: null, contentTop: 24, titleTop: 270, titleHeight: 42 }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('form.document-capture-body')) {
      const height = geometry.errorBodyHeight !== null && this.parentElement?.querySelector('.document-capture-error')
        ? geometry.errorBodyHeight : geometry.bodyHeight
      return new dom.window.DOMRect(100, geometry.bodyTop, 612, height)
    }
    if (this.tagName === 'TEXTAREA') {
      const body = this.closest<HTMLFormElement>('form.document-capture-body')!
      const limit = Number.parseFloat(body.style.getPropertyValue('--quick-capture-content-limit'))
      const height = Math.min(208.458, Number.isFinite(limit) ? limit : Infinity)
      return new dom.window.DOMRect(124, geometry.bodyTop + geometry.contentTop - body.scrollTop, 564, height)
    }
    if (this.tagName === 'INPUT') {
      const body = this.closest<HTMLFormElement>('form.document-capture-body')!
      return new dom.window.DOMRect(124, geometry.bodyTop + geometry.titleTop - body.scrollTop, 270, geometry.titleHeight)
    }
    return new dom.window.DOMRect(100, 80, 612, 40)
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() {
    return Math.round(this.getBoundingClientRect().height)
  } })
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.isConnected && !this.closest('[hidden], [inert], [aria-hidden="true"]') ? [this.getBoundingClientRect()] : []
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const observations: Observation[] = []
  if (supported) Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: class {
    observation: Observation
    constructor(callback: ResizeObserverCallback) {
      this.observation = { targets: new Set(), disconnected: false, notify: () => callback([], this as unknown as ResizeObserver) }
      observations.push(this.observation)
    }
    observe(target: Element) { this.observation.targets.add(target) }
    disconnect() { this.observation.disconnected = true }
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const flush = () => change(() => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  })
  const outside = dom.window.document.getElementById('outside') as HTMLButtonElement
  outside.focus()
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  try {
    await act(async () => root.render(createElement(QuickCaptureDialog, {
      isZh: false, documentTree: [], onClose: () => {}, onSave
    })))
    const body = dom.window.document.querySelector<HTMLFormElement>('form.document-capture-body')!
    const content = body.querySelector<HTMLTextAreaElement>('textarea')!, title = body.querySelector<HTMLInputElement>('input')!
    for (const field of [content, title]) {
      field.style.outlineWidth = '2px'
      field.style.outlineStyle = 'solid'
      field.style.outlineColor = 'red'
      field.style.outlineOffset = '3px'
    }
    await run({ document: dom.window.document, window: dom.window, observations, focusCalls, body, content, title,
      dialog: dom.window.document.querySelector<HTMLDialogElement>('.document-quick-capture-dialog')!, outside, frames,
      change, flush, geometry: values => Object.assign(geometry, values), foreground: value => { foreground = value }, unmount,
      fill: (input, value) => change(() => {
        const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) })
  } finally {
    await unmount()
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function limit(context: Context) {
  const value = Number.parseFloat(context.body.style.getPropertyValue('--quick-capture-content-limit'))
  assert.equal(Number.isFinite(value), true, 'The measured capacity is exposed on the current form body')
  return value
}
async function resize(context: Context, geometry: Partial<Geometry>) {
  context.geometry(geometry)
  await context.change(() => { for (const observation of context.observations) observation.notify() })
  await context.flush()
}

test('quick capture limits a short body while restoring natural textarea capacity in a tall body without replacing the draft', async () => {
  await withLayout(async context => {
    assert.equal(context.observations.some(observer => observer.targets.has(context.body)), true)
    assert.equal(context.observations.some(observer => observer.targets.has(context.content)), true)
    await context.fill(context.content, 'Kept content across viewport changes')
    await context.change(() => { context.content.focus(); context.content.setSelectionRange(2, 6) })
    await resize(context, { bodyHeight: 371.583 })
    const tallLimit = limit(context)
    assert.equal(tallLimit >= 208.458, true)
    const beforeFocus = context.focusCalls.length
    await resize(context, { bodyHeight: 128.875 })
    assert.equal(limit(context) < 200, true, 'A short or failed form can shrink below the former 200px minimum')
    assert.equal(limit(context) <= context.body.getBoundingClientRect().height, true)
    assert.equal(context.content.getBoundingClientRect().height <= context.body.getBoundingClientRect().height, true)
    assert.equal(context.document.activeElement === context.content, true)
    assert.deepEqual([context.content.value, context.content.selectionStart, context.content.selectionEnd], ['Kept content across viewport changes', 2, 6])
    await resize(context, { bodyHeight: 371.583 })
    assert.equal(limit(context), tallLimit)
    assert.equal(context.content.getBoundingClientRect().height, 208.458)
    assert.equal(context.focusCalls.length, beforeFocus)
    assert.deepEqual([context.content.selectionStart, context.content.selectionEnd], [2, 6])
  })
})

test('coalesced resize and field focus reveal only the body frame and preserve its current field focus and selection', async () => {
  await withLayout(async context => {
    await context.flush()
    await context.fill(context.title, 'Kept optional title')
    context.geometry({ bodyHeight: 140.875, titleTop: 110 })
    context.dialog.scrollTop = 23
    await context.change(() => {
      context.title.focus()
      context.title.setSelectionRange(1, 4)
      for (const observation of context.observations) { observation.notify(); observation.notify() }
    })
    assert.equal(context.frames.size, 1, 'Repeated resize notifications and focus changes share a pending layout frame')
    const beforeFocus = context.focusCalls.length
    await context.flush()
    assert.equal(context.body.scrollTop > 0, true)
    assert.equal(context.title.getBoundingClientRect().bottom + 5 <= context.body.getBoundingClientRect().bottom, true)
    assert.equal(context.dialog.scrollTop, 23, 'The containing dialog and its ancestors are not scrolled')
    assert.equal(context.document.activeElement === context.title, true)
    assert.deepEqual([context.title.value, context.title.selectionStart, context.title.selectionEnd], ['Kept optional title', 1, 4])
    assert.equal(context.focusCalls.length, beforeFocus)
    const settledScroll = context.body.scrollTop
    await resize(context, {})
    assert.equal(context.body.scrollTop, settledScroll, 'An already exposed frame does not move again')
    context.geometry({ titleHeight: 200 })
    await resize(context, {})
    assert.equal(context.body.scrollTop, settledScroll, 'A field larger than the scrollport keeps native caret handling')
  })
})

test('pending measurements can resize the content but cannot scroll a departed, background or obscured focus owner', async () => {
  await withLayout(async context => {
    await context.flush()
    context.geometry({ bodyHeight: 140.875, titleTop: 110 })
    await context.change(() => {
      context.title.focus()
      for (const observation of context.observations) observation.notify()
      context.outside.focus()
    })
    const beforeFocus = context.focusCalls.length
    await context.flush()
    assert.equal(limit(context) <= context.body.getBoundingClientRect().height, true)
    assert.equal(context.body.scrollTop, 0)
    assert.equal(context.document.activeElement === context.outside, true)
    assert.equal(context.focusCalls.length, beforeFocus)

    const otherModal = context.document.createElement('div')
    otherModal.setAttribute('role', 'dialog')
    otherModal.setAttribute('aria-modal', 'true')
    context.document.body.append(otherModal)
    await context.change(() => context.title.focus())
    await resize(context, {})
    assert.equal(context.body.scrollTop, 0, 'A newer visible modal blocks lower form scrolling')
    otherModal.remove()
    context.foreground(false)
    await resize(context, { bodyHeight: 120.875 })
    assert.equal(limit(context) <= context.body.getBoundingClientRect().height, true, 'Background documents still receive a correct size constraint')
    assert.equal(context.body.scrollTop, 0)
    context.foreground(true)
    await context.flush()
    assert.equal(context.body.scrollTop, 0, 'Returning to the foreground does not replay discarded scrolling')
  })
})

test('unmount disconnects observation and invalidates held frames; a browser without ResizeObserver remains safe', async () => {
  await withLayout(async context => {
    await context.flush()
    await context.change(() => context.title.focus())
    for (const observation of context.observations) observation.notify()
    const oldFrames = [...context.frames.values()], oldLimit = context.body.style.getPropertyValue('--quick-capture-content-limit')
    await context.unmount()
    assert.equal(context.observations.every(observer => observer.disconnected), true)
    assert.equal(context.frames.size, 0)
    const beforeFocus = context.focusCalls.length
    context.geometry({ bodyHeight: 90 })
    await context.change(() => {
      for (const observation of context.observations) observation.notify()
      for (const callback of oldFrames) callback(0)
    })
    assert.equal(context.body.style.getPropertyValue('--quick-capture-content-limit'), oldLimit)
    assert.equal(context.body.scrollTop, 0)
    assert.equal(context.focusCalls.length, beforeFocus)
  })
  await withLayout(async context => {
    assert.equal(context.observations.length, 0)
    assert.equal(context.document.activeElement === context.content, true)
    await context.fill(context.content, 'Safe without ResizeObserver')
    assert.equal(context.content.value, 'Safe without ResizeObserver')
  }, false)
})

test('a real save failure reduces content capacity in the error commit before the existing failure focus frame runs', async () => {
  let rejectSave!: (error: Error) => void
  const savedInputs: Parameters<ComponentProps<typeof QuickCaptureDialog>['onSave']>[0][] = []
  const pendingSave = new Promise<void>((_resolve, reject) => { rejectSave = reject })
  await withLayout(async context => {
    await context.flush()
    await context.fill(context.content, '# Kept content\n\nOriginal Markdown draft')
    await context.fill(context.title, 'Invalid/title')
    await resize(context, { bodyHeight: 204.01, errorBodyHeight: 125.01 })
    const priorLimit = limit(context)
    await context.change(() => {
      context.content.focus()
      context.content.setSelectionRange(2, 6)
      const submit = new context.window.Event('submit', { bubbles: true, cancelable: true })
      context.body.dispatchEvent(submit)
      assert.equal(submit.defaultPrevented, true)
    })
    assert.equal(savedInputs.length, 1)
    assert.equal(context.body.querySelector('fieldset')!.disabled, true)
    assert.equal(context.document.activeElement === context.dialog, true)
    const beforeFailureFocus = context.focusCalls.length
    await context.change(() => rejectSave(new Error('Document title cannot contain path separators, control characters, or dot segments')))
    assert.equal(context.dialog.querySelector('[role="alert"]')!.textContent,
      'Document title cannot contain path separators, control characters, or dot segments')
    assert.equal(context.body.querySelector('fieldset')!.disabled, false)
    assert.equal(context.body.getBoundingClientRect().height, 125.01)
    // No ResizeObserver delivery or animation frame has been supplied since the rejection.
    assert.equal(limit(context) < priorLimit, true, 'The error commit must constrain the textarea before its existing autofocus frame')
    assert.equal(context.content.getBoundingClientRect().height + 10 <= context.body.getBoundingClientRect().height, true)
    assert.deepEqual([context.content.value, context.title.value, context.content.selectionStart, context.content.selectionEnd],
      ['# Kept content\n\nOriginal Markdown draft', 'Invalid/title', 2, 6])
    assert.equal(context.document.activeElement === context.dialog, true)
    assert.equal(context.focusCalls.length, beforeFailureFocus, 'Layout measurement does not add a synchronous focus change')
    assert.equal(context.frames.size, 1, 'Only the existing save completion frame is pending')

    await context.flush()
    assert.equal(context.document.activeElement === context.content, true)
    assert.equal(context.focusCalls.length, beforeFailureFocus + 1)
    const bodyBounds = context.body.getBoundingClientRect(), fieldBounds = context.content.getBoundingClientRect()
    assert.equal(fieldBounds.top - 5 >= bodyBounds.top && fieldBounds.bottom + 5 <= bodyBounds.bottom, true,
      'The existing failure focus frame must immediately reveal the whole Content field and its frame')
    const revealedScroll = context.body.scrollTop
    await context.flush()
    assert.equal(context.body.scrollTop, revealedScroll, 'The deferred focusin measurement does not repair or move the already revealed field')
    assert.equal(context.focusCalls.length, beforeFailureFocus + 1, 'Revealing the field does not refocus it')
    assert.deepEqual([context.content.selectionStart, context.content.selectionEnd], [2, 6])
  }, true, async input => { savedInputs.push(input); await pendingSave })
})
