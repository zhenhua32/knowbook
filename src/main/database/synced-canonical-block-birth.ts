import type Database from 'better-sqlite3'
import type { SyncedCanonicalBlockAddress } from '../../shared/synced-canonical-block-address'
import type { RawHistoricalEvidenceLocator } from './synced-history-evidence-model'
import { assertHistoricalEvidenceOwned, historicalEvidenceInvalid, historicalOperationLocator, historicalRowLocator,
  readHistoricalTextRows, type HistoricalOperationRow } from './synced-history-evidence-support'
import { HEADING_CREATE_BIRTH2_OPERATION_KIND } from './synced-heading-create-birth-codec2'
import { syncedHeadingCreateBirthOriginalSupportsOwned2 } from './synced-heading-create-birth-read2'
import { decodeHostCreateJournal, type CreateJournalRow, type SyncedHostCreateApplied } from './synced-host-create-codec'
import { hostJson } from './synced-host-document-read'
import { hostEncode, hostEqual, hostHash, sameHostContent } from './synced-host-journal'
import { decodeMainHostOperationAck } from './synced-host-operation-receipt'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { assertSyncedShape, isSyncedUuid, syncedPlainRecord } from '../../shared/syncedBlockValidation'

export interface SyncedCanonicalBlockBirthPointer {
  operationId: string
  historyToken: string
}

export type SyncedCanonicalBlockBirthResult =
  | { status: 'proved'; address: SyncedCanonicalBlockAddress; original: SyncedCanonicalBlockBirthPointer; supports: RawHistoricalEvidenceLocator[] }
  | { status: 'unsupported'; reason: 'missing-provenance' | 'target-mismatch' | 'not-initial-child' }

export interface SyncedCanonicalBlockBirthOriginalAccess {
  journal(historyToken: string): CreateJournalRow | undefined
  operation(operationId: string): HistoricalOperationRow | undefined
  headingCreate(operationId: string): { result: SyncedHostCreateApplied; row: HistoricalOperationRow;
    journalRow: CreateJournalRow; supports: readonly RawHistoricalEvidenceLocator[] }
}

const journalColumns = ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'] as const
const operationColumns = ['client_operation_id', 'request_hash', 'result_json', 'created_at'] as const
const invalid = (): never => historicalEvidenceInvalid('同步正文块的原创建回执和实际日志不闭合。')

function owned(db: Database.Database): void {
  assertHistoricalEvidenceOwned(db)
  if (db.pragma('main.user_version', { simple: true }) !== 27) return historicalEvidenceInvalid('同步正文块出生证明要求原 schema27。')
}

function sqlOriginals(db: Database.Database): SyncedCanonicalBlockBirthOriginalAccess {
  return {
    journal: token => readHistoricalTextRows<CreateJournalRow>(db, 'synced_host_history', journalColumns, 'id=?', [token])[0],
    operation: id => readHistoricalTextRows<HistoricalOperationRow>(db, 'synced_operations', operationColumns, 'client_operation_id=?', [id])[0],
    headingCreate: id => {
      const { original, supports } = syncedHeadingCreateBirthOriginalSupportsOwned2(db, id)
      return { ...original, supports }
    }
  }
}

/** Discover the original creation pointer from the real lifecycle. This only
 * proves birth and does not authorize a current owner or instance. */
export function findSyncedCanonicalBlockBirthOwned(db: Database.Database, address: SyncedCanonicalBlockAddress): SyncedCanonicalBlockBirthResult {
  owned(db)
  const lifecycle = readSyncedGroupLifecycles(db, [address.groupId]).get(address.groupId)
  if (!lifecycle?.createHistoryId) return { status: 'unsupported', reason: 'missing-provenance' }
  if (lifecycle.creationId !== address.creationId) return { status: 'unsupported', reason: 'target-mismatch' }
  return decodeBirthRows(address, lifecycle.createHistoryId, sqlOriginals(db))
}

/** Reopen an exact retained pointer without consulting today's group, physical
 * block, document path or instances. The caller separately checks live state. */
export function readSyncedCanonicalBlockBirthOriginalOwned(db: Database.Database, address: SyncedCanonicalBlockAddress,
  original: SyncedCanonicalBlockBirthPointer): SyncedCanonicalBlockBirthResult {
  owned(db)
  return decodeSyncedCanonicalBlockBirthOriginalRows(address, original, sqlOriginals(db))
}

/** Data-only pair decoding for authenticated complete original rows, including
 * the existing heading decoder when that envelope owns additional material. */
export function decodeSyncedCanonicalBlockBirthOriginalRows(address: SyncedCanonicalBlockAddress, original: SyncedCanonicalBlockBirthPointer,
  rows: SyncedCanonicalBlockBirthOriginalAccess): SyncedCanonicalBlockBirthResult {
  if (!isSyncedUuid(original.operationId)) return { status: 'unsupported', reason: 'missing-provenance' }
  return decodeBirthRows(address, original.historyToken, rows, original.operationId)
}

function decodeBirthRows(address: SyncedCanonicalBlockAddress, historyToken: string, rows: SyncedCanonicalBlockBirthOriginalAccess,
  expectedOperationId?: string): SyncedCanonicalBlockBirthResult {
  if (!isSyncedUuid(historyToken)) return { status: 'unsupported', reason: 'missing-provenance' }
  const journalRow = rows.journal(historyToken)
  if (!journalRow) return { status: 'unsupported', reason: 'missing-provenance' }
  assertSyncedShape(journalRow, journalColumns)
  if (journalRow.id !== historyToken || journalColumns.some(column => typeof journalRow[column] !== 'string')) return invalid()
  const action = hostJson(journalRow.action_json)
  if (!syncedPlainRecord(action) || action.kind !== 'host-command' || action.version !== 2)
    return { status: 'unsupported', reason: 'missing-provenance' }
  const journal = decodeHostCreateJournal(journalRow), { wire, wireHash } = journal.create
  const operationId = journal.input.clientOperationId
  if (expectedOperationId !== undefined && operationId !== expectedOperationId || wire.id !== address.groupId
    || wire.creationId !== address.creationId || wire.createdAt !== address.groupCreatedAt) return { status: 'unsupported', reason: 'target-mismatch' }
  const operation = rows.operation(operationId)
  if (!operation) return { status: 'unsupported', reason: 'missing-provenance' }
  assertSyncedShape(operation, operationColumns)
  if (operation.client_operation_id !== operationId || operationColumns.some(column => typeof operation[column] !== 'string')) return invalid()

  const packet = hostJson(operation.result_json)
  if (!syncedPlainRecord(packet)) return invalid()
  const heading = packet.kind === HEADING_CREATE_BIRTH2_OPERATION_KIND ? rows.headingCreate(operationId) : null
  if (!heading && packet.kind !== 'synced-host-create-operation') return invalid()
  const ack = heading?.result ?? decodeMainHostOperationAck(operation)
  if (!('createdLifecycle' in ack)) return invalid()
  if (heading ? !hostEqual(heading.journalRow, journalRow) || !hostEqual(heading.row, operation)
    : hostEncode({ kind: 'synced-host-create-operation', version: 1, result: ack }) !== operation.result_json) return invalid()

  const life = ack.createdLifecycle, host = ack.hosts[0], own = ack.groups.find(group => group.groupId === wire.id)
  if (life.state !== 'active' || ack.operationId !== operationId || ack.historyToken !== historyToken || life.createHistoryId !== historyToken
    || operation.created_at !== journalRow.created_at || wire.createdAt !== journalRow.created_at
    || operation.request_hash !== hostHash({ method: 'applySyncedHostCommand', input: journal.input })
    || life.groupId !== wire.id || life.creationId !== wire.creationId || life.createdAt !== wire.createdAt
    || life.activationHash !== wireHash || !hostEqual(life.origin, wire.origin) || !own
    || !hostEqual({ kind: 'synced-group', id: own.groupId, creationId: own.creationId, createdAt: own.createdAt,
      origin: own.origin, blocks: own.blocks, bindings: own.bindings }, wire)
    || host.documentId !== journal.before[0].documentId || !hostEqual(host.logicalBefore, journal.before[0].content)
    || !sameHostContent({ title: host.after.title, summary: host.after.summary,
      blocks: host.after.blocks.map(({ sortOrder: _sortOrder, ...block }) => block) }, journal.after[0].content)) return invalid()

  // The finite journal codec replayed the actual initial forest and derived
  // every wire birth from the original selected block or its allocated definition.
  const block = wire.blocks.find(item => item.id === address.blockId)
  if (!block) return { status: 'unsupported', reason: 'not-initial-child' }
  if (block.createdAt !== address.blockCreatedAt) return { status: 'unsupported', reason: 'target-mismatch' }
  return { status: 'proved', address: { groupId: wire.id, creationId: wire.creationId, groupCreatedAt: wire.createdAt,
    blockId: block.id, blockCreatedAt: block.createdAt }, original: { operationId, historyToken }, supports: [
    historicalOperationLocator(operation), ...(heading?.supports ?? [historicalRowLocator('synced_host_history', [historyToken], journalRow)])
  ] }
}
