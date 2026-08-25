export type PluginPlatformScope =
  | {
      kind: 'app'
    }
  | {
      kind: 'workspace'
      workspaceId: string
    }
  | {
      kind: 'session'
      workspaceId: string
      sessionId: string
    }

export interface PluginActivationIdentity {
  pluginId: string
  revisionId: string
  runId: string
  grantSetId: string
  scope: PluginPlatformScope
}

export interface PluginActiveOwner extends PluginActivationIdentity {
  epoch: number
}

export interface PluginServiceDescriptor {
  id: string
  version: string
  priority?: number
}

export interface PluginContributionDescriptor {
  slot: string
  id: string
  order?: number
}

export type PluginActivationState =
  | 'staging'
  | 'active'
  | 'draining'
  | 'disposed'

export interface PluginDrainResult {
  owner: PluginActiveOwner
  timedOut: boolean
  errors: string[]
}

export interface PluginCommitReceipt {
  owner: PluginActiveOwner
  previousOwner: PluginActiveOwner | null
  previousDrain: Promise<PluginDrainResult | null>
}

export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue }

export interface PluginCapabilityRequest {
  capability: string
  version: number
  reason?: string
}

export interface PluginStandardModuleRequest {
  id: string
  version: string
}

/**
 * Manifest for untrusted Plugin Platform v2 packages. Dynamic packages have a
 * deliberately small, closed shape: npm specifications and arbitrary entry
 * paths are not part of this contract.
 */
export interface PluginV2Manifest {
  schemaVersion: 2
  id: string
  name: string
  version: string
  apiVersion: '2'
  worker: 'worker.js'
  description?: string
  author?: string
  stateSchemaVersion?: number
  permissions: PluginCapabilityRequest[]
  standardModules: PluginStandardModuleRequest[]
}

export interface PluginRevisionPackageInput {
  manifest: unknown
  workerSource: string
  views?: unknown
  assets?: Readonly<Record<string, Uint8Array>>
}

export interface PluginRevisionPackage {
  revisionId: string
  contentHash: string
  manifest: PluginV2Manifest
  workerSource: string
  views: PluginJsonValue | null
  assets: Readonly<Record<string, Uint8Array>>
  sizeBytes: number
}

export interface PluginCapabilityGrant {
  capability: string
  version: number
  constraints?: PluginJsonValue
}

export interface PluginGrantSet {
  id: string
  pluginId: string
  revisionId: string
  scope: PluginPlatformScope
  grants: readonly PluginCapabilityGrant[]
  createdAt: string
  expiresAt?: string
}

export interface PluginCapabilityCall {
  callId?: string
  capability: string
  version: number
  input: PluginJsonValue
}
