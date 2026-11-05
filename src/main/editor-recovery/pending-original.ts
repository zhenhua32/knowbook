import type Database from 'better-sqlite3'
import type { EditorRecoveryOriginal, EditorRecoveryPending, EditorRecoveryWorking } from '../../shared/editor-recovery-drafts'
import { editorRecoveryInvalid, validateEditorRecoveryRecord } from '../../shared/editor-recovery-drafts'
import { parseStrictJson } from '../../shared/strictJson'
import { validateSyncedStructureInput, validateSyncedRestoreHostInput, validateSyncedUpdateGroupInput, validateSyncedRestoreGroupInput } from '../../shared/syncedBlockInputs'
import { syncedCanonicalEdits } from '../../shared/syncedBlockValidation'
import { hostHash, hostEqual } from '../database/synced-host-journal'
import { hostJson } from '../database/synced-host-document-read'
import { readHistoricalExactRows } from '../database/synced-history-evidence-support'
import { decodeSyncedOperationWithHeadingTitle3Owned } from '../database/synced-heading-title3-read'
import { HEADING_TITLE3_OPERATION_KIND, headingTitle3RequestHash } from '../database/synced-heading-title3-codec'
import { readTitle2OriginalOperationOwned } from '../database/synced-host-title2-read'
import { TITLE2_OPERATION_KIND, title2RequestHash } from '../database/synced-host-title2-codec'
import type { SyncedMainOperationResult } from '../database/synced-host-operation-receipt'

type Operation = Extract<SyncedMainOperationResult, { status: 'committed' }>['result']
type Row = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
type Attestation = { clientOperationId: string; captureRequestHash: string; writePermit: false; sourceReplayComplete: false } & (
  | { status: 'unknown' }
  | { status: 'idempotency-mismatch'; expectedBusinessRequestHash: string; actualBusinessRequestHash: string }
  | { status: 'committed-attested'; businessRequestHash: string; original: EditorRecoveryOriginal; result: Operation;
      submittedWorking: EditorRecoveryWorking; submittedBinding: 'request-final' | 'source-replay-required' }
)

function request(pending: EditorRecoveryPending) {
  const raw = parseStrictJson(pending.inputJson, { maxBytes: Math.max(1, Buffer.byteLength(pending.inputJson)), maxDepth: 32 })
  // This is the exact PUBLIC invocation capture hash. It is deliberately not
  // compared to an internal writer's differently domain-separated SQL hash.
  if (hostHash({ method: pending.method, input: raw }) !== pending.requestHash) return editorRecoveryInvalid('pending public invocation capture hash differs')
  const input = pending.method === 'updateSyncedBlockGroup' ? validateSyncedUpdateGroupInput(raw)
    : pending.method === 'restoreSyncedGroupOperation' ? validateSyncedRestoreGroupInput(raw)
      : pending.method === 'applySyncedHostStructure' ? validateSyncedStructureInput(raw) : validateSyncedRestoreHostInput(raw)
  if (input.clientOperationId !== pending.clientOperationId) return editorRecoveryInvalid('pending original nonce differs from its complete input')
  return input
}
function kind(row: Row): string | null {
  const packet = hostJson(row.result_json)
  return packet && typeof packet === 'object' && !Array.isArray(packet) && 'kind' in packet && typeof packet.kind === 'string' ? packet.kind : null
}
function businessHash(pending: EditorRecoveryPending, input: ReturnType<typeof request>, envelopeKind: string | null): string {
  if (envelopeKind === HEADING_TITLE3_OPERATION_KIND || envelopeKind === TITLE2_OPERATION_KIND) {
    if (pending.method !== 'applySyncedHostStructure' && pending.method !== 'restoreSyncedHostOperation'
      || pending.method === 'applySyncedHostStructure' && (!('mode' in input) || input.mode !== 'host-final')) return editorRecoveryInvalid('pending method does not belong to the stored title namespace')
    const mode = pending.method === 'applySyncedHostStructure' ? 'apply' : 'restore'
    return envelopeKind === HEADING_TITLE3_OPERATION_KIND ? headingTitle3RequestHash(mode, input) : title2RequestHash(mode, input)
  }
  const method = pending.method === 'applySyncedHostStructure'
    ? 'mode' in input && input.mode === 'command' ? 'applySyncedHostCommand' : 'applySyncedHostFinal' : pending.method
  return hostHash({ method, input })
}

/** Reads actual SQL in the caller's Main-owned snapshot. A matching capture,
 * exact business hash and complete original ACK establish what that nonce did;
 * they do not reconcile later controller/Source input, mint a new baseline, or
 * authorize a retry. The service supplies the actual side-store record. */
export function attestEditorRecoveryPendingOwned(db: Database.Database, value: unknown): Attestation[] {
  if (!db.open || !db.inTransaction || db.pragma('main.user_version', { simple: true }) !== 27) return editorRecoveryInvalid('pending attestation requires actual owned schema27 SQL')
  const record = validateEditorRecoveryRecord(value), owner = record.base.owner
  return record.draft.pending.map(pending => {
    const input = request(pending), base = { clientOperationId: pending.clientOperationId, captureRequestHash: pending.requestHash, writePermit: false as const, sourceReplayComplete: false as const }
    const groupMethod = pending.method === 'updateSyncedBlockGroup' || pending.method === 'restoreSyncedGroupOperation'
    if (groupMethod) {
      if (owner.kind !== 'group' || !('groupId' in input) || input.groupId !== owner.groupId || pending.submittedWorking.kind !== 'group') return editorRecoveryInvalid('pending group does not belong to the sealed owner')
      if (pending.method === 'updateSyncedBlockGroup' && (!('blocks' in input)
        || pending.submittedWorking.incoming !== null || !hostEqual(pending.submittedWorking.blocks, input.blocks))) return editorRecoveryInvalid('pending submitted group differs from the complete request final')
    } else {
      if (owner.kind !== 'host' || pending.submittedWorking.kind !== 'host') return editorRecoveryInvalid('pending host does not belong to the sealed owner')
      if ('hostsWorkingBefore' in input) {
        const before = input.hostsWorkingBefore.find(host => host.documentId === owner.documentId)
        if (!before) return editorRecoveryInvalid('pending complete host closure omits its sealed owner')
        if (input.mode === 'host-final') {
          const final = input.finalAfter.find(host => host.documentId === owner.documentId)
          if (!final || !hostEqual(pending.submittedWorking, { kind: 'host', title: final.title, summary: final.summary, blocks: final.blocks })) return editorRecoveryInvalid('pending submitted host differs from the complete request final')
        }
      } else if (!('expectedHosts' in input) || !input.expectedHosts.some(host => host.documentId === owner.documentId)) return editorRecoveryInvalid('pending restore closure omits its sealed owner')
    }
    const row = readHistoricalExactRows<Row>(db, 'synced_operations', ['client_operation_id', 'request_hash', 'result_json', 'created_at'], 'client_operation_id=?', [pending.clientOperationId])[0]
    if (!row) return { ...base, status: 'unknown' as const }
    if (row.client_operation_id !== pending.clientOperationId || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
      || typeof row.request_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.request_hash) || typeof row.result_json !== 'string') return editorRecoveryInvalid('pending original four-column row is corrupt')
    const envelopeKind = kind(row), expected = businessHash(pending, input, envelopeKind)
    if (expected !== row.request_hash) return { ...base, status: 'idempotency-mismatch' as const, expectedBusinessRequestHash: expected, actualBusinessRequestHash: row.request_hash }
    const title2 = envelopeKind === TITLE2_OPERATION_KIND ? readTitle2OriginalOperationOwned(db, pending.clientOperationId) : null
    if (envelopeKind === TITLE2_OPERATION_KIND && (!title2 || !hostEqual(title2.row, row))) return editorRecoveryInvalid('pending title original differs from its exact SQL row')
    const result = title2 ? title2.envelope.result : decodeSyncedOperationWithHeadingTitle3Owned(db, row)
    if (result.operationId !== pending.clientOperationId) return editorRecoveryInvalid('pending original ACK nonce differs')
    if (groupMethod) {
      if (owner.kind !== 'group' || !('snapshot' in result) || result.snapshot.groupId !== owner.groupId || result.snapshot.creationId !== owner.creationId
        || result.snapshot.createdAt !== owner.createdAt) return editorRecoveryInvalid('pending ACK group birth differs from the sealed owner')
      if (pending.method === 'updateSyncedBlockGroup' && (!('blocks' in input) || !hostEqual(syncedCanonicalEdits(result.snapshot.blocks), input.blocks))) return editorRecoveryInvalid('pending ACK does not contain the exact submitted group final')
    } else {
      // The old public DocumentDetail ACK has no document birth column. This
      // check binds the exact request/ACK host ID only. The cold source adapter
      // must separately reopen the sealed native birth and complete sources;
      // sourceReplayComplete remains false even for an attested nonce.
      if (owner.kind !== 'host' || !('hosts' in result) || !result.hosts.some(host => host.documentId === owner.documentId)) return editorRecoveryInvalid('pending ACK host differs from the sealed owner')
      if ('hostsWorkingBefore' in input && (result.hosts.length !== input.hostsWorkingBefore.length || input.hostsWorkingBefore.some(before => {
        const after = result.hosts.find(host => host.documentId === before.documentId)
        return !after || !hostEqual(after.logicalBefore, before.workingBefore)
      }))) return editorRecoveryInvalid('pending ACK logical W differs from the complete original request')
    }
    const submittedBinding = pending.method === 'updateSyncedBlockGroup' || 'mode' in input && input.mode === 'host-final' ? 'request-final' as const : 'source-replay-required' as const
    return { ...base, status: 'committed-attested' as const, businessRequestHash: expected,
      original: { kind: 'synced-operation' as const, key: row.client_operation_id, requestHash: row.request_hash, resultJson: row.result_json, createdAt: row.created_at },
      result, submittedWorking: pending.submittedWorking, submittedBinding }
  })
}
