import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type ComponentProps, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentCatalogEntry, DocumentCatalogPage, DocumentDatabase, DocumentDatabaseColumn, HomeData } from '../src/shared/contracts'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../src/renderer/src/types/appDomains'
import type { DatabaseWorkspace } from '../src/renderer/src/features/database/DatabaseWorkspace'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { getUiText } from '../src/renderer/src/i18n'

// Exercise the page's actual callbacks through a small DOM workspace. The full
// database workspace and its persistence are covered by Electron tests.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('/features/database/DatabaseWorkspace.tsx')) return {
      format: 'module', source: 'export const DatabaseWorkspace = props => globalThis.databasePageTestWorkspace(props)', shortCircuit: true
    }
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DatabasePage } = await import('../src/renderer/src/pages/DatabasePage')
type WorkspaceProps = ComponentProps<typeof DatabaseWorkspace>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const database = (id: string, suffix = ''): DocumentDatabase => ({ id, kind: id === 'catalog' ? 'document-catalog' : 'custom',
  name: `${id}${suffix}`, description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' })
const columns = (label: string): DocumentDatabaseColumn[] => [{ id: `column-${label}`, name: label, type: 'text', options: [], sortOrder: 0 }]
const entities = (id: string, label: string): DatabaseEntity[] => [{ id: `entity-${label}`, databaseId: id, title: label,
  documentId: null, fieldValues: {}, createdAt: '2026-10-01', updatedAt: '2026-10-01' }]
const views = (id: string): DatabaseSavedView[] => ['view', 'preferred'].map(suffix => ({ id: `${id}-${suffix}`, databaseId: id,
  name: suffix, config: createDefaultDatabaseViewConfig(), configVersion: 1, filterQuery: '', filterScope: '',
  sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0, createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
const catalog = (label: string): DocumentCatalogEntry[] => [{ id: label, title: label, path: label, summary: '', parentId: null,
  parentTitle: null, updatedAt: '2026-10-01', blockCount: 0, childCount: 0, linkCount: 0, fieldValues: {} }]
const home = (label: string) => ({ summary: { databasePath: label } } as HomeData)
type Model = { sourceId: string; columns: DocumentDatabaseColumn[]; entities: DatabaseEntity[]; views: DatabaseSavedView[];
  activeViewId: string; databases: DocumentDatabase[]; catalogColumns: DocumentDatabaseColumn[]; catalog: DocumentCatalogEntry[]; home: HomeData }
const initialModel = (): Model => ({ sourceId: 'a', columns: columns('a'), entities: entities('a', 'a'), views: views('a'), activeViewId: 'a-view',
  databases: ['catalog', 'a', 'b'].map(id => database(id)), catalogColumns: columns('initial-catalog'), catalog: catalog('initial'), home: home('initial') })
const request = () => ({ targetId: '', home: deferred<HomeData>(), documents: deferred<DocumentCatalogPage>(), databases: deferred<DocumentDatabase[]>(),
  columns: deferred<DocumentDatabaseColumn[]>(), entities: deferred<DatabaseEntity[]>(), views: deferred<DatabaseSavedView[]>() })
type Request = ReturnType<typeof request>

async function withPage(run: (context: {
  document: Document; requests: Request[]; mutations: string[]; model: () => Model;
  start: (targetId?: string, preferredViewId?: string, switchAfterRefresh?: string) => Promise<{ completion: Promise<void> }>;
  resolve: (request: Request, label: string, databaseIds?: string[]) => Promise<void>;
  navigate: (id: string) => Promise<void>; externalNavigate: (id: string) => Promise<void>;
  holdNavigation: () => void; flushNavigation: () => Promise<void>; unmount: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const requests: Request[] = []
  const mutations: string[] = []
  let current!: Model
  let updateModel!: (action: SetStateAction<Model>) => void
  let intent: { targetId?: string; preferredViewId?: string; switchAfterRefresh?: string } = {}
  let navigationId = ''
  let holdNavigation = false
  let heldId = ''
  let completion!: Promise<void>
  const applySource = (id: string) => updateModel(previous => ({ ...previous, sourceId: id,
    columns: columns(id), entities: entities(id, id), views: views(id), activeViewId: `${id}-view` }))
  const renderWorkspace = (props: WorkspaceProps) => createElement('div', null,
    createElement('button', { id: 'refresh', onClick: () => {
      const action = intent
      completion = (async () => {
        await props.onRefresh(action.targetId, action.preferredViewId)
        if (action.switchAfterRefresh) props.onCurrentDatabaseIdChange(action.switchAfterRefresh)
      })()
      void completion.catch(() => {})
    } }, 'Refresh'),
    createElement('button', { id: 'switch', onClick: () => props.onCurrentDatabaseIdChange(navigationId) }, 'Switch source'),
    createElement('output', { id: 'workspace' }, JSON.stringify({ source: props.currentDatabaseId,
      columns: props.selectedColumns.map(column => column.id), entities: props.entities.map(entity => entity.id),
      views: props.savedViews.map(view => view.id), activeView: props.activeViewId })))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, databasePageTestWorkspace: renderWorkspace })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const latestRequest = () => requests.at(-1)!
  Object.defineProperty(dom.window, 'knowbook', { value: {
    getHomeData: () => { const next = request(); requests.push(next); return next.home.promise },
    getDocumentCatalogPage: () => latestRequest().documents.promise,
    getDatabases: () => latestRequest().databases.promise,
    getDocumentDatabaseColumns: (id: string) => { latestRequest().targetId = id; return latestRequest().columns.promise },
    getDatabaseEntities: () => latestRequest().entities.promise,
    getDatabaseSavedViews: () => latestRequest().views.promise
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let mounted = true
  function Harness() {
    const [model, setModel] = useState(initialModel)
    current = model
    updateModel = setModel
    const change = <K extends keyof Model>(key: K, value: SetStateAction<Model[K]>) => {
      mutations.push(key)
      setModel(previous => ({ ...previous, [key]: typeof value === 'function'
        ? (value as (previous: Model[K]) => Model[K])(previous[key]) : value }))
    }
    const state = { databaseReady: true, databaseLoading: false, databaseError: null, databaseEntityDatabaseId: model.sourceId,
      databases: model.databases, selectedDatabaseColumns: model.columns, databaseEntities: model.entities,
      databaseSavedViews: model.views, activeDatabaseSavedViewId: model.activeViewId, selectedDatabaseEntityIds: [],
      setDatabases: (value: SetStateAction<DocumentDatabase[]>) => change('databases', value),
      setSelectedDatabaseColumns: (value: SetStateAction<DocumentDatabaseColumn[]>) => change('columns', value),
      setDatabaseEntities: (value: SetStateAction<DatabaseEntity[]>) => change('entities', value),
      setDatabaseSavedViews: (value: SetStateAction<DatabaseSavedView[]>) => change('views', value),
      setActiveDatabaseSavedViewId: (value: SetStateAction<string>) => change('activeViewId', value),
      setDatabaseEntityDatabaseId: (id: string) => { if (holdNavigation) heldId = id; else applySource(id) },
      setSelectedDatabaseEntityIds: () => {}, reloadDatabaseDomain: () => {} } as unknown as DatabaseDomainState
    return createElement(DatabasePage, { database: state, catalogColumns: model.catalogColumns, catalogDocuments: model.catalog,
      catalogLoading: false, catalogReady: true, catalogError: null, onRetryCatalog: () => {}, documentCatalog: [],
      onCatalogColumnsChange: value => change('catalogColumns', value), onCatalogDocumentsChange: value => change('catalog', value),
      onHomeDataChange: value => change('home', value), onMessage: () => {}, onOpenDocument: () => {}, selectedDocumentId: null,
      workspaceBoard: {} as DatabaseWorkspaceBoardState, ui: getUiText('en-US') })
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, requests, mutations, model: () => current, unmount,
      start: async (targetId, preferredViewId, switchAfterRefresh) => {
        intent = { targetId, preferredViewId, switchAfterRefresh }
        await act(async () => dom.window.document.getElementById('refresh')!.click())
        return { completion }
      },
      resolve: async (pending, label, databaseIds = ['catalog', 'a', 'b']) => {
        await act(async () => {
          const documents = catalog(label)
          pending.home.resolve(home(label))
          pending.documents.resolve({ entries: documents, total: documents.length, nextOffset: null })
          pending.databases.resolve(databaseIds.map(id => database(id, `-${label}`)))
          pending.columns.resolve(columns(label))
          pending.entities.resolve(entities(pending.targetId, label))
          pending.views.resolve(views(pending.targetId))
        })
      },
      navigate: async id => { navigationId = id; await act(async () => dom.window.document.getElementById('switch')!.click()) },
      externalNavigate: async id => { await act(async () => applySource(id)) },
      holdNavigation: () => { holdNavigation = true },
      flushNavigation: async () => { holdNavigation = false; await act(async () => applySource(heldId)) }
    })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('a late source A refresh cannot overwrite B target data or any global workspace data', async () => {
  await withPage(async ({ document, requests, mutations, model, start, resolve, navigate }) => {
    const pending = await start('a', 'a-preferred')
    await navigate('b')
    const before = structuredClone(model())
    mutations.length = 0
    await resolve(requests[0], 'old-a')
    await pending.completion
    assert.deepEqual(model(), before)
    assert.deepEqual(mutations, [])
    assert.match(document.getElementById('workspace')!.textContent!, /column-b/)
    assert.doesNotMatch(document.getElementById('workspace')!.textContent!, /old-a/)
  })
})

test('same-source out-of-order refreshes publish only the newest request and retain its preferred view', async () => {
  await withPage(async ({ requests, model, start, resolve }) => {
    const first = await start('a')
    const second = await start('a', 'a-preferred')
    await resolve(requests[1], 'new-a')
    await second.completion
    assert.equal(model().activeViewId, 'a-preferred')
    assert.equal(model().columns[0].id, 'column-new-a')
    const current = structuredClone(model())
    await resolve(requests[0], 'old-a')
    await first.completion
    assert.deepEqual(model(), current)
  })
})

test('ABA navigation invalidates the original A request even after A is selected again', async () => {
  await withPage(async ({ requests, model, start, resolve, navigate }) => {
    const old = await start('a')
    await navigate('b')
    await navigate('a')
    const fresh = await start('a')
    await resolve(requests[1], 'fresh-a')
    await fresh.completion
    const before = structuredClone(model())
    await resolve(requests[0], 'original-a')
    await old.completion
    assert.deepEqual(model(), before)
  })
})

test('source-change invalidation is synchronous before the parent commits its new source props', async () => {
  await withPage(async ({ requests, mutations, model, start, resolve, navigate, holdNavigation, flushNavigation }) => {
    const pending = await start('a')
    holdNavigation()
    await navigate('b')
    assert.equal(model().sourceId, 'a', 'the parent has not rendered B yet')
    mutations.length = 0
    await resolve(requests[0], 'old-a')
    await pending.completion
    assert.deepEqual(mutations, [])
    assert.equal(model().columns[0].id, 'column-a')
    await flushNavigation()
    assert.equal(model().sourceId, 'b')
  })
})

test('external source props invalidate an old request and an omitted target resolves against the latest source', async () => {
  await withPage(async ({ requests, model, start, resolve, externalNavigate }) => {
    const old = await start('a')
    await externalNavigate('b')
    await resolve(requests[0], 'old-a')
    await old.completion
    assert.equal(model().columns[0].id, 'column-b')
    const fresh = await start()
    assert.equal(requests[1].targetId, 'b')
    await resolve(requests[1], 'fresh-b')
    await fresh.completion
    assert.equal(model().columns[0].id, 'column-fresh-b')
  })
})

test('creating a cross-target database refreshes the global source list without publishing its records into the current source', async () => {
  await withPage(async ({ requests, model, start, resolve, navigate }) => {
    const pending = await start('created')
    await resolve(requests[0], 'created', ['catalog', 'a', 'b', 'created'])
    await pending.completion
    assert.ok(model().databases.some(item => item.id === 'created'))
    assert.equal(model().home.summary.databasePath, 'created')
    assert.equal(model().catalog[0].id, 'created')
    assert.equal(model().columns[0].id, 'column-a')
    assert.equal(model().entities[0].id, 'entity-a')
    assert.equal(model().activeViewId, 'a-view')
    await navigate('created')
    assert.equal(model().sourceId, 'created')
  })
})

test('deleting a source can refresh the fallback catalog globally before switching without replacing the old source target data', async () => {
  await withPage(async ({ requests, model, start, resolve, navigate }) => {
    const pending = await start('catalog')
    await resolve(requests[0], 'fallback', ['catalog', 'b'])
    await pending.completion
    assert.equal(model().databases.some(item => item.id === 'a'), false)
    assert.equal(model().catalogColumns[0].id, 'column-fallback')
    assert.equal(model().catalog[0].id, 'fallback')
    assert.equal(model().columns[0].id, 'column-a')
    assert.equal(model().views[0].databaseId, 'a')
    await navigate('catalog')
    assert.equal(model().sourceId, 'catalog')
  })
})

test('an immediate source switch after awaited cross-target refresh keeps the completed global data', async () => {
  for (const target of ['created', 'catalog']) {
    await withPage(async ({ requests, model, start, resolve }) => {
      const pending = await start(target, undefined, target)
      await resolve(requests[0], target, target === 'created' ? ['catalog', 'a', 'b', 'created'] : ['catalog', 'b'])
      await pending.completion
      assert.equal(model().sourceId, target)
      assert.ok(model().databases.some(item => item.id === target), 'the refreshed source must be present when navigation commits')
      assert.equal(model().catalog[0].id, target)
      assert.equal(model().home.summary.databasePath, target)
      if (target === 'catalog') assert.equal(model().catalogColumns[0].id, 'column-catalog')
    })
  }
})

test('unmounting discards pending data and late failures while a current request still rejects to its caller', async () => {
  await withPage(async ({ requests, mutations, start, resolve, unmount }) => {
    const pending = await start('a')
    await unmount()
    await resolve(requests[0], 'unmounted')
    await pending.completion
    assert.deepEqual(mutations, [])
  })
  await withPage(async ({ requests, model, start, navigate, unmount }) => {
    const stale = await start('a')
    await navigate('b')
    await act(async () => requests[0].columns.reject(new Error('Old source failed')))
    await assert.doesNotReject(stale.completion)
    assert.equal(model().columns[0].id, 'column-b')
    const current = await start('b')
    await act(async () => requests[1].columns.reject(new Error('Current source failed')))
    await assert.rejects(current.completion, /Current source failed/)
    const disposed = await start('b')
    await unmount()
    await act(async () => requests[2].columns.reject(new Error('Disposed source failed')))
    await assert.doesNotReject(disposed.completion)
  })
})
