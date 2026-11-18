import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedBlockId } from '../../shared/syncedBlockValidation'
import { parseStrictJson } from '../../shared/strictJson'
import { publicationCompare, publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'

const prefix = 'sync.webdav.client.protocol5.document-deletion.v1.'

export interface LocalDocumentDeletion {
  documentId: string
  createdAt: string
  path: string
  updatedAt: string
  deletedAt: string
}

function settingsKey(documentId: string): string { return prefix + publicationHash(publicationJson(documentId)) }

export function validateLocalDocumentDeletion(value: unknown): LocalDocumentDeletion {
  assertSyncedShape(value, ['documentId', 'createdAt', 'path', 'updatedAt', 'deletedAt'])
  const { documentId, createdAt, path, updatedAt, deletedAt } = value
  const time = (input: unknown): input is string => typeof input === 'string' && Number.isFinite(Date.parse(input))
  if (!isSyncedBlockId(documentId) || typeof path !== 'string' || !time(createdAt) || !time(updatedAt) || !time(deletedAt)) {
    return publicationInvalid('本机删除记录的文档身份或时间无效。')
  }
  return { documentId, createdAt, path, updatedAt, deletedAt }
}

/** Record an explicit user deletion in the same SQL transaction as the archive and removal. */
export function recordLocalDocumentDeletion(db: Database.Database, value: LocalDocumentDeletion): void {
  const deletion = validateLocalDocumentDeletion(value)
  db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(settingsKey(deletion.documentId), publicationJson(deletion), deletion.deletedAt)
}

export function forgetLocalDocumentDeletion(db: Database.Database, documentId: string): void {
  db.prepare('DELETE FROM app_settings WHERE key=?').run(settingsKey(documentId))
}

/** A registered exchange may already have sent the deletion while its local receipt is pending. */
export function hasRegisteredLocalDocumentDeletion(db: Database.Database, documentId: string): boolean {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(settingsKey(documentId)) as { value: string } | undefined
  if (!row) return false
  return !!db.prepare(`SELECT 1 FROM app_settings job,
    json_each(CASE WHEN json_valid(job.value) THEN job.value ELSE '{}' END, '$.deletions') intent
    WHERE job.key GLOB 'sync.webdav.protocol5.exchange-job.v1.*'
      AND json_extract(intent.value,'$.key')=? AND json_extract(intent.value,'$.localDeletionHash')=? LIMIT 1`)
    .get('doc:' + documentId, publicationHash(row.value))
}

export function readLocalDocumentDeletions(db: Database.Database): LocalDocumentDeletion[] {
  const rows = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?')
    .all(prefix.length, prefix) as Array<{ key: string; value: string; updated_at: string }>
  return rows.map(row => {
    const deletion = validateLocalDocumentDeletion(parseStrictJson(row.value, { maxBytes: 64 * 1024, maxDepth: 2 }))
    if (row.key !== settingsKey(deletion.documentId) || row.value !== publicationJson(deletion) || row.updated_at !== deletion.deletedAt) {
      return publicationInvalid('本机删除记录与存储键不符。')
    }
    return deletion
  }).sort((a, b) => publicationCompare(a.documentId, b.documentId))
}
