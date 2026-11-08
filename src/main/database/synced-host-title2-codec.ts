import type { SyncedGroupWire, SyncedStructureApplied, SyncedRestoreHostInput, SyncedGroupGuard, SyncedInstanceGuard } from '../../shared/synced-blocks'
import type { DocumentDetail } from '../../shared/contracts'
import { isNativeSectionHeading } from '../../shared/document-rename-admission'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, syncedPlainRecord, validateSyncedGroupSnapshot, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { validateSyncedStructureInput, validateSyncedRestoreHostInput } from '../../shared/syncedBlockInputs'
import { projectSyncedGroupBudget } from '../../shared/syncedBlockPortable'
import { collectSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import { hostEncode, hostHash, validateHostContent } from './synced-host-journal'
import { hostJson, hostTime, validateHostDocumentDetail, type HostContent } from './synced-host-document-read'
import { projectSyncedMetadataCell2, type SyncedMetadataCellEdit2 } from './synced-metadata-cell2'
import type { OriginalHistoryRow } from './synced-group-history-original'

export const TITLE2_OPERATION_KIND='synced-host-title-metadata2-operation'
export const TITLE2_COMPANION_PREFIX='synced.metadata2.title-transition.v2.'
export const TITLE2_JOURNAL_PREFIX='synced.metadata2.title-journal.v2.'
export const TITLE2_GROUP_HEAD_PREFIX='synced.metadata2.title-group-head.v2.'
export const TITLE2_SCOPE='pure-title-existing-forest-no-heading-lineage-no-group-user-history'
export const TITLE2_HEADING_SCOPE='pure-title-existing-forest-current-heading-no-group-user-history'
export const TITLE2_SECTION_SCOPE='pure-existing-host-section-heading-no-group-user-history'
export const TITLE2_USER_HISTORY_SCOPE='pure-title-existing-forest-document-and-block-user-history'
export const TITLE2_MAX_HISTORY_ROWS=128
export const TITLE2_MAX_HISTORY_BYTES=16*1024*1024
export const TITLE2_MAX_HISTORY_PROJECTIONS=8
export type Title2Row={client_operation_id:string;request_hash:string;result_json:string;created_at:string}
export type Title2Edit=SyncedMetadataCellEdit2&{blockId:string}
export type Title2HistoryPredecessor={operationId:string;companionHash:string}
export type Title2HistoryProjection={position:number;rows:Array<{original:OriginalHistoryRow;originalHash:string;beforeHash:string;afterHash:string}>;
  previous?:Title2HistoryPredecessor}
export type Title2Group={groupId:string;creationId:string;createdAt:string;sourcePointKey:string;sourcePointHash:string;
  sourceRevision:string;sourceTopologyRevision:string;sourceHistoryCursor:string;workingEdits:Title2Edit[];afterEdits:Title2Edit[];
  workingHash:string;afterHash:string;afterRevision:string;userHistory?:Title2HistoryProjection}
export type Title2Subtree={id:string;createdAt:string;parentId:string|null;title:string;path:string;sortOrder:number}
export type Title2Effect={documentId:string;createdAt:string;path:string;contentHash:string}
export type Title2SectionEdit={blockId:string;createdAt:string;before:string;after:string}
export type Title2ApplyIntent={kind:'apply';reason:'source-apply'|'selection-edit'|'drop'|'paste';hostId:string;expectedPersistedUpdatedAt:string;
  workingTitle:string;afterTitle:string;groups:SyncedGroupGuard[];expectedInstances:SyncedInstanceGuard[]}
export interface Title2Companion {
  kind:'synced-host-title-metadata2-companion';version:2;operationId:string;workspaceScope:string;recoveryEpoch:string;createdAt:string;
  scope:typeof TITLE2_SCOPE|typeof TITLE2_HEADING_SCOPE|typeof TITLE2_SECTION_SCOPE|typeof TITLE2_USER_HISTORY_SCOPE;
  intent:Title2ApplyIntent|{kind:'restore';input:SyncedRestoreHostInput};requestHash:string;
  hostId:string;hostCreatedAt:string;hostParentId:string|null;subtree:Title2Subtree[];
  historyToken:string|null;initialCompanion:{key:string;hash:string}|null;rawLogicalChange:boolean;
  persistedTitle:string;persistedPath:string;workingPath:string;afterPath:string;workingContentHash:string;afterContentHash:string;
  workingEffects:Title2Effect[];afterEffects:Title2Effect[];groups:Title2Group[];
  sectionEdit?:Title2SectionEdit;
  projection:'owned-sql-savepoint-main-maintenance';businessOperationCommitted:true;writePermit:false;companionHash:string
}
export type Title2Envelope={kind:typeof TITLE2_OPERATION_KIND;version:2;companionKey:string;companionHash:string;result:SyncedStructureApplied}
const fail=(message:string):never=>{throw new Error('Metadata2 title record invalid: '+message)}
export const title2Hash=(value:unknown)=>hostHash({domain:'knowbook.synced.host-title.metadata2.v2',value})
const uuid=(value:unknown):string=>isSyncedUuid(value)?value:fail('UUID required')
const opaque=(value:unknown):string=>isSyncedBlockId(value)?value:fail('identity required')
const hash=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail('SHA256 required')
const text=(value:unknown):string=>typeof value==='string'?value:fail('text required')
function unique<T>(value:unknown,read:(value:unknown)=>T,key:(value:T)=>string):T[]{
  if(!Array.isArray(value))return fail('array required');const items=value.map(read)
  if(new Set(items.map(key)).size!==items.length)return fail('duplicate item');return items
}
export const title2CompanionKey=(operationId:string)=>TITLE2_COMPANION_PREFIX+uuid(operationId)
export const title2JournalKey=(historyToken:string)=>TITLE2_JOURNAL_PREFIX+uuid(historyToken)
export const title2GroupHeadKey=(groupId:string)=>TITLE2_GROUP_HEAD_PREFIX+uuid(groupId)
export function title2RequestHash(method:'apply'|'restore',input:unknown):string{return title2Hash({method,input})}
function edit(value:unknown):Title2Edit{
  assertSyncedShape(value,['blockId','key','after']);assertSyncedShape(value.key,['blockId','from','to','raw','syntax'])
  if(value.blockId!==value.key.blockId||!Number.isSafeInteger(value.key.from)||!Number.isSafeInteger(value.key.to)
    ||(value.key.from as number)<0||(value.key.to as number)<(value.key.from as number))return fail('invalid exact edit Key')
  const syntax=text(value.key.syntax)
  if(!['markdown','wiki'].includes(syntax))return fail('unknown binding syntax')
  return{blockId:opaque(value.blockId),key:{blockId:opaque(value.key.blockId),from:value.key.from as number,to:value.key.to as number,raw:text(value.key.raw),syntax:syntax as Title2Edit['key']['syntax']},after:text(value.after)}
}
/** Reconstruct only exact recorded navigation replacements. No path/URL
 * resolver or mapper grants a target, and every untouched original Key shifts
 * through the same complete source cell projection. */
export function projectTitle2GroupSide(before:SyncedGroupWire,edits:readonly Title2Edit[]):SyncedGroupWire{
  const original=validateSyncedGroupWire(before),keys=new Map(original.bindings.map(binding=>[hostEncode([binding.blockId,binding.from,binding.to,binding.raw,binding.syntax]),binding]))
  const used=new Set<string>()
  for(const item of edits){const key=hostEncode([item.key.blockId,item.key.from,item.key.to,item.key.raw,item.key.syntax])
    if(item.blockId!==item.key.blockId||!keys.has(key)||used.has(key))return fail('edit has no unique complete original Key');used.add(key)
    const target=keys.get(key)!.target
    if(target.kind!=='document'&&target.kind!=='block'||target.state!=='live')return fail('only currently captured live document/block targets belong to this first domain')
    if(/^heading-[1-6]$/.test(original.blocks.find(block=>block.id===item.blockId)?.type??''))return fail('heading edit needs lineage')
  }
  const cells=new Map(original.blocks.map(block=>[block.id,projectSyncedMetadataCell2(block.content,original.bindings.filter(binding=>binding.blockId===block.id)
    .map(({blockId,from,to,raw,syntax})=>({blockId,from,to,raw,syntax})),edits.filter(edit=>edit.blockId===block.id))]))
  const blocks=original.blocks.map(block=>({...block,content:cells.get(block.id)!.text})),bindings=original.bindings.map(binding=>({
    ...cells.get(binding.blockId)!.project(binding),target:binding.target}))
  const after=validateSyncedGroupWire({...original,blocks,bindings}),parsed=collectSyncedBindingOccurrences(after.origin,after.blocks)
  const final=new Set(parsed.map(item=>hostEncode([item.blockId,item.from,item.to,item.raw,item.syntax])))
  if(final.size!==parsed.length||bindings.length!==final.size||bindings.some(binding=>!final.has(hostEncode([binding.blockId,binding.from,binding.to,binding.raw,binding.syntax]))))return fail('final parser closure differs')
  projectSyncedGroupBudget(after);return after
}
export function decodeTitle2Companion(value:unknown):Title2Companion{
  assertSyncedShape(value,['kind','version','operationId','workspaceScope','recoveryEpoch','createdAt','scope','intent','requestHash','hostId','hostCreatedAt','hostParentId','subtree',
    'historyToken','initialCompanion','rawLogicalChange','persistedTitle','persistedPath','workingPath','afterPath','workingContentHash','afterContentHash','workingEffects','afterEffects','groups',
    'projection','businessOperationCommitted','writePermit','companionHash'],['sectionEdit'])
  if(value.kind!=='synced-host-title-metadata2-companion'||value.version!==2||value.scope!==TITLE2_SCOPE&&value.scope!==TITLE2_HEADING_SCOPE&&value.scope!==TITLE2_SECTION_SCOPE&&value.scope!==TITLE2_USER_HISTORY_SCOPE
    ||value.projection!=='owned-sql-savepoint-main-maintenance'||value.businessOperationCommitted!==true||value.writePermit!==false||typeof value.rawLogicalChange!=='boolean')return fail('domain/flags differ')
  const operationId=uuid(value.operationId),hostId=opaque(value.hostId)
  uuid(value.workspaceScope);uuid(value.recoveryEpoch);hostTime(value.createdAt);hostTime(value.hostCreatedAt);if(value.hostParentId!==null)opaque(value.hostParentId)
  const intent=value.intent
  if(!syncedPlainRecord(intent)||!Object.hasOwn(intent,'kind'))return fail('intent required')
  if(intent.kind==='apply'){
    assertSyncedShape(intent,['kind','reason','hostId','expectedPersistedUpdatedAt','workingTitle','afterTitle','groups','expectedInstances'])
    if(intent.hostId!==hostId||!['source-apply','selection-edit','drop','paste'].includes(String(intent.reason)))return fail('apply intent differs')
    hostTime(intent.expectedPersistedUpdatedAt);text(intent.workingTitle);text(intent.afterTitle)
    if(!Array.isArray(intent.groups)||!Array.isArray(intent.expectedInstances))return fail('intent guards required')
  }else if(intent.kind==='restore'){
    assertSyncedShape(intent,['kind','input']);const input=validateSyncedRestoreHostInput(intent.input)
    if(input.clientOperationId!==operationId||input.expectedHosts.length!==1||input.expectedHosts[0].documentId!==hostId)return fail('restore intent differs')
  }else return fail('unknown intent kind')
  const subtree=unique(value.subtree,raw=>{assertSyncedShape(raw,['id','createdAt','parentId','title','path','sortOrder'])
    if(!Number.isSafeInteger(raw.sortOrder))return fail('subtree order invalid');return{id:opaque(raw.id),createdAt:hostTime(raw.createdAt),parentId:raw.parentId===null?null:opaque(raw.parentId),title:text(raw.title),path:text(raw.path),sortOrder:raw.sortOrder as number}},item=>item.id)
  if(!subtree.some(item=>item.id===hostId&&item.createdAt===value.hostCreatedAt&&item.parentId===value.hostParentId))return fail('root not in actual subtree')
  if(value.historyToken!==null)uuid(value.historyToken)
  if(value.initialCompanion!==null){assertSyncedShape(value.initialCompanion,['key','hash']);if(!text(value.initialCompanion.key).startsWith(TITLE2_COMPANION_PREFIX))return fail('initial companion key invalid');hash(value.initialCompanion.hash)}
  if((intent.kind==='apply')!==(value.initialCompanion===null))return fail('initial/restore companion reference differs')
  for(const field of ['persistedTitle','persistedPath','workingPath','afterPath'])text(value[field])
  if(value.scope===TITLE2_SECTION_SCOPE){
    assertSyncedShape(value.sectionEdit,['blockId','createdAt','before','after'])
    opaque(value.sectionEdit.blockId);hostTime(value.sectionEdit.createdAt)
    if(text(value.sectionEdit.before)===text(value.sectionEdit.after)||intent.kind!=='apply'||intent.workingTitle!==value.persistedTitle
      ||intent.afterTitle!==value.persistedTitle||value.workingPath!==value.persistedPath||value.afterPath!==value.persistedPath
      ||value.historyToken!==null||value.rawLogicalChange)return fail('section heading operation scope differs')
  }else if(value.sectionEdit!==undefined)return fail('section heading proof outside its own scope')
  for(const field of ['requestHash','workingContentHash','afterContentHash'])hash(value[field])
  const effects=(raw:unknown)=>unique(raw,item=>{assertSyncedShape(item,['documentId','createdAt','path','contentHash']);return{documentId:opaque(item.documentId),createdAt:hostTime(item.createdAt),path:text(item.path),contentHash:hash(item.contentHash)}},item=>item.documentId)
  effects(value.workingEffects);effects(value.afterEffects)
  const groups=unique(value.groups,raw=>{assertSyncedShape(raw,['groupId','creationId','createdAt','sourcePointKey','sourcePointHash','sourceRevision','sourceTopologyRevision','sourceHistoryCursor','workingEdits','afterEdits','workingHash','afterHash','afterRevision'],['userHistory'])
    uuid(raw.groupId);uuid(raw.creationId);hostTime(raw.createdAt);text(raw.sourcePointKey);hash(raw.sourcePointHash);uuid(raw.sourceRevision);uuid(raw.sourceTopologyRevision);uuid(raw.sourceHistoryCursor)
    hash(raw.workingHash);hash(raw.afterHash);uuid(raw.afterRevision)
    unique(raw.workingEdits,edit,item=>hostEncode(item.key));unique(raw.afterEdits,edit,item=>hostEncode(item.key))
    if(raw.userHistory!==undefined){
      assertSyncedShape(raw.userHistory,['position','rows'],['previous'])
      const {position,rows}=raw.userHistory
      if(!Array.isArray(rows)||rows.length<1||rows.length>TITLE2_MAX_HISTORY_ROWS||!Number.isSafeInteger(position)
        ||(position as number)<0||(position as number)>rows.length||Buffer.byteLength(hostEncode(rows))>TITLE2_MAX_HISTORY_BYTES)return fail('user-history bounds differ')
      unique(rows,item=>{assertSyncedShape(item,['original','originalHash','beforeHash','afterHash'])
        assertSyncedShape(item.original,['id','group_id','position','before_json','after_json','before_hash','after_hash','created_at'])
        hash(item.originalHash);hash(item.beforeHash);hash(item.afterHash);return uuid(item.original.id)},item=>item)
      if(raw.userHistory.previous!==undefined){
        assertSyncedShape(raw.userHistory.previous,['operationId','companionHash'])
        if(uuid(raw.userHistory.previous.operationId)===operationId)return fail('user-history projection cannot refer to itself')
        hash(raw.userHistory.previous.companionHash)
      }
    }
    return raw
  },item=>String(item.groupId))
  if((value.scope===TITLE2_USER_HISTORY_SCOPE)!==groups.some(group=>group.userHistory!==undefined)
    ||value.scope===TITLE2_USER_HISTORY_SCOPE&&(intent.kind!=='apply'||intent.workingTitle!==intent.afterTitle||value.historyToken!==null))return fail('user-history operation scope differs')
  const histories=groups.flatMap(group=>group.userHistory?[group.userHistory as Title2HistoryProjection]:[])
  if(histories.reduce((count,item)=>count+item.rows.length,0)>TITLE2_MAX_HISTORY_ROWS
    ||Buffer.byteLength(hostEncode(histories))>TITLE2_MAX_HISTORY_BYTES)return fail('user-history aggregate budget differs')
  const {companionHash,...body}=value
  if(hash(companionHash)!==title2Hash(body))return fail('companion self hash differs')
  return value as unknown as Title2Companion
}
function result(value:unknown):SyncedStructureApplied{
  assertSyncedShape(value,['status','operationId','historyToken','replayed','hosts','groups','affectedInstanceIds','blockIdMap'])
  if(value.status!=='applied'&&value.status!=='noop'||value.replayed!==false)return fail('ACK status/replayed invalid')
  uuid(value.operationId);if(value.historyToken!==null)uuid(value.historyToken)
  const hosts=unique(value.hosts,raw=>{assertSyncedShape(raw,['documentId','logicalBefore','logicalBeforeHash','after'])
    const logicalBefore=validateHostContent(raw.logicalBefore),after=validateHostDocumentDetail(raw.after)
    if(after.id!==opaque(raw.documentId)||hash(raw.logicalBeforeHash)!==hostHash(logicalBefore))return fail('ACK complete raw W differs')
    return{documentId:after.id,logicalBefore,logicalBeforeHash:raw.logicalBeforeHash as string,after}
  },item=>item.documentId)
  const groups=unique(value.groups,validateSyncedGroupSnapshot,item=>item.groupId)
  if(hosts.length!==1||!Array.isArray(value.affectedInstanceIds)||value.affectedInstanceIds.length||!Array.isArray(value.blockIdMap)||value.blockIdMap.length)return fail('pure title ACK structural effects differ')
  const ids=new Set(groups.map(group=>group.groupId))
  for(const host of hosts)for(const block of [...host.logicalBefore.blocks,...host.after.blocks])if(block.type==='synced-block'){
    const parsed=hostJson(block.content) as {groupId?:unknown};if(typeof parsed.groupId!=='string'||!ids.has(parsed.groupId))return fail('ACK reference group closure incomplete')
  }
  return{status:value.status,operationId:value.operationId as string,historyToken:value.historyToken as string|null,replayed:false,hosts,groups,affectedInstanceIds:[],blockIdMap:[]}
}
/** The v2 envelope keeps raw W separate from the actual projected after view.
 * Unlike the old v1 ACK, P!=W=A may change physical navigation hints without
 * minting a logical Undo token. The old v1 validator/hash is never widened. */
export function decodeTitle2Envelope(row:Title2Row,companionValue:unknown):{envelope:Title2Envelope;companion:Title2Companion}{
  const value=hostJson(row.result_json);assertSyncedShape(value,['kind','version','companionKey','companionHash','result'])
  if(value.kind!==TITLE2_OPERATION_KIND||value.version!==2)return fail('operation envelope kind/version invalid')
  const companion=decodeTitle2Companion(companionValue),ack=result(value.result)
  if(row.client_operation_id!==companion.operationId||ack.operationId!==companion.operationId||row.request_hash!==companion.requestHash||row.created_at!==companion.createdAt
    ||value.companionKey!==title2CompanionKey(companion.operationId)||value.companionHash!==companion.companionHash||ack.hosts[0].documentId!==companion.hostId
    ||hostHash(content(ack.hosts[0].after))!==companion.afterContentHash||ack.hosts[0].after.path!==companion.afterPath||ack.hosts[0].after.updatedAt!==companion.createdAt
    ||ack.historyToken!==companion.historyToken||hostEncode(value)!==row.result_json)return fail('actual operation/companion/ACK binding differs')
  if(companion.intent.kind==='apply'){
    const intent=companion.intent,before=ack.hosts[0].logicalBefore
    const input=validateSyncedStructureInput({clientOperationId:companion.operationId,mode:'host-final',reason:intent.reason,
      hostsWorkingBefore:[{documentId:companion.hostId,expectedPersistedUpdatedAt:intent.expectedPersistedUpdatedAt,workingBefore:before}],
      finalAfter:[{documentId:companion.hostId,...before,title:intent.afterTitle}],groups:intent.groups,expectedInstances:intent.expectedInstances,newRefSources:[]})
    if(before.title!==intent.workingTitle||title2RequestHash('apply',input)!==row.request_hash||companion.rawLogicalChange!==(intent.workingTitle!==intent.afterTitle)
      ||companion.rawLogicalChange!==(ack.historyToken!==null))return fail('raw request W/A and logical history differ')
    if(companion.sectionEdit){
      const edit=companion.sectionEdit,rawBlock=before.blocks.find(block=>block.id===edit.blockId),saved=ack.hosts[0].after.blocks.find(block=>block.id===edit.blockId)
      if(!rawBlock||!saved||!isNativeSectionHeading(rawBlock.type)||saved.type!==rawBlock.type
        ||rawBlock.content!==edit.after||saved.content!==edit.after)return fail('section heading content differs from its exact intent/ACK')
    }
  }else if(title2RequestHash('restore',companion.intent.input)!==row.request_hash||ack.historyToken===null||!companion.rawLogicalChange)return fail('restore request/journal binding differs')
  return{envelope:value as unknown as Title2Envelope,companion}
}
export const content=(document:DocumentDetail):HostContent=>({title:document.title,summary:document.summary,blocks:document.blocks.map(({sortOrder:_sortOrder,...block})=>block)})
export function makeTitle2Companion(value:Omit<Title2Companion,'companionHash'>):Title2Companion{
  return decodeTitle2Companion({...value,companionHash:title2Hash(value)})
}
