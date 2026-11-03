import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { SyncedGroupWire, SyncedLinkBinding } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, validateSyncedGroupWire, validateSyncedHostForest, validatePersistedHostForest, validateSyncedHistoryState, parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { collectSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import { hostEncode, hostEqual, hostHash } from './synced-host-journal'
import { hostJson, hostTime } from './synced-host-document-read'
import { readHistoricalExactRows, readHistoricalOperationsWithMetadata2RowsOwned2 } from './synced-history-evidence-support'
import { projectSyncedHostHeadingFacts2, type SyncedHeadingHostFacts2, type SyncedHeadingInstanceIdentity2, type SyncedHeadingGroupFacts2 } from './synced-heading-projection2'
import { prepareSyncedMetadataAffectedTransitionsOwned2, prepareSyncedMetadataGroupCurrentCaptureOwned2, prepareSyncedMetadataGroupBaselineCurrentCaptureOwned2 } from './synced-metadata-transition2'

export const SYNCED_METADATA_CAPTURE2_PREFIX='synced.metadata2.current-capture:'
export const SYNCED_METADATA_CAPTURE2_PIN='metadata2-current-capture'
export const SYNCED_METADATA_BASELINE2_PREFIX='synced.metadata2.read-baseline:'
type Prepared=ReturnType<typeof prepareSyncedMetadataAffectedTransitionsOwned2>
type Capture=Prepared['batch']['currentCapture']
interface Source {wire:SyncedGroupWire;revision:string;topologyRevision:string}
interface Record2 {
  kind:'synced-metadata2-current-capture-record'|'synced-metadata2-group-capture-record'|'synced-metadata2-read-baseline-record';version:2;captureId:string;capturedAt:string;workspaceScope:string;recoveryEpoch:string
  pointHash?:string
  requestHash:string;originalHash:string;capture:Capture;sources:Source[];groupHistories:Prepared['groupHistories']
  businessOperationCommitted:false;writePermit:false;historicalKeyLineageComplete:false;recordHash:string
}
type Row={client_operation_id:string;request_hash:string;result_json:string;created_at:string}
declare const prepared:unique symbol
export interface PreparedSyncedMetadataCaptureRecord2 {readonly[prepared]:true}
const owners=new WeakMap<object,{db:Database.Database;key:string;hash:string}>()
const fail=(message:string):never=>{throw new Error('Metadata2 captured original invalid: '+message)}
const digest=(value:unknown)=>createHash('sha256').update('knowbook.synced.metadata2.capture-record.v2\0'+hostEncode(value)).digest('hex')
const pointMaterial=(value:Pick<Record2,'workspaceScope'|'recoveryEpoch'|'requestHash'|'capture'|'sources'|'groupHistories'>)=>({workspaceScope:value.workspaceScope,recoveryEpoch:value.recoveryEpoch,
  requestHash:value.requestHash,capture:value.capture,sources:value.sources,groupHistories:value.groupHistories})
const pointHash=(value:Parameters<typeof pointMaterial>[0])=>createHash('sha256').update('knowbook.synced.metadata2.read-baseline-point.v2\0'+hostEncode(pointMaterial(value))).digest('hex')
const text=(value:unknown):string=>typeof value==='string'?value:fail('text required')
const opaque=(value:unknown):string=>isSyncedBlockId(value)?value:fail('opaque identity required')
const uuid=(value:unknown):string=>isSyncedUuid(value)?value:fail('UUID required')
const hash=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail('SHA256 required')
const tuple=(binding:Pick<SyncedLinkBinding,'blockId'|'from'|'to'|'raw'|'syntax'>)=>hostEncode([binding.blockId,binding.from,binding.to,binding.raw,binding.syntax])
const key=(groupId:string,binding:Pick<SyncedLinkBinding,'blockId'|'from'|'to'|'raw'|'syntax'>)=>hostEncode([groupId,tuple(binding)])
function list<T>(value:unknown,read:(value:unknown)=>T,identity:(value:T)=>string):T[]{
  if(!Array.isArray(value))return fail('array required');const result=value.map(read)
  if(new Set(result.map(identity)).size!==result.length)return fail('duplicate captured identity');return result
}
function source(value:unknown):Source{
  assertSyncedShape(value,['wire','revision','topologyRevision'])
  const wire=validateSyncedGroupWire(value.wire),parsed=collectSyncedBindingOccurrences(wire.origin,wire.blocks),keys=new Set(parsed.map(tuple))
  if(keys.size!==parsed.length||wire.bindings.length!==keys.size||wire.bindings.some(binding=>!keys.has(tuple(binding))))return fail('original source parser Keys are incomplete')
  return{wire,revision:uuid(value.revision),topologyRevision:uuid(value.topologyRevision)}
}
function instance(value:unknown):SyncedHeadingInstanceIdentity2{
  assertSyncedShape(value,['hostDocumentId','hostCreatedAt','instanceId','instanceCreatedAt','groupId','creationId','groupCreatedAt'])
  return{hostDocumentId:opaque(value.hostDocumentId),hostCreatedAt:hostTime(value.hostCreatedAt),instanceId:uuid(value.instanceId),
    instanceCreatedAt:hostTime(value.instanceCreatedAt),groupId:uuid(value.groupId),creationId:uuid(value.creationId),groupCreatedAt:hostTime(value.groupCreatedAt)}
}
/** Strict pure packet validation. This reconstructs namespace/parser/range
 * relationships; neither a valid DTO nor its self hash grants a Main owner. */
function validateCapture(value:unknown,sources:Source[]):Capture{
  assertSyncedShape(value,['kind','version','workspaceScope','recoveryEpoch','sources','targets','namespaces','groups',
    'originalCaptureBirthProved','historicalKeyLineageProved','writePermit','captureHash'])
  if(value.kind!=='synced-metadata2-current-target-capture-batch'||value.version!==2||value.originalCaptureBirthProved!==false
    ||value.historicalKeyLineageProved!==false||value.writePermit!==false)return fail('capture domain/permissions invalid')
  uuid(value.workspaceScope);uuid(value.recoveryEpoch)
  const originals=new Map(sources.map(item=>[item.wire.id,item])),headers=sources.map(item=>({groupId:item.wire.id,creationId:item.wire.creationId,
    groupCreatedAt:item.wire.createdAt,sourceRevision:item.revision,sourceTopologyRevision:item.topologyRevision,sourceWireHash:hostHash(item.wire)}))
  if(!hostEqual(value.sources,headers))return fail('source tuple/CAS/wholewire commitments differ')
  const groupFacts=new Map<string,SyncedHeadingGroupFacts2>()
  for(const item of sources)groupFacts.set(item.wire.id,{groupId:item.wire.id,creationId:item.wire.creationId,createdAt:item.wire.createdAt,
    origin:item.wire.origin,bindings:item.wire.bindings,blocks:item.wire.blocks})
  const namespaceMaterialIds=new Set(list(value.groups,raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail('namespace group material required')
    const item=raw as Record<string,unknown>;uuid(item.revision);uuid(item.topologyRevision)
    if(item.kind==='transition-source'){
      assertSyncedShape(item,['kind','groupId','sourceWireHash','revision','topologyRevision'])
      const original=originals.get(uuid(item.groupId))??fail('dangling namespace source pointer')
      if(item.sourceWireHash!==hostHash(original.wire)||item.revision!==original.revision||item.topologyRevision!==original.topologyRevision)return fail('namespace pointer not its exact source')
      return original.wire.id
    }
    assertSyncedShape(item,['kind','wire','revision','topologyRevision']);if(item.kind!=='namespace-material')return fail('unknown namespace material kind')
    const wire=validateSyncedGroupWire(item.wire)
    if(groupFacts.has(wire.id))return fail('source namespace material is duplicated rather than referenced')
    groupFacts.set(wire.id,{groupId:wire.id,creationId:wire.creationId,createdAt:wire.createdAt,origin:wire.origin,bindings:wire.bindings,blocks:wire.blocks});return wire.id
  },item=>item))
  const requiredGroups=new Set<string>()
  const namespaces=list(value.namespaces,raw=>{
    assertSyncedShape(raw,['host','path','updatedAt','instances','headings','namespaceHash']);assertSyncedShape(raw.host,['documentId','createdAt','parentId','sortOrder','title','summary','blocks','births'])
    const saved=raw.host,blocks=Array.isArray(saved.blocks)&&saved.blocks.every(block=>block&&typeof block==='object'&&'type'in block&&block.type!=='synced-block')?validatePersistedHostForest(saved.blocks):validateSyncedHostForest(saved.blocks)
    const births=list(saved.births,pair=>{if(!Array.isArray(pair)||pair.length!==2)return fail('birth pair required');return[opaque(pair[0]),hostTime(pair[1])] as const},item=>item[0])
    if(births.length!==blocks.length||births.some((pair,index)=>pair[0]!==blocks[index].id))return fail('births do not cover the exact native forest order')
    if(!Number.isSafeInteger(saved.sortOrder))return fail('native host order invalid')
    const host:SyncedHeadingHostFacts2={documentId:opaque(saved.documentId),createdAt:hostTime(saved.createdAt),parentId:saved.parentId===null?null:opaque(saved.parentId),
      sortOrder:saved.sortOrder as number,title:text(saved.title),summary:text(saved.summary),blocks,births:new Map(births)}
    const instances=list(raw.instances,instance,item=>item.instanceId),headings=projectSyncedHostHeadingFacts2(host,groupFacts,new Map(instances.map(item=>[item.instanceId,item])))
    const leaves=new Map(blocks.filter(block=>block.type==='synced-block').map(block=>[block.id,block]))
    if(leaves.size!==instances.length)return fail('captured instances are not the exact host reference closure')
    for(const item of instances){
      const leaf=leaves.get(item.instanceId),groupId=leaf&&parseSyncedBlockPayload(leaf.content).groupId,group=groupId&&groupFacts.get(groupId)
      if(!leaf||!group||item.hostDocumentId!==host.documentId||item.hostCreatedAt!==host.createdAt||item.instanceCreatedAt!==host.births.get(leaf.id)
        ||item.groupId!==group.groupId||item.creationId!==group.creationId||item.groupCreatedAt!==group.createdAt)return fail('captured instance birth/mirror/incarnation differs')
      requiredGroups.add(group.groupId)
    }
    if(!hostEqual(raw.headings,headings))return fail('captured heading namespace differs from the full real occurrence projection')
    const namespaceHash=hostHash({documentId:host.documentId,createdAt:host.createdAt,path:text(raw.path),contentHash:hostHash({title:host.title,summary:host.summary,blocks:host.blocks}),
      births:[...host.births],instances,headings})
    if(hash(raw.namespaceHash)!==namespaceHash)return fail('namespace semantic hash invalid')
    hostTime(raw.updatedAt);return{host,path:raw.path,headings,namespaceHash}
  },item=>item.host.documentId)
  if(namespaceMaterialIds.size!==requiredGroups.size||[...requiredGroups].some(id=>!namespaceMaterialIds.has(id)))return fail('namespace material/pointer closure incomplete')
  const expectedHeadingDocuments=new Set(sources.flatMap(item=>item.wire.bindings.flatMap(binding=>binding.target.kind==='heading'?[binding.target.documentId]:[])))
  if(namespaces.some(namespace=>!expectedHeadingDocuments.has(namespace.host.documentId)))return fail('unreferenced namespace was added to a current capture')
  const byDocument=new Map(namespaces.map(item=>[item.host.documentId,item])),expected=new Map<string,{source:Source;binding:SyncedLinkBinding}>()
  for(const item of sources)for(const binding of item.wire.bindings)expected.set(key(item.wire.id,binding),{source:item,binding})
  const targets=list(value.targets,raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail('captured target required')
    const item=raw as Record<string,unknown>,groupId=uuid(item.sourceGroupId)
    assertSyncedShape(item.key,['blockId','from','to','raw','syntax'])
    const found=expected.get(key(groupId,item.key as unknown as SyncedLinkBinding))??fail('capture target has no exact original Key')
    if(item.sourceCreationId!==found.source.wire.creationId||item.sourceGroupCreatedAt!==found.source.wire.createdAt||!hostEqual(item.key,{
      blockId:found.binding.blockId,from:found.binding.from,to:found.binding.to,raw:found.binding.raw,syntax:found.binding.syntax})
      ||!hostEqual(item.storedTarget,found.binding.target)||item.captureDomain!=='metadata2-current-P'||item.originalCaptureBirthProved!==false
      ||item.historicalKeyLineageProved!==false)return fail('target source/birth domain differs')
    const common=['sourceGroupId','sourceCreationId','sourceGroupCreatedAt','key','storedTarget','captureDomain','originalCaptureBirthProved','historicalKeyLineageProved','status']
    const target=found.binding.target
    if(item.status==='current-heading'){
      assertSyncedShape(item,[...common,'documentId','documentCreatedAt','namespaceHash','heading'])
      const namespace=target.kind==='heading'?byDocument.get(target.documentId):undefined,matches=namespace?.headings.filter(heading=>target.kind==='heading'&&heading.slug===target.slug)??[]
      if(!namespace||matches.length!==1||item.documentId!==namespace.host.documentId||item.documentCreatedAt!==namespace.host.createdAt
        ||item.namespaceHash!==namespace.namespaceHash||!hostEqual(item.heading,matches[0]))return fail('current heading birth/occurrence is not its exact namespace')
    }else if(item.status==='requires-heading-evidence'){
      assertSyncedShape(item,common);if(target.kind!=='heading'||byDocument.get(target.documentId)?.headings.filter(heading=>heading.slug===target.slug).length===1)return fail('unproved heading classification invalid')
    }else if(item.status==='current-document'){
      assertSyncedShape(item,[...common,'documentId','documentCreatedAt','path']);if(target.kind!=='document'||item.documentId!==target.id)return fail('current document differs from original typed target');hostTime(item.documentCreatedAt);text(item.path)
    }else if(item.status==='current-block'){
      assertSyncedShape(item,[...common,'blockId','owner','ownerId','createdAt']);if(target.kind!=='block'||item.blockId!==target.id||item.owner!=='document'&&item.owner!=='group')return fail('current block classification invalid')
      if(item.owner==='group')uuid(item.ownerId);else opaque(item.ownerId);hostTime(item.createdAt)
    }else if(item.status==='current-missing'){
      assertSyncedShape(item,common);if(target.kind!=='document'&&target.kind!=='block')return fail('missing target classification invalid')
    }else if(item.status==='unresolved-literal'){
      assertSyncedShape(item,common);if(target.kind!=='unresolved-url')return fail('unresolved literal was promoted')
    }else return fail('unknown current target capture status')
    return key(groupId,found.binding)
  },item=>item)
  if(targets.length!==expected.size)return fail('captured target source closure incomplete')
  const {captureHash,...body}=value
  if(hash(captureHash)!==hostHash({domain:'knowbook.synced.metadata2.current-target-capture.v2',capture:body}))return fail('capture hash invalid')
  return value as unknown as Capture
}
export function decodeSyncedMetadataCaptureRecord2(row:Row):Record2{
  const value=hostJson(row.result_json)
  const baseline=value!==null&&typeof value==='object'&&'kind'in value&&value.kind==='synced-metadata2-read-baseline-record'
  assertSyncedShape(value,['kind','version','captureId','capturedAt','workspaceScope','recoveryEpoch','requestHash','originalHash','capture','sources','groupHistories',
    'businessOperationCommitted','writePermit','historicalKeyLineageComplete','recordHash',...(baseline?['pointHash']:[])])
  if(value.kind!=='synced-metadata2-current-capture-record'&&value.kind!=='synced-metadata2-group-capture-record'&&!baseline||value.version!==2||value.businessOperationCommitted!==false||value.writePermit!==false
    ||value.historicalKeyLineageComplete!==false)return fail('record is not a capture-only fact')
  const captureId=uuid(value.captureId),workspaceScope=uuid(value.workspaceScope),recoveryEpoch=uuid(value.recoveryEpoch),capturedAt=hostTime(value.capturedAt)
  hash(value.requestHash);hash(value.originalHash)
  const sources=list(value.sources,source,item=>item.wire.id),capture=validateCapture(value.capture,sources)
  if(capture.workspaceScope!==workspaceScope||capture.recoveryEpoch!==recoveryEpoch)return fail('capture workspace/epoch differ')
  const sourceById=new Map(sources.map(item=>[item.wire.id,item]))
  const histories=list(value.groupHistories,raw=>{
    assertSyncedShape(raw,['groupId','creationId','createdAt','position','history','undoSide','redoSide'])
    const item=sourceById.get(opaque(raw.groupId))??fail('history has no original group')
    if(raw.creationId!==item.wire.creationId||raw.createdAt!==item.wire.createdAt||!Number.isSafeInteger(raw.position)||(raw.position as number)<0)return fail('captured history incarnation/position invalid')
    const history=validateSyncedHistoryState(raw.history)
    if((raw.position===0)!==(history.undoToken===null))return fail('captured history pointer/position inconsistent')
    const side=(value:unknown,direction:'before'|'after')=>{
      const token=direction==='after'?history.undoToken:history.redoToken
      if(token===null){if(value!==null)return fail('unexpected absent history-side proof');return null}
      assertSyncedShape(value,['id','position','beforeHash','afterHash','rowHash','matchesCurrentWire'])
      if(value.id!==token||!Number.isSafeInteger(value.position)||value.position!==(raw.position as number)+(direction==='after'?0:1))return fail('captured side token/position differ')
      const beforeHash=hash(value.beforeHash),afterHash=hash(value.afterHash),rowHash=hash(value.rowHash),matchesCurrentWire=(direction==='after'?afterHash:beforeHash)===hostHash(item.wire)
      if(value.matchesCurrentWire!==matchesCurrentWire)return fail('captured exact-tail match is inconsistent')
      return{id:token,position:value.position as number,beforeHash,afterHash,rowHash,matchesCurrentWire}
    }
    return{groupId:item.wire.id,creationId:item.wire.creationId,createdAt:item.wire.createdAt,position:raw.position as number,history,
      undoSide:side(raw.undoSide,'after'),redoSide:side(raw.redoSide,'before')}
  },item=>item.groupId)
  if(histories.length!==sources.length)return fail('captured group history closure incomplete')
  const baselinePoint=baseline?hash(value.pointHash):null
  if(baseline&&(sources.length!==1||baselinePoint!==pointHash({workspaceScope,recoveryEpoch,requestHash:hash(value.requestHash),capture,sources,groupHistories:histories})))return fail('baseline point material/hash invalid')
  const {recordHash,...body}=value
  const rowKey=baseline?SYNCED_METADATA_BASELINE2_PREFIX+baselinePoint:SYNCED_METADATA_CAPTURE2_PREFIX+captureId
  if(hash(recordHash)!==digest(body)||row.client_operation_id!==rowKey||row.request_hash!==recordHash
    ||row.created_at!==capturedAt||hostEncode(value)!==row.result_json)return fail('actual record row/bytes/hash differ')
  return value as unknown as Record2
}
/** Actual capture-only persistence, not a document save or operation ACK.
 * The complete future writer uses the owned helper in its one transaction. */
export function captureSyncedMetadataEditOriginal2(db:Database.Database,input:unknown):PreparedSyncedMetadataCaptureRecord2{
  if(db.inTransaction)throw new Error('Metadata2 capture must own its outer IMMEDIATE transaction.')
  if(db.pragma('foreign_keys',{simple:true})!==1)throw new Error('Metadata2 capture requires FKON.')
  const saved=db.transaction(()=>captureSyncedMetadataEditOriginalOwned2(db,input)).immediate()
  return saved
}
/** No caller rows or mapper enter this persistence path. */
export function captureSyncedMetadataEditOriginalOwned2(db:Database.Database,input:unknown):PreparedSyncedMetadataCaptureRecord2{
  const actual=prepareSyncedMetadataAffectedTransitionsOwned2(db,input),batch=actual.batch,captureId=randomUUID()
  const body={kind:'synced-metadata2-current-capture-record' as const,version:2 as const,captureId,capturedAt:batch.capturedAt,
    workspaceScope:batch.workspaceScope,recoveryEpoch:batch.recoveryEpoch,requestHash:batch.requestHash,originalHash:batch.originalHash,capture:batch.currentCapture,
    sources:batch.transitions.map(item=>({wire:item.before,revision:item.sourceRevision,topologyRevision:item.sourceTopologyRevision})),groupHistories:actual.groupHistories,
    businessOperationCommitted:false as const,writePermit:false as const,historicalKeyLineageComplete:false as const}
  return persistCaptureRecordOwned2(db,body)
}
/** Canonical editing has its own genuine source factory/discriminant. It does
 * not fabricate a host-final request or mix a smaller P DTO into the old API. */
export function captureSyncedMetadataGroupEditOriginal2(db:Database.Database,input:unknown):PreparedSyncedMetadataCaptureRecord2{
  if(db.inTransaction)throw new Error('Metadata2 group capture must own its outer IMMEDIATE transaction.')
  if(db.pragma('foreign_keys',{simple:true})!==1)throw new Error('Metadata2 group capture requires FKON.')
  return db.transaction(()=>captureSyncedMetadataGroupEditOriginalOwned2(db,input)).immediate()
}
export function captureSyncedMetadataGroupEditOriginalOwned2(db:Database.Database,input:unknown):PreparedSyncedMetadataCaptureRecord2{
  const original=prepareSyncedMetadataGroupCurrentCaptureOwned2(db,input)
  const body={kind:'synced-metadata2-group-capture-record' as const,version:2 as const,captureId:randomUUID(),...original,
    businessOperationCommitted:false as const,writePermit:false as const,historicalKeyLineageComplete:false as const}
  return persistCaptureRecordOwned2(db,body)
}
/** New session baseline caller. Equal actual point material reuses its first
 * durable observation, never a new capture birth. Unrelated global-P changes
 * cannot create endless duplicate records on repeated Source opens. Full
 * structural equality accompanies the content address; a matching hash alone
 * never grafts a caller record onto a Main owner. No group pin is installed:
 * this copied read evidence must not prevent a legitimate create-Undo retire. */
export function captureSyncedMetadataReadBaselineOwned2(db:Database.Database,groupId:string):PreparedSyncedMetadataCaptureRecord2{
  const original=prepareSyncedMetadataGroupBaselineCurrentCaptureOwned2(db,groupId),point=pointHash(original),key=SYNCED_METADATA_BASELINE2_PREFIX+point
  const existing=db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(key)
  if(existing){
    const value=actualRecord(db,key)
    if(value.kind!=='synced-metadata2-read-baseline-record'||!hostEqual(pointMaterial(value),pointMaterial(original)))return fail('same point key has different actual material')
    const owner=Object.freeze(Object.create(null)) as PreparedSyncedMetadataCaptureRecord2;owners.set(owner,{db,key,hash:value.recordHash});return owner
  }
  const body={kind:'synced-metadata2-read-baseline-record' as const,version:2 as const,captureId:randomUUID(),pointHash:point,...original,
    businessOperationCommitted:false as const,writePermit:false as const,historicalKeyLineageComplete:false as const}
  return persistCaptureRecordOwned2(db,body)
}
function persistCaptureRecordOwned2(db:Database.Database,body:Omit<Record2,'recordHash'>):PreparedSyncedMetadataCaptureRecord2{
  const captureId=body.captureId
  const record={...body,recordHash:digest(body)},baseline=body.kind==='synced-metadata2-read-baseline-record',key=baseline?SYNCED_METADATA_BASELINE2_PREFIX+body.pointHash:SYNCED_METADATA_CAPTURE2_PREFIX+captureId
  const row={client_operation_id:key,request_hash:record.recordHash,result_json:hostEncode(record),created_at:record.capturedAt}
  decodeSyncedMetadataCaptureRecord2(row)
  const started=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)').run(row.client_operation_id,row.request_hash,row.result_json,row.created_at)
  const pin=db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)')
  if(!baseline)for(const source of record.sources)pin.run(source.wire.id,SYNCED_METADATA_CAPTURE2_PIN,key,record.capturedAt)
  const readback=actualRecord(db,key)
  if(readback.recordHash!==record.recordHash)return fail('new capture did not independently read back its exact record')
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n-started!==1+(baseline?0:record.sources.length))
    return fail('capture-only persistence performed unexpected SQL writes')
  const owner=Object.freeze(Object.create(null)) as PreparedSyncedMetadataCaptureRecord2;owners.set(owner,{db,key,hash:record.recordHash});return owner
}
function actualRecord(db:Database.Database,key:string){
  if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27)return fail('actual owned schema27 SQL snapshot required')
  const started=(db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const row=readHistoricalExactRows<Row>(db,'synced_operations',['client_operation_id','request_hash','result_json','created_at'],'client_operation_id=?',[key])[0]
  if(!row)return fail('persisted capture original missing')
  const value=decodeSyncedMetadataCaptureRecord2(row),pins=readHistoricalExactRows<{group_id:string;created_at:string}>(db,'synced_group_pins',['group_id','created_at'],
    'kind=? AND pin_id=? ORDER BY group_id',[SYNCED_METADATA_CAPTURE2_PIN,key])
  const ids=new Set(value.sources.map(item=>item.wire.id))
  if(value.kind==='synced-metadata2-read-baseline-record'?pins.length!==0:pins.length!==ids.size||pins.some(pin=>!ids.has(pin.group_id)||pin.created_at!==value.capturedAt))return fail('persisted capture pins do not exactly bind its source groups')
  if((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n!==started)return fail('SQL changed during actual record/pin verification')
  return value
}
/** Full reserved-family read for original-history/asset consumers. It only
 * authenticates this actual row and its finite pin rule, not a live session. */
export function readSyncedMetadataCaptureOriginalRowOwned2(db:Database.Database,row:Row){
  const value=actualRecord(db,row.client_operation_id)
  if(value.recordHash!==row.request_hash||value.capturedAt!==row.created_at||hostEncode(value)!==row.result_json)return fail('original reserved row differs from its actual SQL readback')
  return value
}
/** Reverse reserved-family closure: an orphan pin/unknown version/case variant
 * cannot become an ordinary opaque operation merely because no row decoder
 * was selected. This full scan belongs to original-history admission, not
 * every normal read-source open. */
export function assertSyncedMetadataCaptureFamilyOwned2(db:Database.Database):void{
  if(!db.open||!db.inTransaction)return fail('reserved capture family requires actual owned SQL')
  const rows=readHistoricalExactRows<Row>(db,'synced_operations',['client_operation_id','request_hash','result_json','created_at'],
    "lower(client_operation_id) LIKE 'synced.metadata2%' OR lower(client_operation_id) LIKE 'synced:metadata2%'")
  assertActualMetadataCaptureRowsOwned2(db,rows)
}
/** Fixed Main factory: actual full SQL rows and their SQL-selected subset come
 * from this invocation. No caller rows/allowlist/cache can enter validation.
 * Public standalone family assertion above retains its own original read. */
export function readSyncedHistoricalOperationsWithMetadata2Owned2(db:Database.Database):Row[]{
  if(!db.open||!db.inTransaction)return fail('reserved capture family requires actual owned SQL')
  const actual=readHistoricalOperationsWithMetadata2RowsOwned2(db)
  assertActualMetadataCaptureRowsOwned2(db,actual.reserved)
  return actual.rows
}
function assertActualMetadataCaptureRowsOwned2(db:Database.Database,rows:readonly Row[]):void{
  const keys=new Set<string>()
  for(const row of rows){
    const record=actualRecord(db,row.client_operation_id)
    if(hostEncode(record)!==row.result_json)return fail('reserved original capture bytes differ')
    keys.add(row.client_operation_id)
  }
  for(const pin of readHistoricalExactRows<{group_id:string;kind:string;pin_id:string;created_at:string}>(db,'synced_group_pins',['group_id','kind','pin_id','created_at'],"lower(kind) LIKE 'metadata2%'")){
    if(pin.kind!==SYNCED_METADATA_CAPTURE2_PIN||!keys.has(pin.pin_id))return fail('unknown/orphan reserved capture pin')
    const record=actualRecord(db,pin.pin_id)
    if(record.kind==='synced-metadata2-read-baseline-record'||!record.sources.some(source=>source.wire.id===pin.group_id)||record.capturedAt!==pin.created_at)return fail('reserved capture pin does not bind its exact actual source')
  }
}
/** Every read reopens the actual row and exact pins. A DTO/hash/clone cannot
 * recover the private registry identity or grant business-write permission. */
export function readSyncedMetadataCaptureRecordOwned2(db:Database.Database,owner:PreparedSyncedMetadataCaptureRecord2){
  const entry=owner&&typeof owner==='object'?owners.get(owner):undefined
  if(!entry||entry.db!==db)return fail('not a genuine same-connection capture owner')
  const value=actualRecord(db,entry.key);if(value.recordHash!==entry.hash)return fail('immutable actual capture record changed')
  return value
}
/** Known-record read namespace, not a session or an executable history owner. */
export function reopenSyncedMetadataCaptureRecordOwned2(db:Database.Database,key:string):PreparedSyncedMetadataCaptureRecord2{
  if(typeof key!=='string'||!(key.startsWith(SYNCED_METADATA_CAPTURE2_PREFIX)&&isSyncedUuid(key.slice(SYNCED_METADATA_CAPTURE2_PREFIX.length))
    ||key.startsWith(SYNCED_METADATA_BASELINE2_PREFIX)&&/^[a-f0-9]{64}$/.test(key.slice(SYNCED_METADATA_BASELINE2_PREFIX.length))))return fail('known exact capture key required')
  const record=actualRecord(db,key),owner=Object.freeze(Object.create(null)) as PreparedSyncedMetadataCaptureRecord2
  owners.set(owner,{db,key,hash:record.recordHash});return owner
}
/** An actual persisted metadata2 capture anchors exactly the side that was a
 * real execution tail when captured. Matching text/hash in another old row
 * never substitutes for its exact token/position. The original raw side stays
 * unchanged; this is evidence for the future continuity walker, not Undo. */
export function readSyncedMetadataCapturedHistorySideOwned2(db:Database.Database,owner:PreparedSyncedMetadataCaptureRecord2,
  input:{groupId:string;historyToken:string;side:'before'|'after'}){
  assertSyncedShape(input,['groupId','historyToken','side']);uuid(input.groupId);uuid(input.historyToken)
  if(input.side!=='before'&&input.side!=='after')return fail('closed history side required')
  const record=readSyncedMetadataCaptureRecordOwned2(db,owner),original=record.sources.find(item=>item.wire.id===input.groupId)
  const anchor=record.groupHistories.find(item=>item.groupId===input.groupId)
  if(!original||!anchor)return{status:'not-captured' as const,writePermit:false as const}
  const row=readHistoricalExactRows<{id:string;group_id:string;position:number;before_json:string;after_json:string;before_hash:string;after_hash:string;created_at:string}>(db,
    'synced_group_history',['id','group_id','position','before_json','after_json','before_hash','after_hash','created_at'],'id=? AND group_id=?',[input.historyToken,input.groupId])[0]
  if(!row)return{status:'missing' as const,writePermit:false as const}
  const wire=validateSyncedGroupWire(hostJson(input.side==='before'?row.before_json:row.after_json)),rawHash=hash(input.side==='before'?row.before_hash:row.after_hash)
  if(hostHash(wire)!==rawHash||wire.id!==original.wire.id||wire.creationId!==original.wire.creationId||wire.createdAt!==original.wire.createdAt
    ||!hostEqual(wire.origin,original.wire.origin))return fail('actual historical original/hash/incarnation invalid')
  const token=input.side==='after'?anchor.history.undoToken:anchor.history.redoToken,position=anchor.position+(input.side==='after'?0:1)
  const proof=input.side==='after'?anchor.undoSide:anchor.redoSide
  if(row.id!==token||row.position!==position||!proof||!proof.matchesCurrentWire||!hostEqual(wire,original.wire))return{status:'requires-history-lineage' as const,
    rawHash,writePermit:false as const,historicalKeyLineageComplete:false as const}
  if(hostHash({kind:'metadata2-original-group-history-row',row})!==proof.rowHash)return fail('immutable capture-anchored raw history row changed')
  const current=db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as {workspace_scope:string;recovery_epoch:string}|undefined
  return{status:'captured' as const,captureId:record.captureId,recordHash:record.recordHash,groupId:wire.id,historyToken:row.id,position:row.position,side:input.side,
    original:wire,rawHash,sourceCapture:record.capture.targets.filter(target=>target.sourceGroupId===wire.id),
    capturedWorkspaceScope:record.workspaceScope,capturedRecoveryEpoch:record.recoveryEpoch,
    currentEpochMatches:current?.workspace_scope===record.workspaceScope&&current.recovery_epoch===record.recoveryEpoch,
    metadata2CurrentCaptureProved:true as const,legacyOriginalCaptureBirthProved:false as const,rawJournalRewritten:false as const,
    historicalKeyLineageComplete:false as const,writePermit:false as const}
}
