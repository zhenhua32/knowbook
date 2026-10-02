import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { CreateDatabaseSavedViewInput, DatabaseSavedView, DocumentDatabase, UpdateDatabaseSavedViewInput } from '../src/shared/contracts'
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
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function view(source: string, suffix: string): DatabaseSavedView {
  return { id: `${source}-${suffix}`, databaseId: source, name: `${source.toUpperCase()} ${suffix}`,
    config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, DATABASE_SYSTEM_FIELD_IDS.updatedAt]),
    configVersion: 1, filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }
}
const databases: DocumentDatabase[] = ['a', 'b'].map(id => ({ id, kind: 'custom', name: `Source ${id.toUpperCase()}`,
  description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
type Model = { source: string; active: string; views: Record<string, DatabaseSavedView[]>; page: boolean }
type Kind = 'new' | 'save-as' | 'rename'
type FocusCall = { element: HTMLElement; options?: FocusOptions }
type Context = {
  document: Document
  text: ReturnType<typeof getDatabaseWorkspaceText>
  focusCalls: FocusCall[]
  creates: Array<ReturnType<typeof deferred<DatabaseSavedView>> & { input: CreateDatabaseSavedViewInput }>
  updates: Array<ReturnType<typeof deferred<DatabaseSavedView>> & { input: UpdateDatabaseSavedViewInput }>
  refreshes: Array<ReturnType<typeof deferred<void>> & { source: string; preferred?: string }>
  model: () => Model
  summary: () => HTMLElement
  form: () => HTMLFormElement
  name: () => HTMLInputElement
  query: () => HTMLInputElement
  open: (kind: Kind) => Promise<HTMLElement>
  close: (kind?: 'close' | 'escape') => Promise<void>
  fill: (input: HTMLInputElement, value: string) => Promise<void>
  change: (run: () => void) => Promise<void>
  submit: () => Promise<void>
  flushFrames: () => Promise<void>
  frameCount: () => number
  resolve: (kind: Kind) => Promise<DatabaseSavedView>
  navigate: (source: string, active: string) => Promise<void>
  leavePage: () => Promise<void>
  foreground: (focused: boolean) => void
  unmount: () => Promise<void>
}

async function withFocus(run: (context: Context) => Promise<void>, locale = 'en-US') {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside control">', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame }
  const cancelFrame = (id: number) => { frames.delete(id) }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: requestFrame })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: cancelFrame })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  let focused = true
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => focused })
  const isVisible = (element: HTMLElement) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const details = element.closest('details:not([open])')
    return !details || Boolean(details.querySelector('summary')?.contains(element))
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return isVisible(this) ? new dom.window.DOMRect(0, 0, 160, 32) : new dom.window.DOMRect()
  }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = isVisible(this) ? [this.getBoundingClientRect()] : []
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const focusCalls: FocusCall[] = []
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options) {
    focusCalls.push({ element: this, options })
    // JSDOM has no closed-details layout; keep its visibility/focusability
    // consistent with the native menu without fabricating keyboard activation.
    if (isVisible(this)) nativeFocus.call(this, options)
  }
  const server: Record<string, DatabaseSavedView[]> = { a: [view('a', 'primary'), view('a', 'secondary')], b: [view('b', 'primary')] }
  const creates: Context['creates'] = []
  const updates: Context['updates'] = []
  const refreshes: Context['refreshes'] = []
  const api = {
    createDatabaseSavedView: (input: CreateDatabaseSavedViewInput) => {
      const request = { ...deferred<DatabaseSavedView>(), input: clone(input) }; creates.push(request); return request.promise
    },
    updateDatabaseSavedView: (input: UpdateDatabaseSavedViewInput) => {
      const request = { ...deferred<DatabaseSavedView>(), input: clone(input) }; updates.push(request); return request.promise
    }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: {
    ...api,
    createDatabaseSavedViewForm: (input: CreateDatabaseSavedViewInput) => api.createDatabaseSavedView(input)
      .then(saved => ({ status: 'saved' as const, view: saved })),
    updateDatabaseSavedViewForm: (input: UpdateDatabaseSavedViewInput) => api.updateDatabaseSavedView(input)
      .then(saved => ({ status: 'saved' as const, view: saved }))
  } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const text = getDatabaseWorkspaceText(locale)
  let mounted = true
  let current!: Model
  let updateModel!: (update: SetStateAction<Model>) => void
  let generation = 0
  const refresh = async (source = current.source, preferred?: string) => {
    const request = { ...deferred<void>(), source, preferred }
    const session = generation
    refreshes.push(request)
    await request.promise
    if (!mounted || session !== generation || current.source !== source || !current.page) return
    updateModel(previous => ({ ...previous, views: { ...previous.views, [source]: clone(server[source]) },
      active: server[source].some(candidate => candidate.id === preferred) ? preferred! : previous.active }))
  }
  function Harness() {
    const [model, setModel] = useState<Model>(() => ({ source: 'a', active: 'a-primary', views: clone(server), page: true }))
    current = model; updateModel = setModel
    if (!model.page) return createElement('p', { id: 'other-page' }, 'Documents')
    return createElement(DatabaseWorkspace, {
      currentDatabaseId: model.source, activeViewId: model.active, databases, savedViews: model.views[model.source], locale,
      catalogColumns: [], catalogDocuments: [], entities: [], selectedColumns: [], selectedRecordIds: [],
      onActiveViewIdChange: active => setModel(previous => ({ ...previous, active })),
      onCurrentDatabaseIdChange: source => { generation++; setModel(previous => ({ ...previous, source, active: `${source}-primary` })) },
      onSavedView: saved => {
        if (!mounted || current.source !== saved.databaseId) return
        setModel(previous => {
          const views = previous.views[saved.databaseId]
          return { ...previous, views: { ...previous.views, [saved.databaseId]: views.some(candidate => candidate.id === saved.id)
            ? views.map(candidate => candidate.id === saved.id ? clone(saved) : candidate) : [...views, clone(saved)] } }
        })
      },
      onMessage: () => {}, onRefresh: refresh, onOpenDocument: () => {}, onSelectedRecordIdsChange: () => {}
    })
  }
  const change = async (callback: () => void) => { await act(async () => callback()) }
  const form = () => { const element = dom.window.document.querySelector<HTMLFormElement>('form.dbw-dialog'); assert.ok(element); return element }
  const name = () => form().querySelector<HTMLInputElement>('label input')!
  const summary = () => dom.window.document.querySelector<HTMLElement>('.dbw-new-view-menu summary')!
  const query = () => dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
  const fill = async (input: HTMLInputElement, value: string) => change(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const unmount = async () => { if (mounted) { mounted = false; generation++; await act(async () => root.unmount()) } }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, text, focusCalls, creates, updates, refreshes, model: () => current,
      form, name, summary, query, change, fill, frameCount: () => frames.size, unmount,
      flushFrames: async () => change(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) }),
      foreground: value => { focused = value },
      open: async kind => {
        let trigger: HTMLElement
        if (kind === 'new') {
          trigger = summary()
          await change(() => { trigger.focus(); trigger.click() })
          const table = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-layout-menu button')].find(button => button.textContent === text.table)!
          await change(() => { table.focus(); table.click() })
        } else if (kind === 'save-as') {
          trigger = dom.window.document.querySelector<HTMLButtonElement>('.dbw-save-as-button')!
          await change(() => { trigger.focus(); trigger.click() })
        } else {
          trigger = dom.window.document.querySelector<HTMLButtonElement>('.dbw-view-tab[aria-current="page"]')!
          await change(() => { trigger.focus(); trigger.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })) })
        }
        return trigger
      },
      close: async (kind = 'close') => {
        if (kind === 'escape') await change(() => name().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
        else await change(() => form().querySelector<HTMLButtonElement>('header button')!.click())
      },
      submit: async () => change(() => form().dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))),
      resolve: async kind => {
        let saved: DatabaseSavedView
        if (kind === 'rename') {
          const request = updates.at(-1)!; assert.ok(request)
          const previous = Object.values(server).flat().find(candidate => candidate.id === request.input.viewId)!
          saved = { ...previous, name: request.input.name ?? previous.name }
          server[saved.databaseId] = server[saved.databaseId].map(candidate => candidate.id === saved.id ? saved : candidate)
          await change(() => request.resolve(clone(saved)))
        } else {
          const request = creates.at(-1)!; assert.ok(request)
          const config = clone(request.input.config ?? createDefaultDatabaseViewConfig())
          saved = { ...view(request.input.databaseId, 'created'), id: 'created-view', name: request.input.name, config,
            filterQuery: config.query, viewMode: config.layout }
          server[saved.databaseId] = [...server[saved.databaseId], saved]
          await change(() => request.resolve(clone(saved)))
        }
        return saved
      },
      navigate: async (source, active) => change(() => { generation++; updateModel(previous => ({ ...previous, source, active })) }),
      leavePage: async () => change(() => { generation++; updateModel(previous => ({ ...previous, page: false })) }) })
  } finally {
    await unmount()
    await act(async () => {
      for (const request of creates) request.resolve(clone(server.a[0]))
      for (const request of updates) request.resolve(clone(server.a[0]))
      for (const request of refreshes) request.resolve()
    })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('New view Close and Escape restore its visible summary rather than the hidden layout item in both languages', async () => {
  for (const locale of ['en-US', 'zh-CN']) {
    for (const close of ['close', 'escape'] as const) {
      await withFocus(async context => {
        const trigger = await context.open('new')
        const dialog = context.form()
        await context.flushFrames()
        assert.equal(context.document.activeElement === context.name(), true)
        await context.close(close)
        assert.equal(context.document.querySelectorAll('form.dbw-dialog').length, 0)
        await context.flushFrames()
        assert.equal(context.document.activeElement === trigger, true)
        assert.equal(trigger === context.summary(), true)
        assert.equal(trigger.getClientRects().length > 0, true)
        assert.equal(context.focusCalls.at(-1)!.options?.preventScroll, true)
        assert.equal(dialog.getAttribute('role'), 'dialog')
        assert.equal(dialog.getAttribute('aria-label'), context.text.newView)
        // A synthetic key only verifies that the restored summary does not
        // consume Enter; native disclosure activation is verified in Electron.
        const event = new context.document.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        await context.change(() => trigger.dispatchEvent(event))
        assert.equal(event.defaultPrevented, false)
        assert.equal(context.creates.length + context.updates.length, 0)
      }, locale)
    }
  }
})

test('a created view restores New view focus immediately after ACK without awaiting refresh or changing later query edits', async () => {
  await withFocus(async context => {
    await context.fill(context.query(), 'Submitted query')
    const trigger = await context.open('new')
    await context.flushFrames()
    await context.fill(context.name(), 'Focused creation')
    await context.submit()
    const created = await context.resolve('new')
    assert.equal(context.document.querySelectorAll('form.dbw-dialog').length, 0)
    assert.equal(context.model().active, created.id)
    assert.equal(context.refreshes.length, 1, 'The refresh remains genuinely pending')
    await context.flushFrames()
    assert.equal(context.document.activeElement === trigger, true)
    assert.equal(context.focusCalls.at(-1)!.options?.preventScroll, true)
    await context.fill(context.query(), 'New query C')
    await context.change(() => context.query().focus())
    await context.change(() => context.refreshes[0].resolve())
    await context.flushFrames()
    assert.equal(context.query().value, 'New query C')
    assert.equal(context.document.activeElement === context.query(), true)
    assert.equal(context.creates.length, 1)
    assert.equal(context.creates[0].input.name, 'Focused creation')
    assert.equal(context.creates[0].input.config!.query, 'Submitted query')
  })
})

test('queued restore yields to an external control, a new form or a background window instead of reclaiming focus', async () => {
  for (const cancellation of ['external', 'new-form', 'background'] as const) {
    await withFocus(async context => {
      await context.open('new')
      await context.flushFrames()
      await context.close()
      assert.equal(context.frameCount() > 0, true)
      let expected: HTMLElement
      if (cancellation === 'new-form') {
        await context.open('rename')
        expected = context.name()
      } else if (cancellation === 'background') {
        expected = context.document.body
        assert.equal(context.document.activeElement === expected, true)
        context.foreground(false)
      } else {
        expected = context.query()
        await context.change(() => expected.focus())
      }
      const firstCall = context.focusCalls.length
      await context.flushFrames()
      assert.equal(context.document.activeElement === expected, true)
      if (cancellation === 'new-form') {
        assert.equal(context.focusCalls.slice(firstCall).every(call => call.element === expected), true, 'An old restore must not briefly focus behind the newer form')
        assert.equal(context.form().getAttribute('aria-label'), context.text.rename)
      } else assert.equal(context.focusCalls.length, firstCall)
      if (cancellation === 'background') {
        context.foreground(true)
        await context.flushFrames()
        assert.equal(context.document.activeElement === expected, true)
        assert.equal(context.focusCalls.length, firstCall, 'Returning foreground must not replay a discarded restore')
      }
    })
  }
})

test('source, view, page and real unmount transitions revoke queued form restore even when the old opener remains connected', async () => {
  for (const transition of ['source', 'view', 'page', 'unmount'] as const) {
    await withFocus(async context => {
      await context.open('new')
      await context.flushFrames()
      await context.close()
      if (transition === 'source') await context.navigate('b', 'b-primary')
      else if (transition === 'view') await context.navigate('a', 'a-secondary')
      else if (transition === 'page') await context.leavePage()
      else await context.unmount()
      assert.equal(context.document.activeElement === context.document.body, true)
      const firstCall = context.focusCalls.length
      await context.flushFrames()
      assert.equal(context.focusCalls.length, firstCall)
      assert.equal(context.document.activeElement === context.document.body, true)
      assert.equal(context.creates.length + context.updates.length, 0)
    })
  }
})

test('rename and Save as retain their visible opener on accepted completion and expose a localized dialog name', async () => {
  for (const locale of ['en-US', 'zh-CN']) {
    for (const kind of ['rename', 'save-as'] as const) {
      await withFocus(async context => {
        const trigger = await context.open(kind)
        const dialog = context.form()
        await context.flushFrames()
        await context.fill(context.name(), 'Accepted visible opener')
        await context.submit()
        await context.resolve(kind)
        assert.equal(context.document.querySelectorAll('form.dbw-dialog').length, 0)
        await context.flushFrames()
        assert.equal(context.document.activeElement === trigger, true)
        assert.equal(context.focusCalls.at(-1)!.options?.preventScroll, true)
        assert.equal(dialog.getAttribute('aria-label'), kind === 'rename' ? context.text.rename : context.text.newView)
        assert.equal(context.refreshes.length, 1)
      }, locale)
    }
  }
})

test('held restore skips another visible dialog or an unavailable opener, and active forms close on source or view changes without restoring', async () => {
  for (const blocker of ['dialog', 'hidden', 'disabled', 'inert', 'aria-disabled'] as const) {
    await withFocus(async context => {
      const trigger = await context.open(blocker === 'disabled' ? 'save-as' : 'new')
      await context.flushFrames()
      await context.close()
      assert.equal(context.frameCount() > 0, true)
      assert.equal(context.document.activeElement === context.document.body, true)
      let foreignDialog: HTMLElement | undefined
      await context.change(() => {
        if (blocker === 'dialog') {
          foreignDialog = context.document.createElement('section')
          foreignDialog.setAttribute('role', 'dialog')
          foreignDialog.setAttribute('aria-modal', 'true')
          foreignDialog.setAttribute('aria-label', 'Foreign dialog')
          context.document.body.append(foreignDialog)
          assert.equal(foreignDialog.getClientRects().length > 0, true)
        } else trigger.setAttribute(blocker, blocker === 'aria-disabled' ? 'true' : '')
      })
      const firstCall = context.focusCalls.length
      await context.flushFrames()
      assert.equal(context.focusCalls.length, firstCall, `${blocker} must not permit even an attempted opener focus`)
      assert.equal(context.document.activeElement === context.document.body, true)
      await context.change(() => {
        if (foreignDialog) foreignDialog.remove()
        else trigger.removeAttribute(blocker)
      })
      await context.flushFrames()
      assert.equal(context.focusCalls.length, firstCall, 'Removing the blocker must not replay the discarded restore')
      assert.equal(context.document.activeElement === context.document.body, true)
    })
  }
  for (const transition of ['source', 'view'] as const) {
    await withFocus(async context => {
      await context.open('new')
      await context.flushFrames()
      assert.equal(context.document.activeElement === context.name(), true)
      const firstCall = context.focusCalls.length
      await context.navigate(transition === 'source' ? 'b' : 'a', transition === 'source' ? 'b-primary' : 'a-secondary')
      assert.equal(context.document.querySelectorAll('form.dbw-dialog').length, 0)
      await context.flushFrames()
      assert.equal(context.focusCalls.length, firstCall)
      assert.equal(context.document.activeElement === context.document.body, true)
      assert.equal(context.creates.length + context.updates.length, 0)
    })
  }
})
