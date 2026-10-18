import type { SyncedCanonicalWire, SyncedGroupWire } from '../../shared/synced-blocks'
import { parseSyncedBlockPayload, SyncedValidationError } from '../../shared/syncedBlockValidation'
import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson, SyncedPublicationError } from './synced-publication-model'
import { validateSyncedProtocol5Snapshot, type SyncedProtocol5Snapshot, type SyncedProtocol5Record } from './synced-protocol5-model'
import { planSyncedTombstoneExchange } from './synced-exchange-tombstone-plan'
import { assertConflictData } from './synced-exchange-conflict-model'
import { deriveSyncedExchangeDependencyFacts } from './synced-exchange-plan'
import type { ExchangeComponent, ExchangeDeferredReason, ExchangeTransfer } from './synced-exchange-model'
import type { TombstoneAcceptedSide, TombstoneIdentityEffect, TombstoneLocalOutcome } from './synced-exchange-tombstone-types'
import { logicalDeletionChoiceIntentHash, type DeletionChoiceIntent } from './synced-logical-deletion-choice-model'
import { deletionDecisionsHash, deletionDecisionSourceHash, validateDeletionDecisions, validateDeletionDecisionSource,
  validateDeletionChoicePreviewComponent, type DeletionChoice, type DeletionChoiceComponentFence, type DeletionChoicePlan,
  type DeletionChoicePlanInput, type DeletionChoicePreviewComponent, type DeletionDecisionSource } from './synced-exchange-deletion-choice-model'

type Entry=SyncedProtocol5Snapshot['records'][number]
type Entries=Map<string,Entry>
type Physical={key:string;kind:'document'|'group';ownerId:string;birth:string|null}
type Trial={reason:ExchangeDeferredReason|null;choices:Entries;transfers:ExchangeTransfer[];intents:DeletionChoiceIntent[]}
const hash=(v:unknown):string=>publicationHash(publicationJson(v))
const same=(a:unknown,b:unknown):boolean=>publicationJson(a)===publicationJson(b)
const sort=(v:Iterable<string>):string[]=>[...new Set(v)].sort(publicationCompare)
const deleted=(r:SyncedProtocol5Record):boolean=>r.kind==='deleted'||r.kind==='synced-group-deleted'
const index=(s:SyncedProtocol5Snapshot):Entries=>new Map(s.records.map(row=>[row.key,row]))
const dto=(s:SyncedProtocol5Snapshot)=>({manifest:s.manifest,records:s.records})
const tuple=(r:SyncedGroupWire):unknown=>[r.id,r.creationId,r.createdAt,r.origin]
function snapshot(rows:Entries,workspaceId:string):SyncedProtocol5Snapshot {
  const records=[...rows.values()].sort((a,b)=>publicationCompare(a.key,b.key)),groups=new Map(records.flatMap(row=>row.record.kind==='synced-group'?[[row.record.id,row.hash] as const]:[]))
  const syncedInstances:SyncedProtocol5Snapshot['manifest']['syncedInstances']=[]
  for(const {record}of records)if(record.kind==='document')for(const block of record.content.blocks)if(block.type==='synced-block'){
    const groupId=parseSyncedBlockPayload(block.content).groupId,groupHash=groups.get(groupId)
    if(!groupHash)return publicationInvalid('删除决定最终ref缺真实live组。')
    syncedInstances.push({documentId:record.id,instanceId:block.id,groupId,groupHash})
  }
  syncedInstances.sort((a,b)=>publicationCompare(a.documentId,b.documentId)||publicationCompare(a.instanceId,b.instanceId))
  return validateSyncedProtocol5Snapshot({version:5,workspaceId,entries:Object.fromEntries(records.map(row=>[row.key,row.hash])),syncedInstances},records.map(({key,record})=>({key,record})))
}
function physical(rows:Entries):Map<string,Physical> {
  const result=new Map<string,Physical>()
  for(const {key,record}of rows.values())if(record.kind==='document'||record.kind==='synced-group')for(const child of record.kind==='document'?record.content.blocks:record.blocks){
    if(result.has(child.id))return publicationInvalid('删除决定原side/候选物理owner重复。')
    result.set(child.id,{key,kind:record.kind==='document'?'document':'group',ownerId:record.id,birth:record.kind==='synced-group'?(child as SyncedCanonicalWire).createdAt:null})
  }
  return result
}
function pathsValid(rows:Entries):boolean {
  const names=new Set<string>()
  for(const {record}of rows.values())if(record.kind==='document'){
    const title=record.content.title,id=publicationJson([record.parentId,title.replace(/[A-Z]/g,v=>v.toLowerCase())])
    if(title!==title.trim()||names.has(id))return false
    names.add(id)
  }
  return true
}
function ownership(input:DeletionChoicePlanInput,choices:Entries,trial:Entries):{reason:ExchangeDeferredReason|null;transfers:ExchangeTransfer[]} {
  const current=index(input.localPhysical),old=physical(current),ledger=new Map(input.authority.identities.map(row=>[row.id,row])),occupied=new Set(input.authority.occupiedDocumentIds),known=new Set(input.authority.knownGroupIds??[]),transfers:ExchangeTransfer[]=[]
  const seen=new Set<string>()
  for(const {record}of trial.values())if(record.kind==='document'||record.kind==='synced-group')for(const child of record.kind==='document'?record.content.blocks:record.blocks){if(seen.has(child.id))return {reason:'owner-source',transfers};seen.add(child.id)}
  const next=physical(trial)
  for(const [key,{record}]of choices){
    if(record.kind==='document'&&!current.has(key)&&occupied.has(record.id))return {reason:'owner-source',transfers}
    if(record.kind==='synced-group'){
      const previous=current.get(key)?.record
      if(previous?.kind==='synced-group'&&!same(tuple(previous),tuple(record))||!previous&&known.has(record.id))return {reason:'incarnation',transfers}
    }
  }
  for(const [id,row]of next)if(choices.has(row.key)){
    const before=old.get(id),identity=ledger.get(id)
    if(!before){if(identity)return {reason:identity.created_at===null?'unknown-birth':'owner-source',transfers};continue}
    if(!identity||identity.state!=='live'||identity.last_owner_kind!==before.kind||identity.last_owner_id!==before.ownerId||identity.created_at===null)return {reason:'unknown-birth',transfers}
    if(before.kind==='group'&&before.birth!==identity.created_at)return publicationInvalid('删除决定当前canonical实际birth与ledger不符。')
    const birth=row.kind==='group'?row.birth:identity.created_at
    if(birth===null||before.key!==row.key&&!choices.has(before.key))return {reason:'owner-source',transfers}
    if(birth!==identity.created_at&&!(before.kind==='document'&&row.kind==='group')&&!(before.key===row.key&&row.kind==='group'))return {reason:'unknown-birth',transfers}
    if(before.key!==row.key||birth!==identity.created_at)transfers.push({id,fromKind:before.kind,fromId:before.ownerId,fromCreatedAt:identity.created_at,toKind:row.kind,toId:row.ownerId,toCreatedAt:birth})
  }
  return {reason:null,transfers}
}
function buildSource(input:DeletionChoicePlanInput,fences:DeletionChoiceComponentFence[]):DeletionDecisionSource {
  return validateDeletionDecisionSource({domain:'synced-exchange.deletion-decisions.v1',databasePath:input.state.databasePath,targetFingerprint:input.state.targetFingerprint,workspaceScope:input.state.workspaceScope,recoveryEpoch:input.state.recoveryEpoch,remoteWorkspaceId:input.state.remoteWorkspaceId,
    state:input.state,localPhysical:dto(input.localPhysical),localKnowledge:dto(input.localKnowledge),remote:dto(input.remote),baseRecords:[...input.baseRecords].sort((a,b)=>publicationCompare(a.key,b.key)),authority:input.authority,localFingerprint:input.localFingerprint,remoteSource:input.remoteSource,componentFences:fences,
    resolution:input.resolution,decisions:validateDeletionDecisions((input.selections??[]).map(row=>row.decision).sort((a,b)=>publicationCompare(a.componentId,b.componentId))),selections:[...(input.selections??[])].sort((a,b)=>publicationCompare(a.decision.componentId,b.decision.componentId))})
}
/** New finite planner only. Old 1-6 planners are evaluated with their actual inputs and never rewritten or spoofed. */
export function planSyncedDeletionChoices(input:DeletionChoicePlanInput):DeletionChoicePlan {
  assertConflictData(input.selections??[]);assertConflictData(input.resolution);assertConflictData(input.remoteSource)
  const automatic=planSyncedTombstoneExchange(input),local=index(input.localKnowledge),physicalLocal=index(input.localPhysical),remote=index(input.remote),baseline=new Map(input.state.baseline.map(row=>[row.key,row])),base=new Map(input.baseRecords.map(row=>[row.key,row])),facts=new Map(input.authority.deletedFacts.map(row=>[row.key,row])),references=new Map(input.authority.deletionProofReferences.map(row=>[row.key,row])),identities=new Map(input.authority.identities.map(row=>[row.id,row]))
  if(hash(input.remote.manifest)!==input.remoteSource.manifestHash||!input.remoteSource.etag||!/^[a-f0-9]{64}$/.test(input.remoteSource.closureHash))return publicationInvalid('删除决定缺原真实remote closure/ETag。')
  for(const row of input.state.baseline)if(!base.has(row.key)){const found=[local.get(row.key),remote.get(row.key)].find(value=>value?.hash===(row.commonHash??row.remoteHash));if(found)base.set(row.key,found)}
  const components=automatic.components,byKey=new Map(components.flatMap(component=>component.keys.map(key=>[key,component] as const)))
  const fences:DeletionChoiceComponentFence[]=components.map(component=>{
    const deletionKeys=component.keys.filter(key=>{const r=remote.get(key);return r&&deleted(r.record)&&!facts.has(key)}),fixedDenials=[]
    for(const key of component.keys){const row=baseline.get(key),ref=references.get(key),l=local.get(key),r=remote.get(key)
      if(row?.local.kind==='absent'&&ref&&l?.hash===r?.hash&&l?.hash===ref.tombstoneHash&&row.local.tombstoneHash===ref.tombstoneHash&&row.local.deletionOperationId===ref.deletionOperationId&&row.local.intentHash===ref.intentHash)fixedDenials.push({...ref,baselineHash:hash(row)})
    }
    const componentId=hash({domain:'synced-deletion-choice-component.v1',component,deletionKeys,fixedDenials,records:component.keys.map(key=>({key,baseHash:baseline.get(key)?.commonHash??null,localHash:local.get(key)?.hash??null,remoteHash:remote.get(key)?.hash??null}))})
    return {...component,componentId,deletionKeys,fixedDenials}
  }).sort((a,b)=>publicationCompare(a.componentId,b.componentId))
  const selections=new Map<string,NonNullable<DeletionChoicePlanInput['selections']>[number]>()
  for(const selection of input.selections??[]){if(selections.has(selection.decision.componentId))return publicationInvalid('删除决定组件重复选择。');selections.set(selection.decision.componentId,selection)}
  const source=buildSource(input,fences),sourceHash=deletionDecisionSourceHash(source),previews:DeletionChoicePreviewComponent[]=[],deletions:DeletionChoiceIntent[]=[]
  const selectionByKey=new Map<string,DeletionDecisionSource['selections'][number]>()
  for(const row of source.selections)for(const key of row.preview.keys)selectionByKey.set(key,row)
  const related=new Map<string,DeletionDecisionSource['selections']>()
  for(const fence of fences){const matches=new Map<string,DeletionDecisionSource['selections'][number]>()
    for(const key of fence.keys){const row=selectionByKey.get(key);if(row)matches.set(row.decision.componentId,row)}
    related.set(fence.componentId,[...matches.values()].sort((a,b)=>publicationCompare(a.decision.componentId,b.decision.componentId)))
  }
  const consumed=new Set<string>(),staleComponents=new Set<string>()
  for(const fence of fences){const original=related.get(fence.componentId)!
    if(!original.length)continue
    for(const row of original)consumed.add(row.decision.componentId)
    if(original.length!==1){staleComponents.add(fence.componentId);continue}
    const old=original[0].preview
    const oldFence={keys:old.keys,localSignature:old.localSignature,remoteSignature:old.remoteSignature,dependencySignature:old.dependencySignature,componentId:old.componentId,deletionKeys:old.deletionKeys,fixedDenials:old.fixedDenials}
    if(!same(oldFence,fence))staleComponents.add(fence.componentId)
  }
  if(source.decisions.some(row=>!consumed.has(row.componentId)))return publicationInvalid('删除决定来自未知原keys；不能借无关组件授权。')
  const staleKeys=new Set(fences.filter(row=>staleComponents.has(row.componentId)).flatMap(row=>row.keys))
  const special=fences.filter(fence=>fence.deletionKeys.length>0),specialKeys=new Set(special.flatMap(row=>row.keys)),fixedKeys=new Set(fences.flatMap(row=>row.fixedDenials.map(ref=>ref.key)))
  const nextRemote=new Map(remote),finalLocal=new Map(local),accepted=new Set(automatic.accepted.filter(key=>!specialKeys.has(key)&&!fixedKeys.has(key)&&!staleKeys.has(key)))
  const autoL=index(automatic.localKnowledgeFinal),autoR=index(automatic.nextRemote)
  for(const key of accepted){finalLocal.set(key,autoL.get(key)!);nextRemote.set(key,autoR.get(key)!)}
  const transfers=automatic.transfers.filter(row=>{const before=identities.get(row.id),from=(before?.last_owner_kind==='group'?'group:':'doc:')+(before?.last_owner_id??''),to=(row.toKind==='group'?'group:':'doc:')+row.toId;return !specialKeys.has(from)&&!specialKeys.has(to)&&!staleKeys.has(from)&&!staleKeys.has(to)})
  const deferred=automatic.deferred.filter(row=>!row.keys.some(key=>specialKeys.has(key)||staleKeys.has(key))),merges=automatic.merges.filter(row=>!specialKeys.has(row.key)&&!staleKeys.has(row.key))
  for(const fence of fences)if(staleComponents.has(fence.componentId))deferred.push({keys:fence.keys,localSignature:fence.localSignature,remoteSignature:fence.remoteSignature,dependencySignature:fence.dependencySignature,reason:'dependency'})
  if(input.resolution&&input.resolution.decisionsHash!==deletionDecisionsHash(source.decisions))return publicationInvalid('删除决定resolve hash与完整原选择不符。')
  const intentByKey=new Map<string,DeletionChoiceIntent>(),missing=new Set(input.authority.missingBaseKeys??[]),pinned=new Set([...input.authority.pinnedGroupIds,...input.authority.pins.map(row=>row.groupId)])
  function trial(fence:DeletionChoiceComponentFence,choice:DeletionChoice):Trial {
    let reason:ExchangeDeferredReason|null=fence.keys.some(key=>input.authority.deferredKeys?.includes(key))?'dependency':null
    const choices:Entries=new Map(),intents:DeletionChoiceIntent[]=[],deletingBefore:Array<DeletionChoiceIntent['before']>=[],fixed=new Set(fence.fixedDenials.map(row=>row.key))
    for(const key of fence.keys){if(reason)break
      const l=local.get(key),r=remote.get(key),b=baseline.get(key),original=base.get(key)
      if(fixed.has(key)){choices.set(key,l!);continue}
      if(facts.has(key)||b?.local.kind==='absent'||l&&deleted(l.record)){reason='tombstone';break}
      if(b&&(!original||missing.has(key))){reason='baseline-missing';break}
      if(r&&deleted(r.record)){
        const before=physicalLocal.get(key)
        if(!before||!original||deleted(original.record)||!b||b.local.kind!=='live'){reason='baseline-missing';break}
        if(before.record.kind==='synced-group'){
          if(original.record.kind!=='synced-group'||r.record.kind!=='synced-group-deleted'||!same(tuple(before.record),tuple(original.record))||r.record.creationId!==before.record.creationId){reason='incarnation';break}
          if(r.record.previousHash!==original.hash){reason='tombstone';break}
        }else if(before.record.kind!=='document'||original.record.kind!=='document'||r.record.kind!=='deleted'||before.record.id!==original.record.id||before.record.createdAt!==original.record.createdAt){reason='incarnation';break}
      }
      let selected=choice==='keep-live'?l:r
      // A genuinely new R-only live record may be retained by either choice. Absence is never a deletion instruction.
      if(!selected&&choice==='keep-live'&&!b&&r&&!deleted(r.record))selected=r
      if(!selected){if(l||r||b)reason=choice==='keep-delete'?'tombstone':'local-removal';continue}
      choices.set(key,selected)
      if(!deleted(selected.record))continue
      const before=physicalLocal.get(key)
      if(!before||!original||before.record.kind!=='document'&&before.record.kind!=='synced-group'||original.record.kind!=='document'&&original.record.kind!=='synced-group'){reason='baseline-missing';break}
      deletingBefore.push(before.record)
      if(before.record.kind==='synced-group'&&pinned.has(before.record.id)){reason='history-pin';break}
      const effects:TombstoneIdentityEffect[]=[]
      for(const child of before.record.kind==='document'?before.record.content.blocks:before.record.blocks){const identity=identities.get(child.id)
        if(!identity||identity.state!=='live'||identity.last_owner_kind!==(before.record.kind==='document'?'document':'group')||identity.last_owner_id!==before.record.id||identity.created_at===null){reason='unknown-birth';break}
        effects.push({before:{...identity},after:{kind:'retained'}})
      }
      if(reason)break
      effects.sort((a,b)=>publicationCompare(a.before.id,b.before.id))
      // Eligibility trials have no invented preview, operation or permission. Only the actual selected deletion emits an intent.
      if(!input.resolution||selections.get(fence.componentId)?.decision.choice!=='keep-delete')continue
      const decision={...input.resolution,decisionSourceHash:sourceHash,componentId:fence.componentId,choice:'keep-delete' as const}
      const body={kind:before.record.kind==='document'?'document' as const:'group' as const,key,base:original.record,baseLiveHash:original.hash,before:before.record,localBeforeHash:before.hash,tombstoneHash:selected.hash,identities:effects,decision}
      intents.push({...body,intentHash:logicalDeletionChoiceIntentHash(body,{operationId:input.operationId,workspaceScope:input.state.workspaceScope,recoveryEpoch:input.state.recoveryEpoch,targetFingerprint:input.state.targetFingerprint,remoteWorkspaceId:input.state.remoteWorkspaceId})})
    }
    const deletingGroups=new Set(deletingBefore.filter(row=>row.kind==='synced-group').map(row=>row.id))
    if(!reason)for(const before of deletingBefore)if(before.kind==='document')for(const block of before.content.blocks)if(block.type==='synced-block'&&deletingGroups.has(parseSyncedBlockPayload(block.content).groupId))reason='history-pin'
    const trialL=new Map(finalLocal),trialR=new Map(nextRemote)
    for(const [key,row]of choices){trialL.set(key,row);trialR.set(key,row)}
    if(!reason&&input.authority.catalogId!=='catalog')for(const {record}of choices.values()){
      if(record.kind==='databases'&&record.tables.databases.some(row=>row.id===input.authority.catalogId)){reason='catalog';break}
      const blocks=record.kind==='document'?record.content.blocks:record.kind==='synced-group'?record.blocks:[]
      if(blocks.some(row=>row.type==='database-view'&&parseDatabaseViewPayload(row.content).databaseId===input.authority.catalogId)){reason='catalog';break}
    }
    let transition:ReturnType<typeof ownership>={reason:null,transfers:[]}
    if(!reason)transition=ownership(input,choices,trialL)
    reason??=transition.reason
    if(!reason)try{if(!pathsValid(trialL)||!pathsValid(trialR))reason='path';else{snapshot(trialL,input.state.workspaceScope);snapshot(trialR,input.state.remoteWorkspaceId)}}catch(cause){if(!(cause instanceof SyncedPublicationError)&&!(cause instanceof SyncedValidationError))throw cause;reason=fence.keys.includes('databases')?'catalog':'dependency'}
    if(!reason){const next=physical(trialL),byId=new Map(transition.transfers.map(row=>[row.id,row]))
      for(const intent of intents){for(const effect of intent.identities){const owner=next.get(effect.before.id);if(!owner){effect.after={kind:'retained'};continue}const move=byId.get(effect.before.id)
        if(!move||move.fromKind!==effect.before.last_owner_kind||move.fromId!==effect.before.last_owner_id||move.fromCreatedAt!==effect.before.created_at||move.toKind!==owner.kind||move.toId!==owner.ownerId)return publicationInvalid('删除决定完整转域没有真实owner/birth来源。')
        effect.after={kind:'transferred',ownerKind:move.toKind,ownerId:move.toId,createdAt:move.toCreatedAt}
      }const {intentHash:_old,...body}=intent;intent.intentHash=logicalDeletionChoiceIntentHash(body,{operationId:input.operationId,workspaceScope:input.state.workspaceScope,recoveryEpoch:input.state.recoveryEpoch,targetFingerprint:input.state.targetFingerprint,remoteWorkspaceId:input.state.remoteWorkspaceId})}
    }
    return {reason,choices,transfers:transition.transfers,intents}
  }
  for(const fence of special){
    if(staleComponents.has(fence.componentId))continue
    const live=trial(fence,'keep-live'),deletion=trial(fence,'keep-delete'),choices:DeletionChoice[]=[]
    if(live.reason===null)choices.push('keep-live');if(deletion.reason===null)choices.push('keep-delete')
    const preview=validateDeletionChoicePreviewComponent({...fence,records:fence.keys.map(key=>({key,baseHash:baseline.get(key)?.commonHash??null,localHash:local.get(key)?.hash??null,remoteHash:remote.get(key)?.hash??null})),choices,keepLiveReason:live.reason,keepDeleteReason:deletion.reason})
    previews.push(preview)
    const selection=selections.get(fence.componentId)
    if(!selection){deferred.push({...fence,reason:'tombstone'});continue}
    if(!input.resolution)return publicationInvalid('删除选择缺原preview绑定。')
    if(!same(validateDeletionChoicePreviewComponent(selection.preview),preview)||selection.decision.componentId!==fence.componentId||!preview.choices.includes(selection.decision.choice)){
      deferred.push({keys:fence.keys,localSignature:fence.localSignature,remoteSignature:fence.remoteSignature,dependencySignature:fence.dependencySignature,reason:'dependency'});continue
    }
    const chosen=selection.decision.choice==='keep-live'?live:deletion
    if(chosen.reason)return publicationInvalid('blocked删除组件不可借显式选择跳过guard。')
    for(const [key,row]of chosen.choices)if(!fixedKeys.has(key)){nextRemote.set(key,row);finalLocal.set(key,row);accepted.add(key)}
    transfers.push(...chosen.transfers)
    for(const intent of chosen.intents){deletions.push(intent);intentByKey.set(intent.key,intent)}
  }
  if([...selections.keys()].some(id=>!consumed.has(id)))return publicationInvalid('删除决定来自未知原组件。')
  const next=snapshot(nextRemote,input.state.remoteWorkspaceId),known=snapshot(finalLocal,input.state.workspaceScope),physicalFinal=snapshot(new Map([...finalLocal].filter(([,row])=>!deleted(row.record))),input.state.workspaceScope)
  const acceptedKeys=sort(accepted),writes=acceptedKeys.filter(key=>remote.get(key)?.hash!==nextRemote.get(key)?.hash),incoming=acceptedKeys.filter(key=>physicalLocal.get(key)?.hash!==(deleted(finalLocal.get(key)!.record)?undefined:finalLocal.get(key)?.hash))
  const dependencies=new Map(deriveSyncedExchangeDependencyFacts(known).map(row=>[row.key,row.dependencyKeys])),sides:TombstoneAcceptedSide[]=[]
  for(const key of acceptedKeys){const row=finalLocal.get(key)!,intent=intentByKey.get(key);let outcome:TombstoneLocalOutcome
    if(!deleted(row.record))outcome={kind:'live',hash:row.hash}
    else if(intent)outcome={kind:'absent',tombstoneHash:row.hash,deletionOperationId:input.operationId,intentHash:intent.intentHash}
    else return publicationInvalid('新7不得重签旧absence或凭无选择自动删除。')
    const outer=byKey.get(key),dependencyKeys=sort([...(dependencies.get(key)??[]),...(outer?.keys.filter(id=>id!==key)??[])])
    sides.push({key,beforeLocalHash:physicalLocal.get(key)?.hash??null,beforeRemoteHash:remote.get(key)?.hash??null,local:outcome,remoteHash:row.hash,commonHash:row.hash,dependencyKeys,dependencySignature:hash({domain:'delete-choice-accepted.v1',key,dependencies:dependencyKeys.map(id=>[id,nextRemote.get(id)?.hash??null]),local:outcome})})
  }
  const updates=new Map(input.state.baseline.map(row=>[row.key,row]))
  for(const side of sides)updates.set(side.key,{key:side.key,local:side.local,remoteHash:side.remoteHash,commonHash:side.commonHash,dependencyKeys:side.dependencyKeys,dependencySignature:side.dependencySignature,acceptedOperationId:input.operationId})
  for(const old of input.state.baseline)if(old.local.kind==='absent'&&!same(updates.get(old.key),old))return publicationInvalid('新删除决定改写了原永久absence接受来源。')
  const history=new Set(incoming)
  for(let changed=true;changed;){changed=false;for(const part of input.authority.historyComponents)if(part.some(key=>history.has(key)))for(const key of part)if(accepted.has(key)&&!history.has(key)){history.add(key);changed=true}}
  const result:DeletionChoicePlan={plannerVersion:'delete-choices-v1',nextRemote:next,localKnowledgeFinal:known,localPhysicalFinal:physicalFinal,writes,incoming,accepted:acceptedKeys,components:components.map(({keys,localSignature,remoteSignature,dependencySignature})=>({keys,localSignature,remoteSignature,dependencySignature})),deferred:deferred.map(({keys,localSignature,remoteSignature,dependencySignature,reason})=>({keys,localSignature,remoteSignature,dependencySignature,reason})),transfers:transfers.sort((a,b)=>publicationCompare(a.id,b.id)),historyBoundaryKeys:sort(history),acceptedSides:sides,nextBaseline:[...updates.values()].sort((a,b)=>publicationCompare(a.key,b.key)),deletions:deletions.sort((a,b)=>publicationCompare(a.key,b.key)),merges,localFingerprint:input.localFingerprint,beforeManifestHash:hash(input.remote.manifest),afterManifestHash:hash(next.manifest),planHash:'',decisionSource:source,decisionSourceHash:sourceHash,componentFences:fences,deletionPreviews:previews.sort((a,b)=>publicationCompare(a.componentId,b.componentId))}
  result.planHash=hash({...result,nextRemote:dto(next),localKnowledgeFinal:dto(known),localPhysicalFinal:dto(physicalFinal)})
  return result
}
/** Historical replay uses only the immutable required preimage; it never borrows today's SQL state or a spool. */
export function planSyncedDeletionChoicesFromSource(raw:DeletionDecisionSource,operationId:string):DeletionChoicePlan {
  const source=validateDeletionDecisionSource(raw)
  const read=(value:DeletionDecisionSource['localPhysical']):SyncedProtocol5Snapshot=>validateSyncedProtocol5Snapshot(value.manifest,value.records.map(({key,record})=>({key,record})))
  const input:DeletionChoicePlanInput={operationId,localPhysical:read(source.localPhysical),localKnowledge:read(source.localKnowledge),remote:read(source.remote),baseRecords:source.baseRecords,state:source.state,authority:source.authority,localFingerprint:source.localFingerprint,remoteSource:source.remoteSource,resolution:null,selections:[]}
  const observed=planSyncedDeletionChoices(input)
  if(!same(observed.componentFences,source.componentFences))return publicationInvalid('删除决定历史fence不能由原preimage重建。')
  if(source.resolution===null){if(source.decisions.length||source.selections.length)return publicationInvalid('删除决定历史缺原preview。');return observed}
  return planSyncedDeletionChoices({...input,resolution:source.resolution,selections:source.selections})
}
