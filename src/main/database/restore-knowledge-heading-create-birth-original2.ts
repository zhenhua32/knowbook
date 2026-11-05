// Data-only adapter over the SAME complete original packet. No SQL, live
// workspace lookup, source owner or mutation permission is obtained here.
import { assertSyncedShape, isSyncedUuid, syncedPlainRecord } from '../../shared/syncedBlockValidation'
import type { Capsule2RawContent } from './restore-knowledge-capsule2-raw-model'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { hostJson } from './synced-host-document-read'
import { decodeHostCreateJournal, type CreateJournalRow } from './synced-host-create-codec'
import { decodeSyncedMetadataCaptureRecord2 } from './synced-metadata-capture-record2'
import { HEADING_CREATE_BIRTH2_PREFIX, decodeSyncedHeadingCreateBirthOperation2,
  type HeadingCreateBirthOperationRow2, type HeadingCreateBirthCompanionRow2 } from './synced-heading-create-birth-codec2'
import { historicalMetadataLocator, historicalOperationLocator, historicalRowLocator } from './synced-history-evidence-support'

export interface HeadingCreateBirthOriginalSource2<T> {
  readonly value: Readonly<Record<string, unknown>>
  readonly source: T
}
export interface HeadingCreateBirthOriginalAccess2<T> {
  operation(id: string): HeadingCreateBirthOriginalSource2<T>
  metadata(key: string): HeadingCreateBirthOriginalSource2<T>
  journal(token: string): HeadingCreateBirthOriginalSource2<T>
  /** Complete original host-history rows for this token, never caller claims. */
  pins(token: string): readonly HeadingCreateBirthOriginalSource2<T>[]
}
type Pin = { group_id: string; kind: string; pin_id: string; created_at: string }
const columns = {
  synced_operations: ['client_operation_id', 'request_hash', 'result_json', 'created_at'],
  app_settings: ['key', 'value', 'updated_at'],
  synced_host_history: ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'],
  synced_group_pins: ['group_id', 'kind', 'pin_id', 'created_at']
} as const
type Table = keyof typeof columns
const bad = (message: string): never => { throw Error('Heading create birth packet invalid: ' + message) }
function texts<T>(value: Readonly<Record<string, unknown>>, names: readonly string[]): T {
  assertSyncedShape(value, names)
  if (names.some(name => typeof value[name] !== 'string')) return bad('complete original SQL TEXT required')
  return value as unknown as T
}

/** A strict data decoder, NOT the owned Main reader. Callers below supply only
 * full original rows from their authenticated packet. In particular a new
 * current point or a bare old ACK cannot replace a missing original support. */
export function decodeHeadingCreateBirthOriginalMaterial2<T>(id: string, originals: HeadingCreateBirthOriginalAccess2<T>) {
  if (!isSyncedUuid(id)) return bad('operation UUID required')
  const operationSource = originals.operation(id)
  const row = texts<HeadingCreateBirthOperationRow2>(operationSource.value, columns.synced_operations)
  if (row.client_operation_id !== id) return bad('original operation address differs')
  const companionSource = originals.metadata(HEADING_CREATE_BIRTH2_PREFIX + id)
  const companionRow = texts<HeadingCreateBirthCompanionRow2>(companionSource.value, columns.app_settings)
  if (companionRow.key !== HEADING_CREATE_BIRTH2_PREFIX + id) return bad('original companion address differs')
  const header = hostJson(companionRow.value)
  if (!syncedPlainRecord(header) || !isSyncedUuid(header.historyToken)) return bad('original companion header invalid')
  assertSyncedShape(header.sourcePoint, ['key', 'recordHash'])
  if (typeof header.sourcePoint.key !== 'string' || typeof header.sourcePoint.recordHash !== 'string') return bad('point address invalid')
  const pointSource = originals.operation(header.sourcePoint.key)
  const pointRow = texts<HeadingCreateBirthOperationRow2>(pointSource.value, columns.synced_operations)
  if (pointRow.client_operation_id !== header.sourcePoint.key) return bad('original point address differs')
  const point = decodeSyncedMetadataCaptureRecord2(pointRow)
  const journalSource = originals.journal(header.historyToken)
  const journalRow = texts<CreateJournalRow>(journalSource.value, columns.synced_host_history)
  if (journalRow.id !== header.historyToken) return bad('original journal address differs')
  const journal = decodeHostCreateJournal(journalRow), ownId = journal.create.wire.id
  const expected = new Set(journal.groups.map(group => group.groupId))
  const pins = originals.pins(journalRow.id).map(source => ({ source, value: texts<Pin>(source.value, columns.synced_group_pins) }))
  const byGroup = new Map(pins.map(pin => [pin.value.group_id, pin]))
  if (byGroup.size !== pins.length || pins.some(({ value: pin }) => !expected.has(pin.group_id) || pin.kind !== 'host-history'
    || pin.pin_id !== journalRow.id || !Number.isFinite(Date.parse(pin.created_at)))
    || [...expected].filter(groupId => groupId !== ownId).some(groupId => byGroup.get(groupId)?.value.created_at !== journalRow.created_at))
    return bad('retained original dependency pins missing/extra/changed')
  // Initial own-pin facts are sealed in companion.creationPins. The current
  // own pin is an execution index: Undo may remove it and Redo changes its time.
  // It is never a support for the immutable original birth fact.
  const retained = pins.filter(pin => pin.value.group_id !== ownId).sort((a, b) => a.value.group_id < b.value.group_id ? -1 : a.value.group_id > b.value.group_id ? 1 : 0)
  const decoded = decodeSyncedHeadingCreateBirthOperation2(row, companionRow, journalRow, point)
  return { ...decoded, row, companionRow, pointRow, journalRow, point, pins: retained.map(pin => pin.value),
    currentOwnPin: byGroup.get(ownId)?.value ?? null,
    primarySource: operationSource.source,
    companionSource: companionSource.source, pointSource: pointSource.source, journalSource: journalSource.source,
    supportSources: [companionSource.source, pointSource.source, journalSource.source, ...retained.map(pin => pin.source.source)],
    supports: [historicalMetadataLocator(companionRow), historicalOperationLocator(pointRow),
      historicalRowLocator('synced_host_history', [journalRow.id], journalRow),
      ...retained.map(({ value: pin }) => historicalRowLocator('synced_group_pins', [pin.group_id, pin.kind, pin.pin_id], pin))],
    writePermit: false as const, currentHeadingMutationAuthorized: false as const }
}

/** One synchronous collector call owns this index. It is not cached by packet,
 * shared across invocations, exported as authority, or read from today's DB. */
export function headingCreateBirthOriginalsFromRaw2(raw: Capsule2RawContent) {
  type RawRow = ReturnType<typeof graph3Rows>[number]
  const indexed = new Map<Table, RawRow[]>(), decoded = new Map<string, ReturnType<typeof decodeHeadingCreateBirthOriginalMaterial2<RawRow>>>()
  const rows = (table: Table): RawRow[] => {
    let found = indexed.get(table)
    if (!found) {
      const tables = raw.tables.filter(value => value.name === table)
      if (tables.length !== 1 || tables[0].columns.length !== columns[table].length
        || new Set(tables[0].columns).size !== tables[0].columns.length || columns[table].some(name => !tables[0].columns.includes(name)))
        return bad('complete original table columns required: ' + table)
      found = graph3Rows(raw, table); indexed.set(table, found)
    }
    return found
  }
  const material = (row: RawRow): HeadingCreateBirthOriginalSource2<RawRow> => {
    if (row.original.cells.length !== row.table.columns.length || row.original.cells.some(cell => cell[0] !== 'text'))
      return bad('original support storage class/width differs')
    return { value: row.value, source: row }
  }
  const one = (table: Table, key: string, value: string) => {
    const found = rows(table).filter(row => row.value[key] === value)
    if (found.length !== 1) return bad('original support missing/duplicate: ' + table)
    return material(found[0])
  }
  const access: HeadingCreateBirthOriginalAccess2<RawRow> = {
    operation: id => one('synced_operations', 'client_operation_id', id),
    metadata: key => one('app_settings', 'key', key),
    journal: token => one('synced_host_history', 'id', token),
    pins: token => rows('synced_group_pins').filter(row => row.value.kind === 'host-history' && row.value.pin_id === token).map(material)
  }
  return (id: string) => {
    let value = decoded.get(id)
    if (!value) { value = decodeHeadingCreateBirthOriginalMaterial2(id, access); decoded.set(id, value) }
    return value
  }
}
