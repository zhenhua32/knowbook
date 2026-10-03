import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useReducer, type ComponentProps, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEntity, DatabaseSavedView, DocumentDatabase, DocumentDatabaseColumn, DocumentDatabaseFieldValue, UpdateDatabaseEntityInput } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { DatabaseValueEditor } from '../src/renderer/src/features/database/components/DatabaseValueEditor'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const { DatabaseWorkspace } = await import('../src/renderer/src/features/database/DatabaseWorkspace')
const { DatabaseTextDraftCache } = await import('../src/renderer/src/features/database/model/databaseTextDrafts')

type EditorProps = ComponentProps<typeof DatabaseValueEditor>
type CommitResult = Awaited<ReturnType<EditorProps['onChangeValue']>>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred<CommitResult>> & { value: DocumentDatabaseFieldValue }
const notes: DocumentDatabaseColumn = { id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 }

async function withEditor(run: (context: {
  document: Document; window: JSDOM['window']; input: () => HTMLInputElement
  outside: HTMLInputElement; requests: Request[]; focusCalls: HTMLElement[]
  fill: (value: string) => Promise<void>; key: (key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  render: (patch: Partial<EditorProps>) => Promise<void>; settle: (index: number, result: CommitResult) => Promise<void>
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
  const requests: Request[] = []
  let props: EditorProps = { column: notes, value: 'Saved A', onChangeValue: value => {
    const request = { ...deferred<CommitResult>(), value }
    requests.push(request)
    return request.promise
  }, ...options }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const render = async (patch: Partial<EditorProps> = {}) => {
    props = { ...props, ...patch }
    await act(async () => root.render(createElement(DatabaseValueEditor, props)))
  }
  const input = () => {
    const control = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
    assert.ok(control)
    return control
  }
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window, input, requests, focusCalls, render,
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
      settle: async (index, result) => { assert.ok(requests[index]); await act(async () => requests[index].resolve(result)) }
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

type Write = ReturnType<typeof deferred<DatabaseEntity>> & { input: UpdateDatabaseEntityInput }
type Read = ReturnType<typeof deferred<void>> & { canApply: () => boolean }
async function withWorkspace(run: (context: {
  document: Document; input: () => HTMLInputElement; outside: HTMLInputElement; focusCalls: HTMLElement[]
  writes: Write[]; reads: Read[]; disk: () => DatabaseEntity[]; rendered: () => DatabaseEntity[]
  fill: (value: string) => Promise<void>; enter: () => Promise<void>; ack: (index: number) => Promise<void>
  read: (index: number, failed?: boolean) => Promise<void>; externalRefresh: () => Promise<void>
  externalWrite: (fields: DatabaseEntity['fieldValues'], revision?: string) => void
}) => Promise<void>, options: { value?: DocumentDatabaseFieldValue | undefined } = {}) {
  const initialValue = Object.hasOwn(options, 'value') ? options.value : 'Saved A'
  const dom = new JSDOM('<div id="mount"></div><input id="outside">', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const focusCalls: HTMLElement[] = [], nativeFocus = dom.window.HTMLElement.prototype.focus
  dom.window.HTMLElement.prototype.focus = function (options?: FocusOptions) {
    focusCalls.push(this); nativeFocus.call(this, options)
  }
  const database: DocumentDatabase = { id: 'a', kind: 'custom', name: 'Source A', description: '',
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }
  let server: DatabaseEntity[] = ['One', 'Other'].map((title, index) => ({ id: `record-${index}`, databaseId: 'a', title,
    documentId: null, fieldValues: { other: 'Untouched metadata', ...(index ? { notes: 'Other value' }
      : initialValue === undefined ? {} : { notes: initialValue }) }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }))
  const view: DatabaseSavedView = { id: 'main', databaseId: 'a', name: 'All records',
    config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, notes.id]), configVersion: 1,
    filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table', sortOrder: 0,
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }
  const writes: Write[] = [], reads: Read[] = []
  const cache = new DatabaseTextDraftCache()
  let current: DatabaseEntity[] = [], setRecords!: (action: SetStateAction<DatabaseEntity[]>) => void
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDatabaseEntity: (input: UpdateDatabaseEntityInput) => {
      const request = { ...deferred<DatabaseEntity>(), input: structuredClone(input) }
      writes.push(request); return request.promise
    }
  } })
  const refresh = async (_source?: string, _view?: string, shouldContinue?: () => boolean) => {
    const request = { ...deferred<void>(), canApply: shouldContinue ?? (() => true) }
    reads.push(request)
    await request.promise
    if (!request.canApply()) return false
    const canonical = structuredClone(server)
    setRecords(previous => request.canApply() ? canonical : previous)
    return true
  }
  function Harness() {
    const [records, update] = useReducer((previous: DatabaseEntity[], action: SetStateAction<DatabaseEntity[]>) =>
      typeof action === 'function' ? action(previous) : action, structuredClone(server))
    current = records; setRecords = update
    return createElement(DatabaseWorkspace, { currentDatabaseId: 'a', activeViewId: 'main', databases: [database],
      savedViews: [view], selectedColumns: [notes], entities: records, catalogColumns: [], catalogDocuments: [],
      selectedRecordIds: [], textDraftCache: cache, locale: 'en-US', onRefresh: refresh,
      onActiveViewIdChange: () => {}, onCurrentDatabaseIdChange: () => {}, onOpenDocument: () => {},
      onMessage: () => {}, onSelectedRecordIdsChange: () => {} })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const input = () => {
    const row = [...dom.window.document.querySelectorAll('.dbw-table tbody tr')]
      .find(node => node.querySelector('strong')?.textContent === 'One')
    const field = row?.querySelector<HTMLInputElement>('input[aria-label="Notes"]')
    assert.ok(field); return field
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ document: dom.window.document, input, writes, reads, focusCalls,
      outside: dom.window.document.getElementById('outside') as HTMLInputElement,
      disk: () => structuredClone(server), rendered: () => structuredClone(current),
      fill: async value => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
        input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      enter: async () => { await act(async () => input().dispatchEvent(new dom.window.KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }))) },
      ack: async index => {
        assert.ok(writes[index])
        server = server.map(entity => entity.id === writes[index].input.entityId
          ? { ...entity, fieldValues: { ...entity.fieldValues, ...writes[index].input.fieldValues }, updatedAt: `2026-10-02T00:00:0${index}Z` }
          : entity)
        const result = server.find(entity => entity.id === writes[index].input.entityId)!
        await act(async () => writes[index].resolve(structuredClone(result)))
      },
      read: async (index, failed = false) => { assert.ok(reads[index]); await act(async () => {
        if (failed) reads[index].reject(new Error('Read unavailable'))
        else reads[index].resolve()
      }) },
      externalRefresh: async () => { await act(async () => { void refresh().catch(() => {}) }) },
      // An independent durable backend change is published only by the real
      // parent refresh callback, never by directly changing cache/UI state.
      externalWrite: (fields, revision = '2026-10-03') => { server = server.map((entity, index) => index === 0
        ? { ...entity, fieldValues: { ...entity.fieldValues, ...structuredClone(fields) }, updatedAt: revision } : entity) }
    })
  } finally {
    await act(async () => root.unmount())
    await act(async () => { writes.forEach(request => request.resolve(structuredClone(server[0]))); reads.forEach(request => request.resolve()) })
    dom.window.HTMLElement.prototype.focus = nativeFocus
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('native focus and blur of an unchanged text cell do not request a write', async () => {
  await withEditor(async ({ document, input, outside, requests }) => {
    const field = input()
    await act(async () => field.focus())
    assert.equal(document.activeElement, field)
    assert.equal(field.value, 'Saved A')
    await act(async () => outside.focus())
    assert.equal(document.activeElement, outside, 'the browser performs the actual field blur')
    assert.equal(input(), field)
    assert.equal(requests.length, 0, 'browsing an unchanged value is not mutation intent')
    assert.equal(field.value, 'Saved A')
    assert.equal(field.readOnly, false)
    assert.equal(field.parentElement!.querySelector('.dbw-text-cell-feedback, button'), null)
  })
})

test('browsing an unchanged failed raw draft and leaving its scope does not automatically retry', async () => {
  await withEditor(async ({ document, input, outside, requests, fill, key, settle }) => {
    const field = input()
    await act(async () => field.focus())
    await fill('  Kept failed draft  ')
    await key('Enter')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].value, 'Kept failed draft')
    await settle(0, { status: 'failed', message: 'Save blocked' })
    const retry = field.parentElement!.querySelector<HTMLButtonElement>('button')!
    assert.ok(retry)
    assert.equal(retry.textContent, getDatabaseWorkspaceText('en-US').retry)
    assert.equal(field.parentElement!.querySelector('[role="alert"]')?.textContent, 'Save blocked')
    assert.equal(field.value, '  Kept failed draft  ')
    await act(async () => field.focus())
    await act(async () => outside.focus())
    assert.equal(document.activeElement, outside)
    assert.equal(requests.length, 1, 'native blur without a raw change must keep failure for explicit Retry')
    assert.equal(field.value, '  Kept failed draft  ')
    assert.equal(field.readOnly, false)
    assert.equal(field.parentElement!.querySelector('button'), retry)
    assert.equal(field.parentElement!.querySelector('[role="alert"]')?.textContent, 'Save blocked')
  })
})

test('returning to a failed raw draft keeps its original reason until explicit Retry accepts one request', async () => {
  await withEditor(async ({ document, input, outside, requests, focusCalls, fill, key, settle }) => {
    const field = input(), raw = '  Kept failed draft  '
    await act(async () => field.focus())
    await fill(raw)
    await key('Enter')
    await settle(0, { status: 'failed', message: 'Save blocked' })
    await act(async () => field.focus())
    await fill('Temporary B')
    await fill(raw)
    await act(async () => outside.focus())
    assert.equal(requests.length, 1)
    assert.equal(field.value, raw)
    assert.equal(field.parentElement!.querySelector('[role="alert"]')?.textContent, 'Save blocked')
    assert.equal(field.title, 'Save blocked')
    await act(async () => field.focus())
    await key('Enter')
    assert.equal(requests.length, 1, 'implicit unchanged Enter is not the explicit failed-write Retry action')
    const retry = field.parentElement!.querySelector<HTMLButtonElement>('button')!
    assert.ok(retry)
    await act(async () => { retry.focus(); retry.click(); retry.click() })
    assert.equal(requests.length, 2)
    assert.deepEqual(requests.map(request => request.value), ['Kept failed draft', 'Kept failed draft'])
    assert.equal(field.readOnly, true)
    await act(async () => outside.focus())
    focusCalls.length = 0
    await settle(1, { status: 'saved', value: 'Kept failed draft' })
    assert.equal(document.activeElement, outside)
    assert.deepEqual(focusCalls, [])
    assert.equal(field.value, 'Kept failed draft')
    assert.equal(field.readOnly, false)
    assert.equal(field.parentElement!.querySelector('[role="alert"], button'), null)
    assert.equal(requests.length, 2)
  })
})

test('a genuine changed DOM value commits on native blur even without a React onChange event', async () => {
  for (const [raw, canonical] of [['  Autofilled value  ', 'Autofilled value'], ['   ', null]] as const) {
    await withEditor(async ({ document, window, input, outside, requests, settle }) => {
      const field = input()
      await act(async () => field.focus())
      // An autofill/integration can change the DOM value without delivering
      // React onChange. The real blur must compare that value, not an event flag.
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, raw)
      assert.equal(field.value, raw)
      await act(async () => outside.focus())
      assert.equal(document.activeElement, outside)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].value, canonical)
      await settle(0, undefined)
      assert.equal(field.value, canonical ?? '')
      assert.equal(field.readOnly, false)
      assert.equal(requests.length, 1)
    })
  }
})

test('the actual workspace ignores canonical no-ops but persists clearing a nonempty property', async () => {
  const cases: Array<{ value: DocumentDatabaseFieldValue | undefined; drafts: string[]; clear?: boolean }> = [
    { value: 'Saved A', drafts: ['Temporary B', 'Saved A'] },
    { value: 'Saved A', drafts: ['  Saved A  '] },
    { value: null, drafts: ['   '] },
    { value: undefined, drafts: ['   '] },
    { value: 'Saved A', drafts: ['   '], clear: true }
  ]
  for (const item of cases) {
    await withWorkspace(async ({ document, input, writes, reads, fill, enter, ack, read, disk, rendered }) => {
      const originals = disk(), field = input()
      assert.equal(field.value, item.value ?? '')
      await act(async () => field.focus())
      for (const draft of item.drafts) await fill(draft)
      await enter()
      assert.notEqual(document.activeElement, field)
      assert.equal(writes.length, item.clear ? 1 : 0)
      if (item.clear) {
        assert.deepEqual(writes[0].input, { entityId: 'record-0', fieldValues: { notes: null } })
        await ack(0)
        assert.equal(reads.length, 1)
        await read(0)
        assert.equal(disk()[0].fieldValues.notes, null)
        assert.deepEqual(rendered(), disk())
        assert.equal(disk()[0].fieldValues.other, originals[0].fieldValues.other)
        assert.deepEqual(disk().slice(1), originals.slice(1))
      } else {
        assert.deepEqual(disk(), originals)
        assert.deepEqual(rendered(), originals)
        assert.equal(reads.length, 0)
      }
      assert.equal(field.value.trim(), item.clear ? '' : item.value ?? '')
      assert.equal(field.readOnly, false)
      assert.equal(field.parentElement!.querySelector('.dbw-text-cell-feedback, button'), null)
    }, { value: item.value })
  }
})

test('IME and Escape do not create blur intent, while synchronous void and change-mode callbacks remain compatible', async () => {
  await withEditor(async ({ document, window, input, requests, fill, key, settle }) => {
    const field = input()
    await act(async () => field.focus())
    await fill('Unsubmitted B')
    // Controlled DOM composition lifecycle, not an operating-system IME.
    await act(async () => field.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal((await key('Enter')).defaultPrevented, false)
    assert.equal((await key('Escape')).defaultPrevented, false)
    assert.equal(document.activeElement, field)
    assert.equal(requests.length, 0)
    await act(async () => field.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    await key('Escape')
    assert.equal(field.value, 'Saved A')
    assert.equal(requests.length, 0)
    await act(async () => field.focus())
    await fill('Legacy Promise void')
    await key('Enter')
    assert.equal(requests.length, 1)
    await settle(0, undefined)
    assert.equal(field.value, 'Legacy Promise void')
    assert.equal(field.readOnly, false)
  })
  const legacy: DocumentDatabaseFieldValue[] = []
  await withEditor(async ({ input, outside, fill, key }) => {
    await act(async () => input().focus())
    await fill('Synchronous value')
    await key('Enter')
    assert.deepEqual(legacy, ['Synchronous value'])
    await act(async () => input().focus())
    await act(async () => outside.focus())
    assert.deepEqual(legacy, ['Synchronous value'])
  }, { onChangeValue: value => { legacy.push(value) } })
  const changes: DocumentDatabaseFieldValue[] = []
  await withEditor(async ({ input, fill, key }) => {
    await act(async () => input().focus())
    await fill('Change-mode B')
    assert.deepEqual(changes, ['Change-mode B'])
    await key('Escape')
    assert.equal(input().value, 'Saved A')
    assert.deepEqual(changes, ['Change-mode B', 'Saved A'])
  }, { textCommitMode: 'change', onChangeValue: value => { changes.push(value) } })
})

test('returning to the original A really writes when a fresh parent read has advanced authority to C', async () => {
  for (const revision of ['2026-10-03', '2026-10-01']) {
    await withWorkspace(async ({ input, writes, reads, fill, enter, externalWrite, externalRefresh, ack, read, disk, rendered }) => {
      const originals = disk(), field = input()
      await act(async () => field.focus())
      await fill('Unsubmitted B')
      externalWrite({ notes: 'Authoritative C', other: 'Independently updated metadata' }, revision)
      await externalRefresh()
      assert.equal(reads.length, 1)
      await read(0)
      assert.equal(field.value, 'Unsubmitted B')
      assert.equal(rendered()[0].fieldValues.notes, 'Authoritative C')
      assert.deepEqual(rendered(), disk())
      await fill('Saved A')
      await enter()
      assert.equal(writes.length, 1, 'A differs from current durable C even though A was the focus-start baseline')
      assert.deepEqual(writes[0].input, { entityId: 'record-0', fieldValues: { notes: 'Saved A' } })
      await ack(0)
      assert.equal(reads.length, 2)
      await read(1)
      assert.equal(field.value, 'Saved A')
      assert.equal(disk()[0].fieldValues.notes, 'Saved A')
      assert.equal(disk()[0].fieldValues.other, 'Independently updated metadata')
      assert.deepEqual(disk().slice(1), originals.slice(1))
      assert.deepEqual(rendered(), disk())
      assert.equal(writes.length, 1)
    })
  }
})

test('returning to an ACK overlay B does not rewrite lagging props A, lose Refresh feedback or revive a revoked read', async () => {
  for (const oldRead of ['pending', 'failed'] as const) {
    await withWorkspace(async ({ document, input, outside, focusCalls, writes, reads, fill, enter, ack, read, disk, rendered, externalWrite }) => {
      const originals = disk(), field = input(), text = getDatabaseWorkspaceText('en-US')
      await act(async () => field.focus())
      await fill('Accepted B')
      await enter()
      await ack(0)
      assert.equal(field.value, 'Accepted B')
      assert.equal(rendered()[0].fieldValues.notes, 'Saved A')
      if (oldRead === 'failed') await read(0, true)
      await act(async () => field.focus())
      await fill('Temporary C')
      await fill('Accepted B')
      await act(async () => outside.focus())
      assert.equal(writes.length, 1, 'returning to the known accepted value is not a new mutation')
      assert.equal(field.value, 'Accepted B')
      assert.equal(field.readOnly, false)
      assert.equal(reads.length, 1)
      assert.equal(reads[0].canApply(), false, 'editing away and back cannot revive the public read publication lease')
      if (oldRead === 'failed') {
        assert.equal(field.title, text.savedRefreshFailed)
        assert.equal(field.parentElement!.querySelector('.dbw-text-cell-feedback')?.textContent, text.savedRefreshFailed)
        assert.equal(field.parentElement!.querySelector('button')?.textContent, text.refresh)
      } else {
        externalWrite({ notes: 'A newer independent durable C', other: 'Late backend metadata' })
        await act(async () => field.focus())
        field.setSelectionRange(0, 3)
        focusCalls.length = 0
        await read(0)
        assert.equal(document.activeElement, field)
        assert.deepEqual([field.selectionStart, field.selectionEnd], [0, 3])
        assert.deepEqual(focusCalls, [])
        assert.equal(field.value, 'Accepted B')
        assert.equal(field.parentElement!.querySelector('.dbw-text-cell-feedback'), null)
        assert.equal(rendered()[0].fieldValues.notes, 'Saved A', 'the revoked late read cannot publish its C over the new intent')
        assert.equal(disk()[0].fieldValues.notes, 'A newer independent durable C')
      }
      assert.deepEqual(disk().slice(1), originals.slice(1))
      assert.equal(writes.length, 1)
      assert.equal(reads.length, 1)
    })
  }
})
