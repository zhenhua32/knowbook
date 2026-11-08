import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listBackupVersions, publishBackupSnapshot, resolveBackupVersion } from '../src/main/backup/versions'

test('Windows backup publication waits for a real short-lived reader of the staged snapshot', { skip: process.platform !== 'win32' }, async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-backup-sharing-'))
  const backupRoot = join(root, 'markdown'), staging = join(root, 'next'), release = join(root, 'release')
  const released = join(root, 'released')
  const stagedNote = join(staging, 'note.md')
  mkdirSync(backupRoot); writeFileSync(join(backupRoot, 'note.md'), 'Original')
  mkdirSync(staging); writeFileSync(stagedNote, 'Next')
  const script = `
$ErrorActionPreference='Stop'
$stream=[IO.File]::Open($env:KNOWBOOK_LOCK_NOTE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
try {
  [Console]::WriteLine('ready')
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  while (![IO.File]::Exists($env:KNOWBOOK_LOCK_RELEASE) -and [DateTime]::UtcNow -lt $deadline) {
    [Threading.Thread]::Sleep(5)
  }
} finally { $stream.Dispose() }
[IO.File]::WriteAllText($env:KNOWBOOK_LOCK_RELEASED, '')`
  const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, KNOWBOOK_LOCK_NOTE: stagedNote, KNOWBOOK_LOCK_RELEASE: release, KNOWBOOK_LOCK_RELEASED: released },
    windowsHide: true, stdio: ['ignore', 'pipe', 'inherit']
  })
  const ended = once(reader, 'exit')
  try {
    const [ready] = await Promise.race([once(reader.stdout, 'data'), ended.then(() => { throw new Error('Backup reader exited before acquiring the sharing lock') })])
    assert.equal(String(ready).trim(), 'ready')
    const rename = fs.renameSync
    const wait = new Int32Array(new SharedArrayBuffer(4))
    let lockFailures = 0, checkedRetries = 0
    const observe = context.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      try {
        return rename(from, to)
      } catch (error) {
        if (from === staging && (error as NodeJS.ErrnoException).code === 'EPERM') {
          lockFailures++
          writeFileSync(release, '')
          const deadline = performance.now() + 5_000
          while (!existsSync(released) && performance.now() < deadline) Atomics.wait(wait, 0, 0, 5)
          assert.ok(existsSync(released), 'The real reader confirmed its Windows handle was closed')
        }
        throw error
      }
    })
    syncBuiltinESMExports()
    try {
      publishBackupSnapshot(backupRoot, staging, () => {
        assert.equal(readFileSync(stagedNote, 'utf8'), 'Next')
        checkedRetries++
      })
    }
    finally { observe.mock.restore(); syncBuiltinESMExports() }
    assert.equal(lockFailures, 1, 'Windows denied the original rename while the file reader held the lock')
    assert.equal(checkedRetries, lockFailures)
    assert.equal(readFileSync(join(backupRoot, 'note.md'), 'utf8'), 'Next')
    const archived = listBackupVersions(backupRoot).find(version => !version.current)!
    assert.equal(readFileSync(join(resolveBackupVersion(backupRoot, archived.id), 'note.md'), 'utf8'), 'Original')
  } finally {
    writeFileSync(release, '')
    try { await ended } finally { rmSync(root, { recursive: true, force: true }) }
  }
})
