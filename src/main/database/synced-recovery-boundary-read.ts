import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { readSyncedExchangeCutJournal } from './synced-exchange-host-cut'
import { decodeHostJournal, hostJournalKind, validateHostSides } from './synced-host-journal'
import { parseStrictJson } from '../../shared/strictJson'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { RECOVERY_BOUNDARY_PREFIX, RECOVERY_EPOCH_PREFIX, RECOVERY_BOUNDARY_CHANNEL,
  recoveryBoundaryInvalid, recoveryBoundaryJson, recoveryBoundaryKey, recoveryEpochMarkerId, recoveryBoundaryHash,
  recoveryEpochRequestHash, recoveryEpochTargetFingerprint, recoveryOperationRowHash, parseRecoveryBoundaryJson,
  validateSyncedRecoveryHistoryBoundary, validateSyncedRecoveryEpochReceipt,
  type SyncedRecoveryHistoryBoundary, type SyncedRecoveryEpochReceipt, type SyncedRecoveryOperationRow } from './synced-recovery-boundary-model'

export interface SyncedRecoveryBoundaryRecords {
  boundaries: Map<string, SyncedRecoveryHistoryBoundary>
  hostCuts: Map<string, SyncedRecoveryHistoryBoundary>
  groupArchives: Map<string, SyncedRecoveryHistoryBoundary[]>
}
type Marker = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
type Setting = { key: string; value: string; updated_at: string }
type Anchor = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string; state: string; created_at: string; confirmed_at: string | null }
const operationColumns = ['client_operation_id', 'request_hash', 'result_json', 'created_at'] as const
const settingColumns = ['key', 'value', 'updated_at'] as const
const anchorColumns = ['id', 'request_hash', 'channel', 'target_fingerprint', 'publication_hash', 'state', 'created_at'] as const
const journalColumns = ['id', 'action_json', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'] as const
function originalTextSelection(columns: readonly string[]): string {
  return columns.flatMap((name, index) => [name, `typeof(${name}) AS type_${index}`, `CAST(${name} AS BLOB) AS raw_${index}`]).join(',')
}
/** Authenticate SQLite TEXT bytes before hashing/comparing the driver's strings. */
function originalTextRecord<T>(source: Record<string, unknown>, columns: readonly string[]): T {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), row: Record<string, string> = {}
  for (const [index, name] of columns.entries()) {
    const raw = source['raw_' + index]
    if (source['type_' + index] !== 'text' || typeof source[name] !== 'string' || !(raw instanceof Uint8Array)) return recoveryBoundaryInvalid('原SQL值不是准确TEXT')
    let decoded: string
    try { decoded = decoder.decode(raw) } catch { return recoveryBoundaryInvalid('原SQL TEXT含非法UTF8') }
    if (decoded !== source[name] || !Buffer.from(decoded, 'utf8').equals(Buffer.from(raw))) return recoveryBoundaryInvalid('原SQL TEXT不能无损读取')
    row[name] = decoded
  }
  return row as unknown as T
}
function owned(db: Database.Database): void {
  if (!db.open || !db.inTransaction) return recoveryBoundaryInvalid('leaf读取要求原connection真实owned事务')
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
/** No schema assertion, public group read, epoch admission, or recursive receipt
 * reader is called. Each invocation authenticates its own actual SQL snapshot.
 * Document CAS, instance bindings and group guards in B remain historical facts;
 * today's content/epoch/host existence may legitimately have changed. */
export function assertSyncedRecoveryBoundaryRecords(db: Database.Database): SyncedRecoveryBoundaryRecords {
  owned(db)
  const settingFamily = 'synced.recovery.history.', markerFamily = 'synced:recovery-epoch:'
  const settingEnd = 'synced.recovery.history/', markerEnd = 'synced:recovery-epoch;'
  // Stable primary-key ranges inspect the complete family (including unknown
  // versions) without parsing every ordinary operation ACK.
  const settingRows = (db.prepare('SELECT ' + originalTextSelection(settingColumns) + ' FROM app_settings WHERE key>=? AND key<? ORDER BY key')
    .all(settingFamily, settingEnd) as Record<string, unknown>[]).map(row => originalTextRecord<Setting>(row, settingColumns))
  const markerRows = (db.prepare(`SELECT ${originalTextSelection(operationColumns)} FROM synced_operations
    WHERE client_operation_id>=? AND client_operation_id<? ORDER BY client_operation_id`)
    .all(markerFamily, markerEnd) as Record<string, unknown>[]).map(row => originalTextRecord<Marker>(row, operationColumns))
  const anchorRows = (db.prepare(`SELECT ${originalTextSelection(anchorColumns)},confirmed_at FROM synced_exposure_attempts
    WHERE (id>=? AND id<?) OR channel=? ORDER BY id`).all(markerFamily, markerEnd, RECOVERY_BOUNDARY_CHANNEL) as Record<string, unknown>[])
    .map(row => ({ ...originalTextRecord<Omit<Anchor, 'confirmed_at'>>(row, anchorColumns), confirmed_at: row.confirmed_at }))
  if (!settingRows.length && !markerRows.length && !anchorRows.length) return { boundaries: new Map(), hostCuts: new Map(), groupArchives: new Map() }
  if ((db.pragma('foreign_key_check') as unknown[]).length) return recoveryBoundaryInvalid('原数据库外键不完整')
  const boundaries = new Map<string, SyncedRecoveryHistoryBoundary>(), settings = new Map<string, Setting>()
  for (const row of settingRows) {
    if (!row.key.startsWith(RECOVERY_BOUNDARY_PREFIX)) return recoveryBoundaryInvalid('未知恢复边界metadata版本')
    const boundary = validateSyncedRecoveryHistoryBoundary(parseRecoveryBoundaryJson(row.value))
    if (row.key !== recoveryBoundaryKey(boundary.operationId) || row.updated_at !== boundary.acceptedAt || boundaries.has(boundary.operationId)) return recoveryBoundaryInvalid('boundary原key/时点/身份不闭合')
    boundaries.set(boundary.operationId, boundary); settings.set(boundary.operationId, row)
  }
  const receipts = new Map<string, { receipt: SyncedRecoveryEpochReceipt; marker: Marker }>()
  for (const row of markerRows) {
    if (!row.client_operation_id.startsWith(RECOVERY_EPOCH_PREFIX)) return recoveryBoundaryInvalid('未知恢复epoch marker版本或key')
    const receipt = validateSyncedRecoveryEpochReceipt(parseRecoveryBoundaryJson(row.result_json))
    if (row.client_operation_id !== recoveryEpochMarkerId(receipt.operationId) || row.request_hash !== recoveryEpochRequestHash(receipt)
      || row.created_at !== receipt.acceptedAt || receipts.has(receipt.operationId)) return recoveryBoundaryInvalid('epoch marker原key/hash/时点不闭合')
    receipts.set(receipt.operationId, { receipt, marker: row })
  }
  const anchors = new Map(anchorRows.map(row => [row.id, row]))
  if (boundaries.size !== receipts.size || receipts.size !== anchors.size) return recoveryBoundaryInvalid('boundary/marker/anchor数量或反向闭集不符')
  const hostCuts = new Map<string, SyncedRecoveryHistoryBoundary>(), groupArchives = new Map<string, SyncedRecoveryHistoryBoundary[]>()
  const archivedIds = new Set<string>()
  const operationRows = new Map<string, SyncedRecoveryOperationRow>()
  for (const [operationId, boundary] of boundaries) {
    const saved = receipts.get(operationId), setting = settings.get(operationId), anchor = anchors.get(recoveryEpochMarkerId(operationId))
    if (!saved || !setting || !anchor) return recoveryBoundaryInvalid('孤boundary/marker/anchor')
    const { receipt, marker } = saved, boundaryHash = recoveryBoundaryHash(boundary)
    if (receipt.boundaryHash !== boundaryHash || receipt.workspaceScope !== boundary.workspaceScope
      || receipt.beforeEpoch !== boundary.beforeEpoch || receipt.afterEpoch !== boundary.afterEpoch || receipt.acceptedAt !== boundary.acceptedAt
      || anchor.id !== marker.client_operation_id || anchor.request_hash !== marker.request_hash || anchor.channel !== RECOVERY_BOUNDARY_CHANNEL
      || anchor.target_fingerprint !== recoveryEpochTargetFingerprint(boundary.workspaceScope) || anchor.publication_hash !== boundaryHash
      || anchor.state !== 'possible' || anchor.confirmed_at !== null || anchor.created_at !== boundary.acceptedAt
      || db.prepare('SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=? LIMIT 1').get(anchor.id)) return recoveryBoundaryInvalid('原receipt/boundary/零成员不可删anchor不闭合')
    for (const retained of boundary.retainedOperations) {
      let original = operationRows.get(retained.operationId)
      if (!original) {
        original = readOriginalOperationRow(db, retained.operationId)
        operationRows.set(retained.operationId, original)
      }
      if (recoveryOperationRowHash(original) !== retained.rowHash) return recoveryBoundaryInvalid('原operation ACK行被改写')
    }
    for (const pin of boundary.retainedPins) {
      const columns = ['created_at'] as const
      const original = db.prepare('SELECT ' + originalTextSelection(columns) + ' FROM synced_group_pins WHERE group_id=? AND kind=? AND pin_id=?')
        .get(pin.groupId, pin.kind, pin.pinId) as Record<string, unknown> | undefined
      if (!original || originalTextRecord<{ created_at: string }>(original, columns).created_at !== pin.createdAt) return recoveryBoundaryInvalid('恢复前原pin缺失或时点改变')
    }
    for (const cut of boundary.hostCuts) {
      if (hostCuts.has(cut.historyToken)) return recoveryBoundaryInvalid('同host token被多个恢复boundary认领')
      // This existing journal-only helper is a leaf; its FK precondition is
      // retained. Startup may inspect with FK off, so execute the same pure
      // journal authentication below without changing the connection pragma.
      const journal = readCutJournal(db, cut.historyToken)
      if (journal.journalHash !== cut.journalHash || recoveryBoundaryJson(journal.documentIds) !== recoveryBoundaryJson(cut.documentIds)
        || db.prepare('SELECT 1 FROM synced_host_history_documents WHERE history_id=? LIMIT 1').get(cut.historyToken)) return recoveryBoundaryInvalid('原host journal/完整参与者损坏或旧mapping仍可执行')
      hostCuts.set(cut.historyToken, boundary)
    }
    for (const group of boundary.groups) {
      const columns = ['creation_id', 'created_at', 'origin_json'] as const
      const row = db.prepare('SELECT ' + originalTextSelection(columns) + ' FROM synced_groups WHERE id=?').get(group.groupId) as Record<string, unknown> | undefined
      const actual = row && originalTextRecord<{ creation_id: string; created_at: string; origin_json: string }>(row, columns)
      if (!actual || actual.creation_id !== group.creationId || actual.created_at !== group.createdAt || actual.origin_json !== group.originJson) return recoveryBoundaryInvalid('归档失去原组完整immutable tuple')
      for (const row of group.rows) {
        if (archivedIds.has(row.id) || db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(row.id)) return recoveryBoundaryInvalid('归档原history ID重复或仍在活动执行链')
        archivedIds.add(row.id)
      }
      const history = groupArchives.get(group.groupId) ?? []; history.push(boundary); groupArchives.set(group.groupId, history)
    }
    freeze(boundary)
  }
  return { boundaries, hostCuts, groupArchives }
}
export function readSyncedRecoveryHostCut(db: Database.Database, historyToken: string): SyncedRecoveryHistoryBoundary | null {
  if (!isSyncedUuid(historyToken)) return recoveryBoundaryInvalid('host history token无效')
  return assertSyncedRecoveryBoundaryRecords(db).hostCuts.get(historyToken) ?? null
}

function readOriginalOperationRow(db: Database.Database, operationId: string): SyncedRecoveryOperationRow {
  const source = db.prepare('SELECT ' + originalTextSelection(operationColumns) + ' FROM synced_operations WHERE client_operation_id=?').get(operationId) as Record<string, unknown> | undefined
  if (!source) return recoveryBoundaryInvalid('恢复前原operation ACK行缺失')
  const row = originalTextRecord<SyncedRecoveryOperationRow>(source, operationColumns)
  if (row.client_operation_id !== operationId) return recoveryBoundaryInvalid('原operation SQL身份不符')
  return row
}
function readCutJournal(db: Database.Database, historyToken: string): { journalHash: string; documentIds: string[] } {
  const source = db.prepare('SELECT ' + originalTextSelection(journalColumns) + ' FROM synced_host_history WHERE id=?')
    .get(historyToken) as Record<string, unknown> | undefined
  if (!source) return recoveryBoundaryInvalid('原host immutable journal缺失')
  const row = originalTextRecord<SyncedHostHistoryBranchRow>(source, journalColumns)
  if (db.pragma('foreign_keys', { simple: true }) === 1) return readSyncedExchangeCutJournal(db, historyToken)
  if (row.id !== historyToken || !Number.isFinite(Date.parse(row.created_at))) return recoveryBoundaryInvalid('原host immutable journal损坏')
  const hash = (value: unknown): string => createHash('sha256').update(recoveryBoundaryJson(value)).digest('hex')
  const parse = (text: string): unknown => parseStrictJson(text, { maxBytes: Math.max(1, Buffer.byteLength(text, 'utf8')), maxDepth: 32 })
  let before: string[], after: string[]
  if (hostJournalKind(row) === 'bare-create') {
    const rawBefore = parse(row.before_json), rawAfter = parse(row.after_json)
    before = validateHostSides(rawBefore).map(side => side.documentId); after = validateHostSides(rawAfter).map(side => side.documentId)
    if (hash(rawBefore) !== row.before_hash || hash(rawAfter) !== row.after_hash) return recoveryBoundaryInvalid('原bare-create sides/hash损坏')
  } else {
    const journal = decodeHostJournal(row); before = journal.before.map(side => side.documentId); after = journal.after.map(side => side.documentId)
  }
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
  before.sort(compare); after.sort(compare)
  if (!before.length || recoveryBoundaryJson(before) !== recoveryBoundaryJson(after)) return recoveryBoundaryInvalid('原journal完整参与者不闭合')
  return { journalHash: hash(row), documentIds: before }
}
