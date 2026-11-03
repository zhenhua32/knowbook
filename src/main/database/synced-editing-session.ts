import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { OpenSyncedEditingSessionInput, OpenSyncedEditingSessionResult, SyncedEditingSession, SyncedEditingMethod,
  SyncedEditingRequest, SyncedEditingResult } from '../../shared/synced-editing-session'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { getSyncedGroupSnapshots, listSyncedGroups, getSyncedHostHistory } from './synced-blocks-read'
import { updateSyncedBlockGroup, restoreSyncedGroupOperation, getSyncedOperation } from './synced-blocks-content'
import { applySyncedHostFinal, applySyncedHostCommand, restoreSyncedHostOperation } from './synced-host-final'
import { captureSyncedBaselineOwnerWithMetadata2, getSyncedOperationWithOwnedLinkSource, validateSyncedReadOwner, releaseSyncedReadOwner } from './synced-binding-sources'
import { captureSyncedEditingFenceOwned, runWithSyncedEditingFence, assertSyncedEditingFenceOwned, assertSyncedEditingFenceRead,
  type SyncedEditingFence } from './synced-editing-fence'
import { resolveSyncedInlineInstance } from './workspace-search-occurrences'

type Entry={sender:object;fence:SyncedEditingFence;session:SyncedEditingSession;readOwners:Set<string>}
const fail=(message:string):never=>{throw new Error('Synced editing session unavailable: '+message+'; preserve drafts and reload the actual workspace.')}
const methods=new Set<SyncedEditingMethod>(['getSyncedGroupSnapshots','listSyncedGroups','updateSyncedBlockGroup','restoreSyncedGroupOperation',
  'getSyncedOperation','applySyncedHostStructure','restoreSyncedHostOperation','getSyncedHostHistory','captureBaseline','ownedOperation','validateOwner','releaseOwner'])
/** One actual Store connection and exact IPC frame own this namespace.
 * Callers never supply a database, source pair, mapper, fence owner or epoch. */
export class SyncedEditingSessionRepository {
  private entries=new Map<string,Entry>()
  private current=new WeakMap<object,Entry>()
  constructor(private readonly db:Database.Database){}
  private retire(entry:Entry):void {
    for(const readOwnerId of entry.readOwners)releaseSyncedReadOwner(this.db,{readOwnerId})
    entry.readOwners.clear();this.entries.delete(entry.session.sessionId)
    if(this.current.get(entry.sender)===entry)this.current.delete(entry.sender)
  }
  private retireOutside(boundary:{workspaceScope:string;recoveryEpoch:string}):void {
    for(const entry of this.entries.values())if(entry.session.workspaceScope!==boundary.workspaceScope||entry.session.recoveryEpoch!==boundary.recoveryEpoch)this.retire(entry)
  }
  open(sender:object,value:OpenSyncedEditingSessionInput):OpenSyncedEditingSessionResult {
    if(!sender||typeof sender!=='object')return fail('actual IPC frame missing')
    if(!value||typeof value!=='object')return fail('closed normal host/instance request required')
    if(value.kind==='host')assertSyncedShape(value,['kind','hostDocumentId'])
    else if(value.kind==='instance')assertSyncedShape(value,['kind','hostDocumentId','instanceId','groupId'])
    else return fail('unknown session kind')
    if(!isSyncedBlockId(value.hostDocumentId))return fail('host id invalid')
    if(this.db.inTransaction)return fail('host session capture requires its own committed SQL snapshot')
    const opened=this.db.transaction(()=>{
      const prior=this.current.get(sender),actual=this.db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
        {workspace_scope:string;recovery_epoch:string}|undefined
      const boundary=actual&&isSyncedUuid(actual.workspace_scope)&&isSyncedUuid(actual.recovery_epoch)
        ?{workspaceScope:actual.workspace_scope,recoveryEpoch:actual.recovery_epoch}:null
      const reuse=prior&&boundary&&boundary.workspaceScope===prior.session.workspaceScope&&boundary.recoveryEpoch===prior.session.recoveryEpoch?prior:undefined
      const inline=value.kind==='instance'?resolveSyncedInlineInstance(this.db,{hostDocumentId:value.hostDocumentId,instanceId:value.instanceId,groupId:value.groupId}):null
      if(inline?.status==='missing')return{status:'missing' as const,boundary}
      const captured=captureSyncedEditingFenceOwned(this.db,value.hostDocumentId,reuse?.fence)
      if(!captured)return{status:'missing' as const,boundary}
      const entry=reuse??{sender,fence:captured.owner,session:Object.freeze({sessionId:randomUUID(),workspaceScope:captured.workspaceScope,recoveryEpoch:captured.recoveryEpoch}),readOwners:new Set<string>()}
      return{status:'ready' as const,entry,host:captured.host,boundary:{workspaceScope:captured.workspaceScope,recoveryEpoch:captured.recoveryEpoch},
        ...(inline?.status==='ready'?{instance:inline.instance,snapshot:inline.snapshot}:{})}
    })()
    // Publish/retire only after this OWN read ended successfully. A temporary
    // epoch UPDATE rolled back by an outer savepoint must not revoke an owner.
    if(opened.boundary)this.retireOutside(opened.boundary)
    if(opened.status!=='ready')return{status:'missing'}
    for(const entry of this.entries.values())if(entry.sender===sender&&entry!==opened.entry)this.retire(entry)
    this.entries.set(opened.entry.session.sessionId,opened.entry);this.current.set(sender,opened.entry)
    return{status:'ready',session:opened.entry.session,host:opened.host,
      ...(opened.instance?{instance:opened.instance,snapshot:opened.snapshot}:{})}
  }
  invoke<M extends SyncedEditingMethod>(sender:object,value:SyncedEditingRequest<M>):SyncedEditingResult<M> {
    assertSyncedShape(value,['sessionId','method','input'])
    if(!isSyncedUuid(value.sessionId)||!methods.has(value.method))return fail('unknown session method or token')
    const entry=this.entries.get(value.sessionId)
    if(!entry||entry.sender!==sender)return fail('not the original IPC frame session')
    // IPC already clones its input. Clone here too so direct Main callers cannot
    // swap a guard object between old validation and the original transaction.
    const request=structuredClone(value.input),method=value.method
    const ownerId=()=>{assertSyncedShape(request,method==='ownedOperation'?['readOwnerId','clientOperationId']:['readOwnerId'])
      if(!('readOwnerId' in request)||!isSyncedUuid(request.readOwnerId))return fail('read owner id invalid');return request.readOwnerId}
    if(method==='releaseOwner'){
      const id=ownerId();if(entry.readOwners.delete(id))releaseSyncedReadOwner(this.db,{readOwnerId:id})
      return undefined as SyncedEditingResult<M>
    }
    const result=runWithSyncedEditingFence(this.db,entry.fence,method,request,()=>{
      if((method==='ownedOperation'||method==='validateOwner')&&!entry.readOwners.has(ownerId())){
        assertSyncedEditingFenceRead(this.db)
        return{status:'owner-unavailable' as const}
      }
      switch(method){
        case'getSyncedGroupSnapshots':return this.db.transaction(()=>{assertSyncedEditingFenceOwned(this.db);return getSyncedGroupSnapshots(this.db,request)})()
        case'listSyncedGroups':return this.db.transaction(()=>{assertSyncedEditingFenceOwned(this.db);return listSyncedGroups(this.db,request)})()
        case'getSyncedHostHistory':return this.db.transaction(()=>{assertSyncedEditingFenceOwned(this.db);return getSyncedHostHistory(this.db,request)})()
        case'updateSyncedBlockGroup':return updateSyncedBlockGroup(this.db,request)
        case'restoreSyncedGroupOperation':return restoreSyncedGroupOperation(this.db,request)
        case'getSyncedOperation':return getSyncedOperation(this.db,request)
        case'applySyncedHostStructure':return(request as {mode?:unknown}).mode==='command'?applySyncedHostCommand(this.db,request):applySyncedHostFinal(this.db,request)
        case'restoreSyncedHostOperation':return restoreSyncedHostOperation(this.db,request)
        case'captureBaseline':return captureSyncedBaselineOwnerWithMetadata2(this.db,request)
        case'ownedOperation':return getSyncedOperationWithOwnedLinkSource(this.db,request)
        case'validateOwner':return validateSyncedReadOwner(this.db,request)
        default:return fail('closed dispatch method omitted')
      }
    })
    if(method==='captureBaseline'&&result&&typeof result==='object'&&'readOwnerId'in result&&typeof result.readOwnerId==='string')entry.readOwners.add(result.readOwnerId)
    // Do not mint a new mount from an ACK or run another fallible SQL read after
    // commit. Changed instance bindings require the real inline open path again.
    return result as SyncedEditingResult<M>
  }
  release(sender:object,sessionId:string):void {
    if(!isSyncedUuid(sessionId))return fail('session token invalid')
    const entry=this.entries.get(sessionId);if(!entry||entry.sender!==sender)return fail('not the original IPC frame session')
    this.retire(entry)
  }
  releaseSender(sender:object):void {for(const [id,entry]of this.entries)if(entry.sender===sender)this.release(sender,id)}
  releaseAll():void {for(const [id,entry]of this.entries)this.release(entry.sender,id)}
}
