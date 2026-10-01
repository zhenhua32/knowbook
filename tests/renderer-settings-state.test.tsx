import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { AppUpdateState, ElectronApi, UpdateWebClipBridgeSettingsInput, WebClipBridgeStatus } from '../src/shared/contracts'
import { useSettingsState } from '../src/renderer/src/hooks/useSettingsState'
import { getUiText, type UiText } from '../src/renderer/src/i18n'
import type { AppMessageHandler } from '../src/renderer/src/notify'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const updateState: AppUpdateState = { status: 'idle', currentVersion: '1.0.0', availableVersion: null,
  downloadedVersion: null, releaseName: null, releaseNotes: null, checkedAt: null, progressPercent: null,
  message: '', error: null, updatesEnabled: true, canInstall: false }
const bridgeStatus: WebClipBridgeStatus = { enabled: true, running: true, port: 3210, configuredPort: 3210,
  token: 'local-bridge-token', endpoint: 'http://127.0.0.1:3210/clip', lastError: null }
type State = ReturnType<typeof useSettingsState>
type Context = {
  state: () => State;
  document: Document;
  messages: [string | null, string | undefined][];
  calls: {
    check: ReturnType<typeof deferred<AppUpdateState>>[];
    install: ReturnType<typeof deferred<void>>[];
    bridge: (ReturnType<typeof deferred<WebClipBridgeStatus>> & { input: UpdateWebClipBridgeSettingsInput })[];
    clipboard: (ReturnType<typeof deferred<void>> & { text: string })[];
  };
  start: (action: () => Promise<void>) => Promise<{ completion: Promise<void> }>;
  fail: (request: { reject: (error: unknown) => void }, error: unknown, completion: Promise<void>) => Promise<void>;
  drafts: (enabled: boolean, port: string) => Promise<void>;
}

async function withSettings(language: 'zh-CN' | 'en-US', run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const messages: Context['messages'] = []
  const calls: Context['calls'] = { check: [], install: [], bridge: [], clipboard: [] }
  const api: Pick<ElectronApi, 'getAppUpdateState' | 'getWebClipBridgeStatus' | 'checkForAppUpdates' | 'installAppUpdate' | 'updateWebClipBridgeSettings' | 'writeClipboardText'> = {
    getAppUpdateState: async () => updateState,
    getWebClipBridgeStatus: async () => bridgeStatus,
    checkForAppUpdates: () => { const request = deferred<AppUpdateState>(); calls.check.push(request); return request.promise },
    installAppUpdate: () => { const request = deferred<void>(); calls.install.push(request); return request.promise },
    updateWebClipBridgeSettings: input => { const request = { ...deferred<WebClipBridgeStatus>(), input }; calls.bridge.push(request); return request.promise },
    writeClipboardText: text => { const request = { ...deferred<void>(), text }; calls.clipboard.push(request); return request.promise }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let state!: State
  const onMessage: AppMessageHandler = (message, level) => { messages.push([message, level]) }
  function Harness() {
    state = useSettingsState({ isSettingsPageActive: false, ui: getUiText(language), onMessage })
    return createElement('div', { 'data-update-busy': String(state.appUpdateRefreshing), 'data-bridge-busy': String(state.webClipBridgeSaving),
      'data-bridge-copying': state.webClipBridgeCopying ?? '',
      'data-bridge-action-error': JSON.stringify(state.webClipBridgeActionError) },
      state.webClipBridgePortDraft)
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    assert.equal(state.webClipBridgeStatus, bridgeStatus)
    await run({ state: () => state, document: dom.window.document, messages, calls,
      start: async action => {
        let completion!: Promise<void>
        await act(async () => { completion = action() })
        return { completion }
      },
      fail: async (request, error, completion) => { await act(async () => { request.reject(error); await completion }) },
      drafts: async (enabled, port) => { await act(async () => { state.setWebClipBridgeEnabledDraft(enabled); state.setWebClipBridgePortDraft(port) }) }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function operations(context: Context, ui: UiText) {
  return [
    { name: 'check-for-app-updates', prefix: ui.appUpdateCheckFailed, run: () => context.state().checkForAppUpdates(), request: () => context.calls.check.at(-1)! },
    { name: 'install-app-update', prefix: ui.appUpdateInstallFailed, run: () => context.state().installAppUpdate(), request: () => context.calls.install.at(-1)! },
    { name: 'update-web-clip-bridge-settings', prefix: ui.webClipBridgeSaveFailed, run: () => context.state().saveWebClipBridgeSettings(), request: () => context.calls.bridge.at(-1)! },
    { name: 'update-web-clip-bridge-settings', prefix: ui.webClipBridgeTokenRefreshFailed, regenerateToken: true,
      run: () => context.state().saveWebClipBridgeSettings(true), request: () => context.calls.bridge.at(-1)! },
    { name: 'copy-web-clip-endpoint', prefix: ui.copyFailed, run: () => context.state().copyWebClipBridgeEndpoint(), request: () => context.calls.clipboard.at(-1)! },
    { name: 'copy-web-clip-token', prefix: ui.copyFailed, run: () => context.state().copyWebClipBridgeToken(), request: () => context.calls.clipboard.at(-1)! }
  ]
}

test('settings failures append the clean reason after the localized prefix and preserve draft and retry behavior', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withSettings(language, async context => {
      await context.drafts(false, '4321')
      for (const operation of operations(context, getUiText(language))) {
        const { completion } = await context.start(operation.run)
        if (operation.name === 'check-for-app-updates') assert.equal(context.document.querySelector('[data-update-busy]')!.getAttribute('data-update-busy'), 'true')
        if (operation.name === 'copy-web-clip-endpoint' || operation.name === 'copy-web-clip-token') {
          const kind = operation.name === 'copy-web-clip-endpoint' ? 'endpoint' : 'token'
          assert.equal(context.state().webClipBridgeCopying, kind)
          assert.equal(context.document.querySelector('[data-bridge-copying]')!.getAttribute('data-bridge-copying'), kind)
        }
        if (operation.name === 'update-web-clip-bridge-settings') {
          assert.equal(context.document.querySelector('[data-bridge-busy]')!.getAttribute('data-bridge-busy'), 'true')
          const regenerate = 'regenerateToken' in operation && operation.regenerateToken
          assert.deepEqual(context.calls.bridge.at(-1)!.input, { enabled: regenerate ? true : false,
            port: regenerate ? 3210 : 4321, regenerateToken: Boolean(regenerate) })
          assert.equal(context.state().webClipBridgeActionError, null)
        }
        const reason = 'Permission denied for C:/Notes/Error: Review.md\nCheck write permission.'
        await context.fail(operation.request(), new Error(`Error invoking remote method 'knowbook:${operation.name}': Error: ${reason}`), completion)
        assert.deepEqual(context.messages.at(-1), [`${operation.prefix} ${reason}`, 'error'])
        if (operation.name === 'update-web-clip-bridge-settings') {
          const expected = { kind: 'regenerateToken' in operation && operation.regenerateToken ? 'regenerate' : 'save',
            message: `${operation.prefix} ${reason}` }
          assert.deepEqual(context.state().webClipBridgeActionError, expected)
          assert.deepEqual(JSON.parse(context.document.querySelector('[data-bridge-action-error]')!.getAttribute('data-bridge-action-error')!), expected)
        }
        assert.equal(context.state().appUpdateRefreshing, false)
        assert.equal(context.state().webClipBridgeSaving, false)
        assert.equal(context.state().webClipBridgeCopying, null)
        assert.equal(context.document.querySelector('[data-bridge-copying]')!.getAttribute('data-bridge-copying'), '')
        assert.equal(context.state().appUpdateState, updateState)
        assert.equal(context.state().webClipBridgeStatus, bridgeStatus)
        assert.equal(context.state().webClipBridgeEnabledDraft, false)
        assert.equal(context.state().webClipBridgePortDraft, '4321')
      }
      assert.deepEqual(context.calls.clipboard.map(request => request.text), [bridgeStatus.endpoint, bridgeStatus.token])
      const { completion } = await context.start(() => context.state().saveWebClipBridgeSettings(true))
      assert.equal(context.state().webClipBridgeActionError, null)
      assert.deepEqual(context.calls.bridge.at(-1)!.input, { enabled: true, port: 3210, regenerateToken: true })
      const saved = { ...bridgeStatus, token: 'new-local-token' }
      await act(async () => { context.calls.bridge.at(-1)!.resolve(saved); await completion })
      assert.equal(context.state().webClipBridgeStatus, saved)
      assert.equal(context.state().webClipBridgeEnabledDraft, false)
      assert.equal(context.state().webClipBridgePortDraft, '4321')
      assert.equal(context.state().webClipBridgeSaving, false)
      assert.equal(context.state().webClipBridgeActionError, null)
      assert.deepEqual(context.messages.at(-1), [getUiText(language).webClipBridgeTokenRefreshed, undefined])
    })
  }
})

test('empty packaged exceptions and non-Error rejections use only the localized settings failure message', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withSettings(language, async context => {
      for (const operation of operations(context, getUiText(language))) {
        for (const error of [new Error(`Error invoking remote method 'knowbook:${operation.name}': Error: `), new Error('   '), 'plain non-Error rejection']) {
          const { completion } = await context.start(operation.run)
          await context.fail(operation.request(), error, completion)
          assert.deepEqual(context.messages.at(-1), [operation.prefix, 'error'])
          if (operation.name === 'update-web-clip-bridge-settings') {
            const expected = { kind: 'regenerateToken' in operation && operation.regenerateToken ? 'regenerate' : 'save', message: operation.prefix }
            assert.deepEqual(context.state().webClipBridgeActionError, expected)
            assert.deepEqual(JSON.parse(context.document.querySelector('[data-bridge-action-error]')!.getAttribute('data-bridge-action-error')!), expected)
          }
          assert.equal(context.state().appUpdateRefreshing, false)
          assert.equal(context.state().webClipBridgeSaving, false)
          assert.equal(context.state().webClipBridgeCopying, null)
        }
      }
    })
  }
})
