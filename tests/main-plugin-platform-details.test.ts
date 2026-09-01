import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { PluginPlatformV2Service } from '../src/main/plugin-platform/platform-service.ts'
import type { PluginV2Manifest } from '../src/shared/plugin-platform.ts'

test('workspace plugin details expose current permissions, revision history, and bounded logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-plugin-details-test-'))
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
  const scope = { kind: 'workspace' as const, workspaceId: 'workspace-1' }

  try {
    store.pluginPlatform.createDefinition({
      id: 'detail-plugin',
      name: 'Detail Plugin',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const first = publishRevision(service, store, '1.0.0', [])
    const second = publishRevision(service, store, '2.0.0', [
      { capability: 'ui.notify', version: 1 }
    ], first.revisionId)
    const installation = store.pluginPlatform.ensureInstallation({
      id: 'detail-plugin-installation',
      pluginId: 'detail-plugin',
      scope
    })
    const firstGrant = store.pluginPlatform.createGrantSet({
      id: 'detail-plugin-grant-v1',
      pluginId: 'detail-plugin',
      revisionId: first.revisionId,
      installationId: installation.id,
      scope,
      grants: [],
      createdAt: '2026-09-01T00:00:00.000Z'
    })
    await service.coordinator.activate({
      pluginId: 'detail-plugin',
      revisionId: first.revisionId,
      grantSetId: firstGrant.id,
      installationId: installation.id,
      scope,
      runId: 'detail-plugin-run-v1'
    })
    const secondGrant = store.pluginPlatform.createGrantSet({
      id: 'detail-plugin-grant-v2',
      pluginId: 'detail-plugin',
      revisionId: second.revisionId,
      installationId: installation.id,
      scope,
      grants: [{ capability: 'ui.notify', version: 1 }],
      createdAt: '2026-09-01T00:01:00.000Z'
    })
    const secondActivation = await service.coordinator.activate({
      pluginId: 'detail-plugin',
      revisionId: second.revisionId,
      grantSetId: secondGrant.id,
      installationId: installation.id,
      scope,
      runId: 'detail-plugin-run-v2'
    })
    await secondActivation.previousDrain
    store.pluginPlatform.appendPluginLog({
      id: 'detail-log',
      pluginId: 'detail-plugin',
      revisionId: second.revisionId,
      runId: 'detail-plugin-run-v2',
      level: 'info',
      event: 'detail.test',
      message: 'Plugin details are visible.'
    })

    const details = service.getWorkspacePluginDetails('detail-plugin')
    assert.equal(details.currentRevisionId, second.revisionId)
    assert.deepEqual(details.permissions, [{ capability: 'ui.notify', version: 1 }])
    assert.deepEqual(details.revisions.map((revision) => ({
      version: revision.version,
      current: revision.current,
      activated: revision.activated,
      permissionCount: revision.permissionCount
    })), [
      { version: '2.0.0', current: true, activated: true, permissionCount: 1 },
      { version: '1.0.0', current: false, activated: true, permissionCount: 0 }
    ])
    assert.equal(details.recentLogs[0]?.event, 'detail.test')
    assert.equal(details.recentLogs[0]?.message, 'Plugin details are visible.')
    assert.throws(
      () => service.getWorkspacePluginDetails('not-installed'),
      /not installed/
    )
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
  permissions: PluginV2Manifest['permissions'],
  previousRevisionId?: string
) {
  const package_ = service.revisions.publish({
    manifest: {
      schemaVersion: 2,
      id: 'detail-plugin',
      name: 'Detail Plugin',
      version,
      apiVersion: '2',
      permissions,
      standardModules: []
    },
    workerSource: 'export const handlers = {}',
    assets: {}
  })
  store.pluginPlatform.createRevision({
    package: package_,
    previousRevisionId,
    staticCheckStatus: 'passed'
  })
  return package_
}
