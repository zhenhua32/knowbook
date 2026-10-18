import type Database from 'better-sqlite3'
import { parseExchangeStored, type DeletionChoiceJob, type DeletionChoiceReceipt } from '../sync/synced-exchange-model'
import { LOGICAL_DELETION_CHANNEL } from '../sync/synced-logical-deletion-model'
import { validateSyncedLogicalDeletionChoiceProof, logicalDeletionChoiceRequestHash, logicalDeletionChoiceAnchorId } from '../sync/synced-logical-deletion-choice-model'
import { publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'

/** Exact historical metadata only. It never consults today's physical graph,
 * state, head, epoch, preview files or spool, and never reads a receipt recursively. */
export function assertHistoricalDeletionChoiceProofs(db:Database.Database,job:DeletionChoiceJob,receipt:DeletionChoiceReceipt):void {
  if(!db.open||!db.inTransaction)return publicationInvalid('删除选择历史首证只允许owned只读读取。')
  const same=(a:unknown,b:unknown):boolean=>publicationJson(a)===publicationJson(b),intents=new Map(job.deletions.map(row=>[row.key,row]))
  for(const ref of receipt.provenance.deletions){
    const row=db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(ref.anchorId)as
      {client_operation_id:string;request_hash:string;result_json:string;created_at:string}|undefined
    if(!row||publicationHash(row.result_json)!==ref.proofHash)return publicationInvalid('删除选择历史首证原件缺失/原hash改变。')
    const proof=validateSyncedLogicalDeletionChoiceProof(parseExchangeStored(row.result_json)),intent=intents.get(ref.key)
    const originalIntent={kind:proof.before.kind==='document'?'document':'group',key:proof.key,base:proof.base,baseLiveHash:proof.baseLiveHash,before:proof.before,localBeforeHash:proof.localBeforeHash,
      tombstoneHash:proof.tombstoneHash,identities:proof.identities,decision:proof.decision,intentHash:proof.intentHash}
    if(row.result_json!==publicationJson(proof)||row.client_operation_id!==logicalDeletionChoiceAnchorId(proof.before)||row.client_operation_id!==proof.persistence.anchorId
      ||row.request_hash!==logicalDeletionChoiceRequestHash(proof)||row.created_at!==proof.application.acceptedAt||proof.key!==ref.key||proof.intentHash!==ref.intentHash||!intent||!same(intent,originalIntent))
      return publicationInvalid('删除选择历史首证不属于准确原job7完整intent。')
    if(proof.application.operationId!==job.request.operationId||proof.application.requestHash!==job.requestHash||proof.application.acceptedAt!==receipt.result.acceptedAt
      ||proof.scopeAtApply.workspaceScope!==job.workspaceScope||proof.scopeAtApply.recoveryEpoch!==job.recoveryEpoch
      ||proof.source.targetFingerprint!==job.request.targetFingerprint||proof.source.workspaceId!==job.remoteWorkspaceId
      ||proof.source.manifestHash!==job.descriptor.expectedRemote.manifestHash||proof.source.closureHash!==job.decisionSource.remoteSource.closureHash
      ||proof.decision.decisionSourceHash!==job.decisionSourceHash||proof.decision.previewId!==job.resolution.previewId||proof.decision.previewHash!==job.resolution.previewHash||proof.decision.decisionsHash!==job.resolution.decisionsHash
      ||proof.localBefore.keyGuard!==job.decisionSource.authority.keyGuards?.find(row=>row.key===proof.key)?.fingerprint)
      return publicationInvalid('删除选择历史首证的原请求/来源/决定绑定不符。')
    const anchor=db.prepare('SELECT id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at FROM synced_exposure_attempts WHERE id=?').get(ref.anchorId)as
      {id:string;request_hash:string;channel:string;target_fingerprint:string;publication_hash:string;state:string;created_at:string;confirmed_at:string|null}|undefined
    if(!anchor||anchor.id!==row.client_operation_id||anchor.request_hash!==row.request_hash||anchor.channel!==LOGICAL_DELETION_CHANNEL||anchor.target_fingerprint!==job.request.targetFingerprint
      ||anchor.publication_hash!==proof.tombstoneHash||anchor.state!=='possible'||anchor.created_at!==proof.application.acceptedAt||anchor.confirmed_at!==null
      ||db.prepare('SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=? LIMIT 1').get(ref.anchorId))return publicationInvalid('删除选择历史首证的独立不可删锚损坏。')
  }
}
