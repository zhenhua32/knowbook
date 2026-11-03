import type Database from 'better-sqlite3'
import type { SyncedGroupWire } from '../../shared/synced-blocks'
import { isSyncedUuid, assertSyncedShape } from '../../shared/syncedBlockValidation'
import { hostJson, hostTime } from './synced-host-document-read'
import { hostEncode, hostHash, hostEqual, decodeHostJournal } from './synced-host-journal'
import { readHistoricalExactRows, historicalOperationLocator, historicalMetadataLocator, historicalRowLocator, type HistoricalMetadataRow } from './synced-history-evidence-support'
import { reopenSyncedMetadataCaptureRecordOwned2, readSyncedMetadataCaptureRecordOwned2 } from './synced-metadata-capture-record2'
import { TITLE2_OPERATION_KIND, TITLE2_COMPANION_PREFIX, TITLE2_JOURNAL_PREFIX, TITLE2_GROUP_HEAD_PREFIX, title2CompanionKey, title2JournalKey,
  title2GroupHeadKey, title2Hash, decodeTitle2Envelope, projectTitle2GroupSide, type Title2Row, type Title2Group, type Title2Envelope, type Title2Companion } from './synced-host-title2-codec'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { projectSyncedMetadataGroupLinks2, type SyncedMetadataDocumentDestination2 } from './synced-metadata-group-links2'

const fail=(message:string):never=>{throw new Error('Metadata2 title original invalid: '+message)}
const owned=(db:Database.Database)=>{if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)return fail('actual owned schema27 SQL required')}
const setting=(db:Database.Database,key:string)=>readHistoricalExactRows<HistoricalMetadataRow>(db,'app_settings',['key','value','updated_at'],'key=?',[key])[0]
const operation=(db:Database.Database,id:string)=>readHistoricalExactRows<Title2Row>(db,'synced_operations',['client_operation_id','request_hash','result_json','created_at'],'client_operation_id=?',[id])[0]
export interface Title2JournalPointer{kind:'synced-host-title-metadata2-journal';version:2;historyToken:string;initialOperationId:string;companionHash:string;journalHash:string}
export interface Title2GroupHead{kind:'synced-host-title-metadata2-group-head';version:2;groupId:string;creationId:string;groupCreatedAt:string;
  operationId:string;companionHash:string;revision:string;topologyRevision:string;wireHash:string;historyCursor:string;historyPosition:0}
type Title2JournalPin={group_id:string;kind:string;pin_id:string;created_at:string}
export interface Title2OriginalOperation {
  row:Title2Row;metadata:HistoricalMetadataRow;envelope:Title2Envelope;companion:Title2Companion;
  materials:Array<{group:Title2Group;sourcePoint:ReturnType<typeof readSyncedMetadataCaptureRecordOwned2>;before:SyncedGroupWire;working:SyncedGroupWire;after:SyncedGroupWire}>;
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
export function decodeTitle2JournalPointer(value:unknown):Title2JournalPointer{
  assertSyncedShape(value,['kind','version','historyToken','initialOperationId','companionHash','journalHash'])
  if(value.kind!=='synced-host-title-metadata2-journal'||value.version!==2||!isSyncedUuid(value.historyToken)||!isSyncedUuid(value.initialOperationId)
    ||typeof value.companionHash!=='string'||!/^[a-f0-9]{64}$/.test(value.companionHash)||typeof value.journalHash!=='string'||!/^[a-f0-9]{64}$/.test(value.journalHash))return fail('journal pointer malformed')
  return value as unknown as Title2JournalPointer
}
export function decodeTitle2GroupHead(value:unknown):Title2GroupHead{
  assertSyncedShape(value,['kind','version','groupId','creationId','groupCreatedAt','operationId','companionHash','revision','topologyRevision','wireHash','historyCursor','historyPosition'])
  if(value.kind!=='synced-host-title-metadata2-group-head'||value.version!==2||!isSyncedUuid(value.groupId)||!isSyncedUuid(value.creationId)
    ||!isSyncedUuid(value.operationId)||!isSyncedUuid(value.revision)||!isSyncedUuid(value.topologyRevision)||!isSyncedUuid(value.historyCursor)||value.historyPosition!==0
    ||typeof value.companionHash!=='string'||!/^[a-f0-9]{64}$/.test(value.companionHash)||typeof value.wireHash!=='string'||!/^[a-f0-9]{64}$/.test(value.wireHash))return fail('group head malformed')
  hostTime(value.groupCreatedAt);return value as unknown as Title2GroupHead
}
/** Original-data read only, with fixed SQL selectors and exact source-point
 * records. A historical packet cannot authorize a fresh writer or installation. */
export function readTitle2OriginalOperationOwned(db:Database.Database,id:string,visiting=new Set<string>()):Title2OriginalOperation|null{
  owned(db);if(!isSyncedUuid(id))return fail('operation UUID invalid')
  const row=operation(db,id);if(!row)return null
  const packet=hostJson(row.result_json)
  if(!packet||typeof packet!=='object'||!('kind'in packet)||packet.kind!==TITLE2_OPERATION_KIND)return null
  if(visiting.has(id))return fail('cyclic companion reference');visiting.add(id)
  try{
    const metadata=setting(db,title2CompanionKey(id));if(!metadata)return fail('actual companion missing')
    const decoded=decodeTitle2Envelope(row,hostJson(metadata.value)),{companion,envelope}=decoded
    if(metadata.key!==title2CompanionKey(id)||metadata.value!==hostEncode(companion)||metadata.updated_at!==companion.createdAt)return fail('companion original row differs')
    const materials=companion.groups.map(group=>{
      const owner=reopenSyncedMetadataCaptureRecordOwned2(db,group.sourcePointKey),source=readSyncedMetadataCaptureRecordOwned2(db,owner)
      const original=source.sources[0],history=source.groupHistories[0]
      if(source.kind!=='synced-metadata2-read-baseline-record'||source.recordHash!==group.sourcePointHash||source.sources.length!==1||!original||!history
        ||source.workspaceScope!==companion.workspaceScope||source.recoveryEpoch!==companion.recoveryEpoch||original.wire.id!==group.groupId||original.wire.creationId!==group.creationId
        ||original.wire.createdAt!==group.createdAt||original.revision!==group.sourceRevision||original.topologyRevision!==group.sourceTopologyRevision
        ||history.position!==0||history.history.cursor!==group.sourceHistoryCursor||history.history.undoToken!==null||history.history.redoToken!==null)return fail('group side lacks its exact original source point')
      const working=projectTitle2GroupSide(original.wire,group.workingEdits),after=projectTitle2GroupSide(original.wire,group.afterEdits)
      if(hostHash(working)!==group.workingHash||hostHash(after)!==group.afterHash)return fail('group side material hashes differ')
      const owners=new Map<string,{documentId:string;createdAt:string}>()
      for(const target of source.capture.targets)if(target.status==='current-block'&&target.owner==='document')owners.set(target.blockId,{documentId:target.ownerId,createdAt:target.createdAt})
      for(const destination of [destinations(companion,companion.workingPath),destinations(companion,companion.afterPath)]){
        for(const binding of original.wire.bindings)if(binding.target.kind==='document'){
          const path=destination.get(binding.target.id)
          if(path&&path.beforePath!==path.afterPath){const target=source.capture.targets.find(target=>hostEqual(target.key,{blockId:binding.blockId,from:binding.from,to:binding.to,raw:binding.raw,syntax:binding.syntax}))
            if(!target||target.status!=='current-document'||target.documentId!==path.documentId||target.documentCreatedAt!==path.beforeCreatedAt||target.path!==path.beforePath)return fail('changed document target lacks its exact captured current birth/path')}
        }
      }
      const expectedWorking=projectSyncedMetadataGroupLinks2(original.wire,destinations(companion,companion.workingPath),owners)
      const expectedAfter=projectSyncedMetadataGroupLinks2(original.wire,destinations(companion,companion.afterPath),owners)
      if(!hostEqual(working,expectedWorking.after)||!hostEqual(after,expectedAfter.after))return fail('recorded group fields are not the real typed destination projection')
      const ack=envelope.result.groups.find(item=>item.groupId===group.groupId)
      if(!ack||ack.creationId!==group.creationId||ack.createdAt!==group.createdAt||ack.revision!==group.afterRevision||ack.topologyRevision!==group.sourceTopologyRevision
        ||ack.history.cursor!==group.sourceHistoryCursor||ack.history.undoToken!==null||ack.history.redoToken!==null
        ||!hostEqual(after,{kind:'synced-group',id:ack.groupId,creationId:ack.creationId,createdAt:ack.createdAt,origin:ack.origin,blocks:ack.blocks,bindings:ack.bindings}))return fail('group ACK does not equal its reconstructed exact final side')
      return{group,sourcePoint:source,before:original.wire,working,after}
    })
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
        const initial=readTitle2OriginalOperationOwned(db,pointer.initialOperationId,visiting)
        if(!initial||initial.companion.intent.kind!=='apply'||initial.companion.historyToken!==companion.historyToken
          ||companion.initialCompanion?.key!==title2CompanionKey(pointer.initialOperationId)||companion.initialCompanion.hash!==initial.companion.companionHash
          ||pointer.companionHash!==initial.companion.companionHash||companion.hostCreatedAt!==initial.companion.hostCreatedAt
          ||companion.workspaceScope!==initial.companion.workspaceScope||companion.recoveryEpoch!==initial.companion.recoveryEpoch)return fail('restore does not bind its original metadata2 action')
      }
    }else if(companion.intent.kind!=='apply'||companion.rawLogicalChange)return fail('missing logical journal')
    return{row,metadata,...decoded,materials,journal,journalPins,initialOperationId}
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
    ||head.wireHash!==member.group.afterHash||head.historyCursor!==member.group.sourceHistoryCursor||row.updated_at!==original!.companion.createdAt)return fail('last metadata head lacks its exact actual original operation')
  return{row,head}
}
export function title2OriginalSupportsOwned(db:Database.Database,id:string){
  const original=readTitle2OriginalOperationOwned(db,id);if(!original)return fail('actual metadata2 operation required')
  const supports=[historicalMetadataLocator(original.metadata)]
  for(const material of original.materials){const row=operation(db,material.group.sourcePointKey);if(!row)return fail('source point disappeared');supports.push(historicalOperationLocator(row))}
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
