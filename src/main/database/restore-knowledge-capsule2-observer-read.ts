import type Database from 'better-sqlite3'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { LOGICAL_DELETION_CHANNEL } from '../sync/synced-logical-deletion-model'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { RECOVERY_BOUNDARY_CHANNEL, recoveryEpochMarkerId } from './synced-recovery-boundary-model'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from './synced-lifecycle-state'
import { decodeRemoteObservationMarker, observationCorrupt, observationJson, observationKey,
  sameObservedIncarnation, validateObservedIncarnation, SYNCED_OBSERVATION_PREFIX,
  SYNCED_OBSERVATION_CHANNEL, SYNCED_RETIRED_OBSERVATION_CHANNEL,
  type SyncedObservedIncarnation, type SyncedObservationOperationRow, type SyncedRemoteObservationMarker } from './synced-remote-observation-codec'

type Attempt = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string; state: string; created_at: string; confirmed_at: string | null }
type Member = { attempt_id: string; group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }
const parse = (value: string): unknown => parseStrictJson(value, { maxBytes: Math.max(1, Buffer.byteLength(value)), maxDepth: 32 })
function readObservedLocalIncarnation(db: Database.Database, groupId: string): SyncedObservedIncarnation | undefined {
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


import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readRawCapsule2ContentOwned } from './restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2PhysicalGraphOwned } from './restore-knowledge-capsule2-physical-raw-read'
import { readRawCapsule2CoverageSupportsOwned } from './restore-knowledge-capsule2-coverage-raw-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES, type Capsule2RawCoverageSupports } from './restore-knowledge-capsule2-raw-model'
import { coverageAnchorExpectation, parseSyncedKnowledgeCoverage, parseSyncedKnowledgeCoverageLink,
  parseKnowledgeRestoreReceipt, validateCoverageStructureTuple, type RawCoverageRequirement } from './restore-knowledge-coverage-model'
import { historicalHash, historicalTime, historicalOperationLocator, readHistoricalRowLocator,
  readHistoricalOperations, readHistoricalMetadata, readHistoricalExactRows } from './synced-history-evidence-support'

const attemptColumns = ['id', 'request_hash', 'channel', 'target_fingerprint', 'publication_hash', 'state', 'created_at', 'confirmed_at'] as const
const memberColumns = ['attempt_id', 'group_id', 'creation_id', 'revision', 'topology_revision', 'semantic_hash'] as const
export interface RawCapsule2ObserverObservation {
  readonly kind: 'capsule2-observer-format-pairs'; readonly version: 2
  readonly state: 'bounded-owned-sql-format-observation-only'; readonly certified: false; readonly acceptedCoverage: false
  readonly effective: false; readonly permit: false; readonly semanticValidationComplete: false
  readonly schemaVersion: 26 | 27; readonly rawContentHash: string
  readonly physical: { readonly documents: number; readonly groups: number; readonly instances: number; readonly identities: number }
  readonly coverage: Capsule2RawCoverageSupports
  readonly attempts: number; readonly members: number; readonly remoteMarkers: number; readonly ordinaryAttempts: number
  readonly logicalDenials: number; readonly recoveryBoundaries: number; readonly pairedCoverageAnchors: number
}
/** Actual read-only owned transaction only. No caller roots/IDs/DTO/mode, no
 * pending fallback, no source/accepted identity. Dependencies perform early
 * FK/integrity reads; this does NOT implement metadata-before-FK scheduling. */
export function readRawCapsule2ObserverOwned(db: Database.Database): RawCapsule2ObserverObservation {
  if (!db.open || !db.readonly || !db.inTransaction || db.pragma('query_only', { simple: true }) !== 1
    || db.pragma('foreign_keys', { simple: true }) !== 1) return observationCorrupt('observer2要求readonly/query-only/FKON真实owned事务')
  // content preflights fixed full source before subsequent driver materialization.
  // Its integrity/FK and lifecycle-metadata internal checks occur first.
  const content = readRawCapsule2ContentOwned(db), coverage = readRawCapsule2CoverageSupportsOwned(db)
  const physical = readRawCapsule2PhysicalGraphOwned(db), schema = content.schemaVersion
  const rawContentHash = observationHashForContent(content)
  const physicalCounts = { documents: physical.documents.length, groups: physical.groups.length,
    instances: physical.instances.length, identities: physical.identities.length }
  const finish = (counts: { attempts: number; members: number; remoteMarkers: number; ordinaryAttempts: number;
    logicalDenials: number; recoveryBoundaries: number; pairedCoverageAnchors: number }): RawCapsule2ObserverObservation => {
    const value: RawCapsule2ObserverObservation = { kind: 'capsule2-observer-format-pairs', version: 2,
      state: 'bounded-owned-sql-format-observation-only', certified: false, acceptedCoverage: false, effective: false, permit: false,
      semanticValidationComplete: false, schemaVersion: schema, rawContentHash, physical: physicalCounts, coverage, ...counts }
    if (Buffer.byteLength(capsuleJson(value)) > CAPSULE2_RAW_MAX_JSON_BYTES) return observationCorrupt('observer2完整JSON超准备预算，不截断')
    return freezeCapsuleValue(value)
  }
  if (schema === 26) {
    for (const row of readHistoricalOperations(db)) if (/^synced:/i.test(row.client_operation_id))
      return observationCorrupt('observer2 schema26不得含27或未知reserved marker')
    return finish({ attempts: 0, members: 0, remoteMarkers: 0, ordinaryAttempts: 0,
      logicalDenials: 0, recoveryBoundaries: 0, pairedCoverageAnchors: 0 })
  }
  const allOperations = readHistoricalOperations(db), allMetadata = readHistoricalMetadata(db)
  const operationMap = new Map(allOperations.map(row => [row.client_operation_id, row]))
  const metadataMap = new Map(allMetadata.map(row => [row.key, row]))
  // Private dispatch derives only from the fixed actual SQL read above. Each
  // entry is re-parsed as the exact original tuple and every mandatory locator
  // is reread. No exported function accepts this routing map as attestation.
  const dispatch = new Map<string, { entry: RawCoverageRequirement; expected: ReturnType<typeof coverageAnchorExpectation> }>()
  for (const entry of coverage.requirements.entries) {
    const c = metadataMap.get(String(entry.supports.coverage.key[0])), l = operationMap.get(String(entry.supports.link.key[0]))
    const r = metadataMap.get(String(entry.supports.receipt.key[0]))
    if (!c || !l || !r) return observationCorrupt('observer2同次实际C/link/Receipt2缺失')
    const tuple = validateCoverageStructureTuple({ coverage: parseSyncedKnowledgeCoverage(c.value),
      link: parseSyncedKnowledgeCoverageLink(l.result_json), receipt: parseKnowledgeRestoreReceipt(r.value) })
    if (tuple.coverage.operationId !== entry.operationId) return observationCorrupt('observer2实际tuple原operation不一致')
    for (const reference of Object.values(entry.supports)) if (reference
      && capsuleJson(readHistoricalRowLocator(db, reference.table, reference.key)) !== capsuleJson(reference))
      return observationCorrupt('observer2完整mandatory locator/hash变化')
    const expected = coverageAnchorExpectation(tuple.link)
    if (dispatch.has(expected.id)) return observationCorrupt('observer2重复coverage实际locator')
    dispatch.set(expected.id, { entry, expected })
  }
  const consumedCoverage = new Set<string>(), consumedLinks = new Set<string>()
  const checkCoverageAnchor = (row: Attempt): void => {
    const match = dispatch.get(row.id)
    if (!match || attemptColumns.some(column => row[column] !== match.expected[column])
      || capsuleJson(readHistoricalRowLocator(db, 'synced_exposure_attempts', [row.id])) !== capsuleJson(match.entry.supports.anchor)
      || db.prepare('SELECT 1 FROM synced_group_exposure_members WHERE attempt_id=? LIMIT 1').get(row.id))
      return observationCorrupt('observer2 coverage完整八列/locator/hash/零member不闭合')
    consumedCoverage.add(row.id)
  }
  const logical = assertSyncedLogicalDeletionRecords(db), logicalAnchors = new Set([...logical.values()].map(proof => proof.persistence.anchorId))
  const recovery = assertSyncedRecoveryBoundaryRecords(db)
  const recoveryAnchors = new Set([...recovery.boundaries.keys()].map(recoveryEpochMarkerId))
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
    SELECT 1 FROM synced_group_exposure_members m WHERE m.attempt_id=a.id)`).all() as Array<{ id: string; channel: string }>) {
    if (dispatch.has(row.id)) { const actual = attemptRow(db, row.id); if (!actual) return observationCorrupt('coverage实际attempt缺失'); checkCoverageAnchor(actual); continue }
    if (row.channel === LOGICAL_DELETION_CHANNEL && logicalAnchors.has(row.id)) continue
    if (row.channel === RECOVERY_BOUNDARY_CHANNEL && recoveryAnchors.has(row.id)) continue
    if (row.channel !== SYNCED_RETIRED_OBSERVATION_CHANNEL || !row.id.startsWith(SYNCED_OBSERVATION_PREFIX)) {
      throw new Error('同步块 schema27 存在没有准确参与组的发布记录；不会丢弃可能曝光证据。')
    }
    checkRetiredAnchor(row.id)
  }
  for (const row of db.prepare('SELECT id FROM synced_exposure_attempts WHERE channel=?').all(SYNCED_RETIRED_OBSERVATION_CHANNEL) as Array<{ id: string }>) checkRetiredAnchor(row.id)
  for (const row of db.prepare(`SELECT a.id,m.group_id,m.creation_id FROM synced_exposure_attempts a LEFT JOIN synced_group_exposure_members m ON m.attempt_id=a.id WHERE a.channel=?`).all(SYNCED_OBSERVATION_CHANNEL) as Array<{ id: string; group_id: string | null; creation_id: string | null }>) {
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
  for (const row of db.prepare('SELECT client_operation_id FROM synced_operations WHERE client_operation_id>=? AND client_operation_id<?').all(SYNCED_OBSERVATION_PREFIX, end) as Array<{ client_operation_id: string }>) checkKey(row.client_operation_id)

  // Full reserved marker scan catches unknown versions/case variants even
  // outside the legacy v1 stable range. Ordinary UUID ACKs remain for total2.
  for (const row of allOperations) if (/^synced:/i.test(row.client_operation_id)) {
    if (dispatch.has(row.client_operation_id)) {
      const reference = dispatch.get(row.client_operation_id)!.entry.supports.link
      if (capsuleJson(historicalOperationLocator(row)) !== capsuleJson(reference)) return observationCorrupt('coverage link完整原行hash不一致')
      consumedLinks.add(row.client_operation_id)
    } else if (row.client_operation_id.startsWith(SYNCED_OBSERVATION_PREFIX)) checkKey(row.client_operation_id)
    else if (row.client_operation_id.startsWith('synced:logical-deletion:v1:') && logicalAnchors.has(row.client_operation_id)) { /* strict original proof reader paired it */ }
    else if (row.client_operation_id.startsWith('synced:recovery-epoch:v1:') && recoveryAnchors.has(row.client_operation_id)) { /* strict original B/R reader paired it */ }
    else return observationCorrupt('observer2未知reserved marker family/version/case，不降missing')
  }
  const attempts = readHistoricalExactRows<Attempt>(db, 'synced_exposure_attempts', attemptColumns)
  const members = readHistoricalExactRows<Member>(db, 'synced_group_exposure_members', memberColumns)
  const byAttempt = new Map<string, Member[]>(), ids = new Set(attempts.map(row => row.id))
  for (const member of members) {
    if (!ids.has(member.attempt_id)) return observationCorrupt('observer2孤member无实际attempt')
    const values = byAttempt.get(member.attempt_id) ?? []; values.push(member); byAttempt.set(member.attempt_id, values)
  }
  const groupIds = (db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
  const life = readSyncedGroupLifecycles(db, groupIds)
  const special = new Set<string>([SYNCED_OBSERVATION_CHANNEL, SYNCED_RETIRED_OBSERVATION_CHANNEL, LOGICAL_DELETION_CHANNEL, RECOVERY_BOUNDARY_CHANNEL])
  let ordinaryAttempts = 0
  for (const row of attempts) {
    if (dispatch.has(row.id)) { checkCoverageAnchor(row); continue }
    if (special.has(row.channel)) continue // Each original reserved domain was paired, including reverse scans, above.
    const actual = byAttempt.get(row.id) ?? []
    if (!actual.length || !isSyncedUuid(row.id) || !historicalHash(row.request_hash) || !historicalHash(row.target_fingerprint)
      || !historicalHash(row.publication_hash) || typeof row.channel !== 'string' || !row.channel.trim() || !historicalTime(row.created_at)
      || row.state !== 'possible' && row.state !== 'confirmed'
      || (row.state === 'possible' ? row.confirmed_at !== null : !historicalTime(row.confirmed_at))) return observationCorrupt('observer2 ordinary曝光原行/member/状态损坏')
    for (const member of actual) if (!life.has(member.group_id) || life.get(member.group_id)!.creationId !== member.creation_id
      || !isSyncedUuid(member.revision) || !isSyncedUuid(member.topology_revision) || !historicalHash(member.semantic_hash))
      return observationCorrupt('observer2 ordinary成员原incarnation损坏')
    ordinaryAttempts++ // channel is open TEXT, including a new C-looking name.
  }
  if (consumedCoverage.size !== dispatch.size || consumedLinks.size !== dispatch.size) return observationCorrupt('observer2实际coverage ledger未全部消费')
  return finish({ attempts: attempts.length, members: members.length, remoteMarkers: checked.size, ordinaryAttempts,
    logicalDenials: logical.size, recoveryBoundaries: recovery.boundaries.size, pairedCoverageAnchors: consumedCoverage.size })
}

const observationHashForContent = (value: unknown): string => capsuleBytesHash('knowbook.capsule2.observer-content.v1\0' + capsuleJson(value))
