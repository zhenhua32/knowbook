import { decodeMainHostOperationAck, decodeSyncedOperationAck } from './synced-host-operation-receipt'
import type Database from 'better-sqlite3'
import { isSyncedUuid, assertSyncedShape } from '../../shared/syncedBlockValidation'
import { hostJson } from './synced-host-document-read'
import { hostEncode } from './synced-host-journal'
import { decodeHostCreateJournal } from './synced-host-create-codec'
import {
  HEADING_CREATE_BIRTH2_PREFIX,
  decodeSyncedHeadingCreateBirthOperation2
} from './synced-heading-create-birth-codec2'
import {
  reopenSyncedMetadataCaptureRecordOwned2,
  readSyncedMetadataCaptureRecordOwned2
} from './synced-metadata-capture-record2'
import {
  readHistoricalExactRows, readHistoricalMetadata, historicalMetadataLocator, historicalOperationLocator, historicalRowLocator,
  type HistoricalMetadataRow
} from './synced-history-evidence-support'

const operationKind = 'synced-host-create-heading-birth-operation'
type OperationRow = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
type JournalRow = { id: string; action_json: string; before_json: string; after_json: string; before_hash: string; after_hash: string; created_at: string }
type PinRow = { group_id: string; kind: string; pin_id: string; created_at: string }
const fail = (message: string): never => { throw new Error('Heading create birth original invalid: ' + message) }
function owned(db: Database.Database): void {
  if (!db.open || !db.inTransaction || db.pragma('main.user_version', { simple: true }) !== 27)
    fail('actual owned schema27 SQL snapshot required')
}
const operation = (db: Database.Database, id: string) =>
  readHistoricalExactRows<OperationRow>(db, 'synced_operations', ['client_operation_id', 'request_hash', 'result_json', 'created_at'], 'client_operation_id=?', [id])[0]
const metadata = (db: Database.Database, key: string) =>
  readHistoricalExactRows<HistoricalMetadataRow>(db, 'app_settings', ['key', 'value', 'updated_at'], 'key=?', [key])[0]
const totalChanges = (db: Database.Database) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

/** Original-data admission only. Every call reopens exact SQL TEXT originals.
 * A returned value, source point or same hash never grants execution or a new
 * heading birth to an old bare-create/imported/edit Key. Current live rows are
 * deliberately not used to reinterpret an immutable historical target. */
export function readSyncedHeadingCreateBirthOriginalOwned2(db: Database.Database, id: string) {
  owned(db)
  if (!isSyncedUuid(id)) return fail('operation UUID required')
  const started = totalChanges(db), row = operation(db, id)
  if (!row) return null
  const packet = hostJson(row.result_json)
  if (!packet || typeof packet !== 'object' || !('kind' in packet) || packet.kind !== operationKind) return null
  const companionRow = metadata(db, HEADING_CREATE_BIRTH2_PREFIX + id)
  if (!companionRow) return fail('actual companion missing')
  // hostJson parses actual SQL text into ordinary values. These header fields
  // only select exact originals; the complete codec checks the entire object.
  const raw = hostJson(companionRow.value)
  if (!raw || typeof raw !== 'object' || !('historyToken' in raw) || !isSyncedUuid(raw.historyToken)
      || !('sourcePoint' in raw)) return fail('original companion header invalid')
  assertSyncedShape(raw.sourcePoint, ['key', 'recordHash'])
  if (typeof raw.sourcePoint.key !== 'string' || typeof raw.sourcePoint.recordHash !== 'string')
    return fail('source-point original address invalid')
  const pointOwner = reopenSyncedMetadataCaptureRecordOwned2(db, raw.sourcePoint.key)
  const point = readSyncedMetadataCaptureRecordOwned2(db, pointOwner)
  const pointRow = operation(db, raw.sourcePoint.key)
  if (!pointRow || point.recordHash !== raw.sourcePoint.recordHash) return fail('exact source point disappeared/changed')
  const journalRow = readHistoricalExactRows<JournalRow>(db, 'synced_host_history',
    ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'],
    'id=?', [raw.historyToken])[0]
  if (!journalRow) return fail('actual original create journal missing')
  const journal = decodeHostCreateJournal(journalRow)
  const pins = readHistoricalExactRows<PinRow>(db, 'synced_group_pins',
    ['group_id', 'kind', 'pin_id', 'created_at'], 'kind=? AND pin_id=? ORDER BY group_id', ['host-history', journalRow.id])
  const expected = new Set(journal.groups.map(group => group.groupId)), ownId = journal.create.wire.id
  const retainedPins = pins.filter(pin => pin.group_id !== ownId), byGroup = new Map(pins.map(pin => [pin.group_id, pin]))
  // Own create pin is an execution index: Undo removes it and Redo reissues
  // it at its new time. The immutable initial own-pin fact is BACKBOUND in
  // companion.creationPins, never reconstructed from this mutable index.
  if (byGroup.size !== pins.length || pins.some(pin => !expected.has(pin.group_id) || pin.kind !== 'host-history'
      || pin.pin_id !== journalRow.id || !Number.isFinite(Date.parse(pin.created_at)))
      || [...expected].filter(groupId => groupId !== ownId).some(groupId => {
        const pin = byGroup.get(groupId)
        return !pin || pin.created_at !== journalRow.created_at
      })) return fail('retained create dependencies missing/extra/changed')
  const decoded = decodeSyncedHeadingCreateBirthOperation2(row, companionRow, journalRow, point)
  if (hostEncode(decoded.companion) !== companionRow.value) return fail('companion original bytes differ')
  if (totalChanges(db) !== started) return fail('SQL changed during original-only admission')
  return { row, companionRow, journalRow, pointRow, pins: retainedPins, currentOwnPin: byGroup.get(ownId) ?? null, point, ...decoded,
    writePermit: false as const, currentHeadingMutationAuthorized: false as const }
}

/** Complete reverse metadata family, including unknown version/case/orphans.
 * The ordinary operation loop must also select every new business envelope;
 * this scan never turns an arbitrary old ACK into new lineage. */
export function assertSyncedHeadingCreateBirthFamilyOwned2(db: Database.Database): HistoricalMetadataRow[] {
  owned(db)
  const rows = readHistoricalExactRows<HistoricalMetadataRow>(db, 'app_settings', ['key', 'value', 'updated_at'],
    "lower(key) LIKE 'synced.heading.create-birth%'")
  for (const row of rows) {
    if (!row.key.startsWith(HEADING_CREATE_BIRTH2_PREFIX)) return fail('unknown family/version/case')
    const id = row.key.slice(HEADING_CREATE_BIRTH2_PREFIX.length)
    if (!isSyncedUuid(id)) return fail('companion operation address invalid')
    const original = readSyncedHeadingCreateBirthOriginalOwned2(db, id)
    if (!original || original.companionRow.key !== row.key || original.companionRow.value !== row.value
        || original.companionRow.updated_at !== row.updated_at) return fail('orphan/rebound companion')
  }
  return rows
}

export function syncedHeadingCreateBirthOriginalSupportsOwned2(db: Database.Database, id: string) {
  const original = readSyncedHeadingCreateBirthOriginalOwned2(db, id)
  if (!original) return fail('new original business envelope required')
  return { original, supports: [
    historicalMetadataLocator(original.companionRow),
    historicalOperationLocator(original.pointRow),
    historicalRowLocator('synced_host_history', [original.journalRow.id], original.journalRow),
    ...original.pins.map(pin => historicalRowLocator('synced_group_pins', [pin.group_id, pin.kind, pin.pin_id], pin))
  ] }
}

/** Main consumers call this only from their original owned read. Old row-only
 * parsers keep their former closed domain and reject the new envelope. */
function knownHeadingOriginal(db:Database.Database,row:{client_operation_id:string;request_hash:string;result_json:string}) {
  let packet:unknown
  try{packet=hostJson(row.result_json)}catch{
    // Only kind detection delegates to the original closed decoder below.
    // It rejects the same malformed bytes with its established receipt error;
    // errors reading a recognized new original are never swallowed here.
    return null
  }
  if(!packet||typeof packet!=='object'||!('kind'in packet)||packet.kind!==operationKind)return null
  const original=readSyncedHeadingCreateBirthOriginalOwned2(db,row.client_operation_id)
  if(!original||original.row.request_hash!==row.request_hash||original.row.result_json!==row.result_json)
    return fail('operation input differs from its exact actual original')
  return original.result
}
export function decodeMainHostOperationWithHeadingBirthOwned2(db:Database.Database,row:{client_operation_id:string;request_hash:string;result_json:string}) {
  return knownHeadingOriginal(db,row)??decodeMainHostOperationAck(row)
}
export function decodeSyncedOperationWithHeadingBirthOwned2(db:Database.Database,row:{client_operation_id:string;request_hash:string;result_json:string}) {
  return knownHeadingOriginal(db,row)??decodeSyncedOperationAck(row)
}

/** Fixed Main factory: validate the reserved new family from ITS same actual
 * complete metadata read. No public caller rows and no extra empty-family SQL
 * scan or cross-read cache. Schema26 empty legacy metadata keeps its old read. */
export function readHistoricalMetadataWithHeadingCreateBirthOwned2(db:Database.Database) {
  const metadata=readHistoricalMetadata(db)
  const headingBirthMetadata=metadata.filter(row=>row.key.toLowerCase().startsWith('synced.heading.create-birth'))
  for(const row of headingBirthMetadata){
    if(!row.key.startsWith(HEADING_CREATE_BIRTH2_PREFIX))return fail('unknown heading birth family/version/case')
    const id=row.key.slice(HEADING_CREATE_BIRTH2_PREFIX.length)
    if(!isSyncedUuid(id))return fail('heading birth metadata address invalid')
    const original=readSyncedHeadingCreateBirthOriginalOwned2(db,id)
    if(!original||original.companionRow.value!==row.value||original.companionRow.updated_at!==row.updated_at)
      return fail('orphan/rebound heading birth companion')
  }
  return{metadata,headingBirthMetadata}
}
