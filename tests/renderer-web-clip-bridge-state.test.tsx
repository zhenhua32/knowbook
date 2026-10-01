import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode } from 'react'
import { JSDOM } from 'jsdom'
import type { AppUpdateState, ElectronApi, UpdateWebClipBridgeSettingsInput, WebClipBridgeStatus } from '../src/shared/contracts'
import { useSettingsState } from '../src/renderer/src/hooks/useSettingsState'
import { getUiText } from '../src/renderer/src/i18n'
import type { AppMessageHandler } from '../src/renderer/src/notify'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const status = (port = 4321, token = 'local-token'): WebClipBridgeStatus => ({ enabled: true, running: true,
  port, configuredPort: port, token, endpoint: `http://127.0.0.1:${port}/clip`, lastError: null })
const updateState: AppUpdateState = { status: 'idle', currentVersion: '1.0.0', availableVersion: null,
  downloadedVersion: null, releaseName: null, releaseNotes: null, checkedAt: null, progressPercent: null,
  message: '', error: null, updatesEnabled: true, canInstall: false }
type State = ReturnType<typeof useSettingsState>
type Read = ReturnType<typeof deferred<WebClipBridgeStatus>>
type Save = Read & { input: UpdateWebClipBridgeSettingsInput }
type Copy = ReturnType<typeof deferred<void>> & { text: string }
type CopyKind = Exclude<State['webClipBridgeCopying'], null>
type View = {
  status: WebClipBridgeStatus | null; enabled: boolean; port: string;
  loading: boolean; error: string | null; portError: string | null; saving: boolean;
  actionError: State['webClipBridgeActionError'];
  copying: State['webClipBridgeCopying'];
}
type Context = {
  state: () => State; view: () => View;
  reads: Read[]; saves: Save[]; copies: Copy[];
  messages: [string | null, string | undefined][];
  start: (action: () => Promise<void>) => Promise<{ completion: Promise<void> }>;
  edit: (enabled: boolean, port: string) => Promise<void>;
  settle: (action: () => void, completion?: Promise<void>) => Promise<void>;
  poll: () => Promise<void>;
  render: (active?: boolean, language?: 'zh-CN' | 'en-US') => Promise<void>;
  unmount: () => Promise<void>;
  timerCount: () => number;
}

async function withBridge(run: (context: Context) => Promise<void>, options: {
  language?: 'zh-CN' | 'en-US'; active?: boolean; strict?: boolean; updateFailure?: boolean
} = {}) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const timers = new Map<number, () => void>()
  const reads: Read[] = []
  const saves: Save[] = []
  const copies: Copy[] = []
  const messages: Context['messages'] = []
  let timerId = 0
  const interval = (callback: () => void) => { timers.set(++timerId, callback); return timerId }
  const clear = (id: number) => { timers.delete(id) }
  dom.window.setInterval = interval
  dom.window.clearInterval = clear
  const api: Pick<ElectronApi, 'getAppUpdateState' | 'getWebClipBridgeStatus' | 'checkForAppUpdates' | 'installAppUpdate' | 'updateWebClipBridgeSettings' | 'writeClipboardText'> = {
    getAppUpdateState: async () => { if (options.updateFailure) throw new Error('Update status temporarily unavailable'); return updateState },
    getWebClipBridgeStatus: () => { const request = deferred<WebClipBridgeStatus>(); reads.push(request); return request.promise },
    checkForAppUpdates: async () => updateState,
    installAppUpdate: async () => {},
    updateWebClipBridgeSettings: input => { const request = { ...deferred<WebClipBridgeStatus>(), input }; saves.push(request); return request.promise },
    writeClipboardText: text => { const request = { ...deferred<void>(), text }; copies.push(request); return request.promise }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, setInterval: interval, clearInterval: clear, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const previousWarn = console.warn
  if (options.updateFailure) console.warn = () => {}
  const { createRoot } = await import('react-dom/client')
  const mount = dom.window.document.getElementById('mount')!
  let root = createRoot(mount)
  let hasRoot = true
  let state!: State
  let active = options.active ?? false
  let language = options.language ?? 'zh-CN'
  const onMessage: AppMessageHandler = (message, level) => { messages.push([message, level]) }
  function Harness({ active }: { active: boolean }) {
    state = useSettingsState({ isSettingsPageActive: active, ui: getUiText(language), onMessage })
    const view: View = { status: state.webClipBridgeStatus, enabled: state.webClipBridgeEnabledDraft,
      port: state.webClipBridgePortDraft, loading: state.webClipBridgeLoading,
      error: state.webClipBridgeLoadError, portError: state.webClipBridgePortError, saving: state.webClipBridgeSaving,
      actionError: state.webClipBridgeActionError, copying: state.webClipBridgeCopying }
    return createElement('output', { 'data-testid': 'bridge-state' }, JSON.stringify(view))
  }
  const render = async (nextActive = active, nextLanguage = language) => {
    active = nextActive
    language = nextLanguage
    if (!hasRoot) { root = createRoot(mount); hasRoot = true }
    const element = createElement(Harness, { active })
    await act(async () => root.render(options.strict ? createElement(StrictMode, null, element) : element))
  }
  const unmount = async () => { if (hasRoot) { await act(async () => root.unmount()); hasRoot = false } }
  try {
    await render()
    await run({ state: () => state, view: () => JSON.parse(mount.querySelector('output')!.textContent!) as View,
      reads, saves, copies, messages, render, unmount, timerCount: () => timers.size,
      start: async action => {
        let completion!: Promise<void>
        await act(async () => { completion = action() })
        return { completion }
      },
      edit: async (enabled, port) => { await act(async () => { state.setWebClipBridgeEnabledDraft(enabled); state.setWebClipBridgePortDraft(port) }) },
      settle: async (action, completion) => { await act(async () => { action(); await completion }) },
      poll: async () => { await act(async () => { [...timers.values()].forEach(callback => callback()) }) }
    })
  } finally {
    await unmount()
    console.warn = previousWarn
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('an unknown bridge configuration blocks edits and writes, and a failed initial read can initialize the real drafts on retry', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withBridge(async context => {
      assert.equal(context.reads.length, 1)
      assert.deepEqual(context.view(), { status: null, enabled: false, port: '3210', loading: true, error: null, portError: null, saving: false, actionError: null, copying: null })
      await context.edit(true, '9999')
      await context.start(() => context.state().saveWebClipBridgeSettings())
      await context.start(() => context.state().saveWebClipBridgeSettings(true))
      assert.equal(context.saves.length, 0)
      assert.equal(context.view().enabled, false)
      assert.equal(context.view().port, '3210')
      const reason = language === 'zh-CN' ? '读取配置暂时失败' : ''
      await context.settle(() => context.reads[0].reject(new Error(`Error invoking remote method 'knowbook:get-web-clip-bridge-status': Error: ${reason}`)))
      const error = reason ? `${getUiText(language).webClipBridgeLoadFailed} ${reason}` : getUiText(language).webClipBridgeLoadFailed
      assert.equal(context.view().loading, false)
      assert.equal(context.view().error, error)
      assert.equal(context.view().status, null)
      await context.edit(true, '9999')
      assert.equal(context.view().port, '3210')
      const { completion } = await context.start(() => context.state().reloadWebClipBridgeStatus())
      assert.equal(context.view().loading, true)
      assert.equal(context.view().error, error, 'a pending retry keeps the existing failure available to its inline UI')
      const actual = status(4789)
      await context.settle(() => context.reads[1].resolve(actual), completion)
      assert.deepEqual(context.view(), { status: actual, enabled: true, port: '4789', loading: false, error: null, portError: null, saving: false, actionError: null, copying: null })
      const saved = await context.start(() => context.state().saveWebClipBridgeSettings())
      assert.deepEqual(context.saves[0].input, { enabled: true, port: 4789, regenerateToken: false })
      await context.settle(() => context.saves[0].resolve(actual), saved.completion)
    }, { language })
  }
})

test('a successful background poll initializes drafts after initial failure even when update-state reads fail independently', async () => {
  await withBridge(async context => {
    assert.equal(context.reads.length, 1)
    await context.settle(() => context.reads[0].reject(new Error('temporary bridge read failure')))
    assert.equal(context.view().status, null)
    assert.equal(context.timerCount(), 1)
    await context.poll()
    assert.equal(context.reads.length, 2)
    assert.equal(context.view().loading, true)
    const actual = status(5678)
    await context.settle(() => context.reads[1].resolve(actual))
    assert.equal(context.view().status?.port, 5678)
    assert.equal(context.view().enabled, true)
    assert.equal(context.view().port, '5678')
    assert.equal(context.view().error, null)
    assert.equal(context.state().appUpdateState, null, 'an unrelated failed update read does not withhold a valid bridge response')
    await context.render(false)
    assert.equal(context.timerCount(), 0)
  }, { active: true, updateFailure: true })
})

test('disabled and failed bridge services initialize the saved port independently of their nullable runtime port', async () => {
  const configurations: WebClipBridgeStatus[] = [
    { enabled: false, running: false, port: null, configuredPort: 4321, token: 'local-token', endpoint: null, lastError: null },
    { enabled: true, running: false, port: null, configuredPort: 5432, token: 'local-token', endpoint: null, lastError: 'Address already in use' }
  ]
  for (const configuration of configurations) {
    await withBridge(async context => {
      await context.settle(() => context.reads[0].resolve(configuration))
      assert.equal(context.view().status?.running, false)
      assert.equal(context.view().status?.port, null)
      assert.equal(context.view().enabled, configuration.enabled)
      assert.equal(context.view().port, String(configuration.configuredPort), 'the form retains the configured port even without a listening server')
      assert.equal(context.view().loading, false)
      assert.equal(context.view().error, null)
    })
  }
})

test('in-flight manual reloads and repeated poll ticks share one bridge read without prematurely clearing its loading state', async () => {
  await withBridge(async context => {
    const first = await context.start(() => context.state().reloadWebClipBridgeStatus())
    const duplicate = await context.start(() => context.state().reloadWebClipBridgeStatus())
    for (let index = 0; index < 3; index++) await context.poll()
    assert.equal(context.reads.length, 1)
    assert.equal(context.view().loading, true)
    await context.settle(() => context.reads[0].resolve(status()), Promise.all([first.completion, duplicate.completion]).then(() => {}))
    assert.equal(context.view().loading, false)
    const next = await context.start(() => context.state().reloadWebClipBridgeStatus())
    await context.poll()
    assert.equal(context.reads.length, 2)
    assert.equal(context.view().loading, true)
    await context.settle(() => context.reads[1].resolve(status(6789)), next.completion)
    assert.equal(context.view().status?.port, 6789)
    assert.equal(context.view().port, '4321', 'later reads update runtime state without reinitializing the form')
  }, { active: true })
})

test('known refresh failures retain the last status and dirty drafts through a loading retry and successful recovery', async () => {
  await withBridge(async context => {
    const known = status()
    await context.settle(() => context.reads[0].resolve(known))
    await context.edit(false, '5678')
    const failed = await context.start(() => context.state().reloadWebClipBridgeStatus())
    await context.settle(() => context.reads[1].reject(new Error("Error invoking remote method 'knowbook:get-web-clip-bridge-status': Error: temporarily unavailable")), failed.completion)
    assert.deepEqual(context.view().status, known)
    assert.equal(context.view().enabled, false)
    assert.equal(context.view().port, '5678')
    const error = context.view().error
    assert.equal(error, `${getUiText('zh-CN').webClipBridgeLoadFailed} temporarily unavailable`)
    const retry = await context.start(() => context.state().reloadWebClipBridgeStatus())
    assert.equal(context.view().loading, true)
    assert.equal(context.view().error, error)
    await context.settle(() => context.reads[2].resolve(status(6789)), retry.completion)
    assert.equal(context.view().status?.port, 6789)
    assert.equal(context.view().enabled, false)
    assert.equal(context.view().port, '5678')
    assert.equal(context.view().error, null)
    assert.deepEqual(context.messages, [], 'poll failures are represented inline instead of generating repeated notifications')
  })
})

test('invalid decimal port drafts report an inline error without saving, and correcting them permits an explicit configuration save', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withBridge(async context => {
      const known = status()
      await context.settle(() => context.reads[0].resolve(known))
      assert.equal(context.view().portError, null)
      for (const draft of ['', '   ', '0', '65536', '-1', '+4321', '4321.9', '1e4', '0x10', '4321notes', '4 321', '４３２１']) {
        await context.edit(false, draft)
        const portError = context.view().portError
        assert.ok(portError, `the ${JSON.stringify(draft)} draft must expose a validation error`)
        assert.equal(portError, getUiText(language).webClipBridgePortInvalid)
        const { completion } = await context.start(() => context.state().saveWebClipBridgeSettings())
        await completion
        assert.equal(context.saves.length, 0, `invalid ${JSON.stringify(draft)} must never reach persistence`)
        assert.equal(context.view().saving, false)
        assert.deepEqual(context.view().status, known)
        assert.equal(context.view().enabled, false)
        assert.equal(context.view().port, draft, 'invalid input stays available to correct instead of silently replacing it')
        assert.equal(context.view().portError, portError)
      }
      assert.deepEqual(context.messages, [], 'validation stays inline instead of emitting a success or error notification')
      for (const [draft, port] of [['1', 1], ['65535', 65535], [' \t04321\n ', 4321]] as const) {
        await context.edit(false, draft)
        assert.equal(context.view().portError, null, 'the error clears as soon as the input becomes valid')
        const { completion } = await context.start(() => context.state().saveWebClipBridgeSettings())
        assert.deepEqual(context.saves.at(-1)!.input, { enabled: false, port, regenerateToken: false })
        const saved = { ...status(port), enabled: false, running: false, port: null, endpoint: null }
        await context.settle(() => context.saves.at(-1)!.resolve(saved), completion)
        assert.equal(context.view().port, String(port), 'only an explicit successful settings save synchronizes the draft')
        assert.equal(context.view().portError, null)
      }
      assert.equal(context.saves.length, 3)
    }, { language })
  }
})

test('an invalid settings save does not invalidate an already pending status read or clear its loading state', async () => {
  await withBridge(async context => {
    await context.settle(() => context.reads[0].resolve(status()))
    await context.edit(false, '65536')
    const portError = context.view().portError
    assert.ok(portError)
    const read = await context.start(() => context.state().reloadWebClipBridgeStatus())
    const save = await context.start(() => context.state().saveWebClipBridgeSettings())
    await save.completion
    assert.equal(context.view().loading, true)
    assert.equal(context.view().saving, false)
    assert.equal(context.saves.length, 0)
    const latest = status(6789)
    await context.settle(() => context.reads[1].resolve(latest), read.completion)
    assert.deepEqual(context.view().status, latest)
    assert.equal(context.view().loading, false)
    assert.equal(context.view().enabled, false)
    assert.equal(context.view().port, '65536')
    assert.equal(context.view().portError, portError)
    assert.deepEqual(context.messages, [])
  })
})

test('token regeneration preserves valid or invalid unsaved drafts and blocks duplicate writes while updating only the saved configuration', async () => {
  for (const port of ['5432', ''] as const) {
    await withBridge(async context => {
      const known = status()
      await context.settle(() => context.reads[0].resolve(known))
      await context.edit(false, port)
      const portError = context.view().portError
      assert.equal(portError, port === '' ? getUiText('zh-CN').webClipBridgePortInvalid : null)
      let first!: Promise<void>
      let duplicate!: Promise<void>
      let refresh!: Promise<void>
      await act(async () => {
        const current = context.state()
        first = current.saveWebClipBridgeSettings(true)
        current.setWebClipBridgeEnabledDraft(true)
        current.setWebClipBridgePortDraft('9999')
        duplicate = current.saveWebClipBridgeSettings(true)
        refresh = current.reloadWebClipBridgeStatus()
      })
      await context.poll()
      assert.equal(context.saves.length, 1)
      assert.equal(context.reads.length, 1)
      assert.deepEqual(context.saves[0].input, { enabled: true, port: 4321, regenerateToken: true })
      assert.equal(context.view().saving, true)
      assert.equal(context.state().webClipBridgeRegenerating, true)
      assert.equal(context.view().enabled, false)
      assert.equal(context.view().port, port)
      const regenerated = { ...known, token: 'new-token' }
      await context.settle(() => context.saves[0].resolve(regenerated), Promise.all([first, duplicate, refresh]).then(() => {}))
      assert.deepEqual(context.view().status, regenerated)
      assert.equal(context.view().enabled, false, 'refreshing a credential must not apply or discard the unsaved enabled setting')
      assert.equal(context.view().port, port)
      assert.equal(context.view().portError, portError)
      assert.equal(context.view().saving, false)
      assert.equal(context.state().webClipBridgeRegenerating, false)
      assert.deepEqual(context.messages, [[getUiText('zh-CN').webClipBridgeTokenRefreshed, undefined]])
    }, { active: true })
  }
})

test('token regeneration uses the latest saved status, survives a failure, and leaves an invalid draft for a later explicit save', async () => {
  await withBridge(async context => {
    await context.settle(() => context.reads[0].resolve(status()))
    await context.edit(true, '')
    const portError = context.view().portError
    const read = await context.start(() => context.state().reloadWebClipBridgeStatus())
    const latest = { ...status(5432), enabled: false, running: false, port: null, endpoint: null }
    await context.settle(() => context.reads[1].resolve(latest), read.completion)
    assert.equal(context.view().enabled, true)
    assert.equal(context.view().port, '')
    const failed = await context.start(() => context.state().saveWebClipBridgeSettings(true))
    assert.equal(context.state().webClipBridgeRegenerating, true)
    assert.deepEqual(context.saves[0].input, { enabled: false, port: 5432, regenerateToken: true })
    await context.settle(() => context.saves[0].reject(new Error("Error invoking remote method 'knowbook:update-web-clip-bridge-settings': Error: write permission denied")), failed.completion)
    assert.deepEqual(context.view().status, latest)
    assert.equal(context.view().saving, false)
    assert.equal(context.state().webClipBridgeRegenerating, false)
    assert.equal(context.view().enabled, true)
    assert.equal(context.view().port, '')
    assert.equal(context.view().portError, portError)
    const actionError = { kind: 'regenerate', message: `${getUiText('zh-CN').webClipBridgeTokenRefreshFailed} write permission denied` }
    assert.deepEqual(context.view().actionError, actionError)
    assert.deepEqual(context.messages.at(-1), [actionError.message, 'error'])
    const retry = await context.start(() => context.state().saveWebClipBridgeSettings(true))
    assert.equal(context.view().actionError, null)
    assert.deepEqual(context.saves[1].input, { enabled: false, port: 5432, regenerateToken: true })
    const regenerated = { ...latest, token: 'new-disabled-token' }
    await context.settle(() => context.saves[1].resolve(regenerated), retry.completion)
    assert.deepEqual(context.view().status, regenerated)
    assert.equal(context.view().enabled, true)
    assert.equal(context.view().port, '')
    assert.equal(context.view().portError, portError)
    assert.equal(context.view().actionError, null)
    await context.edit(true, '5678')
    const save = await context.start(() => context.state().saveWebClipBridgeSettings())
    assert.deepEqual(context.saves[2].input, { enabled: true, port: 5678, regenerateToken: false })
    assert.equal(context.state().webClipBridgeRegenerating, false)
    const saved = status(5678, 'new-disabled-token')
    await context.settle(() => context.saves[2].resolve(saved), save.completion)
    assert.deepEqual(context.view().status, saved)
    assert.equal(context.view().port, '5678')
    assert.equal(context.view().portError, null)
  })
})

test('saving blocks setters, duplicate writes and refreshes synchronously, then synchronizes drafts from the saved response', async () => {
  await withBridge(async context => {
    await context.settle(() => context.reads[0].resolve(status()))
    await context.edit(true, '4789')
    let first!: Promise<void>
    let duplicate!: Promise<void>
    let refresh!: Promise<void>
    await act(async () => {
      const current = context.state()
      first = current.saveWebClipBridgeSettings()
      current.setWebClipBridgeEnabledDraft(false)
      current.setWebClipBridgePortDraft('9999')
      duplicate = current.saveWebClipBridgeSettings()
      refresh = current.reloadWebClipBridgeStatus()
    })
    await context.poll()
    assert.equal(context.saves.length, 1)
    assert.equal(context.reads.length, 1)
    assert.deepEqual(context.saves[0].input, { enabled: true, port: 4789, regenerateToken: false })
    assert.equal(context.view().saving, true)
    assert.equal(context.view().enabled, true)
    assert.equal(context.view().port, '4789')
    const saved = status(4789)
    await context.settle(() => context.saves[0].resolve(saved), Promise.all([first, duplicate, refresh]).then(() => {}))
    assert.deepEqual(context.view(), { status: saved, enabled: true, port: '4789', loading: false, error: null, portError: null, saving: false, actionError: null, copying: null })
    assert.deepEqual(context.messages, [[getUiText('zh-CN').webClipBridgeSaved(true), undefined]])
  }, { active: true })
})

test('a pre-save read arriving after save cannot overwrite saved data, raise an error or finish a newer read', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withBridge(async context => {
      await context.settle(() => context.reads[0].resolve(status()))
      await context.edit(true, '4789')
      const oldRead = await context.start(() => context.state().reloadWebClipBridgeStatus())
      const saving = await context.start(() => context.state().saveWebClipBridgeSettings())
      const saved = status(4789, 'saved-token')
      await context.settle(() => context.saves[0].resolve(saved), saving.completion)
      const freshRead = await context.start(() => context.state().reloadWebClipBridgeStatus())
      assert.equal(context.reads.length, 3)
      await context.settle(() => outcome === 'success' ? context.reads[1].resolve(status(4321, 'old-token'))
        : context.reads[1].reject(new Error('late pre-save read failed')), oldRead.completion)
      assert.deepEqual(context.view().status, saved)
      assert.equal(context.view().port, '4789')
      assert.equal(context.view().error, null)
      assert.equal(context.view().loading, true, 'the old read finally cannot clear the newer read loading state')
      assert.equal(context.messages.length, 1)
      await context.settle(() => context.reads[2].resolve(saved), freshRead.completion)
      assert.equal(context.view().loading, false)
      assert.equal(context.view().status?.token, 'saved-token')
    })
  }
})

test('a read started before token regeneration cannot restore the old token or discard unsaved invalid drafts', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withBridge(async context => {
      const known = status()
      await context.settle(() => context.reads[0].resolve(known))
      await context.edit(false, '')
      const portError = context.view().portError
      const oldRead = await context.start(() => context.state().reloadWebClipBridgeStatus())
      const regeneration = await context.start(() => context.state().saveWebClipBridgeSettings(true))
      assert.deepEqual(context.saves[0].input, { enabled: true, port: 4321, regenerateToken: true })
      const regenerated = { ...known, token: 'new-token' }
      await context.settle(() => context.saves[0].resolve(regenerated), regeneration.completion)
      const freshRead = await context.start(() => context.state().reloadWebClipBridgeStatus())
      await context.settle(() => outcome === 'success' ? context.reads[1].resolve(known)
        : context.reads[1].reject(new Error('late pre-regeneration read failed')), oldRead.completion)
      assert.deepEqual(context.view().status, regenerated)
      assert.equal(context.view().enabled, false)
      assert.equal(context.view().port, '')
      assert.equal(context.view().portError, portError)
      assert.equal(context.view().error, null)
      assert.equal(context.view().loading, true)
      assert.equal(context.messages.length, 1)
      await context.settle(() => context.reads[2].resolve(regenerated), freshRead.completion)
      assert.equal(context.view().status?.token, 'new-token')
      assert.equal(context.view().loading, false)
      assert.equal(context.view().port, '')
    })
  }
})

test('a failed save preserves known state and dirty drafts and can retry the same configuration', async () => {
  await withBridge(async context => {
    const known = status()
    await context.settle(() => context.reads[0].resolve(known))
    await context.edit(true, '4789')
    const failed = await context.start(() => context.state().saveWebClipBridgeSettings())
    await context.settle(() => context.saves[0].reject(new Error("Error invoking remote method 'knowbook:update-web-clip-bridge-settings': Error: write permission denied")), failed.completion)
    assert.deepEqual(context.view().status, known)
    assert.equal(context.view().port, '4789')
    assert.equal(context.view().saving, false)
    assert.deepEqual(context.messages.at(-1), [`${getUiText('zh-CN').webClipBridgeSaveFailed} write permission denied`, 'error'])
    assert.deepEqual(context.view().actionError, { kind: 'save', message: context.messages.at(-1)![0] })
    const retry = await context.start(() => context.state().saveWebClipBridgeSettings())
    assert.equal(context.view().actionError, null)
    assert.deepEqual(context.saves[1].input, context.saves[0].input)
    await context.settle(() => context.saves[1].resolve(status(4789)), retry.completion)
    assert.equal(context.view().status?.port, 4789)
    assert.equal(context.view().port, '4789')
    assert.equal(context.view().saving, false)
    assert.equal(context.view().actionError, null)
  })
})

test('unmounting stops polls and old callbacks, and late reads do not contaminate a newly mounted settings session', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withBridge(async context => {
      const old = context.state()
      await context.unmount()
      assert.equal(context.timerCount(), 0)
      await old.reloadWebClipBridgeStatus()
      await old.saveWebClipBridgeSettings()
      assert.equal(context.reads.length, 1)
      assert.equal(context.saves.length, 0)
      await context.render(true)
      assert.equal(context.reads.length, 2)
      await context.settle(() => context.reads[1].resolve(status(5678, 'new-session-token')))
      await context.settle(() => outcome === 'success' ? context.reads[0].resolve(status(4321, 'old-session-token'))
        : context.reads[0].reject(new Error('old session read failed')))
      assert.equal(context.view().status?.token, 'new-session-token')
      assert.equal(context.view().port, '5678')
      assert.equal(context.view().error, null)
      assert.equal(context.view().loading, false)
      assert.deepEqual(context.messages, [])
    }, { active: true })
  }
})

test('save completion after unmount cannot notify a new session or change its loading state', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withBridge(async context => {
      await context.settle(() => context.reads[0].resolve(status()))
      const saving = await context.start(() => context.state().saveWebClipBridgeSettings(true))
      await context.unmount()
      await context.render()
      assert.equal(context.view().loading, true)
      await context.settle(() => outcome === 'success' ? context.saves[0].resolve(status(6789, 'old-save-token'))
        : context.saves[0].reject(new Error('old save failed')), saving.completion)
      assert.equal(context.view().status, null)
      assert.equal(context.view().loading, true)
      assert.deepEqual(context.messages, [])
      await context.settle(() => context.reads[1].resolve(status(5678)))
      assert.equal(context.view().port, '5678')
      assert.equal(context.view().saving, false)
    })
  }
})

test('StrictMode effect replay dispatches one valid read and can complete initialization without a stuck loading state', async () => {
  await withBridge(async context => {
    assert.equal(context.reads.length, 1)
    assert.equal(context.timerCount(), 1)
    assert.equal(context.view().loading, true)
    await context.settle(() => context.reads[0].resolve(status(5678)))
    assert.equal(context.view().status?.port, 5678)
    assert.equal(context.view().port, '5678')
    assert.equal(context.view().loading, false)
    assert.equal(context.view().error, null)
  }, { strict: true, active: true })
})

test('bridge mutation errors retain their operation through polling, reload and draft edits until a valid replacement action', async () => {
  for (const regenerate of [false, true]) {
    await withBridge(async context => {
      const known = status()
      await context.settle(() => context.reads[0].resolve(known))
      await context.edit(false, regenerate ? '' : '4789')
      const failed = await context.start(() => context.state().saveWebClipBridgeSettings(regenerate))
      const reason = regenerate ? 'Token replacement could not be stored' : 'Settings could not be stored'
      await context.settle(() => context.saves[0].reject(new Error(reason)), failed.completion)
      const prefix = regenerate ? getUiText('zh-CN').webClipBridgeTokenRefreshFailed : getUiText('zh-CN').webClipBridgeSaveFailed
      const owner = { kind: regenerate ? 'regenerate' : 'save', message: `${prefix} ${reason}` }
      assert.deepEqual(context.view().actionError, owner)
      assert.deepEqual(context.view().status, known)
      await context.edit(false, 'bad-port')
      assert.deepEqual(context.view().actionError, owner)
      await context.poll()
      await context.settle(() => context.reads[1].reject(new Error('Poll failed independently')))
      assert.ok(context.view().error)
      assert.deepEqual(context.view().actionError, owner)
      const read = await context.start(() => context.state().reloadWebClipBridgeStatus())
      const current = status(5678, 'current-native-token')
      await context.settle(() => context.reads[2].resolve(current), read.completion)
      assert.equal(context.view().error, null)
      assert.deepEqual(context.view().actionError, owner)
      assert.equal(context.view().enabled, false)
      assert.equal(context.view().port, 'bad-port')
      await context.start(() => context.state().saveWebClipBridgeSettings())
      assert.equal(context.saves.length, 1)
      assert.deepEqual(context.view().actionError, owner, 'invalid saving must not clear the previous accepted action failure')
      let replacement!: Promise<void>
      await act(async () => {
        const state = context.state()
        replacement = state.saveWebClipBridgeSettings(true)
        void state.saveWebClipBridgeSettings(true)
        void state.saveWebClipBridgeSettings()
        void state.reloadWebClipBridgeStatus()
      })
      assert.equal(context.saves.length, 2)
      assert.deepEqual(context.saves[1].input, { enabled: true, port: 5678, regenerateToken: true })
      assert.equal(context.view().actionError, null)
      assert.equal(context.view().saving, true)
      await context.settle(() => context.saves[1].resolve({ ...current, token: 'replacement-token' }), replacement)
      assert.equal(context.view().actionError, null)
      assert.equal(context.view().status?.token, 'replacement-token')
      assert.equal(context.view().enabled, false)
      assert.equal(context.view().port, 'bad-port')
    }, { active: true })
  }
})

test('an invalidated old bridge read cannot erase a mutation error or finish its newer reconciliation read', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withBridge(async context => {
      const known = status()
      await context.settle(() => context.reads[0].resolve(known))
      await context.edit(false, '')
      const oldRead = await context.start(() => context.state().reloadWebClipBridgeStatus())
      const rotate = await context.start(() => context.state().saveWebClipBridgeSettings(true))
      await context.settle(() => context.saves[0].reject(new Error('Current rotation failed')), rotate.completion)
      const owner = context.view().actionError
      assert.equal(owner?.kind, 'regenerate')
      const currentRead = await context.start(() => context.state().reloadWebClipBridgeStatus())
      await context.settle(() => outcome === 'success' ? context.reads[1].resolve(status(9999, 'obsolete-token'))
        : context.reads[1].reject(new Error('Obsolete read failed')), oldRead.completion)
      assert.deepEqual(context.view().status, known)
      assert.deepEqual(context.view().actionError, owner)
      assert.equal(context.view().error, null)
      assert.equal(context.view().loading, true)
      assert.equal(context.view().port, '')
      await context.settle(() => context.reads[2].resolve(known), currentRead.completion)
      assert.deepEqual(context.view().actionError, owner)
      assert.equal(context.view().loading, false)
      assert.equal(context.messages.length, 1)
    })
  }
})

test('bridge save and token failures use the current language and keep their distinct owner when replacing a previous error', async () => {
  for (const regenerate of [false, true]) {
    await withBridge(async context => {
      await context.settle(() => context.reads[0].resolve(status()))
      const first = await context.start(() => context.state().saveWebClipBridgeSettings(regenerate))
      await context.render(false, 'zh-CN')
      const prefix = regenerate ? getUiText('zh-CN').webClipBridgeTokenRefreshFailed : getUiText('zh-CN').webClipBridgeSaveFailed
      await context.settle(() => context.saves[0].reject(new Error("Error invoking remote method 'knowbook:update-web-clip-bridge-settings': Error: 本次写入失败")), first.completion)
      assert.deepEqual(context.view().actionError, { kind: regenerate ? 'regenerate' : 'save', message: `${prefix} 本次写入失败` })
      assert.deepEqual(context.messages.at(-1), [`${prefix} 本次写入失败`, 'error'])
      const other = await context.start(() => context.state().saveWebClipBridgeSettings(!regenerate))
      assert.equal(context.view().actionError, null)
      await context.render(false, 'en-US')
      const otherPrefix = regenerate ? getUiText('en-US').webClipBridgeSaveFailed : getUiText('en-US').webClipBridgeTokenRefreshFailed
      await context.settle(() => context.saves[1].reject(new Error("Error invoking remote method 'knowbook:update-web-clip-bridge-settings': Error: ")), other.completion)
      assert.deepEqual(context.view().actionError, { kind: regenerate ? 'save' : 'regenerate', message: otherPrefix })
      assert.deepEqual(context.messages.at(-1), [otherPrefix, 'error'])
      assert.equal(context.view().saving, false)
    }, { language: 'en-US' })
  }
})

test('late unmounted bridge mutations cannot overwrite or clear a new session operation error', async () => {
  for (const regenerate of [false, true]) {
    for (const outcome of ['success', 'failure'] as const) {
      await withBridge(async context => {
        await context.settle(() => context.reads[0].resolve(status()))
        const old = await context.start(() => context.state().saveWebClipBridgeSettings(regenerate))
        const oldRequest = context.saves[0]
        await context.unmount()
        await context.render()
        const known = status(5678, 'new-session-token')
        await context.settle(() => context.reads[1].resolve(known))
        await context.edit(false, '6789')
        const current = await context.start(() => context.state().saveWebClipBridgeSettings(!regenerate))
        await context.settle(() => context.saves[1].reject(new Error('Current session mutation failed')), current.completion)
        const owner = context.view().actionError
        assert.equal(owner?.kind, regenerate ? 'save' : 'regenerate')
        await context.settle(() => outcome === 'success' ? oldRequest.resolve(status(4321, 'old-session-token'))
          : oldRequest.reject(new Error('Old session mutation failed')), old.completion)
        assert.deepEqual(context.view().actionError, owner)
        assert.deepEqual(context.view().status, known)
        assert.equal(context.view().enabled, false)
        assert.equal(context.view().port, '6789')
        assert.equal(context.view().saving, false)
        assert.equal(context.messages.length, 1)
        assert.deepEqual(context.messages[0], [owner!.message, 'error'])
      })
    }
  }
})

function copyBridge(state: State, kind: CopyKind) {
  return kind === 'endpoint' ? state.copyWebClipBridgeEndpoint() : state.copyWebClipBridgeToken()
}

function copiedMessage(kind: CopyKind, language: 'zh-CN' | 'en-US') {
  const ui = getUiText(language)
  return kind === 'endpoint' ? ui.webClipBridgeEndpointCopied : ui.webClipBridgeTokenCopied
}

test('unknown configurations and unmounted copy callbacks never dispatch clipboard writes or notifications', async () => {
  await withBridge(async context => {
    await context.state().copyWebClipBridgeEndpoint()
    await context.state().copyWebClipBridgeToken()
    assert.equal(context.copies.length, 0)
    assert.equal(context.view().copying, null)
    await context.settle(() => context.reads[0].resolve(status()))
    const previous = context.state()
    await context.unmount()
    await previous.copyWebClipBridgeEndpoint()
    await previous.copyWebClipBridgeToken()
    assert.equal(context.copies.length, 0)
    assert.deepEqual(context.messages, [])
  })
})

test('saving and regenerating block both copy commands synchronously and until the mutation settles', async () => {
  for (const regenerate of [false, true]) {
    for (const outcome of ['success', 'failure'] as const) {
      await withBridge(async context => {
        const known = status()
        await context.settle(() => context.reads[0].resolve(known))
        await context.edit(true, '5432')
        const previous = context.state()
        let mutation!: Promise<void>
        await act(async () => {
          mutation = previous.saveWebClipBridgeSettings(regenerate)
          await previous.copyWebClipBridgeEndpoint()
          await previous.copyWebClipBridgeToken()
        })
        assert.equal(context.saves.length, 1)
        assert.equal(context.view().saving, true)
        assert.equal(context.view().copying, null)
        await previous.copyWebClipBridgeEndpoint()
        await context.state().copyWebClipBridgeToken()
        assert.equal(context.copies.length, 0, 'a known old value must not be copied while its replacement is pending')
        assert.deepEqual(context.messages, [])
        const next = regenerate ? { ...known, token: 'regenerated-token' } : status(5432, known.token)
        await context.settle(() => outcome === 'success' ? context.saves[0].resolve(next)
          : context.saves[0].reject(new Error('Mutation failed')), mutation)
        const actual = outcome === 'success' ? next : known
        const copy = await context.start(() => previous.copyWebClipBridgeToken())
        assert.equal(context.copies[0].text, actual.token)
        assert.equal(context.view().copying, 'token')
        const actionError = context.view().actionError
        await context.settle(() => context.copies[0].resolve(), copy.completion)
        assert.equal(context.view().copying, null)
        assert.deepEqual(context.view().actionError, actionError, 'copying must not clear a failed configuration action')
      })
    }
  }
})

test('retained copy callbacks use refreshed and saved snapshots while leaving invalid unsaved drafts intact', async () => {
  await withBridge(async context => {
    await context.settle(() => context.reads[0].resolve(status()))
    const previous = context.state()
    await context.edit(false, '1e4')
    const portError = context.view().portError
    await context.poll()
    const refreshed = status(5678, 'polled-token')
    await context.settle(() => context.reads[1].resolve(refreshed))
    for (const kind of ['endpoint', 'token'] as const) {
      const copy = await context.start(() => copyBridge(previous, kind))
      assert.equal(context.copies.at(-1)!.text, refreshed[kind])
      await context.settle(() => context.copies.at(-1)!.resolve(), copy.completion)
      assert.equal(context.view().enabled, false)
      assert.equal(context.view().port, '1e4')
      assert.equal(context.view().portError, portError)
    }
    await context.edit(true, '7890')
    const save = await context.start(() => context.state().saveWebClipBridgeSettings())
    const saved = status(7890, refreshed.token)
    await context.settle(() => context.saves[0].resolve(saved), save.completion)
    const endpoint = await context.start(() => previous.copyWebClipBridgeEndpoint())
    assert.equal(context.copies.at(-1)!.text, saved.endpoint)
    await context.settle(() => context.copies.at(-1)!.resolve(), endpoint.completion)
    await context.edit(false, '1e4')
    const regenerate = await context.start(() => context.state().saveWebClipBridgeSettings(true))
    const regenerated = { ...saved, token: 'latest-saved-token' }
    await context.settle(() => context.saves[1].resolve(regenerated), regenerate.completion)
    const token = await context.start(() => previous.copyWebClipBridgeToken())
    assert.equal(context.copies.at(-1)!.text, regenerated.token)
    await context.settle(() => context.copies.at(-1)!.resolve(), token.completion)
    assert.deepEqual(context.copies.map(copy => copy.text), [refreshed.endpoint, refreshed.token, saved.endpoint, regenerated.token])
    assert.equal(context.view().enabled, false)
    assert.equal(context.view().port, '1e4')
    assert.equal(context.view().portError, portError)
    assert.equal(context.view().copying, null)
  }, { active: true })
})

test('stopped services still allow copying the raw saved token but never copy a missing endpoint', async () => {
  for (const enabled of [false, true]) {
    await withBridge(async context => {
      const known = { ...status(), enabled, running: false, port: null, endpoint: null,
        lastError: enabled ? 'Port in use' : null }
      await context.settle(() => context.reads[0].resolve(known))
      await context.edit(!enabled, 'invalid-port')
      await context.state().copyWebClipBridgeEndpoint()
      assert.equal(context.copies.length, 0)
      assert.equal(context.view().copying, null)
      const token = await context.start(() => context.state().copyWebClipBridgeToken())
      assert.equal(context.copies.length, 1)
      assert.equal(context.copies[0].text, known.token, 'the extension adds the Bearer prefix itself')
      await context.settle(() => context.copies[0].resolve(), token.completion)
      assert.equal(context.view().port, 'invalid-port')
      assert.deepEqual(context.messages, [[getUiText('zh-CN').webClipBridgeTokenCopied, undefined]])
    })
  }
})

test('both copy commands share a synchronous clipboard lock and release it after success or failure', async () => {
  for (const kind of ['endpoint', 'token'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      await withBridge(async context => {
        const known = status()
        await context.settle(() => context.reads[0].resolve(known))
        const other = kind === 'endpoint' ? 'token' : 'endpoint'
        let first!: Promise<void>, duplicate!: Promise<void>, different!: Promise<void>
        await act(async () => {
          const current = context.state()
          first = copyBridge(current, kind)
          duplicate = copyBridge(current, kind)
          different = copyBridge(current, other)
        })
        assert.equal(context.copies.length, 1)
        assert.equal(context.copies[0].text, known[kind])
        assert.equal(context.view().copying, kind)
        assert.equal(context.view().saving, false, 'clipboard acknowledgement does not own the configuration lock')
        await copyBridge(context.state(), other)
        assert.equal(context.copies.length, 1)
        await context.render(false, 'en-US')
        await context.settle(() => outcome === 'success' ? context.copies[0].resolve()
          : context.copies[0].reject(new Error("Error invoking remote method 'knowbook:write-clipboard-text': Error: Clipboard unavailable")),
        Promise.all([first, duplicate, different]).then(() => {}))
        assert.equal(context.view().copying, null)
        assert.deepEqual(context.messages, [outcome === 'success' ? [copiedMessage(kind, 'en-US'), undefined]
          : [`${getUiText('en-US').copyFailed} Clipboard unavailable`, 'error']])
        const retry = await context.start(() => copyBridge(context.state(), other))
        assert.equal(context.copies.length, 2)
        assert.equal(context.copies[1].text, known[other])
        await context.settle(() => context.copies[1].resolve(), retry.completion)
        assert.equal(context.view().copying, null)
        assert.deepEqual(context.messages.at(-1), [copiedMessage(other, 'en-US'), undefined])
      })
    }
  }
})

test('copy failures without a usable reason use the current language fallback and permit a retry', async () => {
  for (const kind of ['endpoint', 'token'] as const) {
    for (const error of [new Error("Error invoking remote method 'knowbook:write-clipboard-text': Error: "), new Error('   '), 'non-Error rejection']) {
      await withBridge(async context => {
        await context.settle(() => context.reads[0].resolve(status()))
        const copy = await context.start(() => copyBridge(context.state(), kind))
        await context.render(false, 'en-US')
        await context.settle(() => context.copies[0].reject(error), copy.completion)
        assert.deepEqual(context.messages, [[getUiText('en-US').copyFailed, 'error']])
        assert.equal(context.view().copying, null)
        const retry = await context.start(() => copyBridge(context.state(), kind))
        assert.equal(context.copies.length, 2)
        await context.settle(() => context.copies[1].resolve(), retry.completion)
        assert.equal(context.view().copying, null)
        assert.deepEqual(context.messages.at(-1), [copiedMessage(kind, 'en-US'), undefined])
      })
    }
  }
})

test('late clipboard completions cannot notify or release a newly mounted session copy owner', async () => {
  for (const kind of ['endpoint', 'token'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      await withBridge(async context => {
        await context.settle(() => context.reads[0].resolve(status()))
        const previous = context.state()
        const old = await context.start(() => copyBridge(previous, kind))
        await context.unmount()
        await copyBridge(previous, kind)
        assert.equal(context.copies.length, 1)
        await context.render(false, 'en-US')
        const known = status(6789, 'new-session-token')
        await context.settle(() => context.reads[1].resolve(known))
        const currentKind = kind === 'endpoint' ? 'token' : 'endpoint'
        const current = await context.start(() => copyBridge(context.state(), currentKind))
        assert.equal(context.copies.length, 2)
        assert.equal(context.view().copying, currentKind)
        await context.settle(() => outcome === 'success' ? context.copies[0].resolve()
          : context.copies[0].reject(new Error('Old clipboard failure')), old.completion)
        assert.equal(context.view().copying, currentKind)
        assert.deepEqual(context.messages, [])
        await copyBridge(context.state(), kind)
        assert.equal(context.copies.length, 2, 'an old finally must not unlock the new clipboard request')
        await context.settle(() => context.copies[1].resolve(), current.completion)
        assert.equal(context.view().copying, null)
        assert.deepEqual(context.messages, [[copiedMessage(currentKind, 'en-US'), undefined]])
        assert.equal(context.copies[1].text, known[currentKind])
      })
    }
  }
})

test('known snapshots remain copyable during failed reads and invalid saves do not invalidate their acknowledgement', async () => {
  await withBridge(async context => {
    const known = status()
    await context.settle(() => context.reads[0].resolve(known))
    await context.edit(false, '1e4')
    const portError = context.view().portError
    await context.poll()
    assert.equal(context.view().loading, true)
    const token = await context.start(() => context.state().copyWebClipBridgeToken())
    assert.equal(context.view().copying, 'token')
    assert.equal(context.copies[0].text, known.token)
    const invalidSave = await context.start(() => context.state().saveWebClipBridgeSettings())
    await invalidSave.completion
    assert.equal(context.saves.length, 0)
    assert.equal(context.view().copying, 'token')
    await context.settle(() => context.reads[1].reject(new Error('Status temporarily unavailable')))
    const readError = context.view().error
    assert.ok(readError)
    await context.settle(() => context.copies[0].resolve(), token.completion)
    assert.deepEqual(context.messages, [[getUiText('zh-CN').webClipBridgeTokenCopied, undefined]])
    assert.equal(context.view().error, readError)
    const endpoint = await context.start(() => context.state().copyWebClipBridgeEndpoint())
    assert.equal(context.copies[1].text, known.endpoint)
    await context.settle(() => context.copies[1].resolve(), endpoint.completion)
    assert.equal(context.view().error, readError)
    assert.equal(context.view().portError, portError)
    assert.equal(context.view().port, '1e4')
    assert.equal(context.view().enabled, false)
    assert.equal(context.view().copying, null)
  }, { active: true })
})

test('accepted configuration actions supersede old clipboard acknowledgement without waiting for it or losing action errors', async () => {
  for (const kind of ['endpoint', 'token'] as const) {
    for (const regenerate of [false, true]) {
      for (const mutationOutcome of ['success', 'failure'] as const) {
        for (const copyOutcome of ['success', 'failure'] as const) {
          await withBridge(async context => {
            const known = status()
            await context.settle(() => context.reads[0].resolve(known))
            await context.edit(true, '5432')
            const copy = await context.start(() => copyBridge(context.state(), kind))
            const mutation = await context.start(() => context.state().saveWebClipBridgeSettings(regenerate))
            assert.equal(context.saves.length, 1, 'copying must not prevent an explicit configuration action')
            assert.equal(context.view().saving, true)
            assert.equal(context.view().copying, kind)
            const next = regenerate ? { ...known, token: 'replacement-token' } : status(5432, known.token)
            await context.settle(() => mutationOutcome === 'success' ? context.saves[0].resolve(next)
              : context.saves[0].reject(new Error('Current configuration failed')), mutation.completion)
            const actual = mutationOutcome === 'success' ? next : known
            const actionError = context.view().actionError
            const messages = [...context.messages]
            assert.equal(context.view().saving, false)
            assert.equal(context.view().copying, kind)
            await context.settle(() => copyOutcome === 'success' ? context.copies[0].resolve()
              : context.copies[0].reject(new Error('Obsolete clipboard failure')), copy.completion)
            assert.deepEqual(context.messages, messages, 'even a failed or same-value accepted mutation supersedes the old acknowledgement')
            assert.equal(context.view().copying, null)
            assert.deepEqual(context.view().actionError, actionError)
            assert.equal(context.copies[0].text, known[kind], 'already dispatched clipboard text is never rewritten by the renderer')
            const retry = await context.start(() => copyBridge(context.state(), kind))
            assert.equal(context.copies[1].text, actual[kind])
            await context.settle(() => context.copies[1].resolve(), retry.completion)
            assert.deepEqual(context.view().actionError, actionError)
            assert.deepEqual(context.messages.at(-1), [copiedMessage(kind, 'zh-CN'), undefined])
          })
        }
      }
    }
  }
})

test('polls suppress a clipboard acknowledgement only when its copied field value changed', async () => {
  for (const kind of ['endpoint', 'token'] as const) {
    for (const changedField of ['endpoint', 'token'] as const) {
      for (const outcome of ['success', 'failure'] as const) {
        await withBridge(async context => {
          const known = status()
          await context.settle(() => context.reads[0].resolve(known))
          const copy = await context.start(() => copyBridge(context.state(), kind))
          await context.poll()
          const refreshed = changedField === 'endpoint' ? status(6789, known.token) : { ...known, token: 'external-token' }
          await context.settle(() => context.reads[1].resolve(refreshed))
          assert.equal(context.view().copying, kind)
          await context.settle(() => outcome === 'success' ? context.copies[0].resolve()
            : context.copies[0].reject(new Error('Clipboard unavailable')), copy.completion)
          assert.equal(context.view().copying, null)
          assert.equal(context.copies[0].text, known[kind])
          assert.deepEqual(context.messages, changedField === kind ? [] : [outcome === 'success'
            ? [copiedMessage(kind, 'zh-CN'), undefined]
            : [`${getUiText('zh-CN').copyFailed} Clipboard unavailable`, 'error']])
          const retry = await context.start(() => copyBridge(context.state(), kind))
          assert.equal(context.copies[1].text, refreshed[kind])
          await context.settle(() => context.copies[1].resolve(), retry.completion)
          assert.equal(context.view().copying, null)
          assert.deepEqual(context.messages.at(-1), [copiedMessage(kind, 'zh-CN'), undefined])
        }, { active: true })
      }
    }
  }
})
