import type Database from 'better-sqlite3'
import { parseStrictJson } from '../../shared/strictJson'
import { parseSyncedBlockPayload, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'
import { exchangeJobKey, parseExchangeStored, validateExchangeJob, type TombstoneExchangeReceipt, type DeletionChoiceReceipt, type ExchangeTransfer } from '../sync/synced-exchange-model'
import type { TombstoneDeletionIntent, TombstoneProofReference } from '../sync/synced-exchange-tombstone-types'
import { readSyncedExchangeDenialReceiptById } from './synced-exchange-receipt'
import { LOGICAL_DELETION_CHANNEL, LOGICAL_DELETION_PREFIX, logicalDeletionAnchorId, logicalDeletionRequestHash,
  validateSyncedLogicalDeletionProof, type SyncedLogicalDeletionProof as OriginalDeletionProof, type SyncedLogicalDeletionOperationRow } from '../sync/synced-logical-deletion-model'
import { validateSyncedLogicalDeletionChoiceProof, logicalDeletionChoiceRequestHash, type SyncedLogicalDeletionChoiceProof, type DeletionChoiceIntent } from '../sync/synced-logical-deletion-choice-model'

type SyncedLogicalDeletionProof = OriginalDeletionProof | SyncedLogicalDeletionChoiceProof

type Attempt = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string; state: string; created_at: string; confirmed_at: string | null }
type ReceiptEvidence = { receipt: TombstoneExchangeReceipt | DeletionChoiceReceipt; refs: Map<string,TombstoneProofReference>; intents: Map<string,TombstoneDeletionIntent | DeletionChoiceIntent>; transfers: Map<string,ExchangeTransfer>; closureHash?: string }
const same = (left: unknown, right: unknown): boolean => publicationJson(left) === publicationJson(right)
const parse = (text: string): unknown => parseStrictJson(text, { maxBytes: Math.max(1, Buffer.byteLength(text, 'utf8')), maxDepth: 32 })
function corrupt(message: string): never { return publicationInvalid('永久删除证明损坏：' + message + '；不会修复或重新授予写权。') }
function marker(db: Database.Database, id: string): SyncedLogicalDeletionOperationRow | undefined {
  return db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(id) as SyncedLogicalDeletionOperationRow | undefined
}
function anchor(db: Database.Database, id: string): Attempt | undefined {
  return db.prepare('SELECT id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at FROM synced_exposure_attempts WHERE id=?').get(id) as Attempt | undefined
}
function storedProof(row: SyncedLogicalDeletionOperationRow): SyncedLogicalDeletionProof {
  const raw=parse(row.result_json)
  const proof=raw!==null&&typeof raw==='object'&&Object.getOwnPropertyDescriptor(raw,'version')?.value===2?validateSyncedLogicalDeletionChoiceProof(raw):validateSyncedLogicalDeletionProof(raw)
  if (row.client_operation_id !== proof.persistence.anchorId || row.result_json !== publicationJson(proof)
    || row.request_hash !== (proof.version===2?logicalDeletionChoiceRequestHash(proof):logicalDeletionRequestHash(proof)) || row.created_at !== proof.application.acceptedAt) return corrupt('marker key/原bytes/requestHash/time不闭合')
  return proof
}
function assertPhysical(db: Database.Database, proof: SyncedLogicalDeletionProof): void {
  if (proof.before.kind === 'document') {
    if (db.prepare('SELECT 1 FROM documents WHERE id=?').get(proof.before.id)
      || db.prepare('SELECT 1 FROM blocks WHERE document_id=? LIMIT 1').get(proof.before.id)
      || db.prepare('SELECT 1 FROM synced_instances WHERE host_document_id=? LIMIT 1').get(proof.before.id)) return corrupt('已删文档仍有真实物理体/实例')
    const expected = [...new Set(proof.before.content.blocks.flatMap(block => block.type === 'synced-block' ? [parseSyncedBlockPayload(block.content).groupId] : []))].sort(publicationCompare)
    const pins = db.prepare("SELECT group_id,created_at FROM synced_group_pins WHERE kind='logical-deletion-document-archive' AND pin_id=?").all(proof.persistence.anchorId) as Array<{group_id:string;created_at:string}>
    if (!same(pins.map(row => row.group_id).sort(publicationCompare), expected) || pins.some(row => row.created_at !== proof.application.acceptedAt)) return corrupt('原文档恢复档案失去准确永久group pin')
  } else {
    const group = db.prepare('SELECT id,creation_id,created_at,origin_json,revision,topology_revision,history_cursor,history_position FROM synced_groups WHERE id=?')
      .get(proof.before.id) as { id: string; creation_id: string; created_at: string; origin_json: string; revision: string; topology_revision: string; history_cursor: string; history_position: number } | undefined
    const life = db.prepare('SELECT creation_id,state FROM synced_group_lifecycle WHERE group_id=?').get(proof.before.id) as { creation_id: string; state: string } | undefined
    const after = proof.localAfter
    if (!group || !life || life.state !== 'active' || life.creation_id !== proof.before.creationId || group.creation_id !== proof.before.creationId
      || group.created_at !== proof.before.createdAt || !same(parse(group.origin_json), proof.before.origin) || after.kind !== 'group'
      || group.revision !== after.revision || group.topology_revision !== after.topologyRevision || group.history_cursor !== after.historyCursor || group.history_position !== 0)
      return corrupt('已删组失去原tuple/实际freshCAS屏障')
    if (db.prepare('SELECT 1 FROM synced_group_blocks WHERE group_id=? LIMIT 1').get(group.id)
      || db.prepare('SELECT 1 FROM synced_instances WHERE group_id=? LIMIT 1').get(group.id)
      || db.prepare("SELECT 1 FROM block_identities WHERE last_owner_kind='group' AND last_owner_id=? AND state='live' LIMIT 1").get(group.id)
      || db.prepare(`SELECT 1 FROM blocks WHERE type='synced-block' AND CASE WHEN json_valid(content) THEN json_extract(content,'$.groupId') ELSE NULL END=? LIMIT 1`).get(group.id))
      return corrupt('已删组残留canonical/引用/存活owner')
  }
  // These are historical installation outcomes. A later legitimate owner/birth
  // transition does not revoke the permanent deletion fact of the former owner.
  const ids = publicationJson(proof.identities.map(effect => effect.before.id))
  const rows = db.prepare(`SELECT i.id,i.last_owner_kind,i.last_owner_id,i.state,i.created_at,
      b.id AS ordinary_id,b.document_id,b.created_at AS ordinary_birth,d.id AS host_id,
      c.id AS canonical_id,c.group_id,c.created_at AS canonical_birth,g.id AS group_exists
    FROM block_identities i LEFT JOIN blocks b ON b.id=i.id LEFT JOIN documents d ON d.id=b.document_id
    LEFT JOIN synced_group_blocks c ON c.id=i.id LEFT JOIN synced_groups g ON g.id=i.last_owner_id
    WHERE i.id IN (SELECT value FROM json_each(?))`).all(ids) as Array<{
      id:string;last_owner_kind:string;last_owner_id:string;state:string;created_at:string|null;
      ordinary_id:string|null;document_id:string|null;ordinary_birth:string|null;host_id:string|null;
      canonical_id:string|null;group_id:string|null;canonical_birth:string|null;group_exists:string|null
    }>
  if (rows.length !== proof.identities.length) return corrupt('历史释放的稳定identity被删除')
  for (const row of rows) {
    if (!isSyncedBlockId(row.id) || !isSyncedBlockId(row.last_owner_id) || !['document','group'].includes(row.last_owner_kind)
      || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
      || row.last_owner_kind === 'group' && (!isSyncedUuid(row.last_owner_id) || row.group_exists !== row.last_owner_id)) return corrupt('历史稳定identity的今日known birth/owner无效')
    const count = Number(row.ordinary_id !== null) + Number(row.canonical_id !== null)
    if (row.state === 'retained') { if (count !== 0) return corrupt('retained identity仍有实际物理体'); continue }
    if (row.state !== 'live' || count !== 1 || (row.ordinary_id !== null
      ? row.last_owner_kind !== 'document' || row.document_id !== row.last_owner_id || row.host_id !== row.last_owner_id || row.ordinary_birth !== row.created_at
      : row.last_owner_kind !== 'group' || row.group_id !== row.last_owner_id || row.canonical_birth !== row.created_at)) return corrupt('今日live identity与唯一实际owner/birth不一致')
  }
}
function assertPair(db: Database.Database, row: SyncedLogicalDeletionOperationRow, proof: SyncedLogicalDeletionProof,
  evidence: ReceiptEvidence): void {
  const receipt = evidence.receipt, id = logicalDeletionAnchorId(proof.before), attempt = anchor(db, id), reference = evidence.refs.get(proof.key)
  if (!attempt || id !== row.client_operation_id || attempt.id !== id || attempt.request_hash !== row.request_hash || attempt.channel !== LOGICAL_DELETION_CHANNEL
    || attempt.target_fingerprint !== proof.source.targetFingerprint || attempt.publication_hash !== proof.tombstoneHash || attempt.state !== 'possible'
    || attempt.created_at !== proof.application.acceptedAt || attempt.confirmed_at !== null
    || db.prepare('SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=? LIMIT 1').get(id)) return corrupt('独立不可删锚不是准确possible/null/零成员')
  if (!reference || reference.anchorId !== id || reference.intentHash !== proof.intentHash || reference.proofHash !== publicationHash(row.result_json)
    || receipt.request.operationId !== proof.application.operationId || receipt.result.acceptedAt !== proof.application.acceptedAt
    || receipt.request.targetFingerprint !== proof.source.targetFingerprint || receipt.result.remoteWorkspaceId !== proof.source.workspaceId
    || receipt.result.workspaceScope !== proof.scopeAtApply.workspaceScope || receipt.result.recoveryEpoch !== proof.scopeAtApply.recoveryEpoch
    || receipt.provenance.beforeManifestHash !== proof.source.manifestHash) return corrupt('首证与准确原receipt来源不闭合')
  const operation = db.prepare('SELECT request_hash FROM synced_operations WHERE client_operation_id=?').get(proof.application.operationId) as { request_hash: string } | undefined
  if (operation?.request_hash !== proof.application.requestHash) return corrupt('首证原请求hash不符')
  const intent = evidence.intents.get(proof.key)
  if (!intent || !same(intent, { kind: proof.before.kind === 'document' ? 'document' : 'group', key: proof.key, baseLiveHash: proof.baseLiveHash,
    tombstoneHash: proof.tombstoneHash, before: proof.before, identities: proof.identities, intentHash: proof.intentHash,
    ...(proof.version===2?{base:proof.base,localBeforeHash:proof.localBeforeHash,decision:proof.decision}:{}) })) return corrupt('首证不属于准确原版本job的完整intent')
  if(proof.version===2&&(receipt.version!==7||proof.decision.decisionSourceHash!==receipt.provenance.decisionSourceHash||evidence.closureHash!==proof.source.closureHash)
    ||proof.version===1&&receipt.version!==4)return corrupt('首证版本/历史决定/真实remote closure不闭合')
  for (const effect of proof.identities) if (effect.after.kind === 'transferred') {
    const after = effect.after, transition = evidence.transfers.get(effect.before.id)
    if (!transition || transition.fromKind !== effect.before.last_owner_kind || transition.fromId !== effect.before.last_owner_id || transition.fromCreatedAt !== effect.before.created_at
      || transition.toKind !== after.ownerKind || transition.toId !== after.ownerId || transition.toCreatedAt !== after.createdAt) return corrupt('历史transfer后果未被同一真实receipt认证')
  }
  assertPhysical(db, proof)
}
/** Read-only denial evidence. No source/proof mint, write or cleanup authority is exported. */
export function assertSyncedLogicalDeletionRecords(db: Database.Database): Map<string, SyncedLogicalDeletionProof> {
  if (!db.open) return corrupt('原connection已关闭')
  if (!db.inTransaction) return db.transaction(() => assertSyncedLogicalDeletionRecords(db))()
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='synced_exposure_attempts'").get()) {
    if (db.prepare('SELECT 1 FROM synced_operations WHERE substr(client_operation_id,1,?)=? LIMIT 1').get(LOGICAL_DELETION_PREFIX.length, LOGICAL_DELETION_PREFIX)) return corrupt('删除marker出现在不支持独立锚的旧schema')
    return new Map()
  }
  const end = LOGICAL_DELETION_PREFIX.slice(0, -1) + ';'
  const rows = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id>=? AND client_operation_id<?')
    .all(LOGICAL_DELETION_PREFIX, end) as SyncedLogicalDeletionOperationRow[]
  const proofs = new Map<string, SyncedLogicalDeletionProof>(), references = new Map<string, { operationId: string; proofHash: string }>(), receipts = new Map<string, ReceiptEvidence>()
  // Materialize before nested strict receipt/pragma reads. The global reverse
  // relation also detects deletion of an entire marker, even in a zero-group DB.
  const operations = db.prepare("SELECT client_operation_id FROM synced_operations WHERE json_extract(result_json,'$.kind')='synced-exchange-operation' AND json_extract(result_json,'$.version') IN (4,7)")
    .all() as Array<{ client_operation_id: string }>
  for (const operation of operations) {
    const receipt = readSyncedExchangeDenialReceiptById(db, operation.client_operation_id)
    if (!receipt || receipt.version !== 4 && receipt.version !== 7) return corrupt('删除receipt版本不闭合')
    const source = db.prepare('SELECT value FROM app_settings WHERE key=?').get(exchangeJobKey(receipt.request.operationId,receipt.provenance.attemptId)) as {value:string}|undefined
    const job = source ? validateExchangeJob(parseExchangeStored(source.value)) : null
    if (!job || job.version !== receipt.version || job.version !== 4 && job.version !== 7) return corrupt('首证缺准确历史版本job')
    receipts.set(operation.client_operation_id, {receipt,refs:new Map(receipt.provenance.deletions.map(ref=>[ref.key,ref])),
      intents:new Map<string,TombstoneDeletionIntent|DeletionChoiceIntent>(job.deletions.map(intent=>[intent.key,intent])),transfers:new Map(receipt.provenance.transfers.map(transfer=>[transfer.id,transfer])),
      ...(job.version===7?{closureHash:job.decisionSource.remoteSource.closureHash}:{})})
    for (const ref of receipt.provenance.deletions) {
      if (references.has(ref.anchorId)) return corrupt('多个operation重复认领同稳定删除首证')
      references.set(ref.anchorId, { operationId: operation.client_operation_id, proofHash: ref.proofHash })
    }
  }
  for (const row of rows) {
    const proof = storedProof(row), reference = references.get(row.client_operation_id), receipt = receipts.get(proof.application.operationId)
    if (!reference || !receipt || reference.operationId !== proof.application.operationId || reference.proofHash !== publicationHash(row.result_json) || proofs.has(proof.key)) return corrupt('孤marker/重复key或首证receipt被删除')
    assertPair(db, row, proof, receipt); proofs.set(proof.key, proof)
  }
  const anchors = db.prepare('SELECT id,channel FROM synced_exposure_attempts WHERE channel=? OR substr(id,1,?)=?')
    .all(LOGICAL_DELETION_CHANNEL, LOGICAL_DELETION_PREFIX.length, LOGICAL_DELETION_PREFIX) as Array<{ id: string; channel: string }>
  const markerKeys = new Set(rows.map(row => row.client_operation_id))
  if (anchors.length !== rows.length || anchors.some(row => row.channel !== LOGICAL_DELETION_CHANNEL || !markerKeys.has(row.id))) return corrupt('孤anchor/错误domain或marker整删')
  if (references.size !== markerKeys.size || [...references.keys()].some(id => !markerKeys.has(id))) return corrupt('原receipt所指删除证明缺失')
  return new Map([...proofs].sort(([left], [right]) => publicationCompare(left, right)))
}
export function isSyncedGroupLogicallyDeleted(db: Database.Database, groupId: string): boolean {
  return assertSyncedLogicalDeletionRecords(db).has('group:' + groupId)
}
export function assertSyncedDocumentNotLogicallyDeleted(db: Database.Database, documentId: string): void {
  if (assertSyncedLogicalDeletionRecords(db).has('doc:' + documentId)) return publicationInvalid('已永久逻辑删除的文档不授新写/restore权。')
}
