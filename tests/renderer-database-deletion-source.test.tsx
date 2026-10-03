import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useMemo, useState, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type {
  DatabaseEntity, DatabaseSavedView, DocumentCatalogEntry, DocumentCatalogPage,
  DocumentDatabase, DocumentDatabaseColumn, HomeData
} from '../src/shared/contracts'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../src/renderer/src/types/appDomains'
import type { DatabaseWorkspace } from '../src/renderer/src/features/database/DatabaseWorkspace'
import type { DatabaseDeletion as Deletion } from '../src/renderer/src/features/database/model/databaseDeletion'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { getUiText } from '../src/renderer/src/i18n'

// The real Page, domain and view-draft hook own the state under test. The small
// workspace exposes their callbacks without replaying destructive-dialog tests.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('/features/database/DatabaseWorkspace.tsx')) return {
      format: 'module', source: 'export const DatabaseWorkspace = props => globalThis.deletionSourceTestWorkspace(props)', shortCircuit: true
    }
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DatabasePage } = await import('../src/renderer/src/pages/DatabasePage')
const { useDatabaseDomainState } = await import('../src/renderer/src/hooks/useDatabaseDomainState')
const { useDatabaseViewDraft } = await import('../src/renderer/src/features/database/hooks/useDatabaseViewDraft')
const { adaptCatalogFields, adaptCustomFields } = await import('../src/renderer/src/features/database/model/databaseAdapters')

type WorkspaceProps = ComponentProps<typeof DatabaseWorkspace> & { onDeleted?: (deletion: Deletion) => void | Promise<void> }
type Domain = ReturnType<typeof useDatabaseDomainState>
type Draft = ReturnType<typeof useDatabaseViewDraft>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const database = (id: string): DocumentDatabase => ({ id, kind: id === 'catalog' ? 'document-catalog' : 'custom',
  name: `Database ${id}`, description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' })
const databases = () => ['catalog', 'a', 'b'].map(database)
const columns = (id: string): DocumentDatabaseColumn[] => [
  { id: `${id}-field`, name: `${id} field`, type: 'text', options: [], sortOrder: 0 },
  { id: `${id}-keep`, name: `${id} keep`, type: 'text', options: [], sortOrder: 1 }
]
const entities = (id: string): DatabaseEntity[] => [1, 2, 3].map(index => ({ id: `${id}-row-${index}`,
  databaseId: id, title: `${id} row ${index}`, documentId: null,
  fieldValues: { [`${id}-field`]: `value ${index}`, [`${id}-keep`]: `keep ${index}` },
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
const views = (id: string): DatabaseSavedView[] => ['one', 'two'].map(suffix => ({ id: `${id}-${suffix}`,
  databaseId: id, name: `${id} ${suffix}`, config: { ...createDefaultDatabaseViewConfig(), query: `${id} saved ${suffix}` },
  configVersion: 1, filterQuery: `${id} saved ${suffix}`, filterScope: '', sortMode: 'updated-desc', viewMode: 'table',
  sortOrder: suffix === 'one' ? 0 : 1, createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
const catalog = (): DocumentCatalogEntry[] => [{ id: 'document', title: 'Document', path: 'Document', summary: '',
  parentId: null, parentTitle: null, updatedAt: '2026-10-01', blockCount: 0, childCount: 0, linkCount: 0,
  fieldValues: { 'catalog-field': 'Deleted property', 'catalog-keep': 'Retained property' } }]
type DataRead = { id: string; called: Set<string>; columns: ReturnType<typeof deferred<DocumentDatabaseColumn[]>>;
  entities: ReturnType<typeof deferred<DatabaseEntity[]>>; views: ReturnType<typeof deferred<DatabaseSavedView[]>> }
type PageRead = { home: ReturnType<typeof deferred<HomeData>>; documents: ReturnType<typeof deferred<DocumentCatalogPage>>;
  list: ReturnType<typeof deferred<DocumentDatabase[]>>; data: DataRead; completion: ReturnType<WorkspaceProps['onRefresh']> }
const fieldLabels = { title: 'Title', path: 'Path', parent: 'Parent', linkedDocument: 'Document',
  blockCount: 'Blocks', linkCount: 'Links', childCount: 'Children', createdAt: 'Created', updatedAt: 'Updated' }
type Context = {
  document: Document; lists: Array<ReturnType<typeof deferred<DocumentDatabase[]>>>; reads: DataRead[];
  refreshes: PageRead[];
  domain: () => Domain; draft: () => Draft; catalogColumns: () => DocumentDatabaseColumn[];
  catalogDocuments: () => DocumentCatalogEntry[]; change: (action: () => void) => Promise<void>;
  acknowledge: (deletion: Deletion) => Promise<void>; captureAck: () => (deletion: Deletion) => void;
  navigate: (id: string) => Promise<void>; navigateNow: (id: string) => void; resolveData: (read: DataRead) => Promise<void>;
  rejectData: (read: DataRead) => Promise<void>;
  startRefresh: () => Promise<PageRead>; resolveRefresh: (read: PageRead, databaseIds?: string[]) => Promise<void>;
  rejectRefresh: (read: PageRead) => Promise<void>; hidePage: () => Promise<void>
}

async function withDeletionSource(run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  dom.window.localStorage.setItem('knowbook.database.last-source', 'a')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const lists: Context['lists'] = []
  const reads: DataRead[] = []
  const refreshes: PageRead[] = []
  let assemblingRefresh: PageRead | null = null
  let current!: Domain
  let currentDraft!: Draft
  let workspace!: WorkspaceProps
  let currentCatalogColumns!: DocumentDatabaseColumn[]
  let currentCatalogDocuments!: DocumentCatalogEntry[]
  let setPageVisible!: (visible: boolean) => void
  const readFor = (id: string, kind: 'columns' | 'entities' | 'views') => {
    // Domain and Page start the same three reads in different orders.
    if (assemblingRefresh) {
      const pending = assemblingRefresh.data
      if (pending.called.size === 0) reads.push(pending)
      pending.id = id
      pending.called.add(kind)
      if (kind === 'views') assemblingRefresh = null
      return pending
    }
    let pending = reads.at(-1)
    if (!pending || pending.id !== id || pending.called.has(kind)) {
      pending = { id, called: new Set(), columns: deferred<DocumentDatabaseColumn[]>(),
        entities: deferred<DatabaseEntity[]>(), views: deferred<DatabaseSavedView[]>() }
      reads.push(pending)
    }
    pending.called.add(kind)
    return pending
  }
  function ObservableWorkspace(props: WorkspaceProps) {
    workspace = props
    const isCatalog = props.databases.find(item => item.id === props.currentDatabaseId)?.kind === 'document-catalog'
    const fields = useMemo(() => isCatalog ? adaptCatalogFields(props.catalogColumns, fieldLabels)
      : adaptCustomFields(props.selectedColumns, fieldLabels), [isCatalog, props.catalogColumns, props.selectedColumns])
    currentDraft = useDatabaseViewDraft({ databaseId: props.currentDatabaseId, fields, savedViews: props.savedViews,
      activeViewId: props.activeViewId, onActiveViewIdChange: props.onActiveViewIdChange, draftCache: props.viewDraftCache })
    return createElement('section', { id: 'observed-workspace', 'data-source': props.currentDatabaseId },
      createElement('output', null, JSON.stringify({ source: props.currentDatabaseId, rows: props.entities.map(row => row.id),
        fields: props.selectedColumns.map(field => field.id), views: props.savedViews.map(view => view.id), active: props.activeViewId })))
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, deletionSourceTestWorkspace: ObservableWorkspace })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    getDatabases: () => { const pending = assemblingRefresh?.list ?? deferred<DocumentDatabase[]>(); lists.push(pending); return pending.promise },
    getHomeData: () => {
      const pending: PageRead = { home: deferred<HomeData>(), documents: deferred<DocumentCatalogPage>(),
        list: deferred<DocumentDatabase[]>(), data: { id: '', called: new Set(), columns: deferred<DocumentDatabaseColumn[]>(),
          entities: deferred<DatabaseEntity[]>(), views: deferred<DatabaseSavedView[]>() }, completion: Promise.resolve() }
      refreshes.push(pending)
      assemblingRefresh = pending
      return pending.home.promise
    },
    getDocumentCatalogPage: () => assemblingRefresh!.documents.promise,
    getDatabaseEntities: (id: string) => readFor(id, 'entities').entities.promise,
    getDocumentDatabaseColumns: (id: string) => readFor(id, 'columns').columns.promise,
    getDatabaseSavedViews: (id: string) => readFor(id, 'views').views.promise
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  function Harness() {
    const domain = useDatabaseDomainState()
    current = domain
    const [visible, setVisible] = useState(true)
    setPageVisible = setVisible
    const [, setHome] = useState({ summary: { databasePath: 'test' } } as HomeData)
    const [catalogColumns, setCatalogColumns] = useState(() => columns('catalog'))
    const [catalogDocuments, setCatalogDocuments] = useState(catalog)
    currentCatalogColumns = catalogColumns
    currentCatalogDocuments = catalogDocuments
    return visible ? createElement(DatabasePage, { database: domain as unknown as DatabaseDomainState,
      catalogColumns, catalogDocuments, catalogLoading: false, catalogReady: true, catalogError: null,
      documentCatalog: [], onRetryCatalog: () => {}, onCatalogColumnsChange: setCatalogColumns,
      onCatalogDocumentsChange: setCatalogDocuments, onHomeDataChange: setHome, onMessage: () => {},
      onOpenDocument: () => {}, selectedDocumentId: null, workspaceBoard: {} as DatabaseWorkspaceBoardState,
      ui: getUiText('en-US') }) : createElement('p', { id: 'other-page' }, 'Another page')
  }
  const change = async (action: () => void) => { await act(async () => action()) }
  const resolveData = async (read: DataRead) => change(() => {
    read.columns.resolve(columns(read.id)); read.entities.resolve(entities(read.id)); read.views.resolve(views(read.id))
  })
  const settleRefresh = async (pending: PageRead, fail = false, databaseIds = ['catalog', 'a', 'b']) => {
    await change(() => {
      pending.home.resolve({ summary: { databasePath: 'obsolete' } } as HomeData)
      const entries = catalog()
      pending.documents.resolve({ entries, total: entries.length, nextOffset: null })
      if (fail) pending.list.reject(new Error('Read after deletion failed'))
      else pending.list.resolve(databaseIds.map(database))
      pending.data.columns.resolve(columns(pending.data.id))
      pending.data.entities.resolve(entities(pending.data.id))
      pending.data.views.resolve(views(pending.data.id))
    })
    await pending.completion
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await change(() => lists[0].resolve(databases()))
    await resolveData(reads[0])
    assert.equal(current.databaseReady, true)
    assert.equal(current.databaseEntityDatabaseId, 'a')
    assert.equal(current.activeDatabaseSavedViewId, 'a-one')
    await run({ document: dom.window.document, lists, reads, refreshes, domain: () => current, draft: () => currentDraft,
      catalogColumns: () => currentCatalogColumns, catalogDocuments: () => currentCatalogDocuments, change, resolveData,
      acknowledge: async deletion => change(() => { void workspace.onDeleted?.(deletion) }),
      captureAck: () => {
        const callback = workspace.onDeleted
        return deletion => { void callback?.(deletion) }
      },
      navigate: async id => change(() => workspace.onCurrentDatabaseIdChange(id)),
      navigateNow: id => workspace.onCurrentDatabaseIdChange(id),
      rejectData: async read => change(() => {
        read.columns.resolve(columns(read.id)); read.entities.reject(new Error('Fallback source read failed'))
        read.views.resolve(views(read.id))
      }),
      startRefresh: async () => {
        let completion!: ReturnType<WorkspaceProps['onRefresh']>
        await change(() => { completion = workspace.onRefresh(); void completion.catch(() => {}) })
        const pending = refreshes.at(-1)!
        pending.completion = completion
        return pending
      },
      resolveRefresh: (pending, ids) => settleRefresh(pending, false, ids), rejectRefresh: pending => settleRefresh(pending, true),
      hidePage: async () => change(() => setPageVisible(false)) })
  } finally {
    await act(async () => root.unmount())
    await act(async () => {
      for (const list of lists) list.resolve([])
      for (const refresh of refreshes) {
        refresh.home.resolve({ summary: { databasePath: 'cleanup' } } as HomeData)
        refresh.documents.resolve({ entries: [], total: 0, nextOffset: null })
      }
      for (const read of reads) { read.columns.resolve([]); read.entities.resolve([]); read.views.resolve([]) }
    })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('database deletion ACK removes the current source before fallback reads and a failed read cannot restore the deleted database', async () => {
  await withDeletionSource(async ({ domain, lists, reads, refreshes, change, acknowledge, resolveData, resolveRefresh, rejectRefresh, document }) => {
    await change(() => domain().reloadDatabaseDomain())
    const oldList = lists.at(-1)!
    const oldData = reads.at(-1)!
    await acknowledge({ kind: 'database', databaseId: 'a', id: 'a' })
    assert.equal(domain().databases.some(item => item.id === 'a'), false)
    assert.equal(domain().databaseEntityDatabaseId, 'catalog')
    assert.equal(domain().databaseReady, false, 'An existing fallback must be loaded normally, never primed as an empty newly created source')
    assert.equal(document.querySelectorAll('#observed-workspace').length, 0)
    const fallback = reads.at(-1)!
    assert.equal(fallback.id, 'catalog')
    const pageRefresh = refreshes.at(-1)!
    assert.equal(pageRefresh.data.id, 'catalog')
    await change(() => {
      oldList.resolve(databases()); oldData.columns.resolve(columns('a'))
      oldData.entities.resolve(entities('a')); oldData.views.resolve(views('a'))
    })
    await resolveData(fallback)
    await rejectRefresh(pageRefresh)
    assert.equal(domain().databases.some(item => item.id === 'a'), false)
    assert.equal(domain().databaseEntityDatabaseId, 'catalog')
    assert.equal(domain().databaseReady, true)
    assert.equal(domain().databaseError, null, 'The ACK refresh error is separate from domain-loading errors')
    assert.equal(document.querySelectorAll('.recovery-state').length, 1)
    assert.equal(document.querySelector('.recovery-state h2')?.textContent, 'Deleted, but refresh failed')
    assert.equal(document.querySelector('.recovery-state p')?.textContent,
      'The data was deleted. Retry only refreshes the list; it will not delete again.')
    assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 0)
    const beforeRetry = refreshes.length
    await change(() => document.querySelector<HTMLButtonElement>('.recovery-state .primary-button')!.click())
    assert.equal(refreshes.length, beforeRetry + 1, 'The recovery action starts a read, not the destructive workflow')
    await resolveRefresh(refreshes.at(-1)!, ['catalog', 'b'])
    assert.equal(document.querySelectorAll('.recovery-state').length, 0)
    assert.equal(domain().databases.some(item => item.id === 'a'), false)
    assert.equal(domain().databaseEntityDatabaseId, 'catalog')
  })
})

test('a same-frame source change and late A deletion ACK do not navigate away from B or cancel its pending load', async () => {
  await withDeletionSource(async ({ domain, reads, refreshes, change, captureAck, navigateNow, resolveData, draft }) => {
    const oldAck = captureAck()
    await change(() => {
      // Use the actual Page navigation callback before React has committed B.
      // The ACK must consult that synchronous intent, not the old rendered A.
      navigateNow('b')
      oldAck({ kind: 'database', databaseId: 'a', id: 'a' })
      oldAck({ kind: 'field', databaseId: 'a', id: 'a-field' })
      oldAck({ kind: 'view', databaseId: 'a', id: 'a-one' })
      oldAck({ kind: 'records', databaseId: 'a', ids: ['a-row-1', 'a-row-2'] })
    })
    const target = reads.at(-1)!
    assert.equal(target.id, 'b')
    assert.equal(refreshes.length, 0, 'An old source ACK must not start a B refresh or invalidate B\'s independent load')
    await resolveData(target)
    assert.equal(domain().databaseEntityDatabaseId, 'b')
    assert.equal(domain().databaseReady, true)
    assert.equal(domain().databases.some(item => item.id === 'a'), false)
    assert.deepEqual(domain().selectedDatabaseColumns, columns('b'))
    assert.deepEqual(domain().databaseEntities, entities('b'))
    await change(() => {
      domain().setSelectedDatabaseEntityIds(['b-row-2'])
      draft().updateDraft(current => ({ ...current, query: 'Unsaved B query' }))
      oldAck({ kind: 'record', databaseId: 'a', id: 'a-row-3' })
    })
    assert.deepEqual(domain().selectedDatabaseEntityIds, ['b-row-2'])
    assert.equal(draft().draft.query, 'Unsaved B query')
  })
})

test('record and bulk deletion ACKs remove only their rows and selected IDs while independent old reads cannot resurrect them', async () => {
  await withDeletionSource(async ({ domain, lists, reads, change, acknowledge, resolveData, draft }) => {
    await change(() => {
      domain().setSelectedDatabaseEntityIds(['a-row-1', 'a-row-2', 'a-row-3'])
      draft().updateDraft(current => ({ ...current, query: 'Keep my query' }))
      domain().reloadDatabaseDomain()
    })
    const oldData = reads.at(-1)!
    const oldList = lists.at(-1)!
    await acknowledge({ kind: 'record', databaseId: 'a', id: 'a-row-1' })
    assert.deepEqual(domain().databaseEntities.map(row => row.id), ['a-row-2', 'a-row-3'])
    assert.deepEqual(domain().selectedDatabaseEntityIds, ['a-row-2', 'a-row-3'])
    await acknowledge({ kind: 'records', databaseId: 'a', ids: ['a-row-2'] })
    assert.deepEqual(domain().databaseEntities.map(row => row.id), ['a-row-3'])
    assert.deepEqual(domain().selectedDatabaseEntityIds, ['a-row-3'])
    await change(() => oldList.resolve(databases()))
    await resolveData(oldData)
    assert.deepEqual(domain().databaseEntities.map(row => row.id), ['a-row-3'])
    assert.deepEqual(domain().selectedDatabaseEntityIds, ['a-row-3'])
    assert.equal(domain().activeDatabaseSavedViewId, 'a-one')
    assert.equal(draft().draft.query, 'Keep my query')
    assert.equal(domain().databaseReady, true)
    assert.equal(domain().databaseLoading, false)
  })
})

test('active-view deletion selects a surviving view without destroying its separately cached unsaved draft or accepting a stale reload', async () => {
  await withDeletionSource(async ({ domain, lists, reads, change, acknowledge, draft, resolveData }) => {
    await change(() => domain().setActiveDatabaseSavedViewId('a-two'))
    await change(() => draft().updateDraft(current => ({ ...current, query: 'Unsaved second view' })))
    await change(() => domain().setActiveDatabaseSavedViewId('a-one'))
    await change(() => domain().reloadDatabaseDomain())
    const oldData = reads.at(-1)!
    const oldList = lists.at(-1)!
    await acknowledge({ kind: 'view', databaseId: 'a', id: 'a-one' })
    assert.deepEqual(domain().databaseSavedViews.map(view => view.id), ['a-two'])
    assert.equal(domain().activeDatabaseSavedViewId, 'a-two')
    assert.equal(draft().draft.query, 'Unsaved second view')
    assert.equal(draft().baseConfig.query, 'a saved two')
    assert.equal(draft().dirty, true)
    assert.deepEqual(domain().databaseEntities, entities('a'))
    await change(() => oldList.resolve(databases()))
    await resolveData(oldData)
    assert.deepEqual(domain().databaseSavedViews.map(view => view.id), ['a-two'])
    assert.equal(domain().activeDatabaseSavedViewId, 'a-two')
    assert.equal(draft().draft.query, 'Unsaved second view')
  })
})

test('field deletion ACK removes its column and values, preserves unrelated draft data, and invalidates an older full Page refresh', async () => {
  await withDeletionSource(async ({ domain, change, acknowledge, draft, startRefresh, resolveRefresh }) => {
    await change(() => {
      draft().updateDraft(current => ({ ...current, query: 'Keep field draft query',
        visibleFieldIds: [...current.visibleFieldIds, 'a-field'],
        filters: { operator: 'and', rules: [{ id: 'deleted-field-rule', fieldId: 'a-field', operator: 'contains', value: 'value' }] } }))
      domain().setDatabaseEntityFieldValues({ 'a-field': 'remove', 'a-keep': 'keep' })
      domain().setDatabaseEntityBulkFieldValues({ 'a-field': 'remove bulk', 'a-keep': 'keep bulk' })
    })
    const oldPageRead = await startRefresh()
    await acknowledge({ kind: 'field', databaseId: 'a', id: 'a-field' })
    assert.deepEqual(domain().selectedDatabaseColumns.map(field => field.id), ['a-keep'])
    assert.equal(domain().databaseEntities.every(row => !Object.hasOwn(row.fieldValues, 'a-field')), true)
    assert.equal(domain().databaseEntities[0].fieldValues['a-keep'], 'keep 1')
    assert.deepEqual(domain().databaseEntityFieldValues, { 'a-keep': 'keep' })
    assert.deepEqual(domain().databaseEntityBulkFieldValues, { 'a-keep': 'keep bulk' })
    assert.equal(draft().draft.query, 'Keep field draft query')
    assert.equal(draft().draft.visibleFieldIds.includes('a-field'), false)
    assert.equal(draft().draft.filters.rules.some(filter => 'fieldId' in filter && filter.fieldId === 'a-field'), false)
    await resolveRefresh(oldPageRead)
    assert.deepEqual(domain().selectedDatabaseColumns.map(field => field.id), ['a-keep'])
    assert.equal(domain().databaseEntities.every(row => !Object.hasOwn(row.fieldValues, 'a-field')), true)
    assert.equal(draft().draft.query, 'Keep field draft query')
  })
})

test('catalog-field ACK updates the shared catalog even when a different database is selected, but an unmounted Page cannot publish another ACK', async () => {
  await withDeletionSource(async ({ domain, acknowledge, captureAck, catalogColumns, catalogDocuments, hidePage, document }) => {
    await acknowledge({ kind: 'field', databaseId: 'catalog', id: 'catalog-field' })
    assert.deepEqual(catalogColumns().map(field => field.id), ['catalog-keep'])
    assert.equal(Object.hasOwn(catalogDocuments()[0].fieldValues, 'catalog-field'), false)
    assert.equal(catalogDocuments()[0].fieldValues['catalog-keep'], 'Retained property')
    assert.deepEqual(domain().selectedDatabaseColumns, columns('a'))
    assert.deepEqual(domain().databaseEntities, entities('a'))
    const oldAck = captureAck()
    await hidePage()
    await act(async () => oldAck({ kind: 'database', databaseId: 'a', id: 'a' }))
    assert.equal(domain().databases.some(item => item.id === 'a'), true)
    assert.equal(domain().databaseEntityDatabaseId, 'a')
    assert.equal(document.querySelectorAll('#other-page').length, 1)
  })
})

test('a successful read-only deletion retry makes the fallback ready after a failed independent load and rejects a later obsolete load failure', async () => {
  for (const independentLoad of ['failed', 'pending'] as const) {
    await withDeletionSource(async ({ document, domain, reads, refreshes, acknowledge, change, rejectData, rejectRefresh, resolveRefresh }) => {
      await acknowledge({ kind: 'database', databaseId: 'a', id: 'a' })
      const independentFallback = reads.at(-1)!
      const deletionRefresh = refreshes.at(-1)!
      assert.equal(independentFallback.id, 'catalog')
      assert.equal(deletionRefresh.data.id, 'catalog')
      assert.equal(independentFallback === deletionRefresh.data, false, 'The fixture must preserve two real independent read lifetimes')
      assert.equal(domain().databaseReady, false)
      if (independentLoad === 'failed') await rejectData(independentFallback)
      await rejectRefresh(deletionRefresh)
      assert.equal(document.querySelectorAll('.recovery-state').length, independentLoad === 'failed' ? 2 : 1)
      if (independentLoad === 'failed') assert.equal(domain().databaseError, 'Fallback source read failed')
      const deletedRecovery = document.querySelector<HTMLElement>('.recovery-state[aria-label="Deleted, but refresh failed"]')!
      assert.equal(Boolean(deletedRecovery), true)
      const readCount = refreshes.length
      await change(() => deletedRecovery.querySelector<HTMLButtonElement>('.recovery-actions .primary-button')!.click())
      assert.equal(refreshes.length, readCount + 1)
      const retry = refreshes.at(-1)!
      assert.equal(retry.data.id, 'catalog')
      await resolveRefresh(retry, ['catalog', 'b'])
      assert.equal(domain().databaseReady, true, `${independentLoad}: an authoritative Page read must complete the source-loading handoff`)
      assert.equal(domain().databaseError, null, `${independentLoad}: successful target data must clear the old target-load error`)
      assert.equal(domain().databaseLoading, false)
      assert.equal(domain().databaseEntityDatabaseId, 'catalog')
      assert.deepEqual(domain().databaseEntities, entities('catalog'))
      assert.equal(domain().databases.some(item => item.id === 'a'), false)
      assert.equal(document.querySelectorAll('.recovery-state').length, 0)
      assert.equal(document.querySelector('#observed-workspace')?.getAttribute('data-source'), 'catalog')
      assert.equal(document.querySelector('#observed-workspace')?.textContent?.includes('catalog-row-1'), true)
      if (independentLoad === 'pending') {
        await rejectData(independentFallback)
        assert.equal(domain().databaseReady, true)
        assert.equal(domain().databaseError, null, 'The late failed independent load must not replace the completed Page read')
        assert.equal(domain().databaseLoading, false)
        assert.deepEqual(domain().databaseEntities, entities('catalog'))
        assert.equal(document.querySelectorAll('.recovery-state').length, 0)
        assert.equal(document.querySelector('#observed-workspace')?.getAttribute('data-source'), 'catalog')
        assert.equal(domain().databases.some(item => item.id === 'a'), false)
      }
    })
  }
})

test('a complete authoritative Page read clears an older list failure and prevents a pending independent list failure from replacing success', async () => {
  for (const independentList of ['failed', 'pending'] as const) {
    await withDeletionSource(async ({ document, domain, lists, refreshes, change, acknowledge, resolveRefresh }) => {
      await change(() => domain().reloadDatabaseDomain())
      const oldList = lists.at(-1)!
      if (independentList === 'failed') {
        await change(() => oldList.reject(new Error('Independent database list read failed')))
        assert.equal(domain().databaseError, 'Independent database list read failed')
        assert.equal(document.querySelectorAll('.recovery-state').length, 1)
      }
      // A record ACK invalidates target data, but is not itself a database-list
      // mutation. Only the subsequent complete getDatabases result can take
      // ownership from the older independent list request.
      await acknowledge({ kind: 'record', databaseId: 'a', id: 'a-row-1' })
      const completeRead = refreshes.at(-1)!
      assert.equal(completeRead.data.id, 'a')
      const remainingRows = entities('a').filter(row => row.id !== 'a-row-1')
      await change(() => completeRead.data.entities.resolve(remainingRows))
      await resolveRefresh(completeRead)
      assert.equal(domain().databaseReady, true)
      assert.equal(domain().databaseError, null, `${independentList}: a real successful getDatabases result must clear the previous independent list error`)
      assert.deepEqual(domain().databaseEntities, remainingRows)
      assert.equal(document.querySelectorAll('.recovery-state').length, 0)
      if (independentList === 'pending') {
        await change(() => oldList.reject(new Error('Obsolete independent list failure')))
        assert.equal(domain().databaseError, null, 'The older independent list failure must not overwrite the complete Page read')
        assert.equal(document.querySelectorAll('.recovery-state').length, 0)
      }
      assert.equal(domain().databaseLoading, false, 'The complete read has already confirmed both list and target data')
      assert.equal(domain().databaseReady, true)
      assert.equal(domain().databaseEntityDatabaseId, 'a')
      assert.deepEqual(domain().databaseEntities, remainingRows)
      assert.equal(document.querySelector('#observed-workspace')?.getAttribute('data-source'), 'a')
    })
  }
})
