import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { decodePublicationJson, publicationInvalid, publicationJson } from '../sync/synced-publication-model'

export const ordinaryPublicationAttemptPrefix = 'sync.webdav.protocol5.ordinary-publication.v1.'
export const ordinaryPublicationAttemptKey = (attemptId: string) => ordinaryPublicationAttemptPrefix + attemptId

export type SyncedPublicationAttemptRow = {
  id: string; request_hash: string; channel: string; target_fingerprint: string; publication_hash: string
  state: string; created_at: string; confirmed_at: string | null
}
type Setting = { key: string; value: string; updated_at: string }
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))

/** A zero-group publication has a durable workspace attempt, with no group exposure evidence. */
export function decodeOrdinaryPublicationAttempt(row: Setting): SyncedPublicationAttemptRow {
  const value = decodePublicationJson(Buffer.from(row.value), 4096)
  assertSyncedShape(value, ['id', 'request_hash', 'channel', 'target_fingerprint', 'publication_hash', 'state', 'created_at', 'confirmed_at'])
  if (!isSyncedUuid(value.id) || row.key !== ordinaryPublicationAttemptKey(value.id) || value.channel !== 'webdav-manifest5'
    || !isDigest(value.request_hash) || !isDigest(value.target_fingerprint) || !isDigest(value.publication_hash) || !isTime(value.created_at)
    || (value.state === 'possible' ? value.confirmed_at !== null || row.updated_at !== value.created_at
      : value.state !== 'confirmed' || !isTime(value.confirmed_at) || row.updated_at !== value.confirmed_at
        || Date.parse(value.confirmed_at) < Date.parse(value.created_at))) {
    return publicationInvalid('普通工作区首发的持久记录损坏。')
  }
  return value as SyncedPublicationAttemptRow
}

export function readOrdinaryPublicationAttempt(db: Database.Database, attemptId: string) {
  const row = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(ordinaryPublicationAttemptKey(attemptId)) as Setting | undefined
  return row ? { row, attempt: decodeOrdinaryPublicationAttempt(row) } : undefined
}

export function readOrdinaryPublicationAttempts(db: Database.Database) {
  const rows = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(lower(key),1,?)=? ORDER BY key')
    .all(ordinaryPublicationAttemptPrefix.length, ordinaryPublicationAttemptPrefix) as Setting[]
  return rows.map(row => ({ row, attempt: decodeOrdinaryPublicationAttempt(row) }))
}

export function insertOrdinaryPublicationAttempt(db: Database.Database, attempt: SyncedPublicationAttemptRow): void {
  db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
    .run(ordinaryPublicationAttemptKey(attempt.id), publicationJson(attempt), attempt.created_at)
}

export function confirmOrdinaryPublicationAttempt(db: Database.Database, attempt: SyncedPublicationAttemptRow, confirmedAt: string): boolean {
  const next = { ...attempt, state: 'confirmed', confirmed_at: confirmedAt }
  return db.prepare('UPDATE app_settings SET value=?,updated_at=? WHERE key=? AND value=?')
    .run(publicationJson(next), confirmedAt, ordinaryPublicationAttemptKey(attempt.id), publicationJson(attempt)).changes === 1
}
