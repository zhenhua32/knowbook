import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { useDocumentNavigationState } from '../src/renderer/src/hooks/useDocumentNavigationState'

type NavigationState = ReturnType<typeof useDocumentNavigationState>
type BeforeOpen = (documentId: string) => boolean | void | Promise<boolean | void>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function withNavigation(before: BeforeOpen, run: (context: {
  current: () => NavigationState
  pageChanges: string[]
}) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  Object.defineProperty(dom.window, 'knowbook', { value: {
    getSetting: async () => null,
    saveSetting: async () => undefined
  } })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const pageChanges: string[] = []
  let state!: NavigationState
  function Harness() {
    state = useDocumentNavigationState({
      onBeforeOpenDocument: before,
      onActivePageChange: (page) => { pageChanges.push(page) }
    })
    return null
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => {
      state.setSelectedDocumentId('document-a')
      state.setPendingBlockNavigationTarget({ documentId: 'document-a', blockId: 'block-a' })
    })
    await run({ current: () => state, pageChanges })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

for (const kind of ['document', 'block'] as const) {
  test(`cancelled ${kind} navigation after saving preserves the current document, target and page`, async () => {
    const saving = deferred<boolean>()
    const requestedDocuments: string[] = []
    await withNavigation((id) => { requestedDocuments.push(id); return saving.promise }, async ({ current, pageChanges }) => {
      let stillCurrent = true
      const originalTarget = current().pendingBlockNavigationTarget
      const opened = kind === 'document'
        ? current().openDocumentInDocumentsPage('document-b', () => stillCurrent)
        : current().openDocumentBlockInDocumentsPage('document-b', 'block-b', () => stillCurrent)
      assert.deepEqual(requestedDocuments, ['document-b'])
      assert.equal(current().selectedDocumentId, 'document-a', 'saving must finish before navigation commits')

      // The full-search page or query changed while the document save was pending.
      stillCurrent = false
      let outcome!: boolean
      await act(async () => { saving.resolve(true); outcome = await opened })
      assert.equal(outcome, false)
      assert.equal(current().selectedDocumentId, 'document-a')
      assert.deepEqual(current().pendingBlockNavigationTarget, originalTarget)
      assert.deepEqual(pageChanges, [])
    })
  })
}

test('unguarded document and block navigation still commits after a successful save', async () => {
  let saving = deferred<boolean>()
  const requestedDocuments: string[] = []
  await withNavigation((id) => { requestedDocuments.push(id); return saving.promise }, async ({ current, pageChanges }) => {
    const openDocument = current().openDocumentInDocumentsPage('document-b')
    let outcome!: boolean
    await act(async () => { saving.resolve(true); outcome = await openDocument })
    assert.equal(outcome, true)
    assert.equal(current().selectedDocumentId, 'document-b')
    assert.equal(current().pendingBlockNavigationTarget, null)

    saving = deferred<boolean>()
    const openBlock = current().openDocumentBlockInDocumentsPage('document-c', 'block-c')
    await act(async () => { saving.resolve(true); outcome = await openBlock })
    assert.equal(outcome, true)
    assert.equal(current().selectedDocumentId, 'document-c')
    assert.deepEqual(current().pendingBlockNavigationTarget, { documentId: 'document-c', blockId: 'block-c' })
    assert.deepEqual(requestedDocuments, ['document-b', 'document-c'])
    assert.deepEqual(pageChanges, ['documents', 'documents'])
  })
})

test('a blocked save stops document and block navigation even when the context remains current', async () => {
  const requestedDocuments: string[] = []
  await withNavigation(async (id) => { requestedDocuments.push(id); return false }, async ({ current, pageChanges }) => {
    const originalTarget = current().pendingBlockNavigationTarget
    let outcome!: boolean
    await act(async () => { outcome = await current().openDocumentInDocumentsPage('document-b', () => true) })
    assert.equal(outcome, false)
    await act(async () => { outcome = await current().openDocumentBlockInDocumentsPage('document-c', 'block-c', () => true) })
    assert.equal(outcome, false)
    assert.equal(current().selectedDocumentId, 'document-a')
    assert.deepEqual(current().pendingBlockNavigationTarget, originalTarget)
    assert.deepEqual(requestedDocuments, ['document-b', 'document-c'])
    assert.deepEqual(pageChanges, [])
  })
})

test('a later navigation request wins even when an earlier save completes last', async () => {
  const saves = new Map([['document-b', deferred<boolean>()], ['document-c', deferred<boolean>()]])
  await withNavigation((id) => saves.get(id)!.promise, async ({ current, pageChanges }) => {
    const older = current().openDocumentInDocumentsPage('document-b', () => true)
    const newer = current().openDocumentBlockInDocumentsPage('document-c', 'block-c', () => true)
    let newerOutcome!: boolean, olderOutcome!: boolean
    await act(async () => { saves.get('document-c')!.resolve(true); newerOutcome = await newer })
    assert.equal(newerOutcome, true)
    await act(async () => { saves.get('document-b')!.resolve(true); olderOutcome = await older })
    assert.equal(olderOutcome, false)
    assert.equal(current().selectedDocumentId, 'document-c')
    assert.deepEqual(current().pendingBlockNavigationTarget, { documentId: 'document-c', blockId: 'block-c' })
    assert.deepEqual(pageChanges, ['documents'])
  })
})

test('a cancelled same-document jump preserves the existing target without saving or changing pages', async () => {
  let saves = 0
  await withNavigation(async () => { saves++; return true }, async ({ current, pageChanges }) => {
    const originalTarget = current().pendingBlockNavigationTarget
    let outcome!: boolean
    await act(async () => { outcome = await current().openDocumentBlockInDocumentsPage('document-a', 'another-block', () => false) })
    assert.equal(outcome, false)
    await act(async () => { outcome = await current().openDocumentInDocumentsPage('document-a', () => false) })
    assert.equal(outcome, false)
    assert.equal(current().selectedDocumentId, 'document-a')
    assert.deepEqual(current().pendingBlockNavigationTarget, originalTarget)
    assert.equal(saves, 0)
    assert.deepEqual(pageChanges, [])
  })
})
