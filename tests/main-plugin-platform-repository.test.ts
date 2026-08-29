import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { buildPluginRevisionPackage } from '../src/main/plugin-platform/revision-package.ts'
import type {
  PluginGrantSet,
  PluginPlatformScope,
  PluginRevisionPackage
} from '../src/shared/plugin-platform.ts'

const scope: PluginPlatformScope = {
  kind: 'workspace',
  workspaceId: 'workspace-1'
}

test('plugin repository advances pending/current/active pointers only at lifecycle boundaries', () => {
  withStore((store) => {
    const repository = store.pluginPlatform
    repository.createDefinition({
      id: 'daily-review',
      name: 'Daily Review',
      source: 'dynamic',
      persistenceScope: 'workspace',
      createdSessionId: 'session-authoring'
    })

    const revision1 = revision('daily-review', '1.0.0', 'export const value = 1')
    repository.createRevision({
      package: revision1,
      staticCheckStatus: 'passed',
      generatedBySessionId: 'session-authoring'
    })
    assert.deepEqual(pointerSnapshot(repository.getDefinition('daily-review')), {
      current: null,
      pending: revision1.revisionId,
      active: null
    })

    const grant1 = repository.createGrantSet(grant('grant-1', revision1.revisionId))
    repository.createRun({
      id: 'run-1',
      pluginId: 'daily-review',
      revisionId: revision1.revisionId,
      grantSetId: grant1.id,
      scope
    })
    assert.deepEqual(pointerSnapshot(repository.getDefinition('daily-review')), {
      current: null,
      pending: revision1.revisionId,
      active: null
    })

    const firstCommit = repository.markRunActive('run-1', 1)
    assert.equal(firstCommit.previousRunId, null)
    assert.deepEqual(pointerSnapshot(repository.getDefinition('daily-review')), {
      current: revision1.revisionId,
      pending: null,
      active: 'run-1'
    })

    const revision2 = revision('daily-review', '1.1.0', 'export const value = 2')
    repository.createRevision({
      package: revision2,
      previousRevisionId: revision1.revisionId,
      staticCheckStatus: 'warning',
      staticCheckDiagnostics: [{ code: 'review-needed' }]
    })
    assert.deepEqual(pointerSnapshot(repository.getDefinition('daily-review')), {
      current: revision1.revisionId,
      pending: revision2.revisionId,
      active: 'run-1'
    })

    repository.createGrantSet(grant('grant-2', revision2.revisionId))
    repository.createRun({
      id: 'run-2',
      pluginId: 'daily-review',
      revisionId: revision2.revisionId,
      grantSetId: 'grant-2',
      scope
    })
    const secondCommit = repository.markRunActive('run-2', 2)
    assert.equal(secondCommit.previousRunId, 'run-1')
    assert.equal(repository.getRun('run-1')?.status, 'draining')
    assert.deepEqual(pointerSnapshot(repository.getDefinition('daily-review')), {
      current: revision2.revisionId,
      pending: null,
      active: 'run-2'
    })

    repository.markRunStopped('run-1')
    assert.equal(repository.getDefinition('daily-review')?.activeRunId, 'run-2')
  })
})

test('failed staging revisions preserve the previous active run and remain pending for repair', () => {
  withStore((store) => {
    const repository = store.pluginPlatform
    repository.createDefinition({
      id: 'safe-plugin',
      name: 'Safe Plugin',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const good = revision('safe-plugin', '1.0.0', 'export const safe = true')
    repository.createRevision({ package: good, staticCheckStatus: 'passed' })
    repository.createGrantSet(grant('grant-good', good.revisionId, 'safe-plugin'))
    repository.createRun({
      id: 'run-good',
      pluginId: 'safe-plugin',
      revisionId: good.revisionId,
      grantSetId: 'grant-good',
      scope
    })
    repository.markRunActive('run-good', 1)

    const broken = revision('safe-plugin', '1.1.0', 'throw new Error("broken")')
    repository.createRevision({
      package: broken,
      previousRevisionId: good.revisionId,
      staticCheckStatus: 'passed'
    })
    repository.createGrantSet(grant('grant-broken', broken.revisionId, 'safe-plugin'))
    repository.createRun({
      id: 'run-broken',
      pluginId: 'safe-plugin',
      revisionId: broken.revisionId,
      grantSetId: 'grant-broken',
      scope
    })
    repository.markRunFailed('run-broken', { message: 'Activation failed' })

    assert.deepEqual(pointerSnapshot(repository.getDefinition('safe-plugin')), {
      current: good.revisionId,
      pending: broken.revisionId,
      active: 'run-good'
    })
    assert.deepEqual(repository.getRun('run-broken')?.error, { message: 'Activation failed' })

    const rejected = revision('safe-plugin', '1.2.0', 'export const unsafe = true')
    repository.createRevision({
      package: rejected,
      previousRevisionId: broken.revisionId,
      staticCheckStatus: 'failed',
      staticCheckDiagnostics: [{ severity: 'error', code: 'forbidden-api' }]
    })
    repository.createGrantSet(grant('grant-rejected', rejected.revisionId, 'safe-plugin'))
    assert.throws(() => repository.createRun({
      id: 'run-rejected',
      pluginId: 'safe-plugin',
      revisionId: rejected.revisionId,
      grantSetId: 'grant-rejected',
      scope
    }), /failed static checks/)
    assert.equal(repository.getDefinition('safe-plugin')?.activeRunId, 'run-good')
  })
})

test('plugin repository persists immutable revision history and rejects mismatched grants', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-plugin-repository-reopen-test-'))
  const databasePath = join(root, 'knowbook.sqlite')
  try {
    const firstStore = new KnowbookStore(databasePath)
    const repository = firstStore.pluginPlatform
    repository.createDefinition({
      id: 'persistent-plugin',
      name: 'Persistent Plugin',
      source: 'marketplace',
      persistenceScope: 'workspace'
    })
    const packageValue = revision('persistent-plugin', '1.0.0', 'export const persisted = true')
    repository.createRevision({ package: packageValue, staticCheckStatus: 'passed' })
    assert.throws(() => repository.createGrantSet({
      ...grant('bad-grant', packageValue.revisionId, 'someone-else'),
      pluginId: 'someone-else'
    }), /does not belong/)
    firstStore.destroy()

    const reopened = new KnowbookStore(databasePath)
    try {
      assert.equal(reopened.pluginPlatform.getDefinition('persistent-plugin')?.name, 'Persistent Plugin')
      assert.deepEqual(
        reopened.pluginPlatform.listRevisions('persistent-plugin').map((entry) => entry.id),
        [packageValue.revisionId]
      )
      assert.equal(
        reopened.pluginPlatform.getRevision(packageValue.revisionId)?.manifest.version,
        '1.0.0'
      )
    } finally {
      reopened.destroy()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('session-preview definitions require an owning assistant session', () => {
  withStore((store) => {
    assert.throws(() => store.pluginPlatform.createDefinition({
      id: 'preview',
      name: 'Preview',
      source: 'dynamic',
      persistenceScope: 'session-preview'
    }), /require a creation session/)
  })
})

test('system plugins remain inert until exact strong confirmation and always require restart', () => {
  withStore((store) => {
    const request = store.pluginPlatform.createSystemPluginInstallRequest({
      pluginId: 'native.capture',
      name: 'Native Capture',
      version: '1.0.0',
      publisher: 'Example Publisher',
      artifactSha256: 'a'.repeat(64),
      systemPermissions: ['filesystem.workspace', 'process.helper'],
      reason: 'Requires an audited native helper.',
      requestedBy: 'assistant'
    })
    assert.equal(request.status, 'awaiting-confirmation')
    assert.equal(request.restartRequired, true)
    assert.equal(store.pluginPlatform.getDefinition('native.capture'), null)
    assert.throws(() => store.pluginPlatform.resolveSystemPluginInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      decision: 'confirm',
      acknowledgeSystemAccess: false
    }), /explicit acknowledgement/)
    assert.throws(() => store.pluginPlatform.resolveSystemPluginInstallRequest({
      requestId: request.id,
      pluginId: 'another.plugin',
      decision: 'confirm',
      acknowledgeSystemAccess: true
    }), /exact plugin id/)
    const confirmed = store.pluginPlatform.resolveSystemPluginInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      decision: 'confirm',
      acknowledgeSystemAccess: true
    })
    assert.equal(confirmed.status, 'confirmed-restart-required')
    assert.equal(confirmed.restartRequired, true)
    assert.equal(store.pluginPlatform.getDefinition('native.capture'), null)
    assert.throws(() => store.pluginPlatform.resolveSystemPluginInstallRequest({
      requestId: request.id,
      pluginId: request.pluginId,
      decision: 'cancel',
      acknowledgeSystemAccess: false
    }), /already resolved/)
  })
})

test('installation pointers isolate workspace and session activations for the same plugin', () => {
  withStore((store) => {
    const repository = store.pluginPlatform
    repository.createDefinition({
      id: 'scoped-plugin',
      name: 'Scoped Plugin',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const packageValue = revision('scoped-plugin', '1.0.0', 'export const scoped = true')
    repository.createRevision({ package: packageValue, staticCheckStatus: 'passed' })
    const workspaceInstallation = repository.ensureInstallation({
      id: 'install-workspace',
      pluginId: 'scoped-plugin',
      scope
    })
    const sessionScope: PluginPlatformScope = {
      kind: 'session',
      workspaceId: 'workspace-1',
      sessionId: 'session-1'
    }
    const sessionInstallation = repository.ensureInstallation({
      id: 'install-session',
      pluginId: 'scoped-plugin',
      scope: sessionScope
    })
    repository.createGrantSet({
      ...grant('grant-workspace', packageValue.revisionId, 'scoped-plugin'),
      installationId: workspaceInstallation.id
    })
    repository.createGrantSet({
      ...grant('grant-session', packageValue.revisionId, 'scoped-plugin'),
      installationId: sessionInstallation.id,
      scope: sessionScope
    })
    repository.createRun({
      id: 'run-workspace',
      pluginId: 'scoped-plugin',
      revisionId: packageValue.revisionId,
      installationId: workspaceInstallation.id,
      grantSetId: 'grant-workspace',
      scope
    })
    assert.equal(repository.markRunActive('run-workspace', 1).previousRunId, null)
    repository.createRun({
      id: 'run-session',
      pluginId: 'scoped-plugin',
      revisionId: packageValue.revisionId,
      installationId: sessionInstallation.id,
      grantSetId: 'grant-session',
      scope: sessionScope
    })
    assert.equal(repository.markRunActive('run-session', 1).previousRunId, null)

    assert.equal(repository.getInstallation(workspaceInstallation.id)?.activeRunId, 'run-workspace')
    assert.equal(repository.getInstallation(sessionInstallation.id)?.activeRunId, 'run-session')
    repository.markRunStopped('run-workspace')
    assert.equal(repository.getInstallation(workspaceInstallation.id)?.activeRunId, null)
    assert.equal(repository.getInstallation(sessionInstallation.id)?.activeRunId, 'run-session')
    assert.throws(() => repository.createRun({
      id: 'run-crossed',
      pluginId: 'scoped-plugin',
      revisionId: packageValue.revisionId,
      installationId: sessionInstallation.id,
      grantSetId: 'grant-workspace',
      scope: sessionScope
    }), /grant/)
  })
})

test('session-preview installations cannot be promoted to workspace scope', () => {
  withStore((store) => {
    store.pluginPlatform.createDefinition({
      id: 'preview-installation',
      name: 'Preview Installation',
      source: 'dynamic',
      persistenceScope: 'session-preview',
      createdSessionId: 'session-owner'
    })
    assert.throws(() => store.pluginPlatform.ensureInstallation({
      id: 'preview-workspace-installation',
      pluginId: 'preview-installation',
      scope
    }), /owning session/)
  })
})

test('plugin state is scoped and upserted without exposing raw SQLite keys', () => {
  withStore((store) => {
    const repository = store.pluginPlatform
    repository.createDefinition({
      id: 'stateful-plugin',
      name: 'Stateful Plugin',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })

    assert.equal(repository.readPluginState('stateful-plugin', scope, 'settings/prefix'), null)
    const first = repository.writePluginState(
      'stateful-plugin',
      scope,
      'settings/prefix',
      { value: 'First' },
      1
    )
    const second = repository.writePluginState(
      'stateful-plugin',
      scope,
      'settings/prefix',
      { value: 'Second' },
      2
    )

    assert.deepEqual(first.value, { value: 'First' })
    assert.deepEqual(second.value, { value: 'Second' })
    assert.deepEqual(repository.readPluginState('stateful-plugin', scope, 'settings/prefix'), second)
    assert.equal(repository.readPluginState(
      'stateful-plugin',
      { kind: 'session', workspaceId: 'workspace-1', sessionId: 'session-1' },
      'settings/prefix'
    ), null)
  })
})

test('startup recovery makes interrupted runs terminal and clears active pointers', () => {
  withStore((store) => {
    const repository = store.pluginPlatform
    repository.createDefinition({
      id: 'recoverable-plugin',
      name: 'Recoverable Plugin',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const first = revision('recoverable-plugin', '1.0.0', 'export const first = true')
    repository.createRevision({ package: first, staticCheckStatus: 'passed' })
    repository.createGrantSet(grant('recover-grant-1', first.revisionId, 'recoverable-plugin'))
    repository.createRun({
      id: 'recover-run-active',
      pluginId: 'recoverable-plugin',
      revisionId: first.revisionId,
      grantSetId: 'recover-grant-1',
      scope
    })
    repository.markRunActive('recover-run-active', 1)

    const second = revision('recoverable-plugin', '1.1.0', 'export const second = true')
    repository.createRevision({
      package: second,
      previousRevisionId: first.revisionId,
      staticCheckStatus: 'passed'
    })
    repository.createGrantSet(grant('recover-grant-2', second.revisionId, 'recoverable-plugin'))
    repository.createRun({
      id: 'recover-run-staging',
      pluginId: 'recoverable-plugin',
      revisionId: second.revisionId,
      grantSetId: 'recover-grant-2',
      scope
    })

    assert.deepEqual(repository.recoverInterruptedRuns(), {
      failedRunIds: ['recover-run-staging'],
      stoppedRunIds: ['recover-run-active']
    })
    assert.equal(repository.getRun('recover-run-active')?.status, 'stopped')
    assert.equal(repository.getRun('recover-run-staging')?.status, 'failed')
    assert.deepEqual(repository.getRun('recover-run-staging')?.error, {
      name: 'PluginHostRestarted',
      message: 'Plugin activation was interrupted by a KnowBook restart.'
    })
    assert.equal(repository.getDefinition('recoverable-plugin')?.activeRunId, null)
    assert.deepEqual(repository.recoverInterruptedRuns(), {
      failedRunIds: [],
      stoppedRunIds: []
    })
  })
})

test('repeated installation violations quarantine until explicit recovery', () => {
  withStore((store) => {
    const repository = store.pluginPlatform
    repository.createDefinition({
      id: 'quarantine-plugin',
      name: 'Quarantine Plugin',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const installation = repository.ensureInstallation({
      id: 'quarantine-installation',
      pluginId: 'quarantine-plugin',
      scope
    })
    assert.equal(installation.quarantined, false)
    assert.equal(repository.recordInstallationViolation(installation.id, { code: 'timeout' }).violationCount, 1)
    assert.equal(repository.recordInstallationViolation(installation.id, { code: 'timeout' }).quarantined, false)
    const quarantined = repository.recordInstallationViolation(installation.id, { code: 'timeout' })
    assert.equal(quarantined.quarantined, true)
    assert.equal(quarantined.enabled, false)
    assert.equal(quarantined.activeRunId, null)
    assert.deepEqual(quarantined.quarantineReason, { code: 'timeout' })
    assert.throws(() => repository.setInstallationEnabled(installation.id, true), /explicitly recovered/)

    const recovered = repository.clearInstallationQuarantine(installation.id)
    assert.equal(recovered.quarantined, false)
    assert.equal(recovered.violationCount, 0)
    assert.equal(repository.setInstallationEnabled(installation.id, true).enabled, true)
  })
})

test('deleting a plugin definition cascades its installed lifecycle records', () => {
  withStore((store) => {
    const repository = store.pluginPlatform
    repository.createDefinition({
      id: 'uninstall-plugin',
      name: 'Uninstall Plugin',
      source: 'dynamic',
      persistenceScope: 'workspace'
    })
    const published = revision('uninstall-plugin', '1.0.0', 'export const installed = true')
    repository.createRevision({ package: published, staticCheckStatus: 'passed' })
    const installation = repository.ensureInstallation({
      id: 'uninstall-installation',
      pluginId: 'uninstall-plugin',
      scope
    })
    repository.createGrantSet({
      ...grant('uninstall-grant', published.revisionId, 'uninstall-plugin'),
      installationId: installation.id
    })
    repository.createRun({
      id: 'uninstall-run',
      pluginId: 'uninstall-plugin',
      revisionId: published.revisionId,
      installationId: installation.id,
      grantSetId: 'uninstall-grant',
      scope
    })
    repository.markRunActive('uninstall-run', 1)

    assert.deepEqual(repository.deleteDefinition('uninstall-plugin'), [published.revisionId])
    assert.equal(repository.getDefinition('uninstall-plugin'), null)
    assert.equal(repository.getRevision(published.revisionId), null)
    assert.equal(repository.getInstallation(installation.id), null)
    assert.equal(repository.getGrantSet('uninstall-grant'), null)
    assert.equal(repository.getRun('uninstall-run'), null)
  })
})

function revision(
  pluginId: string,
  version: string,
  workerSource: string
): PluginRevisionPackage {
  return buildPluginRevisionPackage({
    manifest: {
      schemaVersion: 2,
      id: pluginId,
      name: pluginId,
      version,
      apiVersion: '2',
      permissions: [{ capability: 'documents.read', version: 1 }],
      standardModules: []
    },
    workerSource
  }).package
}

function grant(
  id: string,
  revisionId: string,
  pluginId = 'daily-review'
): PluginGrantSet {
  return {
    id,
    pluginId,
    revisionId,
    scope,
    grants: [{ capability: 'documents.read', version: 1 }],
    createdAt: '2026-08-25T00:00:00.000Z'
  }
}

function pointerSnapshot(definition: ReturnType<KnowbookStore['pluginPlatform']['getDefinition']>): {
  current: string | null
  pending: string | null
  active: string | null
} {
  assert.ok(definition)
  return {
    current: definition.currentRevisionId,
    pending: definition.pendingRevisionId,
    active: definition.activeRunId
  }
}

function withStore(run: (store: KnowbookStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-plugin-repository-test-'))
  const store = new KnowbookStore(join(root, 'knowbook.sqlite'))
  try {
    run(store)
  } finally {
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
}
