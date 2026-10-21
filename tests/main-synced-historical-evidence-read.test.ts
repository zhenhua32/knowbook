import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { KnowbookStore } from '../src/main/database/store'
import { assertRawSyncedHistoricalEvidenceOwned } from '../src/main/database/synced-operation-history-read'
import { readHistoricalRowLocator } from '../src/main/database/synced-history-evidence-support'
import type { RawSyncedHistoricalEvidence } from '../src/main/database/synced-history-evidence-model'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { exchangeJobKey, exchangeJobPhaseKey } from '../src/main/sync/synced-exchange-model'
import { publicationJson } from '../src/main/sync/synced-publication-model'
import { withV3Fixture, allTables, created, createRestoreInput, restoreSyncedHostOperation,
  createRequest, applySyncedHostCommand, snapshot } from './helpers/synced-backup-v3-fixture'
import { editCreatedGroup } from './helpers/synced-host-command-create-fixture'
import { withDeletionChoices, groupConflict, ready, component, choose, completed, receipt7, proof2,
  flip } from './helpers/synced-deletion-choice-fixture'

const now = '2040-02-03T04:05:06.000Z'
function read(db: Database.Database): RawSyncedHistoricalEvidence {
  return db.transaction(() => assertRawSyncedHistoricalEvidenceOwned(db))()
}
/** Corruption never leaves the isolated original DB. Unexpected setup failures
 * cannot count as the reader rejecting a changed historical support. */
function rejectsChanged(db: Database.Database, change: () => void, pattern?: RegExp) {
  const rollback = new Error('rollback only this fixture corruption'), before = allTables(db)
  assert.throws(() => db.transaction(() => {
    change()
    if (pattern) assert.throws(() => assertRawSyncedHistoricalEvidenceOwned(db), pattern)
    else assert.throws(() => assertRawSyncedHistoricalEvidenceOwned(db))
    throw rollback
  })(), error => error === rollback)
  assert.deepEqual(allTables(db), before, 'The original SQL evidence is restored after the negative')
}
function frozenAndReread(db: Database.Database, value: RawSyncedHistoricalEvidence) {
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.facts))
  db.transaction(() => {
    for (const fact of value.facts) {
      assert.ok(Object.isFrozen(fact) && Object.isFrozen(fact.locator) && Object.isFrozen(fact.locator.key) && Object.isFrozen(fact.supports))
      assert.deepEqual(readHistoricalRowLocator(db, fact.locator.table, fact.locator.key), fact.locator,
        'Every indexed locator hashes the complete actual original SQL row')
      for (const support of fact.supports) {
        assert.ok(Object.isFrozen(support) && Object.isFrozen(support.key))
        assert.deepEqual(readHistoricalRowLocator(db, support.table, support.key), support)
      }
    }
  })()
  assert.equal(Reflect.set(value, 'operations', 0), false)
  assert.equal(Reflect.set(value.facts, 'length', 0), false)
  assert.equal(Reflect.set(value.facts[0], 'evidenceClass', 'material-verified'), false)
}

test('historical evidence requires the actual owned transaction and accepts a readonly original connection', () => withV3Fixture(f => {
  assert.throws(() => assertRawSyncedHistoricalEvidenceOwned(f.db), /真实自有事务/)
  const expected = read(f.db), readonly = new Database(f.file, { readonly: true })
  try {
    readonly.pragma('foreign_keys=ON')
    assert.deepEqual(read(readonly), expected, 'Historical evidence does not require a writable capability connection')
  } finally { readonly.close() }
}))

test('real create undo retirement and later redo/content CAS preserve the original ACKs without writes or permissions', () => withV3Fixture(f => {
  const originalRevision = f.created.createdLifecycle.revision
  const undo = created(restoreSyncedHostOperation(f.db, createRestoreInput(f.db, f.created, 'undo').input))
  assert.equal(undo.createdLifecycle.state, 'retired-create')
  const retired = read(f.db)
  assert.ok(retired.facts.some(fact => fact.family === 'host-create-ack' && fact.locator.key[0] === f.created.operationId),
    'The original active create ACK remains historical evidence while the actual group is retired')
  created(restoreSyncedHostOperation(f.db, createRestoreInput(f.db, undo, 'redo').input))
  const edited = editCreatedGroup(f.db, f.groupId)
  assert.notEqual(snapshot(f.db, f.groupId).revision, originalRevision, 'A real Main edit advances today\'s group CAS')
  const before = allTables(f.db), value = read(f.db)
  assert.ok(value.facts.some(fact => fact.family === 'group-ack' && fact.locator.key[0] === edited.operationId))
  assert.ok(value.facts.filter(fact => fact.family === 'host-create-ack').length >= 3)
  frozenAndReread(f.db, value)
  assert.deepEqual(allTables(f.db), before, 'Raw ACK certification does not rotate guards, replay, repair or change SQL')
}))

test('actual ACK unknown versions and future metadata families cannot become certified hashes', () => withV3Fixture(f => {
  const source = f.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId) as { result_json: string }
  const changed = JSON.parse(source.result_json) as { version: number }
  changed.version = 99
  rejectsChanged(f.db, () => f.db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?')
    .run(publicationJson(changed), f.created.operationId), /回执损坏|收据损坏/)
  rejectsChanged(f.db, () => f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
    .run('sync.webdav.protocol5.exchange-job.v99.' + randomUUID(), '{}', now), /未知protocol5/)
  assert.ok(read(f.db).facts.some(fact => fact.family === 'host-create-ack'))
}))

test('actual V3 possible and confirmed metadata remain durable after the exported directories are removed', () => withV3Fixture(f => {
  const possibleId = randomUUID()
  f.db.exec("CREATE TRIGGER historical_fixture_confirm BEFORE UPDATE OF state ON synced_exposure_attempts WHEN NEW.state='confirmed' BEGIN SELECT RAISE(ABORT,'fixture stops confirmation'); END")
  try {
    assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: possibleId }))
  } finally { f.db.exec('DROP TRIGGER historical_fixture_confirm') }
  assert.deepEqual(f.db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(possibleId), { state: 'possible' },
    'The actual producer committed possible before the forced confirmation failure')
  const confirmedId = randomUUID(), confirmedDestination = join(f.root, 'confirmed-history-archive')
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: confirmedDestination, snapshotId: confirmedId })
  assert.deepEqual(f.db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(confirmedId), { state: 'confirmed' })
  assert.ok(existsSync(f.destination) && existsSync(confirmedDestination), 'Both originals came from real V3 output')
  for (const destination of [f.destination, confirmedDestination]) {
    assert.equal(dirname(resolve(destination)), resolve(f.root))
    rmSync(destination, { recursive: true })
  }
  const value = read(f.db), claims = value.facts.filter(fact => fact.family === 'backup-v3')
  assert.equal(claims.length, 2)
  assert.ok(claims.every(fact => fact.evidenceClass === 'durable-only' && fact.supports.some(support => support.table === 'synced_exposure_attempts')))
  const key = 'synced.backup.v3.' + confirmedId, row = f.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string }
  const changed = JSON.parse(row.value) as { archiveHash: string }
  changed.archiveHash = flip(changed.archiveHash)
  rejectsChanged(f.db, () => f.db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(publicationJson(changed), key), /V3 原metadata\/attempt/)
}))

function withEncodedOriginal(encoding: 'UTF-8' | 'UTF-16le' | 'UTF-16be', run: (db: Database.Database) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-history-encoding-')), file = join(root, 'storage', 'knowbook.db')
  let initial: Database.Database | undefined, store: KnowbookStore | undefined
  try {
    mkdirSync(dirname(file), { recursive: true })
    initial = new Database(file)
    initial.pragma("encoding='" + encoding + "'")
    initial.exec('CREATE TABLE history_encoding_fixture(value TEXT)') // Persist the original encoding before Store creates its real schema.
    initial.close(); initial = undefined
    store = new KnowbookStore(file)
    const documentId = store.createDocument(null), blockId = randomUUID()
    store.updateDocument(documentId, { title: '真实编码宿主', summary: '保留中文与 emoji 🧩', blocks: [
      { id: blockId, type: 'paragraph', content: '合法正文与 replacement 字面量 �', checked: false, depth: 0, parentBlockId: null }
    ] })
    const db = store.getUnsafeDatabaseHandle()
    assert.equal(String(db.pragma('encoding', { simple: true })).toLowerCase(), encoding.toLowerCase())
    created(applySyncedHostCommand(db, createRequest(db, { documentId, selectedRootIds: [blockId] })))
    run(db)
  } finally {
    initial?.close(); store?.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-history-encoding-'))
    rmSync(root, { recursive: true, force: true })
  }
}
for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const) {
  test('actual ' + encoding + ' SQL text is lossless and malformed original bytes cannot masquerade as replacement text', () => withEncodedOriginal(encoding, db => {
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('history.encoding.literal', '\uFFFD', now)
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('history.encoding.bom', '\uFEFF原BOM正文', now)
    assert.ok(read(db).facts.some(fact => fact.family === 'host-create-ack'), 'Real Main ACKs are read using the original DB encoding')
    const bytes = encoding === 'UTF-8' ? '80' : encoding === 'UTF-16le' ? '00D8' : 'D800'
    rejectsChanged(db, () => db.prepare("UPDATE app_settings SET value=CAST(X'" + bytes + "' AS TEXT) WHERE key='history.encoding.literal'").run(), /原TEXT编码|原TEXT解码|回编码/)
    assert.equal((db.prepare("SELECT value FROM app_settings WHERE key='history.encoding.literal'").get() as { value: string }).value, '\uFFFD')
  }))
}

test('real job7/proof2 and preview SQL survive cleared private files while missing mandatory support and reverse orphan phases reject', () => withDeletionChoices(async f => {
  const conflict = groupConflict(f), preview = ready(await f.preview()), operationId = randomUUID()
  completed(await f.resolve(preview, [choose(component(preview, conflict.key), 'keep-delete')], operationId), 'applied')
  const original = receipt7(f, operationId), deletion = proof2(f, operationId, conflict.key)
  const attemptId = original.receipt.provenance.attemptId, sourceKey = exchangeJobKey(operationId, attemptId), phaseKey = exchangeJobPhaseKey(operationId, attemptId, 0)
  const first = f.B.db.prepare('SELECT value FROM app_settings WHERE key=?').get(phaseKey) as { value: string }
  assert.ok(first, 'The real settled attempt owns a durable prepared phase')
  for (const name of ['synced-exchanges-v1', 'synced-exchange-deletion-previews-v1']) {
    const storage = join(f.B.root, 'storage'), directory = join(storage, name)
    assert.equal(dirname(resolve(directory)), resolve(storage))
    assert.ok(existsSync(directory), 'The actual Main job/preview wrote this private directory')
    rmSync(directory, { recursive: true })
  }
  const before = allTables(f.B.db), value = read(f.B.db)
  assert.ok(value.facts.some(fact => fact.family === 'exchange-receipt' && fact.version === 7 && fact.locator.key[0] === operationId))
  assert.ok(value.facts.some(fact => fact.family === 'logical-deletion-proof' && fact.version === 2 && fact.locator.key[0] === deletion.markerRow.client_operation_id))
  assert.ok(value.facts.some(fact => fact.family === 'exchange-job' && fact.locator.key[0] === sourceKey && fact.evidenceClass === 'index-attempt-only'))
  assert.ok(value.facts.some(fact => fact.family === 'deletion-preview' && fact.evidenceClass === 'index-attempt-only'))
  assert.deepEqual(allTables(f.B.db), before)
  for (const key of [sourceKey, phaseKey]) rejectsChanged(f.B.db, () => f.B.db.prepare('DELETE FROM app_settings WHERE key=?').run(key))
  rejectsChanged(f.B.db, () => f.B.db.prepare('DELETE FROM synced_operations WHERE client_operation_id=?').run(deletion.markerRow.client_operation_id))
  const orphan = JSON.parse(first.value) as { operationId: string; attemptId: string; sequence: number }
  orphan.operationId = randomUUID(); orphan.attemptId = randomUUID()
  rejectsChanged(f.B.db, () => f.B.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
    .run(exchangeJobPhaseKey(orphan.operationId, orphan.attemptId, orphan.sequence), publicationJson(orphan),
      (JSON.parse(first.value) as { recordedAt: string }).recordedAt), /无原job的phase/)
}))
