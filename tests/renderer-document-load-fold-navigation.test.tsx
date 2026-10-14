import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useCallback, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentDetail } from '../src/shared/contracts'
import type { PendingBlockNavigationTarget } from '../src/renderer/src/hooks/useDocumentNavigationState'
import { useBlockCollapseState } from '../src/renderer/src/hooks/useBlockCollapseState'
import { useDocumentLoadingAndBlockNavigation } from '../src/renderer/src/hooks/useDocumentLoadingAndBlockNavigation'
import { useDocumentViewport } from '../src/renderer/src/hooks/useDocumentViewport'
import { getVisibleDocumentEntries, readDocumentFoldView, saveDocumentFoldView } from '../src/renderer/src/utils/documentSections'
import { saveDocumentPosition } from '../src/renderer/src/utils/documentReadingPosition'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const block = (id: string, type: string, content: string): DocumentBlockDraft => ({ id, type, content, checked: false, depth: 0, parentBlockId: null })
function detail(id: string, blocks: DocumentBlockDraft[]): DocumentDetail {
  return { id, title: id === 'target' ? 'Target document' : 'Source document', path: id, summary: '', updatedAt: '2026-01-01T00:00:00.000Z',
    blocks: blocks.map((value, sortOrder) => ({ ...value, id: value.id!, parentBlockId: value.parentBlockId ?? null, sortOrder })),
    children: [], outgoingLinks: [], backlinks: [] }
}
const source = detail('source', [block('source-body', 'paragraph', 'Source')])
const target = detail('target', [block('target-a', 'heading-1', 'First chapter'), block('target-a-body', 'paragraph', 'First body'),
  block('target-a1', 'heading-2', 'First section'), block('target-a1-body', 'paragraph', 'Target body'),
  block('target-b', 'heading-1', 'Second chapter'), block('target-b-body', 'paragraph', 'Old reading body')])

type View = ReturnType<typeof useBlockCollapseState>
type Navigation = { documentId: string; index: number; sequence: number; headingIndex?: number }
async function fixture(run: (context: {
  begin: (pending: PendingBlockNavigationTarget) => Promise<void>
  acknowledgeDetail: () => Promise<void>
  releaseReady: () => Promise<void>
  flushFrames: () => Promise<void>
  current: () => { loading: boolean; pending: PendingBlockNavigationTarget | null; view: View; detail: DocumentDetail | null }
  resolved: Array<{ index: number; blockId: string; headingIndex?: number }>
  missing: string[]
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>(), frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const raf = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  class Observer { observe() {} unobserve() {} disconnect() {} }
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLDetailsElement: dom.window.HTMLDetailsElement, ResizeObserver: Observer, requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) => { frames.delete(id) }, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const pendingDetail = deferred<DocumentDetail>()
  Object.defineProperty(dom.window, 'knowbook', { value: { getDocumentDetail: (id: string) => id === 'target' ? pendingDetail.promise : Promise.resolve(source) } })
  saveDocumentFoldView('target', { collapsedIds: new Set(['target-a']), focusedHeadingId: 'target-b' })
  saveDocumentPosition('target', { blockId: 'target-b-body', offset: 0, scrollTop: 180, updatedAt: Date.now() })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const resolved: Array<{ index: number; blockId: string; headingIndex?: number }> = [], missing: string[] = []
  let snapshot!: ReturnType<Parameters<typeof run>[0]['current']>
  let start!: (pending: PendingBlockNavigationTarget) => void, ready!: () => void
  let holdTargetReady = false
  function Viewport({ documentId, view, blocks, navigation }: { documentId: string | null; view: View; blocks: DocumentBlockDraft[]; navigation: Navigation | null }) {
    const viewport = useDocumentViewport({ documentId, reading: true, navigation, onRevealBlock: view.revealBlockAncestors })
    return createElement('main', { ref: viewport.scrollRef }, createElement('div', { ref: viewport.headerRef }),
      createElement('div', { ref: viewport.contentRef }, getVisibleDocumentEntries(blocks, view.foldView).map(({ block: value, index }) =>
        createElement('div', { key: value.id, 'data-block-id': value.id, 'data-block-index': index }, value.content))))
  }
  function Harness() {
    const [documentId, setDocumentId] = useState('source'), [selected, setSelected] = useState<DocumentDetail | null>(source)
    const [blocks, setBlocks] = useState<DocumentBlockDraft[]>(source.blocks), [loading, setLoading] = useState(false)
    const [pending, setPending] = useState<PendingBlockNavigationTarget | null>(null), [navigation, setNavigation] = useState<Navigation | null>(null)
    const view = useBlockCollapseState({ draftBlocks: blocks, documentId: !loading && selected?.id === documentId ? documentId : null })
    // Model a ready acknowledgement held by the host while its matching detail
    // and body are already hydrated. Preferences must be enabled before reveal.
    const setDetailLoading = useCallback((value: boolean) => { if (value || !holdTargetReady) setLoading(value) }, [])
    const clearPending = useCallback(() => setPending(null), [])
    const onLoaded = useCallback((value: DocumentDetail) => setBlocks(value.blocks), [])
    useDocumentLoadingAndBlockNavigation({ selectedDocumentId: documentId, selectedDocument: selected, detailLoading: loading,
      setSelectedDocument: setSelected, setDetailLoading, clearPendingTarget: clearPending, pendingBlockNavigationTarget: pending,
      draftBlocks: blocks, draftTitle: selected?.title, onNoDocumentSelected: () => {}, onDocumentLoaded: onLoaded,
      onPendingTargetMissing: () => missing.push(documentId), onPendingTargetResolved: (index, blockId, headingIndex) => {
        resolved.push({ index, blockId, headingIndex })
        view.revealBlockAncestors(blockId)
        setNavigation(previous => ({ index, documentId, sequence: (previous?.sequence ?? 0) + 1, headingIndex }))
      } })
    snapshot = { loading, pending, view, detail: selected }
    start = value => { holdTargetReady = true; setPending(value); setDocumentId('target') }
    ready = () => { holdTargetReady = false; setLoading(false) }
    return createElement(Viewport, { documentId: !loading && selected?.id === documentId ? documentId : null, view, blocks, navigation })
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ begin: async pending => { await act(async () => start(pending)) },
      acknowledgeDetail: async () => { await act(async () => pendingDetail.resolve(target)) },
      releaseReady: async () => { await act(async () => ready()) },
      flushFrames: async () => { await act(async () => {
        for (let cycle = 0; frames.size && cycle < 10; cycle++) {
          const current = [...frames.values()]; frames.clear()
          for (const callback of current) callback(cycle)
        }
        assert.equal(frames.size, 0, 'all controlled layout and navigation frames settle')
      }) }, current: () => snapshot, resolved, missing })
  } finally {
    await act(async () => root.unmount())
    frames.clear()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

for (const kind of ['block', 'heading'] as const) test('cross-document ' + kind + ' navigation waits for fold readiness and wins over an old second-chapter reading position', () => fixture(async context => {
  const pending: PendingBlockNavigationTarget = kind === 'block' ? { documentId: 'target', blockId: 'target-a1-body' }
    : { documentId: 'target', anchor: 'first-section' }
  await context.begin(pending)
  assert.equal(context.current().loading, true)
  await context.acknowledgeDetail()
  assert.equal(context.current().detail?.id, 'target')
  assert.equal(context.current().loading, true)
  assert.deepEqual(context.current().pending, pending, 'a matching detail must not consume navigation before fold preferences can be restored')
  assert.deepEqual(context.resolved, [])
  assert.deepEqual(context.missing, [])
  assert.equal(readDocumentFoldView('target').focusedHeadingId, 'target-b')
  await context.releaseReady()
  await context.flushFrames()
  assert.equal(context.current().pending, null)
  assert.equal(context.resolved.length, 1)
  assert.equal(context.current().view.focusedHeadingId, 'target-a1')
  assert.ok(!context.current().view.collapsedBlockIds.has('target-a'))
  assert.equal(readDocumentFoldView('target').focusedHeadingId, 'target-a1')
  assert.deepEqual([...document.querySelectorAll('[data-block-id]')].map(element => element.getAttribute('data-block-id')), ['target-a1', 'target-a1-body'])
  assert.deepEqual(context.missing, [])
}))