import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
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

type Kind = 'capture' | 'create-template' | 'save-template'
const kinds: Kind[] = ['capture', 'create-template', 'save-template']
const tree: DocumentTreeNode[] = [{ id: 'parent', title: 'Parent folder', path: 'Parent folder', updatedAt: '2026-10-03', children: [] }]
const recipe: DocumentTemplate = {
  id: 'recipe', name: 'Recipe Alpha', description: 'An existing template', title: 'Automatic recipe title', summary: 'Template summary',
  blocks: [{ type: 'paragraph', content: 'Existing template content', checked: false, depth: 0 }], builtIn: false
}
const source = { title: 'Original document title', summary: 'Original document summary',
  blocks: [{ type: 'paragraph' as const, content: 'Original draft content', checked: false, depth: 0 }] }

function deferred() {
  let resolve!: (value?: unknown) => void, reject!: (error: Error) => void
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred> & { payload: unknown }
type Input = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
type FrameSnapshot = { kind: Kind; dialogPresent: boolean; busy: string | null; targetDisabled: boolean | null }
type Context = {
  kind: Kind; document: Document; window: JSDOM['window']; requests: Request[]; calls: { close: number; saved: number }
  frames: Map<number, FrameRequestCallback>; frameHistory: FrameRequestCallback[]; frameSnapshots: FrameSnapshot[]; focusCalls: HTMLElement[]
  dialog: () => HTMLDialogElement; primary: () => HTMLInputElement | HTMLTextAreaElement; other: () => Input
  change: (callback: () => void) => Promise<void>; fill: (input: Input, value: string) => Promise<void>
  prepare: () => Promise<void>; submit: () => Promise<void>; fail: (index?: number) => Promise<void>
  flush: () => Promise<void>; foreground: (value: boolean) => void; render: () => Promise<void>; remove: () => Promise<void>
  draft: () => string[]; payload: () => unknown; resetFocusCalls: () => void
}

function focused(context: Context, target: Element, message?: string) {
  assert.equal(context.document.activeElement === target, true, message ?? `Expected ${target.tagName} to retain focus`)
}

async function withDialog(kind: Kind, run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<button id="opener">Open writing dialog</button><input id="outside" aria-label="Outside editor"><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  const frameHistory: FrameRequestCallback[] = [], focusCalls: HTMLElement[] = [], requests: Request[] = [], calls = { close: 0, saved: 0 }
  const frameSnapshots: FrameSnapshot[] = []
  let frameId = 0, foreground = true, rootMounted = true
  const requestFrame = (callback: FrameRequestCallback) => {
    const modal = dom.window.document.querySelector<HTMLDialogElement>(kind === 'capture' ? '.document-quick-capture-dialog'
      : kind === 'create-template' ? '.document-template-dialog' : '.document-save-template-dialog')
    const target = modal?.querySelector<HTMLElement>(kind === 'capture' ? 'textarea' : kind === 'create-template' ? '[name="document-title"]' : 'input')
    frameSnapshots.push({ kind, dialogPresent: !!modal, busy: modal?.getAttribute('aria-busy') ?? null, targetDisabled: target ? target.matches(':disabled') : null })
    frameHistory.push(callback)
    frames.set(++frameId, callback)
    return frameId
  }
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
  // JSDOM does not perform layout. Only connected visible elements in an open dialog get geometry.
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
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const enqueue = (payload: unknown) => {
    const request = { ...deferred(), payload }
    requests.push(request)
    return request.promise
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    listDocumentTemplates: async () => [recipe],
    saveDocumentTemplate: (input: SaveDocumentTemplateInput) => enqueue(input)
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const close = () => { calls.close++; root.render(null) }
  const render = async () => {
    const element = kind === 'capture' ? createElement(QuickCaptureDialog, {
      isZh: false, documentTree: tree, onClose: close, onSave: async input => { await enqueue(input) }
    }) : kind === 'create-template' ? createElement(DocumentTemplateDialog, {
      isZh: false, documentTree: tree, onClose: close, onCreate: async input => { await enqueue(input) }
    }) : createElement(SaveDocumentTemplateDialog, { isZh: false, source, onClose: close, onSaved: () => { calls.saved++ } })
    await act(async () => root.render(element))
  }
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>(kind === 'capture' ? '.document-quick-capture-dialog'
    : kind === 'create-template' ? '.document-template-dialog' : '.document-save-template-dialog')!
  const primary = () => kind === 'capture' ? dialog().querySelector<HTMLTextAreaElement>('textarea')!
    : kind === 'create-template' ? dialog().querySelector<HTMLInputElement>('[name="document-title"]')!
    : dialog().querySelector<HTMLInputElement>('input')!
  const other = (): Input => kind === 'capture' ? dialog().querySelector<HTMLInputElement>('input')!
    : kind === 'create-template' ? dialog().querySelector<HTMLSelectElement>('select')!
    : dialog().querySelector<HTMLTextAreaElement>('textarea')!
  const fill = (input: Input, value: string) => change(() => {
    const prototype = input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype
      : input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
  const draft = () => kind === 'capture' ? [primary().value, other().value, dialog().querySelector<HTMLSelectElement>('select')!.value]
    : kind === 'create-template' ? [primary().value, other().value, dialog().querySelector<HTMLInputElement>('input[type="search"]')!.value]
    : [primary().value, other().value]
  const payload = () => kind === 'capture' ? { content: 'Captured markdown **draft**\nSecond line', title: 'Manual note title', parentId: 'parent' }
    : kind === 'create-template' ? { templateId: 'recipe', title: 'Manual template title', parentId: 'parent', language: 'en-US' }
    : { ...source, name: 'Saved recipe name', description: 'Preserved recipe description' }
  const flush = () => change(() => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  })
  const remove = () => change(() => root.render(null))
  const unmount = async () => { if (rootMounted) { rootMounted = false; await act(async () => root.unmount()) } }
  dom.window.document.getElementById('opener')!.focus()
  try {
    await render()
    const context: Context = { kind, document: dom.window.document, window: dom.window, requests, calls, frames, frameHistory, frameSnapshots, focusCalls,
      dialog, primary, other, change, fill, draft, payload, flush, render, remove, foreground: value => { foreground = value },
      resetFocusCalls: () => { focusCalls.length = 0 },
      prepare: async () => {
        await fill(primary(), kind === 'capture' ? 'Captured markdown **draft**\nSecond line' : kind === 'create-template' ? 'Manual template title' : 'Saved recipe name')
        await fill(other(), kind === 'capture' ? 'Manual note title' : kind === 'create-template' ? 'parent' : 'Preserved recipe description')
        if (kind === 'capture') await fill(dialog().querySelector<HTMLSelectElement>('select')!, 'parent')
        if (kind === 'create-template') await fill(dialog().querySelector<HTMLInputElement>('input[type="search"]')!, 'Recipe')
        await flush()
        focusCalls.length = 0
      },
      submit: () => change(() => {
        primary().focus()
        primary().setSelectionRange(2, 7)
        const event = new dom.window.Event('submit', { bubbles: true, cancelable: true })
        dialog().querySelector('form')!.dispatchEvent(event)
        assert.equal(event.defaultPrevented, true)
      }),
      fail: (index = 0) => change(() => requests[index].reject(new Error('Provider failed; the submitted draft is retained'))) }
    await run(context)
  } finally {
    await unmount()
    await act(async () => requests.forEach(request => request.resolve(recipe)))
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

async function accepted(context: Context) {
  await context.prepare()
  const before = context.draft()
  await context.submit()
  assert.equal(context.requests.length, 1)
  assert.deepEqual(context.requests[0].payload, context.payload())
  assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
  assert.equal(context.primary().matches(':disabled'), true)
  focused(context, context.dialog())
  context.resetFocusCalls()
  context.frameSnapshots.length = 0
  return before
}

function retainedFailure(context: Context, before: string[]) {
  assert.deepEqual(context.draft(), before)
  assert.deepEqual(context.requests[0].payload, context.payload())
  assert.equal(context.dialog().getAttribute('aria-busy'), 'false')
  assert.equal(context.primary().matches(':disabled'), false)
  assert.equal(context.dialog().querySelector('[role="alert"]')!.textContent, 'Provider failed; the submitted draft is retained')
  assert.deepEqual(context.calls, { close: 0, saved: 0 })
}

test('normal failed writing actions focus Content, Title or Name once after commit without changing draft, payload or selection', async () => {
  for (const kind of kinds) await withDialog(kind, async context => {
    const before = await accepted(context), target = context.primary()
    await context.fail()
    retainedFailure(context, before)
    focused(context, context.dialog(), 'The failed commit does not focus until the original RAF runs')
    const callback = context.frameHistory.at(-1)!
    assert.equal(context.frames.size > 0, true)
    assert.equal(context.frameSnapshots.length > 0, true)
    assert.equal(context.frameSnapshots.every(snapshot => snapshot.dialogPresent && snapshot.busy === 'false' && snapshot.targetDisabled === false), true,
      `Failure focus RAF must be arranged after the enabled DOM commit: ${JSON.stringify(context.frameSnapshots)}`)
    await context.flush()
    focused(context, target)
    assert.equal(context.focusCalls.filter(element => element === target).length, 1)
    assert.deepEqual([target.selectionStart, target.selectionEnd], [2, 7])
    await context.change(() => callback(0)) // A queued callback delivered twice must consume the lease only once.
    assert.equal(context.focusCalls.filter(element => element === target).length, 1)
    assert.deepEqual(context.draft(), before)
  })
})

test('an enabled template preview selected during submission retains focus while the failure and draft still settle', async () => {
  await withDialog('create-template', async context => {
    const before = await accepted(context), target = context.primary()
    const preview = context.dialog().querySelector<HTMLElement>('.document-template-preview')!
    assert.equal(preview.tabIndex, 0)
    await context.change(() => preview.focus())
    await context.fail()
    retainedFailure(context, before)
    await context.flush()
    focused(context, preview)
    assert.equal(context.focusCalls.filter(element => element === target).length, 0)
  })
})

test('queued failure focus is permanently abandoned by new pointer, key, IME composition or window blur activity', async () => {
  for (const kind of kinds) for (const activity of ['pointer', 'key', 'composition', 'window-blur'] as const) await withDialog(kind, async context => {
    const before = await accepted(context), target = context.primary()
    await context.fail()
    const callback = context.frameHistory.at(-1)!, current = context.other()
    await context.change(() => {
      if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
      else if (activity === 'pointer') current.dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else if (activity === 'key') context.dialog().dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      else current.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true, data: '候选文字' }))
    })
    // Returning the renderer to foreground or ending composition cannot revive an abandoned lease.
    await context.change(() => {
      if (activity === 'window-blur') context.window.dispatchEvent(new context.window.Event('focus'))
      if (activity === 'composition') current.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true }))
    })
    await context.flush()
    await context.change(() => callback(0))
    focused(context, context.dialog())
    assert.equal(context.focusCalls.filter(element => element === target).length, 0, `${kind}: ${activity} must not replay focus`)
    retainedFailure(context, before)
  })
})

test('queued focus cannot steal a newer editable field or resume after an ABA transition back to BODY', async () => {
  for (const kind of kinds) for (const returnToBody of [false, true]) await withDialog(kind, async context => {
    const before = await accepted(context), target = context.primary()
    await context.fail()
    const callback = context.frameHistory.at(-1)!, current = context.other()
    await context.change(() => { current.focus(); if (returnToBody) current.blur() })
    focused(context, returnToBody ? context.document.body : current)
    await context.flush()
    await context.change(() => callback(0))
    focused(context, returnToBody ? context.document.body : current)
    assert.equal(context.focusCalls.filter(element => element === target).length, 0)
    retainedFailure(context, before)
  })
})

test('blurring the enabled dialog root to BODY permanently abandons pending or queued restoration', async () => {
  for (const kind of kinds) for (const phase of ['pending', 'queued'] as const) await withDialog(kind, async context => {
    const before = await accepted(context), target = context.primary()
    if (phase === 'queued') await context.fail()
    const callback = phase === 'queued' ? context.frameHistory.at(-1)! : null
    assert.equal(context.dialog().matches(':disabled'), false)
    await context.change(() => context.dialog().blur())
    focused(context, context.document.body)
    if (phase === 'pending') await context.fail()
    await context.flush()
    if (callback) await context.change(() => callback(0))
    focused(context, context.document.body)
    assert.equal(context.focusCalls.filter(element => element === target).length, 0)
    retainedFailure(context, before)
  })
})

test('busy keyboard, disabled-field pointer or IME input cancels focus eligibility without cancelling single-flight error handling', async () => {
  for (const kind of kinds) for (const activity of ['repeat-submit', 'disabled-pointer', 'composition'] as const) await withDialog(kind, async context => {
    const before = await accepted(context), target = context.primary()
    await context.change(() => {
      if (activity === 'repeat-submit') {
        context.dialog().dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: kind === 'capture', bubbles: true }))
        context.dialog().querySelector('form')!.dispatchEvent(new context.window.Event('submit', { bubbles: true, cancelable: true }))
      } else if (activity === 'disabled-pointer') target.dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else target.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
    })
    assert.equal(context.requests.length, 1)
    await context.fail()
    if (activity === 'composition') await context.change(() => target.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
    await context.flush()
    focused(context, context.dialog())
    assert.equal(context.focusCalls.filter(element => element === target).length, 0)
    retainedFailure(context, before)
  })
})

test('a foreign visible modal or an unfocused document consumes queued restoration and cannot replay after becoming eligible again', async () => {
  for (const kind of kinds) for (const blocker of ['modal', 'document-unfocused'] as const) await withDialog(kind, async context => {
    const before = await accepted(context), target = context.primary()
    await context.fail()
    const callback = context.frameHistory.at(-1)!
    const foreign = context.document.createElement('dialog')
    foreign.setAttribute('aria-modal', 'true')
    foreign.setAttribute('role', 'dialog')
    foreign.open = true
    if (blocker === 'modal') context.document.body.append(foreign)
    else context.foreground(false)
    await context.flush()
    focused(context, context.dialog())
    foreign.remove()
    context.foreground(true)
    await context.change(() => callback(0))
    assert.equal(context.focusCalls.filter(element => element === target).length, 0)
    retainedFailure(context, before)
  })
})

test('successful actions cancel failure restoration before close and never focus the removed form again', async () => {
  for (const kind of kinds) await withDialog(kind, async context => {
    await accepted(context)
    const target = context.primary(), modal = context.dialog()
    await context.change(() => context.requests[0].resolve(recipe))
    assert.equal(modal.isConnected, false)
    assert.deepEqual(context.calls, { close: 1, saved: kind === 'save-template' ? 1 : 0 })
    await context.flush()
    assert.equal(context.focusCalls.filter(element => element === target).length, 0)
    assert.equal(context.requests.length, 1)
  })
})

test('programmatic submission without foreground or owned focus still settles its request but cannot claim failure focus', async () => {
  for (const kind of kinds) for (const origin of ['outside', 'document-unfocused'] as const) await withDialog(kind, async context => {
    await context.prepare()
    const before = context.draft(), modal = context.dialog()
    if (origin === 'outside') await context.change(() => context.document.getElementById('outside')!.focus())
    else context.foreground(false)
    context.resetFocusCalls()
    // This explicitly models a programmatic form submission, not an unfocused native click.
    await context.change(() => modal.querySelector('form')!.dispatchEvent(new context.window.Event('submit', { bubbles: true, cancelable: true })))
    assert.equal(context.requests.length, 1)
    assert.equal(modal.getAttribute('aria-busy'), 'true')
    assert.equal(context.focusCalls.length, 0, 'An ineligible begin must not hand focus to the dialog')
    await context.fail()
    context.foreground(true)
    await context.flush()
    assert.equal(context.focusCalls.length, 0)
    if (origin === 'outside') focused(context, context.document.getElementById('outside')!)
    retainedFailure(context, before)
  })
})

test('unmounting and reopening cannot apply an old failure or old queued callback to a new writing dialog', async () => {
  for (const kind of kinds) for (const phase of ['pending', 'success-pending', 'queued'] as const) await withDialog(kind, async context => {
    await accepted(context)
    const original = context.primary()
    if (phase === 'queued') await context.fail()
    const callback = phase === 'queued' ? context.frameHistory.at(-1)! : null
    await context.remove()
    await context.render()
    const fresh = context.primary(), freshDialog = context.dialog()
    assert.notEqual(fresh, original)
    // The fresh dialog's ordinary initial focus is the baseline; the old callback must not add a focus call.
    const newOwner = context.document.activeElement
    context.resetFocusCalls()
    if (phase === 'pending') await context.fail()
    if (phase === 'success-pending') await context.change(() => context.requests[0].resolve(recipe))
    await context.flush()
    if (callback) await context.change(() => callback(0))
    focused(context, newOwner!)
    assert.equal(context.dialog(), freshDialog)
    assert.equal(freshDialog.querySelector('[role="alert"]'), null)
    assert.equal(freshDialog.getAttribute('aria-busy'), 'false')
    assert.equal(context.focusCalls.filter(element => element === original || element === fresh).length, 0)
    assert.deepEqual(context.calls, { close: 0, saved: 0 })
  })
})
