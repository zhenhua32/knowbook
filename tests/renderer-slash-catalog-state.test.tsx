import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { act, createElement, useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import type { UiLanguage } from '../src/renderer/src/i18n'
import { useEditorAssistState } from '../src/renderer/src/hooks/useEditorAssistState'
import { slashCommandCatalog, type BlockSlashCommand } from '../src/renderer/src/utils/slashCommandCatalog'
import { buildBlockSlashCommands } from '../src/renderer/src/utils/blockSlashCommands'

type Model = { documentId: string; language: UiLanguage; present: boolean; editing: boolean;
  blocks: DocumentBlockDraft[]; index: number | null; cursor: number }
type Assist = ReturnType<typeof useEditorAssistState>
const block = (content: string, type = 'paragraph'): DocumentBlockDraft => ({ id: 'same-block', type, content, checked: false, depth: 0 })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred<BlockSlashCommand[]>> & { language: UiLanguage }

async function withAssist(t: TestContext, run: (api: {
  state: () => Assist; model: () => Model; document: Document; requests: Request[];
  update: (patch: Partial<Model>) => Promise<void>; slash: (content?: string) => Promise<void>;
  unmount: () => Promise<void>
}) => Promise<void>, cached?: BlockSlashCommand[]) {
  const requests: Request[] = []
  t.mock.method(slashCommandCatalog, 'cached', () => cached)
  t.mock.method(slashCommandCatalog, 'load', (language: UiLanguage) => {
    const request = { ...deferred<BlockSlashCommand[]>(), language }; requests.push(request); return request.promise
  })
  const dom = new JSDOM('<div id="mount"></div><input id="outside">', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let model!: Model, assist!: Assist, setModel!: Dispatch<SetStateAction<Model>>, mounted = true
  function Harness() {
    const [current, setCurrent] = useState<Model>({ documentId: 'document-a', language: 'en-US', present: true,
      editing: true, blocks: [block('Draft body')], index: 0, cursor: 'Draft body'.length })
    model = current; setModel = setCurrent
    const refs = useRef<Array<HTMLTextAreaElement | null>>([])
    const setIndex = useCallback<Dispatch<SetStateAction<number | null>>>(value => setCurrent(previous => ({ ...previous,
      index: typeof value === 'function' ? value(previous.index) : value })), [])
    const setCursor = useCallback<Dispatch<SetStateAction<number>>>(value => setCurrent(previous => ({ ...previous,
      cursor: typeof value === 'function' ? value(previous.cursor) : value })), [])
    const setBlocks = useCallback<Dispatch<SetStateAction<DocumentBlockDraft[]>>>(value => setCurrent(previous => ({ ...previous,
      blocks: typeof value === 'function' ? value(previous.blocks) : value })), [])
    assist = useEditorAssistState({ activeBlockIndex: current.index, activeCursorPosition: current.cursor,
      blockTextareaRefs: refs, draftBlocks: current.blocks, isEditing: current.editing,
      selectedDocumentId: current.documentId, selectedDocumentPresent: current.present,
      setActiveBlockIndex: setIndex, setActiveCursorPosition: setCursor, setDraftBlocks: setBlocks, uiLanguage: current.language })
    return createElement('textarea', { readOnly: true, value: current.blocks[0].content,
      ref: (element: HTMLTextAreaElement | null) => { refs.current[0] = element } })
  }
  const update = async (patch: Partial<Model>) => { await act(async () => setModel(previous => ({ ...previous, ...patch }))) }
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  try {
    await act(async () => root.render(createElement(Harness)))
    await run({ state: () => assist, model: () => model, document: dom.window.document, requests, update,
      slash: async (content = '/h1') => update({ blocks: [block(content)], cursor: content.length }), unmount })
  } finally {
    await unmount(); dom.window.close()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('the catalog loads only for a valid slash context and its acknowledgement preserves text, selection and focus', async t => {
  await withAssist(t, async api => {
    assert.equal(api.requests.length, 0); assert.equal(api.state().slashCommandsLoading, false)
    await api.update({ blocks: [block('/h1', 'code')], cursor: 3 })
    assert.equal(api.requests.length, 0); assert.equal(api.state().activeSlashContext, null)
    await api.slash()
    assert.equal(api.requests.length, 1); assert.equal(api.state().slashCommandsLoading, true)
    assert.equal(api.state().slashCommandsError, null); assert.equal(api.state().activeSlashCommand, null)
    assert.deepEqual(api.state().filteredSlashCommands, [])
    await api.slash('/h2')
    assert.equal(api.requests.length, 1, 'Typing a new query reuses the same language resource request')
    const input = api.document.querySelector('textarea')!
    await act(async () => { input.focus(); input.setSelectionRange(1, 2, 'backward') })
    const before = api.model()
    await act(async () => api.requests[0].resolve(buildBlockSlashCommands('en-US')))
    assert.equal(api.state().slashCommandsLoading, false); assert.equal(api.state().activeSlashCommand?.id, 'h2')
    assert.equal(api.model(), before, 'Loading a catalog must never apply a command or change the draft')
    assert.equal(api.document.activeElement, input)
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 2, 'backward'])
  })
})

test('A to B to A rejects old catalog receipts and captured retries even with the same block and query', async t => {
  await withAssist(t, async api => {
    await api.slash(); const staleRetry = api.state().retrySlashCommands
    await api.update({ documentId: 'document-b' }); await api.update({ documentId: 'document-a' })
    assert.equal(api.requests.length, 3)
    await act(async () => {
      staleRetry()
      api.requests[0].resolve(buildBlockSlashCommands('en-US'))
      api.requests[1].reject(new Error('Old document failed'))
    })
    assert.equal(api.requests.length, 3); assert.equal(api.state().slashCommandsLoading, true)
    assert.equal(api.state().slashCommandsError, null); assert.equal(api.state().activeSlashCommand, null)
    await act(async () => api.requests[2].resolve(buildBlockSlashCommands('en-US')))
    assert.equal(api.state().activeSlashCommand?.id, 'h1')
    assert.equal(api.model().blocks[0].content, '/h1')
  })
})

test('language changes cannot publish an old catalog and a failed current load can be retried', async t => {
  await withAssist(t, async api => {
    await api.slash(); await api.update({ language: 'zh-CN' })
    assert.deepEqual(api.requests.map(request => request.language), ['en-US', 'zh-CN'])
    await act(async () => api.requests[0].resolve(buildBlockSlashCommands('en-US')))
    assert.equal(api.state().activeSlashCommand, null); assert.equal(api.state().slashCommandsLoading, true)
    await act(async () => api.requests[1].reject(new Error('Private network details')))
    assert.equal(api.state().slashCommandsLoading, false); assert.equal(api.state().slashCommandsError, '无法加载命令，请重试。')
    assert.equal(api.state().activeSlashCommand, null)
    await act(async () => api.state().retrySlashCommands())
    assert.equal(api.requests.length, 3); assert.equal(api.state().slashCommandsLoading, true)
    await act(async () => api.requests[2].resolve(buildBlockSlashCommands('zh-CN')))
    assert.equal(api.state().slashCommandsError, null); assert.equal(api.state().activeSlashCommand?.id, 'h1')
    assert.equal(api.state().activeSlashCommand?.label, '一级标题')
  })
})

test('closing slash and unmounting discard pending loads without reopening suggestions or stealing focus', async t => {
  await withAssist(t, async api => {
    await api.slash(); await api.slash('A normal paragraph')
    await act(async () => api.document.getElementById('outside')!.focus())
    await act(async () => api.requests[0].resolve(buildBlockSlashCommands('en-US')))
    assert.equal(api.state().activeSlashContext, null); assert.equal(api.state().slashCommandsLoading, false)
    assert.equal(api.document.activeElement?.id, 'outside')
    assert.equal(api.model().blocks[0].content, 'A normal paragraph')
    await api.slash(); await api.unmount()
    await act(async () => api.requests[1].resolve(buildBlockSlashCommands('en-US')))
    assert.equal(api.document.getElementById('mount')!.childElementCount, 0)
  })
})

test('a cached catalog is immediately usable with no pending render or additional request', async t => {
  await withAssist(t, async api => {
    await api.slash('/columns')
    assert.equal(api.requests.length, 0); assert.equal(api.state().slashCommandsLoading, false)
    assert.equal(api.state().slashCommandsError, null); assert.equal(api.state().activeSlashCommand?.id, 'columns')
    assert.equal(api.state().activeSlashCommand?.kind, 'action')
  }, buildBlockSlashCommands('en-US'))
})
