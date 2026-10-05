import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
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
  description: 'Original source description', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const field: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }
const record: DatabaseEntity = { id: 'selected-record', databaseId: database.id, title: 'Keep selected record', documentId: null,
  fieldValues: { notes: 'Original notes', hidden: 'Original hidden metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const view: DatabaseSavedView = { id: 'primary', databaseId: database.id, name: 'Original table',
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, field.id]), configVersion: 1,
  filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }

type Context = {
  document: Document
  window: JSDOM['window']
  text: ReturnType<typeof getDatabaseWorkspaceText>
  calls: { deletes: string[][]; reads: number; source: string[]; view: string[]; selection: string[][]; messages: unknown[] }
  focusCalls: HTMLElement[]
  change: (callback: () => void) => Promise<void>
  openSettings: () => Promise<HTMLButtonElement>
  key: (target: HTMLElement, key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  fillQuery: (raw: string) => Promise<void>
  flushFrames: () => Promise<void>
}

async function withWorkspace(locale: 'en-US' | 'zh-CN', run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside editor">', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  dom.window.requestAnimationFrame = requestFrame
  dom.window.cancelAnimationFrame = cancelFrame
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
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
  const calls: Context['calls'] = { deletes: [], reads: 0, source: [], view: [], selection: [], messages: [] }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    deleteDatabaseEntities: async ({ entityIds }: { entityIds: string[] }) => { calls.deletes.push([...entityIds]) },
    deleteDatabase: async (id: string) => { calls.deletes.push([id]) }
  } })
  const oldLanguage = getActiveUiText().language
  setActiveUiLanguage(locale)
  const text = getDatabaseWorkspaceText(locale)
  const data = structuredClone({ database, field, record, view })
  const before = structuredClone(data)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  try {
    await act(async () => root.render(createElement(DatabaseWorkspace, {
      currentDatabaseId: database.id, activeViewId: view.id, databases: [data.database], savedViews: [data.view], locale,
      catalogColumns: [], catalogDocuments: [], entities: [data.record], selectedColumns: [data.field], selectedRecordIds: [record.id],
      onActiveViewIdChange: id => { calls.view.push(id) }, onCurrentDatabaseIdChange: id => { calls.source.push(id) },
      onSelectedRecordIdsChange: ids => { calls.selection.push([...ids]) }, onOpenDocument: () => {},
      onMessage: message => { calls.messages.push(message) }, onRefresh: async () => { calls.reads++ }
    })))
    assert.equal(dom.window.document.querySelectorAll('.dbw-table tbody tr:not(.dbw-virtual-spacer)').length, 1)
    const selected = dom.window.document.querySelector<HTMLInputElement>('.dbw-table tbody input[type="checkbox"]')
    assert.ok(selected)
    assert.equal(selected.checked, true)
    const initialNotes = dom.window.document.querySelectorAll<HTMLInputElement>('.dbw-table tbody input.catalog-cell-input[aria-label="Notes"]')
    assert.equal(initialNotes.length, 1, 'The selected record must expose exactly one Notes cell')
    assert.equal(initialNotes[0].value, data.record.fieldValues.notes, 'Actual Table Notes must render its original stored value before any shortcut')
    await run({ document: dom.window.document, window: dom.window, text, calls, focusCalls, change,
      openSettings: async () => {
        const trigger = dom.window.document.querySelector<HTMLButtonElement>('.dbw-header-actions .dbw-menu-wrap > button')
        assert.ok(trigger)
        await change(() => { trigger.focus(); trigger.click() })
        const edit = dom.window.document.querySelector<HTMLButtonElement>('.dbw-action-menu > button')
        assert.ok(edit)
        assert.equal(edit.textContent, text.editDatabase)
        await change(() => edit.focus())
        assert.equal(dom.window.document.activeElement === edit, true)
        return edit
      },
      key: async (target, key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await change(() => target.dispatchEvent(event))
        return event as unknown as KeyboardEvent
      },
      fillQuery: raw => change(() => {
        const query = dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
        assert.ok(query)
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(query, raw)
        query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      flushFrames: () => change(() => {
        const pending = [...frames.values()]
        frames.clear()
        for (const callback of pending) callback(0)
      })
    })
    assert.deepEqual(data, before, 'Settings keyboard browsing must not mutate fixture records or configuration')
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

function assertNoRequests(context: Context) {
  assert.deepEqual(context.calls, { deletes: [], reads: 0, source: [], view: [], selection: [], messages: [] })
}

test('Database settings Delete does not target selected canvas records while an open-menu control owns focus', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withWorkspace(locale, async context => {
      const edit = await context.openSettings()
      const owner = locale === 'zh-CN'
        ? context.document.querySelector<HTMLButtonElement>('.dbw-header-actions .dbw-menu-wrap > button')!
        : edit
      assert.ok(owner)
      if (owner !== edit) {
        assert.equal(owner.getAttribute('aria-expanded'), 'true')
        await context.change(() => owner.focus())
      }
      assert.equal(context.document.activeElement === owner, true)
      context.focusCalls.length = 0
      const event = await context.key(owner, 'Delete')
      assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0, `${locale}: Menu Delete must not open a records confirmation`)
      assert.equal(context.document.activeElement === owner, true)
      assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 1)
      assert.equal(event.defaultPrevented, false)
      assert.equal(context.focusCalls.length, 0)
      assertNoRequests(context)
    })
  }
})

test('Database settings children yield canvas slash and source/view shortcuts without moving focus', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withWorkspace(locale, async context => {
      const edit = await context.openSettings()
      context.focusCalls.length = 0
      for (const shortcut of [{ key: '/' }, { key: 'L', ctrlKey: true, shiftKey: true }, { key: 'V', ctrlKey: true, shiftKey: true }]) {
        const { key, ...init } = shortcut
        const event = await context.key(edit, key, init)
        assert.equal(context.document.activeElement === edit, true, `${locale}: ${key} must leave the menu's actual focus owner alone`)
        assert.equal(event.defaultPrevented, false)
        assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 1)
        assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
        assert.equal(context.focusCalls.length, 0)
        assertNoRequests(context)
      }
    })
  }
})

const shortcuts: Array<{ key: string; init?: KeyboardEventInit; destination: 'query' | 'source' | 'view' | 'records' }> = [
  { key: '/', destination: 'query' },
  { key: 'L', init: { ctrlKey: true, shiftKey: true }, destination: 'source' },
  { key: 'L', init: { metaKey: true, shiftKey: true }, destination: 'source' },
  { key: 'V', init: { ctrlKey: true, shiftKey: true }, destination: 'view' },
  { key: 'V', init: { metaKey: true, shiftKey: true }, destination: 'view' },
  { key: 'Delete', destination: 'records' }
]

function assertCurrentContext(context: Context, raw = '') {
  assert.equal(context.document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value, raw)
  assert.equal(context.document.querySelector<HTMLInputElement>('.dbw-table tbody input[type="checkbox"]')?.checked, true)
  assert.equal(context.document.querySelector('.dbw-view-tab[aria-current="page"]')?.getAttribute('title'), view.name)
  assert.equal(context.document.querySelector('.dbw-record-title strong')?.textContent, record.title)
  // Selection also renders a blank Notes bulk editor above the table. The
  // preserved value belongs to the actual selected record's Table cell.
  const notes = context.document.querySelectorAll<HTMLInputElement>('.dbw-table tbody input.catalog-cell-input[aria-label="Notes"]')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].value, record.fieldValues.notes)
  assertNoRequests(context)
}

test('Database settings Edit, Delete and expanded trigger all preserve the current view and selection under canvas shortcuts', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withWorkspace(locale, async context => {
      const raw = ' Keep selected '
      await context.fillQuery(raw)
      const edit = await context.openSettings()
      const remove = context.document.querySelector<HTMLButtonElement>('.dbw-action-menu .dbw-danger-text')
      const trigger = context.document.querySelector<HTMLButtonElement>('.dbw-header-actions .dbw-menu-wrap > button')
      assert.ok(remove); assert.ok(trigger)
      assert.equal(remove.textContent, context.text.deleteDatabase)
      for (const owner of [edit, remove, trigger]) {
        for (const shortcut of shortcuts) {
          await context.change(() => owner.focus())
          assert.equal(context.document.activeElement === owner, true)
          assert.equal(trigger.getAttribute('aria-expanded'), 'true')
          context.focusCalls.length = 0
          const event = await context.key(owner, shortcut.key, shortcut.init)
          assert.equal(context.document.activeElement === owner, true)
          assert.equal(event.defaultPrevented, false)
          assert.equal(context.focusCalls.length, 0)
          assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 1)
          assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
          assertCurrentContext(context, raw)
        }
      }
    })
  }
})

test('Closed settings and actual outside focus retain the existing canvas shortcuts after menu dismissal', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    for (const scope of ['closed-trigger', 'outside-menu-dismissal'] as const) {
      await withWorkspace(locale, async context => {
        const raw = ' Keep selected '
        await context.fillQuery(raw)
        await context.openSettings()
        const trigger = context.document.querySelector<HTMLButtonElement>('.dbw-header-actions .dbw-menu-wrap > button')!
        if (scope === 'closed-trigger') await context.change(() => trigger.click())
        const owner = scope === 'closed-trigger' ? trigger
          : context.document.querySelector<HTMLButtonElement>('.dbw-header-actions > .dbw-primary-button')!
        assert.ok(owner)
        for (const shortcut of shortcuts) {
          if (scope === 'outside-menu-dismissal') {
            if (trigger.getAttribute('aria-expanded') === 'false') await context.openSettings()
            assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 1)
          }
          await context.change(() => owner.focus())
          assert.equal(context.document.activeElement === owner, true)
          assert.equal(trigger.getAttribute('aria-expanded'), 'false')
          const event = await context.key(owner, shortcut.key, shortcut.init)
          assert.equal(event.defaultPrevented, true, `${scope}: Existing canvas shortcut must still be accepted`)
          if (shortcut.destination === 'records') {
            const dialog = context.document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
            assert.ok(dialog)
            assert.equal(dialog.querySelector('h2')?.textContent, context.text.deleteRecord)
            assert.equal(dialog.querySelector('.app-confirm-body > p')?.textContent, `“${context.text.selected(1)}”`)
            assert.equal(dialog.open, true)
            assert.equal(context.document.querySelectorAll('.dbw-form-dialog').length, 0)
            const cancel = dialog.querySelector<HTMLButtonElement>('.secondary-button')
            assert.ok(cancel)
            await context.change(() => cancel.click())
            await context.flushFrames()
            assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
          } else {
            const expected = shortcut.destination === 'query' ? context.document.querySelector('.dbw-main-search input')
              : shortcut.destination === 'source' ? context.document.querySelector('.dbw-source-trigger')
                : context.document.querySelector('.dbw-new-view-menu > summary')
            assert.ok(expected)
            assert.equal(context.document.activeElement === expected, true)
            assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
          }
          assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 0)
          assertCurrentContext(context, raw)
        }
      })
    }
  }
})

test('Database settings actual Edit and Delete clicks keep their distinct form and confirmation targets', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withWorkspace(locale, async context => {
      const raw = ' Keep selected '
      await context.fillQuery(raw)
      const edit = await context.openSettings()
      const trigger = context.document.querySelector<HTMLButtonElement>('.dbw-header-actions .dbw-menu-wrap > button')!
      // JSDOM does not synthesize native button activation from Enter: invoke
      // the actual DOM button click, while Electron covers Enter and Space.
      await context.change(() => edit.click())
      const form = context.document.querySelector<HTMLFormElement>('.dbw-form-dialog')
      assert.ok(form)
      assert.equal(form.querySelector('h2')?.textContent, context.text.editDatabase)
      assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
      assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 0)
      await context.flushFrames()
      const name = form.querySelector<HTMLInputElement>('input')!
      const description = form.querySelector<HTMLTextAreaElement>('textarea')!
      assert.equal(name.value, database.name)
      assert.equal(description.value, database.description)
      assert.equal(context.document.activeElement === name, true)
      const cancelForm = form.querySelector<HTMLButtonElement>('footer .dbw-quiet-button')!
      await context.change(() => cancelForm.click())
      await context.flushFrames()
      assert.equal(context.document.querySelectorAll('.dbw-form-dialog').length, 0)
      assert.equal(context.document.activeElement === trigger, true)
      assert.equal(context.document.querySelector('.dbw-header-actions .dbw-menu-wrap > button') === trigger, true)
      assertCurrentContext(context, raw)
      await context.openSettings()
      const remove = context.document.querySelector<HTMLButtonElement>('.dbw-action-menu .dbw-danger-text')!
      await context.change(() => { remove.focus(); remove.click() })
      const confirmation = context.document.querySelector<HTMLDialogElement>('.app-confirm-dialog')
      assert.ok(confirmation)
      assert.equal(confirmation.querySelector('h2')?.textContent, context.text.deleteDatabase)
      assert.equal(confirmation.querySelector('.app-confirm-body > p')?.textContent, `“${database.name}”`)
      assert.equal(context.document.querySelectorAll('.dbw-action-menu').length, 0)
      const cancelConfirmation = confirmation.querySelector<HTMLButtonElement>('.secondary-button')!
      await context.change(() => cancelConfirmation.click())
      await context.flushFrames()
      assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
      assertCurrentContext(context, raw)
    })
  }
})
