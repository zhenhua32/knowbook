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
type View = {
  status: WebClipBridgeStatus | null; enabled: boolean; port: string;
  loading: boolean; error: string | null; portError: string | null; saving: boolean;
}
type Context = {
  state: () => State; view: () => View;
  reads: Read[]; saves: Save[];
  messages: [string | null, string | undefined][];
  start: (action: () => Promise<void>) => Promise<{ completion: Promise<void> }>;
  edit: (enabled: boolean, port: string) => Promise<void>;
  settle: (action: () => void, completion?: Promise<void>) => Promise<void>;
  poll: () => Promise<void>;
  render: (active?: boolean) => Promise<void>;
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
    writeClipboardText: async () => {}
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
  const onMessage: AppMessageHandler = (message, level) => { messages.push([message, level]) }
  function Harness({ active }: { active: boolean }) {
    state = useSettingsState({ isSettingsPageActive: active, ui: getUiText(options.language ?? 'zh-CN'), onMessage })
    const view: View = { status: state.webClipBridgeStatus, enabled: state.webClipBridgeEnabledDraft,
      port: state.webClipBridgePortDraft, loading: state.webClipBridgeLoading,
      error: state.webClipBridgeLoadError, portError: state.webClipBridgePortError, saving: state.webClipBridgeSaving }
    return createElement('output', { 'data-testid': 'bridge-state' }, JSON.stringify(view))
  }
  const render = async (nextActive = active) => {
    active = nextActive
    if (!hasRoot) { root = createRoot(mount); hasRoot = true }
    const element = createElement(Harness, { active })
    await act(async () => root.render(options.strict ? createElement(StrictMode, null, element) : element))
  }
  const unmount = async () => { if (hasRoot) { await act(async () => root.unmount()); hasRoot = false } }
  try {
    await render()
    await run({ state: () => state, view: () => JSON.parse(mount.querySelector('output')!.textContent!) as View,
      reads, saves, messages, render, unmount, timerCount: () => timers.size,
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
      assert.deepEqual(context.view(), { status: null, enabled: false, port: '3210', loading: true, error: null, portError: null, saving: false })
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
      assert.deepEqual(context.view(), { status: actual, enabled: true, port: '4789', loading: false, error: null, portError: null, saving: false })
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
    assert.deepEqual(context.messages.at(-1), [`${getUiText('zh-CN').webClipBridgeSaveFailed} write permission denied`, 'error'])
    const retry = await context.start(() => context.state().saveWebClipBridgeSettings(true))
    assert.deepEqual(context.saves[1].input, { enabled: false, port: 5432, regenerateToken: true })
    const regenerated = { ...latest, token: 'new-disabled-token' }
    await context.settle(() => context.saves[1].resolve(regenerated), retry.completion)
    assert.deepEqual(context.view().status, regenerated)
    assert.equal(context.view().enabled, true)
    assert.equal(context.view().port, '')
    assert.equal(context.view().portError, portError)
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
    assert.deepEqual(context.view(), { status: saved, enabled: true, port: '4789', loading: false, error: null, portError: null, saving: false })
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
    const retry = await context.start(() => context.state().saveWebClipBridgeSettings())
    assert.deepEqual(context.saves[1].input, context.saves[0].input)
    await context.settle(() => context.saves[1].resolve(status(4789)), retry.completion)
    assert.equal(context.view().status?.port, 4789)
    assert.equal(context.view().port, '4789')
    assert.equal(context.view().saving, false)
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
