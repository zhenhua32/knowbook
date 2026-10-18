import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { decodeHostJournal, hostJournalKind, validateHostSides } from './synced-host-journal'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { exchangeHostCutKey, exchangeRequestHash, parseExchangeStored, validateExchangeHostCut, validateExchangeReceipt,
  type ExchangeHostCut, type ExchangeReceipt } from '../sync/synced-exchange-model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'

function owned(db: Database.Database): void {
  if (!db.open || !db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1)
    return publicationInvalid('exchange history cut只允许真实owned transaction/FK只读检查。')
}
/** Read-only original journal facts. No persistence/mint authority is exported. */
export function readSyncedExchangeCutJournal(db: Database.Database, historyToken: string): { journalHash: string; documentIds: string[] } {
  owned(db)
  if (!isSyncedUuid(historyToken)) return publicationInvalid('exchange history cut token无效。')
  const row = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?')
    .get(historyToken) as SyncedHostHistoryBranchRow | undefined
  if (!row || row.id !== historyToken || Object.values(row).some(value => typeof value !== 'string') || !Number.isFinite(Date.parse(row.created_at)))
    return publicationInvalid('exchange history cut原immutable journal缺失/损坏。')
  let before: string[], after: string[]
  if (hostJournalKind(row) === 'bare-create') {
    const rawBefore = parseExchangeStored(row.before_json), rawAfter = parseExchangeStored(row.after_json)
    const beforeSides = validateHostSides(rawBefore), afterSides = validateHostSides(rawAfter)
    if (publicationHash(publicationJson(rawBefore)) !== row.before_hash || publicationHash(publicationJson(rawAfter)) !== row.after_hash)
      return publicationInvalid('exchange history cut原bare create side/hash损坏。')
    before = beforeSides.map(side => side.documentId); after = afterSides.map(side => side.documentId)
  } else {
    const journal = decodeHostJournal(row); before = journal.before.map(side => side.documentId); after = journal.after.map(side => side.documentId)
  }
  before.sort(publicationCompare); after.sort(publicationCompare)
  if (!before.length || publicationJson(before) !== publicationJson(after)) return publicationInvalid('exchange history cut原before/after参与者不闭合。')
  // Hash exact original SQL strings, including each journal JSON string's original bytes/spelling.
  return { journalHash: publicationHash(publicationJson(row)), documentIds: before }
}

/** Historical denial evidence; current epoch/cursor/remote version never revokes an authenticated cut. */
export function assertSyncedExchangeHostCutRecords(db: Database.Database): Map<string, ExchangeHostCut> {
  owned(db)
  const receiptRows = db.prepare("SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE json_extract(result_json,'$.kind')='synced-exchange-operation'")
    .all() as Array<{ client_operation_id: string; request_hash: string; result_json: string; created_at: string }>
  const receipts = new Map<string, ExchangeReceipt>(), references = new Map<string, { operationId: string; cutHash: string }>()
  // Materialize before nested journal/pragma reads; no active iterate() statement is retained.
  for (const row of receiptRows) {
    const receipt = validateExchangeReceipt(parseExchangeStored(row.result_json))
    if (receipt.request.operationId !== row.client_operation_id || receipt.result.operationId !== row.client_operation_id || receipt.result.replayed
      || exchangeRequestHash(receipt.request) !== row.request_hash || receipt.result.acceptedAt !== row.created_at)
      return publicationInvalid('exchange history cut原operation request_hash/created_at/replay损坏。')
    receipts.set(row.client_operation_id, receipt)
    for (const proof of receipt.provenance.hostHistoryCuts) {
      if (references.has(proof.historyToken)) return publicationInvalid('exchange history cut被多个原receipt重复认领。')
      references.set(proof.historyToken, { operationId: row.client_operation_id, cutHash: proof.cutHash })
    }
  }
  const rows = db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-host-cut.v1.%' ORDER BY key")
    .all() as Array<{ key: string; value: string; updated_at: string }>
  const cuts = new Map<string, ExchangeHostCut>()
  for (const row of rows) {
    const cut = validateExchangeHostCut(parseExchangeStored(row.value)), reference = references.get(cut.historyToken), receipt = receipts.get(cut.operationId)
    if (row.key !== exchangeHostCutKey(cut.historyToken) || row.updated_at !== cut.cutAt || !reference || !receipt
      || reference.operationId !== cut.operationId || reference.cutHash !== publicationHash(row.value) || cut.cutAt !== receipt.result.acceptedAt)
      return publicationInvalid('exchange history cut与准确原receipt/key/hash/时点不闭合。')
    const journal = readSyncedExchangeCutJournal(db, cut.historyToken)
    if (journal.journalHash !== cut.journalHash || publicationJson(cut.participants.map(item => item.documentId)) !== publicationJson(journal.documentIds))
      return publicationInvalid('exchange history cut原journal bytes/完整参与者损坏。')
    if (db.prepare('SELECT 1 FROM synced_host_history_documents WHERE history_id=? LIMIT 1').get(cut.historyToken))
      return publicationInvalid('exchange history cut仍残留原全部或部分执行映射。')
    cuts.set(cut.historyToken, cut)
  }
  // Receipt -> cut is mandatory too: deleting a whole cut cannot become an innocent missing record.
  for (const historyToken of references.keys()) if (!cuts.has(historyToken)) return publicationInvalid('exchange history cut原receipt所指持久证明缺失。')
  return cuts
}
export function readSyncedExchangeHostCut(db: Database.Database, historyToken: string): ExchangeHostCut | null {
  if (!isSyncedUuid(historyToken)) return publicationInvalid('exchange history cut token无效。')
  return assertSyncedExchangeHostCutRecords(db).get(historyToken) ?? null
}
