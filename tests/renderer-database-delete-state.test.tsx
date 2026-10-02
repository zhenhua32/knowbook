import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn } from '../src/shared/contracts'
import type { AppMessageHandler } from '../src/renderer/src/notify'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { setActiveUiLanguage } from '../src/renderer/src/i18n'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'
import type { DatabaseDeletion } from '../src/renderer/src/features/database/model/databaseDeletion'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
type Kind = 'database' | 'view' | 'field' | 'record' | 'records'
type Delete = ReturnType<typeof deferred<void>> & { kind: Kind; ids: string[]; databaseId: string }
type Model = {
  source: string; active: string; page: boolean; selected: string[]; databases: DocumentDatabase[]
  views: Record<string, DatabaseSavedView[]>; fields: Record<string, DocumentDatabaseColumn[]>; entities: Record<string, DatabaseEntity[]>
}
type Refresh = ReturnType<typeof deferred<void>> & { source: string; preferred?: string }
type Context = {
  document: Document; text: ReturnType<typeof getDatabaseWorkspaceText>; deletes: Delete[]; refreshes: Refresh[]
  messages: Array<{ message: Parameters<AppMessageHandler>[0]; level?: Parameters<AppMessageHandler>[1] }>
  sourceChanges: string[]; viewChanges: string[]; selectionChanges: string[][]
  acknowledgements: DatabaseDeletion[]
  model: () => Model; dialog: () => HTMLDialogElement; query: () => HTMLInputElement
  change: (run: () => void) => Promise<void>; fill: (input: HTMLInputElement, value: string) => Promise<void>
  open: (kind: Kind) => Promise<void>; confirm: (count?: number) => Promise<void>; cancel: () => Promise<void>
  resolveDelete: (index?: number) => Promise<void>; rejectDelete: (index?: number, message?: string) => Promise<void>
  resolveRefresh: (index?: number) => Promise<void>; rejectRefresh: (index?: number) => Promise<void>
  navigate: (source: string, active: string) => Promise<void>; leavePage: () => Promise<void>
  flushFrames: () => Promise<void>; unmount: () => Promise<void>
}
function savedView(source: string, suffix: string): DatabaseSavedView {
  const config = createDefaultDatabaseViewConfig('cards', [DATABASE_SYSTEM_FIELD_IDS.title, DATABASE_SYSTEM_FIELD_IDS.updatedAt, `${source}-field`])
  return { id: `${source}-${suffix}`, databaseId: source, name: `${source.toUpperCase()} ${suffix}`, config, configVersion: 1,
    filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'cards', sortOrder: 0, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
}
function source(id: string, kind: DocumentDatabase['kind'] = 'custom'): DocumentDatabase {
  return { id, kind, name: `Source ${id.toUpperCase()}`, description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' }
}
function entity(source: string, suffix: string): DatabaseEntity {
  return { id: `${source}-${suffix}`, databaseId: source, title: `Record ${source.toUpperCase()} ${suffix}`, documentId: null,
    createdAt: '2026-10-01', updatedAt: '2026-10-01', fieldValues: { [`${source}-field`]: `Value ${suffix}` } }
}

async function withDeletes(run: (context: Context) => Promise<void>, locale = 'en-US') {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside control">', { url: 'http://localhost' })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: requestFrame })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: cancelFrame })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 160, 32) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.closest('[hidden], [inert], [aria-hidden="true"]') ? [] : [this.getBoundingClientRect()]
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  let server: Omit<Model, 'source' | 'active' | 'page' | 'selected'> = {
    databases: [source('catalog', 'document-catalog'), source('a'), source('b')],
    views: { catalog: [savedView('catalog', 'primary')], a: [savedView('a', 'primary'), savedView('a', 'secondary')], b: [savedView('b', 'primary')] },
    fields: { catalog: [], a: [{ id: 'a-field', name: 'A field', type: 'text', options: [], sortOrder: 0 }], b: [] },
    entities: { catalog: [], a: [entity('a', 'one'), entity('a', 'two')], b: [entity('b', 'one')] }
  }
  const deletes: Delete[] = [], refreshes: Refresh[] = []
  const messages: Context['messages'] = [], sourceChanges: string[] = [], viewChanges: string[] = [], selectionChanges: string[][] = []
  const acknowledgements: DatabaseDeletion[] = []
  const mutate = (kind: Kind, ids: string[]) => {
    const request = { ...deferred<void>(), kind, ids: [...ids], databaseId: current.source }; deletes.push(request); return request.promise
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    deleteDatabase: (id: string) => mutate('database', [id]),
    deleteDatabaseSavedView: (id: string) => mutate('view', [id]),
    deleteDocumentDatabaseColumn: (id: string) => mutate('field', [id]),
    deleteDatabaseEntity: (id: string) => mutate('record', [id]),
    deleteDatabaseEntities: ({ entityIds }: { entityIds: string[] }) => mutate('records', entityIds)
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const text = getDatabaseWorkspaceText(locale)
  let mounted = true, sourceGeneration = 0, refreshGeneration = 0
  let current!: Model, updateModel!: (update: SetStateAction<Model>) => void
  const refresh = async (source = current.source, preferred?: string) => {
    const request = { ...deferred<void>(), source, preferred }, snapshot = clone(server)
    const generation = ++refreshGeneration, session = sourceGeneration
    refreshes.push(request)
    await request.promise
    if (!mounted || !current.page || generation !== refreshGeneration || session !== sourceGeneration || current.source !== source) return
    updateModel(previous => ({ ...previous, ...snapshot,
      active: snapshot.views[source]?.some(view => view.id === preferred) ? preferred! : previous.active }))
  }
  function Harness() {
    const [model, setModel] = useState<Model>(() => ({ ...clone(server), source: 'a', active: 'a-primary', selected: [], page: true }))
    current = model; updateModel = setModel
    if (!model.page) return createElement('p', { id: 'other-page' }, 'Documents')
    const props = {
      currentDatabaseId: model.source, activeViewId: model.active, databases: model.databases, savedViews: model.views[model.source] ?? [], locale,
      catalogColumns: [], catalogDocuments: [], entities: model.entities[model.source] ?? [], selectedColumns: model.fields[model.source] ?? [], selectedRecordIds: model.selected,
      onActiveViewIdChange: (active: string) => { viewChanges.push(active); setModel(previous => ({ ...previous, active })) },
      onCurrentDatabaseIdChange: (source: string) => { sourceChanges.push(source); sourceGeneration++; refreshGeneration++;
        setModel(previous => ({ ...previous, source, active: previous.views[source]?.[0]?.id ?? '' })) },
      onSelectedRecordIdsChange: (selected: string[]) => { selectionChanges.push([...selected]); setModel(previous => ({ ...previous, selected })) },
      onMessage: (message: Parameters<AppMessageHandler>[0], level?: Parameters<AppMessageHandler>[1]) => { messages.push({ message, level }) },
      onDeleted: async (deletion: DatabaseDeletion) => {
        if (!mounted || !current.page) return
        acknowledgements.push(clone(deletion)); refreshGeneration++
        const ids = deletion.kind === 'records' ? deletion.ids : [deletion.id]
        const fallback = current.databases.find(database => database.kind === 'document-catalog')!
        const switchesSource = deletion.kind === 'database' && current.source === deletion.id
        if (switchesSource) { sourceGeneration++; sourceChanges.push(fallback.id) }
        setModel(previous => ({ ...previous,
          databases: deletion.kind === 'database' ? previous.databases.filter(database => !ids.includes(database.id)) : previous.databases,
          views: deletion.kind === 'view' ? { ...previous.views, [deletion.databaseId]: previous.views[deletion.databaseId].filter(view => !ids.includes(view.id)) } : previous.views,
          fields: deletion.kind === 'field' ? { ...previous.fields, [deletion.databaseId]: previous.fields[deletion.databaseId].filter(field => !ids.includes(field.id)) } : previous.fields,
          entities: deletion.kind === 'record' || deletion.kind === 'records'
            ? { ...previous.entities, [deletion.databaseId]: previous.entities[deletion.databaseId].filter(entity => !ids.includes(entity.id)) } : previous.entities,
          selected: deletion.kind === 'record' || deletion.kind === 'records' ? previous.selected.filter(id => !ids.includes(id)) : switchesSource ? [] : previous.selected,
          source: switchesSource ? fallback.id : previous.source,
          active: switchesSource ? previous.views[fallback.id]?.[0]?.id ?? '' : previous.active
        }))
        await refresh(deletion.kind === 'database' ? switchesSource ? fallback.id : current.source : deletion.databaseId)
      },
      onRefresh: refresh, onOpenDocument: () => {}
    }
    return createElement(DatabaseWorkspace, props)
  }
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const flushFrames = async () => change(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) })
  const click = async (element: HTMLElement) => change(() => { element.focus(); element.click() })
  const dialog = () => { const element = dom.window.document.querySelector<HTMLDialogElement>('.app-confirm-dialog'); assert.ok(element); return element }
  const query = () => dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
  const unmount = async () => { if (mounted) { mounted = false; sourceGeneration++; refreshGeneration++; await act(async () => root.unmount()) } }
  try {
    setActiveUiLanguage(locale === 'zh-CN' ? 'zh-CN' : 'en-US')
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, text, deletes, refreshes, messages, sourceChanges, viewChanges, selectionChanges, acknowledgements,
      model: () => current, dialog, query, change, flushFrames, unmount,
      fill: async (input, value) => change(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
      open: async kind => {
        if (kind === 'database') {
          await click(dom.window.document.querySelector<HTMLButtonElement>('.dbw-header-actions .dbw-menu-wrap > button')!)
          const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-action-menu button')].find(item => item.textContent === text.deleteDatabase)!
          await click(button)
        } else if (kind === 'view') await click(dom.window.document.querySelector<HTMLButtonElement>('.dbw-view-tab-wrap.is-active .dbw-view-tab-menu')!)
        else if (kind === 'field') {
          if (!dom.window.document.querySelector('.dbw-field-drawer')) {
            const fieldsButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-toolbar-button')].find(button => button.textContent?.includes(text.fields))!
            await click(fieldsButton); await flushFrames()
          }
          const row = [...dom.window.document.querySelectorAll<HTMLElement>('.dbw-field-row')].find(row => row.querySelector('.dbw-field-name')?.textContent === 'A field')!
          await click(row.querySelector<HTMLButtonElement>(`button[aria-label="${text.deleteField}"]`)!)
        } else if (kind === 'record') {
          if (!dom.window.document.querySelector('.dbw-record-drawer')) {
            await click(dom.window.document.querySelector<HTMLButtonElement>('.dbw-card-body')!); await flushFrames()
          }
          await click(dom.window.document.querySelector<HTMLButtonElement>('.dbw-record-drawer .dbw-danger-quiet-button')!)
        } else {
          for (const checkbox of [...dom.window.document.querySelectorAll<HTMLInputElement>('.dbw-card-checkbox')]) if (!checkbox.checked) await click(checkbox)
          const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-selection-toolbar button')].find(item => item.textContent === text.deleteRecord)!
          await click(button)
        }
        assert.equal(dialog().open, true)
      },
      confirm: async (count = 1) => change(() => { const button = dialog().querySelector<HTMLButtonElement>('.danger-button')!;
        for (let index = 0; index < count; index++) button.click() }),
      cancel: async () => click(dialog().querySelector<HTMLButtonElement>('.secondary-button')!),
      resolveDelete: async (index = 0) => {
        const request = deletes[index]; assert.ok(request)
        if (request.kind === 'database') server = { ...server, databases: server.databases.filter(item => !request.ids.includes(item.id)) }
        else if (request.kind === 'view') server.views[request.databaseId] = server.views[request.databaseId].filter(item => !request.ids.includes(item.id))
        else if (request.kind === 'field') server.fields[request.databaseId] = server.fields[request.databaseId].filter(item => !request.ids.includes(item.id))
        else server.entities[request.databaseId] = server.entities[request.databaseId].filter(item => !request.ids.includes(item.id))
        await change(() => request.resolve())
      },
      rejectDelete: async (index = 0, message = 'Delete failed before writing.') => change(() => deletes[index].reject(new Error(`Error invoking remote method 'knowbook:delete': Error: ${message}`))),
      resolveRefresh: async (index = 0) => { assert.ok(refreshes[index]); await change(() => refreshes[index].resolve()) },
      rejectRefresh: async (index = 0) => { assert.ok(refreshes[index]); await change(() => refreshes[index].reject(new Error('Refresh unavailable.'))) },
      navigate: async (source, active) => change(() => { sourceGeneration++; refreshGeneration++; updateModel(previous => ({ ...previous, source, active, selected: [] })) }),
      leavePage: async () => change(() => { sourceGeneration++; refreshGeneration++; updateModel(previous => ({ ...previous, page: false })) }) })
  } finally {
    await unmount()
    await act(async () => { for (const request of deletes) request.resolve(); for (const request of refreshes) request.resolve() })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('a failed database deletion retains one named danger dialog and retries the mutation without same-frame duplication', async () => {
  for (const locale of ['en-US', 'zh-CN']) for (const kind of ['database', 'view', 'field', 'record', 'records'] as const) {
    await withDeletes(async context => {
      await context.open(kind)
      const currentDialog = context.dialog()
      const title = currentDialog.querySelector('h2')!
      assert.equal(currentDialog.getAttribute('aria-labelledby'), title.id)
      await context.confirm(2)
      assert.equal(context.deletes.length, 1)
      assert.equal(context.deletes[0].kind, kind)
      assert.equal(currentDialog.getAttribute('aria-busy'), 'true')
      await context.rejectDelete()
      assert.equal(context.dialog() === currentDialog, true)
      assert.equal(currentDialog.querySelector('[role="alert"]')!.textContent, 'Delete failed before writing.')
      assert.equal(currentDialog.querySelector('.danger-button')!.textContent, locale === 'zh-CN' ? '重试' : 'Retry')
      assert.equal(context.refreshes.length, 0)
      assert.equal(context.model().source, 'a')
      await context.confirm(2)
      assert.equal(context.deletes.length, 2)
      assert.deepEqual(context.deletes[1].ids, context.deletes[0].ids)
      assert.equal(context.messages.length, 0)
    }, locale)
  }
})

test('a deletion ACK followed by a read failure cannot offer Retry that deletes the same target again', async () => {
  for (const kind of ['database', 'view', 'field', 'record', 'records'] as const) await withDeletes(async context => {
    await context.open(kind)
    await context.confirm(2)
    await context.resolveDelete()
    const closedAtACK = context.document.querySelectorAll('.app-confirm-dialog').length === 0
    assert.equal(context.refreshes.length, 1, 'The real read is held after the successful mutation')
    await context.rejectRefresh()
    // Activate the actual retained Retry if the implementation still offers
    // it, so the baseline proves a second deletion rather than a CSS difference.
    if (context.document.querySelector('.app-confirm-dialog .danger-button')) await context.confirm()
    assert.equal(context.deletes.length, 1, 'A read failure must not issue another already-acknowledged deletion')
    assert.equal(closedAtACK, true, 'The destructive dialog must close before the held read settles')
    assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
    assert.equal(context.acknowledgements.length, 1)
    assert.deepEqual(context.messages, [{ message: 'Deleted, but the list could not be refreshed. Refresh the database.', level: 'error' }])
  })
})

test('all five deletion ACKs close danger immediately and update local data before held reads fail with a localized notification', async () => {
  for (const locale of ['en-US', 'zh-CN']) for (const kind of ['database', 'view', 'field', 'record', 'records'] as const) {
    await withDeletes(async context => {
      await context.open(kind)
      await context.confirm(2)
      await context.resolveDelete()
      assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
      assert.equal(context.refreshes.length, 1, 'The post-ACK read remains genuinely pending')
      assert.equal(context.acknowledgements.length, 1)
      assert.deepEqual(context.acknowledgements[0], kind === 'records'
        ? { databaseId: 'a', kind, ids: ['a-one', 'a-two'] }
        : { databaseId: 'a', kind, id: kind === 'database' ? 'a' : kind === 'view' ? 'a-primary' : kind === 'field' ? 'a-field' : 'a-one' })
      const model = context.model()
      if (kind === 'database') {
        assert.equal(model.databases.some(database => database.id === 'a'), false)
        assert.equal(model.source, 'catalog')
      } else {
        assert.equal(context.document.activeElement === context.query(), true, 'Owned completion returns to the current source query')
        if (kind === 'view') {
          assert.equal(model.views.a.some(view => view.id === 'a-primary'), false)
          assert.equal(model.active, 'a-secondary')
        } else if (kind === 'field') {
          assert.equal(model.fields.a.length, 0)
          assert.equal(context.document.querySelectorAll('.dbw-field-drawer').length, 0)
        } else {
          assert.equal(model.entities.a.some(record => record.id === 'a-one'), false)
          assert.equal(model.entities.a.length, kind === 'records' ? 0 : 1)
          assert.equal(context.document.querySelectorAll('.dbw-record-drawer').length, 0)
          assert.deepEqual(model.selected, [])
        }
      }
      await context.change(() => context.query().focus())
      await context.rejectRefresh()
      await context.flushFrames()
      assert.equal(context.document.activeElement === context.query(), true)
      assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
      assert.equal(context.deletes.length, 1)
      assert.deepEqual(context.messages, [{ message: locale === 'zh-CN' ? '已删除，但列表刷新失败，请刷新数据库。'
        : 'Deleted, but the list could not be refreshed. Refresh the database.', level: 'error' }])
    }, locale)
  }
})

test('late deletion writes and failures cannot navigate, clear a newer selection or reclaim focus after source/view/page/unmount changes', async () => {
  for (const transition of ['source', 'view', 'page', 'unmount'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    await withDeletes(async context => {
      await context.open('view')
      await context.confirm()
      if (transition === 'source') await context.navigate('b', 'b-primary')
      else if (transition === 'view') await context.navigate('a', 'a-secondary')
      else if (transition === 'page') await context.leavePage()
      else await context.unmount()
      assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
      let focused: HTMLElement
      if (transition === 'source' || transition === 'view') {
        const checkbox = context.document.querySelector<HTMLInputElement>('.dbw-card-checkbox')!
        await context.change(() => checkbox.click())
        await context.fill(context.query(), 'Record')
        focused = context.query()
      } else focused = context.document.getElementById('outside')!
      await context.change(() => focused.focus())
      const before = { source: context.model().source, active: context.model().active, selected: [...context.model().selected],
        sourceCalls: context.sourceChanges.length, viewCalls: context.viewChanges.length, selectionCalls: context.selectionChanges.length }
      if (outcome === 'resolve') await context.resolveDelete()
      else await context.rejectDelete(0, 'Old target failure must stay silent.')
      for (let index = 0; index < context.refreshes.length; index++) await context.rejectRefresh(index)
      await context.flushFrames()
      assert.equal(context.model().source, before.source)
      assert.equal(context.model().active, before.active)
      assert.deepEqual(context.model().selected, before.selected)
      assert.equal(context.sourceChanges.length, before.sourceCalls)
      assert.equal(context.viewChanges.length, before.viewCalls)
      assert.equal(context.selectionChanges.length, before.selectionCalls)
      assert.equal(context.document.activeElement === focused, true)
      assert.equal(context.messages.length, 0)
      assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
      assert.equal(context.deletes.length, 1)
    })
  }
})

test('an old pending deletion cannot close or publish errors into the new source danger dialog or release its current request', async () => {
  for (const outcome of ['resolve', 'reject'] as const) await withDeletes(async context => {
    await context.open('view')
    await context.confirm()
    await context.navigate('b', 'b-primary')
    await context.open('record')
    const newerDialog = context.dialog()
    await context.confirm(2)
    assert.equal(context.deletes.length, 2)
    assert.deepEqual(context.deletes[1].ids, ['b-one'])
    if (outcome === 'resolve') await context.resolveDelete(0)
    else await context.rejectDelete(0, 'Old target failure must stay silent.')
    for (let index = 0; index < context.refreshes.length; index++) await context.rejectRefresh(index)
    await context.flushFrames()
    assert.equal(context.dialog() === newerDialog, true)
    assert.equal(newerDialog.getAttribute('aria-busy'), 'true')
    assert.equal(newerDialog.querySelectorAll('[role="alert"]').length, 0)
    assert.equal(newerDialog.contains(context.document.activeElement), true)
    assert.equal(context.model().source, 'b')
    assert.equal(context.messages.length, 0)
    await context.confirm()
    assert.equal(context.deletes.length, 2, 'Finishing the old request must not unlock the newer confirmation')
    await context.rejectDelete(1, 'New target failure.')
    assert.equal(context.dialog() === newerDialog, true)
    assert.equal(newerDialog.querySelector('[role="alert"]')!.textContent, 'New target failure.')
  })
})

test('an acknowledged deletion read cannot affect a newer selection or danger dialog while its own mutation is pending', async () => {
  await withDeletes(async context => {
    await context.open('record')
    await context.confirm()
    await context.resolveDelete()
    assert.equal(context.refreshes.length, 1)
    assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
    await context.open('records')
    assert.deepEqual(context.model().selected, ['a-two'])
    const newerDialog = context.dialog()
    await context.confirm()
    await context.rejectRefresh(0)
    await context.flushFrames()
    assert.equal(context.dialog() === newerDialog, true)
    assert.equal(newerDialog.getAttribute('aria-busy'), 'true')
    assert.equal(newerDialog.contains(context.document.activeElement), true)
    assert.deepEqual(context.model().selected, ['a-two'])
    assert.equal(context.messages.length, 0)
    assert.equal(context.deletes.length, 2)
    await context.rejectDelete(1, 'New selected target failed.')
    assert.equal(newerDialog.querySelector('[role="alert"]')!.textContent, 'New selected target failed.')
    assert.deepEqual(context.model().selected, ['a-two'])
  })
})

test('older read snapshots cannot resurrect records removed by a later deletion ACK', async () => {
  await withDeletes(async context => {
    await context.open('record')
    await context.confirm()
    await context.resolveDelete()
    assert.equal(context.model().entities.a.length, 1)
    await context.open('record')
    await context.confirm()
    assert.deepEqual(context.deletes[1].ids, ['a-two'])
    await context.resolveDelete(1)
    assert.equal(context.model().entities.a.length, 0)
    assert.equal(context.refreshes.length, 2)
    await context.change(() => context.query().focus())
    await context.resolveRefresh(0)
    assert.equal(context.model().entities.a.length, 0)
    assert.equal(context.document.querySelectorAll('.dbw-record-card').length, 0)
    await context.resolveRefresh(1)
    await context.flushFrames()
    assert.equal(context.model().entities.a.length, 0)
    assert.equal(context.document.activeElement === context.query(), true)
    assert.equal(context.deletes.length, 2)
    assert.equal(context.acknowledgements.length, 2)
    assert.equal(context.messages.length, 0)
  })
})

test('Cancel and Escape keep actual targets intact, while Escape during a pending mutation does not cancel or duplicate it', async () => {
  for (const kind of ['database', 'view', 'field', 'record', 'records'] as const) await withDeletes(async context => {
    await context.open(kind)
    const before = clone(context.model())
    const escape = new context.document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await context.change(() => context.dialog().dispatchEvent(escape))
    assert.equal(escape.defaultPrevented, true)
    assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
    assert.deepEqual(context.model(), before)
    assert.equal(context.deletes.length, 0)
    await context.open(kind)
    await context.cancel()
    assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
    assert.equal(context.deletes.length, 0)
    await context.open(kind)
    await context.confirm()
    const pending = context.dialog()
    const pendingEscape = new context.document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await context.change(() => pending.dispatchEvent(pendingEscape))
    assert.equal(context.dialog() === pending, true)
    assert.equal(context.deletes.length, 1)
    await context.rejectDelete()
    await context.cancel()
    assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 0)
    assert.equal(context.deletes.length, 1)
    assert.equal(context.refreshes.length, 0)
  })
})
