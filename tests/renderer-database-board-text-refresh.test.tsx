import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, Fragment, useReducer, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentCatalogEntry, DocumentDatabase, DocumentDatabaseColumn,
  UpdateDatabaseEntityInput, UpdateDocumentDatabaseValueInput } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { appNotifications } from '../src/renderer/src/app-notifications'
import { notify } from '../src/renderer/src/notify'
import { getActiveUiText, setActiveUiLanguage, type UiLanguage } from '../src/renderer/src/i18n'
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
const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Payload = { kind: 'custom'; payload: UpdateDatabaseEntityInput } | { kind: 'catalog'; payload: UpdateDocumentDatabaseValueInput }
type Write = ReturnType<typeof deferred<DatabaseEntity | void>> & Payload & { source: string }
type Read = ReturnType<typeof deferred<void>> & { source: string; preferred: string | undefined; canApply: () => boolean }
type Model = { source: string; view: string; shown: boolean; entities: DatabaseEntity[]; documents: DocumentCatalogEntry[] }
const notes: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }

function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) {
    appNotifications.dismiss(id)
  }
  appNotifications.clearCompleted()
}

async function withBoard(run: (context: {
  document: Document; window: JSDOM['window']; writes: Write[]; reads: Read[]
  outside: HTMLInputElement
  disk: (source?: string) => DatabaseEntity[] | DocumentCatalogEntry[]
  selected: () => { source: string; view: string }
  drop: (title: string, group: string) => Promise<void>; ack: (index: number) => Promise<void>
  read: (index: number, reason?: unknown) => Promise<void>; fail: (index: number, reason: unknown) => Promise<void>
  navigate: (source: string) => Promise<void>; leave: () => Promise<void>; selectView: (layout: 'board' | 'table') => Promise<void>
  query: () => HTMLInputElement; fillQuery: (value: string) => Promise<void>
}) => Promise<void>, options: { kind: 'custom' | 'catalog'; locale: UiLanguage; ungrouped?: boolean; select?: boolean }) {
  clearNotifications()
  const language = getActiveUiText().language
  setActiveUiLanguage(options.locale)
  const dom = new JSDOM('<div id="mount"></div><input id="outside">', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const sources: DocumentDatabase[] = ['a', 'b', 'catalog'].map(id => ({ id, kind: id === 'catalog' ? 'document-catalog' : 'custom',
    name: `Source ${id}`, description: 'Source metadata', createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(['a', 'b'].map(source => [source,
    [{ id: 'target', databaseId: source, title: 'Target', documentId: null,
      fieldValues: { notes: 'Old group', hidden: 'Hidden target metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' },
    { id: 'other', databaseId: source, title: 'Other', documentId: null,
      fieldValues: { notes: 'New group', hidden: 'Hidden other metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' },
    ...(options.ungrouped ? [{ id: 'blank', databaseId: source, title: 'Blank', documentId: null,
      fieldValues: { notes: null, hidden: 'Hidden blank metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }] : [])]]))
  let catalog: DocumentCatalogEntry[] = (options.ungrouped ? ['target', 'other', 'blank'] : ['target', 'other'])
    .map((id, index) => ({ id, title: index === 0 ? 'Target' : index === 1 ? 'Other' : 'Blank',
    path: `Parent/${id}`, summary: `Preserved ${id} summary`, parentId: 'parent', parentTitle: 'Parent', updatedAt: '2026-10-01',
    blockCount: 3 + index, childCount: index, linkCount: 2 + index,
    fieldValues: { notes: index === 0 ? 'Old group' : index === 1 ? 'New group' : null, hidden: `Hidden ${id} metadata` } }))
  const columns: DocumentDatabaseColumn[] = [options.select ? { ...notes, type: 'select', options: ['Old group', 'New group'] } : notes]
  const view = (source: string, layout: 'board' | 'table'): DatabaseSavedView => ({ id: `${source}-${layout}`, databaseId: source,
    name: `Records ${layout}`, config: { ...createDefaultDatabaseViewConfig(layout, [DATABASE_SYSTEM_FIELD_IDS.title, notes.id]),
      groupBy: { fieldId: layout === 'board' ? notes.id : null } }, configVersion: 1,
    filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: layout, sortOrder: 0,
    createdAt: '2026-10-01', updatedAt: '2026-10-01' })
  const savedViews = sources.flatMap(source => [view(source.id, 'board'), view(source.id, 'table')])
  const initialSource = options.kind === 'catalog' ? 'catalog' : 'a'
  const writes: Write[] = [], reads: Read[] = []
  let model!: Model, setModel!: (action: SetStateAction<Model>) => void
  const capture = (payload: Payload) => {
    const request: Write = { ...deferred<DatabaseEntity | void>(), source: model.source, ...structuredClone(payload) }
    writes.push(request); return request.promise
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (payload: UpdateDatabaseEntityInput) => capture({ kind: 'custom', payload }),
    updateDocumentDatabaseValue: (payload: UpdateDocumentDatabaseValueInput) => capture({ kind: 'catalog', payload }),
    onPluginNotification: () => () => {}, onBackupHealth: () => () => {},
    getBackupHealth: async () => ({ revision: 0, error: null })
  } })
  const refresh = async (source = model.source, preferred?: string, shouldContinue?: () => boolean) => {
    const request: Read = { ...deferred<void>(), source, preferred, canApply: shouldContinue ?? (() => true) }
    reads.push(request)
    await request.promise
    if (!request.canApply() || model.source !== source || !model.shown) return false
    const entities = structuredClone(server[source] ?? []), documents = structuredClone(catalog)
    setModel(previous => request.canApply() && previous.source === source && previous.shown
      ? { ...previous, entities, documents, view: preferred ?? previous.view } : previous)
    return true
  }
  function Harness() {
    const [current, update] = useReducer((previous: Model, action: SetStateAction<Model>) =>
      typeof action === 'function' ? action(previous) : action,
    { source: initialSource, view: `${initialSource}-board`, shown: true,
      entities: structuredClone(server[initialSource] ?? []), documents: structuredClone(catalog) })
    model = current; setModel = update
    return createElement(Fragment, null, current.shown ? createElement(DatabaseWorkspace, {
      currentDatabaseId: current.source, activeViewId: current.view, databases: sources,
      savedViews: savedViews.filter(view => view.databaseId === current.source),
      entities: current.entities, catalogDocuments: current.documents, catalogColumns: columns, selectedColumns: columns,
      selectedRecordIds: [], locale: options.locale, onRefresh: refresh, onMessage: notify,
      onActiveViewIdChange: view => update(previous => ({ ...previous, view })),
      onCurrentDatabaseIdChange: source => update(previous => ({ ...previous, source, view: `${source}-board`,
        entities: structuredClone(server[source] ?? []) })), onOpenDocument: () => {}, onSelectedRecordIdsChange: () => {}
    }) : null, createElement(AppNotificationHost, { isZh: options.locale === 'zh-CN', onOpenDocument: () => {} }))
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const query = () => {
    const input = dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')
    assert.ok(input); return input
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, window: dom.window, writes, reads,
      outside: dom.window.document.getElementById('outside') as HTMLInputElement,
      disk: (source = initialSource) => structuredClone(source === 'catalog' ? catalog : server[source]),
      selected: () => ({ source: model.source, view: model.view }),
      drop: async (title, group) => {
        const card = [...dom.window.document.querySelectorAll<HTMLElement>('.dbw-board-card')]
          .find(item => item.querySelector('strong')?.textContent === title)
        const destination = [...dom.window.document.querySelectorAll<HTMLElement>('.dbw-board-column')]
          .find(item => item.querySelector('header strong')?.textContent === group)
        assert.ok(card); assert.ok(destination)
        await act(async () => card.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true })))
        await act(async () => destination.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true })))
      },
      ack: async index => {
        const request = writes[index]; assert.ok(request)
        let result: DatabaseEntity | undefined
        if (request.kind === 'catalog') {
          const payload = request.payload
          catalog = catalog.map(entry => entry.id === payload.documentId
            ? { ...entry, fieldValues: { ...entry.fieldValues, [payload.columnId]: payload.value } } : entry)
        } else {
          const payload = request.payload
          server[request.source] = server[request.source].map(entity => entity.id === payload.entityId
            ? { ...entity, fieldValues: { ...entity.fieldValues, ...payload.fieldValues }, updatedAt: '2026-10-02' } : entity)
          result = server[request.source].find(entity => entity.id === payload.entityId)
        }
        await act(async () => request.resolve(result && structuredClone(result)))
      },
      read: async (index, reason) => { assert.ok(reads[index]); await act(async () => {
        if (reason !== undefined) reads[index].reject(reason)
        else reads[index].resolve()
      }) },
      fail: async (index, reason) => { assert.ok(writes[index]); await act(async () => writes[index].reject(reason)) },
      navigate: async source => {
        const trigger = dom.window.document.querySelector<HTMLButtonElement>('.dbw-source-trigger')
        assert.ok(trigger)
        await act(async () => trigger.click())
        const text = getDatabaseWorkspaceText(options.locale)
        const option = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-source-option')]
          .find(item => item.querySelector('strong')?.textContent === (source === 'catalog' ? text.allDocuments : `Source ${source}`))
        assert.ok(option)
        await act(async () => option.click())
        assert.equal(model.source, source)
      },
      leave: async () => { await act(async () => setModel(previous => ({ ...previous, shown: false }))) },
      selectView: async layout => {
        const button = dom.window.document.querySelector<HTMLButtonElement>(`.dbw-view-tab[title="Records ${layout}"]`)
        assert.ok(button)
        await act(async () => button.click())
        assert.equal(model.view, `${model.source}-${layout}`)
      },
      query,
      fillQuery: async value => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(query(), value)
        query().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) }
    })
  } finally {
    await act(async () => root.unmount())
    await act(async () => { writes.forEach(request => request.resolve(undefined)); reads.forEach(request => request.resolve()) })
    clearNotifications()
    setActiveUiLanguage(language)
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('Board text write failure reports its original domain reason, reads nothing, and an explicit new drop can succeed once', async () => {
  for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
    await withBoard(async ({ document, writes, reads, disk, drop, fail, ack, read }) => {
      const original = disk(), text = getDatabaseWorkspaceText(options.locale)
      await drop('Target', 'New group')
      const cause = new Error('The destination cannot be saved right now')
      await fail(0, cause)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 0)
      assert.deepEqual(disk(), original)
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(appNotifications.getSnapshot()[0].message, cause.message)
      assert.notEqual(appNotifications.getSnapshot()[0].message, text.formFailed)
      await waitForRenderer(() => document.querySelector('.app-notification-message')?.textContent === cause.message,
        'The notification Host must render the failed Board write before inspecting its message')
      assert.equal(document.querySelector('.app-notification-message')?.textContent, cause.message)
      assert.equal(document.querySelector('.dbw-text-cell-feedback'), null)
      await drop('Target', 'New group')
      assert.equal(writes.length, 2)
      await ack(1)
      assert.equal(reads.length, 1)
      await read(0)
      const target = [...document.querySelectorAll('.dbw-board-card')]
        .find(card => card.querySelector('strong')?.textContent === 'Target')
      assert.equal(target?.closest('.dbw-board-column')?.querySelector('header strong')?.textContent, 'New group')
      assert.equal(document.querySelectorAll('.dbw-board-card').length, 2)
      assert.deepEqual(disk(), original.map(record => record.id === 'target'
        ? { ...record, fieldValues: { ...record.fieldValues, notes: 'New group' },
          ...(options.kind === 'custom' ? { updatedAt: '2026-10-02' } : {}) } : record))
      assert.equal(writes.length, 2)
      assert.equal(reads.length, 1)
      assert.equal(appNotifications.getSnapshot().length, 1)
    }, options)
  }
})

test('Board text ACK followed by read failure keeps the saved backend and emits exactly one localized saved-refresh warning', async () => {
  for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
    await withBoard(async ({ document, writes, reads, disk, drop, ack, read, query }) => {
      const original = disk(), text = getDatabaseWorkspaceText(options.locale)
      await drop('Target', 'New group')
      await ack(0)
      assert.equal(reads.length, 1)
      assert.equal(reads[0].preferred, undefined)
      await act(async () => { query().focus(); query().setSelectionRange(0, 0) })
      const focused = query()
      await read(0, new Error('Isolated read failed after the durable ACK'))
      assert.equal(document.activeElement, focused)
      assert.equal(writes.length, 1, 'a failed read must never repeat the accepted mutation')
      assert.equal(reads.length, 1)
      assert.deepEqual(disk(), original.map(record => record.id === 'target'
        ? { ...record, fieldValues: { ...record.fieldValues, notes: 'New group' },
          ...(options.kind === 'custom' ? { updatedAt: '2026-10-02' } : {}) } : record))
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(appNotifications.getHistorySnapshot().length, 1)
      assert.equal(appNotifications.getSnapshot()[0].message, text.savedRefreshFailed)
      assert.notEqual(appNotifications.getSnapshot()[0].message, text.formFailed)
      assert.equal(document.querySelector('.app-notification-message')?.textContent, text.savedRefreshFailed)
      assert.equal(document.querySelector('.dbw-text-cell-feedback'), null)
    }, options)
  }
})

test('same-source view or layout and query changes survive a Board text refresh without moving the new input focus', async () => {
  for (const change of ['view', 'layout'] as const) {
    for (const phase of ['write-pending', 'read-pending'] as const) {
      await withBoard(async ({ document, writes, reads, disk, selected, drop, ack, read, selectView, query, fillQuery }) => {
        const original = disk()
        await drop('Target', 'New group')
        if (phase === 'read-pending') {
          await ack(0)
          assert.equal(reads.length, 1)
        }
        if (change === 'view') await selectView('table')
        else {
          const table = document.querySelector<HTMLButtonElement>('.dbw-layout-switcher button[aria-label="Table"]')
          assert.ok(table)
          await act(async () => table.click())
        }
        assert.ok(document.querySelector('.dbw-table'))
        const current = selected()
        assert.equal(current.view, change === 'view' ? 'a-table' : 'a-board')
        await act(async () => query().focus())
        await fillQuery('Other')
        const focused = query()
        await act(async () => focused.setSelectionRange(1, 4))
        if (phase === 'write-pending') await ack(0)
        assert.equal(reads.length, 1)
        assert.equal(reads[0].preferred, undefined)
        await read(0)
        assert.deepEqual(selected(), current)
        assert.equal(document.activeElement, focused)
        assert.equal(query(), focused)
        assert.equal(focused.value, 'Other')
        assert.deepEqual([focused.selectionStart, focused.selectionEnd], [1, 4])
        assert.ok(document.querySelector('.dbw-table'))
        assert.equal(document.querySelector('[data-testid="database-board-view"]'), null)
        const titles = [...document.querySelectorAll('.dbw-table .dbw-record-title strong')].map(item => item.textContent)
        assert.deepEqual(titles, ['Other'])
        assert.equal(writes.length, 1)
        assert.equal(reads.length, 1)
        assert.deepEqual(disk(), original.map(record => record.id === 'target'
          ? { ...record, fieldValues: { ...record.fieldValues, notes: 'New group' }, updatedAt: '2026-10-02' } : record))
        assert.equal(appNotifications.getSnapshot().length, 0)
      }, { kind: 'custom', locale: 'en-US' })
    }
  }
})

test('late Board text ACK after source departure, source ABA, or Workspace unmount performs no old refresh or notification', async () => {
  for (const transition of ['source', 'source-aba', 'unmount'] as const) {
    await withBoard(async ({ document, outside, writes, reads, disk, selected, drop, ack, navigate, leave, query, fillQuery }) => {
      const originalA = disk('a'), originalB = disk('b')
      await drop('Target', 'New group')
      if (transition === 'unmount') {
        await leave()
        await act(async () => outside.focus())
      } else {
        await navigate('b')
        if (transition === 'source-aba') await navigate('a')
        await act(async () => query().focus())
        await fillQuery('Other')
      }
      const focus = document.activeElement, selection = selected()
      const titles = [...document.querySelectorAll('.dbw-board-card strong')].map(item => item.textContent)
      await ack(0)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 0)
      assert.equal(document.activeElement, focus)
      assert.deepEqual(selected(), selection)
      assert.deepEqual([...document.querySelectorAll('.dbw-board-card strong')].map(item => item.textContent), titles)
      if (transition !== 'unmount') assert.equal(query().value, 'Other')
      assert.deepEqual(disk('a'), originalA.map(record => record.id === 'target'
        ? { ...record, fieldValues: { ...record.fieldValues, notes: 'New group' }, updatedAt: '2026-10-02' } : record))
      assert.deepEqual(disk('b'), originalB)
      assert.equal(appNotifications.getSnapshot().length, 0)
      assert.equal(appNotifications.getHistorySnapshot().length, 0)
      assert.equal(document.querySelector('.app-notification-message'), null)
    }, { kind: 'custom', locale: 'en-US' })
  }
})

test('pending Board text read permanently loses publication ownership on source departure, ABA, or unmount, including read rejection', async () => {
  for (const transition of ['source', 'source-aba', 'unmount'] as const) {
    for (const failed of [false, true]) {
      await withBoard(async ({ document, outside, writes, reads, disk, selected, drop, ack, read, navigate, leave, query, fillQuery }) => {
        const originalB = disk('b')
        await drop('Target', 'New group')
        await ack(0)
        assert.equal(reads.length, 1)
        assert.equal(reads[0].canApply(), true)
        const saved = disk('a')
        if (transition === 'unmount') {
          await leave()
          await act(async () => outside.focus())
        } else {
          await navigate('b')
          if (transition === 'source-aba') await navigate('a')
          await act(async () => query().focus())
          await fillQuery('Other')
        }
        assert.equal(reads[0].canApply(), false)
        const focus = document.activeElement, selection = selected()
        const titles = [...document.querySelectorAll('.dbw-board-card strong')].map(item => item.textContent)
        await read(0, failed ? new Error('The obsolete source read failed') : undefined)
        assert.equal(reads[0].canApply(), false)
        assert.equal(document.activeElement, focus)
        assert.deepEqual(selected(), selection)
        assert.deepEqual([...document.querySelectorAll('.dbw-board-card strong')].map(item => item.textContent), titles)
        if (transition !== 'unmount') assert.equal(query().value, 'Other')
        assert.deepEqual(disk('a'), saved)
        assert.deepEqual(disk('b'), originalB)
        assert.equal(writes.length, 1)
        assert.equal(reads.length, 1)
        assert.equal(appNotifications.getSnapshot().length, 0)
        assert.equal(appNotifications.getHistorySnapshot().length, 0)
      }, { kind: 'custom', locale: 'en-US' })
    }
  }
})

test('a non-text select Board drop retains its existing single-refresh path without a second read', async () => {
  for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
    await withBoard(async ({ document, writes, reads, disk, selected, drop, ack, read }) => {
      const original = disk(), selection = selected()
      await drop('Target', 'New group')
      assert.equal(writes.length, 1)
      await ack(0)
      assert.equal(reads.length, 1)
      assert.equal(reads[0].preferred, selection.view, 'the established non-text mutation contract is preserved')
      await read(0)
      const target = [...document.querySelectorAll('.dbw-board-card')]
        .find(card => card.querySelector('strong')?.textContent === 'Target')
      assert.equal(target?.closest('.dbw-board-column')?.querySelector('header strong')?.textContent, 'New group')
      assert.equal(document.querySelectorAll('.dbw-board-card').length, 2)
      assert.deepEqual(disk(), original.map(record => record.id === 'target'
        ? { ...record, fieldValues: { ...record.fieldValues, notes: 'New group' },
          ...(options.kind === 'custom' ? { updatedAt: '2026-10-02' } : {}) } : record))
      assert.deepEqual(selected(), selection)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 1)
      assert.equal(appNotifications.getSnapshot().length, 0)
    }, { ...options, select: true })
  }
})

for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
  test(`a ${options.kind} Board text drop reads its acknowledged value and moves only the target card`, async () => {
    await withBoard(async ({ document, writes, reads, disk, selected, drop, ack, read }) => {
      const original = disk(), originalOtherSource = disk('b'), originalSelection = selected()
      assert.equal(document.querySelectorAll('.dbw-board-card').length, 2)
      await drop('Target', 'New group')
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 0)
      assert.equal(writes[0].kind, options.kind)
      assert.deepEqual(writes[0].payload, options.kind === 'custom'
        ? { entityId: 'target', fieldValues: { notes: 'New group' } }
        : { documentId: 'target', columnId: 'notes', value: 'New group' })
      await ack(0)
      const expected = original.map(record => record.id === 'target'
        ? { ...record, fieldValues: { ...record.fieldValues, notes: 'New group' },
          ...(options.kind === 'custom' ? { updatedAt: '2026-10-02' } : {}) } : record)
      assert.deepEqual(disk(), expected)
      assert.deepEqual(disk('b'), originalOtherSource)
      assert.equal(reads.length, 1, 'a durable Board write ACK must be followed by a real refresh')
      assert.equal(reads[0].source, originalSelection.source)
      assert.equal(reads[0].preferred, undefined, 'the refresh must not reselect the view captured before the drop')
      await read(0)
      const cards = [...document.querySelectorAll('.dbw-board-card')]
      assert.equal(cards.length, 2)
      const target = cards.find(card => card.querySelector('strong')?.textContent === 'Target')
      assert.ok(target)
      assert.equal(target.closest('.dbw-board-column')?.querySelector('header strong')?.textContent, 'New group')
      const oldGroup = [...document.querySelectorAll('.dbw-board-column')]
        .find(column => column.querySelector('header strong')?.textContent === 'Old group')
      assert.equal(oldGroup?.querySelectorAll('.dbw-board-card').length ?? 0, 0)
      assert.equal(cards.filter(card => card.querySelector('strong')?.textContent === 'Other').length, 1)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 1)
      assert.deepEqual(selected(), originalSelection)
      assert.deepEqual(disk(), expected)
      assert.deepEqual(disk('b'), originalOtherSource)
      assert.equal(appNotifications.getSnapshot().length, 0)
      assert.equal(document.querySelector('.app-notification-message'), null)
    }, options)

    // A separate genuine record supplies the ungrouped destination. Preserve
    // the two-record red oracle above rather than inventing an empty DOM column.
    await withBoard(async ({ document, writes, reads, disk, drop, ack, read }) => {
      const original = disk(), text = getDatabaseWorkspaceText(options.locale)
      await drop('Target', 'New group')
      await ack(0)
      assert.equal(reads.length, 1)
      await read(0)
      await drop('Target', text.noGrouping)
      assert.equal(writes.length, 2)
      assert.deepEqual(writes[1].payload, options.kind === 'custom'
        ? { entityId: 'target', fieldValues: { notes: null } }
        : { documentId: 'target', columnId: 'notes', value: null })
      await ack(1)
      assert.equal(reads.length, 2)
      assert.equal(reads[1].preferred, undefined)
      await read(1)
      const target = [...document.querySelectorAll('.dbw-board-card')]
        .find(card => card.querySelector('strong')?.textContent === 'Target')
      assert.ok(target)
      assert.equal(target.closest('.dbw-board-column')?.querySelector('header strong')?.textContent, text.noGrouping)
      assert.equal(document.querySelectorAll('.dbw-board-card').length, 3)
      const expected = original.map(record => record.id === 'target'
        ? { ...record, fieldValues: { ...record.fieldValues, notes: null },
          ...(options.kind === 'custom' ? { updatedAt: '2026-10-02' } : {}) } : record)
      assert.deepEqual(disk(), expected)
      await drop('Target', text.noGrouping)
      assert.equal(writes.length, 2, 'dropping into the current empty group is not a mutation')
      assert.equal(reads.length, 2)
      assert.deepEqual(disk(), expected)
      assert.equal(appNotifications.getSnapshot().length, 0)
    }, { ...options, ungrouped: true })
  })
}
