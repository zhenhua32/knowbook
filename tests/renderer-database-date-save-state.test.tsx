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
const { DatabaseTextDraftCache } = await import('../src/renderer/src/features/database/model/databaseTextDrafts')
const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const database: DocumentDatabase = { id: 'date-source', kind: 'custom', name: 'Original date source',
  description: 'Original source description', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const due: DocumentDatabaseColumn = { id: 'due', name: 'Due', type: 'date', options: [], sortOrder: 0 }
const notes: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 1 }
const record: DatabaseEntity = { id: 'date-record', databaseId: database.id, title: 'Original date record', documentId: null,
  fieldValues: { due: '2026-10-01', notes: 'Original Notes', hidden: 'Untouched hidden metadata' },
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const view: DatabaseSavedView = { id: 'original-view', databaseId: database.id, name: 'Original table',
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, due.id, notes.id]), configVersion: 1,
  filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }
type Request = ReturnType<typeof deferred<DatabaseEntity>> & { payload: UpdateDatabaseEntityInput; source: string }
type CatalogRequest = ReturnType<typeof deferred<void>> & { payload: UpdateDocumentDatabaseValueInput }
type Read = ReturnType<typeof deferred<void>> & { source: string; preferred?: string; canApply: () => boolean; failed: boolean; calls: string[] }
type Model = { source: string; shown: boolean; columns: DocumentDatabaseColumn[]; entities: DatabaseEntity[];
  databases: DocumentDatabase[]; views: DatabaseSavedView[]; activeView: string; home: HomeData;
  documents: DocumentCatalogEntry[]; catalogColumns: DocumentDatabaseColumn[] }
const fixtureHome: HomeData = { appearanceTheme: 'light', summary: { databasePath: 'isolated-date.db', backupRoot: 'Original backup',
  documents: 0, blocks: 0, links: 0, lastBackupAt: null }, recentDocuments: [], recentEvents: [], documentCatalog: [],
  databaseColumns: [], documentTree: [], initialDocumentId: null, aiConfig: { enabled: false, baseUrl: '', model: '',
    autoSummaryOnSave: false, relatedNotesEnabled: false, hasApiKey: false } }

function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) appNotifications.dismiss(id)
  appNotifications.clearCompleted()
}

async function withWorkspace(locale: 'en-US' | 'zh-CN', run: (context: {
  document: Document; window: JSDOM['window']; outside: HTMLInputElement; requests: Request[]; catalogRequests: CatalogRequest[]; reads: Read[]; focusCalls: HTMLElement[]
  field: () => HTMLInputElement; cell: () => HTMLTableCellElement; row: () => HTMLTableRowElement; change: (callback: () => void) => Promise<void>
  changeDate: (value: string) => Promise<void>; key: (key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  ack: (index: number) => Promise<void>; ackCatalog: (index: number) => Promise<void>; reject: (index: number) => Promise<void>
  read: (index: number, failed?: boolean) => Promise<void>; writes: () => number; disk: (source?: string) => DatabaseEntity[]
  catalogDisk: () => DocumentCatalogEntry[]; schema: () => unknown; owner: () => unknown; facts: () => unknown; model: () => Model
  update: (patch: Partial<Model>) => Promise<void>; move: (top: number) => Promise<void>
  external: (value: DocumentDatabaseFieldValue, revision: string, otherFields?: DatabaseEntity['fieldValues']) => Promise<void>
  hold: (keys: (keyof Model)[]) => void; flush: (keys: (keyof Model)[]) => Promise<void>
}) => Promise<void>, options: { virtual?: boolean; page?: boolean; catalog?: boolean; initial?: string } = {}) {
  clearNotifications()
  const oldLanguage = getActiveUiText().language
  setActiveUiLanguage(locale)
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside control">', { url: 'http://localhost', pretendToBeVisual: true })
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
    return 40 + node.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length * 64 + spacers
  } })
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (settings) { focusCalls.push(this); nativeFocus.call(this, settings) }
  const stored = structuredClone({ database, due, notes, view })
  const sources: DocumentDatabase[] = [stored.database,
    { ...stored.database, id: 'other-date', name: 'Other date source' },
    { ...stored.database, id: 'catalog-date', kind: 'document-catalog', name: 'Original date catalog' }]
  const initialSource = options.catalog ? 'catalog-date' : database.id
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(sources.filter(source => source.kind === 'custom').map(source => [source.id,
    [{ ...structuredClone(record), databaseId: source.id, fieldValues: { ...record.fieldValues, due: options.initial ?? '2026-10-01' } },
      ...Array.from({ length: options.virtual ? 59 : 0 }, (_, index) => ({ ...structuredClone(record), databaseId: source.id,
        id: 'virtual-' + index, title: 'Original zz record ' + index }))]]))
  let catalog: DocumentCatalogEntry[] = [{ id: record.id, title: record.title, path: 'Original date record',
    summary: 'Untouched document summary', parentId: null, parentTitle: null, updatedAt: '2026-10-01',
    blockCount: 3, childCount: 0, linkCount: 2, fieldValues: { ...record.fieldValues, due: options.initial ?? '2026-10-01' } }]
  const requests: Request[] = [], catalogRequests: CatalogRequest[] = [], reads: Read[] = [], contextChanges: unknown[] = []
  const textDraftCache = new DatabaseTextDraftCache(), cacheRef = { current: textDraftCache }
  const held = new Set<keyof Model>(), queued: Array<{ key: keyof Model; apply: (previous: Model) => Model }> = []
  let writes = 0, current!: Model, setModel!: (action: SetStateAction<Model>) => void
  const latestRead = (channel: string) => {
    const request = reads.at(-1); assert.ok(request)
    request.calls.push(channel); return request
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (payload: UpdateDatabaseEntityInput) => {
      assert.equal(payload.entityId, record.id)
      if (current.columns.find(column => column.id === due.id)?.type === 'date') {
        assert.equal(payload.fieldValues?.due === null || typeof payload.fieldValues?.due === 'string', true)
        if (payload.fieldValues?.due !== null) assert.match(String(payload.fieldValues?.due), /^\d{4}-\d{2}-\d{2}$/)
      }
      const request = { ...deferred<DatabaseEntity>(), payload: structuredClone(payload), source: current.source }
      requests.push(request); return request.promise
    },
    updateDocumentDatabaseValue: (payload: UpdateDocumentDatabaseValueInput) => {
      assert.equal(payload.documentId, record.id)
      assert.equal(payload.columnId, due.id)
      assert.equal(payload.value === null || typeof payload.value === 'string', true)
      if (payload.value !== null) assert.match(String(payload.value), /^\d{4}-\d{2}-\d{2}$/)
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
    getDatabaseEntities: (source: string) => latestRead('entities').promise.then(() => structuredClone(server[source] ?? [])),
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
      { source: initialSource, shown: true, columns: [stored.due, stored.notes], entities: structuredClone(server[initialSource] ?? []),
        databases: sources, views: [{ ...stored.view, databaseId: initialSource }], activeView: stored.view.id,
        home: structuredClone(fixtureHome), documents: structuredClone(catalog), catalogColumns: [stored.due, stored.notes] })
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
      selectedDatabaseEntityIds: [record.id], databaseTextDraftCache: cacheRef,
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
      selectedColumns: model.columns, selectedRecordIds: [record.id], textDraftCache,
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
    const fields = row().querySelectorAll<HTMLInputElement>('input[type="date"][aria-label="Due"]')
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
    assert.equal(field().value, options.initial ?? '2026-10-01')
    const query = dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
    await change(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(query, 'Original')
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.equal(query.value, 'Original')
    assert.equal(owner().selected, true)
    assert.equal(owner().notes, 'Original Notes')
    await run({ document: dom.window.document, window: dom.window, outside: dom.window.document.getElementById('outside') as HTMLInputElement, requests, catalogRequests, reads, focusCalls, field, row,
      cell: () => field().closest('td')!, change,
      changeDate: async value => { await change(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field(), value)
        field().dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      }) },
      key: async (key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await change(() => field().dispatchEvent(event)); return event
      },
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
      reject: async index => { assert.ok(requests[index]); await act(async () => requests[index].reject(new Error('Isolated date mutation rejected.'))) },
      read: async (index, failed = false) => {
        const request = reads[index]; assert.ok(request)
        await act(async () => {
          if (failed) { request.failed = true; request.reject(new Error('Isolated date GET failed after its durable ACK.')) }
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
          fieldValues: { ...entity.fieldValues, ...structuredClone(otherFields), due: value }, updatedAt: revision } : entity)
        await change(() => setModel(previous => ({ ...previous, entities: structuredClone(server[previous.source]) })))
      },
      hold: keys => keys.forEach(key => held.add(key)),
      flush: async keys => {
        const selected = new Set(keys); selected.forEach(key => held.delete(key))
        const pending = queued.filter(item => selected.has(item.key))
        for (let index = queued.length - 1; index >= 0; index--) if (selected.has(queued[index].key)) queued.splice(index, 1)
        await change(() => pending.forEach(item => setModel(item.apply)))
      },
      facts: () => ({ locale, input: { value: field().value, readOnly: field().readOnly, disabled: field().disabled,
        ariaDisabled: field().getAttribute('aria-disabled'), ariaBusy: field().getAttribute('aria-busy'),
        focused: dom.window.document.activeElement === field() }, programFocusCalls: focusCalls.length,
        requests: requests.map(request => request.payload), catalogRequests: catalogRequests.map(request => request.payload),
        writes, reads: reads.map(read => ({ source: read.source, preferred: read.preferred, failed: read.failed })),
        disk: structuredClone(server), published: structuredClone(current), schema: schema(), owner: owner(),
        notifications: appNotifications.getSnapshot().map(item => item.message) }) })
    assert.deepEqual(stored, { database, due, notes, view })
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

test('pending date changes retain the accepted date and share exactly one write', async t => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withWorkspace(locale, async context => {
    const before = context.disk(), schema = context.schema(), owner = context.owner(), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    // Dates now submit at complete Enter/blur, so intermediate year segments
    // edit the draft without creating the old sequence of partial IPC writes.
    for (const value of ['0002-10-01', '0020-10-01', '0202-10-01', '2027-10-01', '2026-10-02']) await context.changeDate(value)
    assert.equal(context.requests.length, 0)
    await context.key('Enter')
    await context.changeDate('2026-10-03')
    await context.key('Enter')
    t.diagnostic(JSON.stringify(context.facts()))
    assert.equal(context.writes(), 0)
    assert.equal(context.reads.length, 0)
    assert.deepEqual(context.disk(), before)
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.owner(), owner)
    assert.deepEqual(context.requests[0].payload, { entityId: record.id, fieldValues: { due: '2026-10-02' } })
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(input.value, '2026-10-02', 'the accepted date remains visible until its exact write has acknowledged')
    assert.equal(context.requests.length, 1, 'a repeat date change cannot start a second pending write')
    assert.equal(input.disabled, false)
    assert.equal(input.readOnly, true)
    assert.equal(input.getAttribute('aria-busy'), 'true')
  })
  await withWorkspace('en-US', async context => {
    const input = context.field(), before = context.disk(), text = getDatabaseWorkspaceText('en-US')
    await context.change(() => input.focus())
    // JSDOM sanitizes unfinished native date segments to an empty value but
    // does not implement Chromium's badInput signal. Only that public DOM
    // sensor is controlled here; real native year editing is covered by E2E.
    const original = Object.getOwnPropertyDescriptor(input, 'validity'), nativeValidity = input.validity
    Object.defineProperty(input, 'validity', { configurable: true,
      get: () => new Proxy(nativeValidity, { get: (target, key) => key === 'badInput' ? true : Reflect.get(target, key, target) }) })
    try {
      await context.changeDate('')
      await context.key('Enter')
      assert.equal(input.value, '')
      assert.equal(context.requests.length, 0, 'incomplete native segments must never become a null clear')
      assert.equal(context.cell().querySelector('[role="alert"]')?.textContent, text.dateIncomplete)
      assert.equal(input.readOnly, false)
      assert.deepEqual(context.disk(), before)
      assert.equal(appNotifications.getSnapshot().length, 0)
    } finally {
      if (original) Object.defineProperty(input, 'validity', original)
      else Reflect.deleteProperty(input, 'validity')
    }
    await context.changeDate('2026-10-02')
    await context.key('Enter')
    assert.equal(context.requests.length, 1)
    await context.ack(0)
    await context.read(0)
    assert.equal(input.value, '2026-10-02')
  })
})

test('a durable date ACK survives its independent GET failure and offers read-only Refresh', async t => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withWorkspace(locale, async context => {
    const before = context.disk(), schema = context.schema(), owner = context.owner(), input = context.field(), text = getDatabaseWorkspaceText(locale)
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.changeDate('2026-10-02')
    // Preserve the original ACK/read-failure oracle with the new explicit
    // complete-date submission boundary, rather than writing on every change.
    await context.key('Enter')
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].payload, { entityId: record.id, fieldValues: { due: '2026-10-02' } })
    await context.ack(0)
    assert.equal(context.writes(), 1)
    assert.equal(context.reads.length, 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, due: '2026-10-02' })
    await context.read(0, true)
    t.diagnostic(JSON.stringify(context.facts()))
    // The fixture persists B before resolving the authentic update response;
    // the rejected promise belongs to the subsequent GET, not the write.
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    assert.equal(context.reads.length, 1)
    assert.equal(context.reads[0].failed, true)
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, due: '2026-10-02' })
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.owner(), owner)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.equal(context.document.querySelectorAll('.app-notification [role="alert"]').length, 1)
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(input.value, '2026-10-02', 'the failed post-ACK GET cannot restore stale date A')
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    const refresh = [...context.cell().querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === text.refresh)
    assert.ok(refresh, 'an already saved date needs a read-only recovery action')
    await context.change(() => { refresh.click(); refresh.click() })
    assert.equal(context.reads.length, 2)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 1)
    await context.read(1)
    assert.equal(input.value, '2026-10-02')
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.deepEqual(context.owner(), owner)
    assert.deepEqual(context.schema(), schema)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, due: '2026-10-02' })
  })
  for (const date of ['2026-10-02', null]) await withWorkspace('zh-CN', async context => {
    const before = context.catalogDisk(), schema = context.schema(), owner = context.owner(), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.changeDate(date ?? '')
    assert.equal(input.validity.badInput, false, 'a legal empty date is a clear, not a partial native segment')
    await context.key('Enter')
    assert.equal(context.requests.length, 0)
    assert.deepEqual(context.catalogRequests[0].payload, { documentId: record.id, columnId: due.id, value: date })
    await context.ackCatalog(0)
    await context.read(0, true)
    assert.equal(input.value, date ?? '')
    assert.equal(input.readOnly, false)
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, getDatabaseWorkspaceText('zh-CN').savedRefreshFailed)
    assert.deepEqual(context.catalogDisk(), before.map(document => ({ ...document, fieldValues: { ...document.fieldValues, due: date } })),
      'catalog date ACKs do not modify document metadata or updatedAt')
    const refresh = context.cell().querySelector<HTMLButtonElement>('button'); assert.ok(refresh)
    await context.change(() => { refresh.click(); refresh.click() })
    assert.equal(context.reads.length, 2)
    assert.equal(context.catalogRequests.length, 1)
    await context.read(1)
    assert.equal(input.value, date ?? '')
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.equal(context.writes(), 1)
    assert.deepEqual(context.owner(), owner)
    assert.deepEqual(context.schema(), schema)
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
  }, { catalog: true })
})
test('failed date writes retain the entered date and retry explicitly without implicit repeated submissions', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) await withWorkspace(locale, async context => {
    const before = context.disk(), schema = context.schema(), input = context.field(), text = getDatabaseWorkspaceText(locale)
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.changeDate('2026-10-02')
    await context.key('Enter')
    await context.external('2026-10-03', '2026-10-01T12:00:00.000Z', { notes: 'Another property changed during the write' })
    const latest = context.disk()
    await context.reject(0)
    assert.equal(input.value, '2026-10-02', 'a rejected date remains an unsaved draft rather than looking accepted or reverting silently')
    assert.equal(input.readOnly, false)
    assert.equal(context.cell().querySelector('[role="alert"]')?.textContent, text.dateSaveFailed)
    assert.equal(context.document.querySelector('.app-notification-message')?.textContent, text.dateSaveFailed)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.equal(context.requests.length, 1)
    assert.equal(context.writes(), 0)
    assert.equal(context.reads.length, 0)
    assert.deepEqual(context.disk(), latest)
    assert.deepEqual(context.schema(), schema)
    await context.key('Enter')
    await context.change(() => context.outside.focus())
    await context.change(() => input.focus())
    assert.equal(context.requests.length, 1, 'unchanged failed drafts are browsed without an automatic write retry')
    const retry = context.cell().querySelector<HTMLButtonElement>('button[aria-label="' + text.retry + '"]'); assert.ok(retry)
    await context.change(() => { retry.click(); retry.click() })
    assert.equal(context.requests.length, 2)
    assert.deepEqual(context.requests[1].payload, context.requests[0].payload)
    assert.equal(input.readOnly, true)
    await context.ack(1)
    await context.read(0)
    assert.equal(input.value, '2026-10-02')
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, due: '2026-10-02',
      notes: 'Another property changed during the write' })
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.equal(context.writes(), 1)
    assert.equal(context.requests.length, 2)
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 2, 'only the two explicit browsing focus calls occur')
  })
})

test('a date ACK allows newer drafts and writes while an older GET cannot overwrite or unlock their owner', async () => {
  for (const failedRead of [false, true]) await withWorkspace('en-US', async context => {
    const before = context.disk(), owner = context.owner(), input = context.field()
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.changeDate('2026-10-02')
    await context.key('Enter')
    await context.ack(0)
    assert.equal(input.readOnly, false)
    await context.changeDate('2026-10-04')
    await context.key('Escape')
    assert.equal(input.value, '2026-10-02', 'continued editing after a focused Enter ACK restores the acknowledged date, not stale opening props')
    assert.equal(context.document.activeElement === input, false, 'Escape keeps the existing real native blur contract')
    assert.equal(context.requests.length, 1)
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.changeDate('2026-10-03')
    assert.equal(input.value, '2026-10-03')
    assert.equal(context.requests.length, 1, 'editing a complete next date does not itself save it')
    await context.key('Enter')
    assert.deepEqual(context.requests[1].payload, { entityId: record.id, fieldValues: { due: '2026-10-03' } })
    assert.equal(input.readOnly, true)
    await context.read(0, failedRead)
    assert.equal(input.value, '2026-10-03')
    assert.equal(input.readOnly, true)
    assert.equal(appNotifications.getSnapshot().length, 0)
    await context.ack(1)
    assert.equal(input.readOnly, false)
    assert.equal(context.reads.length, 2)
    await context.read(1)
    assert.equal(input.value, '2026-10-03')
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, due: '2026-10-03' })
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
    assert.equal(context.requests.length, 2)
    assert.equal(context.writes(), 2)
    assert.deepEqual(context.owner(), owner)
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
  })
})

test('virtual rows and temporary Workspace unmounts preserve date drafts and accepted writes in the permanent cache', async () => {
  for (const hiddenBy of ['virtual', 'page'] as const) await withWorkspace('zh-CN', async context => {
    const before = context.disk(), input = context.field()
    await context.change(() => input.focus())
    await context.changeDate('2026-10-02')
    assert.equal(context.requests.length, 0)
    const hideAndReturn = async () => {
      if (hiddenBy === 'virtual') {
        await context.move(3500)
        assert.equal(context.document.querySelectorAll('tbody input[type="date"]').length > 0, true)
        await context.move(0)
      } else {
        await context.update({ shown: false })
        await context.update({ shown: true })
      }
    }
    await hideAndReturn()
    const replacement = context.field()
    assert.equal(input.isConnected, false)
    assert.equal(replacement === input, false)
    assert.equal(replacement.value, '2026-10-02')
    await context.change(() => replacement.focus())
    await context.key('Enter')
    assert.equal(context.requests.length, 1)
    await hideAndReturn()
    const pending = context.field()
    assert.equal(replacement.isConnected, false)
    assert.equal(pending.value, '2026-10-02')
    assert.equal(pending.readOnly, true)
    await context.change(() => pending.focus())
    await context.key('Enter')
    assert.equal(context.requests.length, 1)
    await context.ack(0)
    assert.equal(context.writes(), 1)
    assert.equal(pending.value, '2026-10-02')
    assert.equal(pending.readOnly, false)
    if (hiddenBy === 'virtual') {
      assert.equal(context.reads.length, 1)
      await context.read(0)
    } else {
      assert.equal(context.reads.length, 0, 'the unmounted accepted request does not publish an old Workspace read')
      const refresh = context.cell().querySelector<HTMLButtonElement>('button'); assert.ok(refresh)
      await context.change(() => refresh.click())
      await context.read(0)
    }
    assert.deepEqual(context.disk(), before.map(entity => entity.id === record.id ? { ...entity,
      fieldValues: { ...entity.fieldValues, due: '2026-10-02' }, updatedAt: context.disk()[0].updatedAt } : entity))
    assert.equal(context.requests.length, 1)
    assert.equal(appNotifications.getSnapshot().length, 0)
  }, { virtual: hiddenBy === 'virtual' })
})

test('date and text namespaces isolate late type results while source departure and ABA suppress old notifications', async () => {
  for (const direction of ['date-to-text', 'text-to-date'] as const) await withWorkspace('en-US', async context => {
    const before = context.disk(), dateFirst = direction === 'date-to-text'
    const fillText = async (value: string) => {
      const input = context.row().querySelector<HTMLInputElement>('input[aria-label="Due"]'); assert.ok(input)
      await context.change(() => {
        Object.getOwnPropertyDescriptor(context.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new context.window.Event('input', { bubbles: true }))
      })
      return input
    }
    if (dateFirst) {
      await context.change(() => context.field().focus())
      await context.changeDate('2026-10-02')
      await context.key('Enter')
      await context.update({ columns: [{ ...due, type: 'text' }, notes] })
      const textInput = await fillText('New text owner')
      await context.change(() => textInput.focus())
      await context.change(() => textInput.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    } else {
      await context.update({ columns: [{ ...due, type: 'text' }, notes] })
      const textInput = await fillText('Old text owner')
      await context.change(() => textInput.focus())
      await context.change(() => textInput.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
      await context.update({ columns: [due, notes] })
      assert.equal(context.field().value, '2026-10-01')
      await context.change(() => context.field().focus())
      await context.changeDate('2026-10-03')
      await context.key('Enter')
    }
    assert.equal(context.requests.length, 2, 'typed namespaces are independent; the text cache does not claim a cross-type physical write map')
    const current = context.row().querySelector<HTMLInputElement>('input[aria-label="Due"]'); assert.ok(current)
    assert.equal(current.readOnly, true)
    await context.reject(0)
    assert.equal(appNotifications.getSnapshot().length, 0)
    assert.equal(current.readOnly, true)
    assert.equal(current.value, dateFirst ? 'New text owner' : '2026-10-03')
    assert.equal(context.row().querySelectorAll('[role="alert"]').length, 0)
    await context.ack(1)
    await context.read(0)
    assert.equal(context.writes(), 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, due: current.value })
  })
  for (const returnToFirst of [false, true]) await withWorkspace('zh-CN', async context => {
    const beforeA = context.disk(), beforeB = context.disk('other-date')
    await context.change(() => context.field().focus())
    await context.changeDate('2026-10-02')
    await context.key('Enter')
    await context.update({ source: 'other-date', entities: beforeB })
    if (returnToFirst) await context.update({ source: database.id, entities: beforeA })
    else {
      await context.change(() => context.field().focus())
      await context.changeDate('2026-10-03')
      await context.key('Enter')
    }
    await context.reject(0)
    assert.equal(appNotifications.getSnapshot().length, 0)
    if (returnToFirst) {
      await context.changeDate('2026-10-03')
      await context.key('Enter')
    } else assert.equal(context.field().readOnly, true)
    assert.equal(context.requests.length, 2)
    await context.ack(1)
    await context.read(0)
    assert.equal(context.field().value, '2026-10-03')
    assert.equal(context.requests[1].source, returnToFirst ? database.id : 'other-date')
    assert.deepEqual(context.disk(returnToFirst ? 'other-date' : database.id), returnToFirst ? beforeB : beforeA)
    assert.equal(context.writes(), 1)
  })
})

test('the real RecordDrawer date change-mode setter edits and clears only its local draft until Save', async () => {
  await withWorkspace('zh-CN', async context => {
    const before = context.disk(), text = getDatabaseWorkspaceText('zh-CN')
    const title = context.row().querySelector<HTMLButtonElement>('.dbw-record-title'); assert.ok(title)
    await context.change(() => title.click())
    const drawer = context.document.querySelector('.dbw-record-drawer'); assert.ok(drawer)
    const input = drawer.querySelector<HTMLInputElement>('input[type="date"][aria-label="Due"]'); assert.ok(input)
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    for (const value of ['2026-10-02', '', '2026-10-03']) {
      await context.change(() => {
        Object.getOwnPropertyDescriptor(context.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new context.window.Event('change', { bubbles: true }))
        input.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(input.value, value)
      assert.equal(input.readOnly, false)
      assert.equal(context.requests.length, 0)
      assert.equal(drawer.querySelectorAll('[role="alert"],[role="status"]').length, 0)
    }
    assert.equal(context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.deepEqual(context.disk(), before)
    const save = [...drawer.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === text.save); assert.ok(save)
    await context.change(() => save.click())
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].payload.fieldValues, { due: '2026-10-03', notes: 'Original Notes' })
    await context.ack(0)
    await context.read(0)
    assert.equal(context.document.querySelectorAll('.dbw-record-drawer').length, 0)
    assert.equal(context.writes(), 1)
    assert.deepEqual(context.disk()[0].fieldValues, { ...before[0].fieldValues, due: '2026-10-03' })
    assert.deepEqual({ ...context.disk()[0], fieldValues: before[0].fieldValues, updatedAt: before[0].updatedAt }, before[0])
  })
})

test('the actual Page requires records and schema to confirm date reads and preserves newer writes and null clearing', async () => {
  for (const nextWrite of [false, true]) await withWorkspace('en-US', async context => {
    // Catalog value writes preserve document.updatedAt. Unlike a new custom
    // entity revision, records alone cannot acknowledge this same-revision read.
    const before = context.catalogDisk(), initial = context.model(), input = context.field(), text = getDatabaseWorkspaceText('en-US')
    await context.change(() => input.focus())
    context.focusCalls.length = 0
    await context.changeDate('2026-10-02')
    await context.key('Enter')
    await context.ackCatalog(0)
    assert.deepEqual(context.reads[0].calls.slice().sort(), ['columns', 'databases', 'documents', 'entities', 'home', 'views'])
    await context.read(0, true)
    assert.equal(input.value, '2026-10-02')
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    context.hold(['documents', 'catalogColumns'])
    const refresh = context.cell().querySelector<HTMLButtonElement>('button'); assert.ok(refresh)
    await context.change(() => refresh.click())
    await context.read(1)
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    assert.equal(context.cell().querySelectorAll('button').length, 1)
    assert.deepEqual(context.model().documents, initial.documents)
    await context.flush(['documents'])
    assert.deepEqual(context.model().documents, context.catalogDisk())
    assert.equal(context.cell().querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
    if (nextWrite) {
      await context.changeDate('2026-10-03')
      await context.key('Enter')
      assert.equal(input.readOnly, true)
    }
    await context.flush(['catalogColumns'])
    if (nextWrite) {
      assert.equal(input.value, '2026-10-03')
      assert.equal(input.readOnly, true, 'the old Page receipt cannot unlock a newer date write')
      await context.ackCatalog(1)
      await context.read(2)
    }
    assert.equal(input.value, nextWrite ? '2026-10-03' : '2026-10-02')
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    await context.changeDate('')
    assert.equal(input.validity.badInput, false)
    await context.key('Enter')
    const clearIndex = context.catalogRequests.length - 1, nextRead = context.reads.length
    assert.deepEqual(context.catalogRequests[clearIndex].payload, { documentId: record.id, columnId: due.id, value: null })
    await context.ackCatalog(clearIndex)
    await context.read(nextRead)
    assert.equal(input.value, '')
    assert.equal(input.readOnly, false)
    assert.equal(context.cell().querySelectorAll('[role="status"],[role="alert"],button').length, 0)
    assert.equal(context.field() === input && context.document.activeElement === input, true)
    assert.equal(context.focusCalls.length, 0)
    assert.equal(context.catalogRequests.length, nextWrite ? 3 : 2)
    assert.equal(context.requests.length, 0)
    assert.equal(context.writes(), context.catalogRequests.length)
    assert.equal(appNotifications.getSnapshot().length, 1)
    assert.deepEqual(context.model().documents, context.catalogDisk())
    assert.deepEqual(context.catalogDisk(), before.map(document => ({ ...document,
      fieldValues: { ...document.fieldValues, due: null } })))
    assert.deepEqual(context.model().entities, initial.entities)
    assert.deepEqual(context.model().home, initial.home)
    assert.deepEqual(context.model().databases, initial.databases)
    assert.deepEqual(context.model().views, initial.views)
    assert.equal(context.model().activeView, initial.activeView)
  }, { page: true, catalog: true })
})
