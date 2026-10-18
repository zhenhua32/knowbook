import { assertHistoricalDeletionChoiceProofs } from './synced-exchange-deletion-choice-proof-read'
import { knowledgeSourceHash } from '../sync/synced-exchange-knowledge-model'
import { planSyncedDeletionChoicesFromSource } from '../sync/synced-exchange-deletion-choice-plan'
import { deletionDecisionSourceHash } from '../sync/synced-exchange-deletion-choice-model'
import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { exchangeJobKey, exchangeJobHash, exchangeJobPhaseKey, exchangeRequestHash, parseExchangeStored, validateExchangeJob, validateExchangeJobPhase, validateExchangeReceipt,
  type ExchangeReceipt, type ExchangeRequest } from '../sync/synced-exchange-model'
import { publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'

/** Exact stored request is authoritative for historical references; never synthesize it from today's method/options. */
export function readSyncedExchangeReceiptById(db: Database.Database, operationId: string): ExchangeReceipt | null {
  if (!db.open || !db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1 || !isSyncedUuid(operationId))
    return publicationInvalid('exchange历史receipt只允许owned/FK准确ID读取。')
  return readStoredReceipt(db,operationId)
}
/** Strict denial facts are read before startup enables connection FK enforcement.
 * This separate read-only snapshot entry grants no mutation authority, while the
 * ordinary historical entry above retains its original owned/FK requirement. */
export function readSyncedExchangeDenialReceiptById(db: Database.Database, operationId: string): ExchangeReceipt | null {
  if (!db.open || !db.inTransaction || !isSyncedUuid(operationId)) return publicationInvalid('删除否权历史认证只允许真实owned只读快照/准确ID。')
  return readStoredReceipt(db,operationId)
}
function readStoredReceipt(db: Database.Database, operationId: string): ExchangeReceipt | null {
  const row = db.prepare('SELECT request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(operationId) as { request_hash: string; result_json: string; created_at: string } | undefined
  if (!row) return null
  const receipt = validateExchangeReceipt(parseExchangeStored(row.result_json))
  if (receipt.request.operationId !== operationId || receipt.result.operationId !== operationId || receipt.result.replayed
    || row.request_hash !== exchangeRequestHash(receipt.request) || row.created_at !== receipt.result.acceptedAt)
    return publicationInvalid('exchange原request/method/hash/createdAt/replay损坏。')
  if (receipt.version === 2 || receipt.version === 3 || receipt.version === 4 || receipt.version === 5 || receipt.version === 6 || receipt.version === 7) {
    const proof = receipt.provenance
    if(!proof.attemptId)return publicationInvalid('v2 receipt缺准确attemptId。')
    const source = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?')
      .get(exchangeJobKey(operationId, proof.attemptId)) as { value: string; updated_at: string } | undefined
    if (!source) return publicationInvalid('v2 receipt缺准确immutable attempt。')
    const job = validateExchangeJob(parseExchangeStored(source.value))
    if (job.version !== receipt.version || source.updated_at !== job.preparedAt || publicationJson(job.request) !== publicationJson(receipt.request)
      || job.attemptId !== proof.attemptId || job.descriptor.planHash !== proof.planHash || job.descriptor.next.manifestHash !== proof.afterManifestHash
      || job.descriptor.expectedRemote.manifestHash !== proof.beforeManifestHash || job.descriptor.expectedRemote.etag !== proof.beforeManifestEtag
      || (job.version !== 4 && receipt.version !== 4 && publicationJson(job.resolution) !== publicationJson(proof.resolution)) || publicationJson(job.merges) !== publicationJson(proof.merges)
      || (receipt.version === 3 || receipt.version === 6) && publicationJson(job.forks) !== publicationJson(proof.forks)
      || job.workspaceScope !== receipt.result.workspaceScope || job.recoveryEpoch !== receipt.result.recoveryEpoch || job.remoteWorkspaceId !== receipt.result.remoteWorkspaceId)
      return publicationInvalid('v2 receipt的merge/决定来源不属于准确原job/plan。')
    if (receipt.version === 4 || receipt.version === 7) {
      if (job.version !== receipt.version) return publicationInvalid('删除receipt缺准确原版本job。')
      const refs = new Map(receipt.provenance.deletions.map(ref => [ref.key, ref]))
      if (refs.size !== job.deletions.length || job.deletions.some(intent => refs.get(intent.key)?.intentHash !== intent.intentHash))
        return publicationInvalid('删除receipt没有准确认证原job4完整intent集合。')
    }
    if (receipt.version === 5 || receipt.version === 6) {
      if (job.version !== receipt.version || !('knowledgeSource' in job) || !('knowledgeHash' in proof)
        || knowledgeSourceHash(job.knowledgeSource) !== job.knowledgeHash || job.knowledgeHash !== proof.knowledgeHash)
        return publicationInvalid('knowledge receipt缺历史原preimage/准确jobHash认证；不借今日state或spool。')
    }
    if (receipt.version === 7) {
      if(job.version!==7||deletionDecisionSourceHash(job.decisionSource)!==job.decisionSourceHash||job.decisionSourceHash!==receipt.provenance.decisionSourceHash)
        return publicationInvalid('删除选择receipt缺准确历史原像。')
      const plan=planSyncedDeletionChoicesFromSource(job.decisionSource,operationId)
      for(const [actual,expected]of [[proof.accepted,plan.acceptedSides],[proof.transfers,plan.transfers],[receipt.result.publishedKeys,plan.writes],[receipt.result.appliedKeys,plan.incoming],[receipt.result.deferred,plan.deferred]])
        if(publicationJson(actual)!==publicationJson(expected))return publicationInvalid('删除选择历史receipt不是原完整planner结果。')
      assertHistoricalDeletionChoiceProofs(db,job,receipt)
    }
    const jobHash = exchangeJobHash(job)
    if(source.value !== publicationJson(job) || publicationHash(source.value) !== jobHash)
      return publicationInvalid('v2 receipt的job不是准确原规范bytes。')
    // This is the receipt's historical attempt, not today's head. Materialize before nested
    // strict reads and bind the original phase chain's jobHash, including its settled fact.
    const prefix = exchangeJobPhaseKey(operationId, job.attemptId, 0).slice(0, -1)
    const rows = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?')
      .all(prefix.length, prefix) as Array<{key:string;value:string;updated_at:string}>
    const phases = rows.map(row=>{
      const fact = validateExchangeJobPhase(parseExchangeStored(row.value))
      if(fact.version !== (job.version === 3 || job.version === 6 ? 2 : 1) || row.key !== exchangeJobPhaseKey(operationId, job.attemptId, fact.sequence) || row.updated_at !== fact.recordedAt
        || row.value !== publicationJson(fact) || fact.operationId !== operationId || fact.attemptId !== job.attemptId
        || fact.requestHash !== job.requestHash || fact.jobHash !== jobHash)
        return publicationInvalid('v2 receipt原attempt phase/key/hash损坏。')
      return fact
    }).sort((left,right)=>left.sequence-right.sequence)
    let previous:string|null=null
    for(const [index,fact] of phases.entries()) {
      if(fact.sequence !== index || fact.previousFactHash !== previous)
        return publicationInvalid('v2 receipt原attempt phase追加链不连续。')
      previous = publicationHash(publicationJson(fact))
    }
    const first=phases[0],last=phases.at(-1)
    if(!first || first.phase !== 'prepared' || first.recordedAt !== job.preparedAt || !last
      || last.phase !== 'settled' || last.remoteEtag !== proof.afterManifestEtag)
      return publicationInvalid('v2 receipt缺准确原prepared/settled事实。')
  }
  return receipt
}
export function readExactSyncedExchangeReceipt(db: Database.Database, request: ExchangeRequest): ExchangeReceipt | null {
  const receipt = readSyncedExchangeReceiptById(db, request.operationId)
  if (receipt && publicationJson(receipt.request) !== publicationJson(request)) return publicationInvalid('exchange原operation复用为不同method/selectors。')
  return receipt
}
