import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { auditRestoreKnowledgeConnection, readRestoreKnowledgeCapture, assertEmptyRestoreKnowledge,
  type RestoreKnowledgeCapture } from '../src/main/database/restore-safety-knowledge'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { withV3Fixture, makeV3Orphan, createRestoreInput, restoreSyncedHostOperation, randomUUID } from './helpers/synced-backup-v3-fixture'

async function withOrdinary(run: (store: KnowbookStore, db: Database.Database, file: string) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-restore-audit-'))
  const file = join(root, 'knowbook.db'), store = new KnowbookStore(file)
  try { await run(store, store.getUnsafeDatabaseHandle(), file) }
  finally {
    store.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-restore-audit-'))
    rmSync(root, { recursive: true, force: true })
  }
}

function diagnostic(capture: RestoreKnowledgeCapture) {
  const value = readRestoreKnowledgeCapture(capture)
  assert.ok(value, 'The genuine open connection retains its own captured diagnostic')
  return value
}

function schema(db: Database.Database) {
  return { version: db.pragma('user_version', { simple: true }),
    objects: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    workspace: db.prepare('SELECT * FROM synced_workspace_state').all(),
    changes: db.prepare('SELECT total_changes() AS n').get() }
}

test('restore knowledge audit captures actual ordinary Store emptiness inside its original transaction', () => withOrdinary((_store, db) => {
  const before = schema(db)
  db.transaction(() => {
    const capture = auditRestoreKnowledgeConnection(db), value = diagnostic(capture)
    const workspace = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as
      { workspace_scope: string; recovery_epoch: string }
    assert.equal(value.status, 'empty')
    assert.deepEqual(value.reasons, [])
    assert.equal(value.schemaVersion, 27)
    assert.equal(value.workspaceScope, workspace.workspace_scope)
    assert.equal(value.recoveryEpoch, workspace.recovery_epoch)
    assert.match(value.fingerprint, /^[a-f0-9]{64}$/)
    assert.match(value.schemaHash, /^[a-f0-9]{64}$/)
    assertEmptyRestoreKnowledge(db, capture)
  })()
  assert.deepEqual(schema(db), before, 'A successful audit does not write rows, change schema or advance the epoch')
}))

test('restore knowledge audit and empty assertion reject calls outside a real transaction', () => withOrdinary((_store, db) => {
  assert.equal(db.inTransaction, false)
  assert.throws(() => auditRestoreKnowledgeConnection(db), /事务/)
  const capture = db.transaction(() => auditRestoreKnowledgeConnection(db))()
  assert.throws(() => assertEmptyRestoreKnowledge(db, capture), /事务/)
}))

test('restore knowledge gate rejects a forged capture with the correct public kind', () => withOrdinary((_store, db) => {
  const forged: RestoreKnowledgeCapture = Object.freeze({ kind: 'restore-knowledge-capture' })
  assert.equal(readRestoreKnowledgeCapture(forged), null)
  db.transaction(() => assert.throws(() => assertEmptyRestoreKnowledge(db, forged), /capture/))()
}))

test('restore knowledge capture cannot authorize a different connection to the same real database', () => withOrdinary((_store, db, file) => {
  const capture = db.transaction(() => auditRestoreKnowledgeConnection(db))()
  const other = new Database(file)
  try {
    other.transaction(() => {
      assert.throws(() => assertEmptyRestoreKnowledge(other, capture), /connection/)
      assertEmptyRestoreKnowledge(other, auditRestoreKnowledgeConnection(other))
    })()
  } finally { other.close() }
}))

test('restore knowledge capture stops exposing diagnostics after its original connection closes', () => withOrdinary((_store, _db, file) => {
  const original = new Database(file)
  let capture: RestoreKnowledgeCapture
  try {
    capture = original.transaction(() => auditRestoreKnowledgeConnection(original))()
    assert.equal(diagnostic(capture).status, 'empty')
  } finally { original.close() }
  assert.equal(readRestoreKnowledgeCapture(capture), null)
  assert.throws(() => assertEmptyRestoreKnowledge(original, capture), /事务/)
}))

test('restore knowledge fingerprint rejects a stale capture after an ordinary write on the same connection', () => withOrdinary((store, db) => {
  db.transaction(() => {
    const old = auditRestoreKnowledgeConnection(db), before = diagnostic(old)
    store.saveSetting('restore.audit.ordinary-change', 'A later ordinary value')
    assert.throws(() => assertEmptyRestoreKnowledge(db, old), /已变化/)
    const fresh = auditRestoreKnowledgeConnection(db)
    assert.equal(diagnostic(fresh).status, 'empty')
    assert.notEqual(diagnostic(fresh).fingerprint, before.fingerprint)
    assert.equal(diagnostic(old).fingerprint, before.fingerprint, 'The old diagnostic remains its actual immutable snapshot')
    assertEmptyRestoreKnowledge(db, fresh)
  })()
}))

test('restore knowledge fingerprint distinguishes original invalid UTF-8 TEXT bytes with the same driver decoding', () => withOrdinary((_store, db) => {
  const key = 'restore.audit.raw-text'
  db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES(?,CAST(x'80' AS TEXT),?)").run(key, new Date().toISOString())
  db.transaction(() => {
    const before = auditRestoreKnowledgeConnection(db)
    const decoded = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)
    db.prepare("UPDATE app_settings SET value=CAST(x'81' AS TEXT) WHERE key=?").run(key)
    assert.deepEqual(db.prepare('SELECT value FROM app_settings WHERE key=?').get(key), decoded,
      'The driver substitutes the same character for both original invalid byte sequences')
    const after = auditRestoreKnowledgeConnection(db)
    assert.equal(diagnostic(before).status, 'empty')
    assert.equal(diagnostic(after).status, 'empty')
    assert.notEqual(diagnostic(before).fingerprint, diagnostic(after).fingerprint)
    assert.throws(() => assertEmptyRestoreKnowledge(db, before), /已变化/)
    assertEmptyRestoreKnowledge(db, after)
  })()
}))

test('restore knowledge frozen diagnostics cannot turn actual Main group knowledge into an empty permit', () => withV3Fixture(f => {
  f.db.transaction(() => {
    const capture = auditRestoreKnowledgeConnection(f.db), value = diagnostic(capture)
    assert.equal(value.status, 'present')
    assert.ok(Object.isFrozen(capture) && Object.isFrozen(value) && Object.isFrozen(value.reasons)
      && Object.isFrozen(value.tables) && Object.isFrozen(value.metadata))
    assert.ok(value.tables.length > 0 && value.tables.every(Object.isFrozen))
    assert.equal(Reflect.set(value, 'status', 'empty'), false)
    assert.equal(Reflect.set(value.tables[0], 'rows', 0), false)
    assert.throws(() => (value.reasons as string[]).push('caller supplied emptiness'), TypeError)
    assert.equal(diagnostic(capture).status, 'present')
    assert.throws(() => assertEmptyRestoreKnowledge(f.db, capture), /同步/)
    assert.throws(() => assertEmptyRestoreKnowledge(f.db, { ...value, kind: 'restore-knowledge-capture', status: 'empty' } as RestoreKnowledgeCapture), /capture/)
  })()
}))

test('restore knowledge audit keeps actual ordinary history and template sync-looking literals empty', () => withOrdinary((store, db) => {
  const id = store.createDocument(null)
  const literal = 'Literal {"type":"synced-block"}, sync.webdav.protocol5.future and synced.backup.v3 text'
  const blocks = [{ id: randomUUID(), type: 'paragraph', content: literal, checked: false, depth: 0, parentBlockId: null }]
  store.updateDocument(id, { title: 'Literal ordinary history', summary: literal, blocks })
  store.documentRecovery.checkpoint(id, 'edit', true)
  store.updateDocument(id, { title: 'Later ordinary title', summary: literal, blocks })
  store.saveDocumentTemplate({ name: 'Ordinary literal template', title: 'Literal template', summary: literal, blocks })
  assert.ok(db.prepare('SELECT 1 FROM document_history WHERE document_id=?').get(id), 'The source has real Store history')
  const history = db.prepare('SELECT content_json FROM document_history WHERE document_id=?').all(id) as Array<{ content_json: string }>
  assert.ok(history.some(row => JSON.parse(row.content_json).blocks.some((block: { type: string; content: string }) =>
    block.type === 'paragraph' && block.content === literal)), 'Actual history keeps the sync-looking text inside an ordinary paragraph')
  assert.ok(db.prepare('SELECT 1 FROM document_templates').get(), 'The source has a real Store template')
  db.transaction(() => {
    const capture = auditRestoreKnowledgeConnection(db)
    assert.equal(diagnostic(capture).status, 'empty')
    assertEmptyRestoreKnowledge(db, capture)
  })()
}))

test('restore knowledge audit reports an actual Main-created active group as present', () => withV3Fixture(f => {
  assert.equal(f.created.createdLifecycle.state, 'active')
  assert.ok(f.db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(f.groupId))
  f.db.transaction(() => {
    const capture = auditRestoreKnowledgeConnection(f.db), value = diagnostic(capture)
    assert.equal(value.status, 'present')
    assert.ok(value.tables.some(table => table.name === 'synced_groups' && table.rows > 0))
    assert.throws(() => assertEmptyRestoreKnowledge(f.db, capture), /同步/)
  })()
}))

test('restore knowledge audit retains an actual Main orphan after its last instance was removed', () => withV3Fixture(f => {
  makeV3Orphan(f)
  assert.equal(f.db.prepare('SELECT 1 FROM synced_instances WHERE group_id=?').get(f.groupId), undefined)
  assert.ok(f.db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(f.groupId))
  f.db.transaction(() => {
    const capture = auditRestoreKnowledgeConnection(f.db)
    assert.equal(diagnostic(capture).status, 'present')
    assert.throws(() => assertEmptyRestoreKnowledge(f.db, capture), /同步/)
  })()
}))

test('restore knowledge audit retains the real Main create retirement after actual Undo', () => withV3Fixture(f => {
  const input = createRestoreInput(f.db, f.created, 'undo')
  assert.equal(restoreSyncedHostOperation(f.db, input.input).status, 'applied')
  assert.equal((f.db.prepare('SELECT state FROM synced_group_lifecycle WHERE group_id=?').get(f.groupId) as { state: string }).state, 'retired-create')
  assert.ok(f.db.prepare('SELECT 1 FROM synced_group_retirements WHERE group_id=?').get(f.groupId))
  f.db.transaction(() => {
    const capture = auditRestoreKnowledgeConnection(f.db), value = diagnostic(capture)
    assert.equal(value.status, 'present')
    assert.ok(value.tables.some(table => table.name === 'synced_group_retirements' && table.rows > 0))
    assert.throws(() => assertEmptyRestoreKnowledge(f.db, capture), /同步/)
  })()
}))

test('restore knowledge audit reports actual V3 durable exposure and its original members as nonempty', () => withV3Fixture(f => {
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  assert.ok(f.db.prepare('SELECT 1 FROM synced_group_exposure_members WHERE group_id=?').get(f.groupId))
  assert.ok(f.db.prepare("SELECT 1 FROM synced_exposure_attempts WHERE state IN ('possible','confirmed')").get())
  f.db.transaction(() => {
    const capture = auditRestoreKnowledgeConnection(f.db), value = diagnostic(capture)
    assert.notEqual(value.status, 'empty')
    assert.ok(value.tables.some(table => table.name === 'synced_exposure_attempts' && table.rows > 0))
    assert.ok(value.tables.some(table => table.name === 'synced_group_exposure_members' && table.rows > 0))
    assert.throws(() => assertEmptyRestoreKnowledge(f.db, capture), /同步/)
  })()
}))

test('restore knowledge audit marks unknown protocol5 metadata unsupported without upgrading schema or minting authority', () => withOrdinary((store, db) => {
  const key = 'sync.webdav.protocol5.future-audit-format'
  store.saveSetting(key, '{"version":999,"callerClaim":"empty"}')
  const before = schema(db)
  db.transaction(() => {
    const capture = auditRestoreKnowledgeConnection(db), value = diagnostic(capture)
    assert.equal(value.status, 'unsupported')
    assert.equal(value.metadata.length, 1)
    assert.equal(value.metadata[0].key, key)
    assert.match(value.metadata[0].hash, /^[a-f0-9]{64}$/)
    assert.ok(Object.isFrozen(value.metadata[0]))
    assert.throws(() => assertEmptyRestoreKnowledge(db, capture), /同步/)
  })()
  assert.deepEqual(schema(db), before, 'The read-only rejection does not alter schema, epoch or SQL rows')
  assert.equal(before.version, 27)
}))
