import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, Fragment, useReducer, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn,
  DocumentCatalogEntry, DocumentDatabaseFieldValue, HomeData, UpdateDatabaseEntityInput, UpdateDocumentDatabaseValueInput } from '../src/shared/contracts'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../src/renderer/src/types/appDomains'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { notify } from '../src/renderer/src/notify'
import { getActiveUiText, getUiText, setActiveUiLanguage } from '../src/renderer/src/i18n'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import { waitForRenderer } from './helpers/renderer-async'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
await Promise.all([import('../src/renderer/src/components/AppNotificationList'),
  import('../src/renderer/src/notification-history'), import('../src/renderer/src/backup-notifications')])
const { AppNotificationHost } = await import('../src/renderer/src/components/AppNotificationHost')
const { DatabasePage } = await import('../src/renderer/src/pages/DatabasePage')
const { DatabaseMultiSelectCellCache } = await import('../src/renderer/src/features/database/model/databaseMultiSelectCells')
const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const database: DocumentDatabase = { id: 'checkbox-source', kind: 'custom', name: 'Original checkbox source',
  description: 'Original source description', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const done: DocumentDatabaseColumn = { id: 'done', name: 'Done', type: 'checkbox', options: [], sortOrder: 0 }
const notes: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 1 }
const record: DatabaseEntity = { id: 'checkbox-record', databaseId: database.id, title: 'Original checkbox record', documentId: null,
  fieldValues: { done: false, notes: 'Original Notes', hidden: 'Untouched hidden metadata' },
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const view: DatabaseSavedView = { id: 'original-view', databaseId: database.id, name: 'Original table',
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, done.id, notes.id]), configVersion: 1,
  filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }
type Request = ReturnType<typeof deferred<DatabaseEntity>> & { payload: UpdateDatabaseEntityInput; source: string }
type CatalogRequest = ReturnType<typeof deferred<void>> & { payload: UpdateDocumentDatabaseValueInput }
type Read = ReturnType<typeof deferred<void>> & { source: string; preferred?: string; canApply: () => boolean; failed: boolean; calls: string[] }
type Model = { source: string; shown: boolean; columns: DocumentDatabaseColumn[]; entities: DatabaseEntity[];
  databases: DocumentDatabase[]; views: DatabaseSavedView[]; activeView: string; home: HomeData;
  documents: DocumentCatalogEntry[]; catalogColumns: DocumentDatabaseColumn[] }
const fixtureHome: HomeData = { appearanceTheme: 'light', summary: { databasePath: 'isolated-checkbox.db', backupRoot: 'Original backup',
  documents: 0, blocks: 0, links: 0, lastBackupAt: null }, recentDocuments: [], recentEvents: [], documentCatalog: [],
  databaseColumns: [], documentTree: [], initialDocumentId: null, aiConfig: { enabled: false, baseUrl: '', model: '',
    autoSummaryOnSave: false, relatedNotesEnabled: false, hasApiKey: false } }

function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) appNotifications.dismiss(id)
  appNotifications.clearCompleted()
}

async function withWorkspace(locale: 'en-US' | 'zh-CN', run: (context: {
  document: Document; window: JSDOM['window']; requests: Request[]; catalogRequests: CatalogRequest[]; reads: Read[]; focusCalls: HTMLElement[]
  field: () => HTMLInputElement; cell: () => HTMLTableCellElement; row: () => HTMLTableRowElement; change: (callback: () => void) => Promise<void>
  ack: (index: number) => Promise<void>; ackCatalog: (index: number) => Promise<void>; reject: (index: number) => Promise<void>
  read: (index: number, failed?: boolean) => Promise<void>; writes: () => number; disk: (source?: string) => DatabaseEntity[]
  catalogDisk: () => DocumentCatalogEntry[]; schema: () => unknown; owner: () => unknown; facts: () => unknown; model: () => Model
  update: (patch: Partial<Model>) => Promise<void>; move: (top: number) => Promise<void>
  external: (value: DocumentDatabaseFieldValue, revision: string, otherFields?: DatabaseEntity['fieldValues']) => Promise<void>
  hold: (keys: (keyof Model)[]) => void; flush: (keys: (keyof Model)[]) => Promise<void>
}) => Promise<void>, options: { virtual?: boolean; page?: boolean; catalog?: boolean; initial?: boolean } = {}) {
  clearNotifications()
  const oldLanguage = getActiveUiText().language
  setActiveUiLanguage(locale)
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  class LayoutObserver { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, value: LayoutObserver })
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: LayoutObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 320, 40) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return (this.isConnected ? [this.getBoundingClientRect()] : []) as unknown as DOMRectList
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true,
    get() { return (this as HTMLElement).classList.contains('dbw-table-scroll') ? 200 : 0 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() {
    const node = this as HTMLElement
    if (!node.classList.contains('dbw-table-scroll')) return 0
    const spacers = [...node.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')]
      .reduce((height, cell) => height + (Number.parseFloat(cell.style.height) || 0), 0)
    return 40 + node.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length * 56 + spacers
  } })
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (settings) { focusCalls.push(this); nativeFocus.call(this, settings) }
  const stored = structuredClone({ database, done, notes, view })
  const sources: DocumentDatabase[] = [stored.database,
    { ...stored.database, id: 'other-checkbox', name: 'Other checkbox source' },
    { ...stored.database, id: 'catalog-checkbox', kind: 'document-catalog', name: 'Original checkbox catalog' }]
  const initialSource = options.catalog ? 'catalog-checkbox' : database.id
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(sources.filter(source => source.kind === 'custom').map(source => [source.id,
    [{ ...structuredClone(record), databaseId: source.id, fieldValues: { ...record.fieldValues, done: options.initial ?? false } },
      ...Array.from({ length: options.virtual ? 59 : 0 }, (_, index) => ({ ...structuredClone(record), databaseId: source.id,
        id: 'virtual-' + index, title: 'Original zz record ' + index }))]]))
  let catalog: DocumentCatalogEntry[] = [{ id: record.id, title: record.title, path: 'Original checkbox record',
    summary: 'Untouched document summary', parentId: null, parentTitle: null, updatedAt: '2026-10-01',
    blockCount: 3, childCount: 0, linkCount: 2, fieldValues: { ...record.fieldValues, done: options.initial ?? false } }]
  const requests: Request[] = [], catalogRequests: CatalogRequest[] = [], reads: Read[] = [], contextChanges: unknown[] = []
  const multiSelectCache = new DatabaseMultiSelectCellCache(), cacheRef = { current: multiSelectCache }
  const held = new Set<keyof Model>(), queued: Array<{ key: keyof Model; apply: (previous: Model) => Model }> = []
  let writes = 0, current!: Model, setModel!: (action: SetStateAction<Model>) => void
  const latestRead = (channel: string) => {
    const request = reads.at(-1); assert.ok(request)
    request.calls.push(channel); return request
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (payload: UpdateDatabaseEntityInput) => {
      assert.equal(payload.entityId, record.id)
      if (current.columns.find(column => column.id === done.id)?.type === 'checkbox') {
        assert.equal(typeof payload.fieldValues?.done, 'boolean', 'checkbox IPC values remain exact booleans')
      }
      const request = { ...deferred<DatabaseEntity>(), payload: structuredClone(payload), source: current.source }
      requests.push(request); return request.promise
    },
    updateDocumentDatabaseValue: (payload: UpdateDocumentDatabaseValueInput) => {
      assert.equal(payload.documentId, record.id)
      assert.equal(payload.columnId, done.id)
      assert.equal(typeof payload.value, 'boolean')
      const request = { ...deferred<void>(), payload: structuredClone(payload) }
      catalogRequests.push(request); return request.promise
    },
    getHomeData: () => {
      const request = { ...deferred<void>(), source: current.source, canApply: () => true, failed: false, calls: ['home'] }
      reads.push(request); return request.promise.then(() => structuredClone(fixtureHome))
    },
    getDocumentCatalogPage: () => latestRead('documents').promise.then(() => ({ entries: structuredClone(catalog), total: catalog.length, nextOffset: null })),
    getDatabases: () => latestRead('databases').promise.then(() => structuredClone(sources)),
    getDocumentDatabaseColumns: () => latestRead('columns').promise.then(() => structuredClone(current.columns)),
    getDatabaseEntities: (source: string) => latestRead('entities').promise.then(() => structuredClone(server[source])),
    getDatabaseSavedViews: (source: string) => latestRead('views').promise.then(() => [{ ...structuredClone(stored.view), databaseId: source }]),
    onPluginNotification: () => () => {}, onBackupHealth: () => () => {},
    getBackupHealth: async () => ({ revision: 0, error: null })
  } })
  const refresh = async (source = current.source, preferred?: string, shouldContinue?: () => boolean) => {
    const request = { ...deferred<void>(), source, preferred, canApply: shouldContinue ?? (() => true), failed: false, calls: ['entities'] }
    reads.push(request)
    await request.promise
    if (!request.canApply() || current.source !== source || !current.shown) return false
    const entities = structuredClone(server[source] ?? []), documents = structuredClone(catalog)
    setModel(previous => request.canApply() && previous.source === source && previous.shown ? { ...previous, entities, documents } : previous)
    return true
  }
  function Harness() {
    const [model, update] = useReducer((previous: Model, action: SetStateAction<Model>) => typeof action === 'function' ? action(previous) : action,
      { source: initialSource, shown: true, columns: [stored.done, stored.notes], entities: structuredClone(server[initialSource] ?? []),
        databases: sources, views: [{ ...stored.view, databaseId: initialSource }], activeView: stored.view.id,
        home: structuredClone(fixtureHome), documents: structuredClone(catalog), catalogColumns: [stored.done, stored.notes] })
    current = model; setModel = update
    const publish = <K extends keyof Model>(key: K, value: SetStateAction<Model[K]>) => {
      // Retain real Page functional updaters; do not evaluate their guards until publication.
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
      catalogDocuments: model.documents, catalogColumns: model.catalogColumns, entities: model.entities,
      selectedColumns: model.columns, selectedRecordIds: [record.id], multiSelectCache,
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
    const fields = row().querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-label="Done"]')
    assert.equal(fields.length, 1); return fields[0]
  }
  const schema = () => structuredClone({ database: stored.database, columns: current.columns, views: [stored.view] })
  const owner = () => ({ query: dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')?.value,
    source: dom.window.document.querySelector('.dbw-source-trigger')?.textContent,
    activeView: dom.window.document.querySelector('.dbw-view-tab-wrap.is-active > .dbw-view-tab')?.textContent,
    selected: row().querySelector<HTMLInputElement>('.dbw-select-column input')?.checked,
    notes: row().querySelector<HTMLInputElement>('.catalog-cell-input[aria-label="Notes"]')?.value,
    changes: structuredClone(contextChanges) })
  try {
    await act(async () => root.render(createElement(Harness)))
    assert.equal(field().checked, options.initial ?? false)
    const query = dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
    await change(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(query, 'Original')
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.equal(query.value, 'Original')
    assert.equal(owner().selected, true)
    assert.equal(owner().notes, 'Original Notes')
    await run({ document: dom.window.document, window: dom.window, requests, catalogRequests, reads, focusCalls, field, row,
      cell: () => field().closest('td')!, change,
      ack: async index => {
        const request = requests[index]; assert.ok(request)
        const previous = server[request.source].find(entity => entity.id === request.payload.entityId)!; assert.ok(previous)
        const next = { ...previous, fieldValues: { ...previous.fieldValues, ...structuredClone(request.payload.fieldValues) },
          updatedAt: '2026-10-02T00:00:0' + (++writes) + '.000Z' }
        server[request.source] = server[request.source].map(entity => entity.id === next.id ? next : entity)
        await act(async () => request.resolve(structuredClone(next)))
      },
      ackCatalog: async index => {
        const request = catalogRequests[index]; assert.ok(request)
        const payload = request.payload
        catalog = catalog.map(document => document.id === payload.documentId
          ? { ...document, fieldValues: { ...document.fieldValues, [payload.columnId]: payload.value } } : document)
        writes++
        await act(async () => request.resolve())
      },
      reject: async index => { assert.ok(requests[index]); await act(async () => requests[index].reject(new Error('Isolated checkbox mutation rejected.'))) },
      read: async (index, failed = false) => {
        const request = reads[index]; assert.ok(request)
        await act(async () => {
          if (failed) { request.failed = true; request.reject(new Error('Isolated checkbox GET failed after its durable ACK.')) }
          else request.resolve()
        })
      }, writes: () => writes, disk: (source = database.id) => structuredClone(server[source]), catalogDisk: () => structuredClone(catalog),
      schema, owner, model: () => structuredClone(current),
      update: async patch => { await change(() => setModel(previous => ({ ...previous, ...patch }))) },
      move: async top => { await change(() => {
        const scroll = dom.window.document.querySelector<HTMLDivElement>('.dbw-table-scroll')!; assert.ok(scroll)
        scroll.scrollTop = top; scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
      }) },
      external: async (value, revision, otherFields = {}) => {
        server[current.source] = server[current.source].map(entity => entity.id === record.id ? { ...entity,
          fieldValues: { ...entity.fieldValues, ...structuredClone(otherFields), done: value }, updatedAt: revision } : entity)
        await change(() => setModel(previous => ({ ...previous, entities: structuredClone(server[previous.source]) })))
      },
      hold: keys => keys.forEach(key => held.add(key)),
      flush: async keys => {
        const selected = new Set(keys); selected.forEach(key => held.delete(key))
        const pending = queued.filter(item => selected.has(item.key))
        for (let index = queued.length - 1; index >= 0; index--) if (selected.has(queued[index].key)) queued.splice(index, 1)
        await change(() => pending.forEach(item => setModel(item.apply)))
      },
      facts: () => ({ locale, input: { checked: field().checked, disabled: field().disabled,
        ariaDisabled: field().getAttribute('aria-disabled'), ariaBusy: field().getAttribute('aria-busy'),
        focused: dom.window.document.activeElement === field() }, programFocusCalls: focusCalls.length,
        requests: requests.map(request => request.payload), catalogRequests: catalogRequests.map(request => request.payload),
        writes, reads: reads.map(read => ({ source: read.source, preferred: read.preferred, failed: read.failed })),
        disk: structuredClone(server), published: structuredClone(current), schema: schema(), owner: owner(),
        notifications: appNotifications.getSnapshot().map(item => item.message) }) })
    assert.deepEqual(stored, { database, done, notes, view })
  } finally {
    await act(async () => root.unmount())
    await act(async () => {
      requests.forEach(request => request.resolve(structuredClone(record)))
      catalogRequests.forEach(request => request.resolve())
      reads.forEach(request => request.resolve())
    })
    clearNotifications()
    setActiveUiLanguage(oldLanguage)
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
    dom.window.close()
  }
}

test('pending checkbox toggles keep the accepted boolean and share exactly one write', async t => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withWorkspace(locale, async context => {
    const before = context.disk(), schema = context.schema(), owner = context.owner(), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.change(() => input.click())
    await context.change(() => input.click())
    t.diagnostic(JSON.stringify(context.facts()))
    assert.equal(context.writes(), 0)
    assert.equal(context.reads.length, 0)
    assert.deepEqual(context.disk(), before)
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.owner(), owner)
    assert.deepEqual(context.requests[0].payload, { entityId: record.id, fieldValues: { done: true } })
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(input.checked, true, 'the accepted checkbox toggle remains visible while its write has not acknowledged')
    assert.equal(context.requests.length, 1, 'a repeat native checkbox click cannot start a second pending write')
    assert.equal(input.disabled, false)
    assert.equal(input.getAttribute('aria-disabled'), 'true')
    assert.equal(input.getAttribute('aria-busy'), 'true')
  })
})

test('a durable checkbox ACK survives its separate read failure and offers read-only Refresh', async t => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withWorkspace(locale, async context => {
    const before = context.disk(), schema = context.schema(), owner = context.owner(), input = context.field(), text = getDatabaseWorkspaceText(locale)
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.change(() => input.click())
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].payload, { entityId: record.id, fieldValues: { done: true } })
    await context.ack(0)
    assert.equal(context.writes(), 1)
    assert.equal(context.reads.length, 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, done: true })
    await context.read(0, true)
    t.diagnostic(JSON.stringify(context.facts()))
    // Establish the durable boolean ACK and the rejected GET independently of
    // the UI: this is not a mutation rejection or a fabricated successful result.
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.equal(context.reads.length, 1)
    assert.equal(context.reads[0].failed, true)
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, done: true })
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.owner(), owner)
    assert.equal(appNotifications.getSnapshot().length, 1)
    await waitForRenderer(() => context.document.querySelectorAll('.app-notification [role="alert"]').length === 1,
      'The notification Host must render the checkbox refresh failure before checking its alert')
    assert.equal(context.document.querySelectorAll('.app-notification [role="alert"]').length, 1)
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(input.checked, true, 'the failed post-ACK GET cannot restore the previous false props')
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    const refresh = [...context.cell().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text.refresh)
    assert.ok(refresh, 'the already saved checkbox needs a read-only recovery action')
    await context.change(() => { refresh.click(); refresh.click() })
    assert.equal(context.reads.length, 2)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    await context.read(1)
    assert.equal(input.checked, true)
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.deepEqual(context.owner(), owner)
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, done: true })
  })
  for (const initial of [false, true]) await withWorkspace('zh-CN', async context => {
    const before = context.catalogDisk(), schema = context.schema(), owner = context.owner(), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.change(() => input.click())
    assert.equal(context.requests.length, 0)
    assert.deepEqual(context.catalogRequests[0].payload, { documentId: record.id, columnId: done.id, value: !initial })
    await context.ackCatalog(0)
    assert.equal(context.writes(), 1)
    assert.equal(context.reads.length, 1)
    await context.read(0, true)
    assert.equal(input.checked, !initial)
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, getDatabaseWorkspaceText('zh-CN').savedRefreshFailed)
    assert.deepEqual(context.catalogDisk(), before.map(document => ({ ...document,
      fieldValues: { ...document.fieldValues, done: !initial } })), 'catalog field ACK never rewrites document metadata or timestamps')
    const refresh = context.cell().querySelector<HTMLButtonElement>('button'); assert.ok(refresh)
    await context.change(() => { refresh.click(); refresh.click() })
    assert.equal(context.reads.length, 2)
    assert.equal(context.catalogRequests.length, 1)
    await context.read(1)
    assert.equal(input.checked, !initial)
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.deepEqual(context.owner(), owner)
    assert.deepEqual(context.schema(), schema)
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
  }, { catalog: true, initial })
})
test('checkbox write failures restore the latest confirmed boolean and explicit re-selection retries without losing metadata', async () => {
  for (const initial of [false, true]) await withWorkspace('en-US', async context => {
    const before = context.disk(), schema = context.schema(), input = context.field(), text = getDatabaseWorkspaceText('en-US')
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.change(() => input.click())
    await context.external(!initial, '2026-10-01T12:00:00.000Z', { notes: 'Another property changed during the write' })
    const latest = context.disk()
    await context.reject(0)
    assert.equal(input.checked, !initial, 'failure restores the latest legitimate stored state, not the stale opening props')
    assert.equal(input.disabled, false)
    assert.notEqual(input.getAttribute('aria-disabled'), 'true')
    assert.equal(context.cell().querySelector('[role="alert"]')?.textContent, text.checkboxSaveFailed)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.equal(context.document.querySelector('.app-notification-message')?.textContent, text.checkboxSaveFailed)
    assert.equal(context.cell().querySelectorAll('button').length, 0, 'retry is a new explicit choice')
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 0)
    assert.equal(context.reads.length, 0)
    assert.deepEqual(context.disk(), latest)
    assert.deepEqual(context.schema(), schema)
    await context.change(() => input.click())
    assert.equal(context.requests.length, 2)
    assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { done: initial } })
    await context.ack(1)
    await context.read(0)
    assert.equal(input.checked, initial)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, done: initial,
      notes: 'Another property changed during the write' })
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.equal(context.writes(), 1)
    assert.equal(context.requests.length, 2)
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
  }, { initial })
  for (const preAckValue of [false, true]) await withWorkspace('zh-CN', async context => {
    const before = context.disk(), input = context.field()
    await context.change(() => input.click())
    await context.external(preAckValue, '2026-10-01T12:00:00.000Z', { notes: 'Fresh Notes survive the accepted write' })
    await context.ack(0)
    assert.equal(input.checked, true, 'the real acknowledged boolean wins over metadata-only or pre-ACK value publications')
    assert.equal(context.disk()[0].fieldValues.done, true)
    await context.read(0, true)
    assert.equal(input.checked, true)
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, getDatabaseWorkspaceText('zh-CN').savedRefreshFailed)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, done: true, notes: 'Fresh Notes survive the accepted write' })
  })
})

test('a checkbox ACK unlocks an exact false write while the older GET cannot overwrite or unlock its newer owner', async () => {
  for (const failedRead of [false, true]) await withWorkspace('en-US', async context => {
    const before = context.disk(), owner = context.owner(), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.change(() => input.click())
    await context.ack(0)
    assert.equal(input.checked, true)
    assert.notEqual(input.getAttribute('aria-disabled'), 'true')
    assert.equal(input.getAttribute('aria-busy'), 'true')
    await context.change(() => input.click())
    assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { done: false } })
    assert.equal(input.checked, false)
    assert.equal(input.getAttribute('aria-disabled'), 'true')
    await context.read(0, failedRead)
    assert.equal(input.checked, false)
    assert.equal(input.getAttribute('aria-disabled'), 'true')
    assert.equal(input.getAttribute('aria-busy'), 'true')
    assert.equal(appNotifications.getSnapshot().length, 0)
    await context.ack(1)
    assert.equal(context.writes(), 2)
    assert.equal(context.reads.length, 2)
    assert.notEqual(input.getAttribute('aria-disabled'), 'true')
    await context.read(1)
    assert.equal(input.checked, false)
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.deepEqual(context.disk()[0].fieldValues, before[0].fieldValues)
    assert.deepEqual({ ...context.disk()[0], updatedAt: before[0].updatedAt }, before[0])
    assert.equal(context.requests.length, 2)
    assert.deepEqual(context.owner(), owner)
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
  })
})

test('virtual rows and temporary Workspace unmounts preserve the checkbox physical lock and acknowledged overlay', async () => {
  for (const hiddenBy of ['virtual', 'page'] as const) await withWorkspace('zh-CN', async context => {
    const before = context.disk(), input = context.field()
    await context.change(() => input.click())
    if (hiddenBy === 'virtual') {
      await context.move(3500)
      assert.equal(input.isConnected, false)
      assert.equal(context.document.querySelectorAll('tbody .dbw-checkbox-editor').length > 0, true)
      await context.move(0)
    } else {
      await context.update({ shown: false })
      assert.equal(input.isConnected, false)
      await context.update({ shown: true })
    }
    const replacement = context.field()
    assert.equal(replacement === input, false)
    assert.equal(replacement.checked, true)
    assert.equal(replacement.disabled, false)
    assert.equal(replacement.getAttribute('aria-disabled'), 'true')
    await context.change(() => replacement.click())
    assert.equal(context.requests.length, 1)
    assert.equal(replacement.checked, true)
    await context.ack(0)
    assert.equal(context.writes(), 1)
    assert.equal(replacement.checked, true)
    assert.notEqual(replacement.getAttribute('aria-disabled'), 'true')
    if (hiddenBy === 'virtual') {
      assert.equal(context.reads.length, 1)
      await context.read(0)
    } else {
      assert.equal(context.reads.length, 0)
      const refresh = context.cell().querySelector<HTMLButtonElement>('button'); assert.ok(refresh)
      await context.change(() => refresh.click())
      await context.read(0)
    }
    assert.deepEqual(context.disk(), before.map(entity => entity.id === record.id ? { ...entity,
      fieldValues: { ...entity.fieldValues, done: true }, updatedAt: context.disk()[0].updatedAt } : entity))
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.equal(appNotifications.getSnapshot().length, 0)
  }, { virtual: hiddenBy === 'virtual' })
})

test('checkbox type-prefix changes preserve physical single-flight and departed source failures cannot notify a new owner', async () => {
  for (const variant of ['to-multi', 'from-multi', 'to-select', 'from-select'] as const) await withWorkspace('en-US', async context => {
    const base = context.disk()
    const openMulti = async () => {
      const details = context.row().querySelector<HTMLDetailsElement>('.dbw-multi-editor'); assert.ok(details)
      await act(async () => {
        details.querySelector<HTMLElement>('summary')!.click()
        await new Promise<void>(resolve => context.window.setTimeout(resolve, 0))
      })
      assert.equal(details.open, true)
      const option = [...details.querySelectorAll<HTMLInputElement>('input')]
        .find(node => node.parentElement?.textContent === 'checkbox'); assert.ok(option)
      return { details, option }
    }
    const chooseSelect = async () => {
      const select = context.row().querySelector<HTMLSelectElement>('select[aria-label="Done"]'); assert.ok(select)
      await context.change(() => { select.value = 'checkbox'; select.dispatchEvent(new context.window.Event('change', { bubbles: true })) })
    }
    const reverse = variant.startsWith('from')
    const otherType = variant.endsWith('multi') ? 'multi-select' : 'select'
    if (reverse) {
      await context.update({ columns: [{ ...done, type: otherType, options: ['checkbox'] }, notes] })
      await context.external(otherType === 'multi-select' ? [] : '', '2026-10-01T12:00:00.000Z')
      if (otherType === 'multi-select') { const menu = await openMulti(); await context.change(() => menu.option.click()) }
      else await chooseSelect()
      assert.deepEqual(context.requests[0].payload.fieldValues, { done: otherType === 'multi-select' ? ['checkbox'] : 'checkbox' })
      await context.update({ columns: [done, notes] })
      await context.change(() => context.field().click())
    } else {
      await context.change(() => context.field().click())
      assert.deepEqual(context.requests[0].payload.fieldValues, { done: true })
      await context.update({ columns: [{ ...done, type: otherType, options: ['checkbox'] }, notes] })
      if (otherType === 'multi-select') { const menu = await openMulti(); await context.change(() => menu.option.click()) }
      else await chooseSelect()
    }
    assert.equal(context.requests.length, 1, 'a type change cannot release the still-physical old request')
    await context.reject(0)
    assert.equal(appNotifications.getSnapshot().length, 0)
    assert.equal(context.row().querySelectorAll('[role="alert"],[role="status"]').length, 0)
    if (reverse) {
      assert.equal(context.field().checked, false)
      await context.change(() => context.field().click())
    } else if (otherType === 'multi-select') {
      const menu = context.row().querySelector<HTMLDetailsElement>('.dbw-multi-editor')!; assert.ok(menu)
      assert.equal(menu.querySelector('summary')?.textContent, '—')
      const option = [...menu.querySelectorAll<HTMLInputElement>('input')].find(node => node.parentElement?.textContent === 'checkbox')!
      assert.equal(option.checked, false)
      await context.change(() => option.click())
    } else await chooseSelect()
    assert.equal(context.requests.length, 2)
    const value = reverse ? true : otherType === 'multi-select' ? ['checkbox'] : 'checkbox'
    assert.deepEqual(context.requests[1].payload.fieldValues, { done: value })
    await context.ack(1)
    await context.read(0)
    assert.deepEqual(context.disk()[0].fieldValues, { ...base[0].fieldValues, done: value })
    assert.equal(context.writes(), 1)
    assert.equal(appNotifications.getSnapshot().length, 0)
  })
  for (const returnToFirst of [false, true]) await withWorkspace('zh-CN', async context => {
    const beforeA = context.disk(), beforeB = context.disk('other-checkbox')
    await context.change(() => context.field().click())
    await context.update({ source: 'other-checkbox', entities: beforeB })
    if (returnToFirst) await context.update({ source: database.id, entities: beforeA })
    else await context.change(() => context.field().click())
    await context.reject(0)
    assert.equal(appNotifications.getSnapshot().length, 0, 'source ABA or departure permanently revokes the old global error owner')
    if (returnToFirst) await context.change(() => context.field().click())
    else assert.equal(context.field().getAttribute('aria-disabled'), 'true')
    assert.equal(context.requests.length, 2)
    await context.ack(1)
    await context.read(0)
    assert.equal(context.field().checked, true)
    assert.equal(context.requests[1].source, returnToFirst ? database.id : 'other-checkbox')
    assert.deepEqual(context.disk(returnToFirst ? 'other-checkbox' : database.id), returnToFirst ? beforeB : beforeA)
    assert.equal(context.writes(), 1)
  })
})

test('the real RecordDrawer synchronous boolean setter changes only its draft until explicit Save', async () => {
  await withWorkspace('zh-CN', async context => {
    const before = context.disk(), text = getDatabaseWorkspaceText('zh-CN')
    const title = context.row().querySelector<HTMLButtonElement>('.dbw-record-title'); assert.ok(title)
    await context.change(() => title.click())
    const drawer = context.document.querySelector('.dbw-record-drawer'); assert.ok(drawer)
    const input = drawer.querySelector<HTMLInputElement>('input[aria-label="Done"]'); assert.ok(input)
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    for (const checked of [true, false, true]) {
      await context.change(() => input.click())
      assert.equal(input.checked, checked)
      assert.equal(input.disabled, false)
      assert.notEqual(input.getAttribute('aria-disabled'), 'true')
      assert.notEqual(input.getAttribute('aria-busy'), 'true')
      assert.equal(context.requests.length, 0)
      assert.equal(drawer.querySelectorAll('[role="alert"],[role="status"]').length, 0)
    }
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.disk(), before)
    const save = [...drawer.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === text.save); assert.ok(save)
    await context.change(() => save.click())
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].payload.fieldValues, { done: true, notes: 'Original Notes' })
    await context.ack(0)
    await context.read(0)
    assert.equal(context.document.querySelectorAll('.dbw-record-drawer').length, 0)
    assert.equal(context.writes(), 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, done: true })
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
  })
})

test('actual Page records and schema publication jointly confirm a saved checkbox read without unlocking a newer write', async () => {
  for (const nextWrite of [false, true]) await withWorkspace('en-US', async context => {
    const before = context.disk(), initial = context.model(), input = context.field(), text = getDatabaseWorkspaceText('en-US')
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.change(() => input.click())
    await context.ack(0)
    assert.deepEqual(context.reads[0].calls.slice().sort(), ['columns', 'databases', 'documents', 'entities', 'home', 'views'])
    await context.read(0, true)
    assert.equal(input.checked, true)
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    context.hold(['entities', 'columns'])
    const refresh = context.cell().querySelector<HTMLButtonElement>('button'); assert.ok(refresh)
    await context.change(() => refresh.click())
    await context.read(1)
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed,
      'GET true plus a Page pulse cannot stand in for real parent publication')
    assert.equal(context.cell().querySelectorAll('button').length, 1)
    assert.deepEqual(context.model().entities, initial.entities)
    await context.flush(['entities'])
    assert.deepEqual(context.model().entities, context.disk())
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    if (nextWrite) {
      await context.change(() => input.click())
      assert.equal(input.checked, false)
      assert.deepEqual(context.requests[1].payload.fieldValues, { done: false })
      assert.equal(input.getAttribute('aria-disabled'), 'true')
    }
    await context.flush(['columns'])
    if (nextWrite) {
      assert.equal(input.checked, false)
      assert.equal(input.getAttribute('aria-disabled'), 'true', 'an older read receipt never unlocks a newly accepted write')
      await context.ack(1)
      await context.read(2)
    }
    assert.equal(input.checked, !nextWrite)
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.requests.length, nextWrite ? 2 : 1)
    assert.equal(context.writes(), context.requests.length)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.deepEqual(context.model().entities, context.disk())
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, done: !nextWrite })
    assert.deepEqual(context.model().home, initial.home)
    assert.deepEqual(context.model().databases, initial.databases)
    assert.deepEqual(context.model().views, initial.views)
    assert.deepEqual(context.model().documents, initial.documents)
    assert.equal(context.model().activeView, initial.activeView)
  }, { page: true })
})
