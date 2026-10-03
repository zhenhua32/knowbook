import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, StrictMode } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentTemplate, DocumentTreeNode, SaveDocumentTemplateInput } from '../src/shared/contracts'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: QuickCaptureDialog } = await import('../src/renderer/src/components/QuickCaptureDialog')
const { default: DocumentTemplateDialog } = await import('../src/renderer/src/components/DocumentTemplateDialog')
const { default: SaveDocumentTemplateDialog } = await import('../src/renderer/src/components/SaveDocumentTemplateDialog')
const { setActiveUiLanguage } = await import('../src/renderer/src/i18n')

type Kind = 'capture' | 'create-template' | 'save-template'
const kinds: Kind[] = ['capture', 'create-template', 'save-template']
const tree: DocumentTreeNode[] = [{ id: 'parent', title: 'Parent', path: 'Parent', updatedAt: '2026-10-03', children: [] }]
const recipe = (id: string, name: string): DocumentTemplate => ({ id, name, description: `${name} recipe`, title: `${name} title`,
  summary: `${name} summary`, blocks: [{ type: 'paragraph', content: `${name} body`, checked: false, depth: 0 }], builtIn: false })
const alpha = recipe('alpha', 'Close Alpha'), beta = recipe('beta', 'Close Beta')
const source = { title: 'Original document title', summary: 'Original document summary',
  blocks: [{ type: 'paragraph' as const, content: 'Original draft content', checked: false, depth: 0 }] }

function deferred() {
  let resolve!: (value?: unknown) => void, reject!: (error: Error) => void
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred> & { payload: unknown; deletion: boolean; settled: boolean }
type Input = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
type FocusCall = { element: HTMLElement; disabled: boolean; activeAfter: Element | null; options?: FocusOptions }
type Context = {
  kind: Kind; document: Document; window: JSDOM['window']; requests: Request[]; calls: { close: number; saved: number }
  frames: Map<number, FrameRequestCallback>; history: FrameRequestCallback[]; focusCalls: FocusCall[]
  opener: HTMLButtonElement; outside: HTMLInputElement; dialog: () => HTMLDialogElement; primary: () => HTMLInputElement | HTMLTextAreaElement
  initial: () => HTMLElement; cancel: () => HTMLButtonElement; child: () => HTMLDialogElement | null
  change: (callback: () => void) => Promise<void>; fill: (input: Input, value: string) => Promise<void>; prepare: () => Promise<void>
  cancelParent: () => Promise<void>; submit: () => Promise<void>; succeed: (index?: number) => Promise<void>
  flush: () => Promise<void>; replay: (callbacks: FrameRequestCallback[]) => Promise<void>; render: () => Promise<void>; remove: () => Promise<void>
  foreground: (value: boolean) => void; draft: () => string[]; payload: () => unknown
}

function focused(context: Context, target: Element, message?: string) {
  assert.equal(context.document.activeElement === target, true, message ?? `Expected focus on ${target.tagName}`)
}

async function withDialog(kind: Kind, run: (context: Context) => Promise<void>, options: { strict?: boolean; initiallyDisabledOpener?: boolean; nativeRemovalBlur?: boolean } = {}) {
  const dom = new JSDOM('<button id="opener">Open writing dialog</button><button id="fresh-opener">Open another dialog</button><input id="outside"><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  const history: FrameRequestCallback[] = [], focusCalls: FocusCall[] = [], requests: Request[] = [], calls = { close: 0, saved: 0 }
  let frameId = 0, foreground = true, rootMounted = true, generation = 0, stored = [alpha, beta]
  const requestFrame = (callback: FrameRequestCallback) => { history.push(callback); frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  dom.window.requestAnimationFrame = requestFrame
  dom.window.cancelAnimationFrame = cancelFrame
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => foreground })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  const nativeRemoveChild = dom.window.Node.prototype.removeChild
  if (options.nativeRemovalBlur) dom.window.Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    const active = dom.window.document.activeElement
    // Chromium emits removal focusout while the portal and its active descendant are still connected.
    if (active instanceof dom.window.HTMLElement && child.contains(active)) active.blur()
    return nativeRemoveChild.call(this, child) as T
  }
  // JSDOM supplies native focus but no layout; disconnected, hidden and closed elements have no visible geometry.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 400, 80) }
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
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 80 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.matches('.app-confirm-body') ? 220 : 80 } })
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) {
    const disabled = this.matches(':disabled')
    nativeFocus.call(this, options)
    focusCalls.push({ element: this, disabled, activeAfter: dom.window.document.activeElement, options })
  }
  const enqueue = (payload: unknown, deletion = false) => {
    const request = { ...deferred(), payload, deletion, settled: false }
    requests.push(request)
    return request.promise
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    listDocumentTemplates: async () => stored,
    saveDocumentTemplate: (input: SaveDocumentTemplateInput) => enqueue(input),
    deleteDocumentTemplate: (id: string) => enqueue(id, true)
  } })
  const { createRoot } = await import('react-dom/client')
  // Use the genuine confirmAction/showConfirmation second root for nested template deletion.
  await import('../src/renderer/src/components/showConfirmation')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const close = () => { calls.close++; root.render(null) }
  const render = () => change(() => {
    setActiveUiLanguage('en-US')
    const key = ++generation
    const element = kind === 'capture' ? createElement(QuickCaptureDialog, { key, isZh: false, documentTree: tree,
      onClose: close, onSave: async input => { await enqueue(input) } })
      : kind === 'create-template' ? createElement(DocumentTemplateDialog, { key, isZh: false, documentTree: tree,
        onClose: close, onCreate: async input => { await enqueue(input) } })
        : createElement(SaveDocumentTemplateDialog, { key, isZh: false, source, onClose: close, onSaved: () => { calls.saved++ } })
    root.render(options.strict ? createElement(StrictMode, null, element) : element)
  })
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>(kind === 'capture' ? '.document-quick-capture-dialog'
    : kind === 'create-template' ? '.document-template-dialog' : '.document-save-template-dialog')!
  const child = () => dom.window.document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
  const primary = () => kind === 'capture' ? dialog().querySelector<HTMLTextAreaElement>('textarea')!
    : kind === 'create-template' ? dialog().querySelector<HTMLInputElement>('[name="document-title"]')!
      : dialog().querySelector<HTMLInputElement>('input')!
  const cancel = () => dialog().querySelector<HTMLButtonElement>('header .secondary-button')!
  const initial = () => kind === 'create-template' ? dialog().querySelector<HTMLInputElement>('input[type="search"]')! : primary()
  const fill = (input: Input, value: string) => change(() => {
    const prototype = input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype
      : input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
  const draft = () => kind === 'capture' ? [primary().value, dialog().querySelector<HTMLInputElement>('input')!.value, dialog().querySelector<HTMLSelectElement>('select')!.value]
    : kind === 'create-template' ? [primary().value, dialog().querySelector<HTMLSelectElement>('select')!.value, initial().getAttribute('type') === 'search' ? (initial() as HTMLInputElement).value : '']
      : [primary().value, dialog().querySelector<HTMLTextAreaElement>('textarea')!.value]
  const payload = () => kind === 'capture' ? { content: 'Captured markdown **draft**\nSecond line', title: 'Manual note title', parentId: 'parent' }
    : kind === 'create-template' ? { templateId: 'alpha', title: 'Manual template title', parentId: 'parent', language: 'en-US' }
      : { ...source, name: 'Saved recipe name', description: 'Preserved recipe description' }
  const flush = () => change(() => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0) })
  const succeed = (index = 0) => change(() => {
    const request = requests[index]
    assert.equal(request.settled, false)
    request.settled = true
    if (request.deletion) stored = stored.filter(template => template.id !== request.payload)
    request.resolve(alpha)
  })
  const opener = dom.window.document.getElementById('opener') as HTMLButtonElement
  const outside = dom.window.document.getElementById('outside') as HTMLInputElement
  opener.focus()
  if (options.initiallyDisabledOpener) opener.disabled = true
  try {
    await render()
    const context: Context = { kind, document: dom.window.document, window: dom.window, requests, calls, frames, history, focusCalls,
      opener, outside, dialog, primary, initial, cancel, child, change, fill, draft, payload, flush, succeed, render,
      remove: () => change(() => root.render(null)), foreground: value => { foreground = value },
      replay: callbacks => change(() => { for (const callback of callbacks) callback(0) }),
      prepare: async () => {
        await fill(primary(), kind === 'capture' ? 'Captured markdown **draft**\nSecond line' : kind === 'create-template' ? 'Manual template title' : 'Saved recipe name')
        if (kind === 'capture') {
          await fill(dialog().querySelector<HTMLInputElement>('input')!, 'Manual note title')
          await fill(dialog().querySelector<HTMLSelectElement>('select')!, 'parent')
        } else if (kind === 'create-template') {
          await fill(dialog().querySelector<HTMLSelectElement>('select')!, 'parent')
          await fill(dialog().querySelector<HTMLInputElement>('input[type="search"]')!, 'Close')
        } else await fill(dialog().querySelector<HTMLTextAreaElement>('textarea')!, 'Preserved recipe description')
        await flush()
        focusCalls.length = 0; history.length = 0
      },
      cancelParent: () => change(() => { cancel().focus(); cancel().click() }),
      submit: () => change(() => {
        primary().focus(); primary().setSelectionRange(2, 7)
        const event = new dom.window.Event('submit', { bubbles: true, cancelable: true })
        dialog().querySelector('form')!.dispatchEvent(event)
        assert.equal(event.defaultPrevented, true)
      }) }
    await run(context)
  } finally {
    try {
      // Release the real confirmation's single-flight root before tearing down its DOM.
      await change(() => { for (const request of requests) if (!request.settled) { request.settled = true; request.resolve(alpha) } })
      const currentChild = child()
      if (currentChild) await change(() => currentChild.querySelector<HTMLButtonElement>('footer .secondary-button')?.click())
      if (rootMounted) { rootMounted = false; await act(async () => root.unmount()) }
    } finally {
      dom.window.Node.prototype.removeChild = nativeRemoveChild
      setActiveUiLanguage('zh-CN')
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
      dom.window.close()
    }
  }
}

function returnCalls(context: Context) { return context.focusCalls.filter(call => call.element === context.opener) }
function closed(context: Context, saves: number) {
  assert.equal(context.dialog(), null)
  assert.deepEqual(context.calls, { close: 1, saved: context.kind === 'save-template' ? saves : 0 })
  assert.equal(context.requests.length, saves)
}

test('Cancel and successful writes restore each writing dialog opener once with native enabled focus', async () => {
  for (const kind of kinds) for (const outcome of ['cancel', 'success'] as const) await withDialog(kind, async context => {
    await context.prepare()
    assert.equal(context.opener.hasAttribute('inert'), false)
    assert.equal(context.opener.disabled, false)
    if (outcome === 'cancel') await context.cancelParent()
    else {
      await context.submit()
      assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
      assert.deepEqual(context.requests[0].payload, context.payload())
      context.focusCalls.length = 0
      await context.succeed()
    }
    closed(context, outcome === 'success' ? 1 : 0)
    const callbacks = [...context.history]
    await context.flush()
    focused(context, context.opener)
    assert.deepEqual(returnCalls(context).map(call => ({ disabled: call.disabled, active: call.activeAfter === context.opener, preventScroll: call.options?.preventScroll })),
      [{ disabled: false, active: true, preventScroll: true }])
    await context.replay(callbacks)
    assert.equal(returnCalls(context).length, 1)
    assert.equal(context.opener.hasAttribute('inert'), false)
    assert.equal(context.opener.disabled, false)
  })
})

test('a disabled opener has a single delayed recovery after it enables and a copied callback cannot replay it', async () => {
  for (const kind of kinds) await withDialog(kind, async context => {
    await context.prepare()
    assert.equal(context.opener.hasAttribute('inert'), false)
    context.opener.disabled = true
    await context.cancelParent()
    closed(context, 0)
    assert.equal(returnCalls(context).length, 0)
    assert.equal(context.frames.size > 0, true)
    assert.equal(context.opener.hasAttribute('inert'), false)
    assert.equal(context.opener.disabled, true, 'Closing must not alter the opener state owned by the caller')
    const callbacks = [...context.history]
    context.opener.disabled = false
    await context.flush()
    focused(context, context.opener)
    assert.equal(returnCalls(context).length, 1)
    await context.replay(callbacks)
    assert.equal(returnCalls(context).length, 1)
    assert.equal(context.opener.hasAttribute('inert'), false)
    assert.equal(context.opener.disabled, false)
  })
})

test('a vetoed close preserves an opener existing inert attribute exactly without changing its disabled state', async () => {
  for (const kind of kinds) for (const inertValue of ['', 'existing-inert-value']) await withDialog(kind, async context => {
    await context.prepare()
    context.opener.setAttribute('inert', inertValue)
    const disabled = context.opener.disabled
    await context.change(() => context.window.dispatchEvent(new context.window.Event('blur')))
    await context.cancelParent()
    const callbacks = [...context.history]
    await context.flush(); await context.replay(callbacks)
    closed(context, 0)
    assert.equal(context.opener.hasAttribute('inert'), true)
    assert.equal(context.opener.getAttribute('inert'), inertValue)
    assert.equal(context.opener.disabled, disabled)
    assert.equal(returnCalls(context).length, 0)
    assert.notEqual(context.document.activeElement, context.opener)
  })
})

test('normal passive dialog cleanup preserves opener ownership across native removal blur while a prior window blur remains a veto', async () => {
  for (const kind of ['create-template', 'save-template'] as const) for (const activity of ['normal', 'window-blur'] as const) await withDialog(kind, async context => {
    await context.prepare()
    if (activity === 'window-blur') await context.change(() => context.window.dispatchEvent(new context.window.Event('blur')))
    await context.cancelParent()
    const callbacks = [...context.history]
    await context.flush(); await context.replay(callbacks)
    closed(context, 0)
    assert.equal(context.opener.hasAttribute('inert'), false)
    if (activity === 'normal') {
      focused(context, context.opener)
      assert.equal(returnCalls(context).length, 1)
      assert.equal(returnCalls(context)[0].activeAfter, context.opener)
      assert.equal(returnCalls(context)[0].disabled, false)
    } else {
      assert.equal(returnCalls(context).length, 0)
      assert.notEqual(context.document.activeElement, context.opener)
    }
  }, { nativeRemovalBlur: true })
})

test('external focus then BODY, window blur and background renderer permanently veto an otherwise valid close return', async () => {
  for (const kind of kinds) for (const activity of ['external-body', 'window-blur', 'background'] as const) await withDialog(kind, async context => {
    await context.prepare()
    await context.change(() => {
      if (activity === 'external-body') { context.outside.focus(); context.outside.blur() }
      else if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
      else context.foreground(false)
    })
    await context.cancelParent()
    const callbacks = [...context.history]
    await context.flush()
    context.foreground(true)
    await context.change(() => context.window.dispatchEvent(new context.window.Event('focus')))
    await context.replay(callbacks)
    closed(context, 0)
    assert.equal(returnCalls(context).length, 0)
    assert.notEqual(context.document.activeElement, context.opener)
  })
})

test('new pointer, key, IME, blur or external BODY ownership permanently cancels delayed disabled-opener recovery', async () => {
  for (const kind of kinds) for (const activity of ['pointer', 'key', 'composition', 'window-blur', 'external-body'] as const) await withDialog(kind, async context => {
    await context.prepare()
    context.opener.disabled = true
    await context.cancelParent()
    const callbacks = [...context.history]
    context.opener.disabled = false
    await context.change(() => {
      if (activity === 'pointer') context.outside.dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else if (activity === 'key') context.outside.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      else if (activity === 'composition') context.outside.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
      else if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
      else { context.outside.focus(); context.outside.blur() }
    })
    const owner = context.document.activeElement
    context.focusCalls.length = 0
    await context.flush()
    await context.change(() => {
      context.window.dispatchEvent(new context.window.Event('focus'))
      if (activity === 'composition') context.outside.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true }))
    })
    await context.replay(callbacks)
    focused(context, owner!)
    assert.equal(context.focusCalls.length, 0)
    closed(context, 0)
  })
})

test('a newer foreign modal or invalid opener consumes the delayed return rather than reviving after the blocker disappears', async () => {
  for (const kind of kinds) for (const blocker of ['foreign-modal', 'hidden', 'inert', 'background'] as const) await withDialog(kind, async context => {
    await context.prepare()
    context.opener.disabled = true
    await context.cancelParent()
    const callbacks = [...context.history], foreign = context.document.createElement('dialog')
    context.opener.disabled = false
    if (blocker === 'foreign-modal') { foreign.open = true; foreign.setAttribute('aria-modal', 'true'); context.document.body.append(foreign) }
    else if (blocker === 'hidden') context.opener.hidden = true
    else if (blocker === 'inert') context.opener.setAttribute('inert', '')
    else context.foreground(false)
    await context.flush()
    foreign.remove(); context.opener.hidden = false; context.opener.removeAttribute('inert'); context.foreground(true)
    await context.replay(callbacks)
    assert.equal(returnCalls(context).length, 0)
    assert.notEqual(context.document.activeElement, context.opener)
    closed(context, 0)
  })
})

test('a successful pending write still closes and preserves its exact payload without stealing newer focus or background ownership', async () => {
  for (const kind of kinds) for (const activity of ['external-body', 'window-blur', 'foreign-modal'] as const) await withDialog(kind, async context => {
    await context.prepare(); await context.submit()
    const payload = context.payload(), foreign = context.document.createElement('dialog')
    await context.change(() => {
      if (activity === 'external-body') { context.outside.focus(); context.outside.blur() }
      else if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
      else { foreign.open = true; foreign.setAttribute('aria-modal', 'true'); context.document.body.append(foreign) }
    })
    context.focusCalls.length = 0
    await context.succeed()
    const callbacks = [...context.history]
    await context.flush()
    foreign.remove()
    await context.change(() => context.window.dispatchEvent(new context.window.Event('focus')))
    await context.replay(callbacks)
    closed(context, 1)
    assert.deepEqual(context.requests[0].payload, payload)
    assert.equal(returnCalls(context).length, 0)
    assert.notEqual(context.document.activeElement, context.opener)
  })
})

test('unmount and reopen invalidate copied old closing callbacks without overriding the fresh dialog or its draft', async () => {
  for (const kind of kinds) await withDialog(kind, async context => {
    await context.prepare()
    const original = context.dialog()
    context.opener.disabled = true
    await context.remove()
    const callbacks = [...context.history]
    await context.change(() => context.document.getElementById('fresh-opener')!.focus())
    await context.render()
    const fresh = context.dialog()
    assert.notEqual(fresh, original)
    await context.prepare()
    await context.change(() => { context.primary().focus(); context.primary().setSelectionRange(1, 5) })
    const draft = context.draft(), target = context.primary()
    context.opener.disabled = false; context.focusCalls.length = 0
    await context.flush(); await context.replay(callbacks)
    focused(context, target)
    assert.equal(context.dialog(), fresh)
    assert.deepEqual(context.draft(), draft)
    assert.deepEqual([target.selectionStart, target.selectionEnd], [1, 5])
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.calls, { close: 0, saved: 0 })
  })
})

test('StrictMode setup replay cancels the old delayed opener return before the active dialog initializes again', async () => {
  for (const kind of kinds) await withDialog(kind, async context => {
    const target = context.initial(), modal = context.dialog(), callbacks = [...context.history]
    focused(context, target)
    context.opener.disabled = false; context.focusCalls.length = 0
    await context.flush(); await context.replay(callbacks)
    focused(context, target)
    assert.equal(context.dialog(), modal)
    assert.equal(returnCalls(context).length, 0)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.calls, { close: 0, saved: 0 })
  }, { strict: true, initiallyDisabledOpener: true })
})

test('a genuine nested template confirmation can return to Search and then close its parent back to the original opener once', async () => {
  for (const outcome of ['cancel', 'success'] as const) await withDialog('create-template', async context => {
    await context.prepare()
    const draft = context.draft(), remove = context.dialog().querySelector<HTMLButtonElement>('.document-template-delete')!
    await context.change(() => { remove.focus(); remove.click() })
    assert.equal(context.child()?.open, true)
    assert.equal(context.dialog().contains(context.child()), false)
    const child = context.child()!, childCancel = child.querySelector<HTMLButtonElement>('footer .secondary-button')!
    if (outcome === 'cancel') await context.change(() => { childCancel.focus(); childCancel.click() })
    else {
      const confirm = child.querySelector<HTMLButtonElement>('footer .danger-button')!
      await context.change(() => { confirm.focus(); confirm.click() })
      assert.deepEqual(context.requests.map(request => request.payload), ['alpha'])
      await context.succeed()
    }
    assert.equal(context.child(), null)
    assert.equal(context.dialog().getAttribute('aria-busy'), 'false')
    const title = context.primary()
    assert.deepEqual(context.draft(), outcome === 'cancel' ? draft : ['Manual template title', 'parent', 'Close'])
    await context.flush()
    focused(context, context.initial())
    assert.equal(context.focusCalls.filter(call => call.element === context.initial()).length, 1)
    assert.equal(title.value, 'Manual template title')
    context.focusCalls.length = 0
    await context.cancelParent(); await context.flush()
    focused(context, context.opener)
    assert.equal(returnCalls(context).length, 1)
    assert.deepEqual(context.calls, { close: 1, saved: 0 })
    assert.equal(context.requests.length, outcome === 'cancel' ? 0 : 1)
  }, { nativeRemovalBlur: true })
})

test('legitimate keyboard and IME activity in the nested child preserve parent closing attention through the normal handoff', async () => {
  for (const activity of ['key', 'composition'] as const) await withDialog('create-template', async context => {
    await context.prepare()
    const draft = context.draft(), remove = context.dialog().querySelector<HTMLButtonElement>('.document-template-delete')!
    await context.change(() => { remove.focus(); remove.click() })
    const child = context.child()!, cancel = child.querySelector<HTMLButtonElement>('footer .secondary-button')!
    await context.change(() => {
      if (activity === 'key') child.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      else cancel.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
    })
    if (activity === 'composition') await context.change(() => cancel.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
    await context.change(() => { cancel.focus(); cancel.click() })
    assert.equal(context.child(), null)
    await context.flush()
    assert.deepEqual(context.draft(), draft)
    focused(context, context.initial())
    context.focusCalls.length = 0
    await context.cancelParent()
    const callbacks = [...context.history]
    await context.flush(); await context.replay(callbacks)
    focused(context, context.opener)
    assert.equal(returnCalls(context).length, 1)
    assert.deepEqual(context.calls, { close: 1, saved: 0 })
    assert.equal(context.requests.length, 0)
  })
})

test('window blur or focus outside the nested family then BODY permanently relinquishes parent closing attention', async () => {
  for (const activity of ['window-blur', 'outside-body'] as const) await withDialog('create-template', async context => {
    await context.prepare()
    const draft = context.draft(), remove = context.dialog().querySelector<HTMLButtonElement>('.document-template-delete')!
    await context.change(() => { remove.focus(); remove.click() })
    const child = context.child()!, cancel = child.querySelector<HTMLButtonElement>('footer .secondary-button')!
    await context.change(() => {
      if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
      else { context.outside.focus(); context.outside.blur() }
    })
    if (activity === 'outside-body') focused(context, context.document.body)
    // Returning into the child is a legitimate explicit user action, but cannot revive the already-lost family lease.
    await context.change(() => { cancel.focus(); cancel.click() })
    assert.equal(context.child(), null)
    await context.flush()
    assert.deepEqual(context.draft(), draft)
    context.focusCalls.length = 0
    await context.change(() => context.window.dispatchEvent(new context.window.Event('focus')))
    await context.cancelParent()
    const callbacks = [...context.history]
    await context.flush(); await context.replay(callbacks)
    assert.equal(returnCalls(context).length, 0)
    assert.notEqual(context.document.activeElement, context.opener)
    assert.deepEqual(context.calls, { close: 1, saved: 0 })
    assert.equal(context.requests.length, 0)
  })
})
