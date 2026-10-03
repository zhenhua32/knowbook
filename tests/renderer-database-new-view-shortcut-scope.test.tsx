import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { getActiveUiText, setActiveUiLanguage } from '../src/renderer/src/i18n'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')

const database: DocumentDatabase = { id: 'archive', kind: 'custom', name: 'Research archive',
  description: 'Original description', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const field: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }
const record: DatabaseEntity = { id: 'selected-record', databaseId: database.id, title: 'Keep selected record', documentId: null,
  fieldValues: { notes: 'Original notes', hidden: 'Original hidden metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const view: DatabaseSavedView = { id: 'primary', databaseId: database.id, name: 'Original table',
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, field.id]), configVersion: 1,
  filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }
view.config.query = 'Keep selected'

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`open New view ${locale === 'en-US' ? 'Summary' : 'Table'} owns Delete without targeting selected records in ${locale}`, async context => {
    const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
    const { document } = dom.window
    const originals = new Map<string, PropertyDescriptor | undefined>()
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
    const cancelFrame = (id: number) => { frames.delete(id) }
    dom.window.requestAnimationFrame = requestFrame
    dom.window.cancelAnimationFrame = cancelFrame
    for (const [key, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }
    // Only unavailable dialog/layout/foreground APIs are supplied; focus remains native.
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 300, 40) }
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
    const calls = { deletes: [] as string[][], reads: 0, source: [] as string[], view: [] as string[], selection: [] as string[][], messages: [] as unknown[] }
    Object.defineProperty(dom.window, 'knowbook', { value: {
      deleteDatabaseEntities: async ({ entityIds }: { entityIds: string[] }) => { calls.deletes.push([...entityIds]) }
    } })
    const data = structuredClone({ database, field, record, view })
    const before = structuredClone(data)
    const oldLanguage = getActiveUiText().language
    setActiveUiLanguage(locale)
    const text = getDatabaseWorkspaceText(locale)
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(document.getElementById('mount')!)
    function Harness() {
      const [source, setSource] = useState(database.id)
      const [activeView, setActiveView] = useState(view.id)
      const [selection, setSelection] = useState([record.id])
      return createElement(DatabaseWorkspace, {
        currentDatabaseId: source, activeViewId: activeView, databases: [data.database], savedViews: [data.view], locale,
        catalogColumns: [], catalogDocuments: [], entities: [data.record], selectedColumns: [data.field], selectedRecordIds: selection,
        onActiveViewIdChange: id => { calls.view.push(id); setActiveView(id) },
        onCurrentDatabaseIdChange: id => { calls.source.push(id); setSource(id) },
        onSelectedRecordIdsChange: ids => { calls.selection.push([...ids]); setSelection(ids) },
        onOpenDocument: () => {}, onMessage: message => { calls.messages.push(message) },
        onRefresh: async () => { calls.reads++ }
      })
    }
    try {
      await act(async () => root.render(createElement(Harness)))
      assert.equal(document.querySelector<HTMLInputElement>('.dbw-table tbody input[type="checkbox"]')?.checked, true)
      const notes = document.querySelectorAll<HTMLInputElement>('.dbw-table tbody input.catalog-cell-input[aria-label="Notes"]')
      assert.equal(notes.length, 1)
      assert.equal(notes[0].value, 'Original notes')
      assert.equal(document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value, 'Keep selected')
      const menu = document.querySelector<HTMLDetailsElement>('.dbw-new-view-menu')!
      const summary = menu.querySelector<HTMLElement>('summary')!
      await act(async () => { summary.focus(); summary.click() })
      assert.equal(menu.open, true, 'The actual native details activation must open New view')
      const table = [...menu.querySelectorAll<HTMLButtonElement>('.dbw-layout-menu > button')].find(button => button.textContent === text.table)!
      assert.ok(table)
      const owner = locale === 'en-US' ? summary : table
      await act(async () => owner.focus())
      assert.equal(document.activeElement === owner, true)
      focusCalls.length = 0
      const key = new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      await act(async () => owner.dispatchEvent(key))
      context.diagnostic(JSON.stringify({ locale, menuOpen: menu.open, ownerTag: owner.tagName,
        ownerText: owner.textContent, activeTag: document.activeElement?.tagName,
        confirmationCount: document.querySelectorAll('.app-confirm-dialog').length, defaultPrevented: key.defaultPrevented, calls }))
      assert.equal(document.querySelectorAll('.app-confirm-dialog').length, 0, 'New view keyboard browsing must not open the selected-records deletion dialog')
      assert.equal(document.activeElement === owner, true)
      assert.equal(menu.open, true)
      assert.equal(key.defaultPrevented, false)
      assert.equal(focusCalls.length, 0)
      assert.deepEqual(calls, { deletes: [], reads: 0, source: [], view: [], selection: [], messages: [] })
      assert.deepEqual(data, before)
      assert.equal(notes[0].value, 'Original notes')
      assert.equal(document.querySelector<HTMLInputElement>('.dbw-table tbody input[type="checkbox"]')?.checked, true)
      assert.equal(document.querySelector('.dbw-view-tab[aria-current="page"]')?.getAttribute('title'), view.name)
    } finally {
      await act(async () => root.unmount())
      setActiveUiLanguage(oldLanguage)
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
      dom.window.close()
    }
  })
}

type ScopeContext = {
  document: Document; window: JSDOM['window']; text: ReturnType<typeof getDatabaseWorkspaceText>
  calls: { deletes: string[][]; reads: number; source: string[]; view: string[]; selection: string[][]; messages: unknown[] }
  focusCalls: HTMLElement[]; menu: () => HTMLDetailsElement; summary: () => HTMLElement
  change: (callback: () => void) => Promise<void>; key: (target: Element, key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  open: () => Promise<void>; fill: (input: HTMLInputElement, raw: string) => Promise<void>; flushFrames: () => Promise<void>
  assertContext: () => void
}

async function withNewViewScope(locale: 'en-US' | 'zh-CN', run: (context: ScopeContext) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const { document } = dom.window
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  dom.window.requestAnimationFrame = requestFrame
  dom.window.cancelAnimationFrame = cancelFrame
  for (const [key, value] of Object.entries({ window: dom.window, document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 300, 40) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    let element: HTMLElement | null = this
    if (!element.isConnected) return [] as unknown as DOMRectList
    while (element) {
      const style = dom.window.getComputedStyle(element)
      if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden'
        || element instanceof dom.window.HTMLDialogElement && !element.open) return [] as unknown as DOMRectList
      if (element !== this && element instanceof dom.window.HTMLDetailsElement && !element.open
        && !element.querySelector(':scope > summary')?.contains(this)) return [] as unknown as DOMRectList
      element = element.parentElement
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const calls: ScopeContext['calls'] = { deletes: [], reads: 0, source: [], view: [], selection: [], messages: [] }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    deleteDatabaseEntities: async ({ entityIds }: { entityIds: string[] }) => { calls.deletes.push([...entityIds]) }
  } })
  const data = structuredClone({ database, field, record, view })
  const before = structuredClone(data)
  const rawQuery = '  Keep selected  '
  const state = { source: database.id, activeView: view.id, selection: [record.id] }
  const initialState = structuredClone(state)
  const oldLanguage = getActiveUiText().language
  setActiveUiLanguage(locale)
  const text = getDatabaseWorkspaceText(locale)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  function Harness() {
    const [source, setSource] = useState(database.id)
    const [activeView, setActiveView] = useState(view.id)
    const [selection, setSelection] = useState([record.id])
    Object.assign(state, { source, activeView, selection: [...selection] })
    return createElement(DatabaseWorkspace, {
      currentDatabaseId: source, activeViewId: activeView, databases: [data.database], savedViews: [data.view], locale,
      catalogColumns: [], catalogDocuments: [], entities: [data.record], selectedColumns: [data.field], selectedRecordIds: selection,
      onActiveViewIdChange: id => { calls.view.push(id); setActiveView(id) },
      onCurrentDatabaseIdChange: id => { calls.source.push(id); setSource(id) },
      onSelectedRecordIdsChange: ids => { calls.selection.push([...ids]); setSelection(ids) },
      onOpenDocument: () => {}, onMessage: message => { calls.messages.push(message) },
      onRefresh: async () => { calls.reads++ }
    })
  }
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const menu = () => document.querySelector<HTMLDetailsElement>('.dbw-new-view-menu')!
  const summary = () => menu().querySelector<HTMLElement>('summary')!
  const fill = (input: HTMLInputElement, raw: string) => change(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, raw)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const assertContext = () => {
    assert.deepEqual(data, before, 'Keyboard/menu browsing must leave the stored source, entity, fields and view config intact')
    assert.deepEqual(state, initialState)
    assert.deepEqual(calls, { deletes: [], reads: 0, source: [], view: [], selection: [], messages: [] })
    assert.equal(document.querySelector('.dbw-source-trigger')?.getAttribute('title'), database.name)
    assert.equal(document.querySelector('.dbw-view-tab[aria-current="page"]')?.getAttribute('title'), view.name)
    assert.equal(document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value, rawQuery)
    assert.equal(document.querySelectorAll('.dbw-table tbody tr:not(.dbw-virtual-spacer)').length, 1)
    assert.equal(document.querySelector<HTMLInputElement>('.dbw-table tbody input[type="checkbox"]')?.checked, true)
    assert.equal(document.querySelector('.dbw-table tbody .dbw-record-title strong')?.textContent, record.title)
    const notes = document.querySelectorAll<HTMLInputElement>('.dbw-table tbody input.catalog-cell-input[aria-label="Notes"]')
    assert.equal(notes.length, 1)
    assert.equal(notes[0].value, 'Original notes')
  }
  try {
    await change(() => root.render(createElement(Harness)))
    await fill(document.querySelector<HTMLInputElement>('.dbw-main-search input')!, rawQuery)
    assertContext()
    await run({ document, window: dom.window, text, calls, focusCalls, change, menu, summary, fill, assertContext,
      open: async () => {
        assert.equal(menu().open, false)
        await change(() => { summary().focus(); summary().click() })
        assert.equal(menu().open, true)
        assert.equal(document.activeElement === summary(), true)
      },
      key: async (target, key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await change(() => target.dispatchEvent(event))
        return event as unknown as KeyboardEvent
      },
      flushFrames: () => change(() => {
        const pending = [...frames.values()]
        frames.clear()
        pending.forEach(callback => callback(0))
      })
    })
    assertContext()
  } finally {
    await act(async () => root.unmount())
    setActiveUiLanguage(oldLanguage)
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const canvasKeys: { key: string; init?: KeyboardEventInit; destination: 'records' | 'query' | 'source' | 'view' }[] = [
  { key: 'Delete', destination: 'records' }, { key: '/', destination: 'query' },
  { key: 'L', init: { ctrlKey: true, shiftKey: true }, destination: 'source' },
  { key: 'L', init: { metaKey: true, shiftKey: true }, destination: 'source' },
  { key: 'V', init: { ctrlKey: true, shiftKey: true }, destination: 'view' },
  { key: 'V', init: { metaKey: true, shiftKey: true }, destination: 'view' }
]

test('all four open New view owners and their icon descendants yield every canvas shortcut in both languages', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withNewViewScope(locale, async context => {
    await context.open()
    const buttons = [...context.menu().querySelectorAll<HTMLButtonElement>('.dbw-layout-menu > button')]
    assert.deepEqual(buttons.map(button => button.textContent), [context.text.table, context.text.board, context.text.cards])
    const owners = [context.summary(), ...buttons]
    for (const owner of owners) {
      await context.change(() => owner.focus())
      assert.equal(context.document.activeElement === owner, true)
      const icon = owner.querySelector('span, svg')
      assert.ok(icon, 'The actual rendered owner must supply its icon descendant')
      // The descendant dispatch covers bubbling scope. It does not synthesize
      // browser Enter activation or change the actual focused owner.
      for (const target of [owner, icon]) for (const shortcut of canvasKeys) {
        context.focusCalls.length = 0
        const event = await context.key(target, shortcut.key, shortcut.init)
        assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
        assert.equal(context.document.querySelectorAll('.dbw-form-dialog').length, 0)
        assert.equal(context.document.activeElement === owner, true)
        assert.equal(event.defaultPrevented, false)
        assert.equal(context.focusCalls.length, 0)
        assert.equal(context.menu().open, true)
        context.assertContext()
      }
    }
  })
})

test('closed New view and actual outside focus preserve the canvas shortcuts even while the menu is open', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) for (const scope of ['closed-summary', 'outside-open-menu'] as const) {
    await withNewViewScope(locale, async context => {
      await context.open()
      if (scope === 'closed-summary') await context.change(() => context.summary().click())
      const owner = scope === 'closed-summary' ? context.summary()
        : context.document.querySelector<HTMLButtonElement>('.dbw-header-actions > .dbw-primary-button')!
      assert.ok(owner)
      for (const shortcut of canvasKeys) {
        await context.change(() => owner.focus())
        assert.equal(context.document.activeElement === owner, true)
        assert.equal(context.menu().open, scope === 'outside-open-menu')
        const event = await context.key(owner, shortcut.key, shortcut.init)
        assert.equal(event.defaultPrevented, true, `${scope}: the canvas still owns ${shortcut.key}`)
        if (shortcut.destination === 'records') {
          const dialog = context.document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
          assert.ok(dialog)
          assert.equal(dialog.open, true)
          assert.equal(dialog.querySelector('h2')?.textContent, context.text.deleteRecord)
          assert.equal(dialog.querySelector('.app-confirm-body > p')?.textContent, `“${context.text.selected(1)}”`)
          assert.equal(context.document.querySelectorAll('.dbw-form-dialog').length, 0)
          const cancel = dialog.querySelector<HTMLButtonElement>('.secondary-button')!
          await context.change(() => cancel.click())
          await context.flushFrames()
          assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
        } else {
          const expected = shortcut.destination === 'query' ? context.document.querySelector('.dbw-main-search input')
            : shortcut.destination === 'source' ? context.document.querySelector('.dbw-source-trigger') : context.summary()
          assert.equal(context.document.activeElement === expected, true)
          assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
        }
        assert.equal(context.menu().open, scope === 'outside-open-menu')
        context.assertContext()
      }
    })
  }
})

test('the three actual layout button clicks open the right New view form and Cancel preserves its stable Summary and data', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withNewViewScope(locale, async context => {
    for (const label of [context.text.table, context.text.board, context.text.cards]) {
      await context.open()
      const stableSummary = context.summary()
      const choice = [...context.menu().querySelectorAll<HTMLButtonElement>('.dbw-layout-menu > button')].find(button => button.textContent === label)!
      assert.ok(choice)
      // JSDOM cannot turn a key into native default activation. Invoke the real
      // DOM click; the hidden Electron scenarios separately exercise Enter.
      await context.change(() => { choice.focus(); choice.click() })
      assert.equal(context.menu().open, false)
      assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
      const form = context.document.querySelector<HTMLFormElement>('.dbw-form-dialog')
      assert.ok(form)
      assert.equal(form.querySelector('h2')?.textContent, context.text.newView)
      assert.equal(form.getAttribute('aria-label'), context.text.newView)
      assert.equal(form.querySelectorAll('textarea').length, 0)
      const name = form.querySelector<HTMLInputElement>('input')!
      assert.equal(name.value, `${label} 2`)
      await context.flushFrames()
      assert.equal(context.document.activeElement === name, true)
      await context.fill(name, `Unsaved ${label} name`)
      const cancel = form.querySelector<HTMLButtonElement>('footer .dbw-quiet-button')!
      assert.ok(cancel)
      await context.change(() => { cancel.focus(); cancel.click() })
      await context.flushFrames()
      assert.equal(context.document.querySelectorAll('.dbw-form-dialog').length, 0)
      assert.equal(context.summary() === stableSummary, true)
      assert.equal(context.document.activeElement === stableSummary, true)
      assert.equal(context.menu().open, false)
      context.assertContext()
    }
  })
})
