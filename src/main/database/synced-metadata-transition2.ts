import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { SyncedGroupWire, SyncedGroupSnapshot } from '../../shared/synced-blocks'
import { validateSyncedUpdateGroupInput } from '../../shared/syncedBlockInputs'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { hostEncode, hostEqual, hostHash } from './synced-host-journal'
import { hostJson } from './synced-host-document-read'
import { planSyncedMetadataNamespacesOwned2, readSyncedMetadataWorkspaceOwned2, readSyncedMetadataTargetSourceOwned2, type SyncedMetadataWorkspaceView2 } from './synced-metadata-view2'
import { projectSyncedMetadataStoredGroupLinksOwned2 } from './synced-metadata-group-links2'
import { captureSyncedMetadataCurrentTargets2, captureSyncedMetadataCurrentTargetBatch2 } from './synced-metadata-capture2'
import { readSyncedGroupHistoryOriginalOwned } from './synced-group-history-original'

declare const prepared:unique symbol
/** Read/planning owner only. No writer, history cursor or IPC session authority. */
export interface PreparedSyncedMetadataTransition2 {readonly[prepared]:true}
type Plan=ReturnType<typeof planSyncedMetadataNamespacesOwned2>
type Entry={db:Database.Database;plan:Plan;originalHash:string}
const entries=new WeakMap<object,Entry>(),fail=(message:string):never=>{throw new Error('Metadata2 transition unavailable: '+message)}
const digest=(domain:string,value:unknown)=>createHash('sha256').update(domain+'\0'+hostEncode(value)).digest('hex')
const wire=(group:SyncedGroupSnapshot):SyncedGroupWire=>({kind:'synced-group',id:group.groupId,
  creationId:group.creationId,createdAt:group.createdAt,origin:group.origin,blocks:group.blocks,bindings:group.bindings})
function sourceHash(db:Database.Database,base:SyncedMetadataWorkspaceView2,extraIdentities:Iterable<string>){
  const result=createHash('sha256').update('knowbook.synced.metadata2.native-original.v2\0')
  const add=(value:unknown)=>result.update(hostEncode(value)+'\0'),required=new Set(extraIdentities)
  add({kind:'workspace',workspaceScope:base.workspaceScope,recoveryEpoch:base.recoveryEpoch})
  for(const [id,value] of base.hosts)add({kind:'host',id,createdAt:value.host.createdAt,parentId:value.host.parentId,sortOrder:value.host.sortOrder,
    path:value.host.detail.path,updatedAt:value.host.detail.updatedAt,contentHash:hostHash(value.host.content),births:[...value.host.births],instances:[...value.instances]})
  for(const [id,group] of base.groups){
    add({kind:'group',id,wireHash:hostHash(wire(group)),revision:group.revision,topologyRevision:group.topologyRevision,instances:group.instances,history:group.history})
    for(const binding of group.bindings)if(binding.target.kind==='block')required.add(binding.target.id)
  }
  // Only relevant retained/W-only and captured block-target occupancy. Avoid
  // copying unrelated historical ledger rows or serializing a second world.
  for(const row of db.prepare(`SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities
    WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify([...required])))add({kind:'identity',row})
  return result.digest('hex')
}
/** The factory reads the actual complete P on the same original connection.
 * A caller plan/mapper/fingerprint cannot mint this private registry identity. */
function mint(db:Database.Database,input:unknown){
  const start=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const plan=planSyncedMetadataNamespacesOwned2(db,structuredClone(input)),originalHash=sourceHash(db,plan.base,plan.births.keys())
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==start)return fail('SQL changed during actual P/W/A planning')
  const owner=Object.freeze(Object.create(null)) as PreparedSyncedMetadataTransition2
  const entry={db,plan,originalHash};entries.set(owner,entry);return{owner,entry}
}
export function prepareSyncedMetadataTransitionOwned2(db:Database.Database,input:unknown):PreparedSyncedMetadataTransition2{return mint(db,input).owner}
function genuine(db:Database.Database,owner:PreparedSyncedMetadataTransition2){
  const entry=owner&&typeof owner==='object'?entries.get(owner):undefined
  if(!entry||entry.db!==db)return fail('not the genuine original-connection owner')
  const start=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const base=readSyncedMetadataWorkspaceOwned2(db)
  if(sourceHash(db,base,entry.plan.births.keys())!==entry.originalHash)return fail('actual original SQL/retained namespace changed')
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==start)return fail('SQL changed during original-connection verification')
  return entry
}
/** The write kernel consumes one genuine original read and one deduplicated
 * capture for its whole group set. No source facts are obtained from caller
 * transition arrays or from a matching hash in another owner. */
export function readSyncedMetadataTransitionBatchOwned2(db:Database.Database,owner:PreparedSyncedMetadataTransition2,
  groupIds:readonly string[],side:'working'|'final'){
  if(!Array.isArray(groupIds)||groupIds.some(id=>!isSyncedUuid(id))||new Set(groupIds).size!==groupIds.length
    ||side!=='working'&&side!=='final')return fail('closed unique group/side batch required')
  return transitionBatch(db,genuine(db,owner),groupIds,side)
}
function transitionBatch(db:Database.Database,entry:Entry,groupIds:readonly string[],side:'working'|'final'){
  const start=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const originals=groupIds.map(id=>entry.plan.base.groups.get(id)??fail('actual active group missing'))
  const currentCapture=captureSyncedMetadataCurrentTargetBatch2(entry.plan.base,originals.map(wire))
  const transitions=originals.map(snapshot=>{
    const projection=projectSyncedMetadataStoredGroupLinksOwned2(db,wire(snapshot),side==='working'?entry.plan.workingDestinations:entry.plan.finalDestinations)
    const value={groupId:snapshot.groupId,creationId:snapshot.creationId,groupCreatedAt:snapshot.createdAt,sourceRevision:snapshot.revision,
      sourceTopologyRevision:snapshot.topologyRevision,before:projection.before,after:projection.after,beforeHash:hostHash(projection.before),
      afterHash:hostHash(projection.after),edits:projection.edits,currentCaptureHash:currentCapture.captureHash}
    return{...value,transitionHash:digest('knowbook.synced.metadata2.group-transition-member.v2',value)}
  })
  const core={kind:'synced-group-metadata-transition-batch2' as const,version:2 as const,workspaceScope:entry.plan.base.workspaceScope,
    recoveryEpoch:entry.plan.base.recoveryEpoch,requestHash:digest('knowbook.synced.metadata2.host-request.v2',entry.plan.request),
    originalHash:entry.originalHash,capturedAt:entry.plan.now,side,currentCapture,transitions,rawLogicalChange:entry.plan.rawLogicalChange,
    writePermit:false as const,groupHistoryComplete:false as const,hostHistoryComplete:false as const}
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==start)return fail('SQL changed during complete transition batch')
  return hostJson(hostEncode({...core,transitionHash:digest('knowbook.synced.metadata2.group-transition-batch.v2',core)})) as typeof core&{transitionHash:string}
}
/** Initial edit capture shares the actual factory P observation. Later public
 * reads still invoke genuine() and rebuild the original connection evidence.
 * Only groups with typed targets in a changed namespace are captured. */
export function prepareSyncedMetadataAffectedTransitionsOwned2(db:Database.Database,input:unknown){
  const started=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const {owner,entry}=mint(db,input),affected=new Set<string>()
  for(const destinations of [entry.plan.workingDestinations,entry.plan.finalDestinations])for(const [id,value] of destinations)
    if(value.beforePath!==value.afterPath||value.headings.size)affected.add(id)
  const required=new Set([...entry.plan.base.groups.values()].flatMap(group=>group.bindings.flatMap(binding=>binding.target.kind==='block'?[binding.target.id]:[])))
  const owners=new Map<string,string>()
  if(required.size)for(const [documentId,value] of entry.plan.base.hosts)for(const blockId of value.host.births.keys())if(required.has(blockId))owners.set(blockId,documentId)
  const groupIds=[...entry.plan.base.groups].filter(([,group])=>group.bindings.some(binding=>{
    const target=binding.target,documentId=target.kind==='document'?target.id:target.kind==='heading'?target.documentId:target.kind==='block'?owners.get(target.id):undefined
    return documentId!==undefined&&affected.has(documentId)
  })).map(([id])=>id)
  const batch=transitionBatch(db,entry,groupIds,'final')
  const groupHistories=historyAnchors(db,groupIds.map(id=>entry.plan.base.groups.get(id)!))
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==started)return fail('SQL changed during the initial capture/history observation')
  return{owner,batch,groupHistories}
}
function historyAnchors(db:Database.Database,groups:readonly SyncedGroupSnapshot[]){
  const positions=new Map((db.prepare('SELECT id,history_position FROM synced_groups WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(groups.map(group=>group.groupId))) as Array<{id:string;history_position:number}>).map(row=>[row.id,row.history_position]))
  return groups.map(group=>{
    const groupId=group.groupId,position=positions.get(groupId)
    if(position===undefined||!Number.isSafeInteger(position)||position<0)return fail('actual captured group history position invalid')
    const currentPosition:number=position
    const originalSide=(token:string|null,side:'before'|'after')=>{
      if(token===null)return null
      const original=readSyncedGroupHistoryOriginalOwned(db,group,token,currentPosition+(side==='after'?0:1))
      if(!original)return fail('captured actual history side/position missing')
      const {row}=original
      return{id:row.id,position:row.position,beforeHash:row.before_hash,afterHash:row.after_hash,rowHash:hostHash({kind:'metadata2-original-group-history-row',row}),
        matchesCurrentWire:(side==='after'?row.after_hash:row.before_hash)===hostHash(wire(group))}
    }
    return{groupId,creationId:group.creationId,createdAt:group.createdAt,position:currentPosition,history:group.history,
      undoSide:originalSide(group.history.undoToken,'after'),redoSide:originalSide(group.history.redoToken,'before')}
  })
}
/** Explicit source for a canonical edit: no fabricated host-final intent or
 * W/A alias. The actual mounted instance, group CAS and entire current P are
 * read on the original connection before any new binding lineage is recorded. */
export function prepareSyncedMetadataGroupCurrentCaptureOwned2(db:Database.Database,value:unknown){
  const started=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,input=validateSyncedUpdateGroupInput(structuredClone(value))
  const base=readSyncedMetadataWorkspaceOwned2(db),group=base.groups.get(input.groupId)??fail('actual edit group missing')
  const instance=group.instances.find(instance=>instance.instanceId===input.expectedInstanceBinding.instanceId)
  if(group.revision!==input.expectedRevision||group.topologyRevision!==input.expectedTopologyRevision||!instance
    ||instance.hostDocumentId!==input.expectedInstanceBinding.hostDocumentId||instance.bindingVersion!==input.expectedInstanceBinding.bindingVersion)
    return fail('actual canonical edit CAS/mount binding changed')
  const before=wire(group),capture=captureSyncedMetadataCurrentTargetBatch2(base,[before]),groupHistories=historyAnchors(db,[group])
  const originalHash=sourceHash(db,base,input.blocks.map(block=>block.id)),requestHash=digest('knowbook.synced.metadata2.group-capture-request.v2',input)
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==started)return fail('SQL changed during actual canonical source capture')
  return{workspaceScope:base.workspaceScope,recoveryEpoch:base.recoveryEpoch,capturedAt:new Date().toISOString(),requestHash,originalHash,capture,
    sources:[{wire:before,revision:group.revision,topologyRevision:group.topologyRevision}],groupHistories}
}
/** A read source point has no edit intent, fake blocks, W/A or business ACK.
 * The complete current namespace and exact real group tail share this owned
 * snapshot. Callers obtain data evidence only; the session owns write fences. */
export function prepareSyncedMetadataGroupBaselineCurrentCaptureOwned2(db:Database.Database,groupId:string){
  if(!isSyncedUuid(groupId))return fail('actual group source-point id invalid')
  const started=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const base=readSyncedMetadataTargetSourceOwned2(db,groupId),group=base.groups.get(groupId)??fail('actual source-point group missing')
  const before=wire(group),capture=captureSyncedMetadataCurrentTargetBatch2(base,[before]),groupHistories=historyAnchors(db,[group])
  const originalHash=digest('knowbook.synced.metadata2.target-scope-original.v2',{workspaceScope:base.workspaceScope,recoveryEpoch:base.recoveryEpoch,capture,groupHistories}),requestHash=digest('knowbook.synced.metadata2.read-source-point-request.v2',{groupId})
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==started)return fail('SQL changed during actual read source-point capture')
  return{workspaceScope:base.workspaceScope,recoveryEpoch:base.recoveryEpoch,capturedAt:new Date().toISOString(),requestHash,originalHash,capture,
    sources:[{wire:before,revision:group.revision,topologyRevision:group.topologyRevision}],groupHistories}
}
/** New live-maintenance data domain. The exact before/after mapping can later
 * be persisted by the complete metadata2 transaction; this leaf never writes
 * or labels its DTO as an executable group/host operation. */
export function readSyncedMetadataGroupTransitionOwned2(db:Database.Database,owner:PreparedSyncedMetadataTransition2,
  groupId:string,side:'working'|'final'){
  if(!isSyncedUuid(groupId)||side!=='working'&&side!=='final')return fail('closed group/side address required')
  const entry=genuine(db,owner),snapshot=entry.plan.base.groups.get(groupId)??fail('actual active group missing')
  const start=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const projection=projectSyncedMetadataStoredGroupLinksOwned2(db,wire(snapshot),side==='working'?entry.plan.workingDestinations:entry.plan.finalDestinations)
  const core={kind:'synced-group-metadata-transition2' as const,version:2 as const,workspaceScope:entry.plan.base.workspaceScope,
    recoveryEpoch:entry.plan.base.recoveryEpoch,requestHash:digest('knowbook.synced.metadata2.host-request.v2',entry.plan.request),
    originalHash:entry.originalHash,capturedAt:entry.plan.now,side,groupId,creationId:snapshot.creationId,groupCreatedAt:snapshot.createdAt,
    sourceRevision:snapshot.revision,sourceTopologyRevision:snapshot.topologyRevision,
    before:projection.before,after:projection.after,beforeHash:hostHash(projection.before),afterHash:hostHash(projection.after),edits:projection.edits,
    currentCapture:captureSyncedMetadataCurrentTargets2(entry.plan.base,projection.before),
    rawLogicalChange:entry.plan.rawLogicalChange,writePermit:false as const,groupHistoryComplete:false as const,hostHistoryComplete:false as const}
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==start)return fail('SQL changed while projecting actual original Keys')
  // Return an independent plain value. No external mutable alias can alter the
  // registry's actual P, fixed Main allocations, request or next read.
  return hostJson(hostEncode({...core,transitionHash:digest('knowbook.synced.metadata2.group-transition.v2',core)})) as
    typeof core&{transitionHash:string}
}
/** Exact current-tail subcase, with the real raw row/hash kept separate from
 * its effective pending metadata view. This does not guess older Key lineage.
 * Broader historical continuity remains a required follow-up, not an empty
 * success result or permanent exclusion from the metadata2 design. */
export function readSyncedMetadataExactHistorySideOwned2(db:Database.Database,owner:PreparedSyncedMetadataTransition2,
  input:{groupId:string;historyToken:string;side:'before'|'after';projection:'working'|'final'}){
  if(!isSyncedUuid(input.historyToken)||input.side!=='before'&&input.side!=='after')return fail('closed actual history side required')
  const transition=readSyncedMetadataGroupTransitionOwned2(db,owner,input.groupId,input.projection)
  const actual=entries.get(owner)!.plan.base.groups.get(input.groupId)!,token=input.side==='after'?actual.history.undoToken:actual.history.redoToken
  const originalSide=readSyncedGroupHistoryOriginalOwned(db,actual,input.historyToken)
  if(!originalSide)return{status:'missing' as const}
  const {row}=originalSide,original=originalSide[input.side],rawHash=input.side==='before'?row.before_hash:row.after_hash
  const position=(db.prepare('SELECT history_position FROM synced_groups WHERE id=?').get(input.groupId) as {history_position:number}).history_position
  const adjacent=row.id===token&&Number.isSafeInteger(position)&&row.position===position+(input.side==='after'?0:1)
  if(!adjacent||!hostEqual(original,transition.before))return{status:'requires-history-lineage' as const,historyToken:row.id,rawHash,
    effectiveGroupHistoryComplete:false as const,writePermit:false as const}
  return{status:'ready' as const,historyToken:row.id,rawHash,original,effective:transition.after,effectiveHash:transition.afterHash,
    transitionHash:transition.transitionHash,rawJournalRewritten:false as const,effectiveGroupHistoryComplete:false as const,writePermit:false as const}
}
