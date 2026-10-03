import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentTemplate, DocumentTreeNode } from '../src/shared/contracts'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: DocumentTemplateDialog } = await import('../src/renderer/src/components/DocumentTemplateDialog')
const { setActiveUiLanguage } = await import('../src/renderer/src/i18n')

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred> & { id: string; settled: boolean }
const makeTemplate = (id: string, name: string): DocumentTemplate => ({ id, name, description: `${name} recipe`, title: `${name} title`,
  summary: `${name} summary`, blocks: [{ type: 'paragraph', content: `${name} body`, checked: false, depth: 0 }], builtIn: false })
const alpha = makeTemplate('alpha', 'Lease Alpha'), beta = makeTemplate('beta', 'Lease Beta')
const tree: DocumentTreeNode[] = [{ id: 'parent', title: 'Parent', path: 'Parent', updatedAt: '2026-10-03', children: [] }]
type Context = {
  document: Document; window: JSDOM['window']; requests: Request[]; calls: { close: number; create: number }
  frames: Map<number, FrameRequestCallback>; history: FrameRequestCallback[]; focusCalls: HTMLElement[]
  dialog: () => HTMLDialogElement; child: () => HTMLDialogElement | null; search: () => HTMLInputElement; title: () => HTMLInputElement
  parent: () => HTMLSelectElement; preview: () => HTMLElement; removeButton: () => HTMLButtonElement
  childCancel: () => HTMLButtonElement; childConfirm: () => HTMLButtonElement; items: () => string[]
  change: (callback: () => void | Promise<void>) => Promise<void>; fill: (input: HTMLInputElement | HTMLSelectElement, value: string) => Promise<void>
  prepare: () => Promise<void>; openRemove: () => Promise<void>; cancelChild: () => Promise<void>; confirmChild: () => Promise<void>
  succeed: (index?: number) => Promise<void>; fail: (index?: number) => Promise<void>; flush: () => Promise<void>
  render: () => Promise<void>; removeParent: () => Promise<void>; foreground: (value: boolean) => void; draft: () => string[]
}

function focused(context: Context, target: Element, message?: string) {
  assert.equal(context.document.activeElement === target, true, message ?? `Expected focus on ${target.tagName}`)
}

async function withTemplates(run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<button id="opener">Templates</button><input id="outside" aria-label="Outside editor"><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  const history: FrameRequestCallback[] = [], focusCalls: HTMLElement[] = [], requests: Request[] = [], calls = { close: 0, create: 0 }
  let nextFrame = 0, foreground = true, mounted = true, stored = [alpha, beta]
  const requestFrame = (callback: FrameRequestCallback) => { history.push(callback); frames.set(++nextFrame, callback); return nextFrame }
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
  // Visible, connected dialogs receive real focus delegation; JSDOM itself supplies no layout.
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
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
    return this.matches('.app-confirm-body') ? 220 : 80
  } })
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    listDocumentTemplates: async () => stored,
    deleteDocumentTemplate: (id: string) => {
      const request = { ...deferred(), id, settled: false }
      requests.push(request)
      return request.promise
    }
  } })
  const { createRoot } = await import('react-dom/client')
  // Load the genuine second-root implementation after a DOM exists; never replace confirmAction or its dialog.
  await import('../src/renderer/src/components/showConfirmation')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void | Promise<void>) => { await act(async () => { await callback() }) }
  const render = () => change(() => {
    setActiveUiLanguage('en-US')
    root.render(createElement(DocumentTemplateDialog, { isZh: false, documentTree: tree,
      onClose: () => { calls.close++; root.render(null) }, onCreate: async () => { calls.create++ } }))
  })
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>('.document-template-dialog')!
  const child = () => dom.window.document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
  const search = () => dialog().querySelector<HTMLInputElement>('input[type="search"]')!
  const title = () => dialog().querySelector<HTMLInputElement>('[name="document-title"]')!
  const parent = () => dialog().querySelector<HTMLSelectElement>('select')!
  const removeButton = () => dialog().querySelector<HTMLButtonElement>('.document-template-delete')!
  const childCancel = () => child()!.querySelector<HTMLButtonElement>('footer .secondary-button')!
  const childConfirm = () => child()!.querySelector<HTMLButtonElement>('footer .danger-button')!
  const fill = (input: HTMLInputElement | HTMLSelectElement, value: string) => change(() => {
    const prototype = input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
  const flush = () => change(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(0)
  })
  const succeed = (index = 0) => change(() => {
    const request = requests[index]
    assert.equal(request.settled, false)
    request.settled = true
    stored = stored.filter(template => template.id !== request.id)
    request.resolve()
  })
  const fail = (index = 0) => change(() => {
    assert.equal(requests[index].settled, false)
    requests[index].settled = true
    requests[index].reject(new Error('Template deletion failed; the original recipe is retained'))
  })
  dom.window.document.getElementById('opener')!.focus()
  try {
    await render()
    const context: Context = { document: dom.window.document, window: dom.window, requests, calls, frames, history, focusCalls,
      dialog, child, search, title, parent, removeButton, childCancel, childConfirm, change, fill, flush, succeed, fail, render,
      preview: () => dialog().querySelector<HTMLElement>('.document-template-preview')!,
      items: () => [...dialog().querySelectorAll('.document-template-item strong')].map(element => element.textContent!),
      foreground: value => { foreground = value }, removeParent: () => change(() => root.render(null)),
      draft: () => [title().value, parent().value, search().value],
      prepare: async () => {
        await fill(search(), 'Lease')
        await fill(title(), 'Manual template title')
        await fill(parent(), 'parent')
        await change(() => { title().focus(); title().setSelectionRange(2, 7) })
        await flush()
        focusCalls.length = 0
      },
      openRemove: () => change(() => { removeButton().focus(); removeButton().click() }),
      cancelChild: () => change(() => { childCancel().focus(); childCancel().click() }),
      confirmChild: () => change(() => { childConfirm().focus(); childConfirm().click() }) }
    await run(context)
  } finally {
    // Finish any genuine separate-root confirmation so confirmAction's single-flight state cannot leak to another test.
    await change(() => {
      for (const request of requests) if (!request.settled) { request.settled = true; request.resolve() }
    })
    if (child() && !childCancel().disabled) await change(() => childCancel().click())
    if (mounted) { mounted = false; await act(async () => root.unmount()) }
    setActiveUiLanguage('zh-CN')
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

async function opened(context: Context) {
  await context.prepare()
  const draft = context.draft()
  await context.openRemove()
  assert.equal(context.child()?.open, true)
  assert.equal(context.dialog().contains(context.child()), false, 'The actual confirmation is portalled from its own React root')
  assert.equal(context.child()!.querySelector('h2')!.textContent, 'Delete template “Lease Alpha”')
  assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
  assert.equal(context.removeButton().disabled, true)
  focused(context, context.childCancel())
  return draft
}

function settledParent(context: Context, draft: string[], deleted: boolean) {
  assert.equal(context.child(), null)
  assert.equal(context.dialog().getAttribute('aria-busy'), 'false')
  assert.deepEqual(context.draft(), draft)
  assert.deepEqual(context.items(), deleted ? ['Lease Beta'] : ['Lease Alpha', 'Lease Beta'])
  assert.equal(context.dialog().querySelector('[role="alert"]'), null)
  assert.deepEqual(context.calls, { close: 0, create: 0 })
}

test('normal nested template cancellation and deletion return to Search once while preserving title and location', async () => {
  for (const outcome of ['cancel', 'success'] as const) await withTemplates(async context => {
    const draft = await opened(context)
    context.focusCalls.length = 0
    if (outcome === 'cancel') await context.cancelChild()
    else {
      await context.confirmChild()
      assert.deepEqual(context.requests.map(request => request.id), ['alpha'])
      await context.succeed()
    }
    settledParent(context, draft, outcome === 'success')
    const callbacks = [...context.frames.values()]
    await context.flush()
    focused(context, context.search())
    assert.equal(context.focusCalls.filter(element => element === context.search()).length, 1)
    await context.change(() => { for (const callback of callbacks) callback(0) })
    assert.equal(context.focusCalls.filter(element => element === context.search()).length, 1, 'Copied child and parent restore callbacks cannot replay a consumed handoff')
    assert.deepEqual([context.title().selectionStart, context.title().selectionEnd], [2, 7])
    assert.equal(context.requests.length, outcome === 'cancel' ? 0 : 1)
  })
})

test('a real deletion rejection stays in the child for retry and successful retry returns to Search once', async () => {
  await withTemplates(async context => {
    const draft = await opened(context)
    await context.confirmChild()
    await context.fail()
    assert.equal(context.child()!.querySelector('[role="alert"]')!.textContent, 'Template deletion failed; the original recipe is retained')
    assert.equal(context.childConfirm().textContent, 'Retry')
    assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
    assert.deepEqual(context.items(), ['Lease Alpha', 'Lease Beta'])
    focused(context, context.childCancel())
    await context.confirmChild()
    assert.deepEqual(context.requests.map(request => request.id), ['alpha', 'alpha'])
    context.focusCalls.length = 0
    await context.succeed(1)
    settledParent(context, draft, true)
    await context.flush()
    focused(context, context.search())
    assert.equal(context.focusCalls.filter(element => element === context.search()).length, 1)
  })
})

test('new Title or preview focus after child closure cancels both queued restore layers, including ABA back to BODY', async () => {
  for (const outcome of ['cancel', 'success'] as const) for (const destination of ['title', 'preview', 'title-body'] as const) await withTemplates(async context => {
    const draft = await opened(context)
    if (outcome === 'cancel') await context.cancelChild()
    else { await context.confirmChild(); await context.succeed() }
    settledParent(context, draft, outcome === 'success')
    const callbacks = [...context.history]
    const target = destination === 'preview' ? context.preview() : context.title()
    await context.change(() => {
      target.focus()
      if (target instanceof context.window.HTMLInputElement) target.setSelectionRange(1, 5)
      if (destination === 'title-body') target.blur()
    })
    focused(context, destination === 'title-body' ? context.document.body : target)
    context.focusCalls.length = 0
    await context.flush()
    await context.change(() => { for (const callback of callbacks) callback(0) })
    focused(context, destination === 'title-body' ? context.document.body : target)
    assert.equal(context.focusCalls.length, 0, 'Neither old Delete opener nor Search may override the newer focus owner')
    assert.deepEqual(context.draft(), draft)
    if (destination !== 'preview') assert.deepEqual([context.title().selectionStart, context.title().selectionEnd], [1, 5])
  })
})

test('queued pointer, keyboard, composition and window blur permanently veto both nested return callbacks', async () => {
  for (const activity of ['pointer', 'key', 'composition', 'window-blur'] as const) await withTemplates(async context => {
    const draft = await opened(context)
    await context.cancelChild()
    settledParent(context, draft, false)
    const callbacks = [...context.history]
    await context.change(() => {
      if (activity === 'pointer') context.title().dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else if (activity === 'key') context.dialog().dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      else if (activity === 'composition') context.title().dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
      else context.window.dispatchEvent(new context.window.Event('blur'))
    })
    const owner = context.document.activeElement
    context.focusCalls.length = 0
    await context.flush()
    await context.change(() => {
      if (activity === 'composition') context.title().dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true }))
      if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('focus'))
      for (const callback of callbacks) callback(0)
    })
    focused(context, owner!)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.draft(), draft)
  })
})

test('the enabled parent handoff root can blur to BODY without allowing either old close callback to restore focus', async () => {
  await withTemplates(async context => {
    const draft = await opened(context)
    await context.cancelChild()
    settledParent(context, draft, false)
    const callbacks = [...context.history]
    focused(context, context.dialog(), 'Normal child cleanup hands ownership to the enabled parent before its queued Search restoration')
    assert.equal(context.dialog().matches(':disabled'), false)
    await context.change(() => context.dialog().blur())
    focused(context, context.document.body)
    context.focusCalls.length = 0
    await context.flush()
    await context.change(() => { for (const callback of callbacks) callback(0) })
    focused(context, context.document.body)
    assert.equal(context.focusCalls.length, 0)
    settledParent(context, draft, false)
  })
})

test('a foreign modal or unfocused document cancels queued nested focus without reviving after the blocker leaves', async () => {
  for (const blocker of ['foreign-modal', 'document-unfocused'] as const) await withTemplates(async context => {
    const draft = await opened(context)
    await context.cancelChild()
    const callbacks = [...context.history], foreign = context.document.createElement('dialog')
    foreign.open = true
    foreign.setAttribute('aria-modal', 'true')
    if (blocker === 'foreign-modal') context.document.body.append(foreign)
    else context.foreground(false)
    const owner = context.document.activeElement
    context.focusCalls.length = 0
    await context.flush()
    foreign.remove()
    context.foreground(true)
    await context.change(() => { for (const callback of callbacks) callback(0) })
    focused(context, owner!)
    assert.equal(context.focusCalls.length, 0)
    settledParent(context, draft, false)
  })
})

test('late deletion success or rejection after parent unmount and reopen cannot mutate or focus the new picker', async () => {
  for (const outcome of ['success', 'failure'] as const) await withTemplates(async context => {
    await opened(context)
    await context.confirmChild()
    assert.deepEqual(context.requests.map(request => request.id), ['alpha'])
    const previousDialog = context.dialog()
    await context.removeParent()
    await context.render()
    const fresh = context.dialog()
    assert.notEqual(fresh, previousDialog)
    await context.fill(context.search(), 'Lease')
    await context.fill(context.title(), 'Fresh picker draft')
    await context.fill(context.parent(), 'parent')
    const freshDraft = context.draft()
    await context.change(() => { context.title().focus(); context.title().setSelectionRange(1, 4) })
    const title = context.title()
    context.focusCalls.length = 0
    if (outcome === 'success') await context.succeed()
    else await context.fail()
    // The old child may still show its failure. Do not interact with it before checking the late result's focus effects.
    const callbacks = [...context.history]
    await context.flush()
    await context.change(() => { for (const callback of callbacks) callback(0) })
    assert.equal(context.dialog(), fresh)
    focused(context, title)
    assert.deepEqual(context.draft(), freshDraft)
    assert.deepEqual([title.selectionStart, title.selectionEnd], [1, 4])
    assert.deepEqual(context.items(), ['Lease Alpha', 'Lease Beta'])
    assert.equal(fresh.querySelector('[role="alert"]'), null)
    assert.equal(fresh.getAttribute('aria-busy'), 'false')
    assert.equal(context.removeButton().disabled, false)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.calls, { close: 0, create: 0 })
  })
})
