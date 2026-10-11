import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, StrictMode, Suspense, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import { waitForRenderer } from './helpers/renderer-async'
import type { DocumentRenameTarget, RenameTitleResult } from '../src/renderer/src/hooks/useDocumentEditorState'
import { useDocumentRenameOpening, type DocumentRenameOpening } from '../src/renderer/src/pages/documentRenameOpening'
import { lazyWithRetry } from '../src/renderer/src/utils/lazyWithRetry'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: DocumentRenameDialog } = await import('../src/renderer/src/components/DocumentRenameDialog')
const { DocumentPreviewHeader } = await import('../src/renderer/src/components/DocumentPreviewHeader')
const { getUiText, setActiveUiLanguage } = await import('../src/renderer/src/i18n')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred<RenameTitleResult>> & { name: string; target: DocumentRenameTarget }
type FocusCall = { element: HTMLElement; disabled: boolean; options?: FocusOptions }
type Context = {
  document: Document; window: JSDOM['window']; requests: Request[]; calls: { shown: number; restored: number }
  focusCalls: FocusCall[]; frames: Map<number, FrameRequestCallback>; history: FrameRequestCallback[]
  outside: HTMLInputElement; title: () => HTMLButtonElement; more: () => HTMLButtonElement
  dialog: () => HTMLDialogElement | null; field: () => HTMLInputElement; opening: () => DocumentRenameOpening | null
  change: (callback: () => void) => Promise<void>; fill: (value: string) => Promise<void>; open: (entry?: 'title' | 'more') => Promise<void>
  load: () => Promise<void>; submit: () => Promise<void>; cancel: () => Promise<void>; flush: () => Promise<void>
  settle: (result: RenameTitleResult, index?: number) => Promise<void>; fail: (index?: number) => Promise<void>
  setTarget: (next: DocumentRenameTarget | null) => Promise<void>; setLoading: (value: boolean) => Promise<void>
  remove: () => Promise<void>; foreground: (value: boolean) => void
  key: (key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
}

async function withRename(run: (context: Context) => Promise<void>, options: { isZh?: boolean; delayed?: boolean; strict?: boolean; nativeCloseFocus?: boolean } = {}) {
  const dom = new JSDOM('<input id="outside"><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  const history: FrameRequestCallback[] = [], focusCalls: FocusCall[] = [], requests: Request[] = [], calls = { shown: 0, restored: 0 }
  let frameId = 0, foreground = true, target: DocumentRenameTarget | null = { documentId: 'alpha', session: 1, title: 'Original title' }
  let activeOpening: DocumentRenameOpening | null = null, detailLoading = false
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
  const nativeOpeners = new WeakMap<HTMLDialogElement, HTMLElement | null>()
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    calls.shown++
    const active = dom.window.document.activeElement
    nativeOpeners.set(this, active instanceof dom.window.HTMLElement ? active : null)
    this.open = true
  }
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false
    const opener = nativeOpeners.get(this)
    // Native dialog close restores its invoker unless the host has made it inert.
    if (options.nativeCloseFocus && opener?.isConnected && !opener.closest('[inert]')) opener.focus()
  }
  // Supply geometry only; use JSDOM's native focus and disabled-field behavior.
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
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (focusOptions) {
    const disabled = this.matches(':disabled')
    nativeFocus.call(this, focusOptions)
    focusCalls.push({ element: this, disabled, options: focusOptions })
  }
  const loader = deferred<{ default: typeof DocumentRenameDialog }>()
  const LazyDialog = lazyWithRetry<ComponentProps<typeof DocumentRenameDialog>>(() => options.delayed ? loader.promise : Promise.resolve({ default: DocumentRenameDialog }))
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const isZh = options.isZh === true
  const noAction = () => {}
  function Harness() {
    const rename = useDocumentRenameOpening(() => target)
    activeOpening = rename.opening
    const opening = rename.opening
    return createElement('div', null,
      createElement(DocumentPreviewHeader, {
        ui: getUiText(isZh ? 'zh-CN' : 'en-US'), isZh, selectedDocumentId: target?.documentId ?? null,
        selectedDocumentTitle: target?.title ?? null, isPinned: false, onTogglePin: noAction,
        mdCopyFlash: false, onCopyMarkdown: noAction, onSaveMarkdown: noAction, onAddChild: noAction,
        canUndo: false, canRedo: false, onUndo: noAction, onRedo: noAction, isSaving: false, onSave: noAction,
        onDelete: noAction, moveTargetId: '', moveOptions: [], onMoveTargetChange: noAction, onMove: noAction,
        documentsAuxPanelOpen: false, onToggleAuxPanel: noAction, documentsWideMode: false, onToggleWideMode: noAction,
        detailLoading, onRename: opener => rename.open(opener, () => { calls.restored++ })
      }),
      opening && createElement(Suspense, { fallback: null }, createElement(LazyDialog, {
        key: opening.key, opening, isZh,
        onRename: name => {
          const request = { ...deferred<RenameTitleResult>(), name, target: opening.target }
          requests.push(request)
          return request.promise
        }
      })))
  }
  const render = () => change(() => {
    setActiveUiLanguage(isZh ? 'zh-CN' : 'en-US')
    root.render(options.strict ? createElement(StrictMode, null, createElement(Harness)) : createElement(Harness))
  })
  const dialog = () => dom.window.document.querySelector<HTMLDialogElement>('.document-rename-dialog')
  const field = () => dialog()!.querySelector<HTMLInputElement>('input')!
  const title = () => dom.window.document.querySelector<HTMLButtonElement>('.document-header-title-button')!
  const more = () => dom.window.document.querySelector<HTMLButtonElement>('.document-header-more-button')!
  const outside = dom.window.document.getElementById('outside') as HTMLInputElement
  const flush = () => change(() => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0) })
  try {
    await render()
    const context: Context = {
      document: dom.window.document, window: dom.window, requests, calls, focusCalls, frames, history, outside, dialog, field, title, more,
      opening: () => activeOpening, change, flush, foreground: value => { foreground = value },
      remove: () => change(() => root.render(null)),
      load: async () => { await change(() => loader.resolve({ default: DocumentRenameDialog }));
        await waitForRenderer(() => activeOpening === null || dialog()?.open === true, 'The rename load must resolve or become obsolete') },
      setTarget: async next => { target = next; await render() },
      setLoading: async value => { detailLoading = value; await render() },
      fill: value => change(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field(), value)
        field().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      open: async (entry = 'title') => {
        if (entry === 'title') await change(() => { title().focus(); title().click() })
        else {
          await change(() => { more().focus(); more().click() })
          const menu = dom.window.document.querySelector('.document-header-action-menu')!
          const button = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === (isZh ? '重命名文档' : 'Rename document'))!
          await change(() => { button.focus(); button.click() })
          assert.equal(dom.window.document.querySelector('.document-header-action-menu'), null)
        }
        if (!options.delayed) await waitForRenderer(() => dialog()?.open === true, 'The real rename dialog must open')
      },
      submit: () => change(() => {
        field().focus()
        const event = new dom.window.Event('submit', { bubbles: true, cancelable: true })
        dialog()!.querySelector('form')!.dispatchEvent(event)
        assert.equal(event.defaultPrevented, true)
      }),
      cancel: () => change(() => {
        const button = dialog()!.querySelector<HTMLButtonElement>('footer .secondary-button')!
        button.focus(); button.click()
      }),
      settle: (result, index = 0) => change(() => requests[index].resolve(result)),
      fail: (index = 0) => change(() => requests[index].reject(new Error('Storage unavailable'))),
      key: async (key, keyboardOptions = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...keyboardOptions })
        await change(() => dom.window.document.activeElement!.dispatchEvent(event))
        return event as unknown as KeyboardEvent
      }
    }
    await run(context)
  } finally {
    try { await act(async () => root.unmount()) }
    finally {
      setActiveUiLanguage('zh-CN')
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
      dom.window.close()
    }
  }
}

function focused(context: Context, element: Element) { assert.equal(context.document.activeElement === element, true) }
function returnsTo(context: Context, opener: HTMLElement) { return context.focusCalls.filter(call => call.element === opener) }
function cleanClose(context: Context, opener: HTMLElement, writes: number, restores: number) {
  assert.equal(context.dialog(), null)
  assert.equal(context.requests.length, writes)
  assert.equal(context.calls.restored, restores)
  const calls = returnsTo(context, opener)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].disabled, false)
  assert.deepEqual(calls[0].options, { preventScroll: true })
  focused(context, opener)
}

test('Reading title and More action use one localized, selected form and preserve local candidates on cancellation', async () => {
  for (const isZh of [false, true]) for (const entry of ['title', 'more'] as const) await withRename(async context => {
    const opener = entry === 'title' ? context.title() : context.more()
    assert.equal(context.title().getAttribute('aria-label'), isZh ? '重命名文档' : 'Rename document')
    assert.equal(context.title().querySelector('.document-header-title')!.getAttribute('title'), 'Original title')
    assert.equal(context.title().getAttribute('aria-haspopup'), 'dialog')
    await context.open(entry)
    const field = context.field()
    focused(context, field)
    assert.equal(field.value, 'Original title')
    assert.deepEqual([field.selectionStart, field.selectionEnd], [0, field.value.length])
    assert.equal(context.dialog()!.querySelector('h2')!.textContent, isZh ? '重命名文档' : 'Rename document')
    assert.equal(field.closest('label')!.textContent, isZh ? '文档名称' : 'Document name')
    assert.equal(context.dialog()!.querySelector('footer .primary-button')!.textContent, isZh ? '重命名' : 'Rename')
    assert.equal(context.dialog()!.querySelector('footer .secondary-button')!.textContent, isZh ? '取消' : 'Cancel')
    await context.fill('Candidate not committed')
    assert.equal(context.requests.length, 0)
    assert.equal(context.title().querySelector('.document-header-title')!.textContent, 'Original title')
    context.focusCalls.length = 0
    await context.cancel()
    cleanClose(context, opener, 0, 0)
    await context.flush()
    assert.equal(returnsTo(context, opener).length, 1)
  }, { isZh })
})

test('An unchanged trimmed title closes without a write or viewport restoration; blank names stay in the form', async () => {
  await withRename(async context => {
    await context.open()
    await context.fill('   ')
    assert.equal(context.dialog()!.querySelector<HTMLButtonElement>('footer .primary-button')!.disabled, true)
    await context.submit()
    assert.equal(context.requests.length, 0)
    assert.equal(context.dialog()!.querySelector('[role="alert"]')!.textContent, 'Enter a document name.')
    focused(context, context.field())
    await context.fill('  Original title  ')
    context.focusCalls.length = 0
    await context.submit()
    cleanClose(context, context.title(), 0, 0)
  })
})

test('Detail loading blocks both rename entries and an empty selection retains a noninteractive title', async () => {
  await withRename(async context => {
    await context.setLoading(true)
    assert.equal(context.title().disabled, true)
    await context.change(() => { context.more().focus(); context.more().click() })
    const menu = context.document.querySelector('.document-header-action-menu')!
    assert.equal([...menu.querySelectorAll('button')].some(button => button.textContent === 'Rename document'), false)
    assert.equal(context.opening(), null)
    await context.key('Escape')
    await context.setLoading(false)
    await context.open()
    await context.cancel()
    await context.setTarget(null)
    assert.equal(context.document.querySelector('.document-header-title-button'), null)
    assert.equal(context.document.querySelector('.document-header-more-button'), null)
    assert.equal(context.document.querySelector('.document-header-title')!.textContent, getUiText('en-US').selectDocument)
  })
})

test('A cold More-menu rename waits for its chunk and returns to the real More trigger, including Escape', async () => {
  await withRename(async context => {
    const opener = context.more()
    await context.open('more')
    assert.equal(context.dialog(), null)
    assert.equal(context.opening()!.opener === opener, true)
    focused(context, opener)
    await context.load()
    focused(context, context.field())
    context.focusCalls.length = 0
    const escape = await context.key('Escape')
    assert.equal(escape.defaultPrevented, true)
    cleanClose(context, opener, 0, 0)
  }, { delayed: true })
})

test('Cold rename requests permanently relinquish attention on activity, window blur, foreign focus or a competing modal', async () => {
  for (const activity of ['pointer', 'keyboard', 'composition', 'focus-away-back', 'window-blur', 'foreign-modal'] as const) await withRename(async context => {
    await context.open('more')
    await context.change(() => {
      if (activity === 'pointer') context.outside.dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else if (activity === 'keyboard') context.window.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowDown' }))
      else if (activity === 'composition') context.outside.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
      else if (activity === 'focus-away-back') { context.outside.focus(); context.more().focus() }
      else if (activity === 'window-blur') { context.foreground(false); context.window.dispatchEvent(new context.window.Event('blur')); context.foreground(true) }
      else { const modal = context.document.createElement('dialog'); modal.open = true; context.document.body.append(modal) }
    })
    const active = context.document.activeElement
    context.focusCalls.length = 0
    await context.load()
    assert.equal(context.dialog(), null, activity)
    assert.equal(context.calls.shown, 0, activity)
    assert.equal(context.calls.restored, 0, activity)
    assert.equal(context.focusCalls.length, 0, activity)
    assert.equal(context.document.activeElement === active, true, activity)
    assert.equal(context.opening(), null, activity)
  }, { delayed: true })
})

test('Document selection and same-ID editor sessions invalidate cold requests; revisiting cannot revive their restore closure', async () => {
  for (const sameId of [false, true]) await withRename(async context => {
    await context.open()
    const obsolete = context.opening()!
    await context.setTarget({ documentId: sameId ? 'alpha' : 'beta', session: 2, title: 'Fresh document' })
    await context.setTarget({ documentId: 'alpha', session: 3, title: 'Revisited alpha' })
    await context.load()
    assert.equal(context.dialog(), null)
    assert.equal(context.calls.shown, 0)
    await context.change(() => obsolete.saved())
    assert.equal(context.calls.restored, 0)
    assert.equal(context.opening(), null)
  }, { delayed: true })
})

test('Failure and busy results preserve the candidate, restore enabled field focus and allow one successful retry', async () => {
  for (const failure of ['failed', 'busy', 'throw'] as const) await withRename(async context => {
    await context.open()
    await context.fill('  Renamed title  ')
    await context.submit()
    assert.equal(context.requests[0].name, 'Renamed title')
    assert.deepEqual(context.requests[0].target, { documentId: 'alpha', session: 1, title: 'Original title' })
    assert.equal(context.dialog()!.getAttribute('aria-busy'), 'true')
    assert.equal(context.field().matches(':disabled'), true)
    focused(context, context.dialog()!)
    await context.submit()
    assert.equal(context.requests.length, 1, 'The synchronous lock must block double submission')
    // Ordinary save ACKs keep this exact dialog and its local candidate alive.
    const dialog = context.dialog()
    await context.setTarget({ documentId: 'alpha', session: 1, title: 'Acknowledged old title' })
    assert.equal(context.dialog() === dialog, true)
    assert.equal(context.field().value, '  Renamed title  ')
    if (failure === 'throw') await context.fail()
    else await context.settle(failure === 'failed' ? { status: 'failed', message: 'Storage unavailable' } : { status: 'busy' })
    assert.equal(context.dialog()!.getAttribute('aria-busy'), 'false')
    assert.equal(context.field().matches(':disabled'), false)
    assert.equal(context.field().value, '  Renamed title  ')
    assert.equal(context.dialog()!.querySelector('[role="alert"]')!.textContent,
      failure === 'busy' ? 'The document is saving. Try again shortly.' : 'Storage unavailable')
    assert.equal(context.calls.restored, 0)
    await context.flush()
    focused(context, context.field())
    await context.submit()
    assert.equal(context.requests.length, 2)
    context.focusCalls.length = 0
    await context.settle({ status: 'saved', title: 'Renamed title' }, 1)
    cleanClose(context, context.title(), 2, 1)
    await context.flush()
    assert.equal(context.calls.restored, 1)
    assert.equal(returnsTo(context, context.title()).length, 1)
  })
})

test('Deferred failure focus cannot steal attention after user input, foreign focus or window blur, even if a canceled frame is replayed', async () => {
  for (const activity of ['pointer', 'keyboard', 'composition', 'focus-away-back', 'window-blur'] as const) await withRename(async context => {
    await context.open()
    await context.fill('Retry candidate')
    await context.submit()
    await context.settle({ status: 'failed', message: 'Try again' })
    const oldFrames = [...context.history]
    context.focusCalls.length = 0
    await context.change(() => {
      if (activity === 'pointer') context.dialog()!.dispatchEvent(new context.window.Event('pointerdown', { bubbles: true }))
      else if (activity === 'keyboard') context.dialog()!.dispatchEvent(new context.window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
      else if (activity === 'composition') context.dialog()!.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
      else if (activity === 'focus-away-back') { context.outside.focus(); context.dialog()!.focus() }
      else { context.foreground(false); context.window.dispatchEvent(new context.window.Event('blur')); context.foreground(true) }
    })
    await context.flush()
    await context.change(() => { for (const callback of oldFrames) callback(0) })
    assert.equal(context.focusCalls.some(call => call.element === context.field()), false, activity)
    assert.equal(context.field().value, 'Retry candidate')
    assert.equal(context.calls.restored, 0)
  })
})

test('A stale result or fresh editor session closes without viewport restore or focusing an obsolete opener', async () => {
  for (const outcome of ['stale', 'new-session', 'unmount'] as const) await withRename(async context => {
    await context.open()
    const opener = context.title(), oldDialog = context.dialog()!
    await context.fill('Old session candidate')
    await context.submit()
    context.focusCalls.length = 0
    if (outcome === 'new-session') await context.setTarget({ documentId: 'alpha', session: 2, title: 'Fresh alpha' })
    else if (outcome === 'unmount') await context.remove()
    await context.settle(outcome === 'stale' ? { status: 'stale' } : { status: 'saved', title: 'Old session candidate' })
    await context.flush()
    assert.equal(context.dialog(), null)
    assert.equal(oldDialog.open, false)
    assert.equal(context.calls.restored, 0)
    assert.equal(returnsTo(context, opener).length, 0)
  }, { nativeCloseFocus: true })
})

test('Closing focus waits for an enabled opener but is vetoed if its editor session changes before the frame', async () => {
  for (const obsolete of [false, true]) await withRename(async context => {
    await context.open()
    const opener = context.title()
    await context.change(() => { opener.disabled = true })
    context.focusCalls.length = 0
    await context.cancel()
    assert.equal(context.dialog(), null)
    assert.equal(context.frames.size, 1)
    assert.equal(returnsTo(context, opener).length, 0)
    const oldFrames = [...context.history]
    if (obsolete) await context.setTarget({ documentId: 'alpha', session: 2, title: 'Fresh alpha' })
    await context.change(() => { opener.disabled = false })
    await context.flush()
    await context.change(() => { for (const callback of oldFrames) callback(0) })
    assert.equal(returnsTo(context, opener).length, obsolete ? 0 : 1)
    assert.equal(context.calls.restored, 0)
  })
})

test('Chinese composition, isComposing and legacy 229 keys cannot submit or cancel; committed names remain editable', async () => {
  await withRename(async context => {
    await context.open()
    await context.fill('知识笔记')
    await context.change(() => context.field().dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true, data: '知识笔记' })))
    await context.key('Enter')
    await context.key('Escape')
    await context.submit()
    assert.equal(context.requests.length, 0)
    assert.equal(context.dialog()!.open, true)
    assert.equal(context.field().value, '知识笔记')
    await context.change(() => context.field().dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true, data: '知识笔记' })))
    for (const keyboardOptions of [{ isComposing: true }, { keyCode: 229 }]) for (const key of ['Enter', 'Escape']) {
      const event = await context.key(key, keyboardOptions)
      assert.equal(event.defaultPrevented, true)
      assert.equal(context.requests.length, 0)
      assert.equal(context.dialog()!.open, true)
    }
    await context.submit()
    assert.equal(context.requests.length, 1)
    assert.equal(context.requests[0].name, '知识笔记')
    await context.settle({ status: 'failed', message: '请重试' })
    await context.flush()
    focused(context, context.field())
    assert.equal(context.field().value, '知识笔记')
    await context.cancel()
    assert.equal(context.calls.restored, 0)
  }, { isZh: true })
})

test('StrictMode opening replay retains one live form and normal close focus ownership', async () => {
  await withRename(async context => {
    await context.open()
    assert.equal(context.document.querySelectorAll('.document-rename-dialog').length, 1)
    assert.equal(context.dialog()!.open, true)
    focused(context, context.field())
    context.focusCalls.length = 0
    await context.cancel()
    cleanClose(context, context.title(), 0, 0)
  }, { strict: true })
})
