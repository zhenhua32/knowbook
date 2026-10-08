import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type ComponentProps, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn, DocumentDatabaseFieldValue, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { DatabaseValueEditor } from '../src/renderer/src/features/database/components/DatabaseValueEditor'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

const column: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

type EditorProps = ComponentProps<typeof DatabaseValueEditor>
type CommitResult = Awaited<ReturnType<EditorProps['onChangeValue']>>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type CellRequest = ReturnType<typeof deferred<CommitResult>> & { value: DocumentDatabaseFieldValue }

async function withEditor(run: (context: {
  document: Document; window: JSDOM['window']; requests: CellRequest[]; focusCalls: HTMLElement[]
  input: () => HTMLInputElement; outside: HTMLInputElement
  render: (patch?: Partial<EditorProps>, key?: string) => Promise<void>
  fill: (value: string) => Promise<void>
  key: (key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  settle: (index: number, result: CommitResult | Error) => Promise<void>
}) => Promise<void>, options: Partial<EditorProps> = {}) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside control">',
    { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const focusCalls: HTMLElement[] = []
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options?: FocusOptions) {
    focusCalls.push(this)
    nativeFocus.call(this, options)
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const requests: CellRequest[] = []
  let props: EditorProps = { column, value: 'Saved value', onChangeValue: value => {
    const request = { ...deferred<CommitResult>(), value }
    requests.push(request)
    return request.promise
  }, ...options }
  let instanceKey = 'original'
  const render = async (patch: Partial<EditorProps> = {}, key = instanceKey) => {
    props = { ...props, ...patch }
    instanceKey = key
    await act(async () => root.render(createElement(DatabaseValueEditor, { ...props, key })))
  }
  const input = () => {
    const element = dom.window.document.querySelector<HTMLInputElement>('.catalog-cell-input')
    assert.ok(element instanceof dom.window.HTMLInputElement)
    return element
  }
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window, requests, focusCalls, input,
      outside: dom.window.document.getElementById('outside') as HTMLInputElement, render,
      fill: async value => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
        input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      key: async (key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await act(async () => input().dispatchEvent(event))
        return event
      },
      settle: async (index, result) => { assert.ok(requests[index]); await act(async () => {
        if (result instanceof Error) requests[index].reject(result)
        else requests[index].resolve(result)
      }) }
    })
  } finally {
    await act(async () => root.unmount())
    await act(async () => requests.forEach(request => request.resolve(undefined)))
    dom.window.HTMLElement.prototype.focus = nativeFocus
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('a pending text-cell Enter keeps its submitted draft until persistence resolves', async () => {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const changes: DocumentDatabaseFieldValue[] = []
  const pending: Array<{ resolve: () => void; completion: Promise<void> }> = []

  function Harness() {
    const [value, setValue] = useState<DocumentDatabaseFieldValue>('Saved value')
    return createElement('section', null,
      createElement(DatabaseValueEditor, { column, value, onChangeValue: next => {
        changes.push(next)
        let resolve!: () => void
        const wait = new Promise<void>(done => { resolve = done })
        const completion = wait.then(() => { setValue(next) })
        pending.push({ resolve, completion })
        return completion
      } }),
      createElement('output', { 'data-testid': 'saved-value' }, typeof value === 'string' ? value : ''),
      createElement('button', { type: 'button' }, 'Another control'))
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    const input = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
    const saved = dom.window.document.querySelector<HTMLOutputElement>('[data-testid="saved-value"]')!
    assert.ok(input)
    await act(async () => input.focus())
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Pending new draft')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.equal(dom.window.document.activeElement, input)
    assert.equal(input.value, 'Pending new draft')

    // The component handles this Enter by calling the actual input.blur().
    const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => input.dispatchEvent(enter))
    assert.equal(enter.defaultPrevented, true)
    assert.notEqual(dom.window.document.activeElement, input)
    assert.deepEqual(changes, ['Pending new draft'])
    assert.equal(pending.length, 1)
    assert.equal(saved.textContent, 'Saved value', 'the parent still supplies the last persisted value while the write is pending')
    assert.equal(dom.window.document.querySelector('input[aria-label="Notes"]'), input)
    assert.equal(input.value, 'Pending new draft', 'a pending blur commit must not restore the older persisted value')

    await act(async () => {
      pending[0].resolve()
      await pending[0].completion
    })
    assert.equal(saved.textContent, 'Pending new draft')
    assert.equal(input.value, 'Pending new draft')
    assert.deepEqual(changes, ['Pending new draft'])
  } finally {
    // Settle accepted callbacks even when the pending assertion fails on the baseline.
    await act(async () => {
      for (const request of pending) request.resolve()
      await Promise.all(pending.map(request => request.completion))
    })
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})

test('rejected and structured text writes retain the raw draft and retry once without moving a newer focus', async () => {
  for (const [locale, failure] of [['en-US', 'rejection'], ['zh-CN', 'result']] as const) {
    const text = getDatabaseWorkspaceText(locale)
    await withEditor(async ({ document, requests, focusCalls, input, outside, fill, key, settle, render }) => {
      await act(async () => input().focus())
      await fill('  Kept raw draft  ')
      await key('Enter')
      assert.deepEqual(requests.map(request => request.value), ['Kept raw draft'])
      assert.equal(input().value, '  Kept raw draft  ')
      assert.equal(input().readOnly, true)
      assert.equal(input().disabled, false)
      assert.equal(input().getAttribute('aria-busy'), 'true')
      await act(async () => outside.focus())
      focusCalls.length = 0
      await settle(0, failure === 'rejection' ? new Error('Write unavailable') : { status: 'failed', message: 'Write unavailable' })
      const alert = document.querySelector<HTMLElement>('[role="alert"]')
      assert.ok(alert)
      assert.ok(alert.textContent?.trim())
      assert.equal(alert.textContent, failure === 'rejection' ? text.formFailed : 'Write unavailable')
      assert.equal(input().getAttribute('aria-invalid'), 'true')
      assert.equal(document.getElementById(input().getAttribute('aria-describedby')!), alert)
      assert.equal(input().value, '  Kept raw draft  ')
      assert.equal(input().disabled, false)
      assert.equal(input().readOnly, false)
      assert.equal(document.activeElement, outside)
      assert.deepEqual(focusCalls, [])
      const nextText = getDatabaseWorkspaceText(locale === 'en-US' ? 'zh-CN' : 'en-US')
      await render({ text: nextText })
      const currentMessage = failure === 'rejection' ? nextText.formFailed : 'Write unavailable'
      assert.equal(alert.textContent, currentMessage)
      assert.equal(input().title, currentMessage)
      assert.equal(input().value, '  Kept raw draft  ')
      assert.equal(requests.length, 1, 'changing the UI language must not submit the retained draft')
      assert.equal(document.activeElement, outside)
      const retry = document.querySelector<HTMLButtonElement>('button')
      assert.ok(retry)
      assert.equal(retry.textContent, nextText.retry)
      assert.equal(retry.title, currentMessage)
      await act(async () => { retry.click(); retry.click() })
      assert.equal(requests.length, 2, 'the same-frame retry attempts share one accepted write')
      assert.equal(requests[1].value, 'Kept raw draft')
      assert.equal(input().value, '  Kept raw draft  ')
      assert.equal(document.activeElement, outside)
      await settle(1, { status: 'saved', value: 'Kept raw draft' })
      assert.equal(input().value, 'Kept raw draft')
      assert.equal(document.querySelector('[role="alert"]'), null)
      assert.equal(document.activeElement, outside)
      assert.deepEqual(focusCalls, [])
    }, { text })
  }
})

test('IME candidate keys and Escape do not save discarded text, and the next ordinary Enter can save null', async () => {
  await withEditor(async ({ document, window, requests, input, fill, key, settle }) => {
    await act(async () => input().focus())
    await fill('中文候选')
    await act(async () => input().dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    for (const candidate of ['Enter', 'Escape']) {
      assert.equal((await key(candidate)).defaultPrevented, false)
      assert.equal(document.activeElement, input())
      assert.equal(input().value, '中文候选')
      assert.equal(requests.length, 0)
    }
    await act(async () => input().dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await key('Enter', init)
      await key('Escape', init)
      assert.equal(requests.length, 0)
      assert.equal(document.activeElement, input())
    }
    assert.equal((await key('Escape')).defaultPrevented, true)
    assert.equal(input().value, 'Saved value')
    assert.equal(requests.length, 0)
    await act(async () => input().focus())
    await fill(' \t ')
    await key('Enter')
    assert.deepEqual(requests.map(request => request.value), [null])
    await settle(0, { status: 'saved', value: null })
    assert.equal(input().value, '')
    await act(async () => input().focus())
    await fill('  The next value  ')
    await key('Enter')
    assert.equal(requests[1].value, 'The next value')
    await settle(1, { status: 'saved', value: 'The next value' })
    assert.equal(input().value, 'The next value')
  })
})

test('a late reply from an unmounted editor cannot clear the new instance draft, error or pending write', async () => {
  for (const oldResult of ['failure', 'success'] as const) {
    await withEditor(async ({ document, requests, input, render, fill, key, settle }) => {
      const oldInput = input()
      await act(async () => oldInput.focus())
      await fill('Old submitted value')
      await key('Enter')
      await render({ value: 'Fresh saved value' }, 'fresh')
      assert.equal(oldInput.isConnected, false)
      const fresh = input()
      await act(async () => fresh.focus())
      await fill('Fresh submitted value')
      await key('Enter')
      assert.equal(requests.length, 2)
      await settle(0, oldResult === 'failure' ? { status: 'failed', message: 'Old failure' } : { status: 'saved', value: 'Old submitted value' })
      assert.equal(input(), fresh)
      assert.equal(fresh.value, 'Fresh submitted value')
      assert.equal(document.querySelector('[role="alert"]'), null)
      await settle(1, { status: 'failed', message: 'Fresh failure' })
      assert.ok(document.querySelector('[role="alert"]'))
      assert.equal(fresh.value, 'Fresh submitted value')
      await act(async () => fresh.focus())
      await fill('Fresh corrected value')
      await key('Enter')
      assert.equal(requests.length, 3)
      assert.equal(requests[2].value, 'Fresh corrected value')
      await settle(2, { status: 'saved', value: 'Fresh corrected value' })
      assert.equal(fresh.value, 'Fresh corrected value')
    })
  }
})

test('legacy synchronous blur and local change-mode callbacks keep their original trim and Escape semantics', async () => {
  const blurChanges: DocumentDatabaseFieldValue[] = []
  await withEditor(async ({ input, render, fill, key, document }) => {
    await act(async () => input().focus())
    await fill('  Local value  ')
    await key('Enter')
    assert.deepEqual(blurChanges, ['Local value'])
    await render({ value: 'Local value' })
    assert.equal(input().value, 'Local value')
    assert.equal(document.querySelector('[role="alert"], [role="status"], button'), null)
  }, { onChangeValue: value => { blurChanges.push(value) } })
  const changeValues: DocumentDatabaseFieldValue[] = []
  await withEditor(async ({ document, input, render, fill, key }) => {
    await act(async () => input().focus())
    await fill('First local draft')
    await render({ value: 'First local draft' })
    await fill('Second local draft')
    await render({ value: 'Second local draft' })
    await key('Escape')
    assert.deepEqual(changeValues, ['First local draft', 'Second local draft', 'Saved value'])
    await render({ value: changeValues.at(-1)! })
    assert.equal(input().value, 'Saved value')
    assert.notEqual(document.activeElement, input())
    assert.equal(document.querySelector('[role="alert"], [role="status"], button'), null)
  }, { textCommitMode: 'change', onChangeValue: value => { changeValues.push(value) } })
})

type EntityWrite = ReturnType<typeof deferred<DatabaseEntity>> & { source: string; input: UpdateDatabaseEntityInput }
type EntityRead = ReturnType<typeof deferred<void>> & { source: string }
type WorkspaceModel = { source: string; viewId: string; columns: DocumentDatabaseColumn[]; entities: DatabaseEntity[]; shown: boolean; locale: string }

async function withWorkspace(run: (context: {
  document: Document; window: JSDOM['window']; writes: EntityWrite[]; reads: EntityRead[]
  cell: () => HTMLInputElement; query: () => HTMLInputElement; outside: HTMLInputElement
  fill: (input: HTMLInputElement, value: string) => Promise<void>
  enter: (input: HTMLInputElement) => Promise<void>
  update: (patch: Partial<WorkspaceModel>) => Promise<void>
  move: (top: number) => Promise<void>
  saved: (index: number) => Promise<void>
  failed: (index: number) => Promise<void>
  read: (index: number, failure?: boolean) => Promise<void>
  disk: (source?: string) => DatabaseEntity[]
  externalWrite: (source: string, recordId: string, fields: Record<string, DocumentDatabaseFieldValue>, updatedAt: string) => void
}) => Promise<void>) {
  const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')
  const { DatabaseTextDraftCache } = await import('../src/renderer/src/features/database/model/databaseTextDrafts')
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside control">',
    { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => dom.window.cancelAnimationFrame(id) })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  // Only the actual table's virtual viewport needs layout metrics in JSDOM.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true,
    get() { return (this as HTMLElement).classList.contains('dbw-table-scroll') ? 200 : 0 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true,
    get() {
      const node = this as HTMLElement
      if (!node.classList.contains('dbw-table-scroll')) return 0
      const count = node.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length
      const padding = [...node.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')]
        .reduce((total, item) => total + Number.parseFloat(item.style.height), 0)
      return 42 + count * 56 + padding
    } })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return new dom.window.DOMRect(0, 0, 180, this.tagName === 'THEAD' ? 42 : 32)
  }
  const sources: DocumentDatabase[] = ['a', 'b'].map(id => ({ id, kind: 'custom', name: `Source ${id}`,
    description: '', createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(sources.map(source => [source.id,
    Array.from({ length: 90 }, (_, index) => ({ id: `record-${index}`, databaseId: source.id, title: `${source.id.toUpperCase()} Record ${index}`,
      documentId: null, fieldValues: { notes: `${source.id.toUpperCase()} Notes ${index}` }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }))]))
  const views = (source: string): DatabaseSavedView[] => ['main', 'hidden'].map(suffix => ({
    id: `${source}-${suffix}`, databaseId: source, name: `${source} ${suffix}`,
    config: { ...createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, 'notes']),
      visibleFieldIds: suffix === 'hidden' ? [DATABASE_SYSTEM_FIELD_IDS.title] : [DATABASE_SYSTEM_FIELD_IDS.title, 'notes'] },
    configVersion: 1, filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table',
    sortOrder: suffix === 'main' ? 0 : 1, createdAt: '2026-10-01', updatedAt: '2026-10-01'
  }))
  const cache = new DatabaseTextDraftCache()
  const writes: EntityWrite[] = [], reads: EntityRead[] = []
  let current!: WorkspaceModel
  let setModel!: (update: SetStateAction<WorkspaceModel>) => void
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (input: UpdateDatabaseEntityInput) => {
      const request = { ...deferred<DatabaseEntity>(), source: current.source, input: structuredClone(input) }
      writes.push(request)
      return request.promise
    }
  } })
  const refresh = async (source = current.source) => {
    const request = { ...deferred<void>(), source }
    reads.push(request)
    await request.promise
    setModel(previous => previous.source === source ? { ...previous, entities: structuredClone(server[source]) } : previous)
  }
  function Harness() {
    const [model, update] = useState<WorkspaceModel>(() => ({ source: 'a', viewId: 'a-main', columns: [column], entities: structuredClone(server.a), shown: true, locale: 'en-US' }))
    current = model; setModel = update
    return model.shown ? createElement(DatabaseWorkspace, {
      activeViewId: model.viewId, currentDatabaseId: model.source, databases: sources, savedViews: views(model.source),
      catalogColumns: [], catalogDocuments: [], entities: model.entities, selectedColumns: model.columns, selectedRecordIds: [],
      locale: model.locale, textDraftCache: cache,
      onActiveViewIdChange: viewId => update(previous => ({ ...previous, viewId })),
      onCurrentDatabaseIdChange: source => update(previous => ({ ...previous, source, viewId: `${source}-main`, entities: structuredClone(server[source]) })),
      onMessage: () => {}, onOpenDocument: () => {}, onSelectedRecordIdsChange: () => {}, onRefresh: refresh
    }) : null
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const cell = () => {
    const row = [...dom.window.document.querySelectorAll<HTMLTableRowElement>('.dbw-table tbody tr')]
      .find(item => item.querySelector('strong')?.textContent === `${current.source.toUpperCase()} Record 0`)
    const input = row?.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
    assert.ok(input)
    return input
  }
  const update = async (patch: Partial<WorkspaceModel>) => { await act(async () => setModel(previous => ({ ...previous, ...patch }))) }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, window: dom.window, writes, reads, cell,
      query: () => dom.window.document.querySelector<HTMLInputElement>('.dbw-main-search input')!,
      outside: dom.window.document.getElementById('outside') as HTMLInputElement, update,
      fill: async (input, value) => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      enter: async input => { await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))) },
      move: async top => { await act(async () => {
        const scroll = dom.window.document.querySelector<HTMLDivElement>('.dbw-table-scroll')!
        scroll.scrollTop = top
        scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
      }) },
      saved: async index => {
        const request = writes[index]; assert.ok(request)
        const previous = server[request.source].find(entity => entity.id === request.input.entityId)!; assert.ok(previous)
        const next = { ...previous, fieldValues: { ...previous.fieldValues, ...request.input.fieldValues }, updatedAt: '2026-10-02' }
        server[request.source] = server[request.source].map(entity => entity.id === next.id ? next : entity)
        await act(async () => request.resolve(structuredClone(next)))
      },
      failed: async index => { assert.ok(writes[index]); await act(async () => writes[index].reject(new Error('Write unavailable'))) },
      read: async (index, failure = false) => { assert.ok(reads[index]); await act(async () => {
        if (failure) reads[index].reject(new Error('Read unavailable'))
        else reads[index].resolve()
      }) },
      disk: (source = 'a') => structuredClone(server[source]),
      // Independent backend writes become visible only through an actual refresh.
      // They do not mutate the UI model or the production cell cache.
      externalWrite: (source, recordId, fields, updatedAt) => {
        assert.ok(server[source].some(entity => entity.id === recordId))
        server[source] = server[source].map(entity => entity.id === recordId
          ? { ...entity, fieldValues: { ...entity.fieldValues, ...structuredClone(fields) }, updatedAt }
          : entity)
      }
    })
  } finally {
    await act(async () => root.unmount())
    await act(async () => {
      writes.forEach(request => request.resolve(structuredClone(server[request.source][0])))
      reads.forEach(request => request.resolve())
    })
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('the actual workspace distinguishes saved-but-refresh-failed from a failed write and retries only the read', async () => {
  for (const refreshedBeforeRetry of [false, true]) {
  await withWorkspace(async ({ document, writes, reads, cell, outside, fill, enter, saved, failed, read, disk, update }) => {
    await act(async () => cell().focus())
    await fill(cell(), '  Persisted once  ')
    await enter(cell())
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].input, { entityId: 'record-0', fieldValues: { notes: 'Persisted once' } })
    if (refreshedBeforeRetry) {
      await failed(0)
      assert.equal(cell().value, '  Persisted once  ')
      const refreshedRecords = disk().map(entity => entity.id === 'record-0'
        ? { ...entity, fieldValues: { ...entity.fieldValues, other: 'An external field update' }, updatedAt: '2026-10-01T12:00:00Z' }
        : entity)
      assert.equal(refreshedRecords[0].fieldValues.notes, 'A Notes 0', 'this read has not acknowledged the unsaved Notes draft')
      await update({ entities: refreshedRecords })
      assert.equal(cell().value, '  Persisted once  ')
      assert.ok(cell().parentElement!.querySelector('[role="alert"]'))
      await act(async () => cell().parentElement!.querySelector<HTMLButtonElement>('button')!.click())
      assert.equal(writes.length, 2)
      assert.deepEqual(writes[1].input, writes[0].input)
    }
    const acceptedWrites = refreshedBeforeRetry ? 2 : 1
    await saved(acceptedWrites - 1)
    assert.equal(reads.length, 1)
    assert.equal(disk()[0].fieldValues.notes, 'Persisted once')
    await act(async () => outside.focus())
    await read(0, true)
    assert.equal(cell().value, 'Persisted once', 'old parent props cannot roll back an acknowledged write')
    assert.ok(cell().parentElement!.querySelector('.dbw-text-cell-feedback')?.textContent?.trim())
    await update({ shown: false, locale: 'zh-CN' })
    await update({ shown: true })
    const currentText = getDatabaseWorkspaceText('zh-CN')
    assert.equal(cell().value, 'Persisted once')
    assert.equal(cell().title, currentText.savedRefreshFailed)
    assert.equal(cell().parentElement!.querySelector('.dbw-text-cell-feedback')?.textContent, currentText.savedRefreshFailed)
    assert.equal(writes.length, acceptedWrites, 'page remount and a language change cannot rewrite an acknowledged cell')
    assert.equal(document.activeElement, outside)
    const refresh = () => {
      const button = [...cell().parentElement!.querySelectorAll<HTMLButtonElement>('button')]
        .find(item => item.textContent === currentText.refresh)
      assert.ok(button)
      return button
    }
    await act(async () => { refresh().click(); refresh().click() })
    assert.equal(reads.length, 2)
    assert.equal(writes.length, acceptedWrites)
    await read(1, true)
    assert.equal(cell().value, 'Persisted once')
    assert.equal(cell().parentElement!.querySelector('.dbw-text-cell-feedback')?.textContent, currentText.savedRefreshFailed)
    await act(async () => refresh().click())
    assert.equal(reads.length, 3)
    await read(2)
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert.equal(cell().parentElement!.querySelector('.dbw-text-cell-feedback'), null)
    assert.equal(cell().parentElement!.querySelector('button'), null)
    assert.equal(cell().value, 'Persisted once')
    assert.equal(writes.length, acceptedWrites)
    assert.equal(document.activeElement, outside)
  })
  }
})

test('real virtual rows, search, hidden fields and workspace/source remounts preserve a failed cell draft for one retry', async () => {
  await withWorkspace(async ({ document, writes, reads, cell, query, fill, enter, failed, saved, read, update, move, disk }) => {
    await act(async () => cell().focus())
    await fill(cell(), '  Recover this raw text  ')
    await enter(cell())
    await failed(0)
    const firstInput = cell()
    await move(3000)
    assert.equal(firstInput.isConnected, false, 'the tested row actually leaves the rendered virtual slice')
    await move(0)
    assert.equal(cell().value, '  Recover this raw text  ')
    assert.ok(cell().parentElement!.querySelector('[role="alert"]'))
    const searchInput = cell()
    await fill(query(), 'No records match this query')
    assert.equal(searchInput.isConnected, false)
    await fill(query(), '')
    assert.equal(cell().value, '  Recover this raw text  ')
    await update({ viewId: 'a-hidden' })
    assert.equal(document.querySelector('input[aria-label="Notes"]'), null)
    await update({ viewId: 'a-main' })
    assert.equal(cell().value, '  Recover this raw text  ')
    await update({ shown: false })
    assert.equal(document.querySelector('.dbw-table'), null)
    await update({ shown: true })
    assert.equal(cell().value, '  Recover this raw text  ')
    await update({ source: 'b', viewId: 'b-main', entities: disk('b') })
    assert.equal(cell().value, 'B Notes 0')
    await update({ source: 'a', viewId: 'a-main', entities: disk('a') })
    assert.equal(cell().value, '  Recover this raw text  ')
    assert.ok(cell().parentElement!.querySelector('[role="alert"]'))
    const retry = cell().parentElement!.querySelector<HTMLButtonElement>('button')!
    await act(async () => { retry.click(); retry.click() })
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[1].input, writes[0].input)
    await saved(1)
    assert.equal(reads.length, 1)
    await read(0)
    assert.equal(cell().value, 'Recover this raw text')
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert.equal(disk()[0].fieldValues.notes, 'Recover this raw text')
    assert.equal(writes.length, 2)
  })
})

test('late source and replaced-schema writes cannot report, unlock or replace the current cell session', async () => {
  await withWorkspace(async ({ document, writes, reads, cell, fill, enter, saved, failed, read, update, disk }) => {
    await act(async () => cell().focus())
    await fill(cell(), 'Old source pending')
    await enter(cell())
    await update({ source: 'b', viewId: 'b-main', entities: disk('b') })
    await act(async () => cell().focus())
    await fill(cell(), 'B pending')
    await enter(cell())
    await saved(0)
    assert.equal(reads.length, 0, 'a completed write in A must not refresh the active B source')
    assert.equal(cell().value, 'B pending')
    assert.equal(document.querySelector('[role="alert"]'), null)
    await act(async () => cell().blur())
    assert.equal(writes.length, 2, 'the old A completion cannot unlock B for another write')
    await failed(1)
    assert.equal(cell().value, 'B pending')
    assert.ok(document.querySelector('[role="alert"]'))
    await update({ source: 'a', viewId: 'a-main', entities: disk('a') })
    assert.equal(cell().value, 'Old source pending')
    await act(async () => cell().focus())
    await fill(cell(), 'Old schema pending')
    await enter(cell())
    assert.equal(writes.length, 3)
    await update({ columns: [{ ...column, type: 'select', options: ['Old source pending', 'New choice'] }] })
    assert.ok(document.querySelector('select[aria-label="Notes"]'))
    await update({ columns: [] })
    assert.equal(document.querySelector('[aria-label="Notes"]'), null)
    await update({ columns: [column] })
    await act(async () => cell().focus())
    await fill(cell(), 'Replacement schema pending')
    await enter(cell())
    assert.equal(writes.length, 4)
    await failed(2)
    assert.equal(cell().value, 'Replacement schema pending')
    assert.equal(document.querySelector('[role="alert"]'), null)
    await act(async () => cell().blur())
    assert.equal(writes.length, 4)
    await saved(3)
    assert.equal(reads.length, 1)
    await read(0)
    assert.equal(cell().value, 'Replacement schema pending')
    assert.equal(document.querySelector('[role="alert"]'), null)
  })
})

test('an accepted cell write finishes in the production cache while its workspace is unmounted', async () => {
  for (const outcome of ['failure', 'saved'] as const) {
    await withWorkspace(async ({ document, writes, reads, cell, fill, enter, saved, failed, read, update, disk }) => {
      await act(async () => cell().focus())
      await fill(cell(), '  Survives leaving the page  ')
      await enter(cell())
      await update({ shown: false })
      assert.equal(document.querySelector('.dbw-table'), null)
      if (outcome === 'failure') await failed(0)
      else await saved(0)
      assert.equal(reads.length, 0, 'an unmounted workspace must not launch a read for an old view')
      await update({ shown: true })
      assert.equal(cell().value, outcome === 'failure' ? '  Survives leaving the page  ' : 'Survives leaving the page')
      assert.equal(writes.length, 1)
      if (outcome === 'failure') {
        assert.ok(cell().parentElement!.querySelector('[role="alert"]'))
        await act(async () => cell().parentElement!.querySelector<HTMLButtonElement>('button')!.click())
        assert.equal(writes.length, 2)
        assert.deepEqual(writes[1].input, writes[0].input)
        await saved(1)
        assert.equal(reads.length, 1)
        await read(0)
      } else {
        assert.equal(document.querySelector('[role="alert"]'), null)
      }
      assert.equal(disk()[0].fieldValues.notes, 'Survives leaving the page')
      assert.equal(cell().value, 'Survives leaving the page')
    })
  }
})

test('focusing and leaving an acknowledged cell without editing preserves Refresh and never writes again', async () => {
  for (const leave of ['blur', 'Enter'] as const) {
    await withWorkspace(async ({ cell, writes, reads, fill, enter, saved, read, disk }) => {
      await act(async () => cell().focus())
      await fill(cell(), 'Saved despite failed refresh')
      await enter(cell())
      await saved(0)
      await read(0, true)
      assert.equal(cell().value, 'Saved despite failed refresh')
      assert.equal(disk()[0].fieldValues.notes, 'Saved despite failed refresh')
      const refresh = cell().parentElement!.querySelector<HTMLButtonElement>('button')!
      assert.ok(refresh)
      assert.equal(refresh.textContent, getDatabaseWorkspaceText('en-US').refresh)
      await act(async () => cell().focus())
      if (leave === 'blur') await act(async () => cell().blur())
      else await enter(cell())
      assert.equal(writes.length, 1, 'unchanged focus/blur is not a second mutation or an explicit write retry')
      assert.equal(reads.length, 1)
      assert.equal(cell().value, 'Saved despite failed refresh')
      assert.equal(cell().parentElement!.querySelector('button'), refresh)
      assert.equal(refresh.textContent, getDatabaseWorkspaceText('en-US').refresh)
      assert.equal(cell().parentElement!.querySelector('.dbw-text-cell-feedback')?.textContent,
        getDatabaseWorkspaceText('en-US').savedRefreshFailed)
    })
  }
})

test('a parent revision change during an accepted write cannot roll its later ACK back after refresh fails', async () => {
  await withWorkspace(async ({ cell, writes, reads, fill, enter, update, saved, read, disk }) => {
    await act(async () => cell().focus())
    await fill(cell(), '  Submitted B  ')
    await enter(cell())
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].input, { entityId: 'record-0', fieldValues: { notes: 'Submitted B' } })
    const refreshedWhilePending = disk().map(entity => entity.id === 'record-0'
      ? { ...entity, fieldValues: { ...entity.fieldValues, other: 'Another accepted field update' }, updatedAt: '2026-10-01T18:00:00Z' }
      : entity)
    assert.equal(refreshedWhilePending[0].fieldValues.notes, 'A Notes 0')
    await update({ entities: refreshedWhilePending })
    assert.equal(cell().value, '  Submitted B  ')
    await saved(0)
    assert.equal(reads.length, 1)
    await read(0, true)
    assert.equal(disk()[0].fieldValues.notes, 'Submitted B')
    assert.equal(cell().value, 'Submitted B', 'a pre-ACK revision is not a read of the acknowledged text value')
    assert.equal(writes.length, 1)
    const refresh = cell().parentElement!.querySelector<HTMLButtonElement>('button')!
    assert.ok(refresh)
    assert.equal(refresh.textContent, getDatabaseWorkspaceText('en-US').refresh)
    assert.equal(cell().parentElement!.querySelector('.dbw-text-cell-feedback')?.textContent,
      getDatabaseWorkspaceText('en-US').savedRefreshFailed)
  })
})

test('a successful post-ACK workspace refresh displays a newer authoritative value instead of holding the submitted overlay', async () => {
  await withWorkspace(async ({ cell, writes, reads, fill, enter, update, saved, read, disk, externalWrite }) => {
    const originalRecords = disk()
    await act(async () => cell().focus())
    await fill(cell(), 'Submitted B')
    await enter(cell())
    assert.equal(writes.length, 1)
    externalWrite('a', 'record-0', { other: 'Updated while B was pending' }, '2026-10-01T18:00:00Z')
    assert.equal(disk()[0].fieldValues.notes, 'A Notes 0')
    await update({ entities: disk() })
    assert.equal(cell().value, 'Submitted B')
    await saved(0)
    assert.equal(reads.length, 1)
    assert.equal(disk()[0].fieldValues.notes, 'Submitted B')
    assert.equal(disk()[0].fieldValues.other, 'Updated while B was pending')
    externalWrite('a', 'record-0', { notes: 'Authoritative C' }, '2026-10-03T00:00:00Z')
    assert.equal(cell().value, 'Submitted B', 'a backend write alone does not fabricate a renderer refresh')
    await read(0)
    assert.equal(cell().value, 'Authoritative C', 'the successful real refresh is authoritative over the completed B overlay')
    assert.equal(writes.length, 1, 'the user submitted exactly one text mutation')
    assert.equal(reads.length, 1)
    assert.deepEqual(writes[0].input, { entityId: 'record-0', fieldValues: { notes: 'Submitted B' } })
    assert.deepEqual(disk()[0].fieldValues, { notes: 'Authoritative C', other: 'Updated while B was pending' })
    assert.equal(disk()[0].updatedAt, '2026-10-03T00:00:00Z')
    assert.deepEqual(disk().slice(1), originalRecords.slice(1))
    assert.deepEqual({ ...disk()[0], fieldValues: originalRecords[0].fieldValues, updatedAt: originalRecords[0].updatedAt }, originalRecords[0])
    assert.equal(cell().parentElement!.querySelector('.dbw-text-cell-feedback, button'), null)
  })
})
