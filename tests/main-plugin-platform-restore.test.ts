import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import {
  PluginActivationCoordinator,
  PluginCapabilityBroker,
  PluginPlatformKernel,
  PluginRevisionStore,
  restoreWorkspacePluginInstallations,
  type NoNodePluginRuntimeFactory
} from '../src/main/plugin-platform/index.ts'
import type { PluginPlatformScope } from '../src/shared/plugin-platform.ts'

const workspaceId = 'workspace-restore'
const scope: PluginPlatformScope = { kind: 'workspace', workspaceId }

test('enabled workspace installation restores its exact successful revision with a fresh run', async () => {
  await withPersistedInstallation(async ({ root, databasePath, revisionRoot, installationId, firstRunId }) => {
    const store = new KnowbookStore(databasePath)
    store.pluginPlatform.recoverInterruptedRuns()
    let activations = 0
    const kernel = new PluginPlatformKernel()
    const coordinator = new PluginActivationCoordinator(
      kernel,
      new PluginCapabilityBroker(kernel),
      store.pluginPlatform,
      new PluginRevisionStore(revisionRoot),
      staticRuntimeFactory(() => {
        activations += 1
      })
    )
    try {
      const recovered = store.pluginPlatform.getInstallation(installationId)
      assert.equal(recovered?.activeRunId, null)
      assert.equal(store.pluginPlatform.getRun(firstRunId)?.status, 'stopped')

      const result = await restoreWorkspacePluginInstallations({
        repository: store.pluginPlatform,
        coordinator,
        workspaceId
      })

      const restored = store.pluginPlatform.getInstallation(installationId)
      assert.equal(activations, 1)
      assert.deepEqual(result.restoredInstallationIds, [installationId])
      assert.ok(restored?.activeRunId)
      assert.notEqual(restored.activeRunId, firstRunId)
      assert.equal(restored.currentRevisionId, recovered?.currentRevisionId)
      assert.equal(restored.pendingRevisionId, null)
      assert.equal(store.pluginPlatform.getRun(restored.activeRunId)?.status, 'active')
    } finally {
      await kernel.destroy()
      store.destroy()
      assert.equal(root.length > 0, true)
    }
  })
})

test('workspace restore failure preserves the last successful revision and records diagnostics', async () => {
  await withPersistedInstallation(async ({ databasePath, revisionRoot, installationId, grantSetId }) => {
    const before = new KnowbookStore(databasePath)
    before.pluginPlatform.revokeGrantSet(grantSetId)
    before.destroy()

    const store = new KnowbookStore(databasePath)
    store.pluginPlatform.recoverInterruptedRuns()
    const kernel = new PluginPlatformKernel()
    const coordinator = new PluginActivationCoordinator(
      kernel,
      new PluginCapabilityBroker(kernel),
      store.pluginPlatform,
      new PluginRevisionStore(revisionRoot),
      staticRuntimeFactory()
    )
    try {
      const currentRevisionId = store.pluginPlatform.getInstallation(installationId)?.currentRevisionId
      const result = await restoreWorkspacePluginInstallations({
        repository: store.pluginPlatform,
        coordinator,
        workspaceId
      })

      const failed = store.pluginPlatform.getInstallation(installationId)
      assert.equal(failed?.currentRevisionId, currentRevisionId)
      assert.deepEqual(result.failedInstallationIds, [installationId])
      assert.equal(failed?.activeRunId, null)
      assert.match(JSON.stringify(failed?.lastError), /grant set/)
      assert.equal(
        store.pluginPlatform.listPluginLogs('restore-plugin')
          .some((log) => log.event === 'installation.restore.failed'),
        true
      )
    } finally {
      await kernel.destroy()
      store.destroy()
    }
  })
})

async function withPersistedInstallation(
  run: (context: {
    root: string
    databasePath: string
    revisionRoot: string
    installationId: string
    grantSetId: string
    firstRunId: string
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-plugin-restore-test-'))
  const databasePath = join(root, 'knowbook.sqlite')
  const revisionRoot = join(root, 'plugins-v2')
  const installationId = 'restore-installation'
  const grantSetId = 'restore-grant'
  const firstRunId = 'restore-run-before-restart'
  const store = new KnowbookStore(databasePath)
  const revisions = new PluginRevisionStore(revisionRoot)
  const kernel = new PluginPlatformKernel()
  const broker = new PluginCapabilityBroker(kernel)
  const coordinator = new PluginActivationCoordinator(
    kernel,
    broker,
    store.pluginPlatform,
    revisions,
    staticRuntimeFactory()
  )
  try {
    store.pluginPlatform.createDefinition({
      id: 'restore-plugin',
      name: 'Restore Plugin',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const packageValue = revisions.publish({
      manifest: {
        schemaVersion: 2,
        id: 'restore-plugin',
        name: 'Restore Plugin',
        version: '1.0.0',
        apiVersion: '2',
        permissions: [],
        standardModules: []
      },
      workerSource: 'export default { activate() { return { contributions: [] } } }'
    })
    store.pluginPlatform.createRevision({ package: packageValue, staticCheckStatus: 'passed' })
    store.pluginPlatform.ensureInstallation({
      id: installationId,
      pluginId: 'restore-plugin',
      scope
    })
    store.pluginPlatform.createGrantSet({
      id: grantSetId,
      pluginId: 'restore-plugin',
      revisionId: packageValue.revisionId,
      installationId,
      scope,
      grants: [],
      createdAt: '2026-08-26T00:00:00.000Z'
    })
    await coordinator.activate({
      pluginId: 'restore-plugin',
      revisionId: packageValue.revisionId,
      grantSetId,
      installationId,
      scope,
      runId: firstRunId
    })
  } finally {
    await kernel.destroy()
    store.destroy()
  }

  try {
    await run({ root, databasePath, revisionRoot, installationId, grantSetId, firstRunId })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function staticRuntimeFactory(onActivate: () => void = () => undefined): NoNodePluginRuntimeFactory {
  return {
    isolation: 'no-node-isolate',
    create: async () => ({
      activate: async () => {
        onActivate()
        return { contributions: [] }
      },
      commit: () => undefined,
      invokeHandler: async () => null,
      dispose: () => undefined
    })
  }
}
