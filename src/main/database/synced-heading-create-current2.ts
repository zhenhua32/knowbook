import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { hostEqual } from './synced-host-journal'
import { decodeHostCreateJournal } from './synced-host-create-codec'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { prepareSyncedMetadataGroupBaselineCurrentCaptureOwned2 } from './synced-metadata-transition2'
import { readHistoricalExactRows } from './synced-history-evidence-support'
import { readSyncedHeadingCreateBirthOriginalOwned2 } from './synced-heading-create-birth-read2'

/** Read evidence only. New business-linked creation proof is mandatory.
 * Neither a caller point/map nor a current same-slug heading can fill its gap.
 * This first precondition accepts only a complete unchanged original point;
 * later valid edits require a real continuity walker, not endpoint hashes. */
export function readSyncedCreatedHeadingPointCurrentOwned2(db:Database.Database,groupId:string) {
  if(!db.open||!db.inTransaction||db.pragma('main.user_version',{simple:true})!==27||!isSyncedUuid(groupId))
    throw new Error('Created heading point requires its actual owned schema27 SQL snapshot.')
  const unproved=(reason:string)=>({status:'requires-heading-lineage' as const,reason,writePermit:false as const})
  const item=getSyncedGroupSnapshots(db,{groupIds:[groupId]}).items[0]
  if(item.status!=='ready')return unproved('actual-active-group-unavailable')
  const life=readSyncedGroupLifecycles(db,[groupId]).get(groupId)
  if(!life||life.state!=='active'||!life.createHistoryId)return unproved('original-create-chain-unavailable')
  const row=readHistoricalExactRows<{id:string;action_json:string;before_json:string;after_json:string;before_hash:string;after_hash:string;created_at:string}>(
    db,'synced_host_history',['id','action_json','before_json','after_json','before_hash','after_hash','created_at'],'id=?',[life.createHistoryId])[0]
  if(!row)throw new Error('Declared original create history missing.')
  const journal=decodeHostCreateJournal(row)
  const original=readSyncedHeadingCreateBirthOriginalOwned2(db,journal.input.clientOperationId)
  if(!original)return unproved('old-or-imported-Key-has-no-business-bound-birth')
  const own=original.result.createdLifecycle
  if(own.groupId!==groupId||own.creationId!==item.snapshot.creationId||own.createdAt!==item.snapshot.createdAt
    ||!hostEqual(own.origin,item.snapshot.origin))return unproved('current-group-incarnation-differs')
  const current=prepareSyncedMetadataGroupBaselineCurrentCaptureOwned2(db,groupId)
  const material=(value:Pick<typeof current,'workspaceScope'|'recoveryEpoch'|'requestHash'|'capture'|'sources'|'groupHistories'>)=>({
    workspaceScope:value.workspaceScope,recoveryEpoch:value.recoveryEpoch,requestHash:value.requestHash,
    capture:value.capture,sources:value.sources,groupHistories:value.groupHistories})
  // Full namespace includes document updatedAt. A real edit then restoration of
  // equal text cannot silently reset this to the original creation observation.
  if(!hostEqual(material(current),material(original.point)))return unproved('source-or-whole-target-point-changed')
  return{status:'same-created-point' as const,original,current,writePermit:false as const,
    historicalKeyLineageComplete:false as const,currentMutationAuthorized:false as const}
}
