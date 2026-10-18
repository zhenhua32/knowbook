import type Database from 'better-sqlite3'
import { conflictPreviewKey, validateConflictPreviewIndex, type ConflictPreviewIndex } from '../sync/synced-exchange-conflict-model'
import { parseExchangeStored } from '../sync/synced-exchange-model'
import { publicationInvalid } from '../sync/synced-publication-model'

/** Denial-only original index read; this module cannot mint preview provenance or accept caller records. */
export function readSyncedExchangeConflictPreviewIndex(db: Database.Database, previewId: string,
  context: { databasePath: string; targetFingerprint: string }): ConflictPreviewIndex | null {
  if (!db.open || !db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('preview需要owned/FK只读事务。')
  const key = conflictPreviewKey(previewId), row = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(key) as { value: string; updated_at: string } | undefined
  if (!row) return null
  const value = validateConflictPreviewIndex(parseExchangeStored(row.value))
  if (value.previewId !== previewId || value.databasePath !== context.databasePath || value.targetFingerprint !== context.targetFingerprint || value.createdAt !== row.updated_at)
    return publicationInvalid('preview原index/path/target/时间损坏或ID复用。')
  return value
}
