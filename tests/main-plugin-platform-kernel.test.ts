import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginPlatformKernel } from '../src/main/plugin-platform/kernel.ts'
import type {
  PluginActivationIdentity,
  PluginPlatformScope
} from '../src/shared/plugin-platform.ts'

const appScope: PluginPlatformScope = { kind: 'app' }
const workspaceScope: PluginPlatformScope = {
  kind: 'workspace',
  workspaceId: 'workspace-1'
}
const sessionScope: PluginPlatformScope = {
  kind: 'session',
  workspaceId: 'workspace-1',
  sessionId: 'session-1'
}

test('PluginPlatformKernel keeps staging registrations invisible until commit', async () => {
  const kernel = new PluginPlatformKernel()
  const stage = kernel.beginActivation(identity('probe', 'rev-1', 'run-1', workspaceScope))
  stage.registerService({ id: 'notes.reader', version: '1' }, { source: 'probe' })
  stage.contribute({ slot: 'workspace.dashboard', id: 'probe-card' }, { title: 'Probe' })

  assert.equal(kernel.resolveService('notes.reader', sessionScope), null)
  assert.deepEqual(kernel.listContributions('workspace.dashboard', sessionScope), [])

  const receipt = await stage.commit()
  assert.equal(kernel.resolveService<{ source: string }>('notes.reader', sessionScope)?.value.source, 'probe')
  assert.equal(kernel.listContributions('workspace.dashboard', sessionScope)[0]?.value !== null, true)
  assert.equal(kernel.isCurrent(receipt.owner), true)

  await kernel.destroy()
})

test('service resolution prefers specific scopes and explicit priority', async () => {
  const kernel = new PluginPlatformKernel()

  const app = kernel.beginActivation(identity('app-provider', 'rev-1', 'run-app', appScope))
  app.registerService({ id: 'search', version: '1', priority: 100 }, 'app')
  await app.commit()

  const workspaceLow = kernel.beginActivation(identity('workspace-low', 'rev-1', 'run-work-low', workspaceScope))
  workspaceLow.registerService({ id: 'search', version: '1', priority: 0 }, 'workspace-low')
  await workspaceLow.commit()

  const workspaceHigh = kernel.beginActivation(identity('workspace-high', 'rev-1', 'run-work-high', workspaceScope))
  workspaceHigh.registerService({ id: 'search', version: '1', priority: 10 }, 'workspace-high')
  await workspaceHigh.commit()

  const session = kernel.beginActivation(identity('session-provider', 'rev-1', 'run-session', sessionScope))
  session.registerService({ id: 'search', version: '1', priority: -100 }, 'session')
  await session.commit()

  assert.equal(kernel.resolveService<string>('search', appScope)?.value, 'app')
  assert.equal(kernel.resolveService<string>('search', workspaceScope)?.value, 'workspace-high')
  assert.equal(kernel.resolveService<string>('search', sessionScope)?.value, 'session')

  await kernel.destroy()
})

test('contributions merge scopes, shadow the same plugin contribution, and remain ordered', async () => {
  const kernel = new PluginPlatformKernel()
  const app = kernel.beginActivation(identity('same-plugin', 'rev-app', 'run-app', appScope))
  app.contribute({ slot: 'navigation.primary', id: 'entry', order: 20 }, 'app-entry')
  await app.commit()

  const workspace = kernel.beginActivation(identity('same-plugin', 'rev-work', 'run-work', workspaceScope))
  workspace.contribute({ slot: 'navigation.primary', id: 'entry', order: 30 }, 'workspace-entry')
  await workspace.commit()

  const other = kernel.beginActivation(identity('other-plugin', 'rev-1', 'run-other', appScope))
  other.contribute({ slot: 'navigation.primary', id: 'first', order: 10 }, 'first-entry')
  await other.commit()

  assert.deepEqual(
    kernel.listContributions<string>('navigation.primary', sessionScope).map((item) => item.value),
    ['first-entry', 'workspace-entry']
  )
  assert.deepEqual(
    kernel.listContributions<string>('navigation.primary', appScope).map((item) => item.value),
    ['first-entry', 'app-entry']
  )

  await kernel.destroy()
})

test('conflicting service validation disposes staging and leaves active providers unchanged', async () => {
  const kernel = new PluginPlatformKernel()
  const active = kernel.beginActivation(identity('active', 'rev-1', 'run-active', workspaceScope))
  active.registerService({ id: 'exclusive', version: '1' }, 'active')
  await active.commit()

  let stagingDisposed = false
  const conflict = kernel.beginActivation(identity('conflict', 'rev-1', 'run-conflict', workspaceScope))
  conflict.own(() => {
    stagingDisposed = true
  }, 'staging-runtime')
  conflict.registerService({ id: 'exclusive', version: '2' }, 'conflict')

  await assert.rejects(conflict.commit(), /already has a provider/)
  assert.equal(stagingDisposed, true)
  assert.equal(conflict.state, 'disposed')
  assert.equal(kernel.resolveService<string>('exclusive', workspaceScope)?.value, 'active')

  await kernel.destroy()
})

test('commit hook failure rolls the whole namespace back before old run draining starts', async () => {
  const kernel = new PluginPlatformKernel()
  const first = kernel.beginActivation(identity('atomic-hook', 'rev-1', 'run-hook-1', workspaceScope))
  first.registerService({ id: 'atomic.service', version: '1' }, 'old-service')
  first.contribute({ slot: 'atomic.slot', id: 'entry' }, 'old-contribution')
  const firstReceipt = await first.commit()

  let stagingDisposed = false
  const second = kernel.beginActivation(identity('atomic-hook', 'rev-2', 'run-hook-2', workspaceScope))
  second.registerService({ id: 'atomic.service', version: '1' }, 'new-service')
  second.contribute({ slot: 'atomic.slot', id: 'entry' }, 'new-contribution')
  second.own(() => {
    stagingDisposed = true
  })

  await assert.rejects(second.commit(1_000, () => {
    throw new Error('persistence commit failed')
  }), /persistence commit failed/)

  assert.equal(stagingDisposed, true)
  assert.equal(kernel.isCurrent(firstReceipt.owner), true)
  assert.equal(kernel.resolveService<string>('atomic.service', workspaceScope)?.value, 'old-service')
  assert.deepEqual(
    kernel.listContributions<string>('atomic.slot', workspaceScope).map((item) => item.value),
    ['old-contribution']
  )
  await assert.rejects(
    kernel.runWithActiveOwner({
      ...firstReceipt.owner,
      revisionId: 'rev-2',
      runId: 'run-hook-2',
      grantSetId: 'grant-run-hook-2',
      epoch: firstReceipt.owner.epoch + 1
    }, () => undefined),
    /stale or no longer active/
  )

  await kernel.destroy()
})

test('revision commit switches atomically, rejects stale work, and drains in-flight work', async () => {
  const kernel = new PluginPlatformKernel()
  const trace: string[] = []
  const first = kernel.beginActivation(identity('hot-plugin', 'rev-1', 'run-1', workspaceScope))
  first.contribute({ slot: 'workspace.dashboard', id: 'card' }, 'old')
  first.own(() => {
    trace.push('old-disposed')
  }, 'old-runtime')
  const firstReceipt = await first.commit()

  const workGate = deferred()
  const observedSignal: { current: AbortSignal | null } = { current: null }
  const inFlight = kernel.runWithActiveOwner(firstReceipt.owner, async (signal) => {
    observedSignal.current = signal
    trace.push('work-started')
    await workGate.promise
    trace.push('work-finished')
  })
  await Promise.resolve()

  const second = kernel.beginActivation(identity('hot-plugin', 'rev-2', 'run-2', workspaceScope))
  second.contribute({ slot: 'workspace.dashboard', id: 'card' }, 'new')
  const secondReceipt = await second.commit(1_000)

  assert.equal(secondReceipt.previousOwner?.runId, 'run-1')
  assert.equal(kernel.isCurrent(firstReceipt.owner), false)
  assert.equal(kernel.isCurrent(secondReceipt.owner), true)
  assert.equal(observedSignal.current?.aborted, true)
  assert.deepEqual(
    kernel.listContributions<string>('workspace.dashboard', workspaceScope).map((item) => item.value),
    ['new']
  )
  await assert.rejects(
    kernel.runWithActiveOwner(firstReceipt.owner, () => undefined),
    /stale or no longer active/
  )
  assert.deepEqual(trace, ['work-started'])

  workGate.resolve()
  await inFlight
  const drain = await secondReceipt.previousDrain
  assert.equal(drain?.timedOut, false)
  assert.deepEqual(trace, ['work-started', 'work-finished', 'old-disposed'])

  await kernel.destroy()
})

test('stop hides registrations immediately and reports forced drain timeouts', async () => {
  const kernel = new PluginPlatformKernel()
  const workGate = deferred()
  let disposed = false
  const stage = kernel.beginActivation(identity('timeout-plugin', 'rev-1', 'run-timeout', workspaceScope))
  stage.registerService({ id: 'timeout.service', version: '1' }, true)
  stage.own(() => {
    disposed = true
  }, 'runtime')
  const receipt = await stage.commit()

  const inFlight = kernel.runWithActiveOwner(receipt.owner, async () => {
    await workGate.promise
  })
  await Promise.resolve()
  const drain = await kernel.stop('timeout-plugin', workspaceScope, 0)

  assert.equal(kernel.resolveService('timeout.service', workspaceScope), null)
  assert.equal(drain?.timedOut, true)
  assert.equal(disposed, true)

  workGate.resolve()
  await inFlight
})

function identity(
  pluginId: string,
  revisionId: string,
  runId: string,
  scope: PluginPlatformScope
): PluginActivationIdentity {
  return {
    pluginId,
    revisionId,
    runId,
    grantSetId: `grant-${runId}`,
    scope
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    promise,
    resolve: () => release()
  }
}
