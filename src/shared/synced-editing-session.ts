import type { SyncedBindingSource, SyncedGroupSnapshot, SyncedGroupSaved, SyncedGroupSnapshotsResult, SyncedGroupListResult,
  SyncedGroupMutationResult, SyncedUpdateGroupInput, SyncedRestoreGroupInput, SyncedStructureInput, SyncedStructureResult,
  SyncedRestoreHostInput, SyncedOperationResult, SyncedHistoryState } from './synced-blocks'
import type { SyncedInlineInstanceAddress } from './workspace-search-occurrence'

/** Opaque Main-issued read/write fence. Public fields do not reconstruct its
 * private DB/sender/epoch entry. It is never persisted or sent on the sync wire. */
export interface SyncedEditingSession { sessionId:string;workspaceScope:string;recoveryEpoch:string }
export type OpenSyncedEditingSessionInput=
  | {kind:'host';hostDocumentId:string}
  | {kind:'instance';hostDocumentId:string;instanceId:string;groupId:string}
export type OpenSyncedEditingSessionResult=
  | {status:'ready';session:SyncedEditingSession;host:{documentId:string;createdAt:string};instance?:SyncedInlineInstanceAddress;snapshot?:SyncedGroupSnapshot}
  | {status:'missing'}
export type SyncedEditingHostResult=SyncedStructureResult|{status:'unsupported';reason:string}
export type SyncedEditingBaselineResult=
  | {status:'ready';workspaceScope:string;readOwnerId:string;snapshot:SyncedGroupSnapshot;bindingSource:SyncedBindingSource}
  | {status:'missing';workspaceScope:string;groupId:string}
export type SyncedEditingOwnerResult={status:'ready';workspaceScope:string}|{status:'owner-unavailable'}
export type SyncedEditingOwnedOperationResult=
  | {status:'owner-unavailable'|'unknown-operation'}
  | {status:'committed';workspaceScope:string;result:SyncedGroupSaved;bindingSource:SyncedBindingSource}
export interface SyncedEditingMethods {
  getSyncedGroupSnapshots:{input:{groupIds:string[]};result:SyncedGroupSnapshotsResult}
  listSyncedGroups:{input:{query:string;offset:number;limit:number};result:SyncedGroupListResult}
  updateSyncedBlockGroup:{input:SyncedUpdateGroupInput;result:SyncedGroupMutationResult}
  restoreSyncedGroupOperation:{input:SyncedRestoreGroupInput;result:SyncedGroupMutationResult}
  getSyncedOperation:{input:{clientOperationId:string};result:SyncedOperationResult}
  applySyncedHostStructure:{input:SyncedStructureInput;result:SyncedEditingHostResult}
  restoreSyncedHostOperation:{input:SyncedRestoreHostInput;result:SyncedEditingHostResult}
  getSyncedHostHistory:{input:{documentId:string};result:SyncedHistoryState}
  captureBaseline:{input:{groupId:string};result:SyncedEditingBaselineResult}
  ownedOperation:{input:{readOwnerId:string;clientOperationId:string};result:SyncedEditingOwnedOperationResult}
  validateOwner:{input:{readOwnerId:string};result:SyncedEditingOwnerResult}
  releaseOwner:{input:{readOwnerId:string};result:void}
}
export type SyncedEditingMethod=keyof SyncedEditingMethods
export type SyncedEditingRequest<M extends SyncedEditingMethod=SyncedEditingMethod>=
  M extends SyncedEditingMethod?{sessionId:string;method:M;input:SyncedEditingMethods[M]['input']}:never
export type SyncedEditingResult<M extends SyncedEditingMethod>=SyncedEditingMethods[M]['result']
