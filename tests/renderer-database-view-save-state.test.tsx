import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseSavedView, DatabaseViewConfigV1, DocumentDatabase, UpdateDatabaseSavedViewInput } from '../src/shared/contracts'
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
function savedView(source: string, suffix: string, query = ''): DatabaseSavedView {
  return { id: `${source}-${suffix}`, databaseId: source, name: `${source.toUpperCase()} ${suffix}`,
    config: { ...createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, DATABASE_SYSTEM_FIELD_IDS.updatedAt]), query },
    configVersion: 1, filterQuery: query, filterScope: '', sortMode: 'updated-desc', viewMode: 'table',
    sortOrder: suffix === 'primary' ? 0 : 1, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
}
const sources: DocumentDatabase[] = ['a', 'b'].map(id => ({ id, kind: 'custom', name: `Source ${id.toUpperCase()}`,
  description: `Records in ${id}`, createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
type Model = { source: string; activeViewId: string; views: Record<string, DatabaseSavedView[]> }
type SaveRequest = ReturnType<typeof deferred<DatabaseSavedView>> & { input: UpdateDatabaseSavedViewInput }
type RefreshRequest = ReturnType<typeof deferred<void>> & { source: string; preferredViewId?: string; settled: boolean }
type Context = {
  document: Document
  text: ReturnType<typeof getDatabaseWorkspaceText>
  saves: SaveRequest[]
  refreshes: RefreshRequest[]
  messages: Array<{ message: Parameters<AppMessageHandler>[0]; level?: Parameters<AppMessageHandler>[1] }>
  viewChanges: string[]
  sourceChanges: string[]
  model: () => Model
  query: () => HTMLInputElement
  save: () => HTMLButtonElement
  reset: () => HTMLButtonElement
  fill: (value: string) => Promise<void>
  click: (element: HTMLElement) => Promise<void>
  change: (run: () => void) => Promise<void>
  resolveSave: (index?: number) => Promise<DatabaseSavedView>
  rejectSave: (index?: number) => Promise<void>
  resolveRefresh: (index?: number) => Promise<void>
  rejectRefresh: (index?: number) => Promise<void>
  selectView: (id: string) => Promise<void>
  selectSource: (id: string) => Promise<void>
  unmount: () => Promise<void>
}

async function withWorkspace(run: (context: Context) => Promise<void>, locale = 'en-US') {
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
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true, configurable: true })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return new dom.window.DOMRect(0, 0, 160, 32) }
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rects = this.closest('[hidden], [inert]') ? [] : [this.getBoundingClientRect()]
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
  }
  const serverViews: Record<string, DatabaseSavedView[]> = {
    a: [savedView('a', 'primary'), savedView('a', 'secondary')],
    b: [savedView('b', 'primary'), savedView('b', 'secondary')]
  }
  const saves: SaveRequest[] = []
  const refreshes: RefreshRequest[] = []
  const messages: Context['messages'] = []
  const viewChanges: string[] = []
  const sourceChanges: string[] = []
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseSavedView: (input: UpdateDatabaseSavedViewInput) => {
      const request = { ...deferred<DatabaseSavedView>(), input: clone(input) }
      saves.push(request)
      return request.promise
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
  const refresh = async (source = current.source, preferredViewId?: string) => {
    const request = { ...deferred<void>(), source, preferredViewId, settled: false }
    const requestGeneration = ++refreshGeneration
    const sourceSession = sourceGeneration
    refreshes.push(request)
    await request.promise
    if (!mounted || requestGeneration !== refreshGeneration || sourceSession !== sourceGeneration || current.source !== source) return
    const views = clone(serverViews[source])
    // Match the parent's public refresh semantics: a preferred view changes
    // selection only while the same source is still current.
    updateModel(previous => ({ ...previous, views: { ...previous.views, [source]: views },
      activeViewId: views.some(view => view.id === preferredViewId) ? preferredViewId! : previous.activeViewId }))
  }
  function Harness() {
    const [model, setModel] = useState<Model>(() => ({ source: 'a', activeViewId: 'a-primary', views: clone(serverViews) }))
    current = model
    updateModel = setModel
    return createElement(DatabaseWorkspace, {
      currentDatabaseId: model.source, activeViewId: model.activeViewId, databases: sources,
      savedViews: model.views[model.source], locale, catalogColumns: [], catalogDocuments: [], entities: [], selectedColumns: [], selectedRecordIds: [],
      onActiveViewIdChange: id => { viewChanges.push(id); setModel(previous => ({ ...previous, activeViewId: id })) },
      onCurrentDatabaseIdChange: id => {
        sourceChanges.push(id); sourceGeneration++; refreshGeneration++
        setModel(previous => ({ ...previous, source: id, activeViewId: `${id}-primary` }))
      },
      onMessage: (message, level) => { messages.push({ message, level }) },
      onSavedView: view => {
        if (!mounted || current.source !== view.databaseId) return
        setModel(previous => ({ ...previous, views: { ...previous.views,
          [view.databaseId]: previous.views[view.databaseId].map(candidate => candidate.id === view.id ? clone(view) : candidate) } }))
      },
      onOpenDocument: () => {}, onSelectedRecordIdsChange: () => {}, onRefresh: refresh
    })
  }
  const query = () => dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!
  const save = () => dom.window.document.querySelector<HTMLButtonElement>('.dbw-save-button')!
  const click = async (element: HTMLElement) => { await act(async () => element.click()) }
  const resolveSave = async (index = 0) => {
    const request = saves[index]
    assert.ok(request)
    const previous = Object.values(serverViews).flat().find(view => view.id === request.input.viewId)!
    assert.ok(previous)
    const config = clone(request.input.config ?? previous.config)
    const updated = { ...previous, config, filterQuery: config.query, updatedAt: '2026-10-02' }
    serverViews[previous.databaseId] = serverViews[previous.databaseId].map(view => view.id === previous.id ? updated : view)
    await act(async () => request.resolve(clone(updated)))
    return updated
  }
  const resolveRefresh = async (index = 0) => {
    const request = refreshes[index]
    assert.ok(request)
    request.settled = true
    await act(async () => request.resolve())
  }
  const unmount = async () => {
    if (mounted) { mounted = false; sourceGeneration++; refreshGeneration++; await act(async () => root.unmount()) }
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, text, saves, refreshes, messages, viewChanges, sourceChanges, model: () => current,
      query, save, reset: () => {
        const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-save-actions button')]
          .find(item => item.textContent === text.resetView)
        assert.ok(button)
        return button
      },
      fill: async value => { await act(async () => {
        const input = query()
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      click, change: async callback => { await act(async () => callback()) }, resolveSave, resolveRefresh,
      rejectSave: async (index = 0) => { assert.ok(saves[index]); await act(async () => saves[index].reject(new Error('Save did not complete.'))) },
      rejectRefresh: async (index = 0) => { assert.ok(refreshes[index]); refreshes[index].settled = true;
        await act(async () => refreshes[index].reject(new Error('Refresh did not complete.'))) },
      selectView: async id => {
        const name = Object.values(serverViews).flat().find(view => view.id === id)!.name
        const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-view-tab')].find(item => item.title === name)
        assert.ok(button)
        await click(button)
      },
      selectSource: async id => {
        await click(dom.window.document.querySelector<HTMLButtonElement>('.dbw-source-trigger')!)
        const name = sources.find(source => source.id === id)!.name
        const option = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.dbw-source-option')]
          .find(item => item.querySelector('strong')!.textContent === name)
        assert.ok(option)
        await click(option)
      }, unmount })
  } finally {
    await unmount()
    await act(async () => {
      for (const request of saves) request.resolve(clone(serverViews.a[0]))
      for (const request of refreshes) request.resolve()
    })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function submittedConfig(request: SaveRequest): DatabaseViewConfigV1 {
  assert.ok(request.input.config)
  return request.input.config
}
function assertDirty(context: Context, query: string) {
  assert.equal(context.query().value, query)
  assert.equal(context.save().disabled, false)
  assert.equal(context.save().textContent, context.text.saveChanges)
  assert.equal(context.document.querySelectorAll('.dbw-view-tab[aria-current="page"] .dbw-unsaved-dot').length, 1)
}
function assertSaved(context: Context, query: string) {
  assert.equal(context.query().value, query)
  assert.equal(context.save().disabled, true)
  assert.equal(context.save().textContent, context.text.saved)
  assert.equal(context.document.querySelectorAll('.dbw-unsaved-dot').length, 0)
}

test('edits during update and refresh survive saved-view completion while Reset uses the newly saved base in both languages', async () => {
  for (const locale of ['en-US', 'zh-CN']) {
    await withWorkspace(async context => {
      await context.fill('Submitted A')
      await context.click(context.save())
      assert.equal(context.saves.length, 1)
      assert.equal(submittedConfig(context.saves[0]).query, 'Submitted A')
      await context.fill('Edited during update')
      await context.resolveSave()
      assert.equal(context.refreshes.length, 1)
      assert.equal(context.query().value, 'Edited during update')
      await context.fill('Edited during refresh')
      await context.resolveRefresh()
      assertDirty(context, 'Edited during refresh')
      assert.equal(context.model().views.a[0].config.query, 'Submitted A')
      assert.equal(context.model().activeViewId, 'a-primary')
      await context.click(context.reset())
      assertSaved(context, 'Submitted A')
      assert.equal(context.saves.length, 1)
    }, locale)
  }
})

test('a synchronous pending save blocks duplicate submissions without blocking query focus or the next edited save', async () => {
  await withWorkspace(async context => {
    await context.fill('First payload')
    const trigger = context.save()
    await context.change(() => { trigger.focus(); trigger.click(); trigger.click() })
    assert.equal(context.saves.length, 1)
    assert.equal(context.query().disabled, false)
    await context.change(() => context.query().focus())
    assert.equal(context.document.activeElement === context.query(), true)
    await context.fill('Second payload')
    await context.click(context.save())
    assert.equal(context.saves.length, 1)
    assert.equal(submittedConfig(context.saves[0]).query, 'First payload')
    await context.resolveSave()
    await context.resolveRefresh()
    assertDirty(context, 'Second payload')
    await context.click(context.save())
    assert.equal(context.saves.length, 2)
    assert.equal(submittedConfig(context.saves[1]).query, 'Second payload')
    await context.resolveSave(1)
    await context.resolveRefresh(1)
    assertSaved(context, 'Second payload')
  })
})

test('update and refresh failures preserve the newer draft and release Save for an immediate retry of that draft', async () => {
  for (const locale of ['en-US', 'zh-CN']) {
    for (const phase of ['update', 'refresh'] as const) {
      await withWorkspace(async context => {
        await context.fill('Failed A')
        await context.click(context.save())
        if (phase === 'refresh') await context.resolveSave()
        await context.fill('Retry B')
        if (phase === 'update') await context.rejectSave()
        else await context.rejectRefresh()
        assertDirty(context, 'Retry B')
        assert.equal(context.messages.length, 1)
        if (phase === 'update') {
          assert.deepEqual(context.messages[0], { message: 'Save did not complete.', level: 'error' })
          assert.equal(context.model().views.a[0].config.query, '')
        } else {
          assert.equal(context.messages[0].message, context.text.viewsSavedRefreshFailed)
          assert.equal(context.model().views.a[0].config.query, 'Failed A', 'An accepted ACK establishes the base even if refreshing fails')
        }
        await context.click(context.save())
        assert.equal(context.saves.length, 2)
        assert.equal(submittedConfig(context.saves[1]).query, 'Retry B')
        await context.resolveSave(1)
        await context.resolveRefresh(phase === 'update' ? 0 : 1)
        assertSaved(context, 'Retry B')
      }, locale)
    }
    await withWorkspace(async context => {
      await context.fill('Accepted without newer edits')
      await context.click(context.save())
      await context.change(() => context.query().focus())
      await context.resolveSave()
      assert.equal(context.model().views.a[0].config.query, 'Accepted without newer edits')
      assert.equal(context.document.activeElement === context.query(), true)
      await context.rejectRefresh()
      assertSaved(context, 'Accepted without newer edits')
      assert.equal(context.messages.length, 1)
      assert.equal(context.messages[0].message, context.text.viewsSavedRefreshFailed)
      assert.equal(context.document.activeElement === context.query(), true)
      assert.equal(context.saves.length, 1, 'A failed refresh must not present the accepted mutation as an unsaved retry')
    }, locale)
  }
})

test('late update and refresh completions cannot reselect a previous view or replace another context draft or its cache', async () => {
  for (const phase of ['update', 'refresh'] as const) {
    for (const transition of ['view', 'source', 'unmount'] as const) {
      await withWorkspace(async context => {
        await context.fill('Original A draft')
        await context.click(context.save())
        if (phase === 'refresh') await context.resolveSave()
        if (transition === 'view') await context.selectView('a-secondary')
        else if (transition === 'source') await context.selectSource('b')
        else await context.unmount()
        if (transition !== 'unmount') await context.fill('Current context draft')
        const activeViewId = context.model().activeViewId
        const sourceId = context.model().source
        const changes = context.viewChanges.length
        const sourceChanges = context.sourceChanges.length
        const messages = context.messages.length
        if (phase === 'update') await context.resolveSave()
        for (let index = 0; index < context.refreshes.length; index++) {
          if (!context.refreshes[index].settled) await context.resolveRefresh(index)
        }
        assert.equal(context.viewChanges.length, changes, 'A completed old request must not select its original view')
        assert.equal(context.sourceChanges.length, sourceChanges)
        assert.equal(context.messages.length, messages)
        assert.equal(context.model().activeViewId, activeViewId)
        assert.equal(context.model().source, sourceId)
        if (transition === 'unmount') {
          assert.equal(context.document.querySelectorAll('.dbw-shell').length, 0)
          return
        }
        assertDirty(context, 'Current context draft')
        if (transition === 'view') {
          await context.selectView('a-primary')
          await context.selectView('a-secondary')
        } else {
          await context.selectSource('a')
          await context.selectSource('b')
        }
        assertDirty(context, 'Current context draft')
      })
    }
  }
})
