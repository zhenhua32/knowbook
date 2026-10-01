import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentDetail, UpdateDocumentInput, UpdateDocumentResult } from '../src/shared/contracts'
import { useDocumentEditorState } from '../src/renderer/src/hooks/useDocumentEditorState'
import { getUiText } from '../src/renderer/src/i18n'

type SaveRequest = {
  documentId: string
  input: UpdateDocumentInput
  resolve: (result: UpdateDocumentResult) => void
  reject: (error: Error) => void
}

function documentDetail(id = 'a', title = 'Original', updatedAt = 'revision-0'): DocumentDetail {
  return { id, title, path: title, summary: '', updatedAt, blocks: [], children: [], outgoingLinks: [], backlinks: [] }
}

async function withEditor(run: (context: {
  getEditor: () => ReturnType<typeof useDocumentEditorState>
  getDetail: () => DocumentDetail
  requests: SaveRequest[]
  messages: string[]
  acknowledge: (index: number, revision: string, requiresFullRefresh?: boolean) => void
  select: (detail: DocumentDetail | null) => void
  document: Document
  window: Window
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div><div class="document-summary-card"><input id="title"></div>')
  const requests: SaveRequest[] = [], messages: string[] = []
  Object.defineProperty(dom.window, 'knowbook', { value: {
    updateDocument: (documentId: string, input: UpdateDocumentInput) => new Promise<UpdateDocumentResult>((resolve, reject) => {
      requests.push({ documentId, input, resolve, reject })
    }),
    getHomeData: async () => { throw new Error('Workspace refresh unavailable') }
  } })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root')!)
  let editor!: ReturnType<typeof useDocumentEditorState>, detail!: DocumentDetail | null
  let select!: (next: DocumentDetail | null) => void
  const original = documentDetail()
  function Harness() {
    const [selected, setSelected] = useState<DocumentDetail | null>(original)
    detail = selected
    editor = useDocumentEditorState({ selectedDocumentId: selected?.id ?? null, selectedDocument: selected,
      ui: getUiText('en-US'), onHomeDataChange: () => {}, onSelectedDocumentChange: setSelected,
      onMessage: message => { if (message) messages.push(message) } })
    select = next => { setSelected(next); editor.loadDocumentIntoEditor(next) }
    return null
  }
  const acknowledge = (index: number, revision: string, requiresFullRefresh = false) => {
    const request = requests[index]
    const next = { ...documentDetail(request.documentId), ...request.input, updatedAt: revision,
      blocks: request.input.blocks.map((block, position) => ({ ...block, id: block.id ?? `saved-${position}`, sortOrder: position })) } as DocumentDetail
    request.resolve({ requiresFullRefresh, document: next } as UpdateDocumentResult)
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => editor.loadDocumentIntoEditor(original))
    await run({ getEditor: () => editor, getDetail: () => detail!, requests, messages, acknowledge,
      select: next => select(next), document: dom.window.document, window: dom.window as unknown as Window })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('manual saves and navigation share one pending write and acknowledge its revision', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, acknowledge }) => {
    await act(async () => getEditor().setDraftTitle('Changed'))
    let save!: Promise<void>, repeated!: Promise<void>, navigation!: Promise<boolean>
    await act(async () => { save = getEditor().saveDocument(); repeated = getEditor().saveDocument(); navigation = getEditor().flushPendingChanges() })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].input.expectedUpdatedAt, 'revision-0')
    await act(async () => { acknowledge(0, 'revision-1'); await Promise.all([save, repeated, navigation]) })
    assert.equal(await navigation, true)
    assert.equal(requests.length, 1, 'unchanged waiters must not send duplicate writes')
    assert.equal(getDetail().updatedAt, 'revision-1')
    assert.equal(getEditor().saveStatus, 'saved')
    assert.equal(getEditor().isSaving, false)
  })
})

test('an empty editor does not block navigation or first-document creation', async () => {
  await withEditor(async ({ getEditor, requests, select }) => {
    await act(async () => select(null))
    assert.equal(await getEditor().flushPendingChanges(), true)
    await act(async () => getEditor().saveDocument())
    assert.equal(requests.length, 0)
  })
})

test('autosave remains debounced and navigation waits for its existing write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async ({ getEditor, requests, acknowledge }) => {
      await act(async () => getEditor().setDraftTitle('First input'))
      await act(async () => t.mock.timers.tick(400))
      await act(async () => getEditor().setDraftTitle('Last input'))
      await act(async () => t.mock.timers.tick(799))
      assert.equal(requests.length, 0, 'typing restarts the idle save delay')
      await act(async () => t.mock.timers.tick(1))
      assert.equal(requests.length, 1)
      assert.equal(requests[0].input.title, 'Last input')
      let navigation!: Promise<boolean>
      await act(async () => { navigation = getEditor().flushPendingChanges() })
      assert.equal(requests.length, 1)
      await act(async () => { acknowledge(0, 'revision-1'); await navigation })
      assert.equal(await navigation, true)
      assert.equal(getEditor().saveStatus, 'saved')
    })
  } finally { t.mock.timers.reset() }
})

test('a queued flush saves edits made during a write using its acknowledged revision', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, acknowledge }) => {
    await act(async () => { getEditor().setDraftTitle('First'); getEditor().setDraftBlocks([{ type: 'paragraph', content: 'First body', checked: false, depth: 0 }]) })
    let save!: Promise<void>, navigation!: Promise<boolean>
    await act(async () => { save = getEditor().saveDocument() })
    await act(async () => { getEditor().setDraftTitle('Latest'); getEditor().setDraftSummary('Latest summary'); getEditor().updateDraftBlock(0, { content: 'Latest body' }) })
    await act(async () => { navigation = getEditor().flushPendingChanges() })
    await act(async () => acknowledge(0, 'revision-1'))
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input.expectedUpdatedAt, 'revision-1')
    assert.equal(requests[1].input.title, 'Latest')
    assert.equal(requests[1].input.summary, 'Latest summary')
    assert.equal(requests[1].input.blocks[0].content, 'Latest body')
    await act(async () => { acknowledge(1, 'revision-2'); await Promise.all([save, navigation]) })
    assert.equal(await navigation, true)
    assert.equal(getDetail().title, 'Latest')
    assert.equal(getDetail().updatedAt, 'revision-2')
    assert.equal(getEditor().saveStatus, 'saved')
  })
})

test('a failed pending write stops its waiters, preserves the draft, and permits an explicit retry', async () => {
  await withEditor(async ({ getEditor, requests, messages, acknowledge }) => {
    await act(async () => getEditor().setDraftSummary('Retained draft'))
    let save!: Promise<void>, navigation!: Promise<boolean>
    await act(async () => { save = getEditor().saveDocument(); navigation = getEditor().flushPendingChanges() })
    await act(async () => { requests[0].reject(new Error('Disk unavailable')); await Promise.all([save, navigation]) })
    assert.equal(await navigation, false)
    assert.equal(requests.length, 1)
    assert.equal(getEditor().draftSummary, 'Retained draft')
    assert.equal(getEditor().saveStatus, 'error')
    assert.deepEqual(messages, ['Disk unavailable'])
    let retry!: Promise<void>
    await act(async () => { retry = getEditor().saveDocument() })
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input.expectedUpdatedAt, 'revision-0')
    await act(async () => { acknowledge(1, 'revision-1'); await retry })
    assert.equal(getEditor().saveStatus, 'saved')
  })
})

test('late save acknowledgements cannot replace another document or a later visit to the same document', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, acknowledge, select }) => {
    await act(async () => getEditor().setDraftTitle('Old visit draft'))
    let save!: Promise<void>
    await act(async () => { save = getEditor().saveDocument() })
    await act(async () => select(documentDetail('b', 'Document B')))
    await act(async () => select(documentDetail('a', 'New visit', 'revision-10')))
    await act(async () => { acknowledge(0, 'revision-1'); await save })
    assert.equal(requests.length, 1)
    assert.equal(getDetail().title, 'New visit')
    assert.equal(getDetail().updatedAt, 'revision-10')
    assert.equal(getEditor().draftTitle, 'New visit')
    assert.equal(getEditor().saveStatus, 'saved')
    assert.equal(getEditor().isSaving, false)
  })
})

test('a failed workspace refresh cannot undo an acknowledged document revision', async t => {
  t.mock.method(console, 'warn', () => {})
  await withEditor(async ({ getEditor, getDetail, requests, messages, acknowledge }) => {
    await act(async () => getEditor().setDraftTitle('Renamed document'))
    let save!: Promise<void>
    await act(async () => { save = getEditor().saveDocument() })
    await act(async () => { acknowledge(0, 'revision-1', true); await save })
    assert.equal(getDetail().updatedAt, 'revision-1')
    assert.equal(getEditor().saveStatus, 'saved')
    await act(async () => getEditor().saveDocument())
    assert.equal(requests.length, 1, 'a successful write is not retried with its previous revision')
    assert.deepEqual(messages, [])
  })
})

test('saving cannot persist an unfinished metadata composition', async () => {
  await withEditor(async ({ getEditor, requests, acknowledge, document: documentNode }) => {
    const title = documentNode.getElementById('title')!
    await act(async () => title.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => getEditor().setDraftTitle('组合输入'))
    await act(async () => getEditor().saveDocument())
    assert.equal(requests.length, 0)
    await act(async () => title.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    let save!: Promise<void>
    await act(async () => { save = getEditor().saveDocument() })
    assert.equal(requests.length, 1)
    await act(async () => { acknowledge(0, 'revision-1'); await save })
    assert.equal(getEditor().saveStatus, 'saved')
  })
})
