import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { act, createElement, useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft, DocumentSuggestion, ElectronApi } from '../src/shared/contracts'
import { useEditorAssistState } from '../src/renderer/src/hooks/useEditorAssistState'
import type { UiLanguage } from '../src/renderer/src/i18n'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const block = (id: string, content: string): DocumentBlockDraft => ({ id, content, type: 'paragraph', checked: false, depth: 0 })
const suggestion = (id: string): DocumentSuggestion => ({ id, title: id, path: `Home/${id}` })
const prefix = 'Before [['
const suffix = ' after'
type EditorModel = {
  documentId: string | null
  present: boolean
  editing: boolean
  language: UiLanguage
  index: number | null
  cursor: number
  blocks: DocumentBlockDraft[]
}
type AssistState = ReturnType<typeof useEditorAssistState>
type SuggestionRequest = ReturnType<typeof deferred<DocumentSuggestion[]>> & { query: string; documentId: string | null }
type AssistSnapshot = { key: string | null; items: string[]; blockItems: Array<string | undefined>; slashQuery: string | null }
const sourceTypes = ['code', 'math', 'table', 'frontmatter', 'html', 'divider', 'custom-source']
const proseTypes = ['paragraph', 'quote', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6',
  'todo', 'numbered-todo', 'bulleted-list', 'numbered-list']

async function withAssist(t: TestContext, run: (context: {
  state: () => AssistState
  model: () => EditorModel
  document: Document
  requests: SuggestionRequest[]
  snapshots: AssistSnapshot[]
  update: (patch: Partial<EditorModel>) => Promise<void>
  query: (query: string) => Promise<void>
  tick: (duration?: number) => Promise<void>
  unmount: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const requests: SuggestionRequest[] = []
  const snapshots: AssistSnapshot[] = []
  const api: Partial<ElectronApi> = {
    getDocumentSuggestions: (query, documentId) => {
      const request = { ...deferred<DocumentSuggestion[]>(), query, documentId: documentId ?? null }
      requests.push(request)
      return request.promise
    }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let state!: AssistState
  let model!: EditorModel
  let setModel!: Dispatch<SetStateAction<EditorModel>>
  let mounted = true
  function Harness() {
    const [editor, setEditor] = useState<EditorModel>({ documentId: 'document-a', present: true, editing: true,
      language: 'en-US', index: 0, cursor: prefix.length + 5,
      blocks: [block('input', `${prefix}Alpha${suffix}`), block('local-alpha', 'Alpha local block'), block('local-beta', 'Beta local block')] })
    model = editor
    setModel = setEditor
    const refs = useRef<Array<HTMLTextAreaElement | null>>([])
    const setActiveBlockIndex = useCallback<Dispatch<SetStateAction<number | null>>>(next => {
      setEditor(previous => ({ ...previous, index: typeof next === 'function' ? next(previous.index) : next }))
    }, [])
    const setActiveCursorPosition = useCallback<Dispatch<SetStateAction<number>>>(next => {
      setEditor(previous => ({ ...previous, cursor: typeof next === 'function' ? next(previous.cursor) : next }))
    }, [])
    const setDraftBlocks = useCallback<Dispatch<SetStateAction<DocumentBlockDraft[]>>>(next => {
      setEditor(previous => ({ ...previous, blocks: typeof next === 'function' ? next(previous.blocks) : next }))
    }, [])
    state = useEditorAssistState({ activeBlockIndex: editor.index, activeCursorPosition: editor.cursor,
      blockTextareaRefs: refs, draftBlocks: editor.blocks, isEditing: editor.editing,
      selectedDocumentId: editor.documentId, selectedDocumentPresent: editor.present,
      setActiveBlockIndex, setActiveCursorPosition, setDraftBlocks, uiLanguage: editor.language })
    snapshots.push({ key: state.linkSuggestionContextKey, items: state.linkSuggestions.map(item => item.id),
      blockItems: state.blockSuggestions.map(item => item.id), slashQuery: state.activeSlashContext?.query ?? null })
    return createElement('div', null,
      ...editor.blocks.map((item, index) => createElement('textarea', { key: item.id, value: item.content, readOnly: true,
        'aria-label': `Block ${index}`, ref: (element: HTMLTextAreaElement | null) => { refs.current[index] = element } })),
      createElement('div', { 'data-document-suggestions': true }, ...state.linkSuggestions.map(item =>
        createElement('button', { key: item.id, type: 'button', onClick: () => state.insertLinkSuggestion(item) }, item.title))),
      createElement('div', { 'data-block-suggestions': true }, ...state.blockSuggestions.map((item, index) =>
        createElement('button', { key: item.id ?? index, type: 'button', 'data-block-id': item.id,
          onClick: () => state.insertBlockSuggestion(item) }, item.content))),
      createElement('div', { 'data-slash-suggestions': true }, ...(state.activeSlashContext ? state.filteredSlashCommands : []).map(command =>
        createElement('span', { key: command.id }, command.label))),
      createElement('output', { 'aria-label': 'Suggestion status' }, state.linkSuggestionsLoading ? 'Loading' : state.linkSuggestionsError ?? ''),
      createElement('button', { type: 'button', 'data-retry': true, onClick: state.retryLinkSuggestions }, 'Retry document suggestions'))
  }
  const update = async (patch: Partial<EditorModel>) => { await act(async () => setModel(previous => ({ ...previous, ...patch }))) }
  const unmount = async () => {
    if (mounted) {
      mounted = false
      await act(async () => root.unmount())
    }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ state: () => state, model: () => model, document: dom.window.document, requests, snapshots, update,
      query: async query => { await update({ blocks: [block(model.blocks[0].id!, `${prefix}${query}${suffix}`), ...model.blocks.slice(1)],
        index: 0, cursor: prefix.length + query.length }) },
      tick: async (duration = 120) => { await act(async () => t.mock.timers.tick(duration)) }, unmount })
  } finally {
    await unmount()
    t.mock.timers.reset()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('child slash commands are available only for list parents below the depth limit', async t => {
  await withAssist(t, async ({ state, update }) => {
    const parent = block('parent', '/child')
    await update({ blocks: [parent], index: 0, cursor: parent.content.length })
    assert.equal(state().activeSlashContext?.query, 'child')
    assert.equal(state().filteredSlashCommands.some(command => command.id === 'child'), false)

    await update({ blocks: [{ ...parent, type: 'bulleted-list' }] })
    assert.equal(state().filteredSlashCommands.some(command => command.id === 'child'), true)

    await update({ blocks: [{ ...parent, type: 'todo', depth: 6 }] })
    assert.equal(state().filteredSlashCommands.some(command => command.id === 'child'), false)

    await update({ blocks: [{ ...parent, type: 'todo', depth: 5 }] })
    assert.equal(state().filteredSlashCommands.some(command => command.id === 'child'), true)
  })
})

test('a new link query hides old document suggestions on its first render and rejects their insertion', async t => {
  await withAssist(t, async ({ state, model, document, requests, snapshots, query, tick }) => {
    assert.ok(state().blockSuggestions.some(item => item.id === 'local-alpha'), 'local suggestions are immediate before debounce')
    await tick(119)
    assert.equal(requests.length, 0)
    await tick(1)
    await act(async () => requests[0].resolve([suggestion('Alpha')]))
    const oldState = state()
    assert.equal(document.querySelector('[data-document-suggestions]')!.textContent, 'Alpha')
    const firstNewRender = snapshots.length
    await query('Beta')
    assert.deepEqual(snapshots[firstNewRender].items, [], 'render guard must hide old candidates before layout effects')
    assert.notEqual(state().linkSuggestionContextKey, oldState.linkSuggestionContextKey)
    assert.equal(document.querySelector('[data-document-suggestions]')!.textContent, '')
    assert.equal(state().linkSuggestionsLoading, true)
    assert.ok(state().blockSuggestions.some(item => item.id === 'local-beta'))
    await act(async () => {
      oldState.insertLinkSuggestion(suggestion('Alpha'))
      oldState.insertBlockSuggestion(block('local-alpha', 'Alpha local block'))
      state().insertLinkSuggestion(suggestion('Alpha'))
    })
    assert.equal(model().blocks[0].content, `${prefix}Beta${suffix}`)
    await tick()
    await act(async () => requests[1].resolve([suggestion('Beta')]))
    await act(async () => document.querySelector<HTMLButtonElement>('[data-document-suggestions] button')!.click())
    assert.equal(model().blocks[0].content, 'Before [[Home/Beta]] after')
    const input = document.querySelector<HTMLTextAreaElement>('textarea')!
    assert.equal(document.activeElement, input)
    assert.equal(input.selectionStart, 'Before [[Home/Beta]]'.length)
    assert.deepEqual(state().linkSuggestions, [])
  })
})

test('multiple query requests ignore out-of-order success and failure without finishing the current request', async t => {
  await withAssist(t, async ({ state, requests, query, tick }) => {
    await tick()
    await query('Beta'); await tick()
    await query('Gamma'); await tick()
    assert.deepEqual(requests.map(item => item.query), ['Alpha', 'Beta', 'Gamma'])
    await act(async () => {
      requests[0].resolve([suggestion('Old Alpha')])
      requests[1].reject(new Error('private IPC failure'))
    })
    assert.deepEqual(state().linkSuggestions, [])
    assert.equal(state().linkSuggestionsLoading, true)
    assert.equal(state().linkSuggestionsError, null)
    await act(async () => requests[2].resolve([suggestion('Gamma')]))
    assert.deepEqual(state().linkSuggestions, [suggestion('Gamma')])
    assert.equal(state().linkSuggestionsLoading, false)
  })
})

test('document changes isolate pending requests even when the link query and block id are unchanged', async t => {
  await withAssist(t, async ({ state, requests, update, tick }) => {
    await tick()
    const oldKey = state().linkSuggestionContextKey
    await update({ documentId: 'document-b' })
    assert.notEqual(state().linkSuggestionContextKey, oldKey)
    await tick()
    assert.deepEqual(requests.map(item => item.documentId), ['document-a', 'document-b'])
    await act(async () => requests[0].resolve([suggestion('Old document')]))
    assert.deepEqual(state().linkSuggestions, [])
    assert.equal(state().linkSuggestionsLoading, true)
    await act(async () => requests[1].resolve([suggestion('Current document')]))
    assert.deepEqual(state().linkSuggestions, [suggestion('Current document')])
  })
})

test('returning A to B to A creates a fresh request and rejects the original A response and callbacks', async t => {
  await withAssist(t, async ({ state, model, requests, query, tick }) => {
    await tick()
    await act(async () => requests[0].resolve([suggestion('First Alpha')]))
    const original = state()
    await query('Beta'); await tick()
    await query('Alpha'); await tick()
    assert.equal(state().linkSuggestionContextKey, original.linkSuggestionContextKey)
    await act(async () => {
      original.insertLinkSuggestion(suggestion('First Alpha'))
      original.retryLinkSuggestions()
      requests[1].reject(new Error('Old Beta'))
    })
    assert.equal(model().blocks[0].content, `${prefix}Alpha${suffix}`)
    assert.equal(state().linkSuggestionsLoading, true)
    assert.equal(state().linkSuggestionsError, null)
    await tick()
    assert.equal(requests.length, 3, 'stale retry callback must not restart the returned session')
    await act(async () => requests[2].resolve([suggestion('New Alpha')]))
    assert.deepEqual(state().linkSuggestions, [suggestion('New Alpha')])
  })
})

test('an unresolved original A cannot win after the query returns from B to A', async t => {
  await withAssist(t, async ({ state, requests, query, tick }) => {
    await tick()
    await query('Beta'); await tick()
    await query('Alpha'); await tick()
    await act(async () => requests[0].resolve([suggestion('Stale Alpha')]))
    assert.deepEqual(state().linkSuggestions, [])
    assert.equal(state().linkSuggestionsLoading, true)
    await act(async () => requests[2].resolve([suggestion('Fresh Alpha')]))
    await act(async () => requests[1].resolve([suggestion('Stale Beta')]))
    assert.deepEqual(state().linkSuggestions, [suggestion('Fresh Alpha')])
  })
})

test('switching the active block or link opening invalidates same-query candidates', async t => {
  await withAssist(t, async ({ state, model, requests, update, tick }) => {
    await tick()
    const firstKey = state().linkSuggestionContextKey
    await update({ blocks: [model().blocks[0], block('second-input', `${prefix}Alpha${suffix}`)], index: 1 })
    assert.notEqual(state().linkSuggestionContextKey, firstKey)
    await tick()
    const secondKey = state().linkSuggestionContextKey
    const text = `${prefix}Alpha]] and [[Alpha after`
    await update({ blocks: [model().blocks[0], block('second-input', text)], cursor: text.indexOf(' after') })
    assert.notEqual(state().linkSuggestionContextKey, secondKey)
    await tick()
    await act(async () => { requests[0].resolve([suggestion('First link')]); requests[1].resolve([suggestion('Second block')]) })
    assert.deepEqual(state().linkSuggestions, [])
    await act(async () => requests[2].resolve([suggestion('Current opening')]))
    assert.deepEqual(state().linkSuggestions, [suggestion('Current opening')])
  })
})

test('failure preserves the draft, caret and local candidates; retry targets only the current session', async t => {
  await withAssist(t, async ({ state, model, document, requests, update, query, tick }) => {
    await tick()
    const content = model().blocks[0].content
    const cursor = model().cursor
    await act(async () => requests[0].reject(new Error('secret endpoint or stack')))
    assert.equal(state().linkSuggestionsError, 'Could not load document suggestions. Please retry.')
    assert.equal(state().linkSuggestionsLoading, false)
    assert.ok(state().blockSuggestions.some(item => item.id === 'local-alpha'))
    assert.equal(model().blocks[0].content, content)
    assert.equal(model().cursor, cursor)
    await update({ language: 'zh-CN' })
    assert.equal(state().linkSuggestionsError, '无法加载文档建议，请重试。')
    const staleRetry = state().retryLinkSuggestions
    await query('Beta')
    await act(async () => staleRetry())
    await tick()
    assert.equal(requests.length, 2)
    assert.equal(requests[1].query, 'Beta')
    await act(async () => requests[1].reject(new Error('second private error')))
    const beforeRetry = model()
    await act(async () => document.querySelector<HTMLButtonElement>('button[data-retry]')!.click())
    assert.equal(state().linkSuggestionsError, null)
    assert.equal(state().linkSuggestionsLoading, true)
    assert.ok(state().blockSuggestions.some(item => item.id === 'local-beta'))
    assert.equal(model().blocks, beforeRetry.blocks)
    assert.equal(model().cursor, beforeRetry.cursor)
    await tick()
    assert.equal(requests[2].query, 'Beta')
    assert.equal(requests[2].documentId, 'document-a')
    await act(async () => requests[2].resolve([suggestion('Recovered Beta')]))
    assert.deepEqual(state().linkSuggestions, [suggestion('Recovered Beta')])
    assert.equal(state().linkSuggestionsError, null)
  })
})

test('a newer retry ignores an earlier request response and repeated stale retry clicks', async t => {
  await withAssist(t, async ({ state, requests, tick }) => {
    await tick()
    const initialRetry = state().retryLinkSuggestions
    await act(async () => { initialRetry(); initialRetry() })
    await tick()
    assert.equal(requests.length, 2)
    await act(async () => state().retryLinkSuggestions())
    await tick()
    assert.equal(requests.length, 3)
    await act(async () => { requests[0].resolve([suggestion('Original')]); requests[1].reject(new Error('Older retry')) })
    assert.deepEqual(state().linkSuggestions, [])
    assert.equal(state().linkSuggestionsLoading, true)
    assert.equal(state().linkSuggestionsError, null)
    await act(async () => requests[2].resolve([suggestion('Newest retry')]))
    assert.deepEqual(state().linkSuggestions, [suggestion('Newest retry')])
  })
})

test('current local block insertion works during pending and error, restoring the caret without reopening from a late response', async t => {
  for (const phase of ['pending', 'error'] as const) {
    await withAssist(t, async ({ state, model, document, requests, tick }) => {
      await tick()
      if (phase === 'error') {
        await act(async () => state().retryLinkSuggestions())
        await tick()
        await act(async () => requests[1].reject(new Error('Current lookup failed')))
        assert.equal(state().linkSuggestionsLoading, false)
        assert.ok(state().linkSuggestionsError)
      } else {
        assert.equal(state().linkSuggestionsLoading, true)
      }
      const choice = document.querySelector<HTMLButtonElement>('[data-block-suggestions] button[data-block-id="local-alpha"]')!
      assert.ok(choice)
      await act(async () => choice.click())
      assert.equal(model().blocks[0].content, 'Before [[local-alpha]] after', `local insertion must preserve the surrounding text during ${phase}`)
      assert.equal(model().cursor, 'Before [[local-alpha]]'.length)
      const input = document.querySelector<HTMLTextAreaElement>('textarea')!
      assert.equal(document.activeElement, input)
      assert.equal(input.selectionStart, 'Before [[local-alpha]]'.length)
      assert.equal(input.selectionEnd, input.selectionStart)
      await act(async () => requests[0].resolve([suggestion('Late original request')]))
      assert.equal(state().linkSuggestionContextKey, null)
      assert.deepEqual(state().linkSuggestions, [])
      assert.deepEqual(state().blockSuggestions, [])
      assert.equal(state().linkSuggestionsLoading, false)
      assert.equal(state().linkSuggestionsError, null)
      assert.equal(model().blocks[0].content, 'Before [[local-alpha]] after')
      assert.equal(document.querySelector('[data-document-suggestions]')!.textContent, '')
    })
  }
})

test('unrelated draft edits and same-query caret movement preserve the debounced request and refresh local candidates', async t => {
  await withAssist(t, async ({ state, model, requests, update, tick }) => {
    const key = state().linkSuggestionContextKey
    await tick(60)
    await update({ blocks: [model().blocks[0], block('changed-local', 'Alpha changed locally')] })
    assert.equal(state().linkSuggestionContextKey, key)
    assert.deepEqual(state().blockSuggestions.map(item => item.id), ['input', 'changed-local'])
    await tick(60)
    assert.equal(requests.length, 1, 'unrelated edits must not reset the initial debounce')
    await update({ blocks: [block('input', `${prefix}Alpha  ${suffix}`), ...model().blocks.slice(1)], cursor: prefix.length + 7 })
    assert.equal(state().linkSuggestionContextKey, key)
    await tick(120)
    assert.equal(requests.length, 1, 'primitive trimmed query must avoid another request')
    await act(async () => requests[0].resolve([suggestion('Alpha')]))
    assert.deepEqual(state().linkSuggestions, [suggestion('Alpha')])
  })
})

test('clear cancels debounce and ignores in-flight success and failure until a new context opens', async t => {
  await withAssist(t, async ({ state, requests, query, tick }) => {
    await act(async () => state().clearEditorAssistSuggestions())
    await tick()
    assert.equal(requests.length, 0)
    assert.deepEqual(state().blockSuggestions, [])
    assert.equal(state().linkSuggestionsLoading, false)
    await query('Beta'); await tick()
    await act(async () => state().clearEditorAssistSuggestions())
    await act(async () => requests[0].resolve([suggestion('Late Beta')]))
    assert.deepEqual(state().linkSuggestions, [])
    assert.deepEqual(state().blockSuggestions, [])
    assert.equal(state().linkSuggestionsLoading, false)
    await query('Gamma'); await tick()
    await act(async () => state().clearEditorAssistSuggestions())
    await act(async () => requests[1].reject(new Error('Late failure')))
    assert.equal(state().linkSuggestionsError, null)
    assert.equal(state().linkSuggestionsLoading, false)
  })
})

test('leaving edit mode, losing the selected detail and unmounting discard late responses', async t => {
  await withAssist(t, async ({ state, document, requests, update, tick, unmount }) => {
    await tick()
    await update({ editing: false })
    assert.equal(state().linkSuggestionContextKey, null)
    await act(async () => requests[0].resolve([suggestion('Late read-mode response')]))
    assert.deepEqual(state().linkSuggestions, [])
    await update({ editing: true }); await tick()
    await update({ present: false })
    await act(async () => requests[1].reject(new Error('Late missing-detail failure')))
    assert.equal(state().linkSuggestionContextKey, null)
    assert.equal(state().linkSuggestionsError, null)
    assert.deepEqual(state().blockSuggestions, [])
    await update({ present: true }); await tick()
    const beforeUnmount = state()
    await unmount()
    await act(async () => requests[2].resolve([suggestion('Late unmount response')]))
    assert.equal(state(), beforeUnmount, 'unmounted hook must not render after a late response')
    assert.equal(document.getElementById('mount')!.childElementCount, 0)
  })
})

test('source and unknown blocks never open slash or wiki suggestions or request document candidates', async t => {
  await withAssist(t, async ({ state, model, document, requests, update, tick }) => {
    for (const type of sourceTypes) {
      const wiki = { ...block('input', `${prefix}Alpha${suffix}`), type }
      await update({ blocks: [wiki, block('local-alpha', 'Alpha local block')], cursor: prefix.length + 5 })
      assert.equal(state().activeLinkContext, null, `${type} wiki text must remain literal`)
      assert.equal(state().linkSuggestionContextKey, null)
      assert.deepEqual(state().linkSuggestions, [])
      assert.deepEqual(state().blockSuggestions, [])
      assert.equal(state().linkSuggestionsLoading, false)
      assert.equal(state().linkSuggestionsError, null)
      assert.equal(document.querySelector('[data-document-suggestions]')!.childElementCount, 0)
      assert.equal(document.querySelector('[data-block-suggestions]')!.childElementCount, 0)
      await tick()
      assert.equal(requests.length, 0, `${type} must not make wiki lookups`)
      const slash = { ...wiki, content: '/todo' }
      await update({ blocks: [slash], cursor: slash.content.length })
      assert.equal(state().activeSlashContext, null, `${type} slash text must remain literal`)
      assert.deepEqual(state().filteredSlashCommands, [])
      assert.equal(state().activeSlashCommand, null)
      assert.equal(state().slashPanelPos, null)
      assert.equal(document.querySelector('[data-slash-suggestions]')!.childElementCount, 0)
      await tick()
      assert.deepEqual(model().blocks, [slash])
      assert.equal(requests.length, 0)
    }
  })
})

test('paragraph, headings, lists and quotes retain slash commands and working wiki insertion', async t => {
  await withAssist(t, async ({ state, model, document, requests, update, tick }) => {
    for (const type of proseTypes) {
      const slash = { ...block('input', '/todo'), type }
      await update({ blocks: [slash], cursor: slash.content.length })
      assert.equal(state().activeSlashContext?.query, 'todo', `${type} keeps slash commands`)
      assert.equal(state().activeSlashCommand?.id, 'todo')
      assert.ok(state().filteredSlashCommands.some(command => command.id === 'todo'))
      assert.ok(document.querySelector('[data-slash-suggestions]')!.childElementCount > 0)
      const wiki = { ...slash, content: `${prefix}Alpha${suffix}` }
      await update({ blocks: [wiki, block('local-alpha', 'Alpha local block')], cursor: prefix.length + 5 })
      assert.equal(state().activeLinkContext?.query, 'Alpha', `${type} keeps wiki suggestions`)
      assert.equal(state().activeSlashContext, null)
      assert.ok(state().blockSuggestions.some(item => item.id === 'local-alpha'))
      const count = requests.length
      await tick()
      assert.equal(requests.length, count + 1)
      await act(async () => requests[count].resolve([suggestion('Alpha')]))
      await act(async () => document.querySelector<HTMLButtonElement>('[data-document-suggestions] button')!.click())
      assert.equal(model().blocks[0].content, 'Before [[Home/Alpha]] after')
      assert.equal(model().blocks[0].type, type)
      const input = document.querySelector<HTMLTextAreaElement>('textarea')!
      assert.equal(document.activeElement, input)
      assert.equal(input.selectionStart, 'Before [[Home/Alpha]]'.length)
    }
  })
})

test('changing a prose block to a source type hides same-id candidates on the first render and rejects captured callbacks', async t => {
  await withAssist(t, async ({ state, model, document, requests, snapshots, update, tick }) => {
    for (const type of sourceTypes) {
      const prose = block('input', `${prefix}Alpha${suffix}`)
      await update({ blocks: [prose, block('local-alpha', 'Alpha local block')], cursor: prefix.length + 5 })
      await tick()
      const count = requests.length
      await act(async () => requests[count - 1].resolve([suggestion('Alpha')]))
      const oldState = state()
      assert.equal(document.querySelector('[data-document-suggestions]')!.textContent, 'Alpha')
      const firstSourceRender = snapshots.length
      const source = { ...prose, type }
      await update({ blocks: [source, model().blocks[1]] })
      assert.deepEqual(snapshots[firstSourceRender], { key: null, items: [], blockItems: [], slashQuery: null },
        `${type} must discard candidates before layout effects even when its id, content and caret are unchanged`)
      const before = model()
      await act(async () => {
        oldState.insertLinkSuggestion(suggestion('Alpha'))
        oldState.insertBlockSuggestion(block('local-alpha', 'Alpha local block'))
        oldState.retryLinkSuggestions()
        state().insertLinkSuggestion(suggestion('Alpha'))
        state().insertBlockSuggestion(block('local-alpha', 'Alpha local block'))
      })
      assert.equal(model(), before, 'stale suggestions must neither update the source nor move the caret')
      assert.equal(document.querySelector('[data-document-suggestions]')!.childElementCount, 0)
      assert.equal(document.querySelector('[data-block-suggestions]')!.childElementCount, 0)
      await tick()
      assert.equal(requests.length, count, 'a captured retry cannot restart source suggestions')

      await update({ blocks: [{ ...prose, content: '/todo' }], cursor: '/todo'.length })
      assert.equal(state().activeSlashContext?.query, 'todo')
      const firstSlashSourceRender = snapshots.length
      await update({ blocks: [{ ...source, content: '/todo' }] })
      assert.equal(snapshots[firstSlashSourceRender].slashQuery, null)
      assert.deepEqual(state().filteredSlashCommands, [])
      assert.equal(state().activeSlashCommand, null)
    }
  })
})

test('switching a pending wiki lookup to source ignores late responses and reopens a fresh prose session', async t => {
  for (const response of ['success', 'error'] as const) {
    await withAssist(t, async ({ state, model, requests, update, tick }) => {
      await tick()
      const oldState = state()
      const source = { ...model().blocks[0], type: response === 'success' ? 'code' : 'html' }
      await update({ blocks: [source, ...model().blocks.slice(1)] })
      await act(async () => {
        oldState.insertBlockSuggestion(block('local-alpha', 'Alpha local block'))
        oldState.retryLinkSuggestions()
        if (response === 'success') requests[0].resolve([suggestion('Stale Alpha')])
        else requests[0].reject(new Error('Late source lookup'))
      })
      assert.deepEqual(model().blocks[0], source)
      assert.equal(state().activeLinkContext, null)
      assert.deepEqual(state().linkSuggestions, [])
      assert.deepEqual(state().blockSuggestions, [])
      assert.equal(state().linkSuggestionsError, null)
      assert.equal(state().linkSuggestionsLoading, false)
      await tick()
      assert.equal(requests.length, 1)
      await update({ blocks: [{ ...source, type: 'paragraph' }, ...model().blocks.slice(1)] })
      assert.equal(state().activeLinkContext?.query, 'Alpha')
      assert.equal(state().linkSuggestionsLoading, true)
      await tick()
      assert.equal(requests.length, 2)
      await act(async () => requests[1].resolve([suggestion('Fresh Alpha')]))
      assert.deepEqual(state().linkSuggestions, [suggestion('Fresh Alpha')])
    })
  }
})

test('both slash and wiki contexts require an editable document detail and an active prose block', async t => {
  await withAssist(t, async ({ state, requests, update, tick }) => {
    for (const unavailable of [{ editing: false }, { present: false }, { documentId: null }, { index: null }, { index: 4 }] satisfies Partial<EditorModel>[]) {
      for (const content of ['/todo', `${prefix}Alpha${suffix}`]) {
        await update({ editing: true, present: true, documentId: 'document-a', index: 0,
          blocks: [block('input', content)], cursor: content === '/todo' ? content.length : prefix.length + 5, ...unavailable })
        assert.equal(state().activeLinkContext, null)
        assert.equal(state().activeSlashContext, null)
        assert.equal(state().linkSuggestionContextKey, null)
        assert.deepEqual(state().blockSuggestions, [])
        assert.deepEqual(state().filteredSlashCommands, [])
        assert.equal(state().activeSlashCommand, null)
        await tick()
        assert.equal(requests.length, 0)
      }
    }
  })
})
