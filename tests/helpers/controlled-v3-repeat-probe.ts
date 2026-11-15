import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../../src/main/database/store'
import { writeSyncedBackupV3 } from '../../src/main/backup/v3-export'
import { authorizeInstalledRestoreBackupWorker, recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../../src/main/database/restore-safety'
import { readRawPriorKnowledgeCoverageOwned } from '../../src/main/database/restore-knowledge-coverage-raw-read'
import { canonicalRestoreRoot, restoreExists } from '../../src/main/database/restore-safety-files'
import { applySyncedHostCommand, createRequest, created, freshBlock, randomUUID } from './synced-backup-v3-fixture'

// Invoke in separate Electron Node processes with the same new run path:
// electron --import tsx tests/helpers/controlled-v3-repeat-probe.ts first <run-path>
// electron --import tsx tests/helpers/controlled-v3-repeat-probe.ts second <run-path>
const [phase, requested] = process.argv.slice(2)
if (!requested || phase !== 'first' && phase !== 'second') throw new Error('Expected first or second and a dedicated run path.')
if (phase === 'first') await mkdir(resolve(requested))
const root = await canonicalRestoreRoot(resolve(requested)), receiver = join(root, 'receiver')
const database = join(receiver, 'storage', 'knowbook.db')
const archives = [join(root, 'archive-first'), join(root, 'archive-second')] as const
const titles = ['First independent V3 host', 'Second independent V3 host'] as const
const ordinaryTitle = 'Original ordinary document'
const legacy = {
  readCurrentIdentities: async () => [],
  recoverLegacy: async () => { throw new Error('Expected the controlled joint recovery owner.') }
}

function readCoverage() {
  const db = new Database(database, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only=ON')
    db.pragma('foreign_keys=ON')
    return db.transaction(() => readRawPriorKnowledgeCoverageOwned(db))()
  } finally { db.close() }
}

async function writeArchive(index: 0 | 1) {
  const profile = await mkdtemp(join(root, 'source-'))
  const donor = KnowbookStore.createEmptySyncedReceiver(join(profile, 'storage', 'knowbook.db'))
  try {
    const id = donor.createDocument(null), block = freshBlock(randomUUID(), 'Actual synchronized content for ' + titles[index])
    donor.updateDocument(id, { title: titles[index], summary: 'Actual independent source summary', blocks: [block] })
    const db = donor.getUnsafeDatabaseHandle()
    created(applySyncedHostCommand(db, createRequest(db, { documentId: id, selectedRootIds: [block.id] })))
    writeSyncedBackupV3(db, { userDataRoot: profile, destination: archives[index], snapshotId: randomUUID() })
  } finally { donor.destroy() }
}

const install = (index: 0 | 1) => restoreControlledBackupV3({ userDataRoot: receiver, backupDirectory: archives[index],
  stopProcesses: async () => [] }, legacy)

if (phase === 'first') {
  await mkdir(receiver)
  const old = KnowbookStore.createEmptySyncedReceiver(database)
  try {
    const id = old.createDocument(null)
    old.updateDocument(id, { title: ordinaryTitle, summary: 'Retain this workspace content', blocks: [] })
  } finally { old.destroy() }
  const oldBytes = await readFile(database)
  await writeArchive(0)
  const result = await install(0)
  assert.equal(result.status, 'installed')
  assert.deepEqual(await readFile(join(result.recoveryDirectory, 'original', 'knowbook.db')), oldBytes)
  const coverage = readCoverage()
  assert.equal(coverage.entries.length, 1)
  assert.equal(coverage.entries[0].operationId, result.operationId)
  assert.equal(coverage.entries[0].cut.kind, 'ordinary-empty-epoch-cut')
  console.log('First genuine V3 installation verified.')
} else {
  const first = readCoverage()
  assert.equal(first.entries.length, 1)
  await writeArchive(1)
  const result = await install(1)
  assert.equal(result.status, 'installed')
  assert.equal(await restoreExists(join(receiver, 'database-restore-pending.json')), false)
  for (const archive of archives) await rename(archive, archive + '-retired')
  assert.equal(await recoverControlledDatabaseRestore(receiver, legacy.recoverLegacy), true)
  await authorizeInstalledRestoreBackupWorker(receiver, database)
  const store = KnowbookStore.openCanonicalRuntime(database)
  try {
    const actualTitles = new Set(store.getDocumentIndex().map(document => document.title))
    for (const title of [ordinaryTitle, ...titles]) assert.ok(actualTitles.has(title), title)
  } finally { store.destroy() }
  const coverage = readCoverage()
  assert.equal(coverage.entries.length, 2)
  assert.deepEqual(coverage.entries.find(entry => entry.operationId === first.entries[0].operationId), first.entries[0])
  const latest = coverage.entries.find(entry => entry.operationId === result.operationId)
  assert.equal(latest?.cut.kind, 'synced-recovery-epoch-cut')
  assert.ok(latest?.supports.boundary && latest.supports.epoch)
  console.log('Second genuine V3 installation and both coverage records verified after cold reopen.')
}
