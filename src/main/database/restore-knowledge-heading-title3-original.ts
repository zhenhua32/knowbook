// DATA only over one complete authenticated original packet. This adapter
// never reads today's DB, follows a live owner, or grants a mutation/file right.
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import type { Capsule2RawContent } from './restore-knowledge-capsule2-raw-model'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { hostJson } from './synced-host-document-read'
import { hostEncode, hostEqual, hostHash, decodeHostJournal } from './synced-host-journal'
import { decodeSyncedMetadataCaptureRecord2 } from './synced-metadata-capture-record2'
import { decodeHeadingCreateBirthOriginalMaterial2, type HeadingCreateBirthOriginalAccess2,
  type HeadingCreateBirthOriginalSource2 } from './restore-knowledge-heading-create-birth-original2'
import { HEADING_TITLE3_COMPANION_PREFIX, HEADING_TITLE3_JOURNAL_PREFIX,
  HEADING_TITLE3_GROUP_HEAD_PREFIX, headingTitle3CompanionKey, headingTitle3JournalKey, headingTitle3Hash,
  decodeHeadingTitle3Envelope, decodeHeadingTitle3JournalPointer, decodeHeadingTitle3GroupHead,
  type HeadingTitle3Row } from './synced-heading-title3-codec'
import type { HeadingTitle3OriginalOperation } from './synced-heading-title3-read'
import { deriveHeadingTitlePointEdge3, planHeadingTitleSideData3, headingTitlePointMaterial3,
  deriveHeadingTitleRestorationStyles3, type HeadingTitleCoveredKey3, type HeadingTitleRestoreStyle3 } from './synced-heading-title-point3'
import { headingTitleOrdinaryRestorationFacts3, validateHeadingTitleOrdinaryRestoreRecord3, type HeadingTitleOrdinaryRestoreFact3 } from './synced-heading-title-style-facts3'
import { headingTitleRestorationGroupStyles3, type HeadingTitleRestoreGroupStyle3 } from './synced-heading-title-style3'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { historicalOperationLocator, historicalMetadataLocator, historicalRowLocator,
  type HistoricalMetadataRow } from './synced-history-evidence-support'
import type { RawHistoricalEvidenceLocator } from './synced-history-evidence-model'

export type HeadingTitle3OriginalSource<T> = HeadingCreateBirthOriginalSource2<T>
export interface HeadingTitle3OriginalAccess<T> extends HeadingCreateBirthOriginalAccess2<T> {}
type Pin={group_id:string;kind:string;pin_id:string;created_at:string}
type Decoded<T>=HeadingTitle3OriginalOperation & { primarySource:T;supportSources:T[];
  supports:RawHistoricalEvidenceLocator[];writePermit:false;currentHeadingMutationAuthorized:false }
const columns={
  synced_operations:['client_operation_id','request_hash','result_json','created_at'],
  app_settings:['key','value','updated_at'],
  synced_host_history:['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],
  synced_group_pins:['group_id','kind','pin_id','created_at']
} as const
type Table=keyof typeof columns
const fail=(message:string):never=>{throw Error('Heading title3 original packet invalid: '+message)}
function texts<T>(source:HeadingTitle3OriginalSource<unknown>,names:readonly string[]):T{
  assertSyncedShape(source.value,names)
  if(names.some(name=>typeof source.value[name]!=='string'))return fail('complete original SQL TEXT required')
  return source.value as unknown as T
}

/** The source selectors are supplied only by the two fixed complete-packet
 * adapters (raw SQL or K originals). A returned value remains untrusted DATA.
 * Caching here is scoped to one synchronous decoder invocation, never a public
 * SQL read or persisted owner. Every recursive predecessor is reconstructed. */
export function createHeadingTitle3OriginalDecoder<T>(access:HeadingTitle3OriginalAccess<T>){
  const active=new Set<string>(),decoded=new Map<string,Decoded<T>>()
  const operation=(id:string)=>{
    const source=access.operation(id),row=texts<HeadingTitle3Row>(source,columns.synced_operations)
    if(row.client_operation_id!==id)return fail('operation address differs')
    return{source,row}
  }
  const metadata=(key:string)=>{
    const source=access.metadata(key),row=texts<HistoricalMetadataRow>(source,columns.app_settings)
    if(row.key!==key)return fail('metadata address differs')
    return{source,row}
  }
  const point=(key:string)=>{
    const original=operation(key)
    return{...original,point:decodeSyncedMetadataCaptureRecord2(original.row)}
  }
  function read(id:string):Decoded<T>{
    if(!isSyncedUuid(id))return fail('operation UUID required')
    const remembered=decoded.get(id);if(remembered)return remembered
    if(active.has(id))return fail('cyclic original operation reference')
    active.add(id)
    try{
      const primary=operation(id),row=primary.row,ownMetadata=metadata(headingTitle3CompanionKey(id))
      const {envelope,companion}=decodeHeadingTitle3Envelope(row,hostJson(ownMetadata.row.value))
      if(ownMetadata.row.value!==hostEncode(companion)||ownMetadata.row.updated_at!==companion.createdAt)return fail('original companion bytes/time differ')
      const held=new Map<string,{source:T;locator:RawHistoricalEvidenceLocator}>()
      const hold=(source:T,locator:RawHistoricalEvidenceLocator)=>{
        const address=hostEncode([locator.table,locator.key]),old=held.get(address)
        if(old&&old.locator.rowHash!==locator.rowHash)return fail('contradictory original support address')
        held.set(address,{source,locator})
      }
      const holdParent=(parent:Decoded<T>)=>{
        hold(parent.primarySource,historicalOperationLocator(parent.row))
        parent.supports.forEach((locator,index)=>hold(parent.supportSources[index],locator))
      }
      hold(ownMetadata.source.source,historicalMetadataLocator(ownMetadata.row))
      let restoreStyles:HeadingTitleRestoreStyle3[]|undefined,restoreGroups:HeadingTitleRestoreGroupStyle3[]|undefined,restoreOrdinary:HeadingTitleOrdinaryRestoreFact3[]|undefined
      if(companion.intent.kind==='restore'){
        const pointer=companion.initialCompanion
        if(!pointer||!pointer.key.startsWith(HEADING_TITLE3_COMPANION_PREFIX))return fail('restore initial style source address missing')
        const initial=read(pointer.key.slice(HEADING_TITLE3_COMPANION_PREFIX.length))
        if(initial.companion.companionHash!==pointer.hash||initial.companion.historyToken!==companion.historyToken)return fail('restore style source differs from its exact initial action')
        restoreStyles=deriveHeadingTitleRestorationStyles3(initial,companion.intent.input.direction)
        restoreGroups=headingTitleRestorationGroupStyles3(initial.materials,companion.intent.input.direction)
        restoreOrdinary=headingTitleOrdinaryRestorationFacts3(initial.companion.ordinaryStyles,companion.intent.input.direction)
        validateHeadingTitleOrdinaryRestoreRecord3(initial.companion.ordinaryStyles,companion.ordinaryStyles,companion.intent.input.direction)
      }
      const materials=companion.groups.map(group=>{
        const before=point(group.sourcePointKey),source=before.point,original=source.sources[0],history=source.groupHistories[0]
        hold(before.source.source,historicalOperationLocator(before.row))
        if(source.kind!=='synced-metadata2-read-baseline-record'||source.recordHash!==group.sourcePointHash||source.sources.length!==1||!original||!history
          ||source.workspaceScope!==companion.workspaceScope||source.recoveryEpoch!==companion.recoveryEpoch||original.wire.id!==group.groupId||original.wire.creationId!==group.creationId
          ||original.wire.createdAt!==group.createdAt||original.revision!==group.sourceRevision||original.topologyRevision!==group.sourceTopologyRevision
          ||history.position!==0||history.history.cursor!==group.sourceHistoryCursor||history.history.undoToken!==null||history.history.redoToken!==null)return fail('exact source point differs')
        let preceding:ReturnType<typeof decodeSyncedMetadataCaptureRecord2>,covered:HeadingTitleCoveredKey3[]
        if(group.previous===null){preceding=source;covered=[]}
        else if(group.previous.kind==='heading-create-birth'){
          const birth=decodeHeadingCreateBirthOriginalMaterial2(group.previous.operationId,access)
          if(birth.envelope.companionHash!==group.previous.companionHash||birth.result.createdLifecycle.groupId!==group.groupId)return fail('exact initial birth original differs')
          hold(birth.primarySource,historicalOperationLocator(birth.row))
          birth.supports.forEach((locator,index)=>hold(birth.supportSources[index],locator))
          preceding=birth.point
          covered=birth.companion.covered.map(item=>{
            if(item.heading.location.kind!=='ordinary')return fail('initial heading birth is not ordinary')
            return{birthOperationId:birth.row.client_operation_id,birthKey:item.canonicalKey,key:item.canonicalKey,target:item.storedTarget,location:item.heading.location,headingKey:item.heading.key}
          })
        }else{
          const parent=read(group.previous.operationId),member=parent.materials.find(item=>item.group.groupId===group.groupId)
          if(!member||parent.companion.companionHash!==group.previous.companionHash)return fail('previous committed edge differs')
          holdParent(parent);preceding=member.afterPoint;covered=member.covered
        }
        if(!hostEqual(headingTitlePointMaterial3(preceding),headingTitlePointMaterial3(source)))return fail('source is not the exact preceding point')
        const after=point(group.afterPointKey),afterPoint=after.point
        hold(after.source.source,historicalOperationLocator(after.row))
        if(afterPoint.recordHash!==group.afterPointHash||afterPoint.kind!=='synced-metadata2-read-baseline-record')return fail('exact after point differs')
        const base={before:source,rootId:companion.hostId,persistedTitle:companion.persistedTitle,createdAt:companion.createdAt,subtree:companion.subtree,ordinaryWiki:group.ordinaryWiki,wikiDocuments:companion.wikiDocuments}
        const workingTitle=companion.intent.kind==='apply'?companion.intent.workingTitle:companion.persistedTitle
        const working=planHeadingTitleSideData3({...base,afterTitle:workingTitle}),afterTitle=envelope.result.hosts[0].after.title
        const edge=deriveHeadingTitlePointEdge3({...base,after:afterPoint,afterTitle,afterRevision:group.afterRevision,previousCovered:covered,restoreStyles,restoreGroups,restoreOrdinary})
        if(working.destinations.get(companion.hostId)?.afterPath!==companion.workingPath
          ||planHeadingTitleSideData3({...base,afterTitle,restoreStyles,restoreGroups,restoreOrdinary}).destinations.get(companion.hostId)?.afterPath!==companion.afterPath
          ||!hostEqual(working.projection.edits,group.workingEdits)||!hostEqual(edge.edits,group.afterEdits)
          ||hostHash(working.projection.after)!==group.workingHash||hostHash(edge.after)!==group.afterHash)return fail('complete W/A group projection differs')
        const proved=new Map(covered.map(item=>[hostEncode(item.key),item]))
        for(const binding of original.wire.bindings)if(binding.target.kind==='heading'){
          const destination=working.destinations.get(binding.target.documentId)
          if(destination&&(destination.beforePath!==destination.afterPath||destination.headings.size)){
            const proof=proved.get(hostEncode({blockId:binding.blockId,from:binding.from,to:binding.to,raw:binding.raw,syntax:binding.syntax}))
            if(!proof||!hostEqual(proof.target,binding.target))return fail('working heading Key lacks original continuity proof')
          }
        }
        const ack=envelope.result.groups.find(item=>item.groupId===group.groupId)
        if(!ack||ack.creationId!==group.creationId||ack.createdAt!==group.createdAt||ack.revision!==group.afterRevision||ack.topologyRevision!==group.sourceTopologyRevision
          ||ack.history.cursor!==group.sourceHistoryCursor||ack.history.undoToken!==null||ack.history.redoToken!==null
          ||!hostEqual(edge.after,{kind:'synced-group',id:ack.groupId,creationId:ack.creationId,createdAt:ack.createdAt,origin:ack.origin,blocks:ack.blocks,bindings:ack.bindings}))return fail('ACK group is not its exact final point')
        return{group,sourcePoint:source,afterPoint,before:original.wire,working:working.projection.after,after:edge.after,covered:edge.covered}
      })
      let journal:SyncedHostHistoryBranchRow|null=null,initialOperationId:string|null=null,journalPins:Pin[]=[]
      if(companion.historyToken!==null){
        const pointerOriginal=metadata(headingTitle3JournalKey(companion.historyToken)),pointer=decodeHeadingTitle3JournalPointer(hostJson(pointerOriginal.row.value))
        if(pointerOriginal.row.value!==hostEncode(pointer)||pointer.historyToken!==companion.historyToken)return fail('journal pointer differs')
        hold(pointerOriginal.source.source,historicalMetadataLocator(pointerOriginal.row))
        const journalOriginal=access.journal(companion.historyToken)
        journal=texts<SyncedHostHistoryBranchRow>(journalOriginal,columns.synced_host_history)
        if(journal.id!==companion.historyToken||headingTitle3Hash({journal})!==pointer.journalHash)return fail('original journal address/hash differs')
        hold(journalOriginal.source,historicalRowLocator('synced_host_history',[journal.id],journal))
        const raw=decodeHostJournal(journal)
        if(raw.input.mode!=='host-final'||raw.before.length!==1||raw.before[0].documentId!==companion.hostId||raw.after[0].documentId!==companion.hostId)return fail('journal participants/mode differ')
        journalPins=access.pins(journal.id).map(source=>{
          const pin=texts<Pin>(source,columns.synced_group_pins)
          hold(source.source,historicalRowLocator('synced_group_pins',[pin.group_id,pin.kind,pin.pin_id],pin));return pin
        })
        const pinsByGroup=new Map(journalPins.map(pin=>[pin.group_id,pin]))
        if(pinsByGroup.size!==journalPins.length||journalPins.length!==raw.groups.length||raw.groups.some(group=>{const pin=pinsByGroup.get(group.groupId)
          return!pin||pin.kind!=='host-history'||pin.pin_id!==journal!.id||pin.created_at!==journal!.created_at
        }))return fail('original journal pin closure differs')
        initialOperationId=pointer.initialOperationId
        if(companion.intent.kind==='apply'){
          if(pointer.initialOperationId!==id||pointer.companionHash!==companion.companionHash||journal.created_at!==companion.createdAt
            ||raw.input.clientOperationId!==id||raw.before[0].content.title!==companion.intent.workingTitle||raw.after[0].content.title!==companion.intent.afterTitle
            ||!hostEqual(raw.before[0].content,envelope.result.hosts[0].logicalBefore))return fail('initial journal is not this raw W/A action')
        }else{
          const initial=read(pointer.initialOperationId)
          if(initial.companion.intent.kind!=='apply'||initial.companion.historyToken!==companion.historyToken
            ||companion.initialCompanion?.key!==headingTitle3CompanionKey(pointer.initialOperationId)||companion.initialCompanion.hash!==initial.companion.companionHash
            ||pointer.companionHash!==initial.companion.companionHash||companion.hostCreatedAt!==initial.companion.hostCreatedAt
            ||companion.workspaceScope!==initial.companion.workspaceScope||companion.recoveryEpoch!==initial.companion.recoveryEpoch)return fail('restore does not bind its exact initial action')
          holdParent(initial)
        }
      }else if(companion.intent.kind!=='apply'||companion.rawLogicalChange)return fail('missing logical journal')
      const result:Decoded<T>={row,metadata:ownMetadata.row,envelope,companion,materials,journal,journalPins,initialOperationId,
        primarySource:primary.source.source,supportSources:[...held.values()].map(item=>item.source),supports:[...held.values()].map(item=>item.locator),
        writePermit:false,currentHeadingMutationAuthorized:false}
      decoded.set(id,result);return result
    }finally{active.delete(id)}
  }
  return read
}

/** Complete SQL original index, local to this one pure collector call. No live
 * profile lookup or same-ID/material-hash substitute can fill a missing row. */
export function headingTitle3OriginalsFromRaw(raw:Capsule2RawContent){
  type RawRow=ReturnType<typeof graph3Rows>[number]
  const indexed=new Map<Table,RawRow[]>()
  const rows=(table:Table)=>{
    let found=indexed.get(table)
    if(!found){const declarations=raw.tables.filter(value=>value.name===table)
      if(declarations.length!==1||declarations[0].columns.length!==columns[table].length
        ||new Set(declarations[0].columns).size!==declarations[0].columns.length||columns[table].some(name=>!declarations[0].columns.includes(name)))return fail('complete original columns required: '+table)
      found=graph3Rows(raw,table);indexed.set(table,found)
    }return found
  }
  const material=(row:RawRow):HeadingTitle3OriginalSource<RawRow>=>{
    if(row.original.cells.length!==row.table.columns.length||row.original.cells.some(cell=>cell[0]!=='text'))return fail('original storage class/width differs')
    return{value:row.value,source:row}
  }
  const one=(table:Table,column:string,key:string)=>{
    const found=rows(table).filter(row=>row.value[column]===key)
    if(found.length!==1)return fail('original support missing/duplicate: '+table)
    return material(found[0])
  }
  const access:HeadingTitle3OriginalAccess<RawRow>={operation:id=>one('synced_operations','client_operation_id',id),
    metadata:key=>one('app_settings','key',key),journal:id=>one('synced_host_history','id',id),
    pins:token=>rows('synced_group_pins').filter(row=>row.value.kind==='host-history'&&row.value.pin_id===token).map(material)}
  const read=createHeadingTitle3OriginalDecoder(access)
  let familyChecked=false
  return(id:string)=>{
    if(!familyChecked){
      for(const candidate of rows('app_settings')){
        if(typeof candidate.value.key!=='string'||!candidate.value.key.replace(/[A-Z]/g,value=>value.toLowerCase()).startsWith('synced.heading.title'))continue
        const row=texts<HistoricalMetadataRow>(material(candidate),columns.app_settings)
        if(row.key.startsWith(HEADING_TITLE3_COMPANION_PREFIX)){
          const original=read(row.key.slice(HEADING_TITLE3_COMPANION_PREFIX.length))
          if(!hostEqual(row,original.metadata))return fail('orphan/rebound transition companion')
        }else if(row.key.startsWith(HEADING_TITLE3_JOURNAL_PREFIX)){
          const pointer=decodeHeadingTitle3JournalPointer(hostJson(row.value)),original=read(pointer.initialOperationId)
          if(row.key!==headingTitle3JournalKey(pointer.historyToken)||row.value!==hostEncode(pointer)||original.companion.historyToken!==pointer.historyToken
            ||original.companion.intent.kind!=='apply'||original.companion.companionHash!==pointer.companionHash
            ||!original.journal||headingTitle3Hash({journal:original.journal})!==pointer.journalHash)return fail('orphan/rebound transition journal pointer')
        }else if(row.key.startsWith(HEADING_TITLE3_GROUP_HEAD_PREFIX)){
          const head=decodeHeadingTitle3GroupHead(hostJson(row.value)),original=read(head.operationId),member=original.materials.find(item=>item.group.groupId===head.groupId)
          if(!member||row.key!==HEADING_TITLE3_GROUP_HEAD_PREFIX+head.groupId||row.value!==hostEncode(head)||head.companionHash!==original.companion.companionHash
            ||head.creationId!==member.group.creationId||head.groupCreatedAt!==member.group.createdAt||head.revision!==member.group.afterRevision
            ||head.topologyRevision!==member.group.sourceTopologyRevision||head.wireHash!==member.group.afterHash||head.historyCursor!==member.group.sourceHistoryCursor
            ||row.updated_at!==original.companion.createdAt)return fail('orphan/rebound transition group head')
        }else return fail('unknown transition family/version/case')
      }
      familyChecked=true
    }
    const original=read(id)
    return original
  }
}
