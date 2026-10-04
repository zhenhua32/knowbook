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
const { DatabaseTextDraftCache } = await import('../src/renderer/src/features/database/model/databaseTextDrafts')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Payload = { kind: 'custom'; payload: UpdateDatabaseEntityInput } | { kind: 'catalog'; payload: UpdateDocumentDatabaseValueInput }
type Write = ReturnType<typeof deferred<DatabaseEntity | void>> & Payload & { source: string }
type Read = ReturnType<typeof deferred<void>> & { source: string; preferred: string | undefined; canApply: () => boolean }
type Model = { source: string; shown: boolean; view: string; entities: DatabaseEntity[]; documents: DocumentCatalogEntry[] }
const notes: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }

function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) {
    appNotifications.dismiss(id)
  }
  appNotifications.clearCompleted()
}

async function withWorkspace(run: (context: {
  document: Document; window: JSDOM['window']; outside: HTMLInputElement; warnings: unknown[][]
  writes: Write[]; reads: Read[]; disk: (source?: string) => DatabaseEntity[] | DocumentCatalogEntry[]
  selectedView: () => string; drop: () => Promise<void>; ack: (index?: number) => Promise<void>
  read: (index: number, reason?: unknown) => Promise<void>; query: () => HTMLInputElement
  fillQuery: (raw: string) => Promise<void>; refreshButton: () => HTMLButtonElement
  selectView: (layout: 'board' | 'table' | 'cards') => Promise<void>; navigate: (source: string) => Promise<void>
  leave: () => Promise<void>; cell: () => HTMLInputElement; fillCell: (raw: string) => Promise<void>
  enterCell: () => Promise<void>; fail: (index: number, reason: unknown) => Promise<void>
}) => Promise<void>, options: { kind: 'custom' | 'catalog'; locale: UiLanguage }) {
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
  const source = options.kind === 'catalog' ? 'catalog' : 'custom'
  const databases: DocumentDatabase[] = ['custom', 'other-source', 'catalog'].map(id => ({ id,
    kind: id === 'catalog' ? 'document-catalog' : 'custom', name: `Fixture ${id}`, description: 'Preserved source metadata',
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(['custom', 'other-source'].map(databaseId => [databaseId,
    ['target', 'other'].map((id, index) => ({ id: databaseId === 'custom' ? id : `${databaseId}-${id}`, databaseId,
    title: index === 0 ? 'Target' : 'Other', documentId: null,
    fieldValues: { notes: index === 0 ? 'Old group' : 'New group', hidden: `Hidden ${id} metadata` },
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }))]))
  let documents: DocumentCatalogEntry[] = ['target', 'other'].map((id, index) => ({ id, title: index === 0 ? 'Target' : 'Other',
    path: `Parent/${id}`, summary: `Preserved ${id} summary`, parentId: 'parent', parentTitle: 'Parent',
    updatedAt: '2026-10-01', blockCount: 3 + index, childCount: index, linkCount: 2 + index,
    fieldValues: { notes: index === 0 ? 'Old group' : 'New group', hidden: `Hidden ${id} metadata` } }))
  const savedViews: DatabaseSavedView[] = databases.flatMap(database => (['board', 'table', 'cards'] as const).map(layout =>
    ({ id: `${database.id}-${layout}`, databaseId: database.id,
    name: `Records ${layout}`, config: { ...createDefaultDatabaseViewConfig(layout,
      [DATABASE_SYSTEM_FIELD_IDS.title, notes.id]), groupBy: { fieldId: layout === 'board' ? notes.id : null } },
    configVersion: 1, filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: layout,
    sortOrder: 0, createdAt: '2026-10-01', updatedAt: '2026-10-01' })))
  const cache = new DatabaseTextDraftCache(), warnings: unknown[][] = [], nativeWarn = console.warn
  console.warn = (...values: unknown[]) => { warnings.push(values) }
  const writes: Write[] = [], reads: Read[] = []
  let model!: Model, setModel!: (action: SetStateAction<Model>) => void
  const capture = (payload: Payload) => {
    const request: Write = { ...deferred<DatabaseEntity | void>(), source: model.source, ...structuredClone(payload) }
    writes.push(request); return request.promise
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (payload: UpdateDatabaseEntityInput) => capture({ kind: 'custom', payload }),
    updateDocumentDatabaseValue: (payload: UpdateDocumentDatabaseValueInput) => capture({ kind: 'catalog', payload }),
    onPluginNotification: () => () => {}, onBackupHealth: () => () => {}, getBackupHealth: async () => ({ revision: 0, error: null })
  } })
  const refresh = async (requestedSource = model.source, preferred?: string, shouldContinue?: () => boolean) => {
    const request: Read = { ...deferred<void>(), source: requestedSource, preferred, canApply: shouldContinue ?? (() => true) }
    reads.push(request)
    await request.promise
    if (!request.canApply() || model.source !== requestedSource || !model.shown) return false
    const nextEntities = structuredClone(server[requestedSource] ?? []), nextDocuments = structuredClone(documents)
    setModel(previous => request.canApply() && previous.source === requestedSource && previous.shown
      ? { ...previous, entities: nextEntities, documents: nextDocuments, view: preferred ?? previous.view } : previous)
    return true
  }
  function Harness() {
    const [current, update] = useReducer((previous: Model, action: SetStateAction<Model>) =>
      typeof action === 'function' ? action(previous) : action,
    { source, shown: true, view: `${source}-board`, entities: structuredClone(server[source] ?? []), documents: structuredClone(documents) })
    model = current; setModel = update
    return createElement(Fragment, null, current.shown ? createElement(DatabaseWorkspace, {
      currentDatabaseId: current.source, activeViewId: current.view, databases,
      savedViews: savedViews.filter(view => view.databaseId === current.source),
      entities: current.entities, catalogDocuments: current.documents, catalogColumns: [notes], selectedColumns: [notes],
      selectedRecordIds: [], textDraftCache: cache, locale: options.locale, onRefresh: refresh, onMessage: notify,
      onActiveViewIdChange: view => update(previous => ({ ...previous, view })),
      onCurrentDatabaseIdChange: requestedSource => update(previous => ({ ...previous, source: requestedSource,
        view: `${requestedSource}-board`, entities: structuredClone(server[requestedSource] ?? []) })),
      onOpenDocument: () => {}, onSelectedRecordIdsChange: () => {}
    }) : null, createElement(AppNotificationHost, { isZh: options.locale === 'zh-CN', onOpenDocument: () => {} }))
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const query = () => {
    const input = dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')
    assert.ok(input); return input
  }
  const refreshButton = () => {
    const label = options.locale === 'zh-CN' ? '刷新数据库' : 'Refresh database'
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-header button')]
      .find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label)
    assert.ok(button); return button
  }
  const cell = () => {
    const row = [...dom.window.document.querySelectorAll('.dbw-table tbody tr')]
      .find(item => item.querySelector('.dbw-record-title strong')?.textContent === 'Target')
    const input = row?.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
    assert.ok(input); return input
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, window: dom.window, writes, reads, warnings,
      outside: dom.window.document.getElementById('outside') as HTMLInputElement,
      disk: (requestedSource = source) => structuredClone(requestedSource === 'catalog' ? documents : server[requestedSource]),
      selectedView: () => model.view,
      drop: async () => {
        const card = [...dom.window.document.querySelectorAll<HTMLElement>('.dbw-board-card')]
          .find(item => item.querySelector('strong')?.textContent === 'Target')
        const destination = [...dom.window.document.querySelectorAll<HTMLElement>('.dbw-board-column')]
          .find(item => item.querySelector('header strong')?.textContent === 'New group')
        assert.ok(card); assert.ok(destination)
        await act(async () => card.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true })))
        await act(async () => destination.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true })))
      },
      ack: async (index = 0) => {
        const request = writes[index]; assert.ok(request)
        let result: DatabaseEntity | undefined
        if (request.kind === 'catalog') {
          const payload = request.payload
          documents = documents.map(entry => entry.id === payload.documentId
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
        if (reason === undefined) reads[index].resolve()
        else reads[index].reject(reason)
      }) },
      query, refreshButton, cell,
      fillQuery: async raw => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(query(), raw)
        query().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      selectView: async layout => {
        const button = dom.window.document.querySelector<HTMLButtonElement>(`.dbw-view-tab[title="Records ${layout}"]`)
        assert.ok(button); await act(async () => button.click())
        assert.equal(model.view, `${model.source}-${layout}`)
      },
      navigate: async requestedSource => {
        const trigger = dom.window.document.querySelector<HTMLButtonElement>('.dbw-source-trigger')
        assert.ok(trigger); await act(async () => trigger.click())
        const name = requestedSource === 'catalog' ? getDatabaseWorkspaceText(options.locale).allDocuments : `Fixture ${requestedSource}`
        const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-source-option')]
          .find(item => item.querySelector('strong')?.textContent === name)
        assert.ok(button); await act(async () => button.click())
        assert.equal(model.source, requestedSource)
      },
      leave: async () => { await act(async () => setModel(previous => ({ ...previous, shown: false }))) },
      fillCell: async raw => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(cell(), raw)
        cell().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      enterCell: async () => { await act(async () => cell().dispatchEvent(new dom.window.KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }))) },
      fail: async (index, reason) => { assert.ok(writes[index]); await act(async () => writes[index].reject(reason)) }
    })
  } finally {
    await act(async () => root.unmount())
    await act(async () => { writes.forEach(request => request.resolve(undefined)); reads.forEach(request => request.resolve()) })
    clearNotifications()
    console.warn = nativeWarn
    setActiveUiLanguage(language)
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
  test(`a ${options.kind} Board saved-refresh failure can be recovered through the actual database Header without repeating the write`, async () => {
    await withWorkspace(async ({ document, writes, reads, disk, selectedView, drop, ack, read, query, fillQuery }) => {
      const original = disk(), originalView = selectedView(), text = getDatabaseWorkspaceText(options.locale)
      await drop()
      assert.equal(writes.length, 1)
      assert.deepEqual(writes[0].payload, options.kind === 'custom'
        ? { entityId: 'target', fieldValues: { notes: 'New group' } }
        : { documentId: 'target', columnId: 'notes', value: 'New group' })
      await ack()
      assert.equal(reads.length, 1)
      await read(0, new Error('Isolated read failed after the successful write'))
      const expected = original.map(record => record.id === 'target'
        ? { ...record, fieldValues: { ...record.fieldValues, notes: 'New group' },
          ...(options.kind === 'custom' ? { updatedAt: '2026-10-02' } : {}) } : record)
      assert.deepEqual(disk(), expected)
      assert.equal(writes.length, 1)
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(appNotifications.getSnapshot()[0].message, text.savedRefreshFailed)
      // Preloading the module does not settle React.lazy's first import promise.
      await waitForRenderer(() => Boolean(document.querySelector('.app-notification-message')),
        'The notification list must finish its first lazy import before inspecting the refresh warning')
      assert.equal(document.querySelector('.app-notification-message')?.textContent, text.savedRefreshFailed)
      const label = options.locale === 'zh-CN' ? '刷新数据库' : 'Refresh database'
      const refresh = [...document.querySelectorAll<HTMLButtonElement>('.dbw-header button')]
        .find(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label)
      assert.ok(refresh, 'the actual Header must expose a localized database refresh action')
      await act(async () => query().focus())
      await fillQuery('Target')
      const focused = query()
      await act(async () => focused.setSelectionRange(1, 4))
      await act(async () => { refresh.click(); refresh.click() })
      assert.equal(reads.length, 2, 'same-frame refresh activation is one pure read')
      assert.equal(reads[1].preferred, undefined)
      assert.equal(writes.length, 1, 'retrying the refresh must not resubmit the acknowledged value')
      await read(1)
      assert.equal(document.activeElement, focused)
      assert.equal(query(), focused)
      assert.equal(focused.value, 'Target')
      assert.deepEqual([focused.selectionStart, focused.selectionEnd], [1, 4])
      assert.equal(selectedView(), originalView)
      const cards = [...document.querySelectorAll('.dbw-board-card')]
      assert.equal(cards.length, 1, 'the current query remains active after publication')
      assert.equal(cards[0].querySelector('strong')?.textContent, 'Target')
      assert.equal(cards[0].closest('.dbw-board-column')?.querySelector('header strong')?.textContent, 'New group')
      assert.deepEqual(disk(), expected)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 2)
      assert.equal(appNotifications.getSnapshot().length, 1, 'success does not duplicate the old saved-refresh warning')
    }, options)
  })
}

test('the actual shared refresh entry stays focusable and single-flight in every source and layout without a write or success toast', async () => {
  for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
    for (const layout of ['board', 'table', 'cards'] as const) {
      await withWorkspace(async ({ document, writes, reads, disk, selectedView, selectView, refreshButton, read }) => {
        const original = disk()
        await selectView(layout)
        const view = selectedView(), button = refreshButton()
        await act(async () => button.focus())
        await act(async () => { button.click(); button.click() })
        assert.equal(reads.length, 1)
        assert.equal(reads[0].preferred, undefined)
        assert.equal(writes.length, 0)
        assert.equal(button.disabled, false)
        assert.equal(button.getAttribute('aria-disabled'), 'true')
        assert.equal(button.getAttribute('aria-busy'), 'true')
        assert.equal(document.activeElement, button)
        const busy = options.locale === 'zh-CN' ? '正在刷新数据库…' : 'Refreshing database…'
        assert.equal([...document.querySelectorAll('[role="status"]')].filter(item => item.textContent === busy).length, 1)
        await read(0)
        assert.equal(refreshButton(), button)
        assert.equal(document.activeElement, button)
        assert.notEqual(button.getAttribute('aria-disabled'), 'true')
        assert.notEqual(button.getAttribute('aria-busy'), 'true')
        assert.equal(selectedView(), view)
        assert.ok(document.querySelector(`.dbw-canvas-${layout}`))
        assert.deepEqual(disk(), original)
        assert.equal(writes.length, 0)
        assert.equal(reads.length, 1)
        assert.equal(appNotifications.getSnapshot().length, 0)
      }, options)
    }
  }
})

test('manual read failure is friendly in the real Host, keeps original diagnostics, and an explicit retry remains read-only', async () => {
  for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
    await withWorkspace(async ({ document, writes, reads, disk, warnings, refreshButton, read }) => {
      const original = disk(), cause = new Error("Error invoking remote method 'read-database': SqliteError: isolated read failed")
      const stack = cause.stack, button = refreshButton()
      await act(async () => { button.focus(); button.click(); button.click() })
      assert.equal(reads.length, 1)
      await read(0, cause)
      const friendly = options.locale === 'zh-CN' ? '数据库刷新失败，请重试。' : 'The database could not be refreshed. Try again.'
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(appNotifications.getSnapshot()[0].message, friendly)
      assert.equal(document.querySelector('.app-notification-message')?.textContent, friendly)
      assert.ok(warnings.some(values => values.some(value => value === cause)))
      assert.equal(cause.stack, stack)
      assert.equal(document.activeElement, button)
      assert.equal(button.disabled, false)
      assert.notEqual(button.getAttribute('aria-disabled'), 'true')
      await act(async () => { button.click(); button.click() })
      assert.equal(reads.length, 2)
      assert.equal(writes.length, 0)
      await read(1)
      assert.deepEqual(disk(), original)
      assert.equal(document.activeElement, button)
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(appNotifications.getHistorySnapshot().length, 1)
      assert.equal(writes.length, 0)
      assert.equal(reads.length, 2)
    }, options)
  }
})

test('an in-flight manual read publishes into the current same-source view, layout and query without restoring its old selection', async () => {
  for (const change of ['view', 'layout'] as const) {
    await withWorkspace(async ({ document, writes, reads, disk, selectedView, refreshButton, read, selectView, query, fillQuery }) => {
      const original = disk()
      await act(async () => refreshButton().click())
      assert.equal(reads.length, 1)
      if (change === 'view') await selectView('table')
      else {
        const table = document.querySelector<HTMLButtonElement>('.dbw-layout-switcher button[aria-label="Table"]')
        assert.ok(table); await act(async () => table.click())
      }
      const view = selectedView()
      assert.equal(view, change === 'view' ? 'custom-table' : 'custom-board')
      await act(async () => query().focus())
      await fillQuery('Target')
      const focused = query()
      await act(async () => focused.setSelectionRange(1, 4))
      assert.equal(reads[0].canApply(), true)
      assert.equal(reads[0].preferred, undefined)
      await read(0)
      assert.equal(selectedView(), view)
      assert.equal(query(), focused)
      assert.equal(document.activeElement, focused)
      assert.equal(focused.value, 'Target')
      assert.deepEqual([focused.selectionStart, focused.selectionEnd], [1, 4])
      assert.ok(document.querySelector('.dbw-table'))
      assert.equal(document.querySelector('[data-testid="database-board-view"]'), null)
      assert.deepEqual([...document.querySelectorAll('.dbw-record-title strong')].map(item => item.textContent), ['Target'])
      assert.deepEqual(disk(), original)
      assert.equal(writes.length, 0)
      assert.equal(reads.length, 1)
      assert.equal(appNotifications.getSnapshot().length, 0)
    }, { kind: 'custom', locale: 'en-US' })
  }
})

test('a new source has its own manual read lock and an obsolete finally cannot unlock its pending refresh', async () => {
  for (const failed of [false, true]) {
    await withWorkspace(async ({ document, writes, reads, disk, refreshButton, read, navigate, query, fillQuery }) => {
      const originalA = disk('custom'), originalB = disk('other-source')
      await act(async () => refreshButton().click())
      assert.equal(reads.length, 1)
      await navigate('other-source')
      assert.equal(reads[0].canApply(), false)
      const current = refreshButton()
      assert.notEqual(current.getAttribute('aria-disabled'), 'true')
      await act(async () => { current.click(); current.click() })
      assert.equal(reads.length, 2)
      assert.equal(reads[1].source, 'other-source')
      assert.equal(current.getAttribute('aria-busy'), 'true')
      await act(async () => query().focus())
      await fillQuery('Other')
      const focused = query()
      await read(0, failed ? new Error('The departed source failed') : undefined)
      assert.equal(current.getAttribute('aria-busy'), 'true')
      assert.equal(current.getAttribute('aria-disabled'), 'true')
      assert.equal(reads[1].canApply(), true)
      await act(async () => current.click())
      assert.equal(reads.length, 2)
      assert.equal(document.activeElement, focused)
      assert.equal(focused.value, 'Other')
      assert.equal(appNotifications.getSnapshot().length, 0)
      await read(1)
      assert.notEqual(current.getAttribute('aria-busy'), 'true')
      assert.equal(document.activeElement, focused)
      assert.equal(focused.value, 'Other')
      assert.deepEqual(disk('custom'), originalA)
      assert.deepEqual(disk('other-source'), originalB)
      assert.equal(writes.length, 0)
      assert.equal(reads.length, 2)
    }, { kind: 'custom', locale: 'en-US' })
  }
})

test('manual read success or rejection after source ABA or unmount is permanently obsolete and cannot notify or change the new owner', async () => {
  for (const transition of ['source-aba', 'unmount'] as const) {
    for (const failed of [false, true]) {
      await withWorkspace(async ({ document, outside, writes, reads, disk, selectedView, refreshButton, read, navigate, leave, query, fillQuery }) => {
        const original = disk()
        await act(async () => refreshButton().click())
        assert.equal(reads.length, 1)
        if (transition === 'unmount') {
          await leave()
          await act(async () => outside.focus())
        } else {
          await navigate('other-source')
          await navigate('custom')
          await act(async () => query().focus())
          await fillQuery('Other')
        }
        const focused = document.activeElement, view = selectedView()
        const titles = [...document.querySelectorAll('.dbw-board-card strong')].map(item => item.textContent)
        assert.equal(reads[0].canApply(), false)
        await read(0, failed ? new Error('The obsolete request rejected') : undefined)
        assert.equal(reads[0].canApply(), false)
        assert.equal(document.activeElement, focused)
        assert.equal(selectedView(), view)
        assert.deepEqual([...document.querySelectorAll('.dbw-board-card strong')].map(item => item.textContent), titles)
        if (transition !== 'unmount') {
          assert.equal(query().value, 'Other')
          assert.notEqual(refreshButton().getAttribute('aria-busy'), 'true')
        }
        assert.deepEqual(disk(), original)
        assert.equal(writes.length, 0)
        assert.equal(reads.length, 1)
        assert.equal(appNotifications.getSnapshot().length, 0)
        assert.equal(appNotifications.getHistorySnapshot().length, 0)
      }, { kind: 'custom', locale: 'en-US' })
    }
  }
})

test('Header primary pointerdown preserves real dirty, failed and write-pending Table drafts and a GET never releases the cell write lock', async () => {
  for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
    for (const state of ['dirty', 'failed', 'write-pending'] as const) {
      await withWorkspace(async ({ document, window, writes, reads, disk, selectView, refreshButton, cell, fillCell, enterCell, fail, ack, read }) => {
        const original = disk(), text = getDatabaseWorkspaceText(options.locale)
        await selectView('table')
        await act(async () => cell().focus())
        await fillCell('  Unsubmitted raw spaces  ')
        if (state !== 'dirty') {
          await enterCell()
          assert.equal(writes.length, 1)
          if (state === 'failed') await fail(0, new Error('The isolated text write failed'))
          await act(async () => cell().focus())
        }
        const focused = cell()
        await act(async () => focused.setSelectionRange(2, 13))
        const button = refreshButton()
        // JSDOM has no native pointer focus default. This verifies the actual
        // Header cancellation contract; the Electron test checks the real blur.
        const primary = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
        Object.defineProperty(primary, 'isPrimary', { value: true })
        await act(async () => button.dispatchEvent(primary))
        assert.equal(primary.defaultPrevented, true)
        for (const pointer of [{ isPrimary: false, button: 0 }, { isPrimary: true, button: 2 }]) {
          const other = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: pointer.button })
          Object.defineProperty(other, 'isPrimary', { value: pointer.isPrimary })
          await act(async () => button.dispatchEvent(other))
          assert.equal(other.defaultPrevented, false)
        }
        assert.equal(document.activeElement, focused)
        await act(async () => { button.click(); button.click() })
        assert.equal(reads.length, 1)
        assert.equal(writes.length, state === 'dirty' ? 0 : 1)
        await read(0)
        assert.equal(cell(), focused)
        assert.equal(document.activeElement, focused)
        assert.equal(focused.value, '  Unsubmitted raw spaces  ')
        assert.deepEqual([focused.selectionStart, focused.selectionEnd], [2, 13])
        assert.equal(focused.readOnly, state === 'write-pending')
        assert.deepEqual(disk(), original)
        if (state === 'failed') {
          assert.equal(focused.parentElement!.querySelector('[role="alert"]')?.textContent, text.formFailed)
          assert.equal(focused.parentElement!.querySelector('button')?.textContent, text.retry)
          assert.equal(appNotifications.getSnapshot().length, 1)
        } else assert.equal(appNotifications.getSnapshot().length, 0)
        if (state === 'write-pending') {
          await ack(0)
          assert.equal(focused.readOnly, false)
          assert.equal(focused.value, 'Unsubmitted raw spaces')
          assert.equal(document.activeElement, focused)
          assert.equal(reads.length, 2, 'the original accepted cell ACK still owns its follow-up read')
          await read(1)
          assert.equal(focused.value, 'Unsubmitted raw spaces')
          assert.equal(document.activeElement, focused)
          assert.deepEqual(disk(), original.map(record => record.id === 'target'
            ? { ...record, fieldValues: { ...record.fieldValues, notes: 'Unsubmitted raw spaces' },
              ...(options.kind === 'custom' ? { updatedAt: '2026-10-02' } : {}) } : record))
        }
        assert.equal(writes.length, state === 'dirty' ? 0 : 1)
      }, options)
    }
  }
})
