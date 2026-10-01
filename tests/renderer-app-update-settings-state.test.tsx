import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, StrictMode } from 'react'
import { JSDOM } from 'jsdom'
import type { AppUpdateState, ElectronApi } from '../src/shared/contracts'
import { useSettingsState } from '../src/renderer/src/hooks/useSettingsState'
import { getUiText } from '../src/renderer/src/i18n'
import type { AppMessageHandler } from '../src/renderer/src/notify'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function status(patch: Partial<AppUpdateState> = {}): AppUpdateState {
  return { status: 'idle', currentVersion: '1.0.0', availableVersion: null, downloadedVersion: null,
    releaseName: null, releaseNotes: null, checkedAt: null, progressPercent: null, message: 'Ready',
    error: null, updatesEnabled: true, canInstall: false, ...patch }
}

type State = ReturnType<typeof useSettingsState>
type View = Pick<State, 'appUpdateState' | 'appUpdateLoading' | 'appUpdateLoadError' | 'appUpdateRefreshing'
  | 'appUpdateCheckError' | 'appUpdateCanCheck'>
type Request = ReturnType<typeof deferred<AppUpdateState>>
type Language = 'zh-CN' | 'en-US'
type Context = {
  state: () => State; view: () => View; reads: Request[]; checks: Request[];
  messages: [string | null, string | undefined][];
  start: (action: () => Promise<unknown>) => Promise<{ completion: Promise<unknown> }>;
  settle: (action: () => void, completion?: Promise<unknown>) => Promise<void>;
  ready: (value?: AppUpdateState) => Promise<void>;
  render: (options?: { active?: boolean; language?: Language }) => Promise<void>;
  unmount: () => Promise<void>; poll: () => Promise<void>; intervals: () => number[];
}

async function withUpdates(run: (context: Context) => Promise<void>, options: {
  active?: boolean; language?: Language; strict?: boolean
} = {}) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const timers = new Map<number, { callback: () => void; delay?: number }>()
  const reads: Request[] = [], checks: Request[] = []
  const messages: Context['messages'] = []
  let timerId = 0
  const interval = (callback: () => void, delay?: number) => { timers.set(++timerId, { callback, delay }); return timerId }
  const clear = (id: number) => { timers.delete(id) }
  dom.window.setInterval = interval
  dom.window.clearInterval = clear
  const request = (list: Request[]) => { const next = deferred<AppUpdateState>(); list.push(next); return next.promise }
  const api: Pick<ElectronApi, 'getAppUpdateState' | 'checkForAppUpdates' | 'getWebClipBridgeStatus'> = {
    getAppUpdateState: () => request(reads),
    checkForAppUpdates: () => request(checks),
    getWebClipBridgeStatus: async () => ({ enabled: false, running: false, port: null, configuredPort: 3210,
      token: 'update-test-bridge-token', endpoint: null, lastError: null })
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, setInterval: interval, clearInterval: clear, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const mount = dom.window.document.getElementById('mount')!
  let root: ReturnType<typeof createRoot>
  let mounted = false, active = options.active ?? false, language = options.language ?? 'zh-CN'
  let state!: State
  const onMessage: AppMessageHandler = (message, level) => { messages.push([message, level]) }
  function Harness() {
    state = useSettingsState({ isSettingsPageActive: active, ui: getUiText(language), onMessage })
    const view: View = { appUpdateState: state.appUpdateState, appUpdateLoading: state.appUpdateLoading,
      appUpdateLoadError: state.appUpdateLoadError, appUpdateRefreshing: state.appUpdateRefreshing,
      appUpdateCheckError: state.appUpdateCheckError, appUpdateCanCheck: state.appUpdateCanCheck }
    return createElement('output', null, JSON.stringify(view))
  }
  const render: Context['render'] = async next => {
    if (next?.active !== undefined) active = next.active
    if (next?.language !== undefined) language = next.language
    if (!mounted) { root = createRoot(mount); mounted = true }
    const element = createElement(Harness)
    await act(async () => root.render(options.strict ? createElement(StrictMode, null, element) : element))
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await render()
    await run({ state: () => state, view: () => JSON.parse(mount.querySelector('output')!.textContent!) as View,
      reads, checks, messages, render, unmount, intervals: () => [...timers.values()].map(timer => timer.delay!),
      start: async action => { let completion!: Promise<unknown>; await act(async () => { completion = action() }); return { completion } },
      settle: async (action, completion) => { await act(async () => { action(); await completion }) },
      ready: async (value = status()) => { await act(async () => reads.at(-1)!.resolve(value)) },
      poll: async () => { await act(async () => { [...timers.values()].forEach(timer => timer.callback()) }) }
    })
  } finally {
    await unmount()
    await act(async () => { for (const pending of [...reads, ...checks]) pending.resolve(status()) })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('an unknown update status blocks checks and a failed initial read can recover through a single retry', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withUpdates(async context => {
      assert.equal(context.reads.length, 1)
      assert.equal(context.view().appUpdateState, null)
      assert.equal(context.view().appUpdateLoading, true)
      assert.equal(context.view().appUpdateCanCheck, false)
      await context.start(() => context.state().checkForAppUpdates())
      assert.equal(context.checks.length, 0)
      assert.deepEqual(context.messages, [])
      const reason = 'Status unavailable\nTry again.'
      await context.settle(() => context.reads[0].reject(new Error(`Error invoking remote method 'knowbook:get-app-update-state': Error: ${reason}`)))
      assert.equal(context.view().appUpdateLoading, false)
      assert.equal(context.view().appUpdateState, null)
      assert.equal(context.view().appUpdateCanCheck, false)
      assert.equal(context.view().appUpdateLoadError, `${getUiText(language).appUpdateLoadFailed} ${reason}`)
      assert.ok(!context.view().appUpdateCheckError)
      const first = await context.start(() => context.state().reloadAppUpdateState())
      const duplicate = await context.start(() => context.state().reloadAppUpdateState())
      assert.equal(context.reads.length, 2)
      assert.equal(context.view().appUpdateLoading, true)
      await context.start(() => context.state().checkForAppUpdates())
      assert.equal(context.checks.length, 0)
      const actual = status({ currentVersion: '1.2.3' })
      await context.settle(() => context.reads[1].resolve(actual), Promise.all([first.completion, duplicate.completion]))
      assert.deepEqual(context.view().appUpdateState, actual)
      assert.equal(context.view().appUpdateLoading, false)
      assert.ok(!context.view().appUpdateLoadError)
      assert.equal(context.view().appUpdateCanCheck, true)
    }, { language })
  }
})

test('initial reads, settings entry, reload and slow four-second polls share one effective status request', async () => {
  await withUpdates(async context => {
    assert.deepEqual(context.intervals(), [])
    await context.render({ active: true })
    assert.deepEqual(context.intervals(), [4000])
    for (let tick = 0; tick < 3; tick++) await context.poll()
    const reload = await context.start(() => context.state().reloadAppUpdateState())
    assert.equal(context.reads.length, 1)
    await context.settle(() => context.reads[0].resolve(status()), reload.completion)
    await context.poll()
    for (let tick = 0; tick < 3; tick++) await context.poll()
    assert.equal(context.reads.length, 2)
    assert.equal(context.view().appUpdateLoading, true)
    await context.ready(status({ status: 'not-available', checkedAt: '2026-10-02T00:00:00Z' }))
    await context.render({ active: false })
    assert.deepEqual(context.intervals(), [])
    await context.poll()
    assert.equal(context.reads.length, 2)
    await context.render({ active: true })
    assert.equal(context.reads.length, 3)
    assert.deepEqual(context.intervals(), [4000])
  })
  await withUpdates(async context => {
    assert.equal(context.reads.length, 1, 'mounting directly in settings must coalesce the initial and active-page reads')
    assert.deepEqual(context.intervals(), [4000])
  }, { active: true })
})

test('a synchronous check lock prevents same-frame duplicate checks and suppresses reads until the actual result arrives', async () => {
  await withUpdates(async context => {
    await context.ready()
    const completions: Promise<unknown>[] = []
    await act(async () => {
      const current = context.state()
      completions.push(current.checkForAppUpdates(), current.checkForAppUpdates(), current.reloadAppUpdateState())
    })
    assert.equal(context.checks.length, 1)
    assert.equal(context.reads.length, 1)
    assert.equal(context.view().appUpdateRefreshing, true)
    assert.equal(context.view().appUpdateCanCheck, false)
    for (let tick = 0; tick < 3; tick++) await context.poll()
    await context.start(() => context.state().reloadAppUpdateState())
    assert.equal(context.reads.length, 1)
    assert.deepEqual(context.messages, [])
    const actual = status({ status: 'not-available', checkedAt: '2026-10-02T01:00:00Z', message: 'No newer version' })
    await context.settle(() => context.checks[0].resolve(actual), Promise.all(completions))
    assert.deepEqual(context.view().appUpdateState, actual)
    assert.equal(context.view().appUpdateRefreshing, false)
    assert.equal(context.view().appUpdateCanCheck, true)
    assert.ok(!context.view().appUpdateCheckError)
    assert.deepEqual(context.messages, [[getUiText('zh-CN').appUpdateCheckStarted, undefined]])
  }, { active: true })
})

test('a read started before a successful manual check cannot restore stale checking state or a stale read failure', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withUpdates(async context => {
      await context.ready()
      await context.poll()
      const oldRead = context.reads.at(-1)!
      const check = await context.start(() => context.state().checkForAppUpdates())
      const actual = status({ status: 'not-available', currentVersion: '2.0.0', checkedAt: '2026-10-02T02:00:00Z' })
      await context.settle(() => context.checks[0].resolve(actual), check.completion)
      await context.settle(() => outcome === 'success' ? oldRead.resolve(status({ status: 'checking', currentVersion: '1.0.0' }))
        : oldRead.reject(new Error('Obsolete read failed')))
      assert.deepEqual(context.view().appUpdateState, actual)
      assert.equal(context.view().appUpdateLoading, false)
      assert.equal(context.view().appUpdateRefreshing, false)
      assert.equal(context.view().appUpdateCanCheck, true)
      assert.ok(!context.view().appUpdateLoadError)
      assert.ok(!context.view().appUpdateCheckError)
      assert.equal(context.messages.length, 1)
    }, { active: true })
  }
})

test('an obsolete pre-check read cannot complete or poison the recovery read after a check failure', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withUpdates(async context => {
      const previous = status({ currentVersion: '2.0.0' })
      await context.ready(previous)
      await context.poll()
      const oldRead = context.reads.at(-1)!
      const check = await context.start(() => context.state().checkForAppUpdates())
      const reason = 'Update endpoint refused the request'
      await context.settle(() => context.checks[0].reject(new Error(reason)), check.completion)
      assert.equal(context.reads.length, 3, 'failure recovery must start without waiting for the invalidated read')
      const recovery = context.reads.at(-1)!
      assert.equal(context.view().appUpdateRefreshing, false)
      assert.equal(context.view().appUpdateLoading, true)
      const error = `${getUiText('zh-CN').appUpdateCheckFailed} ${reason}`
      assert.equal(context.view().appUpdateCheckError, error)
      await context.settle(() => outcome === 'success' ? oldRead.resolve(status({ status: 'checking' }))
        : oldRead.reject(new Error('Obsolete read failed')))
      assert.deepEqual(context.view().appUpdateState, previous)
      assert.equal(context.view().appUpdateLoading, true, 'the stale read must not release the newer read busy state')
      assert.ok(!context.view().appUpdateLoadError)
      assert.equal(context.view().appUpdateCheckError, error)
      const nativeError = status({ status: 'error', error: reason, message: 'Update check failed.' })
      await context.settle(() => recovery.resolve(nativeError))
      assert.deepEqual(context.view().appUpdateState, nativeError)
      assert.equal(context.view().appUpdateLoading, false)
      assert.equal(context.view().appUpdateCanCheck, true)
      assert.equal(context.view().appUpdateCheckError, error, 'a status read must not erase manual action feedback')
      assert.deepEqual(context.messages, [[error, 'error']])
    }, { active: true })
  }
})

test('a rejected check releases its promise and remains retryable when the independent recovery read also fails', async () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    await withUpdates(async context => {
      const previous = status({ status: 'not-available', currentVersion: '2.0.0' })
      await context.ready(previous)
      const check = await context.start(() => context.state().checkForAppUpdates())
      const reason = 'Feed unavailable\nRetry later.'
      await context.settle(() => context.checks[0].reject(new Error(`Error invoking remote method 'knowbook:check-for-app-updates': Error: ${reason}`)), check.completion)
      const actionError = `${getUiText(language).appUpdateCheckFailed} ${reason}`
      assert.equal(context.view().appUpdateRefreshing, false)
      assert.equal(context.reads.length, 2)
      assert.equal(context.view().appUpdateCheckError, actionError)
      await context.settle(() => context.reads[1].reject(new Error('Status transport unavailable')))
      assert.deepEqual(context.view().appUpdateState, previous, 'a failed recovery cannot fabricate a native status or erase known version data')
      assert.equal(context.view().appUpdateLoading, false)
      assert.equal(context.view().appUpdateLoadError, `${getUiText(language).appUpdateLoadFailed} Status transport unavailable`)
      assert.equal(context.view().appUpdateCheckError, actionError)
      assert.equal(context.view().appUpdateCanCheck, true)
      const retry = await context.start(() => context.state().checkForAppUpdates())
      assert.equal(context.checks.length, 2)
      assert.equal(context.view().appUpdateRefreshing, true)
      assert.equal(context.view().appUpdateCanCheck, false)
      const actual = status({ status: 'not-available', checkedAt: '2026-10-02T03:00:00Z' })
      await context.settle(() => context.checks[1].resolve(actual), retry.completion)
      assert.deepEqual(context.view().appUpdateState, actual)
      assert.equal(context.view().appUpdateCanCheck, true)
      assert.ok(!context.view().appUpdateCheckError)
      assert.ok(!context.view().appUpdateLoadError)
      assert.deepEqual(context.messages, [[actionError, 'error'], [getUiText(language).appUpdateCheckStarted, undefined]])
    }, { language })
  }
})

test('a fresh native checking state blocks retry after a failed action without clearing its manual error', async () => {
  await withUpdates(async context => {
    await context.ready()
    const check = await context.start(() => context.state().checkForAppUpdates())
    await context.settle(() => context.checks[0].reject(new Error('Manual check failed')), check.completion)
    const error = context.view().appUpdateCheckError
    const checking = status({ status: 'checking', message: 'Another check is active' })
    await context.ready(checking)
    assert.deepEqual(context.view().appUpdateState, checking)
    assert.equal(context.view().appUpdateCanCheck, false)
    assert.equal(context.view().appUpdateCheckError, error)
    await context.start(() => context.state().checkForAppUpdates())
    assert.equal(context.checks.length, 1)
    await context.start(() => context.state().reloadAppUpdateState())
    await context.ready(status({ status: 'error', error: 'Native check finished with an error' }))
    assert.equal(context.view().appUpdateCanCheck, true)
    assert.equal(context.view().appUpdateCheckError, error)
    const retry = await context.start(() => context.state().checkForAppUpdates())
    await context.settle(() => context.checks[1].resolve(status({ status: 'not-available' })), retry.completion)
    assert.ok(!context.view().appUpdateCheckError)
  })
})

test('a failed background read retains known version information and an explicit reload clears only the read failure', async () => {
  await withUpdates(async context => {
    const known = status({ status: 'downloading', availableVersion: '2.1.0', progressPercent: 62,
      releaseName: 'Release 2.1', releaseNotes: 'Changes', checkedAt: '2026-10-02T04:00:00Z' })
    await context.ready(known)
    const read = await context.start(() => context.state().reloadAppUpdateState())
    await context.settle(() => context.reads[1].reject(new Error('Status unavailable')), read.completion)
    assert.deepEqual(context.view().appUpdateState, known)
    assert.equal(context.view().appUpdateLoading, false)
    assert.ok(context.view().appUpdateLoadError)
    const retry = await context.start(() => context.state().reloadAppUpdateState())
    const current = status({ status: 'not-available', currentVersion: '2.1.0' })
    await context.settle(() => context.reads[2].resolve(current), retry.completion)
    assert.deepEqual(context.view().appUpdateState, current)
    assert.ok(!context.view().appUpdateLoadError)
    assert.deepEqual(context.messages, [])
  })
})

test('unsupported builds and native checking states cannot check, and an unsupported manual response does not announce a started check', async () => {
  await withUpdates(async context => {
    const unsupported = status({ status: 'unsupported', updatesEnabled: false, message: 'Packaged builds only' })
    await context.ready(unsupported)
    await context.start(() => context.state().checkForAppUpdates())
    assert.equal(context.checks.length, 0)
    assert.equal(context.view().appUpdateCanCheck, false)
    await context.start(() => context.state().reloadAppUpdateState())
    await context.ready(status({ status: 'checking' }))
    await context.start(() => context.state().checkForAppUpdates())
    assert.equal(context.checks.length, 0)
    assert.equal(context.view().appUpdateCanCheck, false)
    await context.start(() => context.state().reloadAppUpdateState())
    await context.ready()
    const check = await context.start(() => context.state().checkForAppUpdates())
    await context.settle(() => context.checks[0].resolve(unsupported), check.completion)
    assert.deepEqual(context.view().appUpdateState, unsupported)
    assert.equal(context.view().appUpdateRefreshing, false)
    assert.equal(context.view().appUpdateCanCheck, false)
    assert.deepEqual(context.messages, [])
  })
})

test('read and check failures use the current language at completion and clean packaged and empty exceptions', async () => {
  await withUpdates(async context => {
    await context.render({ language: 'zh-CN' })
    await context.settle(() => context.reads[0].reject(new Error("Error invoking remote method 'knowbook:get-app-update-state': Error: 读取暂时失败")))
    assert.equal(context.view().appUpdateLoadError, `${getUiText('zh-CN').appUpdateLoadFailed} 读取暂时失败`)
    const retryRead = await context.start(() => context.state().reloadAppUpdateState())
    await context.render({ language: 'en-US' })
    await context.settle(() => context.reads[1].reject(new Error("Error invoking remote method 'knowbook:get-app-update-state': Error: ")), retryRead.completion)
    assert.equal(context.view().appUpdateLoadError, getUiText('en-US').appUpdateLoadFailed)
    await context.start(() => context.state().reloadAppUpdateState())
    await context.ready()
    const check = await context.start(() => context.state().checkForAppUpdates())
    await context.render({ language: 'zh-CN' })
    await context.settle(() => context.checks[0].reject(new Error("Error invoking remote method 'knowbook:check-for-app-updates': Error: 当前请求失败")), check.completion)
    assert.equal(context.view().appUpdateCheckError, `${getUiText('zh-CN').appUpdateCheckFailed} 当前请求失败`)
    assert.deepEqual(context.messages.at(-1), [context.view().appUpdateCheckError, 'error'])
    await context.ready(status({ status: 'error' }))
    const emptyCheck = await context.start(() => context.state().checkForAppUpdates())
    await context.render({ language: 'en-US' })
    await context.settle(() => context.checks[1].reject('plain non-Error rejection'), emptyCheck.completion)
    assert.equal(context.view().appUpdateCheckError, getUiText('en-US').appUpdateCheckFailed)
    assert.deepEqual(context.messages.at(-1), [getUiText('en-US').appUpdateCheckFailed, 'error'])
  }, { language: 'en-US' })
})

test('StrictMode leaves one live poll and ignores obsolete session reads while ordinary rerenders do not restart reading', async () => {
  await withUpdates(async context => {
    assert.deepEqual(context.intervals(), [4000])
    assert.ok(context.reads.length >= 1 && context.reads.length <= 2)
    const current = context.reads.at(-1)!
    await context.settle(() => { for (const old of context.reads.slice(0, -1)) old.reject(new Error('Obsolete StrictMode read')) })
    const actual = status({ currentVersion: '3.0.0' })
    await context.settle(() => current.resolve(actual))
    assert.deepEqual(context.view().appUpdateState, actual)
    assert.ok(!context.view().appUpdateLoadError)
    const count = context.reads.length
    await context.render({ language: 'en-US' })
    assert.equal(context.reads.length, count)
    assert.deepEqual(context.intervals(), [4000])
    await context.poll()
    assert.equal(context.reads.length, count + 1)
    await context.unmount()
    assert.deepEqual(context.intervals(), [])
    await context.poll()
    assert.equal(context.reads.length, count + 1)
    assert.deepEqual(context.messages, [])
  }, { strict: true, active: true })
})

test('an unmounted status request cannot overwrite a new session or restart polling through an old callback', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withUpdates(async context => {
      const old = context.state(), oldRead = context.reads[0]
      await context.unmount()
      assert.deepEqual(context.intervals(), [])
      await old.reloadAppUpdateState()
      await old.checkForAppUpdates()
      assert.equal(context.reads.length, 1)
      assert.equal(context.checks.length, 0)
      await context.render()
      assert.equal(context.reads.length, 2)
      const actual = status({ status: 'not-available', currentVersion: '4.0.0' })
      await context.ready(actual)
      await context.settle(() => outcome === 'success' ? oldRead.resolve(status({ status: 'checking', currentVersion: '0.1.0' }))
        : oldRead.reject(new Error('Old session read failed')))
      assert.deepEqual(context.view().appUpdateState, actual)
      assert.equal(context.view().appUpdateLoading, false)
      assert.equal(context.view().appUpdateCanCheck, true)
      assert.ok(!context.view().appUpdateLoadError)
      assert.ok(!context.view().appUpdateCheckError)
      assert.deepEqual(context.intervals(), [4000])
      assert.deepEqual(context.messages, [])
    }, { active: true })
  }
})

test('a late unmounted check reply cannot release a new check lock or send a stale notification', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withUpdates(async context => {
      await context.ready()
      const oldCheck = await context.start(() => context.state().checkForAppUpdates())
      const oldRequest = context.checks[0]
      await context.unmount()
      await context.render()
      const known = status({ currentVersion: '5.0.0' })
      await context.ready(known)
      const currentCheck = await context.start(() => context.state().checkForAppUpdates())
      await context.settle(() => outcome === 'success' ? oldRequest.resolve(status({ status: 'not-available', currentVersion: '0.1.0' }))
        : oldRequest.reject(new Error('Old check failed')), oldCheck.completion)
      assert.deepEqual(context.view().appUpdateState, known)
      assert.equal(context.view().appUpdateRefreshing, true)
      assert.equal(context.view().appUpdateCanCheck, false)
      assert.ok(!context.view().appUpdateLoadError)
      assert.ok(!context.view().appUpdateCheckError)
      assert.deepEqual(context.messages, [])
      const actual = status({ status: 'not-available', currentVersion: '5.0.0' })
      await context.settle(() => context.checks[1].resolve(actual), currentCheck.completion)
      assert.deepEqual(context.view().appUpdateState, actual)
      assert.equal(context.view().appUpdateRefreshing, false)
      assert.equal(context.view().appUpdateCanCheck, true)
      assert.deepEqual(context.messages, [[getUiText('zh-CN').appUpdateCheckStarted, undefined]])
    })
  }
})
