import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField, DocumentCatalogEntry } from '../src/shared/contracts'
import { CreateRecordDialog } from '../src/renderer/src/features/database/components/DatabaseRecordDrawer'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

type Props = ComponentProps<typeof CreateRecordDialog>
type Draft = Parameters<Props['onCreate']>[0]
function deferred() {
  let resolve!: (value: boolean) => void, reject!: (error: Error) => void
  const promise = new Promise<boolean>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred> & { draft: Draft; continueAdding: boolean }
const fields: DatabaseField[] = [{ id: 'notes', name: 'Notes', type: 'text', role: 'property', options: [],
  editable: true, hideable: true, deletable: true, sortOrder: 0 }]
const documents: DocumentCatalogEntry[] = [{ id: 'linked', title: 'Plan', path: 'Projects/Plan', parentId: null,
  parentTitle: null, updatedAt: '2026-10-02', summary: '', blockCount: 1, childCount: 0, linkCount: 0, fieldValues: {} }]

type Context = {
  document: Document; window: JSDOM['window']; requests: Request[]; cancelled: () => number
  dialog: () => HTMLElement; title: () => HTMLInputElement; notes: () => HTMLInputElement; linked: () => HTMLSelectElement
  primary: () => HTMLButtonElement; next: () => HTMLButtonElement; alert: () => string
  change: (callback: () => void) => Promise<void>; fill: (input: HTMLInputElement, value: string) => Promise<void>
  submit: () => Promise<Event>; key: (target: HTMLElement, key: string, options?: KeyboardEventInit) => Promise<KeyboardEvent>
  render: (open?: boolean, identity?: string) => Promise<void>
}

async function withCreate(run: (context: Context) => Promise<void>, language: 'zh-CN' | 'en-US' = 'en-US') {
  const dom = new JSDOM('<button id="opener">Create record</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  let frameId = 0, cancelled = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  dom.window.requestAnimationFrame = requestFrame
  dom.window.cancelAnimationFrame = cancelFrame
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(20, 20, 300, 40) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.isConnected && !this.closest('[hidden], [inert], [aria-hidden="true"]') ? [this.getBoundingClientRect()] : []
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const requests: Request[] = [], text = getDatabaseWorkspaceText(language)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const render = async (open = true, identity = 'source-a') => {
    await act(async () => root.render(createElement(CreateRecordDialog, {
      key: identity, open, fields, documents, text, onCancel: () => { cancelled++ },
      onCreate: (draft, continueAdding) => {
        const request = { ...deferred(), draft: structuredClone(draft), continueAdding }
        requests.push(request)
        return request.promise
      }
    })))
    await change(() => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    })
  }
  const dialog = () => dom.window.document.querySelector<HTMLElement>('.dbw-create-record-dialog')!
  const title = () => dialog().querySelector<HTMLInputElement>('.dbw-record-form input')!
  const notes = () => dialog().querySelector<HTMLInputElement>('[aria-label="Notes"]')!
  const primary = () => dialog().querySelector<HTMLButtonElement>('.dbw-primary-button')!
  const next = () => dialog().querySelector<HTMLButtonElement>('footer .dbw-quiet-button')!
  try {
    dom.window.document.getElementById('opener')!.focus()
    await render()
    await run({ document: dom.window.document, window: dom.window, requests, cancelled: () => cancelled,
      dialog, title, notes, primary, next, linked: () => dialog().querySelector('select')!,
      alert: () => dialog().querySelector('[role="alert"]')?.textContent ?? '', change, render,
      fill: (input, value) => change(() => {
        input.focus()
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      submit: async () => {
        const event = new dom.window.Event('submit', { bubbles: true, cancelable: true })
        // Synthetic Enter has no implicit form default in JSDOM; Electron verifies the actual key.
        await change(() => dialog().dispatchEvent(event))
        return event
      },
      key: async (target, key, options = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
        await change(() => target.dispatchEvent(event))
        return event
      }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('a DOM form submit performs ordinary Create with the complete draft in both languages, while incomplete titles never write', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withCreate(async context => {
      await context.fill(context.title(), 'Keyboard record')
      await context.fill(context.notes(), 'Retained property')
      await context.change(() => {
        context.linked().value = 'linked'
        context.linked().dispatchEvent(new context.window.Event('change', { bubbles: true }))
        context.title().focus()
      })
      const event = await context.submit()
      assert.equal(context.requests.length, 1, 'The actual submit event must reach record creation')
      assert.equal(event.defaultPrevented, true)
      assert.equal(context.requests[0].continueAdding, false)
      assert.deepEqual(context.requests[0].draft, { title: 'Keyboard record', documentId: 'linked', fieldValues: { notes: 'Retained property' } })
      assert.equal(context.primary().type, 'submit')
      assert.equal(context.next().type, 'button')
      assert.equal(context.dialog().tagName, 'FORM')
      assert.equal((context.dialog() as HTMLFormElement).noValidate, true)
      await context.change(() => context.requests[0].resolve(true))
      assert.equal(context.cancelled(), 1)
    }, language)
    await withCreate(async context => {
      for (const value of ['', '   ']) {
        await context.fill(context.title(), value)
        const event = await context.submit()
        assert.equal(event.defaultPrevented, true)
        assert.equal(context.requests.length, 0)
        assert.equal(context.primary().disabled, true)
        assert.equal(context.alert(), '')
      }
    }, language)
  }
})

test('explicit Continue and default Create share a same-frame lock without carrying continuation intent into a retry', async () => {
  for (const first of ['form', 'continue'] as const) await withCreate(async context => {
    await context.fill(context.title(), 'One accepted record')
    await context.fill(context.notes(), 'Kept retry value')
    await context.change(() => {
      const event = new context.window.Event('submit', { bubbles: true, cancelable: true })
      if (first === 'continue') { context.next().focus(); context.next().click() }
      context.dialog().dispatchEvent(event)
      if (first === 'form') context.next().click()
      context.primary().click()
    })
    assert.equal(context.requests.length, 1)
    assert.equal(context.requests[0].continueAdding, first === 'continue')
    assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
    await context.change(() => first === 'form'
      ? context.requests[0].resolve(false) : context.requests[0].reject(new Error('Private write failure')))
    assert.equal(context.title().value, 'One accepted record')
    assert.equal(context.notes().value, 'Kept retry value')
    assert.equal(context.alert(), getDatabaseWorkspaceText('en-US').formFailed)
    assert.equal(context.document.body.textContent!.includes('Private write failure'), false)
    await context.key(context.title(), 'Enter')
    await context.submit()
    assert.equal(context.requests.length, 2)
    assert.equal(context.requests[1].continueAdding, false, 'The form always uses ordinary Create, including after failed Continue')
    assert.deepEqual(context.requests[1].draft, context.requests[0].draft)
    assert.equal(context.alert(), '')
    await context.change(() => context.requests[1].resolve(true))
    assert.equal(context.cancelled(), 1)
  })
})

test('IME candidates cannot submit after composition ends, and ordinary keyboard or pointer actions can submit without swallowing candidate keys', async () => {
  for (const origin of ['lifecycle', 'native', 'key-code'] as const) for (const recovery of ['enter', 'pointer', 'blur'] as const) {
    await withCreate(async context => {
      await context.fill(context.title(), 'Composition draft')
      if (origin === 'lifecycle') await context.change(() => context.title().dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })))
      const options: KeyboardEventInit = origin === 'native' ? { isComposing: true } : origin === 'key-code' ? { keyCode: 229 } : {}
      const candidate = await context.key(context.title(), 'Enter', options)
      assert.equal(candidate.defaultPrevented, false)
      await context.change(() => context.title().dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
      const blocked = await context.submit()
      assert.equal(blocked.defaultPrevented, true)
      assert.equal(context.requests.length, 0)
      await context.change(() => context.next().click())
      assert.equal(context.requests.length, 0, 'The candidate guard also blocks explicit continuation until a fresh user action')
      if (recovery === 'enter') await context.key(context.title(), 'Enter')
      else if (recovery === 'pointer') await context.change(() => context.title().dispatchEvent(new context.window.Event('pointerdown', { bubbles: true })))
      else await context.change(() => context.title().blur())
      await context.submit()
      assert.equal(context.requests.length, 1)
      assert.equal(context.requests[0].continueAdding, false)
      await context.change(() => context.requests[0].resolve(false))
      assert.equal(context.title().value, 'Composition draft')
    })
  }
  await withCreate(async context => {
    await context.fill(context.title(), 'IME Escape draft')
    await context.change(() => context.title().dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })))
    await context.key(context.title(), 'Escape')
    assert.equal(context.cancelled(), 0)
    assert.equal(context.requests.length, 0)
    await context.render(false)
    await context.render()
    await context.fill(context.title(), 'Fresh reopened draft')
    await context.submit()
    assert.equal(context.requests.length, 1, 'A new form session does not inherit an old composition latch')
    await context.change(() => context.requests[0].resolve(false))
  })
})

test('property editor Enter remains local, and a late form submission cannot clear or close a newer create session', async () => {
  await withCreate(async context => {
    await context.fill(context.title(), 'Property record')
    await context.fill(context.notes(), 'Committed property')
    const property = context.notes()
    const enter = await context.key(property, 'Enter')
    assert.equal(enter.defaultPrevented, true)
    assert.equal(context.document.activeElement === property, false)
    assert.equal(context.requests.length, 0, 'Property Enter commits and blurs without submitting the new form')
    await context.fill(property, 'Cancelled edit')
    const escape = await context.key(property, 'Escape')
    assert.equal(escape.defaultPrevented, true)
    assert.equal(context.cancelled(), 0)
    assert.equal(context.requests.length, 0)
    await context.submit()
    assert.equal(context.requests.length, 1)
    assert.equal(context.requests[0].draft.fieldValues.notes, 'Committed property')
    await context.render(false)
    await context.render()
    await context.fill(context.title(), 'Newer form draft')
    await context.fill(context.notes(), 'Newer property')
    await context.submit()
    assert.equal(context.requests.length, 2)
    await context.change(() => context.requests[0].resolve(true))
    assert.equal(context.title().value, 'Newer form draft')
    assert.equal(context.notes().value, 'Newer property')
    assert.equal(context.dialog().getAttribute('aria-busy'), 'true')
    assert.equal(context.cancelled(), 0)
    await context.change(() => context.requests[1].resolve(false))
    assert.equal(context.dialog().getAttribute('aria-busy'), 'false')
    assert.equal(context.title().value, 'Newer form draft')
    assert.equal(context.alert(), getDatabaseWorkspaceText('en-US').formFailed)
  })
})
