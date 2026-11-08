import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import type { EditorRecoveryBase, EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'kb-recovery-legacy-'))
  const file = join(directory, 'synced-drafts.sqlite')
  const db = new Database(file)
  db.exec(`
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
  `)
  const workspaceScope = randomUUID(), recoveryEpoch = randomUUID()
  const updatedAt = '2026-11-08T01:00:00.000Z'
  const add = (number: number, payload: string | null) => {
    const recordId = `00000000-0000-0000-0000-00000000000${number}`
    const draftSessionId = randomUUID(), generation = 3, targetId = 'source:原稿'
    const bytes = payload === null ? null : Buffer.from(payload, 'utf16le')
    const hash = createHash('sha256').update(bytes ?? '').digest('hex')
    db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?,?,?)').run(recordId, workspaceScope, recoveryEpoch,
      draftSessionId, generation, 'source', Buffer.from(targetId, 'utf16le'), hash, updatedAt, bytes)
    return { recordId, generation, hash }
  }
  return { directory, file, db, workspaceScope, recoveryEpoch, updatedAt, add,
    close() { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }) } }
}

test('existing renderer journal stays byte-exact while the new recovery store writes and reopens its independent journal', () => {
  const f = fixture()
  try {
    const source = '未保存的源码\r\n\u0000\ud800'
    const legacy = f.add(1, source), second = f.add(2, '第二份')
    f.add(3, null)
    f.db.close()
    const before = readFileSync(f.file)
    const store = new EditorRecoveryDraftStore(f.directory)
    const base: EditorRecoveryBase = { workspaceScope: f.workspaceScope, recoveryEpoch: f.recoveryEpoch, originals: [],
      owner: { kind: 'host', documentId: 'original-document', createdAt: f.updatedAt, updatedAt: f.updatedAt },
      persistedWorking: { kind: 'host', title: 'Original title', summary: '', blocks: [] } }
    const draft: EditorRecoveryDraftInput = { draftSessionId: randomUUID(), generation: 1, expectedPreviousGeneration: 0,
      working: { kind: 'host', title: 'Unsaved title', summary: '', blocks: [] }, sources: [], pending: [],
      selection: null, composing: false, importing: false }
    const saved = (() => {
      try {
        assert.equal(store.file, join(f.directory, 'synced-drafts-v2.sqlite'))
        return store.write([{ base, draft }], { kind: 'background' }).records[0]
      } finally { store.close() }
    })()
    const reopened = new EditorRecoveryDraftStore(f.directory, { readonly: true })
    try {
      assert.deepEqual(reopened.read(saved).draft, draft)
      assert.equal(reopened.legacy?.read(legacy)?.payload, source)
      assert.equal(reopened.legacy?.read({ ...legacy, generation: 2 }), null)
      assert.equal(reopened.legacy?.read({ ...legacy, hash: '0'.repeat(64) }), null)
      const firstPage = reopened.legacy!.list({ limit: 1 })
      assert.deepEqual(firstPage.records.map(record => record.recordId), [legacy.recordId])
      assert.equal(firstPage.next, legacy.recordId)
      const secondPage = reopened.legacy!.list({ afterRecordId: firstPage.next!, limit: 1 })
      assert.deepEqual(secondPage.records.map(record => record.recordId), [second.recordId])
      assert.equal(secondPage.next, null)
    } finally { reopened.close() }
    assert.deepEqual(readFileSync(f.file), before)
  } finally { f.close() }
})

test('legacy draft hash mismatch refuses the damaged bytes while the current recovery store remains usable', () => {
  const f = fixture()
  try {
    const legacy = f.add(1, '原件')
    f.db.prepare('UPDATE drafts SET payload = ? WHERE record_id = ?').run(Buffer.from('错误正文', 'utf16le'), legacy.recordId)
    f.db.close()
    const before = readFileSync(f.file), store = new EditorRecoveryDraftStore(f.directory)
    try {
      assert.throws(() => store.legacy!.read(legacy), /bytes differ/)
      assert.deepEqual(store.list({ limit: 1 }), { records: [], next: null })
    } finally { store.close() }
    assert.deepEqual(readFileSync(f.file), before)
  } finally { f.close() }
})

test('an unknown same-version schema stays refused and is not treated as an older editor journal', () => {
  const f = fixture()
  try {
    f.db.exec('CREATE TABLE unrelated (value TEXT) STRICT')
    f.db.close()
    const before = readFileSync(f.file)
    assert.throws(() => new EditorRecoveryDraftStore(f.directory), /unknown\/corrupt private side-store schema/)
    assert.deepEqual(readFileSync(f.file), before)
  } finally { f.close() }
})
