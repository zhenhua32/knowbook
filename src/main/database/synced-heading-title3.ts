// Owned heading-title v3 writer with independent continuity evidence.
// The existing v2 document/block writer and codec keep their closed domain.
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { SyncedGroupSnapshot, SyncedGroupWire, SyncedStructureApplied } from '../../shared/synced-blocks'
import type { SyncedEditingHostResult } from '../../shared/synced-editing-session'
import { validateSyncedStructureInput, validateSyncedRestoreHostInput } from '../../shared/syncedBlockInputs'
import { getSyncedGroupSnapshots, getSyncedHostHistory } from './synced-blocks-read'
import { requireSyncedMetadataEditingFenceOwned2 } from './synced-editing-fence'
import { hostEncode, hostHash, hostEqual, sameHostContent, encodeHostJournal, decodeHostJournal, hostReferencedGroups, type HostFinalInput, type HostJournal } from './synced-host-journal'
import { hostJson, readStrictHostDocument, type HostContent } from './synced-host-document-read'
import { planSyncedMetadataNamespacesOwned2, readSyncedMetadataWorkspaceOwned2, type SyncedMetadataWorkspaceView2 } from './synced-metadata-view2'
import { projectSyncedHostHeadings2, planSyncedHeadingRewrites2 } from './synced-heading-projection2'
import { projectSyncedMetadataStoredGroupLinksOwned2 } from './synced-metadata-group-links2'
import { captureSyncedMetadataReadBaselineOwned2, reopenSyncedMetadataCaptureRecordOwned2, readSyncedMetadataCaptureRecordOwned2, SYNCED_METADATA_BASELINE2_PREFIX } from './synced-metadata-capture-record2'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { headingTitlePointMaterial3, deriveHeadingTitlePointEdge3, planHeadingTitleSideData3, deriveHeadingTitleRestorationStyles3, headingTitleRestoreTemplate3, HeadingTitle3CascadeRequired, type HeadingTitleOrdinaryWiki3, type HeadingTitleRestoreStyle3 } from './synced-heading-title-point3'
import { restyleHeadingTitleOrdinaryBlocks3, restyleHeadingTitleGroupProjection3, headingTitleRestorationGroupStyles3, headingTitleLinkSyntax3, HeadingTitle3StyleRequired, type HeadingTitleRestoreGroupStyle3 } from './synced-heading-title-style3'
import { assertSyncedStoredBindings } from './synced-stored-binding-read'
import { collectDocumentMarkdownLinks, getMarkdownHeadingTargets, rewriteDocumentMarkdownLinks, rewriteLocalMarkdownLink, type MarkdownDocumentLink } from '../../shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { restoreHeadingTitleOrdinaryFields3, headingTitleOrdinaryRestorationFacts3, validateHeadingTitleOrdinaryStyleFacts3, type HeadingTitleOrdinaryStyleFact3, type HeadingTitleOrdinaryRestoreFact3, type HeadingTitleStyleTarget3 } from './synced-heading-title-style-facts3'
import { HeadingTitle3WikiScopeRequired, projectHeadingTitleOrdinaryWikiDestination3, type HeadingTitleOrdinaryDocument3 } from './synced-heading-title-ordinary3'
import { HeadingTitle3WikiStyleRequired, resolveHeadingTitleWikiStyle3, projectHeadingTitleWikiDocuments3 } from './synced-heading-title-wiki-style3'
import { findWikiHeading } from '../../shared/markdownWiki'
import { readHistoricalExactRows, readOriginalSqlTextRowsOwned2 } from './synced-history-evidence-support'
import { pruneSyncedHostRedoBranches } from './synced-host-history-branch'
import { MarkdownLinkIndex } from './markdown-link-index'
import { DocumentRecoveryRepository } from './document-recovery'
import { readSyncedRecoveryHostCut } from './synced-recovery-boundary-read'
import { readSyncedExchangeHostCut } from './synced-exchange-host-cut'
import { headingTitle3Hash, headingTitle3RequestHash, headingTitle3CompanionKey, headingTitle3JournalKey, headingTitle3GroupHeadKey, makeHeadingTitle3Companion,
  HEADING_TITLE3_OPERATION_KIND, type HeadingTitle3Group, type HeadingTitle3Companion, type HeadingTitle3Effect, type HeadingTitle3Subtree } from './synced-heading-title3-codec'
import { readHeadingTitle3OriginalOperationOwned, readHeadingTitle3JournalOriginalOwned, type HeadingTitle3GroupHead, type HeadingTitle3JournalPointer, readHeadingTitle3MixedSourceOwned, readHeadingTitle3CurrentSourcesOwned, HeadingTitle3LineageRequired } from './synced-heading-title3-read'

class HeadingTitle3DomainRefusal extends Error{constructor(message:string){super('Metadata3 heading title requires-lineage: '+message+'; preserve the complete working draft.');this.name='HeadingTitle3DomainRefusal'}}
const fail=(message:string):never=>{throw new HeadingTitle3DomainRefusal(message)}
const wire=(group:SyncedGroupSnapshot):SyncedGroupWire=>({kind:'synced-group',id:group.groupId,creationId:group.creationId,createdAt:group.createdAt,origin:group.origin,blocks:group.blocks,bindings:group.bindings})
const current=(db:Database.Database,id:string)=>readStrictHostDocument(db,id)??fail('actual host missing')
type Plan=ReturnType<typeof planSyncedMetadataNamespacesOwned2>
type GroupPlan={snapshot:SyncedGroupSnapshot;working:ReturnType<typeof projectSyncedMetadataStoredGroupLinksOwned2>;after:ReturnType<typeof projectSyncedMetadataStoredGroupLinksOwned2>;
  workingRevision:string;afterRevision:string;source:ReturnType<typeof readHeadingTitle3MixedSourceOwned>;ordinaryWiki:HeadingTitleOrdinaryWiki3[]}
type Projection={host:ReturnType<typeof current>;effects:HeadingTitle3Effect[];view:SyncedMetadataWorkspaceView2}
type ApplyContext={plan:Plan;hostId:string;groups:GroupPlan[];subtree:HeadingTitle3Subtree[];wikiDocuments:HeadingTitleOrdinaryDocument3[];now:string;restoreStyles?:readonly HeadingTitleRestoreStyle3[];restoreGroups?:readonly HeadingTitleRestoreGroupStyle3[];restoreOrdinary?:readonly HeadingTitleOrdinaryRestoreFact3[]}
class ProjectionEnd extends Error{constructor(readonly value:Projection){super('metadata2 projection rollback')}}
function own<T>(db:Database.Database,run:()=>T):T|{status:'unsupported';reason:string}{
  if(db.inTransaction)throw new Error('Metadata3 heading title writer requires its actual outer IMMEDIATE transaction.')
  if(db.pragma('foreign_keys',{simple:true})!==1||db.pragma('main.user_version',{simple:true})!==27)throw new Error('Metadata3 heading title writer requires actual schema27/FKON.')
  let refusal:Error|undefined
  try{return db.transaction(()=>{
    requireSyncedMetadataEditingFenceOwned2(db)
    try{return run()}catch(error){if(error instanceof HeadingTitle3DomainRefusal||error instanceof HeadingTitle3LineageRequired||error instanceof HeadingTitle3CascadeRequired||error instanceof HeadingTitle3StyleRequired||error instanceof HeadingTitle3WikiScopeRequired||error instanceof HeadingTitle3WikiStyleRequired)refusal=error;throw error}
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
function subtreeFacts(base:SyncedMetadataWorkspaceView2,rootId:string):HeadingTitle3Subtree[]{
  const result:HeadingTitle3Subtree[]=[],queue=[rootId],seen=new Set<string>()
  for(let i=0;i<queue.length;i++){
    const id=queue[i],host=base.hosts.get(id)?.host??fail('subtree owner missing')
    if(seen.has(id))return fail('subtree parent cycle');seen.add(id)
    result.push({id,createdAt:host.createdAt,parentId:host.parentId,title:host.content.title,path:host.detail.path,sortOrder:host.sortOrder})
    for(const [child,value]of base.hosts)if(value.host.parentId===id)queue.push(child)
  }
  return result.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
}
function readHeadingTitleWikiDocuments3(db:Database.Database):HeadingTitleOrdinaryDocument3[]{
  const rows=db.prepare('SELECT id,created_at,title,path FROM documents ORDER BY id').all() as Array<{id:string;created_at:string;title:string;path:string}>
  return rows.map(row=>({documentId:row.id,documentCreatedAt:row.created_at,title:row.title,path:row.path}))
}
function wikiDocumentsForView3(view:SyncedMetadataWorkspaceView2):HeadingTitleOrdinaryDocument3[]{
  return [...view.hosts.values()].map(({host})=>({documentId:host.detail.id,documentCreatedAt:host.createdAt,title:host.content.title,path:host.detail.path}))
}
function captureOrdinaryWiki3(db:Database.Database,source:ReturnType<typeof readHeadingTitle3MixedSourceOwned>['current'],documents:HeadingTitleOrdinaryDocument3[]):HeadingTitleOrdinaryWiki3[]{
  const parser=new MarkdownLinkIndex(db)
  return source.capture.namespaces.map(namespace=>{
    const links=collectDocumentMarkdownLinks(namespace.host.blocks).filter(link=>link.kind==='wiki')
    return{documentId:namespace.host.documentId,documentCreatedAt:namespace.host.createdAt,
    documents:links.length?documents:[],
    links:links.map(link=>{
      const block=namespace.host.blocks[link.blockIndex]
      if(!block||link.blockId!==block.id)throw new Error('Native ordinary Wiki source lost its exact physical block.')
      const resolved=parser.resolveWiki(link.url,namespace.path)
      const native=resolved?db.prepare('SELECT created_at FROM documents WHERE id=?').get(resolved.id) as {created_at:string}|undefined:undefined
      if(resolved&&!native)throw new Error('Native ordinary Wiki target disappeared inside its original snapshot.')
      return{key:{blockId:block.id,from:link.start,to:link.end,raw:block.content.slice(link.start,link.end),syntax:'wiki' as const},url:link.url,
        target:resolved?{documentId:resolved.id,documentCreatedAt:native!.created_at,path:resolved.path,fragment:resolved.fragment,
          kind:resolved.kind==='heading'?'wiki-heading' as const:'wiki' as const}:null}
    })}})
}
function groupPlans(db:Database.Database,plan:Plan,subtree:HeadingTitle3Subtree[],wikiDocuments:HeadingTitleOrdinaryDocument3[],now:string,restoreStyles?:readonly HeadingTitleRestoreStyle3[],restoreGroups?:readonly HeadingTitleRestoreGroupStyle3[],restoreOrdinary?:readonly HeadingTitleOrdinaryRestoreFact3[]):GroupPlan[]{
  const request=plan.request,rootId=request.hostsWorkingBefore[0].documentId
  const workingWiki=projectHeadingTitleWikiDocuments3(wikiDocuments,plan.workingDestinations,rootId,request.hostsWorkingBefore[0].workingBefore.title)
  const afterWiki=projectHeadingTitleWikiDocuments3(wikiDocuments,plan.finalDestinations,rootId,request.finalAfter[0].title)
  const selected:GroupPlan[]=[]
  const pending:Array<{snapshot:SyncedGroupSnapshot;working:GroupPlan['working'];after:GroupPlan['after'];hasHeading:boolean}>=[]
  for(const snapshot of plan.base.groups.values()){
    const value=wire(snapshot),sourcePath=value.origin.pathAtCreation
    const working=restyleHeadingTitleGroupProjection3(projectSyncedMetadataStoredGroupLinksOwned2(db,value,plan.workingDestinations),undefined,{before:wikiDocuments,after:workingWiki,sourcePath})
    const after=restyleHeadingTitleGroupProjection3(projectSyncedMetadataStoredGroupLinksOwned2(db,value,plan.finalDestinations),restoreGroups,{before:wikiDocuments,after:afterWiki,sourcePath})
    assertSyncedStoredBindings(db,working.after.origin,working.after.blocks,working.after.bindings)
    assertSyncedStoredBindings(db,after.after.origin,after.after.blocks,after.after.bindings)
    const changedHeading=(binding:typeof snapshot.bindings[number])=>{
      if(binding.target.kind!=='heading')return false
      const w=plan.workingDestinations.get(binding.target.documentId),a=plan.finalDestinations.get(binding.target.documentId)
      return Boolean(w&&(w.beforePath!==w.afterPath||w.headings.size)||a&&(a.beforePath!==a.afterPath||a.headings.size))
    }
    const hasHeading=snapshot.bindings.some(changedHeading)
    if(!working.changed&&!after.changed&&!hasHeading)continue
    if(snapshot.history.undoToken!==null||snapshot.history.redoToken!==null
      ||db.prepare('SELECT 1 FROM synced_group_history WHERE group_id=? LIMIT 1').get(snapshot.groupId))return fail('canonical user-history effective-tail adapter is not yet closed')
    const life=readSyncedGroupLifecycles(db,[snapshot.groupId]).get(snapshot.groupId)
    if(!life||life.state!=='active'||life.exposure==='never')return fail('unpublished create activation needs its own metadata-continuity adapter')
    pending.push({snapshot,working,after,hasHeading})
  }
  const sources=readHeadingTitle3CurrentSourcesOwned(db,pending.map(item=>item.snapshot.groupId))
  for(const {snapshot,working,after}of pending){
    const source=sources.get(snapshot.groupId)??fail('actual affected source disappeared')
    const changedHeading=(binding:typeof snapshot.bindings[number])=>{
      if(binding.target.kind!=='heading')return false
      const w=plan.workingDestinations.get(binding.target.documentId),a=plan.finalDestinations.get(binding.target.documentId)
      return Boolean(w&&(w.beforePath!==w.afterPath||w.headings.size)||a&&(a.beforePath!==a.afterPath||a.headings.size))
    }
    const proved=new Map(source.covered.map(item=>[hostEncode(item.key),item]))
    // Complete actual reverse closure, including unchanged literal fields.
    // Null mixed members carry empty coverage and cannot grant old Keys birth.
    for(const binding of snapshot.bindings)if(changedHeading(binding)){
      const key={blockId:binding.blockId,from:binding.from,to:binding.to,raw:binding.raw,syntax:binding.syntax},proof=proved.get(hostEncode(key))
      const target=source.current.capture.targets.find(item=>hostEqual(item.key,key))
      if(!proof||!hostEqual(proof.target,binding.target)||!target||target.status!=='current-heading'
        ||target.heading.location.kind!=='ordinary'||target.heading.key!==proof.headingKey||!hostEqual(target.heading.location,proof.location))return fail('actual incoming heading Key lacks continuous original birth')
    }
    for(const edit of [...working.edits,...after.edits]){
      const binding=snapshot.bindings.find(binding=>hostEqual({blockId:binding.blockId,from:binding.from,to:binding.to,raw:binding.raw,syntax:binding.syntax},edit.key))
      if(!binding||binding.target.kind==='unresolved-url'||binding.target.state!=='live')return fail('missing/unresolved historical target cannot be activated by a new path')
      if(/^heading-[1-6]$/.test(snapshot.blocks.find(block=>block.id===edit.blockId)?.type??''))return fail('canonical heading label maintenance needs its own namespace adapter')
    }
    const ordinaryWiki=captureOrdinaryWiki3(db,source.current,wikiDocuments)
    const base={before:source.current,rootId:plan.request.hostsWorkingBefore[0].documentId,persistedTitle:plan.base.hosts.get(plan.request.hostsWorkingBefore[0].documentId)!.host.content.title,
      createdAt:now,subtree,ordinaryWiki,wikiDocuments}
    const expectedWorking=planHeadingTitleSideData3({...base,afterTitle:plan.request.hostsWorkingBefore[0].workingBefore.title})
    const expectedAfter=planHeadingTitleSideData3({...base,afterTitle:plan.request.finalAfter[0].title,restoreStyles,restoreGroups,restoreOrdinary})
    if(!hostEqual(expectedWorking.projection.after,working.after)||!hostEqual(expectedAfter.projection.after,after.after))return fail('pure exact ordinary/Main namespace projections differ')
    selected.push({snapshot,working,after,source,ordinaryWiki,workingRevision:working.changed?randomUUID():snapshot.revision,afterRevision:after.changed?randomUUID():snapshot.revision})
  }
  return selected
}
function prepare(db:Database.Database,input:HostFinalInput,restoreStyles?:readonly HeadingTitleRestoreStyle3[],restoreGroups?:readonly HeadingTitleRestoreGroupStyle3[],restoreOrdinary?:readonly HeadingTitleOrdinaryRestoreFact3[]):ApplyContext{
  const plan=planSyncedMetadataNamespacesOwned2(db,input)
  if(input.hostsWorkingBefore.length!==1||input.finalAfter.length!==1||input.newRefSources.length)return fail('this first business domain requires one existing unchanged physical forest')
  const hostId=input.hostsWorkingBefore[0].documentId,original=plan.base.hosts.get(hostId)?.host??fail('host missing')
  const before=input.hostsWorkingBefore[0].workingBefore,after=input.finalAfter[0]
  if(!sameForestAndSummary(before,after)||!samePhysicalAttributes(original.content,before))return fail('body/summary/structure edits need the complete metadata writer')
  if(plan.working.hosts.get(hostId)!.host.content.title!==before.title||plan.final.hosts.get(hostId)!.host.content.title!==after.title)return fail('Main naming selection differs from the submitted raw title')
  // groupPlans below closes every actual incoming Key before any DML.
  const subtree=subtreeFacts(plan.base,hostId)
  const now=new Date(Math.max(Date.now(),...[...plan.base.hosts.values()].map(value=>Date.parse(value.host.detail.updatedAt)+1))).toISOString()
  const wikiDocuments=readHeadingTitleWikiDocuments3(db)
  const groups=groupPlans(db,plan,subtree,wikiDocuments,now,restoreStyles,restoreGroups,restoreOrdinary)
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
  const context={plan,hostId,groups,subtree,wikiDocuments,now,restoreStyles,restoreGroups,restoreOrdinary}
  if(restoreOrdinary)preflightOrdinaryRestore3(db,context)
  return context
}

/** Missing/new inverse fields are refused before an observation savepoint can
 * perform DML. The later actual Main projection repeats the exact checks. */
function preflightOrdinaryRestore3(db:Database.Database,ctx:ApplyContext):void{
  const changes=new Map([...ctx.plan.finalDestinations.values()].filter(item=>item.beforePath!==item.afterPath||item.headings.size)
    .map(item=>[item.beforePath,{before:item.beforePath,after:item.afterPath,headings:new Map(item.headings)}]))
  const beforeTargets=ordinaryStyleTargets3(ctx.plan.base),afterTargets=ordinaryStyleTargets3(ctx.plan.final)
  const parser=new MarkdownLinkIndex(db),afterWiki=wikiDocumentsForView3(ctx.plan.final)
  for(const [id,source]of ctx.plan.base.hosts){
    const final=ctx.plan.final.hosts.get(id)?.host
    if(!final)throw new HeadingTitle3StyleRequired('inverse ordinary source disappeared from the actual final namespace')
    const sourcePath=source.host.detail.path,newPath=final.detail.path,wiki={before:ctx.wikiDocuments,after:afterWiki,sourcePath}
    const blocks=rewriteDocumentMarkdownLinks(source.host.content.blocks,link=>{
      if(link.kind==='image')return null
      if(link.kind!=='wiki')return rewriteLocalMarkdownLink(link.url,sourcePath,newPath,changes)
      const binding=parser.resolveWiki(link.url,sourcePath)
      return projectHeadingTitleOrdinaryWikiDestination3(link.url,sourcePath,changes,changes.has(sourcePath),binding?{
        path:binding.path,fragment:binding.fragment,kind:binding.kind==='heading'?'wiki-heading':'wiki'}:null)
    })
    const canonical=restyleHeadingTitleOrdinaryBlocks3(source.host.content.blocks,blocks,newPath,undefined,undefined,undefined,wiki)
    if(hostEqual(canonical.blocks,source.host.content.blocks))continue
    restoreHeadingTitleOrdinaryFields3({documentId:id,documentCreatedAt:source.host.createdAt,path:sourcePath,
      blocks:source.host.content.blocks,births:source.host.births},canonical.blocks,newPath,ctx.restoreOrdinary!,
      (side,link)=>(side==='before'?beforeTargets:afterTargets)(side==='before'?sourcePath:newPath,link),wiki)
  }
}
function ordinaryStyleTargets3(view:SyncedMetadataWorkspaceView2){
  const paths=new Map([...view.hosts.values()].map(item=>[item.host.detail.path,item]))
  const wikiDocuments=wikiDocumentsForView3(view),wikiHeadings=new Map<string,ReturnType<typeof getMarkdownHeadingTargets>>()
  const headings=new Map<string,ReturnType<typeof projectSyncedHostHeadings2>>()
  const ordinaryOwners=new Map([...view.hosts.values()].flatMap(item=>[...item.host.births.keys()].map(id=>[id,item.host.detail.id] as const)))
  const canonicalIds=new Set([...view.groups.values()].flatMap(group=>group.blocks.map(block=>block.id)))
  return(sourcePath:string,link:MarkdownDocumentLink):HeadingTitleStyleTarget3=>{
  if(link.kind==='wiki'){
    const {document,reference}=resolveHeadingTitleWikiStyle3(link.url,sourcePath,wikiDocuments)
    const selected=view.hosts.get(document.documentId)?.host
    if(!selected||selected.createdAt!==document.documentCreatedAt)throw new HeadingTitle3WikiStyleRequired('actual Wiki document birth disappeared')
    const fragment=reference.fragment,blockId=fragment.startsWith('^')?fragment.slice(1):fragment,birth=selected.births.get(blockId)
    let target:unknown={kind:'document',documentId:document.documentId,createdAt:document.documentCreatedAt}
    if(fragment&&birth){target={kind:'block',documentId:document.documentId,documentCreatedAt:document.documentCreatedAt,blockId,blockCreatedAt:birth}}
    else if(fragment){
      if(ordinaryOwners.has(blockId))throw new HeadingTitle3WikiStyleRequired('route-only Wiki target requires its actual original block-route proof')
      let headings=wikiHeadings.get(document.documentId)
      if(!headings){headings=getMarkdownHeadingTargets(selected.content.blocks,selected.content.title);wikiHeadings.set(document.documentId,headings)}
      const heading=findWikiHeading(fragment,headings)
      target=heading?{kind:'heading',documentId:document.documentId,documentCreatedAt:document.documentCreatedAt,key:heading.key,
        blockCreatedAt:heading.blockId===null?null:selected.births.get(heading.blockId)}
        :{kind:'literal-fragment',documentId:document.documentId,documentCreatedAt:document.documentCreatedAt,fragment}
    }
    return{targetPath:document.path,fragment,targetKind:'live',targetId:document.documentId,targetCreatedAt:document.documentCreatedAt,targetIdentity:hostHash(target)}
  }
  const resolved=resolveMarkdownDocumentPath(sourcePath,link.url)
  const selected=resolved?paths.get(resolved.path):undefined
  if(!resolved)throw new HeadingTitle3StyleRequired('actual ordinary target is not a local Markdown destination')
  if(!selected){
    const fragmentId=resolved.fragment.startsWith('^')?resolved.fragment.slice(1):resolved.fragment
    if(fragmentId&&(ordinaryOwners.has(fragmentId)||canonicalIds.has(fragmentId)))throw new HeadingTitle3StyleRequired('route-only ordinary target requires its actual original route proof')
    return{targetPath:resolved.path,fragment:resolved.fragment,targetKind:'unresolved-local',targetId:null,targetCreatedAt:null,
      targetIdentity:hostHash({kind:'unresolved-local',path:resolved.path,fragment:resolved.fragment})}
  }
  const host=selected.host,fragment=resolved.fragment
  let targetIdentity:unknown={kind:'document',documentId:host.detail.id,createdAt:host.createdAt}
  const blockId=fragment.startsWith('^')?fragment.slice(1):fragment,birth=host.births.get(blockId)
  if(fragment&&birth){
    targetIdentity={kind:'block',documentId:host.detail.id,documentCreatedAt:host.createdAt,blockId,blockCreatedAt:birth}
  }else if(fragment){
    if(ordinaryOwners.has(blockId)||canonicalIds.has(blockId))throw new HeadingTitle3StyleRequired('route-only ordinary target requires its actual original route proof')
    let facts=headings.get(host.detail.id)
    if(!facts){facts=projectSyncedHostHeadings2(host,view.groups,selected.instances);headings.set(host.detail.id,facts)}
    const heading=facts.find(item=>item.slug===fragment)
    targetIdentity=heading?{kind:'heading',key:heading.key,location:heading.location}
      :{kind:'literal-fragment',documentId:host.detail.id,createdAt:host.createdAt,fragment}
  }
  return{targetPath:resolved.path,fragment,targetKind:'live',targetId:host.detail.id,targetCreatedAt:host.createdAt,targetIdentity:hostHash(targetIdentity)}
  }
}
/** Observe the complete actual ordinary parser in all three owned views. Store
 * only changed physical destinations and their private native birth facts. */
function captureOrdinaryStyles3(persisted:SyncedMetadataWorkspaceView2,working:SyncedMetadataWorkspaceView2,after:SyncedMetadataWorkspaceView2):HeadingTitleOrdinaryStyleFact3[]{
  const styles=new Map<string,HeadingTitleOrdinaryStyleFact3>()
  const pTargets=ordinaryStyleTargets3(persisted),wTargets=ordinaryStyleTargets3(working),aTargets=ordinaryStyleTargets3(after)
  for(const [id,source]of persisted.hosts){
    const w=working.hosts.get(id),a=after.hosts.get(id)
    if(!w||!a||w.host.createdAt!==source.host.createdAt||a.host.createdAt!==source.host.createdAt)
      throw new HeadingTitle3StyleRequired('ordinary style source incarnation changed during observation')
    const links=collectDocumentMarkdownLinks(source.host.content.blocks),wl=collectDocumentMarkdownLinks(w.host.content.blocks),al=collectDocumentMarkdownLinks(a.host.content.blocks)
    if(links.length!==wl.length||links.length!==al.length)throw new HeadingTitle3StyleRequired('ordinary P/W/A complete parser closure differs')
    for(let index=0;index<links.length;index++){
      const p=links[index],nextW=wl[index],nextA=al[index]
      if(p.kind==='image')continue
      const block=source.host.content.blocks[p.blockIndex],blockW=w.host.content.blocks[nextW.blockIndex],blockA=a.host.content.blocks[nextA.blockIndex]
      const raw=block.content.slice(p.start,p.end),rawW=blockW.content.slice(nextW.start,nextW.end),rawA=blockA.content.slice(nextA.start,nextA.end)
      if(raw===rawW&&raw===rawA)continue
      const birth=source.host.births.get(block.id)
      if(!birth||block.id!==blockW.id||block.id!==blockA.id||birth!==w.host.births.get(block.id)||birth!==a.host.births.get(block.id)
        ||p.kind!==nextW.kind||p.kind!==nextA.kind||headingTitleLinkSyntax3(p)!==headingTitleLinkSyntax3(nextW)||headingTitleLinkSyntax3(p)!==headingTitleLinkSyntax3(nextA))
        throw new HeadingTitle3StyleRequired('ordinary style physical field/grammar/birth changed')
      const field=(targets:ReturnType<typeof ordinaryStyleTargets3>,path:string,link:MarkdownDocumentLink,raw:string)=>({from:link.start,to:link.end,raw,url:link.url,sourcePath:path,
        ...targets(path,link)})
      const fact:HeadingTitleOrdinaryStyleFact3={documentId:id,documentCreatedAt:source.host.createdAt,blockId:block.id,blockCreatedAt:birth,
        kind:p.kind,syntax:headingTitleLinkSyntax3(p)??null,persisted:field(pTargets,source.host.detail.path,p,raw),working:field(wTargets,w.host.detail.path,nextW,rawW),after:field(aTargets,a.host.detail.path,nextA,rawA)}
      const address=hostEncode([id,block.id,p.start,p.end]),old=styles.get(address)
      if(old&&!hostEqual(old,fact))throw new HeadingTitle3StyleRequired('one ordinary physical destination has contradictory native expectations')
      styles.set(address,fact)
    }
  }
  return validateHeadingTitleOrdinaryStyleFacts3([...styles.values()],{persisted:wikiDocumentsForView3(persisted),working:wikiDocumentsForView3(working),after:wikiDocumentsForView3(after)})
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
  let after=readSyncedMetadataWorkspaceOwned2(db)
  const styledDocuments=new Set<string>(),beforeTargets=ordinaryStyleTargets3(ctx.plan.base),afterTargets=ordinaryStyleTargets3(after),afterWiki=wikiDocumentsForView3(after)
  for(const [id,old]of ctx.plan.base.hosts){
    const next=after.hosts.get(id)?.host
    if(!next||hostEqual(old.host.content.blocks,next.content.blocks))continue
    const before={path:old.host.detail.path,host:{documentId:id,createdAt:old.host.createdAt,parentId:old.host.parentId,sortOrder:old.host.sortOrder,
      title:old.host.content.title,summary:old.host.content.summary,blocks:old.host.content.blocks,births:[...old.host.births]}}
    const template=side==='after'&&!ctx.restoreOrdinary?headingTitleRestoreTemplate3(before,ctx.restoreStyles):undefined
    const wiki={before:ctx.wikiDocuments,after:afterWiki,sourcePath:old.host.detail.path}
    const canonical=restyleHeadingTitleOrdinaryBlocks3(old.host.content.blocks,next.content.blocks,next.detail.path,template,undefined,undefined,wiki)
    const restored=side==='after'&&ctx.restoreOrdinary?restoreHeadingTitleOrdinaryFields3({documentId:id,documentCreatedAt:old.host.createdAt,path:old.host.detail.path,
      blocks:old.host.content.blocks,births:old.host.births},canonical.blocks,next.detail.path,ctx.restoreOrdinary,
      (which,link)=>(which==='before'?beforeTargets:afterTargets)(which==='before'?old.host.detail.path:next.detail.path,link),wiki):null
    const styled={blocks:restored?.blocks??canonical.blocks,changed:(restored?.blocks??canonical.blocks).some((block,index)=>block.content!==next.content.blocks[index].content)}
    if(!styled.changed)continue
    for(let index=0;index<styled.blocks.length;index++)if(styled.blocks[index].content!==next.content.blocks[index].content){
      const block=next.content.blocks[index],birth=next.births.get(block.id)
      if(!birth||db.prepare('UPDATE blocks SET content=? WHERE id=? AND document_id=? AND created_at=? AND content=?')
        .run(styled.blocks[index].content,block.id,id,birth,block.content).changes!==1)throw new Error('Metadata3 style correction lost its exact ordinary block birth/content.')
    }
    if(db.prepare('UPDATE documents SET updated_at=? WHERE id=? AND created_at=? AND updated_at=?')
      .run(ctx.now,id,next.createdAt,next.detail.updatedAt).changes!==1)throw new Error('Metadata3 style correction lost its actual document CAS.')
    styledDocuments.add(id)
  }
  if(styledDocuments.size){resyncOrdinaryLinks(db,ctx.now);after=readSyncedMetadataWorkspaceOwned2(db)}
  // Ordinary Wiki maintenance can alter a heading label and cascade. It must
  // not silently activate a canonical heading binding in that new namespace.
  for(const [id,old]of ctx.plan.base.hosts){const next=after.hosts.get(id)!
    if(old.host.content===next.host.content)continue
    const headings=planSyncedHeadingRewrites2(projectSyncedHostHeadings2(old.host,ctx.plan.base.groups,old.instances),projectSyncedHostHeadings2(next.host,after.groups,next.instances))
    if(headings.size)for(const group of ctx.plan.base.groups.values())if(group.bindings.some(binding=>binding.target.kind==='heading'&&binding.target.documentId===id)){
      const expected=destinations.get(id)?.headings??new Map<string,string>()
      if(!hostEqual([...headings],[...expected]))return fail('ordinary maintenance introduced an additional unproved heading cascade beyond the complete preflight namespace')
    }
  }
  const ids=new Set([ctx.hostId,...paths.map(item=>item.documentId),...changed,...styledDocuments]),effects:HeadingTitle3Effect[]=[...ids].sort().map(id=>{const item=after.hosts.get(id)?.host??fail('maintenance result host missing')
    return{documentId:id,createdAt:item.createdAt,path:item.detail.path,contentHash:hostHash(item.content)}})
  return{host:after.hosts.get(ctx.hostId)!.host,effects,view:after}
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
type PreparedGroup3=Omit<HeadingTitle3Group,'afterPointKey'|'afterPointHash'>
const captureBeforePoint3=(db:Database.Database,key:string)=>readSyncedMetadataCaptureRecordOwned2(db,reopenSyncedMetadataCaptureRecordOwned2(db,key))
function groupRecords(db:Database.Database,ctx:ApplyContext):PreparedGroup3[]{
  return ctx.groups.map(item=>{const owner=captureSyncedMetadataReadBaselineOwned2(db,item.snapshot.groupId),point=readSyncedMetadataCaptureRecordOwned2(db,owner)
    if(point.kind!=='synced-metadata2-read-baseline-record'||typeof point.pointHash!=='string'||point.sources[0].revision!==item.snapshot.revision||!hostEqual(point.sources[0].wire,wire(item.snapshot)))return fail('current original source point differs before business mutation')
    if(!hostEqual(headingTitlePointMaterial3(point),headingTitlePointMaterial3(item.source.current)))return fail('native before point changed after complete preflight')
    return{previous:item.source.previous,ordinaryWiki:item.ordinaryWiki,groupId:item.snapshot.groupId,creationId:item.snapshot.creationId,createdAt:item.snapshot.createdAt,sourcePointKey:SYNCED_METADATA_BASELINE2_PREFIX+point.pointHash,sourcePointHash:point.recordHash,
      sourceRevision:item.snapshot.revision,sourceTopologyRevision:item.snapshot.topologyRevision,sourceHistoryCursor:item.snapshot.history.cursor,
      workingEdits:item.working.edits,afterEdits:item.after.edits,workingHash:hostHash(item.working.after),afterHash:hostHash(item.after.after),afterRevision:item.afterRevision}
  })
}
function finish(db:Database.Database,ctx:ApplyContext,requestHash:string,token:string|null,working:Projection,after:Projection,preparedGroups:PreparedGroup3[],
  intent:HeadingTitle3Companion['intent'],initial:HeadingTitle3Companion['initialCompanion'],rawBefore:HostContent):SyncedStructureApplied{
  const input=ctx.plan.request,operationId=intent.kind==='apply'?input.clientOperationId:intent.input.clientOperationId
  const groups:HeadingTitle3Group[]=preparedGroups.map(group=>{
    const owner=captureSyncedMetadataReadBaselineOwned2(db,group.groupId),point=readSyncedMetadataCaptureRecordOwned2(db,owner)
    if(point.kind!=='synced-metadata2-read-baseline-record'||!point.pointHash)return fail('actual committed after source point missing')
    const item=ctx.groups.find(item=>item.snapshot.groupId===group.groupId)!
    const beforeOwner=captureBeforePoint3(db,group.sourcePointKey)
    deriveHeadingTitlePointEdge3({before:beforeOwner,after:point,rootId:ctx.hostId,persistedTitle:ctx.plan.base.hosts.get(ctx.hostId)!.host.content.title,
      afterTitle:after.host.content.title,createdAt:ctx.now,subtree:ctx.subtree,afterRevision:group.afterRevision,previousCovered:item.source.covered,ordinaryWiki:group.ordinaryWiki,wikiDocuments:ctx.wikiDocuments,restoreStyles:ctx.restoreStyles,restoreGroups:ctx.restoreGroups,restoreOrdinary:ctx.restoreOrdinary})
    return{...group,afterPointKey:SYNCED_METADATA_BASELINE2_PREFIX+point.pointHash,afterPointHash:point.recordHash}
  })
  const required=new Set([...input.groups.map(item=>item.groupId),...groups.map(item=>item.groupId)])
  const snapshots=getSyncedGroupSnapshots(db,{groupIds:[...required]}).items.map(item=>item.status==='ready'?item.snapshot:fail('actual final reference group disappeared'))
  const rawLogicalChange=intent.kind==='apply'?input.hostsWorkingBefore[0].workingBefore.title!==input.finalAfter[0].title:true
  const result:SyncedStructureApplied={status:'applied',operationId,historyToken:token,replayed:false,hosts:[{documentId:ctx.hostId,logicalBefore:rawBefore,logicalBeforeHash:hostHash(rawBefore),after:current(db,ctx.hostId).detail}],groups:snapshots,affectedInstanceIds:[],blockIdMap:[]}
  const original=ctx.plan.base.hosts.get(ctx.hostId)!.host,companion=makeHeadingTitle3Companion({kind:'synced-host-heading-title-metadata3-companion',version:3,operationId,
    workspaceScope:ctx.plan.base.workspaceScope,recoveryEpoch:ctx.plan.base.recoveryEpoch,createdAt:ctx.now,scope:'pure-title-existing-forest-business-heading-key-lineage-no-group-user-history',intent,requestHash,
    hostId:ctx.hostId,hostCreatedAt:original.createdAt,hostParentId:original.parentId,subtree:ctx.subtree,wikiDocuments:ctx.wikiDocuments,historyToken:token,initialCompanion:initial,rawLogicalChange,
    persistedTitle:original.content.title,persistedPath:original.detail.path,workingPath:working.host.detail.path,afterPath:after.host.detail.path,workingContentHash:hostHash(working.host.content),afterContentHash:hostHash(after.host.content),
    workingEffects:working.effects,afterEffects:after.effects,ordinaryStyles:captureOrdinaryStyles3(ctx.plan.base,working.view,after.view),groups,projection:'owned-sql-savepoint-main-maintenance',businessOperationCommitted:true,writePermit:false})
  saveSetting(db,headingTitle3CompanionKey(operationId),companion,ctx.now)
  if(intent.kind==='apply'&&token){
    const row=readHistoricalExactRows<Record<string,string>>(db,'synced_host_history',['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],'id=?',[token])[0]
    const pointer:HeadingTitle3JournalPointer={kind:'synced-host-heading-title-metadata3-journal',version:3,historyToken:token,initialOperationId:operationId,companionHash:companion.companionHash,journalHash:headingTitle3Hash({journal:row})}
    saveSetting(db,headingTitle3JournalKey(token),pointer,ctx.now)
  }
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)').run(operationId,requestHash,
    hostEncode({kind:HEADING_TITLE3_OPERATION_KIND,version:3,companionKey:headingTitle3CompanionKey(operationId),companionHash:companion.companionHash,result}),ctx.now)
  for(const group of groups){const head:HeadingTitle3GroupHead={kind:'synced-host-heading-title-metadata3-group-head',version:3,groupId:group.groupId,creationId:group.creationId,groupCreatedAt:group.createdAt,
    operationId,companionHash:companion.companionHash,revision:group.afterRevision,topologyRevision:group.sourceTopologyRevision,wireHash:group.afterHash,historyCursor:group.sourceHistoryCursor,historyPosition:0}
    saveSetting(db,headingTitle3GroupHeadKey(group.groupId),head,ctx.now,true)}
  const readback=readHeadingTitle3OriginalOperationOwned(db,operationId)
  if(!readback||!hostEqual(readback.envelope.result,result))throw new Error('Metadata3 heading title original ACK did not independently read back.')
  return readback.envelope.result
}
export function applySyncedHostHeadingTitle3(db:Database.Database,value:unknown):SyncedEditingHostResult{
  const parsed=validateSyncedStructureInput(value);if(parsed.mode!=='host-final')return fail('explicit title mode required')
  const request:HostFinalInput=parsed
  return own(db,()=>{
    const hash=headingTitle3RequestHash('apply',request),previous=readHeadingTitle3OriginalOperationOwned(db,request.clientOperationId)
    if(previous){if(previous.row.request_hash!==hash)throw new Error('Metadata3 heading title idempotency-mismatch');return{...previous.envelope.result,replayed:true}}
    if(db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(request.clientOperationId))throw new Error('Metadata3 heading title idempotency namespace mismatch')
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
export function restoreSyncedHostHeadingTitle3(db:Database.Database,value:unknown):SyncedEditingHostResult{
  const input=validateSyncedRestoreHostInput(value)
  return own(db,()=>{
    const hash=headingTitle3RequestHash('restore',input),previous=readHeadingTitle3OriginalOperationOwned(db,input.clientOperationId)
    if(previous){if(previous.row.request_hash!==hash)throw new Error('Metadata3 heading title idempotency-mismatch');return{...previous.envelope.result,replayed:true}}
    if(db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId))throw new Error('Metadata3 heading title idempotency namespace mismatch')
    const original=readHeadingTitle3JournalOriginalOwned(db,input.historyToken);if(!original)return fail('actual metadata2 journal missing')
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
    // readHeadingTitle3JournalOriginalOwned already checked every exact original pin
    // in this same owned transaction, before any observe/capture can mutate.
    const desired=undo?saved.intent.workingTitle:saved.intent.afterTitle
    const synthetic:HostFinalInput={clientOperationId:input.clientOperationId,mode:'host-final',reason:'source-apply',hostsWorkingBefore:[{documentId:saved.hostId,
      expectedPersistedUpdatedAt:before.detail.updatedAt,workingBefore:before.content}],finalAfter:[{documentId:saved.hostId,...before.content,title:desired}],groups:input.groups,expectedInstances:input.expectedInstances,newRefSources:[]}
    // This is a new inverse intention derived from the actual journal and
    // current owned P, not a caller DTO posing as a historical capture.
    const restoreStyles=deriveHeadingTitleRestorationStyles3(original.initial,input.direction)
    const restoreGroups=headingTitleRestorationGroupStyles3(original.initial.materials,input.direction)
    const restoreOrdinary=headingTitleOrdinaryRestorationFacts3(saved.ordinaryStyles,input.direction)
    const ctx=prepare(db,synthetic,restoreStyles,restoreGroups,restoreOrdinary)
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
      {key:headingTitle3CompanionKey(original.pointer.initialOperationId),hash:saved.companionHash},before.content)
  })
}
