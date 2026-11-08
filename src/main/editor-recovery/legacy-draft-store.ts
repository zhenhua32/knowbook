import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import Database from 'better-sqlite3'
import { editorRecoveryInvalid, validateEditorRecoveryExpected, type LegacyEditorRecoveryPage,
  type LegacyEditorRecoverySummary } from '../../shared/editor-recovery-drafts'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'

const LEGACY_SCHEMA = `CREATE TABLE drafts (
  record_id TEXT PRIMARY KEY,
  workspace_scope TEXT NOT NULL,
  recovery_epoch TEXT NOT NULL,
  draft_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target_id BLOB NOT NULL,
  payload_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB,
  UNIQUE(workspace_scope, recovery_epoch, draft_session_id, kind, target_id)
) STRICT`

const COLUMNS = `record_id, workspace_scope, recovery_epoch, draft_session_id, generation, kind, target_id, payload_hash, updated_at`

type LegacyRow = {
  record_id: string; workspace_scope: string; recovery_epoch: string; draft_session_id: string; generation: number
  kind: string; target_id: Buffer; payload_hash: string; updated_at: string
}

export function assertIndependentRecoveryJournal(filename: string): boolean {
  let exists = false
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const stat = lstatSync(filename + suffix, { throwIfNoEntry: false })
    if (!stat) continue
    if (!stat.isFile() || stat.nlink !== 1) return editorRecoveryInvalid('side-store is not an independent regular file')
    if (!suffix) exists = true
  }
  return exists
}

function isLegacySchema(db: Database.Database): boolean {
  if (db.pragma('application_id', { simple: true }) !== 0 || db.pragma('user_version', { simple: true }) !== 1) return false
  const rows = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all() as
    Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  return rows.length === 3 && rows[0].name === 'drafts' && rows[0].type === 'table' && rows[0].tbl_name === 'drafts'
    && rows[0].sql?.replace(/\s+/g, '') === LEGACY_SCHEMA.replace(/\s+/g, '')
    && rows.slice(1).every((row, index) => row.type === 'index' && row.name === `sqlite_autoindex_drafts_${index + 1}`
      && row.tbl_name === 'drafts' && row.sql === null)
}

function withLegacySnapshot<T>(filename: string, read: (db: Database.Database) => T): T | null {
  if (!assertIndependentRecoveryJournal(filename)) return null
  const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    db.pragma('trusted_schema = OFF')
    return db.transaction(() => {
      if (!isLegacySchema(db)) return null
      if (db.pragma('journal_mode', { simple: true }) !== 'delete') return editorRecoveryInvalid('legacy journal durability mode refused')
      return read(db)
    })()
  } finally { db.close() }
}

function summarize(row: LegacyRow): LegacyEditorRecoverySummary {
  const { record_id, generation, payload_hash, draft_session_id, workspace_scope, recovery_epoch, kind, target_id, updated_at } = row
  const expected = validateEditorRecoveryExpected({ recordId: record_id, generation, hash: payload_hash })
  if (!isSyncedUuid(draft_session_id) || !isSyncedUuid(workspace_scope) || !isSyncedUuid(recovery_epoch)
    || (kind !== 'document' && kind !== 'group' && kind !== 'source') || !Buffer.isBuffer(target_id) || target_id.length % 2
    || !Number.isFinite(Date.parse(updated_at))) return editorRecoveryInvalid('invalid legacy draft identity')
  const targetId = target_id.toString('utf16le')
  if (!targetId.trim() || targetId.length > 2048) return editorRecoveryInvalid('invalid legacy draft target')
  return { ...expected, kind, targetId, updatedAt: updated_at }
}

/** Older renderer journals retain exact UTF-16 drafts but cannot attest the Main
 * baseline required for editor restore. Expose only the committed local bytes. */
export class LegacyEditorRecoveryDraftStore {
  constructor(readonly file: string) {}

  exists(): boolean { return withLegacySnapshot(this.file, () => true) ?? false }

  list({ afterRecordId, limit }: { afterRecordId?: string; limit: number }): LegacyEditorRecoveryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (afterRecordId !== undefined && !isSyncedUuid(afterRecordId))) {
      return editorRecoveryInvalid('invalid legacy draft page')
    }
    return withLegacySnapshot(this.file, db => {
      const rows = db.prepare(`SELECT ${COLUMNS} FROM drafts WHERE payload IS NOT NULL AND record_id>? ORDER BY record_id LIMIT ?`)
        .all(afterRecordId ?? '', limit + 1) as LegacyRow[]
      const records = rows.slice(0, limit).map(summarize)
      return { records, next: rows.length > limit ? records.at(-1)!.recordId : null }
    }) ?? { records: [], next: null }
  }

  read(value: unknown): (LegacyEditorRecoverySummary & { payload: string }) | null {
    const expected = validateEditorRecoveryExpected(value)
    return withLegacySnapshot(this.file, db => {
      const row = db.prepare(`SELECT ${COLUMNS}, payload FROM drafts WHERE record_id=? AND payload IS NOT NULL`)
        .get(expected.recordId) as (LegacyRow & { payload: Buffer }) | undefined
      if (!row || row.generation !== expected.generation || row.payload_hash !== expected.hash) return null
      if (!Buffer.isBuffer(row.payload) || !row.payload.length || row.payload.length % 2
        || createHash('sha256').update(row.payload).digest('hex') !== expected.hash) return editorRecoveryInvalid('legacy draft bytes differ from their durable hash')
      return { ...summarize(row), payload: row.payload.toString('utf16le') }
    })
  }
}
