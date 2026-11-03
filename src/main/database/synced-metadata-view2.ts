import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { SyncedGroupSnapshot } from '../../shared/synced-blocks'
import type { SyncedInlineInstanceAddress } from '../../shared/workspace-search-occurrence'
import { parseSyncedBlockPayload, SYNCED_MAX_BLOCKS, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { validateSyncedStructureInput } from '../../shared/syncedBlockInputs'
import { BlockIdentityRepository } from './block-identities'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { hostEqual, type HostFinalInput } from './synced-host-journal'
import { readCanonicalRuntimeHostDocumentOwned, type StrictHostDocument, type HostContent } from './synced-host-document-read'
import { resolveRawLiveBlockOwner } from './block-identities-raw-read'
import { readOriginalSqlTextRowsOwned2 } from './synced-history-evidence-support'
import { assertSyncedStoredBindings } from './synced-stored-binding-read'
import { assertCanonicalSearchSnapshotOwned, inlineInstanceFromRow, resolveSyncedInlineInstance, syncedInlineInstancesSql, type SyncedInlineInstanceSqlRow } from './workspace-search-occurrences'
import { projectSyncedHostHeadings2, planSyncedHeadingRewrites2 } from './synced-heading-projection2'
import { planStoredDocumentTitle2 } from './document-metadata-plan2'

const fail=(message:string):never=>{throw new Error('Metadata2 native view: '+message)}
export interface SyncedMetadataHostView2 {host:StrictHostDocument;instances:Map<string,SyncedInlineInstanceAddress>}
export interface SyncedMetadataWorkspaceView2 {
  workspaceScope:string;recoveryEpoch:string;hosts:Map<string,SyncedMetadataHostView2>;groups:Map<string,SyncedGroupSnapshot>
}
/** Current source-point target closure, not a complete mutable workspace plan.
 * Read every referenced namespace in full; unrelated ordinary documents and
 * canonical bodies are never copied merely to open a Source baseline. */
export function readSyncedMetadataTargetSourceOwned2(db:Database.Database,groupId:string){
  if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27||db.pragma('foreign_keys',{simple:true})!==1)
    return fail('owned schema27/FKON source-point snapshot required')
  assertCanonicalSearchSnapshotOwned(db)
  const identity=new BlockIdentityRepository(db).getWorkspaceIdentity(),groups=new Map<string,SyncedGroupSnapshot>(),hosts=new Map<string,SyncedMetadataHostView2>()
  const loadGroup=(id:string)=>{
    const present=groups.get(id);if(present)return present
    readOriginalSqlTextRowsOwned2(db,'synced_groups',['id','creation_id','created_at','origin_json','bindings_json','revision','topology_revision','history_cursor'],'id=?',[id])
    readOriginalSqlTextRowsOwned2(db,'synced_group_blocks',['id','group_id','parent_block_id','type','content','tags_json','language','markdown_format_json','highlight','created_at'],'group_id=?',[id])
    const item=getSyncedGroupSnapshots(db,{groupIds:[id]}).items[0]
    if(!item||item.status!=='ready')return fail('actual referenced source-point group missing')
    assertSyncedStoredBindings(db,item.snapshot.origin,item.snapshot.blocks,item.snapshot.bindings)
    groups.set(id,item.snapshot);return item.snapshot
  }
  const original=loadGroup(groupId),documentIds=new Set<string>()
  for(const binding of original.bindings){const target=binding.target
    if(target.kind==='document')documentIds.add(target.id)
    else if(target.kind==='heading')documentIds.add(target.documentId)
    else if(target.kind==='block'){
      const owner=resolveRawLiveBlockOwner(db,target.id)
      if(owner?.kind==='document')documentIds.add(owner.id)
      else if(owner?.kind==='group')loadGroup(owner.id)
    }
  }
  for(const documentId of [...documentIds].sort()){
    readOriginalSqlTextRowsOwned2(db,'documents',['id','title','path','summary','created_at','updated_at','parent_id'],'id=?',[documentId])
    readOriginalSqlTextRowsOwned2(db,'blocks',['id','document_id','parent_block_id','type','content','tags_json','language','markdown_format_json','highlight','created_at'],'document_id=?',[documentId])
    const host=readCanonicalRuntimeHostDocumentOwned(db,documentId);if(!host)continue
    const instances=new Map<string,SyncedInlineInstanceAddress>()
    for(const leaf of host.content.blocks)if(leaf.type==='synced-block'){
      const id=parseSyncedBlockPayload(leaf.content).groupId,actual=resolveSyncedInlineInstance(db,{hostDocumentId:documentId,instanceId:leaf.id,groupId:id})
      if(actual.status!=='ready'||actual.instance.hostCreatedAt!==host.createdAt||actual.instance.instanceCreatedAt!==host.births.get(leaf.id))return fail('source-point target namespace lacks an exact actual occurrence')
      const group=loadGroup(id)
      if(group.revision!==actual.snapshot.revision||group.topologyRevision!==actual.snapshot.topologyRevision)return fail('same-snapshot namespace group CAS differs')
      instances.set(leaf.id,actual.instance)
    }
    hosts.set(documentId,{host,instances})
  }
  return{...identity,hosts,groups,scope:'one-source-and-complete-referenced-targets' as const}
}
/** Actual one-snapshot read seam. Returned values are readonly planning facts,
 * not a write/session/source capability and not a snapshot cache. */
export function readSyncedMetadataWorkspaceOwned2(db:Database.Database):SyncedMetadataWorkspaceView2{
  if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27||db.pragma('foreign_keys',{simple:true})!==1)
    return fail('owned schema27/FKON SQL snapshot required')
  assertCanonicalSearchSnapshotOwned(db)
  const identity=new BlockIdentityRepository(db).getWorkspaceIdentity(),groups=new Map<string,SyncedGroupSnapshot>()
  const groupIds=(db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{id:string}>).map(row=>row.id)
  for(let start=0;start<groupIds.length||start===0;start+=SYNCED_MAX_BLOCKS){
    for(const item of getSyncedGroupSnapshots(db,{groupIds:groupIds.slice(start,start+SYNCED_MAX_BLOCKS)}).items)
      if(item.status==='ready')groups.set(item.snapshot.groupId,item.snapshot)
  }
  const actualInstances=new Map<string,SyncedInlineInstanceAddress>()
  for(const row of db.prepare(syncedInlineInstancesSql).all() as SyncedInlineInstanceSqlRow[]){
    const instance=inlineInstanceFromRow(row)
    if(actualInstances.has(instance.instanceId))return fail('instance has duplicate physical owners')
    actualInstances.set(instance.instanceId,instance)
  }
  const groupPositions=new Map<string,{groupId:string;position:SyncedGroupSnapshot['instances'][number]}>()
  for(const [groupId,group] of groups)for(const position of group.instances){
    if(groupPositions.has(position.instanceId))return fail('instance belongs to multiple actual groups')
    groupPositions.set(position.instanceId,{groupId,position})
  }
  const hosts=new Map<string,SyncedMetadataHostView2>()
  for(const row of db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{id:string}>){
    const host=readCanonicalRuntimeHostDocumentOwned(db,row.id)??fail('actual document disappeared'),instances=new Map<string,SyncedInlineInstanceAddress>()
    for(const leaf of host.content.blocks)if(leaf.type==='synced-block'){
      const groupId=parseSyncedBlockPayload(leaf.content).groupId,actual=actualInstances.get(leaf.id),group=groups.get(groupId)
      const physical=groupPositions.get(leaf.id),position=physical?.position
      if(!actual||!group||!physical||!position||physical.groupId!==groupId||actual.hostDocumentId!==row.id||actual.hostCreatedAt!==host.createdAt||actual.instanceCreatedAt!==host.births.get(leaf.id)
        ||actual.groupId!==groupId||actual.creationId!==group.creationId||actual.groupCreatedAt!==group.createdAt||actual.revision!==group.revision
        ||actual.topologyRevision!==group.topologyRevision||position.hostDocumentId!==row.id||position.bindingVersion!==actual.bindingVersion
        ||position.depth!==leaf.depth||position.parentBlockId!==leaf.parentBlockId)return fail('live host mirror lacks its exact actual group/instance')
      instances.set(leaf.id,actual)
    }
    hosts.set(row.id,{host,instances})
  }
  return{...identity,hosts,groups}
}
export interface SyncedMetadataTitleSelection2 {documentId:string;raw:string;selected:string}
export interface SyncedMetadataNamespace2 extends SyncedMetadataWorkspaceView2 {
  titleSelections:SyncedMetadataTitleSelection2[]
  /** Real Main allocations for the intended side; these are planning data,
   * not assertions that a new registry row/session already exists. */
  allocatedInstanceBindings:Map<string,string>
}
/** Copy-on-write namespace: paths follow actual parent identities. Each raw W
 * remains separately retained; Main naming never substitutes P for raw W.
 * No SQL rows are written here and the entire workspace is not deep-cloned. */
export function projectSyncedMetadataNamespaceOwned2(db:Database.Database,base:SyncedMetadataWorkspaceView2,
  overrides:ReadonlyMap<string,HostContent>,acceptedBirths:ReadonlyMap<string,{documentId:string;createdAt:string}>) : SyncedMetadataNamespace2{
  if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)return fail('actual owned transaction required')
  const current=new BlockIdentityRepository(db).getWorkspaceIdentity()
  if(current.workspaceScope!==base.workspaceScope||current.recoveryEpoch!==base.recoveryEpoch)return fail('workspace generation changed')
  const hosts=new Map(base.hosts),titleSelections:SyncedMetadataTitleSelection2[]=[],allocatedInstanceBindings=new Map<string,string>()
  const compare=db.prepare('SELECT ? = ? COLLATE NOCASE AS same'),occupied=db.prepare('SELECT 1 FROM documents WHERE parent_id IS ? AND title=? COLLATE NOCASE AND id<>? LIMIT 1')
  const reserved:Array<{parentId:string|null;id:string;title:string}>=[]
  for(const [documentId,raw] of overrides){
    const original=base.hosts.get(documentId)??fail('requested host is missing'),named=planStoredDocumentTitle2(db,documentId,raw.title)
    if(named.original.created_at!==original.host.createdAt||named.original.path!==original.host.detail.path||named.original.title!==original.host.content.title
      ||named.original.updated_at!==original.host.detail.updatedAt)return fail('plan does not belong to the actual original host snapshot')
    const mainBase=named.title;let selected=mainBase,index=1
    // The native SQL collation is the naming authority, including Unicode
    // cases where JS lowercase would conflate distinct actual sibling names.
    if(raw.title!==original.host.content.title)while(occupied.get(original.host.parentId,selected,documentId)
      ||reserved.some(item=>item.id!==documentId&&item.parentId===original.host.parentId
        &&(compare.get(item.title,selected) as {same:number}).same===1))selected=mainBase+' '+index++
    reserved.push({id:documentId,parentId:original.host.parentId,title:selected})
    titleSelections.push({documentId,raw:raw.title,selected})
    const content={...raw,title:selected,blocks:validateSyncedHostForest(raw.blocks)},births=new Map<string,string>(),instances=new Map<string,SyncedInlineInstanceAddress>()
    const byId=new Map(content.blocks.map(block=>[block.id,block])),oldById=new Map(original.host.content.blocks.map(block=>[block.id,block]))
    for(const block of content.blocks){
      const birth=acceptedBirths.get(block.id)
      if(!birth||birth.documentId!==documentId)return fail('planned physical row has no accepted Main birth')
      births.set(block.id,birth.createdAt)
      if(block.type==='synced-block'){
        const groupId=parseSyncedBlockPayload(block.content).groupId,group=base.groups.get(groupId)??fail('planned reference group is missing/retired')
        const old=original.instances.get(block.id),oldLeaf=oldById.get(block.id)
        const role=(parent:string|null,forest:ReadonlyMap<string,typeof block>)=>parent===null?null:forest.get(parent)?.type??fail('actual parent missing')
        const unchanged=old&&old.groupId===groupId&&old.hostDocumentId===documentId&&oldLeaf
          &&oldLeaf.parentBlockId===block.parentBlockId&&oldLeaf.depth===block.depth&&role(oldLeaf.parentBlockId,oldById)===role(block.parentBlockId,byId)
        const bindingVersion=unchanged?old.bindingVersion:randomUUID()
        if(!unchanged)allocatedInstanceBindings.set(block.id,bindingVersion)
        instances.set(block.id,{version:1,workspaceScope:base.workspaceScope,recoveryEpoch:base.recoveryEpoch,
          hostDocumentId:documentId,hostCreatedAt:original.host.createdAt,instanceId:block.id,instanceCreatedAt:birth.createdAt,
          bindingVersion,parentBlockId:block.parentBlockId,depth:block.depth,groupId,creationId:group.creationId,groupCreatedAt:group.createdAt,
          revision:group.revision,topologyRevision:group.topologyRevision})
      }
    }
    hosts.set(documentId,{host:{...original.host,content,births,detail:{...original.host.detail,title:selected,summary:content.summary,
      blocks:content.blocks.map((block,sortOrder)=>({...block,sortOrder}))}},instances})
  }
  const children=new Map<string|null,string[]>()
  for(const [id,value] of base.hosts){const siblings=children.get(value.host.parentId)??[];siblings.push(id);children.set(value.host.parentId,siblings)}
  const visited=new Set<string>(),pending=(children.get(null)??[]).map(id=>({id,parentChanged:false}))
  for(let index=0;index<pending.length;index++){
    const {id,parentChanged}=pending[index];if(visited.has(id))return fail('actual document parent cycle');visited.add(id)
    const view=hosts.get(id)!,original=base.hosts.get(id)!,renamed=view.host.content.title!==original.host.content.title
    const changed=parentChanged||renamed
    if(changed){const parent=view.host.parentId===null?null:hosts.get(view.host.parentId)??fail('actual parent missing')
      const path=parent?parent.host.detail.path+'/'+view.host.content.title:view.host.content.title
      hosts.set(id,{...view,host:{...view.host,detail:{...view.host.detail,path}}})}
    for(const child of children.get(id)??[])pending.push({id:child,parentChanged:changed})
  }
  if(visited.size!==hosts.size)return fail('actual document tree has a missing parent/cycle')
  return{...base,hosts,titleSelections,allocatedInstanceBindings}
}
/** The user request is intent only. This producer verifies actual P CAS and
 * original W/A guard/ref closure before making either namespace projection. */
export function planSyncedMetadataNamespacesOwned2(db:Database.Database,value:unknown){
  const request=validateSyncedStructureInput(value);if(request.mode!=='host-final')return fail('explicit metadata2 only accepts host-final intent')
  const input:HostFinalInput=request,base=readSyncedMetadataWorkspaceOwned2(db),repository=new BlockIdentityRepository(db)
  const participants=new Set(input.hostsWorkingBefore.map(item=>item.documentId)),groups=new Set<string>(),refs=new Map<string,{documentId:string;groupId:string}>()
  const before=new Map<string,HostContent>(),requestedAfter=new Map(input.finalAfter.map(({documentId,...content})=>[documentId,content]))
  // The same real participant order reserves W and A names. A caller's DTO
  // array reorder alone cannot manufacture a logical namespace difference.
  const after=new Map(input.hostsWorkingBefore.map(item=>[item.documentId,requestedAfter.get(item.documentId)??fail('A missing')]))
  const births=new Map<string,{documentId:string;createdAt:string}>()
  let timestamp=Date.now()
  for(const item of input.hostsWorkingBefore){const actual=base.hosts.get(item.documentId)??fail('requested host missing');timestamp=Math.max(timestamp,Date.parse(actual.host.detail.updatedAt)+1)}
  const now=new Date(timestamp).toISOString()
  for(const original of input.hostsWorkingBefore){
    const actual=base.hosts.get(original.documentId)??fail('requested host missing')
    if(actual.host.detail.updatedAt!==original.expectedPersistedUpdatedAt)return fail('host CAS changed')
    before.set(original.documentId,original.workingBefore)
    for(const block of actual.host.content.blocks)if(block.type==='synced-block')refs.set(block.id,{documentId:original.documentId,groupId:parseSyncedBlockPayload(block.content).groupId})
    for(const content of [actual.host.content,original.workingBefore,after.get(original.documentId)??fail('A missing')])for(const block of content.blocks){
      if(block.type==='synced-block')groups.add(parseSyncedBlockPayload(block.content).groupId)
      const identity=repository.get(block.id),owner=repository.resolveLiveOwner(block.id)
      if(identity&&(identity.owner.kind!=='document'||identity.owner.id!==original.documentId)||owner&&(owner.kind!=='document'||owner.id!==original.documentId))return fail('cross-owner/retained identity cannot be claimed')
      const previous=births.get(block.id);if(previous&&previous.documentId!==original.documentId)return fail('W/A identity has more than one owner')
      const createdAt=identity?.createdAt??now;if(identity&&identity.createdAt===null)return fail('retained identity has no exact birth')
      births.set(block.id,{documentId:original.documentId,createdAt})
    }
  }
  if(requestedAfter.size!==participants.size||[...requestedAfter.keys()].some(id=>!participants.has(id)))return fail('W/A participants differ')
  if(input.groups.length!==groups.size||input.groups.some(guard=>!groups.has(guard.groupId)||base.groups.get(guard.groupId)?.revision!==guard.expectedRevision
    ||base.groups.get(guard.groupId)?.topologyRevision!==guard.expectedTopologyRevision))return fail('P/W/A group guard closure changed')
  if(input.expectedInstances.length!==refs.size||input.expectedInstances.some(guard=>{const ref=refs.get(guard.instanceId),actual=ref&&base.hosts.get(ref.documentId)!.instances.get(guard.instanceId)
    return !ref||guard.hostDocumentId!==ref.documentId||actual?.bindingVersion!==guard.bindingVersion}))return fail('actual P instance guard closure changed')
  const known=new Map(refs),fresh=new Map<string,{documentId:string;groupId:string}>()
  for(const [documentId,content] of [...before,...after])for(const block of content.blocks)if(block.type==='synced-block'){
    const groupId=parseSyncedBlockPayload(block.content).groupId,old=known.get(block.id)
    if(old&&(old.documentId!==documentId||old.groupId!==groupId))return fail('existing reference cannot silently change owner/group')
    if(!old){if(repository.get(block.id))return fail('fresh reference identity is already retained');fresh.set(block.id,{documentId,groupId});known.set(block.id,{documentId,groupId})}
  }
  for(const content of [...before.values(),...after.values()])for(const block of content.blocks)
    if(block.type!=='synced-block'&&known.has(block.id))return fail('a reference identity cannot be recast as an ordinary block')
  if(input.newRefSources.length!==fresh.size)return fail('fresh reference sources are not exact')
  for(const source of input.newRefSources){
    const target=fresh.get(source.instanceId);if(!target)return fail('extra new reference source')
    const group=base.groups.get(target.groupId)??fail('fresh reference target inactive')
    if(source.kind==='internal'){
      if(source.identity.workspaceScope!==base.workspaceScope||source.identity.groupId!==group.groupId||source.identity.creationId!==group.creationId)return fail('internal reference source generation changed')
    }else{const p=refs.get(source.sourceInstanceId),w=p&&before.get(p.documentId)?.blocks.find(block=>block.id===source.sourceInstanceId)
      if(!p||p.documentId!==source.sourceDocumentId||p.groupId!==target.groupId||w?.type!=='synced-block'||parseSyncedBlockPayload(w.content).groupId!==p.groupId)return fail('working source lacks exact actual P/W instance')}
  }
  const working=projectSyncedMetadataNamespaceOwned2(db,base,before,births),final=projectSyncedMetadataNamespaceOwned2(db,base,after,births)
  const originalHeadings=new Map([...base.hosts].map(([id,view])=>[id,projectSyncedHostHeadings2(view.host,base.groups,view.instances)]))
  const destinations=(namespace:SyncedMetadataNamespace2)=>new Map([...base.hosts].map(([documentId,p])=>{
    const selected=namespace.hosts.get(documentId)!,oldHeadings=originalHeadings.get(documentId)!
    const nextHeadings=selected.host.content===p.host.content&&selected.instances===p.instances?oldHeadings:projectSyncedHostHeadings2(selected.host,namespace.groups,selected.instances)
    return[documentId,{documentId,beforeCreatedAt:p.host.createdAt,afterCreatedAt:selected.host.createdAt,beforePath:p.host.detail.path,
      afterPath:selected.host.detail.path,headings:planSyncedHeadingRewrites2(oldHeadings,nextHeadings)}] as const
  }))
  return{kind:'synced-host-metadata2-native-plan' as const,version:2 as const,request:input,base,working,final,births,now,
    workingDestinations:destinations(working),finalDestinations:destinations(final),rawLogicalChange:[...before].some(([id,content])=>!hostEqual(content,after.get(id))),
    semanticClosureComplete:false as const,writePermit:false as const}
}
