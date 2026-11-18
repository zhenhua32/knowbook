import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import type { SyncedBindingKey, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { parseDatabaseViewPayload, mapDatabaseViewReferences, serializeDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { parseStrictJson } from '../../shared/strictJson'
import { SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncDatabases } from './model'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson,
  validateInitialManifest5, type InitialPublicationRecord, type SyncedInitialManifest5 } from './synced-publication-model'
import { validateSyncedProtocol5Record, type SyncedProtocol5Record } from './synced-protocol5-model'

export interface SyncedInitialIncomingInput { operationId: string; userDataRoot: string; target: WebDavSyncConfig }
export type SyncedInitialIncomingConflictReason = 'non-initial-target' | 'catalog' | 'occupied-identity' | 'unknown-birth'
  | 'birth-mismatch' | 'owner-transfer' | 'incarnation' | 'history' | 'external-target' | 'path'
export interface SyncedInitialIncomingComponent { keys: string[]; reason: SyncedInitialIncomingConflictReason }
export interface SyncedInitialIncomingAccepted {
  status: 'applied' | 'noop'; operationId: string; replayed: boolean
  workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string
  manifestHash: string; closureHash: string; identityDigest: string; acceptedAt: string
  counts: { documents: number; groups: number; instances: number; physicalBlocks: number; reservations: number; assets: number }
}
export type SyncedInitialIncomingResult = SyncedInitialIncomingAccepted | { status: 'missing' }
  | { status: 'unsupported'; reason: 'schema-27-required' | 'initial-snapshot-only' }
  | { status: 'conflict'; components: SyncedInitialIncomingComponent[] } | { status: 'stale'; side: 'local' | 'remote' }
export interface InitialIncomingRequest { method: 'receiveInitialSyncedSnapshot'; operationId: string; databasePath: string; targetFingerprint: string }
export interface InitialIncomingReservationSource { groupId: string; key: SyncedBindingKey; targetId: string }
export interface InitialIncomingTombstone {
  key: string
  record: Extract<SyncedProtocol5Record, { kind: 'deleted' | 'synced-group-deleted' }>
}
export interface InitialIncomingProvenance {
  manifestEtag: string; portableDigest: string; reservationSourceKey: string; reservedIds: string[]
  reservationSources: InitialIncomingReservationSource[]; reservationDigest: string
  tombstones?: InitialIncomingTombstone[]
}
export interface InitialIncomingReceipt {
  kind: 'synced-initial-incoming-operation'; version: 1; request: InitialIncomingRequest
  result: SyncedInitialIncomingAccepted; provenance: InitialIncomingProvenance
}
export interface InitialIncomingBaseline {
  kind: 'synced-initial-incoming-baseline'; version: 1; databasePath: string; targetFingerprint: string
  manifest: SyncedInitialManifest5; result: SyncedInitialIncomingAccepted; provenance: InitialIncomingProvenance; lastReceivedAt: string
}
const str = (v: unknown): string => typeof v === 'string' ? v : publicationInvalid('incoming 字符串无效。')
const opaque = (v: unknown): string => isSyncedBlockId(v) ? v : publicationInvalid('incoming 稳定身份无效。')
const uuid = (v: unknown): string => isSyncedUuid(v) ? v : publicationInvalid('incoming UUID 无效。')
const digest = (v: unknown): string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : publicationInvalid('incoming digest 无效。')
const time = (v: unknown): string => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : publicationInvalid('incoming 时间无效。')
function integer(v: unknown): number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : publicationInvalid('incoming count/range 无效。') }
function list<T>(v: unknown, read: (raw: unknown) => T): T[] { return Array.isArray(v) ? v.map(read) : publicationInvalid('incoming 数组无效。') }
function sortedUnique(values: string[]): string[] {
  if (new Set(values).size !== values.length || publicationJson(values) !== publicationJson([...values].sort(publicationCompare))) return publicationInvalid('incoming 精确集合没有唯一排序。')
  return values
}
export function initialIncomingTargetFingerprint(target: WebDavSyncConfig): string {
  return publicationHash(publicationJson({ kind: 'webdav-target', version: 1, channel: 'webdav-manifest5-initial-incoming',
    url: target.url, username: target.username, directory: target.directory }))
}
export const initialIncomingRequestHash = (value: InitialIncomingRequest): string => publicationHash(publicationJson(value))
export const initialIncomingBaselinePrefix = 'sync.webdav.protocol5.initial.v1.'
export const initialIncomingBaselineKey = (targetFingerprint: string): string => initialIncomingBaselinePrefix + targetFingerprint
export const initialIncomingReservationKey = (targetFingerprint: string, remoteWorkspaceId: string): string =>
  'sync5:initial-missing-block:v1:' + targetFingerprint + ':' + remoteWorkspaceId
export function initialIncomingPortableDigest(entries: Record<string, string>, syncedInstances: SyncedInitialManifest5['syncedInstances']): string {
  return publicationHash(publicationJson({ entries, syncedInstances }))
}
export function initialIncomingReservationDigest(sourceKey: string, reservedIds: string[], sources: InitialIncomingReservationSource[]): string {
  return publicationHash(publicationJson({ sourceKey, reservedIds, sources }))
}
function request(value: unknown): InitialIncomingRequest {
  assertSyncedShape(value, ['method', 'operationId', 'databasePath', 'targetFingerprint'])
  if (value.method !== 'receiveInitialSyncedSnapshot') return publicationInvalid('incoming method 不匹配。')
  return { method: value.method, operationId: uuid(value.operationId), databasePath: str(value.databasePath), targetFingerprint: digest(value.targetFingerprint) }
}
export function validateInitialIncomingAccepted(value: unknown): SyncedInitialIncomingAccepted {
  assertSyncedShape(value, ['status', 'operationId', 'replayed', 'workspaceScope', 'recoveryEpoch', 'remoteWorkspaceId',
    'manifestHash', 'closureHash', 'identityDigest', 'acceptedAt', 'counts'])
  if (value.status !== 'applied' && value.status !== 'noop' || typeof value.replayed !== 'boolean') return publicationInvalid('incoming ACK 状态无效。')
  assertSyncedShape(value.counts, ['documents', 'groups', 'instances', 'physicalBlocks', 'reservations', 'assets'])
  return { status: value.status, operationId: uuid(value.operationId), replayed: value.replayed,
    workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), remoteWorkspaceId: uuid(value.remoteWorkspaceId),
    manifestHash: digest(value.manifestHash), closureHash: digest(value.closureHash), identityDigest: digest(value.identityDigest), acceptedAt: time(value.acceptedAt),
    counts: { documents: integer(value.counts.documents), groups: integer(value.counts.groups), instances: integer(value.counts.instances),
      physicalBlocks: integer(value.counts.physicalBlocks), reservations: integer(value.counts.reservations), assets: integer(value.counts.assets) } }
}
function provenance(value: unknown, req: InitialIncomingRequest, result: SyncedInitialIncomingAccepted): InitialIncomingProvenance {
  assertSyncedShape(value, ['manifestEtag', 'portableDigest', 'reservationSourceKey', 'reservedIds', 'reservationSources', 'reservationDigest'], ['tombstones'])
  const reservedIds = sortedUnique(list(value.reservedIds, opaque))
  const sources = list<InitialIncomingReservationSource>(value.reservationSources, raw => {
    assertSyncedShape(raw, ['groupId', 'key', 'targetId'])
    assertSyncedShape(raw.key, ['blockId', 'from', 'to', 'raw', 'syntax'])
    const from = integer(raw.key.from), to = integer(raw.key.to), text = str(raw.key.raw)
    if (to < from || text.length !== to - from || raw.key.syntax !== 'markdown' && raw.key.syntax !== 'wiki') return publicationInvalid('incoming reservation 原 Key 无效。')
    return { groupId: uuid(raw.groupId), targetId: opaque(raw.targetId), key: { blockId: opaque(raw.key.blockId), from, to, raw: text, syntax: raw.key.syntax } }
  })
  const sourceKeys = sources.map(item => publicationJson([item.groupId, item.key]))
  sortedUnique(sourceKeys)
  if (publicationJson([...new Set(sources.map(item => item.targetId))].sort(publicationCompare)) !== publicationJson(reservedIds)
    || reservedIds.length !== result.counts.reservations) return publicationInvalid('incoming reservation 闭集与计数不一致。')
  const sourceKey = initialIncomingReservationKey(req.targetFingerprint, result.remoteWorkspaceId)
  if (value.reservationSourceKey !== sourceKey || initialIncomingReservationDigest(sourceKey, reservedIds, sources) !== value.reservationDigest) return publicationInvalid('incoming reservation 来源摘要损坏。')
  const manifestEtag = str(value.manifestEtag)
  if (!manifestEtag || /^W\//i.test(manifestEtag) || !(/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(manifestEtag) || /^[A-Za-z0-9._:+/=-]{1,512}$/.test(manifestEtag))) return publicationInvalid('incoming 原版本证据无效。')
  const tombstones = value.tombstones === undefined ? [] : list<InitialIncomingTombstone>(value.tombstones, item => {
    assertSyncedShape(item, ['key', 'record'])
    const key = str(item.key), record = validateSyncedProtocol5Record(item.record, key)
    if (record.kind !== 'deleted' && record.kind !== 'synced-group-deleted') return publicationInvalid('接收的删除记录含存活正文。')
    return { key, record }
  })
  sortedUnique(tombstones.map(item => item.key))
  return { manifestEtag, portableDigest: digest(value.portableDigest), reservationSourceKey: sourceKey, reservedIds,
    reservationSources: sources, reservationDigest: digest(value.reservationDigest), ...(tombstones.length ? { tombstones } : {}) }
}
export function validateInitialIncomingReceipt(value: unknown): InitialIncomingReceipt {
  assertSyncedShape(value, ['kind', 'version', 'request', 'result', 'provenance'])
  if (value.kind !== 'synced-initial-incoming-operation' || value.version !== 1) return publicationInvalid('不是原 incoming receipt。')
  const req = request(value.request), result = validateInitialIncomingAccepted(value.result)
  if (result.replayed || result.operationId !== req.operationId) return publicationInvalid('incoming 原回执请求不一致。')
  return { kind: value.kind, version: 1, request: req, result, provenance: provenance(value.provenance, req, result) }
}
export function validateInitialIncomingBaseline(value: unknown): InitialIncomingBaseline {
  assertSyncedShape(value, ['kind', 'version', 'databasePath', 'targetFingerprint', 'manifest', 'result', 'provenance', 'lastReceivedAt'])
  if (value.kind !== 'synced-initial-incoming-baseline' || value.version !== 1) return publicationInvalid('不是原 incoming baseline。')
  const result = validateInitialIncomingAccepted(value.result), databasePath = str(value.databasePath), targetFingerprint = digest(value.targetFingerprint)
  const manifest = validateInitialManifest5(value.manifest), received = time(value.lastReceivedAt)
  if (result.replayed || manifest.workspaceId !== result.remoteWorkspaceId || publicationHash(publicationJson(manifest)) !== result.manifestHash
    || received !== result.acceptedAt) return publicationInvalid('incoming baseline 原件/接受时点不一致。')
  const source = provenance(value.provenance, { method: 'receiveInitialSyncedSnapshot', operationId: result.operationId, databasePath, targetFingerprint }, result)
  const deleted = new Set((source.tombstones ?? []).map(item => {
    if (manifest.entries[item.key] !== publicationHash(publicationJson(item.record))) return publicationInvalid('接收基线的删除记录与远端清单不一致。')
    return item.key
  }))
  const keys = Object.keys(manifest.entries).filter(key => !deleted.has(key))
  if (keys.filter(key => key.startsWith('doc:')).length !== result.counts.documents || keys.filter(key => key.startsWith('group:')).length !== result.counts.groups
    || manifest.syncedInstances.length !== result.counts.instances) return publicationInvalid('incoming baseline 记录/实例计数不闭合。')
  if (initialIncomingPortableDigest(manifest.entries, manifest.syncedInstances) !== source.portableDigest) return publicationInvalid('incoming baseline portable 摘要不一致。')
  return { kind: value.kind, version: 1, databasePath, targetFingerprint, manifest, result, provenance: source, lastReceivedAt: received }
}

export function initialIncomingTombstoneFacts(source: Pick<InitialIncomingBaseline, 'result' | 'provenance'> | null) {
  if (!source?.provenance.tombstones) return []
  const { operationId, manifestHash } = source.result
  const proofHash = publicationHash(publicationJson({ result: source.result, provenance: source.provenance }))
  return source.provenance.tombstones.map(({ key, record }) => {
    const tombstoneHash = publicationHash(publicationJson(record))
    const intentHash = publicationHash(publicationJson({ domain: 'synced-initial-incoming-tombstone.v1', operationId, manifestHash, key, tombstoneHash }))
    return { key, record, tombstoneHash, deletionOperationId: operationId, intentHash, proofHash,
      anchorId: 'incoming-tombstone:' + operationId + ':' + intentHash }
  })
}
/** Stored private metadata is not a protocol record; do not invent a snapshot-total 16MiB limit. */
export function parseInitialIncomingStored(source: string): unknown {
  return parseStrictJson(source, { maxBytes: Math.max(1, Buffer.byteLength(source)), maxDepth: 32 })
}
export function incomingComponents(values: SyncedInitialIncomingComponent[]): SyncedInitialIncomingComponent[] {
  const grouped = new Map<SyncedInitialIncomingConflictReason, Set<string>>()
  for (const item of values) { const keys = grouped.get(item.reason) ?? new Set<string>(); item.keys.forEach(key => keys.add(key)); grouped.set(item.reason, keys) }
  return [...grouped].map(([reason, keys]) => ({ reason, keys: [...keys].sort(publicationCompare) }))
    .sort((a, b) => publicationCompare(a.reason, b.reason) || publicationCompare(publicationJson(a.keys), publicationJson(b.keys)))
}
/** Inverse only the typed sentinel. The caller has already rejected authored local-default collisions. */
export function inverseInitialIncomingCatalog(records: InitialPublicationRecord[], catalogId: string, catalogBirth: string): InitialPublicationRecord[] {
  const rewrite = (block: SyncedStableBlockDraft): SyncedStableBlockDraft => block.type !== 'database-view' ? block : {
    ...block, content: serializeDatabaseViewPayload(mapDatabaseViewReferences(parseDatabaseViewPayload(block.content), { databaseId: id => id === 'catalog' ? catalogId : id })) }
  return records.map(record => {
    if (record.kind === 'document') return { ...record, content: { ...record.content, blocks: record.content.blocks.map(rewrite) } }
    if (record.kind === 'synced-group') return { ...record, blocks: record.blocks.map(block => ({ ...rewrite(block), createdAt: block.createdAt })) }
    const tables = {} as SyncDatabases['tables']
    for (const table of SYNC_TABLES) tables[table] = record.tables[table].map(row => {
      const next = { ...row }
      if (table === 'databases' && row.id === 'catalog') { next.id = catalogId; next.created_at = catalogBirth }
      if ('database_id' in next && next.database_id === 'catalog') next.database_id = catalogId
      // Keep the exact closed column order/value set; query/config strings remain authored bytes.
      return Object.fromEntries(SYNC_TABLE_COLUMNS[table].map(column => [column, next[column]]))
    })
    return { ...record, tables }
  })
}
