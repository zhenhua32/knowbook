// Structural validation for the owned heading-title v3 business records.
// Decoded DATA is not a write capability.
import type { SyncedStructureApplied, SyncedRestoreHostInput, SyncedGroupGuard, SyncedInstanceGuard } from '../../shared/synced-blocks'
import type { DocumentDetail } from '../../shared/contracts'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, syncedPlainRecord, validateSyncedGroupSnapshot } from '../../shared/syncedBlockValidation'
import { validateSyncedStructureInput, validateSyncedRestoreHostInput, validateSyncedBindingKey } from '../../shared/syncedBlockInputs'
import { validateHeadingTitleOrdinaryStyleFacts3, type HeadingTitleOrdinaryStyleFact3 } from './synced-heading-title-style-facts3'
import type { HeadingTitleOrdinaryWiki3 } from './synced-heading-title-point3'
import { headingTitleWikiFactScopes3 } from './synced-heading-title-wiki-style3'
import { validateHeadingTitleOrdinaryDocuments3, type HeadingTitleOrdinaryDocument3 } from './synced-heading-title-ordinary3'
import { hostEncode, hostHash, validateHostContent } from './synced-host-journal'
import { hostJson, hostTime, validateHostDocumentDetail, type HostContent } from './synced-host-document-read'
import type { SyncedMetadataCellEdit2 } from './synced-metadata-cell2'

export const HEADING_TITLE3_OPERATION_KIND='synced-host-heading-title-metadata3-operation'
export const HEADING_TITLE3_COMPANION_PREFIX='synced.heading.title-transition.v3.'
export const HEADING_TITLE3_JOURNAL_PREFIX='synced.heading.title-journal.v3.'
export const HEADING_TITLE3_GROUP_HEAD_PREFIX='synced.heading.title-group-head.v3.'
export type HeadingTitle3Row={client_operation_id:string;request_hash:string;result_json:string;created_at:string}
export type HeadingTitle3Edit=SyncedMetadataCellEdit2&{blockId:string}
export type HeadingTitle3Group={groupId:string;creationId:string;createdAt:string;sourcePointKey:string;sourcePointHash:string;
  sourceRevision:string;sourceTopologyRevision:string;sourceHistoryCursor:string;workingEdits:HeadingTitle3Edit[];afterEdits:HeadingTitle3Edit[];
  workingHash:string;afterHash:string;afterRevision:string;
  previous:{kind:'heading-create-birth'|'heading-title-transition';operationId:string;companionHash:string}|null;
  afterPointKey:string;afterPointHash:string;ordinaryWiki:HeadingTitleOrdinaryWiki3[]}
export type HeadingTitle3Subtree={id:string;createdAt:string;parentId:string|null;title:string;path:string;sortOrder:number}
export type HeadingTitle3Effect={documentId:string;createdAt:string;path:string;contentHash:string}
export type HeadingTitle3ApplyIntent={kind:'apply';reason:'source-apply'|'selection-edit'|'drop'|'paste';hostId:string;expectedPersistedUpdatedAt:string;
  workingTitle:string;afterTitle:string;groups:SyncedGroupGuard[];expectedInstances:SyncedInstanceGuard[]}
export interface HeadingTitle3Companion {
  kind:'synced-host-heading-title-metadata3-companion';version:3;operationId:string;workspaceScope:string;recoveryEpoch:string;createdAt:string;
  scope:'pure-title-existing-forest-business-heading-key-lineage-no-group-user-history';
  intent:HeadingTitle3ApplyIntent|{kind:'restore';input:SyncedRestoreHostInput};requestHash:string;
  hostId:string;hostCreatedAt:string;hostParentId:string|null;subtree:HeadingTitle3Subtree[];
  wikiDocuments:HeadingTitleOrdinaryDocument3[];
  historyToken:string|null;initialCompanion:{key:string;hash:string}|null;rawLogicalChange:boolean;
  persistedTitle:string;persistedPath:string;workingPath:string;afterPath:string;workingContentHash:string;afterContentHash:string;
  workingEffects:HeadingTitle3Effect[];afterEffects:HeadingTitle3Effect[];ordinaryStyles:HeadingTitleOrdinaryStyleFact3[];groups:HeadingTitle3Group[];
  projection:'owned-sql-savepoint-main-maintenance';businessOperationCommitted:true;writePermit:false;companionHash:string
}
export type HeadingTitle3Envelope={kind:typeof HEADING_TITLE3_OPERATION_KIND;version:3;companionKey:string;companionHash:string;result:SyncedStructureApplied}
const fail=(message:string):never=>{throw new Error('Metadata3 heading title record invalid: '+message)}
export const headingTitle3Hash=(value:unknown)=>hostHash({domain:'knowbook.synced.host-title.metadata3.v3',value})
const uuid=(value:unknown):string=>isSyncedUuid(value)?value:fail('UUID required')
const opaque=(value:unknown):string=>isSyncedBlockId(value)?value:fail('identity required')
const hash=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail('SHA256 required')
const text=(value:unknown):string=>typeof value==='string'?value:fail('text required')
function unique<T>(value:unknown,read:(value:unknown)=>T,key:(value:T)=>string):T[]{
  if(!Array.isArray(value))return fail('array required');const items=value.map(read)
  if(new Set(items.map(key)).size!==items.length)return fail('duplicate item');return items
}
export const headingTitle3CompanionKey=(operationId:string)=>HEADING_TITLE3_COMPANION_PREFIX+uuid(operationId)
export const headingTitle3JournalKey=(historyToken:string)=>HEADING_TITLE3_JOURNAL_PREFIX+uuid(historyToken)
export const headingTitle3GroupHeadKey=(groupId:string)=>HEADING_TITLE3_GROUP_HEAD_PREFIX+uuid(groupId)
export function headingTitle3RequestHash(method:'apply'|'restore',input:unknown):string{return headingTitle3Hash({method,input})}
function edit(value:unknown):HeadingTitle3Edit{
  assertSyncedShape(value,['blockId','key','after']);assertSyncedShape(value.key,['blockId','from','to','raw','syntax'])
  if(value.blockId!==value.key.blockId||!Number.isSafeInteger(value.key.from)||!Number.isSafeInteger(value.key.to)
    ||(value.key.from as number)<0||(value.key.to as number)<(value.key.from as number))return fail('invalid exact edit Key')
  const syntax=text(value.key.syntax)
  if(!['markdown','wiki'].includes(syntax))return fail('unknown binding syntax')
  return{blockId:opaque(value.blockId),key:{blockId:opaque(value.key.blockId),from:value.key.from as number,to:value.key.to as number,raw:text(value.key.raw),syntax:syntax as HeadingTitle3Edit['key']['syntax']},after:text(value.after)}
}
// Navigation material is reconstructed by the separate exact point/lineage
// kernel. The old v2 document/block-only projector remains unchanged.
export function decodeHeadingTitle3Companion(value:unknown):HeadingTitle3Companion{
  assertSyncedShape(value,['kind','version','operationId','workspaceScope','recoveryEpoch','createdAt','scope','intent','requestHash','hostId','hostCreatedAt','hostParentId','subtree','wikiDocuments',
    'historyToken','initialCompanion','rawLogicalChange','persistedTitle','persistedPath','workingPath','afterPath','workingContentHash','afterContentHash','workingEffects','afterEffects','ordinaryStyles','groups',
    'projection','businessOperationCommitted','writePermit','companionHash'])
  if(value.kind!=='synced-host-heading-title-metadata3-companion'||value.version!==3||value.scope!=='pure-title-existing-forest-business-heading-key-lineage-no-group-user-history'
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
  if(value.initialCompanion!==null){assertSyncedShape(value.initialCompanion,['key','hash']);if(!text(value.initialCompanion.key).startsWith(HEADING_TITLE3_COMPANION_PREFIX))return fail('initial companion key invalid');hash(value.initialCompanion.hash)}
  if((intent.kind==='apply')!==(value.initialCompanion===null))return fail('initial/restore companion reference differs')
  for(const field of ['persistedTitle','persistedPath','workingPath','afterPath'])text(value[field])
  for(const field of ['requestHash','workingContentHash','afterContentHash'])hash(value[field])
  const effects=(raw:unknown)=>unique(raw,item=>{assertSyncedShape(item,['documentId','createdAt','path','contentHash']);return{documentId:opaque(item.documentId),createdAt:hostTime(item.createdAt),path:text(item.path),contentHash:hash(item.contentHash)}},item=>item.documentId)
  const workingEffects=effects(value.workingEffects),afterEffects=effects(value.afterEffects)
  const wikiDocuments=validateHeadingTitleOrdinaryDocuments3(value.wikiDocuments)
  const namingById=new Map(wikiDocuments.map(item=>[item.documentId,item]))
  for(const original of subtree){const item=namingById.get(original.id)
    if(!item||item.documentCreatedAt!==original.createdAt||item.path!==original.path||item.title!==original.title)return fail('single native Wiki naming scope differs from complete original subtree')}
  const ordinaryStyles=validateHeadingTitleOrdinaryStyleFacts3(value.ordinaryStyles,headingTitleWikiFactScopes3(wikiDocuments,subtree,hostId,value.workingPath as string,value.afterPath as string))
  for(const fact of ordinaryStyles){
    const closure=(items:HeadingTitle3Effect[],side:typeof fact.working)=>items.some(item=>item.documentId===fact.documentId&&item.createdAt===fact.documentCreatedAt&&item.path===side.sourcePath)
    if(fact.persisted.raw!==fact.working.raw&&!closure(workingEffects,fact.working)
      ||fact.persisted.raw!==fact.after.raw&&!closure(afterEffects,fact.after))return fail('ordinary style field is outside actual maintenance effects')
  }
  unique(value.groups,raw=>{assertSyncedShape(raw,['groupId','creationId','createdAt','sourcePointKey','sourcePointHash','sourceRevision','sourceTopologyRevision','sourceHistoryCursor','workingEdits','afterEdits','workingHash','afterHash','afterRevision','previous','afterPointKey','afterPointHash','ordinaryWiki'])
    uuid(raw.groupId);uuid(raw.creationId);hostTime(raw.createdAt);text(raw.sourcePointKey);hash(raw.sourcePointHash);uuid(raw.sourceRevision);uuid(raw.sourceTopologyRevision);uuid(raw.sourceHistoryCursor)
    hash(raw.workingHash);hash(raw.afterHash);uuid(raw.afterRevision)
    if(raw.previous!==null){assertSyncedShape(raw.previous,['kind','operationId','companionHash'])
      if(raw.previous.kind!=='heading-create-birth'&&raw.previous.kind!=='heading-title-transition')return fail('unknown continuous predecessor domain')
      uuid(raw.previous.operationId);hash(raw.previous.companionHash)}
    text(raw.afterPointKey);hash(raw.afterPointHash)
    unique(raw.ordinaryWiki,source=>{assertSyncedShape(source,['documentId','documentCreatedAt','documents','links']);opaque(source.documentId);hostTime(source.documentCreatedAt)
      validateHeadingTitleOrdinaryDocuments3(source.documents)
      unique(source.links,link=>{assertSyncedShape(link,['key','url','target']);validateSyncedBindingKey(link.key);text(link.url)
        if(link.target!==null){assertSyncedShape(link.target,['documentId','documentCreatedAt','path','fragment','kind']);opaque(link.target.documentId);hostTime(link.target.documentCreatedAt);text(link.target.path);text(link.target.fragment)
          if(link.target.kind!=='wiki'&&link.target.kind!=='wiki-heading')return fail('ordinary wiki target kind differs')}
        return link},link=>hostEncode(link.key));return source
    },source=>String(source.documentId))
    unique(raw.workingEdits,edit,item=>hostEncode(item.key));unique(raw.afterEdits,edit,item=>hostEncode(item.key));return raw
  },item=>String(item.groupId))
  const {companionHash,...body}=value
  if(hash(companionHash)!==headingTitle3Hash(body))return fail('companion self hash differs')
  return value as unknown as HeadingTitle3Companion
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
/** The v3 envelope keeps raw W separate from the actual projected after view.
 * Unlike the old v1 ACK, P!=W=A may change physical navigation hints without
 * minting a logical Undo token. The old v1 validator/hash is never widened. */
export function decodeHeadingTitle3Envelope(row:HeadingTitle3Row,companionValue:unknown):{envelope:HeadingTitle3Envelope;companion:HeadingTitle3Companion}{
  const value=hostJson(row.result_json);assertSyncedShape(value,['kind','version','companionKey','companionHash','result'])
  if(value.kind!==HEADING_TITLE3_OPERATION_KIND||value.version!==3)return fail('operation envelope kind/version invalid')
  const companion=decodeHeadingTitle3Companion(companionValue),ack=result(value.result)
  if(row.client_operation_id!==companion.operationId||ack.operationId!==companion.operationId||row.request_hash!==companion.requestHash||row.created_at!==companion.createdAt
    ||value.companionKey!==headingTitle3CompanionKey(companion.operationId)||value.companionHash!==companion.companionHash||ack.hosts[0].documentId!==companion.hostId
    ||hostHash(content(ack.hosts[0].after))!==companion.afterContentHash||ack.hosts[0].after.path!==companion.afterPath||ack.hosts[0].after.updatedAt!==companion.createdAt
    ||ack.historyToken!==companion.historyToken||hostEncode(value)!==row.result_json)return fail('actual operation/companion/ACK binding differs')
  if(companion.intent.kind==='apply'){
    const intent=companion.intent,before=ack.hosts[0].logicalBefore
    const input=validateSyncedStructureInput({clientOperationId:companion.operationId,mode:'host-final',reason:intent.reason,
      hostsWorkingBefore:[{documentId:companion.hostId,expectedPersistedUpdatedAt:intent.expectedPersistedUpdatedAt,workingBefore:before}],
      finalAfter:[{documentId:companion.hostId,...before,title:intent.afterTitle}],groups:intent.groups,expectedInstances:intent.expectedInstances,newRefSources:[]})
    if(before.title!==intent.workingTitle||headingTitle3RequestHash('apply',input)!==row.request_hash||companion.rawLogicalChange!==(intent.workingTitle!==intent.afterTitle)
      ||companion.rawLogicalChange!==(ack.historyToken!==null))return fail('raw request W/A and logical history differ')
  }else if(headingTitle3RequestHash('restore',companion.intent.input)!==row.request_hash||ack.historyToken===null||!companion.rawLogicalChange)return fail('restore request/journal binding differs')
  return{envelope:value as unknown as HeadingTitle3Envelope,companion}
}
export const content=(document:DocumentDetail):HostContent=>({title:document.title,summary:document.summary,blocks:document.blocks.map(({sortOrder:_sortOrder,...block})=>block)})
export function makeHeadingTitle3Companion(value:Omit<HeadingTitle3Companion,'companionHash'>):HeadingTitle3Companion{
  return decodeHeadingTitle3Companion({...value,companionHash:headingTitle3Hash(value)})
}

export interface HeadingTitle3JournalPointer{kind:'synced-host-heading-title-metadata3-journal';version:3;historyToken:string;initialOperationId:string;companionHash:string;journalHash:string}
export interface HeadingTitle3GroupHead{kind:'synced-host-heading-title-metadata3-group-head';version:3;groupId:string;creationId:string;groupCreatedAt:string;
  operationId:string;companionHash:string;revision:string;topologyRevision:string;wireHash:string;historyCursor:string;historyPosition:0}
export function decodeHeadingTitle3JournalPointer(value:unknown):HeadingTitle3JournalPointer{
  assertSyncedShape(value,['kind','version','historyToken','initialOperationId','companionHash','journalHash'])
  if(value.kind!=='synced-host-heading-title-metadata3-journal'||value.version!==3||!isSyncedUuid(value.historyToken)||!isSyncedUuid(value.initialOperationId)
    ||typeof value.companionHash!=='string'||!/^[a-f0-9]{64}$/.test(value.companionHash)||typeof value.journalHash!=='string'||!/^[a-f0-9]{64}$/.test(value.journalHash))return fail('journal pointer malformed')
  return value as unknown as HeadingTitle3JournalPointer
}
export function decodeHeadingTitle3GroupHead(value:unknown):HeadingTitle3GroupHead{
  assertSyncedShape(value,['kind','version','groupId','creationId','groupCreatedAt','operationId','companionHash','revision','topologyRevision','wireHash','historyCursor','historyPosition'])
  if(value.kind!=='synced-host-heading-title-metadata3-group-head'||value.version!==3||!isSyncedUuid(value.groupId)||!isSyncedUuid(value.creationId)
    ||!isSyncedUuid(value.operationId)||!isSyncedUuid(value.revision)||!isSyncedUuid(value.topologyRevision)||!isSyncedUuid(value.historyCursor)||value.historyPosition!==0
    ||typeof value.companionHash!=='string'||!/^[a-f0-9]{64}$/.test(value.companionHash)||typeof value.wireHash!=='string'||!/^[a-f0-9]{64}$/.test(value.wireHash))return fail('group head malformed')
  hostTime(value.groupCreatedAt);return value as unknown as HeadingTitle3GroupHead
}
