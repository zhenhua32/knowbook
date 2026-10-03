import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { GlobalSearchResult } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: GlobalSearchPalette } = await import('../src/renderer/src/components/GlobalSearchPalette')
type Props = Parameters<typeof GlobalSearchPalette>[0]
const results: GlobalSearchResult[] = [
  { documentId: 'alpha', documentTitle: 'Needle Alpha', documentPath: 'Notes/Needle Alpha', matchType: 'block', blockId: 'alpha-block', blockType: 'paragraph', snippet: 'The exact first Needle paragraph.' },
  { documentId: 'beta', documentTitle: 'Needle Beta', documentPath: 'Notes/Needle Beta', matchType: 'block', blockId: 'beta-block', blockType: 'paragraph', snippet: 'The exact second Needle paragraph.' }
]
const originalData = { title: 'Untouched current draft', content: 'Unsaved current paragraph', targetBodies: results.map(result => result.snippet) }
const failure = 'Could not switch documents. Your draft and search are preserved. Resolve the save error and retry.'
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred<boolean>> & { result: GlobalSearchResult; documentOnly: boolean; query: string; settled: boolean }
type CopyRequest = ReturnType<typeof deferred<void>> & { text: string }
type FocusCall = { element: HTMLElement; disabled: boolean; activeAfter: Element | null }
type Origin = 'input' | 'go' | 'open'
type Context = {
  document: Document; window: JSDOM['window']; requests: Request[]; copies: CopyRequest[]; focusCalls: FocusCall[]
  frames: Map<number, FrameRequestCallback>; history: FrameRequestCallback[]; calls: { close: number; notify: number }
  dialog: () => HTMLDialogElement; input: () => HTMLInputElement; closeButton: () => HTMLButtonElement; mode: () => HTMLButtonElement
  go: () => HTMLButtonElement; open: () => HTMLButtonElement; copy: () => HTMLButtonElement; selected: () => string | null
  query: () => string; data: () => string; change: (callback: () => void) => Promise<void>
  fillQuery: (value: string) => Promise<void>; externalQuery: (value: string) => Promise<void>; activate: (origin: Origin) => Promise<void>
  pressEnter: () => Promise<void>; fail: (index?: number) => Promise<void>; flush: () => Promise<void>; replay: (callbacks: FrameRequestCallback[]) => Promise<void>
  foreground: (value: boolean) => void; render: () => Promise<void>; remove: () => Promise<void>
}
function focused(context: Context, target: Element, message?: string) {
  assert.equal(context.document.activeElement === target, true, message ?? `Expected focus on ${target.tagName}`)
}

async function withPalette(run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<button id="opener">Open palette</button><input id="outside"><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  const history: FrameRequestCallback[] = [], focusCalls: FocusCall[] = [], requests: Request[] = [], copies: CopyRequest[] = []
  const calls = { close: 0, notify: 0 }
  let frameId = 0, foreground = true, generation = 0, currentQuery = 'Needle'
  let updateQuery!: (value: string) => void
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
  dom.window.HTMLElement.prototype.scrollIntoView = function () {}
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 480, 80) }
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
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) {
    const disabled = this.matches(':disabled')
    nativeFocus.call(this, options)
    focusCalls.push({ element: this, disabled, activeAfter: dom.window.document.activeElement })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: { writeClipboardText: (text: string) => {
    const request = { ...deferred<void>(), text }
    copies.push(request)
    return request.promise
  } } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  function Harness() {
    const [query, setQuery] = useState('Needle')
    currentQuery = query; updateQuery = setQuery
    const documents = {
      globalSearchQuery: query, globalSearchResults: results, globalSearchLoading: false, globalSearchError: null,
      selectedDocument: null, selectedDocumentId: 'current', draftTitle: originalData.title, detailLoading: false, documentLoadError: null,
      updateGlobalSearchQuery: setQuery, retryGlobalSearch: () => {},
      closeGlobalSearch: () => { calls.close++; root.render(null) },
      handleGlobalSearchNavigate: (result: GlobalSearchResult, documentOnly: boolean) => {
        const request = { ...deferred<boolean>(), result: { ...result }, documentOnly, query, settled: false }
        requests.push(request)
        return request.promise
      }
    } as unknown as Props['documents']
    const shell = { isZh: false, ui: getUiText('en-US'), workspaceReady: true, workspaceError: null,
      homeData: { recentDocuments: [] }, pageItems: [{ id: 'settings', label: 'Settings', description: 'Preferences' }],
      isNavCollapsed: false, toggleNavCollapse: () => {}, setActivePage: () => {}, openWorkspaceSearch: () => {},
      notify: () => { calls.notify++ } } as unknown as Props['shell']
    const workspace = { handleCreateDocument: async () => {}, handleBackup: async () => {}, handleRestoreBackup: async () => {} } as unknown as Props['workspace']
    return createElement(GlobalSearchPalette, { documents, shell, workspace })
  }
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>('.global-search-modal')!
  const input = () => dialog().querySelector<HTMLInputElement>('.global-search-input')!
  const closeButton = () => dialog().querySelector<HTMLButtonElement>('.global-search-header button')!
  const mode = () => dialog().querySelector<HTMLButtonElement>('.palette-mode')!
  const action = (text: string) => [...dialog().querySelectorAll<HTMLButtonElement>('.palette-result-actions button')].find(button => button.textContent === text)!
  const go = () => action('Go to block'), open = () => action('Open document'), copy = () => action('Copy document link')
  const render = () => change(() => root.render(createElement(Harness, { key: ++generation })))
  const pressEnter = () => change(() => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input().dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
  })
  const normalizeDisabledBlur = () => change(() => {
    const origin = dom.window.document.activeElement
    if (!(origin instanceof dom.window.HTMLElement) || !origin.matches(':disabled')) return
    const disabledAttribute = origin.getAttribute('disabled')
    assert.notEqual(disabledAttribute, null, 'Palette action buttons own their committed disabled attribute')
    const observed: boolean[] = []
    const restoreDisabled = () => origin.setAttribute('disabled', disabledAttribute!)
    const observeFocusout = () => { observed.push(origin.matches(':disabled')) }
    // JSDOM's blur entry guard rejects disabled controls. Its genuine blur event
    // precedes focusout, so restore the committed state before production reads it.
    origin.addEventListener('blur', restoreDisabled, { capture: true, once: true })
    origin.addEventListener('focusout', observeFocusout)
    try {
      origin.removeAttribute('disabled')
      origin.blur()
      assert.equal(dom.window.document.activeElement, dom.window.document.body)
      assert.deepEqual(observed, [true], 'Native focusout must expose the actual disabled commit, not an enabled voluntary blur')
    } finally {
      origin.setAttribute('disabled', disabledAttribute!)
      origin.removeEventListener('blur', restoreDisabled, true)
      origin.removeEventListener('focusout', observeFocusout)
    }
  })
  const flush = () => change(() => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0) })
  dom.window.document.getElementById('opener')!.focus()
  try {
    await render()
    focused({ document: dom.window.document } as Context, input())
    focusCalls.length = 0; history.length = 0
    await run({ document: dom.window.document, window: dom.window, requests, copies, focusCalls, frames, history, calls,
      dialog, input, closeButton, mode, go, open, copy, query: () => currentQuery, data: () => JSON.stringify(originalData),
      selected: () => input().getAttribute('aria-activedescendant'), change, render, pressEnter, flush,
      remove: () => change(() => root.render(null)), foreground: value => { foreground = value },
      replay: callbacks => change(() => { for (const callback of callbacks) callback(0) }),
      externalQuery: value => change(() => updateQuery(value)),
      fillQuery: value => change(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
        input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      activate: async origin => {
        await change(() => (origin === 'input' ? input() : origin === 'go' ? go() : open()).focus())
        if (origin === 'input') await pressEnter()
        else await change(() => (origin === 'go' ? go() : open()).click())
        await normalizeDisabledBlur()
      },
      fail: (index = 0) => change(() => { requests[index].settled = true; requests[index].resolve(false) }) })
  } finally {
    await act(async () => root.unmount())
    await act(async () => { for (const request of requests) if (!request.settled) request.resolve(false); for (const request of copies) request.resolve() })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

async function accepted(context: Context, origin: Origin = 'go') {
  const data = context.data(), selected = context.selected(), query = context.query()
  await context.activate(origin)
  assert.equal(context.requests.length, 1)
  assert.deepEqual(context.requests[0].result, results[0])
  assert.equal(context.requests[0].documentOnly, origin === 'open')
  assert.equal(context.requests[0].query, query)
  assert.equal(context.dialog().querySelector('[role="listbox"]')!.getAttribute('aria-busy'), 'true')
  assert.equal(context.go().disabled, true)
  context.focusCalls.length = 0; context.history.length = 0
  return { data, selected, query }
}
function settled(context: Context, state: { data: string; selected: string | null; query: string }, feedback = true) {
  assert.equal(context.dialog().querySelector('[role="listbox"]')!.getAttribute('aria-busy'), 'false')
  assert.equal(context.go().disabled, false)
  assert.equal(context.query(), state.query)
  assert.equal(context.selected(), state.selected)
  assert.equal(context.data(), state.data)
  assert.equal(context.requests.length, 1)
  assert.deepEqual(context.calls, { close: 0, notify: 0 })
  if (feedback) assert.equal(context.dialog().querySelector('[role="alert"]')!.textContent, failure)
}
function queryFocusCalls(context: Context) { return context.focusCalls.filter(call => call.element === context.input()) }

test('ordinary input Enter, Go and document-only Open false responses focus the enabled query once and preserve selection for immediate retry', async () => {
  for (const origin of ['input', 'go', 'open'] as const) await withPalette(async context => {
    const state = await accepted(context, origin)
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    settled(context, state)
    focused(context, context.input())
    assert.deepEqual(queryFocusCalls(context).map(call => ({ disabled: call.disabled, active: call.activeAfter === context.input() })), [{ disabled: false, active: true }])
    await context.replay(callbacks)
    assert.equal(queryFocusCalls(context).length, 1)
    context.focusCalls.length = 0
    await context.pressEnter()
    assert.equal(context.requests.length, 2)
    assert.deepEqual(context.requests[1].result, results[0])
    assert.equal(context.requests[1].documentOnly, false)
    await context.fail(1); await context.flush()
    focused(context, context.input())
    assert.equal(queryFocusCalls(context).length, 1)
    assert.equal(context.query(), state.query)
    assert.equal(context.data(), state.data)
  })
})

test('pending Close or external focus and an enabled query blur including BODY ABA veto old query focus while retaining failure feedback', async () => {
  for (const destination of ['close', 'external-body', 'query-body', 'query-body-query'] as const) await withPalette(async context => {
    const queryOrigin = destination === 'query-body' || destination === 'query-body-query'
    const state = await accepted(context, queryOrigin ? 'input' : 'go')
    const outside = context.document.getElementById('outside')!
    await context.change(() => {
      if (destination === 'close') context.closeButton().focus()
      else if (!queryOrigin) { outside.focus(); outside.blur() }
      else {
        assert.equal(context.input().matches(':disabled'), false)
        context.input().blur()
        focused(context, context.document.body)
        if (destination === 'query-body-query') context.input().focus()
      }
    })
    const owner = context.document.activeElement
    context.focusCalls.length = 0
    await context.fail()
    const callbacks = [...context.history]
    await context.flush(); await context.replay(callbacks)
    settled(context, state)
    focused(context, owner!)
    assert.equal(queryFocusCalls(context).length, 0)
  })
})

test('new pending pointer, keyboard or IME intent permanently vetoes recovery focus without swallowing the false response', async () => {
  for (const intent of ['pointer', 'key', 'composition'] as const) await withPalette(async context => {
    const state = await accepted(context)
    await context.change(() => {
      if (intent === 'pointer') context.closeButton().dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else if (intent === 'key') context.dialog().dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      else context.input().dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
    })
    const owner = context.document.activeElement
    context.focusCalls.length = 0
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    await context.change(() => { if (intent === 'composition') context.input().dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })) })
    await context.replay(callbacks)
    settled(context, state)
    focused(context, owner!)
    assert.equal(queryFocusCalls(context).length, 0)
  })
})

test('changed query, changed selection and command mode suppress old action ownership without changing the draft or forcing query focus', async () => {
  for (const change of ['typed-query', 'external-query', 'selection', 'commands'] as const) await withPalette(async context => {
    const state = await accepted(context, 'input')
    if (change === 'typed-query') await context.fillQuery('Needle revised')
    else if (change === 'external-query') await context.externalQuery('Needle external')
    else if (change === 'selection') await context.change(() => context.input().dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    else await context.change(() => { context.mode().focus(); context.mode().click() })
    const owner = context.document.activeElement, query = context.query(), selection = context.selected()
    context.focusCalls.length = 0
    await context.fail()
    const callbacks = [...context.history]
    await context.flush(); await context.replay(callbacks)
    assert.equal(context.query(), query)
    assert.equal(context.selected(), selection)
    focused(context, owner!)
    assert.equal(queryFocusCalls(context).length, 0)
    assert.equal(context.dialog().querySelector('[role="listbox"]')!.getAttribute('aria-busy'), 'false')
    assert.equal(context.dialog().querySelector('.palette-action-feedback'), null)
    assert.equal(context.data(), state.data)
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].result, results[0])
    assert.deepEqual(context.calls, { close: 0, notify: 0 })
  })
})

test('window blur, background renderer and a newer foreign modal veto old recovery even after their conditions are reversed', async () => {
  for (const blocker of ['window-blur', 'background', 'foreign-modal'] as const) await withPalette(async context => {
    const state = await accepted(context), foreign = context.document.createElement('dialog')
    await context.change(() => {
      if (blocker === 'window-blur') context.window.dispatchEvent(new context.window.Event('blur'))
      else if (blocker === 'background') context.foreground(false)
      else { foreign.open = true; foreign.setAttribute('aria-modal', 'true'); context.document.body.append(foreign) }
    })
    const owner = context.document.activeElement
    context.focusCalls.length = 0
    await context.fail()
    const callbacks = [...context.history]
    await context.flush()
    foreign.remove(); context.foreground(true)
    await context.change(() => context.window.dispatchEvent(new context.window.Event('focus')))
    await context.replay(callbacks)
    settled(context, state)
    focused(context, owner!)
    assert.equal(queryFocusCalls(context).length, 0)
  })
})

test('late false responses and copied callbacks from an unmounted palette cannot unlock, report or focus a fresh palette instance', async () => {
  await withPalette(async context => {
    await accepted(context)
    const original = context.dialog(), callbacks = [...context.history]
    await context.remove(); await context.render()
    const fresh = context.dialog(), freshInput = context.input()
    assert.notEqual(fresh, original)
    await context.fillQuery('Needle fresh')
    await context.change(() => { freshInput.focus(); freshInput.setSelectionRange(2, 7) })
    await context.pressEnter()
    assert.equal(context.requests.length, 2)
    assert.deepEqual(context.requests[1].result, results[0])
    assert.equal(context.requests[1].documentOnly, false)
    assert.equal(context.requests[1].query, 'Needle fresh')
    assert.equal(context.dialog().querySelector('[role="listbox"]')!.getAttribute('aria-busy'), 'true')
    context.focusCalls.length = 0
    await context.fail(); await context.flush(); await context.replay(callbacks)
    assert.equal(context.dialog(), fresh)
    focused(context, freshInput)
    assert.equal(context.input().value, 'Needle fresh')
    assert.deepEqual([freshInput.selectionStart, freshInput.selectionEnd], [2, 7])
    assert.equal(context.dialog().querySelector('[role="listbox"]')!.getAttribute('aria-busy'), 'true', 'The old finally must not unlock the new instance request')
    assert.equal(context.dialog().querySelector('[role="alert"]'), null)
    assert.equal(context.dialog().querySelector('.palette-action-feedback')!.textContent, 'Opening…')
    assert.equal(queryFocusCalls(context).length, 0)
    assert.deepEqual(context.calls, { close: 0, notify: 0 })
    assert.equal(context.requests.length, 2)
    await context.fail(1); await context.flush()
    focused(context, freshInput)
    assert.equal(context.dialog().querySelector('[role="listbox"]')!.getAttribute('aria-busy'), 'false')
    assert.equal(context.dialog().querySelector('[role="alert"]')!.textContent, failure)
    assert.equal(queryFocusCalls(context).length, 1)
    assert.equal(context.input().value, 'Needle fresh')
    assert.deepEqual([freshInput.selectionStart, freshInput.selectionEnd], [2, 7])
  })
})

test('existing copy single-flight and successful navigation branches do not acquire false-response query recovery focus', async () => {
  for (const action of ['copy', 'successful-open'] as const) await withPalette(async context => {
    if (action === 'copy') {
      const copy = context.copy()
      await context.change(() => { copy.focus(); copy.click(); copy.click() })
      assert.equal(context.copies.length, 1)
      assert.equal(copy.disabled, false)
      assert.equal(copy.getAttribute('aria-disabled'), 'true')
      focused(context, copy)
      context.focusCalls.length = 0
      await context.change(() => context.copies[0].resolve())
      await context.flush()
      focused(context, copy)
      assert.equal(context.dialog().querySelector('.palette-action-feedback')!.textContent, 'Document link copied. Paste it into another document.')
      assert.equal(context.requests.length, 0)
    } else {
      await accepted(context)
      context.focusCalls.length = 0
      await context.change(() => { context.requests[0].settled = true; context.requests[0].resolve(true) })
      await context.flush()
      assert.equal(context.dialog().querySelector('.palette-action-feedback'), null)
      assert.equal(context.go().disabled, false)
      assert.equal(context.requests.length, 1)
    }
    assert.equal(queryFocusCalls(context).length, 0)
    assert.deepEqual(context.calls, { close: 0, notify: 0 })
    assert.equal(context.data(), JSON.stringify(originalData))
  })
})
