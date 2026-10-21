import type Database from 'better-sqlite3'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { parseExchangeStored, exchangeJobKey, exchangeJobPhaseKey } from '../sync/synced-exchange-model'
import { initialIncomingRequestHash, validateInitialIncomingReceipt } from '../sync/synced-initial-incoming-model'
import { publicationCompare, publicationHash, publicationJson } from '../sync/synced-publication-model'
import { LOGICAL_DELETION_CHANNEL } from '../sync/synced-logical-deletion-model'
import { decodeSyncedOperationAck } from './synced-host-operation-receipt'
import { readSyncedExchangeDenialEvidenceById } from './synced-exchange-receipt'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { assertSyncedRemoteObservationRecords } from './synced-remote-observation-read'
import { decodeRemoteObservationMarker, SYNCED_OBSERVATION_CHANNEL, SYNCED_RETIRED_OBSERVATION_CHANNEL } from './synced-remote-observation-codec'
import { assertSyncedRecoveryBoundaryRecords } from './synced-recovery-boundary-read'
import { RECOVERY_BOUNDARY_CHANNEL, recoveryBoundaryKey, recoveryEpochMarkerId } from './synced-recovery-boundary-model'
import { assertSyncedLifecycleCoverage, readSyncedGroupLifecycles } from './synced-lifecycle-state'
import { assertRawSyncedExchangeHistoricalMetadataOwned } from './synced-exchange-history-metadata-read'
import { assertRawSyncedBackupV3MetadataOwned } from './synced-backup-v3-metadata-read'
import { assertHistoricalEvidenceOwned, historicalEvidenceInvalid, historicalFact, historicalHash, historicalMetadataLocator,
  historicalOperationLocator, historicalRowLocator, historicalTime, readHistoricalExactRows, readHistoricalMetadata, readHistoricalOperations } from './synced-history-evidence-support'
import type { RawHistoricalEvidenceFact, RawHistoricalEvidenceLocator, RawSyncedHistoricalEvidence } from './synced-history-evidence-model'
export type { RawHistoricalEvidenceFact, RawHistoricalEvidenceLocator, RawSyncedHistoricalEvidence } from './synced-history-evidence-model'

type Attempt = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string;
  state: string; created_at: string; confirmed_at: string | null }
type Member = { attempt_id: string; group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }
/** Authenticate every known original SQL family, including dormant historical
 * rows. The frozen result is an index of facts, never an install/publication or
 * old inverse permit. Metadata/schema and the full raw workspace are separate
 * original-capsule checks owned by the caller. No removable spool is required. */
export function assertRawSyncedHistoricalEvidenceOwned(db: Database.Database): RawSyncedHistoricalEvidence {
  assertHistoricalEvidenceOwned(db)
  const schema = db.pragma('user_version', { simple: true })
  if (schema !== 26 && schema !== 27) return historicalEvidenceInvalid('尚无该schema的完整同步历史adapter；不会推定empty。')
  const rows = readHistoricalOperations(db), metadata = readHistoricalMetadata(db)
  const operations = new Map(rows.map(row => [row.client_operation_id, row])), settings = new Map(metadata.map(row => [row.key, row]))
  const facts: RawHistoricalEvidenceFact[] = []
  const operation = (id: string): RawHistoricalEvidenceLocator => {
    const row = operations.get(id)
    return row ? historicalOperationLocator(row) : historicalEvidenceInvalid('原operation支持缺失。')
  }
  const setting = (key: string): RawHistoricalEvidenceLocator => {
    const row = settings.get(key)
    return row ? historicalMetadataLocator(row) : historicalEvidenceInvalid('原metadata支持缺失。')
  }
  const selectedMetadata = metadata.filter(row => /^(?:sync\.webdav\.protocol5|synced\.)/i.test(row.key))
  if (schema === 26 && selectedMetadata.length) return historicalEvidenceInvalid('schema26含不属于该版本的同步私有metadata。')
  const boundaries = schema === 27 ? assertSyncedRecoveryBoundaryRecords(db) : null
  const proofs = schema === 27 ? assertSyncedLogicalDeletionRecords(db) : null
  if (schema === 27) assertSyncedRemoteObservationRecords(db)
  const proofByAnchor = new Map([...(proofs?.values() ?? [])].map(proof => [proof.persistence.anchorId, proof]))
  const attempts = schema === 27 ? readHistoricalExactRows<Attempt>(db, 'synced_exposure_attempts', ['id', 'request_hash', 'channel',
    'target_fingerprint', 'publication_hash', 'state', 'created_at', 'confirmed_at']) : []
  const members = schema === 27 ? readHistoricalExactRows<Member>(db, 'synced_group_exposure_members', ['attempt_id', 'group_id',
    'creation_id', 'revision', 'topology_revision', 'semantic_hash']) : []
  const attemptsById = new Map(attempts.map(row => [row.id, row])), membersById = new Map<string, Member[]>()
  for (const row of members) {
    const list = membersById.get(row.attempt_id) ?? []; list.push(row); membersById.set(row.attempt_id, list)
    if (!attemptsById.has(row.attempt_id)) return historicalEvidenceInvalid('member缺原attempt。')
  }
  const attemptSupport = (id: string): RawHistoricalEvidenceLocator[] => {
    const row = attemptsById.get(id)
    if (!row) return historicalEvidenceInvalid('原anchor/attempt支持缺失。')
    return [historicalRowLocator('synced_exposure_attempts', [id], row), ...(membersById.get(id) ?? [])
      .map(member => historicalRowLocator('synced_group_exposure_members', [id, member.group_id], member))]
  }
  const denyReference = (reference: { anchorId: string; proofHash: string; key: string; tombstoneHash: string; deletionOperationId: string; intentHash: string }): RawHistoricalEvidenceLocator => {
    const proof = proofByAnchor.get(reference.anchorId), row = operations.get(reference.anchorId)
    if (!proof || !row || proof.key !== reference.key || proof.tombstoneHash !== reference.tombstoneHash
      || proof.intentHash !== reference.intentHash || proof.application.operationId !== reference.deletionOperationId
      || publicationHash(row.result_json) !== reference.proofHash) return historicalEvidenceInvalid('历史知识preimage引用缺准确永久proof支持。')
    return historicalOperationLocator(row)
  }
  for (const row of rows) {
    if (!historicalHash(row.request_hash) || !historicalTime(row.created_at)) return historicalEvidenceInvalid('原operation hash/时点无效。')
    const value = parseExchangeStored(row.result_json)
    const kind = value && typeof value === 'object' && !Array.isArray(value) && 'kind' in value ? value.kind : null
    if (row.client_operation_id.startsWith('synced:')) {
      if (schema !== 27) return historicalEvidenceInvalid('schema26不支持27原marker。')
      if (row.client_operation_id.startsWith('synced:remote-exposure-observation:v1:')) {
        const marker = decodeRemoteObservationMarker(row), id = marker.persistence.kind === 'active-confirmed' ? marker.persistence.attemptId : marker.persistence.anchorId
        facts.push(historicalFact('remote-observation', 1, historicalOperationLocator(row), attemptSupport(id)))
      } else if (row.client_operation_id.startsWith('synced:logical-deletion:v1:')) {
        const proof = proofByAnchor.get(row.client_operation_id)
        if (!proof || kind !== 'synced-logical-deletion-proof') return historicalEvidenceInvalid('原删除marker未通过strict支持认证。')
        facts.push(historicalFact('logical-deletion-proof', proof.version, historicalOperationLocator(row),
          [operation(proof.application.operationId), ...attemptSupport(proof.persistence.anchorId)]))
      } else if (row.client_operation_id.startsWith('synced:recovery-epoch:v1:')) {
        const item = [...boundaries!.boundaries.values()].find(boundary => recoveryEpochMarkerId(boundary.operationId) === row.client_operation_id)
        if (!item || kind !== 'synced-recovery-epoch') return historicalEvidenceInvalid('原epoch marker未通过B/R认证。')
        facts.push(historicalFact('recovery-epoch', 1, historicalOperationLocator(row), [setting(recoveryBoundaryKey(item.operationId)), ...attemptSupport(row.client_operation_id)]))
      } else return historicalEvidenceInvalid('未知原operation marker family或版本。')
      continue
    }
    if (!isSyncedUuid(row.client_operation_id)) return historicalEvidenceInvalid('原普通operation key不是准确UUID。')
    if (kind === null || kind === 'synced-host-operation' || kind === 'synced-host-create-operation') {
      decodeSyncedOperationAck(row)
      if (schema === 26 && kind === 'synced-host-create-operation') return historicalEvidenceInvalid('schema26不支持create lifecycle ACK。')
      facts.push(historicalFact(kind === null ? 'group-ack' : kind === 'synced-host-operation' ? 'host-ack' : 'host-create-ack',
        kind === null ? null : 1, historicalOperationLocator(row)))
    } else if (kind === 'synced-initial-incoming-operation') {
      if (schema !== 27) return historicalEvidenceInvalid('schema26不支持initial incoming receipt。')
      const receipt = validateInitialIncomingReceipt(value)
      if (receipt.request.operationId !== row.client_operation_id || row.request_hash !== initialIncomingRequestHash(receipt.request)
        || row.created_at !== receipt.result.acceptedAt) return historicalEvidenceInvalid('原incoming行/request/hash/时点损坏。')
      facts.push(historicalFact('initial-incoming', 1, historicalOperationLocator(row)))
    } else if (kind === 'synced-exchange-operation') {
      if (schema !== 27) return historicalEvidenceInvalid('schema26不支持exchange receipt。')
      const evidence = readSyncedExchangeDenialEvidenceById(db, row.client_operation_id)
      if (!evidence) return historicalEvidenceInvalid('原exchange receipt缺strict SQL支持。')
      const supports: RawHistoricalEvidenceLocator[] = []
      if (evidence.job) {
        const job = evidence.job
        supports.push(setting(exchangeJobKey(row.client_operation_id, job.attemptId)))
        const phasePrefix = exchangeJobPhaseKey(row.client_operation_id, job.attemptId, 0).slice(0, -1)
        supports.push(...metadata.filter(item => item.key.startsWith(phasePrefix)).map(historicalMetadataLocator))
        if (job.version === 5 || job.version === 6) supports.push(...job.knowledgeSource.deleted.map(denyReference))
        if (job.version === 7) supports.push(...job.decisionSource.authority.deletionProofReferences.map(denyReference))
      }
      for (const proof of evidence.receipt.provenance.historyArchives) supports.push(setting('sync.webdav.protocol5.exchange-history-index.v1.' + row.client_operation_id + '.' + proof.groupId))
      for (const cut of evidence.receipt.provenance.hostHistoryCuts) supports.push(setting('sync.webdav.protocol5.exchange-host-cut.v1.' + cut.historyToken))
      if (evidence.receipt.version === 4 || evidence.receipt.version === 7) supports.push(...evidence.receipt.provenance.deletions.map(proof => operation(proof.anchorId)))
      facts.push(historicalFact('exchange-receipt', evidence.receipt.version, historicalOperationLocator(row), supports))
    } else return historicalEvidenceInvalid('未知原operation闭形kind/version；不能只hash认证。')
  }
  if (schema === 27) {
    assertSyncedLifecycleCoverage(db)
    const ids = (db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
    const life = readSyncedGroupLifecycles(db, ids)
    const special = new Set<string>([SYNCED_OBSERVATION_CHANNEL, SYNCED_RETIRED_OBSERVATION_CHANNEL, LOGICAL_DELETION_CHANNEL, RECOVERY_BOUNDARY_CHANNEL])
    for (const row of attempts) {
      const actual = membersById.get(row.id) ?? []
      if (special.has(row.channel)) continue // Each reserved domain was strictly paired above; no generic fallback.
      if (!actual.length || !isSyncedUuid(row.id) || !historicalHash(row.request_hash) || !historicalHash(row.target_fingerprint)
        || !historicalHash(row.publication_hash) || typeof row.channel !== 'string' || !row.channel.trim() || !historicalTime(row.created_at)
        || row.state !== 'possible' && row.state !== 'confirmed'
        || (row.state === 'possible' ? row.confirmed_at !== null : !historicalTime(row.confirmed_at)))
        return historicalEvidenceInvalid('ordinary曝光原行/member/状态损坏。')
      for (const member of actual) if (!life.has(member.group_id) || life.get(member.group_id)!.creationId !== member.creation_id
        || !isSyncedUuid(member.revision) || !isSyncedUuid(member.topology_revision) || !historicalHash(member.semantic_hash))
        return historicalEvidenceInvalid('ordinary曝光成员原incarnation损坏。')
      facts.push(historicalFact('member-exposure', null, historicalRowLocator('synced_exposure_attempts', [row.id], row),
        actual.map(member => historicalRowLocator('synced_group_exposure_members', [member.attempt_id, member.group_id], member))))
    }
    facts.push(...assertRawSyncedExchangeHistoricalMetadataOwned(db), ...assertRawSyncedBackupV3MetadataOwned(db))
    for (const boundary of boundaries!.boundaries.values()) {
      const key = recoveryBoundaryKey(boundary.operationId), supports = [operation(recoveryEpochMarkerId(boundary.operationId)),
        ...attemptSupport(recoveryEpochMarkerId(boundary.operationId)), ...boundary.retainedOperations.map(item => operation(item.operationId))]
      for (const cut of boundary.hostCuts) {
        const journal = readHistoricalExactRows<Record<string, unknown>>(db, 'synced_host_history', ['id', 'action_json', 'before_json', 'after_json',
          'before_hash', 'after_hash', 'created_at'], 'id=?', [cut.historyToken])[0]
        if (!journal) return historicalEvidenceInvalid('B原host journal支持缺失。')
        supports.push(historicalRowLocator('synced_host_history', [cut.historyToken], journal))
      }
      for (const pin of boundary.retainedPins) {
        const original = readHistoricalExactRows<Record<string, unknown>>(db, 'synced_group_pins', ['group_id', 'kind', 'pin_id', 'created_at'],
          'group_id=? AND kind=? AND pin_id=?', [pin.groupId, pin.kind, pin.pinId])[0]
        if (!original) return historicalEvidenceInvalid('B原pin支持缺失。')
        supports.push(historicalRowLocator('synced_group_pins', [pin.groupId, pin.kind, pin.pinId], original))
      }
      facts.push(historicalFact('recovery-boundary', 1, setting(key), supports))
    }
    for (const row of selectedMetadata) if (!/^sync\.webdav\.protocol5\./.test(row.key)
      && !/^synced\.backup\.v3\./.test(row.key) && !/^synced\.recovery\.history\.v1\./.test(row.key))
      return historicalEvidenceInvalid('未知原同步metadata family/版本；不能只hash认证。')
  }
  facts.sort((left, right) => publicationCompare(publicationJson([left.family, left.locator.table, left.locator.key]), publicationJson([right.family, right.locator.table, right.locator.key])))
  return Object.freeze({ version: 1, operations: rows.length, metadata: selectedMetadata.length, facts: Object.freeze(facts) })
}
