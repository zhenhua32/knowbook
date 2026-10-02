import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { CreateDatabaseSavedViewInput, DatabaseSavedView, DatabaseSavedViewFormResult, DocumentDatabase, UpdateDatabaseSavedViewInput } from '../src/shared/contracts'
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
function view(source: string, suffix: string): DatabaseSavedView {
  return { id: `${source}-${suffix}`, databaseId: source, name: `${source.toUpperCase()} ${suffix}`,
    config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, DATABASE_SYSTEM_FIELD_IDS.updatedAt]),
    configVersion: 1, filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }
}
const sources: DocumentDatabase[] = ['a', 'b'].map(id => ({ id, kind: 'custom', name: `Source ${id.toUpperCase()}`,
  description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
type Model = { source: string; active: string; views: Record<string, DatabaseSavedView[]> }
type InvalidName = Extract<DatabaseSavedViewFormResult, { status: 'invalid-name' }>
type Update = ReturnType<typeof deferred<DatabaseSavedView>> & { input: UpdateDatabaseSavedViewInput; invalid?: InvalidName }
type Create = ReturnType<typeof deferred<DatabaseSavedView>> & { input: CreateDatabaseSavedViewInput; invalid?: InvalidName }
type Refresh = ReturnType<typeof deferred<void>> & { source: string; preferred?: string; settled: boolean }
type Context = {
  document: Document
  text: ReturnType<typeof getDatabaseWorkspaceText>
  updates: Update[]
  creates: Create[]
  refreshes: Refresh[]
  messages: Array<{ message: Parameters<AppMessageHandler>[0]; level?: Parameters<AppMessageHandler>[1] }>
  viewChanges: string[]
  model: () => Model
  form: () => HTMLFormElement
  name: () => HTMLInputElement
  submitButton: () => HTMLButtonElement
  query: () => HTMLInputElement
  ordinarySave: () => HTMLButtonElement
  fill: (input: HTMLInputElement, value: string) => Promise<void>
  change: (run: () => void) => Promise<void>
  click: (element: HTMLElement) => Promise<void>
  submit: (count?: number) => Promise<void>
  key: (element: HTMLElement, key: string) => Promise<KeyboardEvent>
  open: (kind: 'rename' | 'create') => Promise<void>
  close: (kind: 'escape' | 'button') => Promise<void>
  addFilter: (value: string) => Promise<void>
  resolveUpdate: (index?: number) => Promise<DatabaseSavedView>
  resolveCreate: (index?: number) => Promise<DatabaseSavedView>
  reject: (kind: 'rename' | 'create', index?: number, message?: string) => Promise<void>
  invalidateName: (kind: 'rename' | 'create', index?: number, reason?: InvalidName['reason'], message?: string) => Promise<void>
  resolveRefresh: (index?: number) => Promise<void>
  rejectRefresh: (index?: number) => Promise<void>
  navigate: (source: string, active: string) => Promise<void>
  unmount: () => Promise<void>
}

async function withForms(run: (context: Context) => Promise<void>, locale = 'en-US') {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside control">', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id: number) => frames.delete(id) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 160, 32) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.closest('[hidden], [inert]') ? [] : [this.getBoundingClientRect()]
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const server: Record<string, DatabaseSavedView[]> = { a: [view('a', 'primary'), view('a', 'secondary')], b: [view('b', 'primary')] }
  const updates: Update[] = []
  const creates: Create[] = []
  const refreshes: Refresh[] = []
  const messages: Context['messages'] = []
  const viewChanges: string[] = []
  let createId = 0
  const queueUpdate = (input: UpdateDatabaseSavedViewInput): Update => {
    const request = { ...deferred<DatabaseSavedView>(), input: clone(input) }; updates.push(request); return request
  }
  const queueCreate = (input: CreateDatabaseSavedViewInput): Create => {
    const request = { ...deferred<DatabaseSavedView>(), input: clone(input) }; creates.push(request); return request
  }
  const formResult = (request: Update | Create): Promise<DatabaseSavedViewFormResult> => request.promise.then(
    saved => ({ status: 'saved' as const, view: saved }),
    error => {
      // The legacy API still rejects this business error. The form API
      // independently resolves the typed outcome supplied by the IPC fixture.
      if (request.invalid) return request.invalid
      throw error
    }
  )
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseSavedView: (input: UpdateDatabaseSavedViewInput) => queueUpdate(input).promise,
    createDatabaseSavedView: (input: CreateDatabaseSavedViewInput) => queueCreate(input).promise,
    updateDatabaseSavedViewForm: (input: UpdateDatabaseSavedViewInput) => formResult(queueUpdate(input)),
    createDatabaseSavedViewForm: (input: CreateDatabaseSavedViewInput) => formResult(queueCreate(input))
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
    const request = { ...deferred<void>(), source, preferred, settled: false }
    const requestId = ++refreshGeneration
    const session = sourceGeneration
    refreshes.push(request)
    await request.promise
    if (!mounted || requestId !== refreshGeneration || session !== sourceGeneration || current.source !== source) return
    const views = clone(server[source])
    updateModel(previous => ({ ...previous, views: { ...previous.views, [source]: views },
      active: views.some(candidate => candidate.id === preferred) ? preferred! : previous.active }))
  }
  function Harness() {
    const [model, setModel] = useState<Model>(() => ({ source: 'a', active: 'a-primary', views: clone(server) }))
    current = model; updateModel = setModel
    return createElement(DatabaseWorkspace, {
      currentDatabaseId: model.source, activeViewId: model.active, databases: sources, savedViews: model.views[model.source], locale,
      catalogColumns: [], catalogDocuments: [], entities: [], selectedColumns: [], selectedRecordIds: [],
      onActiveViewIdChange: id => { viewChanges.push(id); setModel(previous => ({ ...previous, active: id })) },
      onCurrentDatabaseIdChange: id => { sourceGeneration++; refreshGeneration++; setModel(previous => ({ ...previous, source: id, active: `${id}-primary` })) },
      onSavedView: saved => {
        if (!mounted || current.source !== saved.databaseId) return
        setModel(previous => {
          const previousViews = previous.views[saved.databaseId]
          const views = previousViews.some(candidate => candidate.id === saved.id)
            ? previousViews.map(candidate => candidate.id === saved.id ? clone(saved) : candidate) : [...previousViews, clone(saved)]
          return { ...previous, views: { ...previous.views, [saved.databaseId]: views } }
        })
      },
      onMessage: (message, level) => { messages.push({ message, level }) }, onRefresh: refresh,
      onOpenDocument: () => {}, onSelectedRecordIdsChange: () => {}
    })
  }
  const flushFrames = async () => { await act(async () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0))
  }) }
  const change = async (callback: () => void) => { await act(async () => callback()); await flushFrames() }
  const click = async (element: HTMLElement) => change(() => element.click())
  const form = () => { const result = dom.window.document.querySelector<HTMLFormElement>('form.dbw-dialog'); assert.ok(result); return result }
  const name = () => form().querySelector<HTMLInputElement>('label input')!
  const submitButton = () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!
  const query = () => dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
  const fill = async (input: HTMLInputElement, value: string) => change(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const resolveUpdate = async (index = 0) => {
    const request = updates[index]; assert.ok(request)
    const previous = Object.values(server).flat().find(candidate => candidate.id === request.input.viewId)!
    assert.ok(previous)
    const config = clone(request.input.config ?? previous.config)
    const updated = { ...previous, name: request.input.name ?? previous.name, config,
      filterQuery: config.query, viewMode: config.layout, updatedAt: '2026-10-02' }
    server[previous.databaseId] = server[previous.databaseId].map(candidate => candidate.id === previous.id ? updated : candidate)
    await change(() => request.resolve(clone(updated)))
    return updated
  }
  const resolveCreate = async (index = 0) => {
    const request = creates[index]; assert.ok(request)
    const config = clone(request.input.config ?? createDefaultDatabaseViewConfig())
    const created: DatabaseSavedView = { ...view(request.input.databaseId, 'created'), id: `created-${++createId}`,
      name: request.input.name, config, filterQuery: config.query, viewMode: config.layout }
    server[created.databaseId] = [...server[created.databaseId], created]
    await change(() => request.resolve(clone(created)))
    return created
  }
  const resolveRefresh = async (index = 0) => {
    assert.ok(refreshes[index]); refreshes[index].settled = true; await change(() => refreshes[index].resolve())
  }
  const unmount = async () => { if (mounted) { mounted = false; sourceGeneration++; refreshGeneration++; await act(async () => root.unmount()) } }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, text, updates, creates, refreshes, messages, viewChanges,
      model: () => current, form, name, submitButton, query, ordinarySave: () => dom.window.document.querySelector<HTMLButtonElement>('.dbw-save-button')!,
      fill, change, click, resolveUpdate, resolveCreate, resolveRefresh, unmount,
      submit: async (count = 1) => change(() => { const currentForm = form();
        for (let index = 0; index < count; index++) currentForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })) }),
      key: async (element, key) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        await change(() => element.dispatchEvent(event)); return event
      },
      open: async kind => {
        if (kind === 'rename') {
          const active = dom.window.document.querySelector<HTMLButtonElement>('.dbw-view-tab[aria-current="page"]')!
          await change(() => active.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })))
        } else {
          await click(dom.window.document.querySelector<HTMLElement>('.dbw-new-view-menu summary')!)
          const table = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-layout-menu button')].find(button => button.textContent === text.table)!
          await click(table)
        }
      },
      close: async kind => {
        if (kind === 'escape') await change(() => name().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
        else await click(form().querySelector<HTMLButtonElement>('header button')!)
      },
      addFilter: async value => {
        const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-add-config-row')].find(item => item.textContent === `＋ ${text.addFilter}`)!
        await click(button)
        await fill(dom.window.document.querySelector<HTMLInputElement>('.dbw-filter-value')!, value)
      },
      reject: async (kind, index = 0, message = 'View mutation failed.') => change(() => (kind === 'rename' ? updates[index] : creates[index]).reject(new Error(message))),
      invalidateName: async (kind, index = 0, reason = 'name-taken', message = 'A saved view with this name already exists in this database.') => {
        const request = kind === 'rename' ? updates[index] : creates[index]
        assert.ok(request)
        await change(() => {
          request.invalid = { status: 'invalid-name', reason, message }
          request.reject(new Error(message))
        })
      },
      rejectRefresh: async (index = 0) => { assert.ok(refreshes[index]); refreshes[index].settled = true;
        await change(() => refreshes[index].reject(new Error('View refresh failed.'))) },
      navigate: async (source, active) => change(() => {
        if (source !== current.source) { sourceGeneration++; refreshGeneration++ }
        updateModel(previous => ({ ...previous, source, active }))
      }) })
  } finally {
    await unmount()
    await act(async () => {
      for (const request of updates) request.resolve(clone(server.a[0]))
      for (const request of creates) request.resolve(clone(server.a[0]))
      for (const request of refreshes) request.resolve()
    })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function pending(context: Context) {
  assert.equal(context.name().readOnly, true)
  assert.equal(context.name().disabled, false)
  assert.equal(context.submitButton().disabled, false)
  assert.equal(context.submitButton().getAttribute('aria-disabled'), 'true')
  assert.equal(context.submitButton().getAttribute('aria-busy'), 'true')
  assert.equal(context.form().querySelectorAll('[role="status"]').length > 0, true)
}
function noForm(context: Context) { assert.equal(context.document.querySelectorAll('form.dbw-dialog').length, 0) }
function error(context: Context) { return context.form().querySelector('.dbw-form-error-details pre')?.textContent ?? context.form().querySelector('[role="alert"]')?.textContent ?? '' }
async function drainRefreshes(context: Context) {
  for (let index = 0; index < context.refreshes.length; index++) if (!context.refreshes[index].settled) await context.resolveRefresh(index)
}
async function resolveMutation(context: Context, kind: 'rename' | 'create', index = 0) {
  return kind === 'rename' ? context.resolveUpdate(index) : context.resolveCreate(index)
}

test('renaming is single-flight and retains the entire dirty view through failure, retry and a saved base refresh in both languages', async () => {
  for (const locale of ['en-US', 'zh-CN']) {
    await withForms(async context => {
      await context.fill(context.query(), 'Dirty query B')
      await context.addFilter('Whole filter B')
      await context.click(context.document.querySelector<HTMLButtonElement>(`.dbw-layout-switcher button[aria-label="${context.text.cards}"]`)!)
      await context.open('rename')
      await context.fill(context.name(), 'Renamed view')
      const input = context.name()
      await context.submit(2)
      assert.equal(context.updates.length, 1)
      assert.deepEqual(context.updates[0].input, { viewId: 'a-primary', name: 'Renamed view' })
      pending(context)
      assert.equal(context.document.activeElement === input, true)
      await context.reject('rename', 0, "Error invoking remote method 'knowbook:update-database-saved-view': Error: View mutation failed.")
      assert.equal(context.name().value, 'Renamed view')
      assert.equal(context.name().readOnly, false)
      assert.equal(context.name().getAttribute('aria-invalid') === 'true', false)
      assert.equal(context.form().querySelector('[role="alert"]')?.textContent, locale === 'zh-CN'
        ? '保存失败，输入已保留，可以重试。' : 'Could not save. Your input has been kept. Try again.')
      assert.equal(context.form().querySelector<HTMLDetailsElement>('.dbw-form-error-details')?.open, false)
      assert.equal(error(context), 'View mutation failed.')
      assert.equal(context.query().value, 'Dirty query B')
      // The key remains available to the browser. The explicit submit below
      // separately exercises form retry, without emulating native Enter activation.
      assert.equal((await context.key(context.name(), 'Enter')).defaultPrevented, false)
      await context.submit()
      assert.equal(context.updates.length, 2)
      assert.equal(error(context), '')
      await context.resolveUpdate(1)
      noForm(context)
      assert.equal(context.model().views.a[0].name, 'Renamed view')
      assert.equal(context.query().value, 'Dirty query B')
      await drainRefreshes(context)
      assert.equal(context.query().value, 'Dirty query B')
      assert.equal(context.document.querySelector<HTMLInputElement>('.dbw-filter-value')!.value, 'Whole filter B')
      assert.equal(context.document.querySelector('.dbw-layout-switcher [aria-pressed="true"]')!.getAttribute('aria-label'), context.text.cards)
      await context.click(context.ordinarySave())
      const payload = context.updates[2].input.config!
      assert.equal(payload.query, 'Dirty query B')
      assert.equal(payload.layout, 'cards')
      assert.equal(payload.filters.rules.length, 1)
      assert.equal('value' in payload.filters.rules[0] && payload.filters.rules[0].value, 'Whole filter B')
    }, locale)
  }
})

test('creating retries its local failed name and activates the accepted view before refresh without overwriting later edits', async () => {
  for (const locale of ['en-US', 'zh-CN']) {
    await withForms(async context => {
      await context.fill(context.query(), 'Copied draft B')
      await context.open('create')
      await context.fill(context.name(), 'Created view')
      const input = context.name()
      await context.submit(2)
      assert.equal(context.creates.length, 1)
      assert.equal(context.creates[0].input.name, 'Created view')
      assert.equal(context.creates[0].input.config!.query, 'Copied draft B')
      pending(context)
      assert.equal(context.document.activeElement === input, true)
      await context.reject('create')
      assert.equal(context.name().value, 'Created view')
      assert.equal(context.name().getAttribute('aria-invalid') === 'true', false)
      assert.equal(context.form().querySelector('[role="alert"]')?.textContent, locale === 'zh-CN'
        ? '保存失败，输入已保留，可以重试。' : 'Could not save. Your input has been kept. Try again.')
      assert.equal(context.form().querySelector<HTMLDetailsElement>('.dbw-form-error-details')?.open, false)
      assert.equal(error(context).includes('View mutation failed.'), true)
      assert.equal((await context.key(context.name(), 'Enter')).defaultPrevented, false)
      await context.submit()
      assert.equal(context.creates.length, 2)
      const created = await context.resolveCreate(1)
      noForm(context)
      assert.equal(context.model().active, created.id)
      assert.equal(context.model().views.a.some(candidate => candidate.id === created.id), true)
      await context.fill(context.query(), 'Edited after ACK C')
      await context.change(() => context.query().focus())
      await drainRefreshes(context)
      assert.equal(context.query().value, 'Edited after ACK C')
      assert.equal(context.document.activeElement === context.query(), true)
      assert.equal(context.ordinarySave().disabled, false)
      await context.click(context.ordinarySave())
      assert.equal(context.updates[0].input.viewId, created.id)
      assert.equal(context.updates[0].input.config!.query, 'Edited after ACK C')
    }, locale)
  }
})

test('accepted create and rename stay closed and saved when only the refresh fails, rather than inviting another mutation', async () => {
  for (const kind of ['rename', 'create'] as const) {
    await withForms(async context => {
      await context.open(kind)
      await context.fill(context.name(), 'Accepted name')
      await context.submit()
      const saved = await resolveMutation(context, kind)
      noForm(context)
      assert.equal(context.model().views.a.find(candidate => candidate.id === saved.id)!.name, 'Accepted name')
      if (kind === 'create') assert.equal(context.model().active, saved.id)
      await context.change(() => context.query().focus())
      await context.rejectRefresh()
      noForm(context)
      assert.equal(context.messages.at(-1)!.message, context.text.viewsSavedRefreshFailed)
      assert.equal(context.document.activeElement === context.query(), true)
      assert.equal(context.ordinarySave().disabled, true)
      assert.equal(context.updates.length + context.creates.length, 1)
    })
  }
})

test('busy Escape and Close abandon only the form owner so an old success or failure cannot close or contaminate a reopened form', async () => {
  for (const kind of ['rename', 'create'] as const) {
    for (const close of ['escape', 'button'] as const) {
      for (const outcome of ['success', 'failure'] as const) {
        await withForms(async context => {
          await context.open(kind)
          await context.fill(context.name(), 'Old owner X')
          await context.submit()
          await context.close(close)
          noForm(context)
          await context.open(kind)
          await context.fill(context.name(), 'New owner Y')
          const currentForm = context.form()
          const currentInput = context.name()
          const active = context.model().active
          const changes = context.viewChanges.length
          const messages = context.messages.length
          if (outcome === 'success') await resolveMutation(context, kind)
          else await context.reject(kind)
          await drainRefreshes(context)
          assert.equal(context.form() === currentForm, true)
          assert.equal(context.name().value, 'New owner Y')
          assert.equal(context.name().readOnly, false)
          assert.equal(context.submitButton().getAttribute('aria-busy') === 'true', false)
          assert.equal(error(context), '')
          assert.equal(context.document.activeElement === currentInput, true)
          assert.equal(context.model().active, active)
          assert.equal(context.viewChanges.length, changes)
          assert.equal(context.messages.length, messages)
        })
      }
    }
  }
  for (const kind of ['rename', 'create'] as const) {
    await withForms(async context => {
      await context.fill(context.query(), 'Original dirty B')
      await context.open(kind)
      await context.fill(context.name(), 'Closed pending owner')
      await context.submit()
      await context.close('escape')
      noForm(context)
      const active = context.model().active
      const changes = context.viewChanges.length
      await context.change(() => context.query().focus())
      await context.reject(kind)
      noForm(context)
      assert.deepEqual(context.messages, [{ message: 'View mutation failed.', level: 'error' }])
      assert.equal(context.model().active, active)
      assert.equal(context.viewChanges.length, changes)
      assert.equal(context.query().value, 'Original dirty B')
      assert.equal(context.ordinarySave().disabled, false)
      assert.equal(context.document.activeElement === context.query(), true)
    })
  }
  await withForms(async context => {
    await context.fill(context.query(), 'Original dirty B')
    await context.open('create')
    await context.fill(context.name(), 'Accepted after close')
    await context.submit()
    await context.close('button')
    const active = context.model().active
    const changes = context.viewChanges.length
    await context.change(() => context.query().focus())
    const created = await context.resolveCreate()
    noForm(context)
    assert.equal(context.model().views.a.some(candidate => candidate.id === created.id), true)
    assert.equal(context.model().active, active)
    assert.equal(context.viewChanges.length, changes, 'An accepted background creation must not activate its view after the form was closed')
    await context.rejectRefresh()
    noForm(context)
    assert.equal(context.messages.length, 1)
    assert.equal(context.messages[0].message, context.text.viewsSavedRefreshFailed)
    assert.equal(context.model().active, active)
    assert.equal(context.viewChanges.length, changes)
    assert.equal(context.query().value, 'Original dirty B')
    assert.equal(context.ordinarySave().disabled, false)
    assert.equal(context.document.activeElement === context.query(), true)
    assert.equal(context.creates.length, 1)
  })
})

test('late form results after a view, source or unmount transition cannot activate the original target or replace the current draft', async () => {
  for (const kind of ['rename', 'create'] as const) {
    for (const transition of ['view', 'source', 'unmount'] as const) {
      await withForms(async context => {
        await context.open(kind)
        await context.fill(context.name(), 'Stale form')
        await context.submit()
        if (transition === 'unmount') await context.unmount()
        else {
          await context.navigate(transition === 'view' ? 'a' : 'b', transition === 'view' ? 'a-secondary' : 'b-primary')
          await context.fill(context.query(), 'Current context draft')
          await context.change(() => context.query().focus())
        }
        const changes = context.viewChanges.length
        const active = context.model().active
        const messages = context.messages.length
        await resolveMutation(context, kind)
        await drainRefreshes(context)
        assert.equal(context.model().active, active)
        assert.equal(context.viewChanges.length, changes)
        assert.equal(context.messages.length, messages)
        if (transition === 'unmount') assert.equal(context.document.querySelectorAll('.dbw-shell').length, 0)
        else {
          assert.equal(context.query().value, 'Current context draft')
          assert.equal(context.document.activeElement === context.query(), true)
        }
      })
    }
  }
})

test('rename and ordinary Save share a view mutation lock in both directions without discarding the dirty query', async () => {
  for (const first of ['rename', 'ordinary'] as const) {
    await withForms(async context => {
      await context.fill(context.query(), 'Dirty shared draft')
      if (first === 'ordinary') await context.click(context.ordinarySave())
      await context.open('rename')
      await context.fill(context.name(), 'Shared rename')
      await context.submit()
      if (first === 'rename') await context.click(context.ordinarySave())
      assert.equal(context.updates.length, 1)
      if (first === 'rename') {
        assert.equal(context.updates[0].input.config, undefined)
        await context.resolveUpdate()
        await drainRefreshes(context)
        assert.equal(context.query().value, 'Dirty shared draft')
        await context.click(context.ordinarySave())
        assert.equal(context.updates.length, 2)
        assert.equal(context.updates[1].input.config!.query, 'Dirty shared draft')
      } else {
        assert.equal(context.updates[0].input.config!.query, 'Dirty shared draft')
        await context.resolveUpdate()
        await drainRefreshes(context)
        assert.equal(context.name().value, 'Shared rename')
        await context.submit()
        assert.equal(context.updates.length, 2)
        assert.deepEqual(context.updates[1].input, { viewId: 'a-primary', name: 'Shared rename' })
      }
    })
  }
})

test('typed duplicate names give one localized field error and a correction can retry without losing the view draft', async () => {
  const backendMessage = 'A saved view with this name already exists in this database.'
  for (const locale of ['en-US', 'zh-CN']) {
    for (const kind of ['rename', 'create'] as const) {
      await withForms(async context => {
        await context.fill(context.query(), 'Unsaved query B')
        await context.addFilter('Unsaved filter B')
        await context.click(context.document.querySelector<HTMLButtonElement>(`.dbw-layout-switcher button[aria-label="${context.text.cards}"]`)!)
        const originalConfig = clone(context.model().views.a[0].config)
        await context.open(kind)
        await context.fill(context.name(), '  A SECONDARY  ')
        const originalForm = context.form()
        const originalInput = context.name()
        const activeView = context.model().active
        await context.submit(2)
        const requests = kind === 'rename' ? context.updates : context.creates
        assert.equal(requests.length, 1)
        assert.equal(requests[0].input.name, 'A SECONDARY')
        await context.invalidateName(kind, 0, 'name-taken', backendMessage)

        assert.equal(context.form() === originalForm, true)
        assert.equal(context.name() === originalInput, true)
        assert.equal(context.name().value, '  A SECONDARY  ')
        assert.equal(context.name().readOnly, false)
        assert.equal(context.document.activeElement === originalInput, true)
        assert.equal(context.name().getAttribute('aria-invalid'), 'true')
        const alerts = context.form().querySelectorAll<HTMLElement>('[role="alert"]')
        assert.equal(alerts.length, 1)
        const fieldError = alerts[0]
        assert.equal(fieldError.textContent, locale === 'zh-CN'
          ? '此数据库中已有同名视图，请换一个名称。'
          : 'A view with this name already exists in this database. Choose another name.')
        assert.equal(Boolean(fieldError.id), true)
        assert.equal((context.name().getAttribute('aria-describedby') ?? '').split(/\s+/).includes(fieldError.id), true)
        assert.equal((context.submitButton().getAttribute('aria-describedby') ?? '').split(/\s+/).includes(fieldError.id), true)
        assert.equal(Boolean(fieldError.closest('[aria-busy="true"]')), false)
        assert.equal(context.form().querySelector<HTMLDetailsElement>('.dbw-form-error-details')?.open, false)
        assert.equal(error(context), backendMessage)
        assert.equal(context.model().active, activeView)
        assert.deepEqual(context.model().views.a[0].config, originalConfig)
        assert.equal(context.refreshes.length, 0)
        assert.equal(context.messages.length, 0)
        assert.equal(context.query().value, 'Unsaved query B')
        assert.equal(context.document.querySelector<HTMLInputElement>('.dbw-filter-value')!.value, 'Unsaved filter B')
        assert.equal(context.document.querySelector('.dbw-layout-switcher [aria-pressed="true"]')!.getAttribute('aria-label'), context.text.cards)
        assert.equal(context.ordinarySave().disabled, false)

        await context.fill(context.name(), 'Corrected view name')
        assert.equal(context.name().getAttribute('aria-invalid') === 'true', false)
        assert.equal((context.name().getAttribute('aria-describedby') ?? '').split(/\s+/).includes(fieldError.id), false)
        assert.equal(context.form().querySelectorAll('[role="alert"]').length, 0)
        assert.equal(context.form().querySelectorAll('.dbw-form-error-details').length, 0)
        assert.equal(context.document.activeElement === originalInput, true)
        // A dispatched key does not simulate the browser's native Enter-to-submit.
        assert.equal((await context.key(originalInput, 'Enter')).defaultPrevented, false)
        await context.submit()
        assert.equal(requests.length, 2)
        assert.equal(requests[1].input.name, 'Corrected view name')
        pending(context)
        const accepted = await resolveMutation(context, kind, 1)
        noForm(context)
        assert.equal(context.model().views.a.find(candidate => candidate.id === accepted.id)!.name, 'Corrected view name')
        await drainRefreshes(context)
        if (kind === 'create') await context.navigate('a', 'a-primary')
        assert.equal(context.query().value, 'Unsaved query B')
        assert.equal(context.document.querySelector<HTMLInputElement>('.dbw-filter-value')!.value, 'Unsaved filter B')
        assert.equal(context.document.querySelector('.dbw-layout-switcher [aria-pressed="true"]')!.getAttribute('aria-label'), context.text.cards)
        assert.equal(context.ordinarySave().disabled, false)
      }, locale)
    }
  }
})

test('a duplicate-looking exception is still a generic failure rather than a typed field error', async () => {
  const backendMessage = 'A saved view with this name already exists in this database.'
  for (const locale of ['en-US', 'zh-CN']) {
    for (const kind of ['rename', 'create'] as const) {
      await withForms(async context => {
        await context.open(kind)
        await context.fill(context.name(), 'Input retained after exception')
        const input = context.name()
        await context.submit()
        await context.reject(kind, 0, backendMessage)
        assert.equal(context.name().value, 'Input retained after exception')
        assert.equal(context.name().getAttribute('aria-invalid') === 'true', false)
        assert.equal(context.document.activeElement === input, true)
        assert.equal(context.form().querySelectorAll('[role="alert"]').length, 1)
        assert.equal(context.form().querySelector('[role="alert"]')?.textContent, locale === 'zh-CN'
          ? '保存失败，输入已保留，可以重试。' : 'Could not save. Your input has been kept. Try again.')
        assert.equal(context.form().querySelector<HTMLDetailsElement>('.dbw-form-error-details')?.open, false)
        assert.equal(error(context), backendMessage)
        assert.equal(context.refreshes.length, 0)
      }, locale)
    }
  }
})

test('a late typed name rejection cannot attach an error to a reopened form, another view or another source', async () => {
  for (const kind of ['rename', 'create'] as const) {
    for (const transition of ['reopen', 'view', 'source', 'unmount'] as const) {
      await withForms(async context => {
        await context.fill(context.query(), 'Original unsaved query')
        await context.open(kind)
        await context.fill(context.name(), 'Original pending name')
        await context.submit()
        if (transition === 'unmount') {
          await context.unmount()
          await context.invalidateName(kind)
          assert.equal(context.document.querySelectorAll('form.dbw-dialog').length, 0)
          assert.equal(context.messages.length, 0)
          assert.equal(context.refreshes.length, 0)
          return
        }
        if (transition === 'reopen') await context.close('button')
        else await context.navigate(transition === 'view' ? 'a' : 'b', transition === 'view' ? 'a-secondary' : 'b-primary')
        await context.fill(context.query(), 'Current unsaved query')
        await context.open(kind)
        await context.fill(context.name(), 'Current form name')
        const currentForm = context.form()
        const currentInput = context.name()
        const currentView = context.model().active
        const changes = context.viewChanges.length
        await context.invalidateName(kind)
        assert.equal(context.form() === currentForm, true)
        assert.equal(context.name().value, 'Current form name')
        assert.equal(context.name().readOnly, false)
        assert.equal(context.name().getAttribute('aria-invalid') === 'true', false)
        assert.equal(context.form().querySelectorAll('[role="alert"]').length, 0)
        assert.equal(context.form().querySelectorAll('.dbw-form-error-details').length, 0)
        assert.equal(context.document.activeElement === currentInput, true)
        assert.equal(context.query().value, 'Current unsaved query')
        assert.equal(context.model().active, currentView)
        assert.equal(context.viewChanges.length, changes)
        assert.equal(context.messages.length, 0)
        assert.equal(context.refreshes.length, 0)
      })
    }
  }
})
