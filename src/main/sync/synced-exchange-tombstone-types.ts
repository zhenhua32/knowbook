import type { SyncedGroupWire } from '../../shared/synced-blocks'
import type { SyncedPortableHostRecord } from '../../shared/syncedBlockPortable'
import type { ExchangeComponent, ExchangeDeferredReason, ExchangeSeedProof, ExchangeTransfer } from './synced-exchange-model'
import type { ExchangePlanAuthority, ExchangePlanIdentity } from './synced-exchange-plan'
import type { ExchangeMergeProvenance } from './synced-exchange-conflict-model'
import type { SyncedProtocol5Snapshot } from './synced-protocol5-model'

/** Private immutable planning data. None of these types grants a caller SQL or remote authority. */
export type TombstoneLocalOutcome =
  | { kind: 'live'; hash: string }
  | { kind: 'absent'; tombstoneHash: string; deletionOperationId: string; intentHash: string }

export interface TombstoneBaselineEntry {
  key: string
  local: TombstoneLocalOutcome
  remoteHash: string
  commonHash: string | null
  dependencyKeys: string[]
  dependencySignature: string
  acceptedOperationId: string
}
export interface TombstoneDeferredComponent extends ExchangeComponent { reason: ExchangeDeferredReason }
export interface TombstoneExchangeState {
  kind: 'synced-exchange-state'
  version: 2
  databasePath: string
  targetFingerprint: string
  workspaceScope: string
  recoveryEpoch: string
  remoteWorkspaceId: string
  generation: string
  currentOperationId: string | null
  source: ExchangeSeedProof
  baseline: TombstoneBaselineEntry[]
  deferred: TombstoneDeferredComponent[]
  lastSyncAt: string
}

/** Runtime has already authenticated this exact durable fact through the original receipt and denial anchor. */
export interface TombstoneDeletedFact {
  key: string
  tombstoneHash: string
  deletionOperationId: string
  intentHash: string
}
/** Every actual persistent pin is represented, including unknown kind strings and authenticated archives. */
export interface TombstonePinFact {
  groupId: string
  kind: string
  pinId: string
  sourceHash: string
}
export interface TombstonePlanAuthority extends ExchangePlanAuthority {
  deletedFacts: readonly TombstoneDeletedFact[]
  pins: readonly TombstonePinFact[]
}
export interface TombstonePlanInput {
  operationId: string
  /** Strict live-only physical SQL projection. Actual absence never fabricates a deletion wire. */
  localPhysical: SyncedProtocol5Snapshot
  /** Same live records plus exact durable deletion knowledge; current scope is local workspaceScope. */
  localKnowledge: SyncedProtocol5Snapshot
  remote: SyncedProtocol5Snapshot
  baseRecords: readonly SyncedProtocol5Snapshot['records'][number][]
  state: TombstoneExchangeState
  localFingerprint: string
  authority: TombstonePlanAuthority
}

export interface TombstoneAcceptedSide {
  key: string
  beforeLocalHash: string | null
  beforeRemoteHash: string | null
  local: TombstoneLocalOutcome
  remoteHash: string
  commonHash: string
  dependencyKeys: string[]
  dependencySignature: string
}
/** Fixed intent data excludes its own hash, acceptedAt and receiptHash: there is no recursive hash or proof grant. */
export interface TombstoneIdentityEffect {
  before: ExchangePlanIdentity
  after: { kind: 'retained' } | { kind: 'transferred'; ownerKind: 'document' | 'group'; ownerId: string; createdAt: string }
}
export interface TombstoneDeletionIntent {
  kind: 'document' | 'group'
  key: string
  baseLiveHash: string
  tombstoneHash: string
  before: SyncedPortableHostRecord | SyncedGroupWire
  identities: TombstoneIdentityEffect[]
  intentHash: string
}
export interface TombstoneExchangePlan {
  plannerVersion: 'tombstones-v1'
  nextRemote: SyncedProtocol5Snapshot
  localKnowledgeFinal: SyncedProtocol5Snapshot
  localPhysicalFinal: SyncedProtocol5Snapshot
  writes: string[]
  incoming: string[]
  accepted: string[]
  components: ExchangeComponent[]
  deferred: TombstoneDeferredComponent[]
  transfers: ExchangeTransfer[]
  historyBoundaryKeys: string[]
  acceptedSides: TombstoneAcceptedSide[]
  nextBaseline: TombstoneBaselineEntry[]
  deletions: TombstoneDeletionIntent[]
  merges: ExchangeMergeProvenance[]
  localFingerprint: string
  beforeManifestHash: string
  afterManifestHash: string
  planHash: string
}

/** Durable runtime-only proof references, installed in the same transaction as physical absence and state-last. */
export interface TombstoneProofReference {
  key: string
  intentHash: string
  proofHash: string
  anchorId: string
}
