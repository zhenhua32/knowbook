import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownBackupService } from '../src/main/backup/exporter'
import { readV2Header } from '../src/main/backup/v2-format'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { withV3Fixture, randomUUID, addV3Assets, fileInventory, allTables } from './helpers/synced-backup-v3-fixture'

type Archive = ReturnType<typeof readBackupV3Archive>
type WorkerReply = { ok: true; exported?: number; archive?: Archive } | { ok: false; message: string; stack?: string }
function worker(file: string, workerData: unknown): Promise<Extract<WorkerReply, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const child = new Worker(new URL('./helpers/' + file, import.meta.url), { workerData, execArgv: [] })
    let reply: WorkerReply | undefined, failure: Error | undefined
    child.once('message', (value: WorkerReply) => { reply = value })
    child.once('error', error => { failure = error })
    child.once('exit', code => {
      if (failure) { reject(failure); return }
      if (code !== 0 || !reply) { reject(new Error('The actual backup worker exited without a successful result: ' + code)); return }
      if (!reply.ok) { const error = new Error(reply.message); error.stack = reply.stack; reject(error); return }
      resolve(reply)
    })
  })
}
function sameArchive(actual: Archive, expected: Archive) {
  const { snapshotId: _actualId, ...actualManifest } = actual.manifest
  const { snapshotId: _expectedId, ...expectedManifest } = expected.manifest
  assert.equal(canonicalSyncedPortableJson({ documents: actual.documents, catalog: actual.catalog, standaloneDatabases: actual.standaloneDatabases,
    groups: actual.groups, manifest: actualManifest }), canonicalSyncedPortableJson({ documents: expected.documents, catalog: expected.catalog,
    standaloneDatabases: expected.standaloneDatabases, groups: expected.groups, manifest: expectedManifest }))
  assert.deepEqual(actual.assets.map(asset => ({ path: asset.relativePath, hash: asset.hash, name: asset.name, bytes: Buffer.from(asset.bytes) })),
    expected.assets.map(asset => ({ path: asset.relativePath, hash: asset.hash, name: asset.name, bytes: Buffer.from(asset.bytes) })))
}

test('V3 actual export worker reads the real WAL database without production Store group bypass and matches the inline complete graph', () => withV3Fixture(async f => {
  await addV3Assets(f)
  const firstId = randomUUID(), secondId = randomUUID(), workerDestination = join(f.root, 'worker-archive')
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: firstId })
  const reply = await worker('backup-export-worker.mjs', { kind: 'synced-v3', databasePath: f.file,
    userDataRoot: f.userDataRoot, destination: workerDestination, snapshotId: secondId })
  assert.equal(reply.exported, f.sourceDocumentIds.length)
  const actual = readBackupV3Archive(workerDestination), expected = readBackupV3Archive(f.destination)
  assert.equal(actual.manifest.snapshotId, secondId)
  sameArchive(actual, expected)
  const firstGroups = fileInventory(f.destination).filter(row => row.path.startsWith('__knowbook/synced/'))
  assert.deepEqual(fileInventory(workerDestination).filter(row => row.path.startsWith('__knowbook/synced/')), firstGroups)
}))

test('V3 actual parse worker strictly reads real group and asset files and never mutates the database or archive', () => withV3Fixture(async f => {
  await addV3Assets(f)
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const tables = allTables(f.db), files = fileInventory(f.destination), expected = readBackupV3Archive(f.destination)
  const reply = await worker('backup-parse-worker.mjs', { kind: 'synced-v3', root: f.destination })
  assert.ok(reply.archive, 'The actual production parse worker returns its strictly validated complete V3 archive')
  sameArchive(reply.archive, expected)
  assert.deepEqual(allTables(f.db), tables)
  assert.deepEqual(fileInventory(f.destination), files)
}))

test('V3 actual parse worker rejects a damaged generated index and preserves the corrupted bytes for diagnosis', () => withV3Fixture(async f => {
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const path = join(f.destination, '__knowbook', 'databases', 'index.md')
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^backupFormatVersion: [^\r\n]+$/m, 'backupFormatVersion: "999"'))
  const files = fileInventory(f.destination), tables = allTables(f.db)
  await assert.rejects(worker('backup-parse-worker.mjs', { kind: 'synced-v3', root: f.destination }))
  assert.deepEqual(fileInventory(f.destination), files)
  assert.deepEqual(allTables(f.db), tables)
}))

test('V3 opt-in support keeps the real ordinary V2 exporter and its exact version discriminator unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-v3-old-v2-')), store = new KnowbookStore(join(root, 'ordinary.db'))
  try {
    const id = store.createDocument(null)
    store.updateDocument(id, { title: 'Ordinary V2', summary: 'Legacy untouched', blocks: [
      { id: randomUUID(), type: 'paragraph', content: 'Old V2 content', depth: 0, checked: false, parentBlockId: null }
    ] })
    const destination = join(root, 'v2-archive')
    await new MarkdownBackupService(store, destination).exportAll()
    const header = readV2Header(readFileSync(join(destination, '__knowbook', 'databases', 'index.md'), 'utf8'))
    assert.ok(header, 'The real unmodified ordinary exporter still writes an actual V2 envelope')
    assert.equal(header.backupFormatVersion, '2')
    assert.throws(() => readBackupV3Archive(destination))
    assert.equal(store.getDocumentDetail(id)!.blocks[0].content, 'Old V2 content')
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('V3 actual zero-document and zero-active database export retains standalone data without claiming a zero-member group publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-v3-zero-')), userDataRoot = join(root, 'profile')
  mkdirSync(join(userDataRoot, 'storage'), { recursive: true })
  const store = new KnowbookStore(join(userDataRoot, 'storage', 'knowbook.db'))
  try {
    for (const document of store.getAllDocumentSnapshots().reverse()) store.deleteDocument(document.id)
    const custom = store.createDatabase({ name: 'Zero-document standalone' })
    const entity = store.createDatabaseEntity({ databaseId: custom.id, title: 'Standalone with no document' })
    const db = store.getUnsafeDatabaseHandle(), before = db.prepare('SELECT * FROM synced_exposure_attempts').all()
    const destination = join(root, 'archive')
    const result = writeSyncedBackupV3(db, { userDataRoot, destination, snapshotId: randomUUID() })
    assert.equal(result.documents, 0)
    assert.equal(result.groups, 0)
    const archive = readBackupV3Archive(destination)
    assert.deepEqual(archive.documents, [])
    assert.equal(archive.manifest.deletion.documents.mode, 'none')
    const preserved = archive.standaloneDatabases.find(row => row.id === custom.id)
    assert.ok(preserved, 'The actual standalone source survives in a zero-document archive')
    assert.equal(preserved.entities[0].id, entity.id)
    assert.deepEqual(db.prepare('SELECT * FROM synced_exposure_attempts').all(), before)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
