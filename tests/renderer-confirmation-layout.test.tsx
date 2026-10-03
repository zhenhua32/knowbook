import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode, useState } from 'react'
import { JSDOM } from 'jsdom'
import { ConfirmationDialog } from '../src/renderer/src/components/ConfirmationDialog'
import { setActiveUiLanguage } from '../src/renderer/src/i18n'

type Metrics = { headingClient: number; headingScroll: number; bodyClient: number; bodyScroll: number; errorGrowth: number; errorOffset: number }
type Observation = { targets: Set<Element>; disconnected: boolean; notify: () => void }
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred> & { choice: string }
type Context = {
  document: Document; window: JSDOM['window']; observations: Observation[]; requests: Request[]
  reads: { open: boolean; target: string }[]; focusCalls: HTMLElement[]; resizeListeners: Set<EventListenerOrEventListenerObject>
  calls: { cancel: number; complete: number }; dialog: () => HTMLDialogElement; heading: () => HTMLHeadingElement
  body: () => HTMLDivElement; cancel: () => HTMLButtonElement; confirm: () => HTMLButtonElement; choice: (value: string) => HTMLInputElement
  change: (callback: () => void) => Promise<void>; metrics: (next: Partial<Metrics>) => void; resize: () => Promise<void>
  render: (language: 'zh-CN' | 'en-US') => Promise<void>; unmount: () => Promise<void>
}

async function withLayout(run: (context: Context) => Promise<void>, options: { metrics?: Partial<Metrics>; observer?: boolean; strict?: boolean } = {}) {
  const dom = new JSDOM('<button id="opener">Open confirmation</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  const metrics: Metrics = { headingClient: 72, headingScroll: 72, bodyClient: 140, bodyScroll: 100, errorGrowth: 0, errorOffset: 100, ...options.metrics }
  const reads: Context['reads'] = []
  const metric = (element: HTMLElement, scrolling: boolean) => {
    const target = element.matches('.app-confirm-dialog h2') ? 'heading' : element.matches('.app-confirm-body') ? 'body' : ''
    if (!target) return 40
    const open = element.closest<HTMLDialogElement>('dialog')?.open === true
    reads.push({ open, target })
    if (!open) return 0
    return target === 'heading' ? scrolling ? metrics.headingScroll : metrics.headingClient
      : scrolling ? metrics.bodyScroll + (element.querySelector('.app-confirm-error') ? metrics.errorGrowth : 0) : metrics.bodyClient
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return metric(this, false) } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return metric(this, true) } })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('.app-confirm-body')) return new dom.window.DOMRect(0, 20, 300, metrics.bodyClient)
    if (this.matches('.app-confirm-error')) {
      const port = this.closest<HTMLElement>('.app-confirm-body')!
      return new dom.window.DOMRect(0, 20 + metrics.errorOffset - port.scrollTop, 280, metrics.errorGrowth)
    }
    return new dom.window.DOMRect(0, 0, 300, 40)
  }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    let element: HTMLElement | null = this
    if (!element.isConnected) return [] as unknown as DOMRectList
    while (element) {
      const style = dom.window.getComputedStyle(element)
      if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || element instanceof dom.window.HTMLDialogElement && !element.open) return [] as unknown as DOMRectList
      element = element.parentElement
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const observations: Observation[] = []
  if (options.observer !== false) Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: class {
    observation: Observation
    constructor(callback: ResizeObserverCallback) {
      this.observation = { targets: new Set(), disconnected: false, notify: () => callback([], this as unknown as ResizeObserver) }
      observations.push(this.observation)
    }
    observe(target: Element) { this.observation.targets.add(target) }
    disconnect() { this.observation.disconnected = true }
  } })
  const resizeListeners = new Set<EventListenerOrEventListenerObject>()
  const nativeAdd = dom.window.addEventListener.bind(dom.window), nativeRemove = dom.window.removeEventListener.bind(dom.window)
  dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    if (listener) { if (type === 'resize') resizeListeners.add(listener); nativeAdd(type, listener, options) }
  }) as typeof dom.window.addEventListener
  dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
    if (listener) { if (type === 'resize') resizeListeners.delete(listener); nativeRemove(type, listener, options) }
  }) as typeof dom.window.removeEventListener
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true
  const requests: Request[] = [], calls = { cancel: 0, complete: 0 }
  const path = 'D:/KnowBook/plugin-private-data/'.repeat(12)
  const close = (complete: boolean) => { if (complete) calls.complete++; else calls.cancel++; root.render(null) }
  function Harness() {
    const [choice, setChoice] = useState('keep')
    return createElement(ConfirmationDialog, {
      title: 'Long confirmation title '.repeat(8), description: 'Confirm only this exact action.', note: 'Existing documents remain untouched.',
      confirmLabel: 'Confirm action', onCancel: () => close(false), onComplete: () => close(true),
      onConfirm: () => {
        const request = { ...deferred(), choice }
        requests.push(request)
        return request.promise
      }
    }, createElement('code', null, path),
    ...['keep', 'remove'].map(value => createElement('label', { key: value }, createElement('input', {
      type: 'radio', name: 'private-data', value, checked: choice === value, onChange: () => setChoice(value)
    }), value === 'keep' ? 'Keep private data' : 'Delete private data')))
  }
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const render = async (language: 'zh-CN' | 'en-US') => {
    setActiveUiLanguage(language)
    await act(async () => root.render(options.strict ? createElement(StrictMode, null, createElement(Harness)) : createElement(Harness)))
  }
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>('.app-confirm-dialog')!
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  dom.window.document.getElementById('opener')!.focus()
  try {
    await render('en-US')
    await run({ document: dom.window.document, window: dom.window, observations, requests, reads, focusCalls, resizeListeners, calls,
      dialog, heading: () => dialog().querySelector('h2')!, body: () => dialog().querySelector('.app-confirm-body')!,
      cancel: () => dialog().querySelector('.secondary-button')!, confirm: () => dialog().querySelector('.danger-button')!,
      choice: value => dialog().querySelector(`input[value="${value}"]`)!, change, render, unmount,
      metrics: next => Object.assign(metrics, next), resize: () => change(() => {
        for (const observer of observations) observer.notify()
        dom.window.dispatchEvent(new dom.window.Event('resize'))
      }) })
  } finally {
    await unmount()
    setActiveUiLanguage('zh-CN')
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('initial measurement occurs after showModal and gives keyboard entry only to genuinely overflowing content', async () => {
  await withLayout(async context => {
    assert.equal(context.dialog().open, true)
    assert.equal(context.reads.length > 0, true)
    assert.equal(context.reads.every(read => read.open), true, 'Closed dialogs have zero dimensions and must not determine scrollability')
    assert.equal(context.heading().tabIndex, 0)
    assert.equal(context.body().tabIndex, 0)
    assert.equal(context.body().getAttribute('role'), 'region')
    assert.equal(context.body().getAttribute('aria-label'), 'Confirmation details')
    assert.equal(context.document.activeElement === context.cancel(), true)
    assert.equal(context.observations.some(observer => observer.targets.has(context.heading()) && observer.targets.has(context.body())), true)
    const descriptionIds = context.dialog().getAttribute('aria-describedby')!.split(' ')
    assert.equal(descriptionIds.every(id => !!context.document.getElementById(id)), true)
  }, { metrics: { headingScroll: 180, bodyScroll: 420 } })
  await withLayout(async context => {
    assert.equal(context.heading().hasAttribute('tabindex'), false)
    assert.equal(context.body().hasAttribute('tabindex'), false)
    assert.equal(context.body().hasAttribute('role'), false)
    assert.equal(context.body().hasAttribute('aria-label'), false)
    assert.equal(context.document.activeElement === context.cancel(), true)
  })
})

test('overflow and language changes retain the selected child node and focus without adding ordinary tab stops', async () => {
  await withLayout(async context => {
    const radio = context.choice('remove'), code = context.body().querySelector('code')!
    await context.change(() => { radio.click(); radio.focus() })
    const beforeFocus = context.focusCalls.length
    context.metrics({ headingScroll: 170, bodyScroll: 500 })
    await context.resize()
    assert.equal(context.heading().tabIndex, 0)
    assert.equal(context.body().tabIndex, 0)
    assert.equal(context.choice('remove') === radio, true)
    assert.equal(radio.checked, true)
    assert.equal(context.body().querySelector('code') === code, true)
    assert.equal(context.document.activeElement === radio, true)
    assert.equal(context.focusCalls.length, beforeFocus)
    await context.render('zh-CN')
    assert.equal(context.body().getAttribute('aria-label'), '确认详情')
    assert.equal(context.document.activeElement === radio, true)
    context.metrics({ headingClient: 200, bodyClient: 600 })
    await context.resize()
    assert.equal(context.heading().hasAttribute('tabindex'), false)
    assert.equal(context.body().hasAttribute('tabindex'), false)
    assert.equal(context.document.activeElement === radio, true)
    assert.equal(context.focusCalls.length, beforeFocus)
  })
})

test('controlled children and complete failure text survive asynchronous confirmation and retry with the existing lock and IME guards', async () => {
  await withLayout(async context => {
    const radio = context.choice('remove'), code = context.body().querySelector('code')!
    await context.change(() => { radio.click(); radio.focus() })
    await context.change(() => { context.confirm().click(); context.confirm().click() })
    assert.equal(context.requests.length, 1)
    assert.equal(context.requests[0].choice, 'remove')
    assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
    assert.equal(context.dialog().querySelector('fieldset')!.disabled, true)
    await context.change(() => context.choice('keep').click())
    assert.equal(radio.checked, true)
    const reason = 'Failure details retained in full.\n' + '<img src=x onerror="unexpected()">'.repeat(8)
    await context.change(() => context.requests[0].reject(new Error(reason)))
    assert.equal(context.dialog().querySelector('[role="alert"]')!.textContent, reason)
    assert.equal(context.dialog().querySelectorAll('img').length, 0)
    assert.equal(context.body().tabIndex, 0, 'Failure content can cause overflow without changing the observed client height')
    assert.equal(context.confirm().textContent, 'Retry')
    assert.equal(context.choice('remove') === radio && context.body().querySelector('code') === code, true)
    assert.equal(radio.checked, true)
    assert.equal(context.document.activeElement === context.cancel(), true)
    for (const source of ['lifecycle', 'native', 'key-code'] as const) {
      if (source === 'lifecycle') await context.change(() => radio.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })))
      await context.change(() => {
        const escape = new context.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true,
          ...(source === 'native' ? { isComposing: true } : source === 'key-code' ? { keyCode: 229 } : {}) })
        radio.dispatchEvent(escape)
        assert.equal(escape.defaultPrevented, true)
      })
      if (source === 'lifecycle') await context.change(() => radio.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
      assert.equal(context.calls.cancel, 0)
      assert.equal(context.requests.length, 1)
    }
    await context.change(() => { context.confirm().click(); context.confirm().click() })
    assert.equal(context.requests.length, 2)
    assert.equal(context.requests[1].choice, 'remove')
    assert.equal(context.dialog().querySelectorAll('[role="alert"]').length, 0)
    // This intentional new pending key forfeits failure focus; exercise its close lock on the successful retry instead.
    await context.change(() => {
      const escape = new context.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      context.dialog().dispatchEvent(escape)
      assert.equal(escape.defaultPrevented, true)
    })
    assert.equal(context.calls.cancel, 0)
    await context.change(() => context.requests[1].resolve())
    assert.equal(context.calls.complete, 1)
    assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
  }, { metrics: { bodyClient: 140, bodyScroll: 100, errorGrowth: 320 } })
})

test('each new failure reveals only its start while later reading and resizing retain the user scroll and focus', async () => {
  await withLayout(async context => {
    const port = context.body(), heading = context.heading(), modal = context.dialog()
    await context.change(() => { port.scrollTop = 120; heading.scrollTop = 40; context.confirm().click() })
    const reason = ('Storage could not finish this exact action.\n' + 'The original target and selection remain available for retry. '.repeat(12)).trim()
    await context.change(() => context.requests[0].reject(new Error(reason)))
    assert.equal(port.scrollTop, 500, 'The newly committed failure starts at the top of the local scrollport')
    assert.equal(modal.scrollTop, 0)
    assert.equal(heading.scrollTop, 40)
    assert.equal(context.document.activeElement === context.cancel(), true)
    assert.equal(context.dialog().querySelector('[role="alert"]')!.textContent, reason)
    await context.change(() => { port.focus(); port.scrollTop = 580 })
    const focusCalls = context.focusCalls.length
    context.metrics({ bodyClient: 180, headingScroll: 200 })
    await context.resize()
    await context.render('zh-CN')
    assert.equal(context.body() === port, true)
    assert.equal(port.scrollTop, 580, 'Resize, measurement and language commits do not reveal the same error again')
    assert.equal(context.document.activeElement === port, true)
    assert.equal(context.focusCalls.length, focusCalls)
    await context.change(() => context.confirm().click())
    assert.equal(context.dialog().querySelectorAll('[role="alert"]').length, 0)
    await context.change(() => context.requests[1].reject(new Error(reason)))
    assert.equal(port.scrollTop, 500, 'A new failed attempt can reveal the same message again')
    assert.equal(context.document.activeElement === context.cancel(), true)
    await context.change(() => context.confirm().click())
    await context.change(() => context.requests[2].resolve())
    assert.equal(context.calls.complete, 1)
  }, { metrics: { bodyScroll: 500, errorGrowth: 700, errorOffset: 500 } })
})

test('resize observation cleans up through StrictMode and unmount, while absence of ResizeObserver still permits resize measurement', async () => {
  await withLayout(async context => {
    assert.equal(context.resizeListeners.size, 1)
    const callbacks = [...context.resizeListeners], observed = [...context.observations]
    await context.unmount()
    assert.equal(observed.every(observer => observer.disconnected), true)
    assert.equal(context.resizeListeners.size, 0)
    const beforeReads = context.reads.length, beforeFocus = context.focusCalls.length
    context.metrics({ headingScroll: 300, bodyScroll: 800 })
    await context.change(() => {
      for (const observer of observed) observer.notify()
      for (const callback of callbacks) {
        const event = new context.window.Event('resize')
        if (typeof callback === 'function') callback(event)
        else callback.handleEvent(event)
      }
      context.window.dispatchEvent(new context.window.Event('resize'))
    })
    assert.equal(context.reads.length, beforeReads)
    assert.equal(context.focusCalls.length, beforeFocus)
  }, { strict: true })
  await withLayout(async context => {
    assert.equal(context.observations.length, 0)
    context.metrics({ headingScroll: 180, bodyScroll: 500 })
    await context.resize()
    assert.equal(context.heading().tabIndex, 0)
    assert.equal(context.body().tabIndex, 0)
  }, { observer: false })
})
