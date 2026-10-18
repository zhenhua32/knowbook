import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import type { SyncedLinkTarget } from '../../shared/synced-blocks'
import type { ExchangeComponent, ExchangeDeferredReason, SyncedExchangeAccepted } from './synced-exchange-model'
import type { SyncedProtocol5Snapshot } from './synced-protocol5-model'

/** Interface freeze only. These data types confer no persistence or source authority. */
export interface SyncedExchangeBothPreviewInput { previewId: string; userDataRoot: string; target: WebDavSyncConfig }
export interface SyncedExchangeBothHostSelector {
  sourceDocumentId: string; sourceInstanceId: string; destination: 'existing' | 'copied'
}
export interface SyncedExchangeBothDecision {
  componentId: string; copyDocumentIds: string[]
  groups: Array<{ groupId: string; hosts: SyncedExchangeBothHostSelector[] }>
}
export interface SyncedExchangeBothResolveInput {
  operationId: string; userDataRoot: string; target: WebDavSyncConfig
  previewId: string; decisions: SyncedExchangeBothDecision[]
}
export type SyncedExchangeBothBlockedReason = ExchangeDeferredReason | 'semantic-binding' | 'budget'
export interface SyncedExchangeBothRecordSource { key: string; baseHash: string | null; localHash: string | null; remoteHash: string | null }
export interface SyncedExchangeBothCopyDestination {
  sourceDocumentId: string; sourceHash: string; sourceTitle: string; documentId: string; title: string; parentId: string | null; path: string
  required: boolean; requiredCopyDocumentIds: string[]; requiredGroupIds: string[]
}
export interface SyncedExchangeBothHostDestination extends SyncedExchangeBothHostSelector {
  documentId: string; instanceId: string; required: boolean
}
export interface SyncedExchangeBothGroupDestination {
  sourceGroupId: string; sourceHash: string; groupId: string; creationId: string; createdAt: string
  required: boolean; hosts: SyncedExchangeBothHostDestination[]
}
export interface SyncedExchangeBothPreviewComponent extends ExchangeComponent {
  componentId: string; reason: SyncedExchangeBothBlockedReason | null; choices: Array<'both'>
  records: SyncedExchangeBothRecordSource[]
  copyDocuments: SyncedExchangeBothCopyDestination[]; groups: SyncedExchangeBothGroupDestination[]
  entities: Array<{ sourceEntityId: string; entityId: string; sourceDocumentId: string; databaseId: string; title: string }>
}
export interface SyncedExchangeBothPreview {
  kind: 'synced-exchange-both-preview'; version: 1; previewId: string; previewHash: string
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string; targetFingerprint: string
  stateGeneration: string; remoteManifestHash: string; createdAt: string; components: SyncedExchangeBothPreviewComponent[]
}
export type SyncedExchangeBothPreviewResult = { status: 'ready'; preview: SyncedExchangeBothPreview }
  | { status: 'missing' } | { status: 'unsupported'; reason: 'schema-27-required' | 'protocol5-required' }
  | { status: 'stale'; side: 'local' | 'remote' }

export interface SyncedExchangeBothForkSummary {
  componentId: string; allocationHash: string
  documents: Array<{ sourceDocumentId: string; documentId: string; title: string; parentId: string | null; path: string }>
  groups: Array<{ sourceGroupId: string; groupId: string; creationId: string }>
  instances: Array<{ sourceDocumentId: string; sourceInstanceId: string; destination: 'existing' | 'copied'; documentId: string; instanceId: string; groupId: string }>
  entities: Array<{ sourceEntityId: string; entityId: string; documentId: string | null }>
}
export interface SyncedExchangeBothAccepted extends SyncedExchangeAccepted { forks: SyncedExchangeBothForkSummary[] }
export interface SyncedExchangeBothPublishedBlock {
  status: 'blocked'; stage: 'published-local'
  reason: 'identity-collision' | 'path-collision' | 'catalog-collision' | 'source-stale'
  operationId: string; attemptId: string; allocationHash: string
  publishedManifestHash: string; publishedManifestETag: string; componentIds: string[]
  collisions: Array<{ kind: 'document' | 'group' | 'block' | 'instance' | 'entity' | 'path'; id: string }>
}
export type SyncedExchangeBothResult = SyncedExchangeBothAccepted | SyncedExchangeBothPublishedBlock
  | { status: 'missing' } | { status: 'unsupported'; reason: 'schema-27-required' | 'protocol5-required' }
  | { status: 'stale'; side: 'local' | 'remote' }

/** Summary uses blockId=null. Block links require their real opaque physical block ID. */
export interface SyncedBothSourceKey {
  field: 'block' | 'summary'; blockId: string | null; from: number; to: number; raw: string; syntax: 'markdown' | 'wiki'
}
export interface SyncedBothSourceLink { key: SyncedBothSourceKey; url: string; target: SyncedLinkTarget }
/** Images are never navigation bindings. The actual image parser produced this exact range. */
export interface SyncedBothSourceImage { key: SyncedBothSourceKey; url: string }
export interface SyncedBothOwnerSourceLinks {
  ownerKey: string; recordHash: string; path: string | null; complete: boolean
  links: SyncedBothSourceLink[]; images: SyncedBothSourceImage[]
}
export interface SyncedBothSourceComponent extends ExchangeComponent { componentId: string }
export interface SyncedBothCopySource {
  sourceDocumentId: string; sourceHash: string; required: boolean
  requiredCopyDocumentIds: string[]; requiredGroupIds: string[]
}
export interface SyncedBothGroupSource {
  sourceGroupId: string; sourceHash: string; required: boolean
  hosts: Array<SyncedExchangeBothHostSelector & { required: boolean }>
}
export interface SyncedBothDescribeInput {
  local: SyncedProtocol5Snapshot; remote: SyncedProtocol5Snapshot; component: SyncedBothSourceComponent
  selectedOriginal: SyncedProtocol5Snapshot; conflictedKeys: string[]
  sourceLinks: SyncedBothOwnerSourceLinks[]
}
export type SyncedBothDescription = {
  status: 'eligible'; copyDocuments: SyncedBothCopySource[]; groups: SyncedBothGroupSource[]
} | { status: 'blocked'; reason: SyncedExchangeBothBlockedReason; keys: string[] }

/** All candidate maps are private preview bytes, fixed before resolve accepts them. No reservations. */
export interface SyncedBothAllocation {
  kind: 'synced-exchange-both-allocation'; version: 1; previewId: string; allocatedAt: string
  documents: Array<{ sourceDocumentId: string; documentId: string; createdAt: string; title: string; parentId: string | null; path: string }>
  groups: Array<{ sourceGroupId: string; groupId: string; creationId: string; createdAt: string; firstInstanceId: string }>
  blocks: Array<{ sourceOwnerKey: string; sourceBlockId: string; ownerKey: string; blockId: string; createdAt: string }>
  instances: Array<{ sourceDocumentId: string; sourceInstanceId: string; destination: 'existing' | 'copied'; documentId: string; instanceId: string; groupId: string; createdAt: string }>
  entities: Array<{ sourceEntityId: string; entityId: string; createdAt: string }>
  missing: Array<{ sourceId: string; id: string }>
}
export interface SyncedBothLinkProjection {
  sourceOwnerKey: string; source: SyncedBothSourceKey
  destinationOwnerKey: string; destination: SyncedBothSourceKey; target: SyncedLinkTarget
}
export interface SyncedBothForkInput extends SyncedBothDescribeInput {
  retainedLocal: SyncedProtocol5Snapshot; retainedRemote: SyncedProtocol5Snapshot
  decision: SyncedExchangeBothDecision; allocation: SyncedBothAllocation
}
export interface SyncedBothForkProof {
  componentId: string; allocationHash: string
  sources: Array<{ key: string; hash: string }>; results: Array<{ key: string; hash: string }>
  projectionsHash: string; summary: SyncedExchangeBothForkSummary
}
export type SyncedBothForkResult = {
  status: 'planned'; localFinal: SyncedProtocol5Snapshot; nextRemote: SyncedProtocol5Snapshot
  fork: SyncedBothForkProof; projections: SyncedBothLinkProjection[]
  requiredSourceKeys: Array<{ ownerKey: string; key: SyncedBothSourceKey }>
} | { status: 'blocked'; reason: SyncedExchangeBothBlockedReason; keys: string[] }

// Pure helper module src/main/sync/synced-exchange-fork.ts exports exactly:
// describeSyncedBothComponent(input: SyncedBothDescribeInput): SyncedBothDescription
// planSyncedBothFork(input: SyncedBothForkInput): SyncedBothForkResult
// Main alone authenticates sourceLinks/allocation and owns all SQL/HTTP effects.
