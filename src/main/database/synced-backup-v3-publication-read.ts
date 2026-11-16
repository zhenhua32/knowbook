import type Database from 'better-sqlite3'
import { parseExchangeStored } from '../sync/synced-exchange-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { syncedBackupV3HistoricalKey, syncedBackupV3HistoricalRequestHash, syncedBackupV3HistoricalTargetHash,
  validateSyncedBackupV3HistoricalMetadata } from './synced-backup-v3-metadata-model'
import { assertHistoricalEvidenceOwned, historicalTime, readHistoricalExactRows } from './synced-history-evidence-support'

/** Destination is inert compared text. This read does not open the staged archive. */
function readConfirmedPublication(db: Database.Database, snapshotId: string, destination: string) {
  assertHistoricalEvidenceOwned(db)
  const bad = (): never => { throw new Error('V3 backup has no exact confirmed original publication; previous version retained.') }
  const row = readHistoricalExactRows<{key:string;value:string;updated_at:string}>(db, 'app_settings', ['key','value','updated_at'], 'key=?', [syncedBackupV3HistoricalKey(snapshotId)])[0]
  if (!row) return bad()
  const body = validateSyncedBackupV3HistoricalMetadata(parseExchangeStored(row.value))
  if (body.snapshotId !== snapshotId || body.destination !== destination || row.value !== publicationJson(body) || row.updated_at !== body.createdAt) return bad()
  const attempt = readHistoricalExactRows<{id:string;request_hash:string;channel:string;target_fingerprint:string;publication_hash:string;state:string;created_at:string;confirmed_at:string|null}>(db,
    'synced_exposure_attempts', ['id','request_hash','channel','target_fingerprint','publication_hash','state','created_at','confirmed_at'], 'id=?', [snapshotId])[0]
  const members = readHistoricalExactRows<{attempt_id:string;group_id:string;creation_id:string;revision:string;topology_revision:string;semantic_hash:string}>(db,
    'synced_group_exposure_members', ['attempt_id','group_id','creation_id','revision','topology_revision','semantic_hash'], 'attempt_id=? ORDER BY group_id', [snapshotId])
  if (!body.members.length) { if (attempt || members.length) return bad() }
  else {
    if (!attempt || attempt.id !== snapshotId || attempt.state !== 'confirmed' || !historicalTime(attempt.confirmed_at)
      || attempt.created_at !== body.createdAt || attempt.channel !== 'backup-v3' || attempt.request_hash !== syncedBackupV3HistoricalRequestHash(body)
      || attempt.target_fingerprint !== syncedBackupV3HistoricalTargetHash(destination) || attempt.publication_hash !== body.archiveHash) return bad()
    if (publicationJson(members.map(member => ({groupId:member.group_id,creationId:member.creation_id,revision:member.revision,topologyRevision:member.topology_revision,semanticHash:member.semantic_hash}))) !== publicationJson(body.members)) return bad()
  }
  return { body, row, attempt, members }
}

export function readConfirmedSyncedBackupV3PublicationOwned(db: Database.Database, snapshotId: string, destination: string): string {
  return readConfirmedPublication(db, snapshotId, destination).body.archiveHash
}

/** Identifies the worker's validated SQL claim. Final version promotion is a
 * separate Main action, including when a zero-member claim has no attempt. */
export function readConfirmedSyncedBackupV3PublicationClaimOwned(db: Database.Database, snapshotId: string, destination: string) {
  const { body, row, attempt, members } = readConfirmedPublication(db, snapshotId, destination)
  const { archiveHash, workspaceScope, recoveryEpoch } = body
  const claimHash = publicationHash(publicationJson({
    domain: 'knowbook.synced-backup-v3.confirmed-sql-claim.v1', row, attempt: attempt ?? null, members
  }))
  return Object.freeze({ archiveHash, workspaceScope, recoveryEpoch, claimHash })
}
