import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useReducer, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')
const { DatabaseTextDraftCache } = await import('../src/renderer/src/features/database/model/databaseTextDrafts')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Write = ReturnType<typeof deferred<DatabaseEntity>> & { source: string; input: UpdateDatabaseEntityInput }
type Read = ReturnType<typeof deferred<void>> & { source: string; canApply: () => boolean; commitChecks: boolean[] }
type Model = { source: string; viewId: string; entities: DatabaseEntity[]; columns: DocumentDatabaseColumn[]; shown: boolean; locale: string }
const notes: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }

async function withWorkspace(run: (context: {
  document: Document; window: JSDOM['window']; writes: Write[]; reads: Read[]
  input: () => HTMLInputElement; outside: HTMLInputElement; focusCalls: HTMLElement[]
  fill: (value: string) => Promise<void>; key: (key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  ack: (index: number) => Promise<void>; read: (index: number, failed?: boolean) => Promise<void>
  disk: (source?: string) => DatabaseEntity[]; update: (patch: Partial<Model>) => Promise<void>
  rejectWrite: (index: number) => Promise<void>; move: (top: number) => Promise<void>
  rendered: () => DatabaseEntity[]
  externalWrite: (source: string, recordId: string, fields: DatabaseEntity['fieldValues'], revision: string) => void
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside" aria-label="Outside control">',
    { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => dom.window.cancelAnimationFrame(id) })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const focusCalls: HTMLElement[] = []
  const nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options?: FocusOptions) {
    focusCalls.push(this)
    nativeFocus.call(this, options)
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true,
    get() { return (this as HTMLElement).classList.contains('dbw-table-scroll') ? 200 : 0 } })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true,
    get() {
      const node = this as HTMLElement
      if (!node.classList.contains('dbw-table-scroll')) return 0
      const padding = [...node.querySelectorAll<HTMLElement>('.dbw-virtual-spacer td')]
        .reduce((total, item) => total + Number.parseFloat(item.style.height), 0)
      return 42 + node.querySelectorAll('tbody tr:not(.dbw-virtual-spacer)').length * 64 + padding
    } })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return new dom.window.DOMRect(0, 0, 180, this.tagName === 'THEAD' ? 42 : 32)
  }
  const sources: DocumentDatabase[] = ['a', 'b'].map(id => ({ id, name: `Source ${id}`, kind: 'custom', description: '',
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
  const server: Record<string, DatabaseEntity[]> = Object.fromEntries(sources.map(source => [source.id,
    Array.from({ length: 60 }, (_, index) => ({ id: `record-${index}`, databaseId: source.id,
      title: `${source.id.toUpperCase()} Record ${index}`, documentId: null, fieldValues: { notes: `${source.id.toUpperCase()} original ${index}`, other: 'Preserved metadata' },
      createdAt: '2026-10-01', updatedAt: '2026-10-01' }))]))
  const view = (source: string): DatabaseSavedView => ({ id: `${source}-main`, databaseId: source, name: 'All records',
    config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, notes.id]), configVersion: 1,
    filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
    createdAt: '2026-10-01', updatedAt: '2026-10-01' })
  const cache = new DatabaseTextDraftCache()
  const writes: Write[] = [], reads: Read[] = []
  let current!: Model
  let setModel!: (update: SetStateAction<Model>) => void
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (input: UpdateDatabaseEntityInput) => {
      const request = { ...deferred<DatabaseEntity>(), source: current.source, input: structuredClone(input) }
      writes.push(request)
      return request.promise
    }
  } })
  const refresh = async (source = current.source, _preferredViewId?: string, shouldContinue?: () => boolean) => {
    const request = { ...deferred<void>(), source, canApply: shouldContinue ?? (() => true), commitChecks: [] as boolean[] }
    reads.push(request)
    await request.promise
    if (!request.canApply() || current.source !== source || !current.shown) return false
    const entities = structuredClone(server[source])
    setModel(previous => {
      const allowed = request.canApply() && previous.source === source && previous.shown
      request.commitChecks.push(allowed)
      return allowed ? { ...previous, entities } : previous
    })
    return true
  }
  function Harness() {
    // Reducer dispatch queues the functional updater for React's commit render;
    // it cannot use useState's eager evaluation before the read callback settles.
    const [model, update] = useReducer((previous: Model, action: SetStateAction<Model>) =>
      typeof action === 'function' ? action(previous) : action,
    { source: 'a', viewId: 'a-main', entities: structuredClone(server.a), columns: [notes], shown: true, locale: 'en-US' })
    current = model; setModel = update
    return model.shown ? createElement(DatabaseWorkspace, {
      currentDatabaseId: model.source, activeViewId: model.viewId, databases: sources, savedViews: [view(model.source)],
      entities: model.entities, selectedColumns: model.columns, catalogColumns: [], catalogDocuments: [], selectedRecordIds: [],
      locale: model.locale, textDraftCache: cache, onRefresh: refresh,
      onActiveViewIdChange: viewId => update(previous => ({ ...previous, viewId })),
      onCurrentDatabaseIdChange: source => update(previous => ({ ...previous, source, viewId: `${source}-main`, entities: structuredClone(server[source]) })),
      onOpenDocument: () => {}, onMessage: () => {}, onSelectedRecordIdsChange: () => {}
    }) : null
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const input = () => {
    const row = [...dom.window.document.querySelectorAll<HTMLTableRowElement>('.dbw-table tbody tr')]
      .find(node => node.querySelector('strong')?.textContent === `${current.source.toUpperCase()} Record 0`)
    const element = row?.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
    assert.ok(element)
    return element
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, window: dom.window, writes, reads, input, focusCalls,
      outside: dom.window.document.getElementById('outside') as HTMLInputElement,
      fill: async value => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
        input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      key: async (key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await act(async () => input().dispatchEvent(event))
        return event
      },
      ack: async index => {
        const request = writes[index]; assert.ok(request)
        const previous = server[request.source].find(entity => entity.id === request.input.entityId)!; assert.ok(previous)
        const next = { ...previous, fieldValues: { ...previous.fieldValues, ...request.input.fieldValues }, updatedAt: '2026-10-02' }
        server[request.source] = server[request.source].map(entity => entity.id === next.id ? next : entity)
        await act(async () => request.resolve(structuredClone(next)))
      },
      read: async (index, failed = false) => { assert.ok(reads[index]); await act(async () => {
        if (failed) reads[index].reject(new Error('Read unavailable'))
        else reads[index].resolve()
      }) },
      disk: (source = 'a') => structuredClone(server[source]),
      rendered: () => structuredClone(current.entities),
      update: async patch => { await act(async () => setModel(previous => ({ ...previous, ...patch }))) },
      rejectWrite: async index => { assert.ok(writes[index]); await act(async () => writes[index].reject(new Error('Write unavailable'))) },
      move: async top => { await act(async () => {
        const scroll = dom.window.document.querySelector<HTMLDivElement>('.dbw-table-scroll')!
        scroll.scrollTop = top
        scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }))
      }) },
      // This independent backend write is visible to React only through an
      // actual successful refresh; it never edits the cache or UI props.
      externalWrite: (source, recordId, fields, revision) => {
        assert.ok(server[source].some(entity => entity.id === recordId))
        server[source] = server[source].map(entity => entity.id === recordId
          ? { ...entity, fieldValues: { ...entity.fieldValues, ...structuredClone(fields) }, updatedAt: revision }
          : entity)
      }
    })
  } finally {
    await act(async () => root.unmount())
    await act(async () => {
      writes.forEach(request => request.resolve(structuredClone(server[request.source][0])))
      reads.forEach(request => request.resolve())
    })
    dom.window.HTMLElement.prototype.focus = nativeFocus
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('a text cell is editable after its durable write ACK while the actual workspace refresh is still pending', async () => {
  await withWorkspace(async ({ document, writes, reads, input, fill, key, ack, disk }) => {
    const originalRecords = disk()
    const originalInput = input()
    await act(async () => originalInput.focus())
    await fill('Accepted A')
    await key('Enter')
    assert.notEqual(document.activeElement, originalInput, 'Enter delegates to the actual native input blur')
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].input, { entityId: 'record-0', fieldValues: { notes: 'Accepted A' } })
    await ack(0)
    assert.equal(reads.length, 1)
    assert.equal(disk()[0].fieldValues.notes, 'Accepted A')
    assert.equal(disk()[0].fieldValues.other, originalRecords[0].fieldValues.other)
    assert.deepEqual(disk().slice(1), originalRecords.slice(1))
    assert.equal(input(), originalInput)
    assert.equal(input().value, 'Accepted A')
    assert.equal(input().readOnly, false, 'a pending read must not hold the completed mutation lock')
    assert.equal(input().disabled, false)
    assert.notEqual(input().getAttribute('aria-busy'), 'true', 'the text control must no longer report a saving mutation')
    assert.equal(input().parentElement!.querySelector('[role="status"]')?.textContent?.includes(getDatabaseWorkspaceText('en-US').saving) ?? false, false)
    assert.equal(writes.length, 1)
    assert.equal(reads.length, 1)
  })
})

test('late successful and failed post-ACK reads retain a newer draft, native focus and selection', async () => {
  for (const failed of [false, true]) {
    await withWorkspace(async ({ document, writes, reads, input, focusCalls, fill, key, ack, read, disk }) => {
      await act(async () => input().focus())
      await fill('Accepted A')
      await key('Enter')
      await ack(0)
      const field = input()
      assert.equal(field.readOnly, false)
      await act(async () => field.focus())
      await fill('  New draft B  ')
      field.setSelectionRange(2, 8, 'forward')
      focusCalls.length = 0
      await read(0, failed)
      assert.equal(input(), field)
      assert.equal(field.value, '  New draft B  ')
      assert.equal(field.readOnly, false)
      assert.equal(document.activeElement, field)
      assert.deepEqual([field.selectionStart, field.selectionEnd, field.selectionDirection], [2, 8, 'forward'])
      assert.deepEqual(focusCalls, [])
      assert.equal(field.title, '')
      assert.equal(field.parentElement!.querySelector('.dbw-text-cell-feedback'), null)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 1)
      assert.equal(disk()[0].fieldValues.notes, 'Accepted A')
    })
  }
})

test('an older physical read cannot unlock a newer write or overlap its queued post-ACK read', async () => {
  for (const ackBeforeOldRead of [false, true]) {
    await withWorkspace(async ({ writes, reads, input, fill, key, ack, read, disk }) => {
      await act(async () => input().focus())
      await fill('Accepted A')
      await key('Enter')
      await ack(0)
      await act(async () => input().focus())
      await fill('Accepted B')
      await key('Enter')
      assert.equal(writes.length, 2)
      assert.equal(input().readOnly, true)
      if (ackBeforeOldRead) {
        await ack(1)
        assert.equal(input().readOnly, false)
        assert.equal(reads.length, 1, 'the second read waits for the old physical read to finish')
      }
      await read(0, ackBeforeOldRead)
      assert.equal(input().value, 'Accepted B')
      assert.equal(input().readOnly, !ackBeforeOldRead)
      if (!ackBeforeOldRead) {
        await act(async () => input().focus())
        await key('Enter')
        await key('Enter')
        assert.equal(writes.length, 2)
        await ack(1)
      }
      assert.equal(reads.length, 2)
      assert.equal(input().readOnly, false)
      await read(1)
      assert.equal(input().value, 'Accepted B')
      assert.equal(input().parentElement!.querySelector('.dbw-text-cell-feedback, button'), null)
      assert.deepEqual(writes.map(request => request.input.fieldValues), [{ notes: 'Accepted A' }, { notes: 'Accepted B' }])
      assert.equal(disk()[0].fieldValues.notes, 'Accepted B')
      assert.equal(disk()[0].fieldValues.other, 'Preserved metadata')
    })
  }
})

test('manual Refresh stays single-flight and editable, and its obsolete outcome cannot restore a localized old error', async () => {
  for (const failed of [false, true]) {
    await withWorkspace(async ({ document, writes, reads, input, focusCalls, fill, key, ack, read, update }) => {
      await act(async () => input().focus())
      await fill('Accepted A')
      await key('Enter')
      await ack(0)
      await read(0, true)
      await update({ locale: 'zh-CN' })
      const text = getDatabaseWorkspaceText('zh-CN')
      assert.equal(input().title, text.savedRefreshFailed)
      assert.equal(input().parentElement!.querySelector('.dbw-text-cell-feedback')?.textContent, text.savedRefreshFailed)
      const refresh = input().parentElement!.querySelector<HTMLButtonElement>('button')!
      assert.ok(refresh)
      assert.equal(refresh.textContent, text.refresh)
      await act(async () => { refresh.focus(); refresh.click(); refresh.click() })
      assert.equal(reads.length, 2)
      assert.equal(writes.length, 1)
      assert.equal(input().readOnly, false)
      await act(async () => input().focus())
      await fill('手动刷新期间的新稿')
      const field = input()
      field.setSelectionRange(1, 4)
      focusCalls.length = 0
      await read(1, failed)
      assert.equal(field.value, '手动刷新期间的新稿')
      assert.equal(document.activeElement, field)
      assert.deepEqual([field.selectionStart, field.selectionEnd], [1, 4])
      assert.deepEqual(focusCalls, [])
      assert.equal(field.readOnly, false)
      assert.equal(field.parentElement!.querySelector('.dbw-text-cell-feedback'), null)
      assert.equal(reads.length, 2)
      assert.equal(writes.length, 1)
    })
  }
})

test('IME and Escape retain the saved value without reviving an already settled reading snapshot', async () => {
  for (const outcome of ['success-before-Escape', 'failure-before-Escape', 'pending-at-Escape'] as const) {
    await withWorkspace(async ({ document, window, writes, reads, input, fill, key, ack, read, disk }) => {
      await act(async () => input().focus())
      await fill('Accepted A')
      await key('Enter')
      await ack(0)
      const field = input()
      assert.equal(field.readOnly, false)
      await act(async () => field.focus())
      await fill('Unsubmitted composition B')
      // These are controlled DOM composition events, not an operating-system IME.
      await act(async () => field.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
      const confirmingEnter = await key('Enter')
      const composingEscape = await key('Escape')
      assert.equal(confirmingEnter.defaultPrevented, false)
      assert.equal(composingEscape.defaultPrevented, false)
      assert.equal(document.activeElement, field)
      assert.equal(field.value, 'Unsubmitted composition B')
      assert.equal(writes.length, 1)
      await act(async () => field.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
      if (outcome !== 'pending-at-Escape') await read(0, outcome === 'failure-before-Escape')
      assert.equal(field.value, 'Unsubmitted composition B')
      const escape = await key('Escape')
      assert.equal(escape.defaultPrevented, true)
      assert.equal(field.value, 'Accepted A')
      assert.equal(field.readOnly, false)
      assert.notEqual(document.activeElement, field, 'ordinary Escape delegates to native blur')
      assert.equal(writes.length, 1)
      if (outcome === 'pending-at-Escape') await read(0)
      assert.notEqual(field.title, getDatabaseWorkspaceText('en-US').cellRefreshing)
      assert.equal(field.readOnly, false)
      assert.equal(reads.length, 1)
      await act(async () => field.focus())
      await fill('Accepted C after Escape')
      await key('Enter')
      assert.equal(writes.length, 2, 'a completed old read cannot leave a ghost mutation lock')
      await ack(1)
      assert.equal(reads.length, 2)
      assert.equal(field.readOnly, false)
      await read(1)
      assert.equal(field.value, 'Accepted C after Escape')
      assert.equal(disk()[0].fieldValues.notes, 'Accepted C after Escape')
      assert.equal(field.parentElement!.querySelector('.dbw-text-cell-feedback, button'), null)
    })
  }
})

test('virtual rows and workspace/source remounts retain new drafts without letting an old read unlock another source', async () => {
  await withWorkspace(async ({ document, writes, reads, input, focusCalls, fill, key, ack, read, disk, update, move }) => {
    const originalA = disk(), originalB = disk('b')
    await act(async () => input().focus())
    await fill('Accepted A')
    await key('Enter')
    await ack(0)
    await act(async () => input().focus())
    await fill('  A draft across virtual rows and pages  ')
    const first = input()
    await move(2400)
    assert.equal(first.isConnected, false, 'the original row really leaves the rendered virtual slice')
    await move(0)
    assert.notEqual(input(), first)
    assert.equal(input().value, '  A draft across virtual rows and pages  ')
    assert.equal(input().readOnly, false)
    await update({ shown: false })
    assert.equal(document.querySelector('.dbw-table'), null)
    await update({ shown: true })
    assert.equal(input().value, '  A draft across virtual rows and pages  ')
    await update({ source: 'b', viewId: 'b-main', entities: disk('b') })
    assert.equal(input().value, 'B original 0', 'identical record/field IDs do not merge source sessions')
    await act(async () => input().focus())
    await fill('Accepted B source')
    await key('Enter')
    const b = input()
    assert.equal(b.readOnly, true)
    focusCalls.length = 0
    await read(0, true)
    assert.equal(input(), b)
    assert.equal(b.value, 'Accepted B source')
    assert.equal(b.readOnly, true)
    assert.equal(b.parentElement!.querySelector('[role="alert"]'), null)
    assert.deepEqual(focusCalls, [])
    assert.equal(reads.length, 1)
    await ack(1)
    assert.equal(reads.length, 2)
    assert.equal(b.readOnly, false)
    await read(1)
    await update({ source: 'a', viewId: 'a-main', entities: disk() })
    assert.equal(input().value, '  A draft across virtual rows and pages  ')
    assert.equal(input().readOnly, false)
    assert.equal(input().parentElement!.querySelector('.dbw-text-cell-feedback'), null)
    assert.equal(writes.length, 2)
    assert.deepEqual(writes.map(request => request.source), ['a', 'b'])
    assert.equal(disk()[0].fieldValues.notes, 'Accepted A')
    assert.equal(disk('b')[0].fieldValues.notes, 'Accepted B source')
    assert.deepEqual(disk().slice(1), originalA.slice(1))
    assert.deepEqual(disk('b').slice(1), originalB.slice(1))
  })
})

test('a late read from a deleted or changed text field cannot unlock its replacement cell write', async () => {
  await withWorkspace(async ({ document, writes, reads, input, fill, key, ack, read, disk, update }) => {
    await act(async () => input().focus())
    await fill('Accepted before schema change')
    await key('Enter')
    await ack(0)
    const removed = input()
    await update({ columns: [{ ...notes, type: 'select', options: ['A original 0', 'Accepted before schema change'] }] })
    assert.ok(document.querySelector('select[aria-label="Notes"]'))
    assert.equal(document.querySelector('.dbw-text-cell-editor'), null)
    await update({ columns: [] })
    assert.equal(document.querySelector('[aria-label="Notes"]'), null)
    await update({ columns: [notes], entities: disk() })
    const replacement = input()
    assert.notEqual(replacement, removed)
    assert.equal(replacement.value, 'Accepted before schema change')
    await act(async () => replacement.focus())
    await fill('New schema accepted B')
    await key('Enter')
    assert.equal(writes.length, 2)
    assert.equal(replacement.readOnly, true)
    await read(0, true)
    assert.equal(input(), replacement)
    assert.equal(replacement.value, 'New schema accepted B')
    assert.equal(replacement.readOnly, true)
    assert.equal(replacement.parentElement!.querySelector('[role="alert"]'), null)
    await act(async () => replacement.blur())
    assert.equal(writes.length, 2)
    await ack(1)
    assert.equal(reads.length, 2)
    assert.equal(replacement.readOnly, false)
    await read(1)
    assert.equal(replacement.value, 'New schema accepted B')
    assert.equal(replacement.parentElement!.querySelector('.dbw-text-cell-feedback, button'), null)
    assert.equal(disk()[0].fieldValues.notes, 'New schema accepted B')
    assert.equal(disk()[0].fieldValues.other, 'Preserved metadata')
    assert.equal(writes.length, 2)
  })
})

test('a completed current read remains authorized when React later applies its guarded canonical records updater', async () => {
  await withWorkspace(async ({ writes, reads, input, fill, key, ack, read, disk, rendered, externalWrite }) => {
    const untouched = disk().slice(1)
    await act(async () => input().focus())
    await fill('Accepted A')
    await key('Enter')
    await ack(0)
    assert.equal(reads.length, 1)
    assert.equal(input().value, 'Accepted A')
    assert.equal(input().readOnly, false)
    assert.equal(rendered()[0].fieldValues.notes, 'A original 0', 'a durable ACK is not fabricated as a fresh parent read')
    externalWrite('a', 'record-0', { notes: 'Authoritative C', other: 'A separate durable metadata update' }, '2026-10-03')
    const authoritative = disk()
    assert.equal(input().value, 'Accepted A')
    await read(0)
    assert.ok(reads[0].commitChecks.length > 0, 'the guarded updater actually ran in the parent React render')
    assert.ok(reads[0].commitChecks.every(Boolean), 'finishing a read cannot revoke its already queued lawful publication')
    assert.deepEqual(rendered(), authoritative)
    assert.equal(input().value, 'Authoritative C')
    assert.equal(input().readOnly, false)
    assert.equal(input().parentElement!.querySelector('.dbw-text-cell-feedback, button'), null)
    assert.deepEqual(disk().slice(1), untouched)
    assert.equal(writes.length, 1)
    assert.equal(reads.length, 1)
  })
})

test('Escape after refocusing a pending write restores its completed saved or failed state without reviving the old operation', async () => {
  for (const outcome of ['saved', 'failed'] as const) {
    await withWorkspace(async ({ document, writes, reads, input, focusCalls, fill, key, ack, rejectWrite, disk, rendered }) => {
      const originals = disk()
      const field = input()
      const rawA = '  Accepted A  '
      await act(async () => field.focus())
      await fill(rawA)
      await key('Enter')
      assert.notEqual(document.activeElement, field)
      assert.equal(field.readOnly, true)
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 0)
      assert.deepEqual(writes[0].input, { entityId: 'record-0', fieldValues: { notes: 'Accepted A' } })
      assert.deepEqual(disk(), originals)
      // Read-only inputs can really receive focus. The focus snapshot here is
      // the pending write, before its result makes this same control editable.
      await act(async () => field.focus())
      assert.equal(document.activeElement, field)
      assert.equal(field.readOnly, true)
      focusCalls.length = 0
      if (outcome === 'saved') await ack(0)
      else await rejectWrite(0)
      assert.equal(input(), field)
      assert.equal(document.activeElement, field)
      assert.equal(field.readOnly, false)
      assert.equal(field.value, outcome === 'saved' ? 'Accepted A' : rawA)
      assert.equal(reads.length, outcome === 'saved' ? 1 : 0)
      assert.deepEqual(rendered(), originals, 'only a real parent read may publish canonical records')
      const expected = outcome === 'saved' ? originals.map((entity, index) => index === 0
        ? { ...entity, fieldValues: { ...entity.fieldValues, notes: 'Accepted A' }, updatedAt: '2026-10-02' }
        : entity) : originals
      assert.deepEqual(disk(), expected)
      await fill('Discard this newer B')
      assert.equal(document.activeElement, field)
      assert.equal(field.value, 'Discard this newer B')
      const escape = await key('Escape')
      assert.equal(escape.defaultPrevented, true)
      assert.equal(field.value, outcome === 'saved' ? 'Accepted A' : rawA,
        'the focus snapshot must advance past a completed operation before restoring')
      assert.equal(field.readOnly, false)
      assert.notEqual(field.getAttribute('aria-busy'), 'true')
      assert.notEqual(field.title, getDatabaseWorkspaceText('en-US').saving)
      assert.notEqual(document.activeElement, field, 'Escape still uses native blur')
      assert.deepEqual(focusCalls, [])
      if (outcome === 'failed') {
        const text = getDatabaseWorkspaceText('en-US')
        assert.equal(field.getAttribute('aria-invalid'), 'true')
        assert.equal(field.title, text.formFailed)
        assert.equal(field.parentElement!.querySelector('[role="alert"]')?.textContent, text.formFailed)
        assert.equal(field.parentElement!.querySelector('button')?.textContent, text.retry)
      }
      assert.equal(writes.length, 1)
      assert.equal(reads.length, outcome === 'saved' ? 1 : 0)
      assert.deepEqual(disk(), expected)
    })
  }
})
