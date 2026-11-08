import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedUuid } from '../shared/syncedBlockValidation'
import type {
  EditorRecoveryDraft, EditorRecoveryDraftIdentity, EditorRecoveryDraftSummary, EditorRecoveryDraftVersion,
  EditorRecoveryDraftWrite, EditorRecoveryReceipt, EditorRecoveryWorkspace
} from '../shared/editor-recovery-drafts'

const MAX_RECORDS_PER_WRITE = 256
const MAX_BYTES_PER_WRITE = 128 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/

function invalid(): never { throw new Error('Invalid editor recovery draft request.') }
function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
function payloadHash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

export function sameEditorRecoveryWorkspace(left: EditorRecoveryWorkspace, right: EditorRecoveryWorkspace): boolean {
  return left.workspaceScope === right.workspaceScope && left.recoveryEpoch === right.recoveryEpoch
}

export function parseEditorRecoveryDraftWrite(input: unknown): EditorRecoveryDraftWrite {
  assertSyncedShape(input, ['workspace', 'records'], ['close'])
  const { workspace, records, close } = input
  assertSyncedShape(workspace, ['workspaceScope', 'recoveryEpoch'])
  if (!isSyncedUuid(workspace.workspaceScope) || !isSyncedUuid(workspace.recoveryEpoch)) invalid()
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_RECORDS_PER_WRITE) invalid()
  if (close !== undefined) {
    assertSyncedShape(close, ['requestId', 'closeGeneration'])
    if (!isSyncedUuid(close.requestId) || !isGeneration(close.closeGeneration)) invalid()
  }
  let bytes = 0
  const keys = new Set<string>()
  for (const record of records) {
    assertSyncedShape(record, ['draftSessionId', 'generation', 'kind', 'targetId', 'payload'])
    const { draftSessionId, generation, kind, targetId, payload } = record
    if (!isSyncedUuid(draftSessionId) || !isGeneration(generation)
      || (kind !== 'document' && kind !== 'group' && kind !== 'source')
      || typeof targetId !== 'string' || !targetId.trim() || targetId.length > 2048
      || typeof payload !== 'string' || !payload.length) invalid()
    const key = JSON.stringify([draftSessionId, kind, targetId])
    bytes += payload.length * 2
    if (bytes > MAX_BYTES_PER_WRITE || keys.has(key)) invalid()
    keys.add(key)
  }
  return input as unknown as EditorRecoveryDraftWrite
}

interface DraftRow {
  record_id: string
  workspace_scope: string
  recovery_epoch: string
  draft_session_id: string
  generation: number
  kind: EditorRecoveryDraftSummary['kind']
  target_id: Buffer
  payload_hash: string
  updated_at: string
}

function summarize(row: DraftRow): EditorRecoveryDraftSummary {
  return { recordId: row.record_id, draftSessionId: row.draft_session_id, generation: row.generation, hash: row.payload_hash,
    workspace: { workspaceScope: row.workspace_scope, recoveryEpoch: row.recovery_epoch }, kind: row.kind,
    targetId: row.target_id.toString('utf16le'), updatedAt: row.updated_at }
}

const DRAFT_COLUMNS = `record_id, workspace_scope, recovery_epoch, draft_session_id, generation, kind, target_id, payload_hash, updated_at`

/** Private local journal. The workspace Store, backup workers and sync code
 * never open this database. Its records cannot grant authority to save a draft. */
export class EditorRecoveryDraftRepository {
  private connection: Database.Database | null = null
  private readonly filename: string

  constructor(storagePath: string) { this.filename = join(storagePath, 'recovery', 'synced-drafts.sqlite') }

  private open(): Database.Database {
    if (this.connection) return this.connection
    const directory = dirname(this.filename), storage = dirname(directory)
    if (!lstatSync(storage).isDirectory()) throw new Error('Editor recovery storage is not a real directory.')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!lstatSync(directory).isDirectory()) throw new Error('Editor recovery journal directory is not a real directory.')
    const filename = join(realpathSync(directory), 'synced-drafts.sqlite')
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const file = lstatSync(filename + suffix, { throwIfNoEntry: false })
      if (file && (!file.isFile() || file.nlink !== 1)) throw new Error('Editor recovery journal is not an independent local file.')
    }
    const db = new Database(filename, { timeout: 1000 })
    try {
      const version = db.pragma('user_version', { simple: true })
      if (version !== 1 && (version !== 0 || db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())) {
        throw new Error('Unsupported editor recovery journal schema.')
      }
      db.pragma('journal_mode = DELETE')
      db.pragma('synchronous = EXTRA')
      db.pragma('secure_delete = ON')
      if (version === 0) db.transaction(() => db.exec(`
        CREATE TABLE drafts (
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
        ) STRICT;
        PRAGMA user_version = 1;
      `)).immediate()
      this.connection = db
      return db
    } catch (error) { db.close(); throw error }
  }

  private existing(): Database.Database | null {
    return this.connection ?? (lstatSync(this.filename, { throwIfNoEntry: false }) ? this.open() : null)
  }

  write(input: EditorRecoveryDraftWrite, actualWorkspace: EditorRecoveryWorkspace): EditorRecoveryReceipt {
    if (!sameEditorRecoveryWorkspace(input.workspace, actualWorkspace)) throw new Error('The editor recovery workspace changed.')
    const db = this.open(), { workspaceScope, recoveryEpoch } = actualWorkspace
    const find = db.prepare(`SELECT record_id, generation, payload_hash, payload IS NOT NULL AS active FROM drafts
      WHERE workspace_scope = ? AND recovery_epoch = ? AND draft_session_id = ? AND kind = ? AND target_id = ?`)
    const insert = db.prepare(`INSERT INTO drafts (${DRAFT_COLUMNS}, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const update = db.prepare('UPDATE drafts SET generation = ?, payload_hash = ?, updated_at = ?, payload = ? WHERE record_id = ?')
    const records = db.transaction(() => input.records.map(record => {
      const { draftSessionId, generation, kind } = record
      const targetId = Buffer.from(record.targetId, 'utf16le'), payload = Buffer.from(record.payload, 'utf16le')
      const hash = payloadHash(payload), updatedAt = new Date().toISOString()
      const previous = find.get(workspaceScope, recoveryEpoch, draftSessionId, kind, targetId) as
        { record_id: string; generation: number; payload_hash: string; active: number } | undefined
      const recordId = previous?.record_id ?? randomUUID()
      if (!previous) insert.run(recordId, workspaceScope, recoveryEpoch, draftSessionId, generation, kind, targetId, hash, updatedAt, payload)
      else if (generation > previous.generation) update.run(generation, hash, updatedAt, payload, recordId)
      else if (generation !== previous.generation || hash !== previous.payload_hash || !previous.active) {
        throw new Error('The editor recovery draft generation is stale or already used.')
      }
      return { recordId, draftSessionId, generation, hash }
    })).immediate()
    return { receiptId: randomUUID(), records, ...input.close }
  }

  list(): EditorRecoveryDraftSummary[] {
    const db = this.existing()
    return db ? (db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE payload IS NOT NULL ORDER BY updated_at DESC, record_id`).all() as DraftRow[]).map(summarize) : []
  }

  read(recordId: unknown): EditorRecoveryDraft | null {
    if (!isSyncedUuid(recordId)) invalid()
    const row = this.existing()?.prepare(`SELECT ${DRAFT_COLUMNS}, payload FROM drafts WHERE record_id = ? AND payload IS NOT NULL`).get(recordId) as
      (DraftRow & { payload: Buffer }) | undefined
    if (!row) return null
    if (row.payload.length % 2 || payloadHash(row.payload) !== row.payload_hash) throw new Error('Editor recovery draft bytes do not match the durable hash.')
    return { ...summarize(row), payload: row.payload.toString('utf16le') }
  }

  discard(value: unknown): boolean {
    assertSyncedShape(value, ['recordId', 'generation', 'hash'])
    const { recordId, generation, hash } = value as unknown as EditorRecoveryDraftIdentity
    if (!isSyncedUuid(recordId) || !isGeneration(generation) || typeof hash !== 'string' || !SHA256.test(hash)) invalid()
    const result = this.existing()?.prepare(`UPDATE drafts SET payload = NULL WHERE record_id = ? AND generation = ? AND payload_hash = ? AND payload IS NOT NULL`)
      .run(recordId, generation, hash)
    return result?.changes === 1
  }

  confirm(workspace: EditorRecoveryWorkspace, records: readonly EditorRecoveryDraftVersion[]): boolean {
    const db = this.existing()
    if (!db || !records.length) return false
    return db.transaction(() => records.every(version => {
      const draft = this.read(version.recordId)
      return draft !== null && sameEditorRecoveryWorkspace(workspace, draft.workspace)
        && draft.draftSessionId === version.draftSessionId && draft.generation === version.generation && draft.hash === version.hash
    }))()
  }

  close(): void { this.connection?.close(); this.connection = null }
}
