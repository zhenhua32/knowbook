import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { JSDOM } from 'jsdom'
import type { SyncedHostWorkingBefore } from '../src/shared/synced-blocks'
import { serializeSyncedBlockPayload } from '../src/shared/syncedBlockValidation'
import type { PreparedSyncedHostSource } from '../src/renderer/src/features/synced-blocks/hostSource'
import type { SyncedHostSourceCurrent, SyncedHostSourceDialogProps } from '../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { SyncedHostSourceDialog } = await import('../src/renderer/src/features/synced-blocks/SyncedHostSourceDialog')

function initialHost(): SyncedHostWorkingBefore {
  return { documentId: ' 宿主:__proto__ ', expectedPersistedUpdatedAt: '2026-10-16T00:00:00.000Z', workingBefore: {
    title: 'Unsaved title', summary: 'Unsaved summary', blocks: [
      { id: randomUUID(), type: 'synced-block', content: serializeSyncedBlockPayload({ version: 1, groupId: randomUUID() }),
        checked: false, depth: 0, parentBlockId: null },
      { id: ' 尾:constructor ', type: 'paragraph', content: 'Tail', checked: false, depth: 0, parentBlockId: null, tags: ['keep'], highlight: 'yellow' }
    ] } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
type Fixture = {
  document: Document
  window: JSDOM['window']
  props: SyncedHostSourceDialogProps
  calls: PreparedSyncedHostSource[]
  closes: () => number
  current: () => SyncedHostSourceCurrent
  setCurrent: (current: SyncedHostSourceCurrent) => void
  render: (props: SyncedHostSourceDialogProps) => Promise<void>
  view: () => EditorView
  append: (text: string) => Promise<void>
  click: (label: string) => Promise<void>
}

/** Only the asynchronous coordinator port is injected. This does not exercise
 * or fabricate Main structural transactions, SQLite persistence or host history. */
async function withHost(run: (api: Fixture) => Promise<void>, options: {
  submit?: (prepared: PreparedSyncedHostSource) => Promise<boolean>
  adopt?: boolean
  composition?: (composing: boolean) => void
} = {}) {
  const dom = new JSDOM('<button id="opener-a">Host source A</button><button id="opener-b">Host source B</button><div id="mount"></div>',
    { url: 'https://fixture.local', pretendToBeVisual: true })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
    Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, Document: dom.window.Document,
    MutationObserver: dom.window.MutationObserver, DOMRect: dom.window.DOMRect, Range: dom.window.Range,
    Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false }
  })
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let current: SyncedHostSourceCurrent = { hostSession: {}, editSequence: 7, host: initialHost() }, closed = 0
  const calls: PreparedSyncedHostSource[] = []
  const props: SyncedHostSourceDialogProps = {
    sessionKey: {}, getCurrent: () => current, isCurrent: () => true, opener: dom.window.document.getElementById('opener-a'),
    isZh: false, onCompositionChange: options.composition,
    onClose: () => { closed++; root.render(null) },
    applyPrepared: async prepared => {
      calls.push(prepared)
      const accepted = await (options.submit?.(prepared) ?? Promise.resolve(false))
      if (accepted && options.adopt !== false) {
        const after = prepared.finalAfter[0]
        current = { ...current, editSequence: current.editSequence + 1, host: { ...current.host,
          workingBefore: { title: after.title, summary: after.summary, blocks: after.blocks } } }
      }
      return accepted
    }
  }
  const render = async (next: SyncedHostSourceDialogProps) => { await act(async () => root.render(createElement(SyncedHostSourceDialog, next))) }
  const view = () => {
    const element = dom.window.document.querySelector<HTMLElement>('.cm-editor'); assert.ok(element)
    const result = EditorView.findFromDOM(element); assert.ok(result); return result
  }
  try {
    await render(props)
    await run({ document: dom.window.document, window: dom.window, props, calls, closes: () => closed,
      current: () => current, setCurrent: next => { current = next }, render, view,
      append: async text => { await act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert: text } })) },
      click: async label => {
        const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === label)
        assert.ok(button, label); await act(async () => button.click())
      } })
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('host Source submits only exact prepared fields with complete W and closes after coordinator adoption advances editSequence', async () => {
  await withHost(async api => {
    const before = structuredClone(api.current().host), sequence = api.current().editSequence
    await api.append(' edited'); await api.click('Apply changes')
    assert.equal(api.calls.length, 1); assert.equal(api.closes(), 1); assert.equal(api.document.querySelector('dialog'), null)
    const prepared = api.calls[0]
    assert.deepEqual(Object.keys(prepared).sort(), ['finalAfter', 'hostsWorkingBefore', 'newRefSources'])
    assert.deepEqual(prepared.hostsWorkingBefore, [before]); assert.deepEqual(prepared.newRefSources, [])
    assert.equal(prepared.finalAfter[0].documentId, before.documentId)
    assert.equal(prepared.finalAfter[0].title, before.workingBefore.title); assert.equal(prepared.finalAfter[0].summary, before.workingBefore.summary)
    assert.deepEqual(prepared.finalAfter[0].blocks[0], before.workingBefore.blocks[0])
    assert.deepEqual(prepared.finalAfter[0].blocks[1], { ...before.workingBefore.blocks[1], content: 'Tail edited' })
    assert.equal(api.current().editSequence, sequence + 1)
  }, { submit: async () => true })
})

test('changed title, summary, body, persisted baseline, editSequence or host lease rejects the old Apply without losing its CM draft', async () => {
  await withHost(async api => {
    const original = api.current()
    await api.append(' retained')
    const source = api.view().state.doc.toString()
    const changed = [
      { ...original, host: { ...original.host, workingBefore: { ...original.host.workingBefore, title: 'new title' } } },
      { ...original, host: { ...original.host, workingBefore: { ...original.host.workingBefore, summary: 'new summary' } } },
      { ...original, host: { ...original.host, workingBefore: { ...original.host.workingBefore,
        blocks: original.host.workingBefore.blocks.map((block, index) => index ? { ...block, content: 'new body' } : block) } } },
      { ...original, host: { ...original.host, expectedPersistedUpdatedAt: '2026-10-17T00:00:00.000Z' } },
      { ...original, editSequence: original.editSequence + 1 }
    ]
    for (const state of changed) {
      api.setCurrent(state); await api.click('Apply changes')
      assert.equal(api.calls.length, 0); assert.equal(api.closes(), 0); assert.equal(api.view().state.doc.toString(), source)
      assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('Your source is retained'))
    }
    api.setCurrent({ ...original, hostSession: {} }); await api.click('Apply changes')
    assert.equal(api.calls.length, 0); assert.equal(api.closes(), 0); assert.equal(api.view().state.doc.toString(), source)
  })
})

test('real CM protects reference payloads; full host deletion prepares no group filler and same-dialog Undo restores the references', async () => {
  await withHost(async api => {
    const before = structuredClone(api.current().host), view = api.view(), source = view.state.doc.toString(), at = source.indexOf('groupId')
    await act(async () => view.dispatch({ changes: { from: at, to: at + 1, insert: 'X' } }))
    assert.equal(view.state.doc.toString(), source); assert.equal(api.calls.length, 0)
    assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('protected'))
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }))
    await api.click('Apply changes')
    assert.equal(api.calls.length, 1); assert.deepEqual(api.calls[0].finalAfter[0].blocks, [])
    assert.deepEqual(api.calls[0].hostsWorkingBefore, [before]); assert.deepEqual(api.calls[0].newRefSources, [])
    await api.click('Undo'); await api.click('Apply changes')
    assert.equal(view.state.doc.toString(), source); assert.equal(api.calls.length, 2)
    assert.deepEqual(api.calls[1].finalAfter[0].blocks, before.workingBefore.blocks)
    assert.deepEqual(api.calls[1].newRefSources, []); assert.equal(api.closes(), 0)
  })
})

test('late coordinator receipts preserve later CM input and cannot close a newly opened host session', async () => {
  const first = deferred<boolean>()
  await withHost(async api => {
    await api.append(' submitted'); await api.click('Apply changes')
    await api.append(' later')
    await act(async () => first.resolve(true))
    assert.equal(api.calls.length, 1); assert.equal(api.closes(), 0)
    assert.ok(api.view().state.doc.toString().endsWith('Tail submitted later'))
    assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('Later input remains'))
    assert.equal(api.current().host.workingBefore.blocks[1].content, 'Tail submitted')
  }, { submit: () => first.promise })
  const second = deferred<boolean>()
  await withHost(async api => {
    await api.append(' old pending'); await api.click('Apply changes')
    const oldView = api.view(), next = { hostSession: {}, editSequence: 0, host: initialHost() }
    next.host.workingBefore.blocks[1].content = 'New host body'
    api.setCurrent(next)
    await api.render({ ...api.props, sessionKey: {}, opener: api.document.getElementById('opener-b') })
    assert.notEqual(api.view(), oldView)
    await act(async () => second.resolve(true))
    assert.equal(api.closes(), 0); assert.equal(api.calls.length, 1)
    assert.ok(api.view().state.doc.toString().endsWith('New host body'))
  }, { submit: () => second.promise, adopt: false })
})

test('same-session prop changes cannot borrow a new coordinator, opener or composition callback', async () => {
  const originalComposition: boolean[] = [], replacementComposition: boolean[] = []
  let replacementCalls = 0
  await withHost(async api => {
    await api.render({ ...api.props, opener: api.document.getElementById('opener-b'),
      applyPrepared: async () => { replacementCalls++; return false }, onCompositionChange: value => replacementComposition.push(value) })
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(originalComposition, [true, false]); assert.deepEqual(replacementComposition, [])
    await api.click('Apply changes')
    assert.equal(api.calls.length, 1); assert.equal(replacementCalls, 0)
    await api.click('Cancel')
    assert.equal(api.document.activeElement, api.document.getElementById('opener-a'))
  }, { composition: value => originalComposition.push(value) })
})

test('opening replacement during IME never fabricates an end or transfers the old lease to the new Source', async () => {
  const originalComposition: boolean[] = [], nextComposition: boolean[] = []
  await withHost(async api => {
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.deepEqual(originalComposition, [true])
    api.setCurrent({ ...api.current(), hostSession: {} })
    await api.render({ ...api.props, sessionKey: {}, onCompositionChange: value => nextComposition.push(value) })
    assert.deepEqual(originalComposition, [true])
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(nextComposition, [true, false]); assert.deepEqual(originalComposition, [true])
    assert.equal(api.calls.length, 0); assert.equal(api.closes(), 0)
  }, { composition: value => originalComposition.push(value) })
})
