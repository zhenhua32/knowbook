import type Database from 'better-sqlite3'
import { parseExchangeStored } from '../sync/synced-exchange-model'
import { publicationJson } from '../sync/synced-publication-model'
import { syncedBackupV3HistoricalKey, syncedBackupV3HistoricalRequestHash, syncedBackupV3HistoricalTargetHash,
  validateSyncedBackupV3HistoricalMetadata } from './synced-backup-v3-metadata-model'
import { assertHistoricalEvidenceOwned, historicalEvidenceInvalid, historicalFact, historicalMetadataLocator,
  historicalRowLocator, historicalTime, readHistoricalExactRows, readHistoricalMetadata } from './synced-history-evidence-support'
import type { RawHistoricalEvidenceFact, RawHistoricalEvidenceLocator } from './synced-history-evidence-model'

type Attempt = { id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string;
  state: string; created_at: string; confirmed_at: string | null }
type Member = { attempt_id: string; group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }
/** Read the original durable claim only. A removed external ZIP is not needed,
 * and its destination string is never interpreted as a path to open. */
export function assertRawSyncedBackupV3MetadataOwned(db: Database.Database): readonly RawHistoricalEvidenceFact[] {
  assertHistoricalEvidenceOwned(db)
  const result: RawHistoricalEvidenceFact[] = []
  for (const row of readHistoricalMetadata(db)) {
    if (!/^synced\.backup\.v3/i.test(row.key)) continue
    const body = validateSyncedBackupV3HistoricalMetadata(parseExchangeStored(row.value))
    if (row.key !== syncedBackupV3HistoricalKey(body.snapshotId) || row.updated_at !== body.createdAt
      || row.value !== publicationJson(body)) return historicalEvidenceInvalid('V3 原key/规范body/时点不闭合。')
    const attempt = readHistoricalExactRows<Attempt>(db, 'synced_exposure_attempts', ['id', 'request_hash', 'channel', 'target_fingerprint',
      'publication_hash', 'state', 'created_at', 'confirmed_at'], 'id=?', [body.snapshotId])[0]
    const members = readHistoricalExactRows<Member>(db, 'synced_group_exposure_members', ['attempt_id', 'group_id', 'creation_id',
      'revision', 'topology_revision', 'semantic_hash'], 'attempt_id=? ORDER BY group_id', [body.snapshotId])
    const supports: RawHistoricalEvidenceLocator[] = []
    if (!body.members.length) {
      if (attempt || members.length) return historicalEvidenceInvalid('V3 零组原claim不应有发布anchor。')
    } else {
      if (!attempt || attempt.id !== body.snapshotId || attempt.request_hash !== syncedBackupV3HistoricalRequestHash(body)
        || attempt.channel !== 'backup-v3' || attempt.target_fingerprint !== syncedBackupV3HistoricalTargetHash(body.destination)
        || attempt.publication_hash !== body.archiveHash || attempt.created_at !== body.createdAt
        || attempt.state !== 'possible' && attempt.state !== 'confirmed'
        || (attempt.state === 'possible' ? attempt.confirmed_at !== null : !historicalTime(attempt.confirmed_at)))
        return historicalEvidenceInvalid('V3 原metadata/attempt不闭合。')
      const actual = members.map(member => ({ groupId: member.group_id, creationId: member.creation_id, revision: member.revision,
        topologyRevision: member.topology_revision, semanticHash: member.semantic_hash }))
      if (publicationJson(actual) !== publicationJson(body.members)) return historicalEvidenceInvalid('V3 原成员闭集损坏。')
      supports.push(historicalRowLocator('synced_exposure_attempts', [attempt.id], attempt),
        ...members.map(member => historicalRowLocator('synced_group_exposure_members', [member.attempt_id, member.group_id], member)))
    }
    result.push(historicalFact('backup-v3', 1, historicalMetadataLocator(row), supports))
  }
  return Object.freeze(result)
}
