import assert from 'node:assert/strict'
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, restoreKnowbookDatabase, noProcesses, assertOriginals } from './helpers/controlled-restore-fixture'

test('controlled restore refuses a nonempty orphan private exchange spool on an ordinary current without moving original files or clearing bad provenance', () => withControlledRestore(async f => {
  const original = f.sealCurrent(), directory = join(f.profile, 'storage', 'synced-exchanges-v1', 'orphan')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'job.json'), bytes = Buffer.from('{}')
  writeFileSync(path, bytes)
  let replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
    beforeReplace: async () => { replaced = true } }))
  assert.equal(replaced, false)
  assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(path), bytes)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))

test('controlled restore rejects a differently named source hardlink of the real current DB before moving either inode alias', () => withControlledRestore(async f => {
  // A real checkpoint makes the standalone DB itself a valid ordinary source;
  // rejection cannot rely on its differently named alias lacking a live WAL.
  f.db.pragma('wal_checkpoint(TRUNCATE)')
  const original = f.sealCurrent(), source = join(f.root, 'current-hardlink.db')
  linkSync(f.database, source)
  const currentStat = lstatSync(f.database), sourceStat = lstatSync(source), sourceBytes = Buffer.from(readFileSync(source))
  assert.equal(currentStat.ino, sourceStat.ino)
  assert.equal(currentStat.dev, sourceStat.dev)
  assert.ok(currentStat.nlink >= 2, 'The independently named negative source is an actual filesystem hardlink, not a symlink or copied backup')
  let replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: source, stopProcesses: noProcesses,
    beforeReplace: async () => { replaced = true } }))
  assert.equal(replaced, false)
  assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
  assertOriginals(f.database, original)
  assert.deepEqual(readFileSync(source), sourceBytes)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))
