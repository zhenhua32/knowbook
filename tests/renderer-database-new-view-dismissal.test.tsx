import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { act, createElement, createRef } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseSavedView, DatabaseSavedViewLayoutMode, DatabaseSource } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { DatabaseViewTabs } from '../src/renderer/src/features/database/components/DatabaseViewTabs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { waitForRenderer } from './helpers/renderer-async'

type Locale = 'en-US' | 'zh-CN'
type Context = {
  document: Document; window: JSDOM['window']; text: ReturnType<typeof getDatabaseWorkspaceText>
  data: { source: DatabaseSource; activeViewId: string; savedViews: DatabaseSavedView[] }
  calls: { created: { layout: DatabaseSavedViewLayoutMode; target: HTMLElement | null }[];
    deleted: string[]; renamed: string[]; selected: string[]; moved: string[][] }
  focusCalls: HTMLElement[]
  menu: () => HTMLDetailsElement; summary: () => HTMLElement; choice: (layout: DatabaseSavedViewLayoutMode) => HTMLButtonElement
  change: (callback: () => void) => Promise<void>; render: () => Promise<void>; remove: () => Promise<void>
  open: () => Promise<void>; foreground: (value: boolean) => void; flushFrames: () => Promise<void>
  key: (target: HTMLElement, init?: KeyboardEventInit, handled?: boolean) => Promise<KeyboardEvent>
}

async function withTabs(locale: Locale, run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" value="Keep external draft">', {
    url: 'http://localhost', pretendToBeVisual: true
  })
  const { document } = dom.window, originals = new Map<string, PropertyDescriptor | undefined>()
  let foreground = true, frameId = 0
  const frames = new Map<number, FrameRequestCallback>(), copiedFrames: FrameRequestCallback[] = []
  dom.window.requestAnimationFrame = callback => { frames.set(++frameId, callback); copiedFrames.push(callback); return frameId }
  dom.window.cancelAnimationFrame = id => { frames.delete(id) }
  for (const [name, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => foreground })
  // JSDOM has native focus and details activation, but no geometry/top layer.
  // These sensors describe connected visible elements; no focus is fabricated.
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(20, 20, 240, 40) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected) return [] as unknown as DOMRectList
    let ancestor: HTMLElement | null = this
    while (ancestor) {
      const style = dom.window.getComputedStyle(ancestor)
      if (ancestor.hidden || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || ancestor instanceof dom.window.HTMLDialogElement && !ancestor.open
        || ancestor instanceof dom.window.HTMLDetailsElement && !ancestor.open && ancestor !== this
          && this.closest('summary')?.parentElement !== ancestor) return [] as unknown as DOMRectList
      ancestor = ancestor.parentElement
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const source: DatabaseSource = { id: 'archive', kind: 'custom', name: 'Research archive',
    description: 'Keep original metadata', canDelete: true, canCreateDetachedRecord: true }
  const savedViews: DatabaseSavedView[] = ['Alpha', 'Beta'].map((name, index) => ({
    id: name.toLowerCase(), databaseId: source.id, name,
    config: createDefaultDatabaseViewConfig(index ? 'board' : 'table', ['__title__', 'notes']),
    configVersion: 1, filterQuery: 'Original filter metadata', filterScope: 'Original scope', sortMode: 'updated-desc',
    viewMode: index ? 'board' : 'table', sortOrder: index, createdAt: '2026-10-01', updatedAt: '2026-10-02'
  }))
  savedViews[0].config.query = ' Keep original query '
  savedViews[0].config.filters = { operator: 'and', rules: [{ id: 'notes-filter', fieldId: 'notes', operator: 'contains', value: 'Original notes' }] }
  const data = { source, activeViewId: savedViews[0].id, savedViews }
  const calls: Context['calls'] = { created: [], deleted: [], renamed: [], selected: [], moved: [] }
  const text = getDatabaseWorkspaceText(locale), triggerRef = createRef<HTMLElement>()
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const flush = async () => { await act(async () => { await setImmediate() }); await act(async () => { await setImmediate() }) }
  const render = () => change(() => root.render(createElement(DatabaseViewTabs, {
    activeViewId: data.activeViewId, savedViews: data.savedViews, dirty: true, sourceSessionKey: data.source,
    newViewTriggerRef: triggerRef, text,
    onCreateView: (layout, target) => { calls.created.push({ layout, target }) },
    onDeleteView: view => { calls.deleted.push(view.id) }, onRenameView: view => { calls.renamed.push(view.id) },
    onSelectView: id => { calls.selected.push(id) }, onMoveView: (id, target) => { calls.moved.push([id, target]) }
  })))
  const menu = () => { const element = document.querySelector<HTMLDetailsElement>('.dbw-new-view-menu'); assert.ok(element); return element }
  const summary = () => { const element = menu().querySelector<HTMLElement>('summary'); assert.ok(element); assert.equal(triggerRef.current === element, true); return element }
  const choice = (layout: DatabaseSavedViewLayoutMode) => {
    const label = layout === 'table' ? text.table : layout === 'board' ? text.board : text.cards
    const matches = [...menu().querySelectorAll<HTMLButtonElement>('.dbw-layout-menu > button')].filter(button => button.textContent === label)
    assert.equal(matches.length, 1); return matches[0]
  }
  try {
    await render(); await flush()
    await run({ document, window: dom.window, text, data, calls, focusCalls, menu, summary, choice, change, render,
      remove: () => change(() => root.render(null)), foreground: value => { foreground = value },
      open: async () => {
        assert.equal(menu().open, false, 'Each opening starts from a dismissed menu')
        await change(() => { summary().focus(); summary().click() })
        await waitForRenderer(() => menu().open, 'Actual summary click must activate native details')
        assert.equal(document.activeElement === summary(), true)
      },
      key: async (target, init = {}, handled = false) => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
        if (handled) event.preventDefault()
        await change(() => target.dispatchEvent(event)); await flush()
        return event as unknown as KeyboardEvent
      },
      flushFrames: async () => {
        const pending = [...frames.values()]; frames.clear()
        await change(() => pending.forEach(callback => callback(16)))
        await change(() => copiedFrames.forEach(callback => callback(32)))
        await flush()
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

function noActions(context: Context) {
  assert.deepEqual(context.calls, { created: [], deleted: [], renamed: [], selected: [], moved: [] })
}
function preserved(context: Context, before: Context['data']) { assert.deepEqual(context.data, before); noActions(context) }
function actionsTrigger(context: Context) {
  const element = context.document.querySelector<HTMLButtonElement>('.dbw-view-tab-menu')!
  assert.ok(element); return element
}
function pointer(context: Context, target: Element) {
  // Dispatch an actual bubbling pointer event. JSDOM has no pointer default
  // focus; the separate native scenarios verify real mouse/Tab behavior.
  const event = new context.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
  target.dispatchEvent(event); return event
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`New view ordinary Escape closes and returns once to its stable Summary in ${locale}`, async testContext => {
    await withTabs(locale, async context => {
      const before = structuredClone(context.data), summary = context.summary()
      for (const layout of ['table', 'board', 'cards'] as const) {
        await context.open()
        const owner = context.choice(layout)
        await context.change(() => owner.focus())
        assert.equal(context.document.activeElement === owner, true)
        context.focusCalls.length = 0
        const event = await context.key(owner)
        testContext.diagnostic(JSON.stringify({ locale, layout, open: context.menu().open,
          active: context.document.activeElement?.tagName, defaultPrevented: event.defaultPrevented,
          summaryFocusCalls: context.focusCalls.filter(element => element === summary).length, callbackCounts: context.calls }))
        // First independent old-source business RED: no mock closes details.
        assert.equal(context.menu().open, false, 'Escape must dismiss New view instead of leaving its layout choices open')
        assert.equal(context.document.activeElement === summary, true)
        assert.equal(context.summary() === summary, true)
        assert.equal(context.focusCalls.length, 1)
        assert.equal(context.focusCalls[0] === summary, true)
        assert.equal(event.defaultPrevented, true)
        preserved(context, before)
      }
      await context.open()
      context.focusCalls.length = 0
      await context.key(summary)
      assert.equal(context.menu().open, false)
      assert.equal(context.document.activeElement === summary, true)
      assert.equal(context.focusCalls.length, 0, 'Already-focused Summary needs no redundant focus')
      preserved(context, before)
    })
  })
}

test('New view Escape yields to IME flags, composition lifecycle and prevented keys without losing metadata', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withTabs(locale, async context => {
    const before = structuredClone(context.data)
    for (const init of [{ isComposing: true }, { keyCode: 229 }] as KeyboardEventInit[]) {
      await context.open()
      const owner = context.choice('table')
      await context.change(() => owner.focus()); context.focusCalls.length = 0
      const event = await context.key(owner, init)
      assert.equal(context.menu().open, true)
      assert.equal(event.defaultPrevented, false)
      assert.equal(context.document.activeElement === owner, true)
      assert.equal(context.focusCalls.length, 0)
      await context.key(owner)
      assert.equal(context.menu().open, false)
      preserved(context, before)
    }
    for (const reset of ['compositionend', 'internal-blur'] as const) {
      await context.open()
      const owner = context.choice('table')
      await context.change(() => { owner.focus(); owner.dispatchEvent(new context.window.CompositionEvent('compositionstart', { bubbles: true })) })
      context.focusCalls.length = 0
      const composing = await context.key(owner)
      assert.equal(context.menu().open, true)
      assert.equal(composing.defaultPrevented, false)
      assert.equal(context.focusCalls.length, 0)
      let next: HTMLElement = owner
      if (reset === 'compositionend') await context.change(() => owner.dispatchEvent(new context.window.CompositionEvent('compositionend', { bubbles: true })))
      else { next = context.choice('board'); await context.change(() => next.focus()); assert.equal(context.menu().open, true) }
      await context.key(next)
      assert.equal(context.menu().open, false)
      preserved(context, before)
    }
    await context.open()
    const owner = context.choice('cards')
    await context.change(() => owner.focus()); context.focusCalls.length = 0
    await context.key(owner, {}, true)
    assert.equal(context.menu().open, true)
    assert.equal(context.document.activeElement === owner, true)
    assert.equal(context.focusCalls.length, 0)
    await context.key(owner)
    assert.equal(context.menu().open, false)
    preserved(context, before)
  })
})

test('internal pointer keeps New view open while outside pointer only dismisses without return focus', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withTabs(locale, async context => {
    const before = structuredClone(context.data), summary = context.summary(), owner = context.choice('table')
    await context.open(); await context.change(() => owner.focus()); context.focusCalls.length = 0
    let internal!: MouseEvent
    await context.change(() => { internal = pointer(context, owner.querySelector('span')!) })
    assert.equal(context.menu().open, true)
    assert.equal(internal.defaultPrevented, false)
    assert.equal(context.document.activeElement === owner, true)
    assert.equal(context.focusCalls.length, 0)
    const outside = context.document.getElementById('outside') as HTMLInputElement
    let external!: MouseEvent
    await context.change(() => { external = pointer(context, outside) })
    await waitForRenderer(() => !context.menu().open, 'Outside pointer must dismiss New view')
    assert.equal(external.defaultPrevented, false)
    assert.equal(context.focusCalls.filter(element => element === summary).length, 0)
    await context.change(() => outside.focus())
    assert.equal(context.document.activeElement === outside, true)
    assert.equal(outside.value, 'Keep external draft')
    preserved(context, before)
  })
})

test('real internal and external focus transitions dismiss only when leaving New view and preserve the newer field', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withTabs(locale, async context => {
    const before = structuredClone(context.data), summary = context.summary()
    await context.open()
    await context.change(() => context.choice('table').focus())
    await context.change(() => context.choice('cards').focus())
    assert.equal(context.menu().open, true)
    const outside = context.document.getElementById('outside') as HTMLInputElement
    context.focusCalls.length = 0
    await context.change(() => { outside.focus(); outside.setSelectionRange(2, 7) })
    await waitForRenderer(() => !context.menu().open, 'Real focus outside must dismiss New view')
    assert.equal(context.document.activeElement === outside, true)
    assert.equal(context.focusCalls.filter(element => element === summary).length, 0)
    assert.equal(outside.value, 'Keep external draft')
    assert.deepEqual([outside.selectionStart, outside.selectionEnd], [2, 7])
    context.focusCalls.length = 0
    await context.render(); await context.flushFrames()
    assert.equal(context.document.activeElement === outside, true)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual([outside.selectionStart, outside.selectionEnd], [2, 7])
    preserved(context, before)
  })
})

test('actual summary and view-action activations are mutually exclusive independently of pointer default focus', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withTabs(locale, async context => {
    const before = structuredClone(context.data), trigger = actionsTrigger(context)
    await context.open()
    // .click() activates the actual controls without synthesizing pointer/focus
    // transitions, so these are genuine mutual-exclusion checks, not blur checks.
    await context.change(() => trigger.click())
    await waitForRenderer(() => !context.menu().open && context.document.querySelectorAll('.dbw-view-actions-menu').length === 1,
      'Opening view actions must dismiss New view')
    await context.change(() => context.summary().click())
    await waitForRenderer(() => context.menu().open && context.document.querySelectorAll('.dbw-view-actions-menu').length === 0,
      'Opening New view must dismiss view actions')
    assert.equal(context.summary().getClientRects().length > 0, true)
    preserved(context, before)
  })
})

test('active-view and source ABA changes dismiss New view on the same DOM without cleanup focus or configuration edits', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withTabs(locale, async context => {
    const summary = context.summary(), menu = context.menu(), originalViews = structuredClone(context.data.savedViews)
    const originalSource = context.data.source
    for (const changeScope of [() => { context.data.activeViewId = 'beta' }, () => { context.data.activeViewId = 'alpha' },
      () => { context.data.source = { ...originalSource, id: 'second-source' }; context.data.savedViews = originalViews.map(view => ({ ...view, databaseId: 'second-source' })) },
      () => { context.data.source = originalSource; context.data.savedViews = structuredClone(originalViews) }]) {
      await context.open(); await context.change(() => context.choice('board').focus())
      context.focusCalls.length = 0
      changeScope()
      const expected = structuredClone(context.data)
      await context.render()
      await waitForRenderer(() => !context.menu().open, 'New source/view session must dismiss native details')
      assert.equal(context.menu() === menu, true)
      assert.equal(context.summary() === summary, true)
      assert.equal(context.focusCalls.length, 0)
      await context.flushFrames()
      assert.equal(context.focusCalls.length, 0)
      preserved(context, expected)
      assert.deepEqual(context.data.savedViews, originalViews.map(view => ({ ...view, databaseId: context.data.source.id })))
    }
  })
})

test('unavailable return targets, background and foreign modals never receive Escape restoration or unmount replay', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    for (const guard of ['hidden', 'aria-disabled', 'inert', 'background', 'foreign-modal'] as const) {
      await withTabs(locale, async context => {
        const before = structuredClone(context.data), summary = context.summary()
        await context.open(); await context.change(() => context.choice('table').focus())
        let modal: HTMLDialogElement | undefined
        if (guard === 'hidden') summary.hidden = true
        if (guard === 'aria-disabled') summary.setAttribute('aria-disabled', 'true')
        if (guard === 'inert') summary.setAttribute('inert', '')
        if (guard === 'background') context.foreground(false)
        if (guard === 'foreign-modal') {
          modal = context.document.createElement('dialog'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true')
          context.document.body.append(modal); modal.showModal()
        }
        context.focusCalls.length = 0
        await context.key(context.choice('table'))
        assert.equal(context.menu().open, false)
        assert.equal(context.focusCalls.length, 0)
        summary.hidden = false; summary.removeAttribute('aria-disabled'); summary.removeAttribute('inert'); context.foreground(true); modal?.remove()
        await context.flushFrames()
        assert.equal(context.focusCalls.length, 0)
        preserved(context, before)
      })
    }
    await withTabs(locale, async context => {
      const before = structuredClone(context.data), oldSummary = context.summary()
      await context.open(); await context.change(() => context.choice('cards').focus()); context.focusCalls.length = 0
      await context.remove()
      assert.equal(oldSummary.isConnected, false)
      assert.equal(context.focusCalls.length, 0)
      const outside = context.document.getElementById('outside') as HTMLInputElement
      await context.change(() => { outside.focus(); outside.setSelectionRange(1, 5) }); context.focusCalls.length = 0
      await context.render(); await context.flushFrames()
      assert.equal(context.menu().open, false)
      assert.equal(context.summary() === oldSummary, false)
      assert.equal(context.document.activeElement === outside, true)
      assert.equal(context.focusCalls.length, 0)
      assert.deepEqual([outside.selectionStart, outside.selectionEnd], [1, 5])
      preserved(context, before)
    })
  }
})

test('each real Table Board Cards button click creates exactly once with the original Summary and no other callbacks', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withTabs(locale, async context => {
    const before = structuredClone(context.data), summary = context.summary()
    for (const layout of ['table', 'board', 'cards'] as const) {
      await context.open()
      const owner = context.choice(layout)
      await context.change(() => { owner.focus(); owner.click() })
      assert.equal(context.menu().open, false)
      assert.equal(context.calls.created.length, ['table', 'board', 'cards'].indexOf(layout) + 1)
      assert.equal(context.calls.created.at(-1)?.layout, layout)
      assert.equal(context.calls.created.at(-1)?.target === summary, true)
      assert.equal(context.summary() === summary, true)
      assert.deepEqual(context.data, before)
      assert.deepEqual({ deleted: context.calls.deleted, renamed: context.calls.renamed, selected: context.calls.selected, moved: context.calls.moved },
        { deleted: [], renamed: [], selected: [], moved: [] })
    }
    assert.deepEqual(context.calls.created.map(call => call.layout), ['table', 'board', 'cards'])
    // No synthetic key is claimed to perform browser default button activation.
    // Actual hidden Electron Enter activation and persistence remain root-owned.
  })
})

test('New view ordinary Escape from genuine BODY focus dismisses without restoring a control while IME and prevented keys yield', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withTabs(locale, async context => {
    const before = structuredClone(context.data)
    await context.open()
    const owner = context.choice('table')
    await context.change(() => owner.focus())
    assert.equal(context.document.activeElement === owner, true)
    // Native blur supplies a real focus vacancy. The Electron scenario uses an
    // actual pointer click on nonfocusable popup padding for the same state.
    await context.change(() => owner.blur())
    assert.equal(context.document.activeElement === context.document.body, true)
    assert.equal(context.menu().open, true)
    context.focusCalls.length = 0
    for (const init of [{ isComposing: true }, { keyCode: 229 }] as KeyboardEventInit[]) {
      const event = await context.key(context.document.body, init)
      assert.equal(context.menu().open, true)
      assert.equal(event.defaultPrevented, false)
      assert.equal(context.document.activeElement === context.document.body, true)
      assert.equal(context.focusCalls.length, 0)
      preserved(context, before)
    }
    await context.key(context.document.body, {}, true)
    assert.equal(context.menu().open, true)
    assert.equal(context.focusCalls.length, 0)
    const foreign = context.document.createElement('dialog')
    foreign.setAttribute('role', 'dialog'); foreign.setAttribute('aria-modal', 'true')
    await context.change(() => { context.document.body.append(foreign); foreign.showModal() })
    assert.equal(foreign.open, true)
    assert.equal(context.document.activeElement === context.document.body, true)
    const foreignEscape = await context.key(context.document.body)
    assert.equal(context.menu().open, true)
    assert.equal(foreignEscape.defaultPrevented, false)
    assert.equal(context.document.activeElement === context.document.body, true)
    assert.equal(context.focusCalls.length, 0)
    preserved(context, before)
    await context.change(() => foreign.remove())
    context.foreground(false)
    const backgroundEscape = await context.key(context.document.body)
    assert.equal(context.menu().open, true)
    assert.equal(backgroundEscape.defaultPrevented, false)
    assert.equal(context.document.activeElement === context.document.body, true)
    assert.equal(context.focusCalls.length, 0)
    preserved(context, before)
    context.foreground(true)
    const event = await context.key(context.document.body)
    assert.equal(context.menu().open, false)
    assert.equal(event.defaultPrevented, true)
    assert.equal(context.document.activeElement === context.document.body, true)
    assert.equal(context.focusCalls.length, 0, 'BODY Escape dismisses without choosing a new focus owner')
    await context.flushFrames()
    assert.equal(context.document.activeElement === context.document.body, true)
    assert.equal(context.focusCalls.length, 0)
    preserved(context, before)
  })
})
