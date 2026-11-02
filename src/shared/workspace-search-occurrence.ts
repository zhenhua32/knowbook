import type { SyncedGroupSnapshot } from './synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from './syncedBlockValidation'

/** A read address, never mutation authority. A canonical ID has no host by
 * itself; each repeated instance is a separate result and navigation target. */
export interface WorkspaceSearchOccurrence {
  version: 1
  workspaceScope: string
  recoveryEpoch: string
  hostDocumentId: string
  hostCreatedAt: string
  instanceId: string
  instanceCreatedAt: string
  bindingVersion: string
  parentBlockId: string | null
  depth: number
  groupId: string
  creationId: string
  groupCreatedAt: string
  revision: string
  topologyRevision: string
  canonicalBlockId: string
  canonicalCreatedAt: string
}
export type WorkspaceSearchOccurrenceResult =
  | { status: 'ready'; occurrence: WorkspaceSearchOccurrence; snapshot: SyncedGroupSnapshot }
  | { status: 'stale' | 'missing' }
export type SyncedInlineInstanceAddress=Omit<WorkspaceSearchOccurrence,'canonicalBlockId'|'canonicalCreatedAt'>
export interface ResolveSyncedInlineInstanceInput { hostDocumentId:string;instanceId:string;groupId:string }
export type SyncedInlineInstanceResult=
  | {status:'ready';instance:SyncedInlineInstanceAddress;snapshot:SyncedGroupSnapshot}
  | {status:'missing'}

const keys=['version','workspaceScope','recoveryEpoch','hostDocumentId','hostCreatedAt','instanceId','instanceCreatedAt','bindingVersion',
  'parentBlockId','depth','groupId','creationId','groupCreatedAt','revision','topologyRevision','canonicalBlockId','canonicalCreatedAt'] as const
const uuid=(value:unknown):string=>isSyncedUuid(value)?value:bad()
const identity=(value:unknown):string=>isSyncedBlockId(value)?value:bad()
const time=(value:unknown):string=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:bad()
function bad():never { throw new Error('Invalid exact workspace search occurrence.') }
export function validateWorkspaceSearchOccurrence(input:unknown):WorkspaceSearchOccurrence {
  assertSyncedShape(input,keys)
  return {...inlineAddress(input),canonicalBlockId:identity(input.canonicalBlockId),canonicalCreatedAt:time(input.canonicalCreatedAt)}
}
function inlineAddress(input:Record<string,unknown>):SyncedInlineInstanceAddress {
  if(input.version!==1||!Number.isSafeInteger(input.depth)||(input.depth as number)<0||(input.depth as number)>6)return bad()
  return{version:1,workspaceScope:uuid(input.workspaceScope),recoveryEpoch:uuid(input.recoveryEpoch),hostDocumentId:identity(input.hostDocumentId),
    hostCreatedAt:time(input.hostCreatedAt),instanceId:uuid(input.instanceId),instanceCreatedAt:time(input.instanceCreatedAt),bindingVersion:uuid(input.bindingVersion),
    parentBlockId:input.parentBlockId===null?null:identity(input.parentBlockId),depth:input.depth as number,groupId:uuid(input.groupId),creationId:uuid(input.creationId),
    groupCreatedAt:time(input.groupCreatedAt),revision:uuid(input.revision),topologyRevision:uuid(input.topologyRevision)}
}
export function validateSyncedInlineInstanceAddress(input:unknown):SyncedInlineInstanceAddress {
  assertSyncedShape(input,keys.filter(key=>key!=='canonicalBlockId'&&key!=='canonicalCreatedAt'))
  return inlineAddress(input)
}
export function isSameWorkspaceSearchOccurrence(left:WorkspaceSearchOccurrence,right:WorkspaceSearchOccurrence):boolean {
  return keys.every(key=>left[key]===right[key])
}
