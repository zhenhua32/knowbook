import type {
  PluginActivationIdentity,
  PluginActiveOwner,
  PluginCapabilityCall,
  PluginJsonValue,
  PluginRevisionPackage,
  PluginV2Manifest
} from '@shared/plugin-platform'
import type { PluginRuntimeActivationSnapshot } from './activation-coordinator'

export interface QuickJsRuntimePackagePayload {
  revisionId: string
  contentHash: string
  manifest: PluginV2Manifest
  workerSource: string
  views: PluginJsonValue | null
  sizeBytes: number
}

export type QuickJsRuntimeCommand =
  | {
      type: 'initialize'
      package: QuickJsRuntimePackagePayload
    }
  | {
      type: 'activate'
    }
  | {
      type: 'invoke-handler'
      handlerId: string
      input: PluginJsonValue
    }
  | {
      type: 'dispose'
    }

export interface QuickJsRuntimeRequest {
  kind: 'request'
  requestId: number
  identity: PluginActivationIdentity | PluginActiveOwner
  command: QuickJsRuntimeCommand
}

export interface QuickJsRuntimeCommit {
  kind: 'commit'
  identity: PluginActiveOwner
}

export interface QuickJsRuntimeCancel {
  kind: 'cancel'
  requestId: number
  identity: PluginActivationIdentity | PluginActiveOwner
}

export interface QuickJsRuntimeResponse {
  kind: 'response'
  requestId: number
  identity: PluginActivationIdentity | PluginActiveOwner
  ok: boolean
  output?: PluginJsonValue
  error?: string
}

export interface QuickJsRuntimeCapabilityRequest {
  kind: 'capability-call'
  capabilityRequestId: number
  identity: PluginActiveOwner
  call: PluginCapabilityCall
}

export interface QuickJsRuntimeCapabilityResult {
  kind: 'capability-result'
  capabilityRequestId: number
  identity: PluginActiveOwner
  ok: boolean
  output?: PluginJsonValue
  error?: string
}

export type QuickJsRuntimeHostMessage =
  | QuickJsRuntimeRequest
  | QuickJsRuntimeCommit
  | QuickJsRuntimeCancel
  | QuickJsRuntimeCapabilityResult

export type QuickJsRuntimeProcessMessage =
  | QuickJsRuntimeResponse
  | QuickJsRuntimeCapabilityRequest

export function toQuickJsRuntimePackagePayload(
  package_: PluginRevisionPackage
): QuickJsRuntimePackagePayload {
  return {
    revisionId: package_.revisionId,
    contentHash: package_.contentHash,
    manifest: structuredClone(package_.manifest),
    workerSource: package_.workerSource,
    views: structuredClone(package_.views),
    sizeBytes: package_.sizeBytes
  }
}

export function fromQuickJsRuntimePackagePayload(
  payload: QuickJsRuntimePackagePayload
): PluginRevisionPackage {
  return {
    revisionId: payload.revisionId,
    contentHash: payload.contentHash,
    manifest: payload.manifest,
    workerSource: payload.workerSource,
    views: payload.views,
    assets: Object.freeze({}),
    sizeBytes: payload.sizeBytes
  }
}

export function activationSnapshotToJson(
  snapshot: PluginRuntimeActivationSnapshot
): PluginJsonValue {
  return snapshot as unknown as PluginJsonValue
}
