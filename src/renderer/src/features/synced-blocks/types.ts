import type {
  SyncedBindingClaim, SyncedCanonicalEdit, SyncedFailure, SyncedGroupGuard, SyncedGroupSnapshot, SyncedInstanceGuard
} from '@shared/synced-blocks'
import type { EditorHistoryBookmark } from '../../utils/editorHistoryFocus'

export type SyncedForestOwner = { kind: 'document'; documentId: string } | { kind: 'synced-group'; groupId: string }

export interface SyncedScopeBase {
  hostDocumentId: string
  windowSessionId: string
  hostSession: object
  mountEpoch: object
  bindingEpoch: object
  domNamespace: string
  root: () => HTMLElement | null
  isCurrent: () => boolean
}

export interface SyncedGroupScope extends SyncedScopeBase {
  owner: { kind: 'synced-group'; groupId: string }
  instanceId: string
  bindingVersion: string
}

export type SyncedForestScope = SyncedGroupScope | (SyncedScopeBase & {
  owner: { kind: 'document'; documentId: string }
  instanceId?: never
  bindingVersion?: never
})

/** Object epochs stay in memory. Recovery uses its own serializable identity. */
export interface SyncedScopeBookmark {
  owner: SyncedForestOwner
  instanceId?: string
  mountEpoch: object
  bindingEpoch: object
  selection: EditorHistoryBookmark
}

export interface SyncedGroupDraftState {
  snapshot: SyncedGroupSnapshot
  working: SyncedCanonicalEdit[]
  editSequence: number
  dirty: boolean
  phase: 'clean' | 'dirty' | 'saving' | 'conflict' | 'error'
  incoming: SyncedGroupSnapshot | null
  failure: SyncedFailure | null
  error: string | null
  pending: { clientOperationId: string; kind: 'content' | 'history'; editSequence: number } | null
  composingInstanceIds: string[]
  canUndo: boolean
  canRedo: boolean
}

export interface SyncedGroupApply {
  scope: SyncedGroupScope
  expectedEditSequence: number
  guards: SyncedGroupGuard
  blocks: SyncedCanonicalEdit[]
  /** Complete destination claims for this working-before -> candidate step. */
  bindingClaims?: SyncedBindingClaim[]
  bookmark: SyncedScopeBookmark | null
  transactionId: string
}

/** An instance binds the shared controller; it owns no second write queue/history. */
export interface SyncedGroupBinding {
  readonly scope: SyncedGroupScope
  getCurrent: () => SyncedGroupDraftState
  subscribe: (notify: () => void) => () => void
  isCurrent: () => boolean
  apply: (input: Omit<SyncedGroupApply, 'scope'>) => boolean
  checkpoint: () => void
  undo: () => Promise<boolean>
  redo: () => Promise<boolean>
  flush: (options?: { shouldContinue?: () => boolean }) => Promise<boolean>
  setComposing: (composing: boolean) => void
  getBookmark: () => SyncedScopeBookmark | null
  setBookmark: (bookmark: SyncedScopeBookmark | null) => void
  dispose: () => void
}

export interface SyncedGroupController {
  getSnapshot: () => SyncedGroupDraftState
  subscribe: (notify: () => void) => () => void
  bind: (scope: SyncedGroupScope) => SyncedGroupBinding
  apply: (input: SyncedGroupApply) => boolean
  checkpoint: () => void
  undo: (scope: SyncedGroupScope) => Promise<boolean>
  redo: (scope: SyncedGroupScope) => Promise<boolean>
  flush: (options?: { shouldContinue?: () => boolean }) => Promise<boolean>
}

export function syncedScopeDomKey(scope: SyncedForestScope, blockId: string, slot: string): string {
  return JSON.stringify([scope.domNamespace, scope.owner.kind,
    scope.owner.kind === 'document' ? scope.owner.documentId : scope.owner.groupId,
    scope.instanceId ?? null, blockId, slot])
}

export function syncedScopeInstanceGuard(scope: SyncedGroupScope): SyncedInstanceGuard {
  return { instanceId: scope.instanceId, hostDocumentId: scope.hostDocumentId, bindingVersion: scope.bindingVersion }
}

export function syncedSnapshotGuard(snapshot: SyncedGroupSnapshot): SyncedGroupGuard {
  return { groupId: snapshot.groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision }
}
