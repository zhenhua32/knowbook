import type Database from 'better-sqlite3'
import type { EditorRecoveryOriginal } from '../../shared/editor-recovery-drafts'
import { editorRecoveryInvalid, validateEditorRecoveryRecord } from '../../shared/editor-recovery-drafts'
import type { AttestedCanonicalRecoveryFloor } from '../../shared/editor-recovery-canonical'
import type { SyncedGroupSaved, SyncedGroupSnapshot, SyncedGroupWire, SyncedUpdateGroupInput } from '../../shared/synced-blocks'
import { validateSyncedUpdateGroupInput } from '../../shared/syncedBlockInputs'
import { assertSyncedShape, isSyncedUuid, syncedCanonicalEdits, validateSyncedGroupSnapshot } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { getSyncedGroupSnapshots } from '../database/synced-blocks-read'
import { decodeSyncedGroupOperationAck } from '../database/synced-group-operation-receipt'
import { readHistoricalExactRows, readHistoricalTextRows, type HistoricalOperationRow } from '../database/synced-history-evidence-support'
import { hostEncode, hostEqual, hostHash } from '../database/synced-host-journal'
import { readSyncedMetadataCaptureRecordOwned2, reopenSyncedMetadataCaptureRecordOwned2 } from '../database/synced-metadata-capture-record2'
import { attestEditorRecoveryPendingOwned } from './pending-original'

type HistoryRow = { id: string; group_id: string; position: number; before_json: string; after_json: string; before_hash: string; after_hash: string; created_at: string }
type Saved = { from: 'pending' | 'accepted'; input: SyncedUpdateGroupInput; original: EditorRecoveryOriginal; ack: SyncedGroupSaved }
const columns = ['client_operation_id', 'request_hash', 'result_json', 'created_at'] as const
const parse = (json: string) => parseStrictJson(json, { maxBytes: Math.max(1, Buffer.byteLength(json)), maxDepth: 48 })
const row = (db: Database.Database, id: string) => readHistoricalTextRows<HistoricalOperationRow>(db, 'synced_operations', columns, 'client_operation_id=?', [id])[0]

function wire(snapshot: SyncedGroupSnapshot): SyncedGroupWire {
  return { kind: 'synced-group', id: snapshot.groupId, creationId: snapshot.creationId, createdAt: snapshot.createdAt,
    origin: snapshot.origin, blocks: snapshot.blocks, bindings: snapshot.bindings }
}
function readAccepted(db: Database.Database, replayJson: string): Saved | null {
  const replay = parse(replayJson)
  const v2 = !!replay && typeof replay === 'object' && 'version' in replay && replay.version === 2
  const common = ['kind', 'version', 'snapshot', 'readSource', 'accepted', 'frames']
  assertSyncedShape(replay, v2 ? [...common, 'redoFrames', 'serverRedo', 'cutServerRedo'] : common)
  if (replay.kind !== 'knowbook-canonical-recovery-data' || replay.version !== (v2 ? 2 : 1)) return null
  const accepted = replay.accepted
  assertSyncedShape(accepted, ['method', 'input', 'ack'])
  if (accepted.method !== 'updateSyncedBlockGroup') return null
  const input = validateSyncedUpdateGroupInput(accepted.input), claimed = accepted.ack
  assertSyncedShape(claimed, ['status', 'operationId', 'snapshot', 'replayed'])
  const original = row(db, input.clientOperationId)
  if (!original || !Number.isFinite(Date.parse(original.created_at)) || original.request_hash !== hostHash({ method: 'updateSyncedBlockGroup', input })) return null
  const ack = decodeSyncedGroupOperationAck(original)
  if (claimed.operationId !== ack.operationId || claimed.status !== ack.status || typeof claimed.replayed !== 'boolean'
    || !hostEqual(validateSyncedGroupSnapshot(claimed.snapshot), ack.snapshot) || !hostEqual(validateSyncedGroupSnapshot(replay.snapshot), ack.snapshot)) return null
  return { from: 'accepted', input, ack, original: { kind: 'synced-operation', key: original.client_operation_id,
    requestHash: original.request_hash, resultJson: original.result_json, createdAt: original.created_at } }
}

/** Proves one original B→A content transition and the actual current A. Later
 * W is returned as retained data. The former renderer's frames, Source and
 * expired copy authority have separate replay proofs. */
export function attestCanonicalRecoveryAcceptedFloorOwned(db: Database.Database, value: unknown): AttestedCanonicalRecoveryFloor | null {
  return readFloorOwned(db, value, true)
}

/** Used after a prepared local continuation has saved. Rechecks the original
 * B→A edge while the current SQL can already be C. Its caller independently
 * binds the previously current A and the exact terminal C. */
export function readHistoricalCanonicalRecoveryFloorOwned(db: Database.Database, value: unknown): AttestedCanonicalRecoveryFloor | null {
  return readFloorOwned(db, value, false)
}

function readFloorOwned(db: Database.Database, value: unknown, current: boolean): AttestedCanonicalRecoveryFloor | null {
  if (!db.open || !db.inTransaction || db.pragma('main.user_version', { simple: true }) !== 27) {
    return editorRecoveryInvalid('canonical floor requires its actual owned schema27 snapshot')
  }
  try {
    const record = validateEditorRecoveryRecord(value), { base, draft } = record, owner = base.owner
    if (owner.kind !== 'group' || base.persistedWorking.kind !== 'group' || base.persistedWorking.incoming !== null
      || draft.working.kind !== 'group' || draft.working.incoming !== null || draft.composing || draft.importing
      || base.originals.length !== 1 || base.originals[0].kind !== 'metadata2-baseline') return null
    const boundary = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
      { workspace_scope: string; recovery_epoch: string } | undefined
    if (boundary?.workspace_scope !== base.workspaceScope || boundary.recovery_epoch !== base.recoveryEpoch) return null
    const original = base.originals[0], old = row(db, original.key)
    if (!old || old.request_hash !== original.requestHash || old.result_json !== original.resultJson || old.created_at !== original.createdAt) return null
    const point = readSyncedMetadataCaptureRecordOwned2(db, reopenSyncedMetadataCaptureRecordOwned2(db, original.key))
    const source = point.sources.find(item => item.wire.id === owner.groupId), history = point.groupHistories.find(item => item.groupId === owner.groupId)
    if (point.kind !== 'synced-metadata2-read-baseline-record' || point.recordHash !== original.requestHash || point.workspaceScope !== base.workspaceScope
      || point.recoveryEpoch !== base.recoveryEpoch || !source || !history || source.wire.creationId !== owner.creationId || source.wire.createdAt !== owner.createdAt
      || source.revision !== owner.revision || source.topologyRevision !== owner.topologyRevision || history.history.cursor !== owner.historyCursor
      || !hostEqual(syncedCanonicalEdits(source.wire.blocks), base.persistedWorking.blocks)) return null
    let saved: Saved | null = null
    if (draft.pending.length === 1 && draft.pending[0].method === 'updateSyncedBlockGroup') {
      const attested = attestEditorRecoveryPendingOwned(db, record)[0]
      if (attested?.status !== 'committed-attested' || !('snapshot' in attested.result) || attested.submittedBinding !== 'request-final') return null
      saved = { from: 'pending', input: validateSyncedUpdateGroupInput(parse(draft.pending[0].inputJson)), original: attested.original, ack: attested.result }
    } else if (!draft.pending.length && draft.replayJson !== undefined) saved = readAccepted(db, draft.replayJson)
    if (!saved) return null
    const { input, ack } = saved, after = ack.snapshot, guard = input.expectedInstanceBinding
    const actual = getSyncedGroupSnapshots(db, { groupIds: [owner.groupId] }).items[0]
    if (input.groupId !== owner.groupId || input.expectedRevision !== owner.revision || input.expectedTopologyRevision !== owner.topologyRevision
      || after.groupId !== owner.groupId || after.creationId !== owner.creationId || after.createdAt !== owner.createdAt
      || after.topologyRevision !== owner.topologyRevision || !hostEqual(after.origin, source.wire.origin)
      || actual?.status !== 'ready' || actual.snapshot.creationId !== owner.creationId || actual.snapshot.createdAt !== owner.createdAt
      || (current && !hostEqual(actual.snapshot, after)) || !hostEqual(syncedCanonicalEdits(after.blocks), input.blocks)
      || !after.instances.some(item => item.instanceId === guard.instanceId && item.hostDocumentId === guard.hostDocumentId && item.bindingVersion === guard.bindingVersion)) return null
    const position = db.prepare('SELECT history_position FROM synced_groups WHERE id=?').get(owner.groupId) as { history_position: number } | undefined
    const acceptedPosition = history.position + (ack.status === 'saved' ? 1 : 0)
    if (current && position?.history_position !== acceptedPosition) return null
    if (ack.status === 'noop') {
      if (after.revision !== owner.revision || !hostEqual(after.history, history.history)
        || !hostEqual(wire(after), source.wire)) return null
    } else {
      const token = after.history.undoToken
      if (!isSyncedUuid(token) || after.history.redoToken !== null || after.revision === owner.revision || after.history.cursor === owner.historyCursor) return null
      const edge = readHistoricalExactRows<HistoryRow>(db, 'synced_group_history',
        ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'], 'id=? AND group_id=?', [token, owner.groupId])[0]
      const afterWire = wire(after)
      if (!edge || edge.id !== token || edge.group_id !== owner.groupId || edge.position !== acceptedPosition || edge.created_at !== saved.original.createdAt
        || edge.before_json !== hostEncode(source.wire) || edge.after_json !== hostEncode(afterWire)
        || edge.before_hash !== hostHash(source.wire) || edge.after_hash !== hostHash(afterWire)) return null
    }
    return { status: 'attested-original-floor', from: saved.from, original: saved.original, input, acceptedStatus: ack.status, position: acceptedPosition,
      submitted: { kind: 'group', blocks: input.blocks, incoming: null }, retainedWorking: draft.working, floor: after,
      writePermit: false, sourceReplayComplete: false, historicalKeyLineageComplete: false }
  } catch { return null }
}
