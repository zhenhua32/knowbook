import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { getErrorMessage } from '../src/renderer/src/utils/errorMessage'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DatabaseFormDialog } = await import('../src/renderer/src/features/database/components/DatabaseDialogs')

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type State = { name: string; description: string; error: string | null; busy: boolean; open: boolean }
type Request = ReturnType<typeof deferred> & { name: string; description: string }
type Context = {
  document: Document; text: ReturnType<typeof getDatabaseWorkspaceText>; requests: Request[]; focusCalls: HTMLElement[]
  form: () => HTMLFormElement; name: () => HTMLInputElement; description: () => HTMLTextAreaElement; submitButton: () => HTMLButtonElement
  change: (run: () => void) => Promise<void>; fill: (input: HTMLInputElement | HTMLTextAreaElement, value: string) => Promise<void>
  setError: (value: string | null) => Promise<void>; submit: () => Promise<void>; reject: (error: Error, index?: number) => Promise<void>
  resolve: (index?: number) => Promise<void>; flushFrames: () => Promise<void>
}
const failureText = (locale: string) => locale === 'zh-CN' ? '保存失败，输入已保留，可以重试。'
  : 'Could not save. Your input has been kept. Try again.'
const detailsText = (locale: string) => locale === 'zh-CN' ? '错误详情' : 'Error details'

async function withFeedback(run: (context: Context) => Promise<void>, locale = 'en-US', withDescription = true) {
  const dom = new JSDOM('<button id="opener">Open</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: requestFrame })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: cancelFrame })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 160, 32) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.closest('[hidden], [inert], [aria-hidden="true"]') ? [] : [this.getBoundingClientRect()]
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const focusCalls: HTMLElement[] = []
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const requests: Request[] = []
  const text = getDatabaseWorkspaceText(locale)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true, updateState!: (update: SetStateAction<State>) => void
  function Harness() {
    const [state, setState] = useState<State>({ name: 'Kept name', description: 'Kept description', error: null, busy: false, open: true })
    updateState = setState
    const submit = async () => {
      const request = { ...deferred(), name: state.name, description: state.description }
      requests.push(request)
      setState(previous => ({ ...previous, busy: true, error: null }))
      try { await request.promise; if (mounted) setState(previous => ({ ...previous, open: false })) }
      catch (error) { if (mounted) setState(previous => ({ ...previous, error: getErrorMessage(error, text.failed) })) }
      finally { if (mounted) setState(previous => ({ ...previous, busy: false })) }
    }
    return createElement(DatabaseFormDialog, { name: state.name, description: state.description, error: state.error, busy: state.busy,
      open: state.open, text, title: withDescription ? text.editDatabase : text.rename, withDescription,
      returnFocusTarget: dom.window.document.getElementById('opener'), canReturnFocus: () => true,
      onCancel: () => setState(previous => ({ ...previous, open: false })), onSubmit: () => { void submit() },
      onNameChange: name => setState(previous => ({ ...previous, name })),
      onDescriptionChange: description => setState(previous => ({ ...previous, description })) })
  }
  const change = async (run: () => void) => { await act(async () => run()) }
  const flushFrames = async () => change(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) })
  const form = () => { const element = dom.window.document.querySelector<HTMLFormElement>('form.dbw-dialog'); assert.ok(element); return element }
  const name = () => form().querySelector<HTMLInputElement>('label input')!
  const description = () => form().querySelector<HTMLTextAreaElement>('label textarea')!
  const submitButton = () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!
  try {
    await act(async () => root.render(createElement(Harness)))
    await flushFrames()
    await run({ document: dom.window.document, text, requests, focusCalls, form, name, description, submitButton, change, flushFrames,
      fill: async (input, value) => change(() => {
        const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      setError: value => change(() => updateState(previous => ({ ...previous, error: value }))),
      submit: () => change(() => form().dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))),
      reject: (error, index = 0) => change(() => requests[index].reject(error)),
      resolve: (index = 0) => change(() => requests[index].resolve()) })
  } finally {
    mounted = false
    await act(async () => root.unmount())
    await act(async () => { for (const request of requests) request.resolve() })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}
function mainAlert(context: Context) {
  assert.equal(context.form().querySelectorAll('[role="alert"]').length, 1)
  return context.form().querySelector<HTMLElement>('[role="alert"]')!
}
function details(context: Context) {
  const element = context.form().querySelector<HTMLDetailsElement>('details.dbw-form-error-details')
  assert.ok(element)
  return element
}

test('database and view failures show a localized recovery message, with the actual SQLite cause folded and associated with retry', async () => {
  for (const locale of ['en-US', 'zh-CN']) for (const withDescription of [true, false]) {
    await withFeedback(async context => {
      await context.submit()
      const reason = 'SqliteError: Database metadata is temporarily unavailable.'
      await context.reject(new Error(`Error invoking remote method 'knowbook:update-database-metadata': ${reason}`))
      const alert = mainAlert(context), disclosure = details(context)
      assert.equal(alert.textContent, failureText(locale))
      assert.equal(alert.textContent!.includes('SqliteError'), false)
      assert.equal(disclosure.open, false)
      assert.equal(disclosure.querySelector('summary')!.textContent, detailsText(locale))
      assert.equal(disclosure.textContent!.includes(reason), true)
      assert.equal(disclosure.textContent!.includes('Error invoking remote method'), false)
      assert.equal(alert.id.length > 0, true)
      assert.equal(context.submitButton().getAttribute('aria-describedby'), alert.id)
      assert.equal(context.name().value, 'Kept name')
      if (withDescription) assert.equal(context.description().value, 'Kept description')
      assert.equal(context.name().readOnly, false)
      assert.equal(context.submitButton().disabled, false)
    }, locale, withDescription)
  }
})

test('absent errors show no failure UI and an empty native reason uses the recovery message without duplicate fallback details', async () => {
  for (const locale of ['en-US', 'zh-CN']) await withFeedback(async context => {
    for (const value of [null, '']) {
      await context.setError(value)
      assert.equal(context.form().querySelectorAll('[role="alert"], details.dbw-form-error-details').length, 0)
      assert.equal(context.submitButton().hasAttribute('aria-describedby'), false)
    }
    await context.submit()
    await context.reject(new Error())
    assert.equal(mainAlert(context).textContent, failureText(locale))
    assert.equal(context.form().querySelectorAll('details.dbw-form-error-details').length, 0)
    assert.equal(context.form().textContent!.includes(context.text.failed), false)
    assert.equal(context.name().value, 'Kept name')
    assert.equal(context.description().value, 'Kept description')
  }, locale)
})

test('exception details retain full literal diagnostic text without creating HTML elements', async () => {
  await withFeedback(async context => {
    const reason = 'SqliteError: <img src="x" onerror="window.injected=true"> & <script>window.injected=true</script>\nKeep "quoted" detail.'
    await context.submit()
    await context.reject(new Error(`Error invoking remote method 'knowbook:create-document-database': Error: ${reason}`))
    assert.equal(mainAlert(context).textContent, failureText('en-US'))
    const disclosure = details(context)
    assert.equal(disclosure.open, false)
    assert.equal(disclosure.textContent!.includes(reason), true)
    assert.equal(context.form().querySelectorAll('img, script, [onerror]').length, 0)
    assert.equal(context.name().value, 'Kept name')
  })
})

test('failure does not move keyboard focus or replace drafts, and details can be focused before editing and submitting a retry', async () => {
  for (const locale of ['en-US', 'zh-CN']) for (const withDescription of [true, false]) {
    await withFeedback(async context => {
      const focused = withDescription ? context.description() : context.name()
      await context.change(() => focused.focus())
      await context.submit()
      assert.equal(context.document.activeElement === focused, true)
      const firstCall = context.focusCalls.length
      await context.reject(new Error('SqliteError: Write unavailable.'))
      await context.flushFrames()
      assert.equal(context.document.activeElement === focused, true)
      assert.equal(context.focusCalls.length, firstCall, 'Error feedback must not programmatically focus a different control')
      const disclosure = details(context), summary = disclosure.querySelector<HTMLElement>('summary')!
      await context.change(() => summary.focus())
      assert.equal(context.document.activeElement === summary, true)
      // These synthetic keys only check that application handlers preserve
      // the native default; real summary Enter/Space activation is covered in Electron.
      for (const key of ['Enter', ' ']) {
        const event = new context.document.defaultView!.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        await context.change(() => summary.dispatchEvent(event))
        assert.equal(event.defaultPrevented, false)
        assert.equal(context.requests.length, 1)
      }
      await context.change(() => { summary.click() })
      assert.equal(disclosure.open, true)
      await context.change(() => context.name().focus())
      await context.fill(context.name(), 'Retry name')
      if (withDescription) await context.fill(context.description(), 'Retry description')
      await context.submit()
      assert.equal(context.requests.length, 2)
      assert.equal(context.requests[1].name, 'Retry name')
      assert.equal(context.requests[1].description, withDescription ? 'Retry description' : 'Kept description')
      assert.equal(context.form().querySelectorAll('[role="alert"], details.dbw-form-error-details').length, 0)
      assert.equal(context.submitButton().hasAttribute('aria-describedby'), false)
      assert.equal(context.document.activeElement === context.name(), true)
      await context.resolve(1)
      assert.equal(context.document.querySelectorAll('form.dbw-dialog').length, 0)
    }, locale, withDescription)
  }
})
