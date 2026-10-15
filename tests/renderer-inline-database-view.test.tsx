import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useState, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseEmbedSnapshot, DatabaseEntity, UpdateDatabaseEntitiesInput, UpdateDatabaseEntityInput, UpdateDocumentDatabaseValueInput } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { parseDatabaseViewPayload, serializeDatabaseViewPayload, type DatabaseViewBlockPayloadV1 } from '../src/shared/databaseViewBlock'
import { DatabaseEmbedProvider, type DatabaseEmbedContextValue, type DatabaseViewPickerRequest } from '../src/renderer/src/features/database/DatabaseEmbedContext'
import { waitForRenderer } from './helpers/renderer-async'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)
const { InlineDatabaseView } = await import('../src/renderer/src/features/database/InlineDatabaseView')
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const payload = (databaseId = 'custom'): DatabaseViewBlockPayloadV1 => ({ version: 1, databaseId, viewId: null,
  config: createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title, 'notes']) })
const entity = (databaseId: string, id = 'record'): DatabaseEntity => ({ id, databaseId, title: 'Target', documentId: null,
  fieldValues: { notes: `Server ${databaseId}`, other: 'Untouched original' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' })
function snapshot(databaseId: string): DatabaseEmbedSnapshot {
  if (databaseId === 'missing') return { status: 'missing', databaseId }
  return { status: 'ready', database: { id: databaseId, name: databaseId, description: '',
    kind: databaseId === 'catalog' ? 'document-catalog' : 'custom', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
    columns: [{ id: 'notes', name: 'Notes', type: 'text', options: [], sortOrder: 0 },
      { id: 'other', name: 'Other field', type: 'text', options: [], sortOrder: 1 }], savedViews: [],
    entities: [entity(databaseId, databaseId === 'catalog' ? 'detached' : 'record')],
    catalogDocuments: databaseId === 'catalog' ? [{ id: 'real-document', title: 'Real document', path: 'Real document',
      summary: '', parentId: null, parentTitle: null, updatedAt: '2026-10-01', blockCount: 1, childCount: 0, linkCount: 0,
      fieldValues: { notes: 'Document value' } }] : [] }
}
type Atom = { id: string; content: string; mode: 'edit' | 'reading' }
type Write = ReturnType<typeof deferred<DatabaseEntity | void>> & ({ kind: 'entity'; input: UpdateDatabaseEntityInput } | { kind: 'document'; input: UpdateDocumentDatabaseValueInput })
async function withEmbeds(run: (api: {
  document: Document; window: JSDOM['window']; writes: Write[]; reads: string[]; commits: string[]; pickers: DatabaseViewPickerRequest[]
  bulk: Array<ReturnType<typeof deferred<DatabaseEntity[]>> & { input: UpdateDatabaseEntitiesInput }>
  creates: Array<ReturnType<typeof deferred<{ id: string }>>>; navigations: string[]
  host: (id?: string) => HTMLElement; notes: (id?: string, row?: number) => HTMLInputElement; query: (id?: string) => HTMLInputElement
  fill: (input: HTMLInputElement, raw: string) => Promise<void>; enter: (input: HTMLInputElement) => Promise<void>
  replace: (id: string, next: DatabaseViewBlockPayloadV1) => Promise<void>; mode: (mode: 'edit' | 'reading') => Promise<void>
  content: (id?: string) => DatabaseViewBlockPayloadV1; acknowledge: (index: number) => Promise<void>; mutate: (source: string, raw: string) => Promise<void>
  acknowledgeBulk: (index: number) => Promise<void>
  holdRead: (source: string) => { started: () => boolean; release: () => Promise<void> }
  remove: (id: string) => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div><input id="outside">', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const disk = new Map(['custom', 'other', 'catalog', 'missing'].map(id => [id, snapshot(id)])), observers = new Set<() => void>()
  const writes: Write[] = [], reads: string[] = [], commits: string[] = [], pickers: DatabaseViewPickerRequest[] = []
  const bulk: Array<ReturnType<typeof deferred<DatabaseEntity[]>> & { input: UpdateDatabaseEntitiesInput }> = []
  const creates: Array<ReturnType<typeof deferred<{ id: string }>>> = [], navigations: string[] = []
  const heldReads = new Map<string, { request: ReturnType<typeof deferred<DatabaseEmbedSnapshot>>; started: boolean }>()
  Object.defineProperty(dom.window, 'knowbook', { value: {
    getDatabaseEmbedSnapshot: async (id: string) => {
      reads.push(id)
      const held = heldReads.get(id)
      if (held) { heldReads.delete(id); held.started = true; return held.request.promise }
      return structuredClone(disk.get(id) ?? { status: 'missing', databaseId: id })
    },
    onWorkspaceMutated: (callback: () => void) => { observers.add(callback); return () => observers.delete(callback) },
    updateDatabaseEntity: (input: UpdateDatabaseEntityInput) => { const write: Write = { kind: 'entity', input, ...deferred<DatabaseEntity | void>() }; writes.push(write); return write.promise },
    updateDatabaseEntities: (input: UpdateDatabaseEntitiesInput) => { const write = { input, ...deferred<DatabaseEntity[]>() }; bulk.push(write); return write.promise },
    createDocument: () => { const create = deferred<{ id: string }>(); creates.push(create); return create.promise },
    updateDocumentDatabaseValue: (input: UpdateDocumentDatabaseValueInput) => { const write: Write = { kind: 'document', input, ...deferred<DatabaseEntity | void>() }; writes.push(write); return write.promise }
  } })
  let atoms!: Atom[], update!: (action: SetStateAction<Atom[]>) => void
  const registry = new Map<string, unknown>(), session = {}
  function Harness() {
    const [current, setCurrent] = useState<Atom[]>(['one', 'two'].map(id => ({ id, content: serializeDatabaseViewPayload(payload()), mode: 'edit' })))
    atoms = current; update = setCurrent
    const context: DatabaseEmbedContextValue = { documentId: 'host-document', session, registry, locale: 'en-US', isZh: false,
      onMessage: () => {}, onOpenDocument: (id, shouldContinue) => { if (shouldContinue?.() !== false) navigations.push(id) }, onEnterEditing: () => setCurrent(previous => previous.map(atom => ({ ...atom, mode: 'edit' }))),
      openPicker: request => { pickers.push(request) }, commitContent: (id, expected, next) => {
        if (!atoms.some(atom => atom.id === id && atom.content === expected && atom.mode === 'edit')) return false
        commits.push(id); setCurrent(previous => previous.map(atom => atom.id === id ? { ...atom, content: next } : atom)); return true
      } }
    return createElement(DatabaseEmbedProvider, { value: context }, current.map(atom => createElement('div', { key: atom.id, 'data-fixture-host': atom.id },
      createElement(InlineDatabaseView, { blockId: atom.id, content: atom.content, mode: atom.mode }))))
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const host = (id = 'one') => dom.window.document.querySelector<HTMLElement>(`[data-fixture-host="${id}"]`)!
  const notes = (id = 'one', row = 0) => { const input = host(id).querySelectorAll<HTMLInputElement>('.dbw-table input[aria-label="Notes"]')[row]; assert.ok(input); return input }
  const query = (id = 'one') => { const input = host(id).querySelector<HTMLInputElement>('.dbw-main-search input'); assert.ok(input); return input }
  try {
    await act(async () => root.render(createElement(Harness)))
    await waitForRenderer(() => Boolean(host().querySelector('input[aria-label="Notes"]')), 'the real database workspace must load')
    await run({ document: dom.window.document, window: dom.window, writes, reads, commits, pickers, host, notes, query, bulk, creates, navigations,
      fill: async (input, raw) => { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, raw); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }) },
      enter: async input => { await act(async () => { input.focus(); input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }) },
      replace: async (id, next) => { await act(async () => update(previous => previous.map(atom => atom.id === id ? { ...atom, content: serializeDatabaseViewPayload(next) } : atom))) },
      mode: async mode => { await act(async () => update(previous => previous.map(atom => ({ ...atom, mode })))) },
      content: (id = 'one') => parseDatabaseViewPayload(atoms.find(atom => atom.id === id)!.content),
      remove: async id => { await act(async () => update(previous => previous.filter(atom => atom.id !== id))) },
      holdRead: source => {
        const held = { request: deferred<DatabaseEmbedSnapshot>(), started: false }; heldReads.set(source, held)
        return { started: () => held.started, release: async () => { await act(async () => held.request.resolve(structuredClone(disk.get(source)!))) } }
      },
      acknowledge: async index => { const write = writes[index]; assert.ok(write); await act(async () => {
        let result: DatabaseEntity | undefined
        for (const current of disk.values()) if (current.status === 'ready') {
          if (write.kind === 'entity') { current.entities = current.entities.map(entity => entity.id === write.input.entityId
            ? { ...entity, fieldValues: { ...entity.fieldValues, ...write.input.fieldValues }, updatedAt: '2026-10-02' } : entity)
            result ??= current.entities.find(entity => entity.id === write.input.entityId) }
          else current.catalogDocuments = current.catalogDocuments.map(document => document.id === write.input.documentId
            ? { ...document, fieldValues: { ...document.fieldValues, [write.input.columnId]: write.input.value }, updatedAt: '2026-10-02' } : document)
        }
        write.resolve(result); observers.forEach(notify => notify())
      }) },
      acknowledgeBulk: async index => { const write = bulk[index]; assert.ok(write); await act(async () => {
        const result: DatabaseEntity[] = []
        for (const current of disk.values()) if (current.status === 'ready') current.entities = current.entities.map(entity => {
          const patch = write.input.updates.find(update => update.entityId === entity.id)
          if (!patch) return entity
          const next = { ...entity, fieldValues: { ...entity.fieldValues, ...patch.fieldValues }, updatedAt: '2026-10-03' }; result.push(next); return next
        })
        write.resolve(result); observers.forEach(notify => notify())
      }) },
      mutate: async (source, raw) => { await act(async () => { const current = disk.get(source)!; if (current.status === 'ready') current.entities[0].fieldValues.notes = raw; observers.forEach(notify => notify()) }) }
    })
  } finally {
    await act(async () => root.unmount()); assert.equal(observers.size, 0)
    for (const write of writes) write.resolve()
    for (const write of bulk) write.resolve([])
    for (const create of creates) create.resolve({ id: 'created-after-unmount' })
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
}

test('same-source inline workspaces share snapshots while query configuration and dirty cell drafts belong to each host', async () => {
  await withEmbeds(async ({ reads, fill, notes, query, commits, content, mode, replace, host }) => {
    assert.deepEqual(reads, ['custom'])
    await fill(notes(), 'Unsubmitted first host'); assert.equal(notes('two').value, 'Server custom')
    await fill(query(), 'Target'); assert.equal(content().config.query, 'Target'); assert.equal(query('two').value, '')
    assert.deepEqual(commits, ['one']); assert.equal(notes().value, 'Unsubmitted first host')
    await mode('reading'); await mode('edit'); assert.equal(notes().value, 'Unsubmitted first host')
    await replace('one', payload('other'))
    await waitForRenderer(() => host().querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value === 'Server other', 'another source must have its own draft')
    await replace('one', { ...payload(), config: { ...payload().config, query: 'Target' } })
    await waitForRenderer(() => host().querySelector<HTMLInputElement>('input[aria-label="Notes"]')?.value === 'Unsubmitted first host', 'returning to a source must retain its unsubmitted draft')
    assert.equal(notes('two').value, 'Server custom')
  })
})

test('an acknowledged physical cell write updates another live inline view without rewriting either host configuration', async () => {
  await withEmbeds(async ({ fill, notes, enter, writes, acknowledge, commits, content }) => {
    const before = content()
    await fill(notes(), 'Shared committed value'); await enter(notes())
    await waitForRenderer(() => writes.length === 1, 'Enter must commit the actual source cell')
    assert.equal(writes[0].kind, 'entity')
    if (writes[0].kind === 'entity') assert.deepEqual(writes[0].input, { entityId: 'record', fieldValues: { notes: 'Shared committed value' } })
    await acknowledge(0)
    await waitForRenderer(() => notes('two').value === 'Shared committed value', 'source mutation must refresh the other inline workspace')
    assert.equal(notes().value, 'Shared committed value'); assert.deepEqual(content(), before); assert.deepEqual(commits, [])
  })
})

test('catalog inline views route detached records to entity writes and real documents to document field writes', async () => {
  await withEmbeds(async ({ replace, host, notes, fill, enter, writes, acknowledge }) => {
    await replace('one', payload('catalog'))
    await waitForRenderer(() => host().querySelectorAll('input[aria-label="Notes"]').length === 2, 'catalog must include true documents and detached records')
    await fill(notes('one', 0), 'Real document change'); await enter(notes('one', 0))
    await waitForRenderer(() => writes.length === 1, 'real document write must start')
    assert.equal(writes[0].kind, 'document')
    if (writes[0].kind === 'document') assert.equal(writes[0].input.documentId, 'real-document')
    await acknowledge(0)
    await fill(notes('one', 1), 'Detached change'); await enter(notes('one', 1))
    await waitForRenderer(() => writes.length === 2, 'detached entity write must start')
    assert.equal(writes[1].kind, 'entity')
    if (writes[1].kind === 'entity') assert.equal(writes[1].input.entityId, 'detached')
    await acknowledge(1)
  })
})

test('reading mode renders live source values, blocks source writes and provides a real editing entry', async () => {
  await withEmbeds(async ({ mode, host, mutate, writes, document }) => {
    await mode('reading'); assert.equal(host().querySelectorAll('input[aria-label="Notes"]').length, 0)
    assert.match(host().textContent!, /Server custom/)
    await mutate('custom', 'Live reading update')
    await waitForRenderer(() => host().textContent!.includes('Live reading update'), 'reading must follow source updates')
    assert.deepEqual(writes, [])
    const edit = [...host().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Enter editing mode')!
    await act(async () => edit.click())
    assert.equal(document.querySelectorAll('input[aria-label="Notes"]').length, 2)
  })
})

test('missing source or fields remain explicit and old picker callbacks cannot revive a source or view generation', async () => {
  await withEmbeds(async ({ replace, host, commits, pickers, content }) => {
    const choose = () => [...host().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Change source')!
    await act(async () => choose().click()); const old = pickers.at(-1)!; assert.equal(old.isCurrent(), true)
    await replace('one', { ...payload(), viewId: 'unavailable' }); await replace('one', payload())
    assert.equal(old.isCurrent(), false, 'view A to B to A must revoke the old picker lease')
    const missing = payload(); missing.config.filters.rules = [{ id: 'missing-field-filter', fieldId: 'deleted-field', operator: 'equals', value: 'secret' }]
    await replace('one', missing)
    assert.match(host().textContent!, /missing fields/); assert.equal(host().querySelector('.dbw-table'), null)
    assert.deepEqual(content().config.filters, missing.config.filters); assert.deepEqual(commits, [])
    const foreignSystemField = payload(); foreignSystemField.config.filters.rules = [{ id: 'foreign-system-field', fieldId: DATABASE_SYSTEM_FIELD_IDS.path, operator: 'is-empty' }]
    await replace('one', foreignSystemField)
    assert.match(host().textContent!, /missing fields/); assert.equal(host().querySelector('.dbw-table'), null, 'a catalog-only system field must not broaden custom source results')
    await replace('one', payload('missing'))
    await waitForRenderer(() => host().textContent!.includes('no longer exists'), 'missing source must not fall back to an unrelated database')
    assert.equal(host().querySelector('.dbw-table'), null)
  })
})

test('a second inline workspace bulk edit waits for a pending cell write and commits one original batch IPC', async () => {
  await withEmbeds(async ({ host, window, fill, notes, enter, writes, bulk, acknowledge, acknowledgeBulk }) => {
    await fill(notes(), 'First physical write'); await enter(notes())
    await waitForRenderer(() => writes.length === 1, 'first cell write must reach persistence')
    const checkbox = host('two').querySelector<HTMLInputElement>('.dbw-table tbody input[type="checkbox"]')!
    await act(async () => checkbox.click())
    const bulkInput = host('two').querySelector<HTMLInputElement>('.dbw-bulk-field-editor input[aria-label="Notes"]')!
    assert.ok(bulkInput); await fill(bulkInput, 'Later atomic bulk value')
    const apply = [...host('two').querySelectorAll<HTMLButtonElement>('.dbw-bulk-field-editor button')].find(button => button.textContent === 'Apply')!
    await act(async () => apply.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.equal(bulk.length, 0, 'the batch cannot bypass an earlier write to one of its cells')
    await acknowledge(0)
    await waitForRenderer(() => bulk.length === 1, 'the original batch must start once its predecessor acknowledges')
    assert.deepEqual(bulk[0].input, { updates: [{ entityId: 'record', fieldValues: { notes: 'Later atomic bulk value' } }] })
    await acknowledgeBulk(0)
    await waitForRenderer(() => notes().value === 'Later atomic bulk value' && notes('two').value === 'Later atomic bulk value', 'both hosts must follow the final atomic write')
    assert.equal(writes.length, 1); assert.equal(bulk.length, 1)
  })
})

test('an edited record drawer sends only fields changed from its captured baseline and preserves another embed acknowledged field', async () => {
  await withEmbeds(async ({ host, document, fill, enter, writes, replace, acknowledge }) => {
    const peer = payload(); peer.config.visibleFieldIds.push('other'); peer.config.fieldOrder.push('other')
    await replace('two', peer)
    await act(async () => host().querySelector<HTMLButtonElement>('.dbw-record-title')!.click())
    const drawer = () => document.querySelector<HTMLElement>('.dbw-record-drawer')!
    assert.ok(drawer())
    await fill(drawer().querySelector<HTMLInputElement>('input[aria-label="Notes"]')!, 'Drawer changed notes')
    const other = host('two').querySelector<HTMLInputElement>('input[aria-label="Other field"]')!
    await fill(other, 'Peer confirmed other field'); await enter(other)
    await waitForRenderer(() => writes.length === 1, 'the peer field must reach its independent cell IPC')
    await acknowledge(0)
    assert.equal(drawer().querySelector<HTMLInputElement>('input[aria-label="Other field"]')!.value, 'Untouched original', 'the drawer keeps its authored draft while source props refresh')
    const save = [...drawer().querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === 'Save')!
    await act(async () => save.click())
    await waitForRenderer(() => writes.length === 2, 'drawer save must commit its changed field')
    assert.equal(writes[1].kind, 'entity')
    if (writes[1].kind === 'entity') assert.deepEqual(writes[1].input, { entityId: 'record', fieldValues: { notes: 'Drawer changed notes' } })
    await acknowledge(1)
    await waitForRenderer(() => !document.querySelector('.dbw-record-drawer'), 'successful drawer save must close')
    assert.equal(host('two').querySelector<HTMLInputElement>('input[aria-label="Other field"]')!.value, 'Peer confirmed other field')
  })
})

test('late document creation acknowledgements keep the created document but never navigate a source, view or removed host', async () => {
  await withEmbeds(async ({ replace, host, creates, navigations, remove, reads }) => {
    const begin = async () => {
      await replace('one', payload('catalog'))
      await waitForRenderer(() => Boolean(host().querySelector('input[aria-label="Notes"]')), 'catalog workspace must load')
      const create = [...host().querySelectorAll<HTMLButtonElement>('.dbw-header button')].find(button => button.textContent?.includes('New document'))!
      assert.ok(create); await act(async () => create.click())
    }
    await begin(); const before = reads.length
    await replace('one', payload('other'))
    await act(async () => creates[0].resolve({ id: 'persisted-before-source-left' }))
    assert.deepEqual(navigations, []); assert.equal(reads.filter(id => id === 'catalog').length, 1)
    assert.ok(reads.length >= before)
    await begin(); await replace('one', { ...payload('catalog'), viewId: 'unavailable-view' })
    await act(async () => creates[1].resolve({ id: 'persisted-before-view-left' }))
    assert.deepEqual(navigations, [])
    await begin(); await remove('one')
    await act(async () => creates[2].resolve({ id: 'persisted-before-host-deleted' }))
    assert.deepEqual(navigations, [])
  })
})

test('document creation navigation rechecks its host lease after the atomic source refresh completes', async () => {
  await withEmbeds(async ({ replace, host, creates, navigations, holdRead }) => {
    await replace('one', payload('catalog'))
    await waitForRenderer(() => Boolean(host().querySelector('input[aria-label="Notes"]')), 'catalog workspace must load')
    const create = [...host().querySelectorAll<HTMLButtonElement>('.dbw-header button')].find(button => button.textContent?.includes('New document'))!
    await act(async () => create.click())
    const read = holdRead('catalog')
    await act(async () => creates[0].resolve({ id: 'persisted-before-refresh-finished' }))
    await waitForRenderer(read.started, 'creation ACK must start its real atomic snapshot refresh')
    await replace('one', payload('other')); await read.release()
    assert.deepEqual(navigations, [])
    await replace('one', payload('catalog'))
    await waitForRenderer(() => Boolean(host().querySelector('input[aria-label="Notes"]')), 'returning catalog workspace must load')
    const currentCreate = [...host().querySelectorAll<HTMLButtonElement>('.dbw-header button')].find(button => button.textContent?.includes('New document'))!
    await act(async () => currentCreate.click())
    const currentRead = holdRead('catalog')
    await act(async () => creates[1].resolve({ id: 'current-created-document' }))
    await waitForRenderer(currentRead.started, 'current creation must also await its atomic source refresh')
    assert.deepEqual(navigations, [])
    await currentRead.release()
    await waitForRenderer(() => navigations.length === 1, 'a current created document must still open after publication')
    assert.deepEqual(navigations, ['current-created-document'])
  })
})
