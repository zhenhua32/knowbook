import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useEffect, useMemo, useState, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn, HomeData } from '../src/shared/contracts'
import type { DatabaseDomainState, DatabaseWorkspaceBoardState } from '../src/renderer/src/types/appDomains'
import type { DatabaseWorkspace } from '../src/renderer/src/features/database/DatabaseWorkspace'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { getUiText } from '../src/renderer/src/i18n'

// Keep the actual Page and domain hook. This small workspace makes its mount
// lifecycle observable without duplicating the view-form interaction tests.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('/features/database/DatabaseWorkspace.tsx')) return {
      format: 'module', source: 'export const DatabaseWorkspace = props => globalThis.createdSourceTestWorkspace(props)', shortCircuit: true
    }
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DatabasePage } = await import('../src/renderer/src/pages/DatabasePage')
const { useDatabaseDomainState } = await import('../src/renderer/src/hooks/useDatabaseDomainState')
const { useDatabaseViewDraft } = await import('../src/renderer/src/features/database/hooks/useDatabaseViewDraft')
const { adaptCustomFields } = await import('../src/renderer/src/features/database/model/databaseAdapters')
type WorkspaceProps = ComponentProps<typeof DatabaseWorkspace> & {
  onSavedDatabase?: (saved: DocumentDatabase, options?: { activate?: boolean }) => void
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const database = (id: string): DocumentDatabase => ({ id, kind: 'custom', name: `Database ${id}`, description: '',
  createdAt: '2026-10-01', updatedAt: '2026-10-01' })
const columns = (id: string): DocumentDatabaseColumn[] => [{ id: `${id}-field`, name: `${id} field`, type: 'text', options: [], sortOrder: 0 }]
const entities = (id: string): DatabaseEntity[] => [{ id: `${id}-row`, databaseId: id, title: `${id} row`, documentId: null,
  fieldValues: {}, createdAt: '2026-10-01', updatedAt: '2026-10-01' }]
const views = (id: string): DatabaseSavedView[] => [{ id: `${id}-view`, databaseId: id, name: `${id} view`,
  config: { ...createDefaultDatabaseViewConfig(), query: `${id} saved query` }, configVersion: 1,
  filterQuery: `${id} saved query`, filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
  createdAt: '2026-10-01', updatedAt: '2026-10-01' }]
type DataRead = { id: string; columns: ReturnType<typeof deferred<DocumentDatabaseColumn[]>>;
  entities: ReturnType<typeof deferred<DatabaseEntity[]>>; views: ReturnType<typeof deferred<DatabaseSavedView[]>> }
type Domain = ReturnType<typeof useDatabaseDomainState>
type Draft = ReturnType<typeof useDatabaseViewDraft>
const fieldLabels = { title: 'Title', path: 'Path', parent: 'Parent', linkedDocument: 'Document',
  blockCount: 'Blocks', linkCount: 'Links', childCount: 'Children', createdAt: 'Created', updatedAt: 'Updated' }
type Context = {
  document: Document; lists: Array<ReturnType<typeof deferred<DocumentDatabase[]>>>; reads: DataRead[];
  domain: () => Domain; draft: () => Draft; mounts: () => { mounts: number; unmounts: number };
  acknowledge: (saved: DocumentDatabase, activate?: boolean) => Promise<void>;
  resolveData: (read: DataRead) => Promise<void>; change: (action: () => void) => Promise<void>;
  navigate: (id: string) => Promise<void>
}

async function withCreatedSource(run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  dom.window.localStorage.setItem('knowbook.database.last-source', 'a')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const lists: Context['lists'] = []
  const reads: DataRead[] = []
  let current!: Domain
  let currentDraft!: Draft
  let workspace!: WorkspaceProps
  let mountCount = 0
  let unmountCount = 0
  const readFor = (id: string, kind: keyof Omit<DataRead, 'id'>) => {
    // The real domain starts entities first, then columns and views.
    let pending = reads.at(-1)
    if (kind === 'entities' || !pending || pending.id !== id) {
      pending = { id, columns: deferred<DocumentDatabaseColumn[]>(), entities: deferred<DatabaseEntity[]>(), views: deferred<DatabaseSavedView[]>() }
      reads.push(pending)
    }
    return pending
  }
  function ObservableWorkspace(props: WorkspaceProps) {
    workspace = props
    const fields = useMemo(() => adaptCustomFields(props.selectedColumns, fieldLabels), [props.selectedColumns])
    currentDraft = useDatabaseViewDraft({ databaseId: props.currentDatabaseId, fields, savedViews: props.savedViews,
      activeViewId: props.activeViewId, onActiveViewIdChange: props.onActiveViewIdChange, draftCache: props.viewDraftCache })
    useEffect(() => { mountCount++; return () => { unmountCount++ } }, [])
    return createElement('section', { id: 'observed-workspace', 'data-source': props.currentDatabaseId },
      createElement('button', { id: 'source-trigger', type: 'button' }, props.databases.find(item => item.id === props.currentDatabaseId)?.name),
      createElement('output', { id: 'target-data' }, JSON.stringify({ columns: props.selectedColumns.map(item => item.id),
        rows: props.entities.map(item => item.id), views: props.savedViews.map(item => item.id), active: props.activeViewId })))
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, createdSourceTestWorkspace: ObservableWorkspace })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    getDatabases: () => { const pending = deferred<DocumentDatabase[]>(); lists.push(pending); return pending.promise },
    getDatabaseEntities: (id: string) => readFor(id, 'entities').entities.promise,
    getDocumentDatabaseColumns: (id: string) => readFor(id, 'columns').columns.promise,
    getDatabaseSavedViews: (id: string) => readFor(id, 'views').views.promise
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  function Harness() {
    const domain = useDatabaseDomainState()
    current = domain
    const [home, setHome] = useState({ summary: { databasePath: 'test' } } as HomeData)
    void home
    return createElement(DatabasePage, { database: domain as unknown as DatabaseDomainState,
      catalogColumns: [], catalogDocuments: [], catalogLoading: false, catalogReady: true, catalogError: null,
      documentCatalog: [], onRetryCatalog: () => {}, onCatalogColumnsChange: () => {}, onCatalogDocumentsChange: () => {},
      onHomeDataChange: setHome, onMessage: () => {}, onOpenDocument: () => {}, selectedDocumentId: null,
      workspaceBoard: {} as DatabaseWorkspaceBoardState, ui: getUiText('en-US') })
  }
  const change = async (action: () => void) => { await act(async () => action()) }
  const resolveData = async (read: DataRead) => change(() => {
    read.columns.resolve(columns(read.id)); read.entities.resolve(entities(read.id)); read.views.resolve(views(read.id))
  })
  try {
    await act(async () => root.render(createElement(Harness)))
    assert.equal(lists.length, 1)
    await change(() => lists[0].resolve([database('a'), database('b')]))
    assert.equal(reads[0].id, 'a')
    await resolveData(reads[0])
    await change(() => { current.setActiveDatabaseSavedViewId('a-view'); current.setDatabaseEntityFilterQuery('Dirty A query');
      current.setSelectedDatabaseEntityIds(['a-row']) })
    assert.equal(current.databaseReady, true)
    assert.equal(dom.window.document.querySelectorAll('#observed-workspace').length, 1)
    await run({ document: dom.window.document, lists, reads, domain: () => current, draft: () => currentDraft,
      mounts: () => ({ mounts: mountCount, unmounts: unmountCount }), resolveData, change,
      navigate: async id => change(() => workspace.onCurrentDatabaseIdChange(id)),
      acknowledge: async (saved, activate = false) => change(() => {
        workspace.onSavedDatabase?.(saved, activate ? { activate: true } : undefined)
        if (activate) workspace.onCurrentDatabaseIdChange(saved.id)
      }) })
  } finally {
    await act(async () => root.unmount())
    await act(async () => {
      for (const list of lists) list.resolve([])
      for (const read of reads) { read.columns.resolve([]); read.entities.resolve([]); read.views.resolve([]) }
    })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('a confirmed empty database remains ready and keeps the real Page workspace mounted while its target reads are pending', async () => {
  await withCreatedSource(async ({ document, domain, mounts, reads, acknowledge, resolveData, change }) => {
    const before = domain()
    assert.equal(before.databaseEntities[0].id, 'a-row')
    assert.equal(before.databaseSavedViews[0].config.query, 'a saved query')
    assert.equal(before.databaseEntityFilterQuery, 'Dirty A query')
    const opener = document.getElementById('source-trigger')!
    await change(() => opener.focus())
    const lifecycle = mounts()
    await acknowledge(database('created'), true)
    assert.equal(domain().databaseEntityDatabaseId, 'created')
    assert.equal(domain().databaseReady, true, 'The confirmed empty source must not replace the workspace with the initial-loading screen')
    assert.equal(domain().databaseLoading, true, 'The normal target read still runs')
    assert.equal(domain().databases.some(item => item.id === 'created'), true)
    assert.deepEqual(domain().databaseEntities, [])
    assert.deepEqual(domain().selectedDatabaseColumns, [])
    assert.deepEqual(domain().databaseSavedViews, [])
    assert.deepEqual(domain().selectedDatabaseEntityIds, [])
    assert.equal(domain().activeDatabaseSavedViewId, '')
    assert.equal(document.getElementById('source-trigger') === opener, true)
    assert.equal(document.activeElement === opener, true)
    assert.deepEqual(mounts(), lifecycle)
    const target = reads.at(-1)!
    assert.equal(target.id, 'created')
    await resolveData(target)
    assert.equal(domain().databaseReady, true)
    assert.equal(domain().databaseEntities[0].databaseId, 'created')
    assert.equal(domain().selectedDatabaseColumns[0].id, 'created-field')
    assert.equal(domain().databaseSavedViews[0].databaseId, 'created')
    assert.deepEqual(mounts(), lifecycle)
  })
})

test('an older independent list read cannot remove an acknowledged database or replace the newly activated target data', async () => {
  await withCreatedSource(async ({ lists, reads, domain, acknowledge, change, resolveData }) => {
    await change(() => domain().reloadDatabaseDomain())
    assert.equal(lists.length, 2)
    const oldData = reads.at(-1)!
    assert.equal(oldData.id, 'a')
    await acknowledge(database('created'), true)
    const target = reads.at(-1)!
    assert.equal(target.id, 'created')
    await change(() => lists[1].resolve([database('a'), database('b')]))
    await resolveData(oldData)
    assert.equal(domain().databases.some(item => item.id === 'created'), true)
    assert.equal(domain().databaseEntityDatabaseId, 'created')
    assert.equal(domain().databaseReady, true)
    assert.deepEqual(domain().databaseEntities, [])
    assert.deepEqual(domain().selectedDatabaseColumns, [])
    assert.deepEqual(domain().databaseSavedViews, [])
    await resolveData(target)
    assert.equal(domain().databaseEntities[0].databaseId, 'created')
    assert.equal(domain().databaseError, null)
  })
})

test('a stale independent list failure after a metadata ACK ends loading without reporting an obsolete read error', async () => {
  await withCreatedSource(async ({ lists, reads, domain, acknowledge, change, resolveData }) => {
    await change(() => domain().reloadDatabaseDomain())
    const target = reads.at(-1)!
    await resolveData(target)
    const saved = { ...database('a'), name: 'Acknowledged metadata', description: 'New description' }
    await acknowledge(saved)
    await change(() => lists[1].reject(new Error('Obsolete list failure')))
    assert.deepEqual(domain().databases.find(item => item.id === 'a'), saved)
    assert.equal(domain().databaseError, null)
    assert.equal(domain().databaseLoading, false)
    assert.equal(domain().databaseReady, true)
    assert.equal(domain().databaseEntityDatabaseId, 'a')
    assert.equal(domain().databaseEntities[0].databaseId, 'a')
  })
})

test('the real view draft survives ordinary source-loading unmounts through the Page-owned cache after creating a database', async () => {
  await withCreatedSource(async ({ document, domain, draft, mounts, reads, acknowledge, resolveData, navigate, change }) => {
    assert.equal(draft().draft.query, 'a saved query')
    await change(() => draft().updateDraft(current => ({ ...current, query: 'Unsaved A Beta' })))
    assert.equal(draft().dirty, true)
    const beforeCreate = mounts()
    await acknowledge(database('created'), true)
    assert.equal(domain().databaseReady, true)
    assert.deepEqual(mounts(), beforeCreate)
    await resolveData(reads.at(-1)!)
    assert.equal(domain().databaseEntityDatabaseId, 'created')
    assert.equal(draft().draft.query, 'created saved query', 'The new source must not inherit A\'s unsaved query')
    await navigate('a')
    assert.equal(domain().databaseReady, false, 'Ordinary source navigation still uses the normal loading transition')
    assert.equal(document.querySelectorAll('#observed-workspace').length, 0)
    assert.equal(mounts().unmounts, beforeCreate.unmounts + 1)
    const target = reads.at(-1)!
    assert.equal(target.id, 'a')
    await resolveData(target)
    assert.equal(domain().databaseReady, true)
    assert.equal(document.querySelectorAll('#observed-workspace').length, 1)
    assert.equal(mounts().mounts, beforeCreate.mounts + 1)
    assert.equal(draft().draft.query, 'Unsaved A Beta')
    assert.equal(draft().baseConfig.query, 'a saved query')
    assert.equal(draft().dirty, true)
    assert.equal(domain().databaseSavedViews[0].config.query, 'a saved query', 'Returning to the source must not silently persist or rewrite its saved view')
    assert.equal(domain().databaseEntities[0].databaseId, 'a')
  })
})
