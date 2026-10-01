import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { ElectronApi } from '../src/shared/contracts'
import type { ResolveWebDavSyncConflict, SaveWebDavSyncConfig, WebDavSyncConfig, WebDavSyncConflict, WebDavSyncProgress, WebDavSyncStatus } from '../src/shared/webdav-sync'
import { useWebDavSettingsState } from '../src/renderer/src/hooks/useWebDavSettingsState'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const savedConfig: WebDavSyncConfig = { enabled: false, url: 'https://dav.example/notes/', username: 'saved-user',
  directory: 'KnowBook', intervalMinutes: 5, allowInsecureHttp: false }
const conflict: WebDavSyncConflict = { key: 'doc:one', title: 'A conflicting note', localHash: 'a'.repeat(64), remoteHash: 'b'.repeat(64),
  localPreview: 'Local text', remotePreview: 'Remote text', canKeepBoth: true, localDeleted: false, remoteDeleted: false,
  reason: 'overlap', canMerge: false, mergeFields: [], resolution: null }
const resolution: ResolveWebDavSyncConflict = { key: conflict.key, localHash: conflict.localHash, remoteHash: conflict.remoteHash, choice: 'local' }
function status(patch: Partial<WebDavSyncStatus> = {}): WebDavSyncStatus {
  return { config: { ...savedConfig }, hasPassword: true, phase: 'idle', lastSyncAt: null, message: 'Ready', uploaded: 0,
    downloaded: 0, merged: 0, progress: null, conflicts: [], ...patch }
}
const progress: WebDavSyncProgress = { stage: 'uploading', completed: 2, total: 10, attachmentsCompleted: 1,
  attachmentsTotal: 4, currentItem: 'Current note', currentAttachment: 'image.png', startedAt: '2026-10-01T00:00:00Z',
  requestsCompleted: 3, waitingUntil: null }
type State = ReturnType<typeof useWebDavSettingsState>
type View = Pick<State, 'status' | 'config' | 'password' | 'clearPassword' | 'intervalDraft' | 'intervalError' |
  'dirty' | 'readLoading' | 'readError' | 'actionError' | 'actionErrorTarget' | 'actionTarget' | 'actionKind' | 'working' | 'canStop'>
type Read = ReturnType<typeof deferred<WebDavSyncStatus>>
type Calls = { reads: Read[]; saves: (Read & { input: SaveWebDavSyncConfig })[]; tests: Read[]; syncs: Read[];
  resolutions: (Read & { input: ResolveWebDavSyncConflict })[]; cancellations: Read[] }
type Context = {
  state: () => State; view: () => View; calls: Calls;
  start: (action: () => Promise<unknown>) => Promise<{ completion: Promise<unknown> }>;
  settle: (action: () => void, completion?: Promise<unknown>) => Promise<void>;
  edit: (patch: Partial<Omit<WebDavSyncConfig, 'intervalMinutes'>>, interval?: string, password?: string) => Promise<void>;
  poll: () => Promise<void>; ready: (value?: WebDavSyncStatus) => Promise<void>;
  unmount: () => Promise<void>; render: () => Promise<void>; intervals: () => number[];
}

async function withWebDav(run: (context: Context) => Promise<void>, isZh = false) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const timers = new Map<number, { callback: () => void; delay?: number }>()
  const calls: Calls = { reads: [], saves: [], tests: [], syncs: [], resolutions: [], cancellations: [] }
  let timerId = 0
  const interval = (callback: () => void, delay?: number) => { timers.set(++timerId, { callback, delay }); return timerId }
  const clearInterval = (id: number) => { timers.delete(id) }
  dom.window.setInterval = interval
  dom.window.clearInterval = clearInterval
  const request = (list: Read[]) => { const next = deferred<WebDavSyncStatus>(); list.push(next); return next.promise }
  const api: Pick<ElectronApi, 'getWebDavSyncStatus' | 'saveWebDavSyncConfig' | 'testWebDavConnection' | 'syncWebDavNow' | 'resolveWebDavSyncConflict' | 'cancelWebDavSync'> = {
    getWebDavSyncStatus: () => request(calls.reads),
    saveWebDavSyncConfig: input => { const next = { ...deferred<WebDavSyncStatus>(), input }; calls.saves.push(next); return next.promise },
    testWebDavConnection: () => request(calls.tests),
    syncWebDavNow: () => request(calls.syncs),
    resolveWebDavSyncConflict: input => { const next = { ...deferred<WebDavSyncStatus>(), input }; calls.resolutions.push(next); return next.promise },
    cancelWebDavSync: () => request(calls.cancellations)
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, setInterval: interval, clearInterval, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const mount = dom.window.document.getElementById('mount')!
  let root: ReturnType<typeof createRoot>
  let mounted = false
  let state!: State
  function Harness() {
    state = useWebDavSettingsState(isZh)
    const view: View = { status: state.status, config: state.config, password: state.password, clearPassword: state.clearPassword,
      intervalDraft: state.intervalDraft, intervalError: state.intervalError, dirty: state.dirty, readLoading: state.readLoading,
      readError: state.readError, actionError: state.actionError, actionErrorTarget: state.actionErrorTarget,
      actionTarget: state.actionTarget, actionKind: state.actionKind, working: state.working, canStop: state.canStop }
    return createElement('output', null, JSON.stringify(view))
  }
  const render = async () => {
    if (!mounted) { root = createRoot(mount); mounted = true }
    await act(async () => root.render(createElement(Harness)))
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await render()
    await run({ state: () => state, view: () => JSON.parse(mount.querySelector('output')!.textContent!) as View, calls, render, unmount,
      intervals: () => [...timers.values()].map(timer => timer.delay!),
      start: async action => { let completion!: Promise<unknown>; await act(async () => { completion = action() }); return { completion } },
      settle: async (action, completion) => { await act(async () => { action(); await completion }) },
      ready: async (value = status()) => { await act(async () => calls.reads.at(-1)!.resolve(value)) },
      edit: async (patch, interval, password) => { await act(async () => {
        state.edit(patch)
        if (interval !== undefined) state.setIntervalDraft(interval)
        if (password !== undefined) state.setPassword(password)
      }) },
      poll: async () => { await act(async () => { [...timers.values()].forEach(timer => timer.callback()) }) }
    })
  } finally {
    await unmount()
    await act(async () => { for (const list of Object.values(calls)) for (const pending of list) pending.resolve(status()) })
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

test('an initial WebDAV read failure recovers through a single-flight retry and clears its read error', async () => {
  for (const isZh of [true, false]) {
    await withWebDav(async context => {
      assert.equal(context.calls.reads.length, 1)
      assert.equal(context.view().status, null)
      assert.equal(context.view().readLoading, true)
      assert.deepEqual(context.intervals(), [1000])
      await context.settle(() => context.calls.reads[0].reject(new Error("Error invoking remote method 'knowbook:get-webdav-sync-status': Error: temporarily unavailable")))
      assert.equal(context.view().readLoading, false)
      assert.ok(context.view().readError)
      assert.doesNotMatch(context.view().readError!, /Error invoking remote method/)
      assert.ok(!context.view().actionError)
      const first = await context.start(() => context.state().refreshStatus())
      const duplicate = await context.start(() => context.state().refreshStatus())
      for (let tick = 0; tick < 3; tick++) await context.poll()
      assert.equal(context.calls.reads.length, 2)
      assert.equal(context.view().readLoading, true)
      const known = status()
      await context.settle(() => context.calls.reads[1].resolve(known), Promise.all([first.completion, duplicate.completion]))
      assert.deepEqual(context.view().status, known)
      assert.deepEqual(context.view().config, savedConfig)
      assert.equal(context.view().intervalDraft, '5')
      assert.ok(!context.view().readError)
      assert.equal(context.view().readLoading, false)
      assert.equal(context.view().dirty, false)
    }, isZh)
  }
})

test('dirty state follows actual config and credential changes, including reverted fields and numerically equivalent intervals', async () => {
  await withWebDav(async context => {
    await context.ready()
    await context.edit({ url: 'https://draft.example/', username: 'another-user', directory: 'Other', enabled: true, allowInsecureHttp: true })
    assert.equal(context.view().dirty, true)
    await context.edit({ enabled: savedConfig.enabled, url: savedConfig.url, username: savedConfig.username,
      directory: savedConfig.directory, allowInsecureHttp: savedConfig.allowInsecureHttp })
    assert.equal(context.view().dirty, false)
    await act(async () => context.state().setPassword('replacement-password'))
    assert.equal(context.view().dirty, true)
    await act(async () => context.state().setPassword(''))
    assert.equal(context.view().dirty, false)
    await act(async () => context.state().setClearPassword(true))
    assert.equal(context.view().dirty, true)
    await act(async () => context.state().setClearPassword(false))
    assert.equal(context.view().dirty, false)
    await act(async () => context.state().setIntervalDraft('15'))
    assert.equal(context.view().dirty, true)
    for (const draft of ['05', '0005', ' 5 ']) {
      await act(async () => context.state().setIntervalDraft(draft))
      assert.equal(context.view().dirty, false)
      assert.equal(context.view().intervalError, null)
      assert.equal(context.view().intervalDraft, draft)
      assert.equal(context.view().config.intervalMinutes, 5)
    }
  })
})

test('invalid interval drafts stay available to correct and never reach save, connection or sync RPC', async () => {
  for (const isZh of [true, false]) {
    await withWebDav(async context => {
      await context.ready()
      for (const draft of ['', '0', '1441', '1.5', '1e2', '-5', '+5', '5minutes']) {
        await act(async () => context.state().setIntervalDraft(draft))
        assert.ok(context.view().intervalError, `invalid ${JSON.stringify(draft)} requires inline feedback`)
        assert.equal(context.view().config.intervalMinutes, 5)
        assert.equal(context.view().intervalDraft, draft)
        await context.start(() => context.state().save())
        await context.start(() => context.state().testConnection())
        await context.start(() => context.state().syncNow())
        assert.equal(context.calls.saves.length, 0)
        assert.equal(context.calls.tests.length, 0)
        assert.equal(context.calls.syncs.length, 0)
        assert.equal(context.view().actionKind, null)
        assert.equal(context.view().working, false)
      }
      await act(async () => context.state().setIntervalDraft('1440'))
      assert.equal(context.view().intervalError, null)
      const saving = await context.start(() => context.state().save())
      assert.equal(context.calls.saves[0].input.intervalMinutes, 1440)
      await context.settle(() => context.calls.saves[0].resolve(status({ config: { ...savedConfig, intervalMinutes: 1440 } })), saving.completion)
      assert.equal(context.view().dirty, false)
    }, isZh)
  }
})

test('a synchronous save lock blocks config and credential setters, reentry and cancellation while saving', async () => {
  await withWebDav(async context => {
    await context.ready(status({ conflicts: [conflict] }))
    const draft = { enabled: true, url: 'https://draft.example/notes/', username: 'draft-user', directory: 'Draft', allowInsecureHttp: true }
    await context.edit(draft, '015', 'new-password')
    let first!: Promise<unknown>
    const blocked: Promise<unknown>[] = []
    await act(async () => {
      const current = context.state()
      first = current.save()
      current.edit({ enabled: false, url: 'https://bypass.example/', username: 'bypass', directory: 'Bypass', allowInsecureHttp: false })
      current.setPassword('bypass-password')
      current.setClearPassword(true)
      current.setIntervalDraft('30')
      blocked.push(current.save(), current.testConnection(), current.syncNow(), current.resolve(resolution), current.cancel())
    })
    assert.equal(context.calls.saves.length, 1)
    assert.deepEqual(context.calls.saves[0].input, { ...draft, intervalMinutes: 15, password: 'new-password' })
    assert.deepEqual(context.view().config, { ...draft, intervalMinutes: 15 })
    assert.equal(context.view().password, 'new-password')
    assert.equal(context.view().clearPassword, false)
    assert.equal(context.view().intervalDraft, '015')
    assert.equal(context.view().actionKind, 'save')
    assert.equal(context.view().working, true)
    assert.equal(context.view().canStop, false)
    assert.equal(context.calls.tests.length + context.calls.syncs.length + context.calls.resolutions.length + context.calls.cancellations.length, 0)
    const acknowledged = status({ config: { ...draft, intervalMinutes: 15 }, message: 'Settings saved' })
    await context.settle(() => context.calls.saves[0].resolve(acknowledged), Promise.all([first, ...blocked]))
    assert.deepEqual(context.view().status, acknowledged)
    assert.equal(context.view().password, '')
    assert.equal(context.view().clearPassword, false)
    assert.equal(context.view().intervalDraft, '15')
    assert.equal(context.view().dirty, false)
    assert.equal(context.view().working, false)
  })
})

test('failed password saves preserve retryable drafts, while blank omission and explicit clearing retain their IPC meaning', async () => {
  await withWebDav(async context => {
    await context.ready()
    await context.edit({ username: 'draft-user' }, '10', 'replacement-password')
    const saving = await context.start(() => context.state().save())
    await context.settle(() => context.calls.saves[0].reject(new Error("Error invoking remote method 'knowbook:save-webdav-sync-config': Error: Password could not be protected")), saving.completion)
    assert.equal(context.view().password, 'replacement-password')
    assert.equal(context.view().config.username, 'draft-user')
    assert.equal(context.view().intervalDraft, '10')
    assert.equal(context.view().dirty, true)
    assert.equal(context.view().working, false)
    assert.ok(context.view().actionError)
    assert.doesNotMatch(context.view().actionError!, /Error invoking remote method/)
    const retry = await context.start(() => context.state().save())
    assert.deepEqual(context.calls.saves[1].input, context.calls.saves[0].input)
    const saved = status({ config: { ...savedConfig, username: 'draft-user', intervalMinutes: 10 } })
    await context.settle(() => context.calls.saves[1].resolve(saved), retry.completion)
    assert.equal(context.view().password, '')
    assert.equal(context.view().dirty, false)
    assert.ok(!context.view().actionError)
    const keeping = await context.start(() => context.state().save())
    assert.equal('password' in context.calls.saves[2].input, false)
    await context.settle(() => context.calls.saves[2].resolve(saved), keeping.completion)
    await act(async () => context.state().setClearPassword(true))
    const clearing = await context.start(() => context.state().save())
    assert.equal(context.calls.saves[3].input.password, '')
    await context.settle(() => context.calls.saves[3].resolve({ ...saved, hasPassword: false }), clearing.completion)
    assert.equal(context.view().password, '')
    assert.equal(context.view().clearPassword, false)
    assert.equal(context.view().dirty, false)
    assert.equal(context.view().status?.hasPassword, false)
  })
})

test('read failures retain known status and drafts, and poll recovery does not clear a separate operation failure', async () => {
  await withWebDav(async context => {
    const known = status()
    await context.ready(known)
    await context.edit({ username: 'unsaved-user' }, '10', 'unsaved-password')
    const reading = await context.start(() => context.state().refreshStatus())
    await context.settle(() => context.calls.reads[1].reject(new Error('Could not load status')), reading.completion)
    assert.deepEqual(context.view().status, known)
    assert.equal(context.view().readError, 'Could not load status')
    assert.equal(context.view().actionError, '')
    const saving = await context.start(() => context.state().save())
    await context.settle(() => context.calls.saves[0].reject(new Error('Could not save credentials')), saving.completion)
    assert.equal(context.view().actionError, 'Could not save credentials')
    assert.equal(context.view().readError, 'Could not load status')
    assert.equal(context.view().working, false, 'a background status refresh cannot hold the completed save lock')
    assert.equal(context.calls.reads.length, 3, 'a failed action starts a nonblocking status refresh')
    const refreshed = status({ config: { ...savedConfig, directory: 'External folder' }, message: 'Status recovered' })
    await context.settle(() => context.calls.reads[2].resolve(refreshed))
    assert.deepEqual(context.view().status, refreshed)
    assert.equal(context.view().readError, '')
    assert.equal(context.view().actionError, 'Could not save credentials')
    assert.equal(context.view().config.username, 'unsaved-user')
    assert.equal(context.view().config.directory, 'External folder', 'pristine fields can follow the saved configuration')
    assert.equal(context.view().intervalDraft, '10')
    assert.equal(context.view().password, 'unsaved-password')
    assert.equal(context.view().dirty, true)
  })
})

test('a status read started before saving cannot roll back the saved acknowledgement or raise a stale read error', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withWebDav(async context => {
      await context.ready()
      await context.edit({ username: 'new-user' }, '10', 'new-password')
      const reading = await context.start(() => context.state().refreshStatus())
      const saving = await context.start(() => context.state().save())
      await context.poll()
      assert.equal(context.calls.reads.length, 2)
      const acknowledged = status({ config: { ...savedConfig, username: 'new-user', intervalMinutes: 10 }, message: 'New settings saved' })
      await context.settle(() => context.calls.saves[0].resolve(acknowledged), saving.completion)
      await context.settle(() => outcome === 'success' ? context.calls.reads[1].resolve(status({ message: 'Old settings' }))
        : context.calls.reads[1].reject(new Error('Old status failed')), reading.completion)
      assert.deepEqual(context.view().status, acknowledged)
      assert.deepEqual(context.view().config, acknowledged.config)
      assert.equal(context.view().intervalDraft, '10')
      assert.equal(context.view().password, '')
      assert.equal(context.view().dirty, false)
      assert.equal(context.view().readError, '')
      await context.poll()
      assert.equal(context.calls.reads.length, 3)
      await context.settle(() => context.calls.reads[2].resolve({ ...acknowledged, message: 'Latest status' }))
      assert.equal(context.view().status?.message, 'Latest status')
      assert.equal(context.view().config.username, 'new-user')
    })
  }
})

test('equivalent raw intervals and dirty credentials survive polling while genuine pristine interval changes follow the server', async () => {
  await withWebDav(async context => {
    await context.ready()
    await context.edit({ username: 'unsaved-user' }, '005', 'unsaved-password')
    await context.poll()
    await context.settle(() => context.calls.reads[1].resolve(status({ message: 'Fresh progress' })))
    assert.equal(context.view().intervalDraft, '005')
    assert.equal(context.view().config.username, 'unsaved-user')
    assert.equal(context.view().password, 'unsaved-password')
    await context.poll()
    await context.settle(() => context.calls.reads[2].resolve(status({ config: { ...savedConfig, intervalMinutes: 15 } })))
    assert.equal(context.view().intervalDraft, '15', 'an interval still matching the previous saved value is pristine')
    assert.equal(context.view().config.intervalMinutes, 15)
    assert.equal(context.view().config.username, 'unsaved-user')
    assert.equal(context.view().password, 'unsaved-password')
    await act(async () => context.state().setIntervalDraft('20'))
    await context.poll()
    await context.settle(() => context.calls.reads[3].resolve(status({ config: { ...savedConfig, intervalMinutes: 30 } })))
    assert.equal(context.view().intervalDraft, '20', 'an actual unsaved interval is retained across external config changes')
    assert.equal(context.view().config.intervalMinutes, 20)
  })
})

test('resolving a conflict owns the mutation lock and cannot be superseded by cancel or another operation', async () => {
  await withWebDav(async context => {
    await context.ready(status({ conflicts: [conflict] }))
    const resolving = await context.start(() => context.state().resolve(resolution))
    await context.start(() => context.state().cancel())
    await context.start(() => context.state().save())
    await context.start(() => context.state().syncNow())
    await context.edit({ username: 'bypass' }, '10', 'bypass-password')
    await context.poll()
    assert.deepEqual(context.calls.resolutions[0].input, resolution)
    assert.equal(context.calls.resolutions.length, 1)
    assert.equal(context.calls.cancellations.length + context.calls.saves.length + context.calls.syncs.length, 0)
    assert.equal(context.calls.reads.length, 1)
    assert.equal(context.view().actionKind, 'resolve')
    assert.equal(context.view().working, true)
    assert.equal(context.view().canStop, false)
    assert.deepEqual(context.view().config, savedConfig)
    assert.equal(context.view().password, '')
    const resolved = status({ conflicts: [{ ...conflict, resolution: 'local' }], message: 'Resolution saved' })
    await context.settle(() => context.calls.resolutions[0].resolve(resolved), resolving.completion)
    assert.deepEqual(context.view().status, resolved)
    assert.equal(context.view().actionKind, null)
    assert.equal(context.view().working, false)
  })
})

test('connection and sync operations keep polling live progress while their RPC is pending', async () => {
  for (const operation of ['testConnection', 'syncNow'] as const) {
    await withWebDav(async context => {
      await context.ready()
      const running = await context.start(() => context.state()[operation]())
      const kind = operation === 'testConnection' ? 'test' : 'sync'
      assert.equal(context.view().actionKind, kind)
      assert.equal(context.view().working, true)
      assert.equal(context.view().canStop, true)
      await context.poll()
      await context.poll()
      assert.equal(context.calls.reads.length, 2, 'progress reads remain single-flight during a long operation')
      const active = status({ phase: kind === 'test' ? 'testing' : 'syncing', progress, message: 'Working' })
      await context.settle(() => context.calls.reads[1].resolve(active))
      assert.equal(context.view().status?.progress?.completed, 2)
      assert.equal(context.view().actionKind, kind)
      await context.edit({ username: 'bypass' }, '10', 'bypass-password')
      assert.deepEqual(context.view().config, savedConfig)
      assert.equal(context.view().password, '')
      const request = operation === 'testConnection' ? context.calls.tests[0] : context.calls.syncs[0]
      await context.settle(() => request.resolve(status({ message: 'Completed' })), running.completion)
      assert.equal(context.view().status?.message, 'Completed')
      assert.equal(context.view().working, false)
      assert.equal(context.view().canStop, false)
    })
  }
})

test('server-side work blocks new mutations and draft edits but remains cancellable without a renderer-owned action', async () => {
  await withWebDav(async context => {
    await context.ready(status({ phase: 'syncing', progress }))
    await context.edit({ username: 'bypass' }, '10', 'bypass-password')
    await context.start(() => context.state().save())
    await context.start(() => context.state().testConnection())
    await context.start(() => context.state().syncNow())
    await context.start(() => context.state().resolve(resolution))
    assert.deepEqual(context.view().config, savedConfig)
    assert.equal(context.view().password, '')
    assert.equal(context.view().actionKind, null)
    assert.equal(context.view().working, true)
    assert.equal(context.view().canStop, true)
    assert.equal(context.calls.saves.length + context.calls.tests.length + context.calls.syncs.length + context.calls.resolutions.length, 0)
    const cancelling = await context.start(() => context.state().cancel())
    assert.equal(context.calls.cancellations.length, 1)
    await context.settle(() => context.calls.cancellations[0].resolve(status({ message: 'Stopped' })), cancelling.completion)
    assert.equal(context.view().working, false)
    assert.equal(context.view().canStop, false)
  })
})

test('cancel supersedes connection or sync requests and ignores their late results while a new action remains active', async () => {
  for (const operation of ['testConnection', 'syncNow'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      await withWebDav(async context => {
        await context.ready()
        const old = await context.start(() => context.state()[operation]())
        const oldRequest = operation === 'testConnection' ? context.calls.tests[0] : context.calls.syncs[0]
        await context.poll()
        await context.settle(() => context.calls.reads[1].resolve(status({ phase: operation === 'testConnection' ? 'testing' : 'syncing', progress })))
        const oldRead = await context.start(() => context.state().refreshStatus())
        let cancelling!: Promise<unknown>
        const blocked: Promise<unknown>[] = []
        await act(async () => {
          const current = context.state()
          cancelling = current.cancel()
          blocked.push(current.cancel(), current.save(), current.testConnection(), current.syncNow(), current.resolve(resolution))
        })
        assert.equal(context.calls.cancellations.length, 1)
        assert.equal(context.view().actionKind, 'cancel')
        assert.equal(context.view().canStop, false)
        const stopped = status({ message: 'Canceled' })
        await context.settle(() => context.calls.cancellations[0].resolve(stopped), Promise.all([cancelling, ...blocked]))
        assert.deepEqual(context.view().status, stopped)
        assert.equal(context.view().working, false)
        const current = await context.start(() => context.state().testConnection())
        const currentRequest = context.calls.tests.at(-1)!
        await context.settle(() => outcome === 'success' ? oldRequest.resolve(status({ phase: 'error', hasPassword: false, message: 'Obsolete result' }))
          : oldRequest.reject(new Error('Obsolete operation failed')), old.completion)
        assert.deepEqual(context.view().status, stopped)
        assert.equal(context.view().actionKind, 'test')
        assert.equal(context.view().working, true)
        assert.equal(context.view().actionError, '')
        await context.settle(() => outcome === 'success' ? context.calls.reads[2].resolve(status({ phase: 'syncing', progress, message: 'Obsolete progress' }))
          : context.calls.reads[2].reject(new Error('Obsolete progress read failed')), oldRead.completion)
        assert.deepEqual(context.view().status, stopped)
        assert.equal(context.view().readError, '')
        assert.equal(context.view().actionKind, 'test')
        assert.equal(context.view().working, true)
        await context.settle(() => currentRequest.resolve(status({ message: 'Current connection finished' })), current.completion)
        assert.equal(context.view().status?.message, 'Current connection finished')
        assert.equal(context.view().working, false)
        assert.equal(context.view().actionError, '')
      })
    }
  }
})

test('a failed cancellation keeps its action error through live polling and permits another stop attempt', async () => {
  await withWebDav(async context => {
    await context.ready()
    const syncing = await context.start(() => context.state().syncNow())
    await context.poll()
    const active = status({ phase: 'syncing', progress, message: 'Uploading' })
    await context.settle(() => context.calls.reads[1].resolve(active))
    const cancelling = await context.start(() => context.state().cancel())
    await context.settle(() => context.calls.cancellations[0].reject(new Error('Could not stop the operation')), cancelling.completion)
    assert.equal(context.view().actionError, 'Could not stop the operation')
    assert.equal(context.view().actionKind, null)
    assert.equal(context.view().working, true)
    assert.equal(context.view().canStop, true)
    await context.settle(() => context.calls.syncs[0].resolve(status({ message: 'Late old sync response' })), syncing.completion)
    assert.deepEqual(context.view().status, active)
    assert.equal(context.view().actionError, 'Could not stop the operation')
    assert.equal(context.calls.reads.length, 3)
    await context.settle(() => context.calls.reads[2].resolve({ ...active, progress: { ...progress, completed: 4 } }))
    assert.equal(context.view().status?.progress?.completed, 4)
    assert.equal(context.view().actionError, 'Could not stop the operation')
    const retry = await context.start(() => context.state().cancel())
    assert.equal(context.calls.cancellations.length, 2)
    await context.settle(() => context.calls.cancellations[1].resolve(status({ message: 'Stopped' })), retry.completion)
    assert.equal(context.view().working, false)
    assert.equal(context.view().canStop, false)
    assert.equal(context.view().actionError, '')
  })
})

test('late save or cancellation results after unmount cannot alter a newly mounted settings session', async () => {
  for (const operation of ['save', 'cancel'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      await withWebDav(async context => {
        await context.ready(operation === 'cancel' ? status({ phase: 'syncing', progress }) : status())
        if (operation === 'save') await context.edit({ username: 'old-draft' }, '10', 'old-password')
        const pending = await context.start(() => context.state()[operation]())
        const request = operation === 'save' ? context.calls.saves[0] : context.calls.cancellations[0]
        const old = context.state()
        await context.unmount()
        assert.deepEqual(context.intervals(), [])
        await old.refreshStatus()
        await old.save()
        await old.cancel()
        assert.equal(context.calls.reads.length, 1)
        assert.equal(context.calls.saves.length + context.calls.cancellations.length, 1)
        await context.render()
        assert.equal(context.view().readLoading, true)
        await context.settle(() => outcome === 'success' ? request.resolve(status({ config: { ...savedConfig, username: 'old-response' }, message: 'Old action response' }))
          : request.reject(new Error('Old action failed')), pending.completion)
        assert.equal(context.view().status, null)
        assert.equal(context.view().readLoading, true)
        assert.equal(context.view().readError, '')
        assert.equal(context.view().actionError, '')
        assert.equal(context.view().actionKind, null)
        assert.equal(context.view().working, false)
        const current = status({ config: { ...savedConfig, username: 'new-session' } })
        await context.settle(() => context.calls.reads[1].resolve(current))
        assert.deepEqual(context.view().status, current)
        assert.equal(context.view().config.username, 'new-session')
        assert.equal(context.view().password, '')
        assert.equal(context.view().dirty, false)
      })
    }
  }
})

test('unmount removes the poll and isolates an old pending status read from the next mounted session', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withWebDav(async context => {
      await context.unmount()
      assert.deepEqual(context.intervals(), [])
      await context.render()
      assert.equal(context.calls.reads.length, 2)
      const current = status({ config: { ...savedConfig, directory: 'New session' } })
      await context.settle(() => context.calls.reads[1].resolve(current))
      await context.settle(() => outcome === 'success' ? context.calls.reads[0].resolve(status({ message: 'Obsolete status' }))
        : context.calls.reads[0].reject(new Error('Obsolete read failed')))
      assert.deepEqual(context.view().status, current)
      assert.deepEqual(context.view().config, current.config)
      assert.equal(context.view().readError, '')
      assert.equal(context.view().readLoading, false)
      assert.deepEqual(context.intervals(), [1000])
    })
  }
})

test('a failed conflict action retains its exact version and sync destination through status polling', async () => {
  await withWebDav(async context => {
    const config = { ...savedConfig, url: 'https://original.example/dav/', username: 'original-user', directory: 'Original' }
    const owner = { key: conflict.key, localHash: conflict.localHash, remoteHash: conflict.remoteHash,
      url: config.url, username: config.username, directory: config.directory }
    await context.ready(status({ config, conflicts: [conflict] }))
    const resolving = await context.start(() => context.state().resolve(resolution))
    assert.deepEqual(context.view().actionTarget, owner)
    assert.equal(context.view().actionErrorTarget, null)
    await context.settle(() => context.calls.resolutions[0].reject(new Error('This conflict version is no longer current')), resolving.completion)
    assert.equal(await resolving.completion, false)
    assert.equal(context.view().actionTarget, null)
    assert.equal(context.view().actionError, 'This conflict version is no longer current')
    assert.deepEqual(context.view().actionErrorTarget, owner)

    const nextVersion = { ...conflict, localHash: 'c'.repeat(64), remoteHash: 'd'.repeat(64) }
    await context.settle(() => context.calls.reads.at(-1)!.resolve(status({ config, conflicts: [nextVersion] })))
    assert.equal(context.view().status?.conflicts[0].localHash, nextVersion.localHash)
    assert.deepEqual(context.view().actionErrorTarget, owner, 'a refreshed card version cannot take ownership of the old error')
    await context.poll()
    const nextConfig = { ...config, url: 'https://next.example/dav/', username: 'next-user', directory: 'Next' }
    await context.settle(() => context.calls.reads.at(-1)!.resolve(status({ config: nextConfig, conflicts: [nextVersion] })))
    assert.deepEqual(context.view().config, nextConfig)
    assert.equal(context.view().dirty, false)
    assert.equal(context.view().actionError, 'This conflict version is no longer current')
    assert.deepEqual(context.view().actionErrorTarget, owner, 'polling another destination must not reassign the failure to its card')
    assert.equal(context.view().actionTarget, null)
  })
})

test('only a new accepted primary or conflict action clears the previous conflict error owner', async () => {
  for (const operation of ['save', 'testConnection', 'syncNow', 'resolve'] as const) {
    await withWebDav(async context => {
      const nextConflict = { ...conflict, key: 'doc:two', localHash: 'c'.repeat(64), remoteHash: 'd'.repeat(64) }
      const nextResolution: ResolveWebDavSyncConflict = { key: nextConflict.key, localHash: nextConflict.localHash,
        remoteHash: nextConflict.remoteHash, choice: 'remote' }
      const known = status({ conflicts: [conflict, nextConflict] })
      await context.ready(known)
      const failing = await context.start(() => context.state().resolve(resolution))
      await context.settle(() => context.calls.resolutions[0].reject(new Error('Previous conflict action failed')), failing.completion)
      await context.settle(() => context.calls.reads.at(-1)!.resolve(known))
      const previousOwner = context.view().actionErrorTarget
      assert.ok(previousOwner)

      await context.start(() => context.state().cancel())
      await act(async () => context.state().setIntervalDraft(''))
      await context.start(() => context.state().save())
      await context.start(() => context.state().testConnection())
      await context.start(() => context.state().syncNow())
      await context.start(() => context.state().resolve(nextResolution))
      assert.equal(context.view().actionError, 'Previous conflict action failed')
      assert.deepEqual(context.view().actionErrorTarget, previousOwner, 'rejected actions must leave the existing feedback intact')
      assert.equal(context.view().actionTarget, null)
      assert.equal(context.calls.saves.length + context.calls.tests.length + context.calls.syncs.length + context.calls.cancellations.length, 0)
      assert.equal(context.calls.resolutions.length, 1)
      await act(async () => context.state().setIntervalDraft('5'))

      const running = await context.start(() => operation === 'resolve'
        ? context.state().resolve(nextResolution) : context.state()[operation]())
      assert.equal(context.view().actionError, '')
      assert.equal(context.view().actionErrorTarget, null)
      assert.deepEqual(context.view().actionTarget, operation === 'resolve'
        ? { key: nextConflict.key, localHash: nextConflict.localHash, remoteHash: nextConflict.remoteHash,
          url: savedConfig.url, username: savedConfig.username, directory: savedConfig.directory }
        : null)
      const request = operation === 'save' ? context.calls.saves[0] : operation === 'testConnection'
        ? context.calls.tests[0] : operation === 'syncNow' ? context.calls.syncs[0] : context.calls.resolutions[1]
      await context.settle(() => request.resolve(known), running.completion)
      assert.equal(await running.completion, true)
      assert.equal(context.view().actionTarget, null)
      assert.equal(context.view().actionErrorTarget, null)
      assert.equal(context.view().actionError, '')
    })
  }
})

test('a cancelled sync late result cannot overwrite a newer conflict failure or its owner', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    await withWebDav(async context => {
      await context.ready()
      const oldSync = await context.start(() => context.state().syncNow())
      await context.poll()
      await context.settle(() => context.calls.reads.at(-1)!.resolve(status({ phase: 'syncing', progress })))
      const stopping = await context.start(() => context.state().cancel())
      assert.equal(context.view().actionTarget, null)
      const nextConflict = { ...conflict, key: 'doc:two', localHash: 'c'.repeat(64), remoteHash: 'd'.repeat(64) }
      const stopped = status({ conflicts: [nextConflict], message: 'Stopped' })
      await context.settle(() => context.calls.cancellations[0].resolve(stopped), stopping.completion)
      const nextResolution: ResolveWebDavSyncConflict = { key: nextConflict.key, localHash: nextConflict.localHash,
        remoteHash: nextConflict.remoteHash, choice: 'local' }
      const owner = { key: nextConflict.key, localHash: nextConflict.localHash, remoteHash: nextConflict.remoteHash,
        url: savedConfig.url, username: savedConfig.username, directory: savedConfig.directory }
      const resolving = await context.start(() => context.state().resolve(nextResolution))
      assert.deepEqual(context.view().actionTarget, owner)
      await context.settle(() => context.calls.resolutions[0].reject(new Error('New conflict action failed')), resolving.completion)
      assert.equal(context.view().actionTarget, null)
      assert.deepEqual(context.view().actionErrorTarget, owner)
      await context.settle(() => outcome === 'success'
        ? context.calls.syncs[0].resolve(status({ phase: 'error', config: { ...savedConfig, directory: 'Old target' } }))
        : context.calls.syncs[0].reject(new Error('Old sync failed after cancellation')), oldSync.completion)
      assert.equal(await oldSync.completion, false)
      assert.deepEqual(context.view().status, stopped)
      assert.equal(context.view().actionError, 'New conflict action failed')
      assert.deepEqual(context.view().actionErrorTarget, owner)
      assert.equal(context.view().actionTarget, null)
    })
  }
})

test('unmounted conflict and cancellation replies cannot replace a new session conflict owner', async () => {
  for (const operation of ['resolve', 'cancel'] as const) {
    for (const outcome of ['success', 'failure'] as const) {
      await withWebDav(async context => {
        await context.ready(operation === 'cancel' ? status({ phase: 'syncing', progress }) : status({ conflicts: [conflict] }))
        const oldAction = await context.start(() => operation === 'resolve'
          ? context.state().resolve(resolution) : context.state().cancel())
        const oldRequest = operation === 'resolve' ? context.calls.resolutions[0] : context.calls.cancellations[0]
        await context.unmount()
        await context.render()
        const config = { ...savedConfig, url: 'https://new-session.example/dav/', username: 'new-session-user', directory: 'New session' }
        const nextConflict = { ...conflict, key: 'doc:new-session', localHash: 'c'.repeat(64), remoteHash: 'd'.repeat(64) }
        const known = status({ config, conflicts: [nextConflict] })
        await context.ready(known)
        const nextResolution: ResolveWebDavSyncConflict = { key: nextConflict.key, localHash: nextConflict.localHash,
          remoteHash: nextConflict.remoteHash, choice: 'local' }
        const owner = { key: nextConflict.key, localHash: nextConflict.localHash, remoteHash: nextConflict.remoteHash,
          url: config.url, username: config.username, directory: config.directory }
        const resolving = await context.start(() => context.state().resolve(nextResolution))
        assert.deepEqual(context.view().actionTarget, owner)
        await context.settle(() => outcome === 'success' ? oldRequest.resolve(status({ message: 'Old session response' }))
          : oldRequest.reject(new Error('Old session failure')), oldAction.completion)
        assert.equal(await oldAction.completion, false)
        assert.deepEqual(context.view().status, known)
        assert.deepEqual(context.view().actionTarget, owner)
        assert.equal(context.view().actionKind, 'resolve')
        assert.equal(context.view().actionError, '')
        assert.equal(context.view().actionErrorTarget, null)
        await context.settle(() => context.calls.resolutions.at(-1)!.resolve(known), resolving.completion)
        assert.equal(context.view().actionTarget, null)
        assert.equal(context.view().actionErrorTarget, null)
        assert.equal(context.view().actionError, '')
      })
    }
  }
})
