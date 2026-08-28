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
  type NoNodePluginRuntimeFactory,
  type NoNodePluginRuntimeHostContext,
  type NoNodePluginRuntimeInstance,
  type PluginUiPreparationHook
} from '../src/main/plugin-platform/index.ts'
import type {
  PluginActiveOwner,
  PluginGrantSet,
  PluginJsonValue,
  PluginPlatformScope,
  PluginRevisionPackage
} from '../src/shared/plugin-platform.ts'

const scope: PluginPlatformScope = {
  kind: 'workspace',
  workspaceId: 'workspace-1'
}

test('activation coordinator commits verified runtime contributions and routes handlers through broker', async () => {
  await withPlatform(async (platform) => {
    const packageValue = platform.createRevision('1.0.0', 'export const version = 1')
    platform.createGrant('grant-1', packageValue.revisionId)
    const committedOwner: { current: PluginActiveOwner | null } = { current: null }
    let disposed = false
    const factory = runtimeFactory((context) => ({
      activate: async () => ({
        contributions: [{
          descriptor: { slot: 'dashboard.card', id: 'daily-review' },
          value: { title: 'Daily Review', handlerId: 'refresh' }
        }]
      }),
      commit: (owner) => {
        committedOwner.current = owner
      },
      invokeHandler: async (_owner, handlerId) => {
        assert.equal(handlerId, 'refresh')
        return context.callCapability({
          capability: 'documents.read',
          version: 1,
          input: { documentId: 'doc-1' }
        })
      },
      dispose: () => {
        disposed = true
      }
    }))
    const coordinator = platform.coordinator(factory)

    const receipt = await coordinator.activate({
      pluginId: 'daily-review',
      revisionId: packageValue.revisionId,
      grantSetId: 'grant-1',
      scope,
      runId: 'run-1'
    })

    assert.equal(committedOwner.current?.runId, 'run-1')
    assert.equal(disposed, false)
    assert.equal(platform.kernel.isCurrent(receipt.owner), true)
    assert.deepEqual(
      platform.kernel.listContributions<PluginJsonValue>('dashboard.card', scope).map((item) => item.value),
      [{ title: 'Daily Review', handlerId: 'refresh' }]
    )
    assert.deepEqual(await coordinator.invokeHandler(receipt.owner, 'refresh', {}), {
      documentId: 'doc-1',
      title: 'Read through broker'
    })
    assert.deepEqual(pointerSnapshot(platform.store), {
      current: packageValue.revisionId,
      pending: null,
      active: 'run-1'
    })

    await platform.kernel.destroy()
    assert.equal(disposed, true)
  })
})

test('activation failure leaves the old epoch serving and persists the failed run', async () => {
  await withPlatform(async (platform) => {
    const firstPackage = platform.createRevision('1.0.0', 'export const version = 1')
    platform.createGrant('grant-1', firstPackage.revisionId)
    const firstFactory = runtimeFactory(() => staticRuntime('old-card'))
    const firstCoordinator = platform.coordinator(firstFactory)
    const firstReceipt = await firstCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: firstPackage.revisionId,
      grantSetId: 'grant-1',
      scope,
      runId: 'run-1'
    })

    const brokenPackage = platform.createRevision(
      '1.1.0',
      'throw new Error("broken")',
      firstPackage.revisionId
    )
    platform.createGrant('grant-broken', brokenPackage.revisionId)
    let brokenDisposed = false
    const brokenCoordinator = platform.coordinator(runtimeFactory(() => ({
      activate: async () => {
        throw new Error('runtime readiness failed')
      },
      commit: () => undefined,
      invokeHandler: async () => ({}),
      dispose: () => {
        brokenDisposed = true
      }
    })))

    await assert.rejects(brokenCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: brokenPackage.revisionId,
      grantSetId: 'grant-broken',
      scope,
      runId: 'run-broken'
    }), /runtime readiness failed/)

    assert.equal(brokenDisposed, true)
    assert.equal(platform.kernel.isCurrent(firstReceipt.owner), true)
    assert.deepEqual(
      platform.kernel.listContributions<string>('dashboard.card', scope).map((item) => item.value),
      ['old-card']
    )
    assert.equal(platform.store.pluginPlatform.getRun('run-broken')?.status, 'failed')
    assert.deepEqual(pointerSnapshot(platform.store), {
      current: firstPackage.revisionId,
      pending: brokenPackage.revisionId,
      active: 'run-1'
    })
    await platform.kernel.destroy()
  })
})

test('runtime commit failure rolls kernel namespace back before SQLite pointers advance', async () => {
  await withPlatform(async (platform) => {
    const firstPackage = platform.createRevision('1.0.0', 'export const version = 1')
    platform.createGrant('grant-1', firstPackage.revisionId)
    const firstCoordinator = platform.coordinator(runtimeFactory(() => staticRuntime('old-card')))
    const firstReceipt = await firstCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: firstPackage.revisionId,
      grantSetId: 'grant-1',
      scope,
      runId: 'run-1'
    })

    const secondPackage = platform.createRevision(
      '2.0.0',
      'export const version = 2',
      firstPackage.revisionId
    )
    platform.createGrant('grant-2', secondPackage.revisionId)
    let secondDisposed = false
    const secondCoordinator = platform.coordinator(runtimeFactory(() => ({
      ...staticRuntime('new-card'),
      commit: () => {
        throw new Error('runtime commit handshake failed')
      },
      dispose: () => {
        secondDisposed = true
      }
    })))

    await assert.rejects(secondCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: secondPackage.revisionId,
      grantSetId: 'grant-2',
      scope,
      runId: 'run-2'
    }), /runtime commit handshake failed/)

    assert.equal(secondDisposed, true)
    assert.equal(platform.kernel.isCurrent(firstReceipt.owner), true)
    assert.deepEqual(
      platform.kernel.listContributions<string>('dashboard.card', scope).map((item) => item.value),
      ['old-card']
    )
    assert.deepEqual(pointerSnapshot(platform.store), {
      current: firstPackage.revisionId,
      pending: secondPackage.revisionId,
      active: 'run-1'
    })
    assert.equal(platform.store.pluginPlatform.getRun('run-2')?.status, 'failed')
    await platform.kernel.destroy()
  })
})

test('renderer UI readiness failure aborts staging before the old epoch is replaced', async () => {
  await withPlatform(async (platform) => {
    const firstPackage = platform.createRevision('1.0.0', 'export const version = 1')
    platform.createGrant('grant-ui-old', firstPackage.revisionId)
    const firstReceipt = await platform.coordinator(runtimeFactory(() => staticRuntime('old-ui'))).activate({
      pluginId: 'daily-review',
      revisionId: firstPackage.revisionId,
      grantSetId: 'grant-ui-old',
      scope,
      runId: 'run-ui-old'
    })

    const secondPackage = platform.createRevision('2.0.0', 'export const version = 2', firstPackage.revisionId)
    platform.createGrant('grant-ui-new', secondPackage.revisionId)
    let disposed = false
    const prepareUi: PluginUiPreparationHook = async ({ identity, snapshot }) => {
      assert.equal(identity.runId, 'run-ui-new')
      assert.deepEqual(snapshot.contributions.map((item) => item.value), ['new-ui'])
      throw new Error('iframe ready handshake failed')
    }
    const coordinator = platform.coordinator(runtimeFactory(() => ({
      ...staticRuntime('new-ui'),
      dispose: () => { disposed = true }
    })), prepareUi)

    await assert.rejects(coordinator.activate({
      pluginId: 'daily-review',
      revisionId: secondPackage.revisionId,
      grantSetId: 'grant-ui-new',
      scope,
      runId: 'run-ui-new'
    }), /iframe ready handshake failed/)

    assert.equal(disposed, true)
    assert.equal(platform.kernel.isCurrent(firstReceipt.owner), true)
    assert.deepEqual(
      platform.kernel.listContributions<string>('dashboard.card', scope).map((item) => item.value),
      ['old-ui']
    )
    assert.equal(platform.store.pluginPlatform.getRun('run-ui-new')?.status, 'failed')
  })
})

test('state migration commits with the new epoch and rollback restores the retained snapshot', async () => {
  await withPlatform(async (platform) => {
    const firstPackage = platform.createRevision(
      '1.0.0',
      'export const version = 1',
      undefined,
      1
    )
    platform.createGrant('grant-state-1', firstPackage.revisionId)
    const firstCoordinator = platform.coordinator(runtimeFactory(() => staticRuntime('state-v1')))
    await firstCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: firstPackage.revisionId,
      grantSetId: 'grant-state-1',
      scope,
      runId: 'run-state-1'
    })
    platform.store.pluginPlatform.writePluginState(
      'daily-review',
      scope,
      'settings',
      { label: 'before' },
      1
    )

    const secondPackage = platform.createRevision(
      '2.0.0',
      'export const version = 2',
      firstPackage.revisionId,
      2
    )
    platform.createGrant('grant-state-2', secondPackage.revisionId)
    const secondCoordinator = platform.coordinator(runtimeFactory(() => ({
      ...staticRuntime('state-v2'),
      migrateState: async ({ previousVersion, nextVersion, state }) => {
        assert.equal(previousVersion, 1)
        assert.equal(nextVersion, 2)
        assert.deepEqual(state, { settings: { label: 'before' } })
        return { settings: { label: 'after' }, migrated: true }
      }
    })))
    await secondCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: secondPackage.revisionId,
      grantSetId: 'grant-state-2',
      scope,
      runId: 'run-state-2'
    })

    assert.deepEqual(platform.store.pluginPlatform.readPluginState('daily-review', scope, 'settings'), {
      value: { label: 'after' },
      schemaVersion: 2,
      updatedAt: platform.store.pluginPlatform.readPluginState('daily-review', scope, 'settings')?.updatedAt
    })
    assert.deepEqual(
      platform.store.pluginPlatform.readPluginState('daily-review', scope, 'migrated')?.value,
      true
    )
    const installation = platform.store.pluginPlatform.getInstallationForScope('daily-review', scope)
    assert.ok(installation)
    assert.deepEqual(
      platform.store.pluginPlatform.findStateSnapshotForRevision(installation.id, firstPackage.revisionId)?.values,
      { settings: { label: 'before' } }
    )

    const rollbackCoordinator = platform.coordinator(runtimeFactory(() => staticRuntime('state-v1-restored')))
    await rollbackCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: firstPackage.revisionId,
      grantSetId: 'grant-state-1',
      scope,
      runId: 'run-state-rollback'
    })
    assert.deepEqual(platform.store.pluginPlatform.readPluginStateValues('daily-review', scope), {
      settings: { label: 'before' }
    })
    assert.equal(
      platform.store.pluginPlatform.readPluginState('daily-review', scope, 'settings')?.schemaVersion,
      1
    )
    await platform.kernel.destroy()
  })
})

test('failed state migration leaves the old run and state untouched', async () => {
  await withPlatform(async (platform) => {
    const firstPackage = platform.createRevision('1.0.0', 'export const version = 1', undefined, 1)
    platform.createGrant('grant-migration-good', firstPackage.revisionId)
    const firstCoordinator = platform.coordinator(runtimeFactory(() => staticRuntime('migration-old')))
    const firstReceipt = await firstCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: firstPackage.revisionId,
      grantSetId: 'grant-migration-good',
      scope,
      runId: 'run-migration-good'
    })
    platform.store.pluginPlatform.writePluginState('daily-review', scope, 'value', 'stable', 1)

    const secondPackage = platform.createRevision(
      '2.0.0',
      'export const version = 2',
      firstPackage.revisionId,
      2
    )
    platform.createGrant('grant-migration-bad', secondPackage.revisionId)
    const failingCoordinator = platform.coordinator(runtimeFactory(() => ({
      ...staticRuntime('migration-new'),
      migrateState: async () => {
        throw new Error('migration rejected the stored value')
      }
    })))
    await assert.rejects(failingCoordinator.activate({
      pluginId: 'daily-review',
      revisionId: secondPackage.revisionId,
      grantSetId: 'grant-migration-bad',
      scope,
      runId: 'run-migration-bad'
    }), /migration rejected/)

    assert.equal(platform.kernel.isCurrent(firstReceipt.owner), true)
    assert.deepEqual(platform.store.pluginPlatform.readPluginState('daily-review', scope, 'value')?.value, 'stable')
    assert.equal(platform.store.pluginPlatform.getRun('run-migration-bad')?.status, 'failed')
    await platform.kernel.destroy()
  })
})

test('coordinator rejects runtime factories that do not claim the no-node isolation boundary', async () => {
  await withPlatform(async (platform) => {
    const invalidFactory = {
      isolation: 'node-vm',
      create: async () => staticRuntime('unsafe')
    } as unknown as NoNodePluginRuntimeFactory
    assert.throws(() => platform.coordinator(invalidFactory), /no-node-isolate/)
  })
})

test('activation rejects ViewSpec handlers the staged runtime cannot prove ready', async () => {
  await withPlatform(async (platform) => {
    const packageValue = platform.createRevision('1.0.0', 'export const version = 1')
    platform.createGrant('grant-ui-handler', packageValue.revisionId)
    let disposed = false
    const coordinator = platform.coordinator(runtimeFactory(() => ({
      activate: async () => ({
        contributions: [{
          descriptor: { slot: 'workspace.dashboard', id: 'action-view' },
          value: {
            kind: 'view',
            view: {
              version: 1,
              root: { type: 'button', label: 'Run', action: { handler: 'missing-handler' } }
            }
          }
        }]
      }),
      validateHandlers: async (handlerIds) => {
        assert.deepEqual(handlerIds, ['missing-handler'])
        throw new Error('Plugin handler "missing-handler" is not exported.')
      },
      commit: () => undefined,
      invokeHandler: async () => null,
      dispose: () => { disposed = true }
    })))

    await assert.rejects(coordinator.activate({
      pluginId: 'daily-review',
      revisionId: packageValue.revisionId,
      grantSetId: 'grant-ui-handler',
      scope,
      runId: 'run-ui-handler'
    }), /not exported/)
    assert.equal(disposed, true)
    assert.equal(platform.kernel.listContributions('workspace.dashboard', scope).length, 0)
    assert.equal(platform.store.pluginPlatform.getRun('run-ui-handler')?.status, 'failed')
  })
})

function runtimeFactory(
  createInstance: (context: NoNodePluginRuntimeHostContext) => NoNodePluginRuntimeInstance
): NoNodePluginRuntimeFactory {
  return {
    isolation: 'no-node-isolate',
    create: async (context) => createInstance(context)
  }
}

function staticRuntime(value: string): NoNodePluginRuntimeInstance {
  return {
    activate: async () => ({
      contributions: [{
        descriptor: { slot: 'dashboard.card', id: 'daily-review' },
        value
      }]
    }),
    commit: () => undefined,
    invokeHandler: async () => ({}),
    dispose: () => undefined
  }
}

function pointerSnapshot(store: KnowbookStore): {
  current: string | null
  pending: string | null
  active: string | null
} {
  const definition = store.pluginPlatform.getDefinition('daily-review')
  assert.ok(definition)
  return {
    current: definition.currentRevisionId,
    pending: definition.pendingRevisionId,
    active: definition.activeRunId
  }
}

async function withPlatform(
  run: (platform: ReturnType<typeof createPlatform>) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-plugin-coordinator-test-'))
  const platform = createPlatform(root)
  try {
    await run(platform)
  } finally {
    await platform.kernel.destroy()
    platform.store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
}

function createPlatform(root: string) {
  const store = new KnowbookStore(join(root, 'knowbook.sqlite'))
  const revisions = new PluginRevisionStore(join(root, 'plugins-v2'))
  const kernel = new PluginPlatformKernel()
  const broker = new PluginCapabilityBroker(kernel)
  store.pluginPlatform.createDefinition({
    id: 'daily-review',
    name: 'Daily Review',
    source: 'dynamic',
    persistenceScope: 'workspace'
  })
  broker.register({
    id: 'documents.read',
    version: 1,
    scopes: ['workspace', 'session'],
    parseInput: (input) => input as { documentId: string },
    execute: (_context, input) => ({
      documentId: input.documentId,
      title: 'Read through broker'
    })
  })

  const createRevision = (
    version: string,
    workerSource: string,
    previousRevisionId?: string,
    stateSchemaVersion?: number
  ): PluginRevisionPackage => {
    const packageValue = revisions.publish({
      manifest: {
        schemaVersion: 2,
        id: 'daily-review',
        name: 'Daily Review',
        version,
        apiVersion: '2',
        ...(stateSchemaVersion === undefined ? {} : { stateSchemaVersion }),
        permissions: [{ capability: 'documents.read', version: 1 }],
        standardModules: []
      },
      workerSource
    })
    store.pluginPlatform.createRevision({
      package: packageValue,
      previousRevisionId,
      staticCheckStatus: 'passed'
    })
    return packageValue
  }

  const createGrant = (id: string, revisionId: string): PluginGrantSet => {
    return store.pluginPlatform.createGrantSet({
      id,
      pluginId: 'daily-review',
      revisionId,
      scope,
      grants: [{ capability: 'documents.read', version: 1 }],
      createdAt: '2026-08-25T00:00:00.000Z'
    })
  }

  return {
    store,
    revisions,
    kernel,
    broker,
    createRevision,
    createGrant,
    coordinator: (factory: NoNodePluginRuntimeFactory, prepareUi?: PluginUiPreparationHook) => new PluginActivationCoordinator(
      kernel,
      broker,
      store.pluginPlatform,
      revisions,
      factory,
      prepareUi
    )
  }
}
