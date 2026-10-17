import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from './synced-lifecycle-state'
import { hasAnySyncedObservationPending, hasSyncedObservationPending, observationDatabasePath } from './synced-remote-observation-pending'
import { decodeRemoteObservationMarker, observationCorrupt, observationJson, observationKey,
  sameObservedIncarnation, validateObservedIncarnation, SYNCED_OBSERVATION_PREFIX,
  SYNCED_OBSERVATION_CHANNEL, SYNCED_RETIRED_OBSERVATION_CHANNEL,
  type SyncedObservedIncarnation, type SyncedObservationOperationRow, type SyncedRemoteObservationMarker } from './synced-remote-observation-codec'

type Attempt = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string; state: string; created_at: string; confirmed_at: string | null }
type Member = { attempt_id: string; group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }
const parse = (value: string): unknown => parseStrictJson(value, { maxBytes: Math.max(1, Buffer.byteLength(value)), maxDepth: 32 })
export function readObservedLocalIncarnation(db: Database.Database, groupId: string): SyncedObservedIncarnation | undefined {
  const row = db.prepare('SELECT id,creation_id,created_at,origin_json FROM synced_groups WHERE id=?').get(groupId) as { id: unknown; creation_id: unknown; created_at: unknown; origin_json: string } | undefined
  return row ? validateObservedIncarnation({ groupId: row.id, creationId: row.creation_id, createdAt: row.created_at, origin: parse(row.origin_json) }) : undefined
}
function markerRow(db: Database.Database, key: string): SyncedObservationOperationRow | undefined {
  return db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(key) as SyncedObservationOperationRow | undefined
}
function attemptRow(db: Database.Database, id: string): Attempt | undefined {
  return db.prepare('SELECT id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at FROM synced_exposure_attempts WHERE id=?').get(id) as Attempt | undefined
}
function assertPair(db: Database.Database, row: SyncedObservationOperationRow, proof: SyncedRemoteObservationMarker): void {
  const current = readObservedLocalIncarnation(db, proof.incarnation.groupId)
  if (!current || !sameObservedIncarnation(current, proof.incarnation)) return observationCorrupt('marker 失去原 immutable incarnation')
  const lifecycle = readSyncedGroupLifecycles(db, [current.groupId]).get(current.groupId)
  if (!lifecycle || lifecycle.createHistoryId !== proof.local.createHistoryId) return observationCorrupt('原 create 资格/生命周期不符')
  const id = proof.persistence.kind === 'active-confirmed' ? proof.persistence.attemptId : proof.persistence.anchorId
  const attempt = attemptRow(db, id)
  if (!attempt || attempt.request_hash !== row.request_hash || attempt.target_fingerprint !== proof.remote.targetFingerprint
    || attempt.publication_hash !== proof.remote.closureHash || attempt.created_at !== proof.observedAt) return observationCorrupt('首证与不可删锚/attempt 不符')
  const members = db.prepare('SELECT attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash FROM synced_group_exposure_members WHERE attempt_id=?').all(id) as Member[]
  if (proof.local.state === 'active' && proof.persistence.kind === 'active-confirmed') {
    if (!isSyncedUuid(id) || attempt.channel !== SYNCED_OBSERVATION_CHANNEL || attempt.state !== 'confirmed'
      || attempt.confirmed_at !== proof.observedAt || lifecycle.state !== 'active' || lifecycle.exposure !== 'confirmed'
      || members.length !== 1) return observationCorrupt('active observed attempt 不是唯一真实 confirmed 成员')
    const expected: Member = { attempt_id: id, group_id: current.groupId, creation_id: current.creationId,
      revision: proof.local.revision, topology_revision: proof.local.topologyRevision, semantic_hash: proof.local.semanticHash }
    if (observationJson(members[0]) !== observationJson(expected)) return observationCorrupt('active 原本机成员不符')
    return
  }
  if (proof.local.state !== 'retired-create' || proof.persistence.kind !== 'retired-disabled'
    || id !== observationKey(current) || attempt.channel !== SYNCED_RETIRED_OBSERVATION_CHANNEL
    || attempt.state !== 'possible' || attempt.confirmed_at !== null || members.length || lifecycle.state !== 'retired-create'
    || lifecycle.exposure !== 'never') return observationCorrupt('不是精确有限的无成员退休观察锚')
  const group = db.prepare('SELECT revision,topology_revision FROM synced_groups WHERE id=?').get(current.groupId) as { revision: string; topology_revision: string } | undefined
  if (!group || group.revision !== proof.local.revision || group.topology_revision !== proof.local.topologyRevision
    || group.revision !== lifecycle.activationRevision || group.topology_revision !== lifecycle.activationTopologyRevision) return observationCorrupt('retired 原CAS/activation与首证不符')
  const retirement = db.prepare('SELECT create_history_id,wire_json,semantic_hash,retired_at FROM synced_group_retirements WHERE group_id=?').get(current.groupId) as { create_history_id: string; wire_json: string; semantic_hash: string; retired_at: string } | undefined
  if (!retirement || retirement.create_history_id !== proof.local.createHistoryId || retirement.retired_at !== proof.local.retiredAt
    || retirement.semantic_hash !== proof.local.semanticHash || syncedLifecycleSemanticHash(parse(retirement.wire_json)) !== proof.local.retirementHash) return observationCorrupt('原冻结 retirement 与首证不符')
}

/** Exact reads only. A missing marker is not absence if its immutable counterpart remains. */
export function readSyncedRemoteObservation(db: Database.Database, incarnation: SyncedObservedIncarnation): SyncedRemoteObservationMarker | null {
  const tuple = validateObservedIncarnation(incarnation), key = observationKey(tuple), row = markerRow(db, key)
  if (!row) {
    if (attemptRow(db, key) || db.prepare(`SELECT 1 FROM synced_exposure_attempts a JOIN synced_group_exposure_members m ON m.attempt_id=a.id
      WHERE a.channel=? AND m.group_id=? AND m.creation_id=? LIMIT 1`).get(SYNCED_OBSERVATION_CHANNEL, tuple.groupId, tuple.creationId)) return observationCorrupt('不可删证据仍在但 marker 缺失')
    return null
  }
  const proof = decodeRemoteObservationMarker(row)
  if (!sameObservedIncarnation(proof.incarnation, tuple)) return observationCorrupt('同稳定 key 的 birth/Origin 被替换')
  assertPair(db, row, proof); return proof
}

/** Runtime finite format, never DDL/repair. Ordinary empty publication attempts remain invalid. */
export function assertSyncedRemoteObservationRecords(db: Database.Database): void {
  const checked = new Set<string>()
  const checkKey = (key: string): void => {
    if (checked.has(key)) return
    const row = markerRow(db, key)
    if (!row) return observationCorrupt('锚/member 对应 marker 缺失')
    const proof = decodeRemoteObservationMarker(row)
    assertPair(db, row, proof); checked.add(key)
  }
  const checkRetiredAnchor = (id: string): void => {
    checkKey(id)
    const row = markerRow(db, id)
    if (!row) return observationCorrupt('已核退休观察 marker 在同次读取中缺失')
    const proof = decodeRemoteObservationMarker(row)
    if (proof.persistence.kind !== 'retired-disabled' || proof.persistence.anchorId !== id
      || proof.local.state !== 'retired-create') return observationCorrupt('退休观察锚未被原退休首证准确引用')
  }
  for (const row of db.prepare(`SELECT a.id,a.channel FROM synced_exposure_attempts a WHERE NOT EXISTS(
    SELECT 1 FROM synced_group_exposure_members m WHERE m.attempt_id=a.id)`).iterate() as Iterable<{ id: string; channel: string }>) {
    if (row.channel !== SYNCED_RETIRED_OBSERVATION_CHANNEL || !row.id.startsWith(SYNCED_OBSERVATION_PREFIX)) {
      throw new Error('同步块 schema27 存在没有准确参与组的发布记录；不会丢弃可能曝光证据。')
    }
    checkRetiredAnchor(row.id)
  }
  for (const row of db.prepare('SELECT id FROM synced_exposure_attempts WHERE channel=?').iterate(SYNCED_RETIRED_OBSERVATION_CHANNEL) as Iterable<{ id: string }>) checkRetiredAnchor(row.id)
  for (const row of db.prepare(`SELECT a.id,m.group_id,m.creation_id FROM synced_exposure_attempts a LEFT JOIN synced_group_exposure_members m ON m.attempt_id=a.id WHERE a.channel=?`).iterate(SYNCED_OBSERVATION_CHANNEL) as Iterable<{ id: string; group_id: string | null; creation_id: string | null }>) {
    if (!isSyncedUuid(row.id) || !isSyncedUuid(row.group_id) || !isSyncedUuid(row.creation_id)) return observationCorrupt('active observed attempt 失去原准确成员')
    const key = observationKey({ groupId: row.group_id, creationId: row.creation_id })
    checkKey(key)
    const rowMarker = markerRow(db, key)
    if (!rowMarker) return observationCorrupt('已核 observed marker 在同次读取中缺失')
    const marker = decodeRemoteObservationMarker(rowMarker)
    if (marker.persistence.kind !== 'active-confirmed' || marker.persistence.attemptId !== row.id) return observationCorrupt('另一个 attempt 借用首证')
  }
  // The stable primary-key range checks orphan markers without parsing ordinary ACKs.
  const end = SYNCED_OBSERVATION_PREFIX.slice(0, -1) + ';'
  for (const row of db.prepare('SELECT client_operation_id FROM synced_operations WHERE client_operation_id>=? AND client_operation_id<?').iterate(SYNCED_OBSERVATION_PREFIX, end) as Iterable<{ client_operation_id: string }>) checkKey(row.client_operation_id)
}

export function hasSyncedRemoteObservationForCreate(db: Database.Database, incarnation: SyncedObservedIncarnation): boolean {
  const tuple = validateObservedIncarnation(incarnation)
  if (readSyncedRemoteObservation(db, tuple) !== null) return true
  // Disk observers cannot mint pending authority for :memory:; preserve old Main-only inverses.
  if (db.memory || !hasAnySyncedObservationPending()) return false
  // Pending is keyed by real path and immutable identity, not by one connection/epoch.
  const pending = hasSyncedObservationPending(observationDatabasePath(db.name), tuple)
  return pending
}
