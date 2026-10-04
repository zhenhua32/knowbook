import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, Fragment, useReducer, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn, DocumentDatabaseFieldValue,
  DocumentCatalogEntry, HomeData, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../src/renderer/src/types/appDomains'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { notify } from '../src/renderer/src/notify'
import { getActiveUiText, getUiText, setActiveUiLanguage } from '../src/renderer/src/i18n'
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
const { DatabasePage } = await import('../src/renderer/src/pages/DatabasePage')
const { DatabaseMultiSelectCellCache } = await import('../src/renderer/src/features/database/model/databaseMultiSelectCells')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const database: DocumentDatabase = { id: 'choices', kind: 'custom', name: 'Original choice source',
  description: 'Original source description', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const status: DocumentDatabaseColumn = { id: 'status', name: 'Status', type: 'select',
  options: ['Blue', 'Red', 'Green'], sortOrder: 0 }
const notes: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 1 }
const record: DatabaseEntity = { id: 'selected-record', databaseId: database.id, title: 'Original selected record', documentId: null,
  fieldValues: { status: 'Blue', notes: 'Original Notes', hidden: 'Untouched hidden metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const view: DatabaseSavedView = { id: 'original-view', databaseId: database.id, name: 'Original table',
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, status.id, notes.id]), configVersion: 1,
  filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }
type Request = ReturnType<typeof deferred<DatabaseEntity>> & { payload: UpdateDatabaseEntityInput; source: string }
type Read = ReturnType<typeof deferred<void>> & { source: string; canApply: () => boolean; calls: string[] }
type Model = { source: string; shown: boolean; columns: DocumentDatabaseColumn[]; entities: DatabaseEntity[];
  databases: DocumentDatabase[]; views: DatabaseSavedView[]; activeView: string; home: HomeData;
  documents: DocumentCatalogEntry[]; catalogColumns: DocumentDatabaseColumn[] }
const fixtureHome: HomeData = { appearanceTheme: 'light', summary: { databasePath: 'isolated-choices.db', backupRoot: 'Original backup',
  documents: 0, blocks: 0, links: 0, lastBackupAt: null }, recentDocuments: [], recentEvents: [], documentCatalog: [],
  databaseColumns: [], documentTree: [], initialDocumentId: null, aiConfig: { enabled: false, baseUrl: '', model: '',
    autoSummaryOnSave: false, relatedNotesEnabled: false, hasApiKey: false } }

function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) appNotifications.dismiss(id)
  appNotifications.clearCompleted()
}

async function withWorkspace(locale: 'en-US' | 'zh-CN', run: (context: {
  document: Document; window: JSDOM['window']; requests: Request[]; readRequests: Read[]; focusCalls: HTMLElement[]
  field: () => HTMLSelectElement; cell: () => HTMLTableCellElement
  change: (run: () => void) => Promise<void>; choose: (value: string) => Promise<void>
  ack: (index: number) => Promise<void>; reject: (index: number) => Promise<void>; read: (index: number, failed?: boolean) => Promise<void>
  writes: () => number; disk: (source?: string) => DatabaseEntity[]; schema: () => unknown; context: () => unknown
  update: (patch: Partial<Model>) => Promise<void>; move: (top: number) => Promise<void>; model: () => Model
  external: (value: DocumentDatabaseFieldValue, revision: string, otherFields?: DatabaseEntity['fieldValues']) => Promise<void>
  hold: (keys: (keyof Model)[]) => void; flush: (keys?: (keyof Model)[]) => Promise<void>
}) => Promise<void>, options: { virtual?: boolean; page?: boolean } = {}) {
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
    const node = this as HTMLElement
    if (!node.classList.contains('dbw-table-scroll')) return 0
    const spacers = [...node.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')]
      .reduce((height, cell) => height + (Number.parseFloat(cell.style.height) || 0), 0)
    return 40 + node.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length * 64 + spacers
  } })
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (settings) { focusCalls.push(this); nativeFocus.call(this, settings) }
  const stored = structuredClone({ database, status, notes, view })
  const sources = [stored.database, { ...stored.database, id: 'other-choices', name: 'Other choice source' }]
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(sources.map(source => [source.id,
    [{ ...structuredClone(record), databaseId: source.id }, ...Array.from({ length: options.virtual ? 59 : 0 }, (_, index) => ({
      ...structuredClone(record), databaseId: source.id, id: `virtual-${index}`, title: `Original zz record ${index}`
    }))]]))
  const requests: Request[] = [], readRequests: Read[] = [], contextChanges: unknown[] = []
  const multiSelectCache = new DatabaseMultiSelectCellCache(), cacheRef = { current: multiSelectCache }
  const held = new Set<keyof Model>(), queued: Array<{ key: keyof Model; apply: (previous: Model) => Model }> = []
  let writes = 0, current!: Model, setModel!: (action: SetStateAction<Model>) => void
  const latestRead = (channel: string) => {
    const request = readRequests.at(-1); assert.ok(request)
    request.calls.push(channel); return request
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (payload: UpdateDatabaseEntityInput) => {
      const request = { ...deferred<DatabaseEntity>(), payload: structuredClone(payload), source: current.source }
      requests.push(request)
      return request.promise
    },
    getHomeData: () => {
      const request = { ...deferred<void>(), source: current.source, canApply: () => true, calls: ['home'] }
      readRequests.push(request); return request.promise.then(() => structuredClone(fixtureHome))
    },
    getDocumentCatalogPage: () => latestRead('documents').promise.then(() => ({ entries: [], total: 0, nextOffset: null })),
    getDatabases: () => latestRead('databases').promise.then(() => structuredClone(sources)),
    getDocumentDatabaseColumns: () => latestRead('columns').promise.then(() => structuredClone(current.columns)),
    getDatabaseEntities: (source: string) => latestRead('entities').promise.then(() => structuredClone(server[source])),
    getDatabaseSavedViews: (source: string) => latestRead('views').promise.then(() => [{ ...structuredClone(stored.view), databaseId: source }]),
    onPluginNotification: () => () => {}, onBackupHealth: () => () => {}, getBackupHealth: async () => ({ revision: 0, error: null })
  } })
  const refresh = async (source = current.source, _preferred?: string, shouldContinue?: () => boolean) => {
    const request = { ...deferred<void>(), source, canApply: shouldContinue ?? (() => true), calls: ['entities'] }
    readRequests.push(request)
    await request.promise
    if (!request.canApply() || current.source !== source || !current.shown) return false
    const entities = structuredClone(server[source])
    setModel(previous => request.canApply() && previous.source === source && previous.shown ? { ...previous, entities } : previous)
    return true
  }
  function Harness() {
    const [model, update] = useReducer((previous: Model, action: SetStateAction<Model>) => typeof action === 'function' ? action(previous) : action,
      { source: database.id, shown: true, columns: [stored.status, stored.notes], entities: structuredClone(server[database.id]),
        databases: sources, views: [stored.view], activeView: stored.view.id, home: structuredClone(fixtureHome), documents: [], catalogColumns: [] })
    current = model; setModel = update
    const publish = <K extends keyof Model>(key: K, value: SetStateAction<Model[K]>) => {
      // Hold the actual Page functional updater without evaluating its guard.
      const apply = (previous: Model): Model => ({ ...previous,
        [key]: typeof value === 'function' ? (value as (previous: Model[K]) => Model[K])(previous[key]) : value })
      if (held.has(key)) queued.push({ key, apply }); else update(apply)
    }
    const domain = { databaseReady: true, databaseLoading: false, databaseError: null,
      databaseEntityDatabaseId: model.source, databases: model.databases, selectedDatabaseColumns: model.columns,
      databaseEntities: model.entities, databaseSavedViews: model.views, activeDatabaseSavedViewId: model.activeView,
      selectedDatabaseEntityIds: [record.id], databaseMultiSelectCellCache: cacheRef,
      setDatabases: (value: SetStateAction<DocumentDatabase[]>) => publish('databases', value),
      setSelectedDatabaseColumns: (value: SetStateAction<DocumentDatabaseColumn[]>) => publish('columns', value),
      setDatabaseEntities: (value: SetStateAction<DatabaseEntity[]>) => publish('entities', value),
      setDatabaseSavedViews: (value: SetStateAction<DatabaseSavedView[]>) => publish('views', value),
      setActiveDatabaseSavedViewId: (value: SetStateAction<string>) => publish('activeView', value),
      setDatabaseEntityDatabaseId: (source: string) => update(previous => ({ ...previous, source })),
      setSelectedDatabaseEntityIds: (ids: string[]) => contextChanges.push(['selection', [...ids]]),
      acknowledgeWorkspaceRead: () => {}, reloadDatabaseDomain: () => {} } as unknown as DatabaseDomainState
    const workspace = options.page ? createElement(DatabasePage, { database: domain, catalogColumns: model.catalogColumns,
      catalogDocuments: model.documents, catalogLoading: false, catalogReady: true, catalogError: null, onRetryCatalog: () => {},
      documentCatalog: model.documents, onCatalogColumnsChange: value => publish('catalogColumns', value),
      onCatalogDocumentsChange: value => publish('documents', value), onHomeDataChange: value => publish('home', value),
      onMessage: notify, onOpenDocument: () => {}, selectedDocumentId: null,
      workspaceBoard: {} as DatabaseWorkspaceBoardState, ui: getUiText(locale) }) : createElement(DatabaseWorkspace, {
      activeViewId: model.activeView, currentDatabaseId: model.source, databases: sources,
      savedViews: [{ ...stored.view, databaseId: model.source }], locale,
      catalogDocuments: [], catalogColumns: [], entities: model.entities, selectedColumns: model.columns, selectedRecordIds: [record.id],
      multiSelectCache,
      onActiveViewIdChange: id => contextChanges.push(['view', id]), onCurrentDatabaseIdChange: id => contextChanges.push(['source', id]),
      onSelectedRecordIdsChange: ids => contextChanges.push(['selection', [...ids]]), onOpenDocument: () => {}, onMessage: notify, onRefresh: refresh
    })
    return createElement(Fragment, null, model.shown ? workspace : null,
      createElement(AppNotificationHost, { isZh: locale === 'zh-CN', onOpenDocument: () => {} }))
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const row = () => [...dom.window.document.querySelectorAll<HTMLTableRowElement>('.dbw-table tbody tr:not(.dbw-virtual-spacer)')]
    .find(node => node.querySelector('.dbw-record-title strong')?.textContent === record.title)!
  const field = () => {
    const fields = row().querySelectorAll<HTMLSelectElement>('select[aria-label="Status"]')
    assert.equal(fields.length, 1)
    return fields[0]
  }
  const schema = () => structuredClone({ databases: [stored.database], columns: current.columns, views: [stored.view] })
  try {
    await act(async () => root.render(createElement(Harness)))
    assert.equal(field().value, 'Blue')
    const query = dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
    await change(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(query, 'Original')
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.equal(query.value, 'Original')
    assert.equal(row().querySelector<HTMLInputElement>('.dbw-select-column input')?.checked, true)
    assert.equal(row().querySelector<HTMLInputElement>('.catalog-cell-input[aria-label="Notes"]')?.value, 'Original Notes')
    await run({ document: dom.window.document, window: dom.window, requests, readRequests, focusCalls, field,
      cell: () => field().closest('td')!, change,
      choose: async value => { await change(() => { field().value = value; field().dispatchEvent(new dom.window.Event('change', { bubbles: true })) }) },
      ack: async index => {
        const request = requests[index]; assert.ok(request)
        const previous = server[request.source].find(entity => entity.id === request.payload.entityId)!; assert.ok(previous)
        const next = { ...previous, fieldValues: { ...previous.fieldValues, ...structuredClone(request.payload.fieldValues) },
          updatedAt: `2026-10-02T00:00:0${++writes}.000Z` }
        server[request.source] = server[request.source].map(entity => entity.id === next.id ? next : entity)
        await act(async () => request.resolve(structuredClone(next)))
      },
      reject: async index => { assert.ok(requests[index]); await act(async () => requests[index].reject(new Error('Isolated Status write rejected.'))) },
      read: async (index, failed = false) => { assert.ok(readRequests[index]); await act(async () => {
        if (failed) readRequests[index].reject(new Error('Isolated Status read rejected after a durable ACK.'))
        else readRequests[index].resolve()
      }) },
      writes: () => writes, disk: (source = database.id) => structuredClone(server[source]), schema,
      model: () => structuredClone(current), update: async patch => { await change(() => setModel(previous => ({ ...previous, ...patch }))) },
      move: async top => { await change(() => {
        const scroll = dom.window.document.querySelector<HTMLDivElement>('.dbw-table-scroll')!; assert.ok(scroll)
        scroll.scrollTop = top; scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
      }) },
      external: async (value, revision, otherFields = {}) => {
        server[current.source] = server[current.source].map(entity => entity.id === record.id ? { ...entity,
          fieldValues: { ...entity.fieldValues, ...structuredClone(otherFields), status: value }, updatedAt: revision } : entity)
        await change(() => setModel(previous => ({ ...previous, entities: structuredClone(server[previous.source]) })))
      },
      hold: keys => keys.forEach(key => held.add(key)),
      flush: async keys => {
        const selected = new Set(keys ?? held)
        selected.forEach(key => held.delete(key))
        const pending = queued.filter(item => selected.has(item.key))
        for (let index = queued.length - 1; index >= 0; index--) if (selected.has(queued[index].key)) queued.splice(index, 1)
        await change(() => pending.forEach(item => setModel(item.apply)))
      },
      context: () => ({ query: query.value, source: dom.window.document.querySelector('.dbw-source-trigger')?.textContent,
        activeView: dom.window.document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.textContent,
        selected: row().querySelector<HTMLInputElement>('.dbw-select-column input')?.checked,
        notes: row().querySelector<HTMLInputElement>('.catalog-cell-input[aria-label="Notes"]')?.value, changes: structuredClone(contextChanges) }) })
    assert.deepEqual(stored, { database, status, notes, view })
  } finally {
    await act(async () => root.unmount())
    await act(async () => requests.forEach(request => request.resolve(structuredClone(record))))
    await act(async () => readRequests.forEach(request => request.resolve()))
    clearNotifications()
    setActiveUiLanguage(oldLanguage)
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
    dom.window.close()
  }
}

test('a rejected select write restores the saved choice and leaves a local failure before the next selection', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withWorkspace(locale, async context => {
    const before = context.disk(), schema = context.schema(), owner = context.context(), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.choose('Red')
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].payload, { entityId: record.id, fieldValues: { status: 'Red' } })
    await context.reject(0)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.equal(context.document.querySelectorAll('.app-notification [role="alert"]').length, 1,
      'the real Workspace failure has settled and reached the notification Host')
    assert.equal(context.writes(), 0)
    assert.equal(context.readRequests.length, 0)
    assert.deepEqual(context.disk(), before)
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.context(), owner)
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(input.value, 'Blue')
    assert.equal(context.cell().querySelectorAll('[role="alert"]').length, 1,
      'a failed select save must not silently look like an accepted choice')
    const text = getDatabaseWorkspaceText(locale)
    assert.equal(context.cell().querySelector('[role="alert"]')?.textContent, text.selectSaveFailed)
    assert.equal(appNotifications.getSnapshot()[0].message, text.selectSaveFailed)
    await context.choose('Red')
    assert.equal(context.requests.length, 2)
    await context.ack(1)
    assert.equal(context.writes(), 1)
    assert.equal(context.readRequests.length, 1)
    await context.read(0)
    assert.equal(input.value, 'Red')
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, status: 'Red' })
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.context(), owner)
  })
})

test('pending select changes remain focusable and share one write despite repeat events or newer metadata', async () => {
  for (const updatedValue of ['Blue', 'Green']) await withWorkspace('en-US', async context => {
    const original = context.disk(), input = context.field(), text = getDatabaseWorkspaceText('en-US')
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.choose('Red')
    assert.equal(input.value, 'Red')
    assert.equal(input.disabled, false)
    assert.equal(input.getAttribute('aria-disabled'), 'true')
    assert.equal(input.getAttribute('aria-busy'), 'true')
    assert.equal(input.getAttribute('title'), text.saving)
    assert.equal(context.document.activeElement === input, true)
    await context.change(() => input.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    // JSDOM does not perform a native select's arrow-key default action. The
    // following real change events test the synchronous lock; native E2E uses
    // genuine ArrowDown with no OS dropdown.
    await context.choose('Green')
    await context.choose('Red')
    assert.equal(context.requests.length, 1)
    assert.equal(input.value, 'Red')
    await context.external(updatedValue, '2026-10-01T12:00:00.000Z', { notes: 'Another property changed during the write' })
    assert.equal(input.value, 'Red')
    assert.equal(context.disk()[0].fieldValues.status, updatedValue)
    await context.ack(0)
    assert.equal(context.disk()[0].fieldValues.status, 'Red')
    assert.equal(context.disk()[0].fieldValues.notes, 'Another property changed during the write')
    assert.equal(context.writes(), 1)
    assert.equal(context.readRequests.length, 1)
    assert.equal(input.value, 'Red', 'the actual ACK overrules pre-ACK stored choices, including a value change')
    assert.notEqual(input.getAttribute('aria-disabled'), 'true')
    assert.equal(input.getAttribute('aria-busy'), 'true', 'the independent read remains announced after the write unlocks')
    await context.read(0, true)
    assert.equal(input.value, 'Red')
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    assert.equal(appNotifications.getSnapshot()[0].message, text.savedRefreshFailed)
    // A later legitimate value publication may change the selected choice but
    // cannot claim that the failed full read succeeded merely from a timestamp.
    await context.external('Red', '2026-10-03T00:00:00.000Z')
    assert.equal(input.value, 'Red')
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    await context.external('Green', '2026-10-03T00:00:01.000Z')
    assert.equal(input.value, 'Green')
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...original[0].fieldValues,
      status: 'Green', notes: 'Another property changed during the write' })
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
  })
})

test('an ACK releases the select write lock while an older read cannot overwrite or unlock the next choice', async () => {
  for (const failedRead of [false, true]) await withWorkspace('zh-CN', async context => {
    const before = context.disk(), owner = context.context(), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.choose('Red')
    await context.ack(0)
    assert.equal(context.readRequests.length, 1)
    assert.equal(input.value, 'Red')
    assert.notEqual(input.getAttribute('aria-disabled'), 'true')
    await context.choose('Green')
    assert.equal(context.requests.length, 2)
    assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { status: 'Green' } })
    assert.equal(input.value, 'Green')
    assert.equal(input.getAttribute('aria-busy'), 'true')
    assert.equal(input.getAttribute('aria-disabled'), 'true')
    await context.read(0, failedRead)
    assert.equal(input.value, 'Green')
    assert.equal(input.getAttribute('aria-busy'), 'true', 'old read settlement never releases a new write')
    assert.equal(input.getAttribute('aria-disabled'), 'true')
    assert.equal(appNotifications.getSnapshot().length, 0)
    assert.equal(context.readRequests.length, 1)
    await context.ack(1)
    assert.equal(context.writes(), 2)
    assert.equal(context.readRequests.length, 2)
    assert.equal(input.value, 'Green')
    assert.notEqual(input.getAttribute('aria-disabled'), 'true')
    await context.read(1)
    assert.equal(context.cell().querySelectorAll('[role="alert"],[role="status"],button').length, 0)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, status: 'Green' })
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.deepEqual(context.context(), owner)
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
  })
})

test('virtual rows and temporary page unmounts retain the physical select lock and accepted overlay', async () => {
  for (const hiddenBy of ['virtual', 'page'] as const) await withWorkspace('en-US', async context => {
    const before = context.disk(), input = context.field()
    await context.choose('Red')
    assert.equal(context.requests.length, 1)
    if (hiddenBy === 'virtual') {
      await context.move(3500)
      assert.equal(input.isConnected, false)
      assert.equal(context.document.querySelectorAll('tbody select').length > 0, true)
      await context.move(0)
    } else {
      await context.update({ shown: false })
      assert.equal(input.isConnected, false)
      await context.update({ shown: true })
    }
    const replacement = context.field()
    assert.equal(replacement === input, false)
    assert.equal(replacement.value, 'Red')
    assert.equal(replacement.disabled, false)
    assert.equal(replacement.getAttribute('aria-busy'), 'true')
    await context.choose('Green')
    assert.equal(context.requests.length, 1, 'remounting cannot unlock an accepted physical write')
    assert.equal(replacement.value, 'Red')
    await context.ack(0)
    assert.equal(context.writes(), 1)
    assert.equal(replacement.value, 'Red')
    assert.notEqual(replacement.getAttribute('aria-disabled'), 'true')
    if (hiddenBy === 'virtual') {
      assert.equal(context.readRequests.length, 1)
      await context.read(0)
    } else {
      assert.equal(context.readRequests.length, 0, 'an unmounted Workspace cannot publish its old source read')
      const refresh = context.cell().querySelector<HTMLButtonElement>('button')
      assert.ok(refresh)
      await context.change(() => refresh.click())
      assert.equal(context.readRequests.length, 1)
      await context.read(0)
    }
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.equal(appNotifications.getSnapshot().length, 0)
    assert.deepEqual(context.disk(), before.map(entity => entity.id === record.id ? { ...entity,
      fieldValues: { ...entity.fieldValues, status: 'Red' }, updatedAt: context.disk()[0].updatedAt } : entity))
  }, { virtual: hiddenBy === 'virtual' })
})

test('schema replacement and source changes revoke old select feedback without releasing a pending physical write', async () => {
  for (const replacement of ['options', 'multi-select', 'select'] as const) await withWorkspace('zh-CN', async context => {
    const before = context.disk()
    if (replacement === 'select') {
      await context.update({ columns: [{ ...status, type: 'multi-select' }, notes] })
      await context.external(['Blue'], '2026-10-01T12:00:00.000Z')
      const initial = context.document.querySelector<HTMLDetailsElement>('tbody .dbw-multi-editor'); assert.ok(initial)
      await context.change(() => initial.querySelector<HTMLElement>('summary')!.click())
      const red = [...initial.querySelectorAll<HTMLInputElement>('input')].find(input => input.parentElement?.textContent === 'Red')!
      await context.change(() => red.click())
      assert.deepEqual(context.requests[0].payload.fieldValues, { status: ['Blue', 'Red'] })
    } else await context.choose('Red')
    await context.update({ columns: [{ ...status, type: replacement === 'multi-select' ? 'multi-select' : 'select',
      options: ['Blue', 'Green', 'Purple'] }, notes] })
    const multi = context.document.querySelector<HTMLDetailsElement>('tbody .dbw-multi-editor')
    const green = () => [...multi!.querySelectorAll<HTMLInputElement>('input')]
      .find(input => input.parentElement?.textContent === 'Green')!
    if (replacement !== 'multi-select') await context.choose('Green')
    else {
      assert.ok(multi)
      await act(async () => {
        multi.querySelector<HTMLElement>('summary')!.click()
        await new Promise<void>(resolve => context.window.setTimeout(resolve, 0))
      })
      assert.equal(multi.open, true)
      await context.change(() => green().click())
    }
    assert.equal(context.requests.length, 1)
    await context.reject(0)
    assert.equal(appNotifications.getSnapshot().length, 0)
    assert.equal(context.document.querySelectorAll('tbody [role="alert"],tbody [role="status"]').length, 0)
    if (replacement !== 'multi-select') {
      assert.equal(context.field().value, replacement === 'options' ? 'Blue' : '')
      await context.choose('Green')
    } else {
      assert.equal(multi!.querySelector('summary')?.textContent, '—', 'the scalar old props are not an array-valued new field draft')
      assert.equal(green().checked, false)
      await context.change(() => green().click())
    }
    assert.equal(context.requests.length, 2)
    const value = replacement === 'multi-select' ? ['Green'] : 'Green'
    assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { status: value } })
    await context.ack(1)
    await context.read(0)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, status: value })
    assert.equal(context.writes(), 1)
    assert.equal(appNotifications.getSnapshot().length, 0)
  })
  for (const returnToFirst of [false, true]) await withWorkspace('en-US', async context => {
    const beforeA = context.disk(), beforeB = context.disk('other-choices')
    await context.choose('Red')
    await context.update({ source: 'other-choices', entities: beforeB })
    if (returnToFirst) await context.update({ source: database.id, entities: beforeA })
    else await context.choose('Green')
    await context.reject(0)
    assert.equal(appNotifications.getSnapshot().length, 0, 'a departed or ABA source never reports the old failure globally')
    if (returnToFirst) {
      assert.equal(context.field().value, 'Blue')
      await context.choose('Green')
    } else assert.equal(context.field().getAttribute('aria-busy'), 'true')
    assert.equal(context.requests.length, 2)
    await context.ack(1)
    await context.read(0)
    assert.equal(context.field().value, 'Green')
    assert.equal(context.requests[1].source, returnToFirst ? database.id : 'other-choices')
    assert.deepEqual(context.disk(returnToFirst ? 'other-choices' : database.id), returnToFirst ? beforeB : beforeA)
    assert.equal(context.writes(), 1)
  })
})

test('empty scalar choices and the real RecordDrawer synchronous setter preserve comma and space options without cell writes', async () => {
  await withWorkspace('en-US', async context => {
    const before = context.disk()
    await context.choose('')
    assert.deepEqual(context.requests[0].payload, { entityId: record.id, fieldValues: { status: null } })
    await context.ack(0)
    await context.read(0)
    assert.equal(context.field().value, '')
    await context.choose('')
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, status: null })
  })
  await withWorkspace('zh-CN', async context => {
    const before = context.disk(), text = getDatabaseWorkspaceText('zh-CN')
    await context.update({ columns: [{ ...status, options: ['Blue', 'Red, warm', 'Light blue'] }, notes] })
    const title = context.document.querySelector<HTMLButtonElement>('tbody .dbw-record-title')!; assert.ok(title)
    await context.change(() => title.click())
    const drawer = context.document.querySelector('.dbw-record-drawer'); assert.ok(drawer)
    const choice = drawer.querySelector<HTMLSelectElement>('select[aria-label="Status"]'); assert.ok(choice)
    await context.change(() => choice.focus())
    context.focusCalls.length = 0
    const choose = async (value: string) => { await context.change(() => {
      choice.value = value; choice.dispatchEvent(new context.window.Event('change', { bubbles: true }))
    }) }
    for (const value of ['Red, warm', '', 'Light blue']) {
      await choose(value)
      assert.equal(choice.value, value)
      assert.notEqual(choice.getAttribute('aria-busy'), 'true')
      assert.notEqual(choice.getAttribute('aria-disabled'), 'true')
      assert.equal(choice.disabled, false)
      assert.equal(context.requests.length, 0)
      assert.equal(drawer.querySelectorAll('[role="alert"],[role="status"]').length, 0)
    }
    assert.equal(context.document.activeElement === choice, true)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.disk(), before)
    const save = [...drawer.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === text.save)
    assert.ok(save)
    await context.change(() => save.click())
    assert.equal(context.requests.length, 1, 'only explicit record Save reaches the real Workspace IPC path')
    assert.deepEqual(context.requests[0].payload.fieldValues, { status: 'Light blue', notes: 'Original Notes' })
    assert.equal(context.writes(), 0)
  })
})

test('the actual Page clears a saved select read failure only after records and schema commit, preserving newer owners', async () => {
  for (const afterRead of ['no-new-write', 'new-write'] as const) await withWorkspace('en-US', async context => {
    const before = context.disk(), initial = context.model(), text = getDatabaseWorkspaceText('en-US'), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.choose('Red')
    await context.ack(0)
    assert.equal(context.readRequests.length, 1)
    assert.deepEqual(context.readRequests[0].calls.slice().sort(), ['columns', 'databases', 'documents', 'entities', 'home', 'views'])
    await context.read(0, true)
    assert.equal(input.value, 'Red')
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    assert.equal(context.writes(), 1)
    context.hold(['entities', 'columns'])
    const refresh = context.cell().querySelector<HTMLButtonElement>('button'); assert.ok(refresh)
    await context.change(() => refresh.click())
    assert.equal(context.readRequests.length, 2)
    await context.read(1)
    assert.equal(input.value, 'Red')
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed,
      'a true read result and a Page pulse cannot substitute for actual parent data publication')
    assert.equal(context.cell().querySelectorAll('button').length, 1)
    assert.deepEqual(context.model().entities, initial.entities)
    await context.flush(['entities'])
    assert.deepEqual(context.model().entities, context.disk())
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed,
      'records alone do not acknowledge the complete records/schema read')
    if (afterRead === 'new-write') {
      await context.choose('Green')
      assert.equal(context.requests.length, 2)
      assert.equal(input.getAttribute('aria-busy'), 'true')
    }
    await context.flush(['columns'])
    if (afterRead === 'new-write') {
      assert.equal(input.value, 'Green')
      assert.equal(input.getAttribute('aria-busy'), 'true', 'the older Page receipt cannot unlock the new write')
      await context.ack(1)
      assert.equal(context.readRequests.length, 3)
      await context.read(2)
    }
    assert.equal(input.value, afterRead === 'new-write' ? 'Green' : 'Red')
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.requests.length, afterRead === 'new-write' ? 2 : 1)
    assert.equal(context.writes(), context.requests.length)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.deepEqual(context.model().entities, context.disk())
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, status: input.value })
    assert.deepEqual(context.model().home, initial.home)
    assert.deepEqual(context.model().databases, initial.databases)
    assert.deepEqual(context.model().views, initial.views)
    assert.equal(context.model().activeView, initial.activeView)
  }, { page: true })
})

test('a durable select ACK survives its separate read failure and offers Refresh without replaying the write', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withWorkspace(locale, async context => {
    const before = context.disk(), schema = context.schema(), owner = context.context(), input = context.field(), text = getDatabaseWorkspaceText(locale)
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.choose('Red')
    assert.equal(context.requests.length, 1)
    await context.ack(0)
    assert.equal(context.writes(), 1)
    assert.equal(context.readRequests.length, 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, status: 'Red' })
    await context.read(0, true)
    // The rejected promise is a GET after the durable write, never a synthetic
    // write failure. Establish persistence/counts before inspecting its UI.
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.equal(context.readRequests.length, 1)
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.context(), owner)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.equal(context.document.querySelectorAll('.app-notification [role="alert"]').length, 1)
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(input.value, 'Red', 'a rejected post-ACK read cannot restore the old Blue props')
    const feedback = context.cell().querySelector('[role="status"]')
    assert.equal(feedback?.textContent, text.savedRefreshFailed)
    const refresh = [...context.cell().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text.refresh)
    assert.ok(refresh, 'the saved value needs a read-only recovery action')
    await context.change(() => { refresh.click(); refresh.click() })
    assert.equal(context.readRequests.length, 2)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    await context.read(1)
    assert.equal(input.value, 'Red')
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.context(), owner)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, status: 'Red' })
  })
})
