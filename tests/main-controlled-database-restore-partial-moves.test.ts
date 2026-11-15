import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, files, digest, assertOriginals } from './helpers/controlled-restore-fixture'
import { faultChild } from './helpers/controlled-restore-fault-fixture'

async function partialMove(mode: string, moved: number, exitCode: number) {
  await withControlledRestore(async f => {
    const before = f.sealCurrent()
    assert.deepEqual(before.map(file => file.name), [...files], 'The actual Store producer supplied all three original SQLite files')
    const crashed = await faultChild(f.profile, f.backup, mode, join(f.root, mode + '.json'))
    assert.equal(crashed.code, exitCode, JSON.stringify(crashed.evidence.error))
    assert.equal(crashed.evidence.injected, true); assert.equal(crashed.evidence.interrupted, true)
    const witness = crashed.evidence.witness as { pointer: { version: number; phase: string; operationId: string }; archivedSHA256: string }
    assert.equal(witness.pointer.version, 2); assert.equal(witness.pointer.phase, 'moving')
    const recovery = join(f.profile, 'backups', 'database-restore', witness.pointer.operationId)
    for (const [index, file] of before.entries()) {
      const archived = join(recovery, 'original', file.name), current = join(f.profile, 'storage', file.name)
      assert.equal(existsSync(archived), index < moved)
      assert.equal(existsSync(current), index >= moved)
      assert.deepEqual(readFileSync(index < moved ? archived : current), file.bytes)
    }
    assert.equal(witness.archivedSHA256, digest(before[moved - 1].bytes))
    assert.equal(existsSync(join(recovery, 'candidate.db')), true)
    assert.equal((await faultChild(f.profile, f.backup, 'recover', join(f.root, mode + '-recover.json'))).code, 0)
    assertOriginals(f.database, before)
    assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
    assert.equal(JSON.parse(readFileSync(join(f.profile, 'database-restore-fence.json'), 'utf8')).phase, 'rolledback')
    assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
  })
}

test('controlled restore resumes exact rollback after the genuine original DB rename completes before WAL and SHM move', () => partialMove('move-db', 1, 76))

test('controlled restore resumes exact rollback after the genuine original WAL rename completes before SHM moves', () => partialMove('move-wal', 2, 77))

test('controlled restore resumes exact rollback after all genuine original DB WAL SHM renames complete before candidate installation', () => partialMove('move-shm', 3, 78))

test('controlled restore leaves foreign database files in place after a real interrupted move and resumes when the occupied slot is cleared', () => withControlledRestore(async f => {
  const originals = f.sealCurrent()
  const crashed = await faultChild(f.profile, f.backup, 'move-shm', join(f.root, 'occupied-move.json'))
  assert.equal(crashed.code, 78, JSON.stringify(crashed.evidence.error))
  const { pointer } = crashed.evidence.witness as { pointer: { operationId: string } }
  const recovery = join(f.profile, 'backups', 'database-restore', pointer.operationId)
  const journal = join(f.profile, 'database-restore-pending.json')
  const fence = join(f.profile, 'database-restore-fence.json')
  const journalBefore = readFileSync(journal), fenceBefore = readFileSync(fence)
  // The private candidate still exists, so matching database bytes at another
  // inode are not evidence that the candidate has been moved into storage.
  copyFileSync(join(recovery, 'candidate.db'), f.database)
  const foreignDatabase = readFileSync(f.database)
  const blockedDatabase = await faultChild(f.profile, f.backup, 'recover', join(f.root, 'occupied-database.json'))
  assert.equal(blockedDatabase.code, 1)
  assert.match(JSON.stringify(blockedDatabase.evidence.error), /未经认证的数据库文件/)
  assert.deepEqual(readFileSync(f.database), foreignDatabase)
  renameSync(f.database, join(f.root, 'foreign.db'))

  const foreignShm = Buffer.from('outside the interrupted operation')
  writeFileSync(f.database + '-shm', foreignShm, { flag: 'wx' })
  const blockedSidecar = await faultChild(f.profile, f.backup, 'recover', join(f.root, 'occupied-sidecar.json'))
  assert.equal(blockedSidecar.code, 1)
  assert.match(JSON.stringify(blockedSidecar.evidence.error), /未经认证的数据库文件/)
  assert.deepEqual(readFileSync(f.database + '-shm'), foreignShm)
  assert.equal(existsSync(f.database), false, 'A late occupied slot prevents moving an earlier original')
  assert.deepEqual(readFileSync(journal), journalBefore)
  assert.deepEqual(readFileSync(fence), fenceBefore)
  assert.equal(readdirSync(recovery).some(name => name.startsWith('rejected-')), false)
  for (const file of originals) assert.deepEqual(readFileSync(join(recovery, 'original', file.name)), file.bytes)

  renameSync(f.database + '-shm', join(f.root, 'foreign.db-shm'))
  const recovered = await faultChild(f.profile, f.backup, 'recover', join(f.root, 'cleared-slots.json'))
  assert.equal(recovered.code, 0)
  assertOriginals(f.database, originals)
  assert.equal(existsSync(journal), false)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))
