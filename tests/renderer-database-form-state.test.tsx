import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { CreateDatabaseInput, DatabaseSavedView, DatabaseViewConfigV1, DocumentDatabase, UpdateDatabaseMetadataInput } from '../src/shared/contracts'
import type { AppMessageHandler } from '../src/renderer/src/notify'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

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
function database(id: string): DocumentDatabase {
  return { id, kind: 'custom', name: `Source ${id.toUpperCase()}`, description: `Description ${id.toUpperCase()}`,
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }
}
function view(source: string, suffix: string): DatabaseSavedView {
  return { id: `${source}-${suffix}`, databaseId: source, name: `${source.toUpperCase()} ${suffix}`,
    config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, DATABASE_SYSTEM_FIELD_IDS.updatedAt]),
    configVersion: 1, filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }
}
type Kind = 'create' | 'edit'
type Model = { source: string; active: string; databases: DocumentDatabase[]; views: Record<string, DatabaseSavedView[]>; page: boolean }
type Create = ReturnType<typeof deferred<DocumentDatabase>> & { input: CreateDatabaseInput }
type Update = ReturnType<typeof deferred<DocumentDatabase>> & { input: UpdateDatabaseMetadataInput }
type Refresh = ReturnType<typeof deferred<void>> & { source: string; preferred?: string }
type Context = {
  document: Document
  text: ReturnType<typeof getDatabaseWorkspaceText>
  creates: Create[]
  updates: Update[]
  refreshes: Refresh[]
  messages: Array<{ message: Parameters<AppMessageHandler>[0]; level?: Parameters<AppMessageHandler>[1] }>
  sourceChanges: string[]
  viewChanges: string[]
  savedDatabases: DocumentDatabase[]
  focusCalls: Array<{ element: HTMLElement; options?: FocusOptions }>
  model: () => Model
  form: () => HTMLFormElement
  name: () => HTMLInputElement
  description: () => HTMLTextAreaElement
  submitButton: () => HTMLButtonElement
  query: () => HTMLInputElement
  change: (run: () => void) => Promise<void>
  fill: (input: HTMLInputElement | HTMLTextAreaElement, value: string) => Promise<void>
  open: (kind: Kind) => Promise<void>
  close: (kind?: 'escape' | 'button') => Promise<void>
  submit: (count?: number) => Promise<void>
  key: (element: HTMLElement, key: string) => Promise<KeyboardEvent>
  resolve: (kind: Kind, index?: number) => Promise<DocumentDatabase>
  reject: (kind: Kind, index?: number, message?: string) => Promise<void>
  resolveRefresh: (index?: number) => Promise<void>
  rejectRefresh: (index?: number) => Promise<void>
  navigate: (source: string, active: string) => Promise<void>
  leavePage: () => Promise<void>
  enterPage: () => Promise<void>
  flushFrames: () => Promise<void>
  unmount: () => Promise<void>
}

async function withDatabaseForms(run: (context: Context) => Promise<void>, locale = 'en-US', viewDraftCache?: Map<string, DatabaseViewConfigV1>) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside control">', { url: 'http://localhost' })
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
  const focusCalls: Context['focusCalls'] = []
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) {
    focusCalls.push({ element: this, options })
    nativeFocus.call(this, options)
  }
  let serverDatabases = [database('a'), database('b')]
  const serverViews: Record<string, DatabaseSavedView[]> = { a: [view('a', 'primary'), view('a', 'secondary')], b: [view('b', 'primary')] }
  const creates: Create[] = []
  const updates: Update[] = []
  const refreshes: Refresh[] = []
  const messages: Context['messages'] = []
  const sourceChanges: string[] = []
  const viewChanges: string[] = []
  const savedDatabases: DocumentDatabase[] = []
  let createdId = 0
  Object.defineProperty(dom.window, 'knowbook', { value: {
    createDocumentDatabase: (input: CreateDatabaseInput) => {
      const request = { ...deferred<DocumentDatabase>(), input: clone(input) }; creates.push(request); return request.promise
    },
    updateDatabaseMetadata: (input: UpdateDatabaseMetadataInput) => {
      const request = { ...deferred<DocumentDatabase>(), input: clone(input) }; updates.push(request); return request.promise
    }
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const text = getDatabaseWorkspaceText(locale)
  let mounted = true
  let current!: Model
  let updateModel!: (update: SetStateAction<Model>) => void
  let sourceGeneration = 0
  let refreshGeneration = 0
  const refresh = async (source = current.source, preferred?: string) => {
    const request = { ...deferred<void>(), source, preferred }
    const databaseSnapshot = clone(serverDatabases)
    const requestId = ++refreshGeneration
    const session = sourceGeneration
    refreshes.push(request)
    await request.promise
    if (!mounted || !current.page || requestId !== refreshGeneration || session !== sourceGeneration || current.source !== source) return
    const views = clone(serverViews[source] ?? [])
    updateModel(previous => ({ ...previous, databases: databaseSnapshot, views: { ...previous.views, [source]: views },
      active: views.some(candidate => candidate.id === preferred) ? preferred! : previous.active }))
  }
  function Harness() {
    const [model, setModel] = useState<Model>(() => ({ source: 'a', active: 'a-primary', databases: clone(serverDatabases), views: clone(serverViews), page: true }))
    current = model; updateModel = setModel
    if (!model.page) return createElement('p', { id: 'other-page' }, 'Documents')
    // This public ACK callback only updates the parent metadata. It does not
    // select a source, synthesize its views or settle the real refresh.
    const props = {
      currentDatabaseId: model.source, activeViewId: model.active, databases: model.databases, savedViews: model.views[model.source] ?? [], locale,
      catalogColumns: [], catalogDocuments: [], entities: [], selectedColumns: [], selectedRecordIds: [], viewDraftCache,
      onActiveViewIdChange: (active: string) => { viewChanges.push(active); setModel(previous => ({ ...previous, active })) },
      onCurrentDatabaseIdChange: (source: string) => {
        sourceChanges.push(source); sourceGeneration++; refreshGeneration++
        setModel(previous => ({ ...previous, source, active: previous.views[source]?.[0]?.id ?? '',
          views: { ...previous.views, [source]: previous.views[source] ?? [] } }))
      },
      onSavedDatabase: (saved: DocumentDatabase) => {
        if (!mounted || !current.page) return
        refreshGeneration++
        savedDatabases.push(clone(saved))
        setModel(previous => ({ ...previous, databases: previous.databases.some(candidate => candidate.id === saved.id)
          ? previous.databases.map(candidate => candidate.id === saved.id ? clone(saved) : candidate) : [...previous.databases, clone(saved)] }))
      },
      onMessage: (message: Parameters<AppMessageHandler>[0], level?: Parameters<AppMessageHandler>[1]) => { messages.push({ message, level }) },
      onRefresh: refresh, onOpenDocument: () => {}, onSelectedRecordIdsChange: () => {}
    }
    return createElement(DatabaseWorkspace, props)
  }
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const flushFrames = async () => change(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) })
  const form = () => { const element = dom.window.document.querySelector<HTMLFormElement>('form.dbw-dialog'); assert.ok(element); return element }
  const name = () => form().querySelector<HTMLInputElement>('label input')!
  const description = () => form().querySelector<HTMLTextAreaElement>('label textarea')!
  const submitButton = () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!
  const query = () => dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
  const fill = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => change(() => {
    const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const unmount = async () => { if (mounted) { mounted = false; sourceGeneration++; refreshGeneration++; await act(async () => root.unmount()) } }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, text, creates, updates, refreshes, messages, sourceChanges, viewChanges, savedDatabases, focusCalls,
      model: () => current, form, name, description, submitButton, query, change, fill, flushFrames, unmount,
      open: async kind => {
        if (kind === 'create') {
          const trigger = dom.window.document.querySelector<HTMLButtonElement>('.dbw-source-trigger')!
          await change(() => { trigger.focus(); trigger.click() })
          const button = dom.window.document.querySelector<HTMLButtonElement>('.dbw-menu-create')!
          await change(() => { button.focus(); button.click() })
        } else {
          const trigger = dom.window.document.querySelector<HTMLButtonElement>('.dbw-header-actions .dbw-menu-wrap > button')!
          await change(() => { trigger.focus(); trigger.click() })
          const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-action-menu button')].find(item => item.textContent === text.editDatabase)!
          await change(() => { button.focus(); button.click() })
        }
        await flushFrames()
      },
      close: async (kind = 'escape') => {
        if (kind === 'escape') await change(() => name().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
        else await change(() => form().querySelector<HTMLButtonElement>('header button')!.click())
      },
      submit: async (count = 1) => change(() => { const currentForm = form();
        for (let index = 0; index < count; index++) currentForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })) }),
      key: async (element, key) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        await change(() => element.dispatchEvent(event)); return event
      },
      resolve: async (kind, index = 0) => {
        let saved: DocumentDatabase
        if (kind === 'create') {
          const request = creates[index]; assert.ok(request)
          saved = { ...database(`created-${++createdId}`), name: request.input.name, description: request.input.description ?? '' }
          serverDatabases = [...serverDatabases, saved]
          serverViews[saved.id] = [view(saved.id, 'primary')]
          await change(() => request.resolve(clone(saved)))
        } else {
          const request = updates[index]; assert.ok(request)
          saved = { ...serverDatabases.find(candidate => candidate.id === request.input.databaseId)!, name: request.input.name, description: request.input.description }
          serverDatabases = serverDatabases.map(candidate => candidate.id === saved.id ? saved : candidate)
          await change(() => request.resolve(clone(saved)))
        }
        return saved
      },
      reject: async (kind, index = 0, message = 'Database mutation failed.') => change(() => (kind === 'create' ? creates[index] : updates[index]).reject(new Error(message))),
      resolveRefresh: async (index = 0) => { assert.ok(refreshes[index]); await change(() => refreshes[index].resolve()) },
      rejectRefresh: async (index = 0) => { assert.ok(refreshes[index]); await change(() => refreshes[index].reject(new Error('Database refresh failed.'))) },
      navigate: async (source, active) => change(() => { sourceGeneration++; refreshGeneration++; updateModel(previous => ({ ...previous, source, active })) }),
      leavePage: async () => change(() => { sourceGeneration++; refreshGeneration++; updateModel(previous => ({ ...previous, page: false })) }),
      enterPage: async () => change(() => updateModel(previous => ({ ...previous, page: true }))) })
  } finally {
    await unmount()
    await act(async () => {
      for (const request of creates) request.resolve(clone(serverDatabases[0]))
      for (const request of updates) request.resolve(clone(serverDatabases[0]))
      for (const request of refreshes) request.resolve()
    })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function noForm(context: Context) { assert.equal(context.document.querySelectorAll('form.dbw-dialog').length, 0) }
function error(context: Context) { return context.form().querySelector('[role="alert"]')?.textContent ?? '' }
function count(context: Context, kind: Kind) { return kind === 'create' ? context.creates.length : context.updates.length }

test('database create and edit submit once, retain focused read-only fields and allow a cleaned local failure to retry in both languages', async () => {
  for (const locale of ['en-US', 'zh-CN']) for (const kind of ['create', 'edit'] as const) {
    await withDatabaseForms(async context => {
      await context.open(kind)
      await context.fill(context.name(), 'Submitted database')
      await context.fill(context.description(), 'Submitted description')
      const focused = kind === 'edit' ? context.description() : context.name()
      await context.change(() => focused.focus())
      await context.submit(2)
      assert.equal(count(context, kind), 1)
      assert.equal(context.name().readOnly, true)
      assert.equal(context.description().readOnly, true)
      assert.equal(context.name().disabled || context.description().disabled, false)
      assert.equal(context.submitButton().disabled, false)
      assert.equal(context.submitButton().getAttribute('aria-disabled'), 'true')
      assert.equal(context.submitButton().getAttribute('aria-busy'), 'true')
      assert.equal(context.document.activeElement === focused, true)
      const method = kind === 'create' ? 'create-document-database' : 'update-database-metadata'
      await context.reject(kind, 0, `Error invoking remote method 'knowbook:${method}': Error: Database mutation failed.`)
      assert.equal(error(context), 'Database mutation failed.')
      assert.equal(context.messages.length, 0, 'The open form owns the error')
      assert.equal(context.name().value, 'Submitted database')
      assert.equal(context.description().value, 'Submitted description')
      assert.equal(context.name().readOnly || context.description().readOnly, false)
      assert.equal(context.document.activeElement === focused, true)
      await context.fill(context.description(), 'Retried description')
      // Synthetic Enter checks that the browser keeps its default. The real
      // form submit below separately exercises retry; it is not native activation.
      assert.equal((await context.key(context.name(), 'Enter')).defaultPrevented, false)
      await context.submit(2)
      assert.equal(count(context, kind), 2)
      assert.equal(error(context), '')
      const input = kind === 'create' ? context.creates[1].input : context.updates[1].input
      assert.equal(input.name, 'Submitted database')
      assert.equal(input.description, 'Retried description')
      await context.resolve(kind, 1)
      noForm(context)
      assert.equal(context.refreshes.length, 1)
    }, locale)
  }
})

test('create ACK adds and selects the source before refresh, and its late refresh cannot reselect after a later source/query change', async () => {
  await withDatabaseForms(async context => {
    await context.fill(context.query(), 'Source A draft B')
    await context.open('create')
    await context.fill(context.name(), 'Acknowledged source')
    await context.fill(context.description(), 'Acknowledged description')
    await context.submit()
    const created = await context.resolve('create')
    noForm(context)
    assert.equal(context.model().databases.some(candidate => candidate.id === created.id), true)
    assert.equal(context.model().source, created.id)
    assert.deepEqual(context.sourceChanges, [created.id])
    assert.equal(context.savedDatabases.length, 1)
    assert.equal(context.refreshes.length, 1, 'The real refresh is still pending')
    assert.equal(context.refreshes[0].source, created.id)
    assert.equal(context.refreshes[0].preferred, undefined)
    await context.navigate('b', 'b-primary')
    await context.fill(context.query(), 'Source B after ACK C')
    await context.change(() => context.query().focus())
    await context.resolveRefresh()
    await context.flushFrames()
    assert.equal(context.model().source, 'b')
    assert.equal(context.model().active, 'b-primary')
    assert.equal(context.query().value, 'Source B after ACK C')
    assert.equal(context.document.activeElement === context.query(), true)
    assert.deepEqual(context.sourceChanges, [created.id], 'Refresh must not issue a second source activation')
    await context.navigate('a', 'a-primary')
    assert.equal(context.query().value, 'Source A draft B')
    assert.equal(context.creates.length, 1)
  })
})

test('edit ACK updates header metadata without changing the active view or overwriting draft edits before and during refresh', async () => {
  for (const locale of ['en-US', 'zh-CN']) await withDatabaseForms(async context => {
    await context.navigate('a', 'a-secondary')
    await context.fill(context.query(), 'Draft B')
    await context.open('edit')
    assert.equal(context.name().value, 'Source A')
    assert.equal(context.description().value, 'Description A')
    await context.fill(context.name(), 'Renamed source')
    await context.fill(context.description(), 'Changed source description')
    await context.submit()
    await context.fill(context.query(), 'Draft C during write')
    const viewsBeforeACK = context.viewChanges.length
    await context.resolve('edit')
    noForm(context)
    assert.equal(context.document.querySelector('.dbw-source-trigger')!.getAttribute('title'), 'Renamed source')
    assert.equal(context.document.querySelector('.dbw-identity p')!.textContent, 'Changed source description')
    assert.equal(context.model().active, 'a-secondary')
    assert.equal(context.viewChanges.length, viewsBeforeACK)
    assert.equal(context.sourceChanges.length, 0)
    assert.equal(context.query().value, 'Draft C during write')
    assert.equal(context.document.querySelectorAll('.dbw-unsaved-dot').length, 1)
    await context.fill(context.query(), 'Draft D during refresh')
    await context.change(() => context.query().focus())
    await context.resolveRefresh()
    await context.flushFrames()
    assert.equal(context.model().active, 'a-secondary')
    assert.equal(context.query().value, 'Draft D during refresh')
    assert.equal(context.document.activeElement === context.query(), true)
    assert.deepEqual(context.updates[0].input, { databaseId: 'a', name: 'Renamed source', description: 'Changed source description' })
  }, locale)
})

test('closed or navigated database form owners cannot close a newer form, navigate or publish late errors', async () => {
  for (const kind of ['create', 'edit'] as const) for (const transition of ['new-form', 'source', 'view', 'page', 'unmount'] as const) {
    for (const outcome of ['resolve', 'reject'] as const) await withDatabaseForms(async context => {
      await context.open(kind)
      await context.fill(context.name(), 'Old request X')
      await context.fill(context.description(), 'Old description X')
      await context.submit()
      if (transition === 'new-form') {
        await context.close()
        await context.open(kind)
        await context.fill(context.name(), 'New form Y')
        await context.fill(context.description(), 'New description Y')
      } else if (transition === 'source') await context.navigate('b', 'b-primary')
      else if (transition === 'view') await context.navigate('a', 'a-secondary')
      else if (transition === 'page') await context.leavePage()
      else await context.unmount()
      if (transition !== 'new-form') noForm(context)
      const expectedSource = context.model().source
      const expectedView = context.model().active
      const focused = transition === 'new-form' ? context.name()
        : transition === 'page' || transition === 'unmount' ? context.document.getElementById('outside')! : context.query()
      if (transition === 'source' || transition === 'view') await context.fill(context.query(), 'Current context C')
      await context.change(() => focused.focus())
      const sourceCalls = context.sourceChanges.length
      const viewCalls = context.viewChanges.length
      if (outcome === 'resolve') await context.resolve(kind)
      else await context.reject(kind)
      for (let index = 0; index < context.refreshes.length; index++) await context.resolveRefresh(index)
      await context.flushFrames()
      assert.equal(context.model().source, expectedSource)
      assert.equal(context.model().active, expectedView)
      assert.equal(context.sourceChanges.length, sourceCalls)
      assert.equal(context.viewChanges.length, viewCalls)
      assert.equal(context.messages.length, 0)
      assert.equal(context.document.activeElement === focused, true)
      if (transition === 'new-form') {
        assert.equal(context.name().value, 'New form Y')
        assert.equal(context.description().value, 'New description Y')
        assert.equal(context.name().readOnly || context.description().readOnly, false)
        assert.equal(error(context), '')
      } else {
        noForm(context)
        if (transition === 'source' || transition === 'view') assert.equal(context.query().value, 'Current context C')
      }
      assert.equal(count(context, kind), 1)
    })
  }
})

test('accepted database writes remain saved and closed when refresh fails, with a distinct localized warning and no duplicate write', async () => {
  for (const locale of ['en-US', 'zh-CN']) for (const kind of ['create', 'edit'] as const) {
    await withDatabaseForms(async context => {
      await context.open(kind)
      await context.fill(context.name(), 'Saved database')
      await context.fill(context.description(), 'Saved description')
      await context.submit()
      const saved = await context.resolve(kind)
      noForm(context)
      assert.equal(context.model().databases.find(candidate => candidate.id === saved.id)?.name, 'Saved database')
      await context.change(() => context.query().focus())
      await context.rejectRefresh()
      await context.flushFrames()
      noForm(context)
      const warning = locale === 'zh-CN' ? '数据库已保存，但列表刷新失败，请刷新数据库。'
        : 'Database changes were saved, but the list could not be refreshed. Refresh the database.'
      assert.deepEqual(context.messages, [{ message: warning, level: 'error' }])
      assert.equal(context.document.activeElement === context.query(), true)
      assert.equal(count(context, kind), 1)
      await context.open('edit')
      assert.equal(context.name().value, 'Saved database')
      assert.equal(context.description().value, 'Saved description')
      assert.equal(context.name().readOnly || context.description().readOnly, false)
      assert.equal(error(context), '')
      assert.equal(count(context, kind), 1, 'The confirmed write must not be offered as an automatic retry')
    }, locale)
  }
})

test('same-database edits wait without losing the newer draft, and create/edit forms return to their stable visible opener', async () => {
  for (const outcome of ['resolve', 'reject'] as const) await withDatabaseForms(async context => {
    await context.open('edit')
    await context.fill(context.name(), 'Old edit X')
    await context.fill(context.description(), 'Old description X')
    await context.submit()
    await context.close('button')
    await context.open('edit')
    await context.fill(context.name(), 'New edit Y')
    await context.fill(context.description(), 'New description Y')
    const focused = context.description()
    await context.change(() => focused.focus())
    assert.equal(context.name().readOnly || context.description().readOnly, false)
    assert.equal(context.submitButton().disabled, false)
    assert.equal(context.submitButton().getAttribute('aria-disabled'), 'true')
    assert.equal(context.submitButton().textContent, context.text.waitingForSave)
    await context.submit(2)
    assert.equal(context.updates.length, 1, 'A newer editable form must not bypass the same-database write lock')
    if (outcome === 'resolve') {
      await context.resolve('edit')
      for (let index = 0; index < context.refreshes.length; index++) await context.resolveRefresh(index)
    } else await context.reject('edit')
    await context.flushFrames()
    assert.equal(context.name().value, 'New edit Y')
    assert.equal(context.description().value, 'New description Y')
    assert.equal(context.document.activeElement === focused, true)
    assert.equal(error(context), '')
    assert.equal(context.messages.length, 0)
    assert.equal(context.submitButton().getAttribute('aria-disabled'), 'false')
    await context.submit(2)
    assert.equal(context.updates.length, 2)
    assert.deepEqual(context.updates[1].input, { databaseId: 'a', name: 'New edit Y', description: 'New description Y' })
    const opener = context.document.querySelector<HTMLButtonElement>('.dbw-header-actions .dbw-menu-wrap > button')!
    await context.resolve('edit', 1)
    noForm(context)
    await context.flushFrames()
    assert.equal(context.document.activeElement === opener, true)
    assert.equal(context.focusCalls.at(-1)!.options?.preventScroll, true)
  })
  for (const locale of ['en-US', 'zh-CN']) for (const kind of ['create', 'edit'] as const) {
    for (const completion of ['escape', 'button', 'success'] as const) await withDatabaseForms(async context => {
      const opener = context.document.querySelector<HTMLButtonElement>(kind === 'create'
        ? '.dbw-source-trigger' : '.dbw-header-actions .dbw-menu-wrap > button')!
      // Explicit opener focus and the initial RAF use the actual DOM focus
      // lifecycle; the hidden action-menu item is not the return target.
      await context.change(() => opener.focus())
      await context.open(kind)
      assert.equal(context.document.activeElement === context.name(), true)
      if (completion === 'success') {
        await context.fill(context.name(), 'Accepted database')
        await context.submit()
        const saved = await context.resolve(kind)
        assert.equal(context.model().source, kind === 'create' ? saved.id : 'a')
        assert.equal(context.refreshes.length, 1, 'Focus return must not wait for the background refresh')
      } else await context.close(completion)
      noForm(context)
      await context.flushFrames()
      assert.equal(context.document.activeElement === opener, true)
      assert.equal(opener.isConnected && opener.getClientRects().length > 0, true)
      assert.equal(context.focusCalls.at(-1)!.options?.preventScroll, true)
    }, locale)
  }
})

test('a parent-owned draft cache retains the whole dirty view across real Workspace remounts and metadata ACK without autosaving', async () => {
  const cache = new Map<string, DatabaseViewConfigV1>()
  await withDatabaseForms(async context => {
    await context.fill(context.query(), 'Dirty query Beta')
    const cards = context.document.querySelector<HTMLButtonElement>(`.dbw-layout-switcher button[aria-label="${context.text.cards}"]`)!
    await context.change(() => cards.click())
    await context.change(() => context.document.querySelector<HTMLElement>('.dbw-toolbar-menu summary')!.click())
    const addFilter = [...context.document.querySelectorAll<HTMLButtonElement>('.dbw-add-config-row')].find(button => button.textContent === `＋ ${context.text.addFilter}`)!
    await context.change(() => addFilter.click())
    await context.fill(context.document.querySelector<HTMLInputElement>('.dbw-filter-value')!, 'Complete filter Beta')
    const cached = [...cache.values()].find(config => config.query === 'Dirty query Beta')
    assert.ok(cached)
    const completeDraft = clone(cached)
    const assertDraft = () => {
      assert.equal(context.query().value, 'Dirty query Beta')
      assert.equal(context.document.querySelector('.dbw-layout-switcher [aria-pressed="true"]')!.getAttribute('aria-label'), context.text.cards)
      assert.equal(context.document.querySelector<HTMLInputElement>('.dbw-filter-value')!.value, 'Complete filter Beta')
      assert.equal(context.document.querySelectorAll('.dbw-unsaved-dot').length, 1)
      assert.equal(context.document.querySelector<HTMLButtonElement>('.dbw-save-button')!.disabled, false)
      assert.deepEqual([...cache.values()].find(config => config.query === 'Dirty query Beta'), completeDraft)
    }
    await context.open('edit')
    await context.fill(context.name(), 'Metadata ACK preserves Beta')
    await context.submit()
    await context.resolve('edit')
    noForm(context)
    assert.equal(context.document.querySelector('.dbw-source-trigger')!.getAttribute('title'), 'Metadata ACK preserves Beta')
    assertDraft()
    assert.equal(context.refreshes.length, 1, 'The metadata refresh remains pending')
    await context.leavePage()
    assert.equal(context.document.querySelectorAll('.dbw-shell').length, 0, 'Workspace is physically unmounted, rather than hidden')
    await context.enterPage()
    await context.flushFrames()
    assertDraft()
    await context.resolveRefresh()
    assertDraft()
    await context.leavePage()
    await context.navigate('b', 'b-primary')
    await context.enterPage()
    assert.equal(context.query().value, '')
    await context.fill(context.query(), 'Independent source Gamma')
    await context.leavePage()
    await context.navigate('a', 'a-primary')
    await context.enterPage()
    await context.flushFrames()
    assertDraft()
    assert.equal(context.model().active, 'a-primary')
    assert.equal(context.creates.length, 0)
    assert.equal(context.updates.length, 1, 'Only the explicit metadata write ran; remount must not save a view or database')
    assert.deepEqual(context.updates[0].input, { databaseId: 'a', name: 'Metadata ACK preserves Beta', description: 'Description A' })
    assert.equal(context.messages.length, 0)
  }, 'en-US', cache)
})

test('a database write ACK releases the next edit before refresh, and old metadata reads cannot roll back the later ACK', async () => {
  await withDatabaseForms(async context => {
    await context.fill(context.query(), 'Dirty query after write')
    await context.open('edit')
    await context.fill(context.name(), 'Accepted edit X')
    await context.fill(context.description(), 'Accepted description X')
    await context.submit()
    await context.resolve('edit')
    noForm(context)
    assert.equal(context.refreshes.length, 1, 'The first metadata read is still pending')
    await context.open('edit')
    assert.equal(context.name().value, 'Accepted edit X')
    await context.fill(context.name(), 'New edit Y')
    await context.fill(context.description(), 'New description Y')
    const focused = context.description()
    await context.change(() => focused.focus())
    assert.equal(context.submitButton().getAttribute('aria-disabled'), 'false')
    assert.equal(context.submitButton().getAttribute('aria-busy'), 'false')
    assert.equal(context.submitButton().textContent, context.text.save)
    await context.submit(2)
    assert.equal(context.updates.length, 2, 'A completed write must not leave the new form waiting for an old read')
    assert.equal(context.document.activeElement === focused, true)
    assert.deepEqual(context.updates[1].input, { databaseId: 'a', name: 'New edit Y', description: 'New description Y' })
    await context.resolve('edit', 1)
    noForm(context)
    assert.equal(context.model().databases.find(candidate => candidate.id === 'a')!.name, 'New edit Y')
    assert.equal(context.refreshes.length, 2)
    await context.change(() => context.query().focus())
    await context.resolveRefresh(0)
    await context.flushFrames()
    assert.equal(context.document.querySelector('.dbw-source-trigger')!.getAttribute('title'), 'New edit Y')
    assert.equal(context.document.querySelector('.dbw-identity p')!.textContent, 'New description Y')
    assert.equal(context.query().value, 'Dirty query after write')
    assert.equal(context.document.activeElement === context.query(), true)
    await context.resolveRefresh(1)
    assert.equal(context.model().databases.find(candidate => candidate.id === 'a')!.description, 'New description Y')
    assert.equal(context.query().value, 'Dirty query after write')
    assert.equal(context.document.activeElement === context.query(), true)
    assert.equal(context.document.querySelectorAll('.dbw-unsaved-dot').length, 1)
    assert.equal(context.model().active, 'a-primary')
    assert.equal(context.sourceChanges.length, 0)
    assert.equal(context.messages.length, 0)
  })
})
