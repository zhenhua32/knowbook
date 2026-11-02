import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { act, createElement, useLayoutEffect, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { AttachmentInput, ManagedAttachment } from '../src/shared/attachments'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { getRichTextHistoryBridge } from '../src/renderer/src/rich-text/history'
import { flushCanonicalInlinePendingChanges, hasCanonicalInlineAsyncEdits, installCanonicalInlineTransitions,
  signalCanonicalInlineUnlock } from '../src/renderer/src/features/synced-blocks/inlineBridge'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor')

const url = 'file:///fixture/attachment-close/close-note.txt'
const attachment: ManagedAttachment = { url, name: 'close-note.txt', size: 2, kind: 'file' }
const initial = (): DocumentBlockDraft[] => [{ id: 'ordinary-host', type: 'paragraph', content: 'Before attachment',
  checked: false, depth: 0, parentBlockId: null, tags: ['keep'] }]
const containsAttachment = (blocks: readonly DocumentBlockDraft[]) => blocks.some(block => block.content.includes(url))
const noop = () => {}

async function withRichImport(run: (api: {
  blocks: () => DocumentBlockDraft[]
  publications: Array<{ blocks: DocumentBlockDraft[]; locked: boolean; asyncMarker: boolean }>
  commits: Array<{ containsAttachment: boolean; locked: boolean; asyncMarker: boolean }>
  ipcInputs: AttachmentInput[][]
  reads: () => number
  checkpoints: () => number
  flushCalls: () => number
  event: (kind: 'paste' | 'drop') => Promise<boolean>
  lock: () => void
  unlock: () => Promise<void>
  resolveImport: () => Promise<void>
  render: (documentId: string) => Promise<void>
  replace: (blocks: DocumentBlockDraft[]) => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', { url: 'https://fixture.local', pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLImageElement: dom.window.HTMLImageElement, Element: dom.window.Element, Node: dom.window.Node,
    Event: dom.window.Event, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const rectangle = { top: 0, bottom: 20, left: 0, right: 120, x: 0, y: 0, width: 120, height: 20, toJSON: () => ({}) }
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle
  dom.window.Range.prototype.getClientRects = () => [rectangle] as unknown as DOMRectList
  dom.window.scrollBy = noop
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  // JSDOM lacks hit testing. Only browser geometry is supplied; the real PM
  // DOM handler, selection, transaction, binding and React callback execute.
  const row = () => dom.window.document.querySelector<HTMLElement>('[data-block-id="ordinary-host"]')
    ?? dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor [data-block-id]')!
  Object.defineProperty(dom.window.document, 'elementFromPoint', { value: () => row() })
  Object.defineProperty(dom.window.document, 'caretPositionFromPoint', { value: () => ({
    offsetNode: [...row().childNodes].find(node => node.nodeType === dom.window.Node.TEXT_NODE) ?? row(), offset: 0
  }) })
  let locked = false, nativeReads = 0, checkpointCount = 0, portFlushCalls = 0, settled = false
  let resolve!: (value: ManagedAttachment[]) => void
  const imported = new Promise<ManagedAttachment[]>(done => { resolve = done })
  const ipcInputs: AttachmentInput[][] = []
  // This is the only service replacement: the local attachment IPC result.
  // It is not a Main session, accepted Apply result, canonical ACK or SQL oracle.
  Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: {
    importAttachments: async (inputs: AttachmentInput[]) => { ipcInputs.push(inputs); return imported }
  } })
  // The ordinary-editor harness supplies only the renderer transition port.
  // Its local boolean flush has no Main/canonical RPC or successful ACK value.
  const uninstall = installCanonicalInlineTransitions({}, { locked: () => locked, pending: () => false, hostPending: () => false,
    flush: async () => { portFlushCalls++; return !locked && !hasCanonicalInlineAsyncEdits() },
    navigate: async () => !locked, notifyBlocked: noop })
  const publications: Array<{ blocks: DocumentBlockDraft[]; locked: boolean; asyncMarker: boolean }> = []
  const commits: Array<{ containsAttachment: boolean; locked: boolean; asyncMarker: boolean }> = []
  let current = initial(), replace!: (blocks: DocumentBlockDraft[]) => void
  function Harness({ documentId }: { documentId: string }) {
    const [blocks, update] = useState(current)
    current = blocks; replace = update
    useLayoutEffect(() => {
      commits.push({ containsAttachment: containsAttachment(blocks), locked, asyncMarker: hasCanonicalInlineAsyncEdits() })
    }, [blocks])
    return createElement(DocumentRichTextEditor, { documentId, blocks, visibleIndices: blocks.map((_block, index) => index), isZh: false,
      checkpoint: () => { checkpointCount++ }, onChange: next => {
        publications.push({ blocks: next, locked, asyncMarker: hasCanonicalInlineAsyncEdits() }); update(next)
      }, onUndo: noop, onRedo: noop, onEditSource: noop, onRevealBlock: noop })
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const file = new dom.window.File([new Uint8Array([107, 98])], 'close-note.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => { nativeReads++; return new Uint8Array([107, 98]).buffer } })
  const render = async (documentId: string) => {
    await act(async () => root.render(createElement(Harness, { documentId })))
    const editor = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    assert.ok(editor); assert.equal(dom.window.document.querySelectorAll('.knowbook-rich-text-editor').length, 1)
    await act(async () => getRichTextHistoryBridge(editor)!.restore({ blockId: 'ordinary-host', index: 0, start: 0, end: 0, direction: 'none',
      richText: { anchor: { blockId: 'ordinary-host', index: 0, offset: 0 }, head: { blockId: 'ordinary-host', index: 0, offset: 0 } } }))
  }
  try {
    await render('attachment-owner')
    await run({ blocks: () => current, publications, commits, ipcInputs, reads: () => nativeReads, checkpoints: () => checkpointCount,
      flushCalls: () => portFlushCalls, lock: () => { locked = true },
      unlock: async () => { await act(async () => { locked = false; signalCanonicalInlineUnlock(); await setImmediate() }) },
      resolveImport: async () => { await act(async () => { settled = true; resolve([attachment]); await setImmediate() }) },
      render, replace: async blocks => { await act(async () => replace(blocks)) },
      event: async kind => {
        const editor = dom.window.document.querySelector<HTMLElement>('.knowbook-rich-text-editor')!
        const event = kind === 'drop'
          ? new dom.window.MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 })
          : new dom.window.Event('paste', { bubbles: true, cancelable: true })
        const transfer = { files: [file], types: ['Files'], getData: () => '', clearData: noop, setData: noop,
          items: [{ kind: 'file', type: file.type, getAsFile: () => file }], dropEffect: 'copy' }
        Object.defineProperty(event, kind === 'drop' ? 'dataTransfer' : 'clipboardData', { value: transfer })
        await act(async () => { editor.dispatchEvent(event); await setImmediate() })
        return event.defaultPrevented
      } })
  } finally {
    // Complete only this fixture's pending import/unlock before removing its
    // real view, so a failed assertion cannot leak the global async marker.
    await act(async () => { if (!settled) resolve([]); locked = false; signalCanonicalInlineUnlock(); await setImmediate() })
    await act(async () => root.unmount()); uninstall(); dom.window.close()
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
  }
}

async function pendingCloseCancellation(kind: 'paste' | 'drop') {
  await withRichImport(async api => {
    assert.equal(hasCanonicalInlineAsyncEdits(), false)
    api.lock()
    await api.event(kind)
    assert.equal(api.ipcInputs.length, 0); assert.equal(api.reads(), 0, 'a locked new import must not even start reading the file')
    assert.equal(hasCanonicalInlineAsyncEdits(), false)
    await api.unlock()

    assert.equal(await api.event(kind), true)
    assert.equal(api.ipcInputs.length, 1); assert.equal(api.reads(), 1)
    assert.equal(api.ipcInputs[0][0].name, 'close-note.txt')
    assert.deepEqual([...api.ipcInputs[0][0].bytes], [107, 98])
    assert.equal(hasCanonicalInlineAsyncEdits(), true)
    assert.equal(await flushCanonicalInlinePendingChanges(), false)
    assert.equal(api.flushCalls(), 0, 'an actual pending import blocks before the local transition port is asked to flush')
    api.lock()
    await api.resolveImport()
    assert.equal(api.publications.length, 0); assert.equal(containsAttachment(api.blocks()), false)
    assert.equal(api.checkpoints(), 0, 'completion behind the close lock does not checkpoint or publish W')
    assert.equal(hasCanonicalInlineAsyncEdits(), true)
    assert.equal(await flushCanonicalInlinePendingChanges(), false)
    assert.equal(api.flushCalls(), 0)

    await api.unlock()
    assert.equal(api.publications.length, 1)
    assert.equal(api.publications[0].locked, false)
    assert.equal(api.publications[0].asyncMarker, true, 'the original real PM callback still owns its pending marker')
    assert.equal(containsAttachment(api.blocks()), true)
    const committed = api.commits.filter(value => value.containsAttachment)
    assert.ok(committed.length > 0)
    assert.ok(committed.every(value => !value.locked && value.asyncMarker), 'React commits W synchronously before finally releases the marker')
    assert.equal(hasCanonicalInlineAsyncEdits(), false)
    assert.equal(await flushCanonicalInlinePendingChanges(), true)
    assert.equal(api.flushCalls(), 1)
    const changes = api.publications.length
    api.lock(); await api.event(kind)
    assert.equal(api.ipcInputs.length, 1); assert.equal(api.reads(), 1)
    assert.equal(api.publications.length, changes); assert.equal(hasCanonicalInlineAsyncEdits(), false)
    await api.unlock()
  })
}

test('the actual rich paste attachment waits behind close cancellation and commits W before releasing its async marker', { concurrency: false }, () => pendingCloseCancellation('paste'))
test('the actual rich drop attachment waits behind close cancellation and rejects new locked imports without reading files', { concurrency: false }, () => pendingCloseCancellation('drop'))

test('a pending rich attachment completion cannot publish into a recreated document view after close cancellation', { concurrency: false }, async () => {
  await withRichImport(async api => {
    await api.event('paste'); assert.equal(api.ipcInputs.length, 1)
    api.lock(); await api.resolveImport()
    assert.equal(hasCanonicalInlineAsyncEdits(), true)
    await api.render('replacement-owner')
    await api.unlock()
    assert.equal(api.publications.length, 0); assert.equal(containsAttachment(api.blocks()), false)
    assert.equal(hasCanonicalInlineAsyncEdits(), false)
  })
})

test('a pending rich attachment completion preserves externally replaced body bytes and still finishes its original async marker', { concurrency: false }, async () => {
  await withRichImport(async api => {
    await api.event('drop'); assert.equal(api.ipcInputs.length, 1)
    api.lock(); await api.resolveImport()
    const replacement = initial().map(block => ({ ...block, content: 'External replacement must remain' }))
    await api.replace(replacement)
    await api.unlock()
    assert.equal(api.publications.length, 0); assert.deepEqual(api.blocks(), replacement)
    assert.equal(hasCanonicalInlineAsyncEdits(), false)
  })
})
