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
import { waitForRenderer } from './helpers/renderer-async'

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
type ReadMetadata = Partial<Pick<Model, 'home' | 'databases' | 'views'>>
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
        return 42 + node.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length * 56 + spacers
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
      if (reason === undefined) request.documents.resolve({ entries: structuredClone(disk), total: disk.length, nextOffset: null })
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

// Each read below travels through the actual inline cell action and the full
// DatabasePage API fan-out. A resolved promise alone is not fabricated as props.
for (const { locale, freshValue } of [{ locale: 'en-US', freshValue: 'Beta' },
  { locale: 'zh-CN', freshValue: 'External canonical C' }] as const) {
  test(`an inline text Refresh confirms its own published catalog read without Escape reviving an obsolete action (${locale})`, async () => {
    await withPage(locale, async ({ document, writes, reads, input, fill, enter, ack,
      settleRead, disk, model, externalWrite, key }) => {
      const before = model(), original = disk(), field = input(), text = getDatabaseWorkspaceText(locale)
      const expected = (value: string) => original.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: value } } : entry)
      await act(async () => field.focus())
      await fill('  Beta  ')
      await enter()
      assert.equal(writes.length, 1)
      assert.deepEqual(writes[0].input, { documentId: 'target', columnId: 'notes', value: 'Beta' })
      assert.deepEqual(disk(), original)
      assert.equal(field.readOnly, true)
      await ack()
      assert.deepEqual(disk(), expected('Beta'), 'the durable catalog ACK preserves all document metadata, including updatedAt')
      assert.equal(reads.length, 1)
      await settleRead(0, new Error('Actual automatic catalog read rejected after the property ACK'))
      assert.deepEqual(model(), before)
      assert.equal(input() === field, true)
      assert.equal(field.value, 'Beta')
      assert.equal(field.readOnly, false)
      const editor = field.closest('.dbw-text-cell-editor')!
      assert.equal(editor.querySelector('.dbw-text-cell-feedback')?.textContent, text.savedRefreshFailed)
      assert.equal(editor.querySelectorAll('button').length, 1)
      assert.equal(appNotifications.getSnapshot().length, 1)
      await waitForRenderer(() => document.querySelector('.app-notification-message')?.textContent === text.savedRefreshFailed,
        'The notification Host must finish its first lazy import before checking the catalog refresh failure')
      assert.equal(document.querySelector('.app-notification-message')?.textContent, text.savedRefreshFailed)
      const refresh = editor.querySelector<HTMLButtonElement>('button')
      assert.ok(refresh)
      assert.equal(refresh.textContent, text.refresh)
      await act(async () => { refresh.click(); refresh.click() })
      assert.equal(reads.length, 2, 'the actual inline action starts one complete Page GET')
      assert.equal(writes.length, 1, 'refreshing never repeats the successful write')
      assert.equal(field.readOnly, false, 'the read leaves this real input editable')
      await act(async () => { field.focus(); field.setSelectionRange(1, 3) })
      assert.equal(document.activeElement === field, true)
      assert.equal(field.value, 'Beta')
      assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 3])
      if (freshValue !== 'Beta') externalWrite(freshValue)
      assert.deepEqual(reads[1].calls, ['home', 'documents', 'databases', 'columns', 'entities', 'views'])
      assert.equal(reads[1].target, 'catalog')
      assert.deepEqual(reads[1].catalogInputs, [{ databaseId: null, limit: 1000, offset: 0 }])
      await settleRead(1)
      assert.deepEqual(model(), { ...before, documents: expected(freshValue) },
        'the actual Page functional updates commit the complete fresh records and schema')
      assert.deepEqual(disk(), expected(freshValue))
      assert.equal(input() === field, true)
      assert.equal(document.activeElement === field, true)
      assert.equal(field.readOnly, false)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 2)
      assert.equal(appNotifications.getSnapshot().length, 1, 'successful reading adds no duplicate notification')
      assert.equal(field.value, freshValue, 'the current read publishes the authoritative property at the same document revision')
      assert.equal(editor.querySelectorAll('.dbw-text-cell-feedback').length, 0)
      assert.equal(editor.querySelectorAll('button').length, 0)
      await key('Escape')
      assert.equal(field.value, freshValue, 'Escape cannot restore the previous ACK over the successfully read authority')
      assert.equal(editor.querySelectorAll('.dbw-text-cell-feedback').length, 0)
      assert.equal(editor.querySelectorAll('button').length, 0, 'Escape cannot restore an obsolete message-free Refresh action')
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 2)
      assert.deepEqual(disk(), expected(freshValue))
    })
  })
}

type PageContext = Parameters<Parameters<typeof withPage>[1]>[0]
const publicationKeys: (keyof Model)[] = ['documents', 'catalogColumns']
const editor = (context: PageContext) => context.input().closest('.dbw-text-cell-editor')!
const feedback = (context: PageContext) => editor(context).querySelector('.dbw-text-cell-feedback')?.textContent ?? ''
const actions = (context: PageContext) => editor(context).querySelectorAll('button').length
async function inlineRefresh(context: PageContext) {
  const button = editor(context).querySelector<HTMLButtonElement>('button'); assert.ok(button)
  assert.equal(button.textContent, getDatabaseWorkspaceText(getActiveUiText().language).refresh)
  await act(async () => button.click())
}
async function startWrite(context: PageContext) {
  const original = context.disk()
  await act(async () => context.input().focus())
  await context.fill('  Beta  ')
  await context.enter()
  assert.equal(context.writes.length, 1)
  assert.deepEqual(context.writes[0].input, { documentId: 'target', columnId: 'notes', value: 'Beta' })
  assert.deepEqual(context.disk(), original)
  await context.ack()
  assert.equal(context.reads.length, 1)
  assert.deepEqual(context.disk(), original.map(entry => entry.id === 'target'
    ? { ...entry, fieldValues: { ...entry.fieldValues, notes: 'Beta' } } : entry))
  assert.equal(context.input().readOnly, false)
}
async function savedFailure(context: PageContext) {
  await startWrite(context)
  await context.settleRead(0, new Error('Actual automatic GET rejected after its durable ACK'))
  assert.equal(feedback(context), getDatabaseWorkspaceText(getActiveUiText().language).savedRefreshFailed)
  assert.equal(actions(context), 1)
  assert.equal(appNotifications.getSnapshot().length, 1)
}

test('an own inline read cannot acknowledge its value before the real records and schema functional updaters commit', async () => {
  await withPage('en-US', async context => {
    await savedFailure(context)
    const before = context.model(), field = context.input()
    context.hold(publicationKeys)
    await inlineRefresh(context)
    await act(async () => field.focus())
    context.externalWrite('Fresh own-read C')
    await context.settleRead(1)
    assert.deepEqual(context.model().documents, before.documents)
    assert.equal(field.value, 'Beta')
    assert.equal(field.readOnly, false)
    assert.equal(actions(context), 1, 'GET resolution alone must not remove the still-unconfirmed Refresh action')
    await context.pulse()
    assert.equal(actions(context), 1, 'a Page pulse is not a records-and-schema commit')
    await context.flush(['documents'])
    assert.deepEqual(context.model().documents, context.disk())
    assert.equal(field.value, 'Beta', 'schema publication is still outstanding')
    assert.equal(actions(context), 1)
    await context.flush(['catalogColumns'])
    assert.equal(field.value, 'Fresh own-read C')
    assert.equal(feedback(context), '')
    assert.equal(actions(context), 0)
    assert.equal(context.document.activeElement === field, true)
    await context.key('Escape')
    assert.equal(field.value, 'Fresh own-read C')
    assert.equal(feedback(context), '')
    assert.equal(actions(context), 0)
    assert.equal(context.writes.length, 1)
    assert.equal(context.reads.length, 2)
    assert.equal(appNotifications.getSnapshot().length, 1)
  })
})

test('automatic reads establish same-revision authority only on success and retain their actual terminal failure on Escape', async () => {
  for (const rejected of [false, true]) {
    await withPage('zh-CN', async context => {
      const before = context.model(), original = context.disk(), text = getDatabaseWorkspaceText('zh-CN')
      await startWrite(context)
      const field = context.input()
      await act(async () => { field.focus(); field.setSelectionRange(0, 2) })
      context.externalWrite('Automatic canonical C')
      await context.settleRead(0, rejected ? new Error('Automatic read rejected') : undefined)
      const canonical = original.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: 'Automatic canonical C' } } : entry)
      assert.deepEqual(context.disk(), canonical)
      assert.deepEqual(context.model(), rejected ? before : { ...before, documents: canonical })
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.equal(field.value, rejected ? 'Beta' : 'Automatic canonical C')
      assert.equal(feedback(context), rejected ? text.savedRefreshFailed : '')
      assert.equal(actions(context), rejected ? 1 : 0)
      await context.key('Escape')
      assert.equal(field.value, rejected ? 'Beta' : 'Automatic canonical C')
      assert.equal(feedback(context), rejected ? text.savedRefreshFailed : '',
        'a reading focus snapshot cannot replace an actual failure with an empty message')
      assert.equal(actions(context), rejected ? 1 : 0)
      assert.equal(field.readOnly, false)
      assert.equal(context.writes.length, 1)
      assert.equal(context.reads.length, 1)
      assert.equal(appNotifications.getSnapshot().length, rejected ? 1 : 0)
    })
  }
})

test('Escape from a captured reading clone revokes a queued publication and a later valid inline request establishes fresh authority', async () => {
  await withPage('en-US', async context => {
    await savedFailure(context)
    const before = context.model(), field = context.input()
    context.hold(publicationKeys)
    await inlineRefresh(context)
    await act(async () => field.focus())
    context.externalWrite('Canonical after clone C')
    await context.settleRead(1)
    assert.equal(actions(context), 1)
    await context.key('Escape')
    assert.equal(field.value, 'Beta')
    assert.equal(field.readOnly, false)
    assert.equal(actions(context), 1)
    await context.flush()
    assert.deepEqual(context.model().documents, before.documents, 'the actual queued updater evaluates the revoked read guard')
    assert.equal(field.value, 'Beta')
    assert.equal(actions(context), 1)
    await inlineRefresh(context)
    await act(async () => field.focus())
    await context.settleRead(2)
    assert.deepEqual(context.model().documents, context.disk())
    assert.equal(field.value, 'Canonical after clone C')
    assert.equal(actions(context), 0)
    await context.key('Escape')
    assert.equal(field.value, 'Canonical after clone C')
    assert.equal(feedback(context), '')
    assert.equal(actions(context), 0)
    assert.equal(context.writes.length, 1)
    assert.equal(context.reads.length, 3)
    assert.equal(appNotifications.getSnapshot().length, 1)
  })
})

test('newer failed reads, source transitions, ABA, and Page unmount cannot confirm an older own-read snapshot or emit its late failure', async () => {
  for (const transition of ['superseded', 'source', 'aba', 'unmount'] as const) {
    for (const rejected of transition === 'superseded' ? [false] : [false, true]) {
      await withPage('en-US', async context => {
        await savedFailure(context)
        const before = context.model()
        await inlineRefresh(context)
        if (transition === 'superseded') {
          context.hold(publicationKeys)
          await context.settleRead(1)
          assert.equal(actions(context), 1)
          await act(async () => context.refreshButton().click())
          await context.flush()
          assert.equal(actions(context), 1, 'the older descriptor cannot confirm after a new full read starts')
          await context.settleRead(2, new Error('Newer Header read rejected'))
          assert.equal(actions(context), 1)
          assert.equal(appNotifications.getSnapshot().length, 2)
          assert.equal(appNotifications.getSnapshot()[1].message, getDatabaseWorkspaceText('en-US').refreshFailed)
        } else {
          if (transition === 'unmount') await context.patch({ shown: false })
          else {
            await context.navigate('other-source')
            if (transition === 'aba') await context.navigate('catalog')
          }
          await context.settleRead(1, rejected ? new Error('Old inline read rejected') : undefined)
          if (transition === 'unmount') await context.patch({ shown: true })
          else if (transition === 'source') await context.navigate('catalog')
          assert.deepEqual(context.model().documents, before.documents)
          assert.equal(context.input().value, 'Beta')
          assert.equal(feedback(context), getDatabaseWorkspaceText('en-US').savedRefreshFailed)
          assert.equal(actions(context), 1)
          assert.equal(appNotifications.getSnapshot().length, 1)
        }
        assert.equal(context.writes.length, 1)
        assert.equal(context.reads.length, transition === 'superseded' ? 3 : 2)
      })
    }
  }
})

test('a swapped Domain cache or pruned same-ID text entry cannot receive an old own-read result over a new failed draft', async () => {
  for (const replacement of ['cache', 'record', 'field-type'] as const) for (const rejected of [false, true]) {
    await withPage('zh-CN', async context => {
      await savedFailure(context)
      const before = context.model(), canonical = context.disk()
      await inlineRefresh(context)
      if (replacement === 'cache') await context.replaceCache()
      else if (replacement === 'record') {
        await context.patch({ documents: before.documents.filter(entry => entry.id !== 'target') })
        await context.patch({ documents: before.documents })
      } else {
        await context.patch({ catalogColumns: columns.map(column => column.id === 'notes'
          ? { ...column, type: 'checkbox', options: [] } : column) })
        assert.equal(context.input().type, 'checkbox')
        await context.patch({ catalogColumns: columns })
      }
      const field = context.input()
      assert.equal(field.value, 'Alpha')
      await act(async () => field.focus())
      await context.fill('  New same-ID failure  ')
      await context.enter()
      await context.failWrite(1)
      await act(async () => { field.focus(); field.setSelectionRange(2, 6) })
      await context.settleRead(1, rejected ? new Error('Obsolete inline GET rejected') : undefined)
      assert.deepEqual(context.disk(), canonical)
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.equal(field.value, '  New same-ID failure  ')
      assert.deepEqual([field.selectionStart, field.selectionEnd], [2, 6])
      assert.equal(field.readOnly, false)
      assert.equal(field.getAttribute('aria-invalid'), 'true')
      assert.equal(feedback(context), getDatabaseWorkspaceText('zh-CN').formFailed)
      assert.equal(actions(context), 1)
      assert.equal(appNotifications.getSnapshot().length, 2, 'only the original read error and the current failed write are announced')
      assert.equal(context.writes.length, 2)
      assert.equal(context.reads.length, 2)
      assert.deepEqual(context.model().databases, before.databases)
      assert.deepEqual(context.model().home, before.home)
      assert.deepEqual(context.model().documents.filter(entry => entry.id !== 'target'), before.documents.filter(entry => entry.id !== 'target'))
    })
  }
})

test('new dirty input and accepted writes permanently revoke an own read before its queued props can publish or release a new lock', async () => {
  for (const next of ['dirty', 'write'] as const) {
    await withPage('en-US', async context => {
      await savedFailure(context)
      const before = context.model(), original = initialDocuments(), field = context.input()
      context.hold(publicationKeys)
      await inlineRefresh(context)
      await act(async () => field.focus())
      context.externalWrite('Revoked old read C')
      await context.settleRead(1)
      assert.equal(actions(context), 1)
      await context.fill('  New intent D  ')
      if (next === 'write') {
        await context.enter()
        assert.equal(context.writes.length, 2)
        assert.equal(field.readOnly, true)
        await act(async () => field.focus())
      }
      await context.flush()
      assert.deepEqual(context.model().documents, before.documents, 'the real old functional updater is rejected after the new input intent')
      assert.equal(field.value, '  New intent D  ')
      assert.equal(field.readOnly, next === 'write')
      assert.equal(context.document.activeElement === field, true)
      if (next === 'dirty') {
        await context.key('Escape')
        assert.equal(field.value, 'Beta')
        assert.equal(actions(context), 1)
        await inlineRefresh(context)
        await act(async () => field.focus())
        await context.settleRead(2)
        assert.equal(field.value, 'Revoked old read C')
        await context.key('Escape')
        assert.equal(field.value, 'Revoked old read C')
        assert.equal(actions(context), 0)
        assert.equal(context.writes.length, 1)
      } else {
        await context.key('Escape')
        assert.equal(field.value, '  New intent D  ')
        assert.equal(field.readOnly, true, 'Escape does not roll back or unlock an accepted write')
        await context.ack(1)
        await context.settleRead(2)
        const canonical = original.map(entry => entry.id === 'target'
          ? { ...entry, fieldValues: { ...entry.fieldValues, notes: 'New intent D' } } : entry)
        assert.deepEqual(context.disk(), canonical)
        assert.deepEqual(context.model().documents, canonical)
        assert.equal(field.value, 'New intent D')
        assert.equal(field.readOnly, false)
        assert.equal(actions(context), 0)
        assert.equal(context.writes.length, 2)
      }
      assert.equal(feedback(context), '')
      assert.equal(context.reads.length, 3)
      assert.equal(appNotifications.getSnapshot().length, 1)
    })
  }
})

const delayedMetadataKeys: (keyof Model)[] = ['home', 'databases', 'views', 'activeView']
const allPublicationKeys: (keyof Model)[] = ['home', 'documents', 'databases', 'catalogColumns',
  'selectedColumns', 'entities', 'views', 'activeView']
function freshMetadata(before: Model, label: string): Required<ReadMetadata> {
  return {
    home: { ...structuredClone(before.home), summary: { ...before.home.summary,
      backupRoot: `Fresh ${label} backup root`, lastBackupAt: '2026-10-03T09:30:00.000Z' } },
    databases: before.databases.map(source => ({ ...source,
      description: `${label}: ${source.description}`, updatedAt: '2026-10-03T09:30:00.000Z' })),
    // The previously active view no longer exists in this genuine GET result.
    // Page must eventually apply both the fresh view and its selected ID.
    views: before.views.map(view => ({ ...structuredClone(view), id: `fresh-${label}-${view.id}`,
      name: `Fresh ${label} view`, updatedAt: '2026-10-03T09:30:00.000Z' }))
  }
}

test('confirming committed cell data permits the same read to publish delayed home and views, while later editing revokes that publication', async () => {
  for (const timing of ['terminal-first', 'layout-first'] as const) for (const newerEdit of [false, true]) {
    await withPage('en-US', async context => {
      await savedFailure(context)
      const before = context.model(), original = context.disk(), field = context.input()
      const metadata = freshMetadata(before, timing)
      context.hold(delayedMetadataKeys)
      if (timing === 'terminal-first') context.hold(publicationKeys)
      else context.publishNow(['documents', 'catalogColumns', 'selectedColumns'])
      await inlineRefresh(context)
      await act(async () => field.focus())
      context.externalWrite('Confirmed own-read canonical C')
      await context.settleRead(1, undefined, metadata)
      if (timing === 'terminal-first') {
        assert.equal(field.value, 'Beta')
        assert.equal(actions(context), 1)
        assert.deepEqual(context.model().documents, before.documents)
        await context.flush(publicationKeys)
      }
      assert.deepEqual(context.model().documents, context.disk())
      assert.equal(field.value, 'Confirmed own-read canonical C')
      assert.equal(actions(context), 0)
      assert.equal(feedback(context), '')
      assert.deepEqual(context.model().home, before.home)
      assert.deepEqual(context.model().databases, before.databases)
      assert.deepEqual(context.model().views, before.views)
      assert.equal(context.model().activeView, before.activeView)
      if (newerEdit) await context.fill('  User edit after confirmation D  ')
      await act(async () => field.setSelectionRange(2, 8))
      const selection = [field.selectionStart, field.selectionEnd]
      await context.flush(delayedMetadataKeys)
      assert.deepEqual(context.model(), { ...before, documents: context.disk(),
        ...(newerEdit ? {} : { ...metadata, activeView: metadata.views[0].id }) },
      newerEdit ? 'a new edit cancels the actual delayed metadata updaters after the cell feedback was cleared'
        : 'clearing cell feedback must not cancel legitimate delayed publication from the same GET')
      assert.equal(context.input() === field, true)
      assert.equal(context.document.activeElement === field, true)
      assert.equal(field.value, newerEdit ? '  User edit after confirmation D  ' : 'Confirmed own-read canonical C')
      assert.deepEqual([field.selectionStart, field.selectionEnd], selection)
      assert.equal(field.readOnly, false)
      assert.equal(actions(context), 0)
      assert.equal(feedback(context), '')
      assert.deepEqual(context.disk(), original.map(entry => entry.id === 'target'
        ? { ...entry, fieldValues: { ...entry.fieldValues, notes: 'Confirmed own-read canonical C' } } : entry))
      assert.equal(context.writes.length, 1)
      assert.equal(context.reads.length, 2)
      assert.deepEqual(context.reads[1].calls.slice().sort(), ['columns', 'databases', 'documents', 'entities', 'home', 'views'])
      assert.equal(appNotifications.getSnapshot().length, 1)
    })
  }
})

test('a newer Header read permanently supersedes older own-read records, schema, home, and view functional updaters', async () => {
  await withPage('zh-CN', async context => {
    await savedFailure(context)
    const before = context.model(), original = context.disk(), field = context.input()
    context.hold(allPublicationKeys)
    await inlineRefresh(context)
    await act(async () => field.focus())
    const obsoleteMetadata = freshMetadata(before, 'obsolete')
    await context.settleRead(1, undefined, obsoleteMetadata)
    assert.deepEqual(context.model(), before)
    assert.equal(field.value, 'Beta')
    assert.equal(actions(context), 1)
    // Leave the actual old updater functions queued, but allow this newer GET
    // to commit normally. No private Page guard is substituted by the fixture.
    context.release(allPublicationKeys)
    await act(async () => context.refreshButton().click())
    context.externalWrite('Latest Header canonical C')
    const latestMetadata = freshMetadata(before, 'latest')
    await context.settleRead(2, undefined, latestMetadata)
    const published = { ...before, documents: context.disk(), ...latestMetadata,
      activeView: latestMetadata.views[0].id }
    assert.deepEqual(context.model(), published)
    assert.equal(field.value, 'Latest Header canonical C')
    assert.equal(actions(context), 0)
    assert.equal(feedback(context), '')
    await act(async () => field.setSelectionRange(1, 5))
    await context.flush(allPublicationKeys)
    assert.deepEqual(context.model(), published, 'old own-read functions cannot overwrite a later full Page read')
    assert.equal(context.input() === field, true)
    assert.equal(context.document.activeElement === field, true)
    assert.equal(field.value, 'Latest Header canonical C')
    assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 5])
    await context.key('Escape')
    assert.equal(field.value, 'Latest Header canonical C')
    assert.equal(actions(context), 0)
    assert.equal(feedback(context), '')
    assert.deepEqual(context.disk(), original.map(entry => entry.id === 'target'
      ? { ...entry, fieldValues: { ...entry.fieldValues, notes: 'Latest Header canonical C' } } : entry))
    assert.equal(context.writes.length, 1)
    assert.equal(context.reads.length, 3)
    assert.equal(appNotifications.getSnapshot().length, 1)
  })
})
