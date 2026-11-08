import type Database from 'better-sqlite3'
import { decodeCanonicalRecoveryData, decodeCanonicalRecoveryFollowupData, type AttestedCanonicalRecoveryFloor, type CanonicalRecoveryData } from '../../shared/editor-recovery-canonical'
import { editorRecoveryInvalid, validateEditorRecoveryRecord } from '../../shared/editor-recovery-drafts'
import type { SyncedBindingSource, SyncedGroupSnapshot, SyncedGroupWire } from '../../shared/synced-blocks'
import type { SyncedEditingBaselineResult } from '../../shared/synced-editing-session'
import { canonicalSyncedPortableJson as encode } from '../../shared/syncedBlockPortable'
import { validateSyncedUpdateGroupInput } from '../../shared/syncedBlockInputs'
import { isSyncedUuid, syncedCanonicalEdits, validateSyncedGroupSnapshot, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { readSyncedRecoveryBaselineAliasOwned2, resolveSyncedBindingSource } from '../database/synced-binding-sources'
import { getSyncedGroupSnapshots } from '../database/synced-blocks-read'
import { decodeSyncedGroupOperationAck } from '../database/synced-group-operation-receipt'
import { hostHash } from '../database/synced-host-journal'
import { readHistoricalExactRows, readHistoricalTextRows, type HistoricalOperationRow } from '../database/synced-history-evidence-support'
import { readSyncedMetadataCaptureRecordOwned2, reopenSyncedMetadataCaptureRecordOwned2, SYNCED_METADATA_BASELINE2_PREFIX } from '../database/synced-metadata-capture-record2'
import { readHistoricalCanonicalRecoveryFloorOwned } from './canonical-accepted-floor'
import { verifyCanonicalOriginalAlias } from './canonical-copy-original'

type Ready = Extract<SyncedEditingBaselineResult, { status: 'ready' }>
export interface PreparedCanonicalRecoveryCompletion { readonly kind: 'actual-canonical-recovery-completion' }
type Prepared = { db: Database.Database; recordHash: string; position: number } & (
  { kind: 'baseline'; baselineHash: string; sourceHash: string; readOwnerId: string } | { kind: 'floor'; floorHash: string }
)
type HistoryRow = { id: string; group_id: string; position: number; before_json: string; after_json: string; before_hash: string; after_hash: string; created_at: string }
const prepared = new WeakMap<PreparedCanonicalRecoveryCompletion, Prepared>()
const same = (left: unknown, right: unknown) => encode(left) === encode(right)
const key = ({ blockId, from, to, raw, syntax }: SyncedBindingSource['entries'][number]['key']) => encode([blockId, from, to, raw, syntax])
const operationFields = ['client_operation_id', 'request_hash', 'result_json', 'created_at'] as const
const historyFields = ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'] as const

function wire(snapshot: SyncedGroupSnapshot): SyncedGroupWire {
  return { kind: 'synced-group', id: snapshot.groupId, creationId: snapshot.creationId, createdAt: snapshot.createdAt,
    origin: snapshot.origin, blocks: snapshot.blocks, bindings: snapshot.bindings }
}
function ownsSnapshot(db: Database.Database): void {
  if (!db.open || !db.inTransaction || db.pragma('main.user_version', { simple: true }) !== 27) {
    editorRecoveryInvalid('canonical completion requires its actual owned schema27 snapshot')
  }
}
function getActualGroup(db: Database.Database, groupId: string): SyncedGroupSnapshot | null {
  const result = getSyncedGroupSnapshots(db, { groupIds: [groupId] }).items[0]
  return result?.status === 'ready' ? result.snapshot : null
}
function readOriginal(db: Database.Database, operationId: string): HistoricalOperationRow | undefined {
  return readHistoricalTextRows<HistoricalOperationRow>(db, 'synced_operations', operationFields, 'client_operation_id=?', [operationId])[0]
}
const parse = (json: string): unknown => parseStrictJson(json, { maxBytes: Math.max(1, Buffer.byteLength(json)), maxDepth: 48 })
const empty = (value: unknown): boolean => Array.isArray(value) && value.length === 0
function sourceStillExact(db: Database.Database, baseline: SyncedGroupSnapshot, source: SyncedBindingSource): boolean {
  const expected = new Map(baseline.bindings.map(binding => [key(binding), binding.target]))
  for (const entry of source.entries) {
    const actual = resolveSyncedBindingSource(db, source.ticketId, entry.entryId), id = key(entry.key)
    if (!same(actual.key, entry.key) || !expected.has(id) || !same(actual.target, expected.get(id))) return false
    expected.delete(id)
  }
  return expected.size === 0
}

/** Called while the cold Main adapter's new exact Original owner is live and
 * its original B is still the actual current group. Captures the genuine
 * before-history position before a legitimate Save can prune the old Redo. */
export function prepareCanonicalRecoveryCompletionOwned(db: Database.Database, record: unknown, baseline: Ready): PreparedCanonicalRecoveryCompletion {
  ownsSnapshot(db)
  const actualRecord = validateEditorRecoveryRecord(record)
  const data = decodeCanonicalRecoveryData(actualRecord, baseline, verifyCanonicalOriginalAlias(actualRecord))
  const alias = readSyncedRecoveryBaselineAliasOwned2(db, baseline.readOwnerId), point = alias?.original
  if (!point || point.kind !== 'synced-metadata2-read-baseline-record' || !point.pointHash || !same(alias?.bindingSource, baseline.bindingSource)) {
    return editorRecoveryInvalid('canonical completion has no actual reopened Original')
  }
  const originalKey = SYNCED_METADATA_BASELINE2_PREFIX + point.pointHash
  const original = data.record.base.originals.find(item => item.kind === 'metadata2-baseline' && item.key === originalKey)
  const row = original && readOriginal(db, original.key)
  const actual = getActualGroup(db, data.baseline.groupId)
  const captured = point.sources.find(source => source.wire.id === data.baseline.groupId)
  const history = point.groupHistories.find(source => source.groupId === data.baseline.groupId)
  if (!original || !row || row.request_hash !== original.requestHash || row.result_json !== original.resultJson || row.created_at !== original.createdAt
    || point.recordHash !== original.requestHash || point.workspaceScope !== data.record.base.workspaceScope
    || point.recoveryEpoch !== data.record.base.recoveryEpoch || !captured || !history || !actual || !same(actual, data.baseline)
    || !same(captured.wire, wire(data.baseline)) || captured.revision !== data.baseline.revision || captured.topologyRevision !== data.baseline.topologyRevision
    || !same(history.history, data.baseline.history) || !sourceStillExact(db, data.baseline, baseline.bindingSource)) {
    return editorRecoveryInvalid('canonical completion does not start from its sealed Original and live source keys')
  }
  const owner: PreparedCanonicalRecoveryCompletion = Object.freeze({ kind: 'actual-canonical-recovery-completion' })
  // The cold panel may prepare and cancel repeatedly. Keep only fixed-size
  // commitments and reread its exact actual side head at completion.
  prepared.set(owner, { kind: 'baseline', db, recordHash: hostHash(data.record), baselineHash: hostHash(data.baseline),
    sourceHash: hostHash(baseline.bindingSource), readOwnerId: baseline.readOwnerId, position: history.position })
  return owner
}

export function prepareCanonicalRecoveryFollowupCompletionOwned(db: Database.Database, record: unknown, floor: AttestedCanonicalRecoveryFloor): PreparedCanonicalRecoveryCompletion {
  ownsSnapshot(db)
  const data = decodeCanonicalRecoveryFollowupData(record, floor)
  if (!same(getActualGroup(db, data.baseline.groupId), data.baseline)) return editorRecoveryInvalid('accepted recovery floor is no longer current')
  const owner: PreparedCanonicalRecoveryCompletion = Object.freeze({ kind: 'actual-canonical-recovery-completion' })
  prepared.set(owner, { kind: 'floor', db, recordHash: hostHash(data.record), floorHash: hostHash(floor), position: floor.position })
  return owner
}

function dataFields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return editorRecoveryInvalid('closed canonical receipt object required')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== names.length || names.some(name => !descriptors[name]?.enumerable || !('value' in descriptors[name]))) {
    return editorRecoveryInvalid('canonical receipt fields differ')
  }
  return value as Record<string, unknown>
}
function receiptList(value: unknown, count: number): unknown[] {
  if (!Array.isArray(value) || !count || value.length !== count || Reflect.ownKeys(value).length !== count + 1) {
    return editorRecoveryInvalid('the complete original canonical frame receipt list is required')
  }
  return Array.from({ length: count }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) return editorRecoveryInvalid('sparse/accessor canonical receipt list')
    return descriptor.value
  })
}

/** The only positive result says this original complete authored branch is
 * already in current SQL. It neither retires a side head nor writes business
 * state. The service separately performs the original generation/hash CAS. */
export function attestCanonicalRecoveryCompletionOwned(db: Database.Database, owner: PreparedCanonicalRecoveryCompletion, recordValue: unknown, value: unknown): boolean {
  ownsSnapshot(db)
  const actual = prepared.get(owner)
  if (!actual || actual.db !== db) return false
  try {
    const record = validateEditorRecoveryRecord(recordValue)
    if (hostHash(record) !== actual.recordHash || typeof record.draft.replayJson !== 'string') return false
    let data: CanonicalRecoveryData
    if (actual.kind === 'floor') {
      const floor = readHistoricalCanonicalRecoveryFloorOwned(db, record)
      if (!floor || hostHash(floor) !== actual.floorHash) return false
      data = decodeCanonicalRecoveryFollowupData(record, floor)
    } else {
      const replay = dataFields(parse(record.draft.replayJson), ['kind', 'version', 'snapshot', 'readSource', 'accepted', 'frames', 'redoFrames', 'serverRedo', 'cutServerRedo'])
      const baseline = validateSyncedGroupSnapshot(replay.snapshot)
      const source = readSyncedRecoveryBaselineAliasOwned2(db, actual.readOwnerId)?.bindingSource
      if (!source || hostHash(source) !== actual.sourceHash || hostHash(baseline) !== actual.baselineHash) return false
      data = decodeCanonicalRecoveryData(record, { status: 'ready', workspaceScope: record.base.workspaceScope,
        readOwnerId: actual.readOwnerId, snapshot: baseline, bindingSource: source }, verifyCanonicalOriginalAlias(record))
      const original = data.record.base.originals[0]
      const row = readOriginal(db, original.key)
      const boundary = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
        { workspace_scope: string; recovery_epoch: string } | undefined
      if (!row || row.request_hash !== original.requestHash || row.result_json !== original.resultJson || row.created_at !== original.createdAt
        || boundary?.workspace_scope !== data.record.base.workspaceScope || boundary.recovery_epoch !== data.record.base.recoveryEpoch
        || !sourceStillExact(db, baseline, source)) return false
    }
    const { baseline } = data
    const frames = [...data.frames, ...[...data.redoFrames].reverse()], rows = receiptList(value, frames.length), nonces = new Set<string>()
    let before = baseline, position = actual.position
    for (const [index, frame] of frames.entries()) {
      const evidence = dataFields(rows[index], ['transactionId', 'input', 'ack']), input = validateSyncedUpdateGroupInput(evidence.input)
      const ack = dataFields(evidence.ack, ['status', 'operationId', 'snapshot', 'replayed'])
      const instance = input.expectedInstanceBinding
      if (evidence.transactionId !== frame.transactionId || nonces.has(input.clientOperationId) || input.groupId !== before.groupId
        || input.expectedRevision !== before.revision || input.expectedTopologyRevision !== before.topologyRevision
        || !before.instances.some(item => item.instanceId === instance.instanceId && item.hostDocumentId === instance.hostDocumentId && item.bindingVersion === instance.bindingVersion)
        || !same(syncedCanonicalEdits(before.blocks), frame.before) || !same(input.blocks, frame.after) || !same(input.bindingClaims, frame.bindingClaims)
        || typeof ack.replayed !== 'boolean' || ack.operationId !== input.clientOperationId) return false
      nonces.add(input.clientOperationId)
      const row = readOriginal(db, input.clientOperationId)
      if (!row || row.client_operation_id !== input.clientOperationId || !Number.isFinite(Date.parse(row.created_at))
        || row.request_hash !== hostHash({ method: 'updateSyncedBlockGroup', input })) return false
      const committed = decodeSyncedGroupOperationAck(row), after = committed.snapshot
      if (ack.status !== committed.status || !same(validateSyncedGroupSnapshot(ack.snapshot), after)
        || after.groupId !== before.groupId || after.creationId !== before.creationId || after.createdAt !== before.createdAt
        || !same(after.origin, before.origin) || after.topologyRevision !== before.topologyRevision || !same(after.instances, before.instances)
        || !same(syncedCanonicalEdits(after.blocks), input.blocks)) return false
      if (committed.status === 'noop') {
        if (!same(after, before)) return false
      } else {
        const token = after.history.undoToken
        if (!isSyncedUuid(token) || after.history.redoToken !== null || after.history.cursor === before.history.cursor || after.revision === before.revision) return false
        const rowHistory = readHistoricalExactRows<HistoryRow>(db, 'synced_group_history', historyFields, 'id=? AND group_id=?', [token, after.groupId])[0]
        const beforeWire = wire(before), afterWire = wire(after)
        if (!rowHistory || rowHistory.id !== token || rowHistory.group_id !== after.groupId || rowHistory.position !== position + 1 || rowHistory.created_at !== row.created_at
          || rowHistory.before_json !== encode(beforeWire) || rowHistory.after_json !== encode(afterWire)
          || rowHistory.before_hash !== hostHash(beforeWire) || rowHistory.after_hash !== hostHash(afterWire)) return false
        position++
      }
      before = after
    }
    const actualPosition = db.prepare('SELECT history_position FROM synced_groups WHERE id=?').get(before.groupId) as { history_position: number } | undefined
    return actualPosition?.history_position === position && same(getActualGroup(db, before.groupId), before)
      && !(data.cutServerRedo && baseline.history.redoToken !== null && before.history.redoToken !== null)
  } catch { return false }
}

/** A fresh producer can retain one final clean checkpoint until the window
 * closes. With no Source, pending input, local frames or Redo to preserve, the
 * exact current stored ACK/history can retire that checkpoint on cold list. */
export function alreadySavedCanonicalRecoveryOwned(db: Database.Database, value: unknown): boolean {
  ownsSnapshot(db)
  try {
    const { base, draft } = validateEditorRecoveryRecord(value), owner = base.owner, working = draft.working
    if (owner.kind !== 'group' || base.persistedWorking.kind !== 'group' || working.kind !== 'group' || working.incoming !== null
      || draft.pending.length || draft.sources.length || draft.composing || draft.importing || typeof draft.replayJson !== 'string'
      || base.originals.length !== 1 || base.originals[0].kind !== 'metadata2-baseline') return false
    const replay = dataFields(parse(draft.replayJson), ['kind', 'version', 'snapshot', 'readSource', 'accepted', 'frames', 'redoFrames', 'serverRedo', 'cutServerRedo'])
    if (replay.kind !== 'knowbook-canonical-recovery-data' || replay.version !== 2 || !empty(replay.frames) || !empty(replay.redoFrames)
      || !empty(replay.serverRedo) || typeof replay.cutServerRedo !== 'boolean') return false
    const accepted = dataFields(replay.accepted, ['method', 'input', 'ack'])
    if (accepted.method !== 'updateSyncedBlockGroup') return false
    const input = validateSyncedUpdateGroupInput(accepted.input), ack = dataFields(accepted.ack, ['status', 'operationId', 'snapshot', 'replayed'])
    const current = getActualGroup(db, owner.groupId), boundary = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
      { workspace_scope: string; recovery_epoch: string } | undefined
    if (!current || current.creationId !== owner.creationId || current.createdAt !== owner.createdAt || input.groupId !== owner.groupId
      || input.expectedTopologyRevision !== current.topologyRevision || boundary?.workspace_scope !== base.workspaceScope || boundary.recovery_epoch !== base.recoveryEpoch
      || !same(validateSyncedGroupSnapshot(replay.snapshot), current) || !same(validateSyncedGroupSnapshot(ack.snapshot), current)
      || !same(working.blocks, input.blocks) || !same(syncedCanonicalEdits(current.blocks), working.blocks)
      || typeof ack.replayed !== 'boolean' || ack.operationId !== input.clientOperationId || (replay.cutServerRedo && current.history.redoToken !== null)) return false
    const guard = input.expectedInstanceBinding
    if (!current.instances.some(instance => instance.instanceId === guard.instanceId && instance.hostDocumentId === guard.hostDocumentId
      && instance.bindingVersion === guard.bindingVersion)) return false
    const original = base.originals[0], originalRow = readOriginal(db, original.key)
    if (!originalRow || originalRow.request_hash !== original.requestHash || originalRow.result_json !== original.resultJson || originalRow.created_at !== original.createdAt) return false
    const point = readSyncedMetadataCaptureRecordOwned2(db, reopenSyncedMetadataCaptureRecordOwned2(db, original.key))
    const initial = point.sources.find(source => source.wire.id === owner.groupId), history = point.groupHistories.find(item => item.groupId === owner.groupId)
    if (point.kind !== 'synced-metadata2-read-baseline-record' || point.recordHash !== original.requestHash || point.workspaceScope !== base.workspaceScope
      || point.recoveryEpoch !== base.recoveryEpoch || !initial || !history || initial.wire.creationId !== owner.creationId || initial.wire.createdAt !== owner.createdAt
      || initial.revision !== owner.revision || initial.topologyRevision !== owner.topologyRevision || history.history.cursor !== owner.historyCursor
      || !same(initial.wire.origin, current.origin) || !same(syncedCanonicalEdits(initial.wire.blocks), base.persistedWorking.blocks)) return false
    const operation = readOriginal(db, input.clientOperationId)
    if (!operation || !Number.isFinite(Date.parse(operation.created_at)) || operation.request_hash !== hostHash({ method: 'updateSyncedBlockGroup', input })) return false
    const stored = decodeSyncedGroupOperationAck(operation)
    if (stored.status !== ack.status || !same(stored.snapshot, current)) return false
    if (stored.status === 'noop') return input.expectedRevision === current.revision
    const token = current.history.undoToken
    if (!isSyncedUuid(token) || current.history.redoToken !== null || input.expectedRevision === current.revision) return false
    const row = readHistoricalExactRows<HistoryRow>(db, 'synced_group_history', historyFields, 'id=? AND group_id=?', [token, owner.groupId])[0]
    const position = db.prepare('SELECT history_position FROM synced_groups WHERE id=?').get(owner.groupId) as { history_position: number } | undefined
    if (!row || row.position !== position?.history_position || row.created_at !== operation.created_at) return false
    const before = validateSyncedGroupWire(parse(row.before_json)), after = wire(current)
    return before.id === owner.groupId && before.creationId === owner.creationId && before.createdAt === owner.createdAt && same(before.origin, current.origin)
      && row.before_json === encode(before) && row.before_hash === hostHash(before)
      && row.after_json === encode(after) && row.after_hash === hostHash(after)
  } catch { return false }
}
