import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import { editorRecoveryInvalid, editorRecoveryRecordJson, validateEditorRecoveryBase, validateEditorRecoveryDraftInput,
  validateEditorRecoveryReceipt, validateEditorRecoveryRecord, type EditorRecoveryBase, type EditorRecoveryDecision,
  type EditorRecoveryDraftInput, type EditorRecoveryReceipt, type EditorRecoveryRecord, type EditorRecoveryRecordSummary } from '../../shared/editor-recovery-drafts'
import { assertIndependentRecoveryJournal, LegacyEditorRecoveryDraftStore } from './legacy-draft-store'

const APPLICATION_ID = 0x4b425244
const SCHEMA_VERSION = 1
const SCHEMA = `
CREATE TABLE recovery_bases (
 base_id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL CHECK(typeof(payload)='blob'), payload_hash TEXT NOT NULL
);
CREATE TABLE recovery_records (
 record_id TEXT PRIMARY KEY NOT NULL, draft_session_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 previous_record_id TEXT, base_id TEXT NOT NULL REFERENCES recovery_bases(base_id), captured_at TEXT NOT NULL,
 payload BLOB NOT NULL CHECK(typeof(payload)='blob'), payload_hash TEXT NOT NULL,
 UNIQUE(draft_session_id,generation)
);
CREATE TABLE recovery_heads (
 draft_session_id TEXT PRIMARY KEY NOT NULL, record_id TEXT UNIQUE NOT NULL REFERENCES recovery_records(record_id),
 generation INTEGER NOT NULL CHECK(generation>0), payload_hash TEXT NOT NULL
);
CREATE TABLE recovery_receipts (
 receipt_id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL CHECK(typeof(payload)='blob'), payload_hash TEXT NOT NULL
);
CREATE TABLE recovery_receipt_records (
 receipt_id TEXT NOT NULL REFERENCES recovery_receipts(receipt_id) ON DELETE CASCADE,
 record_id TEXT NOT NULL REFERENCES recovery_records(record_id), PRIMARY KEY(receipt_id,record_id)
);
CREATE TABLE recovery_decisions (
 record_id TEXT PRIMARY KEY NOT NULL REFERENCES recovery_records(record_id) ON DELETE CASCADE, decision TEXT NOT NULL CHECK(decision IN('restore-draft','keep','discard')),
 decided_at TEXT NOT NULL
);
CREATE TRIGGER recovery_records_no_update BEFORE UPDATE ON recovery_records BEGIN SELECT RAISE(ABORT,'immutable recovery record'); END;
CREATE TRIGGER recovery_receipts_no_update BEFORE UPDATE ON recovery_receipts BEGIN SELECT RAISE(ABORT,'immutable recovery receipt'); END;
CREATE TRIGGER recovery_bases_no_update BEFORE UPDATE ON recovery_bases BEGIN SELECT RAISE(ABORT,'immutable recovery base'); END;
`
type BasePointer = { baseId: string; hash: string }
type Stored = { record_id: string; draft_session_id: string; generation: number; previous_record_id: string | null; base_id: string; captured_at: string; payload: Buffer; payload_hash: string }
type Head = { draft_session_id: string; record_id: string; generation: number; payload_hash: string }
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null }
const schemaRows = (db: Database.Database) => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all() as SchemaRow[]
let expectedSchema: string | undefined
function schemaSignature(): string {
  if (expectedSchema) return expectedSchema
  const db = new Database(':memory:')
  try { db.exec(SCHEMA); return expectedSchema = JSON.stringify(schemaRows(db)) } finally { db.close() }
}
export function editorRecoveryHash(kind: 'record' | 'receipt' | 'capture' | 'base', bytes: Uint8Array | string): string {
  return createHash('sha256').update('knowbook.editor-recovery.' + kind + '.v1\0').update(bytes).digest('hex')
}
function safeDirectory(directory: string): void {
  const absolute = resolve(directory), root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    if (!existsSync(current)) continue
    const info = lstatSync(current)
    if (info.isSymbolicLink() || !info.isDirectory()) return editorRecoveryInvalid('recovery directory follows a link or non-directory')
  }
}
function assertSchema(db: Database.Database): void {
  if (db.pragma('application_id', { simple: true }) !== APPLICATION_ID || db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION
    || JSON.stringify(schemaRows(db)) !== schemaSignature()) return editorRecoveryInvalid('unknown/corrupt private side-store schema')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) return editorRecoveryInvalid('side-store foreign keys disabled')
}
function decodeJson(bytes: Buffer): unknown {
  if (!Buffer.isBuffer(bytes)) return editorRecoveryInvalid('exact side-store BLOB required')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return editorRecoveryInvalid('invalid UTF8/JSON side-store BLOB') }
  return value
}
const receiptJson = (receipt: EditorRecoveryReceipt) => JSON.stringify(validateEditorRecoveryReceipt(receipt))
function basePointer(value: unknown): BasePointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return editorRecoveryInvalid('base pointer required')
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields)
  if (keys.length !== 2 || keys.some(key => typeof key !== 'string' || !['baseId', 'hash'].includes(key)
    || !fields[key].enumerable || !('value' in fields[key]))) return editorRecoveryInvalid('closed base pointer required')
  const baseId = fields.baseId.value, hash = fields.hash.value
  if (typeof baseId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(baseId)
    || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return editorRecoveryInvalid('base pointer identity/hash differs')
  return { baseId, hash }
}
function storedJson(value: EditorRecoveryRecord, base: BasePointer, previousRecordId: string | null): string {
  return JSON.stringify({ kind: 'knowbook-editor-recovery-stored-draft', version: 1, recordId: value.recordId, capturedAt: value.capturedAt,
    base, previousRecordId, draft: value.draft, writePermit: false, businessOperationCommitted: false,
    ...(value.canonicalOriginalAliasHash === undefined ? {} : { canonicalOriginalAliasHash: value.canonicalOriginalAliasHash }) })
}

/** Owns only a local private side database, never the canonical workspace DB.
 * No method in this class executes/repairs/replays a business operation. */
export class EditorRecoveryDraftStore {
  private readonly db: Database.Database
  readonly file: string
  readonly legacy: LegacyEditorRecoveryDraftStore | null
  constructor(directory: string, options: { readonly?: boolean } = {}) {
    safeDirectory(directory)
    if (!options.readonly) { mkdirSync(directory, { recursive: true }); safeDirectory(directory) }
    const original = join(resolve(directory), 'synced-drafts.sqlite')
    const alternate = join(resolve(directory), 'synced-drafts-v2.sqlite')
    const legacy = new LegacyEditorRecoveryDraftStore(original)
    this.legacy = legacy.exists() ? legacy : null
    const useAlternate = this.legacy || (!existsSync(original) && existsSync(alternate))
    this.file = useAlternate ? alternate : original
    assertIndependentRecoveryJournal(this.file)
    this.db = new Database(this.file, { readonly: options.readonly === true, fileMustExist: options.readonly === true })
    try {
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('trusted_schema = OFF')
      this.db.pragma('secure_delete = ON')
      // Require the existing physical mode instead of converting an alien DB.
      // FULL synchronous is connection-local; no persistent PRAGMA precedes the
      // actual locked empty/schema decision. A parallel initializer may have
      // populated the file since its path was selected.
      if (String(this.db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'delete') return editorRecoveryInvalid('private journal durability mode refused')
      if (!options.readonly) {
        this.db.pragma('synchronous = FULL')
        if (this.db.pragma('synchronous', { simple: true }) !== 2) return editorRecoveryInvalid('private journal full synchronous mode refused')
        this.db.transaction(() => {
          const empty = schemaRows(this.db).length === 0 && this.db.pragma('application_id', { simple: true }) === 0 && this.db.pragma('user_version', { simple: true }) === 0
          if (empty) { this.db.exec(SCHEMA); this.db.pragma('application_id = ' + APPLICATION_ID); this.db.pragma('user_version = ' + SCHEMA_VERSION) }
          else assertSchema(this.db)
        }).immediate()
      } else this.db.transaction(() => assertSchema(this.db))()
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { if (this.db.open) this.db.close() }
  private ownRead<T>(read: () => T): T {
    if (!this.db.open || this.db.inTransaction) return editorRecoveryInvalid('read requires its own actual committed SQL snapshot')
    return this.db.transaction(() => { assertSchema(this.db); return read() })()
  }
  /** The actual live Main source producer calls this before publishing an
   * editor draft owner. Its registry retains only this immutable pointer. */
  sealBase(input: EditorRecoveryBase): { baseId: string; hash: string } {
    if (this.db.readonly || this.db.inTransaction) return editorRecoveryInvalid('base capture requires own side-store commit')
    const base = validateEditorRecoveryBase(input), raw = JSON.stringify(base)
    const pointer = this.db.transaction(() => { assertSchema(this.db); return this.sealBaseOwned(base) }).immediate()
    if (JSON.stringify(this.readBase(pointer)) !== raw) return editorRecoveryInvalid('base did not independently read back')
    return pointer
  }
  private sealBaseOwned(base: EditorRecoveryBase): BasePointer {
    const raw = Buffer.from(JSON.stringify(base)), baseId = randomUUID(), hash = editorRecoveryHash('base', raw)
    this.db.prepare('INSERT INTO recovery_bases VALUES(?,?,?)').run(baseId, raw, hash)
    return { baseId, hash }
  }
  readBase(expected: { baseId: string; hash: string }): EditorRecoveryBase {
    return this.ownRead(() => this.readBaseOwned(expected))
  }
  private readBaseOwned(expected: { baseId: string; hash: string }): EditorRecoveryBase {
    expected = basePointer(expected)
    const row = this.db.prepare('SELECT payload,payload_hash FROM recovery_bases WHERE base_id=?').get(expected.baseId) as { payload: Buffer; payload_hash: string } | undefined
    if (!row || row.payload_hash !== expected.hash || editorRecoveryHash('base', row.payload) !== row.payload_hash) return editorRecoveryInvalid('base absent or exact BLOB hash differs')
    const base = validateEditorRecoveryBase(decodeJson(row.payload))
    if (JSON.stringify(base) !== row.payload.toString('utf8')) return editorRecoveryInvalid('base closed bytes differ')
    return base
  }
  private actualRecord(recordId: string): { value: EditorRecoveryRecord; hash: string } {
    const row = this.db.prepare('SELECT * FROM recovery_records WHERE record_id=?').get(recordId) as Stored | undefined
    if (!row || editorRecoveryHash('record', row.payload) !== row.payload_hash) return editorRecoveryInvalid('record absent or actual BLOB hash differs')
    const stored = decodeJson(row.payload) as Record<string, unknown>
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.kind !== 'knowbook-editor-recovery-stored-draft' || stored.version !== 1)
      return editorRecoveryInvalid('stored record domain differs')
    const pointer = basePointer(stored.base), base = this.readBaseOwned(pointer)
    const value = validateEditorRecoveryRecord({ kind: 'knowbook-editor-recovery-draft', version: 1, recordId: stored.recordId,
      capturedAt: stored.capturedAt, base, draft: stored.draft, writePermit: stored.writePermit, businessOperationCommitted: stored.businessOperationCommitted,
      ...(Object.hasOwn(stored, 'canonicalOriginalAliasHash') ? { canonicalOriginalAliasHash: stored.canonicalOriginalAliasHash } : {}) })
    if (storedJson(value, pointer, row.previous_record_id) !== row.payload.toString('utf8') || pointer.baseId !== row.base_id
      || value.recordId !== row.record_id || value.capturedAt !== row.captured_at
      || value.draft.draftSessionId !== row.draft_session_id || value.draft.generation !== row.generation) return editorRecoveryInvalid('record columns/closed bytes differ')
    if (row.previous_record_id === null) { if (row.generation !== 1) return editorRecoveryInvalid('noninitial generation has no predecessor') }
    else {
      const previous = this.db.prepare('SELECT draft_session_id,generation FROM recovery_records WHERE record_id=?').get(row.previous_record_id) as { draft_session_id: string; generation: number } | undefined
      // Superseded bodies may be reclaimed only after a newer durable head.
      // The complete current payload still commits its exact previous ID and
      // expected generation; a retained predecessor must agree when present.
      if (row.generation === 1 || typeof row.previous_record_id !== 'string'
        || previous && (previous.draft_session_id !== row.draft_session_id || previous.generation + 1 !== row.generation)) return editorRecoveryInvalid('generation predecessor differs')
    }
    return { value, hash: row.payload_hash }
  }
  private currentHead(sessionId: string): Head | undefined {
    const head = this.db.prepare('SELECT * FROM recovery_heads WHERE draft_session_id=?').get(sessionId) as Head | undefined
    if (head) {
      const record = this.actualRecord(head.record_id)
      if (record.hash !== head.payload_hash || record.value.draft.draftSessionId !== sessionId || record.value.draft.generation !== head.generation) return editorRecoveryInvalid('head does not bind its exact record')
    }
    return head
  }
  /** bases are Main-owned facts, never an IPC proof/DTO supplied by renderer. */
  write(captures: readonly { base: EditorRecoveryBase | BasePointer; draft: EditorRecoveryDraftInput; canonicalOriginalAliasHash?: string }[], purpose:
    { kind: 'background' } | { kind: 'close'; requestId: string; closeGeneration: number }): EditorRecoveryReceipt {
    if (this.db.readonly || this.db.inTransaction) return editorRecoveryInvalid('write requires own writable side-store transaction')
    const values = captures.map(item => ({ base: Object.hasOwn(item.base, 'baseId') ? basePointer(item.base) : validateEditorRecoveryBase(item.base),
      draft: validateEditorRecoveryDraftInput(item.draft), canonicalOriginalAliasHash: item.canonicalOriginalAliasHash }))
    if (new Set(values.map(item => item.draft.draftSessionId)).size !== values.length) return editorRecoveryInvalid('capture repeats draft owner')
    const receipt: EditorRecoveryReceipt = validateEditorRecoveryReceipt({ kind: 'knowbook-editor-recovery-receipt', version: 1, receiptId: randomUUID(),
      purpose: purpose.kind, requestId: purpose.kind === 'close' ? purpose.requestId : null, closeGeneration: purpose.kind === 'close' ? purpose.closeGeneration : null, records: [] })
    this.db.transaction(() => {
      assertSchema(this.db)
      for (const item of values) {
        const head = this.currentHead(item.draft.draftSessionId)
        if (head?.generation !== item.draft.generation && (head?.generation ?? 0) !== item.draft.expectedPreviousGeneration) return editorRecoveryInvalid('stale capture generation')
        const original = head && this.actualRecord(head.record_id)
        let pointer: BasePointer
        if (Object.hasOwn(item.base, 'baseId')) pointer = basePointer(item.base)
        else if (head) {
          const row = this.db.prepare('SELECT base_id FROM recovery_records WHERE record_id=?').get(head.record_id) as { base_id: string }
          const existing = this.db.prepare('SELECT payload_hash FROM recovery_bases WHERE base_id=?').get(row.base_id) as { payload_hash: string }
          pointer = { baseId: row.base_id, hash: existing.payload_hash }
        } else pointer = this.sealBaseOwned(item.base as EditorRecoveryBase)
        const base = this.readBaseOwned(pointer)
        if (!Object.hasOwn(item.base, 'baseId') && JSON.stringify(base) !== JSON.stringify(item.base)) return editorRecoveryInvalid('a draft owner cannot replace its original base')
        if (head?.generation === item.draft.generation) {
          if (JSON.stringify(original!.value.base) !== JSON.stringify(base) || JSON.stringify(original!.value.draft) !== JSON.stringify(item.draft)) return editorRecoveryInvalid('same generation has a different complete capture')
          receipt.records.push({ recordId: head.record_id, draftSessionId: head.draft_session_id, generation: head.generation, hash: head.payload_hash }); continue
        }
        if ((head?.generation ?? 0) !== item.draft.expectedPreviousGeneration) return editorRecoveryInvalid('stale capture generation')
        const record = validateEditorRecoveryRecord({ kind: 'knowbook-editor-recovery-draft', version: 1, recordId: randomUUID(), capturedAt: new Date().toISOString(),
          base, draft: item.draft, writePermit: false, businessOperationCommitted: false,
          ...(item.canonicalOriginalAliasHash === undefined ? {} : { canonicalOriginalAliasHash: item.canonicalOriginalAliasHash }) })
        if (original && JSON.stringify(original.value.base) !== JSON.stringify(base)) return editorRecoveryInvalid('generation changed its original base')
        const previous = head?.record_id ?? null, raw = Buffer.from(storedJson(record, pointer, previous)), hash = editorRecoveryHash('record', raw)
        this.db.prepare('INSERT INTO recovery_records VALUES(?,?,?,?,?,?,?,?)').run(record.recordId, item.draft.draftSessionId, item.draft.generation,
          previous, pointer.baseId, record.capturedAt, raw, hash)
        this.db.prepare('INSERT INTO recovery_heads VALUES(?,?,?,?) ON CONFLICT(draft_session_id) DO UPDATE SET record_id=excluded.record_id,generation=excluded.generation,payload_hash=excluded.payload_hash')
          .run(item.draft.draftSessionId, record.recordId, item.draft.generation, hash)
        const actual = this.actualRecord(record.recordId)
        if (actual.hash !== hash || editorRecoveryRecordJson(actual.value) !== editorRecoveryRecordJson(record)) return editorRecoveryInvalid('new record did not independently read back')
        receipt.records.push({ recordId: record.recordId, draftSessionId: item.draft.draftSessionId, generation: item.draft.generation, hash })
      }
      const raw = Buffer.from(receiptJson(receipt))
      this.db.prepare('INSERT INTO recovery_receipts VALUES(?,?,?)').run(receipt.receiptId, raw, editorRecoveryHash('receipt', raw))
      const link = this.db.prepare('INSERT INTO recovery_receipt_records VALUES(?,?)')
      for (const item of receipt.records) link.run(receipt.receiptId, item.recordId)
    }).immediate()
    // The exact real COMMIT with synchronous=FULL happened before this read.
    // A COMMIT error never returns a receipt; independent cold-process tests
    // establish the actual on-disk reopen behavior rather than a memory claim.
    return this.readReceipt(receipt.receiptId, true)
  }
  readReceipt(receiptId: string, requireCurrent = false): EditorRecoveryReceipt {
    return this.ownRead(() => this.readReceiptOwned(receiptId, requireCurrent))
  }
  private readReceiptOwned(receiptId: string, requireCurrent: boolean): EditorRecoveryReceipt {
    const row = this.db.prepare('SELECT payload,payload_hash FROM recovery_receipts WHERE receipt_id=?').get(receiptId) as { payload: Buffer; payload_hash: string } | undefined
    if (!row || editorRecoveryHash('receipt', row.payload) !== row.payload_hash) return editorRecoveryInvalid('receipt absent or BLOB hash differs')
    const receipt = validateEditorRecoveryReceipt(decodeJson(row.payload))
    if (receipt.receiptId !== receiptId || receiptJson(receipt) !== row.payload.toString('utf8')) return editorRecoveryInvalid('receipt columns/closed bytes differ')
    const links = this.db.prepare('SELECT record_id FROM recovery_receipt_records WHERE receipt_id=? ORDER BY record_id').all(receiptId) as Array<{ record_id: string }>
    if (JSON.stringify(links.map(item => item.record_id)) !== JSON.stringify(receipt.records.map(item => item.recordId).sort())) return editorRecoveryInvalid('receipt exact record relation differs')
    for (const item of receipt.records) {
      const record = this.actualRecord(item.recordId)
      if (record.hash !== item.hash || record.value.draft.draftSessionId !== item.draftSessionId || record.value.draft.generation !== item.generation) return editorRecoveryInvalid('receipt does not cover exact record')
      if (requireCurrent && this.currentHead(item.draftSessionId)?.record_id !== item.recordId) return editorRecoveryInvalid('receipt no longer covers latest head')
      if (requireCurrent && (this.db.prepare('SELECT decision FROM recovery_decisions WHERE record_id=?').get(item.recordId) as { decision: string } | undefined)?.decision === 'discard') return editorRecoveryInvalid('receipt contains a discarded record')
    }
    return receipt
  }
  read(expected: { recordId: string; generation: number; hash: string }): EditorRecoveryRecord {
    return this.ownRead(() => {
      const actual = this.actualRecord(expected.recordId)
      if (actual.hash !== expected.hash || actual.value.draft.generation !== expected.generation) return editorRecoveryInvalid('read generation/hash differs')
      return actual.value
    })
  }
  list(input: { afterSessionId?: string; limit: number; excludeSessionIds?: readonly string[] }): { records: EditorRecoveryRecordSummary[]; next: string | null } {
    return this.ownRead(() => this.listOwned(input))
  }
  private listOwned(input: { afterSessionId?: string; limit: number; excludeSessionIds?: readonly string[] }): { records: EditorRecoveryRecordSummary[]; next: string | null } {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || input.afterSessionId !== undefined && typeof input.afterSessionId !== 'string') return editorRecoveryInvalid('page invalid')
    const heads = this.db.prepare(`SELECT h.* FROM recovery_heads h LEFT JOIN recovery_decisions d ON d.record_id=h.record_id
      WHERE (d.decision IS NULL OR d.decision!='discard') AND h.draft_session_id>?
      AND h.draft_session_id NOT IN (SELECT value FROM json_each(?)) ORDER BY h.draft_session_id LIMIT ?`)
      .all(input.afterSessionId ?? '', JSON.stringify(input.excludeSessionIds ?? []), input.limit + 1) as Head[]
    const page = heads.slice(0, input.limit), records = page.map(head => {
      const actual = this.actualRecord(head.record_id), { value } = actual
      if (head.payload_hash !== actual.hash || head.generation !== value.draft.generation || head.draft_session_id !== value.draft.draftSessionId) return editorRecoveryInvalid('page head differs')
      return { recordId: value.recordId, draftSessionId: value.draft.draftSessionId, generation: value.draft.generation, hash: actual.hash,
        capturedAt: value.capturedAt, owner: value.base.owner, workspaceScope: value.base.workspaceScope, recoveryEpoch: value.base.recoveryEpoch,
        displayTitle: value.draft.working.kind === 'host' ? value.draft.working.title : value.draft.working.blocks.map(block => block.content).find(content => content.trim())?.slice(0, 120) ?? '' }
    })
    return { records, next: heads.length > input.limit ? page.at(-1)!.draft_session_id : null }
  }
  decide(expected: { recordId: string; generation: number; hash: string }, decision: EditorRecoveryDecision): void {
    if (!['restore-draft', 'keep', 'discard'].includes(decision) || this.db.readonly || this.db.inTransaction) return editorRecoveryInvalid('decision invalid')
    this.db.transaction(() => {
      assertSchema(this.db)
      const read = this.actualRecord(expected.recordId)
      if (read.hash !== expected.hash || read.value.draft.generation !== expected.generation) return editorRecoveryInvalid('decision generation/hash differs')
      const actual = read.value, head = this.currentHead(actual.draft.draftSessionId)
      if (head?.record_id !== actual.recordId) return editorRecoveryInvalid('old decision cannot affect newer draft')
      const prior = this.db.prepare('SELECT decision FROM recovery_decisions WHERE record_id=?').get(actual.recordId) as { decision: string } | undefined
      if (prior?.decision === 'discard' && decision !== 'discard') return editorRecoveryInvalid('discarded capture cannot be silently revived')
      this.db.prepare('INSERT INTO recovery_decisions VALUES(?,?,?) ON CONFLICT(record_id) DO UPDATE SET decision=excluded.decision,decided_at=excluded.decided_at')
        .run(actual.recordId, decision, new Date().toISOString())
      if (decision === 'discard') this.db.prepare('DELETE FROM recovery_heads WHERE draft_session_id=? AND record_id=? AND generation=? AND payload_hash=?')
        .run(actual.draft.draftSessionId, actual.recordId, expected.generation, expected.hash)
    }).immediate()
  }
  head(sessionId: string): { record: EditorRecoveryRecord; expected: { recordId: string; generation: number; hash: string } } | null {
    return this.ownRead(() => {
      const head = this.currentHead(sessionId)
      return head ? { record: this.actualRecord(head.record_id).value, expected: { recordId: head.record_id, generation: head.generation, hash: head.payload_hash } } : null
    })
  }
  /** Reclaim superseded private drafts, not canonical history. Every retained
   * head is independently checked. Explicit current discard first requires its
   * expected generation/hash in decide(); a newer head cannot be collected.
   * Main supplies the actual still-live base IDs, never an IPC allowlist. */
  collectGarbage(liveBaseIds: readonly string[], retainedReceiptIds: readonly string[] = []): { records: number; receipts: number; bases: number } {
    if (this.db.readonly || this.db.inTransaction || new Set(liveBaseIds).size !== liveBaseIds.length
      || new Set(retainedReceiptIds).size !== retainedReceiptIds.length) return editorRecoveryInvalid('private garbage collection requires own write snapshot')
    return this.db.transaction(() => {
      assertSchema(this.db)
      for (const row of this.db.prepare('SELECT draft_session_id FROM recovery_heads').all() as Array<{ draft_session_id: string }>) this.currentHead(row.draft_session_id)
      for (const id of retainedReceiptIds) this.readReceiptOwned(id, true)
      // Any receipt with an older member can no longer authorize whole-window
      // close. Remove its relation before removing obsolete record bodies.
      const receipts = this.db.prepare(`DELETE FROM recovery_receipts WHERE receipt_id IN (
        SELECT r.receipt_id FROM recovery_receipts r WHERE r.receipt_id NOT IN (SELECT value FROM json_each(?)) OR EXISTS (
          SELECT 1 FROM recovery_receipt_records m LEFT JOIN recovery_heads h ON h.record_id=m.record_id
          WHERE m.receipt_id=r.receipt_id AND h.record_id IS NULL))`).run(JSON.stringify(retainedReceiptIds)).changes
      const records = this.db.prepare('DELETE FROM recovery_records WHERE record_id NOT IN (SELECT record_id FROM recovery_heads) AND record_id NOT IN (SELECT record_id FROM recovery_receipt_records)').run().changes
      const bases = this.db.prepare('DELETE FROM recovery_bases WHERE base_id NOT IN (SELECT base_id FROM recovery_records) AND base_id NOT IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify(liveBaseIds)).changes
      return { records, receipts, bases }
    }).immediate()
  }
}
