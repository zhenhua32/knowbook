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
// Preload actual lazy modules; the Host, notify and notification store stay real.
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
type Read = ReturnType<typeof deferred<void>> & { source: string; canApply: () => boolean }
type Model = { source: string; shown: boolean; entities: DatabaseEntity[]; documents: DocumentCatalogEntry[];
  columns: DocumentDatabaseColumn[]; layout: 'table' | 'board' }
const notes: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }

function clearNotifications() {
  for (const id of new Set([...appNotifications.getSnapshot(), ...appNotifications.getHistorySnapshot()].map(item => item.id))) {
    appNotifications.dismiss(id)
  }
  appNotifications.clearCompleted()
}

async function withWorkspace(run: (context: {
  document: Document; window: JSDOM['window']; input: () => HTMLInputElement; outside: HTMLInputElement; warnings: unknown[][]
  writes: Write[]; reads: Read[]; disk: (source?: string) => DatabaseEntity[] | DocumentCatalogEntry[]
  fill: (raw: string) => Promise<void>; enter: () => Promise<void>; fail: (index: number, reason: unknown) => Promise<void>
  ack: (index: number) => Promise<void>; read: (index: number, failed?: boolean) => Promise<void>
  navigate: (source: string) => Promise<void>; leave: () => Promise<void>
  schema: (columns: DocumentDatabaseColumn[]) => Promise<void>; board: () => Promise<void>
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
  const warnings: unknown[][] = [], nativeWarn = console.warn
  console.warn = (...values: unknown[]) => { warnings.push(values) }
  const sources: DocumentDatabase[] = ['a', 'b', 'catalog'].map(id => ({ id, kind: id === 'catalog' ? 'document-catalog' : 'custom',
    name: `Source ${id}`, description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(['a', 'b'].map(source => [source,
    [{ id: 'record', databaseId: source, title: `Record ${source}`, documentId: null,
      fieldValues: { notes: `Saved ${source}`, other: 'Untouched metadata' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' },
    { id: 'other-record', databaseId: source, title: `Other ${source}`, documentId: null,
      fieldValues: { notes: 'Other group', other: 'Unchanged second record' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }]]))
  let catalog: DocumentCatalogEntry[] = [{ id: 'document', title: 'Document', path: 'Document', summary: 'Preserved summary',
    parentId: null, parentTitle: null, updatedAt: '2026-10-01', blockCount: 3, childCount: 0, linkCount: 2,
    fieldValues: { notes: 'Saved catalog', other: 'Untouched metadata' } }]
  const view = (source: string, layout: 'table' | 'board'): DatabaseSavedView => ({ id: `${source}-${layout}`, databaseId: source, name: `All records ${layout}`,
    config: { ...createDefaultDatabaseViewConfig(layout, [DATABASE_SYSTEM_FIELD_IDS.title, notes.id]),
      groupBy: { fieldId: layout === 'board' ? notes.id : null } }, configVersion: 1,
    filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: layout, sortOrder: 0,
    createdAt: '2026-10-01', updatedAt: '2026-10-01' })
  const cache = new DatabaseTextDraftCache(), writes: Write[] = [], reads: Read[] = []
  const initialSource = options.kind === 'catalog' ? 'catalog' : 'a'
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
  const refresh = async (source = model.source, _preferred?: string, shouldContinue?: () => boolean) => {
    const request = { ...deferred<void>(), source, canApply: shouldContinue ?? (() => true) }
    reads.push(request)
    await request.promise
    if (!request.canApply() || model.source !== source || !model.shown) return false
    const entities = structuredClone(server[source] ?? []), documents = structuredClone(catalog)
    setModel(previous => request.canApply() && previous.source === source && previous.shown
      ? { ...previous, entities, documents } : previous)
    return true
  }
  function Harness() {
    const [current, update] = useReducer((previous: Model, action: SetStateAction<Model>) =>
      typeof action === 'function' ? action(previous) : action,
    { source: initialSource, shown: true, entities: structuredClone(server[initialSource] ?? []), documents: structuredClone(catalog),
      columns: [notes], layout: 'table' })
    model = current; setModel = update
    return createElement(Fragment, null, current.shown ? createElement(DatabaseWorkspace, {
      currentDatabaseId: current.source, activeViewId: `${current.source}-${current.layout}`, databases: sources,
      savedViews: [view(current.source, 'table'), view(current.source, 'board')],
      entities: current.entities, catalogDocuments: current.documents, catalogColumns: current.columns, selectedColumns: current.columns,
      selectedRecordIds: [], textDraftCache: cache, locale: options.locale, onRefresh: refresh, onMessage: notify,
      onActiveViewIdChange: () => {}, onCurrentDatabaseIdChange: () => {}, onOpenDocument: () => {}, onSelectedRecordIdsChange: () => {}
    }) : null, createElement(AppNotificationHost, { isZh: options.locale === 'zh-CN', onOpenDocument: () => {} }))
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const input = () => {
    const title = model.source === 'catalog' ? 'Document' : `Record ${model.source}`
    const row = [...dom.window.document.querySelectorAll('.dbw-table tbody tr')]
      .find(candidate => candidate.querySelector('.dbw-record-title strong')?.textContent === title)
    const field = row?.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
    assert.ok(field); return field
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, window: dom.window, input, warnings, writes, reads,
      outside: dom.window.document.getElementById('outside') as HTMLInputElement,
      disk: (source = initialSource) => structuredClone(source === 'catalog' ? catalog : server[source]),
      fill: async raw => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), raw)
        input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      enter: async () => { await act(async () => input().dispatchEvent(new dom.window.KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }))) },
      fail: async (index, reason) => { assert.ok(writes[index]); await act(async () => writes[index].reject(reason)) },
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
      read: async (index, failed = false) => { assert.ok(reads[index]); await act(async () => {
        if (failed) reads[index].reject(new Error('Read unavailable'))
        else reads[index].resolve()
      }) },
      navigate: async source => { await act(async () => setModel(previous => ({ ...previous, source, entities: structuredClone(server[source] ?? []) }))) },
      leave: async () => { await act(async () => setModel(previous => ({ ...previous, shown: false }))) },
      schema: async columns => { await act(async () => setModel(previous => ({ ...previous, columns }))) },
      board: async () => { await act(async () => setModel(previous => ({ ...previous, layout: 'board' }))) }
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

for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' },
  { kind: 'custom', locale: 'zh-CN' }, { kind: 'catalog', locale: 'en-US' }] as const) {
  test(`a ${options.kind} text save failure uses the same localized inline and real Host notification message in ${options.locale}`, async () => {
    await withWorkspace(async ({ document, input, writes, reads, warnings, fill, enter, fail, disk }) => {
      const originals = disk(), text = getDatabaseWorkspaceText(options.locale)
      const cause = new Error("Error invoking remote method 'knowbook:update-value': SqliteError: isolated write rejected at C:\\isolated\\knowbook.db")
      const stack = cause.stack
      await act(async () => input().focus())
      await fill('  Retained raw draft  ')
      await enter()
      assert.equal(writes.length, 1)
      await fail(0, cause)
      assert.equal(input().value, '  Retained raw draft  ')
      assert.equal(input().parentElement!.querySelector('[role="alert"]')?.textContent, text.formFailed)
      assert.deepEqual(disk(), originals)
      assert.equal(reads.length, 0)
      assert.equal(appNotifications.getSnapshot().length, 1)
      await waitForRenderer(() => document.querySelector('.app-notification-message')?.textContent === text.formFailed,
        'The notification Host must render the localized text save failure before inspecting its message')
      assert.equal(document.querySelector('.app-notification-message')?.textContent, text.formFailed,
        'the real notify → store → Host chain must not show the technical cause')
      assert.equal(appNotifications.getSnapshot()[0].message, text.formFailed)
      assert.ok(warnings.some(values => values.some(value => value === cause)), 'diagnostics must retain the original Error object')
      assert.equal(cause.stack, stack)
    }, options)
  })
}

test('non-Error text write rejections keep the original diagnostic value and show only the localized retained-input message', async () => {
  for (const scenario of [
    { kind: 'custom', locale: 'en-US', cause: { code: 'ISOLATED_WRITE', detail: 'Diagnostic object only' } },
    { kind: 'catalog', locale: 'zh-CN', cause: 'Diagnostic rejection string only' }
  ] as const) {
    await withWorkspace(async ({ document, input, fill, enter, fail, writes, reads, warnings, disk }) => {
      const original = disk(), text = getDatabaseWorkspaceText(scenario.locale)
      await act(async () => input().focus())
      await fill('  Kept non-Error draft  ')
      await enter()
      assert.equal(writes.length, 1)
      await fail(0, scenario.cause)
      assert.equal(input().value, '  Kept non-Error draft  ')
      assert.equal(input().parentElement!.querySelector('[role="alert"]')?.textContent, text.formFailed)
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(appNotifications.getSnapshot()[0].message, text.formFailed)
      assert.equal(document.querySelector('.app-notification-message')?.textContent, text.formFailed)
      assert.ok(warnings.some(values => values.some(value => value === scenario.cause)), 'diagnostics must keep the original thrown value')
      assert.deepEqual(disk(), original)
      assert.equal(reads.length, 0)
    }, scenario)
  }
})

test('explicit text Retry is single-flight and a saved-but-refresh-failed notification leads only to a read retry', async () => {
  for (const options of [{ kind: 'custom', locale: 'en-US' }, { kind: 'catalog', locale: 'zh-CN' }] as const) {
    await withWorkspace(async ({ document, input, fill, enter, fail, ack, read, writes, reads, warnings, disk }) => {
      const original = disk(), text = getDatabaseWorkspaceText(options.locale)
      const cause = new Error('Isolated write unavailable')
      await act(async () => input().focus())
      await fill('  Retry saved value  ')
      await enter()
      await fail(0, cause)
      assert.equal(writes.length, 1)
      assert.equal(appNotifications.getSnapshot()[0].message, text.formFailed)
      const retry = input().parentElement!.querySelector<HTMLButtonElement>('button')
      assert.ok(retry)
      assert.equal(retry.textContent, text.retry)
      await act(async () => { retry.click(); retry.click() })
      assert.equal(writes.length, 2, 'two accepted Retry activations must share one pending write')
      assert.equal(input().readOnly, true)
      assert.equal(input().value, '  Retry saved value  ')
      assert.equal(retry.getAttribute('aria-busy'), 'true')
      await ack(1)
      assert.equal(reads.length, 1)
      assert.equal(input().readOnly, false, 'the write ACK unlocks editing while the follow-up read is pending')
      assert.equal(input().value, 'Retry saved value')
      await read(0, true)
      assert.equal(writes.length, 2)
      assert.equal(input().parentElement!.querySelector('[role="status"]')?.textContent, text.savedRefreshFailed)
      const notices = appNotifications.getSnapshot()
      assert.equal(notices.length, 2)
      assert.equal(notices[0].message, text.formFailed, 'the earlier write failure remains in the real history/live chain')
      assert.equal(notices[1].message, text.savedRefreshFailed)
      assert.notEqual(notices[1].message, text.formFailed)
      assert.equal(document.querySelector(`.app-notification[data-notification-id="${notices[1].id}"] .app-notification-message`)?.textContent,
        text.savedRefreshFailed)
      assert.ok(warnings.some(values => values.includes(cause)))
      const expected = original.map(record => record.id === (options.kind === 'custom' ? 'record' : 'document')
        ? { ...record, fieldValues: { ...record.fieldValues, notes: 'Retry saved value' },
          ...(options.kind === 'custom' ? { updatedAt: '2026-10-02' } : {}) } : record)
      assert.deepEqual(disk(), expected)
      const refresh = input().parentElement!.querySelector<HTMLButtonElement>('button')
      assert.ok(refresh)
      assert.equal(refresh.textContent, text.refresh)
      await act(async () => { refresh.click(); refresh.click() })
      assert.equal(reads.length, 2)
      assert.equal(writes.length, 2, 'Refresh must never submit the accepted text again')
      await read(1)
      assert.equal(input().value, 'Retry saved value')
      assert.equal(input().parentElement!.querySelector('button'), null)
      assert.equal(input().parentElement!.querySelector('.dbw-text-cell-feedback'), null)
      assert.deepEqual(disk(), expected)
      assert.equal(appNotifications.getSnapshot().length, 2)
    }, options)
  }
})

test('late text failures after source departure, unmount, or schema replacement are diagnostics only and cannot unlock a new cell request', async () => {
  for (const transition of ['source', 'unmount', 'delete-field', 'replace-type'] as const) {
    await withWorkspace(async ({ document, input, outside, fill, enter, fail, navigate, leave, schema,
      writes, reads, warnings, disk }) => {
      const originalA = disk('a'), originalB = disk('b'), text = getDatabaseWorkspaceText('en-US')
      const cause = new Error(`Old ${transition} request failed`)
      await act(async () => input().focus())
      await fill('Discarded old owner draft')
      await enter()
      assert.equal(writes.length, 1)
      if (transition === 'source') await navigate('b')
      else if (transition === 'unmount') await leave()
      else if (transition === 'delete-field') {
        await schema([])
        assert.equal(document.querySelector('.dbw-table input[aria-label="Notes"]'), null)
      } else {
        // Complete schema changes go through the real Workspace prune effect.
        // Reintroducing the same field ID must create an independent operation.
        await schema([{ ...notes, type: 'checkbox' }])
        assert.equal(document.querySelector('.dbw-table .dbw-text-cell-editor input[aria-label="Notes"]'), null)
        await schema([notes])
        assert.equal(input().value, 'Saved a')
        await act(async () => input().focus())
        await fill('New same-key request draft')
        await enter()
        assert.equal(writes.length, 2)
        assert.equal(input().readOnly, true)
      }
      await act(async () => { outside.focus(); outside.setSelectionRange(0, 0) })
      await fail(0, cause)
      assert.equal(document.activeElement, outside)
      assert.equal(appNotifications.getSnapshot().length, 0)
      assert.equal(appNotifications.getHistorySnapshot().length, 0)
      assert.equal(document.querySelector('.app-notification-message'), null)
      assert.ok(warnings.some(values => values.includes(cause)), 'stale failures are still available to diagnostics')
      assert.equal(reads.length, 0)
      assert.deepEqual(disk('a'), originalA)
      assert.deepEqual(disk('b'), originalB)
      if (transition === 'source') {
        assert.equal(input().value, 'Saved b')
        assert.equal(input().parentElement!.querySelector('[role="alert"]'), null)
      } else if (transition === 'unmount') assert.equal(document.querySelector('.dbw-table'), null)
      else if (transition === 'delete-field') {
        assert.equal(document.querySelector('.dbw-table input[aria-label="Notes"]'), null)
        assert.equal(document.querySelector('.dbw-text-cell-feedback[role="alert"]'), null)
      } else {
        assert.equal(input().value, 'New same-key request draft')
        assert.equal(input().readOnly, true, 'the old failure cannot release the replacement request lock')
        assert.equal(input().parentElement!.querySelector('[role="alert"]'), null)
        const currentCause = new Error('Current same-key request failed')
        await fail(1, currentCause)
        assert.equal(input().readOnly, false)
        assert.equal(input().value, 'New same-key request draft')
        assert.equal(input().parentElement!.querySelector('[role="alert"]')?.textContent, text.formFailed)
        assert.equal(appNotifications.getSnapshot().length, 1)
        assert.equal(appNotifications.getSnapshot()[0].message, text.formFailed)
        assert.equal(document.querySelector('.app-notification-message')?.textContent, text.formFailed)
        assert.ok(warnings.some(values => values.includes(currentCause)))
        assert.deepEqual(disk('a'), originalA)
      }
    }, { kind: 'custom', locale: 'en-US' })
  }
})

test('a real Board text-group drop failure does not claim an editable raw draft and Retry were retained', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await withWorkspace(async ({ document, window, board, writes, reads, fail, disk }) => {
      const original = disk(), text = getDatabaseWorkspaceText(locale)
      await board()
      assert.ok(document.querySelector('[data-testid="database-board-view"]'))
      assert.equal(document.querySelector('.dbw-text-cell-editor'), null)
      const card = [...document.querySelectorAll<HTMLElement>('.dbw-board-card')]
        .find(item => item.querySelector('strong')?.textContent === 'Record a')
      const destination = [...document.querySelectorAll<HTMLElement>('.dbw-board-column')]
        .find(item => item.querySelector('header strong')?.textContent === 'Other group')
      assert.ok(card); assert.ok(destination)
      assert.equal(card.draggable, true)
      // Dispatch the actual React drag/drop handlers. No cache entries or
      // notification DOM/state are injected, and no successful drop is faked.
      await act(async () => card.dispatchEvent(new window.Event('dragstart', { bubbles: true })))
      await act(async () => destination.dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true })))
      assert.equal(writes.length, 1)
      assert.equal(writes[0].kind, 'custom')
      assert.deepEqual(writes[0].payload, { entityId: 'record', fieldValues: { notes: 'Other group' } })
      const cause = new Error('Board destination rejected')
      await fail(0, cause)
      assert.deepEqual(disk(), original)
      assert.equal(reads.length, 0)
      assert.equal(appNotifications.getSnapshot().length, 1)
      assert.equal(appNotifications.getSnapshot()[0].message, cause.message)
      assert.notEqual(appNotifications.getSnapshot()[0].message, text.formFailed,
        'a Board move has no retained text input or cell Retry action')
      assert.equal(document.querySelector('.app-notification-message')?.textContent, cause.message)
      assert.equal(document.querySelector('.dbw-text-cell-feedback'), null)
      assert.equal(card.closest('.dbw-board-column')?.querySelector('header strong')?.textContent, 'Saved a')
      assert.equal(destination.querySelectorAll('.dbw-board-card').length, 1)
    }, { kind: 'custom', locale })
  }
})
