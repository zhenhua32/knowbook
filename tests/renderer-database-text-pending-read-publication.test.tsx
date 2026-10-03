import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, Fragment, useState, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentCatalogEntry, DocumentCatalogPage,
  DocumentCatalogPageInput, DocumentDatabase, DocumentDatabaseColumn, HomeData,
  UpdateDocumentDatabaseValueInput } from '../src/shared/contracts'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../src/renderer/src/types/appDomains'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { notify } from '../src/renderer/src/notify'
import { getActiveUiText, getUiText, setActiveUiLanguage, type UiLanguage } from '../src/renderer/src/i18n'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

// Only styles are omitted: Page, Workspace, Table, Editor, and notification Host
// all execute their production callbacks and use the Page's real draft cache.
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

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const columns: DocumentDatabaseColumn[] = [
  { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 },
  { id: 'hidden', name: 'Hidden metadata', type: 'text', options: [], sortOrder: 1 }
]
const sources: DocumentDatabase[] = [{ id: 'catalog', kind: 'document-catalog', name: 'Catalog',
  description: 'Preserved catalog metadata', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
{ id: 'other-source', kind: 'custom', name: 'Other source', description: 'Preserved independent source',
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }]
const savedViews: DatabaseSavedView[] = [{ id: 'catalog-table', databaseId: 'catalog', name: 'Notes table',
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, 'notes']),
  configVersion: 1, filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table',
  sortOrder: 0, createdAt: '2026-10-01', updatedAt: '2026-10-01' }]
const initialDocuments = (): DocumentCatalogEntry[] => ['target', 'other'].map((id, index) => ({ id,
  title: index === 0 ? 'Target' : 'Other', path: `Parent/${id}`, parentId: 'parent', parentTitle: 'Parent',
  summary: `Preserved ${id} summary`, updatedAt: '2026-10-01T00:00:00.000Z',
  blockCount: 3 + index, childCount: index, linkCount: 2 + index,
  fieldValues: { notes: index === 0 ? 'Alpha' : 'Other notes', hidden: `Hidden ${id} value` } }))
const home: HomeData = { appearanceTheme: 'light',
  summary: { databasePath: 'isolated-catalog.db', backupRoot: 'isolated-backup', documents: 2,
    blocks: 7, links: 5, lastBackupAt: null }, recentDocuments: [], recentEvents: [],
  documentCatalog: initialDocuments().map(({ id, title, path, parentId, updatedAt }) => ({ id, title, path, parentId, updatedAt })),
  databaseColumns: columns, documentTree: [], initialDocumentId: null,
  aiConfig: { enabled: false, baseUrl: '', model: '', autoSummaryOnSave: false,
    relatedNotesEnabled: false, hasApiKey: false } }
type Model = { source: string; shown: boolean; documents: DocumentCatalogEntry[]; catalogColumns: DocumentDatabaseColumn[];
  databases: DocumentDatabase[]; selectedColumns: DocumentDatabaseColumn[]; entities: DatabaseEntity[];
  views: DatabaseSavedView[]; activeView: string; home: HomeData }
type Write = ReturnType<typeof deferred<void>> & { input: UpdateDocumentDatabaseValueInput }
const readRequest = () => ({ target: '', calls: [] as string[], catalogInputs: [] as DocumentCatalogPageInput[],
  home: deferred<HomeData>(), documents: deferred<DocumentCatalogPage>(), databases: deferred<DocumentDatabase[]>(),
  columns: deferred<DocumentDatabaseColumn[]>(), entities: deferred<DatabaseEntity[]>(), views: deferred<DatabaseSavedView[]>() })
type Read = ReturnType<typeof readRequest>
type ReadMetadata = Partial<Pick<Model, 'home' | 'databases' | 'views' | 'documents'>>
type RecordId = 'target' | 'other'
type QueuedUpdate = { key: keyof Model; apply: (previous: Model) => Model }

function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) {
    appNotifications.dismiss(id)
  }
  appNotifications.clearCompleted()
}

async function withPage(locale: UiLanguage, run: (context: {
  document: Document; window: JSDOM['window']; writes: Write[]; reads: Read[];
  model: () => Model; disk: () => DocumentCatalogEntry[]; input: (id?: RecordId) => HTMLInputElement;
  fill: (raw: string, id?: RecordId) => Promise<void>; enter: (id?: RecordId) => Promise<void>; ack: (index?: number) => Promise<void>;
  failWrite: (index: number) => Promise<void>; key: (key: string, id?: RecordId) => Promise<void>;
  settleRead: (index: number, reason?: unknown, metadata?: ReadMetadata) => Promise<void>; externalWrite: (raw: string) => void;
  refreshButton: () => HTMLButtonElement; navigate: (id: string) => Promise<void>;
  hold: (keys: (keyof Model)[]) => void; flush: (keys?: (keyof Model)[]) => Promise<void>;
  release: (keys: (keyof Model)[]) => void; publishNow: (keys: (keyof Model)[]) => void;
  pulse: () => Promise<void>; patch: (value: Partial<Model>) => Promise<void>;
  replaceCache: () => Promise<() => Promise<void>>; move: (top: number) => Promise<void>
}) => Promise<void>, options: { virtual?: boolean } = {}) {
  clearNotifications()
  const oldLanguage = getActiveUiText().language
  setActiveUiLanguage(locale)
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const nativeWarn = console.warn
  console.warn = () => {}
  const seedDocuments = [...initialDocuments(), ...Array.from({ length: options.virtual ? 40 : 0 }, (_, index): DocumentCatalogEntry => ({
    id: `virtual-${index}`, title: `Virtual row ${index}`, path: `Parent/Virtual row ${index}`,
    parentId: 'parent', parentTitle: 'Parent', summary: `Preserved virtual row ${index}`,
    updatedAt: '2026-10-01T00:00:00.000Z', blockCount: 1, childCount: 0, linkCount: 0,
    fieldValues: { notes: `Virtual notes ${index}`, hidden: `Hidden virtual metadata ${index}` }
  }))]
  const fixtureHome: HomeData = { ...structuredClone(home), summary: { ...home.summary,
    documents: seedDocuments.length, blocks: seedDocuments.reduce((total, item) => total + item.blockCount, 0),
    links: seedDocuments.reduce((total, item) => total + item.linkCount, 0) },
    documentCatalog: seedDocuments.map(({ id, title, path, parentId, updatedAt }) => ({ id, title, path, parentId, updatedAt })) }
  if (options.virtual) {
    // Provide only the table's actual measured viewport/row extent. The real
    // Table still computes its visible slice, removes Editors, and remounts them.
    const nativeRect = dom.window.HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true,
      get() { return (this as HTMLElement).classList.contains('dbw-table-scroll') ? 200 : 0 } })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true,
      get() {
        const node = this as HTMLElement
        if (!node.classList.contains('dbw-table-scroll')) return 0
        const spacers = [...node.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')]
          .reduce((height, cell) => height + (Number.parseFloat(cell.style.height) || 0), 0)
        return 42 + node.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length * 64 + spacers
      } })
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.tagName === 'THEAD' ? new dom.window.DOMRect(0, 0, 600, 42) : nativeRect.call(this)
    }
  }
  let disk = structuredClone(seedDocuments), current!: Model, updateModel!: (value: SetStateAction<Model>) => void
  const held = new Set<keyof Model>(), synchronous = new Set<keyof Model>(), queued: QueuedUpdate[] = []
  // This is the Domain's ordinary persistent cache ref, never seeded or mutated
  // by the fixture. All entries arise from actual Editor events and API replies.
  const cacheRef = { current: new DatabaseTextDraftCache() }
  const writes: Write[] = [], reads: Read[] = []
  const latestRead = (channel: string) => {
    const request = reads.at(-1); assert.ok(request)
    request.calls.push(channel)
    return request
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDocumentDatabaseValue: (input: UpdateDocumentDatabaseValueInput) => {
      const request = { ...deferred<void>(), input: structuredClone(input) }
      writes.push(request)
      return request.promise
    },
    getHomeData: () => { const request = readRequest(); reads.push(request); request.calls.push('home'); return request.home.promise },
    getDocumentCatalogPage: (input: DocumentCatalogPageInput) => {
      const request = latestRead('documents'); request.catalogInputs.push(structuredClone(input)); return request.documents.promise
    },
    getDatabases: () => latestRead('databases').databases.promise,
    getDocumentDatabaseColumns: (id: string) => { const request = latestRead('columns'); request.target = id; return request.columns.promise },
    getDatabaseEntities: (id: string) => { assert.ok(sources.some(source => source.id === id)); return latestRead('entities').entities.promise },
    getDatabaseSavedViews: (id: string) => { assert.ok(sources.some(source => source.id === id)); return latestRead('views').views.promise },
    onPluginNotification: () => () => {}, onBackupHealth: () => () => {},
    getBackupHealth: async () => ({ revision: 0, error: null })
  } })
  function Harness() {
    const [model, setModel] = useState<Model>(() => ({ source: 'catalog', shown: true, documents: structuredClone(seedDocuments),
      catalogColumns: structuredClone(columns), databases: structuredClone(sources), selectedColumns: structuredClone(columns),
      entities: [], views: structuredClone(savedViews), activeView: 'catalog-table', home: structuredClone(fixtureHome) }))
    current = model; updateModel = setModel
    const change = <K extends keyof Model>(key: K, value: SetStateAction<Model[K]>) => {
      // Store the actual Page functional updater without evaluating it. A later
      // React commit invokes its real guard; merely resolving GET cannot apply it.
      const apply = (previous: Model): Model => ({ ...previous,
        [key]: typeof value === 'function' ? (value as (previous: Model[K]) => Model[K])(previous[key]) : value })
      if (held.has(key)) queued.push({ key, apply })
      else if (synchronous.has(key)) flushSync(() => setModel(apply))
      else setModel(apply)
    }
    const database = { databaseReady: true, databaseLoading: false, databaseError: null,
      databaseEntityDatabaseId: model.source, databases: model.databases, selectedDatabaseColumns: model.selectedColumns,
      databaseEntities: model.entities, databaseSavedViews: model.views, activeDatabaseSavedViewId: model.activeView,
      selectedDatabaseEntityIds: [],
      setDatabases: (value: SetStateAction<DocumentDatabase[]>) => change('databases', value),
      setSelectedDatabaseColumns: (value: SetStateAction<DocumentDatabaseColumn[]>) => change('selectedColumns', value),
      setDatabaseEntities: (value: SetStateAction<DatabaseEntity[]>) => change('entities', value),
      setDatabaseSavedViews: (value: SetStateAction<DatabaseSavedView[]>) => change('views', value),
      setActiveDatabaseSavedViewId: (value: SetStateAction<string>) => change('activeView', value),
      setDatabaseEntityDatabaseId: (value: string) => setModel(previous => ({ ...previous, source: value,
        entities: [], selectedColumns: structuredClone(columns),
        views: value === 'catalog' ? structuredClone(savedViews) : [], activeView: value === 'catalog' ? 'catalog-table' : '' })),
      databaseTextDraftCache: cacheRef,
      setSelectedDatabaseEntityIds: () => {}, acknowledgeWorkspaceRead: () => {},
      reloadDatabaseDomain: () => {} } as unknown as DatabaseDomainState
    return createElement(Fragment, null, model.shown ? createElement(DatabasePage, { database,
      catalogColumns: model.catalogColumns, catalogDocuments: model.documents, catalogLoading: false,
      catalogReady: true, catalogError: null, onRetryCatalog: () => {}, documentCatalog: model.documents,
      onCatalogColumnsChange: value => change('catalogColumns', value), onCatalogDocumentsChange: value => change('documents', value),
      onHomeDataChange: value => change('home', value), onMessage: notify, onOpenDocument: () => {},
      selectedDocumentId: null, workspaceBoard: {} as DatabaseWorkspaceBoardState, ui: getUiText(locale) }) : null,
    createElement(AppNotificationHost, { isZh: locale === 'zh-CN', onOpenDocument: () => {} }))
  }
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const input = (id: RecordId = 'target') => {
    const row = [...dom.window.document.querySelectorAll('.dbw-table tbody tr')]
      .find(node => node.querySelector('.dbw-record-title strong')?.textContent === (id === 'target' ? 'Target' : 'Other'))
    const element = row?.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
    assert.ok(element); return element
  }
  const settleRead = async (index: number, reason?: unknown, metadata: ReadMetadata = {}) => {
    const request = reads[index]; assert.ok(request)
    await act(async () => {
      request.home.resolve(structuredClone(metadata.home ?? fixtureHome))
      const readDocuments = metadata.documents ?? disk
      if (reason === undefined) request.documents.resolve({ entries: structuredClone(readDocuments), total: readDocuments.length, nextOffset: null })
      else request.documents.reject(reason)
      request.databases.resolve(structuredClone(metadata.databases ?? sources)); request.columns.resolve(structuredClone(columns))
      request.entities.resolve([]); request.views.resolve(request.target === 'catalog'
        ? structuredClone(metadata.views ?? savedViews) : [])
    })
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, window: dom.window, writes, reads, input,
      model: () => structuredClone(current), disk: () => structuredClone(disk), settleRead,
      fill: async (raw, id) => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(id), raw)
        input(id).dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      enter: async id => { await act(async () => input(id).dispatchEvent(new dom.window.KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }))) },
      key: async (key, id) => { await act(async () => input(id).dispatchEvent(new dom.window.KeyboardEvent('keydown',
        { key, bubbles: true, cancelable: true }))) },
      ack: async (index = 0) => {
        const request = writes[index]; assert.ok(request)
        disk = disk.map(entry => entry.id === request.input.documentId
          ? { ...entry, fieldValues: { ...entry.fieldValues, [request.input.columnId]: request.input.value } } : entry)
        await act(async () => request.resolve())
      },
      failWrite: async index => { const request = writes[index]; assert.ok(request)
        await act(async () => request.reject(new Error('Isolated second write rejected'))) },
      // An independent service update reaches React only through Page's full GET.
      externalWrite: raw => { disk = disk.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: raw } } : entry) },
      refreshButton: () => {
        const button = dom.window.document.querySelector<HTMLButtonElement>('.dbw-header .dbw-refresh-button')
        assert.ok(button); assert.equal(button.getAttribute('aria-label'), locale === 'zh-CN' ? '刷新数据库' : 'Refresh database')
        return button
      },
      hold: keys => { keys.forEach(key => held.add(key)) },
      release: keys => { keys.forEach(key => held.delete(key)) },
      // Exercise both legal parent commit timings without touching Page/cache:
      // some real parent setters may commit before the read promise returns.
      publishNow: keys => { keys.forEach(key => synchronous.add(key)) },
      flush: async keys => {
        const selected = keys ? new Set(keys) : new Set(held)
        selected.forEach(key => held.delete(key))
        const updates = queued.filter(item => selected.has(item.key))
        for (let index = queued.length - 1; index >= 0; index--) if (selected.has(queued[index].key)) queued.splice(index, 1)
        await act(async () => { updates.forEach(item => updateModel(item.apply)) })
      },
      pulse: async () => { await act(async () => updateModel(previous => ({ ...previous }))) },
      patch: async value => { await act(async () => updateModel(previous => ({ ...previous, ...structuredClone(value) }))) },
      replaceCache: async () => {
        const previous = cacheRef.current
        cacheRef.current = new DatabaseTextDraftCache()
        await act(async () => updateModel(model => ({ ...model })))
        return async () => { cacheRef.current = previous; await act(async () => updateModel(model => ({ ...model }))) }
      },
      move: async top => {
        const scroll = dom.window.document.querySelector<HTMLDivElement>('.dbw-table-scroll'); assert.ok(scroll)
        await act(async () => { scroll.scrollTop = top; scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })) })
      },
      navigate: async id => {
        const trigger = dom.window.document.querySelector<HTMLButtonElement>('.dbw-source-trigger'); assert.ok(trigger)
        await act(async () => trigger.click())
        const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-source-option')]
          .find(node => node.querySelector('strong')?.textContent === (id === 'catalog' ? getDatabaseWorkspaceText(locale).allDocuments : 'Other source'))
        assert.ok(button); await act(async () => button.click())
        assert.equal(current.source, id)
      }
    })
  } finally {
    await act(async () => root.unmount())
    await act(async () => {
      writes.forEach(request => request.resolve())
      reads.forEach(request => { request.home.resolve(fixtureHome); request.documents.resolve({ entries: disk, total: disk.length, nextOffset: null })
        request.databases.resolve(sources); request.columns.resolve(columns); request.entities.resolve([]); request.views.resolve(savedViews) })
    })
    clearNotifications(); console.warn = nativeWarn; setActiveUiLanguage(oldLanguage)
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

// The older automatic request remains physically unresolved until a newer
// Header request has published all of its actual Page model data.
for (const { locale, freshValue } of [{ locale: 'en-US', freshValue: 'Beta' },
  { locale: 'zh-CN', freshValue: 'External canonical C' }] as const) {
  test(`a newer committed Header read replaces a physically pending cell read without Escape resurrecting it (${locale})`, async () => {
    await withPage(locale, async context => {
      const before = context.model(), original = context.disk(), field = context.input()
      const expected = (value: string) => original.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: value } } : entry)
      const feedbackCount = () => field.closest('.dbw-text-cell-editor')!.querySelectorAll('.dbw-text-cell-feedback').length
      const actionCount = () => field.closest('.dbw-text-cell-editor')!.querySelectorAll('button').length
      await act(async () => field.focus())
      await context.fill('  Beta  ')
      await context.enter()
      assert.equal(context.writes.length, 1)
      assert.deepEqual(context.writes[0].input, { documentId: 'target', columnId: 'notes', value: 'Beta' })
      assert.deepEqual(context.disk(), original)
      assert.equal(field.readOnly, true)
      await context.ack()
      assert.deepEqual(context.disk(), expected('Beta'))
      assert.deepEqual(context.model(), before)
      assert.equal(context.reads.length, 1)
      assert.equal(context.input() === field, true)
      assert.equal(field.value, 'Beta')
      assert.equal(field.readOnly, false)
      assert.equal(feedbackCount(), 1)
      assert.equal(actionCount(), 1)
      await act(async () => { field.focus(); field.setSelectionRange(1, 3) })
      await act(async () => context.refreshButton().click())
      assert.equal(context.reads.length, 2)
      if (freshValue !== 'Beta') context.externalWrite(freshValue)
      await context.settleRead(1)
      // Request 0 was never released: these props were published by the newer
      // real Page GET, not by returning a fabricated cache confirmation.
      assert.deepEqual(context.disk(), expected(freshValue))
      assert.deepEqual(context.model(), { ...before, documents: expected(freshValue) })
      for (const request of context.reads) {
        assert.equal(request.target, 'catalog')
        assert.deepEqual(request.calls.slice().sort(), ['columns', 'databases', 'documents', 'entities', 'home', 'views'])
        assert.deepEqual(request.catalogInputs, [{ databaseId: null, limit: 1000, offset: 0 }])
      }
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.equal(field.readOnly, false)
      assert.equal(context.writes.length, 1)
      assert.equal(appNotifications.getSnapshot().length, 0)
      assert.equal(field.value, freshValue, 'a newer committed read cannot remain hidden under an older pending overlay')
      assert.equal(feedbackCount(), 0, 'the older physical GET must not keep a stale Refreshing status after publication')
      assert.equal(actionCount(), 0)
      await context.key('Escape')
      assert.equal(field.value, freshValue)
      assert.equal(feedbackCount(), 0)
      assert.equal(actionCount(), 0)
      assert.equal(context.document.activeElement === field, false, 'Escape preserves the editor\'s existing blur behavior')
      // Its later rejection is obsolete and cannot resurrect feedback, acquire
      // focus, rewrite a value, or announce a failure for the new authority.
      await act(async () => { field.focus(); field.setSelectionRange(1, 3) })
      await context.settleRead(0, new Error('Superseded physical automatic GET rejected'))
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 3])
      assert.equal(field.value, freshValue)
      assert.equal(field.readOnly, false)
      assert.equal(feedbackCount(), 0)
      assert.equal(actionCount(), 0)
      assert.deepEqual(context.model(), { ...before, documents: expected(freshValue) })
      assert.deepEqual(context.disk(), expected(freshValue))
      assert.equal(context.writes.length, 1)
      assert.equal(context.reads.length, 2)
      assert.equal(appNotifications.getSnapshot().length, 0)
    })
  })
}

type PageContext = Parameters<Parameters<typeof withPage>[1]>[0]
const publicationKeys: (keyof Model)[] = ['documents', 'catalogColumns']
const textRoot = (context: PageContext) => context.input().closest('.dbw-text-cell-editor')!
const feedback = (context: PageContext) => textRoot(context).querySelector('.dbw-text-cell-feedback')?.textContent ?? ''
const feedbackCount = (context: PageContext) => textRoot(context).querySelectorAll('.dbw-text-cell-feedback').length
const actionCount = (context: PageContext) => textRoot(context).querySelectorAll('button').length
const withNotes = (documents: DocumentCatalogEntry[], value: string) => documents.map(entry => entry.id === 'target'
  ? { ...entry, fieldValues: { ...entry.fieldValues, notes: value } } : entry)
async function pendingAutomaticRead(context: PageContext) {
  const before = context.model(), original = context.disk(), field = context.input()
  await act(async () => field.focus())
  await context.fill('  Beta  ')
  await context.enter()
  assert.deepEqual(context.writes.map(request => request.input), [{ documentId: 'target', columnId: 'notes', value: 'Beta' }])
  assert.deepEqual(context.disk(), original)
  assert.equal(field.readOnly, true)
  await context.ack()
  assert.deepEqual(context.disk(), withNotes(original, 'Beta'))
  assert.deepEqual(context.model(), before)
  assert.equal(context.reads.length, 1)
  assert.equal(field.value, 'Beta')
  assert.equal(field.readOnly, false)
  assert.equal(feedback(context), getDatabaseWorkspaceText(getActiveUiText().language).cellRefreshing)
  assert.equal(actionCount(context), 1)
  await act(async () => field.focus())
  return { before, original, field, oldResponse: context.disk() }
}

test('a newer failed Header read or incomplete records and schema publication cannot retire a physical pending cell read', async () => {
  for (const result of ['failed', 'held-publication'] as const) {
    await withPage('en-US', async context => {
      const { before, original, field, oldResponse } = await pendingAutomaticRead(context)
      const text = getDatabaseWorkspaceText('en-US')
      if (result === 'held-publication') context.hold(publicationKeys)
      await act(async () => context.refreshButton().click())
      context.externalWrite('Fresh Header C')
      await context.settleRead(1, result === 'failed' ? new Error('New Header GET failed before publication') : undefined)
      assert.deepEqual(context.disk(), withNotes(original, 'Fresh Header C'))
      assert.deepEqual(context.model(), before)
      assert.equal(field.value, 'Beta')
      assert.equal(field.readOnly, false)
      assert.equal(feedback(context), text.cellRefreshing)
      assert.equal(actionCount(context), 1)
      await context.pulse()
      assert.equal(feedback(context), text.cellRefreshing)
      assert.equal(actionCount(context), 1)
      if (result === 'failed') {
        assert.equal(appNotifications.getSnapshot().length, 1)
        assert.equal(appNotifications.getSnapshot()[0].message, text.refreshFailed)
        await act(async () => context.refreshButton().click())
        await context.settleRead(2)
      } else {
        await context.flush(['documents'])
        assert.deepEqual(context.model().documents, context.disk())
        assert.equal(field.value, 'Beta', 'the actual schema updater is still outstanding')
        assert.equal(feedback(context), text.cellRefreshing)
        assert.equal(actionCount(context), 1)
        await context.flush(['catalogColumns'])
      }
      assert.deepEqual(context.model(), { ...before, documents: context.disk() })
      assert.equal(field.value, 'Fresh Header C')
      assert.equal(feedbackCount(context), 0)
      assert.equal(actionCount(context), 0)
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      // The first GET still physically exists, but its genuine stale response
      // cannot replace the newer fully committed Page model.
      await context.settleRead(0, undefined, { documents: oldResponse })
      assert.deepEqual(context.model(), { ...before, documents: context.disk() })
      assert.equal(field.value, 'Fresh Header C')
      assert.equal(feedbackCount(context), 0)
      assert.equal(actionCount(context), 0)
      assert.equal(context.writes.length, 1)
      assert.equal(context.reads.length, result === 'failed' ? 3 : 2)
      assert.equal(appNotifications.getSnapshot().length, result === 'failed' ? 1 : 0)
    })
  }
})

test('new dirty, failed, and accepted writing owners survive Header confirmation and the older physical read terminal', async () => {
  for (const intent of ['dirty', 'failed', 'writing'] as const) {
    await withPage('zh-CN', async context => {
      const { before, original, field, oldResponse } = await pendingAutomaticRead(context)
      const text = getDatabaseWorkspaceText('zh-CN'), raw = '  New owner D  '
      await act(async () => context.refreshButton().click())
      await context.fill(raw)
      if (intent !== 'dirty') await context.enter()
      if (intent === 'failed') await context.failWrite(1)
      await act(async () => { field.focus(); field.setSelectionRange(2, 7) })
      context.externalWrite('Authoritative Header C')
      await context.settleRead(1)
      assert.deepEqual(context.model(), { ...before, documents: withNotes(original, 'Authoritative Header C') })
      assert.deepEqual(context.disk(), withNotes(original, 'Authoritative Header C'))
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.deepEqual([field.selectionStart, field.selectionEnd], [2, 7])
      assert.equal(field.value, raw)
      assert.equal(field.readOnly, intent === 'writing')
      assert.equal(feedback(context), intent === 'failed' ? text.formFailed : intent === 'writing' ? text.saving : '')
      assert.equal(actionCount(context), intent === 'failed' ? 1 : 0)
      await context.settleRead(0, undefined, { documents: oldResponse })
      assert.equal(field.value, raw)
      assert.equal(field.readOnly, intent === 'writing', 'an old read cannot unlock a newer accepted write')
      assert.equal(context.document.activeElement === field, true)
      assert.deepEqual([field.selectionStart, field.selectionEnd], [2, 7])
      assert.equal(feedback(context), intent === 'failed' ? text.formFailed : intent === 'writing' ? text.saving : '')
      assert.equal(actionCount(context), intent === 'failed' ? 1 : 0)
      assert.deepEqual(context.model(), { ...before, documents: context.disk() })
      if (intent === 'dirty') {
        await context.key('Escape')
        assert.equal(field.value, 'Authoritative Header C')
        assert.equal(feedbackCount(context), 0)
        assert.equal(actionCount(context), 0)
        assert.equal(context.writes.length, 1)
        assert.equal(context.reads.length, 2)
      } else {
        if (intent === 'failed') {
          const retry = textRoot(context).querySelector<HTMLButtonElement>('button')!
          assert.equal(retry.textContent, text.retry)
          await act(async () => { retry.click(); retry.click() })
          assert.equal(context.writes.length, 3, 'explicit Retry is single-flight and submits the unchanged raw once')
        } else {
          await context.key('Escape')
          assert.equal(field.value, raw)
          assert.equal(field.readOnly, true)
          assert.equal(context.writes.length, 2)
        }
        const acceptedIndex = intent === 'failed' ? 2 : 1
        await context.ack(acceptedIndex)
        assert.equal(context.reads.length, 3)
        assert.equal(field.readOnly, false)
        assert.equal(field.value, 'New owner D')
        await context.settleRead(2)
        assert.deepEqual(context.disk(), withNotes(original, 'New owner D'))
        assert.deepEqual(context.model(), { ...before, documents: context.disk() })
        assert.equal(field.value, 'New owner D')
        assert.equal(feedbackCount(context), 0)
        assert.equal(actionCount(context), 0)
      }
      assert.equal(appNotifications.getSnapshot().length, intent === 'failed' ? 1 : 0)
      if (intent === 'failed') assert.equal(appNotifications.getSnapshot()[0].message, text.formFailed)
    })
  }
})

test('editing and Escape after clearing a pending-read entry cannot revive its late success or failure', async () => {
  for (const rejected of [false, true]) {
    await withPage('en-US', async context => {
      const { before, original, field, oldResponse } = await pendingAutomaticRead(context)
      await act(async () => context.refreshButton().click())
      context.externalWrite('Committed Header C')
      await context.settleRead(1)
      assert.equal(field.value, 'Committed Header C')
      assert.equal(feedbackCount(context), 0)
      assert.equal(actionCount(context), 0)
      // These are actual browser input events. No cache entry or focus snapshot
      // is fabricated to make the post-publication Escape path pass.
      await act(async () => { field.blur(); field.focus(); field.setSelectionRange(0, 2) })
      await context.fill('  Post-confirmation edit D  ')
      await context.key('Escape')
      assert.equal(context.document.activeElement === field, false)
      assert.equal(field.value, 'Committed Header C')
      assert.equal(field.readOnly, false)
      assert.equal(feedbackCount(context), 0)
      assert.equal(actionCount(context), 0)
      await act(async () => { field.focus(); field.setSelectionRange(1, 5) })
      await context.settleRead(0, rejected ? new Error('Obsolete physical GET rejected after new intent') : undefined,
        { documents: oldResponse })
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 5])
      assert.equal(field.value, 'Committed Header C')
      assert.equal(field.readOnly, false)
      assert.equal(feedbackCount(context), 0)
      assert.equal(actionCount(context), 0)
      assert.deepEqual(context.disk(), withNotes(original, 'Committed Header C'))
      assert.deepEqual(context.model(), { ...before, documents: context.disk() })
      assert.equal(context.writes.length, 1)
      assert.equal(context.reads.length, 2)
      assert.equal(appNotifications.getSnapshot().length, 0)
    })
  }
})

test('physical cell reads remain serial while new writes replace queued read owners without losing their locks', async () => {
  await withPage('zh-CN', async context => {
    const { before, original, field, oldResponse } = await pendingAutomaticRead(context)
    await act(async () => context.refreshButton().click())
    context.externalWrite('Committed Header C')
    await context.settleRead(1)
    assert.equal(field.value, 'Committed Header C')
    assert.equal(feedbackCount(context), 0)
    assert.equal(actionCount(context), 0)
    await context.fill('  Queued read D  ')
    await context.enter()
    assert.equal(context.writes.length, 2)
    assert.equal(field.readOnly, true)
    await context.ack(1)
    assert.deepEqual(context.disk(), withNotes(original, 'Queued read D'))
    assert.equal(field.value, 'Queued read D')
    assert.equal(field.readOnly, false)
    assert.equal(feedback(context), getDatabaseWorkspaceText('zh-CN').cellRefreshing)
    assert.equal(context.reads.length, 2, 'the new cell read waits for its old physical flight, while the Header read was independent')
    await act(async () => field.focus())
    await context.fill('  Latest write E  ')
    await context.enter()
    assert.equal(context.writes.length, 3)
    assert.equal(field.readOnly, true)
    await act(async () => { field.focus(); field.setSelectionRange(2, 8) })
    await context.settleRead(0, undefined, { documents: oldResponse })
    assert.equal(context.reads.length, 2, 'the revoked D read must not dispatch after the older physical flight finishes')
    assert.equal(field.value, '  Latest write E  ')
    assert.equal(field.readOnly, true)
    assert.equal(context.document.activeElement === field, true)
    assert.deepEqual([field.selectionStart, field.selectionEnd], [2, 8])
    assert.equal(feedback(context), getDatabaseWorkspaceText('zh-CN').saving)
    assert.deepEqual(context.model(), { ...before, documents: withNotes(original, 'Committed Header C') })
    await context.ack(2)
    assert.equal(context.reads.length, 3, 'only the latest accepted E read dispatches')
    assert.equal(field.value, 'Latest write E')
    assert.equal(field.readOnly, false)
    await context.settleRead(2)
    assert.deepEqual(context.writes.map(request => request.input), ['Beta', 'Queued read D', 'Latest write E']
      .map(value => ({ documentId: 'target', columnId: 'notes', value })))
    assert.deepEqual(context.disk(), withNotes(original, 'Latest write E'))
    assert.deepEqual(context.model(), { ...before, documents: context.disk() })
    assert.equal(context.input() === field, true)
    assert.equal(field.value, 'Latest write E')
    assert.equal(field.readOnly, false)
    assert.equal(feedbackCount(context), 0)
    assert.equal(actionCount(context), 0)
    assert.equal(context.writes.length, 3)
    assert.equal(context.reads.length, 3)
    assert.equal(appNotifications.getSnapshot().length, 0)
  })
})
