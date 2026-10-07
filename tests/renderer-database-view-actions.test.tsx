import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseSavedView, DatabaseSource } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { DatabaseViewTabs } from '../src/renderer/src/features/database/components/DatabaseViewTabs'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

type Context = {
  document: Document
  window: JSDOM['window']
  text: ReturnType<typeof getDatabaseWorkspaceText>
  data: { source: DatabaseSource; activeViewId: string; savedViews: DatabaseSavedView[] }
  calls: { deleted: { view: DatabaseSavedView; target: HTMLElement | null }[];
    renamed: { view: DatabaseSavedView; target: HTMLElement }[]; selected: string[]; moved: string[][]; created: string[] }
  focusCalls: { element: HTMLElement; options?: FocusOptions }[]
  change: (callback: () => void) => Promise<void>
  key: (target: HTMLElement, key: string, init?: KeyboardEventInit, handled?: boolean) => Promise<KeyboardEvent>
  foreground: (value: boolean) => void
  acceptDelete: (value: boolean) => void
  render: () => Promise<void>
  remove: () => Promise<void>
}

async function withViewTabs(locale: 'en-US' | 'zh-CN', run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside query">', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  let foreground = true, acceptedDelete = true
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => foreground })
  // JSDOM supplies native focus but no layout. Only connected, visible
  // controls receive geometry; no keyboard default activation is simulated.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(20, 20, 240, 40) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    let element: HTMLElement | null = this
    if (!element.isConnected) return [] as unknown as DOMRectList
    while (element) {
      const style = dom.window.getComputedStyle(element)
      if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || element instanceof dom.window.HTMLDialogElement && !element.open) {
        return [] as unknown as DOMRectList
      }
      element = element.parentElement
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  const focusCalls: Context['focusCalls'] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) {
    focusCalls.push({ element: this, options }); nativeFocus.call(this, options)
  }
  const source: DatabaseSource = { id: 'archive', kind: 'custom', name: 'Research archive',
    description: 'Original source description', canDelete: true, canCreateDetachedRecord: true }
  const savedViews: DatabaseSavedView[] = ['Alpha', 'Beta'].map((name, index) => ({
    id: name.toLowerCase(), databaseId: source.id, name,
    config: createDefaultDatabaseViewConfig(index === 0 ? 'table' : 'board', ['__title__', 'notes']),
    configVersion: 1, filterQuery: '', filterScope: '', sortMode: 'updated-desc',
    viewMode: index === 0 ? 'table' : 'board', sortOrder: index,
    createdAt: '2026-10-01', updatedAt: '2026-10-01'
  }))
  savedViews[0].config.query = 'Keep this draft configuration'
  const data = { source, activeViewId: savedViews[0].id, savedViews }
  const calls: Context['calls'] = { deleted: [], renamed: [], selected: [],
    moved: [] as string[][], created: [] as string[] }
  const text = getDatabaseWorkspaceText(locale)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const render = () => change(() => root.render(createElement(DatabaseViewTabs, {
    activeViewId: data.activeViewId, dirty: true, savedViews: data.savedViews, text, sourceSessionKey: data.source,
    onCreateView: layout => { calls.created.push(layout) },
    onDeleteView: (view, target?: HTMLElement | null) => { calls.deleted.push({ view, target: target ?? null }); return acceptedDelete },
    onMoveView: (id, targetId) => { calls.moved.push([id, targetId]) },
    onRenameView: (view, target) => { calls.renamed.push({ view, target }) },
    onSelectView: id => { calls.selected.push(id) }
  })))
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window, text, data, calls, focusCalls, change, render,
      remove: () => change(() => root.render(null)), foreground: value => { foreground = value },
      acceptDelete: value => { acceptedDelete = value },
      key: async (target, key, init = {}, handled = false) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        if (handled) event.preventDefault()
        await change(() => target.dispatchEvent(event))
        return event as unknown as KeyboardEvent
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

function menuTrigger(context: Context, name = 'Alpha') {
  const controls = [...context.document.querySelectorAll<HTMLButtonElement>('.dbw-view-tab-menu')]
    .filter(button => button.getAttribute('aria-label') === `${context.text.viewMenu}: ${name}`)
  assert.equal(controls.length, 1)
  return controls[0]
}

function popup(context: Context, trigger: HTMLButtonElement) {
  const id = trigger.getAttribute('aria-controls')
  assert.ok(id, 'The open View menu must identify its actual popup')
  const element = context.document.getElementById(id)
  assert.ok(element)
  assert.equal(element.getAttribute('role'), 'dialog')
  assert.equal(element.getAttribute('aria-label'), trigger.getAttribute('aria-label'))
  assert.equal(context.document.querySelectorAll('.dbw-view-actions-menu').length, 1)
  assert.equal(element.parentElement?.classList.contains('dbw-view-tabs'), true)
  assert.equal(element.closest('.dbw-view-tab-list') === null, true, 'The popup must escape the scrolling tab list')
  assert.equal(element.getClientRects().length > 0, true)
  return element
}

function action(context: Context, trigger: HTMLButtonElement, label: string) {
  const matches = [...popup(context, trigger).querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => button.textContent === label)
  assert.equal(matches.length, 1, `Expected one visible ${label} management action`)
  assert.equal(matches[0].getClientRects().length > 0, true)
  return matches[0]
}

async function openMenu(context: Context, name = 'Alpha') {
  const trigger = menuTrigger(context, name)
  await context.change(() => { trigger.focus(); trigger.click() })
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog')
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(context.document.activeElement === action(context, trigger, context.text.rename), true)
  return trigger
}

function noActions(context: Context) {
  assert.deepEqual(context.calls, { deleted: [], renamed: [], selected: [], moved: [], created: [] })
}

function closed(context: Context, trigger: HTMLButtonElement) {
  assert.equal(context.document.querySelectorAll('.dbw-view-actions-menu').length, 0)
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
}

test('DatabaseViewTabs View menu opens management actions without requesting deletion or changing the active view', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withViewTabs(locale, async context => {
      const before = structuredClone(context.data)
      const active = context.document.querySelector<HTMLButtonElement>('.dbw-view-tab[aria-current="page"]')!
      assert.equal(active.textContent?.includes('Alpha'), true)
      const trigger = context.document.querySelector<HTMLButtonElement>('.dbw-view-tab-menu')!
      assert.equal(trigger.getAttribute('aria-label'), `${context.text.viewMenu}: Alpha`)
      await context.change(() => trigger.focus())
      assert.equal(context.document.activeElement === trigger, true)
      await context.change(() => trigger.click())

      // This is the first business oracle: opening a management menu must
      // never invoke the callback that opens a destructive confirmation.
      assert.equal(context.calls.deleted.length, 0, `${locale}: View menu must not request deletion`)
      for (const label of [context.text.rename, context.text.deleteView]) {
        action(context, trigger, label)
      }
      assert.equal(context.document.activeElement === action(context, trigger, context.text.rename), true)
      noActions(context)
      assert.equal(context.document.querySelectorAll('[role="alertdialog"]').length, 0)
      assert.equal(context.document.querySelector('.dbw-view-tab[aria-current="page"]') === active, true)
      assert.deepEqual(context.data, before)
    })
    await withViewTabs(locale, async context => {
      context.data.savedViews = context.data.savedViews.slice(0, 1)
      context.acceptDelete(false)
      await context.render()
      const before = structuredClone(context.data), trigger = await openMenu(context)
      const remove = action(context, trigger, context.text.deleteView)
      await context.change(() => remove.focus())
      context.focusCalls.length = 0
      await context.change(() => remove.click())
      assert.equal(context.calls.deleted.length, 1, 'Only explicit Delete reaches the caller last-view guard')
      assert.equal(context.calls.deleted[0].target === trigger, true)
      assert.equal(context.document.querySelectorAll('.dbw-view-actions-menu').length, 1)
      assert.equal(context.document.activeElement === remove, true)
      assert.equal(context.focusCalls.filter(call => call.element === trigger).length, 0)
      assert.deepEqual(context.data, before)
    })
  }
})

test('DatabaseViewTabs actions use the chosen inactive view and stable opener without changing selection or configuration', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    for (const kind of ['rename', 'delete'] as const) {
      await withViewTabs(locale, async context => {
        const before = structuredClone(context.data), beta = context.data.savedViews[1]
        const trigger = await openMenu(context, 'Beta')
        assert.equal(context.document.querySelector('.dbw-view-tab[aria-current="page"]')?.textContent?.includes('Alpha'), true)
        noActions(context)
        const target = action(context, trigger, kind === 'rename' ? context.text.rename : context.text.deleteView)
        context.focusCalls.length = 0
        await context.change(() => target.click())
        closed(context, trigger)
        const calls = kind === 'rename' ? context.calls.renamed : context.calls.deleted
        assert.equal(calls.length, 1)
        assert.equal(calls[0].view === beta, true)
        assert.equal(calls[0].target === trigger, true)
        assert.equal(kind === 'rename' ? context.calls.deleted.length : context.calls.renamed.length, 0)
        assert.deepEqual(context.calls.selected, [])
        assert.deepEqual(context.calls.moved, [])
        assert.deepEqual(context.calls.created, [])
        assert.equal(context.focusCalls.filter(call => call.element === trigger).length, 0, 'Action handoff must not steal focus back from its caller')
        assert.deepEqual(context.data, before)
      })
    }
    await withViewTabs(locale, async context => {
      const before = structuredClone(context.data)
      const tab = context.document.querySelectorAll<HTMLButtonElement>('.dbw-view-tab')[1]
      await context.change(() => tab.dispatchEvent(new context.window.MouseEvent('dblclick', { bubbles: true })))
      assert.equal(context.calls.renamed.length, 1)
      assert.equal(context.calls.renamed[0].view === context.data.savedViews[1], true)
      assert.equal(context.calls.renamed[0].target === tab, true)
      assert.deepEqual(context.calls.deleted, [])
      assert.deepEqual(context.data, before)
    })
  }
})

test('DatabaseViewTabs arrow navigation and owned Escape preserve ordinary keys and restore the stable trigger once', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withViewTabs(locale, async context => {
      const before = structuredClone(context.data), trigger = await openMenu(context)
      const popupId = trigger.getAttribute('aria-controls')
      const rename = action(context, trigger, context.text.rename), remove = action(context, trigger, context.text.deleteView)
      for (const [key, expected] of [['ArrowDown', remove], ['ArrowDown', rename], ['ArrowUp', remove], ['Home', rename], ['End', remove]] as const) {
        const event = await context.key(context.document.activeElement as HTMLElement, key)
        assert.equal(event.defaultPrevented, true)
        assert.equal(context.document.activeElement === expected, true)
      }
      // Synthetic key events do not implement browser button activation or
      // Tab traversal. Verify only that the component leaves those defaults.
      for (const key of ['Tab', 'Enter', ' ']) assert.equal((await context.key(remove, key)).defaultPrevented, false)
      context.focusCalls.length = 0
      const escape = await context.key(remove, 'Escape')
      assert.equal(escape.defaultPrevented, true)
      closed(context, trigger)
      assert.equal(context.document.activeElement === trigger, true)
      const returns = context.focusCalls.filter(call => call.element === trigger)
      assert.equal(returns.length, 1)
      assert.equal(returns[0].options?.preventScroll, true)
      await openMenu(context)
      assert.equal(trigger.getAttribute('aria-controls'), popupId, 'Repeated opening keeps the same associated popup ID')
      await context.change(() => trigger.focus())
      context.focusCalls.length = 0
      await context.key(trigger, 'Escape')
      closed(context, trigger)
      assert.equal(context.document.activeElement === trigger, true)
      assert.equal(context.focusCalls.length, 0, 'Already-focused trigger needs no redundant focus call')
      noActions(context)
      assert.deepEqual(context.data, before)
    })
  }
})

test('DatabaseViewTabs yields handled and IME keys until composition ends or moves to another menu control', async () => {
  for (const mode of ['native', 'legacy', 'composition-end', 'composition-blur', 'handled'] as const) {
    await withViewTabs(mode === 'legacy' || mode.startsWith('composition') ? 'zh-CN' : 'en-US', async context => {
      const before = structuredClone(context.data), trigger = await openMenu(context)
      const rename = action(context, trigger, context.text.rename)
      if (mode.startsWith('composition')) await context.change(() => rename.dispatchEvent(
        new context.window.CompositionEvent('compositionstart', { bubbles: true, data: '视' })))
      context.focusCalls.length = 0
      const event = await context.key(rename, 'Escape', mode === 'native' ? { isComposing: true }
        : mode === 'legacy' ? { keyCode: 229 } : {}, mode === 'handled')
      assert.equal(context.document.querySelectorAll('.dbw-view-actions-menu').length, 1)
      assert.equal(context.document.activeElement === rename, true)
      assert.equal(context.focusCalls.length, 0)
      if (mode !== 'handled') assert.equal(event.defaultPrevented, false)
      if (mode === 'composition-end') await context.change(() => rename.dispatchEvent(
        new context.window.CompositionEvent('compositionend', { bubbles: true, data: '视图' })))
      if (mode === 'composition-blur') await context.change(() => {
        action(context, trigger, context.text.deleteView).focus(); rename.focus()
      })
      await context.key(rename, 'Escape')
      closed(context, trigger)
      assert.equal(context.document.activeElement === trigger, true)
      noActions(context)
      assert.deepEqual(context.data, before)
    })
  }
})

test('DatabaseViewTabs keeps a menu usable when a delayed strip scroll leaves its opener in place', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withViewTabs(locale, async context => {
      const before = structuredClone(context.data)
      const list = context.document.querySelector<HTMLElement>('.dbw-view-tab-list')!
      const delayedScroll = new context.window.Event('scroll')
      const trigger = await openMenu(context), menu = popup(context, trigger)
      const rename = action(context, trigger, context.text.rename), remove = action(context, trigger, context.text.deleteView)
      context.focusCalls.length = 0
      // Native focus may finish moving the strip before its scroll event is
      // delivered. Its unchanged opener must keep the newly opened menu alive.
      await context.change(() => list.dispatchEvent(delayedScroll))
      assert.equal(popup(context, trigger) === menu, true)
      assert.equal(context.document.activeElement === rename, true)
      assert.equal(context.focusCalls.length, 0)
      await context.key(rename, 'ArrowDown')
      assert.equal(context.document.activeElement === remove, true)
      await context.key(remove, 'ArrowUp')
      assert.equal(context.document.activeElement === rename, true)
      await context.key(rename, 'Escape')
      closed(context, trigger)
      assert.equal(context.document.activeElement === trigger, true)
      const returns = context.focusCalls.filter(call => call.element === trigger)
      assert.equal(returns.length, 1)
      assert.equal(returns[0].options?.preventScroll, true)
      noActions(context)
      assert.deepEqual(context.data, before)
    })
  }
})

test('DatabaseViewTabs other owner scrolls still dismiss an anchored menu without restoring focus', async () => {
  for (const mode of ['document', 'outer-container'] as const) {
    await withViewTabs(mode === 'document' ? 'en-US' : 'zh-CN', async context => {
      const before = structuredClone(context.data), trigger = await openMenu(context)
      const originalBounds = trigger.getBoundingClientRect().toJSON()
      context.focusCalls.length = 0
      await context.change(() => {
        const owner = mode === 'document' ? context.document : context.document.getElementById('mount')!
        if (mode === 'outer-container') (owner as HTMLElement).scrollTop = 40
        owner.dispatchEvent(new context.window.Event('scroll'))
      })
      assert.deepEqual(trigger.getBoundingClientRect().toJSON(), originalBounds,
        'Only the tab strip may keep its menu when the opener position is unchanged')
      closed(context, trigger)
      assert.equal(context.focusCalls.length, 0)
      const outside = context.document.getElementById('outside') as HTMLInputElement
      outside.value = 'New query owner'
      await context.change(() => outside.focus())
      context.focusCalls.length = 0
      await context.render()
      assert.equal(context.document.activeElement === outside, true)
      assert.equal(context.focusCalls.length, 0)
      assert.equal(outside.value, 'New query owner')
      noActions(context)
      assert.deepEqual(context.data, before)
    })
  }
})

test('DatabaseViewTabs leaving the menu or changing its source, active view or owner only dismisses without cleanup focus', async () => {
  for (const mode of ['focus', 'pointer', 'list-scroll', 'resize', 'window-blur', 'active-view', 'source', 'removed-view', 'unmount'] as const) {
    await withViewTabs(mode === 'source' || mode === 'active-view' ? 'zh-CN' : 'en-US', async context => {
      const trigger = await openMenu(context)
      const originalViews = structuredClone(context.data.savedViews)
      const outside = context.document.getElementById('outside') as HTMLInputElement
      outside.value = 'User newer query'
      context.focusCalls.length = 0
      if (mode === 'focus') await context.change(() => outside.focus())
      if (mode === 'pointer') await context.change(() => outside.dispatchEvent(
        new context.window.MouseEvent('pointerdown', { bubbles: true, button: 0 })))
      if (mode === 'list-scroll') await context.change(() => {
        const list = context.document.querySelector<HTMLElement>('.dbw-view-tab-list')!
        const initialScroll = list.scrollLeft, initialBounds = trigger.getBoundingClientRect()
        // JSDOM has no layout: model the real opener moving with its strip.
        trigger.getBoundingClientRect = () => new context.window.DOMRect(
          initialBounds.x - (list.scrollLeft - initialScroll), initialBounds.y, initialBounds.width, initialBounds.height)
        list.scrollLeft += 40
        list.dispatchEvent(new context.window.Event('scroll'))
      })
      if (mode === 'resize') await context.change(() => context.window.dispatchEvent(new context.window.Event('resize')))
      if (mode === 'window-blur') await context.change(() => context.window.dispatchEvent(new context.window.Event('blur')))
      if (mode === 'active-view') { context.data.activeViewId = 'beta'; await context.render() }
      if (mode === 'source') {
        context.data.source = { ...context.data.source, id: 'another-source', name: 'Another database' }
        context.data.savedViews = context.data.savedViews.map(view => ({ ...view, databaseId: context.data.source.id }))
        await context.render()
      }
      if (mode === 'removed-view') { context.data.savedViews = context.data.savedViews.slice(1); await context.render() }
      if (mode === 'unmount') await context.remove()
      const expected = structuredClone(context.data)
      assert.equal(context.document.querySelectorAll('.dbw-view-actions-menu').length, 0, `${mode}: dismiss obsolete popup`)
      if (trigger.isConnected) assert.equal(trigger.getAttribute('aria-expanded'), 'false')
      assert.equal(context.focusCalls.filter(call => call.element === trigger).length, 0)
      if (mode === 'focus') assert.equal(context.document.activeElement === outside, true)
      await context.change(() => outside.focus())
      context.focusCalls.length = 0
      if (mode !== 'unmount') await context.render()
      await context.change(() => context.window.dispatchEvent(new context.window.Event('resize')))
      assert.equal(context.document.activeElement === outside, true)
      assert.equal(context.focusCalls.length, 0, 'No delayed cleanup return may steal the newer owner')
      assert.equal(outside.value, 'User newer query')
      noActions(context)
      assert.deepEqual(context.data, expected)
      for (const view of context.data.savedViews) assert.deepEqual(view.config, originalViews.find(original => original.id === view.id)!.config)
    })
  }
})

test('DatabaseViewTabs Escape never focuses unavailable triggers, a background document or a foreign modal', async () => {
  for (const mode of ['disabled', 'aria-disabled', 'hidden', 'inert', 'background', 'foreign-modal'] as const) {
    await withViewTabs(mode === 'background' ? 'zh-CN' : 'en-US', async context => {
      const before = structuredClone(context.data), trigger = await openMenu(context)
      const rename = action(context, trigger, context.text.rename)
      if (mode === 'disabled') trigger.disabled = true
      if (mode === 'aria-disabled') trigger.setAttribute('aria-disabled', 'true')
      if (mode === 'hidden') trigger.hidden = true
      if (mode === 'inert') trigger.setAttribute('inert', '')
      if (mode === 'background') context.foreground(false)
      if (mode === 'foreign-modal') {
        const modal = context.document.createElement('div')
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true')
        modal.textContent = 'New foreground owner'
        context.document.body.append(modal)
      }
      context.focusCalls.length = 0
      await context.key(rename, 'Escape')
      closed(context, trigger)
      assert.equal(context.focusCalls.filter(call => call.element === trigger).length, 0)
      const outside = context.document.getElementById('outside') as HTMLInputElement
      await context.change(() => outside.focus())
      context.foreground(true)
      trigger.disabled = false; trigger.hidden = false
      trigger.removeAttribute('inert'); trigger.removeAttribute('aria-disabled')
      context.focusCalls.length = 0
      await context.render()
      assert.equal(context.document.activeElement === outside, true)
      assert.equal(context.focusCalls.length, 0)
      noActions(context)
      assert.deepEqual(context.data, before)
    })
  }
})
