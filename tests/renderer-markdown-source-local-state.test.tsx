import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { JSDOM } from 'jsdom'
import type { ManagedAttachment } from '../src/shared/attachments'
import type { MarkdownSourceLocalState } from '../src/renderer/src/components/DocumentMarkdownSourceDialog'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { MarkdownSourceDialog } = await import('../src/renderer/src/components/DocumentMarkdownSourceDialog')
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

async function withDialog(run: (f: {
  document: Document; window: JSDOM['window']; states: Readonly<MarkdownSourceLocalState>[]; closed: () => number
  view: () => EditorView; edit: (source: string) => Promise<void>; click: (label: string) => Promise<void>
  setApply: (callback: () => boolean | Promise<boolean>) => void; setCurrent: (value: boolean) => void
  setImport: (callback: () => Promise<ManagedAttachment[]>) => void
}) => Promise<void>) {
  const dom = new JSDOM('<button id="opener">Source</button><div id="mount"></div>', { url: 'https://fixture.local', pretendToBeVisual: true })
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
  Object.assign(dom.window.HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false } })
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })
  let current = true, closed = 0, apply: () => boolean | Promise<boolean> = () => false
  let importer: () => Promise<ManagedAttachment[]> = async () => []
  Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: { importAttachments: () => importer() } })
  const states: Readonly<MarkdownSourceLocalState>[] = []
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const view = () => {
    const element = dom.window.document.querySelector<HTMLElement>('.cm-editor'); assert.ok(element)
    const result = EditorView.findFromDOM(element); assert.ok(result); return result
  }
  await act(async () => root.render(createElement(MarkdownSourceDialog<{ source: string }>, {
    sessionKey: {}, createDraft: () => ({ source: 'opening' }),
    replaceChanges: (draft, changes) => {
      let source = draft.source
      for (const change of [...changes].sort((a, b) => b.from - a.from)) source = source.slice(0, change.from) + change.insert + source.slice(change.to)
      return { source }
    }, onApply: () => apply(), isCurrent: () => current, getReturnFocus: () => dom.window.document.getElementById('opener'),
    onLocalStateChange: state => { states.push(state) }, isZh: false,
    onClose: () => { closed++; root.render(null) }
  })))
  try {
    await run({ document: dom.window.document, window: dom.window, states, closed: () => closed, view,
      edit: async source => { await act(async () => {
        view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: source } })
        assert.equal(states.at(-1)?.dirty, source !== 'opening', 'Accepted raw CM change reports synchronously, before React commits')
      }) },
      click: async label => { const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === label)
        assert.ok(button, label); await act(async () => button.click()) },
      setApply: callback => { apply = callback }, setCurrent: value => { current = value }, setImport: callback => { importer = callback }
    })
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

test('real Source CM reports unapplied text IME and pending Apply synchronously and keeps later input dirty against the accepted submission', { concurrency: false }, () => withDialog(async f => {
  assert.deepEqual(f.states.at(-1), { dirty: false, composing: false, applying: false, importing: false })
  await f.edit('submitted source')
  await f.click('Undo'); assert.equal(f.states.at(-1)?.dirty, false)
  await f.click('Redo'); assert.equal(f.states.at(-1)?.dirty, true)
  await act(async () => f.view().contentDOM.dispatchEvent(new f.window.CompositionEvent('compositionstart', { bubbles: true })))
  assert.equal(f.states.at(-1)?.composing, true); await f.click('Cancel'); assert.equal(f.closed(), 0)
  await act(async () => f.view().contentDOM.dispatchEvent(new f.window.CompositionEvent('compositionend', { bubbles: true })))
  assert.equal(f.states.at(-1)?.composing, false)
  const gate = deferred<boolean>(); f.setApply(() => gate.promise)
  await f.click('Apply changes'); assert.equal(f.states.at(-1)?.applying, true)
  await f.edit('later source')
  await act(async () => { gate.resolve(true); await Promise.resolve() })
  assert.equal(f.closed(), 0); assert.equal(f.view().state.doc.toString(), 'later source')
  assert.deepEqual(f.states.at(-1), { dirty: true, composing: false, applying: false, importing: false })
  // The accepted submission is the new local clean base, even while the
  // source opening remains mounted because there was later input.
  await act(async () => f.view().dispatch({ changes: { from: 0, to: f.view().state.doc.length, insert: 'submitted source' } }))
  assert.equal(f.states.at(-1)?.dirty, false)
  await f.click('Cancel'); assert.equal(f.closed(), 1)
}))

test('failed Apply and stale attachment completion clear real busy state while retaining local text and permit only explicit Cancel of a stale opening', { concurrency: false }, () => withDialog(async f => {
  await f.edit('retained text')
  f.setApply(async () => { throw new Error('actual rejected submission') })
  await f.click('Apply changes')
  assert.deepEqual(f.states.at(-1), { dirty: true, composing: false, applying: false, importing: false })
  assert.match(f.document.querySelector('[role="alert"]')?.textContent ?? '', /actual rejected submission/)
  const gate = deferred<ManagedAttachment[]>(); f.setImport(() => gate.promise)
  const input = f.document.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input)
  const file = { name: 'fixture.txt', size: 1, arrayBuffer: async () => new Uint8Array([65]).buffer } as File
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => input.dispatchEvent(new f.window.Event('change', { bubbles: true })))
  assert.equal(f.states.at(-1)?.importing, true)
  f.setCurrent(false)
  await act(async () => { gate.resolve([{ url: 'file:///managed/fixture.txt', name: 'fixture.txt', size: 1, kind: 'file' }]); await Promise.resolve() })
  assert.deepEqual(f.states.at(-1), { dirty: true, composing: false, applying: false, importing: false })
  assert.equal(f.view().state.doc.toString(), 'retained text'); assert.equal(f.closed(), 0)
  await f.click('Cancel'); assert.equal(f.closed(), 1)
}))
