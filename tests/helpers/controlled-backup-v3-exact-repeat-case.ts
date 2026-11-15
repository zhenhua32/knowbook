import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../../src/main/database/store'
import { writeSyncedBackupV3 } from '../../src/main/backup/v3-export'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../../src/main/database/restore-safety'
import { readRawPriorKnowledgeCoverageOwned } from '../../src/main/database/restore-knowledge-coverage-raw-read'
import { canonicalRestoreRoot, restoreExists } from '../../src/main/database/restore-safety-files'
import { applySyncedHostCommand, createRequest, created, freshBlock, randomUUID } from './synced-backup-v3-fixture'

const folder = process.env.KNOWBOOK_EXACT_V3_REPEAT_FIXTURE
const phase = process.env.KNOWBOOK_EXACT_V3_REPEAT_PHASE
if (!folder || phase !== 'first' && phase !== 'second') throw new Error('Expected dedicated exact repeat fixture and explicit phase')
const archive = join(folder, 'archive'), requested = join(folder, 'restore-receiver'), record = join(folder, 'oracle.json')
const legacy = {
  readCurrentIdentities: async () => [],
  recoverLegacy: async () => { throw new Error('V3 must use the controlled joint recovery owner') }
}

test('first controlled restore installs a genuine source and records exact SQLite identities', { skip: phase !== 'first' }, async () => {
  const userDataRoot = join(folder, 'source')
  await mkdir(userDataRoot)
  const source = KnowbookStore.createEmptySyncedReceiver(join(userDataRoot, 'storage', 'knowbook.db'))
  try {
    const documentId = source.createDocument(null), blockId = randomUUID()
    source.updateDocument(documentId, { title: 'Canonical source', summary: 'V3 repeated backup', blocks: [
      freshBlock(randomUUID(), 'An ordinary persisted block'),
      freshBlock(blockId, 'A canonical body')
    ] })
    const db = source.getUnsafeDatabaseHandle()
    created(applySyncedHostCommand(db, createRequest(db, { documentId, selectedRootIds: [blockId] })))
    writeSyncedBackupV3(db, { userDataRoot, destination: archive, snapshotId: randomUUID() })
  } finally { source.destroy() }
  await mkdir(requested)
  const root = await canonicalRestoreRoot(requested), database = join(root, 'storage', 'knowbook.db')
  const old = KnowbookStore.createEmptySyncedReceiver(database)
  const oldDocument = old.createDocument(null)
  old.updateDocument(oldDocument, { title: 'Existing ordinary document', summary: 'Retain this workspace content', blocks: [] })
  old.destroy()
  const oldBytes = await readFile(database)
  const result = await restoreControlledBackupV3({ userDataRoot: root, backupDirectory: archive, stopProcesses: async () => [] }, legacy)
  assert.equal(result.status, 'installed')
  assert.deepEqual(await readFile(join(result.recoveryDirectory, 'original', 'knowbook.db')), oldBytes)
  assert.equal(await restoreExists(join(root, 'database-restore-pending.json')), false)
  const first = readCoverage(database)
  const before = stableIdentities(database)
  assert.equal(before.groups.length, 1)
  assert.equal(before.instances.length, 1)
  await writeFile(record, JSON.stringify({ firstPid: process.pid, operationId: result.operationId, oldDocument, before, first }))
})

test('second process reopens genuine prior installation and preserves its exact identities', { skip: phase !== 'second' }, async () => {
  const root = await canonicalRestoreRoot(requested), database = join(root, 'storage', 'knowbook.db')
  const { firstPid, operationId, oldDocument, before, first } = JSON.parse(await readFile(record, 'utf8'))
  assert.notEqual(firstPid, process.pid)
  assert.deepEqual(readCoverage(database), first)
  const second = await restoreControlledBackupV3({ userDataRoot: root, backupDirectory: archive, stopProcesses: async () => [] }, legacy)
  assert.equal(second.status, 'installed')
  assert.deepEqual(stableIdentities(database), before)
  await rename(archive, archive + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(root, legacy.recoverLegacy), true)
  const store = KnowbookStore.openCanonicalRuntime(database)
  try {
    assert.equal(store.getDocumentDetail(oldDocument)?.summary, 'Retain this workspace content')
  } finally { store.destroy() }
  const actual = readCoverage(database)
  assert.equal(actual.entries.length, 2)
  assert.deepEqual(actual.entries.find(entry => entry.operationId === operationId), first.entries[0])
  assert.equal(actual.entries.find(entry => entry.operationId === second.operationId)?.cut.kind, 'synced-recovery-epoch-cut')
})

function stableIdentities(database: string) {
  const db = new Database(database, { readonly: true, fileMustExist: true })
  try {
    return db.transaction(() => ({
      documents: db.prepare('SELECT id,created_at FROM documents ORDER BY id').all(),
      ordinary: db.prepare('SELECT id,document_id,created_at FROM blocks ORDER BY id').all(),
      groups: db.prepare('SELECT id,creation_id,created_at,origin_json,bindings_json FROM synced_groups ORDER BY id').all(),
      canonical: db.prepare('SELECT id,group_id,created_at FROM synced_group_blocks ORDER BY id').all(),
      instances: db.prepare('SELECT instance_id,group_id,host_document_id FROM synced_instances ORDER BY instance_id').all(),
      definitions: ['databases', 'document_database_columns', 'database_saved_views', 'database_entities']
        .map(table => db.prepare('SELECT id,created_at FROM ' + table + ' ORDER BY id').all())
    }))()
  } finally { db.close() }
}

function readCoverage(database: string) {
  const db = new Database(database, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    return db.transaction(() => readRawPriorKnowledgeCoverageOwned(db))()
  } finally { db.close() }
}
