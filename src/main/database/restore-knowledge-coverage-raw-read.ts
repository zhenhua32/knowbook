import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { parseRestoreJson, restoreReceiptKey, validateRestoreReceipt } from './restore-safety-model'
import { assertHistoricalEvidenceOwned, readHistoricalExactRows, readHistoricalRowLocator,
  readHistoricalTextRows, type HistoricalMetadataRow, type HistoricalOperationRow } from './synced-history-evidence-support'
import { readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { parseRecoveryBoundaryJson, recoveryBoundaryHash, recoveryBoundaryKey, recoveryEpochMarkerId,
  recoveryEpochRequestHash, validateSyncedRecoveryEpochReceipt } from './synced-recovery-boundary-model'
import { COVERAGE_ANCHOR_CHANNEL, COVERAGE_OPERATION_PREFIX, COVERAGE_RECEIPT_PREFIX, COVERAGE_SETTING_PREFIX,
  coverageAnchorExpectation, coverageOperationId, coverageReceiptKey, coverageSettingKey,
  knowledgeRestoreReceiptHash, parseKnowledgeRestoreReceipt, parseSyncedKnowledgeCoverage,
  parseSyncedKnowledgeCoverageLink, syncedKnowledgeCoverageHash, syncedKnowledgeCoverageLinkHash,
  validateCoverageStructureTuple, validateRawPriorCoverageRequirements,
  type CoverageSqlRowReference, type KnowledgeRestoreReceiptV2, type RawCoverageRequirement,
  type RawPriorCoverageRequirements, type SyncedKnowledgeCoverageLinkV1,
  type SyncedKnowledgeCoverageV1 } from './restore-knowledge-coverage-model'

const settingFamily = 'synced.restore.coverage.'
const receiptFamily = 'database.restore.receipt.'
const operationFamily = 'synced:restore-knowledge-coverage:'
const channelFamily = 'recovery-knowledge-coverage'
const boundaryFamily = 'synced.recovery.history.'
const epochFamily = 'synced:recovery-epoch:'
const settingColumns = ['key', 'value', 'updated_at'] as const
const operationColumns = ['client_operation_id', 'request_hash', 'result_json', 'created_at'] as const
const anchorColumns = ['id', 'request_hash', 'channel', 'target_fingerprint', 'publication_hash', 'state', 'created_at', 'confirmed_at'] as const
const memberColumns = ['attempt_id', 'group_id', 'creation_id', 'revision', 'topology_revision', 'semantic_hash'] as const
type Anchor = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string
  state: string; created_at: string; confirmed_at: string | null }
type Member = { attempt_id: string; group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }
function refused(message: string): never {
  throw new Error('恢复知识原SQL requirements无效：' + message + '；不授接受、安装或empty证明。')
}
/** CAST is only a reserved-family detector. Every selected value must still
 * authenticate its real SQL storage class and database-encoding bytes below. */
function family(column: string): string { return 'substr(lower(CAST(' + column + ' AS TEXT)),1,?)=?' }
function familyParameters(prefix: string): readonly [number, string] { return [prefix.length, prefix] }
function startsFamily(value: string, prefix: string): boolean { return value.toLowerCase().startsWith(prefix) }
function settings(db: Database.Database, prefix: string): HistoricalMetadataRow[] {
  return readHistoricalTextRows(db, 'app_settings', settingColumns, family('key') + ' ORDER BY key', familyParameters(prefix))
}
function operations(db: Database.Database, prefix: string): HistoricalOperationRow[] {
  return readHistoricalTextRows(db, 'synced_operations', operationColumns,
    family('client_operation_id') + ' ORDER BY client_operation_id', familyParameters(prefix))
}
function rowReference(db: Database.Database, table: CoverageSqlRowReference['table'], key: string): CoverageSqlRowReference {
  const original = readHistoricalRowLocator(db, table, [key])
  if (original.table !== table || original.key.length !== 1 || original.key[0] !== key) return refused('完整原行locator不闭合')
  return { table, key: [key], rowHash: original.rowHash }
}
function add<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.has(key)) return refused('同operation重复原记录')
  map.set(key, value)
}
function checkAnchorText(row: Anchor): void {
  if (anchorColumns.some(column => column === 'confirmed_at' ? row[column] !== null && typeof row[column] !== 'string' : typeof row[column] !== 'string'))
    return refused('attempt原列不是准确TEXT/null')
}
/** The old ordinary exposure channel is intentionally open TEXT, not an enum.
 * A UUID attempt with real nonzero members remains ordinary even when its
 * channel happens to equal this version's reserved zero-member channel. */
function assertOrdinaryExposure(db: Database.Database, anchor: Anchor): void {
  if (!isSyncedUuid(anchor.id)) return refused('channel-only anchor不是原普通UUID attempt')
  const members = readHistoricalTextRows<Member>(db, 'synced_group_exposure_members', memberColumns,
    'CAST(attempt_id AS TEXT)=? ORDER BY group_id', [anchor.id])
  if (!members.length || members.some(member => member.attempt_id !== anchor.id)) return refused('无C id的reserved channel不能用零成员声明普通曝光')
  // This is the existing original raw validation, including creation tuple,
  // hashes, UUIDs, open channel TEXT, dates and aggregate exposure state.
  // It does not check today's CAS against a historical member's CAS.
  const groupIds = [...new Set(members.map(member => member.group_id))]
  const lifecycles = readSyncedGroupLifecycles(db, groupIds)
  if (lifecycles.size !== groupIds.length) return refused('普通曝光member无真实原lifecycle支持')
}

/** Main-internal raw read only. The returned frozen stored references remain
 * unresolved in the original bundle/native interpretation domain. No DAG/FS,
 * public admission, ordinary audit, effective reader or total historical scan
 * is invoked. Empty entries are not an authenticated empty-knowledge result. */
export function readRawPriorKnowledgeCoverageOwned(db: Database.Database): RawPriorCoverageRequirements {
  assertHistoricalEvidenceOwned(db)
  const version = db.pragma('user_version', { simple: true })
  if (version !== 26 && version !== 27) return refused('仅支持schema26/27；未知版本不推定empty')
  const coverageRows = settings(db, settingFamily), receiptRows = settings(db, receiptFamily)
  const linkRows = operations(db, operationFamily)
  const coverages = new Map<string, { value: SyncedKnowledgeCoverageV1; row: HistoricalMetadataRow }>()
  const receipts = new Map<string, { value: KnowledgeRestoreReceiptV2; row: HistoricalMetadataRow }>()
  const links = new Map<string, { value: SyncedKnowledgeCoverageLinkV1; row: HistoricalOperationRow }>()
  for (const row of receiptRows) {
    if (row.key.startsWith(COVERAGE_RECEIPT_PREFIX)) {
      const receipt = parseKnowledgeRestoreReceipt(row.value)
      if (row.key !== coverageReceiptKey(receipt.operationId) || row.updated_at !== receipt.acceptedAt) return refused('Receipt2原key/时点不闭合')
      add(receipts, receipt.operationId, { value: receipt, row })
    } else {
      const suffix = row.key.slice(receiptFamily.length)
      if (!row.key.startsWith(receiptFamily) || !isSyncedUuid(suffix)) return refused('未知restore receipt family版本/key')
      const old = validateRestoreReceipt(parseRestoreJson(row.value))
      if (row.key !== restoreReceiptKey(old.operationId) || row.updated_at !== old.acceptedAt) return refused('旧receipt1原key/时点被替换')
    }
  }
  if (version === 26) {
    // Only sqlite_master is consulted: never query a schema27-only table on 26.
    const lifecycleTables = ['synced_group_lifecycle', 'synced_group_retirements',
      'synced_exposure_attempts', 'synced_group_exposure_members']
    if (coverageRows.length || receipts.size || linkRows.length || settings(db, boundaryFamily).length || operations(db, epochFamily).length
      || lifecycleTables.some(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)))
      return refused('schema26含27 coverage/lifecycle历史原件')
    return validateRawPriorCoverageRequirements({ kind: 'restore-knowledge-unresolved-required-roots', version: 1, schemaVersion: 26, entries: [] })
  }
  for (const row of coverageRows) {
    if (!row.key.startsWith(COVERAGE_SETTING_PREFIX)) return refused('未知coverage metadata版本/key')
    const coverage = parseSyncedKnowledgeCoverage(row.value)
    if (row.key !== coverageSettingKey(coverage.operationId) || row.updated_at !== coverage.acceptedAt) return refused('C原key/时点不闭合')
    add(coverages, coverage.operationId, { value: coverage, row })
  }
  for (const row of linkRows) {
    if (!row.client_operation_id.startsWith(COVERAGE_OPERATION_PREFIX)) return refused('未知coverage link版本/key')
    const link = parseSyncedKnowledgeCoverageLink(row.result_json)
    if (row.client_operation_id !== coverageOperationId(link.operationId) || row.request_hash !== syncedKnowledgeCoverageLinkHash(link)
      || row.created_at !== link.acceptedAt) return refused('link原id/hash/时点不闭合')
    add(links, link.operationId, { value: link, row })
  }
  // Reserved marker membership is invalid even if its attempt or C is absent.
  if (readHistoricalExactRows(db, 'synced_group_exposure_members', memberColumns,
    family('attempt_id'), familyParameters(operationFamily)).length) return refused('coverage ID family不得有任何member，包括孤member')
  const candidates = readHistoricalExactRows<Anchor>(db, 'synced_exposure_attempts', anchorColumns,
    '(' + family('id') + ') OR (' + family('channel') + ') ORDER BY id',
    [...familyParameters(operationFamily), ...familyParameters(channelFamily)])
  const anchors = new Map<string, Anchor>()
  const linkedAnchorIds = new Set([...coverages.keys()].map(coverageOperationId))
  for (const anchor of candidates) {
    checkAnchorText(anchor)
    if (!startsFamily(anchor.id, operationFamily)) {
      // A linked C always uses the reserved non-UUID marker ID. Never classify
      // a marker as ordinary based on member count or an open channel name.
      if (linkedAnchorIds.has(anchor.id)) return refused('已链接C anchor不是reserved原id')
      assertOrdinaryExposure(db, anchor)
      continue
    }
    if (!anchor.id.startsWith(COVERAGE_OPERATION_PREFIX) || anchor.channel !== COVERAGE_ANCHOR_CHANNEL) return refused('未知coverage anchor版本/id/channel')
    const operationId = anchor.id.slice(COVERAGE_OPERATION_PREFIX.length)
    if (coverageOperationId(operationId) !== anchor.id) return refused('coverage anchor不是准确canonical marker')
    add(anchors, operationId, anchor)
  }
  if (coverages.size !== links.size || links.size !== receipts.size || receipts.size !== anchors.size)
    return refused('C/link/Receipt2/zero-member anchor反向闭集不完整')
  // An ordinary declaration is not an empty audit. Still reject an actual
  // same-operation B/R rather than quietly relabeling history as ordinary.
  const hasHistory = [...coverages.values()].some(item => item.value.cut.kind === 'synced-recovery-epoch-cut')
  const historical = hasHistory ? assertSyncedRecoveryBoundaryRecords(db) : null
  const entries: RawCoverageRequirement[] = []
  for (const [operationId, saved] of [...coverages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const linked = links.get(operationId), restored = receipts.get(operationId), anchor = anchors.get(operationId)
    if (!linked || !restored || !anchor) return refused('孤C/link/Receipt2/anchor')
    const { coverage, link, receipt } = validateCoverageStructureTuple({ coverage: saved.value, link: linked.value, receipt: restored.value })
    const expected = coverageAnchorExpectation(link)
    if (anchorColumns.some(column => anchor[column] !== expected[column])) return refused('真实零成员anchor与原tuple/hash/时点不闭合')
    const cut = coverage.cut
    let boundary: CoverageSqlRowReference | null = null, epoch: CoverageSqlRowReference | null = null
    if (cut.kind === 'synced-recovery-epoch-cut') {
      const actual = historical?.boundaries.get(operationId)
      if (!actual || actual.workspaceScope !== cut.workspaceScope || actual.beforeEpoch !== cut.beforeEpoch || actual.afterEpoch !== cut.afterEpoch
        || actual.documentBoundary !== cut.documentBoundary || actual.acceptedAt !== cut.acceptedAt || recoveryBoundaryHash(actual) !== cut.boundaryHash)
        return refused('history cut缺真实B或与B原分配不一致')
      const rows = readHistoricalTextRows<HistoricalOperationRow>(db, 'synced_operations', operationColumns, 'client_operation_id=?', [recoveryEpochMarkerId(operationId)])
      if (rows.length !== 1) return refused('history cut缺真实R')
      const raw = rows[0], actualReceipt = validateSyncedRecoveryEpochReceipt(parseRecoveryBoundaryJson(raw.result_json))
      if (actualReceipt.operationId !== operationId || actualReceipt.boundaryHash !== cut.boundaryHash || actualReceipt.workspaceScope !== cut.workspaceScope
        || actualReceipt.beforeEpoch !== cut.beforeEpoch || actualReceipt.afterEpoch !== cut.afterEpoch || actualReceipt.acceptedAt !== cut.acceptedAt
        || raw.request_hash !== cut.epochRequestHash || recoveryEpochRequestHash(actualReceipt) !== cut.epochRequestHash || raw.created_at !== cut.acceptedAt)
        return refused('history cut与真实R原hash/tuple不一致')
      boundary = rowReference(db, 'app_settings', recoveryBoundaryKey(operationId))
      epoch = rowReference(db, 'synced_operations', recoveryEpochMarkerId(operationId))
    } else if (db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(recoveryBoundaryKey(operationId))
      || db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(recoveryEpochMarkerId(operationId))) {
      return refused('ordinary cut不能隐藏同operation真实B/R；缺B亦不证明empty')
    }
    entries.push({ operationId, coverageHash: syncedKnowledgeCoverageHash(coverage), receiptHash: knowledgeRestoreReceiptHash(receipt),
      root: coverage.root, cut, acceptedAt: coverage.acceptedAt, supports: {
        coverage: rowReference(db, 'app_settings', saved.row.key), link: rowReference(db, 'synced_operations', linked.row.client_operation_id),
        receipt: rowReference(db, 'app_settings', restored.row.key), anchor: rowReference(db, 'synced_exposure_attempts', anchor.id), boundary, epoch } })
  }
  return validateRawPriorCoverageRequirements({ kind: 'restore-knowledge-unresolved-required-roots', version: 1, schemaVersion: 27, entries })
}
