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
  acknowledge: (index: number, revision: string, requiresFullRefresh?: boolean, canonicalTitle?: string) => void
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
  const acknowledge = (index: number, revision: string, requiresFullRefresh = false, canonicalTitle?: string) => {
    const request = requests[index]
    const next = { ...documentDetail(request.documentId), ...request.input, updatedAt: revision,
      blocks: request.input.blocks.map((block, position) => ({ ...block, id: block.id ?? `saved-${position}`, sortOrder: position })) } as DocumentDetail
    if (canonicalTitle !== undefined) { next.title = canonicalTitle; next.path = canonicalTitle }
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

type RenameResult = Awaited<ReturnType<ReturnType<typeof useDocumentEditorState>['renameTitle']>>

test('renaming writes its candidate while leaving the shared title unchanged until canonical acknowledgement', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, acknowledge }) => {
    const target = getEditor().getRenameTarget()!
    assert.equal(target.documentId, 'a')
    assert.equal(target.title, 'Original')
    let rename!: Promise<RenameResult>
    await act(async () => { rename = getEditor().renameTitle(target, 'Renamed') })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].input.title, 'Renamed')
    assert.equal(requests[0].input.expectedUpdatedAt, 'revision-0')
    assert.equal(getEditor().draftTitle, 'Original', 'the pending name belongs to the rename form')
    assert.equal(getDetail().title, 'Original')
    await act(async () => { acknowledge(0, 'revision-1', false, 'Renamed 1'); await rename })
    assert.deepEqual(await rename, { status: 'saved', title: 'Renamed 1' })
    assert.equal(getEditor().draftTitle, 'Renamed 1')
    assert.equal(getDetail().title, 'Renamed 1')
    assert.equal(getEditor().getRenameTarget()!.session, target.session, 'a save acknowledgement is still the same editing session')
    assert.equal(getEditor().saveStatus, 'saved')
  })
})

test('confirming the unchanged name does not save a body draft or cancel its existing autosave delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async ({ getEditor, requests, acknowledge }) => {
      await act(async () => getEditor().setDraftSummary('A body-related draft still waiting for autosave'))
      await act(async () => t.mock.timers.tick(400))
      const target = getEditor().getRenameTarget()!
      let result!: RenameResult
      await act(async () => { result = await getEditor().renameTitle(target, ' Original ') })
      assert.deepEqual(result, { status: 'saved', title: 'Original' })
      assert.equal(requests.length, 0, 'a name no-op does not flush unrelated edits')
      await act(async () => t.mock.timers.tick(399))
      assert.equal(requests.length, 0)
      await act(async () => t.mock.timers.tick(1))
      assert.equal(requests.length, 1, 'the body keeps its original debounce deadline')
      assert.equal(requests[0].input.title, 'Original')
      assert.equal(requests[0].input.summary, 'A body-related draft still waiting for autosave')
      await act(async () => acknowledge(0, 'revision-1'))
    })
  } finally { t.mock.timers.reset() }
})

test('duplicate rename confirmations share one write and another pending candidate cannot replace it', async () => {
  await withEditor(async ({ getEditor, requests, acknowledge }) => {
    const target = getEditor().getRenameTarget()!
    let first!: Promise<RenameResult>, repeated!: Promise<RenameResult>, different!: Promise<RenameResult>
    await act(async () => {
      first = getEditor().renameTitle(target, 'Candidate')
      repeated = getEditor().renameTitle(target, 'Candidate')
      different = getEditor().renameTitle(target, 'Different')
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].input.title, 'Candidate')
    assert.deepEqual(await different, { status: 'busy' })
    assert.equal(getEditor().draftTitle, 'Original')
    await act(async () => { acknowledge(0, 'revision-1'); await Promise.all([first, repeated]) })
    assert.deepEqual(await first, { status: 'saved', title: 'Candidate' })
    assert.deepEqual(await repeated, await first)
    assert.equal(requests.length, 1)
  })
})

test('a rename waiting for a regular save uses its canonical name and latest acknowledged revision', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, acknowledge }) => {
    await act(async () => getEditor().setDraftTitle('Old draft name'))
    const target = getEditor().getRenameTarget()!
    let save!: Promise<void>, rename!: Promise<RenameResult>
    await act(async () => { save = getEditor().saveDocument(); rename = getEditor().renameTitle(target, 'New name') })
    assert.equal(requests.length, 1)
    assert.equal(getEditor().draftTitle, 'Old draft name')
    await act(async () => { acknowledge(0, 'revision-1', false, 'Old draft name 1'); await save })
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input.title, 'New name')
    assert.equal(requests[1].input.expectedUpdatedAt, 'revision-1')
    assert.equal(getEditor().draftTitle, 'Old draft name 1', 'the earlier canonical acknowledgement is not hidden by the candidate')
    assert.equal(getEditor().getRenameTarget()!.session, target.session)
    await act(async () => { acknowledge(1, 'revision-2', false, 'New name 1'); await rename })
    assert.deepEqual(await rename, { status: 'saved', title: 'New name 1' })
    assert.equal(getDetail().updatedAt, 'revision-2')
  })
})

test('save and navigation queued behind a rename preserve newer body edits and its canonical title', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, acknowledge }) => {
    const target = getEditor().getRenameTarget()!
    let rename!: Promise<RenameResult>, save!: Promise<void>, navigation!: Promise<boolean>
    await act(async () => { rename = getEditor().renameTitle(target, 'New name') })
    await act(async () => {
      getEditor().setDraftBlocks([{ type: 'paragraph', content: 'New body while renaming', checked: false, depth: 0 }])
      getEditor().setDraftSummary('New summary while renaming')
    })
    await act(async () => { save = getEditor().saveDocument(); navigation = getEditor().flushPendingChanges() })
    assert.equal(requests.length, 1)
    await act(async () => { acknowledge(0, 'revision-1', false, 'New name 1'); await rename })
    assert.deepEqual(await rename, { status: 'saved', title: 'New name 1' })
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input.expectedUpdatedAt, 'revision-1')
    assert.equal(requests[1].input.title, 'New name 1', 'a later body save cannot replay the title from before renaming')
    assert.equal(requests[1].input.summary, 'New summary while renaming')
    assert.equal(requests[1].input.blocks[0].content, 'New body while renaming')
    assert.equal(getEditor().draftSummary, 'New summary while renaming')
    assert.equal(getEditor().draftBlocks[0].content, 'New body while renaming')
    await act(async () => { acknowledge(1, 'revision-2'); await Promise.all([save, navigation]) })
    assert.equal(await navigation, true)
    assert.equal(getDetail().title, 'New name 1')
    assert.equal(getEditor().saveStatus, 'saved')
    assert.equal(requests.length, 2)
  })
})

test('abandoning a failed rename retains the original title and body without automatically retrying the failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async ({ getEditor, requests, messages, acknowledge }) => {
      await act(async () => {
        getEditor().setDraftSummary('Keep this summary')
        getEditor().setDraftBlocks([{ type: 'paragraph', content: 'Keep this body', checked: false, depth: 0 }])
      })
      const blocks = getEditor().draftBlocks
      const target = getEditor().getRenameTarget()!
      let rename!: Promise<RenameResult>
      await act(async () => { rename = getEditor().renameTitle(target, 'Name to abandon') })
      await act(async () => { requests[0].reject(new Error('Disk unavailable')); await rename })
      assert.deepEqual(await rename, { status: 'failed', message: 'Disk unavailable' })
      assert.equal(getEditor().draftTitle, 'Original')
      assert.equal(getEditor().draftSummary, 'Keep this summary')
      assert.equal(getEditor().draftBlocks, blocks, 'a failed rename does not replace the body snapshot')
      assert.equal(getEditor().saveStatus, 'error')
      assert.deepEqual(messages, ['Disk unavailable'])
      await act(async () => t.mock.timers.tick(1600))
      assert.equal(requests.length, 1, 'closing the local form must not restart the failed body autosave')
      let save!: Promise<void>
      await act(async () => { save = getEditor().saveDocument() })
      assert.equal(requests[1].input.title, 'Original', 'retrying the body later cannot apply an abandoned name')
      assert.equal(requests[1].input.summary, 'Keep this summary')
      assert.equal(requests[1].input.blocks[0].content, 'Keep this body')
      await act(async () => { acknowledge(1, 'revision-1'); await save })
    })
  } finally { t.mock.timers.reset() }
})

test('a clean document keeps its original title on rename failure and can retry the local candidate explicitly', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, acknowledge }) => {
    const target = getEditor().getRenameTarget()!
    let rename!: Promise<RenameResult>
    await act(async () => { rename = getEditor().renameTitle(target, 'Retry this name') })
    await act(async () => { requests[0].reject(new Error('Disk unavailable')); await rename })
    assert.equal((await rename).status, 'failed')
    assert.equal(getEditor().draftTitle, 'Original')
    assert.equal(getDetail().updatedAt, 'revision-0')
    assert.equal(getEditor().hasPendingDraftChanges, false, 'the failed candidate is kept by the form, not smuggled into the editor draft')
    assert.equal(getEditor().saveStatus, 'saved')
    await act(async () => { rename = getEditor().renameTitle(target, 'Retry this name') })
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input.expectedUpdatedAt, 'revision-0')
    assert.equal(requests[1].input.title, 'Retry this name')
    await act(async () => { acknowledge(1, 'revision-1'); await rename })
    assert.deepEqual(await rename, { status: 'saved', title: 'Retry this name' })
  })
})

test('a failed older writer stops a waiting rename without replacing its draft', async () => {
  await withEditor(async ({ getEditor, requests }) => {
    await act(async () => getEditor().setDraftSummary('Failed earlier summary'))
    const target = getEditor().getRenameTarget()!
    let save!: Promise<void>, rename!: Promise<RenameResult>
    await act(async () => { save = getEditor().saveDocument(); rename = getEditor().renameTitle(target, 'Waiting name') })
    await act(async () => { requests[0].reject(new Error('Earlier save failed')); await Promise.all([save, rename]) })
    assert.equal((await rename).status, 'failed')
    assert.equal(requests.length, 1)
    assert.equal(getEditor().draftTitle, 'Original')
    assert.equal(getEditor().draftSummary, 'Failed earlier summary')
    assert.equal(getEditor().saveStatus, 'error')
  })
})

test('rename acknowledgement does not overwrite a newer title draft', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, acknowledge }) => {
    const target = getEditor().getRenameTarget()!
    let rename!: Promise<RenameResult>
    await act(async () => { rename = getEditor().renameTitle(target, 'Committed rename') })
    await act(async () => getEditor().setDraftTitle('Newer deliberate title edit'))
    await act(async () => { acknowledge(0, 'revision-1', false, 'Committed rename 1'); await rename })
    assert.deepEqual(await rename, { status: 'saved', title: 'Committed rename 1' })
    assert.equal(getDetail().title, 'Committed rename 1')
    assert.equal(getEditor().draftTitle, 'Newer deliberate title edit')
    let save!: Promise<void>
    await act(async () => { save = getEditor().saveDocument() })
    assert.equal(requests[1].input.expectedUpdatedAt, 'revision-1')
    assert.equal(requests[1].input.title, 'Newer deliberate title edit')
    await act(async () => { acknowledge(1, 'revision-2'); await save })
  })
})

test('choosing the already persisted name removes an unsaved name draft without an unnecessary write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withEditor(async ({ getEditor, getDetail, requests }) => {
      await act(async () => getEditor().setDraftTitle('Unsaved name to discard'))
      const target = getEditor().getRenameTarget()!
      let result!: RenameResult
      await act(async () => { result = await getEditor().renameTitle(target, 'Original') })
      assert.deepEqual(result, { status: 'saved', title: 'Original' })
      assert.equal(getEditor().draftTitle, 'Original')
      assert.equal(getDetail().title, 'Original')
      assert.equal(getEditor().saveStatus, 'saved')
      await act(async () => t.mock.timers.tick(1000))
      assert.equal(requests.length, 0, 'the discarded title cannot be autosaved later')
    })
  } finally { t.mock.timers.reset() }
})

test('a rename target expires on a new editing session even when the document ID is unchanged', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, select }) => {
    const oldTarget = getEditor().getRenameTarget()!
    await act(async () => select(documentDetail('a', 'Fresh same-document session', 'revision-10')))
    assert.notEqual(getEditor().getRenameTarget()!.session, oldTarget.session)
    let result!: RenameResult
    await act(async () => { result = await getEditor().renameTitle(oldTarget, 'Stale name') })
    assert.deepEqual(result, { status: 'stale' })
    assert.equal(requests.length, 0)
    assert.equal(getEditor().draftTitle, 'Fresh same-document session')
    assert.equal(getDetail().updatedAt, 'revision-10')
    await act(async () => select(null))
    assert.equal(getEditor().getRenameTarget(), null)
    assert.deepEqual(await getEditor().renameTitle(oldTarget, 'Another stale name'), { status: 'stale' })
  })
})

test('late rename completion cannot overwrite an ABA document visit or clear its newer rename lock', async () => {
  await withEditor(async ({ getEditor, getDetail, requests, select, acknowledge }) => {
    const oldTarget = getEditor().getRenameTarget()!
    let oldRename!: Promise<RenameResult>, newRename!: Promise<RenameResult>
    await act(async () => { oldRename = getEditor().renameTitle(oldTarget, 'Old visit rename') })
    await act(async () => select(documentDetail('b', 'Document B')))
    await act(async () => select(documentDetail('a', 'New A visit', 'revision-10')))
    const newTarget = getEditor().getRenameTarget()!
    await act(async () => { newRename = getEditor().renameTitle(newTarget, 'New visit rename') })
    assert.equal(requests.length, 1, 'the newer session still waits for the actual older writer')
    await act(async () => { acknowledge(0, 'revision-1'); await oldRename })
    assert.deepEqual(await oldRename, { status: 'stale' })
    assert.equal(getDetail().title, 'New A visit')
    assert.equal(getEditor().draftTitle, 'New A visit')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input.expectedUpdatedAt, 'revision-10')
    assert.equal(requests[1].input.title, 'New visit rename')
    assert.deepEqual(await getEditor().renameTitle(newTarget, 'Competing new visit rename'), { status: 'busy' })
    await act(async () => { acknowledge(1, 'revision-11'); await newRename })
    assert.deepEqual(await newRename, { status: 'saved', title: 'New visit rename' })
    assert.equal(getEditor().draftTitle, 'New visit rename')
  })
})

test('a malformed rename acknowledgement cannot clear the current document or claim success', async () => {
  for (const returnedDocument of [null, documentDetail('wrong-document', 'Wrong name', 'wrong-revision')]) {
    await withEditor(async ({ getEditor, getDetail, requests }) => {
      const target = getEditor().getRenameTarget()!
      let rename!: Promise<RenameResult>
      await act(async () => { rename = getEditor().renameTitle(target, 'Candidate') })
      await act(async () => {
        requests[0].resolve({ requiresFullRefresh: true, document: returnedDocument } as unknown as UpdateDocumentResult)
        await rename
      })
      assert.equal((await rename).status, 'failed')
      assert.equal(getDetail().id, 'a')
      assert.equal(getDetail().title, 'Original')
      assert.equal(getDetail().updatedAt, 'revision-0')
      assert.equal(getEditor().draftTitle, 'Original')
    })
  }
})

test('a workspace refresh failure after rename keeps its acknowledged name and does not resend the previous revision', async t => {
  t.mock.method(console, 'warn', () => {})
  await withEditor(async ({ getEditor, getDetail, requests, messages, acknowledge }) => {
    const target = getEditor().getRenameTarget()!
    let rename!: Promise<RenameResult>
    await act(async () => { rename = getEditor().renameTitle(target, 'Committed name') })
    await act(async () => { acknowledge(0, 'revision-1', true, 'Committed name 1'); await rename })
    assert.deepEqual(await rename, { status: 'saved', title: 'Committed name 1' })
    assert.equal(getDetail().updatedAt, 'revision-1')
    assert.equal(getEditor().saveStatus, 'saved')
    await act(async () => getEditor().saveDocument())
    assert.equal(requests.length, 1)
    assert.deepEqual(messages, [])
  })
})

test('rename confirmation cannot persist unfinished metadata composition or leave a stale operation lock', async () => {
  await withEditor(async ({ getEditor, requests, acknowledge, document: documentNode }) => {
    const target = getEditor().getRenameTarget()!
    const input = documentNode.getElementById('title')!
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.deepEqual(await getEditor().renameTitle(target, 'Completed name'), { status: 'busy' })
    assert.equal(requests.length, 0)
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    let rename!: Promise<RenameResult>
    await act(async () => { rename = getEditor().renameTitle(target, 'Completed name') })
    assert.equal(requests.length, 1)
    await act(async () => { acknowledge(0, 'revision-1'); await rename })
    assert.deepEqual(await rename, { status: 'saved', title: 'Completed name' })
  })
})
