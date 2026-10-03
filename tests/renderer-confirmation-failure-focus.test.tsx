import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import { ConfirmationDialog } from '../src/renderer/src/components/ConfirmationDialog'
import { setActiveUiLanguage } from '../src/renderer/src/i18n'

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred> & { choice: string }
type FocusCall = { element: HTMLElement; disabled: boolean; busy: string | null; activeAfter: Element | null }
type Context = {
  document: Document; window: JSDOM['window']; requests: Request[]; focusCalls: FocusCall[]
  frames: Map<number, FrameRequestCallback>; history: FrameRequestCallback[]; calls: { cancel: number; complete: number }
  dialog: () => HTMLDialogElement; body: () => HTMLDivElement; heading: () => HTMLHeadingElement
  cancel: () => HTMLButtonElement; confirm: () => HTMLButtonElement; choice: () => HTMLInputElement
  change: (callback: () => void) => Promise<void>; submit: () => Promise<void>; fail: (index?: number) => Promise<void>
  flush: () => Promise<void>; render: () => Promise<void>; remove: () => Promise<void>; foreground: (value: boolean) => void
}
const reason = 'Could not finish this exact action.\nOriginal target and selected option are retained for retry. '.repeat(5).trim()

function focused(context: Context, expected: Element, message?: string) {
  assert.equal(context.document.activeElement === expected, true, message ?? `Expected focus on ${expected.tagName}`)
}

async function withFailure(run: (context: Context) => Promise<void>, options: { parentModal?: boolean; returnFocusOutsideParent?: boolean; canReturnFocus?: () => boolean } = {}) {
  const openerMarkup = options.parentModal ? '<dialog id="parent" open tabindex="-1"><button id="opener">Open nested confirmation</button></dialog>' : '<button id="opener">Open confirmation</button>'
  const dom = new JSDOM(`${openerMarkup}<button id="outside-return">Main search return target</button><input id="editor"><div id="mount"></div>`, { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  const history: FrameRequestCallback[] = [], focusCalls: FocusCall[] = [], requests: Request[] = [], calls = { cancel: 0, complete: 0 }
  let nextFrame = 0, foreground = true, rootMounted = true, generation = 0
  const requestFrame = (callback: FrameRequestCallback) => { history.push(callback); frames.set(++nextFrame, callback); return nextFrame }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: (id: number) => frames.delete(id) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  dom.window.requestAnimationFrame = requestFrame
  dom.window.cancelAnimationFrame = id => { frames.delete(id) }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => foreground })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('.app-confirm-body')) return new dom.window.DOMRect(0, 80, 360, 100)
    if (this.matches('.app-confirm-error')) return new dom.window.DOMRect(0, 480 - this.closest<HTMLElement>('.app-confirm-body')!.scrollTop, 340, 240)
    return new dom.window.DOMRect(0, 0, 360, 60)
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
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.matches('.app-confirm-body') ? 100 : 60 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
    return this.matches('.app-confirm-body') ? 800 : this.matches('.app-confirm-dialog h2') ? 180 : 60
  } })
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (focusOptions) {
    const disabled = this.matches(':disabled'), busy = this.closest('.app-confirm-dialog')?.getAttribute('aria-busy') ?? null
    nativeFocus.call(this, focusOptions)
    focusCalls.push({ element: this, disabled, busy, activeAfter: dom.window.document.activeElement })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const close = (complete: boolean) => { if (complete) calls.complete++; else calls.cancel++; root.render(null) }
  function Harness() {
    const [choice, setChoice] = useState('keep')
    return createElement(ConfirmationDialog, { title: 'Long confirmation heading '.repeat(8), description: 'Read the complete original confirmation description. '.repeat(12),
      note: 'The exact selected target is kept until a successful retry.', confirmLabel: 'Delete selected target',
      returnFocus: dom.window.document.getElementById(options.returnFocusOutsideParent ? 'outside-return' : 'opener'), canReturnFocus: options.canReturnFocus,
      onCancel: () => close(false), onComplete: () => close(true), onConfirm: () => {
        const request = { ...deferred(), choice }
        requests.push(request)
        return request.promise
      } }, ...['keep', 'remove'].map(value => createElement('label', { key: value }, createElement('input', {
        type: 'radio', name: 'decision', value, checked: choice === value, onChange: () => setChoice(value)
      }), value === 'keep' ? 'Keep original content' : 'Remove only the selected target')))
  }
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>('.app-confirm-dialog')!
  const body = () => dialog().querySelector<HTMLDivElement>('.app-confirm-body')!
  const heading = () => dialog().querySelector<HTMLHeadingElement>('h2')!
  const cancel = () => dialog().querySelector<HTMLButtonElement>('footer .secondary-button')!
  const confirm = () => dialog().querySelector<HTMLButtonElement>('footer .danger-button')!
  const choice = () => dialog().querySelector<HTMLInputElement>('input[value="remove"]')!
  const render = () => change(() => { setActiveUiLanguage('en-US'); root.render(createElement(Harness, { key: ++generation })) })
  const flush = () => change(() => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0) })
  dom.window.document.getElementById('opener')!.focus()
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window, requests, focusCalls, frames, history, calls, dialog, body, heading, cancel, confirm, choice,
      change, flush, render, remove: () => change(() => root.render(null)), foreground: value => { foreground = value },
      submit: () => change(() => { confirm().focus(); confirm().click() }), fail: (index = 0) => change(() => requests[index].reject(new Error(reason))) })
  } finally {
    if (rootMounted) { rootMounted = false; await act(async () => root.unmount()) }
    await act(async () => requests.forEach(request => request.resolve()))
    setActiveUiLanguage('zh-CN')
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

async function accepted(context: Context) {
  await context.change(() => { context.choice().click(); context.body().scrollTop = 24; context.heading().scrollTop = 32 })
  await context.submit()
  assert.equal(context.requests.length, 1)
  assert.equal(context.requests[0].choice, 'remove')
  assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
  assert.equal(context.cancel().disabled, true)
  focused(context, context.dialog())
  context.focusCalls.length = 0
  context.history.length = 0
}

function retained(context: Context) {
  assert.equal(context.dialog().getAttribute('aria-busy'), 'false')
  assert.equal(context.cancel().disabled, false)
  assert.equal(context.dialog().querySelector('[role="alert"]')!.textContent, reason)
  assert.equal(context.confirm().textContent, 'Retry')
  assert.equal(context.choice().checked, true)
  assert.equal(context.requests[0].choice, 'remove')
  assert.deepEqual(context.calls, { cancel: 0, complete: 0 })
}

test('a normal failure focuses Cancel once after its enabled DOM commit, reveals the error start and grants a fresh retry lease', async () => {
  await withFailure(async context => {
    await accepted(context)
    const cancel = context.cancel(), body = context.body(), heading = context.heading()
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    retained(context)
    focused(context, cancel)
    const attempts = context.focusCalls.filter(call => call.element === cancel)
    assert.equal(attempts.length, 1)
    assert.deepEqual(attempts.map(call => ({ disabled: call.disabled, busy: call.busy, active: call.activeAfter === cancel })), [{ disabled: false, busy: 'false', active: true }])
    assert.equal(body.scrollTop, 400)
    assert.equal(heading.scrollTop, 32)
    assert.equal(context.dialog().scrollTop, 0)
    await context.change(() => { for (const callback of callbacks) callback(0) })
    assert.equal(context.focusCalls.filter(call => call.element === cancel).length, 1)
    await context.submit()
    assert.equal(context.requests.length, 2)
    context.focusCalls.length = 0
    await context.fail(1)
    await context.flush()
    focused(context, cancel)
    assert.equal(context.focusCalls.filter(call => call.element === cancel).length, 1)
    assert.equal(context.requests[1].choice, 'remove')
  })
})

test('pending body or heading reading retains focus, range selection and scroll when failure appears', async () => {
  for (const reading of ['body', 'heading'] as const) await withFailure(async context => {
    await accepted(context)
    const target = reading === 'body' ? context.body() : context.heading()
    assert.equal(target.tabIndex, 0)
    const text = target.querySelector('p')?.firstChild ?? target.firstChild!
    const range = context.document.createRange()
    range.setStart(text, 1); range.setEnd(text, 9)
    await context.change(() => {
      target.focus()
      context.document.getSelection()!.removeAllRanges()
      context.document.getSelection()!.addRange(range)
      context.body().scrollTop = 190
      context.heading().scrollTop = 50
      target.dispatchEvent(new context.window.Event('scroll'))
    })
    const selected = context.document.getSelection()!.toString(), calls = context.focusCalls.length
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    await context.change(() => { for (const callback of callbacks) callback(0) })
    retained(context)
    focused(context, target)
    assert.equal(context.document.getSelection()!.toString(), selected)
    assert.equal(context.body().scrollTop, 190, 'The new failure must not interrupt reading by revealing itself automatically')
    assert.equal(context.heading().scrollTop, 50)
    assert.equal(context.focusCalls.length, calls)
  })
})

test('new pending pointer, key or IME intent preserves error handling and permanently vetoes automatic focus and scrolling', async () => {
  for (const activity of ['pointer', 'key', 'composition'] as const) await withFailure(async context => {
    await accepted(context)
    await context.change(() => {
      if (activity === 'pointer') context.body().dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else if (activity === 'key') context.dialog().dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      else context.body().dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
    })
    assert.equal(context.calls.cancel, 0)
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    await context.change(() => {
      if (activity === 'composition') context.body().dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true }))
      for (const callback of callbacks) callback(0)
    })
    retained(context)
    focused(context, context.dialog())
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.body().scrollTop, 24)
  })
})

test('reading followed by blur to BODY cannot revive the pending failure lease', async () => {
  await withFailure(async context => {
    await accepted(context)
    await context.change(() => { context.body().focus(); context.body().scrollTop = 160; context.body().blur() })
    focused(context, context.document.body)
    context.focusCalls.length = 0
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    await context.change(() => { for (const callback of callbacks) callback(0) })
    retained(context)
    focused(context, context.document.body)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.body().scrollTop, 160)
  })
})

test('blur of the enabled submission root to BODY is not a disabled-control transition and permanently forfeits failure focus', async () => {
  await withFailure(async context => {
    await accepted(context)
    assert.equal(context.dialog().matches(':disabled'), false)
    await context.change(() => context.dialog().blur())
    focused(context, context.document.body)
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    await context.change(() => { for (const callback of callbacks) callback(0) })
    retained(context)
    focused(context, context.document.body)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.body().scrollTop, 24)
  })
})

test('wheel or changed scroll while pending preserves the reading position rather than automatically revealing a new failure', async () => {
  for (const reading of ['wheel', 'scroll'] as const) await withFailure(async context => {
    await accepted(context)
    await context.change(() => {
      context.body().scrollTop = 170
      context.body().dispatchEvent(reading === 'wheel' ? new context.window.WheelEvent('wheel', { deltaY: 146, bubbles: true }) : new context.window.Event('scroll'))
    })
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    await context.change(() => { for (const callback of callbacks) callback(0) })
    retained(context)
    assert.equal(context.body().scrollTop, 170)
    assert.equal(context.heading().scrollTop, 32)
    assert.equal(context.dialog().scrollTop, 0)
    if (reading === 'wheel') {
      focused(context, context.dialog())
      assert.equal(context.focusCalls.length, 0, 'Wheel intent vetoes failure focus as well as the error reveal')
    }
  })
})

test('window blur, background renderer or a newer modal permanently veto failure focus even after becoming eligible again', async () => {
  for (const blocker of ['window-blur', 'background', 'foreign-modal'] as const) await withFailure(async context => {
    await accepted(context)
    const foreign = context.document.createElement('dialog')
    foreign.open = true
    foreign.setAttribute('aria-modal', 'true')
    if (blocker === 'foreign-modal') context.document.body.append(foreign)
    else if (blocker === 'background') context.foreground(false)
    else await context.change(() => context.window.dispatchEvent(new context.window.Event('blur')))
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    foreign.remove()
    context.foreground(true)
    await context.change(() => { context.window.dispatchEvent(new context.window.Event('focus')); for (const callback of callbacks) callback(0) })
    retained(context)
    focused(context, context.dialog())
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.body().scrollTop, 24)
  })
})

test('failure restoration is independent of the closing canReturnFocus veto and permits the original parent modal', async () => {
  await withFailure(async context => {
    await accepted(context)
    const cancel = context.cancel()
    await context.fail()
    await context.flush()
    retained(context)
    focused(context, cancel)
    assert.equal(context.focusCalls.filter(call => call.element === cancel).length, 1)
  }, { parentModal: true, canReturnFocus: () => false })
})

test('the actual opening parent modal permits failure focus even when the explicit close return target is outside it', async () => {
  for (const newForeignModal of [false, true]) await withFailure(async context => {
    const parent = context.document.getElementById('parent')!, outside = context.document.getElementById('outside-return')!
    assert.equal(parent.contains(context.document.getElementById('opener')), true)
    assert.equal(parent.contains(outside), false)
    await accepted(context)
    const cancel = context.cancel(), foreign = context.document.createElement('dialog')
    if (newForeignModal) {
      foreign.open = true
      foreign.setAttribute('aria-modal', 'true')
      context.document.body.append(foreign)
    }
    await context.fail()
    await context.flush()
    retained(context)
    const attempts = context.focusCalls.filter(call => call.element === cancel)
    if (newForeignModal) {
      focused(context, context.dialog())
      assert.equal(attempts.length, 0)
      assert.equal(context.body().scrollTop, 24)
      foreign.remove()
    } else {
      focused(context, cancel)
      assert.deepEqual(attempts.map(call => ({ disabled: call.disabled, busy: call.busy, active: call.activeAfter === cancel })), [{ disabled: false, busy: 'false', active: true }])
      assert.equal(context.body().scrollTop, 400)
      await context.change(() => cancel.click())
      await context.flush()
      assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
      assert.equal(context.focusCalls.some(call => call.element === outside), false, 'The close-return veto remains independent of the successful failure focus')
      assert.deepEqual(context.calls, { cancel: 1, complete: 0 })
    }
  }, { parentModal: true, returnFocusOutsideParent: true, canReturnFocus: () => false })
})

test('reading vetoes failure focus without cancelling the ordinary explicit Cancel return to its opener', async () => {
  await withFailure(async context => {
    await accepted(context)
    await context.change(() => context.body().focus())
    await context.fail()
    await context.flush()
    focused(context, context.body())
    await context.change(() => { context.cancel().focus(); context.cancel().click() })
    assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
    await context.flush()
    focused(context, context.document.getElementById('opener')!)
    assert.deepEqual(context.calls, { cancel: 1, complete: 0 })
  })
})

test('unmount and remount reject stale success, failure and copied failure callbacks without altering the new dialog', async () => {
  for (const outcome of ['success', 'failure', 'queued-failure'] as const) await withFailure(async context => {
    await accepted(context)
    const original = context.dialog()
    if (outcome === 'queued-failure') await context.fail()
    const callbacks = [...context.history]
    await context.remove()
    await context.render()
    const fresh = context.dialog()
    assert.notEqual(fresh, original)
    focused(context, context.cancel())
    context.focusCalls.length = 0
    if (outcome === 'success') await context.change(() => context.requests[0].resolve())
    else if (outcome === 'failure') await context.fail()
    await context.flush()
    await context.change(() => { for (const callback of callbacks) callback(0) })
    assert.equal(context.dialog(), fresh)
    focused(context, context.cancel())
    assert.equal(fresh.getAttribute('aria-busy'), 'false')
    assert.equal(fresh.querySelector('[role="alert"]'), null)
    assert.equal(context.choice().checked, false)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.calls, { cancel: 0, complete: 0 })
  })
})
