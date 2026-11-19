import type Database from 'better-sqlite3'
import { assertSyncedPersistentPublicationReadAdmissionOwned, type SyncedPublicationLocalSnapshot } from './synced-publication'
import { readRawInitialIncomingWorkspaceOwned, type InitialIncomingIdentity } from './synced-initial-incoming-raw-read'
import { initialIncomingBaselineKey, initialIncomingBaselinePrefix, initialIncomingRequestHash, initialIncomingTombstoneFacts,
  parseInitialIncomingStored, validateInitialIncomingBaseline,
  validateInitialIncomingReceipt, type InitialIncomingBaseline, type InitialIncomingReceipt, type InitialIncomingRequest } from '../sync/synced-initial-incoming-model'
import { publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'
import { SYNC_TABLES } from '../sync/model'

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
export function readInitialIncomingBaseline(db: Database.Database, request: Pick<InitialIncomingRequest, 'databasePath' | 'targetFingerprint'>
  & Partial<Pick<InitialIncomingRequest, 'method' | 'operationId'>>): { value: InitialIncomingBaseline; raw: string } | null {
  const row = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(initialIncomingBaselineKey(request.targetFingerprint)) as { value: unknown; updated_at: unknown } | undefined
  if (!row) return null
  if (typeof row.value !== 'string') return publicationInvalid('incoming 来源 baseline 不是原 JSON。')
  const value = validateInitialIncomingBaseline(json(row.value))
  if (value.databasePath !== request.databasePath || value.targetFingerprint !== request.targetFingerprint || row.updated_at !== value.lastReceivedAt) return publicationInvalid('incoming baseline 目标、路径或接受时间损坏。')
  const original = readInitialIncomingReceipt(db, { method: 'receiveInitialSyncedSnapshot', databasePath: request.databasePath,
    targetFingerprint: request.targetFingerprint, operationId: value.result.operationId })
  if (!original || publicationJson(original.result) !== publicationJson(value.result) || publicationJson(original.provenance) !== publicationJson(value.provenance)) return publicationInvalid('incoming baseline 缺原准确 receipt。')
  return { value, raw: row.value }
}

/** Original accepted absence survives restore even where no live row ever existed. */
export function readInheritedInitialIncomingTombstones(db: Database.Database) {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1)
    return publicationInvalid('接收的删除记录要求封存 SQLite 只读事务。')
  const rows = db.prepare('SELECT key,value FROM app_settings WHERE substr(key,1,?)=? ORDER BY key')
    .all(initialIncomingBaselinePrefix.length, initialIncomingBaselinePrefix) as Array<{ key: string; value: string }>
  return rows.flatMap(row => {
    const value = validateInitialIncomingBaseline(json(row.value))
    if (row.key !== initialIncomingBaselineKey(value.targetFingerprint)) return publicationInvalid('接收的删除记录基线键不匹配。')
    const original = readInitialIncomingBaseline(db, { method: 'receiveInitialSyncedSnapshot',
      databasePath: value.databasePath, targetFingerprint: value.targetFingerprint, operationId: value.result.operationId })
    if (!original) return publicationInvalid('接收的删除记录缺原基线。')
    return initialIncomingTombstoneFacts(original.value)
  })
}

/** Public callers retain the original admission before reading raw facts. */
function captureInitialIncomingWorkspace(db: Database.Database) {
  assertSyncedPersistentPublicationReadAdmissionOwned(db)
  // Saved template blocks are draft-local names. Instantiating a template
  // allocates new physical block IDs. Keep their original rows in the
  // fingerprint without manufacturing identity facts for them.
  return readRawInitialIncomingWorkspaceOwned(db)
}

/** Request-free strict workspace read. No incoming baseline/receipt lookup or write authority. */
export function readInitialIncomingWorkspace(db: Database.Database): InitialIncomingWorkspace {
  if (!db.open || !db.inTransaction) return publicationInvalid('incoming workspace读取要求开放原connection的真实自有事务。')
  const { snapshot, identities, historyDocuments, historyBlocks, groupIds, rawIdentities, historyRows } = captureInitialIncomingWorkspace(db)
  return { snapshot, identities, historyDocuments, historyBlocks, groupIds,
    fingerprint: publicationHash(publicationJson({ snapshot: snapshot.localFingerprint, rawIdentities, historyRows })) }
}

export function isPristineInitialIncomingWorkspace(local: InitialIncomingWorkspace): boolean {
  const [catalog] = local.snapshot.records
  return !local.identities.size && !local.historyDocuments.size && !local.historyBlocks.size && !local.groupIds.size
    && local.snapshot.records.length === 1 && catalog?.kind === 'databases' && catalog.tables.databases.length === 1
    && catalog.tables.databases[0].id === local.snapshot.catalogId && catalog.tables.databases[0].name === 'Default'
    && catalog.tables.databases[0].description === 'Default database'
    && SYNC_TABLES.every(table => table === 'databases' || catalog.tables[table].length === 0)
}

export function canJoinSyncedProtocol5Workspace(db: Database.Database): boolean {
  return db.transaction(() => isPristineInitialIncomingWorkspace(readInitialIncomingWorkspace(db)))()
}

/** Caller owns a strict read/IMMEDIATE. This leaf reads authority; it never repairs, reserves or adopts. */
export function readInitialIncomingLocal(db: Database.Database, request: InitialIncomingRequest): InitialIncomingLocal {
  const facts = captureInitialIncomingWorkspace(db)
  // Preserve the first-receive capability boundary. Draft-local names do not
  // establish a pristine receiver or support any incoming reservation.
  if (facts.unregisteredTemplateBlocks.size) return publicationInvalid('本机历史块缺少原保留 ledger；不会重新回填或抢占。')
  return readIncomingLocal(db, request, facts)
}

/** An already bound exchange reads the same exact template rows and the
 * original baseline without treating template names as ledger entries. */
export function readSyncedExchangeIncomingLocal(db: Database.Database, request: InitialIncomingRequest): InitialIncomingLocal {
  return readIncomingLocal(db, request, captureInitialIncomingWorkspace(db))
}

function readIncomingLocal(db: Database.Database, request: InitialIncomingRequest,
  { snapshot, identities, historyDocuments, historyBlocks, groupIds, rawIdentities, historyRows }: ReturnType<typeof captureInitialIncomingWorkspace>): InitialIncomingLocal {
  const baseline = readInitialIncomingBaseline(db, request)
  return { snapshot, identities, historyDocuments, historyBlocks, groupIds, baseline: baseline?.value ?? null, baselineRaw: baseline?.raw ?? null,
    fingerprint: publicationHash(publicationJson({ snapshot: snapshot.localFingerprint, rawIdentities, historyRows, baseline: baseline?.raw ?? null })) }
}
export function readInitialIncomingIdentityDigest(db: Database.Database, ids: readonly string[]): string {
  const rows = db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(ids))
  if (rows.length !== new Set(ids).size) return publicationInvalid('incoming 接受后的 identity 闭集缺失。')
  return publicationHash(publicationJson(rows))
}
