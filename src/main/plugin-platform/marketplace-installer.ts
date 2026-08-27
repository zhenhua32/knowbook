import { randomUUID } from 'node:crypto'
import type { MarketplacePluginInstallResult } from '@shared/plugin-trust'
import type { PluginPlatformScope } from '@shared/plugin-platform'
import type { PluginRevisionValidator } from '../assistant/plugin-authoring-service'
import type { SqlitePluginPlatformRepository } from './repository'
import type { PluginRevisionStore } from './revision-store'
import { clonePluginRuntimeJson } from './runtime-json'
import {
  verifyMarketplacePluginPackage,
  type MarketplacePluginPackage,
  type TrustedMarketplacePublisher
} from './marketplace-package'

export interface MarketplacePluginInstallerDependencies {
  repository: SqlitePluginPlatformRepository
  revisions: PluginRevisionStore
  validator: PluginRevisionValidator
  workspaceScope: Extract<PluginPlatformScope, { kind: 'workspace' }>
  trustedPublishers: readonly TrustedMarketplacePublisher[]
}

/**
 * Verifies and records a marketplace package without executing or enabling it.
 * Activation remains a separate, explicitly approved lifecycle operation.
 */
export async function installMarketplacePluginPackage(
  dependencies: MarketplacePluginInstallerDependencies,
  input: MarketplacePluginPackage
): Promise<MarketplacePluginInstallResult> {
  const verified = verifyMarketplacePluginPackage(input, dependencies.trustedPublishers)
  const revisionPackage = dependencies.revisions.publish(verified.revision)
  if (revisionPackage.revisionId !== verified.revision.revisionId) {
    throw new Error('Verified marketplace revision changed before publication.')
  }

  const existing = dependencies.repository.getDefinition(revisionPackage.manifest.id)
  if (existing && existing.source !== 'marketplace') {
    throw new Error(`Marketplace plugin id "${existing.id}" conflicts with ${existing.source} plugin metadata.`)
  }

  const runtimeValidation = await dependencies.validator.validate(revisionPackage)
  if (runtimeValidation.status === 'failed') {
    throw new Error(`Marketplace plugin failed runtime validation: ${JSON.stringify(runtimeValidation.diagnostics)}`)
  }

  const definition = existing ?? dependencies.repository.createDefinition({
    id: revisionPackage.manifest.id,
    name: revisionPackage.manifest.name,
    source: 'marketplace',
    persistenceScope: 'workspace'
  })
  const diagnostics = clonePluginRuntimeJson([
    ...verified.diagnostics,
    ...(Array.isArray(runtimeValidation.diagnostics)
      ? runtimeValidation.diagnostics
      : [runtimeValidation.diagnostics])
  ], 'Marketplace install diagnostics')
  const revision = dependencies.repository.createRevision({
    package: revisionPackage,
    previousRevisionId: definition.pendingRevisionId ?? definition.currentRevisionId,
    staticCheckStatus: verified.diagnostics.some((entry) => entry.severity === 'warning')
      || runtimeValidation.status === 'warning'
      ? 'warning'
      : 'passed',
    staticCheckDiagnostics: diagnostics
  })
  const installation = dependencies.repository.ensureInstallation({
    id: randomUUID(),
    pluginId: revision.pluginId,
    scope: dependencies.workspaceScope,
    enabled: false
  })

  return clonePluginRuntimeJson({
    pluginId: revision.pluginId,
    revisionId: revision.id,
    publisher: verified.publisher,
    signatureVerified: true,
    sbomFormat: `${verified.sbom.bomFormat}-${verified.sbom.specVersion}`,
    dependencyCount: verified.dependencyLock.dependencies.length,
    diagnostics,
    installationId: installation.id,
    enabled: installation.enabled,
    activationRequiresApproval: true
  }, 'Marketplace install result') as unknown as MarketplacePluginInstallResult
}
