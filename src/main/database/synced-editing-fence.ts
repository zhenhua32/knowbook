import type Database from 'better-sqlite3'
import type { SyncedInlineInstanceAddress } from '../../shared/workspace-search-occurrence'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { readStrictHostDocument } from './synced-host-document-read'
import { assertCanonicalSearchSnapshotOwned, resolveSyncedInlineInstance, syncedInlineInstancesSql, type SyncedInlineInstanceSqlRow } from './workspace-search-occurrences'

export interface SyncedEditingFence {readonly kind:'main-owned-synced-editing-fence'}
type Saved={db:Database.Database;workspaceScope:string;recoveryEpoch:string;hosts:Map<string,string>;instances:Map<string,SyncedInlineInstanceAddress>}
type Running={owner:SyncedEditingFence;method:string;input:unknown}
const fences=new WeakMap<SyncedEditingFence,Saved>(),running=new WeakMap<Database.Database,Running>()
const fail=(message:string):never=>{throw new Error('Synced editing session is unavailable: '+message+'; preserve the current draft.')}
function workspaceOwned(db:Database.Database){
  if(!db.open||!db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1||db.pragma('main.user_version',{simple:true})!==27)return fail('actual owned schema27 transaction required')
  const state=db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as {workspace_scope:unknown;recovery_epoch:unknown}|undefined
  if(!state||!isSyncedUuid(state.workspace_scope)||!isSyncedUuid(state.recovery_epoch))return fail('actual workspace boundary missing')
  return{workspaceScope:state.workspace_scope,recoveryEpoch:state.recovery_epoch}
}
/** Called only in the Main session factory's actual SQL snapshot. All host
 * births and persisted instance bindings come from SQL, never a caller DTO. */
export function captureSyncedEditingFenceOwned(db:Database.Database,hostId:string,previous?:SyncedEditingFence){
  const state=workspaceOwned(db);assertCanonicalSearchSnapshotOwned(db)
  const host=readStrictHostDocument(db,hostId);if(!host)return null
  let saved=previous?fences.get(previous):undefined
  if(previous&&(!saved||saved.db!==db||saved.workspaceScope!==state.workspaceScope||saved.recoveryEpoch!==state.recoveryEpoch))return fail('old session cannot adopt another epoch')
  const owner=previous??Object.freeze({kind:'main-owned-synced-editing-fence' as const})
  if(!saved){saved={db,...state,hosts:new Map(),instances:new Map()};fences.set(owner,saved)}
  const existingBirth=saved.hosts.get(hostId)
  if(existingBirth!==undefined&&existingBirth!==host.createdAt)return fail('host was replaced with another birth')
  const rows=db.prepare(`SELECT * FROM (${syncedInlineInstancesSql}) WHERE document_id=?`).all(hostId) as SyncedInlineInstanceSqlRow[]
  const captured:SyncedInlineInstanceAddress[]=[]
  for(const row of rows){const actual=resolveSyncedInlineInstance(db,{hostDocumentId:hostId,instanceId:row.instance_id,groupId:row.group_id})
    if(actual.status!=='ready')return fail('same-snapshot instance disappeared')
    captured.push(actual.instance)
  }
  saved.hosts.set(hostId,host.createdAt)
  for(const [id,instance]of saved.instances)if(instance.hostDocumentId===hostId)saved.instances.delete(id)
  for(const instance of captured)saved.instances.set(instance.instanceId,Object.freeze({...instance}))
  return{owner,host:{documentId:hostId,createdAt:host.createdAt},...state}
}
export function readSyncedEditingFence(owner:SyncedEditingFence,db:Database.Database){const saved=fences.get(owner)
  if(!saved||saved.db!==db)return fail('not a genuine Main fence for this database')
  return{workspaceScope:saved.workspaceScope,recoveryEpoch:saved.recoveryEpoch,hostIds:[...saved.hosts.keys()]}
}
/** Installs no transaction and accepts no asynchronous continuation. The
 * original writer/read leaf must call assert... from ITS real transaction. */
export function runWithSyncedEditingFence<T>(db:Database.Database,owner:SyncedEditingFence,method:string,input:unknown,run:()=>T):T {
  readSyncedEditingFence(owner,db)
  if(db.inTransaction||running.has(db))return fail('writer requires its own outer transaction without reentry')
  running.set(db,{owner,method,input})
  try{const result=run();if(result&&typeof result==='object'&&'then' in result)return fail('asynchronous preflight cannot carry a synchronous fence');return result}
  finally{running.delete(db)}
}
/** Legacy direct calls have no fence and retain their original behavior.
 * New production calls always install a genuine opaque session first. */
export function assertSyncedEditingFenceOwned(db:Database.Database):void {
  const active=running.get(db);if(!active)return
  const saved=fences.get(active.owner);if(!saved||saved.db!==db)return fail('genuine call context lost')
  const state=workspaceOwned(db)
  if(state.workspaceScope!==saved.workspaceScope||state.recoveryEpoch!==saved.recoveryEpoch)return fail('workspace epoch changed')
  const request=active.input as Record<string,unknown>
  const host=(id:unknown)=>{if(typeof id!=='string')return fail('host address missing')
    const birth=saved.hosts.get(id),actual=db.prepare('SELECT created_at FROM documents WHERE id=?').get(id) as {created_at:string}|undefined
    if(!birth||actual?.created_at!==birth)return fail('host birth differs from the actual opened host session')}
  const instance=(value:unknown)=>{if(!value||typeof value!=='object')return fail('actual instance guard missing')
    const expected=value as Record<string,unknown>,proof=typeof expected.instanceId==='string'?saved.instances.get(expected.instanceId):undefined
    if(!proof||expected.hostDocumentId!==proof.hostDocumentId||expected.bindingVersion!==proof.bindingVersion)return fail('instance was not read in this actual host session')
    host(proof.hostDocumentId)
    const row=db.prepare(`SELECT * FROM (${syncedInlineInstancesSql}) WHERE document_id=? AND instance_id=? AND group_id=?`)
      .get(proof.hostDocumentId,proof.instanceId,proof.groupId) as SyncedInlineInstanceSqlRow|undefined
    if(!row||row.host_created_at!==proof.hostCreatedAt||row.instance_created_at!==proof.instanceCreatedAt||row.binding_version!==proof.bindingVersion
      ||row.creation_id!==proof.creationId||row.group_created_at!==proof.groupCreatedAt||row.parent_block_id!==proof.parentBlockId||row.instance_depth!==proof.depth)
      return fail('actual instance birth/group/placement/binding changed before the writer transaction')
    if((active.method==='updateSyncedBlockGroup'||active.method==='restoreSyncedGroupOperation')&&request.groupId!==proof.groupId)return fail('canonical request belongs to another captured group')
  }
  if(active.method==='updateSyncedBlockGroup'||active.method==='restoreSyncedGroupOperation')instance(request.expectedInstanceBinding)
  if(active.method==='applySyncedHostStructure'){
    if(!Array.isArray(request.hostsWorkingBefore)||!Array.isArray(request.expectedInstances))return fail('complete host guards missing')
    for(const side of request.hostsWorkingBefore)host((side as Record<string,unknown>).documentId)
    for(const guard of request.expectedInstances)instance(guard)
  }
  if(active.method==='restoreSyncedHostOperation'){
    if(!Array.isArray(request.expectedHosts)||!Array.isArray(request.expectedInstances))return fail('complete host inverse guards missing')
    for(const side of request.expectedHosts)host((side as Record<string,unknown>).documentId)
    for(const guard of request.expectedInstances)instance(guard)
  }
  if(active.method==='getSyncedHostHistory')host(request.documentId)
}

/** New metadata business writers are production session consumers only. They
 * cannot silently acquire the legacy direct writer's unfenced compatibility. */
export function requireSyncedMetadataEditingFenceOwned2(db:Database.Database):void {
  if(!running.has(db))return fail('metadata2 requires the genuine active Main editing session')
  assertSyncedEditingFenceOwned(db)
}

/** Negative readonly results still belong to the current real epoch. Only a
 * genuine running context uses SQL; old unfenced early returns stay unchanged.
 * The callback is just this assertion, never an outer wrapper of an old reader. */
export function assertSyncedEditingFenceRead(db:Database.Database):void {
  if(!running.has(db))return
  if(db.inTransaction)return fail('readonly fence requires its own SQL snapshot')
  db.transaction(()=>{assertSyncedEditingFenceOwned(db)})()
}
