import assert from 'node:assert/strict'
import { join } from 'node:path'
import { buildPluginRevisionPackage } from '../../src/main/plugin-platform/revision-package'
import type { PluginPlatformScope } from '../../src/shared/plugin-platform'
import type { V3Fixture } from './synced-backup-v3-fixture'

export const pluginPolicyTables = ['plugin_definitions', 'plugin_revisions', 'plugin_installations', 'plugin_grants', 'plugin_runs',
  'plugin_state', 'plugin_state_snapshots', 'plugin_logs', 'system_plugin_install_requests', 'system_plugin_packages',
  'system_plugin_installations', 'system_plugin_runs', 'system_plugin_audit', 'system_plugin_dependency_jobs',
  'system_plugin_crash_markers', 'system_plugin_os_persistence'] as const

/** Actual repository metadata writers, never a plugin host, shell, OS service
 * registration or artifact confirmation. These are persisted pending/history
 * data; source inspection must not turn them into executable authority. */
export function seedPluginPolicy(f: V3Fixture) {
  const repository = f.store.pluginPlatform, pluginId = 'source-policy-v2'
  const scope: PluginPlatformScope = { kind: 'workspace', workspaceId: 'source:policy/工作区' }
  repository.createDefinition({ id: pluginId, name: 'Actual source plugin', source: 'dynamic', persistenceScope: 'workspace' })
  const installation = repository.ensureInstallation({ id: 'source-v2-installation', pluginId, scope })
  const revision = (version: string) => buildPluginRevisionPackage({ manifest: { schemaVersion: 2, id: pluginId, name: 'Actual source plugin', version,
    apiVersion: '2', permissions: [], standardModules: [] }, workerSource: `export const version = ${JSON.stringify(version)}` }).package
  const first = revision('1.0.0'), second = revision('1.1.0')
  repository.createRevision({ package: first, staticCheckStatus: 'passed' })
  const grant = (id: string, revisionId: string) => repository.createGrantSet({ id, pluginId, revisionId, installationId: installation.id, scope,
    grants: [], createdAt: '2026-01-01T00:00:00Z' })
  const firstGrant = grant('source-v2-first-grant', first.revisionId)
  repository.createRun({ id: 'source-v2-first-run', pluginId, revisionId: first.revisionId, installationId: installation.id, grantSetId: firstGrant.id, scope })
  repository.markRunActive('source-v2-first-run', 1)
  repository.writePluginState(pluginId, scope, 'state', { literal: 'file:///opaque/state', old: true }, 1)
  repository.createRevision({ package: second, previousRevisionId: first.revisionId, staticCheckStatus: 'warning', staticCheckDiagnostics: [{ literal: 'file:///opaque/diagnostic' }] })
  const secondGrant = grant('source-v2-second-grant', second.revisionId)
  repository.createRun({ id: 'source-v2-second-run', pluginId, revisionId: second.revisionId, installationId: installation.id, grantSetId: secondGrant.id, scope })
  repository.markRunActive('source-v2-second-run', 2, 'source-v2-first-run', {
    fromRevisionId: first.revisionId, fromSchemaVersion: 1, toSchemaVersion: 2, values: { state: { current: true } }
  })
  assert.equal(repository.revokeGrantSet(firstGrant.id), true)
  repository.appendPluginLog({ id: 'source-v2-log', pluginId, revisionId: first.revisionId, runId: 'source-v2-first-run', level: 'info', event: 'source.retained',
    message: 'Actual retained log', data: { literal: '![opaque](file:///opaque/log)' } })

  const systemId = 'source-policy-v3', artifactPath = join(f.root, 'metadata-only-not-executed')
  const request = repository.createSystemPluginInstallRequest({ pluginId: systemId, name: 'Actual pending source request', version: '1.0.0', publisher: 'Source fixture',
    artifactSha256: 'a'.repeat(64), systemPermissions: ['full-trust'], reason: 'Retained source metadata only', requestedBy: 'user' })
  repository.updateSystemPluginInstallRequestState(request.id, { stagedArtifactPath: artifactPath, computedArtifactSha256: 'a'.repeat(64), manifestSnapshot: { schemaVersion: 3, id: systemId } })
  const pkg = repository.createSystemPluginPackage({ id: 'source-v3-package', pluginId: systemId, version: '1.0.0', publisher: 'Source fixture', contentHash: 'a'.repeat(64),
    artifactPath, manifestSnapshot: { schemaVersion: 3, id: systemId }, fileManifest: [{ path: 'plugin.json', sha256: 'b'.repeat(64) }], sourceRequestId: request.id })
  repository.updateSystemPluginPackage(pkg.id, { status: 'ready', runtimeFingerprint: { platform: process.platform, arch: process.arch } })
  const systemInstallation = repository.createSystemPluginInstallation({ id: 'source-v3-installation', pluginId: systemId, enabled: true, autoStart: true,
    status: 'pending-restart', pendingPackageId: pkg.id, backupPath: join(f.root, 'metadata-only-backup.db') })
  repository.updateSystemPluginInstallRequestState(request.id, { installationId: systemInstallation.id })
  const run = repository.createSystemPluginRun({ id: 'source-v3-run', installationId: systemInstallation.id, packageId: pkg.id, component: 'main' })
  const marker = repository.createSystemPluginCrashMarker({ id: 'source-v3-marker', installationId: systemInstallation.id, packageId: pkg.id, runId: run.id, phase: 'activation.main' })
  const dependency = repository.createSystemPluginDependencyJob({ id: 'source-v3-dependency', packageId: pkg.id, installationId: systemInstallation.id, requestId: request.id,
    kind: 'install', packageManager: 'npm', command: ['npm', 'ci'], logPath: join(f.root, 'metadata-only.log') })
  repository.appendSystemPluginAudit({ id: 'source-v3-audit', pluginId: systemId, installationId: systemInstallation.id, packageId: pkg.id, requestId: request.id, runId: run.id,
    actor: 'user', action: 'source.metadata', outcome: 'success', details: { literal: 'file:///opaque/audit' } })
  const persistence = repository.upsertSystemPluginOsPersistence({ id: 'source-v3-persistence', installationId: systemInstallation.id, packageId: pkg.id,
    revisionHash: 'sha256:' + 'a'.repeat(64), serviceId: 'knowbook.source-policy-v3', method: 'electron-login-item',
    command: { executable: join(f.root, 'not-executed.exe'), args: ['--source-metadata-only'] }, descriptor: { schemaVersion: 1, literal: 'file:///opaque/descriptor' } })
  for (const table of pluginPolicyTables) assert.ok((f.db.prepare('SELECT count(*) AS n FROM ' + table).get() as { n: number }).n > 0, 'A real repository writer populated ' + table)
  return { repository, pluginId, scope, first, second, installation, firstGrant, secondGrant, request, pkg, systemInstallation, run, marker, dependency, persistence }
}
