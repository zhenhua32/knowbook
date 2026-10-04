import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, Fragment, useReducer, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { notify } from '../src/renderer/src/notify'
import { getActiveUiText, setActiveUiLanguage } from '../src/renderer/src/i18n'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
await Promise.all([import('../src/renderer/src/components/AppNotificationList'),
  import('../src/renderer/src/notification-history'), import('../src/renderer/src/backup-notifications')])
const { AppNotificationHost } = await import('../src/renderer/src/components/AppNotificationHost')
const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')
const { DatabaseMultiSelectCellCache } = await import('../src/renderer/src/features/database/model/databaseMultiSelectCells')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const database: DocumentDatabase = { id: 'colors', kind: 'custom', name: 'Original colors source',
  description: 'Original source description', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const tags: DocumentDatabaseColumn = { id: 'tags', name: 'Tags', type: 'multi-select',
  options: ['Blue', 'Red', 'Green'], sortOrder: 0 }
const record: DatabaseEntity = { id: 'selected-record', databaseId: database.id, title: 'Original selected record', documentId: null,
  fieldValues: { tags: ['Blue'], hidden: 'Untouched hidden metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const view: DatabaseSavedView = { id: 'original-view', databaseId: database.id, name: 'Original table',
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, tags.id]), configVersion: 1,
  filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }

function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) {
    appNotifications.dismiss(id)
  }
  appNotifications.clearCompleted()
}

type Request = ReturnType<typeof deferred<DatabaseEntity>> & { payload: UpdateDatabaseEntityInput; source: string }
type Read = ReturnType<typeof deferred<void>> & { source: string; canApply: () => boolean }
type Model = { source: string; shown: boolean; columns: DocumentDatabaseColumn[]; entities: DatabaseEntity[] }
type Menu = { details: HTMLDetailsElement; summary: HTMLElement; option: (name: string) => HTMLInputElement }

async function withWorkspace(locale: 'en-US' | 'zh-CN', run: (context: {
  document: Document; details: HTMLDetailsElement; summary: HTMLElement; red: HTMLInputElement
  window: JSDOM['window']; menu: () => Menu; requests: Request[]; readRequests: Read[]; focusCalls: HTMLElement[]
  reads: () => number; writes: () => number; stored: () => unknown; disk: (source?: string) => DatabaseEntity[]
  reject: (reason: unknown) => Promise<void>; change: (callback: () => void) => Promise<void>
  rejectAt: (index: number, reason?: unknown) => Promise<void>; ack: (index: number) => Promise<void>
  read: (index: number, failed?: boolean) => Promise<void>; open: () => Promise<Menu>; close: () => Promise<void>
  update: (patch: Partial<Model>) => Promise<void>; move: (top: number) => Promise<void>
  external: (value: string[], revision: string, otherFields?: DatabaseEntity['fieldValues']) => Promise<void>; context: () => unknown
}) => Promise<void>, options: { virtual?: boolean } = {}) {
  clearNotifications()
  const oldLanguage = getActiveUiText().language
  setActiveUiLanguage(locale)
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  class LayoutObserver { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: LayoutObserver })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    ResizeObserver: LayoutObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 320, 40) }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true,
    get() { return (this as HTMLElement).classList.contains('dbw-table-scroll') ? 200 : 0 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
    const element = this as HTMLElement
    if (!element.classList.contains('dbw-table-scroll')) return 0
    const padding = [...element.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')]
      .reduce((sum, spacer) => sum + Number.parseFloat(spacer.style.height), 0)
    return 40 + element.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length * 64 + padding
  } })
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (settings) { focusCalls.push(this); nativeFocus.call(this, settings) }
  const stored = structuredClone({ database, tags, record, view })
  const initial = structuredClone(stored)
  const sources = [stored.database, { ...structuredClone(stored.database), id: 'other-colors', name: 'Other colors source' }]
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(sources.map(source => [source.id,
    [ { ...structuredClone(stored.record), databaseId: source.id }, ...Array.from({ length: options.virtual ? 59 : 0 }, (_, index) => ({
      ...structuredClone(stored.record), databaseId: source.id, id: `other-${index}`, title: `Original zz record ${index}`
    })) ]]))
  const requests: Request[] = [], contextChanges: unknown[] = []
  const readRequests: Read[] = []
  const multiSelectCache = new DatabaseMultiSelectCellCache()
  let writes = 0, current!: Model, setModel!: (action: SetStateAction<Model>) => void
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (payload: UpdateDatabaseEntityInput) => {
      const request = { ...deferred<DatabaseEntity>(), payload: structuredClone(payload), source: current.source }
      requests.push(request)
      return request.promise
    },
    onPluginNotification: () => () => {}, onBackupHealth: () => () => {},
    getBackupHealth: async () => ({ revision: 0, error: null })
  } })
  const refresh = async (source = current.source, _preferred?: string, shouldContinue?: () => boolean) => {
    const request = { ...deferred<void>(), source, canApply: shouldContinue ?? (() => true) }
    readRequests.push(request)
    await request.promise
    if (!request.canApply() || current.source !== source || !current.shown) return false
    const entities = structuredClone(server[source])
    setModel(previous => request.canApply() && previous.source === source && previous.shown ? { ...previous, entities } : previous)
    return true
  }
  function Harness() {
    const [model, update] = useReducer((previous: Model, action: SetStateAction<Model>) =>
      typeof action === 'function' ? action(previous) : action,
    { source: stored.database.id, shown: true, columns: [stored.tags], entities: structuredClone(server[stored.database.id]) })
    current = model; setModel = update
    return createElement(Fragment, null, model.shown ? createElement(DatabaseWorkspace, {
      activeViewId: stored.view.id, currentDatabaseId: model.source, databases: sources,
      savedViews: [{ ...stored.view, databaseId: model.source }], locale,
      catalogDocuments: [], catalogColumns: [], entities: model.entities, selectedColumns: model.columns, selectedRecordIds: [stored.record.id],
      multiSelectCache,
      onActiveViewIdChange: id => contextChanges.push(['view', id]),
      onCurrentDatabaseIdChange: id => contextChanges.push(['source', id]),
      onSelectedRecordIdsChange: ids => contextChanges.push(['selection', [...ids]]), onOpenDocument: () => {},
      onMessage: notify, onRefresh: refresh
    }) : null, createElement(AppNotificationHost, { isZh: locale === 'zh-CN', onOpenDocument: () => {} }))
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const menu = (): Menu => {
    const row = [...dom.window.document.querySelectorAll('.dbw-table tbody tr:not(.dbw-virtual-spacer)')]
      .find(candidate => candidate.querySelector('.dbw-record-title strong')?.textContent === record.title)
    const details = row?.querySelector<HTMLDetailsElement>('.dbw-multi-editor')
    assert.ok(details)
    const summary = details.querySelector<HTMLElement>('summary')!
    return { details, summary, option: name => {
      const input = [...details.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
        .find(candidate => candidate.parentElement?.textContent === name)
      assert.ok(input, `The actual Tags menu must contain option ${name}`); return input
    } }
  }
  const toggle = async (open: boolean) => {
    const currentMenu = menu()
    if (currentMenu.details.open !== open) await act(async () => {
      currentMenu.summary.click()
      await new Promise<void>(resolve => dom.window.setTimeout(resolve, 0))
    })
    assert.equal(currentMenu.details.open, open)
    return currentMenu
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    const row = dom.window.document.querySelector('.dbw-table tbody tr:not(.dbw-virtual-spacer)')
    assert.ok(row)
    const details = row.querySelector<HTMLDetailsElement>('.dbw-multi-editor')!
    const summary = details.querySelector<HTMLElement>('summary')!
    const red = [...details.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find(input => input.parentElement?.textContent === 'Red')!
    assert.ok(details && summary && red)
    assert.equal(summary.textContent, 'Blue')
    assert.equal(red.checked, false)
    const query = dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
    await change(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(query, 'Original')
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await toggle(true)
    assert.equal(details.open, true)
    assert.equal(query.value, 'Original')
    assert.equal(row.querySelector<HTMLInputElement>('.dbw-select-column input')?.checked, true)
    assert.ok(dom.window.document.querySelector('.dbw-source-trigger')?.textContent?.includes(stored.database.name))
    assert.equal(dom.window.document.querySelector('.dbw-view-tab-wrap.is-active .dbw-view-tab')?.textContent, stored.view.name)
    await run({ document: dom.window.document, window: dom.window, details, summary, red, menu, requests, readRequests, focusCalls, change,
      reads: () => readRequests.length, writes: () => writes, stored: () => structuredClone(stored),
      disk: (source = database.id) => structuredClone(server[source]), open: () => toggle(true), close: async () => { await toggle(false) },
      reject: async reason => { assert.equal(requests.length, 1); await act(async () => requests[0].reject(reason)) },
      rejectAt: async (index, reason = new Error('Isolated multi-select failure')) => {
        assert.ok(requests[index]); await act(async () => requests[index].reject(reason))
      },
      ack: async index => {
        const request = requests[index]; assert.ok(request)
        const previous = server[request.source].find(entity => entity.id === request.payload.entityId)!
        assert.ok(previous)
        const next = { ...previous, fieldValues: { ...previous.fieldValues, ...structuredClone(request.payload.fieldValues) },
          updatedAt: `2026-10-02T00:00:0${++writes}.000Z` }
        server[request.source] = server[request.source].map(entity => entity.id === next.id ? next : entity)
        await act(async () => request.resolve(structuredClone(next)))
      },
      read: async (index, failed = false) => { assert.ok(readRequests[index]); await act(async () => {
        if (failed) readRequests[index].reject(new Error('Isolated read failure'))
        else readRequests[index].resolve()
      }) },
      update: async patch => { await act(async () => setModel(previous => ({ ...previous, ...patch }))) },
      move: async top => { await change(() => {
        const scroll = dom.window.document.querySelector<HTMLDivElement>('.dbw-table-scroll')!
        assert.ok(scroll); scroll.scrollTop = top; scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
      }) },
      external: async (value, revision, otherFields = {}) => {
        server[current.source] = server[current.source].map(entity => entity.id === record.id
          ? { ...entity, fieldValues: { ...entity.fieldValues, ...structuredClone(otherFields), tags: [...value] }, updatedAt: revision } : entity)
        await act(async () => setModel(previous => ({ ...previous, entities: structuredClone(server[previous.source]) })))
      },
      context: () => ({ query: query.value, source: dom.window.document.querySelector('.dbw-source-trigger')?.textContent,
        activeView: dom.window.document.querySelector('.dbw-view-tab-wrap.is-active .dbw-view-tab')?.textContent,
        selected: row.querySelector<HTMLInputElement>('.dbw-select-column input')?.checked, changes: structuredClone(contextChanges) })
    })
    assert.deepEqual(stored, initial)
  } finally {
    await act(async () => root.unmount())
    await act(async () => requests.forEach(request => request.resolve(structuredClone(stored.record))))
    await act(async () => readRequests.forEach(request => request.resolve()))
    clearNotifications()
    setActiveUiLanguage(oldLanguage)
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`a rejected multi-select save rolls the still-open menu back to its stored value in ${locale}`, async () => {
    await withWorkspace(locale, async context => {
      const before = context.stored(), beforeDisk = context.disk(), owner = context.context()
      await context.change(() => context.red.click())
      assert.equal(context.requests.length, 1)
      assert.deepEqual(context.requests[0].payload, { entityId: record.id, fieldValues: { tags: ['Blue', 'Red'] } })
      assert.equal(context.writes(), 0)
      await context.reject(new Error('The isolated multi-select write was rejected.'))
      assert.equal(appNotifications.getSnapshot().length, 1, 'the actual Workspace failure must reach notify and the notification store')
      assert.equal(context.document.querySelectorAll('.app-notification [role="alert"]').length, 1,
        'the real notification Host must have rendered the completed failure before checking rollback')
      const text = getDatabaseWorkspaceText(locale)
      assert.equal(context.document.querySelector('.app-notification-message')?.textContent, text.multiSelectSaveFailed)
      assert.equal(context.details.open, true)
      assert.equal(context.red.checked, false, 'an unsaved option must not remain checked after the write failed')
      assert.equal(context.summary.textContent, 'Blue', 'the summary must describe the stored value rather than the rejected optimistic draft')
      assert.equal(context.requests.length, 1)
      assert.equal(context.reads(), 0)
      assert.equal(context.writes(), 0)
      assert.deepEqual(context.stored(), before)
      assert.deepEqual(context.disk(), beforeDisk)
      assert.deepEqual(context.context(), owner)
      assert.equal(context.details.querySelector('.dbw-multi-feedback[role="alert"]')?.textContent, text.multiSelectSaveFailed)
      assert.equal(context.details.querySelectorAll('button').length, 0, 'the failed choice is retried by choosing it again')
      await context.change(() => context.red.click())
      assert.equal(context.requests.length, 2)
      assert.deepEqual(context.requests[1].payload, context.requests[0].payload)
      await context.ack(1)
      assert.equal(context.writes(), 1)
      assert.equal(context.reads(), 1)
      assert.equal(context.red.checked, true)
      assert.equal(context.summary.textContent, 'Blue · Red')
      await context.read(0)
      assert.deepEqual(context.disk()[0].fieldValues, { ...beforeDisk[0].fieldValues, tags: ['Blue', 'Red'] })
      assert.deepEqual({ ...context.disk()[0], fieldValues: beforeDisk[0].fieldValues, updatedAt: beforeDisk[0].updatedAt }, beforeDisk[0])
      assert.deepEqual(context.context(), owner)
      assert.equal(context.requests.length, 2)
      assert.equal(context.writes(), 1)
    })
  })
}

test('pending multi-select choices stay focusable and repeated native clicks share one write', async () => {
  await withWorkspace('en-US', async context => {
    const before = context.disk(), owner = context.context(), red = context.red
    await context.change(() => red.focus())
    context.focusCalls.length = 0
    await context.change(() => red.click())
    assert.equal(context.requests.length, 1)
    assert.equal(red.disabled, false)
    assert.equal(red.getAttribute('aria-disabled'), 'true')
    assert.equal(red.getAttribute('aria-busy'), 'true')
    assert.equal(context.document.activeElement === red, true)
    const green = context.menu().option('Green')
    await context.change(() => {
      red.click(); red.click(); green.click()
      // JSDOM does not synthesize a checkbox's Space activation; native E2E
      // covers that default action, while these are actual DOM click changes.
      red.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    assert.equal(context.requests.length, 1)
    assert.equal(red.checked, true)
    assert.equal(green.checked, false)
    assert.equal(context.document.activeElement === red, true)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.disk(), before)
    await context.ack(0)
    assert.equal(context.reads(), 1)
    assert.equal(red.disabled, false)
    assert.notEqual(red.getAttribute('aria-disabled'), 'true', 'the durable ACK releases the write lock before its read completes')
    assert.equal(context.document.activeElement === red, true)
    await context.read(0)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.writes(), 1)
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.context(), owner)
  })
})

test('real virtual-row and workspace remounts retain the physical multi-select write lock', async () => {
  await withWorkspace('zh-CN', async context => {
    const before = context.disk(), first = context.details
    await context.change(() => context.red.click())
    assert.equal(context.requests.length, 1)
    await context.move(3000)
    assert.equal(first.isConnected, false, 'the actual Table virtual slice must unmount the accepted cell')
    await context.move(0)
    const virtual = await context.open()
    assert.equal(virtual.details === first, false)
    assert.equal(virtual.option('Red').checked, true)
    assert.equal(virtual.option('Red').getAttribute('aria-disabled'), 'true')
    await context.change(() => virtual.option('Green').click())
    assert.equal(context.requests.length, 1)
    await context.update({ shown: false })
    assert.equal(virtual.details.isConnected, false)
    await context.update({ shown: true })
    const reopened = await context.open()
    assert.equal(reopened.option('Red').checked, true)
    await context.change(() => reopened.option('Red').click())
    assert.equal(context.requests.length, 1)
    await context.rejectAt(0)
    assert.equal(reopened.option('Red').checked, false)
    assert.equal(reopened.summary.textContent, 'Blue')
    assert.equal(reopened.details.querySelector('.dbw-multi-feedback[role="alert"]')?.textContent,
      getDatabaseWorkspaceText('zh-CN').multiSelectSaveFailed)
    assert.equal(appNotifications.getSnapshot().length, 0, 'a disposed Workspace must not emit a late global notification')
    assert.deepEqual(context.disk(), before)
    await context.change(() => reopened.option('Green').click())
    assert.equal(context.requests.length, 2)
    assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { tags: ['Blue', 'Green'] } })
    await context.ack(1)
    await context.read(0)
    assert.equal(context.writes(), 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, tags: ['Blue', 'Green'] })
    assert.deepEqual(context.disk().slice(1), before.slice(1))
  }, { virtual: true })
})

test('a newer accepted multi-select choice is not unlocked or overwritten by an older post-ACK read', async () => {
  for (const scenario of [{ failOldRead: false, ackBeforeOldRead: false }, { failOldRead: true, ackBeforeOldRead: true }]) {
    await withWorkspace('en-US', async context => {
      const before = context.disk(), owner = context.context()
      await context.change(() => context.red.click())
      await context.ack(0)
      assert.equal(context.reads(), 1)
      assert.equal(context.summary.textContent, 'Blue · Red')
      const green = context.menu().option('Green')
      await context.change(() => { green.focus(); green.click() })
      context.focusCalls.length = 0
      assert.equal(context.requests.length, 2)
      assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { tags: ['Blue', 'Red', 'Green'] } })
      assert.equal(green.getAttribute('aria-busy'), 'true')
      assert.equal(green.getAttribute('aria-disabled'), 'true')
      if (scenario.ackBeforeOldRead) {
        await context.ack(1)
        assert.equal(context.reads(), 1, 'the newer ACK may finish, but its physical read must wait for the earlier read')
        assert.notEqual(green.getAttribute('aria-disabled'), 'true')
      }
      await context.read(0, scenario.failOldRead)
      if (!scenario.ackBeforeOldRead) {
        assert.equal(green.getAttribute('aria-busy'), 'true', 'an old read cannot release the newer mutation lock')
        assert.equal(green.getAttribute('aria-disabled'), 'true')
      }
      assert.equal(context.summary.textContent, scenario.ackBeforeOldRead ? 'Blue · Red · Green' : getDatabaseWorkspaceText('en-US').saving)
      assert.equal(context.summary.title, 'Blue · Red · Green')
      assert.equal(context.menu().option('Blue').checked, true)
      assert.equal(context.menu().option('Red').checked, true)
      assert.equal(green.checked, true)
      assert.equal(context.document.activeElement === green, true)
      assert.equal(context.focusCalls.length, 0)
      assert.equal(appNotifications.getSnapshot().length, 0)
      if (!scenario.ackBeforeOldRead) await context.ack(1)
      assert.equal(context.reads(), 2)
      await context.read(1)
      assert.equal(context.summary.textContent, 'Blue · Red · Green')
      assert.equal(context.document.activeElement === green, true)
      assert.equal(context.focusCalls.length, 0)
      assert.equal(context.requests.length, 2)
      assert.equal(context.writes(), 2)
      assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, tags: ['Blue', 'Red', 'Green'] })
      assert.deepEqual(context.context(), owner)
    })
  }
})

test('saved multi-select choices survive close/reopen and a failed read offers only a single-flight Refresh', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withWorkspace(locale, async context => {
      const before = context.disk(), text = getDatabaseWorkspaceText(locale)
      await context.change(() => context.red.click())
      await context.ack(0)
      await context.close()
      const reopened = await context.open()
      assert.equal(reopened.summary.textContent, 'Blue · Red', 'closing must not roll a durable ACK back to lagging props')
      await context.read(0, true)
      assert.equal(reopened.option('Red').checked, true)
      assert.equal(reopened.details.querySelector('.dbw-multi-feedback')?.textContent, text.savedRefreshFailed)
      assert.equal(appNotifications.getSnapshot()[0]?.message, text.savedRefreshFailed)
      const refresh = reopened.details.querySelector<HTMLButtonElement>('button')
      assert.ok(refresh)
      assert.equal(refresh.textContent, text.refresh)
      await context.change(() => { refresh.focus(); refresh.click(); refresh.click() })
      context.focusCalls.length = 0
      assert.equal(context.reads(), 2)
      assert.equal(context.requests.length, 1)
      assert.equal(context.writes(), 1)
      await context.read(1)
      assert.equal(context.summary.textContent, 'Blue · Red')
      assert.equal(context.requests.length, 1)
      assert.equal(context.writes(), 1)
      assert.equal(context.focusCalls.length, 0)
      assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, tags: ['Blue', 'Red'] })
    })
  }
})

test('external values, source changes and replaced options isolate late multi-select replies', async () => {
  await withWorkspace('en-US', async context => {
    const original = context.disk()
    await context.change(() => context.red.click())
    await context.external(['Blue'], '2026-10-03', { hidden: 'Another property was saved while Tags were pending' })
    await context.ack(0)
    assert.equal(context.summary.textContent, 'Blue · Red', 'another property revision cannot overrule this Tags write ACK')
    assert.equal(context.red.checked, true)
    await context.read(0)
    assert.deepEqual(context.disk()[0].fieldValues, { ...original[0].fieldValues,
      hidden: 'Another property was saved while Tags were pending', tags: ['Blue', 'Red'] })
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
  })
  await withWorkspace('en-US', async context => {
    await context.change(() => context.red.click())
    await context.external(['Green'], '2026-10-03')
    await context.rejectAt(0)
    assert.equal(context.menu().summary.textContent, 'Green')
    assert.equal(context.menu().option('Red').checked, false)
    assert.equal(context.menu().option('Blue').checked, false)
    assert.equal(context.menu().option('Green').checked, true)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.equal(appNotifications.getSnapshot()[0].message, getDatabaseWorkspaceText('en-US').multiSelectSaveFailed)
    assert.equal(context.reads(), 0)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 0)
  })
  await withWorkspace('zh-CN', async context => {
    const beforeA = context.disk(), beforeB = context.disk('other-colors')
    await context.change(() => context.red.click())
    await context.update({ source: 'other-colors', entities: beforeB })
    const other = await context.open()
    await context.change(() => other.option('Green').click())
    assert.equal(context.requests.length, 2)
    await context.rejectAt(0)
    assert.equal(other.option('Green').checked, true)
    assert.equal(other.option('Green').getAttribute('aria-busy'), 'true')
    assert.equal(appNotifications.getSnapshot().length, 0)
    await context.ack(1)
    assert.equal(context.readRequests[0].source, 'other-colors')
    await context.read(0)
    assert.equal(other.summary.textContent, 'Blue · Green')
    assert.deepEqual(context.disk(), beforeA)
    assert.deepEqual(context.disk('other-colors')[0].fieldValues, { ...beforeB[0].fieldValues, tags: ['Blue', 'Green'] })
    assert.equal(context.requests.length, 2)
  })
  await withWorkspace('en-US', async context => {
    const before = context.disk()
    await context.change(() => context.red.click())
    await context.update({ columns: [] })
    assert.equal(context.document.querySelectorAll('.dbw-table tbody .dbw-multi-editor').length, 0)
    await context.update({ columns: [{ ...tags, options: ['Blue', 'Green', 'Purple'] }] })
    const replacement = await context.open()
    assert.equal(replacement.option('Green').disabled, false)
    await context.change(() => replacement.option('Green').click())
    assert.equal(context.requests.length, 1, 'a schema replacement cannot release a physically pending write to the same logical cell')
    await context.rejectAt(0)
    assert.equal(replacement.summary.textContent, 'Blue')
    assert.equal(replacement.details.querySelectorAll('.dbw-multi-feedback').length, 0)
    assert.equal(appNotifications.getSnapshot().length, 0)
    await context.change(() => replacement.option('Green').click())
    assert.equal(context.requests.length, 2)
    assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { tags: ['Blue', 'Green'] } })
    await context.rejectAt(1)
    assert.equal(replacement.summary.textContent, 'Blue')
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.deepEqual(context.disk(), before)
    assert.equal(context.writes(), 0)
  })
})

test('the real RecordDrawer synchronous draft setter keeps comma-containing choices without cell IPC or a saving state', async () => {
  await withWorkspace('en-US', async context => {
    const before = context.disk()
    await context.update({ columns: [{ ...tags, options: ['Blue', 'Red, warm'] }] })
    const title = context.document.querySelector<HTMLButtonElement>('.dbw-table tbody .dbw-record-title')!
    assert.ok(title)
    await context.change(() => title.click())
    const drawer = context.document.querySelector('.dbw-record-drawer')
    assert.ok(drawer)
    const details = drawer.querySelector<HTMLDetailsElement>('.dbw-multi-editor')!
    assert.ok(details)
    const summary = details.querySelector<HTMLElement>('summary')!
    await act(async () => {
      summary.click()
      await new Promise<void>(resolve => context.window.setTimeout(resolve, 0))
    })
    const comma = [...details.querySelectorAll<HTMLInputElement>('input')]
      .find(input => input.parentElement?.textContent === 'Red, warm')!
    assert.ok(comma)
    await context.change(() => { comma.focus(); comma.click() })
    context.focusCalls.length = 0
    assert.equal(comma.checked, true)
    assert.equal(summary.textContent, 'Blue · Red, warm')
    assert.notEqual(comma.getAttribute('aria-busy'), 'true')
    assert.notEqual(comma.getAttribute('aria-disabled'), 'true')
    assert.equal(context.document.activeElement === comma, true)
    assert.equal(context.requests.length, 0)
    await act(async () => {
      summary.click(); await new Promise<void>(resolve => context.window.setTimeout(resolve, 0))
      summary.click(); await new Promise<void>(resolve => context.window.setTimeout(resolve, 0))
    })
    assert.equal(comma.checked, true)
    assert.equal(summary.textContent, 'Blue · Red, warm')
    const save = [...drawer.querySelectorAll<HTMLButtonElement>('footer button')]
      .find(button => button.textContent === getDatabaseWorkspaceText('en-US').save)!
    assert.ok(save)
    await context.change(() => save.click())
    assert.equal(context.requests.length, 1, 'editing the draft is synchronous; only the explicit record Save reaches IPC')
    assert.deepEqual(context.requests[0].payload.fieldValues, { tags: ['Blue', 'Red, warm'] })
    assert.equal(context.writes(), 0)
    assert.deepEqual(context.disk(), before)
  })
})

test('a genuine multi-select ACK overrides older external props even when its follow-up read fails', async () => {
  await withWorkspace('en-US', async context => {
    const before = context.disk(), owner = context.context(), text = getDatabaseWorkspaceText('en-US')
    await context.change(() => context.red.click())
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].payload, { entityId: record.id, fieldValues: { tags: ['Blue', 'Red'] } })
    // A separate backend change is published before this deferred write runs.
    // Its legal timestamp precedes the actual fixture ACK timestamp.
    await context.external(['Green'], '2026-10-01T12:00:00.000Z')
    assert.deepEqual(context.disk()[0].fieldValues.tags, ['Green'])
    await context.ack(0)
    assert.deepEqual(context.disk()[0].fieldValues.tags, ['Blue', 'Red'])
    assert.equal(context.writes(), 1)
    assert.equal(context.reads(), 1)
    await context.read(0, true)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.equal(context.reads(), 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, tags: ['Blue', 'Red'] })
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.deepEqual(context.context(), owner)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.equal(appNotifications.getSnapshot()[0].message, text.savedRefreshFailed)
    assert.equal(context.details.querySelector('.dbw-multi-feedback')?.textContent, text.savedRefreshFailed)
    assert.equal(context.summary.textContent, 'Blue · Red', 'an accepted durable write must take precedence over pre-ACK Green props')
    assert.equal(context.summary.title, 'Blue · Red')
    assert.equal(context.menu().option('Blue').checked, true)
    assert.equal(context.menu().option('Red').checked, true)
    assert.equal(context.menu().option('Green').checked, false)
  })
})

test('new stored multi-select values replace a failed-read overlay without clearing its read-recovery hint', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withWorkspace(locale, async context => {
      const before = context.disk(), owner = context.context(), text = getDatabaseWorkspaceText(locale)
      await context.change(() => { context.red.focus(); context.red.click() })
      context.focusCalls.length = 0
      await context.ack(0)
      await context.read(0, true)
      assert.equal(context.summary.textContent, 'Blue · Red')
      assert.equal(context.details.querySelector('.dbw-multi-feedback')?.textContent, text.savedRefreshFailed)
      assert.equal(context.requests.length, 1)
      assert.equal(context.writes(), 1)
      const originalInput = context.red, originalSummary = context.summary

      await context.external(['Green'], '2026-10-03T00:00:00.000Z')
      assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, tags: ['Green'] })
      assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
      assert.deepEqual(context.context(), owner)
      assert.equal(context.requests.length, 1, 'publishing another stored value cannot perform a new UI write')
      assert.equal(context.writes(), 1)
      assert.equal(context.reads(), 1)
      assert.equal(context.menu().option('Red') === originalInput, true)
      assert.equal(context.menu().summary === originalSummary, true)
      assert.equal(context.document.activeElement === originalInput, true)
      assert.equal(context.focusCalls.length, 0)
      // The same source/schema now has a genuinely newer stored Tags value.
      assert.equal(context.summary.textContent, 'Green')
      assert.equal(context.summary.title, 'Green')
      assert.equal(context.menu().option('Green').checked, true)
      assert.equal(context.menu().option('Red').checked, false)
      assert.equal(context.menu().option('Blue').checked, false)
      const feedback = context.details.querySelector('.dbw-multi-feedback')!
      assert.equal(feedback.textContent, text.savedRefreshFailed)
      assert.equal(feedback.getAttribute('role'), 'status')
      assert.equal(context.details.querySelector('button')?.textContent, text.refresh,
        'a props publication alone does not acknowledge the full Page refresh')
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(appNotifications.getSnapshot()[0].message, text.savedRefreshFailed)

      // A later rejected choice must roll back to the newly confirmed Green,
      // proving that the cache updated its baseline as well as its display.
      await context.change(() => originalInput.click())
      assert.equal(context.requests.length, 2)
      assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { tags: ['Green', 'Red'] } })
      await context.rejectAt(1)
      assert.equal(context.summary.textContent, 'Green')
      assert.equal(context.menu().option('Green').checked, true)
      assert.equal(context.menu().option('Red').checked, false)
      assert.equal(context.details.querySelector('.dbw-multi-feedback')?.textContent, text.multiSelectSaveFailed)
      assert.equal(context.writes(), 1)
      assert.equal(context.reads(), 1)
      assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, tags: ['Green'] })
    })
  }
  await withWorkspace('en-US', async context => {
    const text = getDatabaseWorkspaceText('en-US')
    await context.change(() => context.red.click())
    await context.external(['Green'], '2026-10-01T12:00:00.000Z')
    const olderGreenProps = context.disk()
    await context.ack(0)
    await context.read(0, true)
    const acknowledged = context.disk()
    // Only the parent's record revision changes; its Tags value is still the
    // pre-ACK Green. That metadata alone cannot resurrect the old choices.
    await context.update({ entities: olderGreenProps.map(entity => ({ ...entity, updatedAt: '2026-10-03T00:00:00.000Z' })) })
    assert.equal(context.summary.textContent, 'Blue · Red')
    assert.equal(context.menu().option('Green').checked, false)
    assert.equal(context.details.querySelector('.dbw-multi-feedback')?.textContent, text.savedRefreshFailed)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.equal(context.reads(), 1)
    assert.deepEqual(context.disk(), acknowledged)
  })
})
