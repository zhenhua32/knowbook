import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import type {
  NoNodePluginRuntimeFactory,
  NoNodePluginRuntimeHostContext
} from '../src/main/plugin-platform/activation-coordinator.ts'
import { PluginPlatformV2Service } from '../src/main/plugin-platform/platform-service.ts'
import type { PluginPlatformScope } from '../src/shared/plugin-platform.ts'

test('post-commit iframe failure revokes the failed run and automatically restores the last successful revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-plugin-ui-recovery-test-'))
  const store = new KnowbookStore(join(root, 'knowbook.sqlite'))
  const runtimeFactory: NoNodePluginRuntimeFactory = {
    isolation: 'no-node-isolate',
    create: async (context: NoNodePluginRuntimeHostContext) => ({
      activate: async () => ({
        contributions: [{
          descriptor: { slot: 'workspace.dashboard', id: 'advanced-frame' },
          value: {
            kind: 'iframe',
            asset: 'frame.html',
            title: `Frame ${context.package.manifest.version}`,
            handlers: []
          }
        }]
      }),
      commit: () => undefined,
      invokeHandler: async () => null,
      dispose: () => undefined
    })
  }
  const service = new PluginPlatformV2Service(store, join(root, 'plugins-v2'), {
    workspaceId: 'workspace-1',
    runtimeFactory
  })
  const scope: PluginPlatformScope = { kind: 'workspace', workspaceId: 'workspace-1' }

  try {
    store.pluginPlatform.createDefinition({
      id: 'advanced-ui',
      name: 'Advanced UI',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const first = publishRevision(service, store, '1.0.0')
    const second = publishRevision(service, store, '2.0.0', first.revisionId)
    const installation = store.pluginPlatform.ensureInstallation({
      id: 'advanced-ui-installation',
      pluginId: 'advanced-ui',
      scope
    })
    const firstGrant = store.pluginPlatform.createGrantSet({
      id: 'grant-v1',
      pluginId: 'advanced-ui',
      revisionId: first.revisionId,
      installationId: installation.id,
      scope,
      grants: [],
      createdAt: '2026-08-28T00:00:00.000Z'
    })
    const firstReceipt = await service.coordinator.activate({
      pluginId: 'advanced-ui',
      revisionId: first.revisionId,
      grantSetId: firstGrant.id,
      installationId: installation.id,
      scope,
      runId: 'run-v1'
    })
    const secondGrant = store.pluginPlatform.createGrantSet({
      id: 'grant-v2',
      pluginId: 'advanced-ui',
      revisionId: second.revisionId,
      installationId: installation.id,
      scope,
      grants: [],
      createdAt: '2026-08-28T00:01:00.000Z'
    })
    const secondReceipt = await service.coordinator.activate({
      pluginId: 'advanced-ui',
      revisionId: second.revisionId,
      grantSetId: secondGrant.id,
      installationId: installation.id,
      scope,
      runId: 'run-v2'
    })
    await secondReceipt.previousDrain

    assert.equal(firstReceipt.owner.revisionId, first.revisionId)
    assert.equal(service.listUiContributions('workspace.dashboard')[0]?.owner.runId, 'run-v2')

    await service.reportUiRuntimeFailure({
      owner: secondReceipt.owner,
      contributionId: 'advanced-frame',
      error: 'simulated post-commit render failure'
    })

    const restored = service.listUiContributions('workspace.dashboard')[0]
    assert.equal(restored?.owner.revisionId, first.revisionId)
    assert.notEqual(restored?.owner.runId, firstReceipt.owner.runId)
    assert.equal(store.pluginPlatform.getRun('run-v2')?.status, 'failed')
    assert.equal(store.pluginPlatform.getGrantSet(secondGrant.id), null)
    assert.equal(store.pluginPlatform.getInstallation(installation.id)?.currentRevisionId, first.revisionId)
    assert.equal(
      store.pluginPlatform.listPluginLogs('advanced-ui').some((entry) => (
        entry.event === 'ui.auto-rollback.succeeded'
      )),
      true
    )
  } finally {
    await service.destroy()
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

test('workspace lifecycle controls disable, restore, and fully uninstall a dynamic plugin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-plugin-lifecycle-test-'))
  const store = new KnowbookStore(join(root, 'knowbook.sqlite'))
  const service = new PluginPlatformV2Service(store, join(root, 'plugins-v2'), {
    workspaceId: 'workspace-1',
    runtimeFactory: {
      isolation: 'no-node-isolate',
      create: async () => ({
        activate: async () => ({ contributions: [] }),
        commit: () => undefined,
        invokeHandler: async () => null,
        dispose: () => undefined
      })
    }
  })
  const scope: PluginPlatformScope = { kind: 'workspace', workspaceId: 'workspace-1' }

  try {
    store.pluginPlatform.createDefinition({
      id: 'advanced-ui',
      name: 'Advanced UI',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const revision = publishRevision(service, store, '1.0.0')
    const installation = store.pluginPlatform.ensureInstallation({
      id: 'advanced-ui-installation',
      pluginId: 'advanced-ui',
      scope
    })
    const grant = store.pluginPlatform.createGrantSet({
      id: 'advanced-ui-grant',
      pluginId: 'advanced-ui',
      revisionId: revision.revisionId,
      installationId: installation.id,
      scope,
      grants: [],
      createdAt: '2026-08-29T00:00:00.000Z'
    })
    await service.coordinator.activate({
      pluginId: 'advanced-ui',
      revisionId: revision.revisionId,
      grantSetId: grant.id,
      installationId: installation.id,
      scope,
      runId: 'initial-run'
    })

    await service.setWorkspacePluginEnabled('advanced-ui', false)
    assert.equal(store.pluginPlatform.getInstallation(installation.id)?.enabled, false)
    assert.equal(store.pluginPlatform.getInstallation(installation.id)?.activeRunId, null)
    assert.equal(store.pluginPlatform.getRun('initial-run')?.status, 'stopped')
    assert.equal(service.kernel.getActiveOwner('advanced-ui', scope), null)

    await service.setWorkspacePluginEnabled('advanced-ui', true)
    const restored = store.pluginPlatform.getInstallation(installation.id)
    assert.equal(restored?.enabled, true)
    assert.ok(restored?.activeRunId)
    assert.notEqual(restored?.activeRunId, 'initial-run')
    assert.equal(restored?.currentRevisionId, revision.revisionId)

    await service.removeWorkspacePlugin('advanced-ui')
    assert.equal(store.pluginPlatform.getDefinition('advanced-ui'), null)
    assert.equal(store.pluginPlatform.getInstallation(installation.id), null)
    assert.equal(service.revisions.has(revision.revisionId), false)
    assert.equal(service.kernel.getActiveOwner('advanced-ui', scope), null)
  } finally {
    await service.destroy()
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

function publishRevision(
  service: PluginPlatformV2Service,
  store: KnowbookStore,
  version: string,
  previousRevisionId?: string
) {
  const package_ = service.revisions.publish({
    manifest: {
      schemaVersion: 2,
      id: 'advanced-ui',
      name: 'Advanced UI',
      version,
      apiVersion: '2',
      permissions: [],
      standardModules: []
    },
    workerSource: 'export const handlers = {}',
    assets: {
      'frame.html': new TextEncoder().encode('<script>globalThis.frameReady = true</script>')
    }
  })
  store.pluginPlatform.createRevision({
    package: package_,
    previousRevisionId,
    staticCheckStatus: 'passed'
  })
  return package_
}
