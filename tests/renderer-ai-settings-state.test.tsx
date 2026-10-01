import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement, useCallback, useState } from 'react'
import { JSDOM } from 'jsdom'
import type { AiConfig, ElectronApi, UpdateAiConfigInput } from '../src/shared/contracts'
import { useAiState } from '../src/renderer/src/hooks/useAiState'
import { getActiveUiText, getUiText, setActiveUiLanguage } from '../src/renderer/src/i18n'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const initialConfig: AiConfig = { enabled: true, baseUrl: 'https://saved.example/v1', model: 'saved-model',
  autoSummaryOnSave: false, relatedNotesEnabled: true, hasApiKey: true }
type State = ReturnType<typeof useAiState>
type Drafts = { enabled: boolean; baseUrl: string; model: string; autoSummaryOnSave: boolean;
  relatedNotesEnabled: boolean; apiKey: string }
type View = { drafts: Drafts; config: AiConfig; saving: boolean; clearing: boolean; saveError: string }
type Request = ReturnType<typeof deferred<AiConfig>> & { input: UpdateAiConfigInput }
type Context = {
  state: () => State; view: () => View; document: Document;
  requests: Request[]; changes: AiConfig[]; messages: [string | null, string | undefined][];
  homeReads: () => number; homeChanges: () => number;
  edit: (drafts: Partial<Drafts>) => Promise<void>;
  external: (config: AiConfig) => Promise<void>;
  start: (action: () => Promise<void>) => Promise<{ completion: Promise<void> }>;
  settle: (action: () => void, completion?: Promise<void>) => Promise<void>;
  waitForDialog: () => Promise<void>;
  confirm: () => Promise<void>; cancel: (completion?: Promise<void>) => Promise<void>;
  unmount: () => Promise<void>; render: (config?: AiConfig) => Promise<void>;
}

function draftsFrom(config: AiConfig, apiKey = ''): Drafts {
  return { enabled: config.enabled, baseUrl: config.baseUrl, model: config.model,
    autoSummaryOnSave: config.autoSummaryOnSave, relatedNotesEnabled: config.relatedNotesEnabled, apiKey }
}
const settingsInput = (drafts: Drafts): UpdateAiConfigInput => ({ ...drafts })
const clearInput = (config: AiConfig): UpdateAiConfigInput => ({ enabled: config.enabled,
  baseUrl: config.baseUrl, model: config.model, autoSummaryOnSave: config.autoSummaryOnSave,
  relatedNotesEnabled: config.relatedNotesEnabled, clearApiKey: true })

function setDrafts(state: State, drafts: Partial<Drafts>) {
  if (drafts.enabled !== undefined) state.setAiEnabledDraft(drafts.enabled)
  if (drafts.baseUrl !== undefined) state.setAiBaseUrlDraft(drafts.baseUrl)
  if (drafts.model !== undefined) state.setAiModelDraft(drafts.model)
  if (drafts.autoSummaryOnSave !== undefined) state.setAiAutoSummaryOnSaveDraft(drafts.autoSummaryOnSave)
  if (drafts.relatedNotesEnabled !== undefined) state.setAiRelatedNotesEnabledDraft(drafts.relatedNotesEnabled)
  if (drafts.apiKey !== undefined) state.setAiApiKeyDraft(drafts.apiKey)
}

async function withSettings(run: (context: Context) => Promise<void>, language: 'zh-CN' | 'en-US' = 'en-US') {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const requests: Request[] = []
  const changes: AiConfig[] = []
  const messages: Context['messages'] = []
  const startedActions: Promise<void>[] = []
  let homeReads = 0
  let homeChanges = 0
  const api: Pick<ElectronApi, 'updateAiConfig' | 'getHomeData'> = {
    updateAiConfig: input => { const request = { ...deferred<AiConfig>(), input }; requests.push(request); return request.promise },
    getHomeData: async () => { homeReads++; throw new Error('The unrelated home refresh is unavailable') }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const previousLanguage = getActiveUiText().language
  setActiveUiLanguage(language)
  await import('../src/renderer/src/components/showConfirmation')
  const { createRoot } = await import('react-dom/client')
  const mount = dom.window.document.getElementById('mount')!
  let root: ReturnType<typeof createRoot>
  let mounted = false
  let state!: State
  let configuration = initialConfig
  let changeExternal!: (config: AiConfig) => void
  function Harness() {
    const [config, setConfig] = useState(configuration)
    changeExternal = setConfig
    const onAiConfigChange = useCallback((next: AiConfig) => {
      changes.push(next)
      configuration = next
      setConfig(next)
    }, [])
    state = useAiState({ aiConfig: config, selectedDocumentId: null, ui: getUiText(language), onAiConfigChange,
      onHomeDataChange: () => { homeChanges++ }, onSelectedDocumentChange: () => {},
      onDraftSummaryChange: () => {}, onMessage: (message, level) => messages.push([message, level]) })
    const view: View = { config, saving: state.aiSaving, clearing: state.aiClearingApiKey, saveError: state.aiSaveError,
      drafts: { enabled: state.aiEnabledDraft, baseUrl: state.aiBaseUrlDraft, model: state.aiModelDraft,
        autoSummaryOnSave: state.aiAutoSummaryOnSaveDraft, relatedNotesEnabled: state.aiRelatedNotesEnabledDraft,
        apiKey: state.aiApiKeyDraft } }
    return createElement('output', null, JSON.stringify(view))
  }
  const render = async (config?: AiConfig) => {
    if (config) configuration = config
    if (!mounted) { root = createRoot(mount); mounted = true }
    await act(async () => root.render(createElement(Harness)))
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  const flushConfirmation = async () => {
    await act(async () => {
      await import('../src/renderer/src/components/showConfirmation')
      await new Promise<void>(resolve => setImmediate(resolve))
    })
  }
  const waitForDialog = async () => {
    const deadline = Date.now() + 2000
    do {
      await flushConfirmation()
      if (dom.window.document.querySelector('.app-confirm-dialog')) return
    } while (Date.now() < deadline)
    assert.fail('the real confirmation did not render')
  }
  const cancel = async (completion?: Promise<void>) => {
    await waitForDialog()
    const button = dom.window.document.querySelector<HTMLButtonElement>('.app-confirm-dialog .secondary-button')
    assert.ok(button, 'the real confirmation must be open')
    await act(async () => { button.click(); await completion })
  }
  try {
    await render()
    await run({ state: () => state, view: () => JSON.parse(mount.querySelector('output')!.textContent!) as View,
      document: dom.window.document, requests, changes, messages, homeReads: () => homeReads, homeChanges: () => homeChanges,
      render, unmount, cancel, waitForDialog,
      edit: async drafts => { await act(async () => setDrafts(state, drafts)) },
      external: async config => { configuration = config; await act(async () => changeExternal(config)) },
      start: async action => { let completion!: Promise<void>; await act(async () => { completion = action(); startedActions.push(completion) }); return { completion } },
      settle: async (action, completion) => { await act(async () => { action(); await completion }) },
      confirm: async () => {
        await waitForDialog()
        const button = dom.window.document.querySelector<HTMLButtonElement>('.app-confirm-dialog .danger-button')
        assert.ok(button, 'the real confirmation must be open')
        await act(async () => button.click())
      }
    })
  } finally {
    await unmount()
    await flushConfirmation()
    await act(async () => { for (const request of requests) request.resolve(initialConfig) })
    if (dom.window.document.querySelector('.app-confirm-dialog')) await cancel()
    await act(async () => { await Promise.all(startedActions) })
    setActiveUiLanguage(previousLanguage)
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const editedDrafts: Drafts = { enabled: false, baseUrl: ' https://draft.example/v1 ', model: ' draft-model ',
  autoSummaryOnSave: true, relatedNotesEnabled: false, apiKey: 'new-api-key' }
const acknowledgedConfig: AiConfig = { enabled: false, baseUrl: 'https://draft.example/v1', model: 'draft-model',
  autoSummaryOnSave: true, relatedNotesEnabled: false, hasApiKey: true }

test('AI settings acquire a synchronous save lock, block every draft setter and clear action, and synchronize the public acknowledgement', async () => {
  await withSettings(async context => {
    await context.edit(editedDrafts)
    let first!: Promise<void>
    let duplicate!: Promise<void>
    let clear!: Promise<void>
    await act(async () => {
      const current = context.state()
      first = current.saveAiConfig()
      setDrafts(current, draftsFrom(initialConfig, 'bypass-key'))
      duplicate = current.saveAiConfig()
      clear = current.clearAiApiKey()
    })
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].input, settingsInput(editedDrafts))
    assert.deepEqual(context.view().drafts, editedDrafts)
    assert.equal(context.view().saving, true)
    assert.equal(context.view().clearing, false)
    assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
    await context.settle(() => context.requests[0].resolve(acknowledgedConfig), Promise.all([first, duplicate, clear]).then(() => {}))
    assert.deepEqual(context.view().drafts, draftsFrom(acknowledgedConfig))
    assert.deepEqual(context.view().config, acknowledgedConfig)
    assert.equal(context.view().saving, false)
    assert.deepEqual(context.changes, [acknowledgedConfig])
    assert.deepEqual(context.messages, [[getUiText('en-US').aiSettingsSaved, undefined]])
    assert.equal(context.homeReads(), 0)
    assert.equal(context.homeChanges(), 0)
  })
})

test('a failed AI settings save retains all six drafts, reports the clean error and allows a successful retry', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withSettings(async context => {
      await context.edit(editedDrafts)
      const failed = await context.start(() => context.state().saveAiConfig())
      const reason = 'Permission denied. Keep the current draft.'
      await context.settle(() => context.requests[0].reject(new Error("Error invoking remote method 'knowbook:update-ai-config': Error: " + reason)), failed.completion)
      assert.deepEqual(context.view().drafts, editedDrafts)
      assert.deepEqual(context.view().config, initialConfig)
      assert.equal(context.view().saving, false)
      assert.equal(context.view().saveError, reason)
      assert.deepEqual(context.changes, [])
      assert.deepEqual(context.messages, [[reason, 'error']])
      const retry = await context.start(() => context.state().saveAiConfig())
      assert.equal(context.view().saveError, '')
      assert.deepEqual(context.requests[1].input, context.requests[0].input)
      await context.settle(() => context.requests[1].resolve(acknowledgedConfig), retry.completion)
      assert.deepEqual(context.view().drafts, draftsFrom(acknowledgedConfig))
      assert.equal(context.view().saving, false)
      assert.equal(context.view().saveError, '')
      assert.deepEqual(context.messages.at(-1), [getUiText(language).aiSettingsSaved, undefined])
      assert.equal(context.homeReads(), 0)
    }, language)
  }
})

test('a key-only successful save clears the secret draft even when the public configuration is completely unchanged', async () => {
  await withSettings(async context => {
    await context.edit({ apiKey: 'replacement-key' })
    const saving = await context.start(() => context.state().saveAiConfig())
    assert.deepEqual(context.requests[0].input, settingsInput(draftsFrom(initialConfig, 'replacement-key')))
    await context.settle(() => context.requests[0].resolve({ ...initialConfig }), saving.completion)
    assert.deepEqual(context.view().drafts, draftsFrom(initialConfig))
    assert.deepEqual(context.view().config, initialConfig)
    assert.equal(context.view().saving, false)
    assert.equal(context.changes.length, 1)
    assert.deepEqual(context.messages, [[getUiText('en-US').aiSettingsSaved, undefined]])
    assert.equal(context.homeReads(), 0, 'a committed settings result cannot be turned into failure by an unrelated home refresh')
  })
})

test('external AI configuration changes update pristine fields while retaining dirty fields and the unsaved key', async () => {
  await withSettings(async context => {
    await context.edit({ enabled: false, model: 'unsaved-model', apiKey: 'unsaved-key', baseUrl: 'temporary-url' })
    await context.edit({ baseUrl: initialConfig.baseUrl })
    const latest = { ...initialConfig, baseUrl: 'https://external.example/v1', model: 'external-model',
      autoSummaryOnSave: true, relatedNotesEnabled: false, hasApiKey: false }
    await context.external(latest)
    assert.deepEqual(context.view().drafts, { enabled: false, baseUrl: latest.baseUrl, model: 'unsaved-model',
      autoSummaryOnSave: true, relatedNotesEnabled: false, apiKey: 'unsaved-key' })
    await context.external({ ...latest })
    assert.equal(context.view().drafts.apiKey, 'unsaved-key', 'an identical refreshed object cannot clear an unsaved credential')
    const saving = await context.start(() => context.state().saveAiConfig())
    assert.deepEqual(context.requests[0].input, settingsInput(context.view().drafts))
    const saved = { ...latest, enabled: false, model: 'unsaved-model', hasApiKey: true }
    await context.settle(() => context.requests[0].resolve(saved), saving.completion)
    assert.deepEqual(context.view().drafts, draftsFrom(saved))
  })
})

test('opening the clear-key confirmation owns the operation until cancel, preserves drafts and then permits a normal save', async () => {
  await withSettings(async context => {
    await context.edit(editedDrafts)
    let opening!: Promise<void>
    let duplicate!: Promise<void>
    let save!: Promise<void>
    await act(async () => {
      const current = context.state()
      opening = current.clearAiApiKey()
      duplicate = current.clearAiApiKey()
      save = current.saveAiConfig()
    })
    await context.waitForDialog()
    assert.equal(context.document.querySelectorAll('.app-confirm-dialog').length, 1)
    assert.equal(context.requests.length, 0)
    assert.equal(context.view().saving, false)
    assert.equal(context.view().clearing, false)
    assert.deepEqual(context.view().drafts, editedDrafts)
    await context.cancel(Promise.all([opening, duplicate, save]).then(() => {}))
    assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
    assert.deepEqual(context.view().drafts, editedDrafts)
    assert.deepEqual(context.changes, [])
    assert.deepEqual(context.messages, [])
    const saving = await context.start(() => context.state().saveAiConfig())
    assert.equal(context.requests.length, 1, 'cancel releases the operation owner')
    await context.settle(() => context.requests[0].resolve(acknowledgedConfig), saving.completion)
  })
})

test('clear-key confirmation submits the latest saved settings instead of dirty drafts and merges its public result without losing them', async () => {
  await withSettings(async context => {
    await context.edit({ model: 'unsaved-model', apiKey: 'unsaved-key' })
    const clearing = await context.start(() => context.state().clearAiApiKey())
    const latest = { ...initialConfig, enabled: false, baseUrl: 'https://latest.example/v1', model: 'latest-model',
      autoSummaryOnSave: true, relatedNotesEnabled: false }
    await context.external(latest)
    await context.confirm()
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.requests[0].input, clearInput(latest))
    assert.equal('apiKey' in context.requests[0].input, false)
    assert.equal(context.view().saving, true)
    assert.equal(context.view().clearing, true)
    assert.equal(context.document.querySelector('.app-confirm-dialog')?.getAttribute('aria-busy'), 'true')
    const currentDrafts = context.view().drafts
    await act(async () => {
      setDrafts(context.state(), editedDrafts)
      void context.state().saveAiConfig()
      void context.state().clearAiApiKey()
    })
    assert.deepEqual(context.view().drafts, currentDrafts)
    assert.equal(context.requests.length, 1)
    const acknowledged = { ...latest, baseUrl: 'https://canonical.example/v1', hasApiKey: false }
    await context.settle(() => context.requests[0].resolve(acknowledged), clearing.completion)
    assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
    assert.deepEqual(context.view().drafts, { ...draftsFrom(acknowledged), model: 'unsaved-model' })
    assert.deepEqual(context.view().config, acknowledged)
    assert.equal(context.view().saving, false)
    assert.equal(context.view().clearing, false)
    assert.deepEqual(context.changes, [acknowledged])
    assert.deepEqual(context.messages, [[getUiText('en-US').aiApiKeyCleared, undefined]])
    assert.equal(context.homeReads(), 0)
    assert.equal(context.homeChanges(), 0)
  })
})

test('a failed clear-key attempt keeps the real modal retryable, retains operation ownership and retries with the newest saved configuration', async () => {
  await withSettings(async context => {
    await context.edit({ model: 'unsaved-model', apiKey: 'unsaved-key' })
    const clearing = await context.start(() => context.state().clearAiApiKey())
    await context.confirm()
    assert.deepEqual(context.requests[0].input, clearInput(initialConfig))
    await context.settle(() => context.requests[0].reject(new Error("Error invoking remote method 'knowbook:update-ai-config': Error: Permission denied")))
    assert.equal(context.document.querySelector('.app-confirm-dialog [role="alert"]')?.textContent, 'Permission denied')
    assert.equal(context.view().saveError, '', 'a clear-key failure belongs only to its confirmation')
    assert.equal(context.document.querySelector('.app-confirm-dialog .danger-button')?.textContent, 'Retry')
    assert.equal(context.view().saving, false)
    assert.equal(context.view().clearing, false)
    assert.equal(context.view().drafts.model, 'unsaved-model')
    assert.equal(context.view().drafts.apiKey, 'unsaved-key')
    await context.start(() => context.state().saveAiConfig())
    await context.start(() => context.state().clearAiApiKey())
    assert.equal(context.requests.length, 1)
    assert.deepEqual(context.changes, [])
    assert.deepEqual(context.messages, [], 'the confirmation owns its inline failure rather than duplicating a notification')
    const latest = { ...initialConfig, enabled: false, baseUrl: 'https://retry.example/v1', model: 'retry-model',
      autoSummaryOnSave: true, relatedNotesEnabled: false }
    await context.external(latest)
    await context.confirm()
    assert.deepEqual(context.requests[1].input, clearInput(latest))
    assert.equal(context.document.querySelector('.app-confirm-dialog [role="alert"]'), null)
    const acknowledged = { ...latest, hasApiKey: false }
    await context.settle(() => context.requests[1].resolve(acknowledged), clearing.completion)
    assert.deepEqual(context.view().drafts, { ...draftsFrom(acknowledged), model: 'unsaved-model' })
    assert.equal(context.view().clearing, false)
    assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
  })
})

for (const outcome of ['success', 'failure'] as const) {
  test(`an AI settings save completing with ${outcome} after unmount cannot publish to a new session`, async () => {
    await withSettings(async context => {
      await context.edit(editedDrafts)
      const saving = await context.start(() => context.state().saveAiConfig())
      const old = context.state()
      await context.unmount()
      const nextConfig = { ...initialConfig, model: 'new-session-model', hasApiKey: false }
      await context.render(nextConfig)
      await old.saveAiConfig()
      await old.clearAiApiKey()
      assert.equal(context.requests.length, 1)
      assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
      await context.settle(() => outcome === 'success' ? context.requests[0].resolve(acknowledgedConfig)
        : context.requests[0].reject(new Error('Old save failed')), saving.completion)
      assert.deepEqual(context.view().config, nextConfig)
      assert.deepEqual(context.view().drafts, draftsFrom(nextConfig))
      assert.equal(context.view().saving, false)
      assert.equal(context.view().saveError, '')
      assert.deepEqual(context.changes, [])
      assert.deepEqual(context.messages, [])
    })
  })

  test(`a clear-key mutation completing with ${outcome} after unmount cannot report stale results or overwrite a new session`, async () => {
    await withSettings(async context => {
      const clearing = await context.start(() => context.state().clearAiApiKey())
      await context.confirm()
      assert.equal(context.requests.length, 1)
      await context.unmount()
      const nextConfig = { ...initialConfig, model: 'new-session-model' }
      await context.render(nextConfig)
      await context.settle(() => outcome === 'success' ? context.requests[0].resolve({ ...initialConfig, hasApiKey: false })
        : context.requests[0].reject(new Error('Old clear failed')), clearing.completion)
      assert.deepEqual(context.view().config, nextConfig)
      assert.deepEqual(context.view().drafts, draftsFrom(nextConfig))
      assert.equal(context.view().saving, false)
      assert.equal(context.view().clearing, false)
      assert.equal(context.view().saveError, '')
      assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
      assert.deepEqual(context.changes, [])
      assert.deepEqual(context.messages, [])
    })
  })
}

test('confirming a clear-key dialog after its settings owner unmounted sends no mutation', async () => {
  await withSettings(async context => {
    const clearing = await context.start(() => context.state().clearAiApiKey())
    await context.unmount()
    await context.confirm()
    await context.settle(() => {}, clearing.completion)
    assert.equal(context.requests.length, 0)
    assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
    assert.deepEqual(context.changes, [])
    assert.deepEqual(context.messages, [])
  })
})

test('an AI save error survives external configuration updates and draft corrections until a new accepted save', async () => {
  await withSettings(async context => {
    await context.edit({ model: 'unsaved-model', apiKey: 'unsaved-key' })
    const failed = await context.start(() => context.state().saveAiConfig())
    const reason = 'The current settings could not be stored'
    await context.settle(() => context.requests[0].reject(new Error(reason)), failed.completion)
    assert.equal(context.view().saveError, reason)
    const external = { ...initialConfig, baseUrl: 'https://external.example/v1', model: 'external-model',
      autoSummaryOnSave: true, hasApiKey: false }
    await context.external(external)
    assert.equal(context.view().saveError, reason)
    assert.deepEqual(context.view().drafts, { ...draftsFrom(external, 'unsaved-key'), model: 'unsaved-model' })
    await context.edit({ model: 'corrected-model' })
    assert.equal(context.view().saveError, reason, 'editing must not silently acknowledge a failed write')
    let retry!: Promise<void>
    await act(async () => {
      const current = context.state()
      retry = current.saveAiConfig()
      void current.saveAiConfig()
      void current.clearAiApiKey()
    })
    assert.equal(context.requests.length, 2)
    assert.equal(context.view().saveError, '')
    assert.equal(context.view().saving, true)
    assert.deepEqual(context.requests[1].input, settingsInput(context.view().drafts))
    const acknowledged = { ...external, model: 'corrected-model', hasApiKey: true }
    await context.settle(() => context.requests[1].resolve(acknowledged), retry)
    assert.equal(context.view().saveError, '')
    assert.deepEqual(context.view().drafts, draftsFrom(acknowledged))
    assert.equal(context.document.querySelector('.app-confirm-dialog'), null)
  })
})

test('opening, blocked saving and cancelling Clear preserve a save error, while a confirmed Clear transfers feedback to its modal', async () => {
  await withSettings(async context => {
    await context.edit(editedDrafts)
    const failed = await context.start(() => context.state().saveAiConfig())
    const reason = 'Original AI save failure'
    await context.settle(() => context.requests[0].reject(new Error(reason)), failed.completion)
    const cancelledClear = await context.start(() => context.state().clearAiApiKey())
    await context.waitForDialog()
    await context.start(() => context.state().saveAiConfig())
    assert.equal(context.requests.length, 1)
    assert.equal(context.view().saveError, reason)
    await context.cancel(cancelledClear.completion)
    assert.equal(context.view().saveError, reason)
    assert.deepEqual(context.view().drafts, editedDrafts)
    const clear = await context.start(() => context.state().clearAiApiKey())
    await context.waitForDialog()
    assert.equal(context.view().saveError, reason)
    await context.confirm()
    assert.equal(context.view().saveError, '')
    assert.deepEqual(context.requests[1].input, clearInput(initialConfig))
    await context.settle(() => context.requests[1].reject(new Error('Controlled clear failure')))
    assert.equal(context.document.querySelector('.app-confirm-dialog [role="alert"]')?.textContent, 'Controlled clear failure')
    assert.equal(context.view().saveError, '')
    assert.deepEqual(context.view().drafts, editedDrafts)
    assert.deepEqual(context.messages, [[reason, 'error']], 'the modal failure must not duplicate the ordinary save feedback')
    await context.cancel(clear.completion)
    assert.equal(context.view().saveError, '')
  })
})

test('empty and non-Error AI save failures use the localized settings fallback without changing nonempty reasons', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withSettings(async context => {
      await context.edit({ apiKey: 'retained-unsaved-key' })
      for (const error of [new Error("Error invoking remote method 'knowbook:update-ai-config': Error: "),
        new Error('   '), 'plain non-Error rejection']) {
        const saving = await context.start(() => context.state().saveAiConfig())
        assert.equal(context.view().saveError, '')
        await context.settle(() => context.requests.at(-1)!.reject(error), saving.completion)
        assert.equal(context.view().saveError, getUiText(language).aiSettingsSaveFailed)
        assert.deepEqual(context.messages.at(-1), [getUiText(language).aiSettingsSaveFailed, 'error'])
        assert.equal(context.view().drafts.apiKey, 'retained-unsaved-key')
        assert.deepEqual(context.view().config, initialConfig)
      }
    }, language)
  }
})

test('an old unmounted AI save cannot overwrite or clear a newer session save failure', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withSettings(async context => {
      const old = await context.start(() => context.state().saveAiConfig())
      const oldRequest = context.requests[0]
      await context.unmount()
      const next = { ...initialConfig, model: 'new-session-model' }
      await context.render(next)
      await context.edit({ model: 'new-session-draft', apiKey: 'new-session-key' })
      const current = await context.start(() => context.state().saveAiConfig())
      await context.settle(() => context.requests[1].reject(new Error('Current session save failed')), current.completion)
      const drafts = context.view().drafts
      await context.settle(() => outcome === 'success' ? oldRequest.resolve(acknowledgedConfig)
        : oldRequest.reject(new Error('Old session save failed')), old.completion)
      assert.equal(context.view().saveError, 'Current session save failed')
      assert.deepEqual(context.view().config, next)
      assert.deepEqual(context.view().drafts, drafts)
      assert.equal(context.view().saving, false)
      assert.deepEqual(context.changes, [])
      assert.deepEqual(context.messages, [['Current session save failed', 'error']])
    })
  }
})
