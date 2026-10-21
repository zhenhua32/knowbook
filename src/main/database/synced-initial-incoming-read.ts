import type Database from 'better-sqlite3'
import { assertSyncedPersistentPublicationReadAdmissionOwned, type SyncedPublicationLocalSnapshot } from './synced-publication'
import { readRawInitialIncomingWorkspaceOwned, type InitialIncomingIdentity } from './synced-initial-incoming-raw-read'
import { initialIncomingBaselineKey, initialIncomingRequestHash, parseInitialIncomingStored, validateInitialIncomingBaseline,
  validateInitialIncomingReceipt, type InitialIncomingBaseline, type InitialIncomingReceipt, type InitialIncomingRequest } from '../sync/synced-initial-incoming-model'
import { publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'

export type { InitialIncomingIdentity } from './synced-initial-incoming-raw-read'
export interface InitialIncomingLocal {
  snapshot: SyncedPublicationLocalSnapshot; fingerprint: string
  identities: Map<string, InitialIncomingIdentity>; historyDocuments: Set<string>; historyBlocks: Set<string>
  groupIds: Set<string>; baseline: InitialIncomingBaseline | null; baselineRaw: string | null
}
export type InitialIncomingWorkspace = Omit<InitialIncomingLocal, 'baseline' | 'baselineRaw'>
type OperationRow = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }
function json(source: string): unknown { return parseInitialIncomingStored(source) }

/** Pure readonly exact receipt lookup. No caller object is a write permit. */
export function readInitialIncomingReceipt(db: Database.Database, request: InitialIncomingRequest): InitialIncomingReceipt | null {
  const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(request.operationId) as OperationRow | undefined
  if (!row) return null
  const receipt = validateInitialIncomingReceipt(json(row.result_json))
  if (row.client_operation_id !== receipt.request.operationId || row.request_hash !== initialIncomingRequestHash(receipt.request)
    || row.created_at !== receipt.result.acceptedAt || publicationJson(receipt.request) !== publicationJson(request)) return publicationInvalid('incoming 原请求/回执损坏或 idempotency mismatch。')
  return receipt
}
export function readInitialIncomingBaseline(db: Database.Database, request: InitialIncomingRequest): { value: InitialIncomingBaseline; raw: string } | null {
  const row = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(initialIncomingBaselineKey(request.targetFingerprint)) as { value: unknown; updated_at: unknown } | undefined
  if (!row) return null
  if (typeof row.value !== 'string') return publicationInvalid('incoming 来源 baseline 不是原 JSON。')
  const value = validateInitialIncomingBaseline(json(row.value))
  if (value.databasePath !== request.databasePath || value.targetFingerprint !== request.targetFingerprint || row.updated_at !== value.lastReceivedAt) return publicationInvalid('incoming baseline 目标、路径或接受时间损坏。')
  const original = readInitialIncomingReceipt(db, { ...request, operationId: value.result.operationId })
  if (!original || publicationJson(original.result) !== publicationJson(value.result) || publicationJson(original.provenance) !== publicationJson(value.provenance)) return publicationInvalid('incoming baseline 缺原准确 receipt。')
  return { value, raw: row.value }
}

/** Public callers retain the original admission before reading raw facts. */
function captureInitialIncomingWorkspace(db: Database.Database) {
  assertSyncedPersistentPublicationReadAdmissionOwned(db)
  return readRawInitialIncomingWorkspaceOwned(db)
}

/** Request-free strict workspace read. No incoming baseline/receipt lookup or write authority. */
export function readInitialIncomingWorkspace(db: Database.Database): InitialIncomingWorkspace {
  if (!db.open || !db.inTransaction) return publicationInvalid('incoming workspace读取要求开放原connection的真实自有事务。')
  const { snapshot, identities, historyDocuments, historyBlocks, groupIds, rawIdentities, historyRows } = captureInitialIncomingWorkspace(db)
  return { snapshot, identities, historyDocuments, historyBlocks, groupIds,
    fingerprint: publicationHash(publicationJson({ snapshot: snapshot.localFingerprint, rawIdentities, historyRows })) }
}

/** Caller owns a strict read/IMMEDIATE. This leaf reads authority; it never repairs, reserves or adopts. */
export function readInitialIncomingLocal(db: Database.Database, request: InitialIncomingRequest): InitialIncomingLocal {
  const { snapshot, identities, historyDocuments, historyBlocks, groupIds, rawIdentities, historyRows } = captureInitialIncomingWorkspace(db)
  const baseline = readInitialIncomingBaseline(db, request)
  return { snapshot, identities, historyDocuments, historyBlocks, groupIds, baseline: baseline?.value ?? null, baselineRaw: baseline?.raw ?? null,
    fingerprint: publicationHash(publicationJson({ snapshot: snapshot.localFingerprint, rawIdentities, historyRows, baseline: baseline?.raw ?? null })) }
}
export function readInitialIncomingIdentityDigest(db: Database.Database, ids: readonly string[]): string {
  const rows = db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(ids))
  if (rows.length !== new Set(ids).size) return publicationInvalid('incoming 接受后的 identity 闭集缺失。')
  return publicationHash(publicationJson(rows))
}
