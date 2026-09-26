import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, Suspense, useState, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import { ErrorBoundary } from '../src/renderer/src/components/ErrorBoundary'
import { RecoveryState } from '../src/renderer/src/components/RecoveryState'
import { lazyWithRetry } from '../src/renderer/src/utils/lazyWithRetry'
import { useDocumentLoadingAndBlockNavigation } from '../src/renderer/src/hooks/useDocumentLoadingAndBlockNavigation'
import { useGlobalDocumentSearch } from '../src/renderer/src/hooks/useGlobalDocumentSearch'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { getUiText, setActiveUiLanguage } from '../src/renderer/src/i18n'
import type { DocumentDetail, ElectronApi, GlobalSearchResult } from '../src/shared/contracts'

async function withRenderer(api: Partial<ElectronApi>, run: (context: {
  render: (node: ReactNode) => Promise<void>; document: Document; window: Window
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  setActiveUiLanguage('en-US')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  try { await run({ render: async (node) => { await act(async () => root.render(node)) }, document: dom.window.document, window: dom.window as unknown as Window }) }
  finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('a failed lazy page can be retried without resetting draft state owned outside its boundary', async (t) => {
  t.mock.method(console, 'error', () => undefined)
  let attempts = 0
  const View = lazyWithRetry<{ draft: string }>(async () => {
    if (++attempts === 1) throw new Error('Chunk unavailable')
    return { default: ({ draft }) => <p>{draft}</p> }
  })
  let setDraft!: (text: string) => void
  function Shell() {
    const [draft, update] = useState('initial')
    setDraft = update
    return <ErrorBoundary page><Suspense fallback="Loading"><View draft={draft} /></Suspense></ErrorBoundary>
  }
  await withRenderer({}, async ({ render, document }) => {
    await render(<Shell />)
    assert.match(document.body.textContent!, /Something went wrong/)
    await act(async () => setDraft('unsaved draft retained'))
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    await act(async () => retry.click())
    assert.equal(attempts, 2)
    assert.match(document.body.textContent!, /unsaved draft retained/)
    assert.doesNotMatch(document.body.textContent!, /Something went wrong/)
  })
})

test('changing the page recovers a boundary, including errors thrown as non-Error values', async (t) => {
  t.mock.method(console, 'error', () => undefined)
  function Broken(): never { throw 'broken page' }
  await withRenderer({}, async ({ render, document }) => {
    await render(<ErrorBoundary resetKey="broken"><Broken /></ErrorBoundary>)
    assert.match(document.body.textContent!, /broken page/)
    await render(<ErrorBoundary resetKey="working"><p>Working page</p></ErrorBoundary>)
    assert.match(document.body.textContent!, /Working page/)
    assert.doesNotMatch(document.body.textContent!, /broken page/)
  })
})

test('recovery actions surface clipboard failure and honour cancellation before a safe-mode restart', async () => {
  let restarts = 0
  let copied = ''
  let failCopy = true
  await withRenderer({
    writeClipboardText: async (text) => { if (failCopy) throw new Error('clipboard busy'); copied = text },
    restartInSystemPluginSafeMode: async () => { restarts++ }
  }, async ({ render, document, window }) => {
    window.confirm = () => false
    await render(<RecoveryState title="Test recovery" error={new Error('diagnostic detail')} allowRestart />)
    const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === label)!
    await act(async () => button('Copy diagnostics').click())
    assert.match(document.body.textContent!, /clipboard busy/)
    failCopy = false
    await act(async () => button('Copy diagnostics').click())
    assert.match(copied, /diagnostic detail/)
    await act(async () => button('Restart in safe mode').click())
    assert.equal(restarts, 0)
    window.confirm = () => true
    await act(async () => button('Restart in safe mode').click())
    assert.equal(restarts, 1)
  })
})

test('document retry retains its target and late failures cannot replace a newly selected document', async () => {
  const pending = new Map<string, { resolve: (value: DocumentDetail | null) => void; reject: (error: Error) => void }>()
  await withRenderer({ getDocumentDetail: (id) => new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }, async ({ render }) => {
    let state!: ReturnType<typeof useDocumentLoadingAndBlockNavigation>
    const failure = () => state.documentLoadError
    let selected: DocumentDetail | null = null
    const setSelected = (detail: DocumentDetail | null) => { selected = detail }
    const noop = () => undefined
    function Harness({ id }: { id: string }) {
      state = useDocumentLoadingAndBlockNavigation({ selectedDocumentId: id, selectedDocument: null, setSelectedDocument: setSelected,
        setDetailLoading: noop, clearPendingTarget: noop, pendingBlockNavigationTarget: null, draftBlocks: [], onNoDocumentSelected: noop,
        onDocumentLoaded: noop, onPendingTargetResolved: noop, onPendingTargetMissing: noop })
      return null
    }
    await render(<Harness id="a" />)
    await render(<Harness id="b" />)
    await act(async () => pending.get('a')!.reject(new Error('old error')))
    assert.equal(failure(), null)
    await act(async () => pending.get('b')!.resolve(null))
    assert.equal(failure()?.missing, true)
    await act(async () => state.retryDocumentLoad())
    assert.equal(failure(), null)
    const detail = { id: 'b', title: 'Recovered document', blocks: [] } as unknown as DocumentDetail
    await act(async () => pending.get('b')!.resolve(detail))
    assert.equal(selected, detail)
    assert.equal(failure(), null)
  })
})

test('search failures are distinct from no results and late requests cannot overwrite a retried query', async (t) => {
  t.mock.method(console, 'warn', () => undefined)
  const requests: Array<{ resolve: (value: GlobalSearchResult[]) => void; reject: (error: Error) => void }> = []
  await withRenderer({ searchDocuments: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) }, async ({ render }) => {
    let search!: ReturnType<typeof useGlobalDocumentSearch>
    function Harness() { search = useGlobalDocumentSearch({ documentCatalog: [], onOpenDocument: () => undefined }); return null }
    await render(<Harness />)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await act(async () => { search.openGlobalSearch(); search.updateGlobalSearchQuery('retained query') })
      await act(async () => t.mock.timers.tick(160))
      await act(async () => requests[0].reject(new Error('search unavailable')))
      assert.equal(search.globalSearchQuery, 'retained query')
      assert.equal(search.globalSearchError, 'search unavailable')
      await act(async () => search.retryGlobalSearch())
      await act(async () => t.mock.timers.tick(160))
      await act(async () => search.updateGlobalSearchQuery('new query'))
      await act(async () => t.mock.timers.tick(160))
      await act(async () => requests[2].resolve([]))
      await act(async () => requests[1].reject(new Error('stale failure')))
      assert.equal(search.globalSearchError, null)
      assert.equal(search.globalSearchLoading, false)
      assert.equal(search.globalSearchQuery, 'new query')
    } finally { t.mock.timers.reset() }
  })
})

test('manual and automatic saves never write a retained draft to a document that has not loaded', async (t) => {
  const writes: string[] = []
  const detail = { id: 'a', title: 'Original', summary: '', blocks: [] } as unknown as DocumentDetail
  await withRenderer({ updateDocument: async (id) => { writes.push(id); throw new Error('Keep the draft unsaved') } }, async ({ render }) => {
    let editor!: ReturnType<typeof useDocumentEditorState>
    function Harness({ id }: { id: string }) {
      editor = useDocumentEditorState({ selectedDocumentId: id, selectedDocument: detail, ui: getUiText('en-US'),
        onHomeDataChange: () => undefined, onSelectedDocumentChange: () => undefined, onMessage: () => undefined })
      return null
    }
    await render(<Harness id="a" />)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await act(async () => editor.loadDocumentIntoEditor(detail))
      await act(async () => editor.setDraftTitle('Retained draft'))
      await render(<Harness id="b" />)
      await act(async () => t.mock.timers.tick(800))
      await act(async () => editor.saveDocument())
      assert.deepEqual(writes, [])
      assert.equal(editor.draftTitle, 'Retained draft')
      await render(<Harness id="a" />)
      await act(async () => editor.saveDocument())
      assert.deepEqual(writes, ['a'])
      assert.equal(editor.draftTitle, 'Retained draft')
    } finally { t.mock.timers.reset() }
  })
})
