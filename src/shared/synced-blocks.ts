import type { DocumentBlockDraft, DocumentDetail } from './contracts'

export interface SyncedBlockPayloadV1 { version: 1; groupId: string }

/** Historical child identities are opaque strings. Only new groups and instances require UUIDs. */
export type SyncedStableBlockDraft = Omit<DocumentBlockDraft, 'id' | 'parentBlockId'> & {
  id: string
  parentBlockId: string | null
}
export type SyncedCanonicalEdit = SyncedStableBlockDraft
export type SyncedCanonicalWire = SyncedCanonicalEdit & { createdAt: string }

export interface SyncedOriginV1 {
  version: 1
  documentId: string
  pathAtCreation: string
  firstInstanceId: string
}

export type SyncedLinkTarget =
  | { kind: 'document'; id: string; state: 'live' | 'missing' }
  | { kind: 'block'; id: string; documentId: string | null; state: 'live' | 'missing' }
  | { kind: 'heading'; documentId: string; slug: string; state: 'live' | 'missing' }
  | { kind: 'unresolved-url'; path: string; fragment: string | null }

export interface SyncedBindingKey {
  blockId: string
  from: number
  to: number
  raw: string
  syntax: 'markdown' | 'wiki'
}
/** Editing intent only; Main proves the exact parsed source and destination. */
export type SyncedBindingClaim =
  | { kind: 'continue'; source: SyncedBindingKey; destination: SyncedBindingKey }
  | { kind: 'copy'; source: { kind: 'current'; key: SyncedBindingKey }
      | { kind: 'ticket'; ticketId: string; entryId: string }; destination: SyncedBindingKey }
  | { kind: 'new'; destination: SyncedBindingKey }
export interface SyncedLinkBinding extends SyncedBindingKey {
  target: SyncedLinkTarget
}
/** Main-process lifetime only. Tickets never enter portable semantics or executable history. */
export interface SyncedBindingSource {
  ticketId: string
  entries: Array<{ entryId: string; key: SyncedBindingKey }>
}

export interface SyncedInstanceGuard {
  instanceId: string
  hostDocumentId: string
  bindingVersion: string
}
export interface SyncedInstancePosition extends SyncedInstanceGuard {
  depth: number
  parentBlockId: string | null
  /** Derived from the real host, never supplied as mutation authority or sent on the wire. */
  parentType: string | null
}
export interface SyncedGroupGuard {
  groupId: string
  expectedRevision: string
  expectedTopologyRevision: string
}
export interface SyncedHistoryState {
  cursor: string
  undoToken: string | null
  redoToken: string | null
}
export interface SyncedGroupSnapshot {
  groupId: string
  creationId: string
  createdAt: string
  revision: string
  topologyRevision: string
  origin: SyncedOriginV1
  bindings: SyncedLinkBinding[]
  blocks: SyncedCanonicalWire[]
  instances: SyncedInstancePosition[]
  history: SyncedHistoryState
  maxRelativeDepth: number
}

/** Portable semantics deliberately exclude local CAS, operation IDs and executable history. */
export interface SyncedGroupWire {
  kind: 'synced-group'
  id: string
  creationId: string
  createdAt: string
  origin: SyncedOriginV1
  bindings: SyncedLinkBinding[]
  blocks: SyncedCanonicalWire[]
}
export interface SyncedGroupDeletedWire {
  kind: 'synced-group-deleted'
  id: string
  creationId: string
  previousHash: string
  deletedAt: string
}

export type SyncedValidationCode = 'forest' | 'nested-sync' | 'identity' | 'binding' | 'depth' | 'budget'
export type SyncedFailure =
  | { status: 'conflict'; kind: 'group' | 'topology' | 'host' | 'history'; groups: SyncedGroupSnapshot[]; hosts: DocumentDetail[] }
  | { status: 'missing'; kind: 'group' | 'instance' | 'document'; id: string }
  | { status: 'invalid'; code: SyncedValidationCode; blockingInstances: SyncedInstanceGuard[] }
  | { status: 'idempotency-mismatch' }

export interface SyncedGroupSaved {
  status: 'saved' | 'noop'
  operationId: string
  snapshot: SyncedGroupSnapshot
  replayed: boolean
}
export type SyncedGroupMutationResult = SyncedGroupSaved | SyncedFailure

export interface SyncedHostWorkingBefore {
  documentId: string
  expectedPersistedUpdatedAt: string
  workingBefore: { title: string; summary: string; blocks: SyncedStableBlockDraft[] }
}
export interface SyncedPlacement {
  documentId: string
  beforeBlockId: string | null
  parentBlockId: string | null
  depth: number
}
export interface SyncedRootSelection { documentId: string; selectedRootIds: string[] }
export interface SyncedReferenceIdentity { workspaceScope: string; groupId: string; creationId: string }
export type SyncedNewRefSource = { instanceId: string } & (
  | { kind: 'working'; sourceDocumentId: string; sourceInstanceId: string }
  | { kind: 'internal'; identity: SyncedReferenceIdentity }
)
export type SyncedStructureAction =
  | { kind: 'create'; documentId: string; selectedRootIds: string[]; groupId: string; instanceId: string }
  | { kind: 'insert'; groupId: string; instanceId: string; target: SyncedPlacement }
  | { kind: 'move' | 'duplicate'; selection: SyncedRootSelection; target: SyncedPlacement }
  | { kind: 'move-batch'; moves: Array<{ selection: SyncedRootSelection; target: SyncedPlacement }> }
  | { kind: 'delete'; selection: SyncedRootSelection }
  | { kind: 'paste'; fragment: SyncedStableBlockDraft[];
      refSources: Array<{ fragmentBlockId: string; identity: SyncedReferenceIdentity }>;
      replace: SyncedRootSelection | null; target: SyncedPlacement }
  | { kind: 'detach'; instanceId: string; groupId: string }

export interface SyncedStructureApplied {
  status: 'applied' | 'noop'
  operationId: string
  historyToken: string | null
  replayed: boolean
  hosts: Array<{
    documentId: string
    logicalBefore: SyncedHostWorkingBefore['workingBefore']
    logicalBeforeHash: string
    after: DocumentDetail
  }>
  groups: SyncedGroupSnapshot[]
  affectedInstanceIds: string[]
  blockIdMap: Array<{ from: string; to: string }>
}
export interface SyncedStructureBase {
  clientOperationId: string
  hostsWorkingBefore: SyncedHostWorkingBefore[]
  groups: SyncedGroupGuard[]
  expectedInstances: SyncedInstanceGuard[]
}
export type SyncedStructureInput = SyncedStructureBase & (
  | { mode: 'command'; action: SyncedStructureAction }
  | { mode: 'host-final'; reason: 'source-apply' | 'selection-edit' | 'drop' | 'paste';
      finalAfter: Array<{ documentId: string; title: string; summary: string; blocks: SyncedStableBlockDraft[] }>;
      newRefSources: SyncedNewRefSource[] }
)
export type SyncedStructureResult = SyncedStructureApplied | SyncedFailure

export type SyncedUpdateGroupInput = SyncedGroupGuard & {
  clientOperationId: string
  expectedInstanceBinding: SyncedInstanceGuard
  blocks: SyncedCanonicalEdit[]
  bindingClaims?: SyncedBindingClaim[]
}
export type SyncedRestoreGroupInput = SyncedGroupGuard & {
  clientOperationId: string
  expectedInstanceBinding: SyncedInstanceGuard
  historyToken: string
  expectedHistoryCursor: string
  direction: 'undo' | 'redo'
}
export interface SyncedRestoreHostInput {
  clientOperationId: string
  historyToken: string
  direction: 'undo' | 'redo'
  expectedHosts: Array<{ documentId: string; expectedUpdatedAt: string }>
  groups: SyncedGroupGuard[]
  expectedInstances: SyncedInstanceGuard[]
}
export interface SyncedBlocksChangedEvent {
  operationId: string
  changes: Array<{ groupId: string; revision: string; topologyRevision: string; kind: 'content' | 'topology' }>
  affectedInstanceIds: string[]
}
export interface SyncedGroupSnapshotsResult {
  workspaceScope: string
  items: Array<{ status: 'ready'; snapshot: SyncedGroupSnapshot } | { status: 'missing'; groupId: string }>
}
/** Explicit read extension; the existing snapshot API and closed snapshot shape stay unchanged. */
export interface SyncedGroupSnapshotsWithLinkSourcesResult {
  workspaceScope: string
  items: Array<{ status: 'ready'; snapshot: SyncedGroupSnapshot; bindingSource: SyncedBindingSource }
    | { status: 'missing'; groupId: string }>
}
export interface SyncedGroupListResult {
  items: Array<{ groupId: string; preview: string; originPath: string; liveInstances: number }>
  total: number
}
export type SyncedOperationResult =
  | { status: 'committed'; result: SyncedGroupSaved | SyncedStructureApplied }
  | { status: 'unknown' }
/** Explicit read extension. The stored ACK remains unchanged and tickets stay
 * Main-lifetime capabilities, outside portable semantics and executable history. */
export type SyncedOperationWithLinkSourceResult =
  | { status: 'unknown' }
  | { status: 'committed'; workspaceScope: string; result: SyncedGroupSaved; bindingSource: SyncedBindingSource }

/** The renderer may inject this complete port before the trusted IPC adapter is installed. */
export interface SyncedBlocksApi {
  getSyncedGroupSnapshots(input: { groupIds: string[] }): Promise<SyncedGroupSnapshotsResult>
  listSyncedGroups(input: { query: string; offset: number; limit: number }): Promise<SyncedGroupListResult>
  updateSyncedBlockGroup(input: SyncedUpdateGroupInput): Promise<SyncedGroupMutationResult>
  getSyncedOperation(input: { clientOperationId: string }): Promise<SyncedOperationResult>
  applySyncedHostStructure(input: SyncedStructureInput): Promise<SyncedStructureResult>
  restoreSyncedGroupOperation(input: SyncedRestoreGroupInput): Promise<SyncedGroupMutationResult>
  restoreSyncedHostOperation(input: SyncedRestoreHostInput): Promise<SyncedStructureResult>
  getSyncedHostHistory(input: { documentId: string }): Promise<SyncedHistoryState>
  onSyncedBlocksChanged(listener: (event: SyncedBlocksChangedEvent) => void): () => void
}

export interface SyncedBlockReferenceScope {
  groupId: string
  instanceId: string
  canonicalBlockId: string
  hostDocumentId: string
  revision: string
  bindingVersion: string
}
