import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot, SyncedGroupWire } from '../../shared/synced-blocks'
import { isNativeSectionHeading } from '../../shared/document-rename-admission'
import { isSyncedUuid, assertSyncedShape } from '../../shared/syncedBlockValidation'
import { hostJson, hostTime, type HostContent } from './synced-host-document-read'
import { hostEncode, hostHash, hostEqual, sameHostContent, decodeHostJournal } from './synced-host-journal'
import { readHistoricalExactRows, historicalOperationLocator, historicalMetadataLocator, historicalRowLocator, type HistoricalMetadataRow } from './synced-history-evidence-support'
import { reopenSyncedMetadataCaptureRecordOwned2, readSyncedMetadataCaptureRecordOwned2 } from './synced-metadata-capture-record2'
import { TITLE2_OPERATION_KIND, TITLE2_COMPANION_PREFIX, TITLE2_JOURNAL_PREFIX, TITLE2_GROUP_HEAD_PREFIX, title2CompanionKey, title2JournalKey,
  title2GroupHeadKey, title2Hash, decodeTitle2Envelope, projectTitle2GroupSide, TITLE2_HEADING_SCOPE, TITLE2_SECTION_SCOPE, TITLE2_USER_HISTORY_SCOPE, TITLE2_MAX_HISTORY_PROJECTIONS,
  type Title2Row, type Title2Group, type Title2Envelope, type Title2Companion } from './synced-host-title2-codec'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { projectSyncedMetadataGroupLinks2, type SyncedMetadataDocumentDestination2 } from './synced-metadata-group-links2'
import { projectSyncedHostHeadingFacts2, planSyncedHeadingRewrites2, type SyncedHeadingGroupFacts2 } from './synced-heading-projection2'
import { continueTitle2Heading, title2BindingKey } from './synced-host-title2-heading'
import { replayTitle2UserHistory, type Title2PriorHistory } from './synced-title2-user-history'
import type { OriginalHistoryRow } from './synced-group-history-original'

const fail=(message:string):never=>{throw new Error('Metadata2 title original invalid: '+message)}
const owned=(db:Database.Database)=>{if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)return fail('actual owned schema27 SQL required')}
const setting=(db:Database.Database,key:string)=>readHistoricalExactRows<HistoricalMetadataRow>(db,'app_settings',['key','value','updated_at'],'key=?',[key])[0]
const operation=(db:Database.Database,id:string)=>readHistoricalExactRows<Title2Row>(db,'synced_operations',['client_operation_id','request_hash','result_json','created_at'],'client_operation_id=?',[id])[0]
export interface Title2JournalPointer{kind:'synced-host-title-metadata2-journal';version:2;historyToken:string;initialOperationId:string;companionHash:string;journalHash:string}
export interface Title2GroupHead{kind:'synced-host-title-metadata2-group-head';version:2;groupId:string;creationId:string;groupCreatedAt:string;
  operationId:string;companionHash:string;revision:string;topologyRevision:string;wireHash:string;historyCursor:string;historyPosition:number}
type Title2JournalPin={group_id:string;kind:string;pin_id:string;created_at:string}
export interface Title2OriginalOperation {
  row:Title2Row;metadata:HistoricalMetadataRow;envelope:Title2Envelope;companion:Title2Companion;
  materials:Array<{group:Title2Group;sourcePoint:ReturnType<typeof readSyncedMetadataCaptureRecordOwned2>;before:SyncedGroupWire;working:SyncedGroupWire;after:SyncedGroupWire;
    userHistory?:ReturnType<typeof replayTitle2UserHistory>;userHistoryDepth:number}>;
  journal:SyncedHostHistoryBranchRow|null;journalPins:Title2JournalPin[];initialOperationId:string|null
}
function destinations(companion:Title2Companion,rootPath:string):Map<string,SyncedMetadataDocumentDestination2>{
  const items=new Map(companion.subtree.map(item=>[item.id,item])),paths=new Map<string,string>([[companion.hostId,rootPath]]),queue=[companion.hostId]
  for(let i=0;i<queue.length;i++)for(const item of companion.subtree)if(item.parentId===queue[i]){
    if(paths.has(item.id))return fail('companion subtree has a cycle')
    paths.set(item.id,rootPath===companion.persistedPath?item.path:paths.get(queue[i])!+'/'+item.title);queue.push(item.id)
  }
  if(paths.size!==items.size)return fail('companion subtree parent closure differs')
  return new Map(companion.subtree.map(item=>[item.id,{documentId:item.id,beforeCreatedAt:item.createdAt,afterCreatedAt:item.createdAt,
    beforePath:item.path,afterPath:paths.get(item.id)!,headings:new Map<string,string>()}]))
}
function projectTitle2HeadingDestinations(
  companion: Title2Companion,
  source: ReturnType<typeof readSyncedMetadataCaptureRecordOwned2>,
  side: Map<string, SyncedMetadataDocumentDestination2>,
  rootTitle: string,
  rawWorking: HostContent
) {
  const facts = new Map<string, SyncedHeadingGroupFacts2>()
  const wires = [...source.sources.map(item => item.wire), ...source.capture.groups.flatMap(item => item.kind === 'namespace-material' ? [item.wire] : [])]
  for (const wire of wires) facts.set(wire.id, { groupId: wire.id, creationId: wire.creationId, createdAt: wire.createdAt,
    origin: wire.origin, bindings: wire.bindings, blocks: wire.blocks })
  const projected = new Map<string, ReturnType<typeof projectSyncedHostHeadingFacts2>>()
  for (const wire of source.sources.map(item => item.wire)) for (const binding of wire.bindings) {
    const target = binding.target
    if (target.kind !== 'heading') continue
    const destination = side.get(target.documentId)
    const isRoot = target.documentId === companion.hostId
    const section = isRoot ? companion.sectionEdit : undefined
    if (!destination || !section && destination.beforePath === destination.afterPath && (!isRoot || rootTitle === companion.persistedTitle)) continue
    const namespace = source.capture.namespaces.find(item => item.host.documentId === target.documentId)
    const captured = source.capture.targets.find(item => item.sourceGroupId === wire.id && hostEqual(item.key, title2BindingKey(binding)))
    if (target.state !== 'live' || !namespace || !captured || captured.status !== 'current-heading'
      || captured.documentCreatedAt !== destination.beforeCreatedAt || namespace.path !== destination.beforePath
      || isRoot && namespace.host.title !== companion.persistedTitle) return fail('heading lacks its exact original current namespace and Key')
    let next = projected.get(target.documentId)
    if (!next) {
      let blocks = namespace.host.blocks
      const births = new Map(namespace.host.births)
      if (section) {
        const heading = blocks.find(block => block.id === section.blockId)
        if (!heading || !isNativeSectionHeading(heading.type) || heading.content !== section.before
          || births.get(heading.id) !== section.createdAt || namespace.host.createdAt !== companion.hostCreatedAt
          || namespace.host.parentId !== companion.hostParentId)
          return fail('section heading lacks its exact original physical birth and text')
        blocks = blocks.map(block => block.id === heading.id ? { ...block, content: section.after } : block)
        if (!sameHostContent(rawWorking, { title: rootTitle, summary: namespace.host.summary, blocks }))
          return fail('section heading original P does not reconstruct the complete raw W')
      }
      next = section || isRoot && namespace.host.title !== rootTitle
        ? projectSyncedHostHeadingFacts2({ ...namespace.host, title: rootTitle, blocks, births },
          facts, new Map(namespace.instances.map(instance => [instance.instanceId, instance])))
        : namespace.headings
      projected.set(target.documentId, next)
      side.set(target.documentId, { ...destination, headings: planSyncedHeadingRewrites2(namespace.headings, next) })
    }
    const continued = continueTitle2Heading(target.slug, namespace.headings, next)
    if (!continued || !hostEqual(captured.heading, continued.source)
      || continued.destination.slug !== (side.get(target.documentId)!.headings.get(target.slug) ?? target.slug))
      return fail('heading does not continue its exact captured occurrence')
  }
  return projected.size > 0
}
function assertTitle2HeadingPath(companion: Title2Companion, afterTitle: string) {
  const root = companion.subtree.find(item => item.id === companion.hostId)!
  const suffix = '/' + companion.persistedTitle
  if (root.title !== companion.persistedTitle || root.path !== companion.persistedPath
    || (root.parentId === null ? root.path !== root.title : !root.path.endsWith(suffix))) return fail('captured heading title does not bind its exact original root path')
  const prefix = root.parentId === null ? '' : root.path.slice(0, -companion.persistedTitle.length)
  const workingTitle = companion.intent.kind === 'apply' ? companion.intent.workingTitle : companion.persistedTitle
  if (companion.workingPath !== prefix + workingTitle || companion.afterPath !== prefix + afterTitle
    || companion.intent.kind === 'apply' && companion.intent.afterTitle !== afterTitle) return fail('heading projection path does not match its exact title intent')
}
export function decodeTitle2JournalPointer(value:unknown):Title2JournalPointer{
  assertSyncedShape(value,['kind','version','historyToken','initialOperationId','companionHash','journalHash'])
  if(value.kind!=='synced-host-title-metadata2-journal'||value.version!==2||!isSyncedUuid(value.historyToken)||!isSyncedUuid(value.initialOperationId)
    ||typeof value.companionHash!=='string'||!/^[a-f0-9]{64}$/.test(value.companionHash)||typeof value.journalHash!=='string'||!/^[a-f0-9]{64}$/.test(value.journalHash))return fail('journal pointer malformed')
  return value as unknown as Title2JournalPointer
}
export function decodeTitle2GroupHead(value:unknown):Title2GroupHead{
  assertSyncedShape(value,['kind','version','groupId','creationId','groupCreatedAt','operationId','companionHash','revision','topologyRevision','wireHash','historyCursor','historyPosition'])
  if(value.kind!=='synced-host-title-metadata2-group-head'||value.version!==2||!isSyncedUuid(value.groupId)||!isSyncedUuid(value.creationId)
    ||!isSyncedUuid(value.operationId)||!isSyncedUuid(value.revision)||!isSyncedUuid(value.topologyRevision)||!isSyncedUuid(value.historyCursor)
    ||!Number.isSafeInteger(value.historyPosition)||(value.historyPosition as number)<0
    ||typeof value.companionHash!=='string'||!/^[a-f0-9]{64}$/.test(value.companionHash)||typeof value.wireHash!=='string'||!/^[a-f0-9]{64}$/.test(value.wireHash))return fail('group head malformed')
  hostTime(value.groupCreatedAt);return value as unknown as Title2GroupHead
}
/** Original-data read only, with fixed SQL selectors and exact source-point
 * records. A historical packet cannot authorize a fresh writer or installation. */
export function readTitle2OriginalOperationOwned(db:Database.Database,id:string):Title2OriginalOperation|null{
  return readOriginalTitle2Operation(db,id,new Set(),new Map())
}
function readOriginalTitle2Operation(db:Database.Database,id:string,visiting:Set<string>,verified:Map<string,Title2OriginalOperation>):Title2OriginalOperation|null{
  owned(db);if(!isSyncedUuid(id))return fail('operation UUID invalid')
  if(visiting.has(id)||visiting.size>=TITLE2_MAX_HISTORY_PROJECTIONS)return fail('cyclic or unbounded companion reference')
  const existing=verified.get(id);if(existing)return existing
  const row=operation(db,id);if(!row)return null
  const packet=hostJson(row.result_json)
  if(!packet||typeof packet!=='object'||!('kind'in packet)||packet.kind!==TITLE2_OPERATION_KIND)return null
  visiting.add(id)
  try{
    const metadata=setting(db,title2CompanionKey(id));if(!metadata)return fail('actual companion missing')
    const decoded=decodeTitle2Envelope(row,hostJson(metadata.value)),{companion,envelope}=decoded
    if(metadata.key!==title2CompanionKey(id)||metadata.value!==hostEncode(companion)||metadata.updated_at!==companion.createdAt)return fail('companion original row differs')
    const includesHeadings=companion.scope===TITLE2_HEADING_SCOPE||companion.scope===TITLE2_SECTION_SCOPE
    if(includesHeadings||companion.scope===TITLE2_USER_HISTORY_SCOPE)assertTitle2HeadingPath(companion,envelope.result.hosts[0].after.title)
    let hasHeadingProjection=false
    const materials=companion.groups.map(group=>{
      const owner=reopenSyncedMetadataCaptureRecordOwned2(db,group.sourcePointKey),source=readSyncedMetadataCaptureRecordOwned2(db,owner)
      const original=source.sources[0],history=source.groupHistories[0]
      if(source.kind!=='synced-metadata2-read-baseline-record'||source.recordHash!==group.sourcePointHash||source.sources.length!==1||!original||!history
        ||source.workspaceScope!==companion.workspaceScope||source.recoveryEpoch!==companion.recoveryEpoch||original.wire.id!==group.groupId||original.wire.creationId!==group.creationId
        ||original.wire.createdAt!==group.createdAt||original.revision!==group.sourceRevision||original.topologyRevision!==group.sourceTopologyRevision
        ||history.position!==(group.userHistory?.position??0)||history.history.cursor!==group.sourceHistoryCursor
        ||!group.userHistory&&(history.history.undoToken!==null||history.history.redoToken!==null))return fail('group side lacks its exact original source point')
      const owners=new Map<string,{documentId:string;createdAt:string}>()
      for(const target of source.capture.targets)if(target.status==='current-block'&&target.owner==='document')owners.set(target.blockId,{documentId:target.ownerId,createdAt:target.createdAt})
      const workingDestinations=destinations(companion,companion.workingPath),afterDestinations=destinations(companion,companion.afterPath)
      for(const destination of [workingDestinations,afterDestinations]){
        for(const binding of original.wire.bindings)if(binding.target.kind==='document'){
          const path=destination.get(binding.target.id)
          if(path&&path.beforePath!==path.afterPath){const target=source.capture.targets.find(target=>hostEqual(target.key,{blockId:binding.blockId,from:binding.from,to:binding.to,raw:binding.raw,syntax:binding.syntax}))
            if(!target||target.status!=='current-document'||target.documentId!==path.documentId||target.documentCreatedAt!==path.beforeCreatedAt||target.path!==path.beforePath)return fail('changed document target lacks its exact captured current birth/path')}
        }
      }
      if(includesHeadings){
        const workingTitle=companion.intent.kind==='apply'?companion.intent.workingTitle:companion.persistedTitle
        const host=envelope.result.hosts[0]
        const w=projectTitle2HeadingDestinations(companion,source,workingDestinations,workingTitle,host.logicalBefore)
        const a=projectTitle2HeadingDestinations(companion,source,afterDestinations,host.after.title,host.logicalBefore)
        hasHeadingProjection ||= w||a
      }
      const expectedWorking=projectSyncedMetadataGroupLinks2(original.wire,workingDestinations,owners)
      const expectedAfter=projectSyncedMetadataGroupLinks2(original.wire,afterDestinations,owners)
      const working=includesHeadings?expectedWorking.after:projectTitle2GroupSide(original.wire,group.workingEdits)
      const after=includesHeadings?expectedAfter.after:projectTitle2GroupSide(original.wire,group.afterEdits)
      if(hostHash(working)!==group.workingHash||hostHash(after)!==group.afterHash)return fail('group side material hashes differ')
      if(includesHeadings&&(!hostEqual(group.workingEdits,expectedWorking.edits)||!hostEqual(group.afterEdits,expectedAfter.edits)
        ||[...group.workingEdits,...group.afterEdits].some(edit=>{
          const binding=original.wire.bindings.find(item=>hostEqual(title2BindingKey(item),edit.key))
          return !binding||binding.target.kind==='unresolved-url'||binding.target.state!=='live'
            ||/^heading-[1-6]$/.test(original.wire.blocks.find(block=>block.id===edit.blockId)?.type??'')
        }))
        ||!hostEqual(working,expectedWorking.after)||!hostEqual(after,expectedAfter.after))return fail('recorded group fields are not the real typed destination projection')
      const ack=envelope.result.groups.find(item=>item.groupId===group.groupId)
      if(!ack||ack.creationId!==group.creationId||ack.createdAt!==group.createdAt||ack.revision!==group.afterRevision||ack.topologyRevision!==group.sourceTopologyRevision
        ||!hostEqual(ack.history,history.history)
        ||!hostEqual(after,{kind:'synced-group',id:ack.groupId,creationId:ack.creationId,createdAt:ack.createdAt,origin:ack.origin,blocks:ack.blocks,bindings:ack.bindings}))return fail('group ACK does not equal its reconstructed exact final side')
      const historyProjection=group.userHistory
      let userHistory:ReturnType<typeof replayTitle2UserHistory>|undefined
      let userHistoryDepth=0
      if(historyProjection){
        for(const [proof,entry] of [[history.undoSide,historyProjection.rows[historyProjection.position-1]],
          [history.redoSide,historyProjection.rows[historyProjection.position]]] as const){
          if(Boolean(proof)!==Boolean(entry)||proof&&(proof.id!==entry.original.id
            ||proof.rowHash!==entry.originalHash||proof.beforeHash!==entry.original.before_hash||proof.afterHash!==entry.original.after_hash))
            return fail('effective history projection does not continue its exact captured SQL tail')
        }
        const reference=historyProjection.previous
        let prior:Title2PriorHistory|undefined
        if(reference){
          const previous=readOriginalTitle2Operation(db,reference.operationId,visiting,verified)
          const member=previous?.materials.find(item=>item.group.groupId===group.groupId)
          if(!previous||!member?.userHistory||previous.companion.companionHash!==reference.companionHash
            ||previous.companion.workspaceScope!==companion.workspaceScope||previous.companion.recoveryEpoch!==companion.recoveryEpoch
            ||Date.parse(previous.companion.createdAt)>Date.parse(companion.createdAt)
            ||member.group.creationId!==group.creationId||member.group.createdAt!==group.createdAt||!hostEqual(member.before.origin,original.wire.origin))
            return fail('previous canonical history projection has no exact immutable original owner')
          prior={reference,sides:member.userHistory,depth:member.userHistoryDepth}
        }
        userHistoryDepth=(prior?.depth??0)+1
        userHistory=replayTitle2UserHistory(historyProjection,original.wire,after,history.history,afterDestinations,owners,prior)
        const rowsById=new Map(userHistory.map(item=>[item.row.id,item.row]))
        const retained=readHistoricalExactRows<OriginalHistoryRow>(db,'synced_group_history',
          ['id','group_id','position','before_json','after_json','before_hash','after_hash','created_at'],
          'id IN (SELECT value FROM json_each(?))',[JSON.stringify([...rowsById.keys()])])
        if(retained.some(row=>!hostEqual(row,rowsById.get(row.id))))return fail('retained canonical history original differs from its exact archived row')
      }
      return{group,sourcePoint:source,before:original.wire,working,after,userHistory,userHistoryDepth}
    })
    if(includesHeadings&&!hasHeadingProjection)return fail('heading companion lacks an original heading projection')
    let journal:SyncedHostHistoryBranchRow|null=null,initialOperationId:string|null=null
    let journalPins:Title2JournalPin[]=[]
    if(companion.historyToken!==null){
      const pointerRow=setting(db,title2JournalKey(companion.historyToken));if(!pointerRow)return fail('journal metadata2 pointer missing')
      const pointer=decodeTitle2JournalPointer(hostJson(pointerRow.value))
      if(pointerRow.value!==hostEncode(pointer)||pointer.historyToken!==companion.historyToken)return fail('journal pointer original bytes differ')
      journal=readHistoricalExactRows<SyncedHostHistoryBranchRow>(db,'synced_host_history',['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],'id=?',[companion.historyToken])[0]??null
      if(!journal||title2Hash({journal})!==pointer.journalHash)return fail('original host journal missing/changed')
      const raw=decodeHostJournal(journal)
      if(raw.input.mode!=='host-final'||raw.before.length!==1||raw.before[0].documentId!==companion.hostId||raw.after[0].documentId!==companion.hostId)return fail('journal participant/mode differs')
      // Immutable data support uses all raw W/A references, including groups
      // outside metadata URI maintenance. It is not a current execution permit.
      journalPins=readHistoricalExactRows<Title2JournalPin>(db,'synced_group_pins',['group_id','kind','pin_id','created_at'],'kind=? AND pin_id=?',['host-history',journal.id])
      const pinsByGroup=new Map(journalPins.map(pin=>[pin.group_id,pin]))
      if(journalPins.length!==raw.groups.length||raw.groups.some(group=>{const pin=pinsByGroup.get(group.groupId)
        return!pin||pin.kind!=='host-history'||pin.pin_id!==journal!.id||pin.created_at!==journal!.created_at
      }))return fail('original host-history pin closure missing/changed')
      initialOperationId=pointer.initialOperationId
      if(companion.intent.kind==='apply'){
        if(pointer.initialOperationId!==id||pointer.companionHash!==companion.companionHash||journal.created_at!==companion.createdAt
          ||raw.input.clientOperationId!==id||raw.before[0].content.title!==companion.intent.workingTitle||raw.after[0].content.title!==companion.intent.afterTitle
          ||!hostEqual(raw.before[0].content,envelope.result.hosts[0].logicalBefore))return fail('initial journal is not this raw W/A action')
      }else{
        const initial=readOriginalTitle2Operation(db,pointer.initialOperationId,visiting,verified)
        if(!initial||initial.companion.intent.kind!=='apply'||initial.companion.historyToken!==companion.historyToken
          ||companion.initialCompanion?.key!==title2CompanionKey(pointer.initialOperationId)||companion.initialCompanion.hash!==initial.companion.companionHash
          ||pointer.companionHash!==initial.companion.companionHash||companion.hostCreatedAt!==initial.companion.hostCreatedAt
          ||companion.workspaceScope!==initial.companion.workspaceScope||companion.recoveryEpoch!==initial.companion.recoveryEpoch)return fail('restore does not bind its original metadata2 action')
      }
    }else if(companion.intent.kind!=='apply'||companion.rawLogicalChange)return fail('missing logical journal')
    const value={row,metadata,...decoded,materials,journal,journalPins,initialOperationId}
    verified.set(id,value)
    return value
  }finally{visiting.delete(id)}
}
export function readTitle2JournalOriginalOwned(db:Database.Database,token:string){
  owned(db);if(!isSyncedUuid(token))return fail('journal UUID invalid')
  const row=setting(db,title2JournalKey(token));if(!row)return null
  const pointer=decodeTitle2JournalPointer(hostJson(row.value)),initial=readTitle2OriginalOperationOwned(db,pointer.initialOperationId)
  if(!initial||initial.companion.intent.kind!=='apply'||initial.companion.historyToken!==token||initial.companion.companionHash!==pointer.companionHash
    ||row.value!==hostEncode(pointer))return fail('journal original pointer does not bind an actual initial action')
  return{row,pointer,initial}
}
export function readTitle2GroupHeadOriginalOwned(db:Database.Database,groupId:string){
  owned(db);const row=setting(db,title2GroupHeadKey(groupId));if(!row)return null
  const head=decodeTitle2GroupHead(hostJson(row.value)),original=readTitle2OriginalOperationOwned(db,head.operationId)
  const member=original?.materials.find(item=>item.group.groupId===groupId)
  if(!member||row.value!==hostEncode(head)||head.groupId!==groupId||head.companionHash!==original!.companion.companionHash||head.creationId!==member.group.creationId
    ||head.groupCreatedAt!==member.group.createdAt||head.revision!==member.group.afterRevision||head.topologyRevision!==member.group.sourceTopologyRevision
    ||head.wireHash!==member.group.afterHash||head.historyCursor!==member.group.sourceHistoryCursor||head.historyPosition!==(member.group.userHistory?.position??0)
    ||row.updated_at!==original!.companion.createdAt)return fail('last metadata head lacks its exact actual original operation')
  const captured=new Map(member.sourcePoint.capture.targets.flatMap(target=>target.status==='current-heading'
    ?[[hostEncode(target.key),target] as const]:[]))
  const headingWitnesses=member.before.bindings.flatMap((binding,index)=>{
    const after=member.after.bindings[index].target,source=captured.get(hostEncode(title2BindingKey(binding)))
    if(!source||after.kind!=='heading'||after.state!=='live'||after.documentId!==source.documentId)return[]
    return[{documentId:source.documentId,documentCreatedAt:source.documentCreatedAt,slug:after.slug,heading:source.heading}]
  })
  return{row,head,headingWitnesses,userHistory:member.userHistory,userHistoryDepth:member.userHistoryDepth,
    workspaceScope:original!.companion.workspaceScope,recoveryEpoch:original!.companion.recoveryEpoch}
}
/** Group edits consume projected sides only through today's verified title
 * head. The original immutable row is still checked by the actual executor. */
export function readTitle2EffectiveGroupHistoryOwned(db:Database.Database,group:SyncedGroupSnapshot){
  if(db.pragma('main.user_version',{simple:true})!==27)return new Map<string,ReturnType<typeof replayTitle2UserHistory>[number]>()
  const head=readTitle2GroupHeadOriginalOwned(db,group.groupId)
  if(!head?.userHistory)return new Map<string,ReturnType<typeof replayTitle2UserHistory>[number]>()
  const workspace=db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as {workspace_scope:string;recovery_epoch:string}|undefined
  if(!workspace||head.head.creationId!==group.creationId||head.head.groupCreatedAt!==group.createdAt||head.workspaceScope!==workspace.workspace_scope
    ||head.recoveryEpoch!==workspace.recovery_epoch)return new Map<string,ReturnType<typeof replayTitle2UserHistory>[number]>()
  return new Map(head.userHistory.map(row=>[row.row.id,row]))
}
export function title2OriginalSupportsOwned(db:Database.Database,id:string){
  const original=readTitle2OriginalOperationOwned(db,id);if(!original)return fail('actual metadata2 operation required')
  const supports=[historicalMetadataLocator(original.metadata)]
  const previous=new Set<string>()
  for(const material of original.materials){const row=operation(db,material.group.sourcePointKey);if(!row)return fail('source point disappeared');supports.push(historicalOperationLocator(row))
    const id=material.group.userHistory?.previous?.operationId
    if(id&&!previous.has(id)){
      const parent=operation(db,id),metadata=setting(db,title2CompanionKey(id))
      if(!parent||!metadata)return fail('previous history projection support disappeared')
      previous.add(id);supports.push(historicalOperationLocator(parent),historicalMetadataLocator(metadata))
    }
  }
  if(original.journal){supports.push(historicalRowLocator('synced_host_history',[original.journal.id],original.journal))
    const pointer=setting(db,title2JournalKey(original.journal.id));if(!pointer)return fail('journal pointer disappeared');supports.push(historicalMetadataLocator(pointer))
    for(const pin of original.journalPins)supports.push(historicalRowLocator('synced_group_pins',[pin.group_id,pin.kind,pin.pin_id],pin))}
  if(original.companion.initialCompanion){const row=setting(db,original.companion.initialCompanion.key);if(!row)return fail('initial companion disappeared');supports.push(historicalMetadataLocator(row))}
  return{original,supports}
}
/** Complete reserved metadata scan; no unknown title version is treated as
 * ordinary opaque settings. Heads remain historical indexes after later user
 * edits, so original admission does not demand that today's body equals them. */
export function assertTitle2OriginalFamilyOwned(db:Database.Database):HistoricalMetadataRow[]{
  owned(db)
  const rows=readHistoricalExactRows<HistoricalMetadataRow>(db,'app_settings',['key','value','updated_at'],"lower(key) LIKE 'synced.metadata2.title%'")
  for(const row of rows){
    if(row.key.startsWith(TITLE2_COMPANION_PREFIX)){const id=row.key.slice(TITLE2_COMPANION_PREFIX.length);if(!readTitle2OriginalOperationOwned(db,id))return fail('orphan title companion')}
    else if(row.key.startsWith(TITLE2_JOURNAL_PREFIX)){if(!readTitle2JournalOriginalOwned(db,row.key.slice(TITLE2_JOURNAL_PREFIX.length)))return fail('orphan title journal pointer')}
    else if(row.key.startsWith(TITLE2_GROUP_HEAD_PREFIX)){if(!readTitle2GroupHeadOriginalOwned(db,row.key.slice(TITLE2_GROUP_HEAD_PREFIX.length)))return fail('orphan title head')}
    else return fail('unknown title metadata family/version/case')
  }
  return rows
}
