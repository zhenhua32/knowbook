import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseSource } from '../src/shared/contracts'
import { DatabaseHeader } from '../src/renderer/src/features/database/components/DatabaseHeader'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

const locales = ['en-US', 'zh-CN'] as const
const kinds = ['picker', 'settings'] as const
type Kind = typeof kinds[number]
const popupSelector = (kind: Kind) => kind === 'picker' ? '.dbw-source-picker' : '.dbw-action-menu'
const searchDraft = ' archive '
const originalSources: DatabaseSource[] = [
  { id: 'catalog', kind: 'document-catalog', name: 'Catalog', description: 'All original documents',
    canDelete: false, canCreateDetachedRecord: false },
  { id: 'archive', kind: 'custom', name: 'Research archive', description: 'Keep this source metadata',
    canDelete: true, canCreateDetachedRecord: true },
  { id: 'other', kind: 'custom', name: 'Another archive', description: 'Keep the other metadata',
    canDelete: true, canCreateDetachedRecord: true }
]
type Calls = { create: (HTMLElement | null)[]; edit: (HTMLElement | null)[];
  record: number; delete: number; refresh: number; source: string[] }
type Context = {
  document: Document; window: JSDOM['window']; calls: Calls; focusCalls: HTMLElement[]
  model: { currentSource: DatabaseSource; sources: DatabaseSource[]; refreshing: boolean; sourceSessionKey: unknown }
  find: <T extends HTMLElement>(selector: string) => T
  trigger: (kind: Kind) => HTMLButtonElement
  change: (callback: () => void) => Promise<void>; render: () => Promise<void>; remove: () => Promise<void>
  fill: (value: string) => Promise<void>; foreground: (value: boolean) => void
  key: (target: Element, init?: KeyboardEventInit, handled?: boolean) => Promise<KeyboardEvent>
  pointer: (target: Element, button?: number, primary?: boolean) => Promise<MouseEvent>
  flushFrames: () => Promise<void>; assertData: () => void
}

async function withHeader(locale: typeof locales[number], run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div><input id="query" aria-label="Main query" value="Keep original query">',
    { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>(), copiedFrames: FrameRequestCallback[] = []
  let foreground = true, frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback); copiedFrames.push(callback); return frameId
  }
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
  // JSDOM lacks layout and the dialog top layer. Only those sensors are supplied;
  // every focus/blur below delegates to JSDOM's actual HTMLElement implementation.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(20, 20, 300, 40) }
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
  const nativeFocus = dom.window.HTMLElement.prototype.focus, focusCalls: HTMLElement[] = []
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const model: Context['model'] = { currentSource: structuredClone(originalSources[1]),
    sources: structuredClone(originalSources), refreshing: false, sourceSessionKey: { source: 'archive', generation: 1 } }
  const calls: Calls = { create: [], edit: [], record: 0, delete: 0, refresh: 0, source: [] }
  const text = getDatabaseWorkspaceText(locale)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = dom.window.document.querySelector<T>(selector)
    assert.ok(element, `Expected connected Header control: ${selector}`)
    return element
  }
  const change = async (callback: () => void) => {
    await act(async () => { callback(); await new Promise<void>(resolve => setImmediate(resolve)) })
  }
  const render = () => change(() => root.render(createElement(DatabaseHeader, { ...model, text,
    onCreateDatabase: target => { calls.create.push(target) }, onEditDatabase: target => { calls.edit.push(target) },
    onCreateRecord: () => { calls.record++ }, onDeleteDatabase: () => { calls.delete++ },
    onRefresh: () => { calls.refresh++ }, onSourceChange: id => { calls.source.push(id) }
  })))
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window, calls, focusCalls, model, find, change, render,
      trigger: kind => find<HTMLButtonElement>(kind === 'picker' ? '.dbw-source-trigger' : '.dbw-menu-wrap > button'),
      remove: () => change(() => root.render(null)), foreground: value => { foreground = value },
      fill: value => change(() => {
        const input = find<HTMLInputElement>('.dbw-source-search input')
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      key: async (target, init = {}, handled = false) => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
        if (handled) event.preventDefault()
        await change(() => target.dispatchEvent(event))
        return event as unknown as KeyboardEvent
      },
      pointer: async (target, button = 0, primary = true) => {
        // JSDOM has no PointerEvent. A real bubbling event reaches React's
        // pointer handler; browser default focus and native routing stay in E2E.
        const event = new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button })
        Object.defineProperty(event, 'isPrimary', { value: primary })
        await change(() => target.dispatchEvent(event))
        return event as unknown as MouseEvent
      },
      flushFrames: () => change(() => {
        const pending = [...frames.values()]; frames.clear()
        for (const callback of pending) callback(0)
        for (const callback of copiedFrames) callback(0)
      }),
      assertData: () => {
        assert.deepEqual(model.sources, originalSources)
        assert.deepEqual(model.currentSource, originalSources[1])
        assert.equal(find<HTMLInputElement>('#query').value, 'Keep original query')
      }
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
function count(context: Context, kind: Kind) { return context.document.querySelectorAll(popupSelector(kind)).length }
async function open(context: Context, kind: Kind) {
  const trigger = context.trigger(kind)
  await context.change(() => { trigger.focus(); trigger.click() })
  assert.equal(count(context, kind), 1)
  const owner = context.find<HTMLElement>(kind === 'picker' ? '.dbw-source-search input' : '.dbw-action-menu > button')
  if (kind === 'settings') await context.change(() => owner.focus())
  assert.equal(context.document.activeElement === owner, true)
  return { trigger, owner }
}
async function seedSearch(context: Context) {
  const { owner } = await open(context, 'picker')
  await context.fill(searchDraft)
  assert.equal(context.document.querySelectorAll('.dbw-source-option').length, 2)
  await context.key(owner)
  assert.equal(count(context, 'picker'), 0)
}
async function assertRetainedSearch(context: Context) {
  await open(context, 'picker')
  assert.equal(context.find<HTMLInputElement>('.dbw-source-search input').value, searchDraft)
  assert.equal(context.document.querySelectorAll('.dbw-source-option').length, 2)
}

for (const locale of locales) for (const kind of kinds) {
  test(`DatabaseHeader ${locale} ${kind} closes when native focus leaves its own menu scope`, async t => {
    await withHeader(locale, async context => {
      await seedSearch(context)
      const { trigger } = await open(context, kind)
      const outside = context.find<HTMLButtonElement>('.dbw-header-actions > .dbw-primary-button')
      await context.change(() => outside.focus())
      context.focusCalls.length = 0
      t.diagnostic(JSON.stringify({ kind, expanded: trigger.getAttribute('aria-expanded'), popupCount: count(context, kind),
        newRecordFocused: context.document.activeElement === outside, calls: context.calls }))
      assert.equal(count(context, kind), 0, 'Moving to a Header sibling must close only the previous popup')
      assert.equal(context.document.activeElement === outside, true)
      await context.flushFrames()
      assert.equal(context.focusCalls.length, 0)
      assertNoActions(context); context.assertData()
      await assertRetainedSearch(context)
    })
  })
}

test('DatabaseHeader internal pointer and focus keep each popup, while Query, NewRecord and Refresh pointer close without return', async () => {
  for (const locale of locales) for (const kind of kinds) for (const outside of ['#query', '.dbw-primary-button', '.dbw-refresh-button']) {
    await withHeader(locale, async context => {
      await seedSearch(context)
      const { trigger, owner } = await open(context, kind)
      await context.pointer(context.find(popupSelector(kind)))
      assert.equal(count(context, kind), 1)
      await context.change(() => trigger.focus())
      assert.equal(count(context, kind), 1, 'The corresponding stable trigger belongs to this popup')
      await context.pointer(trigger)
      await context.change(() => owner.focus())
      assert.equal(count(context, kind), 1)
      context.focusCalls.length = 0
      const event = await context.pointer(context.find(outside))
      assert.equal(event.defaultPrevented, outside === '.dbw-refresh-button')
      assert.equal(count(context, kind), 0)
      await context.flushFrames()
      assert.equal(context.focusCalls.length, 0)
      assertNoActions(context); context.assertData()
      await assertRetainedSearch(context)
    })
  }
})

test('DatabaseHeader window blur dismisses both popup kinds without reviving them on foreground return', async () => {
  for (const locale of locales) for (const kind of kinds) await withHeader(locale, async context => {
    await seedSearch(context); await open(context, kind)
    context.focusCalls.length = 0
    context.foreground(false)
    await context.change(() => context.window.dispatchEvent(new context.window.Event('blur')))
    assert.equal(count(context, kind), 0)
    context.foreground(true)
    await context.change(() => context.window.dispatchEvent(new context.window.Event('focus')))
    await context.flushFrames()
    assert.equal(count(context, kind), 0)
    assert.equal(context.focusCalls.length, 0)
    assertNoActions(context); context.assertData()
    await assertRetainedSearch(context)
  })
})

test('DatabaseHeader stable-session metadata preserves search, while source ID and same-ID session replacement close without returning focus', async () => {
  for (const locale of locales) for (const kind of kinds) await withHeader(locale, async context => {
    await seedSearch(context)
    const { trigger, owner } = await open(context, kind)
    context.model.currentSource = { ...context.model.currentSource, description: 'Updated source description' }
    context.model.sources[1] = context.model.currentSource
    const updated = structuredClone(context.model)
    context.focusCalls.length = 0
    await context.render()
    assert.equal(count(context, kind), 1)
    assert.equal(context.document.activeElement === owner, true)
    assert.equal(context.focusCalls.length, 0)
    if (kind === 'picker') assert.equal(context.find<HTMLInputElement>('.dbw-source-search input').value, searchDraft)
    context.model.currentSource = context.model.sources[2]
    await context.render()
    assert.equal(count(context, kind), 0)
    assert.equal(context.trigger(kind) === trigger, true)
    context.model.currentSource = context.model.sources[1]
    await context.render(); await context.flushFrames()
    assert.equal(count(context, kind), 0)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.model, updated)
    assertNoActions(context)
    await assertRetainedSearch(context)
    if (kind === 'settings') await open(context, kind)
    context.focusCalls.length = 0
    // Spread props remain valid against the old Header. A fresh session for
    // the same source must close an old popup without remounting its trigger.
    context.model.sourceSessionKey = { source: 'archive', generation: 2 }
    await context.render()
    assert.equal(count(context, kind), 0)
    assert.equal(context.trigger(kind) === trigger, true)
    await context.flushFrames()
    assert.equal(context.focusCalls.length, 0)
    assertNoActions(context)
    await assertRetainedSearch(context)
  })
})

test('DatabaseHeader real trigger activation keeps source and settings mutually exclusive and preserves the search draft', async () => {
  for (const locale of locales) await withHeader(locale, async context => {
    await seedSearch(context)
    await open(context, 'picker')
    await context.change(() => context.trigger('settings').click())
    assert.equal(count(context, 'picker'), 0)
    assert.equal(count(context, 'settings'), 1)
    await context.change(() => context.trigger('picker').click())
    assert.equal(count(context, 'settings'), 0)
    assert.equal(count(context, 'picker'), 1)
    assert.equal(context.find<HTMLInputElement>('.dbw-source-search input').value, searchDraft)
    assertNoActions(context); context.assertData()
  })
})

test('DatabaseHeader owned Escape retains IME and handled events, then returns only its stable trigger once', async () => {
  for (const locale of locales) for (const kind of kinds) await withHeader(locale, async context => {
    await seedSearch(context)
    const { trigger, owner } = await open(context, kind)
    context.focusCalls.length = 0
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = await context.key(owner, init)
      assert.equal(event.defaultPrevented, false); assert.equal(count(context, kind), 1)
    }
    await context.key(owner, {}, true)
    assert.equal(count(context, kind), 1)
    await context.change(() => owner.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })))
    const composing = await context.key(owner)
    assert.equal(composing.defaultPrevented, false); assert.equal(count(context, kind), 1)
    await context.change(() => owner.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
    for (const key of ['Tab', 'Enter', 'ArrowDown']) {
      assert.equal((await context.key(owner, { key })).defaultPrevented, false)
      assert.equal(count(context, kind), 1)
    }
    const escape = await context.key(owner)
    assert.equal(escape.defaultPrevented, true); assert.equal(count(context, kind), 0)
    assert.equal(context.document.activeElement === trigger, true)
    assert.equal(context.focusCalls.filter(element => element === trigger).length, 1)
    await open(context, kind)
    await context.change(() => {
      const target = context.document.activeElement!
      target.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true }))
      trigger.focus() // Actual blur ends the old target's composition ownership.
    })
    context.focusCalls.length = 0
    assert.equal((await context.key(trigger)).defaultPrevented, true)
    assert.equal(count(context, kind), 0); assert.equal(context.focusCalls.length, 0)
    assertNoActions(context); context.assertData()
    await assertRetainedSearch(context)
  })
})

test('DatabaseHeader dismissal never returns to unavailable triggers or competes with another modal, and unmount has no late focus', async () => {
  for (const kind of kinds) for (const blocked of ['hidden', 'disabled', 'inert', 'background', 'foreign-modal'] as const) {
    await withHeader('zh-CN', async context => {
      await seedSearch(context)
      const { trigger, owner } = await open(context, kind)
      let modal: HTMLDialogElement | undefined
      if (blocked === 'hidden') trigger.hidden = true
      if (blocked === 'disabled') trigger.disabled = true
      if (blocked === 'inert') trigger.setAttribute('inert', '')
      if (blocked === 'background') context.foreground(false)
      if (blocked === 'foreign-modal') {
        modal = context.document.createElement('dialog'); modal.setAttribute('aria-modal', 'true')
        context.document.body.append(modal); modal.showModal()
      }
      context.focusCalls.length = 0
      await context.key(owner)
      assert.equal(count(context, kind), 0)
      await context.flushFrames()
      assert.equal(context.focusCalls.length, 0)
      assert.equal(context.document.activeElement === trigger, false)
      trigger.hidden = false; trigger.disabled = false; trigger.removeAttribute('inert')
      modal?.remove(); context.foreground(true)
      await open(context, kind)
      const external = context.find<HTMLInputElement>('#query')
      await context.change(() => external.focus())
      context.focusCalls.length = 0
      await context.remove(); await context.flushFrames()
      assert.equal(context.document.activeElement === external, true)
      assert.equal(context.focusCalls.length, 0)
      await context.render()
      const fresh = await open(context, kind)
      assert.equal(fresh.trigger === trigger, false)
      context.focusCalls.length = 0
      await context.flushFrames()
      assert.equal(context.document.activeElement === fresh.owner, true)
      assert.equal(context.focusCalls.length, 0)
      assertNoActions(context); context.assertData()
    })
  }
})

test('DatabaseHeader actual action clicks keep Create/Edit stable return targets and call only the chosen action', async () => {
  for (const locale of locales) await withHeader(locale, async context => {
    await seedSearch(context)
    const sourceTrigger = context.trigger('picker'), settingsTrigger = context.trigger('settings')
    await open(context, 'picker')
    await context.change(() => context.find<HTMLButtonElement>('.dbw-menu-create').click())
    assert.equal(count(context, 'picker'), 0)
    assert.equal(context.calls.create.length, 1); assert.equal(context.calls.create[0] === sourceTrigger, true)
    await open(context, 'settings')
    await context.change(() => context.find<HTMLButtonElement>('.dbw-action-menu > button').click())
    assert.equal(count(context, 'settings'), 0)
    assert.equal(context.calls.edit.length, 1); assert.equal(context.calls.edit[0] === settingsTrigger, true)
    await open(context, 'settings')
    await context.change(() => context.find<HTMLButtonElement>('.dbw-danger-text').click())
    assert.equal(count(context, 'settings'), 0); assert.equal(context.calls.delete, 1)
    await open(context, 'settings')
    const record = context.find<HTMLButtonElement>('.dbw-header-actions > .dbw-primary-button')
    await context.pointer(record); await context.change(() => record.click())
    assert.equal(count(context, 'settings'), 0); assert.equal(context.calls.record, 1)
    await open(context, 'picker')
    const refresh = context.find<HTMLButtonElement>('.dbw-refresh-button')
    await context.pointer(refresh); await context.change(() => refresh.click())
    assert.equal(count(context, 'picker'), 0); assert.equal(context.calls.refresh, 1)
    assert.equal(context.calls.create.length, 1); assert.equal(context.calls.edit.length, 1)
    assert.equal(context.calls.delete, 1); assert.equal(context.calls.record, 1)
    assert.deepEqual(context.calls.source, [])
    context.assertData(); await assertRetainedSearch(context)
  })
})

test('DatabaseHeader source selection resets only its search, while Refresh preserves external editing focus and native pointer prevention', async () => {
  for (const locale of locales) await withHeader(locale, async context => {
    await seedSearch(context); await open(context, 'picker')
    const other = [...context.document.querySelectorAll<HTMLButtonElement>('.dbw-source-option')]
      .find(button => button.querySelector('strong')?.textContent === originalSources[2].name)!
    assert.ok(other)
    await context.change(() => { other.focus(); other.click() })
    assert.equal(count(context, 'picker'), 0); assert.deepEqual(context.calls.source, ['other'])
    await open(context, 'picker')
    assert.equal(context.find<HTMLInputElement>('.dbw-source-search input').value, '')
    const external = context.find<HTMLInputElement>('#query')
    await context.change(() => { external.focus(); external.setSelectionRange(3, 11) })
    assert.equal(count(context, 'picker'), 0)
    const refresh = context.find<HTMLButtonElement>('.dbw-refresh-button')
    context.focusCalls.length = 0
    for (const [button, primary, prevented] of [[0, true, true], [0, false, false], [2, true, false]] as const) {
      assert.equal((await context.pointer(refresh, button, primary)).defaultPrevented, prevented)
      assert.equal(context.document.activeElement === external, true)
      assert.equal(external.selectionStart, 3); assert.equal(external.selectionEnd, 11)
    }
    await context.change(() => refresh.click())
    assert.equal(context.calls.refresh, 1); assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.calls.source, ['other'])
    assert.equal(context.calls.create.length, 0); assert.equal(context.calls.edit.length, 0)
    assert.equal(context.calls.delete, 0); assert.equal(context.calls.record, 0)
    context.assertData()
  })
})
