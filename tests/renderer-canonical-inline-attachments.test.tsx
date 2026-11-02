import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import React, { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentsDomainState } from '../src/renderer/src/types/appDomains'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import type { ManagedAttachment } from '../src/shared/attachments'
import { hasCanonicalInlineAsyncEdits, flushCanonicalInlinePendingChanges, installCanonicalInlineTransitions,
  signalCanonicalInlineUnlock } from '../src/renderer/src/features/synced-blocks/inlineBridge'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { useDocumentAttachments } = await import('../src/renderer/src/hooks/useDocumentAttachments')

test('the actual host attachment capture leaves canonical islands alone and a real pending host insertion waits for close cancellation before publishing W',
  { concurrency: false }, async () => {
    const dom = new JSDOM('<div id="mount"></div>', { url: 'https://fixture.local', pretendToBeVisual: true })
    const previous = new Map<string, PropertyDescriptor | undefined>()
    for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLImageElement: dom.window.HTMLImageElement,
      Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, value })
    }
    let locked = false, calls = 0, published = 0
    let resolve!: (value: ManagedAttachment[]) => void
    const nativeImport = new Promise<ManagedAttachment[]>(done => { resolve = done })
    Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: {
      importAttachments: async () => { calls++; return nativeImport }
    } })
    const uninstall = installCanonicalInlineTransitions({}, { locked: () => locked, pending: () => false, hostPending: () => false,
      flush: async () => true, navigate: async () => true, notifyBlocked: () => undefined })
    const blocks: DocumentBlockDraft[] = [{ id: 'host-row', type: 'paragraph', content: 'ordinary', checked: false, depth: 0, parentBlockId: null }]
    // Only the ordinary hook's local view boundary is injected. Main/IPC/SQL
    // acceptance is covered in renderer-canonical-inline-main, not fabricated here.
    const documents = { selectedDocumentId: 'host', detailLoading: false, draftBlocks: blocks,
      getDraftBlocks: () => blocks, checkpointDraft: () => undefined, clearBlockSelection: () => undefined,
      setIsReadingMode: () => undefined, setDraftBlocks: (next: DocumentBlockDraft[]) => {
        assert.equal(locked, false, 'a completed importer may not publish new W behind the close lock')
        published++; assert.ok(next.some(block => block.content.includes('file:///actual-contract/image.png')))
      }
    } as unknown as DocumentsDomainState
    function Surface() {
      const attachments = useDocumentAttachments(documents, false)
      return <div {...attachments.surfaceProps}><div className="preview-panel">
        <div data-editor-island="synced-group"><div id="canonical" data-block-index="0">canonical</div></div>
        <div id="ordinary" data-block-index="0">ordinary</div>
      </div>{attachments.dialog}</div>
    }
    const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
    const file = new dom.window.File(['x'], 'image.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([120]).buffer })
    const drop = (id: string) => {
      const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file], dropEffect: 'copy' } })
      dom.window.document.getElementById(id)!.dispatchEvent(event)
    }
    try {
      await act(async () => root.render(createElement(Surface)))
      await act(async () => { drop('canonical'); await setImmediate() })
      assert.equal(calls, 0); assert.equal(published, 0); assert.equal(hasCanonicalInlineAsyncEdits(), false)
      await act(async () => { drop('ordinary'); await setImmediate() })
      assert.equal(calls, 1); assert.equal(hasCanonicalInlineAsyncEdits(), true)
      locked = true
      assert.equal(await flushCanonicalInlinePendingChanges(), false)
      await act(async () => { resolve([{ url: 'file:///actual-contract/image.png', name: 'image.png', size: 1, kind: 'image' }]); await setImmediate() })
      assert.equal(published, 0); assert.equal(hasCanonicalInlineAsyncEdits(), true)
      await act(async () => { locked = false; signalCanonicalInlineUnlock(); await setImmediate() })
      assert.equal(published, 1); assert.equal(hasCanonicalInlineAsyncEdits(), false)
      assert.equal(await flushCanonicalInlinePendingChanges(), true)
    } finally {
      locked = false; signalCanonicalInlineUnlock(); await act(async () => root.unmount()); uninstall(); dom.window.close()
      for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
    }
  })
