import assert from 'node:assert/strict'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../src/main/database/store'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../src/main/database/restore-safety'
import { readRawPriorKnowledgeCoverageOwned } from '../src/main/database/restore-knowledge-coverage-raw-read'
import { canonicalRestoreRoot, restoreExists, restorePaths } from '../src/main/database/restore-safety-files'
import { addV3Assets, randomUUID, withV3Fixture } from './helpers/synced-backup-v3-fixture'

test('controlled V3 maintenance installs the real SQLite and attachments and cold recovery verifies its receipt', () => withV3Fixture(async f => {
  const assets = await addV3Assets(f)
  const [first, second] = assets.attachments
  const ordinary = f.store.getDocumentDetail(f.targetId)!
  f.store.updateDocument(f.targetId, { ...ordinary,
    summary: `![ordinary][alias]\n\n[alias]: <${first.url}>\n\n<img src="${second.url}" alt="ordinary HTML">`
  })
  f.store.documentRecovery.checkpoint(f.targetId, 'edit', true)
  const removedSource = f.store.createDocument(null)
  f.store.updateDocument(removedSource, { title: 'Incoming archive trash', summary: 'Source-only evidence', blocks: [] })
  f.store.deleteDocument(removedSource)
  assert.ok(f.db.prepare('SELECT 1 FROM document_history LIMIT 1').get())
  assert.ok(f.db.prepare('SELECT 1 FROM document_trash LIMIT 1').get())
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const requested = join(f.root, 'restore-receiver')
  await mkdir(requested)
  const root = await canonicalRestoreRoot(requested), database = join(root, 'storage', 'knowbook.db')
  const old = KnowbookStore.createEmptySyncedReceiver(database)
  const oldDocument = old.createDocument(null)
  const retainedRoot = randomUUID(), retainedChild = randomUUID()
  const retainedBlocks = [
    { id: retainedRoot, type: 'bulleted-list', content: 'Retain this list', checked: false, depth: 0, parentBlockId: null },
    { id: retainedChild, type: 'bulleted-list', content: 'Retain the nested current block', checked: false, depth: 1, parentBlockId: retainedRoot }
  ]
  old.updateDocument(oldDocument, { title: 'Existing ordinary document', summary: 'Retain this workspace content', blocks: retainedBlocks })
  old.destroy()
  const oldBytes = await readFile(database)
  const legacy = {
    readCurrentIdentities: async () => [],
    recoverLegacy: async () => { throw new Error('V3 must use the controlled joint recovery owner') }
  }
  let confirmedOperation: string | undefined
  const result = await restoreControlledBackupV3({ userDataRoot: root, backupDirectory: f.destination, stopProcesses: async () => [] }, legacy, async preview => {
    confirmedOperation = preview.operationId
    assert.match(preview.intentHash, /^[a-f0-9]{64}$/)
    assert.ok(preview.documents.incoming > 0 && preview.groups.incoming > 0)
    assert.equal(preview.documents.retained, 1)
    assert.equal(preview.documents.replaced, 0)
    assert.equal(preview.conflicts, 0)
    const paths = restorePaths(root, preview.operationId)
    assert.ok(await restoreExists(paths.stage))
    assert.equal(await restoreExists(paths.intent), false)
    assert.equal(await restoreExists(paths.fence), false)
    assert.equal(await restoreExists(paths.journal), false)
    assert.deepEqual(await readFile(database), oldBytes)
    return true
  })
  assert.ok(result)
  assert.equal(result.operationId, confirmedOperation)
  assert.equal(result.status, 'installed')
  assert.deepEqual(await readFile(join(result.recoveryDirectory, 'original', 'knowbook.db')), oldBytes)
  assert.equal(await restoreExists(join(root, 'database-restore-pending.json')), false)
  await rename(f.destination, f.destination + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(root, legacy.recoverLegacy), true)
  const store = KnowbookStore.openCanonicalRuntime(database)
  try {
    const retained = store.getDocumentDetail(oldDocument)
    assert.equal(retained?.summary, 'Retain this workspace content')
    assert.deepEqual(retained?.blocks.map(({ id, type, content, checked, depth, parentBlockId }) =>
      ({ id, type, content, checked, depth, parentBlockId })), retainedBlocks)
    const summary = store.getDocumentDetail(f.targetId)?.summary
    assert.match(String(summary), /\[alias\]: <file:.*attachments/)
    assert.match(String(summary), /<img src="file:.*attachments/)
    assert.doesNotMatch(String(summary), /knowbook-asset:/)
  } finally { store.destroy() }
  const db = new Database(database, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    const coverage = db.transaction(() => readRawPriorKnowledgeCoverageOwned(db))()
    assert.equal(coverage.entries.length, 1)
    assert.equal(coverage.entries[0].operationId, result.operationId)
    assert.equal(db.prepare('SELECT summary FROM documents WHERE id=?').pluck().get(oldDocument), 'Retain this workspace content')
    const summary = db.prepare('SELECT summary FROM documents WHERE id=?').pluck().get(f.hostId)
    assert.match(String(summary), /file:.*attachments/)
  } finally { db.close() }
  for (const attachment of assets.attachments) {
    const file = join(root, 'storage', 'assets', 'attachments', assets.hash.slice(0, 2), assets.hash, attachment.name)
    assert.deepEqual(await readFile(file), assets.bytes)
  }
  const destination = join(f.root, 'export-after-restore')
  await new Promise<void>((resolve, reject) => {
    const workerData = { kind: 'synced-v3', databasePath: database, userDataRoot: root, destination, snapshotId: randomUUID() }
    const worker = new Worker(new URL('./helpers/backup-export-worker.mjs', import.meta.url), { workerData, execArgv: [] })
    worker.once('message', (value: { ok: boolean; message?: string }) => value.ok ? resolve() : reject(new Error(value.message)))
    worker.once('error', reject)
    worker.once('exit', code => { if (code !== 0) reject(new Error('Backup worker exited with code ' + code)) })
  })
  const exported = readBackupV3Archive(destination)
  assert.equal(exported.assets.length, assets.attachments.length)
  assert.ok(exported.documents.some(doc => doc.id === oldDocument))
}))

test('declining a real prepared V3 plan preserves the current SQLite and creates no install fence', () => withV3Fixture(async f => {
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const requested = join(f.root, 'cancel-receiver')
  await mkdir(requested)
  const root = await canonicalRestoreRoot(requested), database = join(root, 'storage', 'knowbook.db')
  const store = KnowbookStore.createEmptySyncedReceiver(database)
  store.destroy()
  const before = await readFile(database)
  let operationId: string | undefined
  const result = await restoreControlledBackupV3({ userDataRoot: root, backupDirectory: f.destination, stopProcesses: async () => [] },
    { readCurrentIdentities: async () => [], recoverLegacy: async () => { throw new Error('unexpected legacy recovery') } },
    async preview => {
      operationId = preview.operationId
      assert.ok(await restoreExists(restorePaths(root, operationId).stage))
      return false
    })
  assert.equal(result, null)
  assert.ok(operationId)
  const paths = restorePaths(root, operationId)
  for (const file of [paths.intent, paths.fence, paths.journal, paths.result, paths.safeMarker])
    assert.equal(await restoreExists(file), false)
  assert.deepEqual(await readFile(database), before)
}))
