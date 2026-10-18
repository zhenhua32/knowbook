import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedUuid, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { readInitialIncomingLocal, type InitialIncomingIdentity } from './synced-initial-incoming-read'
import { assertSyncedExchangeHostCutRecords } from './synced-exchange-host-cut'
import type { SyncedPublicationLocalSnapshot } from './synced-publication'
import type { InitialIncomingBaseline } from '../sync/synced-initial-incoming-model'
import { exchangeRequestHash, exchangeStateKey, parseExchangeStored, validateExchangeReceipt, validateExchangeState,
  type ExchangeRequest, type ExchangeReceipt, type ExchangeState } from '../sync/synced-exchange-model'
import { publicationHash, publicationInvalid, publicationJson, SyncedPublicationError } from '../sync/synced-publication-model'

export interface SyncedExchangeLocal {
  snapshot: SyncedPublicationLocalSnapshot; fingerprint: string
  identities: InitialIncomingIdentity[]; occupiedDocumentIds: string[]; historyComponents: string[][]; pinnedGroupIds: string[]
  state: ExchangeState | null; stateRaw: string | null; initialBaseline: InitialIncomingBaseline | null
  keyGuards: Record<string, string>; knownGroupIds: string[]
}
function owned(db: Database.Database): void {
  if (!db.inTransaction) return publicationInvalid('exchange readonly authority requires an owned transaction。')
  if (!db.open || db.readonly) throw new SyncedPublicationError('unavailable', 'exchange原 writable connection 已失效。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('exchange FK protection失效。')
}
export function readSyncedExchangeReceipt(db: Database.Database, request: ExchangeRequest): ExchangeReceipt | null {
  owned(db)
  const row = db.prepare('SELECT request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(request.operationId) as { request_hash: string; result_json: string; created_at: string } | undefined
  if (!row) return null
  const receipt = validateExchangeReceipt(parseExchangeStored(row.result_json))
  if (receipt.result.replayed || row.request_hash !== exchangeRequestHash(request)
    || publicationJson(receipt.request) !== publicationJson(request) || receipt.result.acceptedAt !== row.created_at)
    return publicationInvalid('exchange原operation/method/request/receipt损坏或idempotency不匹配。')
  return receipt
}
export function readSyncedExchangeState(db: Database.Database, request: ExchangeRequest,
  context: { workspaceScope: string; recoveryEpoch: string }): { value: ExchangeState; raw: string } | null {
  owned(db)
  const row = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(exchangeStateKey(request.targetFingerprint)) as
    { value: string; updated_at: string } | undefined
  if (!row) return null
  const value = validateExchangeState(parseExchangeStored(row.value))
  if (value.databasePath !== request.databasePath || value.targetFingerprint !== request.targetFingerprint || row.updated_at !== value.lastSyncAt)
    return publicationInvalid('exchange state准确路径/target/接受时点损坏。')
  if (value.workspaceScope !== context.workspaceScope || value.recoveryEpoch !== context.recoveryEpoch)
    throw new SyncedPublicationError('unavailable', '历史exchange state属于另一workspace/recovery世代；不借旧state授新写权。')
  if (!isSyncedUuid(value.currentOperationId)) return publicationInvalid('durable exchange state缺准确最终operation。')
  const current = readSyncedExchangeReceipt(db, { ...request, operationId: value.currentOperationId })
  if (!current || current.provenance.afterStateHash !== publicationHash(publicationJson(value)) || current.result.acceptedAt !== value.lastSyncAt
    || current.result.workspaceScope !== value.workspaceScope || current.result.recoveryEpoch !== value.recoveryEpoch
    || current.result.remoteWorkspaceId !== value.remoteWorkspaceId || publicationJson(current.provenance.source) !== publicationJson(value.source))
    return publicationInvalid('exchange完整state缺原结算receipt准确认证；不能删baseline row再猜新来源。')
  for (const entry of value.baseline) {
    // The initial source proof is authenticated separately from its original receipt/spool.
    if (entry.acceptedOperationId === value.source.operationId) continue
    const original = readSyncedExchangeReceipt(db, { ...request, operationId: entry.acceptedOperationId })
    const accepted = original?.provenance.accepted.find(side => side.key === entry.key)
    if (!original || !accepted || original.result.workspaceScope !== value.workspaceScope || original.result.recoveryEpoch !== value.recoveryEpoch
      || original.result.remoteWorkspaceId !== value.remoteWorkspaceId || accepted.afterHash !== entry.remoteHash || entry.localHash !== accepted.afterHash || entry.commonHash !== accepted.afterHash
      || entry.dependencySignature !== accepted.dependencySignature
      || publicationJson(entry.dependencyKeys) !== publicationJson(accepted.dependencyKeys)
      || publicationJson(value.source) !== publicationJson(original.provenance.source)) return publicationInvalid('exchange baseline缺少其准确结算receipt。')
  }
  return { value, raw: row.value }
}
/** Complete old authority remains strict; this function never repairs, transfers, or mints write permission. */
export function readSyncedExchangeLocal(db: Database.Database,
  input: { request: ExchangeRequest; initialTargetFingerprint: string }): SyncedExchangeLocal {
  owned(db)
  const legacy = readInitialIncomingLocal(db, { method: 'receiveInitialSyncedSnapshot', operationId: input.request.operationId,
    databasePath: input.request.databasePath, targetFingerprint: input.initialTargetFingerprint })
  const state = readSyncedExchangeState(db, input.request, legacy.snapshot)
  const hostCuts = assertSyncedExchangeHostCutRecords(db)
  const rows = db.prepare('SELECT history_id,document_id FROM synced_host_history_documents ORDER BY history_id,document_id')
    .all() as Array<{ history_id: string; document_id: string }>
  const histories = new Map<string, string[]>()
  for (const row of rows) { const members = histories.get(row.history_id) ?? []; members.push(row.document_id); histories.set(row.history_id, members) }
  const historyComponents = [...histories.values()].filter(ids => ids.length > 1).map(ids => ids.map(id => 'doc:' + id))
  const pinned = new Set((db.prepare('SELECT DISTINCT group_id FROM synced_group_pins ORDER BY group_id').all() as Array<{ group_id: string }>).map(row => row.group_id))
  const archives = db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-history-index.v1.%' ORDER BY key").all() as
    Array<{ key: string; value: string; updated_at: string }>
  const referencedRows = new Set<string>()
  const archiveReceipts = new Map<string, ExchangeReceipt>()
  const operationRows = db.prepare("SELECT client_operation_id,result_json FROM synced_operations WHERE json_extract(result_json,'$.kind')='synced-exchange-operation'").all() as Array<{ client_operation_id: string; result_json: string }>
  for (const row of operationRows) {
    const raw = validateExchangeReceipt(parseExchangeStored(row.result_json)), receipt = readSyncedExchangeReceipt(db, raw.request)
    if (!receipt || row.client_operation_id !== receipt.request.operationId) return publicationInvalid('exchange archive原operation行/准确request不闭合。')
    archiveReceipts.set(row.client_operation_id, receipt)
  }
  for (const row of archives) {
    const archive = parseExchangeStored(row.value)
    assertSyncedShape(archive, ['kind', 'version', 'operationId', 'groupId', 'rows', 'archivedAt'])
    if (archive.kind !== 'synced-exchange-history-index' || archive.version !== 1 || !isSyncedUuid(archive.operationId)
      || !isSyncedUuid(archive.groupId) || !Array.isArray(archive.rows) || archive.archivedAt !== row.updated_at
      || row.key !== 'sync.webdav.protocol5.exchange-history-index.v1.' + archive.operationId + '.' + archive.groupId)
      return publicationInvalid('exchange冻结history archive原件损坏。')
    const actualGroup = db.prepare('SELECT creation_id,created_at,origin_json FROM synced_groups WHERE id=?').get(archive.groupId) as
      { creation_id: string; created_at: string; origin_json: string } | undefined
    if (!actualGroup || !isSyncedUuid(archive.operationId) || typeof archive.archivedAt !== 'string' || !Number.isFinite(Date.parse(archive.archivedAt)))
      return publicationInvalid('exchange archive原group/接受时点缺失。')
    const original = archiveReceipts.get(archive.operationId)
    if (!original || original.result.operationId !== archive.operationId || !original.result.appliedKeys.includes('group:' + archive.groupId)
      || !original.provenance.historyArchives.some(item => item.groupId === archive.groupId && item.indexHash === publicationHash(row.value)))
      return publicationInvalid('exchange archive缺准确原replacement receipt。')
    const ids = new Set<string>()
    const keys: string[] = []
    for (const [index, entry] of archive.rows.entries()) {
      assertSyncedShape(entry, ['id', 'hash'])
      if (!isSyncedUuid(entry.id) || typeof entry.hash !== 'string') return publicationInvalid('exchange archive index损坏。')
      const key = 'sync.webdav.protocol5.exchange-history-row.v1.' + archive.operationId + '.' + archive.groupId + '.' + entry.id
      keys.push(key)
      referencedRows.add(key)
      const source = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(key) as { value: string; updated_at: string } | undefined
      if (!source || source.updated_at !== archive.archivedAt || publicationHash(source.value) !== entry.hash) return publicationInvalid('exchange archive row原件缺失/被改。')
      const envelope = parseExchangeStored(source.value)
      assertSyncedShape(envelope, ['kind', 'version', 'operationId', 'groupId', 'row', 'archivedAt'])
      if (envelope.kind !== 'synced-exchange-history-row' || envelope.version !== 1 || envelope.operationId !== archive.operationId
        || envelope.groupId !== archive.groupId || envelope.archivedAt !== archive.archivedAt) return publicationInvalid('exchange archive row envelope损坏。')
      const raw = envelope.row
      assertSyncedShape(raw, ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'])
      if (!isSyncedUuid(raw.id) || raw.id !== entry.id || ids.has(raw.id) || raw.group_id !== archive.groupId || raw.position !== index + 1
        || typeof raw.created_at !== 'string' || !Number.isFinite(Date.parse(raw.created_at))) return publicationInvalid('exchange原history archive row损坏。')
      ids.add(raw.id)
      for (const [body, hash] of [[raw.before_json, raw.before_hash], [raw.after_json, raw.after_hash]]) {
        if (typeof body !== 'string') return publicationInvalid('exchange archived side不是原JSON。')
        const wire = validateSyncedGroupWire(parseExchangeStored(body))
        if (wire.id !== archive.groupId || wire.creationId !== actualGroup.creation_id || wire.createdAt !== actualGroup.created_at
          || publicationJson(wire.origin) !== publicationJson(parseExchangeStored(actualGroup.origin_json))
          || publicationHash(publicationJson(wire)) !== hash) return publicationInvalid('exchange archived side/hash/immutable tuple损坏。')
      }
    }
    const actualKeys = (db.prepare('SELECT key FROM app_settings WHERE substr(key,1,?)=? ORDER BY key').all(
      ('sync.webdav.protocol5.exchange-history-row.v1.' + archive.operationId + '.' + archive.groupId + '.').length,
      'sync.webdav.protocol5.exchange-history-row.v1.' + archive.operationId + '.' + archive.groupId + '.') as Array<{ key: string }>).map(item => item.key)
    if (publicationJson(actualKeys) !== publicationJson(keys.sort())) return publicationInvalid('exchange archive row闭集不符。')
    pinned.add(archive.groupId)
  }
  // Bidirectional closure: deleting a whole index+row set must not silently erase its historical denial/pin evidence.
  const archiveIndexes = new Map(archives.map(row => [row.key, row]))
  for (const original of archiveReceipts.values()) for (const proof of original.provenance.historyArchives) {
    const key = 'sync.webdav.protocol5.exchange-history-index.v1.' + original.request.operationId + '.' + proof.groupId, index = archiveIndexes.get(key)
    if (!index || publicationHash(index.value) !== proof.indexHash || !original.result.appliedKeys.includes('group:' + proof.groupId)) return publicationInvalid('exchange原receipt所认证的history index缺失/被改。')
  }
  const allArchiveRows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange-history-row.v1.%'").all() as Array<{ key: string }>
  if (allArchiveRows.length !== referencedRows.size || allArchiveRows.some(row => !referencedRows.has(row.key))) return publicationInvalid('exchange存在无准确receipt/index认证的孤history row。')
  // Exposure/attempt rows are monotone facts, not local content guards. Our own observation/claim must not invalidate this capture.
  const guardedTables = ['document_history', 'document_trash', 'document_block_moves', 'backup_restore_identities', 'document_block_routes',
    'synced_host_history', 'synced_host_history_documents', 'synced_host_history_state', 'synced_group_history', 'synced_group_pins']
  const history = guardedTables.map(table => ({ table, rows: db.prepare('SELECT * FROM ' + table).all().sort((a, b) => publicationJson(a).localeCompare(publicationJson(b))) }))
  const physicalRows = db.prepare('SELECT * FROM documents ORDER BY id').all() as Array<Record<string, unknown>>
  const groupRows = db.prepare('SELECT * FROM synced_groups ORDER BY id').all() as Array<Record<string, unknown>>
  const instances = db.prepare('SELECT * FROM synced_instances ORDER BY instance_id').all() as Array<Record<string, unknown>>
  const parts = new Map<string, string[]>(), owners = new Map<string, InitialIncomingIdentity[]>(), mapped = new Map<string, string[]>()
  const add = (key: string, digest: string) => { const list = parts.get(key) ?? []; list.push(digest); parts.set(key, list) }
  for (const cut of hostCuts.values()) { const digest = publicationHash(publicationJson(cut))
    for (const participant of cut.participants) add('doc:' + participant.documentId, digest) }
  for (const row of rows) { const list = mapped.get(row.history_id) ?? []; list.push('doc:' + row.document_id); mapped.set(row.history_id, list) }
  for (const identity of legacy.identities.values()) {
    if (identity.last_owner_kind === 'reserved') continue
    const key = (identity.last_owner_kind === 'group' ? 'group:' : 'doc:') + identity.last_owner_id, list = owners.get(key) ?? []
    list.push(identity); owners.set(key, list)
  }
  for (const item of history) for (const raw of item.rows) {
    const value = raw as Record<string, unknown>, keys = new Set<string>(), digest = publicationHash(publicationJson([item.table, raw]))
    for (const name of ['document_id', 'source_document_id', 'target_document_id']) if (typeof value[name] === 'string') keys.add('doc:' + value[name])
    if (typeof value.group_id === 'string') keys.add('group:' + value.group_id)
    const historyId = item.table === 'synced_host_history' ? value.id : value.history_id
    if (typeof historyId === 'string') for (const key of mapped.get(historyId) ?? []) keys.add(key)
    if (typeof value.block_id === 'string') { const identity = legacy.identities.get(value.block_id)
      if (identity && identity.last_owner_kind !== 'reserved') keys.add((identity.last_owner_kind === 'group' ? 'group:' : 'doc:') + identity.last_owner_id) }
    for (const key of keys) add(key, digest)
  }
  for (const row of physicalRows) if (typeof row.id === 'string') add('doc:' + row.id, publicationHash(publicationJson(row)))
  for (const row of groupRows) if (typeof row.id === 'string') add('group:' + row.id, publicationHash(publicationJson(row)))
  for (const row of instances) { const digest = publicationHash(publicationJson(row))
    if (typeof row.group_id === 'string') add('group:' + row.group_id, digest)
    if (typeof row.host_document_id === 'string') add('doc:' + row.host_document_id, digest) }
  const groups = new Map(legacy.snapshot.groups.map(group => [group.wire.id, group]))
  const keyGuards: Record<string, string> = Object.create(null) as Record<string, string>
  for (const record of legacy.snapshot.records) {
    const key = record.kind === 'databases' ? 'databases' : record.kind === 'document' ? 'doc:' + record.id : 'group:' + record.id
    keyGuards[key] = publicationHash(publicationJson({ record, owners: owners.get(key) ?? [], guards: (parts.get(key) ?? []).sort(), group: groups.get(record.id) ?? null }))
  }
  return { snapshot: legacy.snapshot, identities: [...legacy.identities.values()], occupiedDocumentIds: [...legacy.historyDocuments].sort(),
    historyComponents, pinnedGroupIds: [...pinned].sort(), initialBaseline: legacy.baseline,
    state: state?.value ?? null, stateRaw: state?.raw ?? null,
    knownGroupIds: [...legacy.groupIds].sort(), keyGuards,
    fingerprint: publicationHash(publicationJson({ snapshot: legacy.snapshot.localFingerprint, keyGuards, identities: [...legacy.identities.values()], history, state: state?.raw ?? null, archives,
      hostCuts: [...hostCuts.values()].sort((a, b) => a.historyToken < b.historyToken ? -1 : a.historyToken > b.historyToken ? 1 : 0) })) }
}
