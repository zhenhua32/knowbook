import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { setImmediate } from 'node:timers/promises'
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

type Locale = 'en-US' | 'zh-CN'
const database: DocumentDatabase = { id: 'archive', kind: 'custom', name: 'Research archive',
  description: 'Original description', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const field: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }
const record: DatabaseEntity = { id: 'selected-record', databaseId: database.id, title: 'Keep selected record', documentId: null,
  fieldValues: { notes: 'Original notes', hidden: 'Original hidden metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const view: DatabaseSavedView = { id: 'primary', databaseId: database.id, name: 'Original table',
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, field.id]), configVersion: 1,
  filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }
view.config.query = ' Keep selected '
view.config.filters = { operator: 'and', rules: [{ id: 'notes-filter', fieldId: field.id, operator: 'contains', value: 'Original' }] }
view.config.sorts = [{ fieldId: DATABASE_SYSTEM_FIELD_IDS.title, direction: 'asc' }]

type Context = {
  document: Document; window: JSDOM['window']; text: ReturnType<typeof getDatabaseWorkspaceText>
  calls: { api: Array<{ method: string; input: unknown[] }>; reads: number; source: string[]; view: string[]; selection: string[][]; messages: unknown[] }
  focusCalls: HTMLElement[]
  change: (callback: () => void) => Promise<void>
  key: (target: Element, key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  flushRendererWork: () => Promise<void>
  assertContext: () => void
}

async function withWorkspace(locale: Locale, run: (context: Context) => Promise<void>) {
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
  // Supply unavailable foreground/dialog/layout APIs; all focus delegates to JSDOM.
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 300, 40) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected) return [] as unknown as DOMRectList
    let ancestor: HTMLElement | null = this
    while (ancestor) {
      const style = dom.window.getComputedStyle(ancestor)
      if (ancestor.hidden || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden'
        || ancestor instanceof dom.window.HTMLDialogElement && !ancestor.open) return [] as unknown as DOMRectList
      ancestor = ancestor.parentElement
    }
    return [this.getBoundingClientRect()] as unknown as DOMRectList
  }
  const nativeFocus = dom.window.HTMLElement.prototype.focus, focusCalls: HTMLElement[] = []
  dom.window.HTMLElement.prototype.focus = function (options) { focusCalls.push(this); nativeFocus.call(this, options) }
  const calls: Context['calls'] = { api: [], reads: 0, source: [], view: [], selection: [], messages: [] }
  Object.defineProperty(dom.window, 'knowbook', { value: new Proxy({}, {
    get: (_target, method) => async (...input: unknown[]) => {
      calls.api.push({ method: String(method), input: structuredClone(input) })
      throw new Error('Keyboard browsing must not make a persistence request')
    }
  }) })
  const data = structuredClone({ database, field, record, view }), before = structuredClone(data)
  const oldLanguage = getActiveUiText().language
  setActiveUiLanguage(locale)
  const text = getDatabaseWorkspaceText(locale)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const flushRendererWork = async () => {
    // Allow actual effects/portal commits and held return-focus frames to settle.
    await act(async () => { await setImmediate() })
    await change(() => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(0))
    })
    await act(async () => { await setImmediate() })
  }
  function Harness() {
    const [source, setSource] = useState(database.id)
    const [activeView, setView] = useState(view.id)
    const [selection, setSelection] = useState([record.id])
    return createElement(DatabaseWorkspace, {
      currentDatabaseId: source, activeViewId: activeView, databases: [data.database], savedViews: [data.view], locale,
      catalogColumns: [], catalogDocuments: [], entities: [data.record], selectedColumns: [data.field], selectedRecordIds: selection,
      onActiveViewIdChange: id => { calls.view.push(id); setView(id) },
      onCurrentDatabaseIdChange: id => { calls.source.push(id); setSource(id) },
      onSelectedRecordIdsChange: ids => { calls.selection.push([...ids]); setSelection(ids) },
      onOpenDocument: () => assert.fail('Toolbar browsing must not navigate to a document'),
      onMessage: message => { calls.messages.push(message) }, onRefresh: async () => { calls.reads++ }
    })
  }
  const assertContext = () => {
    assert.deepEqual(calls, { api: [], reads: 0, source: [], view: [], selection: [], messages: [] })
    assert.deepEqual(data, before, 'Record metadata, hidden values, schema and saved-view configuration must stay intact')
    assert.equal(document.querySelector('.dbw-source-trigger')?.getAttribute('title'), database.name)
    assert.equal(document.querySelector('.dbw-view-tab[aria-current="page"]')?.getAttribute('title'), view.name)
    assert.equal(document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value, view.config.query)
    assert.equal(document.querySelectorAll('.dbw-table tbody tr:not(.dbw-virtual-spacer)').length, 1)
    assert.equal(document.querySelector<HTMLInputElement>('.dbw-table tbody input[type="checkbox"]')?.checked, true)
    assert.equal(document.querySelector('.dbw-table tbody .dbw-record-title strong')?.textContent, record.title)
    // The selected record also creates a blank bulk editor with the same Notes label.
    const notes = document.querySelectorAll<HTMLInputElement>('.dbw-table tbody input.catalog-cell-input[aria-label="Notes"]')
    assert.equal(notes.length, 1)
    assert.equal(notes[0].value, 'Original notes')
    const filter = document.querySelector<HTMLInputElement>('.dbw-filter-row input')
    assert.equal(filter?.value, 'Original')
    const sort = document.querySelectorAll<HTMLSelectElement>('.dbw-config-row select')
    assert.deepEqual([...sort].map(control => control.value), [DATABASE_SYSTEM_FIELD_IDS.title, 'asc'])
    assert.equal(document.querySelectorAll('.dbw-unsaved-dot').length, 0)
  }
  try {
    await change(() => root.render(createElement(Harness)))
    await flushRendererWork()
    assertContext()
    await run({ document, window: dom.window, text, calls, focusCalls, change, flushRendererWork, assertContext,
      key: async (target, key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await change(() => target.dispatchEvent(event))
        await flushRendererWork()
        return event as unknown as KeyboardEvent
      }
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

const shortcuts: Array<{ key: string; init?: KeyboardEventInit; destination: 'records' | 'query' | 'source' | 'view' }> = [
  { key: 'Delete', destination: 'records' }, { key: '/', destination: 'query' },
  { key: 'L', init: { ctrlKey: true, shiftKey: true }, destination: 'source' },
  { key: 'L', init: { metaKey: true, shiftKey: true }, destination: 'source' },
  { key: 'V', init: { ctrlKey: true, shiftKey: true }, destination: 'view' },
  { key: 'V', init: { metaKey: true, shiftKey: true }, destination: 'view' }
]

for (const locale of ['en-US', 'zh-CN'] as const) for (const kind of ['Filter', 'Sort'] as const) {
  test(`${kind} open toolbar controls own canvas shortcuts without deleting records in ${locale}`, async testContext => {
    await withWorkspace(locale, async context => {
      const { document } = context
      const menus = document.querySelectorAll<HTMLDetailsElement>('.dbw-toolbar-menu')
      assert.equal(menus.length, 2)
      const menu = menus[kind === 'Filter' ? 0 : 1], summary = menu.querySelector<HTMLElement>('summary')!
      assert.ok(summary)
      await context.change(() => { summary.focus(); summary.click() })
      assert.equal(menu.open, true, 'Actual native details activation must open the toolbar menu')
      assert.equal(document.activeElement === summary, true)
      const firstOwner = menu.querySelector<HTMLButtonElement>(kind === 'Filter'
        ? '.dbw-popover-heading button' : '.dbw-config-row button')!
      assert.ok(firstOwner)
      await context.change(() => firstOwner.focus())
      assert.equal(document.activeElement === firstOwner, true)
      context.focusCalls.length = 0
      const firstDelete = await context.key(firstOwner, 'Delete')
      testContext.diagnostic(JSON.stringify({ locale, kind, open: menu.open,
        active: { tag: document.activeElement?.tagName, text: document.activeElement?.textContent },
        source: document.querySelector('.dbw-source-trigger')?.getAttribute('title'),
        view: document.querySelector('.dbw-view-tab[aria-current="page"]')?.getAttribute('title'),
        query: document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
        selected: document.querySelector<HTMLInputElement>('.dbw-table tbody input[type="checkbox"]')?.checked,
        notes: document.querySelector<HTMLInputElement>('.dbw-table tbody input.catalog-cell-input[aria-label="Notes"]')?.value,
        confirmationCount: document.querySelectorAll('.app-confirm-dialog').length,
        defaultPrevented: firstDelete.defaultPrevented, focusCalls: context.focusCalls.map(element => element.tagName), calls: context.calls }))
      // Keep this first business oracle ahead of the rest of the protection matrix.
      assert.equal(document.querySelectorAll('.app-confirm-dialog').length, 0, `${kind}: Delete must not target selected canvas records`)
      assert.equal(document.activeElement === firstOwner, true)
      assert.equal(firstDelete.defaultPrevented, false)
      assert.equal(context.focusCalls.length, 0)
      context.assertContext()

      const owners = [summary, ...menu.querySelectorAll<HTMLElement>('button, input, select')]
      assert.ok(owners.some(owner => owner.tagName === 'BUTTON'))
      assert.ok(owners.some(owner => owner.tagName === 'SELECT'))
      if (kind === 'Filter') assert.ok(owners.some(owner => owner.tagName === 'INPUT'))
      // Synthetic keydown checks canvas ownership only. It does not implement
      // the browser's native Delete/slash text editing or clipboard actions.
      for (const owner of owners) for (const shortcut of shortcuts) {
        await context.change(() => owner.focus())
        assert.equal(document.activeElement === owner, true)
        context.focusCalls.length = 0
        const event = await context.key(owner, shortcut.key, shortcut.init)
        assert.equal(document.querySelectorAll('.app-confirm-dialog').length, 0)
        assert.equal(document.activeElement === owner, true, `${kind} ${owner.tagName}: ${shortcut.key} must leave its actual owner alone`)
        assert.equal(event.defaultPrevented, false)
        assert.equal(context.focusCalls.length, 0)
        assert.equal(menu.open, true)
        context.assertContext()
      }

      for (const scope of ['closed-summary', 'outside-open-menu'] as const) {
        await context.change(() => { summary.focus(); summary.click() })
        assert.equal(menu.open, scope === 'outside-open-menu')
        const owner = scope === 'closed-summary' ? summary
          : document.querySelector<HTMLButtonElement>('.dbw-header-actions > .dbw-primary-button')!
        assert.ok(owner)
        for (const shortcut of shortcuts) {
          await context.change(() => owner.focus())
          assert.equal(document.activeElement === owner, true)
          const event = await context.key(owner, shortcut.key, shortcut.init)
          assert.equal(event.defaultPrevented, true, `${scope}: canvas ${shortcut.key} must remain available`)
          if (shortcut.destination === 'records') {
            const dialog = document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
            assert.ok(dialog)
            assert.equal(dialog.open, true)
            assert.equal(dialog.querySelector('h2')?.textContent, context.text.deleteRecord)
            assert.equal(dialog.querySelector('.app-confirm-body > p')?.textContent, `“${context.text.selected(1)}”`)
            const cancel = dialog.querySelector<HTMLButtonElement>('.secondary-button')!
            assert.ok(cancel)
            // Use the real button click: JSDOM keydown does not perform native Enter activation.
            await context.change(() => cancel.click())
            await context.flushRendererWork()
            assert.equal(document.querySelectorAll('.app-confirm-dialog').length, 0)
          } else {
            const expected = shortcut.destination === 'query' ? document.querySelector('.dbw-main-search input')
              : shortcut.destination === 'source' ? document.querySelector('.dbw-source-trigger')
                : document.querySelector('.dbw-new-view-menu > summary')
            assert.ok(expected)
            assert.equal(document.activeElement === expected, true)
            assert.equal(document.querySelectorAll('.app-confirm-dialog').length, 0)
          }
          assert.equal(document.querySelectorAll('.dbw-form-dialog').length, 0)
          assert.equal(menu.open, scope === 'outside-open-menu')
          context.assertContext()
        }
      }
    })
  })
}
