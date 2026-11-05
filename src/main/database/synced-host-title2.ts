import { applySyncedHostHeadingTitle3, restoreSyncedHostHeadingTitle3 } from './synced-heading-title3'
import { readHeadingTitle3OriginalOperationOwned } from './synced-heading-title3-read'
import { HEADING_TITLE3_OPERATION_KIND, headingTitle3JournalKey } from './synced-heading-title3-codec'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { SyncedGroupSnapshot, SyncedGroupWire, SyncedStructureApplied, SyncedStructureInput } from '../../shared/synced-blocks'
import type { SyncedEditingHostResult } from '../../shared/synced-editing-session'
import { validateSyncedStructureInput, validateSyncedRestoreHostInput } from '../../shared/syncedBlockInputs'
import { getSyncedGroupSnapshots, getSyncedHostHistory } from './synced-blocks-read'
import { getSyncedOperation } from './synced-blocks-content'
import { validateSyncedOperationLookupInput } from './synced-group-operation-receipt'
import { applySyncedHostFinal, applySyncedHostCommand, restoreSyncedHostOperation } from './synced-host-final'
import { requireSyncedMetadataEditingFenceOwned2 } from './synced-editing-fence'
import { hostEncode, hostHash, hostEqual, sameHostContent, encodeHostJournal, decodeHostJournal, hostReferencedGroups, type HostFinalInput, type HostJournal } from './synced-host-journal'
import { hostJson, readStrictHostDocument, type HostContent } from './synced-host-document-read'
import { planSyncedMetadataNamespacesOwned2, readSyncedMetadataWorkspaceOwned2, type SyncedMetadataWorkspaceView2 } from './synced-metadata-view2'
import { projectSyncedHostHeadings2, planSyncedHeadingRewrites2 } from './synced-heading-projection2'
import { projectSyncedMetadataStoredGroupLinksOwned2 } from './synced-metadata-group-links2'
import { captureSyncedMetadataReadBaselineOwned2, readSyncedMetadataCaptureRecordOwned2, SYNCED_METADATA_BASELINE2_PREFIX } from './synced-metadata-capture-record2'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { readHistoricalExactRows, readOriginalSqlTextRowsOwned2 } from './synced-history-evidence-support'
import { pruneSyncedHostRedoBranches } from './synced-host-history-branch'
import { MarkdownLinkIndex } from './markdown-link-index'
import { DocumentRecoveryRepository } from './document-recovery'
import { readSyncedRecoveryHostCut } from './synced-recovery-boundary-read'
import { readSyncedExchangeHostCut } from './synced-exchange-host-cut'
import { title2Hash, title2RequestHash, title2CompanionKey, title2JournalKey, title2GroupHeadKey, makeTitle2Companion,
  TITLE2_OPERATION_KIND, type Title2Group, type Title2Companion, type Title2Effect, type Title2Subtree } from './synced-host-title2-codec'
import { readTitle2OriginalOperationOwned, readTitle2JournalOriginalOwned, readTitle2GroupHeadOriginalOwned, type Title2GroupHead, type Title2JournalPointer } from './synced-host-title2-read'

class Title2DomainRefusal extends Error{constructor(message:string){super('Metadata2 title requires-lineage: '+message+'; preserve the complete working draft.');this.name='Title2DomainRefusal'}}
const fail=(message:string):never=>{throw new Title2DomainRefusal(message)}
const wire=(group:SyncedGroupSnapshot):SyncedGroupWire=>({kind:'synced-group',id:group.groupId,creationId:group.creationId,createdAt:group.createdAt,origin:group.origin,blocks:group.blocks,bindings:group.bindings})
const current=(db:Database.Database,id:string)=>readStrictHostDocument(db,id)??fail('actual host missing')
type Plan=ReturnType<typeof planSyncedMetadataNamespacesOwned2>
type GroupPlan={snapshot:SyncedGroupSnapshot;working:ReturnType<typeof projectSyncedMetadataStoredGroupLinksOwned2>;after:ReturnType<typeof projectSyncedMetadataStoredGroupLinksOwned2>;
  workingRevision:string;afterRevision:string}
type Projection={host:ReturnType<typeof current>;effects:Title2Effect[]}
type ApplyContext={plan:Plan;hostId:string;groups:GroupPlan[];subtree:Title2Subtree[];now:string}
class ProjectionEnd extends Error{constructor(readonly value:Projection){super('metadata2 projection rollback')}}
function own<T>(db:Database.Database,run:()=>T):T|{status:'unsupported';reason:string}{
  if(db.inTransaction)throw new Error('Metadata2 title writer requires its actual outer IMMEDIATE transaction.')
  if(db.pragma('foreign_keys',{simple:true})!==1||db.pragma('main.user_version',{simple:true})!==27)throw new Error('Metadata2 title writer requires actual schema27/FKON.')
  let refusal:Title2DomainRefusal|undefined
  try{return db.transaction(()=>{
    requireSyncedMetadataEditingFenceOwned2(db)
    try{return run()}catch(error){if(error instanceof Title2DomainRefusal)refusal=error;throw error}
  }).immediate()}catch(error){
    // better-sqlite3 rethrows the callback error only after its own rollback
    // succeeds. Rollback/commit/SQL failures cannot equal this local sentinel.
    if(refusal&&error===refusal&&db.open&&!db.inTransaction)return{status:'unsupported',reason:refusal.message}
    throw error
  }
}
function sameForestAndSummary(left:HostContent,right:HostContent):boolean{return left.summary===right.summary&&hostEqual(left.blocks,right.blocks)}
// Storage has one physical empty-tag spelling. Keep raw W/A and ACK hashes exact.
function samePhysicalForestAndSummary(left:HostContent,right:HostContent):boolean{
  return sameHostContent({...left,title:''},{...right,title:''})
}
function samePhysicalAttributes(left:HostContent,right:HostContent):boolean{
  const attributes=(host:HostContent):HostContent=>({...host,blocks:host.blocks.map(block=>({...block,content:''}))})
  return samePhysicalForestAndSummary(attributes(left),attributes(right))
}
function subtreeFacts(base:SyncedMetadataWorkspaceView2,rootId:string):Title2Subtree[]{
  const result:Title2Subtree[]=[],queue=[rootId],seen=new Set<string>()
  for(let i=0;i<queue.length;i++){
    const id=queue[i],host=base.hosts.get(id)?.host??fail('subtree owner missing')
    if(seen.has(id))return fail('subtree parent cycle');seen.add(id)
    result.push({id,createdAt:host.createdAt,parentId:host.parentId,title:host.content.title,path:host.detail.path,sortOrder:host.sortOrder})
    for(const [child,value]of base.hosts)if(value.host.parentId===id)queue.push(child)
  }
  return result.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
}
function groupPlans(db:Database.Database,plan:Plan):GroupPlan[]{
  const selected:GroupPlan[]=[]
  for(const snapshot of plan.base.groups.values()){
    const value=wire(snapshot),working=projectSyncedMetadataStoredGroupLinksOwned2(db,value,plan.workingDestinations),after=projectSyncedMetadataStoredGroupLinksOwned2(db,value,plan.finalDestinations)
    if(!working.changed&&!after.changed)continue
    const edits=[...working.edits,...after.edits]
    for(const edit of edits){const binding=snapshot.bindings.find(binding=>hostEqual({blockId:binding.blockId,from:binding.from,to:binding.to,raw:binding.raw,syntax:binding.syntax},edit.key))
      if(!binding||binding.target.kind!=='document'&&binding.target.kind!=='block'||binding.target.state!=='live')return fail('a missing/unresolved historical target cannot be activated by a new path')}
    for(const binding of snapshot.bindings)if(binding.target.kind==='heading'){
      const w=plan.workingDestinations.get(binding.target.documentId),a=plan.finalDestinations.get(binding.target.documentId)
      if(w&&(w.beforePath!==w.afterPath||w.headings.size)||a&&(a.beforePath!==a.afterPath||a.headings.size))return fail('a canonical heading target lacks its original continuous birth/Key evidence')
    }
    if([...working.edits,...after.edits].some(edit=>/^heading-[1-6]$/.test(snapshot.blocks.find(block=>block.id===edit.blockId)?.type??'')))return fail('canonical heading label maintenance needs full heading lineage')
    if(snapshot.history.undoToken!==null||snapshot.history.redoToken!==null
      ||db.prepare('SELECT 1 FROM synced_group_history WHERE group_id=? LIMIT 1').get(snapshot.groupId))return fail('canonical user-history effective-tail adapter is not yet closed')
    const life=readSyncedGroupLifecycles(db,[snapshot.groupId]).get(snapshot.groupId)
    if(!life||life.state!=='active'||life.exposure==='never')return fail('unpublished create activation needs its own metadata-continuity adapter')
    const head=readTitle2GroupHeadOriginalOwned(db,snapshot.groupId)
    if(head&&(head.head.creationId!==snapshot.creationId||head.head.groupCreatedAt!==snapshot.createdAt||head.head.revision!==snapshot.revision
      ||head.head.topologyRevision!==snapshot.topologyRevision||head.head.historyCursor!==snapshot.history.cursor||head.head.wireHash!==hostHash(value)))return fail('later group edits changed the real last metadata tail')
    selected.push({snapshot,working,after,workingRevision:working.changed?randomUUID():snapshot.revision,afterRevision:after.changed?randomUUID():snapshot.revision})
  }
  return selected
}
function prepare(db:Database.Database,input:HostFinalInput):ApplyContext{
  const plan=planSyncedMetadataNamespacesOwned2(db,input)
  if(input.hostsWorkingBefore.length!==1||input.finalAfter.length!==1||input.newRefSources.length)return fail('this first business domain requires one existing unchanged physical forest')
  const hostId=input.hostsWorkingBefore[0].documentId,original=plan.base.hosts.get(hostId)?.host??fail('host missing')
  const before=input.hostsWorkingBefore[0].workingBefore,after=input.finalAfter[0]
  if(!sameForestAndSummary(before,after)||!samePhysicalAttributes(original.content,before))return fail('body/summary/structure edits need the complete metadata writer')
  if(plan.working.hosts.get(hostId)!.host.content.title!==before.title||plan.final.hosts.get(hostId)!.host.content.title!==after.title)return fail('Main naming selection differs from the submitted raw title')
  // Every heading-dependent binding is checked, even when the projector kept
  // the same literal URI. A same-caption/current-slug lookup is not lineage.
  for(const group of plan.base.groups.values())for(const binding of group.bindings)if(binding.target.kind==='heading'){
    const w=plan.workingDestinations.get(binding.target.documentId),a=plan.finalDestinations.get(binding.target.documentId)
    if(w&&(w.beforePath!==w.afterPath||w.headings.size)||a&&(a.beforePath!==a.afterPath||a.headings.size))return fail('heading-dependent title change lacks continuous target birth')
  }
  const groups=groupPlans(db,plan),subtree=subtreeFacts(plan.base,hostId)
  const ancestors=new Set<string>();let ancestor:string|null=hostId
  while(ancestor!==null){
    if(ancestors.has(ancestor))return fail('actual ancestor cycle');ancestors.add(ancestor)
    const value:ReturnType<typeof current>=plan.base.hosts.get(ancestor)?.host??fail('actual ancestor missing'),parent=value.parentId===null?null:plan.base.hosts.get(value.parentId)?.host
    if(value.detail.path!==(parent?parent.detail.path+'/'+value.content.title:value.content.title))return fail('legacy ancestor path drift needs its original-path adapter')
    ancestor=value.parentId
  }
  for(const item of subtree){const parent=item.parentId===null?null:plan.base.hosts.get(item.parentId)?.host
    const expected=parent?parent.detail.path+'/'+item.title:item.title
    if(item.path!==expected)return fail('legacy drifted paths need an exact original-path restore adapter')}
  for(const id of new Set([...ancestors,...subtree.map(item=>item.id)]))readOriginalSqlTextRowsOwned2(db,'documents',['id','title','path','summary','created_at','updated_at','parent_id'],'id=?',[id])
  readOriginalSqlTextRowsOwned2(db,'blocks',['id','document_id','parent_block_id','type','content','tags_json','language','markdown_format_json','highlight','created_at'],'document_id=?',[hostId])
  for(const id of new Set([...input.groups.map(item=>item.groupId),...groups.map(item=>item.snapshot.groupId)])){
    readOriginalSqlTextRowsOwned2(db,'synced_groups',['id','creation_id','created_at','origin_json','bindings_json','revision','topology_revision','history_cursor'],'id=?',[id])
    readOriginalSqlTextRowsOwned2(db,'synced_group_blocks',['id','group_id','parent_block_id','type','content','tags_json','language','markdown_format_json','highlight','created_at'],'group_id=?',[id])
  }
  const now=new Date(Math.max(Date.now(),...[...plan.base.hosts.values()].map(value=>Date.parse(value.host.detail.updatedAt)+1))).toISOString()
  return{plan,hostId,groups,subtree,now}
}
function resyncOrdinaryLinks(db:Database.Database,now:string):void{
  const index=new MarkdownLinkIndex(db);index.rebuild()
  db.prepare('DELETE FROM links').run()
  const rows=db.prepare(`SELECT DISTINCT source.source_document_id,target.id AS target_id,source.url
    FROM markdown_link_sources source JOIN documents target ON target.path=source.target_path
    WHERE source.kind IN ('wiki','wiki-heading') OR target.id<>source.source_document_id`).all() as Array<{source_document_id:string;target_id:string;url:string}>
  const insert=db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)')
  for(const row of rows)insert.run(randomUUID(),row.source_document_id,row.target_id,row.url,now)
  const bad=db.prepare(`SELECT 1 FROM documents d
    WHERE d.link_count<>(SELECT count(*) FROM links l WHERE l.source_document_id=d.id) LIMIT 1`).get()
  if(bad)throw new Error('Metadata2 ordinary link-count readback differs from the real SQL relation.')
}
function writeGroups(db:Database.Database,ctx:ApplyContext,side:'working'|'after'):void{
  for(const item of ctx.groups){const projected=side==='working'?item.working:item.after;if(!projected.changed)continue
    const old=item.snapshot,raw=readHistoricalExactRows<{bindings_json:string}>(db,'synced_groups',['bindings_json'],'id=?',[old.groupId])[0]
    if(!raw)return fail('actual group row disappeared')
    for(let i=0;i<old.blocks.length;i++)if(old.blocks[i].content!==projected.after.blocks[i].content){
      const before=old.blocks[i],after=projected.after.blocks[i]
      if(db.prepare('UPDATE synced_group_blocks SET content=? WHERE id=? AND group_id=? AND created_at=? AND content=?')
        .run(after.content,before.id,old.groupId,before.createdAt,before.content).changes!==1)return fail('canonical original content/CAS changed')
    }
    const revision=side==='working'?item.workingRevision:item.afterRevision
    if(db.prepare('UPDATE synced_groups SET bindings_json=?,revision=? WHERE id=? AND creation_id=? AND revision=? AND topology_revision=? AND history_cursor=? AND history_position=0 AND bindings_json=?')
      .run(hostEncode(projected.after.bindings),revision,old.groupId,old.creationId,old.revision,old.topologyRevision,old.history.cursor,raw.bindings_json).changes!==1)return fail('canonical actual revision/topology/history changed')
  }
}
/** The production Main maintenance implementation is executed in this owned
 * transaction. Projection calls use a rollback savepoint; they publish no
 * owner/ticket/checkpoint/event and are explicitly labeled projections. */
function applyPhysical(db:Database.Database,ctx:ApplyContext,side:'working'|'after',checkpoint:boolean):Projection{
  const namespace=side==='working'?ctx.plan.working:ctx.plan.final,destinations=side==='working'?ctx.plan.workingDestinations:ctx.plan.finalDestinations
  const original=ctx.plan.base.hosts.get(ctx.hostId)!.host,target=namespace.hosts.get(ctx.hostId)!.host
  const paths=[...destinations.values()].filter(item=>item.beforePath!==item.afterPath)
  const index=new MarkdownLinkIndex(db,checkpoint?id=>new DocumentRecoveryRepository(db).checkpoint(id):undefined)
  // Rebuild the actual original ordinary parser relation before any path moves;
  // Main's existing maintainer then consumes those real pre-move bindings.
  index.rebuild()
  if(checkpoint)new DocumentRecoveryRepository(db).checkpoint(ctx.hostId)
  const route=db.prepare('INSERT OR IGNORE INTO document_block_routes(document_path,block_id) SELECT ?,id FROM blocks WHERE document_id=?')
  for(const path of paths)route.run(path.beforePath,path.documentId)
  writeGroups(db,ctx,side)
  if(db.prepare('UPDATE documents SET title=?,path=?,updated_at=? WHERE id=? AND created_at=? AND updated_at=?')
    .run(target.content.title,target.detail.path,ctx.now,ctx.hostId,original.createdAt,original.detail.updatedAt).changes!==1)return fail('host actual CAS changed')
  for(const path of paths)if(path.documentId!==ctx.hostId){
    const child=ctx.plan.base.hosts.get(path.documentId)!.host
    if(db.prepare('UPDATE documents SET path=? WHERE id=? AND created_at=? AND parent_id IS ? AND path=?').run(path.afterPath,path.documentId,child.createdAt,child.parentId,path.beforePath).changes!==1)return fail('descendant lineage/path changed')
  }
  const changes=[...destinations.values()].filter(item=>item.beforePath!==item.afterPath||item.headings.size).map(item=>({id:item.documentId,before:item.beforePath,after:item.afterPath,headings:item.headings}))
  const indexed=new Set<string>(),changed=index.maintain(changes,[],ctx.now,undefined,indexed)
  resyncOrdinaryLinks(db,ctx.now)
  const after=readSyncedMetadataWorkspaceOwned2(db)
  // Ordinary Wiki maintenance can alter a heading label and cascade. It must
  // not silently activate a canonical heading binding in that new namespace.
  for(const [id,old]of ctx.plan.base.hosts){const next=after.hosts.get(id)!
    if(old.host.content===next.host.content)continue
    const headings=planSyncedHeadingRewrites2(projectSyncedHostHeadings2(old.host,ctx.plan.base.groups,old.instances),projectSyncedHostHeadings2(next.host,after.groups,next.instances))
    if(headings.size)for(const group of ctx.plan.base.groups.values())if(group.bindings.some(binding=>binding.target.kind==='heading'&&binding.target.documentId===id))return fail('ordinary maintenance changed a canonical heading namespace without lineage')
  }
  const ids=new Set([ctx.hostId,...paths.map(item=>item.documentId),...changed]),effects:Title2Effect[]=[...ids].sort().map(id=>{const item=after.hosts.get(id)?.host??fail('maintenance result host missing')
    return{documentId:id,createdAt:item.createdAt,path:item.detail.path,contentHash:hostHash(item.content)}})
  return{host:after.hosts.get(ctx.hostId)!.host,effects}
}
function observe(db:Database.Database,ctx:ApplyContext,side:'working'|'after'):Projection{
  try{db.transaction(()=>{const value=applyPhysical(db,ctx,side,false);throw new ProjectionEnd(value)})()}
  catch(error){if(error instanceof ProjectionEnd)return error.value;throw error}
  throw new Error('Metadata2 projection did not roll back its own savepoint.')
}
function ensureHostState(db:Database.Database,id:string):void{
  db.prepare('INSERT OR IGNORE INTO synced_host_history_state(document_id,cursor,position) VALUES(?,?,0)').run(id,randomUUID());getSyncedHostHistory(db,{documentId:id})
}
function appendJournal(db:Database.Database,ctx:ApplyContext,token:string):void{
  const input=ctx.plan.request,host=ctx.plan.base.hosts.get(ctx.hostId)!.host,before=input.hostsWorkingBefore[0].workingBefore,after=input.finalAfter[0]
  const ids=hostReferencedGroups([{documentId:ctx.hostId,content:before},{documentId:ctx.hostId,content:after}])
  const groups=[...ids].map(id=>{const group=ctx.plan.base.groups.get(id)!;return{groupId:id,creationId:group.creationId,createdAt:group.createdAt,origin:group.origin}})
  const journal:HostJournal={input,persisted:[{documentId:ctx.hostId,content:host.content,updatedAt:host.detail.updatedAt}],births:[...host.births].map(([blockId,createdAt])=>({documentId:ctx.hostId,blockId,createdAt})),groups,
    before:[{documentId:ctx.hostId,content:before}],after:[{documentId:ctx.hostId,content:{title:after.title,summary:after.summary,blocks:after.blocks}}]}
  const encoded=encodeHostJournal(journal),row={id:token,action_json:encoded.action,before_json:encoded.before,after_json:encoded.after,before_hash:encoded.beforeHash,after_hash:encoded.afterHash,created_at:ctx.now}
  decodeHostJournal(row)
  db.prepare('INSERT INTO synced_host_history(id,action_json,before_json,after_json,before_hash,after_hash,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(token,row.action_json,row.before_json,row.after_json,row.before_hash,row.after_hash,row.created_at)
  const state=db.prepare('SELECT cursor,position FROM synced_host_history_state WHERE document_id=?').get(ctx.hostId) as {cursor:string;position:number}
  if(!Number.isSafeInteger(state.position+1))return fail('host execution position exhausted')
  db.prepare('INSERT INTO synced_host_history_documents(history_id,document_id,position) VALUES(?,?,?)').run(token,ctx.hostId,state.position+1)
  if(db.prepare('UPDATE synced_host_history_state SET cursor=?,position=? WHERE document_id=? AND cursor=? AND position=?').run(randomUUID(),state.position+1,ctx.hostId,state.cursor,state.position).changes!==1)return fail('host execution cursor changed')
  for(const group of groups)db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(group.groupId,'host-history',token,ctx.now)
}
function saveSetting(db:Database.Database,key:string,value:unknown,at:string,replace=false):void{
  const sql=replace?'INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at':'INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)'
  db.prepare(sql).run(key,hostEncode(value),at)
}
function groupRecords(db:Database.Database,ctx:ApplyContext):Title2Group[]{
  return ctx.groups.map(item=>{const owner=captureSyncedMetadataReadBaselineOwned2(db,item.snapshot.groupId),point=readSyncedMetadataCaptureRecordOwned2(db,owner)
    if(point.kind!=='synced-metadata2-read-baseline-record'||typeof point.pointHash!=='string'||point.sources[0].revision!==item.snapshot.revision||!hostEqual(point.sources[0].wire,wire(item.snapshot)))return fail('current original source point differs before business mutation')
    return{groupId:item.snapshot.groupId,creationId:item.snapshot.creationId,createdAt:item.snapshot.createdAt,sourcePointKey:SYNCED_METADATA_BASELINE2_PREFIX+point.pointHash,sourcePointHash:point.recordHash,
      sourceRevision:item.snapshot.revision,sourceTopologyRevision:item.snapshot.topologyRevision,sourceHistoryCursor:item.snapshot.history.cursor,
      workingEdits:item.working.edits,afterEdits:item.after.edits,workingHash:hostHash(item.working.after),afterHash:hostHash(item.after.after),afterRevision:item.afterRevision}
  })
}
function finish(db:Database.Database,ctx:ApplyContext,requestHash:string,token:string|null,working:Projection,after:Projection,groups:Title2Group[],
  intent:Title2Companion['intent'],initial:Title2Companion['initialCompanion'],rawBefore:HostContent):SyncedStructureApplied{
  const input=ctx.plan.request,operationId=intent.kind==='apply'?input.clientOperationId:intent.input.clientOperationId
  const required=new Set([...input.groups.map(item=>item.groupId),...groups.map(item=>item.groupId)])
  const snapshots=getSyncedGroupSnapshots(db,{groupIds:[...required]}).items.map(item=>item.status==='ready'?item.snapshot:fail('actual final reference group disappeared'))
  const rawLogicalChange=intent.kind==='apply'?input.hostsWorkingBefore[0].workingBefore.title!==input.finalAfter[0].title:true
  const result:SyncedStructureApplied={status:'applied',operationId,historyToken:token,replayed:false,hosts:[{documentId:ctx.hostId,logicalBefore:rawBefore,logicalBeforeHash:hostHash(rawBefore),after:current(db,ctx.hostId).detail}],groups:snapshots,affectedInstanceIds:[],blockIdMap:[]}
  const original=ctx.plan.base.hosts.get(ctx.hostId)!.host,companion=makeTitle2Companion({kind:'synced-host-title-metadata2-companion',version:2,operationId,
    workspaceScope:ctx.plan.base.workspaceScope,recoveryEpoch:ctx.plan.base.recoveryEpoch,createdAt:ctx.now,scope:'pure-title-existing-forest-no-heading-lineage-no-group-user-history',intent,requestHash,
    hostId:ctx.hostId,hostCreatedAt:original.createdAt,hostParentId:original.parentId,subtree:ctx.subtree,historyToken:token,initialCompanion:initial,rawLogicalChange,
    persistedTitle:original.content.title,persistedPath:original.detail.path,workingPath:working.host.detail.path,afterPath:after.host.detail.path,workingContentHash:hostHash(working.host.content),afterContentHash:hostHash(after.host.content),
    workingEffects:working.effects,afterEffects:after.effects,groups,projection:'owned-sql-savepoint-main-maintenance',businessOperationCommitted:true,writePermit:false})
  saveSetting(db,title2CompanionKey(operationId),companion,ctx.now)
  if(intent.kind==='apply'&&token){
    const row=readHistoricalExactRows<Record<string,string>>(db,'synced_host_history',['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],'id=?',[token])[0]
    const pointer:Title2JournalPointer={kind:'synced-host-title-metadata2-journal',version:2,historyToken:token,initialOperationId:operationId,companionHash:companion.companionHash,journalHash:title2Hash({journal:row})}
    saveSetting(db,title2JournalKey(token),pointer,ctx.now)
  }
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)').run(operationId,requestHash,
    hostEncode({kind:TITLE2_OPERATION_KIND,version:2,companionKey:title2CompanionKey(operationId),companionHash:companion.companionHash,result}),ctx.now)
  for(const group of groups){const head:Title2GroupHead={kind:'synced-host-title-metadata2-group-head',version:2,groupId:group.groupId,creationId:group.creationId,groupCreatedAt:group.createdAt,
    operationId,companionHash:companion.companionHash,revision:group.afterRevision,topologyRevision:group.sourceTopologyRevision,wireHash:group.afterHash,historyCursor:group.sourceHistoryCursor,historyPosition:0}
    saveSetting(db,title2GroupHeadKey(group.groupId),head,ctx.now,true)}
  const readback=readTitle2OriginalOperationOwned(db,operationId)
  if(!readback||!hostEqual(readback.envelope.result,result))throw new Error('Metadata2 title original ACK did not independently read back.')
  return readback.envelope.result
}
export function applySyncedHostTitleMetadata2(db:Database.Database,value:unknown):SyncedEditingHostResult{
  const parsed=validateSyncedStructureInput(value);if(parsed.mode!=='host-final')return fail('explicit title mode required')
  const request:HostFinalInput=parsed
  return own(db,()=>{
    const hash=title2RequestHash('apply',request),previous=readTitle2OriginalOperationOwned(db,request.clientOperationId)
    if(previous){if(previous.row.request_hash!==hash)throw new Error('Metadata2 title idempotency-mismatch');return{...previous.envelope.result,replayed:true}}
    if(db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(request.clientOperationId))throw new Error('Metadata2 title idempotency namespace mismatch')
    const ctx=prepare(db,request),working=observe(db,ctx,'working')
    const rawWorking=request.hostsWorkingBefore[0].workingBefore,persisted=ctx.plan.base.hosts.get(ctx.hostId)!.host.content
    if(!samePhysicalForestAndSummary(rawWorking,persisted)&&!samePhysicalForestAndSummary(rawWorking,working.host.content))return fail('raw W has body changes beyond the separately proved Main P→W navigation projection')
    const projectedAfter=observe(db,ctx,'after'),groups=groupRecords(db,ctx)
    ensureHostState(db,ctx.hostId);pruneSyncedHostRedoBranches(db,[ctx.hostId],row=>decodeHostJournal(row).before.map(side=>side.documentId))
    const after=applyPhysical(db,ctx,'after',true)
    if(!hostEqual(after.effects,projectedAfter.effects)||!hostEqual(after.host.content,projectedAfter.host.content)||after.host.detail.path!==projectedAfter.host.detail.path)throw new Error('Metadata2 actual final SQL differs from its separately observed P→A projection')
    const logical=request.hostsWorkingBefore[0].workingBefore.title!==request.finalAfter[0].title,token=logical?randomUUID():null
    if(token)appendJournal(db,ctx,token)
    const side=request.hostsWorkingBefore[0]
    return finish(db,ctx,hash,token,working,after,groups,{kind:'apply',reason:request.reason,hostId:ctx.hostId,expectedPersistedUpdatedAt:side.expectedPersistedUpdatedAt,
      workingTitle:side.workingBefore.title,afterTitle:request.finalAfter[0].title,groups:request.groups,expectedInstances:request.expectedInstances},null,side.workingBefore)
  })
}
export function restoreSyncedHostTitleMetadata2(db:Database.Database,value:unknown):SyncedEditingHostResult{
  const input=validateSyncedRestoreHostInput(value)
  return own(db,()=>{
    const hash=title2RequestHash('restore',input),previous=readTitle2OriginalOperationOwned(db,input.clientOperationId)
    if(previous){if(previous.row.request_hash!==hash)throw new Error('Metadata2 title idempotency-mismatch');return{...previous.envelope.result,replayed:true}}
    if(db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId))throw new Error('Metadata2 title idempotency namespace mismatch')
    const original=readTitle2JournalOriginalOwned(db,input.historyToken);if(!original)return fail('actual metadata2 journal missing')
    if(readSyncedRecoveryHostCut(db,input.historyToken)||readSyncedExchangeHostCut(db,input.historyToken))return fail('an actual external boundary retired this executable host history')
    const saved=original.initial.companion;if(saved.intent.kind!=='apply')return fail('initial title action missing')
    const boundary=db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as {workspace_scope:string;recovery_epoch:string}
    if(boundary.workspace_scope!==saved.workspaceScope||boundary.recovery_epoch!==saved.recoveryEpoch)return fail('the original action belongs to another recovery boundary')
    if(input.expectedHosts.length!==1||input.expectedHosts[0].documentId!==saved.hostId)return fail('inverse host closure differs')
    const before=current(db,saved.hostId),undo=input.direction==='undo',state=getSyncedHostHistory(db,{documentId:saved.hostId})
    if(before.createdAt!==saved.hostCreatedAt||before.parentId!==saved.hostParentId||before.detail.updatedAt!==input.expectedHosts[0].expectedUpdatedAt
      ||(undo?state.undoToken:state.redoToken)!==input.historyToken)return fail('actual host birth/CAS/execution tail changed')
    if(hostHash(before.content)!==(undo?saved.afterContentHash:saved.workingContentHash))return fail('later host edits changed the original effective from-side')
    const journalRow=original.initial.journal;if(!journalRow)return fail('actual original title journal disappeared')
    const journal=decodeHostJournal(journalRow)
    // Raw W/A reference dependencies include groups whose URI did not change;
    // neither companion.groups nor the later projection's ctx.groups is enough.
    const dependencies=new Map(getSyncedGroupSnapshots(db,{groupIds:journal.groups.map(group=>group.groupId)}).items
      .flatMap(item=>item.status==='ready'?[[item.snapshot.groupId,item.snapshot] as const]:[]))
    for(const dependency of journal.groups){const actual=dependencies.get(dependency.groupId)
      if(!actual||actual.creationId!==dependency.creationId||actual.createdAt!==dependency.createdAt||!hostEqual(actual.origin,dependency.origin))
        return fail('an original journal reference incarnation changed')
    }
    // readTitle2JournalOriginalOwned already checked every exact original pin
    // in this same owned transaction, before any observe/capture can mutate.
    const desired=undo?saved.intent.workingTitle:saved.intent.afterTitle
    const synthetic:HostFinalInput={clientOperationId:input.clientOperationId,mode:'host-final',reason:'source-apply',hostsWorkingBefore:[{documentId:saved.hostId,
      expectedPersistedUpdatedAt:before.detail.updatedAt,workingBefore:before.content}],finalAfter:[{documentId:saved.hostId,...before.content,title:desired}],groups:input.groups,expectedInstances:input.expectedInstances,newRefSources:[]}
    // This is a new inverse intention derived from the actual journal and
    // current owned P, not a caller DTO posing as a historical capture.
    const ctx=prepare(db,synthetic)
    if(!hostEqual(ctx.subtree.map(({path:_path,...item})=>({...item,title:item.id===saved.hostId?'':item.title})),saved.subtree.map(({path:_path,...item})=>({...item,title:item.id===saved.hostId?'':item.title}))))return fail('descendant birth/parent/title topology changed')
    const working=observe(db,ctx,'working'),projectedAfter=observe(db,ctx,'after'),groups=groupRecords(db,ctx)
    if(hostHash(projectedAfter.host.content)!==(undo?saved.workingContentHash:saved.afterContentHash))return fail('inverse Main projection differs from the original effective target')
    const after=applyPhysical(db,ctx,'after',true)
    if(!hostEqual(after.effects,projectedAfter.effects)||!hostEqual(after.host.content,projectedAfter.host.content))throw new Error('Metadata2 inverse actual SQL differs from its projected target')
    const mapping=db.prepare('SELECT position FROM synced_host_history_documents WHERE history_id=? AND document_id=?').get(input.historyToken,saved.hostId) as {position:number}|undefined
    const currentState=db.prepare('SELECT cursor,position FROM synced_host_history_state WHERE document_id=?').get(saved.hostId) as {cursor:string;position:number}
    if(!mapping||mapping.position!==currentState.position+(undo?0:1)||db.prepare('UPDATE synced_host_history_state SET cursor=?,position=? WHERE document_id=? AND cursor=? AND position=?')
      .run(randomUUID(),currentState.position+(undo?-1:1),saved.hostId,currentState.cursor,currentState.position).changes!==1)return fail('actual inverse execution mapping changed')
    getSyncedHostHistory(db,{documentId:saved.hostId})
    return finish(db,ctx,hash,input.historyToken,working,after,groups,{kind:'restore',input},
      {key:title2CompanionKey(original.pointer.initialOperationId),hash:saved.companionHash},before.content)
  })
}
/** Read-only implementation selection. This supplies no write permit or
 * cached proof. The selected writer rechecks the complete current workspace,
 * session/birth/CAS and both incoming Key closures in ITS own IMMEDIATE. */
function routeHeadingTitle3Apply(db:Database.Database,input:SyncedStructureInput):boolean{
  return db.transaction(()=>{
    const old=db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as {result_json:string}|undefined
    if(old){const packet=hostJson(old.result_json);return Boolean(packet&&typeof packet==='object'&&'kind'in packet&&packet.kind===HEADING_TITLE3_OPERATION_KIND)}
    if(input.mode!=='host-final')return false
    const affected=new Set<string>()
    for(const side of input.hostsWorkingBefore){
      const actual=db.prepare('SELECT title,updated_at FROM documents WHERE id=?').get(side.documentId) as {title:string;updated_at:string}|undefined
      if(actual&&actual.updated_at===side.expectedPersistedUpdatedAt&&(actual.title!==side.workingBefore.title
        ||input.finalAfter.find(after=>after.documentId===side.documentId)?.title!==actual.title))affected.add(side.documentId)
    }
    if(!affected.size)return false
    const children=new Map<string,string[]>()
    for(const row of db.prepare('SELECT id,parent_id FROM documents').all() as Array<{id:string;parent_id:string|null}>){
      if(row.parent_id!==null){const list=children.get(row.parent_id)??[];list.push(row.id);children.set(row.parent_id,list)}
    }
    const queue=[...affected]
    for(let index=0;index<queue.length;index++)for(const id of children.get(queue[index])??[])if(!affected.has(id)){affected.add(id);queue.push(id)}
    for(const row of db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{id:string}>){
      const item=getSyncedGroupSnapshots(db,{groupIds:[row.id]}).items[0]
      if(item?.status==='ready'&&item.snapshot.bindings.some(binding=>binding.target.kind==='heading'&&affected.has(binding.target.documentId)))return true
    }
    return false
  })()
}
function routeHeadingTitle3Restore(db:Database.Database,input:ReturnType<typeof validateSyncedRestoreHostInput>):boolean{
  return db.transaction(()=>{
    const old=db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as {result_json:string}|undefined
    if(old){const packet=hostJson(old.result_json);return Boolean(packet&&typeof packet==='object'&&'kind'in packet&&packet.kind===HEADING_TITLE3_OPERATION_KIND)}
    return Boolean(db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(headingTitle3JournalKey(input.historyToken)))
  })()
}

/** Routing reads select an implementation only. Every authority/CAS/nonce is
 * rechecked inside the selected original writer's own outer transaction. */
export function applySyncedHostStructureWithTitle2(db:Database.Database,value:unknown){
  let input:SyncedStructureInput
  try{input=validateSyncedStructureInput(value)}catch{
    return value&&typeof value==='object'&&'mode'in value&&value.mode==='command'?applySyncedHostCommand(db,value):applySyncedHostFinal(db,value)
  }
  if(routeHeadingTitle3Apply(db,input))return applySyncedHostHeadingTitle3(db,input)
  const selected=db.transaction(()=>{
    const row=db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as {result_json:string}|undefined
    if(row){const packet=hostJson(row.result_json);return Boolean(packet&&typeof packet==='object'&&'kind'in packet&&packet.kind===TITLE2_OPERATION_KIND)}
    if(input.mode!=='host-final')return false
    return input.hostsWorkingBefore.some(item=>{const row=db.prepare('SELECT title,updated_at FROM documents WHERE id=?').get(item.documentId) as {title:string;updated_at:string}|undefined
      if(!row||row.updated_at!==item.expectedPersistedUpdatedAt)return false
      return row.title!==item.workingBefore.title||input.mode==='host-final'&&input.finalAfter.find(after=>after.documentId===item.documentId)?.title!==row.title})
  })()
  return selected?applySyncedHostTitleMetadata2(db,input):input.mode==='command'?applySyncedHostCommand(db,input):applySyncedHostFinal(db,input)
}
export function restoreSyncedHostStructureWithTitle2(db:Database.Database,value:unknown){
  let input:ReturnType<typeof validateSyncedRestoreHostInput>
  try{input=validateSyncedRestoreHostInput(value)}catch{return restoreSyncedHostOperation(db,value)}
  if(routeHeadingTitle3Restore(db,input))return restoreSyncedHostHeadingTitle3(db,input)
  const selected=db.transaction(()=>{
    const row=db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as {result_json:string}|undefined
    if(row){const packet=hostJson(row.result_json);return Boolean(packet&&typeof packet==='object'&&'kind'in packet&&packet.kind===TITLE2_OPERATION_KIND)}
    return Boolean(db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(title2JournalKey(input.historyToken)))
  })()
  return selected?restoreSyncedHostTitleMetadata2(db,input):restoreSyncedHostOperation(db,input)
}
export function getSyncedOperationWithTitle2(db:Database.Database,value:unknown){
  const id=validateSyncedOperationLookupInput(value)
  const original=db.transaction(()=>{requireSyncedMetadataEditingFenceOwned2(db);return readHeadingTitle3OriginalOperationOwned(db,id)??readTitle2OriginalOperationOwned(db,id)})()
  return original?{status:'committed' as const,result:{...original.envelope.result,replayed:true}}:getSyncedOperation(db,value)
}
