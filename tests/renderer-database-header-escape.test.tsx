import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseSource } from '../src/shared/contracts'
import { DatabaseHeader } from '../src/renderer/src/features/database/components/DatabaseHeader'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

const sources: DatabaseSource[] = [
  { id: 'catalog', kind: 'document-catalog', name: 'Catalog', description: 'All original documents',
    canDelete: false, canCreateDetachedRecord: false },
  { id: 'archive', kind: 'custom', name: 'Research archive', description: 'Keep this source metadata',
    canDelete: true, canCreateDetachedRecord: true }
]

type Context = {
  document: Document
  window: JSDOM['window']
  calls: { create: (HTMLElement | null)[]; edit: (HTMLElement | null)[]; record: number; delete: number; refresh: number; source: string[] }
  focusCalls: HTMLElement[]
  source: () => HTMLButtonElement
  settings: () => HTMLButtonElement
  search: () => HTMLInputElement
  change: (callback: () => void) => Promise<void>
  fillSearch: (value: string) => Promise<void>
  escape: () => Promise<void>
  key: (target: Element, key: string, init?: KeyboardEventInit, prevented?: boolean) => Promise<KeyboardEvent>
  foreground: (value: boolean) => void
  remove: () => Promise<void>
  render: () => Promise<void>
  flushFrames: () => Promise<void>
}

async function withHeader(locale: 'en-US' | 'zh-CN', run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside query">',
    { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let foreground = true, frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  dom.window.requestAnimationFrame = requestFrame
  dom.window.cancelAnimationFrame = cancelFrame
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => foreground })
  // JSDOM has no layout. Supply geometry only for connected, visible DOM;
  // focus itself remains JSDOM's native implementation.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(20, 20, 300, 40) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    let element: HTMLElement | null = this
    if (!element.isConnected) return [] as unknown as DOMRectList
    while (element) {
      const style = dom.window.getComputedStyle(element)
      if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden'
        || element instanceof dom.window.HTMLDialogElement && !element.open) return [] as unknown as DOMRectList
      element = element.parentElement
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const calls: Context['calls'] = { create: [], edit: [], record: 0, delete: 0, refresh: 0, source: [] }
  const text = getDatabaseWorkspaceText(locale)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const find = <T extends HTMLElement>(selector: string) => {
    const element = dom.window.document.querySelector<T>(selector)
    assert.ok(element, `Expected connected Header control: ${selector}`)
    return element
  }
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const render = () => change(() => root.render(createElement(DatabaseHeader, {
    currentSource: sources[1], sources, text, refreshing: false,
    onCreateDatabase: target => { calls.create.push(target) },
    onEditDatabase: target => { calls.edit.push(target) },
    onCreateRecord: () => { calls.record++ }, onDeleteDatabase: () => { calls.delete++ },
    onRefresh: () => { calls.refresh++ }, onSourceChange: id => { calls.source.push(id) }
  })))
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window, calls, focusCalls,
      source: () => find<HTMLButtonElement>('.dbw-source-trigger'),
      settings: () => find<HTMLButtonElement>('.dbw-menu-wrap > button'),
      search: () => find<HTMLInputElement>('.dbw-source-search input'), change,
      fillSearch: async value => { await change(() => {
        const input = find<HTMLInputElement>('.dbw-source-search input')
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      escape: () => change(() => dom.window.document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))),
      key: async (target, key, init = {}, prevented = false) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        if (prevented) event.preventDefault()
        await change(() => target.dispatchEvent(event))
        return event as unknown as KeyboardEvent
      },
      foreground: value => { foreground = value }, render,
      remove: () => change(() => root.render(null)),
      flushFrames: () => change(() => {
        const pending = [...frames.values()]
        frames.clear()
        for (const callback of pending) callback(0)
      })
    })
  } finally {
    await act(async () => root.unmount())
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

function assertNoActions(context: Context) {
  assert.deepEqual(context.calls, { create: [], edit: [], record: 0, delete: 0, refresh: 0, source: [] })
}

test('DatabaseHeader source picker Escape closes and restores its stable trigger without changing the query', async () => {
  const originalSources = structuredClone(sources)
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withHeader(locale, async context => {
      const trigger = context.source()
      await context.change(() => { trigger.focus(); trigger.click() })
      assert.equal(context.document.activeElement === context.search(), true)
      await context.fillSearch('Research')
      assert.equal(context.search().value, 'Research')
      assert.equal(context.document.querySelectorAll('.dbw-source-option').length, 1)
      context.focusCalls.length = 0
      await context.escape()
      assert.equal(context.document.querySelectorAll('.dbw-source-picker').length, 0, `${locale}: Escape must close the picker`)
      assert.equal(trigger.getAttribute('aria-expanded'), 'false')
      assert.equal(context.document.activeElement === trigger, true)
      assert.equal(context.source() === trigger, true)
      assert.equal(context.focusCalls.filter(element => element === trigger).length, 1)
      assertNoActions(context)
      await context.change(() => trigger.click())
      assert.equal(context.search().value, 'Research')
      assert.equal(context.document.querySelectorAll('.dbw-source-option').length, 1)
      assert.deepEqual(sources, originalSources)
    })
  }
})

type PopupKind = 'picker' | 'settings'
const selector = (kind: PopupKind) => kind === 'picker' ? '.dbw-source-picker' : '.dbw-action-menu'

async function openPopup(context: Context, kind: PopupKind) {
  const trigger = kind === 'picker' ? context.source() : context.settings()
  await context.change(() => { trigger.focus(); trigger.click() })
  const target = kind === 'picker' ? context.search()
    : context.document.querySelector<HTMLButtonElement>('.dbw-action-menu > button')!
  assert.ok(target)
  if (kind === 'settings') await context.change(() => target.focus())
  assert.equal(context.document.activeElement === target, true)
  return { trigger, target }
}

test('DatabaseHeader Escape yields to IME and already handled events, with composition ending or blurring normally', async () => {
  for (const kind of ['picker', 'settings'] as const) {
    for (const mode of ['native', 'legacy', 'composition-end', 'composition-blur', 'handled'] as const) {
      await withHeader(kind === 'picker' ? 'zh-CN' : 'en-US', async context => {
        const { trigger, target } = await openPopup(context, kind)
        if (kind === 'picker') await context.fillSearch('Research')
        if (mode.startsWith('composition')) await context.change(() => target.dispatchEvent(
          new context.window.CompositionEvent('compositionstart', { bubbles: true, data: '研' })))
        context.focusCalls.length = 0
        const ignored = await context.key(target, 'Escape', mode === 'native' ? { isComposing: true }
          : mode === 'legacy' ? { keyCode: 229 } : {}, mode === 'handled')
        assert.equal(context.document.querySelectorAll(selector(kind)).length, 1)
        assert.equal(context.document.activeElement === target, true)
        assert.equal(context.focusCalls.filter(element => element === trigger).length, 0)
        if (mode !== 'handled') assert.equal(ignored.defaultPrevented, false, 'Candidate Escape retains its native default')
        if (mode === 'composition-end') await context.change(() => target.dispatchEvent(
          new context.window.CompositionEvent('compositionend', { bubbles: true, data: '研究' })))
        if (mode === 'composition-blur') await context.change(() => { target.blur(); target.focus() })
        context.focusCalls.length = 0
        await context.escape()
        assert.equal(context.document.querySelectorAll(selector(kind)).length, 0)
        assert.equal(context.document.activeElement === trigger, true)
        assert.equal(context.focusCalls.filter(element => element === trigger).length, 1)
        assertNoActions(context)
      })
    }
  }
})

test('DatabaseHeader only handles Escape for its open control and keeps ordinary input and form return targets', async () => {
  await withHeader('en-US', async context => {
    const { trigger, target } = await openPopup(context, 'picker')
    await context.fillSearch('Research')
    for (const key of ['Tab', 'Enter', 'ArrowDown']) {
      const event = await context.key(target, key)
      assert.equal(event.defaultPrevented, false)
      assert.equal(context.document.querySelectorAll('.dbw-source-picker').length, 1)
      assert.equal(context.search().value, 'Research')
      assertNoActions(context)
    }
    // Unit tests explicitly move native focus; browser Tab routing is covered
    // by the separate hidden Electron regression, not emulated here.
    await context.change(() => trigger.focus())
    context.focusCalls.length = 0
    await context.escape()
    assert.equal(context.document.querySelectorAll('.dbw-source-picker').length, 0)
    assert.equal(context.document.activeElement === trigger, true)
    assert.equal(context.focusCalls.length, 0, 'An already focused trigger needs no redundant focus call')
    const closedEscape = await context.key(trigger, 'Escape')
    assert.equal(closedEscape.defaultPrevented, false)
    await context.change(() => trigger.click())
    assert.equal(context.search().value, 'Research')
    const create = context.document.querySelector<HTMLButtonElement>('.dbw-menu-create')!
    await context.change(() => { create.focus(); create.click() })
    assert.equal(context.document.querySelectorAll('.dbw-source-picker').length, 0)
    assert.equal(context.calls.create.length, 1)
    assert.equal(context.calls.create[0] === trigger, true)
    assert.equal(context.source() === trigger, true)
    assert.equal(context.calls.source.length, 0)
    assert.equal(context.calls.record, 0)
    const opened = await openPopup(context, 'settings')
    await context.change(() => { opened.target.click() })
    assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 0)
    assert.equal(context.calls.edit.length, 1)
    assert.equal(context.calls.edit[0] === opened.trigger, true)
    assert.equal(context.settings() === opened.trigger, true)
    assert.equal(context.calls.delete, 0)
  })
  await withHeader('zh-CN', async context => {
    const { trigger } = await openPopup(context, 'settings')
    await context.change(() => trigger.focus())
    context.focusCalls.length = 0
    await context.escape()
    assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 0)
    assert.equal(context.document.activeElement === trigger, true)
    assert.equal(context.focusCalls.length, 0)
    assertNoActions(context)
  })
})

test('DatabaseHeader Escape cannot reclaim focus from another owner or an unavailable trigger', async () => {
  for (const kind of ['picker', 'settings'] as const) {
    for (const blocked of ['outside', 'foreign-modal', 'inert', 'disabled', 'hidden', 'background'] as const) {
      await withHeader('en-US', async context => {
        const { trigger, target } = await openPopup(context, kind)
        const outside = context.document.getElementById('outside') as HTMLInputElement
        const expected: { current: Element | null } = { current: null }
        await context.change(() => {
          if (blocked === 'outside') { outside.focus(); expected.current = outside }
          else if (blocked === 'foreign-modal') {
            const modal = context.document.createElement('dialog')
            modal.open = true
            modal.setAttribute('aria-modal', 'true')
            const input = context.document.createElement('input')
            modal.append(input); context.document.body.append(modal); input.focus(); expected.current = input
          } else if (blocked === 'inert') trigger.setAttribute('inert', '')
          else if (blocked === 'disabled') trigger.disabled = true
          else if (blocked === 'hidden') trigger.hidden = true
          else { context.foreground(false); expected.current = target }
        })
        context.focusCalls.length = 0
        await context.key(target, 'Escape')
        await context.flushFrames()
        assert.equal(context.focusCalls.filter(element => element === trigger).length, 0, `${kind}/${blocked}`)
        assert.equal(context.document.activeElement === trigger, false)
        if (expected.current?.isConnected) assert.equal(context.document.activeElement === expected.current, true)
        assertNoActions(context)
      })
    }
  }
})

test('DatabaseHeader outside clicks, a new modal and unmount do not schedule cleanup focus or disturb a fresh Header', async () => {
  for (const kind of ['picker', 'settings'] as const) {
    await withHeader('zh-CN', async context => {
      const old = await openPopup(context, kind)
      const outside = context.document.getElementById('outside') as HTMLInputElement
      await context.change(() => outside.focus())
      context.focusCalls.length = 0
      await context.change(() => outside.dispatchEvent(new context.window.MouseEvent('mousedown', { bubbles: true })))
      assert.equal(context.document.querySelectorAll(selector(kind)).length, 0)
      assert.equal(context.document.activeElement === outside, true)
      assert.equal(context.focusCalls.filter(element => element === old.trigger).length, 0)
      await openPopup(context, kind)
      const modal = context.document.createElement('dialog')
      modal.open = true
      modal.setAttribute('aria-modal', 'true')
      const modalInput = context.document.createElement('input')
      modal.append(modalInput); context.document.body.append(modal)
      await context.change(() => modalInput.focus())
      context.focusCalls.length = 0
      await context.remove()
      await context.flushFrames()
      assert.equal(context.document.activeElement === modalInput, true)
      assert.equal(context.focusCalls.length, 0)
      assert.equal(old.trigger.isConnected, false)
      modal.remove()
      await context.render()
      const fresh = await openPopup(context, kind)
      context.focusCalls.length = 0
      await context.flushFrames()
      assert.equal(context.document.activeElement === fresh.target, true)
      assert.equal(context.focusCalls.length, 0)
      assert.equal(fresh.trigger === old.trigger, false)
      assertNoActions(context)
    })
  }
})

test('DatabaseHeader settings Escape closes and restores its stable trigger without executing an action', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withHeader(locale, async context => {
      const trigger = context.settings()
      await context.change(() => { trigger.focus(); trigger.click() })
      const edit = context.document.querySelector<HTMLButtonElement>('.dbw-action-menu > button')
      assert.ok(edit)
      assert.equal(edit.textContent, getDatabaseWorkspaceText(locale).editDatabase)
      await context.change(() => edit.focus())
      assert.equal(context.document.activeElement === edit, true)
      context.focusCalls.length = 0
      await context.escape()
      assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 0, `${locale}: Escape must close settings`)
      assert.equal(trigger.getAttribute('aria-expanded'), 'false')
      assert.equal(context.document.activeElement === trigger, true)
      assert.equal(context.settings() === trigger, true)
      assert.equal(context.focusCalls.filter(element => element === trigger).length, 1)
      assertNoActions(context)
    })
  }
})
