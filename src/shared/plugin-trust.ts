import type { PluginJsonValue, PluginRevisionPackageInput } from './plugin-platform'

export interface MarketplacePublisherIdentity {
  publisherId: string
  keyId: string
}

export interface MarketplaceDependencyLock {
  lockFormat: 'knowbook-dependency-lock-v1'
  packageManager: 'bundled'
  dependencies: Array<{ name: string; version: string; integrity: string }>
}

export interface MarketplaceCycloneDxSbom {
  bomFormat: 'CycloneDX'
  specVersion: '1.5'
  version: 1
  metadata: {
    component: { type: 'application'; name: string; version: string }
  }
  components: Array<{
    type: 'library'
    name: string
    version: string
    hashes: Array<{ alg: 'SHA-256' | 'SHA-512'; content: string }>
  }>
}

export interface MarketplaceArtifactDigest {
  path: string
  size: number
  sha256: string
}

export interface UnsignedMarketplacePluginPackage {
  format: 'knowbook-marketplace-v1'
  publisher: MarketplacePublisherIdentity
  revision: PluginRevisionPackageInput
  dependencyLock: MarketplaceDependencyLock
  sbom: MarketplaceCycloneDxSbom
  artifacts: MarketplaceArtifactDigest[]
}

export interface MarketplacePluginPackage extends UnsignedMarketplacePluginPackage {
  signature: { algorithm: 'Ed25519'; value: string }
}

export interface TrustedMarketplacePublisher {
  publisherId: string
  keyId: string
  publicKeyPem: string
  revoked?: boolean
}

export interface MarketplacePluginInstallResult {
  pluginId: string
  revisionId: string
  publisher: MarketplacePublisherIdentity
  signatureVerified: true
  sbomFormat: string
  dependencyCount: number
  diagnostics: PluginJsonValue
  installationId: string
  enabled: boolean
  activationRequiresApproval: true
}

export interface SystemPluginInstallRequestInput {
  pluginId: string
  name: string
  version: string
  publisher: string
  artifactSha256: string
  systemPermissions: string[]
  reason: string
  requestedBy: 'user' | 'assistant'
}

export interface SystemPluginInstallRequest {
  id: string
  pluginId: string
  name: string
  version: string
  publisher: string
  artifactSha256: string
  systemPermissions: string[]
  reason: string
  requestedBy: 'user' | 'assistant'
  status: 'awaiting-confirmation' | 'confirmed-restart-required' | 'cancelled'
  restartRequired: true
  createdAt: string
  resolvedAt: string | null
}

export interface ResolveSystemPluginInstallRequestInput {
  requestId: string
  pluginId: string
  acknowledgeSystemAccess: boolean
  decision: 'confirm' | 'cancel'
}
