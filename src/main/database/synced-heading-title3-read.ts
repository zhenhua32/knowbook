import { decodeHeadingTitle3JournalPointer, decodeHeadingTitle3GroupHead, type HeadingTitle3JournalPointer, type HeadingTitle3GroupHead } from './synced-heading-title3-codec'
export { decodeHeadingTitle3JournalPointer, decodeHeadingTitle3GroupHead, type HeadingTitle3JournalPointer, type HeadingTitle3GroupHead } from './synced-heading-title3-codec'
// Owned original-data reader. Each public read independently validates the complete reverse-bound business history.
import type Database from 'better-sqlite3'
import type { SyncedGroupWire } from '../../shared/synced-blocks'
import { isSyncedUuid, assertSyncedShape } from '../../shared/syncedBlockValidation'
import { hostJson, hostTime } from './synced-host-document-read'
import { hostEncode, hostHash, hostEqual, decodeHostJournal } from './synced-host-journal'
import { readHistoricalExactRows, historicalOperationLocator, historicalMetadataLocator, historicalRowLocator, type HistoricalMetadataRow } from './synced-history-evidence-support'
import { reopenSyncedMetadataCaptureRecordOwned2, readSyncedMetadataCaptureRecordOwned2, readSyncedHistoricalOperationsWithMetadata2Owned2 } from './synced-metadata-capture-record2'
import { HEADING_TITLE3_OPERATION_KIND, HEADING_TITLE3_COMPANION_PREFIX, HEADING_TITLE3_JOURNAL_PREFIX, HEADING_TITLE3_GROUP_HEAD_PREFIX, headingTitle3CompanionKey, headingTitle3JournalKey,
  headingTitle3GroupHeadKey, headingTitle3Hash, decodeHeadingTitle3Envelope, type HeadingTitle3Row, type HeadingTitle3Group, type HeadingTitle3Envelope, type HeadingTitle3Companion } from './synced-heading-title3-codec'
import { headingTitleOrdinaryRestorationFacts3, validateHeadingTitleOrdinaryRestoreRecord3, type HeadingTitleOrdinaryRestoreFact3 } from './synced-heading-title-style-facts3'
import { headingTitleRestorationGroupStyles3, type HeadingTitleRestoreGroupStyle3 } from './synced-heading-title-style3'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { deriveHeadingTitlePointEdge3, planHeadingTitleSideData3, headingTitlePointMaterial3, deriveHeadingTitleRestorationStyles3, type HeadingTitleCoveredKey3, type HeadingTitleRestoreStyle3 } from './synced-heading-title-point3'
import { readSyncedHeadingCreateBirthOriginalOwned2, syncedHeadingCreateBirthOriginalSupportsOwned2, decodeSyncedOperationWithHeadingBirthOwned2, readHistoricalMetadataWithHeadingCreateBirthOwned2 } from './synced-heading-create-birth-read2'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { prepareSyncedMetadataGroupBaselineCurrentCaptureOwned2 } from './synced-metadata-transition2'
import { decodeHostCreateJournal } from './synced-host-create-codec'
import type { RawHistoricalEvidenceLocator } from './synced-history-evidence-model'

const fail=(message:string):never=>{throw new Error('Metadata3 heading title original invalid: '+message)}
export class HeadingTitle3LineageRequired extends Error{
  constructor(message:string){super('Metadata3 heading title requires-lineage: '+message+'; preserve the complete working draft.');this.name='HeadingTitle3LineageRequired'}
}
const owned=(db:Database.Database)=>{if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)return fail('actual owned schema27 SQL required')}
const setting=(db:Database.Database,key:string)=>readHistoricalExactRows<HistoricalMetadataRow>(db,'app_settings',['key','value','updated_at'],'key=?',[key])[0]
const operation=(db:Database.Database,id:string)=>readHistoricalExactRows<HeadingTitle3Row>(db,'synced_operations',['client_operation_id','request_hash','result_json','created_at'],'client_operation_id=?',[id])[0]
type HeadingTitle3JournalPin={group_id:string;kind:string;pin_id:string;created_at:string}
export interface HeadingTitle3OriginalOperation {
  row:HeadingTitle3Row;metadata:HistoricalMetadataRow;envelope:HeadingTitle3Envelope;companion:HeadingTitle3Companion;
  materials:Array<{group:HeadingTitle3Group;sourcePoint:ReturnType<typeof readSyncedMetadataCaptureRecordOwned2>;
    afterPoint:ReturnType<typeof readSyncedMetadataCaptureRecordOwned2>;before:SyncedGroupWire;working:SyncedGroupWire;after:SyncedGroupWire;covered:HeadingTitleCoveredKey3[]}>;
  journal:SyncedHostHistoryBranchRow|null;journalPins:HeadingTitle3JournalPin[];initialOperationId:string|null
}
/** Original-data read only, with fixed SQL selectors and exact source-point
 * records. A historical packet cannot authorize a fresh writer or installation. */
interface HeadingTitle3ReadContext {visiting:Set<string>;validated:Map<string,HeadingTitle3OriginalOperation>;
  operations?:ReadonlyMap<string,HeadingTitle3Row>;metadata?:ReadonlyMap<string,HistoricalMetadataRow>}
const freshReadContext3=():HeadingTitle3ReadContext=>({visiting:new Set(),validated:new Map()})
export function readHeadingTitle3OriginalOperationOwned(db:Database.Database,id:string):HeadingTitle3OriginalOperation|null{
  return readOriginal3(db,id,freshReadContext3())
}
function readOriginal3(db:Database.Database,id:string,context:HeadingTitle3ReadContext):HeadingTitle3OriginalOperation|null{
  owned(db);if(!isSyncedUuid(id))return fail('operation UUID invalid')
  const cached=context.validated.get(id);if(cached)return cached
  const row=context.operations?context.operations.get(id):operation(db,id);if(!row)return null
  const packet=hostJson(row.result_json)
  if(!packet||typeof packet!=='object'||!('kind'in packet)||packet.kind!==HEADING_TITLE3_OPERATION_KIND)return null
  if(context.visiting.has(id))return fail('cyclic companion reference');context.visiting.add(id)
  try{
    const metadata=context.metadata?context.metadata.get(headingTitle3CompanionKey(id)):setting(db,headingTitle3CompanionKey(id));if(!metadata)return fail('actual companion missing')
    const decoded=decodeHeadingTitle3Envelope(row,hostJson(metadata.value)),{companion,envelope}=decoded
    if(metadata.key!==headingTitle3CompanionKey(id)||metadata.value!==hostEncode(companion)||metadata.updated_at!==companion.createdAt)return fail('companion original row differs')
    let restoreStyles:HeadingTitleRestoreStyle3[]|undefined,restoreGroups:HeadingTitleRestoreGroupStyle3[]|undefined,restoreOrdinary:HeadingTitleOrdinaryRestoreFact3[]|undefined
    if(companion.intent.kind==='restore'){
      const pointer=companion.initialCompanion
      if(!pointer||!pointer.key.startsWith(HEADING_TITLE3_COMPANION_PREFIX))return fail('restore initial style source address missing')
      const initial=readOriginal3(db,pointer.key.slice(HEADING_TITLE3_COMPANION_PREFIX.length),context)
      if(!initial||initial.companion.companionHash!==pointer.hash||initial.companion.historyToken!==companion.historyToken)return fail('restore style source is not its exact initial action')
      restoreStyles=deriveHeadingTitleRestorationStyles3(initial,companion.intent.input.direction)
      restoreGroups=headingTitleRestorationGroupStyles3(initial.materials,companion.intent.input.direction)
      restoreOrdinary=headingTitleOrdinaryRestorationFacts3(initial.companion.ordinaryStyles,companion.intent.input.direction)
      validateHeadingTitleOrdinaryRestoreRecord3(initial.companion.ordinaryStyles,companion.ordinaryStyles,companion.intent.input.direction)
    }
    const materials=companion.groups.map(group=>{
      const owner=reopenSyncedMetadataCaptureRecordOwned2(db,group.sourcePointKey),source=readSyncedMetadataCaptureRecordOwned2(db,owner)
      const original=source.sources[0],history=source.groupHistories[0]
      if(source.kind!=='synced-metadata2-read-baseline-record'||source.recordHash!==group.sourcePointHash||source.sources.length!==1||!original||!history
        ||source.workspaceScope!==companion.workspaceScope||source.recoveryEpoch!==companion.recoveryEpoch||original.wire.id!==group.groupId||original.wire.creationId!==group.creationId
        ||original.wire.createdAt!==group.createdAt||original.revision!==group.sourceRevision||original.topologyRevision!==group.sourceTopologyRevision
        ||history.position!==0||history.history.cursor!==group.sourceHistoryCursor||history.history.undoToken!==null||history.history.redoToken!==null)return fail('group side lacks its exact original source point')
      let preceding:ReturnType<typeof readSyncedMetadataCaptureRecordOwned2>,covered:HeadingTitleCoveredKey3[]
      if(group.previous===null){
        // This explicit mixed-operation member carries NO heading authority.
        // Both independently reconstructed W/A projections below still reject
        // any affected incoming heading Key absent from the empty covered set.
        preceding=source;covered=[]
      }else if(group.previous.kind==='heading-create-birth'){
        const birth=readSyncedHeadingCreateBirthOriginalOwned2(db,group.previous.operationId)
        if(!birth||birth.envelope.companionHash!==group.previous.companionHash||birth.result.createdLifecycle.groupId!==group.groupId)
          return fail('exact initial heading business original missing')
        preceding=birth.point
        covered=birth.companion.covered.map(item=>{
          if(item.heading.location.kind!=='ordinary')return fail('initial covered heading is not an ordinary native occurrence')
          return{birthOperationId:birth.row.client_operation_id,birthKey:item.canonicalKey,key:item.canonicalKey,target:item.storedTarget,location:item.heading.location,headingKey:item.heading.key}
        })
      }else{
        const previous=readOriginal3(db,group.previous.operationId,context)
        const member=previous?.materials.find(item=>item.group.groupId===group.groupId)
        if(!previous||!member||previous.companion.companionHash!==group.previous.companionHash)return fail('exact previous committed heading edge missing')
        preceding=member.afterPoint;covered=member.covered
      }
      if(!hostEqual(headingTitlePointMaterial3(preceding),headingTitlePointMaterial3(source)))return fail('full source point is not the exact preceding committed point')
      const afterOwner=reopenSyncedMetadataCaptureRecordOwned2(db,group.afterPointKey),afterPoint=readSyncedMetadataCaptureRecordOwned2(db,afterOwner)
      if(afterPoint.recordHash!==group.afterPointHash||afterPoint.kind!=='synced-metadata2-read-baseline-record')return fail('actual committed after point missing')
      const base={before:source,rootId:companion.hostId,persistedTitle:companion.persistedTitle,createdAt:companion.createdAt,subtree:companion.subtree,ordinaryWiki:group.ordinaryWiki,wikiDocuments:companion.wikiDocuments}
      const workingTitle=companion.intent.kind==='apply'?companion.intent.workingTitle:companion.persistedTitle
      const workingPlan=planHeadingTitleSideData3({...base,afterTitle:workingTitle})
      const afterTitle=envelope.result.hosts[0].after.title
      const edge=deriveHeadingTitlePointEdge3({...base,after:afterPoint,afterTitle,afterRevision:group.afterRevision,previousCovered:covered,restoreStyles,restoreGroups,restoreOrdinary})
      if(workingPlan.destinations.get(companion.hostId)?.afterPath!==companion.workingPath
        ||planHeadingTitleSideData3({...base,afterTitle,restoreStyles,restoreGroups,restoreOrdinary}).destinations.get(companion.hostId)?.afterPath!==companion.afterPath
        ||!hostEqual(workingPlan.projection.edits,group.workingEdits)||!hostEqual(edge.edits,group.afterEdits)
        ||hostHash(workingPlan.projection.after)!==group.workingHash||hostHash(edge.after)!==group.afterHash)return fail('complete projected W/A group material differs')
      // W is not a committed predecessor, yet every heading Key which its path
      // projection touches still needs the SAME actual original birth proof.
      const proved=new Map(covered.map(item=>[hostEncode(item.key),item]))
      for(const binding of original.wire.bindings)if(binding.target.kind==='heading'){
        const destination=workingPlan.destinations.get(binding.target.documentId)
        if(destination&&(destination.beforePath!==destination.afterPath||destination.headings.size)){
          const proof=proved.get(hostEncode({blockId:binding.blockId,from:binding.from,to:binding.to,raw:binding.raw,syntax:binding.syntax}))
          if(!proof||!hostEqual(proof.target,binding.target))return fail('working-side incoming heading Key lacks its original continuity proof')
        }
      }
      const ack=envelope.result.groups.find(item=>item.groupId===group.groupId)
      if(!ack||ack.creationId!==group.creationId||ack.createdAt!==group.createdAt||ack.revision!==group.afterRevision||ack.topologyRevision!==group.sourceTopologyRevision
        ||ack.history.cursor!==group.sourceHistoryCursor||ack.history.undoToken!==null||ack.history.redoToken!==null
        ||!hostEqual(edge.after,{kind:'synced-group',id:ack.groupId,creationId:ack.creationId,createdAt:ack.createdAt,origin:ack.origin,blocks:ack.blocks,bindings:ack.bindings}))return fail('group ACK does not equal its exact committed final side')
      return{group,sourcePoint:source,afterPoint,before:original.wire,working:workingPlan.projection.after,after:edge.after,covered:edge.covered}
    })
    let journal:SyncedHostHistoryBranchRow|null=null,initialOperationId:string|null=null
    let journalPins:HeadingTitle3JournalPin[]=[]
    if(companion.historyToken!==null){
      const pointerRow=context.metadata?context.metadata.get(headingTitle3JournalKey(companion.historyToken)):setting(db,headingTitle3JournalKey(companion.historyToken));if(!pointerRow)return fail('journal metadata2 pointer missing')
      const pointer=decodeHeadingTitle3JournalPointer(hostJson(pointerRow.value))
      if(pointerRow.value!==hostEncode(pointer)||pointer.historyToken!==companion.historyToken)return fail('journal pointer original bytes differ')
      journal=readHistoricalExactRows<SyncedHostHistoryBranchRow>(db,'synced_host_history',['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],'id=?',[companion.historyToken])[0]??null
      if(!journal||headingTitle3Hash({journal})!==pointer.journalHash)return fail('original host journal missing/changed')
      const raw=decodeHostJournal(journal)
      if(raw.input.mode!=='host-final'||raw.before.length!==1||raw.before[0].documentId!==companion.hostId||raw.after[0].documentId!==companion.hostId)return fail('journal participant/mode differs')
      // Immutable data support uses all raw W/A references, including groups
      // outside metadata URI maintenance. It is not a current execution permit.
      journalPins=readHistoricalExactRows<HeadingTitle3JournalPin>(db,'synced_group_pins',['group_id','kind','pin_id','created_at'],'kind=? AND pin_id=?',['host-history',journal.id])
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
        const initial=readOriginal3(db,pointer.initialOperationId,context)
        if(!initial||initial.companion.intent.kind!=='apply'||initial.companion.historyToken!==companion.historyToken
          ||companion.initialCompanion?.key!==headingTitle3CompanionKey(pointer.initialOperationId)||companion.initialCompanion.hash!==initial.companion.companionHash
          ||pointer.companionHash!==initial.companion.companionHash||companion.hostCreatedAt!==initial.companion.hostCreatedAt
          ||companion.workspaceScope!==initial.companion.workspaceScope||companion.recoveryEpoch!==initial.companion.recoveryEpoch)return fail('restore does not bind its original metadata2 action')
      }
    }else if(companion.intent.kind!=='apply'||companion.rawLogicalChange)return fail('missing logical journal')
    const complete={row,metadata,...decoded,materials,journal,journalPins,initialOperationId}
    context.validated.set(id,complete);return complete
  }finally{context.visiting.delete(id)}
}
export function readHeadingTitle3JournalOriginalOwned(db:Database.Database,token:string){
  return readJournal3(db,token,freshReadContext3())
}
function readJournal3(db:Database.Database,token:string,context:HeadingTitle3ReadContext){
  owned(db);if(!isSyncedUuid(token))return fail('journal UUID invalid')
  const row=setting(db,headingTitle3JournalKey(token));if(!row)return null
  const pointer=decodeHeadingTitle3JournalPointer(hostJson(row.value)),initial=readOriginal3(db,pointer.initialOperationId,context)
  if(!initial||initial.companion.intent.kind!=='apply'||initial.companion.historyToken!==token||initial.companion.companionHash!==pointer.companionHash
    ||row.value!==hostEncode(pointer))return fail('journal original pointer does not bind an actual initial action')
  return{row,pointer,initial}
}
export function readHeadingTitle3GroupHeadOriginalOwned(db:Database.Database,groupId:string){
  return readGroupHead3(db,groupId,freshReadContext3())
}
function readGroupHead3(db:Database.Database,groupId:string,context:HeadingTitle3ReadContext){
  owned(db);const row=setting(db,headingTitle3GroupHeadKey(groupId));if(!row)return null
  const head=decodeHeadingTitle3GroupHead(hostJson(row.value)),original=readOriginal3(db,head.operationId,context)
  const member=original?.materials.find(item=>item.group.groupId===groupId)
  if(!member||row.value!==hostEncode(head)||head.groupId!==groupId||head.companionHash!==original!.companion.companionHash||head.creationId!==member.group.creationId
    ||head.groupCreatedAt!==member.group.createdAt||head.revision!==member.group.afterRevision||head.topologyRevision!==member.group.sourceTopologyRevision
    ||head.wireHash!==member.group.afterHash||head.historyCursor!==member.group.sourceHistoryCursor||row.updated_at!==original!.companion.createdAt)return fail('last metadata head lacks its exact actual original operation')
  return{row,head}
}
type HeadingTitle3Supports={original:HeadingTitle3OriginalOperation;supports:RawHistoricalEvidenceLocator[]}
export function headingTitle3OriginalSupportsOwned(db:Database.Database,id:string):HeadingTitle3Supports{
  return originalSupports3(db,id,freshReadContext3(),new Set(),new Map())
}
function originalSupports3(db:Database.Database,id:string,context:HeadingTitle3ReadContext,active:Set<string>,memo:Map<string,HeadingTitle3Supports>):HeadingTitle3Supports{
  const cached=memo.get(id);if(cached)return cached
  if(active.has(id))return fail('cyclic original support closure')
  active.add(id)
  try{
  const original=readOriginal3(db,id,context);if(!original)return fail('actual metadata2 operation required')
  const supports=[historicalMetadataLocator(original.metadata)]
  for(const material of original.materials)for(const key of [material.group.sourcePointKey,material.group.afterPointKey]){const row=operation(db,key);if(!row)return fail('source/after point disappeared');supports.push(historicalOperationLocator(row))}
  if(original.journal){supports.push(historicalRowLocator('synced_host_history',[original.journal.id],original.journal))
    const pointer=setting(db,headingTitle3JournalKey(original.journal.id));if(!pointer)return fail('journal pointer disappeared');supports.push(historicalMetadataLocator(pointer))
    for(const pin of original.journalPins)supports.push(historicalRowLocator('synced_group_pins',[pin.group_id,pin.kind,pin.pin_id],pin))}
  if(original.companion.initialCompanion){const row=setting(db,original.companion.initialCompanion.key);if(!row)return fail('initial companion disappeared');supports.push(historicalMetadataLocator(row))}
  if(original.companion.intent.kind==='restore'){
    const initialId=original.initialOperationId
    if(!initialId||initialId===id)return fail('restore initial operation address missing/cyclic')
    const initialRow=operation(db,initialId);if(!initialRow)return fail('restore initial operation disappeared')
    supports.push(historicalOperationLocator(initialRow),...originalSupports3(db,initialId,context,active,memo).supports)
  }
  for(const material of original.materials){
    if(material.group.previous===null)continue
    const row=operation(db,material.group.previous.operationId);if(!row)return fail('previous actual operation disappeared')
    supports.push(historicalOperationLocator(row))
    if(material.group.previous.kind==='heading-create-birth')supports.push(...syncedHeadingCreateBirthOriginalSupportsOwned2(db,row.client_operation_id).supports)
    else supports.push(...originalSupports3(db,row.client_operation_id,context,active,memo).supports)
  }
  const byAddress=new Map<string,typeof supports[number]>()
  for(const support of supports){const key=hostEncode([support.table,support.key]),previous=byAddress.get(key)
    if(previous&&previous.rowHash!==support.rowHash)return fail('contradictory exact original support address')
    byAddress.set(key,support)}
  const complete={original,supports:[...byAddress.values()]};memo.set(id,complete);return complete
  }finally{active.delete(id)}
}

/** Actual Main current-data precondition only. The immutable chain is reopened
 * from exact SQL originals and compared against a fresh native whole point.
 * A head is an index: its matching operation, companion, points and every old
 * Key/birth support must still authenticate before it can select DATA. */
export function readHeadingTitle3CurrentPredecessorOwned(db:Database.Database,groupId:string){
  return currentPredecessor3(db,groupId,freshReadContext3())
}
function currentPredecessor3(db:Database.Database,groupId:string,context:HeadingTitle3ReadContext){
  owned(db)
  const current=prepareSyncedMetadataGroupBaselineCurrentCaptureOwned2(db,groupId)
  const head=readGroupHead3(db,groupId,context)
  let point:ReturnType<typeof readSyncedMetadataCaptureRecordOwned2>,covered:HeadingTitleCoveredKey3[],previous:HeadingTitle3Group['previous']
  if(head){
    const original=readOriginal3(db,head.head.operationId,context),member=original?.materials.find(item=>item.group.groupId===groupId)
    if(!original||!member)return fail('current indexed chain disappeared')
    point=member.afterPoint;covered=member.covered
    previous={kind:'heading-title-transition',operationId:original.row.client_operation_id,companionHash:original.companion.companionHash}
  }else{
    const life=readSyncedGroupLifecycles(db,[groupId]).get(groupId)
    if(!life||life.state!=='active'||!life.createHistoryId)throw new HeadingTitle3LineageRequired('actual active original create chain unavailable')
    const row=readHistoricalExactRows<SyncedHostHistoryBranchRow>(db,'synced_host_history',
      ['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],'id=?',[life.createHistoryId])[0]
    if(!row)return fail('declared original create journal missing')
    const journal=decodeHostCreateJournal(row),birth=readSyncedHeadingCreateBirthOriginalOwned2(db,journal.input.clientOperationId)
    if(!birth||birth.result.createdLifecycle.groupId!==groupId)throw new HeadingTitle3LineageRequired('old bare/imported Key has no business-bound heading birth')
    point=birth.point
    covered=birth.companion.covered.map(item=>{
      if(item.heading.location.kind!=='ordinary')return fail('initial ordinary heading birth differs')
      return{birthOperationId:birth.row.client_operation_id,birthKey:item.canonicalKey,key:item.canonicalKey,target:item.storedTarget,location:item.heading.location,headingKey:item.heading.key}
    })
    previous={kind:'heading-create-birth',operationId:birth.row.client_operation_id,companionHash:birth.envelope.companionHash}
  }
  if(!hostEqual(headingTitlePointMaterial3(current),headingTitlePointMaterial3(point)))throw new HeadingTitle3LineageRequired('actual current whole source/namespace point differs from the last committed chain')
  return{previous,point,covered,current,writePermit:false as const,currentMutationAuthorized:false as const}
}

/** Explicit data-only source for a mixed document/block member. A genuine old
 * heading chain is preserved when available. Old bare groups without one get
 * an empty covered set, so neither actual W nor A can touch a heading Key. */
export function readHeadingTitle3MixedSourceOwned(db:Database.Database,groupId:string){
  return mixedSource3(db,groupId,freshReadContext3())
}
function mixedSource3(db:Database.Database,groupId:string,context:HeadingTitle3ReadContext){
  owned(db)
  const head=readGroupHead3(db,groupId,context)
  if(head)return currentPredecessor3(db,groupId,context)
  const life=readSyncedGroupLifecycles(db,[groupId]).get(groupId)
  if(life?.createHistoryId){
    const row=readHistoricalExactRows<SyncedHostHistoryBranchRow>(db,'synced_host_history',
      ['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],'id=?',[life.createHistoryId])[0]
    if(!row)return fail('declared original create journal missing')
    const journal=decodeHostCreateJournal(row)
    if(readSyncedHeadingCreateBirthOriginalOwned2(db,journal.input.clientOperationId))return currentPredecessor3(db,groupId,context)
  }
  const current=prepareSyncedMetadataGroupBaselineCurrentCaptureOwned2(db,groupId)
  return{previous:null,point:null,covered:[] as HeadingTitleCoveredKey3[],current,writePermit:false as const,currentMutationAuthorized:false as const}
}

/** The actual writer supplies its independently enumerated affected IDs. One
 * owned call shares only immutable original DATA across their common DAG;
 * no returned map is accepted as a caller proof or retained for another read. */
export function readHeadingTitle3CurrentSourcesOwned(db:Database.Database,groupIds:readonly string[]){
  owned(db)
  if(new Set(groupIds).size!==groupIds.length||groupIds.some(id=>!isSyncedUuid(id)))return fail('current source IDs differ')
  const context=freshReadContext3()
  return new Map(groupIds.map(id=>[id,mixedSource3(db,id,context)]))
}

/** Generic nonce lookup selects only the actual immutable envelope. The old
 * row-only parsers retain their closed domain and never accept the new kind. */
export function decodeSyncedOperationWithHeadingTitle3Owned(db:Database.Database,row:{client_operation_id:string;request_hash:string;result_json:string}){
  // The canonical title3 envelope writes this ASCII discriminator literally.
  if (typeof row.result_json === 'string' && !row.result_json.includes(HEADING_TITLE3_OPERATION_KIND)) {
    return decodeSyncedOperationWithHeadingBirthOwned2(db, row)
  }
  let packet:unknown
  try{packet=hostJson(row.result_json)}catch{
    // A malformed discriminator cannot identify this new envelope. Preserve
    // the existing strict decoder's corruption error rather than replacing it
    // with a bare JSON parse exception. No SQL read errors are caught here.
    return decodeSyncedOperationWithHeadingBirthOwned2(db,row)
  }
  if(packet&&typeof packet==='object'&&'kind'in packet&&packet.kind===HEADING_TITLE3_OPERATION_KIND){
    const original=readHeadingTitle3OriginalOperationOwned(db,row.client_operation_id)
    if(!original||original.row.request_hash!==row.request_hash||original.row.result_json!==row.result_json)return fail('lookup row differs from its actual complete original')
    return original.envelope.result
  }
  return decodeSyncedOperationWithHeadingBirthOwned2(db,row)
}

/** Fixed Main factory over ONE complete actual operations and metadata read.
 * Its maps are DATA for this finished public read, never accepted by a writer,
 * passed back as a cache/owner, or retained across another SQL observation. */
export function readHeadingTitle3OriginalSnapshotOwned(db:Database.Database){
  if(!db.open||!db.inTransaction)return fail('actual owned original snapshot required')
  const started=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const rows=readSyncedHistoricalOperationsWithMetadata2Owned2(db)
  const {metadata,headingBirthMetadata}=readHistoricalMetadataWithHeadingCreateBirthOwned2(db)
  const headingTitleMetadata=metadata.filter(row=>row.key.toLowerCase().startsWith('synced.heading.title'))
  const context=freshReadContext3();context.operations=new Map(rows.map(row=>[row.client_operation_id,row]));context.metadata=new Map(metadata.map(row=>[row.key,row]))
  const active=new Set<string>(),memo=new Map<string,HeadingTitle3Supports>()
  for(const row of rows){
    // Every valid new producer uses the strict canonical envelope, whose ASCII
    // kind is literal in the original TEXT. Skip only redundant parsing of old
    // large packets here. The complete caller operation loop still classifies
    // every row; an escaped/noncanonical new kind has no authenticated entry
    // and is rejected there. Reverse metadata validation below is unconditional.
    if(!row.result_json.includes(HEADING_TITLE3_OPERATION_KIND))continue
    const packet=hostJson(row.result_json)
    if(packet&&typeof packet==='object'&&'kind'in packet&&packet.kind===HEADING_TITLE3_OPERATION_KIND)originalSupports3(db,row.client_operation_id,context,active,memo)}
  for(const row of headingTitleMetadata){
    if(row.key.startsWith(HEADING_TITLE3_COMPANION_PREFIX)){
      const id=row.key.slice(HEADING_TITLE3_COMPANION_PREFIX.length),original=readOriginal3(db,id,context)
      if(!original||original.metadata.value!==row.value||original.metadata.updated_at!==row.updated_at)return fail('orphan/rebound heading title companion')
    }else if(row.key.startsWith(HEADING_TITLE3_JOURNAL_PREFIX)){
      const pointer=decodeHeadingTitle3JournalPointer(hostJson(row.value)),id=row.key.slice(HEADING_TITLE3_JOURNAL_PREFIX.length),original=readOriginal3(db,pointer.initialOperationId,context)
      if(!original||original.companion.intent.kind!=='apply'||original.companion.historyToken!==id||pointer.historyToken!==id
        ||row.value!==hostEncode(pointer)||pointer.companionHash!==original.companion.companionHash)return fail('orphan/rebound heading title journal pointer')
    }else if(row.key.startsWith(HEADING_TITLE3_GROUP_HEAD_PREFIX)){
      const head=decodeHeadingTitle3GroupHead(hostJson(row.value)),id=row.key.slice(HEADING_TITLE3_GROUP_HEAD_PREFIX.length),original=readOriginal3(db,head.operationId,context)
      const member=original?.materials.find(item=>item.group.groupId===id)
      if(!original||!member||head.groupId!==id||row.value!==hostEncode(head)||head.companionHash!==original.companion.companionHash
        ||head.creationId!==member.group.creationId||head.groupCreatedAt!==member.group.createdAt||head.revision!==member.group.afterRevision
        ||head.topologyRevision!==member.group.sourceTopologyRevision||head.historyCursor!==member.group.sourceHistoryCursor
        ||head.wireHash!==member.group.afterHash||row.updated_at!==original.companion.createdAt)return fail('orphan/rebound heading title group head')
    }else return fail('unknown heading title metadata family/version/case')
  }
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==started)return fail('SQL changed during original snapshot validation')
  return{rows,metadata,headingBirthMetadata,headingTitleMetadata,originals:memo as ReadonlyMap<string,HeadingTitle3Supports>}
}
/** Complete reserved metadata scan; no unknown title version is treated as
 * ordinary opaque settings. Heads remain historical indexes after later user
 * edits, so original admission does not demand that today's body equals them. */
export function assertHeadingTitle3OriginalFamilyOwned(db:Database.Database):HistoricalMetadataRow[]{
  owned(db)
  const rows=readHistoricalExactRows<HistoricalMetadataRow>(db,'app_settings',['key','value','updated_at'],"lower(key) LIKE 'synced.heading.title%'")
  for(const row of rows){
    if(row.key.startsWith(HEADING_TITLE3_COMPANION_PREFIX)){const id=row.key.slice(HEADING_TITLE3_COMPANION_PREFIX.length);if(!readHeadingTitle3OriginalOperationOwned(db,id))return fail('orphan title companion')}
    else if(row.key.startsWith(HEADING_TITLE3_JOURNAL_PREFIX)){if(!readHeadingTitle3JournalOriginalOwned(db,row.key.slice(HEADING_TITLE3_JOURNAL_PREFIX.length)))return fail('orphan title journal pointer')}
    else if(row.key.startsWith(HEADING_TITLE3_GROUP_HEAD_PREFIX)){if(!readHeadingTitle3GroupHeadOriginalOwned(db,row.key.slice(HEADING_TITLE3_GROUP_HEAD_PREFIX.length)))return fail('orphan title head')}
    else return fail('unknown title metadata family/version/case')
  }
  return rows
}
