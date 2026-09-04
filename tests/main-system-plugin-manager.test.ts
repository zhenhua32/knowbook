import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import {
  isSystemPluginRuntimeCompatible,
  SystemPluginManager,
  type CreateSystemPluginServiceRpcMethods,
  type PreparePublishedSystemPluginPackage,
  type SystemPluginDetachedProcessInspector,
  type SystemPluginHostController,
  type SystemPluginServiceController,
  type SystemPluginServiceFactory,
  type SystemPluginServiceRpcServerFactory
} from '../src/main/system-plugin/manager'
import {
  SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
  SYSTEM_PLUGIN_SERVICE_RPC_REQUEST
} from '../src/main/system-plugin/service-rpc'
import type { SystemPluginRuntimeStatus } from '../src/main/system-plugin/types'
import {
  createFullTrustElectronLoginItemAdapter,
  type FullTrustElectronLoginItemApplication,
  type FullTrustElectronLoginItemQuery,
  type FullTrustElectronLoginItemSettings,
  type FullTrustElectronLoginItemState,
  type FullTrustOsPersistenceAdapter
} from '../src/main/system-plugin/os-persistence'

test('native runtime compatibility is bound to platform, architecture and Electron ABI', () => {
  const fingerprint = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? null,
    modules: process.versions.modules ?? null
  }
  assert.equal(isSystemPluginRuntimeCompatible(fingerprint), true)
  assert.equal(isSystemPluginRuntimeCompatible({ ...fingerprint, modules: 'incompatible' }), false)
  assert.equal(isSystemPluginRuntimeCompatible({ ...fingerprint, platform: 'other-os' }), false)
  assert.equal(isSystemPluginRuntimeCompatible(null), false)
})

test('a bundled native module is re-probed after the Electron ABI changes without requiring a rebuild plan', async () => {
  await withManagerFixture(async ({ source, store, createManager }) => {
    const installer = createManager()
    const installed = await installForRestart(installer, source)
    await installer.destroy()
    store.pluginPlatform.updateSystemPluginPackage(installed.packageRecord!.id, {
      runtimeFingerprint: {
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? null,
        modules: 'previous-electron-abi',
        nativeModuleProbe: { status: 'passed', moduleCount: 1, modules: ['build/addon.node'] }
      }
    })

    let preparations = 0
    const manager = createManager({
      preparePublishedPackage: async () => {
        preparations += 1
        return {
          runtimeFingerprint: {
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron ?? null,
            modules: process.versions.modules ?? null,
            nativeModuleProbe: { status: 'passed', moduleCount: 1, modules: ['build/addon.node'] }
          }
        }
      }
    })
    const [summary] = await manager.startup()
    assert.equal(preparations, 1)
    assert.equal(summary.installation.status, 'active')
    assert.equal(
      (summary.currentPackage?.runtimeFingerprint as Record<string, unknown>).modules,
      process.versions.modules ?? null
    )
    await manager.destroy()
  })
})

test('SystemPluginManager binds confirmation to exact bytes and activates only after restart', async () => {
  await withManagerFixture(async ({ root, source, store, createManager, activations }) => {
    const first = createManager()
    const request = await first.prepareInstallFromDirectory({
      sourceDirectory: source,
      reason: 'User selected a local package.',
      requestedBy: 'user'
    })
    assert.equal(request.status, 'awaiting-confirmation')
    assert.match(request.artifactSha256, /^[a-f0-9]{64}$/)
    assert.equal(activations.count, 0)

    await assert.rejects(first.resolveInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      artifactSha256: '0'.repeat(64),
      acknowledgeSystemAccess: true,
      decision: 'confirm',
      actor: 'user'
    }), /exact reviewed artifact/i)

    const resolution = await first.resolveInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      artifactSha256: request.artifactSha256,
      acknowledgeSystemAccess: true,
      decision: 'confirm',
      actor: 'user'
    })
    assert.equal(resolution.request.status, 'confirmed-restart-required')
    assert.equal(resolution.installation?.status, 'pending-restart')
    assert.equal(resolution.installation?.currentPackageId, null)
    assert.equal(activations.count, 0)
    assert.ok(resolution.packageRecord)
    assert.equal(existsSync(resolution.packageRecord.artifactPath), true)
    await first.destroy()

    const restarted = createManager()
    const summaries = await restarted.startup()
    assert.equal(activations.count, 2)
    assert.equal(summaries[0]?.installation.status, 'active')
    assert.equal(summaries[0]?.installation.currentPackageId, resolution.packageRecord.id)
    assert.equal(summaries[0]?.installation.pendingPackageId, null)
    assert.deepEqual(
      store.pluginPlatform.listSystemPluginRuns(resolution.installation!.id)
        .map((run) => run.component)
        .sort(),
      ['main', 'service']
    )

    const updateSource = join(root, 'source-v2')
    writePlugin(updateSource, '2.0.0')
    const updateRequest = await restarted.prepareInstallFromDirectory({
      sourceDirectory: updateSource,
      reason: 'Install an update.',
      requestedBy: 'user'
    })
    const update = await restarted.resolveInstallRequest({
      requestId: updateRequest.id,
      pluginId: updateRequest.pluginId,
      artifactSha256: updateRequest.artifactSha256,
      acknowledgeSystemAccess: true,
      decision: 'confirm',
      actor: 'user'
    })
    assert.equal(update.installation?.status, 'pending-restart')
    assert.equal(activations.count, 2)
    await restarted.destroy()

    const upgraded = createManager()
    const [upgradedSummary] = await upgraded.startup()
    assert.equal(upgradedSummary.currentPackage?.version, '2.0.0')
    assert.equal(activations.count, 4)
    const rollback = await upgraded.rollback(request.pluginId, resolution.packageRecord.id)
    assert.equal(rollback.pendingPackage?.version, '1.0.0')
    assert.equal(rollback.installation.status, 'pending-restart')
    await upgraded.destroy()

    const rolledBack = createManager()
    const [rolledBackSummary] = await rolledBack.startup()
    assert.equal(rolledBackSummary.currentPackage?.version, '1.0.0')
    assert.equal(activations.count, 6)

    const uninstall = await rolledBack.requestUninstall(request.pluginId)
    assert.equal(uninstall.installation.status, 'uninstall-pending')
    assert.equal(uninstall.installation.enabled, false)
    await rolledBack.destroy()

    const cleanupRestart = createManager()
    assert.deepEqual(await cleanupRestart.startup(), [])
    assert.equal(store.pluginPlatform.getSystemPluginInstallationByPlugin(request.pluginId), null)
    assert.equal(store.pluginPlatform.listSystemPluginPackages(request.pluginId).length, 0)
    assert.equal(existsSync(resolution.packageRecord.artifactPath), false)
    assert.equal(store.pluginPlatform.listSystemPluginAudit(request.pluginId).some(
      (entry) => entry.action === 'installation.uninstalled'
    ), true)
    await cleanupRestart.destroy()
  })
})

test('SystemPluginManager binds service RPC to the active revision and persists metadata-only audit', async () => {
  await withManagerFixture(async ({ source, store, createManager, activations }) => {
    const installer = createManager()
    const installed = await installForRestart(installer, source)
    await installer.destroy()
    const captured: { options?: Parameters<SystemPluginServiceFactory>[0] } = {}
    const manager = createManager({
      createServiceRpcMethods: () => ({
        'test.echo': (params) => params
      }),
      createServiceSupervisor: (options) => {
        captured.options = options
        return fakeService(activations, options)
      }
    })
    await manager.startup()
    const rpcHost = captured.options?.rpcHost
    assert.ok(rpcHost)
    const response = await rpcHost.dispatch({
      type: SYSTEM_PLUGIN_SERVICE_RPC_REQUEST,
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      pluginId: installed.request.pluginId,
      revisionHash: `sha256:${installed.packageRecord!.contentHash}`,
      requestId: 'manager-rpc',
      method: 'test.echo',
      params: { secret: 'must-not-be-audited' }
    })
    assert.equal(response?.ok, true)

    const audit = store.pluginPlatform.listSystemPluginAudit(installed.request.pluginId)
      .find((entry) => entry.action === 'service.rpc')
    assert.ok(audit)
    assert.equal(audit.outcome, 'success')
    assert.equal(JSON.stringify(audit.details).includes('must-not-be-audited'), false)
    assert.deepEqual(audit.details, {
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      requestId: 'manager-rpc',
      method: 'test.echo',
      outcome: 'success',
      errorCode: null,
      durationMs: (audit.details as { durationMs: number }).durationMs
    })
    await manager.destroy()
  })
})

test('SystemPluginManager preserves and adopts a live detached service across app restarts', async () => {
  await withManagerFixture(async ({ source, store, createManager, activations }) => {
    writePlugin(source, '1.0.0', 'detached')
    const installer = createManager()
    const request = await installer.prepareInstallFromDirectory({
      sourceDirectory: source,
      reason: 'Detached service fixture.',
      requestedBy: 'user'
    })
    const installed = await installer.resolveInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      artifactSha256: request.artifactSha256,
      acknowledgeSystemAccess: true,
      decision: 'confirm',
      actor: 'user'
    })
    assert.ok(installed.installation)
    await installer.destroy()

    const firstBoot = createManager()
    await firstBoot.startup()
    assert.equal(activations.count, 2)
    const firstRuns = store.pluginPlatform.listSystemPluginRuns(installed.installation.id)
    const detached = firstRuns.find((run) => run.component === 'detached')
    assert.equal(detached?.status, 'ready')
    assert.equal(detached?.pid, process.pid)
    await firstBoot.destroy()
    assert.equal(
      store.pluginPlatform.getSystemPluginRun(detached!.id)?.status,
      'ready'
    )

    const secondBoot = createManager()
    await secondBoot.startup()
    assert.equal(activations.count, 3)
    assert.equal(
      store.pluginPlatform.listSystemPluginRuns(installed.installation.id)
        .filter((run) => run.component === 'detached').length,
      1
    )
    await secondBoot.destroy()
  })
})

test('SystemPluginManager reopens adopted detached RPC with the persisted launch nonce', async () => {
  await withManagerFixture(async ({ source, store, createManager, activations }) => {
    writePlugin(source, '1.0.0', 'detached')
    const installer = createManager()
    const installed = await installForRestart(installer, source)
    await installer.destroy()

    const servers: Array<{
      options: Parameters<SystemPluginServiceRpcServerFactory>[0]
      starts: number
      closes: number
    }> = []
    const createServiceRpcServer: SystemPluginServiceRpcServerFactory = (options) => {
      const record = { options, starts: 0, closes: 0 }
      servers.push(record)
      return {
        async start() { record.starts += 1 },
        async close() { record.closes += 1 }
      }
    }
    const supervisorOptions: Parameters<SystemPluginServiceFactory>[0][] = []
    const commonOptions = {
      createServiceRpcMethods: (() => ({
        'test.echo': (params) => params
      })) satisfies CreateSystemPluginServiceRpcMethods,
      createServiceRpcServer
    }
    const firstBoot = createManager({
      ...commonOptions,
      createServiceSupervisor: (options) => {
        supervisorOptions.push(options)
        return fakeService(activations, options)
      }
    })
    await firstBoot.startup()
    assert.equal(servers.length, 1)
    assert.equal(servers[0].starts, 1)
    const firstSupervisorOptions = supervisorOptions[0]
    assert.ok(firstSupervisorOptions)
    const firstToken = firstSupervisorOptions.environment?.KNOWBOOK_SYSTEM_PLUGIN_RPC_TOKEN
    const firstEndpoint = firstSupervisorOptions.environment?.KNOWBOOK_SYSTEM_PLUGIN_RPC_ENDPOINT
    assert.equal(firstToken, servers[0].options.token)
    assert.equal(firstEndpoint, servers[0].options.endpoint)
    const detachedRun = store.pluginPlatform.listSystemPluginRuns(installed.installation!.id)
      .find((run) => run.component === 'detached')
    const identity = (
      detachedRun?.health as { detachedProcessIdentity?: { launchNonce?: string } }
    )?.detachedProcessIdentity
    assert.equal(identity?.launchNonce, firstToken)

    await firstBoot.destroy()
    assert.equal(servers[0].closes, 1)
    assert.equal(
      (store.pluginPlatform.getSystemPluginRun(detachedRun!.id)?.health as { rpcConnected?: boolean })
        .rpcConnected,
      false
    )

    const secondBoot = createManager(commonOptions)
    await secondBoot.startup()
    assert.equal(servers.length, 2)
    assert.equal(servers[1].starts, 1)
    assert.equal(servers[1].options.token, firstToken)
    assert.equal(servers[1].options.endpoint, firstEndpoint)
    assert.equal(servers[1].options.revisionHash, servers[0].options.revisionHash)
    servers[1].options.onLifecycle?.({
      type: 'knowbook:service:heartbeat',
      protocolVersion: SYSTEM_PLUGIN_SERVICE_RPC_PROTOCOL_VERSION,
      pluginId: installed.request.pluginId,
      revisionHash: servers[1].options.revisionHash,
      payload: { reconnected: true }
    })
    assert.equal(
      (store.pluginPlatform.getSystemPluginRun(detachedRun!.id)?.health as { rpcConnected?: boolean })
        .rpcConnected,
      true
    )
    assert.equal(activations.count, 3)
    await secondBoot.destroy()
    assert.equal(servers[1].closes, 1)
  })
})

test('manually started detached service captures an adoptable process identity', async () => {
  await withManagerFixture(async ({ source, store, createManager, activations }) => {
    writePlugin(source, '1.0.0', 'detached', 'system.manager.fixture', false)
    const installer = createManager()
    const installed = await installForRestart(installer, source)
    await installer.destroy()

    const firstBoot = createManager()
    await firstBoot.startup()
    assert.equal(activations.count, 1)
    const started = await firstBoot.startService(installed.request.pluginId)
    assert.equal(activations.count, 2)
    const run = started.recentRuns.find((candidate) => candidate.component === 'detached')
    assert.equal(run?.pid, process.pid)
    assert.match(
      String((run?.health as { detachedProcessIdentity?: { launchNonce?: string } })
        .detachedProcessIdentity?.launchNonce),
      /^[0-9a-f-]{36}$/i
    )
    await firstBoot.destroy()

    const secondBoot = createManager()
    await secondBoot.startup()
    assert.equal(activations.count, 3)
    assert.equal(
      store.pluginPlatform.listSystemPluginRuns(installed.installation!.id)
        .filter((candidate) => candidate.component === 'detached').length,
      1
    )
    await secondBoot.destroy()
  })
})

test('one-boot safe mode stops a verified detached service without loading plugin code', async () => {
  await withManagerFixture(async ({ source, store, createManager, activations }) => {
    writePlugin(source, '1.0.0', 'detached')
    let alive = true
    const killSignals: NodeJS.Signals[] = []
    const hostProcess = Object.create(process) as NodeJS.Process
    Object.defineProperty(hostProcess, 'kill', {
      configurable: true,
      value: (_pid: number, signal: NodeJS.Signals) => {
        killSignals.push(signal)
        alive = false
        return true
      }
    })
    const lifecycleOptions = {
      process: hostProcess,
      inspectDetachedProcess: async (pid: number) => alive && pid === process.pid
        ? { pid, executable: process.execPath, startToken: 'safe-mode-process-start' }
        : null,
      adoptedServiceStopTimeoutMs: 1,
      adoptedServiceForceKillTimeoutMs: 20
    }
    const installer = createManager()
    const installed = await installForRestart(installer, source)
    await installer.destroy()

    const firstBoot = createManager(lifecycleOptions)
    await firstBoot.startup()
    assert.equal(activations.count, 2)
    await firstBoot.destroy()

    const safeBoot = createManager(lifecycleOptions)
    await safeBoot.startup({ safeMode: true })
    assert.deepEqual(killSignals, ['SIGTERM'])
    assert.equal(activations.count, 2)
    const run = store.pluginPlatform.listSystemPluginRuns(installed.installation!.id)
      .find((candidate) => candidate.component === 'detached')
    assert.equal(run?.status, 'stopped')
    assert.equal(run?.pid, null)
    assert.equal((run?.health as { cleanupReason?: string }).cleanupReason, 'safe-mode')
    await safeBoot.destroy()
  })
})

test('activating a new revision stops the verified detached service from the old revision', async () => {
  await withManagerFixture(async ({ source, store, createManager, activations }) => {
    writePlugin(source, '1.0.0', 'detached')
    let processState: 'old' | 'transition' | 'new' = 'old'
    const killSignals: NodeJS.Signals[] = []
    const hostProcess = Object.create(process) as NodeJS.Process
    Object.defineProperty(hostProcess, 'kill', {
      configurable: true,
      value: (_pid: number, signal: NodeJS.Signals) => {
        killSignals.push(signal)
        processState = 'transition'
        return true
      }
    })
    const inspectDetachedProcess: SystemPluginDetachedProcessInspector = async (pid) => {
      if (pid !== process.pid) return null
      if (processState === 'transition') {
        processState = 'new'
        return null
      }
      return {
        pid,
        executable: process.execPath,
        startToken: processState === 'old' ? 'old-revision-start' : 'new-revision-start'
      }
    }
    const lifecycleOptions = {
      process: hostProcess,
      inspectDetachedProcess,
      adoptedServiceStopTimeoutMs: 1,
      adoptedServiceForceKillTimeoutMs: 20
    }
    const installer = createManager()
    const firstInstall = await installForRestart(installer, source)
    await installer.destroy()
    const firstBoot = createManager(lifecycleOptions)
    await firstBoot.startup()
    await firstBoot.destroy()

    writePlugin(source, '2.0.0', 'detached')
    const updater = createManager()
    const update = await installForRestart(updater, source)
    await updater.destroy()
    assert.notEqual(update.packageRecord?.id, firstInstall.packageRecord?.id)

    const upgradedBoot = createManager(lifecycleOptions)
    const [summary] = await upgradedBoot.startup()
    assert.equal(summary.currentPackage?.version, '2.0.0')
    assert.deepEqual(killSignals, ['SIGTERM'])
    const detachedRuns = store.pluginPlatform.listSystemPluginRuns(firstInstall.installation!.id)
      .filter((run) => run.component === 'detached')
    const oldRun = detachedRuns.find((run) => run.packageId === firstInstall.packageRecord!.id)
    const newRun = detachedRuns.find((run) => run.packageId === update.packageRecord!.id)
    assert.equal(oldRun?.status, 'stopped')
    assert.equal((oldRun?.health as { cleanupReason?: string }).cleanupReason, 'superseded')
    assert.equal(newRun?.status, 'ready')
    assert.equal(
      (newRun?.health as { detachedProcessIdentity?: { startToken?: string } })
        .detachedProcessIdentity?.startToken,
      'new-revision-start'
    )
    assert.equal(activations.count, 4)
    await upgradedBoot.destroy()
  })
})

test('SystemPluginManager requires a separate exact confirmation for OS startup and removes it on uninstall', async () => {
  await withManagerFixture(async ({ source, createManager }) => {
    writePlugin(source, '1.0.0', 'detached')
    const installer = createManager()
    const request = await installer.prepareInstallFromDirectory({
      sourceDirectory: source,
      reason: 'OS persistence fixture.',
      requestedBy: 'user'
    })
    await installer.resolveInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      artifactSha256: request.artifactSha256,
      acknowledgeSystemAccess: true,
      decision: 'confirm',
      actor: 'user'
    })
    await installer.destroy()

    const loginItems = new FakeManagerLoginItems()
    const adapter = createFullTrustElectronLoginItemAdapter({
      platform: 'win32',
      app: loginItems
    })
    const manager = createManager({
      osPersistenceAdapter: adapter,
      osPersistenceCommand: (pluginId) => ({
        executable: 'C:\\Program Files\\KnowBook\\KnowBook.exe',
        args: [`--knowbook-system-plugin-os-startup=${pluginId}`]
      })
    })
    await manager.startup()
    const persistence = manager.requestOsPersistence(request.pluginId)
    assert.equal(persistence.status, 'awaiting-confirmation')
    assert.equal(loginItems.calls.length, 0)
    await assert.rejects(manager.resolveOsPersistence({
      recordId: persistence.id,
      pluginId: request.pluginId,
      revisionHash: `sha256:${'0'.repeat(64)}`,
      decision: 'confirm',
      acknowledgeSystemStartup: true,
      actor: 'user'
    }), /reviewed revision/)

    const registered = await manager.resolveOsPersistence({
      recordId: persistence.id,
      pluginId: request.pluginId,
      revisionHash: persistence.revisionHash,
      decision: 'confirm',
      acknowledgeSystemStartup: true,
      actor: 'user'
    })
    assert.equal(registered.status, 'registered')
    assert.equal(loginItems.calls.length, 1)
    assert.equal(manager.get(request.pluginId)?.osPersistence?.status, 'registered')

    const uninstall = await manager.requestUninstall(request.pluginId)
    assert.equal(uninstall.installation.status, 'uninstall-pending')
    assert.equal(uninstall.osPersistence?.status, 'removed')
    assert.equal(loginItems.calls.length, 2)
    await manager.destroy()

    const cleanup = createManager({
      osPersistenceAdapter: adapter,
      osPersistenceCommand: (pluginId) => ({
        executable: 'C:\\Program Files\\KnowBook\\KnowBook.exe',
        args: [`--knowbook-system-plugin-os-startup=${pluginId}`]
      })
    })
    assert.deepEqual(await cleanup.startup(), [])
    await cleanup.destroy()
  })
})

test('macOS main-app login persistence has exactly one Full Trust plugin owner', async () => {
  await withManagerFixture(async ({ root, source, createManager }) => {
    const secondSource = join(root, 'source-second')
    writePlugin(source, '1.0.0', 'detached', 'system.manager.first')
    writePlugin(secondSource, '1.0.0', 'detached', 'system.manager.second')
    const installer = createManager()
    const first = await installForRestart(installer, source)
    const second = await installForRestart(installer, secondSource)
    await installer.destroy()

    const loginItems = new FakeManagerLoginItems()
    const manager = createManager({
      osPersistenceAdapter: createFullTrustElectronLoginItemAdapter({
        platform: 'darwin',
        app: loginItems
      }),
      osPersistenceCommand: (pluginId) => ({
        executable: '/Applications/KnowBook.app/Contents/MacOS/KnowBook',
        args: [`--knowbook-system-plugin-os-startup=${pluginId}`]
      })
    })
    await manager.startup()
    const firstReview = manager.requestOsPersistence(first.request.pluginId)
    await manager.resolveOsPersistence({
      recordId: firstReview.id,
      pluginId: first.request.pluginId,
      revisionHash: firstReview.revisionHash,
      decision: 'confirm',
      acknowledgeSystemStartup: true,
      actor: 'user'
    })

    assert.throws(
      () => manager.requestOsPersistence(second.request.pluginId),
      /already owned by Full Trust plugin "system\.manager\.first"/
    )
    assert.equal(loginItems.calls.length, 1)
    assert.equal(manager.get(first.request.pluginId)?.osPersistence?.status, 'registered')
    assert.equal(manager.get(second.request.pluginId)?.osPersistence, null)
    await manager.destroy()
  })
})

test('detached adoption rejects a reused PID with a different process start token', async () => {
  await withManagerFixture(async ({ source, store, createManager, activations }) => {
    writePlugin(source, '1.0.0', 'detached')
    const installer = createManager()
    const installed = await installForRestart(installer, source)
    await installer.destroy()

    const firstBoot = createManager()
    await firstBoot.startup()
    await firstBoot.destroy()
    assert.equal(activations.count, 2)

    const secondBoot = createManager({
      inspectDetachedProcess: async (pid) => pid === process.pid
        ? { pid, executable: process.execPath, startToken: 'replacement-process-start' }
        : null
    })
    await secondBoot.startup()
    assert.equal(activations.count, 4)
    const detachedRuns = store.pluginPlatform.listSystemPluginRuns(installed.installation!.id)
      .filter((run) => run.component === 'detached')
    assert.equal(detachedRuns.length, 2)
    assert.equal(detachedRuns.some((run) => (
      run.status === 'failed' && JSON.stringify(run.error).includes('identity could not be verified')
    )), true)
    assert.equal(detachedRuns.some((run) => run.status === 'ready'), true)
    await secondBoot.destroy()
  })
})

test('stopping an adopted detached service verifies identity and escalates to a confirmed force kill', async () => {
  await withManagerFixture(async ({ source, createManager, activations }) => {
    writePlugin(source, '1.0.0', 'detached')
    const installer = createManager()
    await installForRestart(installer, source)
    await installer.destroy()

    const firstBoot = createManager()
    await firstBoot.startup()
    await firstBoot.destroy()
    assert.equal(activations.count, 2)

    let alive = true
    const killSignals: NodeJS.Signals[] = []
    const hostProcess = Object.create(process) as NodeJS.Process
    Object.defineProperty(hostProcess, 'kill', {
      configurable: true,
      value: (_pid: number, signal: NodeJS.Signals) => {
        killSignals.push(signal)
        if (signal === 'SIGKILL') alive = false
        return true
      }
    })
    const manager = createManager({
      process: hostProcess,
      inspectDetachedProcess: async (pid) => alive && pid === process.pid
        ? { pid, executable: process.execPath, startToken: 'fixture-process-start' }
        : null,
      adoptedServiceStopTimeoutMs: 1,
      adoptedServiceForceKillTimeoutMs: 20
    })
    await manager.startup()
    assert.equal(activations.count, 3)
    const stopped = await manager.stopService('system.manager.fixture')
    assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL'])
    const stoppedService = stopped.recentRuns.find((run) => run.component === 'detached')
    assert.equal(stoppedService?.status, 'stopped')
    assert.equal(stoppedService?.pid, null)
    await manager.destroy()
  })
})

test('an adopted detached service can be stopped and started again in the same host session', async () => {
  await withManagerFixture(async ({ source, createManager, activations }) => {
    writePlugin(source, '1.0.0', 'detached')
    const installer = createManager()
    await installForRestart(installer, source)
    await installer.destroy()
    const firstBoot = createManager()
    await firstBoot.startup()
    await firstBoot.destroy()

    let processState: 'adopted' | 'transition' | 'restarted' = 'adopted'
    const hostProcess = Object.create(process) as NodeJS.Process
    Object.defineProperty(hostProcess, 'kill', {
      configurable: true,
      value: () => {
        processState = 'transition'
        return true
      }
    })
    const manager = createManager({
      process: hostProcess,
      inspectDetachedProcess: async (pid) => {
        if (pid !== process.pid) return null
        if (processState === 'transition') {
          processState = 'restarted'
          return null
        }
        return {
          pid,
          executable: process.execPath,
          startToken: processState === 'adopted'
            ? 'fixture-process-start'
            : 'restarted-process-start'
        }
      },
      adoptedServiceStopTimeoutMs: 1,
      adoptedServiceForceKillTimeoutMs: 20
    })
    await manager.startup()
    assert.equal(activations.count, 3)
    await manager.stopService('system.manager.fixture')
    const restarted = await manager.startService('system.manager.fixture')
    assert.equal(activations.count, 4)
    const run = restarted.recentRuns.find((candidate) => candidate.component === 'detached')
    assert.equal(run?.status, 'ready')
    assert.equal(
      (run?.health as { detachedProcessIdentity?: { startToken?: string } })
        .detachedProcessIdentity?.startToken,
      'restarted-process-start'
    )
    await manager.destroy()
  })
})

test('auto-start service spawn failure cannot mark a Full Trust installation active', async () => {
  await withManagerFixture(async ({ source, store, createManager }) => {
    const installer = createManager()
    const installed = await installForRestart(installer, source)
    await installer.destroy()

    const manager = createManager({
      createServiceSupervisor: (options) => failedService(options)
    })
    const [summary] = await manager.startup()
    assert.equal(summary.installation.status, 'safe-mode-disabled')
    assert.equal(summary.installation.enabled, false)
    assert.equal(summary.installation.safeModeDisabled, true)
    assert.match(JSON.stringify(summary.installation.lastError), /failed synchronously/)
    assert.equal(summary.runtime, null)
    assert.equal(store.pluginPlatform.getSystemPluginPackage(installed.packageRecord!.id)?.status, 'failed')
    assert.equal(
      store.pluginPlatform.listSystemPluginRuns(installed.installation!.id)
        .some((run) => run.component === 'service' && run.status === 'failed'),
      true
    )
    await manager.destroy()
  })
})

test('startup retries after a rejected startup operation instead of caching the rejection', async () => {
  await withManagerFixture(async ({ createManager }) => {
    const manager = createManager()
    const privateManager = manager as unknown as {
      runStartup(safeMode: boolean): Promise<ReturnType<typeof manager.list>>
    }
    let attempts = 0
    privateManager.runStartup = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient startup failure')
      return []
    }

    await assert.rejects(manager.startup(), /transient startup failure/)
    assert.deepEqual(await manager.startup(), [])
    assert.equal(attempts, 2)
    await manager.destroy()
  })
})

test('startup removes staging left behind by a previously resolved install request', async () => {
  await withManagerFixture(async ({ source, store, createManager }) => {
    const manager = createManager()
    const request = await manager.prepareInstallFromDirectory({
      sourceDirectory: source,
      reason: 'Leave resolved staging for recovery.',
      requestedBy: 'user'
    })
    const stagingPath = request.stagedArtifactPath!
    assert.equal(existsSync(stagingPath), true)
    store.pluginPlatform.resolveSystemPluginInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      artifactSha256: request.artifactSha256,
      acknowledgeSystemAccess: false,
      decision: 'cancel'
    })
    await manager.destroy()

    const restarted = createManager()
    assert.deepEqual(await restarted.startup(), [])
    assert.equal(existsSync(stagingPath), false)
    assert.equal(store.pluginPlatform.getSystemPluginInstallRequest(request.id)?.stagedArtifactPath, null)
    assert.equal(store.pluginPlatform.listSystemPluginAudit(request.pluginId).some(
      (entry) => entry.action === 'install.staging-recovered' && entry.outcome === 'success'
    ), true)
    await restarted.destroy()
  })
})

test('SystemPluginManager safe-disables an installation with an armed crash marker', async () => {
  await withManagerFixture(async ({ source, store, createManager, activations }) => {
    const installer = createManager()
    const request = await installer.prepareInstallFromDirectory({
      sourceDirectory: source,
      reason: 'Crash recovery fixture.',
      requestedBy: 'user'
    })
    const installed = await installer.resolveInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      artifactSha256: request.artifactSha256,
      acknowledgeSystemAccess: true,
      decision: 'confirm',
      actor: 'user'
    })
    assert.ok(installed.installation && installed.packageRecord)
    const run = store.pluginPlatform.createSystemPluginRun({
      installationId: installed.installation.id,
      packageId: installed.packageRecord.id,
      component: 'main',
      pid: 123
    })
    store.pluginPlatform.createSystemPluginCrashMarker({
      installationId: installed.installation.id,
      packageId: installed.packageRecord.id,
      runId: run.id,
      phase: 'activation.main'
    })
    await installer.destroy()

    const restarted = createManager()
    const [summary] = await restarted.startup()
    assert.equal(activations.count, 0)
    assert.equal(summary.installation.status, 'safe-mode-disabled')
    assert.equal(summary.installation.enabled, false)
    assert.equal(summary.installation.safeModeDisabled, true)
    assert.match(JSON.stringify(summary.installation.lastError), /exited before/i)
    await restarted.destroy()
  })
})

async function installForRestart(
  manager: SystemPluginManager<Record<never, never>>,
  sourceDirectory: string
) {
  const request = await manager.prepareInstallFromDirectory({
    sourceDirectory,
    reason: 'Install manager hardening fixture.',
    requestedBy: 'user'
  })
  const resolution = await manager.resolveInstallRequest({
    requestId: request.id,
    pluginId: request.pluginId,
    artifactSha256: request.artifactSha256,
    acknowledgeSystemAccess: true,
    decision: 'confirm',
    actor: 'user'
  })
  return resolution
}

function failedService(
  options: Parameters<SystemPluginServiceFactory>[0]
): SystemPluginServiceController {
  let snapshot: SystemPluginServiceController['snapshot'] = {
    pluginId: options.package.manifest.id,
    version: options.package.manifest.version,
    revisionHash: options.package.revisionHash,
    mode: options.package.manifest.background!.mode,
    status: 'idle',
    pid: null,
    ready: false,
    restartCount: 0,
    startedAt: null,
    readyAt: null,
    lastHeartbeatAt: null,
    lastExit: null
  }
  const fail = () => {
    snapshot = { ...snapshot, status: 'failed' }
    return snapshot
  }
  return {
    get snapshot() {
      return snapshot
    },
    start: fail,
    startIfConfigured: fail,
    async stop() {
      snapshot = { ...snapshot, status: 'stopped' }
      return snapshot
    }
  }
}

async function withManagerFixture(run: (input: {
  root: string
  source: string
  store: KnowbookStore
  activations: { count: number }
    createManager: (options?: {
    osPersistenceAdapter?: FullTrustOsPersistenceAdapter
    osPersistenceCommand?: (pluginId: string) => { executable: string; args: string[] }
    inspectDetachedProcess?: SystemPluginDetachedProcessInspector
    createServiceSupervisor?: SystemPluginServiceFactory
    createServiceRpcMethods?: CreateSystemPluginServiceRpcMethods
    createServiceRpcServer?: SystemPluginServiceRpcServerFactory
    adoptedServiceStopTimeoutMs?: number
    adoptedServiceForceKillTimeoutMs?: number
    preparePublishedPackage?: PreparePublishedSystemPluginPackage
    process?: NodeJS.Process
  }) => SystemPluginManager<Record<never, never>>
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-system-manager-'))
  const source = join(root, 'source')
  const store = new KnowbookStore(join(root, 'knowbook.db'))
  const activations = { count: 0 }
  writePlugin(source)
  try {
    await run({
      root,
      source,
      store,
      activations,
      createManager: (options = {}) => new SystemPluginManager({
        repository: store.pluginPlatform,
        stagingRoot: join(root, 'staging'),
        artifactRoot: join(root, 'artifacts'),
        runtimeRoot: join(root, 'runtime'),
        dataRoot: join(root, 'data'),
        logRoot: join(root, 'logs'),
        backupRoot: join(root, 'backups'),
        backupDatabase: (destination) => store.backupDatabase(destination),
        services: {},
        createHost: () => fakeHost(activations),
        createServiceSupervisor: (serviceOptions) => fakeService(activations, serviceOptions),
        inspectDetachedProcess: async (pid) => pid === process.pid
          ? { pid, executable: process.execPath, startToken: 'fixture-process-start' }
          : null,
        ...options
      })
    })
  } finally {
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
}

function fakeHost(activations: { count: number }): SystemPluginHostController {
  let status: SystemPluginRuntimeStatus = 'idle'
  return {
    get status() {
      return status
    },
    async activate() {
      activations.count += 1
      status = 'active'
      return {
        entryPath: 'dist/main.cjs',
        format: 'cjs',
        health: { ok: true }
      }
    },
    async healthCheck() {
      return { ok: true }
    },
    async beforeQuit() {},
    async deactivate() {
      status = 'stopped'
    }
  }
}

function fakeService(
  activations: { count: number },
  options: Parameters<SystemPluginServiceFactory>[0]
): SystemPluginServiceController {
  let snapshot: SystemPluginServiceController['snapshot'] = {
    pluginId: options.package.manifest.id,
    version: options.package.manifest.version,
    revisionHash: options.package.revisionHash,
    mode: options.package.manifest.background!.mode,
    status: 'idle',
    pid: null,
    ready: false,
    restartCount: 0,
    startedAt: null,
    readyAt: null,
    lastHeartbeatAt: null,
    lastExit: null
  }
  return {
    get snapshot() {
      return snapshot
    },
    start() {
      activations.count += 1
      const readyAt = new Date().toISOString()
      snapshot = {
        ...snapshot,
        status: 'running',
        pid: snapshot.mode === 'detached' ? process.pid : null,
        ready: true,
        startedAt: readyAt,
        readyAt,
        lastHeartbeatAt: readyAt
      }
      return snapshot
    },
    startIfConfigured() {
      return options.package.manifest.background!.autoStart
        ? this.start()
        : snapshot
    },
    async stop() {
      snapshot = { ...snapshot, status: 'stopped', pid: null }
      return snapshot
    }
  }
}

function writePlugin(
  root: string,
  version = '1.0.0',
  backgroundMode: 'app-lifetime' | 'detached' = 'app-lifetime',
  pluginId = 'system.manager.fixture',
  autoStart = true
): void {
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 3,
    trust: 'full',
    id: pluginId,
    name: 'Manager fixture',
    version,
    publisher: 'KnowBook tests',
    entries: { main: 'dist/main.cjs', service: 'dist/service.cjs' },
    background: { mode: backgroundMode, autoStart },
    fullAccess: true,
    riskDeclarations: ['filesystem', 'node', 'database', 'os-persistence']
  }, null, 2))
  writeFileSync(join(root, 'dist', 'main.cjs'), `module.exports = { activate() { return ${JSON.stringify(version)} } }\n`)
  writeFileSync(join(root, 'dist', 'service.cjs'), `module.exports = { activate() { return ${JSON.stringify(version)} } }\n`)
}

class FakeManagerLoginItems implements FullTrustElectronLoginItemApplication {
  readonly calls: FullTrustElectronLoginItemSettings[] = []
  private current: FullTrustElectronLoginItemSettings | null = null

  setLoginItemSettings(settings: FullTrustElectronLoginItemSettings): void {
    this.calls.push({
      ...settings,
      ...(settings.args ? { args: [...settings.args] } : {})
    })
    this.current = settings.openAtLogin ? settings : null
  }

  getLoginItemSettings(
    _options?: FullTrustElectronLoginItemQuery
  ): FullTrustElectronLoginItemState {
    const current = this.current
    return {
      openAtLogin: current !== null,
      executableWillLaunchAtLogin: current !== null,
      launchItems: current
        ? [{
            name: current.name ?? '',
            path: current.path ?? '',
            args: [...(current.args ?? [])],
            scope: 'user',
            enabled: current.enabled !== false
          }]
        : []
    }
  }
}
