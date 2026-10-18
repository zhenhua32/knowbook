import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { withControlledRestore, files, digest, assertOriginals } from './helpers/controlled-restore-fixture'
import { faultChild } from './helpers/controlled-restore-fault-fixture'

async function partialMove(mode: string, moved: number, exitCode: number) {
  await withControlledRestore(async f => {
    const before = f.sealCurrent()
    assert.deepEqual(before.map(file => file.name), [...files], 'The actual Store producer supplied all three original SQLite files')
    const crashed = await faultChild(f.profile, f.backup, mode, join(f.root, mode + '.json'))
    assert.equal(crashed.code, exitCode); assert.equal(crashed.evidence.injected, true); assert.equal(crashed.evidence.interrupted, true)
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
