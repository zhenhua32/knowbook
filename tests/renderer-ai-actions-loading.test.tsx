import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { AiConfig, ElectronApi, HomeData, DocumentDetail, UpdateAiConfigInput } from '../src/shared/contracts'
import { getUiText } from '../src/renderer/src/i18n'
import { useAiState } from '../src/renderer/src/hooks/useAiState'
import * as actions from '../src/renderer/src/hooks/aiStateActions'

// Real React hook + real actions. Only the local renderer IPC endpoints and
// chunk delivery timing are fixtures; this is not a Main/network oracle.
type Actions = typeof actions
type State = ReturnType<typeof useAiState>
type Loader = () => Promise<Actions>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const configuration: AiConfig = { enabled: true, hasApiKey: true, baseUrl: 'https://local.example/v1', model: 'saved',
  autoSummaryOnSave: false, relatedNotesEnabled: true }

async function withAi(load: Loader, api: Partial<ElectronApi>, run: (context: {
  state: () => State; messages: unknown[][]; configChanges: AiConfig[]; document: Document;
  edit: (change: (state: State) => void) => Promise<void>;
  select: (id: string) => Promise<void>; unmount: () => Promise<void>;
  begin: (invoke: (state: State) => Promise<void>) => Promise<{ completion: Promise<void> }>;
  settle: (change: () => void, completion?: Promise<void>) => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  const messages: unknown[][] = [], configChanges: AiConfig[] = []
  let selected = 'source', mounted = true, state!: State
  function Harness() {
    state = useAiState({ aiConfig: configuration, selectedDocumentId: selected, ui: getUiText('en-US'),
      onHomeDataChange: () => {}, onAiConfigChange: value => configChanges.push(value), onSelectedDocumentChange: () => {},
      onDraftSummaryChange: () => {}, onMessage: (...values) => messages.push(values) }, load)
    return null
  }
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  try {
    await act(async () => root.render(createElement(Harness)))
    await act(async () => state.setAiPromptDraft('original question'))
    await run({ state: () => state, messages, configChanges, document: dom.window.document,
      edit: async change => { await act(async () => change(state)) },
      select: async id => { selected = id; await act(async () => root.render(createElement(Harness))) }, unmount,
      begin: async invoke => { let completion!: Promise<void>; await act(async () => { completion = invoke(state); await Promise.resolve() }); return { completion } },
      settle: async (change, completion) => { await act(async () => { change(); if (completion) await completion; else await Promise.resolve() }) } })
  } finally {
    await unmount(); dom.window.close()
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

test('AI settings remain cold at mount and reserve the real save lock and busy state before loading', async () => {
  const chunk = deferred<Actions>(), ipc = deferred<AiConfig>(), requests: UpdateAiConfigInput[] = []
  let loads = 0
  await withAi(() => { loads++; return chunk.promise }, { updateAiConfig: input => { requests.push(input); return ipc.promise } }, async context => {
    assert.equal(loads, 0)
    await context.edit(state => { state.setAiModelDraft('submitted'); state.setAiApiKeyDraft('local secret') })
    const pending = await context.begin(state => state.saveAiConfig())
    assert.equal(context.state().aiSaving, true); assert.equal(loads, 1); assert.equal(requests.length, 0)
    await context.edit(state => { state.setAiModelDraft('blocked replacement'); state.setAiApiKeyDraft('blocked secret') })
    assert.equal(context.state().aiModelDraft, 'submitted'); assert.equal(context.state().aiApiKeyDraft, 'local secret')
    await context.begin(state => state.saveAiConfig()); await context.begin(state => state.clearAiApiKey())
    assert.equal(loads, 1, 'the original settings lock must deduplicate before the chunk arrives')
    await context.settle(() => chunk.resolve(actions))
    assert.equal(requests.length, 1); assert.equal(requests[0].model, 'submitted'); assert.equal(requests[0].apiKey, 'local secret')
    const saved = { ...configuration, model: 'submitted' }
    await context.settle(() => ipc.resolve(saved), pending.completion)
    assert.equal(context.state().aiSaving, false); assert.equal(context.state().aiApiKeyDraft, '')
    assert.deepEqual(context.configChanges, [saved])
  })
})

for (const operation of ['ask', 'related', 'automation'] as const) test(`cold AI ${operation} never sends an old request after navigating away and back`, async () => {
  const chunk = deferred<Actions>(); let requests = 0
  const api: Partial<ElectronApi> = {
    askAiAboutDocument: async () => { requests++; return { answer: 'obsolete', references: [] } },
    searchSemanticNotes: async () => { requests++; return [] },
    runDocumentAiAutomations: async () => { requests++; return { summaryGenerated: false } },
    getHomeData: async () => ({}) as HomeData, getDocumentDetail: async id => ({ id, summary: '' }) as DocumentDetail
  }
  await withAi(() => chunk.promise, api, async context => {
    const pending = await context.begin(state => operation === 'ask' ? state.askAiOnSelectedDocument()
      : operation === 'related' ? state.findRelatedNotesForPrompt() : state.runEnabledAiAutomationsOnSelectedDocument())
    assert.equal(operation === 'ask' ? context.state().aiAsking : operation === 'related' ? context.state().aiContextSearching : context.state().aiAutomationsRunning, true)
    assert.equal(requests, 0)
    await context.select('destination'); await context.select('source')
    await context.settle(() => chunk.resolve(actions), pending.completion)
    assert.equal(requests, 0); assert.equal(context.state().aiAnswer, '')
    assert.deepEqual(context.state().aiContextResults, []); assert.deepEqual(context.messages, [])
    assert.equal(context.state().aiAsking, false); assert.equal(context.state().aiContextSearching, false); assert.equal(context.state().aiAutomationsRunning, false)
  })
})

test('unmount before the AI action chunk arrives cannot start a request or a clear-key confirmation', async () => {
  for (const operation of ['save', 'clear', 'ask', 'related', 'automation'] as const) {
    const chunk = deferred<Actions>(); let requests = 0
    const api: Partial<ElectronApi> = {
      updateAiConfig: async () => { requests++; return configuration },
      askAiAboutDocument: async () => { requests++; return { answer: '', references: [] } },
      searchSemanticNotes: async () => { requests++; return [] },
      runDocumentAiAutomations: async () => { requests++; return { summaryGenerated: false } }
    }
    await withAi(() => chunk.promise, api, async context => {
      if (operation === 'save') await context.edit(state => state.setAiModelDraft('pending'))
      const pending = await context.begin(state => operation === 'save' ? state.saveAiConfig() : operation === 'clear' ? state.clearAiApiKey()
        : operation === 'ask' ? state.askAiOnSelectedDocument() : operation === 'related' ? state.findRelatedNotesForPrompt() : state.runEnabledAiAutomationsOnSelectedDocument())
      await context.unmount()
      await context.settle(() => chunk.resolve(actions), pending.completion)
      assert.equal(requests, 0); assert.deepEqual(context.messages, []); assert.deepEqual(context.configChanges, [])
      assert.equal(context.document.querySelector('dialog'), null)
    })
  }
})

test('an AI chunk failure clears the original save lock, preserves the draft, and allows an explicit retry', async () => {
  const chunk = deferred<Actions>(); let loads = 0
  const requests: UpdateAiConfigInput[] = []
  await withAi(() => ++loads === 1 ? chunk.promise : Promise.resolve(actions), {
    updateAiConfig: async input => { requests.push(input); return { ...configuration, model: input.model } }
  }, async context => {
    await context.edit(state => { state.setAiModelDraft('pending'); state.setAiApiKeyDraft('retained secret') })
    const pending = await context.begin(state => state.saveAiConfig())
    await context.settle(() => chunk.reject(new Error('AI actions chunk unavailable')), pending.completion)
    assert.equal(context.state().aiSaving, false); assert.equal(requests.length, 0)
    assert.equal(context.state().aiModelDraft, 'pending'); assert.equal(context.state().aiApiKeyDraft, 'retained secret')
    assert.equal(context.state().aiSaveError, 'AI actions chunk unavailable'); assert.equal(context.state().aiSettingsDirty, true)
    assert.deepEqual(context.messages, [['AI actions chunk unavailable', 'error']])
    await context.edit(state => state.setAiModelDraft('retry model'))
    assert.equal(context.state().aiModelDraft, 'retry model', 'load failure must release the real synchronous lock')
    const retry = await context.begin(state => state.saveAiConfig())
    await context.settle(() => {}, retry.completion)
    assert.equal(loads, 2); assert.equal(requests.length, 1); assert.equal(requests[0].model, 'retry model')
    assert.equal(context.state().aiSaving, false)
  })
})
