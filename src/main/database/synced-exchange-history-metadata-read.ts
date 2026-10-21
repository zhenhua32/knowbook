import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedUuid, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { exchangeHostCutKey, exchangeJobHeadKey, exchangeJobKey, exchangeJobPhaseKey,
  exchangeStateKey, parseExchangeStored, validateAnyExchangeState, validateExchangeJob, validateExchangeJobPhase,
  type AnyExchangeState, type ExchangeJob, type ExchangeReceipt } from '../sync/synced-exchange-model'
import { conflictPreviewKey, validateConflictPreviewIndex } from '../sync/synced-exchange-conflict-model'
import { bothPreviewKey, validateBothPreviewIndex } from '../sync/synced-exchange-both-model'
import { initialIncomingBaselineKey, initialIncomingRequestHash, validateInitialIncomingBaseline,
  validateInitialIncomingReceipt } from '../sync/synced-initial-incoming-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { readSyncedExchangeDenialEvidenceById } from './synced-exchange-receipt'
import { assertSyncedExchangeHostCutRecords } from './synced-exchange-host-cut'
import { assertSyncedLogicalDeletionRecords } from './synced-logical-deletion-read'
import { knowledgePreviewKey, validateKnowledgePreviewIndex } from './synced-exchange-knowledge-read'
import { deletionChoicePreviewKey, validateDeletionChoicePreviewIndex } from './synced-exchange-deletion-choice-read'
import { assertHistoricalEvidenceOwned, historicalEvidenceInvalid, historicalFact, historicalHash, historicalMetadataLocator,
  historicalOperationLocator, historicalRowLocator, historicalTime, readHistoricalExactRows, readHistoricalMetadata, readHistoricalOperations, readHistoricalRowLocator,
  type HistoricalMetadataRow } from './synced-history-evidence-support'
import type { RawHistoricalEvidenceFact, RawHistoricalEvidenceLocator } from './synced-history-evidence-model'

const same = (left: unknown, right: unknown): boolean => publicationJson(left) === publicationJson(right)
const prefix = 'sync.webdav.protocol5.'
type Head = { kind: 'synced-exchange-job-head'; version: 1; operationId: string; requestHash: string; attemptId: string; attemptIndex: number; jobHash: string }
function head(value: unknown): Head {
  assertSyncedShape(value, ['kind', 'version', 'operationId', 'requestHash', 'attemptId', 'attemptIndex', 'jobHash'])
  if (value.kind !== 'synced-exchange-job-head' || value.version !== 1 || !isSyncedUuid(value.operationId) || !isSyncedUuid(value.attemptId)
    || !historicalHash(value.requestHash) || !historicalHash(value.jobHash) || typeof value.attemptIndex !== 'number'
    || !Number.isSafeInteger(value.attemptIndex) || value.attemptIndex < 0) return historicalEvidenceInvalid('exchange原head闭形损坏。')
  return { kind: value.kind, version: 1, operationId: value.operationId, requestHash: value.requestHash,
    attemptId: value.attemptId, attemptIndex: value.attemptIndex, jobHash: value.jobHash }
}
/** Historical SQL only. No network execution module, today's path/epoch/CAS,
 * removable spool, public graph reader or source permit is consulted. */
export function assertRawSyncedExchangeHistoricalMetadataOwned(db: Database.Database): readonly RawHistoricalEvidenceFact[] {
  assertHistoricalEvidenceOwned(db)
  const metadata = readHistoricalMetadata(db), settings = new Map(metadata.map(row => [row.key, row]))
  const rows = readHistoricalOperations(db), operations = new Map(rows.map(row => [row.client_operation_id, row]))
  const selected = metadata.filter(row => /^sync\.webdav\.protocol5/i.test(row.key))
  if (db.pragma('user_version', { simple: true }) !== 27) {
    if (selected.length) return historicalEvidenceInvalid('protocol5私有metadata不属于原schema26。')
    return Object.freeze([])
  }
  const facts: RawHistoricalEvidenceFact[] = [], recognized = new Set<string>()
  const proofs = new Map([...assertSyncedLogicalDeletionRecords(db).values()].map(proof => [proof.persistence.anchorId, proof]))
  const receipts = new Map<string, ExchangeReceipt>()
  const receipt = (id: string): ExchangeReceipt => {
    const old = receipts.get(id); if (old) return old
    const exact = readSyncedExchangeDenialEvidenceById(db, id)?.receipt
    if (!exact) return historicalEvidenceInvalid('历史metadata缺准确原exchange receipt。')
    receipts.set(id, exact); return exact
  }
  const operationSupport = (id: string): RawHistoricalEvidenceLocator => {
    const row = operations.get(id)
    return row ? historicalOperationLocator(row) : historicalEvidenceInvalid('历史metadata缺原operation行。')
  }
  const jobs = new Map<string, { row: HistoricalMetadataRow; job: ExchangeJob }>()
  const heads = new Map<string, { row: HistoricalMetadataRow; value: Head }>()
  const phases = new Map<string, Array<{ row: HistoricalMetadataRow; value: ReturnType<typeof validateExchangeJobPhase> }>>()
  const states: Array<{ row: HistoricalMetadataRow; value: AnyExchangeState }> = []
  const indexes: HistoricalMetadataRow[] = [], archiveRows = new Map<string, HistoricalMetadataRow>()
  const cutRows: HistoricalMetadataRow[] = []
  for (const row of selected) {
    const raw = parseExchangeStored(row.value)
    if (row.key.startsWith(prefix + 'initial.v1.')) {
      const value = validateInitialIncomingBaseline(raw), operation = operations.get(value.result.operationId)
      if (!operation) return historicalEvidenceInvalid('initial baseline缺原receipt。')
      const original = validateInitialIncomingReceipt(parseExchangeStored(operation.result_json))
      if (row.key !== initialIncomingBaselineKey(value.targetFingerprint) || row.updated_at !== value.lastReceivedAt
        || operation.client_operation_id !== original.request.operationId || operation.request_hash !== initialIncomingRequestHash(original.request)
        || operation.created_at !== original.result.acceptedAt || original.request.databasePath !== value.databasePath
        || original.request.targetFingerprint !== value.targetFingerprint || !same(original.result, value.result) || !same(original.provenance, value.provenance))
        return historicalEvidenceInvalid('initial baseline原key/hash/时点/receipt不闭合。')
      facts.push(historicalFact('initial-baseline', 1, historicalMetadataLocator(row), [historicalOperationLocator(operation)]))
    } else if (row.key.startsWith(prefix + 'exchange.v1.')) {
      const value = validateAnyExchangeState(raw)
      if (row.key !== exchangeStateKey(value.targetFingerprint) || row.updated_at !== value.lastSyncAt || !isSyncedUuid(value.currentOperationId))
        return historicalEvidenceInvalid('exchange state原key/接受时点/operation损坏。')
      states.push({ row, value })
    } else if (row.key.startsWith(prefix + 'exchange-job.v1.')) {
      const job = validateExchangeJob(raw), key = exchangeJobKey(job.request.operationId, job.attemptId)
      if (row.key !== key || row.updated_at !== job.preparedAt || row.value !== publicationJson(job)) return historicalEvidenceInvalid('原immutable job/key/bytes/时点损坏。')
      jobs.set(key, { row, job })
    } else if (row.key.startsWith(prefix + 'exchange-job-head.v1.')) {
      const value = head(raw)
      if (row.key !== exchangeJobHeadKey(value.operationId)) return historicalEvidenceInvalid('原job head key损坏。')
      heads.set(value.operationId, { row, value })
    } else if (row.key.startsWith(prefix + 'exchange-job-phase.v1.')) {
      const value = validateExchangeJobPhase(raw), key = exchangeJobKey(value.operationId, value.attemptId)
      if (row.key !== exchangeJobPhaseKey(value.operationId, value.attemptId, value.sequence) || row.updated_at !== value.recordedAt
        || row.value !== publicationJson(value)) return historicalEvidenceInvalid('原phase key/bytes/时点损坏。')
      const list = phases.get(key) ?? []; list.push({ row, value }); phases.set(key, list)
    } else if (row.key.startsWith(prefix + 'exchange-preview.v1.')) {
      const value = validateConflictPreviewIndex(raw)
      if (row.key !== conflictPreviewKey(value.previewId) || row.updated_at !== value.createdAt
        || settings.has(knowledgePreviewKey('conflicts', value.previewId))) return historicalEvidenceInvalid('原conflict index/key/版本并存损坏。')
      facts.push(historicalFact('conflict-preview', 1, historicalMetadataLocator(row), [], 'index-attempt-only'))
    } else if (row.key.startsWith(prefix + 'exchange-both-preview.v1.')) {
      const value = validateBothPreviewIndex(raw)
      if (row.key !== bothPreviewKey(value.previewId) || row.updated_at !== value.createdAt || row.value !== publicationJson(value)
        || settings.has(knowledgePreviewKey('both', value.previewId))) return historicalEvidenceInvalid('原both index/key/版本并存损坏。')
      facts.push(historicalFact('both-preview', 1, historicalMetadataLocator(row), [], 'index-attempt-only'))
    } else if (row.key.startsWith(prefix + 'exchange-preview.v2.') || row.key.startsWith(prefix + 'exchange-both-preview.v2.')) {
      const mode = row.key.startsWith(prefix + 'exchange-both-preview.v2.') ? 'both' : 'conflicts'
      const value = validateKnowledgePreviewIndex(raw, mode)
      if (row.key !== knowledgePreviewKey(mode, value.previewId) || row.updated_at !== value.createdAt || row.value !== publicationJson(value)
        || settings.has(mode === 'both' ? bothPreviewKey(value.previewId) : conflictPreviewKey(value.previewId)))
        return historicalEvidenceInvalid('原knowledge index/key/版本并存损坏。')
      facts.push(historicalFact(mode === 'both' ? 'both-preview' : 'conflict-preview', 2, historicalMetadataLocator(row), [], 'index-attempt-only'))
    } else if (row.key.startsWith(prefix + 'exchange-deletion-preview.v1.')) {
      const value = validateDeletionChoicePreviewIndex(raw)
      if (row.key !== deletionChoicePreviewKey(value.previewId) || row.updated_at !== value.createdAt || row.value !== publicationJson(value))
        return historicalEvidenceInvalid('原deletion preview index/key损坏。')
      facts.push(historicalFact('deletion-preview', 1, historicalMetadataLocator(row), [], 'index-attempt-only'))
    } else if (row.key.startsWith(prefix + 'exchange-history-index.v1.')) indexes.push(row)
    else if (row.key.startsWith(prefix + 'exchange-history-row.v1.')) archiveRows.set(row.key, row)
    else if (row.key.startsWith(prefix + 'exchange-host-cut.v1.')) cutRows.push(row)
    else return historicalEvidenceInvalid('未知protocol5 metadata family或版本：' + row.key)
    recognized.add(row.key)
  }
  const byOperation = new Map<string, Array<{ row: HistoricalMetadataRow; job: ExchangeJob }>>()
  for (const item of jobs.values()) {
    const jobHash = publicationHash(publicationJson(item.job))
    const list = byOperation.get(item.job.request.operationId) ?? []; list.push(item); byOperation.set(item.job.request.operationId, list)
    const chain = (phases.get(item.row.key) ?? []).sort((left, right) => left.value.sequence - right.value.sequence)
    let previous: string | null = null
    for (const [index, entry] of chain.entries()) {
      const value = entry.value
      if (value.sequence !== index || value.previousFactHash !== previous || value.operationId !== item.job.request.operationId
        || value.attemptId !== item.job.attemptId || value.requestHash !== item.job.requestHash || value.jobHash !== jobHash
        || value.version !== (item.job.version === 3 || item.job.version === 6 ? 2 : 1)) return historicalEvidenceInvalid('原attempt phase追加链不闭合。')
      previous = publicationHash(publicationJson(value))
      facts.push(historicalFact('exchange-job-phase', value.version, historicalMetadataLocator(entry.row), [historicalMetadataLocator(item.row)], 'index-attempt-only'))
    }
    if (!chain.length || chain[0].value.phase !== 'prepared' || chain[0].value.recordedAt !== item.job.preparedAt)
      return historicalEvidenceInvalid('原attempt缺prepared首事实。')
    const supports = chain.map(entry => historicalMetadataLocator(entry.row))
    const references = item.job.version === 5 || item.job.version === 6 ? item.job.knowledgeSource.deleted
      : item.job.version === 7 ? item.job.decisionSource.authority.deletionProofReferences : []
    for (const reference of references) {
      const proof = proofs.get(reference.anchorId), source = operations.get(reference.anchorId)
      if (!proof || !source || proof.key !== reference.key || proof.tombstoneHash !== reference.tombstoneHash
        || proof.application.operationId !== reference.deletionOperationId || proof.intentHash !== reference.intentHash
        || publicationHash(source.result_json) !== reference.proofHash) return historicalEvidenceInvalid('原job knowledge引用失去准确永久proof。')
      supports.push(historicalOperationLocator(source))
    }
    facts.push(historicalFact('exchange-job', item.job.version, historicalMetadataLocator(item.row), supports, 'index-attempt-only'))
  }
  for (const key of phases.keys()) if (!jobs.has(key)) return historicalEvidenceInvalid('存在无原job的phase。')
  for (const [operationId, chain] of byOperation) {
    const current = heads.get(operationId)
    if (!current) return historicalEvidenceInvalid('原attempt链缺head。')
    const byId = new Map(chain.map(item => [item.job.attemptId, item])), seen = new Set<string>()
    let id: string | null = current.value.attemptId, expected = current.value.attemptIndex
    while (id !== null) {
      const item = byId.get(id)
      if (!item || seen.has(id) || item.job.attemptIndex !== expected || item.job.requestHash !== current.value.requestHash
        || !same(item.job.request, chain[0].job.request) || seen.size === 0 && (publicationHash(publicationJson(item.job)) !== current.value.jobHash
          || current.row.updated_at !== item.job.preparedAt)) return historicalEvidenceInvalid('原job父链缺失/循环/错位。')
      seen.add(id); expected--; id = item.job.parentAttemptId
    }
    if (expected !== -1 || seen.size !== byId.size) return historicalEvidenceInvalid('原job链存在孤attempt。')
    facts.push(historicalFact('exchange-job-head', 1, historicalMetadataLocator(current.row), chain.map(item => historicalMetadataLocator(item.row)), 'index-attempt-only'))
  }
  for (const id of heads.keys()) if (!byOperation.has(id)) return historicalEvidenceInvalid('原head缺job链。')
  for (const { row, value } of states) {
    const current = receipt(value.currentOperationId!), supports = [operationSupport(current.request.operationId)]
    if (current.request.databasePath !== value.databasePath || current.request.targetFingerprint !== value.targetFingerprint
      || current.provenance.afterStateHash !== publicationHash(publicationJson(value)) || current.result.acceptedAt !== value.lastSyncAt
      || current.result.workspaceScope !== value.workspaceScope || current.result.recoveryEpoch !== value.recoveryEpoch
      || current.result.remoteWorkspaceId !== value.remoteWorkspaceId || !same(current.provenance.source, value.source))
      return historicalEvidenceInvalid('历史state缺准确结算receipt。')
    for (const entry of value.baseline) {
      if (entry.acceptedOperationId === value.source.operationId) continue
      const original = receipt(entry.acceptedOperationId), accepted = original.provenance.accepted.find(side => side.key === entry.key)
      const local = accepted && ('local' in accepted ? accepted.local : { kind: 'live', hash: accepted.afterHash })
      const expected = value.version === 2 && 'local' in entry ? entry.local : 'localHash' in entry ? { kind: 'live', hash: entry.localHash } : null
      const common = accepted && ('local' in accepted ? accepted.commonHash : accepted.afterHash)
      if (!accepted || original.request.databasePath !== value.databasePath || original.request.targetFingerprint !== value.targetFingerprint
        || original.result.workspaceScope !== value.workspaceScope || original.result.recoveryEpoch !== value.recoveryEpoch
        || original.result.remoteWorkspaceId !== value.remoteWorkspaceId || common !== entry.remoteHash || common !== entry.commonHash
        || !same(local, expected) || entry.dependencySignature !== accepted.dependencySignature || !same(entry.dependencyKeys, accepted.dependencyKeys)
        || !same(value.source, original.provenance.source)) return historicalEvidenceInvalid('历史baseline缺准确原accepted receipt。')
      supports.push(operationSupport(original.request.operationId))
    }
    if (value.source.kind === 'initial-receipt') {
      const source = operations.get(value.source.operationId!)
      if (!source) return historicalEvidenceInvalid('state缺原initial seed receipt。')
      const seed = validateInitialIncomingReceipt(parseExchangeStored(source.result_json))
      if (source.request_hash !== initialIncomingRequestHash(seed.request) || source.created_at !== seed.result.acceptedAt
        || seed.request.operationId !== source.client_operation_id || seed.request.databasePath !== value.databasePath
        || seed.result.workspaceScope !== value.workspaceScope || seed.result.recoveryEpoch !== value.recoveryEpoch
        || seed.result.remoteWorkspaceId !== value.remoteWorkspaceId || seed.result.manifestHash !== value.source.manifestHash
        || seed.provenance.portableDigest !== value.source.portableDigest) return historicalEvidenceInvalid('state原initial seed损坏。')
      supports.push(historicalOperationLocator(source))
    } else if (value.source.kind === 'confirmed-publication') {
      const source = readHistoricalExactRows<Record<string, unknown>>(db, 'synced_exposure_attempts', ['id', 'request_hash', 'channel',
        'target_fingerprint', 'publication_hash', 'state', 'created_at', 'confirmed_at'], 'id=?', [value.source.operationId!])[0]
      if (!source || source.channel !== 'webdav-manifest5' || source.state !== 'confirmed' || !historicalTime(source.confirmed_at))
        return historicalEvidenceInvalid('state原confirmed seed缺durable attempt。')
      supports.push(historicalRowLocator('synced_exposure_attempts', [value.source.operationId!], source))
    }
    facts.push(historicalFact('exchange-state', value.version, historicalMetadataLocator(row), supports, 'index-attempt-only'))
  }
  // A receipt may outlive today's mutable state/head. Only its own immutable
  // history references impose a mandatory reverse archive/cut dependency.
  for (const row of rows) {
    const raw = parseExchangeStored(row.result_json)
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'kind' in raw && raw.kind === 'synced-exchange-operation') receipt(row.client_operation_id)
  }
  const referenced = new Set<string>(), indexByKey = new Map(indexes.map(row => [row.key, row]))
  for (const row of indexes) {
    const value = parseExchangeStored(row.value)
    assertSyncedShape(value, ['kind', 'version', 'operationId', 'groupId', 'rows', 'archivedAt'])
    if (value.kind !== 'synced-exchange-history-index' || value.version !== 1 || !isSyncedUuid(value.operationId) || !isSyncedUuid(value.groupId)
      || !Array.isArray(value.rows) || !historicalTime(value.archivedAt) || value.archivedAt !== row.updated_at
      || row.key !== prefix + 'exchange-history-index.v1.' + value.operationId + '.' + value.groupId)
      return historicalEvidenceInvalid('history index原闭形/key/时点损坏。')
    const original = receipt(value.operationId)
    if (!original.result.appliedKeys.includes('group:' + value.groupId)
      || !original.provenance.historyArchives.some(proof => proof.groupId === value.groupId && proof.indexHash === publicationHash(row.value)))
      return historicalEvidenceInvalid('history index缺准确replacement receipt。')
    const group = readHistoricalExactRows<{ id: string; creation_id: string; created_at: string; origin_json: string }>(db, 'synced_groups',
      ['id', 'creation_id', 'created_at', 'origin_json'], 'id=?', [value.groupId])[0]
    if (!group) return historicalEvidenceInvalid('history archive缺原immutable group tuple。')
    const supports = [operationSupport(value.operationId), readHistoricalRowLocator(db, 'synced_groups', [group.id])], seen = new Set<string>()
    for (const [position, entry] of value.rows.entries()) {
      assertSyncedShape(entry, ['id', 'hash'])
      if (!isSyncedUuid(entry.id) || !historicalHash(entry.hash) || seen.has(entry.id)) return historicalEvidenceInvalid('history index entries损坏。')
      seen.add(entry.id)
      const key = prefix + 'exchange-history-row.v1.' + value.operationId + '.' + value.groupId + '.' + entry.id, source = archiveRows.get(key)
      if (!source || source.updated_at !== value.archivedAt || publicationHash(source.value) !== entry.hash) return historicalEvidenceInvalid('history archive原row缺失/改写。')
      const envelope = parseExchangeStored(source.value)
      assertSyncedShape(envelope, ['kind', 'version', 'operationId', 'groupId', 'row', 'archivedAt'])
      if (envelope.kind !== 'synced-exchange-history-row' || envelope.version !== 1 || envelope.operationId !== value.operationId
        || envelope.groupId !== value.groupId || envelope.archivedAt !== value.archivedAt) return historicalEvidenceInvalid('history row envelope损坏。')
      const item = envelope.row
      assertSyncedShape(item, ['id', 'group_id', 'position', 'before_json', 'after_json', 'before_hash', 'after_hash', 'created_at'])
      if (item.id !== entry.id || item.group_id !== value.groupId || item.position !== position + 1 || !historicalTime(item.created_at))
        return historicalEvidenceInvalid('原history row身份/顺序/时点损坏。')
      for (const [text, hash] of [[item.before_json, item.before_hash], [item.after_json, item.after_hash]]) {
        if (typeof text !== 'string') return historicalEvidenceInvalid('archive side不是原JSON。')
        const wire = validateSyncedGroupWire(parseExchangeStored(text))
        if (wire.id !== group.id || wire.creationId !== group.creation_id || wire.createdAt !== group.created_at
          || !same(wire.origin, parseExchangeStored(group.origin_json)) || publicationHash(publicationJson(wire)) !== hash)
          return historicalEvidenceInvalid('原archived wire/hash/immutable tuple损坏。')
      }
      if (db.prepare('SELECT 1 FROM synced_group_history WHERE id=?').get(item.id)) return historicalEvidenceInvalid('已归档group历史ID重新成为执行记录。')
      const support = historicalMetadataLocator(source); supports.push(support); referenced.add(key)
      facts.push(historicalFact('exchange-history-row', 1, support, [historicalMetadataLocator(row), operationSupport(value.operationId)]))
    }
    facts.push(historicalFact('exchange-history-index', 1, historicalMetadataLocator(row), supports))
  }
  if (referenced.size !== archiveRows.size) return historicalEvidenceInvalid('存在孤history archive row。')
  for (const original of receipts.values()) for (const proof of original.provenance.historyArchives) {
    const index = indexByKey.get(prefix + 'exchange-history-index.v1.' + original.request.operationId + '.' + proof.groupId)
    if (!index || publicationHash(index.value) !== proof.indexHash) return historicalEvidenceInvalid('原receipt所指archive整组缺失/被改。')
  }
  const cuts = assertSyncedExchangeHostCutRecords(db)
  for (const row of cutRows) {
    const token = row.key.slice((prefix + 'exchange-host-cut.v1.').length), cut = cuts.get(token)
    if (!cut || row.key !== exchangeHostCutKey(cut.historyToken)) return historicalEvidenceInvalid('原host cut未认证。')
    const journal = readHistoricalExactRows<Record<string, unknown>>(db, 'synced_host_history', ['id', 'action_json', 'before_json', 'after_json',
      'before_hash', 'after_hash', 'created_at'], 'id=?', [cut.historyToken])[0]
    if (!journal) return historicalEvidenceInvalid('原host cut journal缺失。')
    facts.push(historicalFact('exchange-host-cut', 1, historicalMetadataLocator(row), [operationSupport(cut.operationId),
      historicalRowLocator('synced_host_history', [cut.historyToken], journal)]))
  }
  if (recognized.size !== selected.length) return historicalEvidenceInvalid('metadata family未完整覆盖。')
  return Object.freeze(facts)
}
