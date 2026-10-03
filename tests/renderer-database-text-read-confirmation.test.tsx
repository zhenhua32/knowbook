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
  settleRead: (index: number, reason?: unknown) => Promise<void>; externalWrite: (raw: string) => void;
  refreshButton: () => HTMLButtonElement; navigate: (id: string) => Promise<void>;
  hold: (keys: (keyof Model)[]) => void; flush: (keys?: (keyof Model)[]) => Promise<void>;
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
  const held = new Set<keyof Model>(), queued: QueuedUpdate[] = []
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
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const input = (id: RecordId = 'target') => {
    const row = [...dom.window.document.querySelectorAll('.dbw-table tbody tr')]
      .find(node => node.querySelector('.dbw-record-title strong')?.textContent === (id === 'target' ? 'Target' : 'Other'))
    const element = row?.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
    assert.ok(element); return element
  }
  const settleRead = async (index: number, reason?: unknown) => {
    const request = reads[index]; assert.ok(request)
    await act(async () => {
      request.home.resolve(structuredClone(fixtureHome))
      if (reason === undefined) request.documents.resolve({ entries: structuredClone(disk), total: disk.length, nextOffset: null })
      else request.documents.reject(reason)
      request.databases.resolve(structuredClone(sources)); request.columns.resolve(structuredClone(columns))
      request.entities.resolve([]); request.views.resolve(request.target === 'catalog' ? structuredClone(savedViews) : [])
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

for (const { locale, freshValue } of [{ locale: 'en-US', freshValue: 'Beta' },
  { locale: 'zh-CN', freshValue: 'External canonical C' }] as const) {
  test(`actual Page Header confirms a catalog text read at the same document revision (${locale}, ${freshValue})`, async () => {
    await withPage(locale, async ({ document, writes, reads, input, fill, enter, ack, settleRead,
      disk, model, externalWrite, refreshButton, key }) => {
      const before = model(), original = disk(), field = input(), text = getDatabaseWorkspaceText(locale)
      await act(async () => field.focus())
      await fill('  Beta  ')
      await enter()
      assert.equal(writes.length, 1)
      assert.deepEqual(writes[0].input, { documentId: 'target', columnId: 'notes', value: 'Beta' })
      assert.deepEqual(disk(), original, 'a held write has not changed canonical data')
      assert.equal(field.readOnly, true)
      await ack()
      const expected = (value: string) => original.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: value } } : entry)
      assert.deepEqual(disk(), expected('Beta'), 'catalog ACK changes only the property, not document.updatedAt')
      assert.equal(reads.length, 1)
      await settleRead(0, new Error('Actual catalog read failed after the durable property ACK'))
      assert.deepEqual(model(), before, 'a rejected Page refresh has not published partial metadata')
      assert.equal(input() === field, true)
      assert.equal(field.value, 'Beta')
      assert.equal(field.readOnly, false)
      const editor = field.closest('.dbw-text-cell-editor')!
      assert.equal(editor.querySelector('.dbw-text-cell-feedback')?.textContent, text.savedRefreshFailed)
      assert.equal(editor.querySelector('button')?.textContent, text.refresh)
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(document.querySelector('.app-notification-message')?.textContent, text.savedRefreshFailed)
      await act(async () => { field.focus(); field.setSelectionRange(1, 3) })
      if (freshValue !== 'Beta') externalWrite(freshValue)
      await act(async () => { refreshButton().click(); refreshButton().click() })
      assert.equal(reads.length, 2, 'Header activation starts one new full Page read')
      assert.equal(writes.length, 1)
      assert.equal(reads[1].target, 'catalog')
      assert.deepEqual(reads[1].calls, ['home', 'documents', 'databases', 'columns', 'entities', 'views'])
      assert.deepEqual(reads[1].catalogInputs, [{ databaseId: null, limit: 1000, offset: 0 }])
      await settleRead(1)
      assert.deepEqual(model(), { ...before, documents: expected(freshValue) }, 'actual Page state receives the complete authoritative read')
      assert.deepEqual(disk(), expected(freshValue))
      assert.equal(input() === field, true)
      assert.equal(document.activeElement === field, true, 'pure reading does not move focus')
      assert.equal(writes.length, 1, 'read confirmation never repeats the acknowledged write')
      assert.equal(reads.length, 2)
      assert.equal(appNotifications.getSnapshot().length, 1, 'successful reading emits no duplicate notification')
      assert.equal(editor.querySelectorAll('.dbw-text-cell-feedback').length, 0,
        'a successfully published Header read must remove the obsolete cell refresh error even at the same revision')
      assert.equal(editor.querySelectorAll('button').length, 0, 'the obsolete cell Refresh action has been satisfied by the actual read')
      assert.equal(field.value, freshValue, 'a fresh external value is authoritative despite an unchanged document timestamp')
      await key('Escape')
      assert.equal(field.value, freshValue, 'Escape cannot revive the pre-read overlay from an old focus snapshot')
      assert.equal(editor.querySelectorAll('.dbw-text-cell-feedback').length, 0)
      assert.equal(editor.querySelectorAll('button').length, 0)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 2)
    })
  })
}

type PageContext = Parameters<Parameters<typeof withPage>[1]>[0]
const publicationKeys: (keyof Model)[] = ['documents', 'catalogColumns']
const feedback = (context: PageContext, id: RecordId = 'target') =>
  context.input(id).closest('.dbw-text-cell-editor')?.querySelector('.dbw-text-cell-feedback')?.textContent ?? ''
const actionCount = (context: PageContext, id: RecordId = 'target') =>
  context.input(id).closest('.dbw-text-cell-editor')?.querySelectorAll('button').length ?? 0

async function savedReadFailure(context: PageContext, value = 'Beta', id: RecordId = 'target') {
  const writeIndex = context.writes.length, readIndex = context.reads.length
  await act(async () => context.input(id).focus())
  await context.fill(value, id)
  await context.enter(id)
  assert.equal(context.writes.length, writeIndex + 1)
  assert.deepEqual(context.writes[writeIndex].input, { documentId: id, columnId: 'notes', value: value.trim() })
  await context.ack(writeIndex)
  assert.equal(context.reads.length, readIndex + 1)
  await context.settleRead(readIndex, new Error('Isolated automatic read failed after ACK'))
  assert.equal(context.input(id).value, value.trim())
  assert.equal(context.input(id).readOnly, false)
  assert.equal(feedback(context, id), getDatabaseWorkspaceText(getActiveUiText().language).savedRefreshFailed)
  assert.equal(actionCount(context, id), 1)
}

test('a GET result and Page pulse cannot confirm text feedback before both catalog records and schema actually commit', async () => {
  await withPage('en-US', async context => {
    await savedReadFailure(context)
    const before = context.model(), field = context.input(), text = getDatabaseWorkspaceText('en-US')
    await act(async () => { field.focus(); field.setSelectionRange(0, 2) })
    context.hold(publicationKeys)
    await act(async () => context.refreshButton().click())
    await context.settleRead(1)
    assert.deepEqual(context.model().documents, before.documents)
    assert.equal(feedback(context), text.savedRefreshFailed, 'resolved GET has not published the held functional updater')
    await context.pulse()
    assert.equal(feedback(context), text.savedRefreshFailed, 'an unrelated React commit is not a read acknowledgement')
    await context.flush(['documents'])
    assert.deepEqual(context.model().documents, context.disk())
    assert.equal(feedback(context), text.savedRefreshFailed, 'records alone cannot acknowledge an uncommitted schema')
    await context.pulse()
    assert.equal(actionCount(context), 1)
    await context.flush(['catalogColumns'])
    assert.equal(feedback(context), '')
    assert.equal(actionCount(context), 0)
    assert.equal(context.input() === field, true)
    assert.equal(context.document.activeElement === field, true)
    assert.deepEqual([field.selectionStart, field.selectionEnd], [0, 2])
    assert.equal(context.writes.length, 1)
    assert.equal(context.reads.length, 2)
    assert.deepEqual(context.model(), { ...before, documents: context.disk() })
  })
})

test('a newer Page read permanently supersedes an older queued confirmation even when the newer read fails', async () => {
  await withPage('en-US', async context => {
    await savedReadFailure(context)
    context.hold(publicationKeys)
    await act(async () => context.refreshButton().click())
    await context.settleRead(1)
    assert.equal(actionCount(context), 1)
    await act(async () => context.refreshButton().click())
    assert.equal(context.reads.length, 3)
    await context.flush()
    assert.deepEqual(context.model().documents, context.disk(), 'old global updates may commit, but their confirmation is obsolete')
    assert.equal(actionCount(context), 1, 'a new pending GET invalidates the old publication descriptor')
    await context.settleRead(2, new Error('The newer full read failed'))
    await context.pulse()
    assert.equal(feedback(context), getDatabaseWorkspaceText('en-US').savedRefreshFailed)
    assert.equal(actionCount(context), 1)
    assert.equal(appNotifications.getSnapshot().length, 2)
    assert.equal(appNotifications.getSnapshot()[1].message, getDatabaseWorkspaceText('en-US').refreshFailed)
    await act(async () => context.refreshButton().click())
    await context.settleRead(3)
    assert.equal(feedback(context), '')
    assert.equal(actionCount(context), 0)
    assert.equal(context.writes.length, 1)
    assert.equal(context.reads.length, 4)
  })
})

test('source changes, ABA navigation, and Page unmount discard old successful or failed read confirmation without a late notification', async () => {
  for (const transition of ['source', 'aba', 'unmount'] as const) for (const rejected of [false, true]) {
    await withPage('zh-CN', async context => {
      await savedReadFailure(context)
      const before = context.model(), canonical = context.disk()
      await act(async () => context.refreshButton().click())
      if (transition === 'unmount') await context.patch({ shown: false })
      else {
        await context.navigate('other-source')
        if (transition === 'aba') await context.navigate('catalog')
      }
      await context.settleRead(1, rejected ? new Error('Old source read rejected') : undefined)
      if (transition === 'unmount') await context.patch({ shown: true })
      else if (transition === 'source') await context.navigate('catalog')
      assert.equal(context.model().source, 'catalog')
      assert.deepEqual(context.model().documents, before.documents)
      assert.deepEqual(context.disk(), canonical)
      assert.equal(context.input().value, 'Beta')
      assert.equal(feedback(context), getDatabaseWorkspaceText('zh-CN').savedRefreshFailed)
      assert.equal(actionCount(context), 1)
      assert.equal(appNotifications.getSnapshot().length, 1, 'late success and rejection are both silent')
      assert.equal(context.writes.length, 1)
      assert.equal(context.reads.length, 2)
    })
  }
})

test('Header publication confirms only captured settled cells while a new dirty, failed, or pending write retains its raw input and lock', async () => {
  for (const next of ['dirty', 'dirty-before', 'failed', 'pending'] as const) {
    await withPage('en-US', async context => {
      await savedReadFailure(context)
      await savedReadFailure(context, 'Other ACK', 'other')
      const canonical = context.disk(), text = getDatabaseWorkspaceText('en-US'), field = context.input()
      const dirty = next === 'dirty' || next === 'dirty-before'
      if (next === 'dirty-before') {
        await act(async () => field.focus())
        await context.fill('  New raw Gamma  ')
      }
      await act(async () => context.refreshButton().click())
      if (next !== 'dirty-before') {
        await act(async () => field.focus())
        await context.fill('  New raw Gamma  ')
      }
      if (dirty) context.externalWrite('External canonical C')
      if (!dirty) {
        await context.enter()
        assert.equal(context.writes.length, 3)
        if (next === 'failed') await context.failWrite(2)
      }
      await act(async () => { field.focus(); field.setSelectionRange(2, 7) })
      await context.settleRead(2)
      const published = dirty ? canonical.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: 'External canonical C' } } : entry) : canonical
      assert.deepEqual(context.disk(), published)
      assert.deepEqual(context.model().documents, published)
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.equal(field.value, '  New raw Gamma  ')
      assert.deepEqual([field.selectionStart, field.selectionEnd], [2, 7])
      assert.equal(field.readOnly, next === 'pending')
      assert.equal(feedback(context), next === 'failed' ? text.formFailed : next === 'pending' ? text.saving : '')
      assert.equal(actionCount(context), next === 'failed' ? 1 : 0)
      assert.equal(feedback(context, 'other'), '', 'the independently unchanged saved cell is confirmed')
      assert.equal(actionCount(context, 'other'), 0)
      assert.equal(context.writes.length, dirty ? 2 : 3)
      assert.equal(context.reads.length, 3)
      if (dirty) {
        await context.key('Escape')
        assert.equal(field.value, 'External canonical C', 'discarding a new edit returns to the successfully read authority, not the stale saved overlay')
        assert.equal(feedback(context), '')
        assert.equal(actionCount(context), 0)
        assert.equal(context.writes.length, 2)
        assert.equal(context.reads.length, 3)
      }
      if (next === 'pending') {
        await context.key('Escape')
        assert.equal(field.value, '  New raw Gamma  ', 'Escape cannot roll back an accepted pending write')
        assert.equal(context.writes.length, 3, 'a GET or Escape does not release the actual write single-flight lock')
        assert.equal(field.readOnly, true)
        await context.ack(2)
        await context.settleRead(3, new Error('New owner automatic read failed'))
        assert.equal(field.value, 'New raw Gamma')
        assert.equal(feedback(context), text.savedRefreshFailed, 'the old confirmation cannot erase a newer saved-error owner')
        assert.equal(actionCount(context), 1)
      }
    })
  }
})

test('Escape copies before actual publication remain valid only until a successful read establishes a new same-revision authority', async () => {
  for (const result of ['Alpha', 'External C', 'rejected'] as const) {
    await withPage('en-US', async context => {
      await savedReadFailure(context)
      const original = initialDocuments(), field = context.input(), text = getDatabaseWorkspaceText('en-US')
      const expected = (value: string) => original.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: value } } : entry)
      await act(async () => field.focus())
      context.hold(publicationKeys)
      await act(async () => context.refreshButton().click())
      context.externalWrite(result === 'rejected' ? 'External C' : result)
      await context.settleRead(1, result === 'rejected' ? new Error('Full read rejected before publication') : undefined)
      await context.key('Escape')
      assert.equal(field.value, 'Beta', 'before real publication the saved overlay is still the current authority')
      assert.equal(feedback(context), text.savedRefreshFailed)
      assert.equal(actionCount(context), 1)
      assert.deepEqual(context.model().documents, original)
      assert.equal(context.writes.length, 1)
      await act(async () => { field.focus(); field.setSelectionRange(0, 2) })
      await context.flush()
      if (result === 'rejected') {
        await context.fill('Transient browsing edit')
        await context.key('Escape')
        assert.equal(field.value, 'Beta', 'a rejected read must not invalidate the saved overlay or its feedback')
        assert.equal(feedback(context), text.savedRefreshFailed)
        assert.equal(actionCount(context), 1)
        assert.deepEqual(context.model().documents, original)
        assert.deepEqual(context.disk(), expected('External C'))
        assert.equal(context.writes.length, 1)
        assert.equal(context.reads.length, 2)
        return
      }
      assert.deepEqual(context.disk(), expected(result))
      assert.deepEqual(context.model().documents, expected(result))
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.equal(field.value, result)
      assert.equal(feedback(context), '')
      assert.equal(actionCount(context), 0)
      await context.key('Escape')
      assert.equal(field.value, result, 'the copied pre-publication snapshot cannot restore obsolete Beta after the new authority commits')
      assert.equal(feedback(context), '')
      assert.equal(actionCount(context), 0)
      // Alpha equals the original observed props and has the very same revision.
      // It is nevertheless a fresh service value, so returning to old ACK Beta
      // is an intentional new write rather than a canonical no-op.
      await act(async () => field.focus())
      await context.fill('  Beta  ')
      await context.enter()
      assert.equal(context.writes.length, 2)
      assert.deepEqual(context.writes[1].input, { documentId: 'target', columnId: 'notes', value: 'Beta' })
      assert.equal(field.readOnly, true)
      assert.deepEqual(context.disk(), expected(result))
      assert.equal(context.reads.length, 2)
      await context.ack(1)
      await context.settleRead(2)
      assert.deepEqual(context.disk(), expected('Beta'))
      assert.deepEqual(context.model().documents, expected('Beta'))
      assert.equal(field.value, 'Beta')
      assert.equal(field.readOnly, false)
      assert.equal(feedback(context), '')
      assert.equal(actionCount(context), 0)
      assert.equal(context.writes.length, 2)
      assert.equal(context.reads.length, 3)
    })
  }
})

test('replacing the Domain cache invalidates a held Page confirmation without clearing either instance through the old result', async () => {
  await withPage('en-US', async context => {
    await savedReadFailure(context)
    context.hold(publicationKeys)
    await act(async () => context.refreshButton().click())
    await context.settleRead(1)
    const restore = await context.replaceCache()
    assert.equal(context.input().value, 'Alpha', 'the fresh cache starts from actual current props')
    const field = context.input()
    await act(async () => field.focus())
    await context.fill('  New cache draft  ')
    await context.flush()
    assert.equal(context.input() === field, true)
    assert.equal(context.input().value, '  New cache draft  ')
    assert.equal(context.document.activeElement === field, true)
    await restore()
    assert.equal(context.input().value, 'Beta')
    assert.equal(feedback(context), getDatabaseWorkspaceText('en-US').savedRefreshFailed,
      'the old instance was not acknowledged after the actual Domain ref changed')
    assert.equal(actionCount(context), 1)
    assert.equal(context.writes.length, 1)
    assert.equal(context.reads.length, 2)
    await act(async () => context.refreshButton().click())
    await context.settleRead(2)
    assert.equal(feedback(context), '')
    assert.equal(actionCount(context), 0)
  })
})

test('record removal or text-type replacement prunes the captured entry and an old Page result cannot clear a new same-ID failure', async () => {
  for (const replacement of ['record', 'field-type'] as const) {
    await withPage('zh-CN', async context => {
      await savedReadFailure(context)
      const before = context.model(), canonical = context.disk(), oldField = context.input()
      context.hold(publicationKeys)
      await act(async () => context.refreshButton().click())
      await context.settleRead(1)
      if (replacement === 'record') {
        await context.patch({ documents: before.documents.filter(entry => entry.id !== 'target') })
        await context.patch({ documents: before.documents })
      } else {
        await context.patch({ catalogColumns: columns.map(column => column.id === 'notes'
          ? { ...column, type: 'checkbox', options: [] } : column) })
        assert.equal(context.input().type, 'checkbox')
        assert.equal(feedback(context), '', 'the schema change removed the old text draft')
        await context.patch({ catalogColumns: columns })
      }
      const field = context.input()
      if (replacement === 'record') assert.equal(oldField.isConnected, false)
      assert.equal(field.value, 'Alpha')
      await act(async () => field.focus())
      await context.fill('  Same ID new failed draft  ')
      await context.enter()
      await context.failWrite(1)
      await act(async () => { field.focus(); field.setSelectionRange(2, 9) })
      await context.flush()
      assert.deepEqual(context.disk(), canonical)
      assert.deepEqual(context.model().documents, canonical)
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.equal(field.value, '  Same ID new failed draft  ')
      assert.deepEqual([field.selectionStart, field.selectionEnd], [2, 9])
      assert.equal(field.getAttribute('aria-invalid'), 'true')
      assert.equal(feedback(context), getDatabaseWorkspaceText('zh-CN').formFailed)
      assert.equal(actionCount(context), 1)
      assert.equal(context.writes.length, 2)
      assert.equal(context.reads.length, 2)
    })
  }
})

test('a virtual remount focus snapshot restores its unsaved draft after read confirmation without reviving the obsolete saved overlay', async () => {
  for (const rejected of [false, true]) {
    await withPage('en-US', async context => {
      const original = context.disk(), text = getDatabaseWorkspaceText('en-US')
      assert.equal(original.length, 42)
      await savedReadFailure(context)
      const fieldBeforeScroll = context.input()
      await act(async () => fieldBeforeScroll.focus())
      await context.fill('  Unsaved draft D  ')
      assert.equal(context.writes.length, 1)
      await context.move(2400)
      assert.equal(fieldBeforeScroll.isConnected, false, 'the actual Table has removed the old Editor from its virtual slice')
      await context.move(0)
      const field = context.input()
      assert.equal(field === fieldBeforeScroll, false)
      assert.equal(field.value, '  Unsaved draft D  ', 'Domain cache keeps raw input across the real row unmount')
      assert.equal(field.readOnly, false)
      await act(async () => field.focus())
      await context.fill('  Newer raw edit E  ')
      await act(async () => field.setSelectionRange(2, 8))
      await act(async () => context.refreshButton().click())
      context.externalWrite('Fresh canonical C')
      await context.settleRead(1, rejected ? new Error('Header read rejected after virtual remount') : undefined)
      const canonical = original.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: 'Fresh canonical C' } } : entry)
      assert.deepEqual(context.disk(), canonical)
      assert.deepEqual(context.model().documents, rejected ? original : canonical)
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.equal(field.value, '  Newer raw edit E  ')
      assert.deepEqual([field.selectionStart, field.selectionEnd], [2, 8])
      assert.equal(feedback(context), '')
      assert.equal(actionCount(context), 0)
      await context.key('Escape')
      assert.equal(field.value, '  Unsaved draft D  ',
        'Escape restores the genuinely unsaved focus snapshot, rather than deleting it together with its obsolete saved metadata')
      assert.equal(feedback(context), '')
      assert.equal(actionCount(context), 0)
      assert.equal(field.readOnly, false)
      assert.equal(context.writes.length, 1)
      assert.equal(context.reads.length, 2)
      await act(async () => field.focus())
      await context.fill('  Beta  ')
      await context.enter()
      if (rejected) {
        assert.equal(context.writes.length, 1, 'a failed read leaves the previous ACK as the no-op baseline')
        assert.equal(field.value, 'Beta')
        assert.equal(feedback(context), text.savedRefreshFailed, 'returning to the still-valid saved value retains its old refresh feedback')
        assert.equal(actionCount(context), 1)
        assert.equal(context.reads.length, 2)
      } else {
        assert.equal(context.writes.length, 2, 'after successful C publication, returning to old ACK Beta is a new intentional write')
        assert.deepEqual(context.writes[1].input, { documentId: 'target', columnId: 'notes', value: 'Beta' })
        assert.equal(field.readOnly, true)
        assert.equal(context.reads.length, 2)
        await context.ack(1)
        await context.settleRead(2)
        const saved = original.map(entry => entry.id === 'target'
          ? { ...entry, fieldValues: { ...entry.fieldValues, notes: 'Beta' } } : entry)
        assert.deepEqual(context.disk(), saved)
        assert.deepEqual(context.model().documents, saved)
        assert.equal(field.value, 'Beta')
        assert.equal(field.readOnly, false)
        assert.equal(feedback(context), '')
        assert.equal(actionCount(context), 0)
        assert.equal(context.writes.length, 2)
        assert.equal(context.reads.length, 3)
      }
    }, { virtual: true })
  }
})
