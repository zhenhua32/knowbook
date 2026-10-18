import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../../src/main/database/store'
import { restoreKnowbookDatabase, recoverInterruptedDatabaseRestore } from '../../src/main/database/restore-maintenance'

export { Database, KnowbookStore, restoreKnowbookDatabase, recoverInterruptedDatabaseRestore, randomUUID }
export const files = ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm'] as const
export const noProcesses = async () => []
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function originals(database: string) {
  return files.flatMap((name, index) => {
    const path = database + ['', '-wal', '-shm'][index]
    return existsSync(path) ? [{ name, bytes: Buffer.from(readFileSync(path)) }] : []
  })
}
export function assertOriginals(database: string, expected: ReturnType<typeof originals>) {
  assert.deepEqual(originals(database), expected, 'The exact original DB/WAL/SHM presence and raw bytes remain intact')
}
export function workspace(db: Database.Database) {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: string; recovery_epoch: string } | undefined
  assert.ok(row, 'The real initialized Store has its actual singleton scope and recovery epoch')
  return row
}
export function inspect<T>(path: string, run: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try { return run(db) } finally { db.close() }
}
export async function ordinaryBackup(root: string, title = 'Ordinary source backup', moves = false) {
  const file = join(root, 'backup-source-profile', 'storage', 'knowbook.db'), backup = join(root, 'source-independent.db')
  mkdirSync(dirname(file), { recursive: true })
  const store = new KnowbookStore(file)
  try {
    const id = store.createDocument(null), blockId = randomUUID()
    store.updateDocument(id, { title, summary: 'Source summary preserved', blocks: [
      { id: blockId, type: 'paragraph', content: 'Source ordinary real body', checked: false, depth: 0, parentBlockId: null }
    ] })
    let move: ReturnType<KnowbookStore['moveDocumentBlocks']> | undefined
    if (moves) {
      const target = store.createDocument(null), movingId = randomUUID()
      store.updateDocument(id, { title, summary: 'Source summary preserved', blocks: [
        { id: blockId, type: 'paragraph', content: 'Source ordinary real body', checked: false, depth: 0, parentBlockId: null },
        { id: movingId, type: 'paragraph', content: 'Real ordinary move body', checked: false, depth: 0, parentBlockId: null }
      ] })
      store.updateDocument(target, { title: 'Ordinary move target', summary: '', blocks: [
        { id: randomUUID(), type: 'paragraph', content: 'Existing target body', checked: false, depth: 0, parentBlockId: null }
      ] })
      const from = store.getDocumentDetail(id), to = store.getDocumentDetail(target)
      assert.ok(from && to, 'Both ordinary move participants are actual current Store documents')
      move = store.moveDocumentBlocks({ fromDocumentId: id, toDocumentId: target, blockIds: [movingId], expectedFromUpdatedAt: from.updatedAt, expectedToUpdatedAt: to.updatedAt })
      const trash = store.createDocument(null)
      store.updateDocument(trash, { title: 'Ordinary retained trash', summary: 'Retained ordinary trash content', blocks: [
        { id: randomUUID(), type: 'paragraph', content: 'Ordinary trash real body', checked: false, depth: 0, parentBlockId: null }
      ] })
      store.deleteDocument(trash)
    }
    const sourceWorkspace = workspace(store.getUnsafeDatabaseHandle())
    await store.backupDatabase(backup)
    return { backup, id, blockId, move, sourceWorkspace, sourceBytes: Buffer.from(readFileSync(backup)) }
  } finally { store.destroy() }
}

/** A real Store produces current DB plus genuine WAL/SHM. The three-file raw
 * snapshot is reinstated only after closing its producer, with no SQL mutation
 * or fabricated success rows. It supplies the exact preservation oracle. */
export async function withControlledRestore(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-controlled-restore-'))
  let fixture: Awaited<ReturnType<typeof setup>> | undefined
  try { fixture = await setup(root); await run(fixture) }
  finally {
    fixture?.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'Only the controlled restore temp root is removed')
    assert.ok(basename(root).startsWith('knowbook-controlled-restore-'), 'The cleanup root has its dedicated controlled restore prefix')
    rmSync(root, { recursive: true, force: true })
  }
}
async function setup(root: string) {
  const source = await ordinaryBackup(root), profile = join(root, 'current-profile'), database = join(profile, 'storage', 'knowbook.db')
  mkdirSync(dirname(database), { recursive: true })
  const current = new KnowbookStore(database), db = current.getUnsafeDatabaseHandle(), id = current.createDocument(null), blockId = randomUUID()
  db.pragma('journal_mode=WAL')
  current.updateDocument(id, { title: 'Current ordinary document', summary: 'Current persistent summary', blocks: [
    { id: blockId, type: 'paragraph', content: 'Current ordinary real body', checked: false, depth: 0, parentBlockId: null }
  ] })
  const currentWorkspace = workspace(db)
  let closed = false
  const close = () => { if (!closed) { closed = true; current.destroy() } }
  const sealCurrent = () => {
    assert.equal(closed, false, 'The genuine current producer is closed only once before maintenance')
    const snapshot = originals(database)
    close()
    for (const file of files) rmSync(join(profile, 'storage', file), { force: true })
    for (const file of snapshot) writeFileSync(join(profile, 'storage', file.name), file.bytes)
    const oracle = join(root, 'closed-current-read-oracle', randomUUID())
    mkdirSync(oracle, { recursive: true })
    for (const file of snapshot) copyFileSync(join(profile, 'storage', file.name), join(oracle, file.name))
    inspect(join(oracle, 'knowbook.db'), actual => {
      assert.equal(actual.pragma('integrity_check', { simple: true }), 'ok', 'The raw three-file preservation fixture really reopens as a readable ordinary database')
      assert.equal((actual.prepare('SELECT title FROM documents WHERE id=?').get(id) as { title: string }).title, 'Current ordinary document')
      assert.deepEqual(workspace(actual), currentWorkspace)
    })
    assertOriginals(database, snapshot)
    return snapshot
  }
  return { ...source, root, profile, database, current, db, currentId: id, currentBlockId: blockId, currentWorkspace, sealCurrent, close }
}
